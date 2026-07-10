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
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Attachment,
  AttachmentKind,
  Channel,
  IncomingMessage,
  MessageHandler,
} from "../../src/channels/types.js";
import { getPaths } from "../../src/core/paths.js";
import type { Observer } from "../../src/core/observers/types.js";
import { safeUnsubscribe, type EventBus } from "../../src/core/eventbus.js";
import { collectInventory } from "../../src/core/plugins/inventory.js";
import { getAllCommands } from "../../src/core/entry/command-registry.js";
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
import { getRecentChatLog } from "../../src/store/chat-log.js";
import { getAssistantName } from "../../src/core/identity.js";
import { listProjects } from "../../src/store/projects.js";
import { parseProjectMd } from "../../src/core/llm-runtime/capabilities/project-registry.js";
import { discoverSkills } from "../../src/core/llm-runtime/capabilities/skill-registry.js";
import { discoverAgents } from "../../src/core/llm-runtime/capabilities/agent-registry.js";
import {
  readProjectMcpServers,
  describeExternalMcpConfig,
} from "../../src/core/external-mcp.js";
import {
  runRegionA,
  parseModelSpec,
  parseModelSpecList,
  resolveTier,
  type ModelSpec,
} from "../../src/core/llm-runtime/index.js";
import { listEvents } from "../../src/store/events.js";
import { listJobs } from "../../src/core/worker-jobs.js";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";

const VERSION = "0.1.0";
const DEFAULT_THREAD_KEY = "http-bridge:default";
const HANDLER_TIMEOUT_MS = 60_000;

// 신규 SSE 접속 history replay 에서 제외할 고volume 스트리밍 타입.
// - llm.delta: 토큰 증분(P5). 재연결이 옛 턴 토큰을 재생해 깨진 부분 버블을 만들지 않도록.
//   라이브 fan-out 은 통과(진행 중 턴 실시간엔 필요), history(과거 재생)에서만 제외.
//   최종 권위 전체본은 channel.message.out 이라 델타 재생 없이도 수렴.
// - llm.sdk_message: claude firehose. 같은 고volume·감사가치 낮음(영속 SKIP 과 동렬).
// core/event-persist.ts 의 SKIP_TYPES 와 의미는 비슷하나 모듈 경계가 달라 로컬 set(과결합 회피).
const HISTORY_EXCLUDE = new Set<string>(["llm.delta", "llm.sdk_message"]);

// ── 첨부 intake (#2, 2026-07-08) — 대시보드 채팅이 붙여넣은 파일을 홈에 저장 → Attachment[]. ──
// 텔레그램 첨부 경로와 동형(진실 소스 = Attachment 계약, <home>/data/attachments/<channel>/
// <yyyymmdd>/<id>.<ext>). base64 인바운드는 로컬(127.0.0.1)+토큰 게이트 한정 = 외부 노출 아님.
// 크기/개수 캡은 boundary 검증(메모리·디스크 보호). 캡 위반·저장 실패는 400 으로 닫고 데몬 생존.
const ATTACH_MAX_COUNT = 10;
const ATTACH_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB/파일
const ATTACH_MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB/요청
class AttachmentError extends Error {}
const attachmentKindOf = (mime: string): AttachmentKind =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("video/")
        ? "video"
        : "document";
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "application/pdf": "pdf", "text/plain": "txt",
  "text/markdown": "md", "application/json": "json", "text/csv": "csv",
};
// 서빙용 확장자→content-type (인바운드 첨부 파일 렌더). 미지 확장자는 octet-stream.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8",
};
const sanitizeFilename = (n: string): string =>
  n.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim().slice(-120) || "file";
const extForAttachment = (filename: string, mime: string): string => {
  const e = path.extname(filename).replace(/^\./, "").toLowerCase();
  if (e.length > 0 && e.length <= 8) return e;
  return EXT_BY_MIME[mime] ?? "bin";
};
const yyyymmddUtc = (): string =>
  new Date().toISOString().slice(0, 10).replace(/-/g, "");
// body.attachments([{filename?, mimeType?, dataBase64}]) → Attachment[] (홈 저장). 캡 위반 throw.
const ingestAttachments = async (
  raw: unknown,
  channel: string,
): Promise<Attachment[]> => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > ATTACH_MAX_COUNT) {
    throw new AttachmentError(`첨부는 최대 ${ATTACH_MAX_COUNT}개까지 가능합니다.`);
  }
  const dir = path.join(getPaths().attachmentsDir, channel, yyyymmddUtc());
  const out: Attachment[] = [];
  let total = 0;
  for (const a of raw) {
    const item = a as { filename?: unknown; mimeType?: unknown; dataBase64?: unknown };
    if (typeof item.dataBase64 !== "string" || item.dataBase64 === "") continue;
    const filename = sanitizeFilename(
      typeof item.filename === "string" ? item.filename : "file",
    );
    const mimeType =
      typeof item.mimeType === "string" && item.mimeType !== ""
        ? item.mimeType
        : "application/octet-stream";
    const buf = Buffer.from(item.dataBase64, "base64");
    if (buf.length === 0) continue;
    if (buf.length > ATTACH_MAX_FILE_BYTES) {
      throw new AttachmentError(
        `'${filename}' 이(가) 파일당 한도(${ATTACH_MAX_FILE_BYTES / 1024 / 1024}MB)를 초과합니다.`,
      );
    }
    total += buf.length;
    if (total > ATTACH_MAX_TOTAL_BYTES) {
      throw new AttachmentError(
        `첨부 총합이 한도(${ATTACH_MAX_TOTAL_BYTES / 1024 / 1024}MB)를 초과합니다.`,
      );
    }
    await fs.mkdir(dir, { recursive: true });
    const id = crypto.randomBytes(8).toString("hex");
    const abs = path.join(dir, `${id}.${extForAttachment(filename, mimeType)}`);
    await fs.writeFile(abs, buf);
    out.push({
      kind: attachmentKindOf(mimeType),
      mimeType,
      path: abs,
      filename,
      bytes: buf.length,
    });
  }
  return out;
};

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

// ── LLM 게이트웨이(ADR 2026-07-09) — OpenAI 호환 /v1/chat/completions. 앱이 tiguclaw 멀티LLM
// 폴백을 HTTP 로 사용. 전용 토큰(LLM_GATEWAY_TOKEN) 미설정 시 비활성(안전 기본, 404). 얇은 경로:
// runRegionA(internal=persist·이벤트 스킵 + toolPolicy:none=도구0 + systemPromptOverride=앱 system,
// 비서 페르소나 누수 0). ──
const GATEWAY_MAX_CONCURRENCY = ((): number => {
  const n = Number(process.env.LLM_GATEWAY_MAX_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 4;
})();
let gatewayInflight = 0;

// 요청 model → tiguclaw 스펙. `tier:high|mid|low` / `provider:model` / 그 외=env 폴백 풀.
const resolveGatewaySpecs = (model: unknown): ModelSpec[] => {
  const m = typeof model === "string" ? model.trim() : "";
  if (m.startsWith("tier:")) {
    const t = resolveTier(m.slice("tier:".length));
    if (t.length > 0) return t;
  }
  const direct = parseModelSpec(m);
  if (direct !== null) return [direct];
  const env = process.env.LLM_GATEWAY_MODELS ?? process.env.REGION_A_MODELS ?? "";
  return parseModelSpecList(env);
};

// OpenAI messages[] → (system override, user text). system 은 override 로, 나머지는 순서대로 이어붙임.
const flattenChatMessages = (
  messages: Array<{ role?: string; content?: unknown }>,
): { system: string; text: string } => {
  const sys: string[] = [];
  const turns: string[] = [];
  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "user";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((c) =>
                typeof c === "object" && c !== null && "text" in c
                  ? String((c as { text?: unknown }).text ?? "")
                  : "",
              )
              .join("")
          : "";
    if (role === "system") sys.push(content);
    else if (role === "user") turns.push(content);
    else turns.push(`[${role}]\n${content}`);
  }
  return { system: sys.join("\n\n"), text: turns.join("\n\n") };
};

// ── 이력 도구 스텝(기능 B, 2026-07-09) — chat_log 메시지 window 와 같은 ts 범위의 영속
// llm.activity(start·tool, 워커·서브·게이트웨이 제외)를 복원용으로 반환. 도구 스텝은 events 에
// 이미 영속되나 chat-history 는 메시지만 줬다 → 새로고침 시 도구 사용이 사라져 보였음. 이제
// 여기서 함께 반환하고 대시보드가 메시지와 시간순 인터리브 렌더. best-effort(실패=빈 배열). ──
interface HistoryActivity {
  ts: number;
  threadKey: string;
  adapter: string;
  seq: number;
  label: string;
  detail: string;
  diff?: unknown; // 리치 diff(ActivityDiff) — 있으면 그대로 통과(대시보드가 렌더). 2026-07-09.
  output?: unknown; // 리치 출력(ActivityOutput) — phase:"end" 에서 시작 스텝으로 병합. 2026-07-09.
}
const historyActivities = (entries: Array<{ ts: number }>): HistoryActivity[] => {
  if (entries.length === 0) return [];
  const sinceTs = entries[0].ts; // ASC — oldest.
  const newestTs = entries[entries.length - 1].ts;
  try {
    const raw = listEvents({ types: ["llm.activity"], sinceTs, limit: 3000 });
    // 1차 파싱 — start 스텝은 out 으로, end 이벤트의 output 은 (threadKey|adapter|seq) 맵으로
    // 모아 뒤에 시작 스텝에 병합(라이브의 phase:end→스텝 주석과 동형). durationMs 는 이력 불필요.
    const out: HistoryActivity[] = [];
    const endOutputs = new Map<string, unknown>();
    const okey = (tk: string, adapter: string, seq: number) => tk + "|" + adapter + "|" + seq;
    for (const e of raw) {
      if (e.ts > newestTs) continue;
      let p: {
        threadKey?: unknown;
        adapter?: unknown;
        seq?: unknown;
        label?: unknown;
        detail?: unknown;
        phase?: unknown;
        kind?: unknown;
        diff?: unknown;
        output?: unknown;
      };
      try {
        p = JSON.parse(e.payload);
      } catch {
        continue;
      }
      if (p.kind !== "tool") continue;
      const tk = typeof p.threadKey === "string" ? p.threadKey : "";
      if (tk.startsWith("worker:") || tk.startsWith("agent:") || tk.startsWith("gateway:")) {
        continue; // 잡·게이트웨이 스텝은 채팅 이력 아님.
      }
      const seq = typeof p.seq === "number" ? p.seq : 0;
      const adapter = typeof p.adapter === "string" ? p.adapter : "";
      if (p.phase === "end") {
        // 실행시간 주석 이벤트 — 스텝은 아니나 output 이 있으면 시작 스텝에 병합.
        if (p.output !== undefined && p.output !== null) endOutputs.set(okey(tk, adapter, seq), p.output);
        continue;
      }
      out.push({
        ts: e.ts,
        threadKey: tk,
        adapter,
        seq,
        label: typeof p.label === "string" ? p.label : "tool",
        detail: typeof p.detail === "string" ? p.detail : "",
        ...(p.diff !== undefined && p.diff !== null ? { diff: p.diff } : {}),
      });
    }
    // 2차 — end output 을 대응 시작 스텝에 병합.
    if (endOutputs.size > 0) {
      for (const s of out) {
        const o = endOutputs.get(okey(s.threadKey, s.adapter, s.seq));
        if (o !== undefined) s.output = o;
      }
    }
    return out;
  } catch {
    return [];
  }
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
  // 바인딩 호스트 — 기본 127.0.0.1 (로컬 전용, LAN 비노출 = 안전 기본). LAN/원격
  // 접근이 필요하면 명시적으로 HTTP_BRIDGE_HOST=0.0.0.0 (토큰 인증은 항상 적용되나
  // 노출면이 늘어나므로 의도적으로만).
  private readonly host: string;

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
    this.host = process.env.HTTP_BRIDGE_HOST?.trim() || "127.0.0.1";
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
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", onError);
        console.log(
          `http-bridge listening on http://${this.host}:${this.port}`,
        );
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

    // LLM 게이트웨이 — OpenAI 호환. **브리지 role 토큰과 별개**의 전용 토큰(LLM_GATEWAY_TOKEN).
    // 미설정 = 비활성(404). 앱 서버가 토큰 쥐고 호출(브라우저 직접 금지). 127.0.0.1 바인드.
    if (pathname === "/v1/chat/completions" && method === "POST") {
      const gwTok = process.env.LLM_GATEWAY_TOKEN?.trim() ?? "";
      if (gwTok === "") {
        writeJson(res, 404, { error: { message: "llm gateway disabled (LLM_GATEWAY_TOKEN not set)" } });
        return;
      }
      const gwAuth = req.headers.authorization ?? "";
      const bearer = gwAuth.startsWith("Bearer ") ? gwAuth.slice("Bearer ".length).trim() : "";
      if (bearer !== gwTok) {
        writeJson(res, 401, { error: { message: "unauthorized" } });
        return;
      }
      if (gatewayInflight >= GATEWAY_MAX_CONCURRENCY) {
        writeJson(res, 429, { error: { message: "gateway busy (max concurrency reached)" } });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        writeJson(res, 400, { error: { message: `invalid body: ${e instanceof Error ? e.message : String(e)}` } });
        return;
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as Array<{ role?: string; content?: unknown }>)
        : [];
      if (messages.length === 0) {
        writeJson(res, 400, { error: { message: "messages required" } });
        return;
      }
      const { system, text } = flattenChatMessages(messages);
      const specs = resolveGatewaySpecs(body.model);
      const runInput = {
        text: text !== "" ? text : " ",
        threadKey: `gateway:${crypto.randomUUID()}`,
        channel: this.name,
        internal: true as const, // persist·이벤트 스킵(대시보드·트랜스크립트 무오염).
        toolPolicy: { mode: "none" as const }, // 도구 0.
        systemPromptOverride: system, // 앱 system(빈 문자열도 override — 비서 페르소나 스킵).
      };
      const specOpt = specs.length > 0 ? { specs } : undefined;
      const cid = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const reqModel = typeof body.model === "string" ? body.model : "tiguclaw";

      // ── 스트리밍(stream:true) — SSE, OpenAI chat.completion.chunk. 이 게이트웨이 턴의
      // llm.delta(threadKey 필터)를 구독해 content 청크로 중계. 델타 전무(비스트리밍 모델)
      // 시 완료 후 전체본 1청크 폴백. ──
      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let modelLabel = reqModel;
        let sawDelta = false;
        const chunk = (delta: Record<string, unknown>, finish: string | null): void => {
          res.write(
            `data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: modelLabel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        };
        chunk({ role: "assistant" }, null);
        const unsub =
          this.bus !== null
            ? this.bus.subscribe((ev) => {
                if (ev.type !== "llm.delta") return;
                const p = ev.payload as {
                  threadKey?: string;
                  delta?: string;
                  model?: string;
                };
                if (p.threadKey !== runInput.threadKey) return;
                if (typeof p.model === "string" && p.model !== "") modelLabel = p.model;
                if (typeof p.delta === "string" && p.delta !== "") {
                  sawDelta = true;
                  chunk({ content: p.delta }, null);
                }
              })
            : null;
        gatewayInflight += 1;
        try {
          const out = await runRegionA(runInput, specOpt);
          if (out.model !== undefined && out.model !== null && out.model !== "") modelLabel = out.model;
          if (!sawDelta && out.text) chunk({ content: out.text }, null); // 델타 전무 폴백.
          chunk({}, "stop");
          res.write("data: [DONE]\n\n");
        } catch (e) {
          res.write(
            `data: ${JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } })}\n\n`,
          );
        } finally {
          if (unsub !== null) safeUnsubscribe(unsub);
          gatewayInflight -= 1;
          res.end();
        }
        return;
      }

      // ── 비스트리밍 ──
      gatewayInflight += 1;
      try {
        const out = await runRegionA(runInput, specOpt);
        const inTok = out.usage?.inputTokens ?? 0;
        const outTok = out.usage?.outputTokens ?? 0;
        writeJson(res, 200, {
          id: cid,
          object: "chat.completion",
          created,
          model: out.model ?? reqModel,
          choices: [
            { index: 0, message: { role: "assistant", content: out.text ?? "" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
        });
      } catch (e) {
        writeJson(res, 502, { error: { message: e instanceof Error ? e.message : String(e) } });
      } finally {
        gatewayInflight -= 1;
      }
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
          : pathname === "/commands" && method === "GET"
            ? "read"
            : pathname === "/providers" && method === "GET"
            ? "read"
            : pathname === "/chat-history" && method === "GET"
              ? "read"
              : pathname === "/projects" && method === "GET"
                ? "read"
                : pathname === "/projects/detail" && method === "GET"
                  ? "read"
                  : pathname === "/messages" && method === "POST"
              ? "write"
              : pathname === "/restart" && method === "POST"
                ? "admin"
                : pathname.startsWith("/attachments/") && method === "GET"
                  ? "read"
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
      // 고volume 스트리밍 타입(llm.delta 등)은 재생 제외 — 라이브 fan-out 은 통과, history 만 필터.
      if (this.bus !== null) {
        const recent = this.bus
          .history({ limit: 50 })
          .filter((e) => !HISTORY_EXCLUDE.has(e.type));
        for (const e of recent) {
          try {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
          } catch {
            return;
          }
        }
      }
      this.sseClients.add(res);
      // 하트비트 — 주기적 SSE 코멘트(`: ping`)로 연결을 살아있게 유지한다. half-open
      // (데몬 재시작·네트워크 블립·프록시 idle timeout)이면 write 가 끝내 실패하거나
      // 상대가 끊김을 감지 → 브라우저 EventSource 가 자동 재연결(탭 stale 방지). child
      // proxySse 는 raw 바이트를 그대로 흘리므로 ping 이 브라우저까지 전달된다.
      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          /* 끊긴 소켓 — close/error 가 cleanup 처리 */
        }
      }, 20_000);
      (heartbeat as { unref?: () => void }).unref?.();
      const cleanup = (): void => {
        clearInterval(heartbeat);
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

    // /commands — JSON. 슬래시 명령 목록(빌트인 + 커스텀) 대시보드 노출. getAllCommands
    // 가 내부에서 discoverCommands 실패를 흡수(빌트인 폴백)하므로 여기선 경계 표준 에러만.
    if (pathname === "/commands" && method === "GET") {
      try {
        const cmds = await getAllCommands();
        writeJson(res, 200, { commands: cmds });
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

    // /chat-history — JSON. 대시보드 대화 이력 복원(기능 B). chat_log 의 최근 N 건을
    // 시간 오름차순으로 반환 → 대시보드가 SSE 연결 *전에* fetch 해 과거 채팅 버블 렌더.
    // read 게이트(위 role 표). ts 는 event.ts(쓰기 훅) 이므로 클라이언트가 SSE history
    // replay 와 ts 로 dedup 한다. ?limit= 허용(기본 200).
    if (pathname === "/chat-history" && method === "GET") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const parsed = limitRaw !== null ? parseInt(limitRaw, 10) : NaN;
        const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
        // beforeTs — 페이지네이션(스크롤 더보기). 그 시각 *이전* N 건을 ASC 반환.
        // 안전 파싱: 유효 양수만 전달, 그 외엔 undefined(= 최신 묶음).
        const beforeRaw = url.searchParams.get("beforeTs");
        const beforeParsed =
          beforeRaw !== null ? parseInt(beforeRaw, 10) : NaN;
        const beforeTs =
          Number.isFinite(beforeParsed) && beforeParsed > 0
            ? beforeParsed
            : undefined;
        const entries = getRecentChatLog(
          beforeTs !== undefined ? { limit, beforeTs } : { limit },
        );
        // 비서 표시 이름(AGENT.md 이름 필드, 없으면 tiguclaw) — 대시보드 채팅 라벨용.
        // activities(기능 B) — 이력에 도구 스텝 복원(새로고침 후에도 도구 사용 표시).
        writeJson(res, 200, {
          entries,
          activities: historyActivities(entries),
          assistantName: getAssistantName(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /attachments/<rel> — 저장된 인바운드 첨부 파일 서빙(대시보드 이력 이미지/파일 렌더).
    // read 게이트(위). rel = attachmentsDir 기준 상대경로. ★path traversal 방어: 해석된 절대
    // 경로가 반드시 attachmentsDir 하위여야(../ 이스케이프·절대경로 거부). 로컬 바인딩 + 토큰
    // 게이트 뒤라 표면 작음. base64 를 DB 에 안 담고 이 파일을 재사용 = 이력 이미지 영속.
    if (pathname.startsWith("/attachments/") && method === "GET") {
      try {
        const rel = decodeURIComponent(pathname.slice("/attachments/".length));
        const dir = getPaths().attachmentsDir;
        const abs = path.resolve(dir, rel);
        if (!(abs === dir || abs.startsWith(dir + path.sep))) {
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        const buf = await fs.readFile(abs).catch(() => null);
        if (buf === null) {
          writeJson(res, 404, { error: "not found" });
          return;
        }
        const ext = path.extname(abs).replace(/^\./, "").toLowerCase();
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
          "Cache-Control": "private, max-age=86400",
          "Content-Length": buf.length,
        });
        res.end(buf);
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // /projects — JSON. 등록된 프로젝트 목록(레지스트리 조회 캐시). 대시보드 그리드 카드용.
    // 진실은 각 폴더의 PROJECT.md — 여긴 인덱스일 뿐(상세 열 때 파일 재-Read). read 게이트.
    if (pathname === "/projects" && method === "GET") {
      try {
        // 각 프로젝트에 현재 실행 중 에이전트 수(runningAgents) 부착 — 그리드 카드의
        // "🤖 N 실행 중" 배지용. in-memory listJobs(running) 을 job.cwd 로 귀속(G2).
        const running = listJobs({ runningOnly: true, limit: 500 });
        const rows = listProjects().map((p) => ({
          ...p,
          runningAgents: running.filter(
            (j) =>
              j.cwd !== undefined &&
              nodePath.resolve(j.cwd) === nodePath.resolve(p.path),
          ).length,
        }));
        writeJson(res, 200, rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /projects/detail?path=<abs> — JSON. 매 호출 <path>/PROJECT.md 재-Read(최신 진실) +
    // discover*(path) project-source 스킬/에이전트 + related 해소. PROJECT.md/폴더 부재 시 404.
    // recentJobs 는 P1 빈 배열([]) — G2 후속(cwd 귀속 payload 확장에 편승).
    if (pathname === "/projects/detail" && method === "GET") {
      const projectPath = url.searchParams.get("path") ?? "";
      if (projectPath.trim() === "") {
        writeJson(res, 400, { error: "path required" });
        return;
      }
      try {
        const mdPath = nodePath.join(projectPath, "PROJECT.md");
        let raw: string;
        try {
          raw = await fsp.readFile(mdPath, "utf8");
        } catch {
          // PROJECT.md 부재/폴더 없음 → 404 (best-effort, throw 0).
          writeJson(res, 404, {
            error: "PROJECT.md not found",
            path: projectPath,
          });
          return;
        }
        const folderName = nodePath.basename(projectPath);
        const meta = parseProjectMd(raw, folderName);

        // 프로젝트 전용 스킬/에이전트 — discover*(path) 중 source==="project" 만.
        const [allSkills, allAgents] = await Promise.all([
          discoverSkills(projectPath).catch(() => []),
          discoverAgents(projectPath).catch(() => []),
        ]);
        const skills = allSkills
          .filter((s) => s.source === "project")
          .map((s) => ({ name: s.name, description: s.description }));
        const agents = allAgents
          .filter((a) => a.source === "project")
          .map((a) => ({
            name: a.name,
            description: a.description,
            model: a.model ?? null, // 모델 티어(high/mid/low 또는 provider:model). 대시보드 표시.
          }));
        // 프로젝트 전용 MCP — <path>/.mcp.json (프로젝트 스코프). 대시보드 상세에 노출.
        const projectMcp = await readProjectMcpServers(projectPath).catch(() => ({}));
        const mcp = Object.entries(projectMcp).map(([name, cfg]) => ({
          name,
          desc: describeExternalMcpConfig(name, cfg),
        }));

        // related 해소 — 각 항목(경로 또는 등록 name)을 등록 목록에서 name/path 로.
        // 못 찾으면 path=null(텍스트로만 표시). 상대경로는 프로젝트 폴더 기준 절대화 후 매칭.
        let registered: ReturnType<typeof listProjects>;
        try {
          registered = listProjects();
        } catch {
          registered = [];
        }
        const related = meta.related.map((ref: string) => {
          const trimmed = ref.trim();
          const abs = nodePath.isAbsolute(trimmed)
            ? trimmed
            : nodePath.resolve(projectPath, trimmed);
          const byPath = registered.find(
            (p) => p.path === abs || p.path === trimmed,
          );
          if (byPath !== undefined) {
            return { name: byPath.name, path: byPath.path };
          }
          const byName = registered.find((p) => p.name === trimmed);
          if (byName !== undefined) {
            return { name: byName.name, path: byName.path };
          }
          return { name: trimmed, path: null };
        });

        // recentJobs — 이 프로젝트(cwd) 에서 실행된/실행 중인 서브에이전트 잡(G2 귀속).
        // in-memory listJobs 를 실행 cwd 로 필터(spawn_agent(path=X)가 job.cwd=X 기록).
        // running 먼저(startedAt desc, listJobs 기본 정렬) → 최대 20건. 무귀속(cwd 미기록)
        // 잡은 자연 제외. 대시보드가 "이 프로젝트에서 작업 중/최근 서브에이전트" 로 렌더.
        const projAbs = nodePath.resolve(projectPath);
        const recentJobs = listJobs({ limit: 200 })
          .filter(
            (j) => j.cwd !== undefined && nodePath.resolve(j.cwd) === projAbs,
          )
          .slice(0, 20)
          .map((j) => ({
            jobId: j.jobId,
            kind: j.kind,
            agentName: j.agentName ?? j.label,
            modelTier: j.modelTier ?? null,
            status: j.status,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt ?? null,
            task: j.task,
          }));

        writeJson(res, 200, {
          meta: {
            name: meta.name,
            description: meta.description,
            status: meta.status,
            related: meta.related,
            body: meta.body,
          },
          skills,
          agents,
          mcp,
          related,
          recentJobs,
        });
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
      // 첨부(#2) — 붙여넣은 파일을 홈에 저장해 Attachment[] 구성. 캡 위반·저장 실패 = 400.
      let attachments: Attachment[] = [];
      try {
        attachments = await ingestAttachments(body.attachments, this.name);
      } catch (e) {
        writeJson(res, 400, {
          error:
            e instanceof AttachmentError
              ? e.message
              : `attachment 처리 실패: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      // 파일만 보내는 경우(캡션 없는 첨부)도 허용 — text 또는 attachments 중 하나면 진행.
      if (text === "" && attachments.length === 0) {
        writeJson(res, 400, { error: "text 또는 attachments 가 필요합니다." });
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
      // 축1(2026-06-25) — 선택지 제시. http-bridge 는 SSE 채널이므로 inline keyboard
      // (telegram) 대신 EventBus 에 `prompt.options` 이벤트를 publish 한다. 대시보드가
      // SSE 로 받아 버튼 묶음을 채팅 흐름에 렌더하고, 클릭 시 그 value 를 POST /messages
      // {text:value} 로 흘려보낸다(= 사용자가 그 값을 입력한 것과 동치, route() 단일 인격
      // 재진입). 비차단: 이벤트 1회 publish 후 즉시 {ok:true}. bus 미연결(observer 미부착)
      // 환경에선 렌더 경로가 없으므로 {ok:false} → MCP 도구가 텍스트 제시로 graceful 폴백.
      const bus = this.bus;
      const presentOptions: IncomingMessage["presentOptions"] = async (
        question,
        options,
        presentOpts,
      ) => {
        if (bus === null) {
          return { ok: false, error: "control bus not started (관측 미연결)" };
        }
        try {
          bus.publish({
            type: "prompt.options",
            ts: Date.now(),
            payload: {
              channel: this.name,
              threadKey,
              question,
              options,
              ...(presentOpts?.note !== undefined
                ? { note: presentOpts.note }
                : {}),
            },
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      };
      const msg: IncomingMessage = {
        channel: this.name,
        channelUserId,
        threadKey,
        text,
        receivedAt: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        reply: async (out: string): Promise<void> => {
          replyText = out;
        },
        presentOptions,
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

    // /restart — 빌트인 제어 엔드포인트(A: 대시보드 버튼). admin 토큰 게이트(위 role 표) +
    // 127.0.0.1 바인드(기본). 메시지 큐(enqueueThreadTurn) 를 타지 않고 control.restart 이벤트를
    // EventBus 에 publish → index.ts 가 구독해 shutdown("RESTART"). 멈춘 턴에도 동작. 빌트인
    // 경로라 register_endpoint 로는 등록·shadow 불가(코드 순서 = 우선순위, 커스텀 폴백 위에서 선점).
    if (pathname === "/restart" && method === "POST") {
      if (this.bus === null) {
        // observer 미연결 = 재시작 트리거 경로 없음. 거짓 200 금지.
        writeJson(res, 503, { error: "control bus not started" });
        return;
      }
      this.bus.publish({
        type: "control.restart",
        ts: Date.now(),
        payload: { source: "http-bridge:dashboard" },
      });
      // 데몬이 곧 종료되므로 즉시 ack(이 응답 후 graceful shutdown 진행).
      writeJson(res, 202, { ok: true, restarting: true });
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
    this.busUnsubscribe = safeUnsubscribe(this.busUnsubscribe);
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
