import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck, type Assertion } from "./_framework.js";
import * as P from "../../core/llm-runtime/adapters/_codex-pressure.js";
import * as H from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

export const check: RegressionCheck = {
  name: "codex-current-pressure",
  guards: "matched invocation-local usage boundary, unchanged legacy/media/density gates, old-only single append compaction and one-shot structured context rescue",
  run: async (): Promise<Assertion[]> => {
    const invocation = Symbol("fixture");
    const initial: H.ResponseInputItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic" }] }];
    const body = (input: readonly H.ResponseInputItem[], extra = {}) => JSON.stringify({ model: "synthetic-model", instructions: "same", input, tools: [], prompt_cache_key: "session", ...extra });
    const snapshot = P.pressureSnapshot(body(initial), invocation, 1);
    const replay: H.ResponseInputItem[] = [
      { type: "reasoning", id: "rs", summary: [], encrypted_content: "synthetic-opaque".repeat(50_000) },
      { type: "function_call", id: "fc", call_id: "call", name: "Read", arguments: "{}" },
    ];
    const result: H.CodexSseResult = {
      text: "", toolCalls: [{ callId: "call", name: "Read", partialJson: "{}", id: "fc" }],
      replayOutput: replay, replayUnchanged: true, responseId: "r", lastEvent: "response.completed", eventCounts: { "response.completed": 1 },
      terminalUsage: { responseId: "r", model: "synthetic-model", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 90, reasoningTokens: 7 },
    };
    const covered = [...initial, ...replay];
    const anchor = P.committedPressureAnchor(snapshot, result, "true", covered);
    const tail: H.ResponseInputItem[] = [{ type: "function_call_output", call_id: "call", output: 'ref "한글" \\ newline\n' }];
    const next = P.pressureSnapshot(body([...covered, ...tail]), invocation, 2);
    const pressure = P.matchedPressureChars(anchor, next);
    const out: Assertion[] = [
      assert("complete committed opaque reply uses terminal total plus actual escaped rendered array; no cache subtraction/reasoning addition", pressure === 120 * 1.4 + JSON.stringify(tail).length, { pressure, tailChars: JSON.stringify(tail).length }),
      assert("terminal alone never installs an uncommitted reply", P.committedPressureAnchor(snapshot, result, "true", initial) === undefined, { accepted: P.committedPressureAnchor(snapshot, result, "true", initial) !== undefined, committedItems: initial.length }),
      assert("missing/false/unknown inclusion signal never inherits true", [null, "false", "unknown", "1"].every(header => P.committedPressureAnchor(snapshot, result, header, covered) === undefined), [null, "false", "unknown", "1"].map(header => ({ header, accepted: P.committedPressureAnchor(snapshot, result, header, covered) !== undefined }))),
    ];
    for (const [label, patch] of Object.entries({
      mismatchedTotal: { terminalUsage: { ...result.terminalUsage!, totalTokens: 119 } },
      missingTotal: { terminalUsage: undefined },
      mismatchedModel: { terminalUsage: { ...result.terminalUsage!, model: "other" } },
      missingModel: { terminalUsage: { ...result.terminalUsage!, model: undefined } },
      unsafe: { terminalUsage: { ...result.terminalUsage!, inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
      fractional: { terminalUsage: { ...result.terminalUsage!, inputTokens: 99.5 } },
      negative: { terminalUsage: { ...result.terminalUsage!, inputTokens: -1 } },
      wrongResponse: { terminalUsage: { ...result.terminalUsage!, responseId: "other" } },
      repeatedTerminal: { eventCounts: { "response.completed": 2 } },
      incomplete: { lastEvent: "response.incomplete" },
      transformed: { replayUnchanged: false },
      unknownReplay: { replayOutput: [{ type: "web_search_call", id: "ws", status: "completed", action: { type: "search", query: "q" } }] },
    })) out.push(assert(`anchor rejects ${label}`, P.committedPressureAnchor(snapshot, { ...result, ...patch } as H.CodexSseResult, "true", covered) === undefined, label));
    const mutations: Array<[string, H.ResponseInputItem[], Record<string, unknown>?]> = [
      ["same-length prefix rewrite", [{ ...initial[0]!, content: [{ type: "input_text", text: "Synthetic" }] } as H.ResponseInputItem, ...replay, ...tail]],
      ["new opaque", [...covered, { type: "reasoning", id: "new", summary: [], encrypted_content: "new" }]],
      ["steering/checkpoint", [...covered, initial[0]!]],
      ["new image", [...covered, { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,abc" }] }]],
      ["wrong call", [...covered, { type: "function_call_output", call_id: "other", output: "x" }]],
      ["duplicate output", [...covered, ...tail, ...tail]],
      ["body/tools", [...covered, ...tail], { tools: [{ type: "function", name: "other" }] }],
      ["effort", [...covered, ...tail], { reasoning: { effort: "high" } }],
      ["model", [...covered, ...tail], { model: "other" }],
      ["session/cache", [...covered, ...tail], { prompt_cache_key: "other" }],
    ];
    for (const [label, items, extra] of mutations) out.push(assert(`pressure falls back on ${label}`, P.matchedPressureChars(anchor, P.pressureSnapshot(body(items, extra), invocation, 2)) === undefined, label));
    out.push(assert("other invocation and stale attempt cannot reuse sample", P.matchedPressureChars(anchor, { ...next, invocation: Symbol() }) === undefined && P.matchedPressureChars(anchor, { ...next, attempt: 1 }) === undefined, { otherInvocation: P.matchedPressureChars(anchor, { ...next, invocation: Symbol() }) ?? null, staleAttempt: P.matchedPressureChars(anchor, { ...next, attempt: 1 }) ?? null }));
    out.push(assert("explicit context classifier ignores prose/413/generic/error.message", P.hasExplicitContextLimit('{"error":{"code":"context_length_exceeded"}}') && ['context_length_exceeded', '{"error":{"message":"context_length_exceeded"}}', '{"error":{"code":"invalid_prompt"}}', '413'].every(x => !P.hasExplicitContextLimit(x)), { structured: P.hasExplicitContextLimit('{"error":{"code":"context_length_exceeded"}}'), rejected: ['context_length_exceeded', '{"error":{"message":"context_length_exceeded"}}', '{"error":{"code":"invalid_prompt"}}', '413'].map(x => P.hasExplicitContextLimit(x)) }));

    out.push(assert("unknown model window never exposes a matched-pressure ceiling", P.currentPressureCeiling("gpt-synthetic-unknown-window") === undefined, { ceiling: P.currentPressureCeiling("gpt-synthetic-unknown-window") ?? null }));

    const old: H.ResponseInputItem[] = Array.from({ length: 5 }, (_, i) => ({ type: "function_call", call_id: `old${i}`, name: "Read", arguments: "{}" }));
    H.appendToolResultsToInput(old, Array.from({ length: 5 }, (_, i) => ({ callId: `old${i}`, name: "Read", output: `original${i}\n` + "x".repeat(5000), media: [] })), { requestChars: 0, deferTextCompaction: true });
    const eligible = H.oldToolOutputCandidates(old);
    const fresh = Array.from({ length: 7 }, (_, i) => ({ callId: `new${i}`, name: "Read", output: "fresh\n" + "y".repeat(6000), media: [] }));
    old.push(...fresh.map(it => ({ type: "function_call" as const, call_id: it.callId, name: "Read", arguments: "{}" })));
    const appended = H.appendToolResultsToInput(old, fresh, { requestChars: 900_000, ceilingChars: 1, deferTextCompaction: true });
    const changed = H.compactOldToolOutputs(old, { eligible, batchChars: 0 });
    const markers = old.filter(it => it.type === "function_call_output").map(it => it.type === "function_call_output" && it.output.startsWith("\u0000__codex_compacted__\u0000"));
    out.push(assert("deferred append compacts zero, one pressure pass rewrites only old two; recent3 and entire new7 survive", appended === 0 && changed === 2 && markers.slice(0, 2).every(Boolean) && markers.slice(2).every(x => !x), { appended, changed, markers }));
    out.push(assert("entry-capped original survives pressure rewrite through collectTurnItems", H.collectTurnItems(old, "").filter(it => it.type === "function_call_output").length === 12 && H.collectTurnItems(old, "").filter(it => it.type === "function_call_output").every(it => it.type === "function_call_output" && !it.output.startsWith("\u0000__codex_compacted__\u0000")), H.collectTurnItems(old, "").filter(it => it.type === "function_call_output").map(it => it.type === "function_call_output" ? { callId: it.call_id, chars: it.output.length, marker: it.output.startsWith("\u0000__codex_compacted__\u0000") } : { type: it.type })));
    const restored = H.buildCodexInputArray([{ role: "user", content: "q" }, { role: "assistant", content: "a", items: Array.from({ length: 5 }, (_, i) => [
      { type: "function_call" as const, call_id: `h${i}`, name: "Read", arguments: "{}" },
      { type: "function_call_output" as const, call_id: `h${i}`, output: "restored\n" + "h".repeat(5000) },
    ]).flat() }], "", initial[0]! as H.ResponseInputMessage);
    const normal = H.compactOldToolOutputs(restored, { batchChars: 0 });
    const rescue = H.compactOldToolOutputs(restored, { batchChars: 0, includeRestored: true, eligible: H.oldToolOutputCandidates(restored, true) });
    out.push(assert("legacy force never opens restored; explicit rescue opens old restored only and retains recent3", normal === 0 && rescue === 2, { normal, rescue }));

    type Observation = { chars: number; bytes: number; outputs: Array<{ id: string; len: number; marker: boolean }> };
    type Flow = { observations: Observation[]; starts: number; error: string; text: string; sameTransientBody: boolean; rescueReduced: boolean };
    const modes = ["matched", "missing", "false", "bad-total", "media-legacy", "transient", "overflow", "overflow-twice", "overflow-generic", "visible-overflow", "generic400", "unknown-model", "wrong-model", "missing-model"];
    const flows: Record<string, Flow> = {};
    for (let start = 0; start < modes.length; start += 4) {
      await Promise.all(modes.slice(start, start + 4).map(async mode => {
        const r = await spawnWithin(60_000, `pressure ${mode}`, ["--import", "tsx", fileURLToPath(new URL("./_codex-pressure-child.ts", import.meta.url)), mode]);
        const line = r.out.split("\n").find(x => x.startsWith("PRESSURE_RESULT "));
        out.push(assert(`actual adapter ${mode} fixture completes`, !!line && !r.timedOut, line ? "complete" : r.err.slice(-1200)));
        if (line) flows[mode] = JSON.parse(line.slice(16)) as Flow;
      }));
    }
    const last = (mode: string) => flows[mode]?.observations.at(-1);
    const marks = (mode: string) => last(mode)?.outputs.filter(x => x.marker).length;
    out.push(assert("actual matched response suppresses opaque-only forced compression", flows.matched?.error === "" && marks("matched") === 0 && flows.matched.starts === 10 && (last("matched")?.chars ?? 0) > 700_000, flows.matched));
    for (const mode of ["missing", "false", "bad-total", "unknown-model", "wrong-model", "missing-model"]) out.push(assert(`actual ${mode} falls back; preserves old recent3 and whole new batch`, flows[mode]?.error === "" && marks(mode) === 2 && last(mode)?.outputs.filter(x => x.marker).every(x => x.id === "call_1_0" || x.id === "call_1_1") === true, flows[mode]));
    out.push(assert("actual fallback still subtracts media, never whole-body forces pressure; chars and UTF8 bytes distinct", flows["media-legacy"]?.error === "" && marks("media-legacy") === 0 && (last("media-legacy")?.chars ?? 0) > 800_000 && (last("media-legacy")?.bytes ?? 0) > (last("media-legacy")?.chars ?? Infinity), flows["media-legacy"]));
    out.push(assert("same-body transient retry preserves snapshot and installs only successful terminal once", flows.transient?.error === "" && flows.transient.sameTransientBody && flows.transient.observations.length === 4 && flows.transient.starts === 10 && marks("transient") === 0, flows.transient));
    out.push(assert("explicit overflow rescues once with strict wire reduction and no Read replay/new batch compression", flows.overflow?.error === "" && flows.overflow.rescueReduced && flows.overflow.observations.length === 4 && flows.overflow.starts === 10 && marks("overflow") === 2, flows.overflow));
    for (const mode of ["overflow-twice", "overflow-generic"]) out.push(assert(`actual ${mode} propagates its own cause without another rescue (facade replay covered by codex-rescue-error-cause)`,
      flows[mode]?.text === "" && flows[mode]!.observations.length === 4 && flows[mode]!.starts === 10 && flows[mode]!.rescueReduced &&
      (mode === "overflow-twice" ? flows[mode]!.error.includes("context_length_exceeded") : flows[mode]!.error.includes("failed: 400") && flows[mode]!.error.includes("invalid_prompt") && !flows[mode]!.error.includes("context_length_exceeded")), flows[mode]));
    out.push(assert("visible text delta prohibits local context retry", flows["visible-overflow"]?.error === "" && flows["visible-overflow"].observations.length === 3 && flows["visible-overflow"].starts === 10 && flows["visible-overflow"].text.includes("already visible"), flows["visible-overflow"]));
    out.push(assert("generic400 prose never triggers rescue", flows.generic400?.observations.length === 3 && flows.generic400.error !== "", flows.generic400));
    return out;
  },
};
