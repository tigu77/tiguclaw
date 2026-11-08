/** Isolated real own Read + installed SDK Runner; only model responses are fake. No DB, credentials or external network. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assertIsolated } from "./_framework.js";
import { MiniDocument, dispatch, makeEvent } from "./_mini-dom.js";

assertIsolated();
const work = fs.mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "read-observation-"));
const checks: Array<{ name: string; ok: boolean; got?: unknown }> = [];
const check = (name: string, ok: unknown, got?: unknown) => checks.push({ name, ok: !!ok, ...(got === undefined ? {} : { got }) });
let networkAttempts = 0;
const blocked = () => { networkAttempts++; throw new Error("READ_OBSERVATION_NETWORK_BLOCKED"); };
globalThis.fetch = blocked as never;
const net = await import("node:net");
net.Socket.prototype.connect = blocked as never;

try {
  const { buildActivityOutput: output } = await import("../../core/llm-runtime/adapters/_activity-output.js");
  const { READ_RESULT_META, readObservationFromContent, validateReadObservation, ownReadCustomData, withoutReadObservation, splitMcpToolContent, emptyToolText } = await import("../../core/llm-runtime/adapters/_mcp-content.js");
  const textRead = (returnedLineCount: number, startLine = 1) => ({ kind: "text" as const, startLine, returnedLineCount });
  const preview = (text: string, count: number, start = 1) => output("Read", text, false, textRead(count, start), true)!;
  const c400 = preview("x".repeat(400), 1);
  const c401 = preview("x".repeat(401) + "\nnext", 2);
  check("400/401-char rows: strict width, truncation and final partial flag", c400.text.length === 400 && !c400.truncated && c401.text.split("\n")[0]?.length === 400 && c401.text.endsWith("\nnext") && c401.truncated && !c401.read?.previewLastLinePartial && preview("x".repeat(401), 1).read?.previewLastLinePartial);
  const l40 = preview(Array.from({ length: 40 }, (_, i) => String(i)).join("\n") + "\n", 40);
  const l41 = preview(Array.from({ length: 41 }, (_, i) => String(i)).join("\n"), 41);
  check("40/41-row cap excludes only proven sentinel, not real rows", l40.text.split("\n").length === 40 && !l40.truncated && l41.text.split("\n").length === 40 && l41.truncated && !l41.read?.previewLastLinePartial);
  const exact = Array.from({ length: 10 }, () => "z".repeat(399)).join("\n") + "z";
  const exactOut = preview(exact, 10);
  const overflow = preview(Array.from({ length: 11 }, () => "z".repeat(400)).join("\n"), 11);
  check("4000-char total cap is strict including separators", exact.length === 4000 && exactOut.text.length === 4000 && !exactOut.truncated && overflow.text.length <= 4000 && overflow.truncated && overflow.read?.previewLastLinePartial, { exact: exactOut.text.length, overflow: overflow.text.length });
  check("Read preserves whitespace and known real blank rows", preview(" \t\n\n", 2).text === " \t\n" && preview("", 1).read?.kind === "text" && preview("", 1).text === "");
  check("empty/EOF are not dropped, old empty remains absent", output("Read", "", false, { kind: "empty" }, true)?.read?.kind === "empty" && output("Read", "", false, { kind: "eof" }, true)?.read?.kind === "eof" && output("Read", "") === undefined);
  check("known successful Error: body stays normal, explicit errors always win", !preview("Error: file content", 1).isError && output("Read", "Error: real failure", true, textRead(1), true)?.isError && output("Read", "Error: unsupported native")?.isError);
  check("native/old output never invents row numbers; other tools unchanged", output("Read", "   7→text")?.read?.kind === "unknown" && !output("Read", "   7→text")?.read?.startLine && output("Bash", " a\n\n")?.text === " a" && !output("Bash", "ok")?.read);
  const evil = new Proxy({}, { get() { throw new Error("bad getter"); } });
  check("observation is scalar-only and no-throw on malformed extraction", validateReadObservation(evil) === undefined && ownReadCustomData(evil as never) === undefined && ownReadCustomData({ toolName: "Read", toolOutput: evil }) === undefined && validateReadObservation({ kind: "text", startLine: 1, returnedLineCount: 0 }) === undefined && JSON.stringify(validateReadObservation({ ...textRead(2), body: "DO NOT COPY" })) === JSON.stringify(textRead(2)));

  let kindReads = 0, lineReads = 0;
  const scalarSnapshot = validateReadObservation({
    get kind() { return ++kindReads === 1 ? "text" : { body: "not scalar" }; },
    get startLine() { return ++lineReads === 1 ? 7 : { body: "not scalar" }; },
    returnedLineCount: 1,
  });
  check("extractor snapshots only validated JSON scalars even with changing getters", JSON.stringify(scalarSnapshot) === JSON.stringify(textRead(1, 7)) && kindReads === 1 && lineReads === 1);

  const fixtures: Record<string, string | Buffer> = {
    "normal.txt": "alpha\nbeta\ngamma\ndelta\n", "error-prefix.txt": "Error: legitimate content\nsecond\n",
    "empty.txt": "", "newline.txt": "\n", "two-newlines.txt": "\n\n", "spaces.txt": " \t\n\nnext",
    "cache.txt": Array.from({ length: 80 }, (_, i) => `cache row ${i} ${"a".repeat(60)}`).join("\n"),
    "sample.ipynb": JSON.stringify({ nbformat: 4, cells: [{ cell_type: "markdown", source: ["# Notebook\n"] }] }),
    "binary.bin": Buffer.from([0, 255, 0, 1]),
    "pixel.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=", "base64"),
    "hardcap.txt": "h".repeat(1_048_590),
    "hardcap-boundary.txt": "h".repeat(999_998) + "\n" + "bb",
  };
  for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(work, name), content);
  const { createFileOpsMcpServer } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
  const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
  const own = () => createFileOpsMcpServer(work, "cli:read-observation-regression", { readsOnly: [...Object.keys(fixtures), "missing.txt"].map(n => path.join(work, n)) });
  const bridge = await adaptClaudeMcpServer(own(), "read-observation");
  const read = async (name: string, args: Record<string, number> = {}) => {
    const content = await bridge.callTool("Read", { path: path.join(work, name), ...args });
    const meta = readObservationFromContent(content);
    const split = splitMcpToolContent(content);
    return { content, meta, split, output: output("Read", split.text, false, meta, meta !== undefined) };
  };
  const normal = await read("normal.txt", { offset: 2, limit: 2 });
  const errorPrefix = await read("error-prefix.txt");
  const empty = await read("empty.txt");
  const eof = await read("normal.txt", { offset: 99, limit: 2 });
  const sentinel = await read("normal.txt", { offset: 5, limit: 1 });
  const newline = await read("newline.txt");
  const two = await read("two-newlines.txt");
  const actualBlank = await read("spaces.txt", { offset: 2, limit: 1 });
  const err = await read("missing.txt");
  check("own producer offset+limit describes actual returned slice", normal.split.text === "beta\ngamma" && JSON.stringify(normal.meta) === JSON.stringify(textRead(2, 2)));
  check("own normal Error: result is not a tool error", !errorPrefix.output?.isError && errorPrefix.meta?.kind === "text");
  check("own empty and EOF/sentinel are distinct from a real empty row", empty.meta?.kind === "empty" && eof.meta?.kind === "eof" && sentinel.meta?.kind === "eof" && actualBlank.meta?.kind === "text" && actualBlank.meta.returnedLineCount === 1 && actualBlank.output?.text === "");
  check("newline-only files retain one/two actual blank rows", newline.meta?.returnedLineCount === 1 && newline.output?.text === "" && two.meta?.returnedLineCount === 2 && two.output?.text === "\n");
  check("actual file error has no success metadata and remains error", err.meta === undefined && err.output?.isError);
  const notebook = await read("sample.ipynb");
  const binary = await read("binary.bin");
  const image = await read("pixel.png");
  check("notebook unknown, binary/image non-text without fabricated file rows", notebook.meta?.kind === "unknown" && binary.meta?.kind === "non-text" && image.meta?.kind === "non-text" && image.split.media.length === 1);
  const hard = await read("hardcap.txt");
  check("source hardcap marks actual returned partial row independently of preview cap", hard.meta?.sourceTruncated && hard.meta.partialLastLine && hard.meta.returnedLineCount === 1 && hard.output?.read?.previewLastLinePartial);
  const hardBoundary = await read("hardcap-boundary.txt");
  check("hardcap ellipsis after a newline is not a returned file row", hardBoundary.meta?.sourceTruncated && hardBoundary.meta.partialLastLine !== true && hardBoundary.meta.returnedLineCount === 1 && hardBoundary.output?.read?.returnedLineCount === 1 && hardBoundary.output.text.split("\n").length === 1, hardBoundary.meta);
  const cache = await read("cache.txt");
  const notice1 = await read("cache.txt");
  const notice2 = await read("cache.txt");
  const reread = await read("cache.txt");
  check("cache notice never becomes file body/range and third repeat returns body", cache.meta?.kind === "text" && notice1.meta?.kind === "notice" && !notice1.meta.startLine && notice2.meta?.kind === "notice" && reread.split.text === cache.split.text);
  check("Codex empty JSON fallback stays byte-identical despite observation", emptyToolText(withoutReadObservation(empty.content), 0) === '[{"type":"text","text":""}]');
  check("customData is only own bridge extraction, tool-name gate rejects other tools", ownReadCustomData({ toolName: "Read", toolOutput: normal.content })?.tiguclawRead?.startLine === 2 && ownReadCustomData({ toolName: "Other", toolOutput: normal.content }) === undefined);
  await bridge.close();

  const { Agent, Runner } = await import("@openai/agents");
  const sdk = async (marked: boolean, malformed = false) => {
    const server = await adaptClaudeMcpServer(own(), "read-observation-sdk");
    const original = server.callTool.bind(server);
    server.callTool = async (...args) => {
      const result = await original(...args);
      // Baseline removes only the new observational metadata, not any model content.
      return (marked ? result : withoutReadObservation(result)) as typeof result;
    };
    if (marked) server.customDataExtractor = malformed ? () => ownReadCustomData({ toolName: "Read", toolOutput: evil }) : ownReadCustomData;
    let calls = 0;
    const requests: unknown[] = [];
    const events: Array<{ callId?: string; output: unknown; customData: unknown }> = [];
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 };
    const fake = {
      getResponse: async () => { throw new Error("stream only"); },
      async *getStreamedResponse(req: any) {
        calls++;
        requests.push(JSON.parse(JSON.stringify({ input: req.input, tools: req.tools })));
        yield { type: "response_started" };
        if (calls === 1) {
          yield { type: "response_done", response: { id: "r1", usage, output: [
            ["slice", "normal.txt", { offset: 2, limit: 2 }], ["empty", "empty.txt", {}],
            ["blank", "spaces.txt", { offset: 2, limit: 1 }], ["error-prefix", "error-prefix.txt", {}],
            ["eof", "normal.txt", { offset: 99 }], ["image", "pixel.png", {}],
          ].map(([id, file, extra]) => ({ type: "function_call", id: `fc-${id}`, callId: `c-${id}`, name: "Read", arguments: JSON.stringify({ path: path.join(work, file as string), ...(extra as object) }), status: "completed" })) } };
        } else if (calls === 2) {
          yield { type: "output_text_delta", delta: "done" };
          yield { type: "response_done", response: { id: "r2", usage, output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] }] } };
        } else throw new Error("unexpected extra model request");
      },
    };
    const runner = new Runner({ model: fake as never, tracingDisabled: true });
    const agent = new Agent({ name: "ReadObservation", model: fake as never, mcpServers: [server] });
    try {
      const stream = await runner.run(agent, "isolated own Read observation", { stream: true, maxTurns: 3 });
      for await (const e of stream) {
        if (e.type === "run_item_stream_event" && e.name === "tool_output") {
          const item = e.item as any;
          events.push({ callId: item.rawItem?.callId, output: item.output, customData: item.customData });
        }
      }
      await stream.completed;
      return { requests, events, calls, final: stream.finalOutput };
    } finally { await server.close(); }
  };
  const baseline = await sdk(false);
  const marked = await sdk(true);
  const failedObservation = await sdk(true, true);
  check("actual SDK parallel Read customData pairing survives tool_output", marked.events.length === 6 && marked.events.find(e => e.callId === "c-slice")?.customData && (marked.events.find(e => e.callId === "c-empty")?.customData as any)?.tiguclawRead?.kind === "empty" && (marked.events.find(e => e.callId === "c-blank")?.customData as any)?.tiguclawRead?.kind === "text" && (marked.events.find(e => e.callId === "c-eof")?.customData as any)?.tiguclawRead?.kind === "eof", marked.events.map(e => ({ callId: e.callId, customData: e.customData })));
  check("SDK original item.output retains original Read text/observation", readObservationFromContent(marked.events.find(e => e.callId === "c-slice")?.output)?.startLine === 2 && readObservationFromContent(marked.events.find(e => e.callId === "c-blank")?.output)?.returnedLineCount === 1);
  check("SDK model next-request + tools byte-identical with new metadata/customData", JSON.stringify(baseline.requests) === JSON.stringify(marked.requests) && !JSON.stringify(marked.requests).includes(READ_RESULT_META) && !JSON.stringify(marked.requests).includes("tiguclawRead"));
  check("malformed/no observation does not fail successful SDK Read", failedObservation.calls === 2 && failedObservation.final === "done" && JSON.stringify(failedObservation.requests) === JSON.stringify(baseline.requests));
  fs.writeFileSync(path.join(work, "sdk-evidence.json"), JSON.stringify({ baseline, marked, failedObservation }, null, 2));

  const { extractToolResults } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const native = extractToolResults({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "n-text", content: "  2→native" },
    { type: "tool_result", tool_use_id: "n-image", content: [{ type: "image", source: { type: "base64", data: "x" } }] },
    { type: "tool_result", tool_use_id: "n-error", content: "Error: native error", is_error: true },
  ] } });
  check("Claude native extraction keeps literal text, image hint and explicit error", native[0]?.text === "  2→native" && !native[0].nonText && native[1]?.nonText && native[2]?.isError);

  // Run the production helper, not a replica; renderer is intentionally pure (no HTTP/read fallback).
  const ui = fs.readFileSync(new URL("../../../packages/dashboard/js/virtualization.js", import.meta.url), "utf8");
  const helper = ui.slice(ui.indexOf("      const buildReadBlock ="), ui.indexOf("      // ExitPlanMode 계획 카드"));
  const document = new MiniDocument();
  const context = vm.createContext({ document, queueMicrotask, i18n: (k: string, v?: unknown) => k + (v ? JSON.stringify(v) : ""), buildOutputBlock: () => document.createElement("div") });
  vm.runInContext(helper + "\nglobalThis.renderRead = buildReadBlock; globalThis.bindRead = wireReadToggle;", context);
  const render = context.renderRead as (o: unknown, f?: unknown) => ReturnType<MiniDocument["createElement"]>;
  const step = document.createElement("div");
  document.body.appendChild(step);
  step.addEventListener("click", () => step.classList.toggle("expanded"));
  const bind = context.bindRead as (step: unknown) => void;
  bind(step); bind(step);
  dispatch(step, makeEvent("keydown", { key: "Enter", bubbles: true }));
  await Promise.resolve();
  const opened = step.classList.contains("expanded") && step.getAttribute("aria-expanded") === "true";
  dispatch(step, makeEvent("keydown", { key: " ", bubbles: true }));
  await Promise.resolve();
  const closed = !step.classList.contains("expanded") && step.getAttribute("aria-expanded") === "false";
  check("Read keyboard toggle binds once and keeps persistent step aria state", opened && closed && step.getAttribute("role") === "button");
  const blankCard = render(actualBlank.output);
  const unknownCard = render(output("Read", "  17→<script>not markup</script>"));
  const card = render(normal.output);
  check("Read helper gives actual returned rows and leaves default collapsed", card.querySelectorAll(".act-read-line").length === 2 && card.querySelector(".act-read-num")?.textContent === "2" && !card.classList.contains("expanded"));
  check("actual blank row gets a row; empty/EOF get no manufactured rows", blankCard.querySelectorAll(".act-read-line").length === 1 && blankCard.querySelector(".act-read-text")?.textContent === "" && render(empty.output).querySelectorAll(".act-read-line").length === 0 && render(eof.output).querySelectorAll(".act-read-line").length === 0);
  check("unsupported native-like numbering remains literal escaped text", unknownCard.querySelectorAll(".act-read-num").length === 0 && unknownCard.querySelector("pre")?.textContent === "  17→<script>not markup</script>" && unknownCard.querySelector("script") === null);
  check("UI separates true returned range from clipped displayed range", render(l41).querySelector(".act-output-lbl")?.textContent.includes('"end":41') && render(l41).querySelector(".act-read-caption")?.textContent.includes('"end":40'));
  check("Read helper contains no file/http/innerHTML fallback", !/\bfetch\s*\(|\.innerHTML\s*=|readFile|\/api\//.test(helper));
  check("network attempts are zero", networkAttempts === 0, networkAttempts);
} catch (error) {
  check("child execution", false, error instanceof Error ? error.stack : String(error));
}
console.log(JSON.stringify({ checks, evidence: work, networkAttempts }));
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
