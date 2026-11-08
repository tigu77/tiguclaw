/** Real adapter, real Read dispatch, synthetic auth/network; no live endpoints or user files. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
assertIsolated();
if (process.env.TIGUCLAW_DISABLE_ENV_FILE !== "1" || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL !== "1") throw new Error("isolated fake-network runner required");
pinModelForTest("codex:gpt-5.6-sol");
process.env.CODEX_TOOL_SEARCH = "0";
process.env.CODEX_MAX_TOOL_ITERATIONS = "12";
process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = "16";
const mode = process.argv[2] ?? "matched";
const requestModel = mode === "unknown-model" ? "gpt-synthetic-unknown-window" : "gpt-5.6-sol";
const cwd = path.join(process.env.TIGUCLAW_HOME!, "work");
mkdirSync(cwd);
writeFileSync(path.join(cwd, "fixture.txt"), 'synthetic row "한글" \\ data\n'.repeat(350));
const media = mode === "media-legacy";
const image = path.join(cwd, "synthetic.png");
if (media) writeFileSync(image, Buffer.alloc(650_000, 42));
const { initStore } = await import("../../store/sessions.js");
const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
const { getEventBus } = await import("../../core/eventbus.js");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "synthetic-token" });
let starts = 0;
const unsub = getEventBus().subscribe(e => { if (e.type === "llm.activity" && e.payload.kind === "tool" && e.payload.phase !== "end") starts++; });
type Item = Record<string, unknown>;
type Body = { input: Item[]; tools: unknown[] };
const observations: Array<{ chars: number; bytes: number; outputs: Array<{ id: unknown; len: number; marker: boolean }> }> = [];
let logical = 0;
let transient = false;
let retryWire: string | undefined;
let sameTransientBody = false;
let rescueWire: string | undefined;
let rescueReduced = false;
const frame = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
const complete = (n: number, items: Item[], header: string | undefined) => {
  const events = [
    ...items.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" } : item },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: "synthetic done" }] : []),
      { type: "response.output_item.done", output_index, item },
    ]),
    { type: "response.completed", response: { id: `synthetic_${n}`, ...(mode === "missing-model" && n === 2 ? {} : { model: mode === "wrong-model" && n === 2 ? "gpt-different-model" : requestModel }), status: "completed", output: items,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: mode === "bad-total" && n === 2 ? 29 : 30,
        input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 4 } } } },
  ];
  return new Response(frame(events), { headers: header === undefined ? {} : { "x-reasoning-included": header } });
};
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const wire = String(init?.body);
  const body = JSON.parse(wire) as Body;
  observations.push({ chars: wire.length, bytes: Buffer.byteLength(wire), outputs: body.input.filter(x => x.type === "function_call_output").map(x => ({ id: x.call_id, len: String(x.output).length, marker: String(x.output).startsWith("\u0000__codex_compacted__\u0000") })) });
  if (mode === "transient" && logical === 1 && !transient) { transient = true; retryWire = wire; return new Response("synthetic temporary error", { status: 503 }); }
  if (retryWire !== undefined) { sameTransientBody = retryWire === wire; retryWire = undefined; }
  if (logical === 2 && mode.startsWith("overflow")) {
    if (rescueWire === undefined) {
      rescueWire = wire;
      return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
    }
    rescueReduced = wire.length < rescueWire.length && Buffer.byteLength(wire) < Buffer.byteLength(rescueWire);
    if (mode === "overflow-twice") return new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
    if (mode === "overflow-generic") return new Response(JSON.stringify({ error: { code: "invalid_prompt" } }), { status: 400 });
  }
  if (logical === 2 && mode === "visible-overflow") return new Response(frame([
    { type: "response.output_text.delta", delta: "already visible" },
    { type: "response.failed", response: { id: "synthetic_failure", error: { code: "context_length_exceeded" } } },
  ]));
  if (logical === 2 && mode === "generic400") return new Response(JSON.stringify({ error: { message: "context_length_exceeded is only prose" } }), { status: 400 });
  logical++;
  if (logical >= 3) return complete(logical, [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic done" }] }], "true");
  const items: Item[] = [
    { type: "reasoning", id: `rs_${logical}`, summary: [], encrypted_content: logical === 1 && !media ? "synthetic-opaque".repeat(48_000) : "synthetic-short" },
    ...Array.from({ length: 5 }, (_, i) => ({ type: "function_call", id: `fc_${logical}_${i}`, call_id: `call_${logical}_${i}`, name: "Read", arguments: JSON.stringify({ path: "fixture.txt", offset: i + 1 + (logical - 1) * 5, limit: 350 }), status: "completed" })),
  ];
  // One response without a header, a false header, or a mismatched total must never inherit prior true.
  const header = logical === 2 && (mode === "missing" || media) ? undefined : logical === 2 && mode === "false" ? "false" : "true";
  return complete(logical, items, header);
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
let error = "";
let text = "";
try {
  const result = await runOpenAiCodex({ text: "synthetic pressure fixture", channel: "cli", threadKey: `regr:pressure:${mode}`, cwd, model: requestModel,
    ...(mode === "visible-overflow" ? {} : { workerDepth: 1 }),
    ...(media ? { attachments: [{ kind: "image" as const, path: image, filename: "synthetic.png", mimeType: "image/png", bytes: 650_000 }] } : {}),
  });
  text = result.text;
} catch (e) { error = String(e); }
unsub();
console.log("PRESSURE_RESULT " + JSON.stringify({ mode, observations, starts, error, text, sameTransientBody, rescueReduced }));
process.exit(0);
