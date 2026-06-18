/**
 * http-bridge — 첫 시민 hybrid plugin (channel + observer).
 *
 * contract `_workspace/eventbus_http_architect_contract.md` §5 +
 *          `_workspace/eventbus_http_daemon_engineer_delegation.md` §3.
 *
 * 양방향:
 *  - read: SSE `/events` 로 EventBus stream + `/inventory`/`/providers` JSON.
 *  - write: POST `/messages` 로 channel handler 호출 (synchronous request/response).
 *
 * 단일 instance 가 두 capability 동시 보유 — `startChannel(handler)` (channel) +
 * `startObserver(bus)` (observer). 호출 순서 무관, http 서버 부팅은 idempotent
 * (`ensureServer`). 단일 capability plugin 호환을 위해 `start(arg)` fallback 도 노출.
 *
 * 외부 의존 0 — node http/crypto + 내부 inventory walker.
 */
import http from "node:http";
import crypto from "node:crypto";
import type {
  Channel,
  IncomingMessage,
  MessageHandler,
} from "../../src/channels/types.js";
import type { Observer } from "../../src/core/observers/types.js";
import type { EventBus } from "../../src/core/eventbus.js";
import { collectInventory } from "../../src/core/plugins/inventory.js";
import { collectProviders } from "../../src/core/plugins/providers.js";
import {
  verifyToken,
  type BridgeTokenRole,
} from "../../src/store/bridge-tokens.js";
import { route } from "../../src/core/router.js";
import {
  findEndpoint,
  expandEndpoint,
} from "../../src/core/entry/endpoint-registry.js";

const VERSION = "0.1.0";
const DEFAULT_THREAD_KEY = "http-bridge:default";
const HANDLER_TIMEOUT_MS = 60_000;

const readJsonBody = async (
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

// 커스텀 엔드포인트 $BODY 치환용 raw body(파싱 안 함 — 모델이 읽음, §3). GET 은 빈 문자열.
const readRawBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const writeJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// endpoint × role 매핑 — contract §1.Q3 표 그대로.
// admin 은 모든 role 포함 (superset). dashboard V2 contract §1.Q3.
const ROLE_RANK: Record<BridgeTokenRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};
const meetsRole = (
  presented: BridgeTokenRole,
  required: BridgeTokenRole,
): boolean => ROLE_RANK[presented] >= ROLE_RANK[required];

class HttpBridge implements Channel, Observer {
  readonly name = "http-bridge";

  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private busUnsubscribe: (() => void) | null = null;
  private bus: EventBus | null = null;
  private channelHandler: MessageHandler | null = null;
  // env HTTP_BRIDGE_TOKEN 부재 + DB 0개 환경의 V1 회귀 0 폴백.
  // `verifyToken` 이 null 반환 시 본 토큰과 비교, 매치 시 admin role.
  private readonly ephemeralToken: string | null;
  private readonly port: number;

  constructor() {
    const envToken = process.env.HTTP_BRIDGE_TOKEN;
    if (envToken !== undefined && envToken.trim() !== "") {
      // env 토큰은 verifyToken 내부에서 admin role 폴백으로 매치 — 본 클래스는 보유 X.
      this.ephemeralToken = null;
    } else {
      this.ephemeralToken = crypto.randomBytes(16).toString("hex");
      console.error(
        `HTTP_BRIDGE_TOKEN not set, using ephemeral token: ${this.ephemeralToken}`,
      );
    }
    this.port = parseInt(process.env.HTTP_BRIDGE_PORT ?? "3001", 10);
  }

  private resolveToken(
    presented: string,
  ): { role: BridgeTokenRole } | null {
    if (presented === "") return null;
    const verified = verifyToken(presented);
    if (verified !== null) return { role: verified.role };
    // env 부재 환경의 ephemeral 폴백 — V1 회귀 0.
    if (
      this.ephemeralToken !== null &&
      presented === this.ephemeralToken
    ) {
      return { role: "admin" };
    }
    return null;
  }

  // ─── Channel capability ────────────────────────────────────────────────
  async startChannel(handler: MessageHandler): Promise<void> {
    this.channelHandler = handler;
    await this.ensureServer();
  }

  // ─── Observer capability ───────────────────────────────────────────────
  async startObserver(eventBus: EventBus): Promise<void> {
    this.bus = eventBus;
    this.busUnsubscribe = eventBus.subscribe((event) => {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of this.sseClients) {
        try {
          c.write(line);
        } catch {
          // 죽은 connection — 다음 client 진행. close 핸들러가 set 정리.
        }
      }
    });
    await this.ensureServer();
  }

  // ─── 단일 capability fallback (덕 타이핑 분기) ─────────────────────────
  async start(arg: MessageHandler | EventBus): Promise<void> {
    if (
      typeof arg === "object" &&
      arg !== null &&
      "subscribe" in arg &&
      typeof (arg as EventBus).subscribe === "function"
    ) {
      await this.startObserver(arg as EventBus);
    } else {
      await this.startChannel(arg as MessageHandler);
    }
  }

  // ─── http 서버 — idempotent (양 capability 모두 호출해도 1 listen) ────
  private async ensureServer(): Promise<void> {
    if (this.server !== null) return;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(err);
      };
      this.server!.once("error", onError);
      this.server!.listen(this.port, () => {
        this.server!.removeListener("error", onError);
        console.log(`http-bridge listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // /health — 인증 무.
    if (pathname === "/health" && method === "GET") {
      const buffer_size = this.bus ? this.bus.history().length : 0;
      writeJson(res, 200, {
        ok: true,
        version: VERSION,
        buffer_size,
        subscribers: this.sseClients.size,
        channel_handler: this.channelHandler !== null,
      });
      return;
    }

    // 그 외 — token 검증 + role 게이트.
    const authHeader = req.headers.authorization ?? "";
    const headerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const queryToken = url.searchParams.get("token") ?? "";
    const presented = headerToken !== "" ? headerToken : queryToken;
    const resolved = this.resolveToken(presented);
    if (resolved === null) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    // endpoint × role 매핑 — contract §1.Q3.
    const required: BridgeTokenRole | null =
      pathname === "/events" && method === "GET"
        ? "read"
        : pathname === "/inventory" && method === "GET"
          ? "read"
          : pathname === "/providers" && method === "GET"
            ? "read"
            : pathname === "/messages" && method === "POST"
              ? "write"
              : null;
    if (required !== null && !meetsRole(resolved.role, required)) {
      writeJson(res, 403, {
        error: "forbidden",
        required,
        presented: resolved.role,
      });
      return;
    }

    // /events — SSE.
    if (pathname === "/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 초기 history 푸시 (bus 가 붙어있을 때만).
      if (this.bus !== null) {
        const recent = this.bus.history({ limit: 50 });
        for (const e of recent) {
          try {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
          } catch {
            return;
          }
        }
      }
      this.sseClients.add(res);
      const cleanup = (): void => {
        this.sseClients.delete(res);
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      return;
    }

    // /inventory — JSON.
    if (pathname === "/inventory" && method === "GET") {
      try {
        const inv = await collectInventory();
        writeJson(res, 200, inv);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /providers — JSON. Dashboard/Dolsoe 공통 provider interface.
    if (pathname === "/providers" && method === "GET") {
      try {
        const providers = await collectProviders();
        writeJson(res, 200, providers);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /messages — POST 양방향.
    if (pathname === "/messages" && method === "POST") {
      if (this.channelHandler === null) {
        writeJson(res, 503, { error: "channel not started" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${msg}` });
        return;
      }
      const text =
        typeof body.text === "string" ? body.text.trim() : "";
      if (text === "") {
        writeJson(res, 400, { error: "text required" });
        return;
      }
      const threadKey =
        typeof body.threadKey === "string" && body.threadKey.trim() !== ""
          ? body.threadKey
          : DEFAULT_THREAD_KEY;
      const channelUserId =
        typeof body.userId === "string" && body.userId.trim() !== ""
          ? body.userId
          : "http-bridge";

      let replyText = "";
      const msg: IncomingMessage = {
        channel: this.name,
        channelUserId,
        threadKey,
        text,
        receivedAt: Date.now(),
        reply: async (out: string): Promise<void> => {
          replyText = out;
        },
      };

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutP = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("timeout"));
        }, HANDLER_TIMEOUT_MS);
      });

      try {
        await Promise.race([this.channelHandler(msg), timeoutP]);
        writeJson(res, 200, { replyText });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (reason === "timeout") {
          writeJson(res, 504, { error: "timeout" });
        } else {
          writeJson(res, 500, { error: reason });
        }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
      return;
    }

    // ── 커스텀 엔드포인트 폴백 (빌트인 전부 미매칭 후에만 — E-I4 빌트인 우선) ──
    // 빌트인 5경로(/health·/events·/inventory·/providers·/messages)는 위에서 전부 return
    // 했으므로 여기 도달 = 빌트인 아님. findEndpoint 가 충돌해도 물리적으로 도달 불가
    // (코드 순서 = 우선순위). 인증은 위에서 이미 통과(resolved !== null).
    {
      let ep;
      try {
        ep = await findEndpoint(pathname, method, process.cwd());
      } catch (e) {
        // 발견 실패(fs 등) = 데몬 생존 우선. 엔드포인트 없음으로 간주 → 404 로 진행.
        ep = undefined;
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`http-bridge: findEndpoint failed (${reason})`);
      }
      if (ep !== undefined) {
        // role 게이트 — 인증 없는 커스텀 엔드포인트 0(필수). 기본 write(read 폴백 금지).
        if (!meetsRole(resolved.role, ep.role)) {
          writeJson(res, 403, {
            error: "forbidden",
            required: ep.role,
            presented: resolved.role,
          });
          return;
        }
        // raw body(POST 만) + query → 템플릿 치환. JSON 파싱 안 함(모델이 읽음, §3).
        const rawBody = method === "POST" ? await readRawBody(req) : "";
        const queryStr = url.search.startsWith("?")
          ? url.search.slice(1)
          : url.search;
        const prompt = await expandEndpoint(ep, {
          body: rawBody,
          query: queryStr,
        });
        if (prompt === undefined) {
          // 정의 파일 read 실패(레이스 등) — 발견됐으나 본문 소실. 500.
          writeJson(res, 500, { error: "endpoint definition unreadable" });
          return;
        }

        // 실행 — route() 직접 호출(channelHandler 우회). 슬래시 비즈니스 로직 불요 +
        // toolPolicy 주입 필수(채널 어댑터 안 로직 0 = Q4). 사용자 대화 history 오염 0(E-I9).
        // threadKey 는 **호출마다 고유 nonce** — HTTP 엔드포인트는 stateless(매 호출 독립
        // 컨텍스트, contract §4-D). 이로써 (a)다른 외부 호출자 간 컨텍스트 bleed 0,
        // (b)동시 호출 세션 race 0(각 호출 = 별 thread, 직렬화 우회 무해). restricted 면 도구 0(E-I7).
        let replyText = "";
        const epNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const epMsg: IncomingMessage = {
          channel: this.name,
          channelUserId: `endpoint:${ep.name}`,
          threadKey: `endpoint:${ep.name}:${epNonce}`,
          text: prompt,
          receivedAt: Date.now(),
          reply: async (out: string): Promise<void> => {
            replyText = out;
          },
        };

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutP = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error("timeout"));
          }, HANDLER_TIMEOUT_MS);
        });

        try {
          const out = await Promise.race([
            route(epMsg, {
              // restricted(기본) → 도구 0. full(소유자 명시) → undefined = 전체 도구.
              toolPolicy:
                ep.mode === "restricted" ? { mode: "none" } : undefined,
            }),
            timeoutP,
          ]);
          // route 는 RouteOutput.text 를 반환 — reply 클로저(replyText)와 동일 본문이나,
          // route 의 반환 text 를 1차 진실로 사용(reply 미호출 어댑터 경로 대비 replyText 폴백).
          const result = out.text !== "" ? out.text : replyText;
          writeJson(res, 200, { result });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          if (reason === "timeout") {
            writeJson(res, 504, { error: "timeout" });
          } else {
            writeJson(res, 500, { error: reason });
          }
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
        return;
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // 미정의 — 404.
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  async stop(): Promise<void> {
    if (this.busUnsubscribe !== null) {
      try {
        this.busUnsubscribe();
      } catch {
        // 무시.
      }
      this.busUnsubscribe = null;
    }
    for (const c of this.sseClients) {
      try {
        c.end();
      } catch {
        // 무시.
      }
    }
    this.sseClients.clear();
    if (this.server !== null) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
    this.channelHandler = null;
    this.bus = null;
  }
}

export default HttpBridge;
