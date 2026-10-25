/**
 * 회귀: **원격 MCP(Streamable HTTP + 토큰 헤더)를 붙인다** (2026-10-18, Claude Code 대비 감사 1번 · 정태님 «다 지원해야지»).
 *
 * 사고: `add_mcp_server` 가 url 이면 **무조건 SSE** 로 저장했고, Codex·OpenAI 브리지는 stdio·SSE 만 알며 SSE 에도 헤더를 안 넘겼다 —
 *  GitHub·Linear·Notion 류 지금 표준(HTTP + 토큰) 원격 서버에 붙을 길이 없었다. Claude Code 는 `--transport http` 로 된다.
 *
 * 본다(로컬에 띄운 **진짜 HTTP MCP 서버** — 토큰을 요구한다):
 *  ① 브리지(Codex·OpenAI 경로)가 헤더를 붙여 연결하고 도구를 실제로 부른다 · 틀린 토큰은 붙지 않는다
 *  ② `${VAR}` 는 읽을 때 데몬 환경으로 바뀐다 · 없는 변수면 그 서버만 건너뛴다(반쪽 헤더로 보내지 않는다 — 서버에 요청 0)
 *  ③ Claude 경로(설정을 SDK 에 그대로 넘김)가 받는 모양 = `type:"http"` + 바뀐 헤더 · 파일엔 `${VAR}` 그대로(비밀이 되써지지 않는다)
 *  ④ `add_mcp_server` — url 이면 기본 http · transport:"sse" 면 sse · headers 저장 · 목록 표시는 헤더 **이름만**
 *  ⑦ 리다이렉트 — 같은 출처는 따라가 붙고, 다른 출처는 안 따라간다(목적지에 요청 0)
 *
 * 등급: **실행**(격리 홈 · 같은 프로세스의 실제 HTTP 서버).
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const TOKEN = "regr-remote-token";
const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b === "" ? undefined : JSON.parse(b));
      } catch {
        resolve(undefined);
      }
    });
  });

export const check: RegressionCheck = {
  name: "remote-mcp-http",
  guards: "원격 MCP 를 못 붙이던 것 — url 이면 무조건 SSE 로 저장 · Codex·OpenAI 브리지는 HTTP 전송이 없고 헤더(토큰)도 안 넘김",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { z } = await import("zod");
    const { getPaths } = await import("../../core/paths.js");
    const ext = await import("../../core/external-mcp.js");
    const { createMcpAdminMcpServer } = await import("../../core/llm-runtime/capabilities/mcp-admin-mcp.js");

    // ── 토큰을 요구하는 진짜 HTTP MCP 서버(상태 있는 세션 — 지금 표준 서버와 같은 모양) ─────────────────────────────
    const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
    let requests = 0;
    let rejected = 0;
    // ⑦ 다른 출처 리다이렉트의 목적지 — 무엇이든 오면 적어 둔다(와선 안 된다).
    const crossSeen: Array<{ method?: string; auth?: string; secret?: string; body: number }> = [];
    const dest = createServer(async (req, res) => {
      let b = "";
      for await (const c of req) b += String(c);
      crossSeen.push({ method: req.method, auth: req.headers.authorization, secret: req.headers["x-regr-secret"] as string | undefined, body: b.length });
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => dest.listen(0, "127.0.0.1", () => r()));
    const destPort = (dest.address() as { port: number }).port;
    const http = createServer(async (req, res) => {
      requests += 1;
      if (req.url?.startsWith("/same")) return void res.writeHead(307, { location: "/mcp" }).end();
      if (req.url?.startsWith("/cross")) return void res.writeHead(307, { location: `http://127.0.0.1:${destPort}/mcp` }).end();
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        rejected += 1;
        res.writeHead(401).end("unauthorized");
        return;
      }
      const body = await readBody(req);
      const sid = req.headers["mcp-session-id"];
      let t = typeof sid === "string" ? transports.get(sid) : undefined;
      if (t === undefined) {
        t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t!) });
        const srv = new McpServer({ name: "regr-remote", version: "1.0.0" });
        srv.tool("echo", "받은 글을 돌려준다", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `REMOTE:${text}` }] }));
        await srv.connect(t);
      }
      await t.handleRequest(req, res, body);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/mcp`;

    const file = path.join(getPaths().home, "mcp.json");
    const prev = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    process.env.REGR_REMOTE_MCP_TOKEN = TOKEN;
    delete process.env.REGR_REMOTE_MCP_UNSET;
    try {
      writeFileSync(file, JSON.stringify({
        mcpServers: {
          remote: { type: "http", url, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_TOKEN}" } },
          wrongtoken: { type: "http", url, headers: { Authorization: "Bearer nope" } },
          missingvar: { type: "http", url, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_UNSET}" } },
        },
      }));

      // ① 브리지 — 연결·도구 목록·호출
      const bridges = await ext.getConnectedExternalMcpBridges();
      const names = bridges.map((b) => b.name).sort();
      const remote = bridges.find((b) => b.name === "remote");
      const tools = remote === undefined ? [] : (await remote.listTools()).map((t) => t.name);
      const called = remote === undefined ? [] : await remote.callTool("echo", { text: "안녕" });
      const calledText = JSON.stringify(called);
      for (const b of bridges) await b.close();
      out.push(assert("★① Codex·OpenAI 브리지가 Streamable HTTP 로 헤더를 붙여 연결하고 원격 도구를 실제로 부른다",
        tools.includes("echo") && calledText.includes("REMOTE:안녕"), JSON.stringify({ names, tools, calledText: calledText.slice(0, 80) })));
      out.push(assert("① 틀린 토큰은 붙지 않는다(401) — 다른 서버를 막지 않는다",
        !names.includes("wrongtoken") && names.includes("remote") && rejected >= 1, JSON.stringify({ names, rejected })));
      const requestsBeforeMissing = requests;

      // ② 없는 변수 — 그 서버만 빠지고, 반쪽 헤더로 요청하지 않는다
      out.push(assert("★② 설정이 쓰는 환경변수가 없으면 그 서버만 건너뛴다(빈 토큰으로 보내지 않는다)",
        !names.includes("missingvar"), JSON.stringify({ names })));

      // ③ Claude 경로가 받는 설정 · 파일엔 이름 그대로
      const forClaude = await ext.readExternalMcpServers();
      const rc = forClaude.remote as { type?: string; headers?: Record<string, string> } | undefined;
      const onDisk = readFileSync(file, "utf8");
      out.push(assert("③ Claude 에 넘기는 설정 = type:http + 바뀐 헤더 · 못 채운 서버는 빠진다 · 파일엔 `${VAR}` 그대로",
        rc?.type === "http" && rc.headers?.Authorization === `Bearer ${TOKEN}` && forClaude.missingvar === undefined &&
          onDisk.includes("${REGR_REMOTE_MCP_TOKEN}") && !onDisk.includes(TOKEN),
        JSON.stringify({ type: rc?.type, auth: rc?.headers?.Authorization === `Bearer ${TOKEN}`, missing: forClaude.missingvar === undefined })));
      void requestsBeforeMissing;

      // ④ add_mcp_server
      const srv = createMcpAdminMcpServer(getPaths().home);
      const reg = (srv.instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, x?: unknown) => Promise<unknown> }> })._registeredTools;
      await reg.add_mcp_server!.handler({ name: "addhttp", url, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_TOKEN}" } }, {});
      await reg.add_mcp_server!.handler({ name: "addsse", url: "http://127.0.0.1:9/sse", transport: "sse" }, {});
      const saved = JSON.parse(readFileSync(file, "utf8")).mcpServers as Record<string, { type?: string; headers?: Record<string, string> }>;
      const listed = JSON.stringify(await reg.list_mcp_servers!.handler({}, {}));
      out.push(assert("★④ add_mcp_server — url 이면 기본 http · transport:'sse' 면 sse · headers 저장(이름 그대로)",
        saved.addhttp?.type === "http" && saved.addhttp.headers?.Authorization === "Bearer ${REGR_REMOTE_MCP_TOKEN}" && saved.addsse?.type === "sse",
        JSON.stringify({ addhttp: saved.addhttp?.type, addsse: saved.addsse?.type })));
      out.push(assert("④ 목록 표시는 헤더 **이름만** — 토큰 값이 답에 실리지 않는다",
        listed.includes("headers: Authorization") && !listed.includes(TOKEN) && !listed.includes("Bearer nope"),
        listed.slice(0, 200)));
      out.push(assert("④ 쓰는 환경변수가 없어 건너뛴 서버도 목록에 보인다(변수 이름 · 재시작 안내) — 안 보이면 또 등록한다",
        listed.includes("missingvar") && listed.includes("REGR_REMOTE_MCP_UNSET"), listed.slice(0, 300)));

      // ⑤ Claude CLI 로 넘기는 모양 — 명령줄(`--mcp-config`)에 비밀 값이 없다(리뷰 10-18 · 적대 검토 P2-3).
      //  `${VAR}` 로 적힌 것은 **적힌 그대로**(CLI 가 채운다 — 실CLI 확인) · 값으로 적은 헤더·OAuth 토큰은 환경변수 참조로.
      process.env.REGR_STDIO_SECRET = "stdio-secret-value";
      writeFileSync(file, JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: `${url}?k=\${REGR_REMOTE_MCP_TOKEN}`, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_TOKEN}", "X-Literal": "literal-secret" } },
          local: { command: "node", args: ["srv.js", "--key=${REGR_STDIO_SECRET}"], env: { K: "${REGR_STDIO_SECRET:-dflt}" } },
          plainurl: { type: "http", url: `${url}?key=\${REGR_REMOTE_MCP_TOKEN}` }, // 헤더 없는 원격도 URL 은 적힌 그대로
        },
      }));
      const read2 = await ext.readExternalMcpServers();
      const handoff = ext.moveRemoteHeadersToEnv(read2);
      const argvJson = JSON.stringify(handoff.servers);
      const hr = handoff.servers.remote as { url?: string; headers?: Record<string, string> };
      const literalVar = /^\$\{(TIGUCLAW_MCP_HEADER_\d+)\}$/.exec(hr.headers?.["X-Literal"] ?? "")?.[1];
      out.push(assert("★⑤ Claude 명령줄로 가는 설정에 비밀 값 없음 — stdio args·env·URL·`${}` 헤더는 적힌 그대로 · 값 헤더는 환경변수로",
        !argvJson.includes(TOKEN) && !argvJson.includes("stdio-secret-value") && !argvJson.includes("literal-secret") &&
          argvJson.includes("--key=${REGR_STDIO_SECRET}") && argvJson.includes("${REGR_STDIO_SECRET:-dflt}") &&
          hr.url?.endsWith("?k=${REGR_REMOTE_MCP_TOKEN}") === true && hr.headers?.Authorization === "Bearer ${REGR_REMOTE_MCP_TOKEN}" &&
          literalVar !== undefined && handoff.env[literalVar] === "literal-secret",
        argvJson.replace(TOKEN, "<TOKEN>").slice(0, 300)));
      const shown = ext.describeExternalMcpConfig("local", read2.local!);
      out.push(assert("⑤ 목록 표시도 적힌 모양 — 채운 인자 속 비밀이 도구 답으로 안 나간다",
        shown.includes("--key=${REGR_STDIO_SECRET}") && !shown.includes("stdio-secret-value"), shown));
      // CLI 는 서버 이름을 도구 이름에 넣을 때 `[^a-zA-Z0-9_-]` 를 `_` 로 바꾼다 — 같은 규칙으로 막아야 한다.
      const blocked = ext.cliOwnAuthToolNames(["notion.so", "노션 서버", "my-srv"]);
      out.push(assert("⑤ CLI 자체 로그인 도구 차단 이름 = CLI 의 이름 규칙(점·공백·한글 → _)",
        blocked.includes("mcp__notion_so__complete_authentication") && blocked.includes(`mcp__${"_".repeat("노션 서버".length)}__authenticate`) && blocked.includes("mcp__my-srv__authenticate"), JSON.stringify(blocked)));
      delete process.env.REGR_STDIO_SECRET;

      // ⑥ 건너뛴 서버 표시 — 등록 서버가 0개여도 보이고(«없음» 이 아니다) · 설정에서 빠지면 표시도 사라진다(낡은 표시 금지).
      writeFileSync(file, JSON.stringify({ mcpServers: { onlymissing: { type: "http", url, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_UNSET}" } } } }));
      const onlySkipped = JSON.stringify(await reg.list_mcp_servers!.handler({}, {}));
      writeFileSync(file, JSON.stringify({}));
      await ext.readExternalMcpServers();
      const afterEmpty = ext.skippedMcpServers();
      // 파일 삭제는 따로 본다 — 건너뜀 상태를 다시 만든 뒤 지운다(앞 단계가 이미 지웠으면 이 축을 못 본다).
      writeFileSync(file, JSON.stringify({ mcpServers: { onlymissing: { type: "http", url, headers: { Authorization: "Bearer ${REGR_REMOTE_MCP_UNSET}" } } } }));
      await ext.readExternalMcpServers();
      const beforeGone = ext.skippedMcpServers().length;
      rmSync(file, { force: true });
      await ext.readExternalMcpServers();
      const afterGone = ext.skippedMcpServers();
      out.push(assert("⑥ 건너뛴 서버만 있어도 목록에 보이고 · 설정이 비거나 파일이 없어지면 표시도 사라진다",
        onlySkipped.includes("onlymissing") && !onlySkipped.includes("없습니다") && afterEmpty.length === 0 && beforeGone === 1 && afterGone.length === 0,
        JSON.stringify({ onlySkipped: onlySkipped.slice(0, 120), afterEmpty: afterEmpty.length, beforeGone, afterGone: afterGone.length })));

      // ⑦ 리다이렉트 경계 — 원격 전송은 **같은 출처** 리다이렉트만 따라간다(MCP SDK 1.32 기본 `redirectPolicy: 'same-origin'`).
      //  우리 진입점(브리지 연결)에서 양쪽을 잰다. ★없을 때: SDK 를 올려 경계가 바뀌었는데, 넓혀도(토큰·헤더가 다른 서버로) 좁혀도
      //  (같은 출처 이전이 끊김) 원격 MCP 회귀가 전부 초록이었다(GPT 검토 10-25).
      const hopHeaders = { Authorization: `Bearer ${TOKEN}`, "X-Regr-Secret": "regr-redirect-secret" };
      writeFileSync(file, JSON.stringify({ mcpServers: {
        samehop: { type: "http", url: `http://127.0.0.1:${port}/same`, headers: hopHeaders },
        crosshop: { type: "http", url: `http://127.0.0.1:${port}/cross`, headers: hopHeaders },
      } }));
      await ext.closeAllExternalMcp();
      const hops = await ext.getConnectedExternalMcpBridges();
      const hopNames = hops.map((b) => b.name).sort();
      const sameHop = hops.find((b) => b.name === "samehop");
      const sameCalled = sameHop === undefined ? "" : JSON.stringify(await sameHop.callTool("echo", { text: "hop" }));
      for (const b of hops) await b.close();
      out.push(assert("★⑦ 같은 출처 307 은 따라가 붙고 원격 도구까지 부른다(인증 헤더 유지)",
        hopNames.includes("samehop") && sameCalled.includes("REMOTE:hop"), JSON.stringify({ hopNames, sameCalled: sameCalled.slice(0, 60) })));
      out.push(assert("★⑦ 다른 출처 307 은 따라가지 않는다 — 붙지 않고, 그 목적지엔 요청·헤더·본문이 하나도 안 간다",
        !hopNames.includes("crosshop") && crossSeen.length === 0, JSON.stringify({ hopNames, crossSeen })));
    } finally {
      await ext.closeAllExternalMcp();
      if (prev === undefined) rmSync(file, { force: true });
      else writeFileSync(file, prev);
      delete process.env.REGR_REMOTE_MCP_TOKEN;
      await new Promise<void>((r) => http.close(() => r()));
      await new Promise<void>((r) => dest.close(() => r()));
    }
    return out;
  },
};
