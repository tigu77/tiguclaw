/**
 * `codex-tool-folding` 의 자식 — 실제 `runOpenAiCodex` 를 가짜 네트워크로 돌려 **접기가 켜진 요청의 모양**을 본다(2026-10-19 적대 검토).
 * ★자식인 이유: `fetch` 스텁·인증 전역·홈 모델 카탈로그를 바꾼다. 모드 하나 = 프로세스 하나. 출력: 마지막 줄 JSON.
 *  empty     — 첫 응답이 검색 + 접힌 도구 호출, 이후 빈 응답 → 마무리 요청(`tools: []`)의 입력에 접기 흔적이 없어야 한다.
 *  reject400 — 접힌 요청을 400 으로 거절 → 이 턴은 접기를 끄고 한 번 다시 보내 답을 받아야 한다(다른 어댑터로 넘기지 않는다).
 *  external  — 실제 로컬 HTTP MCP 서버(mcp.json)를 붙인다 → 그 서버의 도구는 표식이 없어도 서버 이름 묶음으로 접혀 실려야 한다.
 *  reject400-later   — 접힌 채 도구를 한 번 부른 뒤 둘째 요청이 400 → 그 뒤 요청은 전부 펼친 채·흔적 없이(같은 턴의 다음 iteration 포함).
 *  reject400-then-503 — 400 뒤 재전송이 503 → 재시도 루프가 흡수해 답을 받는다.
 *  plain400  — 접기를 끈 요청의 400 → 다시 보내지 않는다(안전망은 접힌 요청에만).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const mode = process.argv[2] ?? "empty";
if (mode === "plain400") process.env.CODEX_TOOL_SEARCH = "0";
type Body = { tools: Array<{ type: string; name?: string }>; input: Array<{ type: string; namespace?: string }> };
const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "codex-fold-"));
  const MODEL = "gpt-regression-fold";
  writeFileSync(path.join(process.env.TIGUCLAW_HOME, "model-catalog.json"), JSON.stringify({ fetchedAt: Date.now(), models: { codex: [MODEL] }, toolSearch: { [`codex:${MODEL}`]: true } }));
  const realFetch = globalThis.fetch;
  let mcpUrl = "";
  if (mode === "external") {
    const { createServer } = await import("node:http");
    const { randomUUID } = await import("node:crypto");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { z } = await import("zod");
    const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
    const http = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => void (async () => {
        const sid = req.headers["mcp-session-id"];
        let t = typeof sid === "string" ? transports.get(sid) : undefined;
        if (t === undefined) {
          t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t!) });
          const srv = new McpServer({ name: "regext", version: "1" });
          srv.tool("ext_echo", "외부 에코", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
          await srv.connect(t);
        }
        await t.handleRequest(req, res, b === "" ? undefined : JSON.parse(b));
      })());
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    mcpUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
    writeFileSync(path.join(process.env.TIGUCLAW_HOME, "mcp.json"), JSON.stringify({ mcpServers: { regext: { type: "http", url: mcpUrl } } }));
  }
  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const reqs: Body[] = [];
  const sizes: number[] = [];
  const sse = (evs: unknown[]) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
  const answer = () => sse([{ type: "response.output_text.delta", delta: "끝" }, { type: "response.completed", response: { id: "ra", usage: { input_tokens: 1, output_tokens: 1 } } }]);
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: unknown, init: { body?: unknown }) => {
    if (mcpUrl !== "" && String(url).startsWith(mcpUrl)) return realFetch(url as string, init as RequestInit);
    const body = JSON.parse(String(init?.body)) as Body;
    reqs.push(body);
    sizes.push(String(init?.body).length);
    const folded = body.tools.some((t) => t.type === "namespace");
    if (mode === "reject400") return folded ? new Response("invalid namespace tool shape", { status: 400 }) : answer();
    if (mode === "external") return answer();
    if (mode === "plain400") return new Response("bad request", { status: 400 });
    if (mode === "reject400-then-503") {
      if (folded) return new Response("invalid namespace tool shape", { status: 400 });
      return reqs.filter((r) => !r.tools.some((t) => t.type === "namespace")).length === 1 ? new Response("busy", { status: 503 }) : answer();
    }
    if (mode === "reject400-later" && reqs.length >= 2) {
      if (folded) return new Response("invalid namespace tool shape", { status: 400 });
      // 펼친 뒤 첫 응답은 도구를 한 번 더(이름만) — 그다음 iteration 도 펼친 채인지 본다.
      if (reqs.filter((r) => !r.tools.some((t) => t.type === "namespace")).length === 1) {
        const fc2 = { id: "fc_2", type: "function_call", status: "completed", call_id: "call_2", name: "list_commands", arguments: "{}" };
        return sse([
          { type: "response.output_item.added", output_index: 0, item: { ...fc2, status: "in_progress", arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: fc2 },
          { type: "response.completed", response: { id: "r3", output: [fc2], usage: { input_tokens: 1, output_tokens: 1 } } },
        ]);
      }
      return answer();
    }
    if (reqs.length === 1) {
      const ns = body.tools.find((t) => t.type === "namespace" && t.name === "commands");
      const sc = { id: "tsc_1", type: "tool_search_call", status: "completed", arguments: { paths: ["commands"] }, call_id: null, execution: "server" };
      const so = { id: "tso_1", type: "tool_search_output", status: "completed", call_id: null, execution: "server", tools: ns ? [ns] : [] };
      const fc = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "list_commands", namespace: "commands", arguments: "{}" };
      return sse([
        { type: "response.output_item.done", output_index: 0, item: sc },
        { type: "response.output_item.done", output_index: 1, item: so },
        { type: "response.output_item.added", output_index: 2, item: { ...fc, status: "in_progress", arguments: "" } },
        { type: "response.output_item.done", output_index: 2, item: fc },
        { type: "response.completed", response: { id: "r1", output: [sc, so, fc], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    return sse([{ type: "response.completed", response: { id: `r${reqs.length}`, output: [], usage: { input_tokens: 1, output_tokens: 1 } } }]);
  });
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  let text: string | null = null;
  let err: string | null = null;
  try {
    text = (await runOpenAiCodex({ text: "합성 검사", channel: "cli", threadKey: `regr:codex-fold-${mode}`, model: MODEL, cwd: process.env.TIGUCLAW_HOME } as never)).text;
  } catch (e) {
    err = String((e as Error)?.message ?? e).slice(0, 200);
  }
  const first = reqs[0];
  const extNs = first?.tools.find((t) => t.type === "namespace" && t.name === "regext") as { tools?: Array<{ name: string; defer_loading?: boolean }> } | undefined;
  const external = {
    folded: extNs?.tools?.some((t) => t.name === "ext_echo" && t.defer_loading === true) ?? false,
    flat: first?.tools.some((t) => t.type === "function" && t.name === "ext_echo") ?? false,
  };
  const shape = reqs.map((r) => ({
    tools: r.tools.length,
    folded: r.tools.some((t) => t.type === "namespace"),
    traces: r.input.filter((i) => i.type === "tool_search_call" || i.type === "tool_search_output" || i.namespace !== undefined).length,
  }));
  console.log(JSON.stringify({ text, err, shape, external, sizes }));
  process.exit(0);
};
main().catch((e) => {
  console.log(JSON.stringify({ text: null, err: `harness: ${String(e).slice(0, 200)}`, shape: [] }));
  process.exit(0);
});
