/** Real adapter + real Read/Write dispatch + real facade classification; synthetic auth/fetch only. */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fakeNetwork, assertIsolated, pinModelForTest } from "./_framework.js";
assertIsolated();
if (process.env.TIGUCLAW_DISABLE_ENV_FILE !== "1" || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL !== "1") throw new Error("isolated fake-network runner required");
process.env.TIGUCLAW_REGRESSION = "1";
const mode = process.argv[2] ?? "401";
const tool = process.argv[3] ?? "Read";
const home = process.env.TIGUCLAW_HOME!;
const cwd = path.join(home, "fixture");
mkdirSync(cwd, { recursive: true });
const marker = "synthetic-executed-once";
writeFileSync(path.join(cwd, "fixture.txt"), 'synthetic row \"한글\" \\ data\n'.repeat(350));
pinModelForTest("codex:gpt-5.6-sol");
if (mode === "retry-search") writeFileSync(path.join(process.env.TIGUCLAW_HOME!, "model-catalog.json"), JSON.stringify({ fetchedAt: Date.now(), models: { codex: ["gpt-5.6-sol"] }, toolSearch: { "codex:gpt-5.6-sol": true } }));
const zero = mode.startsWith("zero-");
const recovery = mode.startsWith("retry-");
process.env.CODEX_TOOL_SEARCH = !zero && (!recovery || mode === "retry-search") ? "1" : "0";
if (zero || recovery) process.env.CODEX_WEB_SEARCH = mode.includes("native") ? "1" : "0";
if (mode === "retry-stall" || mode === "retry-stall-exhaust") {
  process.env.CODEX_NO_PROGRESS_MS = "40";
  process.env.CODEX_STALL_BACKOFF_MS = "1";
}

const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
registerAuthProvider({ provider: "codex", getAccessToken: async () => "synthetic-token" });
const { getEventBus } = await import("../../core/eventbus.js");
const { createReplayGuard, canReplay } = await import("../../core/llm-runtime/replay-safety.js");
const { classifyCooldown } = await import("../../core/llm-runtime/rate-limit.js");
const { getCooldownRow } = await import("../../store/cooldowns.js");
const { initStore } = await import("../../store/sessions.js");
initStore();
let starts = 0;
const unsub = getEventBus().subscribe((e) => {
  if (e.type === "llm.activity" && e.payload.kind === "tool" && e.payload.phase !== "end") starts++;
});
const frame = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const completed = (output: Array<Record<string, unknown>>) => new Response(frame([
  ...output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" } : item },
    { type: "response.output_item.done", output_index, item },
  ]),
  { type: "response.completed", response: { id: "synthetic_first", output } },
]));
const ac = new AbortController();
// A synthetic never-ending stream has no socket handle; keep Node alive so the
// product's unref'ed no-progress timer can fire, just as it does with real I/O.
const streamKeepAlive = mode.startsWith("retry-stall") ? setInterval(() => {}, 1000) : undefined;
const cancellation = Object.assign(new Error("synthetic user stop"), { name: "UserCancelledError" });
const networkCause = Object.assign(new Error("synthetic socket closed"), { code: "ECONNRESET" });
const networkError = Object.assign(new TypeError("synthetic fetch failed", { cause: networkCause }), { code: "SYNTHETIC_NETWORK" });
const wire: string[] = [];
let requests = 0;
globalThis.fetch = fakeNetwork(async (_u, init) => {
  requests++;
  wire.push(String(init?.body));
  const context = () => new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 });
  if (zero) {
    if (mode === "zero-failed-read" && requests === 1) return completed([{ type: "function_call", id: "missing", call_id: "missing", name: "Read", arguments: JSON.stringify({ path: "missing.txt" }), status: "completed" }]);
    if (mode.includes("sse") || mode === "zero-text" || mode === "zero-external") return new Response(frame([
      ...(mode === "zero-text" ? [{ type: "response.output_text.delta", delta: "already visible" }] : []),
      ...(mode === "zero-external" ? [{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "ext", call_id: "ext", name: "external_fixture", arguments: "" } }] : []),
      { type: "response.failed", response: { error: { code: "context_length_exceeded" } } },
    ]));
    return context();
  }
  if (requests <= 2) return completed(Array.from({ length: requests === 1 ? 5 : 1 }, (_, i) => ({
    type: "function_call", id: `synthetic_call_${requests}_${i}`, call_id: `synthetic_call_${requests}_${i}`,
    name: requests === 1 ? "Read" : tool,
    arguments: JSON.stringify(requests === 1 || tool === "Read" ? { path: "fixture.txt", offset: i + 1, limit: 350 } : { path: "written.txt", content: marker }), status: "completed",
  })));
  if (requests === 3 || mode === "context") return context();
  if (recovery) {
    const fail = requests === 4 || mode.endsWith("exhaust");
    if (fail && mode.startsWith("retry-stall")) return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.error(init?.signal?.reason), { once: true }); } }));
    if (fail && mode === "retry-cut") return new Response(new ReadableStream({ start(c) { c.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })); } }));
    if (fail) {
      if (mode === "retry-cancel") setTimeout(() => ac.abort(cancellation), 10);
      return new Response(frame([
        ...(mode === "retry-partial" ? [{ type: "response.output_text.delta", delta: "partial response" }] : []),
        ...(mode === "retry-external" ? [{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "ext", call_id: "ext", name: "external_fixture", arguments: "" } }] : []),
        { type: "response.failed", response: { id: "synthetic_transient", error: { code: "server_error", message: "synthetic transient backend" } } },
      ]));
    }
    return new Response(frame([
      { type: "response.output_text.delta", delta: "recovered current step" },
      { type: "response.completed", response: { id: "synthetic_recovered", status: "completed", output: [] } },
    ]));
  }
  if (mode === "network") throw networkError;
  if (mode === "cancel") { ac.abort(cancellation); throw cancellation; }
  if (mode === "sse-auth") return new Response(frame([{ type: "response.failed", response: { id: "synthetic_failed", error: { code: "authentication_error", message: "synthetic access rejected" } } }]));
  const status = Number(mode);
  const code = status === 429 ? "usage_limit_reached" : status === 400 ? "invalid_prompt" : "invalid_api_key";
  return new Response(JSON.stringify({ error: { code, message: "synthetic upstream failure preserved" } }), { status });
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const { runRegionA, __setAdapterForTest, clearCooldownKeys } = await import("../../core/llm-runtime/index.js");
const { CodexContextLimitError } = await import("../../core/llm-runtime/adapters/_codex-pressure.js");
const replay = createReplayGuard();
if (mode === "zero-blocked") replay.blockedReason = "synthetic already blocked turn";
const provider = `synthetic-rescue-${mode}-${tool}`;
let fallback = 0;
let attempts = 0;
const restore = __setAdapterForTest(async (_adapter, input) => {
  attempts++;
  if (input.model === "synthetic-fallback") { fallback++; return { text: "INCORRECT_FALLBACK" }; }
  return await runOpenAiCodex(input);
});
let error: unknown;
let text = "";
try {
  text = (await runRegionA({ text: "synthetic rescue error fixture", channel: "cli", threadKey: `regr:rescue-error:${mode}:${tool}`, cwd, workerDepth: mode === "zero-text" ? 0 : 1, replay, abortSignal: ac.signal, internal: true, extraMcpServers: {}, ...(mode.endsWith("external") ? { externalTools: [{ name: "external_fixture", parameters: { type: "object", properties: {} } }] } : {}) }, {
    chain: [[{ adapter: "codex-oauth", model: "gpt-5.6-sol", provider }, { adapter: "codex-oauth", model: "synthetic-fallback", provider: "synthetic-fallback" }], [{ adapter: "codex-oauth", model: "synthetic-fallback", provider: "synthetic-fallback" }]],
  })).text;
} catch (e) { error = e; }
finally { restore(); unsub(); if (streamKeepAlive !== undefined) clearInterval(streamKeepAlive); }
const err = error instanceof Error ? error : undefined;
const cooldown = getCooldownRow(provider, Date.now());
const record = { mode, tool, requests, starts, attempts, fallback, text, message: err?.message ?? "", name: err?.constructor.name, context: error instanceof CodexContextLimitError,
  classified: classifyCooldown(error, err?.message ?? ""), cooldown: cooldown === null ? null : cooldown.untilTs - Date.now() > 3_600_000 ? "auth" : "limit",
  replayAllowed: canReplay(replay), networkIdentity: error === networkError, causeIdentity: err?.cause === networkCause,
  networkCode: (error as { code?: string } | undefined)?.code, causeCode: (err?.cause as { code?: string } | undefined)?.code,
  cancellationIdentity: error === cancellation,
  providerToolsOffered: (JSON.parse(wire[zero ? 0 : 3] ?? "{}").tools as Array<{type:string}> | undefined)?.some(t => t.type === "web_search" || t.type === "tool_search") ?? false,
  reduced: (wire[3]?.length ?? Infinity) < (wire[2]?.length ?? 0),
  sameRetryBody: wire.slice(3).every((w) => w === wire[3]),
  writeContent: tool === "Write" && existsSync(path.join(cwd, "written.txt")) ? readFileSync(path.join(cwd, "written.txt"), "utf8") : undefined,
};
clearCooldownKeys([provider, "synthetic-fallback"]);
console.log("RESCUE_ERROR_RESULT " + JSON.stringify(record));
process.exit(0);
