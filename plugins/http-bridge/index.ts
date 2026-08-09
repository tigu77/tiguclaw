/**
 * http-bridge — 첫 시민 hybrid plugin (channel + observer).
 *
 * contract `_workspace/eventbus_http_architect_contract.md` §5 +
 *          `_workspace/eventbus_http_daemon_engineer_delegation.md` §3.
 *
 * 양방향:
 *  - read: SSE `/events` 로 EventBus stream + `/inventory`/`/providers`/`/context-menu-items` JSON.
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
import type { ChannelOutbound } from "../../src/core/channel-outbound.js";
import {
  registerExternalTurn,
  unregisterExternalTurn,
} from "../../src/core/inflight-turns.js";
import { getPaths } from "../../src/core/paths.js";
import { getChannelPresence } from "../../src/core/channel-registry.js";
import type { Observer } from "../../src/core/observers/types.js";
import { safeUnsubscribe, type EventBus } from "../../src/core/eventbus.js";
import {
  collectInventory,
  collectContextMenuContributions,
  isWhitelistedContextMenuAction,
} from "../../src/core/plugins/inventory.js";
import { getAllCommands } from "../../src/core/entry/command-registry.js";
import { collectModules } from "../../src/core/plugins/providers.js";
import {
  loadModelProfiles,
  loadGatewayConfig,
  getDefaultProfileName,
  setDefaultProfile,
  setModuleDisabled,
} from "../../src/core/settings.js";
import {
  verifyToken,
  type BridgeTokenRole,
} from "../../src/store/bridge-tokens.js";
import { route } from "../../src/core/router.js";
import {
  findEndpoint,
  expandEndpoint,
} from "../../src/core/entry/endpoint-registry.js";
import { getFirstUserText, getRecentChatLog } from "../../src/store/chat-log.js";
import {
  listThreads,
  setThreadName,
  getSessionModelProfile,
  setSessionModelProfile,
  clearSessionModelProfile,
  SESSION_STORAGE_CHANNEL,
  sessionDisplayName,
  setThreadArchived,
} from "../../src/store/sessions.js";
import { DEFAULT_SESSION_ID, resolveSessionId } from "../../src/core/threadkey.js";
import { getAssistantName } from "../../src/core/identity.js";
import { listProjects, forgetProject, upsertProject } from "../../src/store/projects.js";
import { listSchedules } from "../../src/store/schedules.js";
import { Cron } from "croner";
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
  specLabel,
  type ModelSpec,
} from "../../src/core/llm-runtime/index.js";
import { resolveTranscriptionProvider } from "../../src/core/llm-runtime/transcription/index.js";
import { listEvents } from "../../src/store/events.js";
import { createMemoryMcpServer } from "../../src/core/memory-mcp.js";
import { adaptClaudeMcpServer } from "../../src/core/llm-runtime/adapters/_mcp-bridge.js";


import {
  listJobs,
  resolveOwnerThreadKey,
  cancelQueuedTurn,
  cancelJob,
  isCancelledTurnResult,
  isSteeredTurnResult,
} from "../../src/core/worker-jobs.js";
import {
  listShells,
  tailShell,
  killShellById,
} from "../../src/core/llm-runtime/capabilities/file-ops-mcp.js";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { redactSecrets } from "../../src/core/outbound-sanitize.js";
import { getInflightTurns } from "../../src/core/inflight-turns.js";

/**
 * in-process MCP 서버 팩토리 — `/mcp-tools` 가 **실제 인스턴스에 물어보기** 위한 유일한 맵.
 * 새 in-process 서버가 생기면 여기 한 줄만 추가하면 도구 상세가 자동으로 따라온다
 * (하드코딩 목록을 또 만들지 않는다 — 기존 두 곳이 이미 드리프트했다, 2026-07-29).
 */
const IN_PROCESS_MCP_FACTORIES: Record<string, () => ReturnType<typeof createMemoryMcpServer>> = {
  memory: createMemoryMcpServer,
};
import { readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";

// 앱 버전 = 레포 루트 package.json(데몬 cwd=repoRoot). 하드코딩 stale 방지 — /health 가 이걸
// 반환하고 대시보드 헤더가 표시한다. 읽기 실패 시 "unknown".
const VERSION: string = (() => {
  try {
    const raw = readFileSync(nodePath.join(process.cwd(), "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v !== "" ? v : "unknown";
  } catch {
    return "unknown";
  }
})();
const HANDLER_TIMEOUT_MS = 60_000;
// 커스텀 엔드포인트 전용 타임아웃(2026-07-26) — `/messages`(대시보드)와 **성격이 다르다**:
//  - /messages: 최종 답은 SSE 로 가므로 HTTP 응답이 잘려도 사용자는 답을 받는다(504 무해).
//  - 엔드포인트: 앱이 **HTTP 응답 본문을 결과로 쓴다** → 잘리면 진짜 실패다.
// 실측(2026-07-26): codex 빈응답 → claude 폴백으로 한 턴이 70초 걸려 60초 캡에 걸렸고, 서버는
// 정상 완료(textLen=3164)했는데 앱만 504 를 받았다(작업완료·전달실패 부류). 폴백이 끼면 시간이
// 배가 되므로 캡을 넉넉히. env 로 조정 가능.
const ENDPOINT_TIMEOUT_MS = ((): number => {
  const n = Number(process.env.ENDPOINT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 300_000; // 기본 5분
})();

/**
 * ★`endpoint.call` 관측 이벤트에 실을 요청/응답 **미리보기** 길이 (2026-07-26).
 *
 * 실측: 이 배포의 엔드포인트 요청은 평균 **253,000자**, 최대 **1,324,574자(1.3MB)** 였다.
 * 종전엔 이걸 통째로 SSE 로 흘려보냈고 대시보드가 최대 60건을 **전부 펼친 채** DOM 에 넣어
 * 브라우저가 멈췄다(사용자 신고: "엔드포인트 화면 들어가면 멈춰있어").
 *
 * 정책 = 핫 경로만 바운드, 레코드는 보존([[project_hotpath_bound_preserve_record]]):
 *  - 전문은 `transcripts` 에 그대로 남는다(잘리는 건 **라이브 UI 미리보기뿐**).
 *  - 잘렸으면 얼마나 잘렸는지 본문에 명시 — 조용한 절단은 "이게 전부" 로 읽힌다.
 */
const ENDPOINT_PREVIEW_MAX = 4000;

/** 관측 이벤트용 미리보기 — 길면 앞부분만 + 잘린 사실·원본 길이 명시(조용한 절단 금지). */
const endpointPreview = (s: string): string => {
  const text = String(s ?? "");
  if (text.length <= ENDPOINT_PREVIEW_MAX) return text;
  return (
    text.slice(0, ENDPOINT_PREVIEW_MAX) +
    `\n\n… (전체 ${text.length.toLocaleString()}자 중 앞 ${ENDPOINT_PREVIEW_MAX.toLocaleString()}자만 표시 — 전문은 대화 기록에 보존됩니다)`
  );
};

// 신규 SSE 접속 history replay 에서 제외할 고volume 스트리밍 타입.
// - llm.delta: 토큰 증분(P5). 재연결이 옛 턴 토큰을 재생해 깨진 부분 버블을 만들지 않도록.
//   라이브 fan-out 은 통과(진행 중 턴 실시간엔 필요), history(과거 재생)에서만 제외.
//   최종 권위 전체본은 channel.message.out 이라 델타 재생 없이도 수렴.
// - llm.sdk_message: claude firehose. 같은 고volume·감사가치 낮음(영속 SKIP 과 동렬).
// core/event-persist.ts 의 SKIP_TYPES 와 의미는 비슷하나 모듈 경계가 달라 로컬 set(과결합 회피).
const HISTORY_EXCLUDE = new Set<string>(["llm.delta", "llm.sdk_message"]);

// 핵심 플러그인(비활성 = "자기 눈 가림", ADR 2026-07-17 §5.6 가드) — dashboard 가 꺼지면
// 대시보드 UI 자체가 안 뜨고, http-bridge(자기 자신)가 꺼지면 이 API 자체가 죽는다.
// 막지 않는다(사용자 결정, 파괴적-행위 소프트 게이트) — /set-module-enabled 응답에
// warning:"critical" 만 실어 프런트가 danger 확인 UX 를 붙이게 한다.
const CRITICAL_MODULE_NAMES = new Set<string>(["dashboard", "http-bridge"]);

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
// 🎤 음성입력(/transcribe) 임시파일 확장자 — 오디오 mime → ext. MediaRecorder 기본은 webm/opus.
// whisper wrapper 가 ffmpeg 로 재변환하므로 확장자만 맞으면 충분(미지 = webm 폴백).
const AUDIO_EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/oga": "ogg",
  "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac",
};
// 서빙용 확장자→content-type (인바운드 첨부 파일 렌더). 미지 확장자는 octet-stream.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf",
  // ★svg 는 **의도적으로 뺐다** (2026-07-31 전체검토 P0). SVG 는 스크립트를 담을 수 있고,
  //  `image/svg+xml` 로 inline 서빙하면 top-level 이동 시 **같은 오리진에서 실행**된다
  //  (실증: `<svg><script>fetch('/pwned')</script></svg>` 가 서버 요청을 냈다).
  //  첨부 URL 은 인증을 `?token=` 으로 싣기 때문에, 실행되는 순간 `location.search` 로
  //  브리지 토큰을 읽어 API 전부를 부를 수 있다. 심는 경로는 write 토큰뿐 아니라
  //  **프롬프트 인젝션으로 비서가 send_file 한 경우·텔레그램 인바운드 첨부**도 같다.
  //  → 미지 확장자로 떨어져 `application/octet-stream` + 아래 nosniff/attachment 로 닫힌다.
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

// ── 아웃바운드 첨부(send_file, #2 parity) — 비서가 send_file 로 보낸 절대경로 파일을 대시보드가
// 받아볼 수 있게 통제 디렉터리로 *복사*해 servable rel 을 확보한다. ★임의 절대경로를 그대로
// 서빙하지 않는다(보안): 인바운드와 동일하게 attachmentsDir/<channel>/<yyyymmdd>/<id>.<ext> 만
// /attachments 로 노출된다. 인바운드 ingest 와 대칭(같은 디렉터리·명명·kind 매핑 헬퍼 재사용). ──
// ext → 깨끗한 mime(CONTENT_TYPE_BY_EXT 는 charset 파라미터 포함 → 첫 토큰만). 미지 = octet-stream.
const mimeForExt = (ext: string): string => {
  const ct = CONTENT_TYPE_BY_EXT[ext];
  return ct !== undefined ? (ct.split(";")[0]?.trim() ?? "application/octet-stream") : "application/octet-stream";
};
interface OutboundAttachmentMeta {
  rel: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: number;
}
// srcPath(절대경로) → 통제 디렉터리 복사 후 서빙 메타. 파일 부재/디렉터리/접근불가면 null(호출자 {ok:false}).
const persistOutboundAttachment = async (
  srcPath: string,
  channel: string,
): Promise<OutboundAttachmentMeta | null> => {
  const st = await fs.stat(srcPath).catch(() => null);
  if (st === null || !st.isFile()) return null;
  const name = sanitizeFilename(path.basename(srcPath));
  const srcExt = path.extname(srcPath).replace(/^\./, "").toLowerCase();
  const mime = mimeForExt(srcExt);
  const kind = attachmentKindOf(mime);
  const dir = path.join(getPaths().attachmentsDir, channel, yyyymmddUtc());
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const destExt = srcExt.length > 0 && srcExt.length <= 8 ? srcExt : (EXT_BY_MIME[mime] ?? "bin");
  const abs = path.join(dir, `${id}.${destExt}`);
  await fs.copyFile(srcPath, abs);
  const rel = path
    .relative(getPaths().attachmentsDir, abs)
    .split(path.sep)
    .join("/"); // URL 경로 정규화(윈도우 \ → /).
  return { rel, name, mime, kind, bytes: st.size };
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
let gatewayInflight = 0;

// ── 게이트웨이 런타임 설정 해석(2026-07-26) — **settings.json `gateway:{}` 우선, env 레거시 폴백**.
//   settings 는 매 요청 fresh read(캐시 0)라 켜기/끄기·모델·동시성 변경이 **재시작 불요**.
//   settings 에 gateway 섹션이 없으면 종전 env 경로 그대로(= 토큰 존재만으로 활성) → 회귀 0.
//   토큰은 언제나 env 에서만 읽는다(D5 — raw 토큰을 settings 파일에 두지 않음).
interface GatewayRuntime {
  /** 활성 여부(= 토큰 있음 AND settings.enabled). false 면 /v1/* 는 404. */
  enabled: boolean;
  /** 인증 토큰(빈 문자열이면 비활성). */
  token: string;
  /** 기본 모델 풀 raw 문자열(콤마) — 요청 model 미매칭 시 폴백. */
  poolRaw: string;
  /** 동시 처리 상한(초과 429). */
  maxConcurrency: number;
}
const resolveGatewayRuntime = (): GatewayRuntime => {
  const cfg = loadGatewayConfig();
  const tokenEnvName = cfg?.tokenEnv ?? "LLM_GATEWAY_TOKEN";
  const token = process.env[tokenEnvName]?.trim() ?? "";
  // settings 섹션 부재 = 레거시(토큰만으로 판정) / 존재 = enabled 플래그가 킬스위치.
  const enabled = token !== "" && (cfg === undefined || cfg.enabled);
  const poolRaw =
    cfg?.models !== undefined && cfg.models.length > 0
      ? cfg.models.join(",")
      : (process.env.LLM_GATEWAY_MODELS ?? process.env.REGION_A_MODELS ?? "");
  const envCap = Number(process.env.LLM_GATEWAY_MAX_CONCURRENCY);
  const maxConcurrency =
    cfg?.maxConcurrency ??
    (Number.isInteger(envCap) && envCap > 0 ? envCap : 4);
  return { enabled, token, poolRaw, maxConcurrency };
};

// 요청 model → tiguclaw 스펙. `tier:high|mid|low` / `provider:model` / 그 외=기본 풀 폴백.
const resolveGatewaySpecs = (model: unknown, poolRaw: string): ModelSpec[] => {
  const m = typeof model === "string" ? model.trim() : "";
  if (m.startsWith("tier:")) {
    const t = resolveTier(m.slice("tier:".length));
    if (t.length > 0) return t;
  }
  const direct = parseModelSpec(m);
  if (direct !== null) return [direct];
  return parseModelSpecList(poolRaw);
};

// ── GET /v1/models (ADR 2026-07-25) — 사용 가능 모델 id 목록. ★왕복(round-trip) 보장:
//   프로파일/티어는 `tier:<name>` 로 노출(resolveGatewaySpecs 가 tier: 접두만 resolveTier 를
//   타므로 — 순수 이름을 그대로 노출하면 클라가 body.model 에 넣었을 때 조용히 기본 풀로 치환
//   되는 기존 갭을 광고하는 꼴). 직접 풀 스펙은 specLabel(provider:model) 로 대칭 노출. ──
const GATEWAY_MODELS_CREATED = Math.floor(Date.now() / 1000); // 부팅 1회 고정(매요청 Date.now()면 클라 캐시 무효화).
const GATEWAY_TIER_ENV: Record<string, string> = {
  high: "MODEL_TIER_HIGH",
  mid: "MODEL_TIER_MID",
  low: "MODEL_TIER_LOW",
  nano: "MODEL_TIER_NANO",
};
const buildModelsListResponse = (poolRaw: string): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} => {
  const seen = new Set<string>();
  const data: Array<{ id: string; object: "model"; created: number; owned_by: string }> = [];
  const add = (id: string, owner: string): void => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    data.push({ id, object: "model", created: GATEWAY_MODELS_CREATED, owned_by: owner });
  };
  // 1) 명명 프로파일 → tier:<name>
  try {
    for (const name of Object.keys(loadModelProfiles())) add(`tier:${name}`, "tiguclaw");
  } catch {
    /* settings 파싱 실패 — 프로파일 스킵(부재 graceful) */
  }
  // 2) 레거시 티어 — MODEL_TIER_* env 가 실제로 채워진 것만(빈 풀=어댑터 디폴트라 제외).
  for (const [tier, envKey] of Object.entries(GATEWAY_TIER_ENV)) {
    const v = process.env[envKey];
    if (typeof v === "string" && v.trim() !== "") add(`tier:${tier}`, "tiguclaw");
  }
  // 3) 직접 풀 스펙 — settings gateway.models ?? env (resolveGatewaySpecs 폴백과 동일 소스).
  for (const spec of parseModelSpecList(poolRaw)) {
    const label = specLabel(spec);
    add(label, label.includes(":") ? label.slice(0, label.indexOf(":")) : "tiguclaw");
  }
  return { object: "list", data };
};

// OpenAI messages content 의 image_url 파트 → ingestAttachments 입력 shape (vision, ADR 2026-07-25).
//   v1 은 `data:<mime>;base64,<payload>` 인라인만 지원 — http(s) URL 다운로드는 SSRF 표면이라
//   스코프아웃(후속). 텍스트 파트·기타는 무시(flattenChatMessages 가 텍스트 담당).
const extractGatewayImageAttachments = (
  messages: Array<{ content?: unknown }>,
): Array<{ filename: string; mimeType: string; dataBase64: string }> => {
  const out: Array<{ filename: string; mimeType: string; dataBase64: string }> = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part === null ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "image_url"
      ) {
        continue;
      }
      const urlRaw = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof urlRaw !== "string") continue;
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(urlRaw);
      if (m === null) continue; // data: URI 만 (http URL = 스코프아웃).
      const ext = (m[1].split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
      out.push({ filename: `image.${ext}`, mimeType: m[1], dataBase64: m[2] });
    }
  }
  return out;
};

// OpenAI chat message shape — 게이트웨이가 받는 요청 messages[] 원소. tool_calls/tool_call_id
// 는 함수콜 패스스루(ADR 2026-07-25 §Decision-5, role:"assistant"/"tool" 직렬화)에서만 읽힘.
interface GatewayChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

// OpenAI messages[] → (system override, user text). system 은 override 로, 나머지는 순서대로
// 이어붙임. ★role:"assistant"(tool_calls 있음)/"tool"(결과) 는 텍스트로 서술 직렬화한다 —
// 게이트웨이는 매 요청 새 threadKey(gateway:<uuid>) 라 무상태(어댑터 세션 resume 없음) →
// 이건 진짜 네이티브 멀티턴 tool state 재현이 아니라 "과거 tool 호출 기록"의 프롬프트 문자열
// 재구성일 뿐이다(설계 §2-b 최소안, 과대약속 금지). 모델은 이 서술을 컨텍스트로만 인지한다.
const flattenChatMessages = (
  messages: GatewayChatMessage[],
): { system: string; text: string } => {
  const sys: string[] = [];
  const turns: string[] = [];
  // tool_call_id → 호출 시점 함수명(role:"tool" 결과를 그 함수명과 함께 서술하기 위한 역참조 맵).
  const toolCallNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc?.id === "string" && tc.id !== "") {
          toolCallNames.set(tc.id, tc.function?.name ?? "tool");
        }
      }
    }
  }
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
    if (role === "system") {
      sys.push(content);
    } else if (role === "user") {
      turns.push(content);
    } else if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // 과거 함수콜 turn — 실행 없이 "이렇게 불렀었다"만 서술(2-b 최소안).
      const calls = msg.tool_calls
        .map((tc) => `[assistant called ${tc.function?.name ?? "tool"}(${tc.function?.arguments ?? ""})]`)
        .join("\n");
      turns.push(content !== "" ? `${calls}\n${content}` : calls);
    } else if (role === "tool") {
      const name =
        typeof msg.tool_call_id === "string" ? (toolCallNames.get(msg.tool_call_id) ?? "tool") : "tool";
      turns.push(`[tool result for ${name}]\n${content}`);
    } else {
      turns.push(`[${role}]\n${content}`);
    }
  }
  return { system: sys.join("\n\n"), text: turns.join("\n\n") };
};

// OpenAI tools[]/tool_choice → externalTools 패스스루(ADR 2026-07-25 §Decision-5). 실행은
//   tiguclaw 가 하지 않는다 — 모델이 고른 의도만 그대로 caller(게이트웨이 클라이언트)에 반환.
//   body.tools 부재/빈 배열 = 미주입(현행, 회귀 0).
const parseGatewayTools = (
  body: Record<string, unknown>,
): {
  externalTools?: Array<{ name: string; description?: string; parameters: unknown }>;
  externalToolChoice?: "auto" | "none" | "required" | { name: string };
} => {
  const rawTools = body.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return {};
  const externalTools: Array<{ name: string; description?: string; parameters: unknown }> = [];
  for (const t of rawTools) {
    if (t === null || typeof t !== "object") continue;
    if ((t as { type?: unknown }).type !== "function") continue;
    const fn = (t as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object") continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || name === "") continue;
    const description = (fn as { description?: unknown }).description;
    externalTools.push({
      name,
      ...(typeof description === "string" ? { description } : {}),
      parameters: (fn as { parameters?: unknown }).parameters ?? {},
    });
  }
  if (externalTools.length === 0) return {}; // 전부 무효 항목이면 미주입(안전 degrade).
  const rawChoice = body.tool_choice;
  let externalToolChoice: "auto" | "none" | "required" | { name: string } | undefined;
  if (rawChoice === "auto" || rawChoice === "none" || rawChoice === "required") {
    externalToolChoice = rawChoice;
  } else if (rawChoice !== null && typeof rawChoice === "object") {
    const fnName = (rawChoice as { function?: { name?: unknown } }).function?.name;
    if (typeof fnName === "string" && fnName !== "") externalToolChoice = { name: fnName };
  }
  return { externalTools, ...(externalToolChoice !== undefined ? { externalToolChoice } : {}) };
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
  plan?: string; // ExitPlanMode 전체 계획(마크다운) — 있으면 통과(대시보드 전체 렌더). 2026-07-19.
  /**
   * "tool" | "text" (2026-07-13, additive). 미지정 시 프런트 기본 해석 = "tool"
   * (하위호환 — 옛 이력에 kind 필드가 아예 없던 시절과 동형 형상). "text" 면 `text`
   * 필드가 그 세그먼트 본문(마크다운). seq 는 tool 활동과 같은 카운터 공간 — seq 정렬
   * = 인터리브 렌더 순서(`docs/decisions/2026-07-13-dashboard-turn-interleave.md`).
   */
  kind?: "tool" | "text";
  /** kind==="text" 일 때만 — 그 세그먼트의 마크다운 원문. 2026-07-13. */
  text?: string;
}
const historyActivities = (
  entries: Array<{ ts: number }>,
  scopeThreadKey?: string,
  /**
   * ★상한 적용 여부 (2026-07-30) — **최신 페이지에서는 상한을 걸면 안 된다.**
   *
   * 사고: 탭을 전환하면 그 세션에서 *진행 중인* 턴이 통째로 안 보였다. 원인은 아래
   * `newestTs` 컷이다 — `chat_log` 는 `channel.message.in`(사용자 발화, 인바운드 즉시)과
   * `channel.message.out`(비서 응답, **턴 완료 후**)로만 쌓이므로, 진행 중 턴에는
   * assistant 행이 아직 없어 `newestTs` = 사용자 발화 시각이다. 그 턴의 도구 스텝·텍스트
   * 세그먼트는 전부 그 이후라 **100% 버려졌다**. 그래서 `tabs.js` 의 "진행 중 턴 seamless
   * 재개"(activeTurns && activities.length > 0)가 **한 번도 발동하지 못했다** — 방어 코드는
   * 있는데 서버가 재료를 안 줬다.
   *
   * 상한의 원래 의도는 **역방향 페이지네이션**(옛 페이지를 볼 때 창 밖 활동 배제)이다.
   * 그래서 `beforeTs` 가 지정된 과거 페이지에서만 건다.
   */
  upperBounded = false,
): HistoryActivity[] => {
  if (entries.length === 0) return [];
  const sinceTs = entries[0].ts; // ASC — oldest.
  const newestTs = upperBounded
    ? entries[entries.length - 1].ts
    : Number.POSITIVE_INFINITY;
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
        model?: unknown;
        seq?: unknown;
        label?: unknown;
        detail?: unknown;
        phase?: unknown;
        kind?: unknown;
        diff?: unknown;
        output?: unknown;
        text?: unknown;
        plan?: unknown;
      };
      try {
        p = JSON.parse(e.payload);
      } catch {
        continue;
      }
      // 2026-07-13 인터리브 — "tool" 외에 "text"(도구 경계 텍스트 세그먼트)도 이력에 admit.
      // "turn"(coarse floor) 은 여전히 제외 — 렌더 대상 아님(기존과 동일).
      if (p.kind !== "tool" && p.kind !== "text") continue;
      const tk = typeof p.threadKey === "string" ? p.threadKey : "";
      if (tk.startsWith("worker:") || tk.startsWith("agent:") || tk.startsWith("gateway:")) {
        continue; // 잡·게이트웨이 스텝은 채팅 이력 아님(text 세그먼트도 depth>0 은 애초 미발행).
      }
      // 멀티세션 탭(ADR 2026-07-15) — 요청 threadKey 로 스코프해 entries 와 동일 계약 유지
      //  (안 하면 타 스레드 도구 스텝이 세션 이력에 샘 = 크로스세션 누수). 미지정=현행(전 스레드).
      if (scopeThreadKey !== undefined && scopeThreadKey !== "" && tk !== scopeThreadKey) continue;
      const seq = typeof p.seq === "number" ? p.seq : 0;
      const adapter = typeof p.adapter === "string" ? p.adapter : "";
      // ★실제 응답 모델을 이력 투영에 포함 (2026-07-27). 종전엔 여기서 버려져, 라이브 SSE 에는
      //  모델이 보이는데 **새로고침하면 사라지고** 전체활동 뷰엔 아예 안 나왔다(같은 데이터인데
      //  경로에 따라 달라지는 것 = 관측을 믿을 수 없게 만든다). 없으면 키 자체를 생략(거짓값 금지).
      const model = typeof p.model === "string" && p.model !== "" ? p.model : undefined;
      if (p.kind === "text") {
        // 텍스트 세그먼트 — phase/output/diff 없음(발행측이 안 채움). 그대로 1건.
        out.push({
          ts: e.ts,
          threadKey: tk,
          adapter,
          ...(model !== undefined ? { model } : {}),
          seq,
          label: typeof p.label === "string" ? p.label : "text",
          detail: "",
          kind: "text",
          text: typeof p.text === "string" ? p.text : "",
        });
        continue;
      }
      if (p.phase === "end") {
        // 실행시간 주석 이벤트 — 스텝은 아니나 output 이 있으면 시작 스텝에 병합.
        if (p.output !== undefined && p.output !== null) endOutputs.set(okey(tk, adapter, seq), p.output);
        continue;
      }
      out.push({
        ts: e.ts,
        threadKey: tk,
        adapter,
        ...(model !== undefined ? { model } : {}),
        seq,
        label: typeof p.label === "string" ? p.label : "tool",
        detail: typeof p.detail === "string" ? p.detail : "",
        kind: "tool",
        ...(p.diff !== undefined && p.diff !== null ? { diff: p.diff } : {}),
        ...(typeof p.plan === "string" ? { plan: p.plan } : {}),
      });
    }
    // 2차 — end output 을 대응 시작 스텝에 병합.
    if (endOutputs.size > 0) {
      for (const s of out) {
        const o = endOutputs.get(okey(s.threadKey, s.adapter, s.seq));
        if (o !== undefined) s.output = o;
      }
    }
    // ★ASC 로 돌려준다 (2026-07-30) — `entries`(ASC, 위 sinceTs 주석)와 **같은 방향**이어야
    //  한다. listEvents 는 `ORDER BY id DESC` 라 여기까지 최신순인데, 소비처는 ASC 를
    //  가정한다: `tabs.js` 의 진행 중 턴 분할이 배열 끝에서부터 seq 증가 구간을 되짚어
    //  "마지막 turn" 을 찾는다(DESC 면 가장 오래된 1건만 집어 재개가 깨진다).
    //  `groupMergedItems` 는 자체 정렬이라 무영향 — 즉 지금까지 이 뒤집힘이 드러난 곳이
    //  분할 로직 하나뿐이었고, 그마저 위 상한 컷 때문에 실행된 적이 없어 가려져 있었다.
    out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
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

  /**
   * 아웃바운드 능력(ADR 2026-07-16 §D1/§D3) — **관측-전용**. `deliver` 없음(undefined):
   * 물리 발송 없이 `deliverOutbound` 의 publishOut(`channel.message.out`)이 대시보드 SSE 로
   * 배달한다(현행 switch http-bridge 케이스 = publishOut 만, 비트 동일). "미등록(unsupported)"
   * 과 "등록+deliver없음(관측전용)" 은 레지스트리 존재로 구분 — 자신을 *등록*하되 deliver 를
   * 안 실어 현행 동작 유지. index.ts loader 가 이 필드를 duck-typing 으로 읽어 등록(§0 준수).
   * defaultOutboundTarget = null(세션 문맥 의존, 명시 target 필요).
   */
  readonly outbound: ChannelOutbound = {
    defaultOutboundTarget: (): string | null => null,
  };

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
    this.port = parseInt(process.env.HTTP_BRIDGE_PORT ?? "7011", 10);
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
      // ★SSE 도 redact 한다 (2026-07-29 검토). event-persist 는 **insertEvent 로 넘기는
      //  문자열 사본만** redact 해서 DB 만 닫혔고, 여기 fan-out 은 원본 객체를 그대로
      //  stringify 했다(그 파일 주석의 "DB 와 SSE 를 한 지점에서 동시에 닫는다"는 사실이
      //  아니었다). 실증: events id=34467 에 `[REDACTED:TIGUCLAW_BRIDGE_TOKEN]` 마커가 있다
      //  = 그 순간 버스 payload 엔 토큰 평문이 있었고 그게 /events(요구 role=read)로 나갔다.
      //  이벤트당 1회만 계산되므로(클라이언트 수와 무관) 비용은 문자열 1벌.
      const line = `data: ${redactSecrets(JSON.stringify(event))}\n\n`;
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
      // ★진행 중 메인 턴 — "살아있나" 가 아니라 "지금 누구를 위해 일하나" (2026-08-01 A5).
      //  재시작 전 확인용. 미등록이면 null 로 답한다(0 과 구분 — 모르는 걸 안전으로 읽으면
      //  그게 사고의 형상이었다).
      const inflight = getInflightTurns();
      writeJson(res, 200, {
        ok: true,
        version: VERSION,
        buffer_size,
        subscribers: this.sseClients.size,
        channel_handler: this.channelHandler !== null,
        active_turns: inflight === null ? null : inflight.count,
        active_turn_threads: inflight === null ? null : inflight.keys,
      });
      return;
    }

    // LLM 게이트웨이 모델 목록 — OpenAI 호환 `GET /v1/models`(ADR 2026-07-25). chat 과 동일
    // 인증(gateway 토큰), 비활성=404. read-only 라 동시성 캡 밖(gatewayInflight 무증감).
    if (pathname === "/v1/models" && method === "GET") {
      const gw = resolveGatewayRuntime(); // settings fresh read → 재시작 없이 반영.
      if (!gw.enabled) {
        writeJson(res, 404, { error: { message: "llm gateway disabled (settings gateway.enabled / token not set)" } });
        return;
      }
      const auth = req.headers.authorization ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      if (bearer !== gw.token) {
        writeJson(res, 401, { error: { message: "unauthorized" } });
        return;
      }
      writeJson(res, 200, buildModelsListResponse(gw.poolRaw));
      return;
    }

    // LLM 게이트웨이 — OpenAI 호환. **브리지 role 토큰과 별개**의 전용 게이트웨이 토큰.
    // 비활성 = 404. 앱 서버가 토큰 쥐고 호출(브라우저 직접 금지). 127.0.0.1 바인드.
    if (pathname === "/v1/chat/completions" && method === "POST") {
      const gw = resolveGatewayRuntime(); // settings fresh read → 재시작 없이 반영.
      if (!gw.enabled) {
        writeJson(res, 404, { error: { message: "llm gateway disabled (settings gateway.enabled / token not set)" } });
        return;
      }
      const gwAuth = req.headers.authorization ?? "";
      const bearer = gwAuth.startsWith("Bearer ") ? gwAuth.slice("Bearer ".length).trim() : "";
      if (bearer !== gw.token) {
        writeJson(res, 401, { error: { message: "unauthorized" } });
        return;
      }
      if (gatewayInflight >= gw.maxConcurrency) {
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
        ? (body.messages as GatewayChatMessage[])
        : [];
      if (messages.length === 0) {
        writeJson(res, 400, { error: { message: "messages required" } });
        return;
      }
      const { system, text } = flattenChatMessages(messages);
      // 함수콜 패스스루(ADR 2026-07-25 §Decision-5) — body.tools 없으면 미주입(현행, 회귀 0).
      const gatewayTools = parseGatewayTools(body);
      // 비전(ADR 2026-07-25) — messages content 의 image_url(data: URI) → Attachment. 기존
      //   ingestAttachments/attachments seam 재사용(어댑터 vision 경로 그대로). 이미지 없으면
      //   빈 배열=현행 text-only(회귀 0). 파싱/캡 위반은 400.
      let gatewayAttachments: Attachment[] = [];
      try {
        gatewayAttachments = await ingestAttachments(
          extractGatewayImageAttachments(messages),
          this.name,
        );
      } catch (e) {
        writeJson(res, 400, {
          error: { message: `image parse failed: ${e instanceof Error ? e.message : String(e)}` },
        });
        return;
      }
      const specs = resolveGatewaySpecs(body.model, gw.poolRaw);
      const runInput = {
        text: text !== "" ? text : " ",
        threadKey: `gateway:${crypto.randomUUID()}`,
        channel: this.name,
        internal: true as const, // persist·이벤트 스킵(대시보드·트랜스크립트 무오염).
        toolPolicy: { mode: "none" as const }, // 도구 0.
        systemPromptOverride: system, // 앱 system(빈 문자열도 override — 비서 페르소나 스킵).
        ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}), // 비전.
        ...gatewayTools, // 함수콜 패스스루(externalTools/externalToolChoice, 없으면 미주입).
      };
      const specOpt = specs.length > 0 ? { specs } : undefined;
      const cid = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const reqModel = typeof body.model === "string" ? body.model : "tiguclaw";

      // ── 스트리밍(stream:true) — SSE, OpenAI chat.completion.chunk. 이 게이트웨이 턴의
      // llm.delta(threadKey 필터)를 구독해 content 청크로 중계. 델타 전무(비스트리밍 모델)
      // 시 완료 후 전체본 1청크 폴백. 함수콜(ADR 2026-07-25 §Decision-5) — llm.tool_call_delta
      // (형제 이벤트, llm.delta 확장 아님)를 옆에서 구독해 index-기반 tool_calls 조각으로 중계.
      // externalTools 미요청 turn 은 이 이벤트 발행처 자체가 없어 이 구독은 그냥 무동작(회귀 0). ──
      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let modelLabel = reqModel;
        let sawDelta = false;
        let sawToolCallDelta = false;
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
        const unsubTool =
          this.bus !== null
            ? this.bus.subscribe((ev) => {
                if (ev.type !== "llm.tool_call_delta") return;
                const p = ev.payload as {
                  threadKey?: string;
                  index?: number;
                  id?: string;
                  name?: string;
                  argumentsDelta?: string;
                };
                if (p.threadKey !== runInput.threadKey) return;
                if (typeof p.index !== "number") return;
                sawToolCallDelta = true;
                chunk(
                  {
                    tool_calls: [
                      {
                        index: p.index,
                        ...(typeof p.id === "string" && p.id !== "" ? { id: p.id, type: "function" } : {}),
                        function: {
                          ...(typeof p.name === "string" && p.name !== "" ? { name: p.name } : {}),
                          ...(typeof p.argumentsDelta === "string" && p.argumentsDelta !== ""
                            ? { arguments: p.argumentsDelta }
                            : {}),
                        },
                      },
                    ],
                  },
                  null,
                );
              })
            : null;
        gatewayInflight += 1;
        try {
          const out = await runRegionA(runInput, specOpt);
          if (out.model !== undefined && out.model !== null && out.model !== "") modelLabel = out.model;
          const toolCalls = out.externalToolCalls ?? [];
          if (toolCalls.length > 0) {
            if (!sawToolCallDelta) {
              // 델타 미발행(폴링형/비스트리밍 어댑터) — llm.delta 전무 폴백과 동형: 완료 후
              // 전체 tool_calls 1청크로.
              chunk(
                {
                  tool_calls: toolCalls.map((tc, i) => ({
                    index: i,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.argumentsJson },
                  })),
                },
                null,
              );
            }
            chunk({}, "tool_calls");
          } else {
            if (!sawDelta && out.text) chunk({ content: out.text }, null); // 델타 전무 폴백.
            chunk({}, "stop");
          }
          res.write("data: [DONE]\n\n");
        } catch (e) {
          res.write(
            `data: ${JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } })}\n\n`,
          );
        } finally {
          if (unsub !== null) safeUnsubscribe(unsub);
          if (unsubTool !== null) safeUnsubscribe(unsubTool);
          gatewayInflight -= 1;
          res.end();
        }
        return;
      }

      // ── 비스트리밍 — out.externalToolCalls 있으면 tool_calls 응답(§Decision-5), 없으면
      // 기존 그대로(content:out.text, finish_reason:"stop") — 하위호환 100%. ──
      gatewayInflight += 1;
      try {
        const out = await runRegionA(runInput, specOpt);
        // ★prompt_tokens 는 **턴 전체 합계** (2026-07-30). `inputTokens` 는 계약상
        //  "마지막 호출 1회"(컨텍스트 참 정도)라, 도구 루프를 도는 요청에서 그걸 내보내면
        //  클라이언트 비용·예산 회계가 실제의 일부만 본다. 제3자에게 나가는 값이라
        //  우리 화면처럼 나중에 눈으로 걸러지지 않는다 — 합계가 정직하다.
        const inTok = out.usage?.inputTokensTotal ?? out.usage?.inputTokens ?? 0;
        const outTok = out.usage?.outputTokens ?? 0;
        const toolCalls = out.externalToolCalls ?? [];
        const hasToolCalls = toolCalls.length > 0;
        writeJson(res, 200, {
          id: cid,
          object: "chat.completion",
          created,
          model: out.model ?? reqModel,
          choices: [
            {
              index: 0,
              message: hasToolCalls
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: toolCalls.map((tc) => ({
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.argumentsJson },
                    })),
                  }
                : { role: "assistant", content: out.text ?? "" },
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
            },
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
          : pathname === "/inventory-item" && method === "GET"
          ? "read"
          : pathname === "/context-menu-items" && method === "GET"
            ? "read"
          : pathname === "/commands" && method === "GET"
            ? "read"
            : pathname === "/channels" && method === "GET"
            ? "read"
            : pathname === "/providers" && method === "GET"
            ? "read"
            : pathname === "/model-profiles" && method === "GET"
            ? "read"
            : pathname === "/chat-history" && method === "GET"
              ? "read"
              : pathname === "/all-activity" && method === "GET"
                ? "read"
              : pathname === "/endpoint-calls" && method === "GET"
                ? "read"
              : pathname === "/sessions" && method === "GET"
              ? "read"
              : pathname === "/projects" && method === "GET"
                ? "read"
              : pathname === "/worker-jobs" && method === "GET"
                ? "read"
                : pathname === "/mcp-tools" && method === "GET"
                  ? "read"
                : pathname === "/shells" && method === "GET"
                  ? "read"
                : pathname === "/shell-output" && method === "GET"
                  ? "read"
                : pathname === "/projects/capability" && method === "GET"
                  ? "read"
                : pathname === "/projects/detail" && method === "GET"
                  ? "read"
                  : pathname === "/messages" && method === "POST"
              ? "write"
              : pathname === "/session-name" && method === "POST"
                ? "write"
              : pathname === "/session-archive" && method === "POST"
                ? "write"
              : pathname === "/set-default-profile" && method === "POST"
                ? "write"
              : pathname === "/set-session-profile" && method === "POST"
                ? "write" // ★누락돼 있었다(2026-07-28) — required=null 로 게이트를 통과해 **read 토큰이 세션 프로파일을 변경**할 수 있었다.
              : pathname === "/set-module-enabled" && method === "POST"
                ? "write"
              : pathname === "/transcribe" && method === "POST"
                ? "write"
              : pathname === "/restart" && method === "POST"
                ? "admin"
                : pathname === "/cancel-queued" && method === "POST"
                  ? "admin"
                : pathname === "/cancel-worker" && method === "POST"
                  ? "write"
                : pathname === "/kill-shell" && method === "POST"
                  ? "write"
                : pathname === "/open-path" && method === "POST"
                  ? "write"
                : pathname === "/project-forget" && method === "POST"
                  ? "write"
                : pathname === "/project-rename" && method === "POST"
                  ? "write"
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
            res.write(`data: ${redactSecrets(JSON.stringify(e))}\n\n`); // 위와 같은 이유.
          } catch {
            return;
          }
        }
      }
      this.sseClients.add(res);
      // 하트비트 — 연결 유지 + **클라이언트 liveness 관측**(2026-07-26).
      //  종전엔 SSE 코멘트(`: ping`)만 보냈는데, 코멘트는 EventSource 의 onmessage 를
      //  발화시키지 않아 **브라우저가 "핑이 끊겼다"를 알 방법이 없었다**. 그래서 연결이
      //  조용히 half-open 으로 죽으면(맥 절전·네트워크 전환·프록시 idle) onerror 도 안 뜨고
      //  readyState 는 OPEN 이라 재연결이 영영 안 걸려, 그 뒤 발행된 이벤트(worker.done 등)를
      //  못 받아 카드가 "실행 중"으로 영구히 남았다(실측: 끝난 워커가 30분째 도는 것처럼 보임).
      //  → 코멘트 대신 **실제 이벤트**로 보내 클라가 수신 시각을 추적/워치독할 수 있게 한다.
      //  `stream.heartbeat` 는 EventBus 를 타지 않는 **전송 계층 전용** 신호(영속·관측 대상 아님)
      //  라 소비자(대시보드)는 렌더하지 않고 liveness 갱신에만 쓴다.
      const heartbeat = setInterval(() => {
        try {
          res.write(`data: ${JSON.stringify({ type: "stream.heartbeat", ts: Date.now() })}\n\n`);
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

    // /inventory — JSON. collectInventory(5 카테고리) + 스케줄(능력 축 확장, 2026-07-18). 스케줄은
    // scheduler 플러그인 store(listSchedules)에서 읽어 인벤토리 아이템 shape(PluginEntry 호환:
    // name·description·enabled·source·metadata)로 매핑 — 대시보드 인벤토리 뷰가 '⏰ 스케줄'
    // 카테고리로 렌더(읽기 전용). next_run 계산은 scheduler mcp list_schedules 로직 재사용(croner
    // dry-run). 격리: 스케줄 수집 실패해도 나머지 인벤토리는 그대로 응답(빈 배열 폴백).
    if (pathname === "/inventory" && method === "GET") {
      try {
        const inv = await collectInventory();
        let schedules: Array<Record<string, unknown>> = [];
        try {
          schedules = listSchedules().map((r) => {
            let nextRun: string | null = null;
            if (r.enabled && r.triggerType === "cron") {
              try {
                const dry = new Cron(r.cronExpr, {
                  timezone: r.timezone,
                  paused: true,
                });
                const next = dry.nextRun();
                nextRun = next === null ? null : next.toISOString();
              } catch {
                nextRun = null;
              }
            }
            const en = r.enabled ? "켜짐" : "꺼짐";
            const status = r.lastStatus ?? "미실행";
            const description =
              r.triggerType === "reboot"
                ? `재부팅 시 · ${en}(${status})`
                : `${r.cronExpr} · 다음 ${nextRun ?? "-"} · ${en}(${status})`;
            const metadata: Record<string, unknown> = {
              trigger_type: r.triggerType,
              dest_channel: r.destChannel,
            };
            if (r.triggerType === "cron") {
              metadata.cron_expr = r.cronExpr;
              metadata.timezone = r.timezone;
              if (nextRun !== null) metadata.next_run = nextRun;
            }
            if (r.destTarget !== null && r.destTarget !== "")
              metadata.dest_target = r.destTarget;
            if (r.lastStatus !== null) metadata.last_status = r.lastStatus;
            if (r.lastError !== null && r.lastError !== "")
              metadata.last_error = r.lastError;
            return {
              category: "schedule",
              name: r.label,
              description,
              source: `schedule:${r.id}`,
              enabled: r.enabled,
              metadata,
            };
          });
        } catch {
          schedules = [];
        }
        writeJson(res, 200, { ...inv, schedules });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /inventory-item?source=<abs> — JSON. 인벤토리 항목의 정의 본문(스킬 SKILL.md·에이전트
    // .md 등 파일)을 경로로 재-Read 해 `{ source, body }`(utf8)로 반환. 대시보드 능력 상세뷰의
    // "본문" 섹션이 소비(/projects/detail 이 PROJECT.md 를 재-Read 하는 것과 동일 결).
    //
    // ★보안 하드제약(allowlist): 임의 파일 읽기 절대 금지. collectInventory 를 매 호출 다시
    // 빌드해 **유효 source 파일 경로 집합**을 만들고(walker 재사용 — 신규 walk 로직 0), 요청
    // source 가 그 집합에 정확히 있을 때만 읽는다. 경로 트래버설(`..`)·심볼릭 우회·레포 무관
    // 임의 경로(예: /etc/passwd)는 집합 불일치로 자연 차단(403). in-process:/builtin:/schedule:
    // 등 비파일 source 는 절대경로가 아니라 집합에 애초에 안 들어감 → 403. 파일 부재 404.
    // read 게이트(위 role 표, /inventory·/projects/detail 과 동일 role).
    if (pathname === "/inventory-item" && method === "GET") {
      const source = url.searchParams.get("source") ?? "";
      if (source.trim() === "") {
        writeJson(res, 400, { error: "source required" });
        return;
      }
      try {
        const inv = await collectInventory();
        const allow = new Set<string>();
        // 모든 카테고리의 파일 source(절대 경로)만 허용 집합에 편입. in-process:/builtin:/
        // schedule: 같은 비파일 source 는 path.isAbsolute 가 false → 자동 제외.
        for (const arr of [
          inv.channel,
          inv.external_plugin,
          inv.skill,
          inv.agent,
          inv.mcp,
          inv.endpoint,
          inv.command,
        ]) {
          for (const e of arr) {
            if (typeof e.source === "string" && path.isAbsolute(e.source)) {
              allow.add(e.source);
            }
          }
        }
        if (!allow.has(source)) {
          // allowlist 밖 = 임의 경로·비파일 source·부재 항목 → 읽기 거부(보안).
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        let body: string;
        try {
          body = await fs.readFile(source, "utf8");
        } catch {
          // 집합엔 있으나 파일 부재/디렉터리(예: 플러그인 dir) → 본문 없음.
          writeJson(res, 404, { error: "not found", source });
          return;
        }
        writeJson(res, 200, { source, body });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /channels — JSON. 라이브 채널 presence(ADR 2026-07-16 §D4 Phase A / U4). 정적 파일
    // walk(collectInventory)와 달리 index.ts 가 부팅 때 실제 로드·시작한 산 channels[] 를
    // 모듈레벨 레지스트리(channel-registry.ts, 동일 프로세스 공유)에서 읽어 그대로 노출.
    // 읽기전용 — outbound 라우팅 무관.
    if (pathname === "/channels" && method === "GET") {
      writeJson(res, 200, { channels: getChannelPresence() });
      return;
    }

    // /worker-jobs — 현재 실행 중(running) 백그라운드 잡 목록. 대시보드 부팅 시 하이드레이션용:
    // 긴 워커의 worker.started SSE 가 replay 창(50) 밖으로 밀리면 새로고침 시 activity-only 카드
    // 라 라벨이 "(작업)"으로 뜨던 문제 → in-memory listJobs 로 label·kind·task 복원. read 게이트.
    if (pathname === "/worker-jobs" && method === "GET") {
      const jobs = listJobs({ runningOnly: true, limit: 200 }).map((j) => ({
        jobId: j.jobId,
        label: j.label,
        kind: j.kind ?? "worker",
        threadKey: j.threadKey,
        // 원 세션(잡 좌표 환원) — worker.* 이벤트 payload 와 동형. 대시보드 세션 스코프 필터가
        // SSE·하이드레이션 어느 경로로 카드를 만들든 같은 근거로 판정하게 한다.
        ownerThreadKey: resolveOwnerThreadKey(j.threadKey),
        status: j.status,
        ...(j.agentName !== undefined ? { agentName: j.agentName } : {}),
        ...(j.modelTier !== undefined && j.modelTier !== ""
          ? { modelTier: j.modelTier }
          : {}),
        ...(j.task !== undefined ? { task: j.task } : {}),
        ...(j.cwd !== undefined && j.cwd !== "" ? { cwd: j.cwd } : {}),
      }));
      writeJson(res, 200, { jobs });
      return;
    }

    // /shells — 백그라운드 셸 관측 레인(ADR 2026-07-17 Phase 2 §C). 대시보드 표면 C
    // (사이드바 "🖥️ 셸/프로세스") 뷰 오픈 시 라이브 시드용. §0 단방향: 코어 export
    // `listShells`(file-ops-mcp.ts) 를 그대로 호출 — 코어는 http-bridge 를 모른다.
    // codex/openai 전용 레인(claude SDK 소유 셸은 Phase 4 관측 브리지 전까지 미포함,
    // ADR §6 명시). read 게이트(자기 셸 목록 조회, /worker-jobs 동형).
    // /mcp-tools?name=<server> — 그 MCP 서버가 제공하는 도구를 **설명·스키마까지** 반환.
    // 인벤토리는 서버 단위라 도구는 이름만 하드코딩돼 있었고(두 곳에 있어 이미 드리프트),
    // 대시보드에서 눌러도 더 볼 게 없었다(사용자 지적). 여기서 **실제 서버 인스턴스에
    // 물어본다** — 하드코딩이 아니라 단일 진실 소스이므로 드리프트가 구조적으로 불가능하다.
    // 지연 조회(이 요청이 올 때만 인스턴스 생성) — 평시 비용 0. read 게이트.
    if (pathname === "/mcp-tools" && method === "GET") {
      const want = (url.searchParams.get("name") ?? "").trim();
      if (want === "") {
        writeJson(res, 400, { error: "name 파라미터가 필요합니다" });
        return;
      }
      try {
        const factory = IN_PROCESS_MCP_FACTORIES[want];
        if (factory === undefined) {
          // 외부 MCP 는 연결된 클라이언트가 있어야 물어볼 수 있다 — 없으면 정직하게 빈 목록.
          writeJson(res, 200, { name: want, tools: [], note: "in-process 서버가 아니라 도구 상세를 조회할 수 없습니다(외부 MCP 는 연결 시점에만 노출)." });
          return;
        }
        const bridge = await adaptClaudeMcpServer(factory(), want);
        const raw = (await bridge.listTools()) as Array<{
          name?: string;
          description?: string;
          inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
        }>;
        const tools = raw.map((t) => ({
          name: String(t.name ?? ""),
          description: String(t.description ?? ""),
          params: Object.keys(t.inputSchema?.properties ?? {}),
          required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [],
        }));
        writeJson(res, 200, { name: want, tools });
      } catch (e) {
        writeJson(res, 500, {
          error: `도구 조회 실패: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return;
    }

    if (pathname === "/shells" && method === "GET") {
      writeJson(res, 200, { shells: listShells() });
      return;
    }

    // /shell-output — 특정 셸의 ★비소비 tail 스냅샷(마지막 16KB stdout/stderr). 대시보드
    // 표면 D(라이브 tail) 폴링용. ★불변식(ADR §1·검증 line 141): 코어 tailShell() 은 모델
    // BashOutput 의 증분 폴링 offset(stdoutRead/stderrRead)을 절대 소비하지 않는다 —
    // 이 엔드포인트를 아무리 폴링해도 모델이 받을 출력이 줄지 않는다. 없는 id 는 404.
    if (pathname === "/shell-output" && method === "GET") {
      const shellId = url.searchParams.get("id") ?? "";
      if (shellId === "") {
        writeJson(res, 400, { error: "id required" });
        return;
      }
      const tail = tailShell(shellId);
      if (tail === undefined) {
        writeJson(res, 404, { error: "shell not found", shellId });
        return;
      }
      writeJson(res, 200, tail);
      return;
    }

    // /context-menu-items — JSON. 대시보드 확장 가능 컨텍스트메뉴 외부 기여 집계
    // (`_workspace/context-menu_architect_contract.md` §2.3 Phase 3, 스킬 기여만 —
    // 플러그인 매니페스트는 후속). 전 스킬 SKILL.md frontmatter `context-menu` 선언을
    // 평탄화 → `MenuItem` shape. action 은 여기서 **고정**(스킬 기여는 항상
    // `invoke_skill`) 후 화이트리스트 통과분만 포함 — endpoint/builtin 은 구조적으로
    // 나올 수 없지만 방어선으로 재검사(§2.4). 전용 스킬-실행 엔드포인트는 만들지 않음
    // — 실행은 프론트가 기존 POST /api/messages(모델 매개)로 발동, 여기선 read 만.
    if (pathname === "/context-menu-items" && method === "GET") {
      try {
        const contributions = await collectContextMenuContributions();
        const items: Array<{
          id: string;
          type: string;
          label: string;
          icon?: string;
          action: { kind: "invoke_skill"; skill: string };
          group?: string;
          danger?: boolean;
        }> = [];
        for (const c of contributions) {
          c.items.forEach((raw, idx) => {
            const action = { kind: "invoke_skill" as const, skill: c.skillName };
            if (!isWhitelistedContextMenuAction(action.kind)) return; // 방어선(도달 불가 — 항상 invoke_skill).
            items.push({
              id: `skill:${c.skillName}:${idx}`,
              type: raw.on,
              label: raw.label,
              ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
              action,
              ...(raw.group !== undefined ? { group: raw.group } : {}),
              ...(raw.danger !== undefined ? { danger: raw.danger } : {}),
            });
          });
        }
        writeJson(res, 200, { items, generatedAt: Date.now() });
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
        const providers = await collectModules();
        writeJson(res, 200, providers);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /model-profiles — JSON. settings.json `models.profiles` 를 대시보드가 표시(순수 read,
    // /models 슬래시와 동일 데이터원 loadModelProfiles). /inventory·/providers 와 동형(read 게이트).
    // 순서는 기본 프로파일을 맨 앞으로(models-command 렌더와 동일 결정성), 각 프로파일에 isDefault 표식.
    // 기본 = settings.json `models.default` 포인터(미설정 시 "default") — 하드코딩 아님.
    // 프로파일 부재 시 profiles:[] graceful(400/500 아님). 편집 아님 — 표시만(설정은 대화·POST /set-default-profile).
    if (pathname === "/model-profiles" && method === "GET") {
      try {
        const map = loadModelProfiles();
        const defaultName = getDefaultProfileName();
        const names = Object.keys(map);
        const rest = names.filter((n) => n !== defaultName);
        const ordered = names.includes(defaultName)
          ? [defaultName, ...rest]
          : rest;
        const profiles = ordered.map((name) => {
          const p = map[name]!;
          return {
            name,
            isDefault: name === defaultName,
            ...(p.description !== undefined ? { description: p.description } : {}),
            pool: p.pool,
            ...(p.fallback !== undefined ? { fallback: p.fallback } : {}),
          };
        });
        writeJson(res, 200, {
          profiles,
          count: profiles.length,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /set-default-profile — 기본 프로파일 포인터(models.default) 설정. write 게이트(위 role 표).
    // body { name } — name 은 실존 프로파일이어야(loadModelProfiles 검증) → 없으면 400(댕글링 차단).
    // OK 면 settings.json read-modify-write(다른 키 보존) → 재시작 없이 fresh read 로 다음 턴 반영.
    if (pathname === "/set-default-profile" && method === "POST") {
      let dbody: Record<string, unknown>;
      try {
        dbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const name = typeof dbody.name === "string" ? dbody.name.trim() : "";
      if (name === "") {
        writeJson(res, 400, { error: "name required" });
        return;
      }
      const profiles = loadModelProfiles();
      if (profiles[name] === undefined) {
        writeJson(res, 400, {
          error: `존재하지 않는 프로파일: ${name}`,
          available: Object.keys(profiles),
        });
        return;
      }
      try {
        setDefaultProfile(name);
        writeJson(res, 200, { ok: true, default: name });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /set-session-profile — 이 세션(대시보드 탭)만 sticky 한 모델 프로파일 선택
    // (ADR _workspace/model-dropdown_architect_contract.md §3-b). write 게이트
    // (/set-default-profile 패턴 복제). ★전역 models.default 는 절대 안 건드림 — 세션 스코프.
    // body { threadKey, profile } — profile 은 실존 프로파일 이름(loadModelProfiles 검증) 또는
    // "default"/"" (= 상속으로 되돌림 → clearSessionModelProfile). 미지 이름 → 400(constraint 2).
    // 저장 키 = (SESSION_STORAGE_CHANNEL, resolveSessionId(...)) — /messages·router 와 동일 정규화.
    if (pathname === "/set-session-profile" && method === "POST") {
      let dbody: Record<string, unknown>;
      try {
        dbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const rawThreadKey =
        typeof dbody.threadKey === "string" ? dbody.threadKey.trim() : "";
      if (rawThreadKey === "") {
        writeJson(res, 400, { error: "threadKey required" });
        return;
      }
      // profile 필드(계약) — name alias 도 관용 허용.
      const rawProfile =
        typeof dbody.profile === "string"
          ? dbody.profile.trim()
          : typeof dbody.name === "string"
            ? dbody.name.trim()
            : "";
      // /messages 와 동일 정규화 — sessionId = resolveSessionId(this.name, threadKey, threadKey).
      const sessionId = resolveSessionId(this.name, rawThreadKey, rawThreadKey);
      // "" / "default" / 현재 전역 default 이름 → 세션 override 제거(전역 default 상속).
      const isInherit =
        rawProfile === "" ||
        rawProfile === "default" ||
        rawProfile === getDefaultProfileName();
      if (isInherit) {
        try {
          clearSessionModelProfile(SESSION_STORAGE_CHANNEL, sessionId);
          writeJson(res, 200, { ok: true, threadKey: rawThreadKey, profile: null });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          writeJson(res, 500, { error: m });
        }
        return;
      }
      // 실존 프로파일 검증(댕글링 차단 = constraint 2 방어심).
      const profiles = loadModelProfiles();
      if (profiles[rawProfile] === undefined) {
        writeJson(res, 400, {
          error: `존재하지 않는 프로파일: ${rawProfile}`,
          available: Object.keys(profiles),
        });
        return;
      }
      try {
        setSessionModelProfile(SESSION_STORAGE_CHANNEL, sessionId, rawProfile);
        writeJson(res, 200, {
          ok: true,
          threadKey: rawThreadKey,
          profile: rawProfile,
        });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /set-module-enabled — kind:plugin 모듈 활성/비활성(ADR 2026-07-17-module-capability-model
    // §5.6 MVP). write 게이트(위 role 표, /set-default-profile·/cancel-worker 패턴).
    // body { name, enabled }. 코어는 이 경로에 없음(loadPlugins 가 <root>/plugins/* 만 훑음 —
    // 가드1 이 자연 강제, 여기서 별도 kind 검사 불필요). ★MVP = config 만 갱신 — 재시작해야
    // loadPlugins 스킵이 실제 적용(핫토글 아님) → 응답에 requiresRestart:true 로 항상 안내.
    // dashboard·http-bridge 비활성 = "자기 눈 가림"(대시보드 자체가 안 뜨거나 이 API 자체가
    // 죽음) — 막지 않되(사용자 결정, 파괴적-행위 소프트 게이트) warning:"critical" 을 실어
    // 프런트가 danger 확인하게 한다.
    if (pathname === "/set-module-enabled" && method === "POST") {
      let dbody: Record<string, unknown>;
      try {
        dbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const name = typeof dbody.name === "string" ? dbody.name.trim() : "";
      const enabled = dbody.enabled;
      if (name === "") {
        writeJson(res, 400, { error: "name required" });
        return;
      }
      if (typeof enabled !== "boolean") {
        writeJson(res, 400, { error: "enabled(boolean) required" });
        return;
      }
      // 존재 검증(댕글링 이름 차단) — inventory 의 channel/external_plugin 카테고리(loadPlugins
      // 가 <root>/plugins/* 에서 훑는 대상과 동일 모집단)에서 이름을 찾는다.
      try {
        const inv = await collectInventory();
        const known = [...inv.channel, ...inv.external_plugin].some(
          (e) => e.name === name,
        );
        if (!known) {
          writeJson(res, 400, {
            error: `존재하지 않는 모듈: ${name}`,
            available: [...inv.channel, ...inv.external_plugin].map((e) => e.name),
          });
          return;
        }
        setModuleDisabled(name, !enabled);
        const warning = CRITICAL_MODULE_NAMES.has(name) ? "critical" : undefined;
        writeJson(res, 200, {
          ok: true,
          name,
          enabled,
          requiresRestart: true,
          ...(warning !== undefined ? { warning } : {}),
        });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /transcribe — 오디오 바이트 → 텍스트(대시보드 🎤 음성입력, 2026-07-18). config-driven 전사
    // 인프라(resolveTranscriptionProvider) 재사용 — 첨부/텔레그램 음성 전사와 동일 provider·언어
    // (settings.json transcription). body { dataBase64, mimeType } → 임시파일(attachmentsDir/transcribe)
    // 저장 → provider.transcribe → { text }. 전사 미설정/disabled 는 { error }(200, 프런트 토스트).
    // ★never-throw: 저장/전사/파싱 실패는 { error } + 로그로 닫고 데몬 생존(핫경로 격리). write 게이트
    // (읽기성이나 파일 업로드라 write 권장). 임시파일은 전사 후 정리(우발 누적 방지 — 채팅 첨부와
    // 달리 회수/서빙 대상 아님). openai 25MB 한도 정합 위해 파일당 캡(ATTACH_MAX_FILE_BYTES) 재사용.
    if (pathname === "/transcribe" && method === "POST") {
      let tbody: Record<string, unknown>;
      try {
        tbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const dataBase64 = typeof tbody.dataBase64 === "string" ? tbody.dataBase64 : "";
      const mimeRaw =
        typeof tbody.mimeType === "string" && tbody.mimeType !== ""
          ? tbody.mimeType
          : "audio/webm";
      if (dataBase64 === "") {
        writeJson(res, 400, { error: "dataBase64 required" });
        return;
      }
      const buf = Buffer.from(dataBase64, "base64");
      if (buf.length === 0) {
        writeJson(res, 400, { error: "빈 오디오" });
        return;
      }
      if (buf.length > ATTACH_MAX_FILE_BYTES) {
        writeJson(res, 400, {
          error: `오디오가 한도(${ATTACH_MAX_FILE_BYTES / 1024 / 1024}MB)를 초과합니다.`,
        });
        return;
      }
      // provider 해석은 저장 전에(미설정이면 파일 안 만들고 조기 종료). cwd = 데몬 루트(dev 홈은
      // TIGUCLAW_HOME 이 아닌 settings 레이어가 해석 — loadTranscriptionConfig 가 홈/프로젝트 병합).
      const resolved = resolveTranscriptionProvider(process.cwd());
      if (resolved === null) {
        writeJson(res, 200, {
          error: "전사가 설정되지 않았습니다 (settings.json transcription).",
        });
        return;
      }
      const mime = (mimeRaw.split(";")[0] ?? "audio/webm").trim();
      const ext = AUDIO_EXT_BY_MIME[mime] ?? "webm";
      const tmpDir = path.join(getPaths().attachmentsDir, "transcribe");
      let tmpPath = "";
      try {
        await fs.mkdir(tmpDir, { recursive: true });
        tmpPath = path.join(
          tmpDir,
          `${crypto.randomBytes(8).toString("hex")}.${ext}`,
        );
        await fs.writeFile(tmpPath, buf);
        const text = await resolved.provider.transcribe({
          filePath: tmpPath,
          mimeType: mime,
          language: resolved.language,
        });
        writeJson(res, 200, { text: text.trim() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[transcribe] 실패 — ${msg}`);
        writeJson(res, 200, { error: `전사 실패: ${msg}` });
      } finally {
        if (tmpPath !== "") {
          try {
            await fs.unlink(tmpPath);
          } catch {
            /* 임시파일 정리 실패 무해(다음 부팅·OS 청소) */
          }
        }
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
        // threadKey — 멀티세션 탭(ADR 2026-07-15 D5.3). 지정 시 그 스레드만, 미지정 시
        // 현행(전 스레드 병합, 회귀 0). limit/beforeTs 와 결합.
        const threadKeyRaw = url.searchParams.get("threadKey");
        const threadKey =
          threadKeyRaw !== null && threadKeyRaw.trim() !== ""
            ? threadKeyRaw
            : undefined;
        const entries = getRecentChatLog({
          limit,
          ...(beforeTs !== undefined ? { beforeTs } : {}),
          ...(threadKey !== undefined ? { threadKey } : {}),
        });
        // 비서 표시 이름(AGENT.md 이름 필드, 없으면 tiguclaw) — 대시보드 채팅 라벨용.
        // activities(기능 B) — 이력에 도구 스텝 복원(새로고침 후에도 도구 사용 표시).
        writeJson(res, 200, {
          entries,
          // 상한은 역방향 페이지네이션(beforeTs)일 때만 — 최신 페이지는 진행 중 턴의
          // 활동이 chat_log 마지막 행보다 뒤에 있어 상한을 걸면 통째로 사라진다.
          activities: historyActivities(entries, threadKey, beforeTs !== undefined),
          assistantName: getAssistantName(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /all-activity — JSON. 전체활동(크로스세션) 뷰(_workspace/all-activity_architect_contract.md
    // §1.1). /chat-history 의 언스코프 버전 — threadKey 를 아예 전달하지 않아 getRecentChatLog
    // 가 전 스레드 병합으로 동작(chat-log.ts, 이미 준비됨)하고 historyActivities 도
    // scopeThreadKey 생략 호출로 전 스레드 활동을 병합(L355 분기가 undefined 면 통과 — 이미
    // 준비됨). store·historyActivities 시그니처 변경 없음. assistantName 등 세션특화 필드는
    // 이 뷰에 불필요(읽기전용 모니터). read 게이트(위 role 표).
    // 엔드포인트 호출 이력 (2026-08-01) — 종전엔 대시보드가 **라이브 SSE 로만** 채워서
    // 새로고침·데몬 재시작이면 전멸했다("엔드포인트 기록들이 다 사라졌어"). `endpoint.call`
    // 을 영속으로 돌리고(event-persist SKIP 해제) 여기서 되읽는다 — 채팅의 `/chat-history`
    // 와 같은 자리. 라이브 SSE 는 그대로 두고, **열 때 과거를 채우는** 용도다.
    if (pathname === "/endpoint-calls" && method === "GET") {
      try {
        const raw = url.searchParams.get("limit");
        const n = raw !== null ? parseInt(raw, 10) : NaN;
        const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 60;
        // 한 호출이 start/done 2건이므로 넉넉히 읽어 callId 로 접는다(done 이 start 를 대체).
        const rows = listEvents({ types: ["endpoint.call"], limit: limit * 3 });
        const byCall = new Map<string, { ts: number; payload: Record<string, unknown> }>();
        for (const r of rows) {
          // ★`PersistedEvent.payload` 는 **JSON 문자열**이다(객체 아님). 캐스팅으로 넘기면
          //  조용히 빈 값이 나간다 — tsc 가 잡아줬다.
          let pl: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(r.payload);
            pl =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
          } catch {
            continue; // 깨진 행은 건너뛴다(한 행이 이력 전체를 막지 않게).
          }
          const id = String(pl.callId ?? r.ts);
          const prev = byCall.get(id);
          // done(phase!=="start") 이 start 를 이긴다. 같은 phase 면 나중 것.
          if (prev === undefined || pl.phase !== "start" || prev.payload.phase === "start") {
            byCall.set(id, { ts: r.ts, payload: pl });
          }
        }
        // ★start 만 있고 done 이 없는 호출 = **끝을 못 본 호출**(데몬 재시작 등).
        //  그대로 두면 화면에 영원히 "진행 중" 으로 보인다 — 오늘 고친 "실패했는데 아무것도
        //  안 보이는" 것의 화면판이다. 진행 중일 수 없는 시간이 지났으면 미완으로 못 박는다.
        const STALE_MS = 10 * 60_000;
        const now = Date.now();
        const calls = [...byCall.values()]
          .sort((a, b) => a.ts - b.ts)
          .slice(-limit)
          .map((c) =>
            c.payload.phase === "start" && now - c.ts > STALE_MS
              ? {
                  ts: c.ts,
                  ...c.payload,
                  phase: "done",
                  ok: false,
                  response:
                    "(완료 기록 없음 — 데몬 재시작 등으로 중단된 호출입니다. 생성 중이던 응답은 남지 않았습니다.)",
                }
              : { ts: c.ts, ...c.payload },
          );
        writeJson(res, 200, { calls, generatedAt: new Date().toISOString() });
      } catch (e) {
        writeJson(res, 500, { error: String(e) });
      }
      return;
    }

    if (pathname === "/all-activity" && method === "GET") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const parsed = limitRaw !== null ? parseInt(limitRaw, 10) : NaN;
        const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
        const beforeRaw = url.searchParams.get("beforeTs");
        const beforeParsed =
          beforeRaw !== null ? parseInt(beforeRaw, 10) : NaN;
        const beforeTs =
          Number.isFinite(beforeParsed) && beforeParsed > 0
            ? beforeParsed
            : undefined;
        const entries = getRecentChatLog({
          limit,
          ...(beforeTs !== undefined ? { beforeTs } : {}),
        });
        writeJson(res, 200, {
          entries,
          // /chat-history 와 동일 규칙 — 상한은 역방향 페이지(beforeTs)에서만.
          activities: historyActivities(entries, undefined, beforeTs !== undefined),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: msg });
      }
      return;
    }

    // /sessions — JSON. 대시보드 멀티세션 탭(ADR 2026-07-15 §D6). ★채널/세션 분리로 세션이
    // 채널 무관이 됐으므로 `prefix:'dashboard:'` 필터를 폐지하고 `excludeInternal:true` 로
    // **사용자 대면 대화 세션 전체**(현행 dashboard:* + 레거시 tg:*/cli:* 과거 대화)를 반환한다
    // — 내부 파생 스레드(worker:/agent:/endpoint:/gateway:/scheduler:/`::sub::`)만 배제.
    // 텔레그램 기본 세션 = 대시보드 첫 탭 = 동일 id(DEFAULT_SESSION_ID)라 중복 0. 세션별
    // 프리뷰(chat_log 최근 1건 요약) 부착. read 게이트. SSE 는 전체 브로드캐스트 유지(D5).
    if (pathname === "/sessions" && method === "GET") {
      try {
        // 사용자에게 보이는 목록 — 프로브·검증 흔적 제외(대시보드 세션 목록과 /sessions 공통 기준).
        const threads = listThreads({ excludeInternal: true });
        const sessions = threads.map((t) => {
          // 프리뷰 — 그 스레드 최근 1건 text 요약(80자 슬라이스). 첨부-only(text="")는
          // 스킵되어 빈 프리뷰(undefined)로 graceful.
          const recent = getRecentChatLog({ threadKey: t.threadKey, limit: 1 });
          const previewText = recent.length > 0 ? recent[recent.length - 1]!.text : "";
          const preview =
            previewText.trim() !== ""
              ? previewText.replace(/\s+/g, " ").slice(0, 80)
              : undefined;
          // 세션 모델 프로파일(대시보드 드롭다운 상태 복원용, additive — 기존 소비자 무영향,
          // ADR model-dropdown §3-c). 미기재 세션 → null(드롭다운 default 로 hydrate).
          const modelProfile = getSessionModelProfile(
            SESSION_STORAGE_CHANNEL,
            t.threadKey,
          );
          return {
            threadKey: t.threadKey,
            lastUsedAt: t.lastUsedAt,
            ...(t.model !== null ? { model: t.model } : {}),
            ...(preview !== undefined ? { preview } : {}),
            ...(t.name !== null ? { name: t.name } : {}),
            // ★표시명은 **서버가 정한다** — 클라가 각자 파생하면 같은 세션이 채널마다
            //  다른 이름으로 보인다(실제로 그랬다: 대시보드 `세션3` vs 텔레그램 생키).
            displayName: sessionDisplayName(
              t.threadKey,
              t.name,
              // ★*첫* 발화다(최근 아님) — 최근으로 파생하면 이름이 매 턴 바뀐다.
              getFirstUserText(t.threadKey),
            ),
            modelProfile: modelProfile ?? null,
          };
        });
        writeJson(res, 200, {
          sessions,
          generatedAt: new Date().toISOString(),
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
        const ctype = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
        // ★inline 실행 차단 3종 (2026-07-31 전체검토 P0):
        //  ①nosniff — 브라우저가 내용을 보고 타입을 추측(sniff)해 HTML/SVG 로 실행하는 것 차단.
        //  ②알려진 안전 타입이 아니면 `attachment` — 다운로드로만 열리고 렌더되지 않는다.
        //  ③CSP sandbox — 혹시 렌더돼도 스크립트·같은 오리진 권한이 없다.
        const inlineSafe = CONTENT_TYPE_BY_EXT[ext] !== undefined;
        res.writeHead(200, {
          "Content-Type": ctype,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
          ...(inlineSafe
            ? {}
            : { "Content-Disposition": `attachment; filename="${sanitizeFilename(path.basename(abs))}"` }),
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

    // /projects/capability?path=<abs>&kind=skill|agent&name=<name> — 프로젝트 **전용** 능력의
    // 본문(markdown). 대시보드 프로젝트 상세에서 항목을 **눌렀을 때만** 부른다.
    //
    // ★본문을 `/projects/detail` 에 싣지 않는 이유: 스킬 하나가 10KB 를 넘는다. 프로젝트를
    //  열 때마다 전부 실으면 목록 한 번 보는 데 수십 KB 를 옮기게 된다 — 게으른 조회가 맞다.
    // ★임의 파일 읽기가 아니다: 경로를 받지 않고 **프로젝트+종류+이름으로 해소**한 뒤 그
    //  discover 결과의 filePath 만 읽는다. `source === "project"` 로 한 번 더 좁혀 전역 자산도
    //  이 통로로는 안 나간다(프로젝트 것은 프로젝트 레벨에서만 — 2026-08-07 사용자 확정).
    if (pathname === "/projects/capability" && method === "GET") {
      const projectPath = url.searchParams.get("path") ?? "";
      const kind = url.searchParams.get("kind") ?? "";
      const name = url.searchParams.get("name") ?? "";
      if (projectPath.trim() === "" || name.trim() === "") {
        writeJson(res, 400, { error: "path·name required" });
        return;
      }
      if (kind !== "skill" && kind !== "agent") {
        writeJson(res, 400, { error: "kind 는 skill 또는 agent" });
        return;
      }
      try {
        const found =
          kind === "skill"
            ? (await discoverSkills(projectPath).catch(() => [])).find(
                (x) => x.source === "project" && x.name === name,
              )
            : (await discoverAgents(projectPath).catch(() => [])).find(
                (x) => x.source === "project" && x.name === name,
              );
        if (found === undefined) {
          writeJson(res, 404, { error: `이 프로젝트의 ${kind} '${name}' 을 찾을 수 없습니다.` });
          return;
        }
        const raw = await fs.readFile(found.filePath, "utf8");
        // 상한 — 브라우저 DOM 에 통째로 붓지 않는다(비대화 방지). 넘으면 잘렸다고 말한다.
        const CAP = 64 * 1024;
        const body = raw.length > CAP ? `${raw.slice(0, CAP)}\n\n…(${raw.length - CAP}자 생략 — 전문은 ${found.filePath})` : raw;
        writeJson(res, 200, { name: found.name, kind, body });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
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
      // 채널/세션 분리(ADR 2026-07-15 §D1/§D2) — 대시보드는 활성 탭 세션 id 를 body.threadKey
      // 로 명시 전달(explicitSessionId → resolveSessionId passthrough). 비-대시보드 http
      // default(threadKey 미부여)는 기본 세션(DEFAULT_SESSION_ID)으로 수렴. channelAddress =
      // http 배달 좌표(= sessionId, 대시보드가 SSE 를 그 탭으로 라우팅). msg.threadKey=sessionId
      // 로 세팅(직렬 큐/`/cancel-queued`/`/stop` 정합) + session 으로 route 가 canonical
      // (http-bridge, sessionId) 로 정규화. 세션 id 는 채널 무관 — telegram/cli 기본 세션과 공유.
      const explicitSessionId =
        typeof body.threadKey === "string" && body.threadKey.trim() !== ""
          ? body.threadKey.trim()
          : undefined;
      const threadKey = resolveSessionId(
        this.name,
        explicitSessionId,
        explicitSessionId,
      );
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
      // 답글 인용(대시보드 등) — body.replyToText 를 중립 필드로 실어 route 직전 인용 주입
      // (telegram 의 reply_to_message 와 동형·LLM-agnostic, index.ts 934 단일 지점). 캡 1500.
      const replyToText =
        typeof body.replyToText === "string" ? body.replyToText.trim().slice(0, 1500) : "";
      // 큐-취소 correlationId(ADR 2026-07-15) — 클라(대시보드)가 전송 순간 만든 상관 id.
      // 실제 사용자 인바운드(POST /messages)만 실린다 — 이 값을 큐 항목 식별 키로 전달해
      // 대기 중(미시작) 항목을 나중에 POST /cancel-queued 로 지목 취소 가능. 미부여 = 익명
      // 큐 항목(현행 동작). 어댑터는 이 값을 안 읽는다(순수 큐 상관, #2 LLM-agnostic).
      const correlationId =
        typeof body.correlationId === "string" ? body.correlationId.trim() : "";
      // egress fan-out(ADR 2026-07-16 §D4 Phase B2) — 컴포저 체크박스가 "이 답도 함께 보낼"
      // 추가 채널들(예 telegram)을 body.outboundChannels(string[]) 로 실어 온다. swap 아님 —
      // 인입 채널 응답은 항상 유지. 여기선 문자열 배열 검증만(라우팅·outbound-capable 여부는 코어
      // handler 가 레지스트리 조회로) → egressChannels 중립 필드로 전달. 미지정/빈 배열/비배열 =
      // undefined(현행 동작·회귀 0). 중복·빈문자 제거.
      const egressChannels = Array.isArray(body.outboundChannels)
        ? [
            ...new Set(
              body.outboundChannels
                .filter((c): c is string => typeof c === "string")
                .map((c) => c.trim())
                .filter((c) => c !== ""),
            ),
          ]
        : [];
      // 아웃바운드 첨부(send_file, #2 parity) — 텔레그램 sendDocument 와 동형의 추상 의도
      // 렌더. send_file 된 절대경로를 통제 디렉터리로 복사(servable rel 확보)한 뒤,
      // `channel.message.out` 이벤트에 additive `attachments:[{rel,name,mime,kind,caption?}]`
      // 를 실어 발행한다 → 대시보드가 SSE 로 받아 첨부 카드(미리보기+받기 버튼)로 렌더하고,
      // event-persist 가 chat_log(role:assistant)에 영속(인바운드 첨부 영속과 대칭 = 새로고침·
      // 재시작 후에도 유지). 멱등은 호출자(send_file 도구, per-turn sentPaths)가 보장 — 채널은
      // 복사+발행 1회만. bus 미연결(observer 미부착)이면 렌더 경로 없음 → {ok:false}.
      const channelName = this.name;
      const sendAttachment: IncomingMessage["sendAttachment"] = async (
        filePath,
        opts,
      ) => {
        const meta = await persistOutboundAttachment(filePath, channelName).catch(
          () => null,
        );
        if (meta === null) {
          return {
            ok: false,
            error: `파일을 찾을 수 없거나 접근할 수 없습니다: ${filePath}`,
          };
        }
        if (bus === null) {
          return { ok: false, error: "control bus not started (대시보드 미연결)" };
        }
        try {
          bus.publish({
            type: "channel.message.out",
            ts: Date.now(),
            payload: {
              channel: channelName,
              threadKey,
              text: "", // 첨부-only 아웃바운드(캡션은 attachment.caption 으로). 최종 답변 text-out 과 별개 버블.
              attachments: [
                {
                  rel: meta.rel,
                  mime: meta.mime,
                  name: meta.name,
                  kind: meta.kind,
                  bytes: meta.bytes,
                  ...(opts?.caption !== undefined && opts.caption !== ""
                    ? { caption: opts.caption }
                    : {}),
                },
              ],
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
        // 배달 좌표(http) = sessionId. 세션 정규화 지시(session) — 대시보드는 explicitSessionId
        // 로 활성 탭 세션 passthrough, 비-대시보드는 미부여 → route 가 DEFAULT 로 수렴.
        channelAddress: threadKey,
        session: {
          ...(explicitSessionId !== undefined ? { explicitSessionId } : {}),
          channelAddress: threadKey,
        },
        text,
        receivedAt: Date.now(),
        ...(replyToText !== "" ? { replyToText } : {}),
        ...(correlationId !== "" ? { correlationId } : {}),
        ...(egressChannels.length > 0 ? { egressChannels } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        reply: async (out: string): Promise<void> => {
          replyText = out;
        },
        sendAttachment,
        presentOptions,
      };

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutP = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("timeout"));
        }, HANDLER_TIMEOUT_MS);
      });

      try {
        const outcome = await Promise.race([this.channelHandler(msg), timeoutP]);
        // 큐-취소(ADR 2026-07-15, G1) — 이 항목이 대기 중 취소돼 handler 미실행 no-op
        // resolve 면 정상 흐름으로 {replyText:"", cancelled:true} 응답(에러 아님). 클라는
        // 이미 취소 UI 를 로컬 처리했으므로 무시 가능. isCancelledTurnResult 가 sentinel 판정.
        if (isCancelledTurnResult(outcome)) {
          writeJson(res, 200, { replyText: "", cancelled: true });
        } else if (isSteeredTurnResult(outcome)) {
          // mid-turn steering 주입(ADR 2026-07-16) — 이 메시지는 새 턴이 아니라 진행 턴에
          // append 됐고 핸들러가 즉시 resolve 한다(원래 턴은 아직 진행). 클라가 이 200-반환을
          // "턴 완료"로 오인해 작업중을 조기에 끄지 않도록 steered 플래그를 실어 응답한다.
          // 실제 종료는 원래 턴의 SSE channel.message.out/turn_done 이 담당(steering 조기-off 픽스).
          writeJson(res, 200, { replyText: "", steered: true });
        } else {
          writeJson(res, 200, { replyText });
        }
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

    // /cancel-queued — 대기 중(미시작) 큐 메시지 취소(ADR 2026-07-15). admin 토큰 게이트(위
    // role 표) + 127.0.0.1 바인드. 메시지 큐(enqueueThreadTurn)를 *타지 않는* 제어 경로
    // (/restart·/stop 동형 out-of-band) — 큐 뒤에 붙으면 자기 앞 항목이 끝나야 실행돼 무의미.
    // §0 단방향: 코어 export `cancelQueuedTurn` 을 호출(코어는 http-bridge 를 모른다). 특정
    // 대기 항목을 correlationId 로 지목 취소하고 결과("cancelled"/"already-started"/"not-found")
    // 를 그대로 반환. 텔레그램 후속(/cancel 슬래시 등)도 동일 코어 primitive 재사용 가능(범위 밖).
    if (pathname === "/cancel-queued" && method === "POST") {
      let cbody: Record<string, unknown>;
      try {
        cbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const threadKey =
        typeof cbody.threadKey === "string" ? cbody.threadKey.trim() : "";
      const correlationId =
        typeof cbody.correlationId === "string" ? cbody.correlationId.trim() : "";
      if (threadKey === "" || correlationId === "") {
        writeJson(res, 400, {
          error: "threadKey and correlationId required",
        });
        return;
      }
      const result = cancelQueuedTurn(threadKey, correlationId);
      writeJson(res, 200, { result });
      return;
    }

    // /cancel-worker — 진행 중(running) 백그라운드 워커 수동 취소(2026-07-16). write 게이트
    // (위 role 표) — /messages·/stop 동형 "사용자 자기 잡 제어"(admin 아님, /cancel-queued 는
    // out-of-band 큐 조작이라 admin 이었으나 이건 이미 시작된 *자기* 워커를 멈추는 것뿐).
    // §0 단방향: 코어 export `cancelJob`(src/core/worker-jobs.ts) 를 그대로 호출 — 코어는
    // http-bridge 를 모른다. running 인 worker·agent 모두 실제 취소(U-I4 개정 2026-07-17 —
    // 코어 cancelJob 이 kind∈{worker,agent} 게이트: worker=워커 abort, agent=서브에이전트
    // cancel-only abort 또는 claude native Task 는 부모 턴 coarse abort). done 은 false. abort 는
    // LLM 스트림은 끊지만 hung 도구 호출은 다음 도구 경계까지 못 끊을 수 있다(코어 주석 참조)
    // — 여기선 신호 발사 여부만 정직 반환.
    if (pathname === "/cancel-worker" && method === "POST") {
      let wbody: Record<string, unknown>;
      try {
        wbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const jobId = typeof wbody.jobId === "string" ? wbody.jobId.trim() : "";
      if (jobId === "") {
        writeJson(res, 400, { error: "jobId required" });
        return;
      }
      const cancelled = cancelJob(jobId);
      writeJson(res, 200, { ok: true, cancelled });
      return;
    }

    // /kill-shell — 백그라운드 셸 강제 종료(ADR 2026-07-17 Phase 2 §C). write 게이트
    // (/cancel-worker 동형 — "자기 셸 제어", admin 아님). §0 단방향: 코어 export
    // `killShellById`(file-ops-mcp.ts) 를 그대로 호출 — killTree(그룹 전체)+status=killed+
    // shell.exited 발행까지 그 안에서 처리(모델 대면 KillShell 도구와 동일 헬퍼 재사용).
    // claude 셸(SDK 소유)은 이 레인 밖 — codex/openai BG_SHELLS 에 없는 id 는 killed:false.
    if (pathname === "/kill-shell" && method === "POST") {
      let kbody: Record<string, unknown>;
      try {
        kbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const shellId =
        typeof kbody.shellId === "string" ? kbody.shellId.trim() : "";
      if (shellId === "") {
        writeJson(res, 400, { error: "shellId required" });
        return;
      }
      const killed = await killShellById(shellId);
      writeJson(res, 200, { ok: true, killed });
      return;
    }

    // /session-name — 세션 커스텀 이름 설정(채널무관·UPDATE-only·비파괴, 계약
    // _workspace/session-tabs_architect_contract.md §3-1). write 게이트(위 role 표).
    // body { threadKey, name } — name 은 string|null(빈문자→null=커스텀 제거→파생 폴백).
    // store setThreadName 이 정규화(trim·60캡·빈값→null)까지 수행 — 여기선 pass-through.
    if (pathname === "/session-name" && method === "POST") {
      let nbody: Record<string, unknown>;
      try {
        nbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const threadKey =
        typeof nbody.threadKey === "string" ? nbody.threadKey.trim() : "";
      if (threadKey === "") {
        writeJson(res, 400, { error: "threadKey required" });
        return;
      }
      const nameIn =
        typeof nbody.name === "string" ? nbody.name : null;
      try {
        setThreadName(threadKey, nameIn);
        // 정규화된 값을 응답에 반영 — store 는 changes count 만 반환하므로 여기서
        // 동일 정규화 규칙(trim·60캡·빈값→null)을 재적용해 클라 로컬 동기화값을 만든다.
        const normName =
          nameIn === null || nameIn.trim() === ""
            ? null
            : nameIn.trim().slice(0, 60);
        writeJson(res, 200, { ok: true, threadKey, name: normName });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /session-archive — 세션 보관/복원. ★비파괴(archived_at 만 세팅, 대화 기록 보존).
    //
    // ★왜 필요했나 (2026-08-03): 대시보드의 "탭 닫기" 는 **브라우저 localStorage**
    //  (`dash.closedTabs.v1`)에만 기록됐다. 그런데 탭바는 서버 세션 목록에서 안 열린 것을
    //  자동으로 되살리므로(`refreshSessionPreviews`), 다른 브라우저·기기·캐시 정리 뒤엔
    //  **닫은 세션이 그대로 다시 올라왔다** — 사용자가 본 "세션이 계속 생긴다".
    //  서버엔 이미 `archived_at` 과 `/sessions archive` 명령이 있었는데, 대시보드가 같은
    //  판단을 로컬로 **따로** 구현하고 있었다(같은 판단이 두 곳 = 반드시 갈린다).
    //  body { threadKey, archived: boolean }. 기본 세션은 보관 불가(닫을 수 없는 홈).
    if (pathname === "/session-archive" && method === "POST") {
      let abody: Record<string, unknown>;
      try {
        abody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const threadKey =
        typeof abody.threadKey === "string" ? abody.threadKey.trim() : "";
      if (threadKey === "") {
        writeJson(res, 400, { error: "threadKey required" });
        return;
      }
      if (threadKey === DEFAULT_SESSION_ID) {
        writeJson(res, 400, { error: "기본 세션은 보관할 수 없습니다" });
        return;
      }
      const archived = abody.archived !== false; // 미지정 = 보관.
      try {
        setThreadArchived(threadKey, archived ? Date.now() : null);
        writeJson(res, 200, { ok: true, threadKey, archived });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /project-forget — 프로젝트 등록 해제(레지스트리 인덱스에서만 제거). ★비파괴: PROJECT.md
    // 파일·폴더는 절대 안 지운다(store forgetProject = DELETE FROM projects WHERE path=?). write
    // 게이트(위 role 표, /session-name 동형). body { path } — 정규화·검증 후 forgetProject 호출.
    if (pathname === "/project-forget" && method === "POST") {
      let pbody: Record<string, unknown>;
      try {
        pbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const pathIn =
        typeof pbody.path === "string" ? pbody.path.trim() : "";
      if (pathIn === "") {
        writeJson(res, 400, { error: "path required" });
        return;
      }
      try {
        forgetProject(pathIn);
        writeJson(res, 200, { ok: true, path: pathIn });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }


    // /project-rename — PROJECT.md frontmatter name 갱신 + 레지스트리 캐시 갱신. write.
    if (pathname === "/project-rename" && method === "POST") {
      let pbody: Record<string, unknown>;
      try {
        pbody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const pathIn = typeof pbody.path === "string" ? pbody.path.trim() : "";
      const name = typeof pbody.name === "string" ? pbody.name.trim() : "";
      if (pathIn === "" || name === "") {
        writeJson(res, 400, { error: "path and name required" });
        return;
      }
      if (/[\x00-\x1f\x7f]/.test(name)) {
        writeJson(res, 400, { error: "name must not contain control characters" });
        return;
      }
      const abs = nodePath.resolve(pathIn);
      const projects = listProjects();
      const registered = projects.find((p) => nodePath.resolve(p.path) === abs);
      if (registered === undefined) {
        writeJson(res, 404, { error: "project not registered" });
        return;
      }
      const duplicate = projects.find(
        (p) => nodePath.resolve(p.path) !== abs && p.name === name,
      );
      if (duplicate !== undefined) {
        writeJson(res, 409, { error: "project name already exists" });
        return;
      }
      try {
        const mdPath = path.join(registered.path, "PROJECT.md");
        const raw = await fs.readFile(mdPath, "utf8");
        let next: string;
        if (raw.startsWith("---\n")) {
          const end = raw.indexOf("\n---", 4);
          if (end >= 0) {
            const fm = raw.slice(4, end);
            const rest = raw.slice(end);
            const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const nameLine = `name: "${escaped}"`;
            const nextFm = /^name\s*:/m.test(fm)
              ? fm.replace(/^name\s*:.*$/m, nameLine)
              : `${nameLine}\n${fm}`;
            next = `---\n${nextFm}${rest}`;
          } else {
            next = raw;
          }
        } else {
          const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const escapedDescription = (registered.description ?? "")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
          next = `---\nname: "${escapedName}"\ndescription: "${escapedDescription}"\nstatus: ${registered.status}\n---\n\n${raw}`;
        }
        if (next === raw) {
          writeJson(res, 400, { error: "invalid PROJECT.md frontmatter" });
          return;
        }
        await fs.writeFile(mdPath, next, "utf8");
        const folderName = path.basename(registered.path);
        const meta = parseProjectMd(next, folderName);
        upsertProject({ path: registered.path, ...meta });
        writeJson(res, 200, { ok: true, path: registered.path, name: meta.name });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { error: m });
      }
      return;
    }

    // /open-path — 프로젝트 폴더를 데몬 호스트의 OS 파일 탐색기로 연다(대시보드 프로젝트 카드
    // ⋯ 메뉴). ★보안: **등록된 프로젝트 경로만** 허용(임의 경로 열기·정찰 차단). execFile(배열
    // 인자, no shell)이라 셸 인젝션 0 — 경로는 검증된 등록값만 인자로 넘긴다.
    if (pathname === "/open-path" && method === "POST") {
      let obody: Record<string, unknown>;
      try {
        obody = await readJsonBody(req);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        writeJson(res, 400, { error: `invalid body: ${m}` });
        return;
      }
      const pathIn =
        typeof obody.path === "string" ? obody.path.trim() : "";
      if (pathIn === "") {
        writeJson(res, 400, { error: "path required" });
        return;
      }
      // ★파일 열기 확장 (2026-08-02) — 종전엔 **정확일치(등록 프로젝트 폴더)** 만 허용했다.
      //  편집 카드의 파일도 열려면 "등록 프로젝트 **루트 하위**" 로 넓혀야 한다. 넓히는
      //  만큼 두 가지를 닫는다:
      //   ①**심링크 탈출** — resolve 만으론 `<proj>/link → /etc` 를 못 막는다. realpath 로
      //     실제 대상까지 풀고 **다시** 루트 하위인지 본다(존재하지 않으면 애초에 못 연다).
      //   ②**실행** — macOS `open` 은 `.app`·실행권한 파일을 **실행**한다. 우리는 소스를
      //     *보려는* 것이지 실행하려는 게 아니므로 실행권한이 있으면 거부한다. 디렉터리는
      //     종전대로 허용(폴더 열기가 원래 용도).
      const abs = nodePath.resolve(pathIn);
      let real: string;
      try {
        real = nodeFs.realpathSync(abs);
      } catch {
        writeJson(res, 404, { error: "경로가 존재하지 않습니다" });
        return;
      }
      const roots = listProjects().map((p) => {
        const r = nodePath.resolve(p.path);
        try {
          return nodeFs.realpathSync(r); // 루트도 실제 경로로 — 양쪽을 같은 기준에 놓는다.
        } catch {
          return r; // 루트가 사라졌으면 원경로로 비교(어차피 하위도 존재 안 함).
        }
      });
      const inRoot = roots.some(
        (r) => real === r || real.startsWith(r + nodePath.sep),
      );
      if (!inRoot) {
        writeJson(res, 403, {
          error: "등록된 프로젝트 경로가 아닙니다(허용된 경로만 열 수 있음)",
        });
        return;
      }
      let st: import("node:fs").Stats;
      try {
        st = nodeFs.statSync(real);
      } catch {
        writeJson(res, 404, { error: "경로가 존재하지 않습니다" });
        return;
      }
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        writeJson(res, 403, {
          error: "실행 권한이 있는 파일은 열지 않습니다(실행 위험) — 편집기에서 직접 여세요",
        });
        return;
      }
      if (!st.isFile() && !st.isDirectory()) {
        writeJson(res, 403, { error: "일반 파일·디렉터리만 열 수 있습니다" });
        return;
      }
      const match = { path: real };
      // darwin=open · win32=explorer · 그 외=xdg-open. 폴더 열기는 fire-and-forget(즉시 200).
      // Windows explorer 는 성공해도 exit 1 을 내는 알려진 quirk → win32 는 에러를 무시한다.
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      execFile(opener, [match.path], (err) => {
        if (err !== null && process.platform !== "win32") {
          console.warn(
            `http-bridge: open-path 실패(${opener} ${match.path}) — ${err.message}`,
          );
        }
      });
      writeJson(res, 200, { ok: true, path: match.path });
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

        // ★수명주기 관측 (2026-07-26) — 종전엔 `endpoint.call` 을 **완료 후에만** 발행해서
        //  호출이 도는 20초~5분 동안 대시보드에 아무것도 안 보였다("멈춘 것처럼 보인다").
        //  요청 접수 시점에 먼저 알리고(진행 중), 끝나면 같은 callId 로 갱신한다.
        //  callId = threadKey nonce 재사용(이미 호출마다 고유 — 새 식별자 만들 필요 0).
        const epStartedAt = Date.now();
        // ★진행 중 등록 (2026-08-01 실사고) — 엔드포인트는 직렬화 핸들러를 우회하므로
        //  거기 매달린 in-flight 등록도 건너뛰었다. 그래서 `/health` 가 0 이라 답했고
        //  배포 재시작이 4,610자를 만들던 응답을 죽였다. 직렬화는 그대로 우회하고
        //  **등록만** 한다 — 재시작 판단과 중단 통지가 이 호출을 볼 수 있게.
        const epAc = new AbortController();
        registerExternalTurn(epMsg.threadKey, {
          ac: epAc,
          channel: this.name,
          target: null, // HTTP 응답으로 돌아가므로 채널 발송 대상 없음(통지는 로그·기록으로).
        });
        this.bus?.publish({
          type: "endpoint.call",
          ts: epStartedAt,
          payload: {
            callId: epNonce,
            phase: "start",
            name: ep.name,
            request: endpointPreview(prompt),
          },
        });
        /** 완료(성공·실패 공통) 관측 — 같은 callId 로 진행 중 항목을 대체한다. */
        const publishEndpointDone = (ok: boolean, response: string): void => {
          unregisterExternalTurn(epMsg.threadKey); // 성공·실패 공통 해제(누수 0).
          this.bus?.publish({
            type: "endpoint.call",
            ts: Date.now(),
            payload: {
              callId: epNonce,
              phase: "done",
              name: ep.name,
              ok,
              request: endpointPreview(prompt),
              response: endpointPreview(response),
              durationMs: Date.now() - epStartedAt,
            },
          });
        };

        // ── 스트리밍 opt-in (2026-07-26) — body `"stream":true` 또는 `?stream=1`.
        //   미지정 = 종전 동기 JSON(회귀 0). 스트리밍이면 진행 델타를 흘려 (a)중간 계층
        //   idle timeout 회피 (b)앱이 진행 상황 표시 가능("멈춘 것처럼" 방지).
        //   프로토콜은 tiguclaw 고유(엔드포인트는 규약 자유):
        //     data: {"type":"delta","text":"…"}   진행 조각(0회 이상)
        //     data: {"type":"result","result":"…"} 최종 결과(정확히 1회, 성공 시)
        //     data: {"type":"error","error":"…"}   실패(정확히 1회)
        //     data: [DONE]                          종료 표식(성공·실패 공통)
        //   ★앱은 **result/error 이벤트를 받았는지**로 성패를 판정해야 한다(연결만 끝난 것과 구분).
        const wantStream =
          url.searchParams.get("stream") === "1" ||
          /"stream"\s*:\s*true/.test(rawBody);

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutP = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error("timeout"));
          }, ENDPOINT_TIMEOUT_MS);
        });
        const runTurn = (): Promise<{ text: string }> =>
          route(epMsg, {
            // restricted(기본) → 도구 0. full(소유자 명시) → undefined = 전체 도구.
            toolPolicy: ep.mode === "restricted" ? { mode: "none" } : undefined,
            // ★restricted = **순수 백엔드** (2026-08-02) — 도구뿐 아니라 비서 인격·정책도 뺀다.
            //  종전엔 도구는 0인데 SYSTEM.md 25KB 가 그대로 실렸다. 도구가 없으니 그 대부분
            //  (도구 사용법·승인 게이트·채널 발신·스킬 라우팅)은 **적용 대상이 아예 없고**,
            //  남는 건 말투·보고 지시뿐인데 그게 역할과 충돌했다 — 정의 파일이 "순수 JSON 하나만
            //  반환하세요 / 설명 문장 금지" 같은 **방어 문장**을 쓰고 있었다(역할이 두 번 주어짐).
            //  LLM 게이트웨이가 이미 같은 이유로 systemPromptOverride 를 쓴다(동형).
            //  full 은 도구를 쥐므로 헌법(파괴적 작업 승인·권한)을 **유지**한다 — 도구를 주면서
            //  안전 규칙만 빼는 조합은 만들지 않는다.
            ...(ep.mode === "restricted" ? { systemPromptOverride: prompt } : {}),
            // 엔드포인트 정의의 실행 프로파일(2026-08-01) — 미지정("")이면 미전달 = 기본 풀.
            //  toolPolicy 운반과 동형: 여기선 정의값을 옮기기만 하고 해석은 코어가 한다.
            ...(ep.model !== "" ? { modelProfile: ep.model } : {}),
          });

        if (wantStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const send = (obj: unknown): void => {
            try {
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch {
              /* 끊긴 소켓 — 아래 finally 가 정리 */
            }
          };
          // 이 턴의 llm.delta 만 중계(threadKey 필터) — 게이트웨이 스트리밍과 동형 패턴.
          const unsub =
            this.bus !== null
              ? this.bus.subscribe((ev) => {
                  if (ev.type !== "llm.delta") return;
                  const p = ev.payload as { threadKey?: string; delta?: string };
                  if (p.threadKey !== epMsg.threadKey) return;
                  if (typeof p.delta === "string" && p.delta !== "") {
                    send({ type: "delta", text: p.delta });
                  }
                })
              : null;
          try {
            const out = await Promise.race([runTurn(), timeoutP]);
            const result = out.text !== "" ? out.text : replyText;
            send({ type: "result", result });
            publishEndpointDone(true, result);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            send({ type: "error", error: reason });
            publishEndpointDone(false, reason);
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            if (unsub !== null) safeUnsubscribe(unsub);
            try {
              res.write("data: [DONE]\n\n");
            } catch {
              /* 끊긴 소켓 */
            }
            res.end();
          }
          return;
        }

        try {
          const out = await Promise.race([runTurn(), timeoutP]);
          // route 는 RouteOutput.text 를 반환 — reply 클로저(replyText)와 동일 본문이나,
          // route 의 반환 text 를 1차 진실로 사용(reply 미호출 어댑터 경로 대비 replyText 폴백).
          const result = out.text !== "" ? out.text : replyText;
          writeJson(res, 200, { result });
          // 대시보드 엔드포인트 뷰용 — 요청+응답을 담은 관측 이벤트(채팅 밖 기계 API 호출).
          // 라이브 SSE 로 전문 전달(event-persist 는 SKIP → 절단/영속 비대 회피).
          publishEndpointDone(true, result);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          publishEndpointDone(false, reason);
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
