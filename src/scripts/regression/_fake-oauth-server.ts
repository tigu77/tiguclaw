/**
 * 회귀 공용 — **가짜 인가 서버 + 보호된 MCP 서버**를 한 원점에 띄운다 (2026-10-18, 원격 MCP OAuth).
 * RFC 9728 보호 자원 메타데이터 · RFC 8414 인가 서버 메타데이터 · RFC 7591 동적 등록 · PKCE S256 검증 · refresh 토큰 회전.
 * `/authorize` 는 사용자가 «허용» 을 누른 셈으로 바로 redirect_uri 로 code·state 를 돌려준다. `as` 로 동작을 바꾸고 발급값(`issued`)을 본다.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};
const b64url = (buf: Buffer): string => buf.toString("base64url");

export const startFakeOAuthMcp = async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { z } = await import("zod");
    const as = {
      expiresIn: 3600,
      /** `hang` = 요청을 받고 답하지 않는다(`held` 에 쥐고 있다가 `release()` 로 끊는다). */
      refreshMode: "ok" as "ok" | "invalid_grant" | "server_error" | "hang",
      held: [] as ServerResponse[],
      rejected: [] as string[],
      /** true 면 보호 자원 탐색 응답을 붙잡아 둔다 — 로그인 준비를 «auth() 대기 중» 에 세워 두는 제어 가능한 대기점. `releaseDiscovery()` 로 보낸다. */
      holdDiscovery: false,
      heldDiscovery: [] as Array<() => void>,
      /** refresh 토큰을 안 주는 공급자(GitHub OAuth 앱 류) 흉내. */
      noRefresh: false,
      /** refresh 토큰 → 발급받은 클라이언트(RFC 6749 §6 — 다른 클라이언트의 갱신은 거절). */
      refreshClient: new Map<string, string>(),
      refreshCalls: 0,
      clients: new Map<string, string[]>(),
      codes: new Map<string, { challenge: string; clientId: string; redirectUri: string }>(),
      access: new Set<string>(),
      refresh: new Set<string>(),
      issued: [] as string[],
      /** 보호 자원 메타데이터의 `resource` — 없으면 `${origin}/mcp`. origin 만 있는 자원(`http://host:port`)으로 바꿔 직렬화 차이를 본다. */
      resource: undefined as string | undefined,
      /** 받은 `resource` 파라미터 — 인가 요청·토큰 요청(grant 별). 인가 서버는 RFC 8707 자원 지시자를 **문자 그대로** 비교한다(다르면 invalid_target). */
      resourceSeen: [] as Array<{ at: "authorize" | "authorization_code" | "refresh_token"; resource: string | null }>,
      /** 토큰 요청 파라미터 중 비밀이 아닌 것(grant·client·resource·scope) — 우리 갱신과 SDK `auth()` 갱신을 대조한다. */
      tokenRequests: [] as Array<Record<string, string>>,
    };
    const advertised = (): string => as.resource ?? `${origin}/mcp`;
    /** 자원 지시자가 왔으면 광고한 값과 문자 그대로 같아야 한다(끝 `/` 하나도 다르면 거절). */
    const targetOk = (r: string | null): boolean => r === null || r === advertised();
    const issue = (clientId: string): { access_token: string; refresh_token?: string; token_type: string; expires_in: number } => {
      const a = `at-${randomBytes(12).toString("hex")}`;
      as.access.add(a);
      as.issued.push(a);
      if (as.noRefresh) return { access_token: a, token_type: "Bearer", expires_in: as.expiresIn };
      const r = `rt-${randomBytes(12).toString("hex")}`;
      as.refresh.add(r);
      as.refreshClient.set(r, clientId);
      as.issued.push(r);
      return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: as.expiresIn };
    };
    const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
    let origin = "";
    const http = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", origin);
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        const send = () => json(res, 200, { resource: advertised(), authorization_servers: [origin] });
        if (as.holdDiscovery) {
          as.heldDiscovery.push(send);
          return;
        }
        return send();
      }
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (u.pathname === "/register" && req.method === "POST") {
        const meta = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
        const id = `client-${randomBytes(6).toString("hex")}`;
        as.clients.set(id, meta.redirect_uris);
        return json(res, 201, { ...meta, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (u.pathname === "/authorize") {
        // 사용자가 «허용» 을 누른 셈 — redirect_uri 로 code·state 를 돌려준다.
        const clientId = u.searchParams.get("client_id") ?? "";
        const redirectUri = u.searchParams.get("redirect_uri") ?? "";
        if (!(as.clients.get(clientId) ?? []).includes(redirectUri)) return json(res, 400, { error: "invalid_request" });
        as.resourceSeen.push({ at: "authorize", resource: u.searchParams.get("resource") });
        if (!targetOk(u.searchParams.get("resource"))) return json(res, 400, { error: "invalid_target" });
        const code = `code-${randomBytes(12).toString("hex")}`;
        as.issued.push(code);
        as.codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", clientId, redirectUri });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const p = new URLSearchParams(await readBody(req));
        const g = p.get("grant_type");
        if (g === "authorization_code" || g === "refresh_token") as.resourceSeen.push({ at: g, resource: p.get("resource") });
        as.tokenRequests.push(Object.fromEntries([...p].filter(([k]) => !["code", "code_verifier", "refresh_token"].includes(k))));
        if (!targetOk(p.get("resource"))) return json(res, 400, { error: "invalid_target" });
        if (p.get("grant_type") === "authorization_code") {
          const c = as.codes.get(p.get("code") ?? "");
          as.codes.delete(p.get("code") ?? "");
          const ok = c !== undefined && b64url(createHash("sha256").update(p.get("code_verifier") ?? "").digest()) === c.challenge && c.redirectUri === p.get("redirect_uri");
          return ok ? json(res, 200, issue(c.clientId)) : json(res, 400, { error: "invalid_grant" });
        }
        if (p.get("grant_type") === "refresh_token") {
          as.refreshCalls += 1;
          await new Promise((r) => setTimeout(r, 30)); // 동시 요청이 겹치게
          if (as.refreshMode === "server_error") return json(res, 500, { error: "server_error" });
          if (as.refreshMode === "hang") {
            as.held.push(res);
            return;
          }
          const rt = p.get("refresh_token") ?? "";
          const cid = p.get("client_id") ?? "";
          if (as.refreshMode === "invalid_grant" || !as.refresh.has(rt) || as.refreshClient.get(rt) !== cid) return json(res, 400, { error: "invalid_grant" });
          as.refresh.delete(rt); // 회전 — 옛 refresh 는 무효
          return json(res, 200, issue(cid));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (u.pathname === "/mcp") {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!as.access.has(bearer)) {
          as.rejected.push(bearer); // 어떤 토큰이 거절됐나(빈 문자열 = 토큰 없음) — «우리 토큰이 거절됨» 과 «토큰을 안 보냄» 을 가른다
          res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end("unauthorized");
          return;
        }
        const body = await readBody(req);
        const sid = req.headers["mcp-session-id"];
        let t = typeof sid === "string" ? transports.get(sid) : undefined;
        if (t === undefined) {
          t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void transports.set(id, t!) });
          const srv = new McpServer({ name: "regr-oauth", version: "1.0.0" });
          srv.tool("whoami", "로그인 확인", { x: z.string().optional() }, async () => ({ content: [{ type: "text", text: "OAUTH-OK" }] }));
          await srv.connect(t);
        }
        await t.handleRequest(req, res, body === "" ? undefined : JSON.parse(body));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const url = `${origin}/mcp`;
    /** 붙잡아 둔 탐색 응답을 보낸다. */
    const releaseDiscovery = (): void => {
      as.holdDiscovery = false;
      for (const send of as.heldDiscovery.splice(0)) send();
    };
    /** 쥐고 있던 응답을 끊는다(클라이언트엔 연결 오류). */
    const release = (): void => {
      for (const r of as.held.splice(0)) r.destroy();
    };
    return { as, origin, url, release, releaseDiscovery, close: (): Promise<void> => (release(), releaseDiscovery(), new Promise<void>((r) => http.close(() => r()))) };
};
