/**
 * `adapter-contract` 의 자식 — **시나리오 하나를 세 어댑터에 똑같이** 돌린다 (2026-10-18, 정태님 «능력 비대칭 검토도 자동으로»).
 *
 * ★왜: OpenAI 어댑터가 취소를 «빈 성공» 으로 돌려주던 결함이 몇 달 살아 있었다 — 어댑터마다 자기 검사만 있었고, 같은 상황을
 *  세 어댑터에 같은 모양으로 던져 보는 그물이 없었다. 여기선 시나리오를 **추상 대본**(텍스트 조각·취소·완료)으로 한 번 적고,
 *  어댑터별 번역기가 각자의 가짜 경계로 옮긴다 — Codex=가짜 네트워크(SSE) · Claude=가짜 SDK 질의 · OpenAI=주입한 가짜 Model.
 *  시나리오를 하나 더하면 세 어댑터에 자동으로 걸린다.
 * ★자식인 이유: `fetch` 스텁·인증 전역·가짜 Model 주입이 프로세스를 오염시킨다. 어댑터×시나리오 하나 = 프로세스 하나.
 *
 * 사용: `<adapter: codex|claude|openai> <scenario> [facade]` · 출력: 마지막 줄 JSON.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const [adapter, scenario, via] = process.argv.slice(2) as ["codex" | "claude" | "openai", string, string | undefined];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 추상 대본 — 모델 호출 한 번이 내는 것. `abort` 는 그 자리에서 턴을 끊고, `hang` 은 취소될 때까지 매달린다.
 * `call` 은 도구 호출로 그 모델 호출을 끝내고, `answer-from-tool` 은 **모델이 받은 입력에서** 도구 결과를 찾아 답한다
 * (결과가 모델까지 돌아왔는지를 그것으로 본다). `next` = 두 번째 모델 호출의 대본.
 */
/** 그 모델 호출이 보고할 사용량 — 공급자 중립(입력은 캐시 포함). 번역기가 각 공급자 형식으로 옮긴다(Anthropic 은 캐시를 빼고 준다). */
type CallUsage = { input: number; cached: number; output: number };
type Step =
  | { t: "text"; s: string }
  | { t: "abort"; reason: "user" | "turn-timeout" }
  | { t: "hang" }
  | { t: "done"; text: string; usage?: CallUsage }
  | { t: "call"; tool: string; args: Record<string, unknown>; usage?: CallUsage }
  | { t: "answer-from-tool"; usage?: CallUsage };
type Scenario = { pre?: "user"; steps: Step[]; next?: Step[]; remote?: true };
const SCENARIOS: Record<string, Scenario> = {
  complete: { steps: [{ t: "text", s: "끝" }, { t: "done", text: "끝" }] },
  "abort-before-output": { steps: [{ t: "abort", reason: "user" }, { t: "hang" }] },
  "abort-mid-text": { steps: [{ t: "text", s: "작업을 시작합니다. 첫째로 " }, { t: "abort", reason: "turn-timeout" }, { t: "hang" }] },
  "pre-aborted": { pre: "user", steps: [{ t: "text", s: "안 나와야 한다" }, { t: "done", text: "안 나와야 한다" }] },
  // 원격(Streamable HTTP) MCP 도구 — 설정의 `${VAR}` 확장·헤더가 서버까지 가고, 결과가 모델에 돌아온다.
  "remote-tool": { remote: true, steps: [{ t: "call", tool: "remote_echo", args: { text: "ping-1" } }], next: [{ t: "answer-from-tool" }] },
  // 사용량 — 모델 호출 두 번(도구 → 답). 같은 의미로 돌아와야 한다: 마지막 호출 / 턴 합계 / 캐시 포함 관계.
  "usage-two-calls": {
    remote: true,
    steps: [{ t: "call", tool: "remote_echo", args: { text: "ping-1" }, usage: { input: 100, cached: 40, output: 10 } }],
    next: [{ t: "answer-from-tool", usage: { input: 150, cached: 120, output: 20 } }],
  },
};
const ECHO = /echo:[A-Za-z0-9-]+:[A-Za-z0-9-]*/;

/** 원격 MCP 서버(실제 HTTP · 세션 있는 Streamable HTTP) — 받은 호출과 그때의 헤더를 적는다. */
const startRemoteMcp = async () => {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { z } = await import("zod");
  const got: Array<{ text: string; hdr: string }> = [];
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
  let hdr = "";
  const http = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      void (async () => {
        hdr = String(req.headers["x-regression"] ?? "");
        const sid = req.headers["mcp-session-id"];
        let t = typeof sid === "string" ? transports.get(sid) : undefined;
        if (t === undefined) {
          t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t!) });
          const srv = new McpServer({ name: "regr-remote", version: "1.0.0" });
          srv.tool("remote_echo", "원격 에코", { text: z.string() }, async ({ text }) => {
            got.push({ text, hdr });
            return { content: [{ type: "text", text: `echo:${text}:${hdr}` }] };
          });
          await srv.connect(t);
        }
        await t.handleRequest(req, res, b === "" ? undefined : JSON.parse(b));
      })();
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, got };
};

const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `contract-${adapter}-`));
  const sc = SCENARIOS[scenario];
  if (sc === undefined) throw new Error(`unknown scenario ${scenario}`);
  const { initStore } = await import("../../store/sessions.js");
  const { UserCancelledError } = await import("../../core/steering.js");
  const { TurnTimeoutError } = await import("../../core/llm-runtime/turn-timeout.js");
  const { getEventBus } = await import("../../core/eventbus.js");
  initStore();
  const remote = sc.remote === true ? await startRemoteMcp() : undefined;
  if (remote !== undefined) {
    // 설정은 사용자가 쓰는 모양 그대로 — 값은 `${VAR}` 로 두고 환경에서 채운다.
    process.env.REGR_REMOTE_URL = remote.url;
    process.env.REGR_REMOTE_HDR = "hdr-ok";
    writeFileSync(path.join(process.env.TIGUCLAW_HOME, "mcp.json"), JSON.stringify({ mcpServers: { regremote: { type: "http", url: "${REGR_REMOTE_URL}", headers: { "X-Regression": "${REGR_REMOTE_HDR}" } } } }));
  }
  /** 가짜 네트워크가 원격 MCP 서버(루프백)로 가는 요청만 실제로 보낸다. */
  const realFetch = globalThis.fetch;
  const toRemote = (url: unknown): boolean => remote !== undefined && String(url).startsWith(remote.url);
  const turnAc = new AbortController();
  const reasonOf = (r: "user" | "turn-timeout"): Error => (r === "user" ? new UserCancelledError() : new TurnTimeoutError(1));
  let calls = 0;
  const threadKey = `cli:contract-${adapter}-${scenario}-${via ?? "adapter"}`;
  const events: string[] = [];
  getEventBus().subscribe((ev) => {
    const tk = (ev.payload as { threadKey?: unknown } | undefined)?.threadKey;
    if (tk === threadKey && (ev.type === "llm.turn_done" || ev.type === "llm.turn_error")) events.push(ev.type);
  });

  // ── 번역기 — 대본을 각 어댑터의 가짜 경계로 ───────────────────────────────────────────────
  type Emit = { text: (s: string) => void; done: (t: string, u?: CallUsage) => void; call?: (tool: string, args: Record<string, unknown>, u?: CallUsage) => void };
  /**
   * 대본을 돌리며 콜백으로 낸다. `n` = 몇 번째 모델 호출 · `seen` = 그 호출에서 모델이 받은 입력(직렬화).
   * 반환 = 완료(done) / 도구 호출로 끝남(called) / 매달렸다 끊김(hung).
   */
  const play = async (signal: AbortSignal | undefined, emit: Emit, n = 1, seen = ""): Promise<"done" | "called" | "hung"> => {
    for (const st of n > 1 && sc.next !== undefined ? sc.next : sc.steps) {
      if (st.t === "text") emit.text(st.s);
      else if (st.t === "abort") turnAc.abort(reasonOf(st.reason));
      else if (st.t === "done" || st.t === "answer-from-tool") {
        if (st.t === "answer-from-tool") {
          // 실제 모델처럼 텍스트를 흘린 뒤 끝낸다(`complete` 대본과 같은 모양).
          const t = `결과 ${seen.match(ECHO)?.[0] ?? "없음"}`;
          emit.text(t);
          emit.done(t, st.usage);
        } else emit.done(st.text, st.usage);
        return "done";
      } else if (st.t === "call") {
        emit.call?.(st.tool, st.args, st.usage);
        return "called";
      } else {
        await new Promise<void>((r) => (signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true })));
        return "hung";
      }
      await sleep(2);
    }
    return "hung";
  };

  let runTurn: () => Promise<{ text: string; usage?: unknown }>;
  // 공급자 형식 — Responses API(Codex): input_tokens 는 캐시 포함, 캐시는 상세에.
  const codexUsage = (u?: CallUsage) =>
    u === undefined ? { input_tokens: 10, output_tokens: 5 } : { input_tokens: u.input, input_tokens_details: { cached_tokens: u.cached }, output_tokens: u.output };
  // Agents SDK Model 응답 — 캐시 포함 입력 + inputTokensDetails.cached_tokens.
  const agentsUsage = (u?: CallUsage) =>
    u === undefined
      ? { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }
      : { inputTokens: u.input, outputTokens: u.output, totalTokens: u.input + u.output, requests: 1, inputTokensDetails: { cached_tokens: u.cached } };
  let cliSeen: { configHasSecret: boolean; blocksCliAuth: boolean } | undefined;
  const input = { text: "해줘", threadKey, channel: "cli", cwd: process.env.TIGUCLAW_HOME, abortSignal: turnAc.signal };
  if (adapter === "codex") {
    const enc = new TextEncoder();
    (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string, init: { signal?: AbortSignal; body?: unknown }): Promise<Response> => {
      if (toRemote(url)) return realFetch(url, init as RequestInit);
      if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
      calls += 1;
      const n = calls;
      const seen = typeof init.body === "string" ? init.body : "";
      const sig = init.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            const send = (e: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            let finished = false;
            const done = await play(sig, {
              text: (s) => send({ type: "response.output_text.delta", delta: s }),
              done: (t, u) => {
                send({ type: "response.output_item.done", item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: t }] } });
                send({ type: "response.completed", response: { id: "r1", usage: codexUsage(u) } });
                finished = true;
              },
              call: (tool, args, u) => {
                const item = { type: "function_call", id: "fc1", call_id: "c1", name: tool };
                send({ type: "response.output_item.added", item: { ...item, arguments: "" } });
                send({ type: "response.output_item.done", item: { ...item, arguments: JSON.stringify(args) } });
                send({ type: "response.completed", response: { id: "r1", usage: codexUsage(u) } });
                finished = true;
              },
            }, n, seen);
            try {
              if (done !== "hung" && finished) c.close();
              else c.error(sig?.reason ?? new Error("aborted"));
            } catch {
              /* 이미 닫힘 */
            }
          },
        }),
        { status: 200 },
      );
    });
    const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
    registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
    const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
    runTurn = () => runOpenAiCodex(input as never);
  } else if (adapter === "openai") {
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
      if (toRemote(url)) return realFetch(url as string, init);
      throw new Error("REGRESSION_NETWORK_BLOCKED");
    };
    const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
    injectRegressionModel({
      getResponse: async () => {
        throw new Error("스트림만 쓴다");
      },
      async *getStreamedResponse(req: { signal?: AbortSignal; input?: unknown }) {
        calls += 1;
        yield { type: "response_started" };
        const q: unknown[] = [];
        let finalText: string | undefined;
        let toolCall: { tool: string; args: Record<string, unknown> } | undefined;
        let callUsage: CallUsage | undefined;
        const done = await play(req.signal, { text: (s) => q.push({ type: "output_text_delta", delta: s }), done: (t, u) => { finalText = t; callUsage = u; }, call: (tool, args, u) => { toolCall = { tool, args }; callUsage = u; } }, calls, JSON.stringify(req.input ?? ""));
        for (const e of q) yield e;
        if (done === "called" && toolCall !== undefined) {
          yield { type: "response_done", response: { id: "r", usage: agentsUsage(callUsage), output: [{ type: "function_call", id: "fc1", callId: "c1", name: toolCall.tool, arguments: JSON.stringify(toolCall.args), status: "completed" }] } };
          return;
        }
        if (done !== "done" || finalText === undefined) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield { type: "response_done", response: { id: "r", usage: agentsUsage(callUsage), output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: finalText }] }] } };
      },
    });
    const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
    runTurn = () => runOpenAi({ ...input, model: "gpt-regression", provider: "openai" } as never);
  } else {
    const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
    const say = (text: string) => ({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text }] } });
    /**
     * 실제 Claude CLI 는 도구를 **자기가** 부른다 — 가짜도 그렇게 한다: 어댑터가 넘긴 `options.mcpServers` 설정만으로
     * 원격 서버에 붙어 호출한다(그 설정으로 서버에 닿는가가 Claude 쪽 계약이다).
     */
    const callViaConfig = async (cfg: unknown, env: Record<string, string> | undefined, tool: string, args: Record<string, unknown>): Promise<string> => {
      const c = cfg as { type?: string; url: string; headers?: Record<string, string> } | undefined;
      if (c?.type !== "http" || typeof c.url !== "string") return `설정 없음:${JSON.stringify(cfg ?? null).slice(0, 80)}`;
      // 실제 CLI 처럼 헤더의 `${VAR}` 를 **자기 환경**(어댑터가 넘긴 options.env, 없으면 이 프로세스)에서 채운다(2026-10-18 실CLI 로 확인한 동작).
      const fill = (v: string): string => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => (env ?? (process.env as Record<string, string>))[k] ?? "");
      c.headers = Object.fromEntries(Object.entries(c.headers ?? {}).map(([h, v]) => [h, fill(v)]));
      c.url = fill(c.url); // 어댑터는 파일에 적힌 모양(`${VAR}`)을 넘긴다 — CLI 가 URL 도 채운다.
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "fake-claude-cli", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers ?? {} } }));
      const r = (await client.callTool({ name: tool, arguments: args })) as { content?: Array<{ text?: string }> };
      await client.close();
      return (r.content ?? []).map((x) => x.text ?? "").join("");
    };
    const fake = ((args: { options: { abortController: AbortController; mcpServers?: Record<string, unknown>; env?: Record<string, string>; disallowedTools?: string[] } }) => {
      calls += 1;
      if (remote !== undefined) {
        // ★CLI 명령줄로 가는 것(=설정 JSON)에 헤더 값이 없어야 하고, CLI 자체 로그인 도구는 막혀 있어야 한다.
        cliSeen = { configHasSecret: JSON.stringify(Object.values(args.options.mcpServers ?? {}).filter((c) => (c as { type?: string }).type !== "sdk")).includes("hdr-ok"), blocksCliAuth: (args.options.disallowedTools ?? []).includes("mcp__regremote__complete_authentication") };
      }
      const sig = args.options.abortController.signal;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
        const q: unknown[] = [];
        let finalText: string | undefined;
        let toolCall: { tool: string; args: Record<string, unknown> } | undefined;
        // 모델 호출 한 번의 스트림 이벤트(Anthropic 형식 — input_tokens 는 캐시를 **뺀** 값, 캐시 읽기는 따로) + 그 호출의 assistant 메시지.
        let msgN = 0;
        const callEvents = (u: CallUsage | undefined, content: unknown[]): void => {
          if (u === undefined) return;
          msgN += 1;
          const id = `msg_${msgN}`;
          const raw = { input_tokens: u.input - u.cached, cache_read_input_tokens: u.cached, cache_creation_input_tokens: 0 };
          const ev = (event: unknown) => q.push({ type: "stream_event", session_id: "s", parent_tool_use_id: null, event });
          ev({ type: "message_start", message: { id, model: "claude-fake", usage: { ...raw, output_tokens: 1 } } });
          ev({ type: "message_delta", usage: { ...raw, output_tokens: u.output } });
          ev({ type: "message_stop" });
          q.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { id, role: "assistant", model: "claude-fake", content, usage: { ...raw, output_tokens: 1 } } });
        };
        const emit: Emit = {
          text: (s) => q.push(say(s)),
          done: (t, u) => { finalText = t; callEvents(u, [{ type: "text", text: t }]); },
          call: (tool, a, u) => { toolCall = { tool, args: a }; callEvents(u, [{ type: "tool_use", id: "tu1", name: `mcp__regremote__${tool}`, input: a }]); },
        };
        // ★실제 SDK 처럼 **취소되면 조용히 끝난다**(가장 나쁜 쪽 — 어댑터가 승격해야 한다).
        let done = await play(sig, emit);
        if (done === "called" && toolCall !== undefined) {
          const seen = await callViaConfig(structuredClone(args.options.mcpServers?.regremote), args.options.env, toolCall.tool, toolCall.args).catch((e: unknown) => `호출 실패:${String(e).slice(0, 80)}`);
          done = await play(sig, emit, 2, seen);
        }
        for (const f of q) yield f;
        if (done === "done" && finalText !== undefined) {
          yield { type: "result", subtype: "success", is_error: false, result: finalText, num_turns: 1, session_id: "s-new", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        }
      })();
    }) as never;
    (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: unknown, init?: RequestInit) => {
      if (toRemote(url)) return realFetch(url as string, init);
      throw new Error("REGRESSION_NETWORK_BLOCKED");
    });
    runTurn = () => withFakeClaudeQuery(fake, () => runClaude(input as never));
    if (via === "facade") {
      const inner = runTurn;
      runTurn = inner; // facade 는 아래에서 withFakeClaudeQuery 로 감싼다
    }
    // facade 경로는 같은 가짜를 씌운 채 runRegionA 로.
    if (via === "facade") {
      const { runRegionA } = await import("../../core/llm-runtime/index.js");
      runTurn = () => withFakeClaudeQuery(fake, () => runRegionA(input as never, { specs: [{ adapter: "claude", model: "claude-fake", provider: "anthropic" }] }));
    }
  }
  if (via === "facade" && adapter !== "claude") {
    const { runRegionA } = await import("../../core/llm-runtime/index.js");
    const spec = adapter === "codex" ? { adapter: "codex-oauth", model: "gpt-regression", provider: "codex" } : { adapter: "openai", model: "gpt-regression", provider: "openai" };
    runTurn = () => runRegionA(input as never, { specs: [spec as never] });
  }

  if (sc.pre !== undefined) turnAc.abort(reasonOf(sc.pre));
  let out: Record<string, unknown>;
  try {
    const r = await runTurn();
    out = { outcome: "returned", text: r.text, ...(r.usage !== undefined ? { usage: r.usage } : {}) };
  } catch (e) {
    out = { outcome: "threw", name: (e as Error).name, message: String((e as Error).message).slice(0, 120), ...(process.env.CONTRACT_DEBUG === "1" ? { stack: String((e as Error).stack).slice(0, 900) } : {}) };
  }
  console.log(JSON.stringify({ ...out, calls, events, ...(remote !== undefined ? { remoteCalls: remote.got } : {}), ...(cliSeen !== undefined ? { cli: cliSeen } : {}) }));
  process.exit(0);
};

main().catch((e) => {
  console.log(JSON.stringify({ outcome: "harness-error", message: String((e as Error)?.stack ?? e).slice(0, 400) }));
  process.exit(0);
});
