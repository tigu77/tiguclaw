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
import { writeJson } from "../../src/core/net/write-json.js";
import { callPluginDataRoute, isPluginMedia } from "../../src/core/plugins/data-routes.js";
import { readHomeWidgets } from "../../src/core/home-widgets.js";
import { listLivePlugins } from "../../src/core/plugins/manager.js";
import { stampFor, RUNNING_WORK } from "../../src/core/resource-revision.js";
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
import type { DisplayText } from "../../src/core/plugins/providers.js";
import {
  isAllowedHost,
  parseAllowedHosts,
  rebindRejectionMessage,
} from "../../src/core/net/host-guard.js";
import { listOutboundChannels } from "../../src/core/channel-outbound.js";
import {
  registerExternalTurn,
  unregisterExternalTurn,
} from "../../src/core/inflight-turns.js";
import { getPaths, appRoot } from "../../src/core/paths.js";
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
import { isCoreModule } from "../../src/core/plugins/inventory.js";
import {
  loadModelProfiles,
  loadGatewayConfig,
  getDefaultProfileName,
  setDefaultProfile,
  setSuggestionEnabled,
  setLocale,
  setTheme,
  setEgressChannels,
  readEgressChannels,
  setModuleDisabled,
  setProfileColor,
} from "../../src/core/settings.js";
import { readSuggestionSettings } from "../../src/core/next-message-suggestion.js";
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
import { setSessionArchived } from "../../src/store/channel-session.js";
import {
  resolveModelProfiles,
  BUILTIN_DEFAULT_TIER,
} from "../../src/core/llm-runtime/builtin-profiles.js";
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
// 프로젝트 상세의 훅 목록 — 인벤토리와 **같은 판정 함수**를 쓴다(scope 로만 가른다).
import { listHooksForInventory } from "../../src/core/entry/hook-runner.js";
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
  getJobActivity,
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
import { readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";

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
import { endpointPreview } from "./endpoint-preview.js";



// ── 첨부 intake (#2, 2026-07-08) — 대시보드 채팅이 붙여넣은 파일을 홈에 저장 → Attachment[]. ──
// 텔레그램 첨부 경로와 동형(진실 소스 = Attachment 계약, <home>/data/attachments/<channel>/
// <yyyymmdd>/<id>.<ext>). base64 인바운드는 로컬(127.0.0.1)+토큰 게이트 한정 = 외부 노출 아님.
// 크기/개수 캡은 boundary 검증(메모리·디스크 보호). 캡 위반·저장 실패는 400 으로 닫고 데몬 생존.
import { ATTACH_MAX_FILE_BYTES, AttachmentError, AUDIO_EXT_BY_MIME, CONTENT_TYPE_BY_EXT, sanitizeFilename, ingestAttachments, persistOutboundAttachment } from "./attachments.js";
import { readJsonBody, readRawBody } from "./http-body.js";
import {
  handleSetDefaultProfile, handleSetProfileColor, handleSetSuggestion, handleSetLocale,
  handleSetTheme, handleSetEgress, handleGetEgress, handleGetSuggestion,
  handleSetSessionProfile, handleSetModuleEnabled, handleGetModelProfiles,
  handleGetProviders,
} from "./routes-settings.js";
import { handleSessions, handleSessionName, handleSessionArchive } from "./routes-sessions.js";
import { handleHealth, handleLogStatus, handleLogClear, handleUpdateAvailability, handleUpdateChangelog, handleSelfUpdate, handleRestart, handleChangelog } from "./routes-ops.js";
import { handleEvents, handleEndpointCalls, handleAllActivity } from "./routes-activity.js";
import { handleProjects, handleProjectCapability, handleProjectDetail, handleProjectForget, handleProjectRename } from "./routes-projects.js";
import { handleWorkerJobs, handleShells, handleShellOutput, handleCancelQueued, handleCancelWorker, handleKillShell } from "./routes-work.js";
import { handleMessages, handleChatHistory, handleChatSearch } from "./routes-chat.js";
import { handleAttachmentServe, handleTranscribe, handleOpenPath } from "./routes-files.js";
import { handleInventory, handleInventoryItem, handleContextMenuItems, handleCommands, handleMcpTools, handleHomeWidgets, handlePluginData, handlePlugins, handlePluginsAction } from "./routes-inventory.js";
import type { RouteCtx } from "./route-ctx.js";
import {
  serveGatewayChat,
  serveGatewayModels,
} from "./routes-gateway.js";

import { resolveGatewayRuntime, resolveGatewaySpecs, buildModelsListResponse, extractGatewayImageAttachments, GatewayChatMessage, flattenChatMessages, parseGatewayTools } from "./gateway.js";
import { historyActivities } from "./history-activities.js";
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
  /** DNS 리바인딩 방어 — 루프백 외에 받아줄 Host 이름(부팅 1회 파싱). */
  private readonly allowedHosts: ReadonlySet<string>;

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
    this.allowedHosts = parseAllowedHosts(process.env.HTTP_BRIDGE_ALLOWED_HOSTS);
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
      // ★여기에 `SettingsFileCorruptError` 전용 `.catch` 를 뒀다가 **걷어냈다**
      //  (2026-08-29, 적대 검토 G-2). 그 예외를 던지는 setter 16곳이 **전부 각자
      //  `try/catch` 안**이라 이 그물엔 도달 경로가 0이었다(전수 확인). 그런데 도달하는
      //  날엔 헤더가 이미 나간 뒤일 수 있어 `writeJson` 이 `ERR_HTTP_HEADERS_SENT` 로
      //  다시 던지고, 그게 곧 `unhandledRejection` 이다 — 이 레포가
      //  `write-json-serializes-first` 로 지키는 바로 그 사고를 새 자리에 다시 만드는 셈.
      //  원칙 게이트 Q6: **발생 불가능한 시나리오의 fallback 은 가짜 견고함**이다.
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

  /** 라우트 군집이 쓰는 문맥 — 재서 정했다(지역 셋 + 채널 이름). */
  private routeCtx(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): RouteCtx {
    return {
      req,
      res,
      url,
      pathname: url.pathname,
      channelName: this.name,
      bus: this.bus,
      sseClients: this.sseClients,
      channelHandler: this.channelHandler,
    };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // ★DNS 리바인딩 방어 (2026-08-24) — **인증보다 먼저**, `/health` 보다도 먼저.
    //  브리지는 토큰 인증이 있어 대시보드보다 노출이 작지만, `/health` 는 무인증이고
    //  거기서 진행 중 턴·구독자 수가 나간다. 판정은 대시보드와 **같은 함수**를 쓴다 —
    //  두 서버가 각자 판정하면 한쪽이 늙는다.
    if (!isAllowedHost(req.headers.host, this.allowedHosts)) {
      console.warn(
        `[http-bridge] Host 차단: '${String(req.headers.host ?? "")}' ${method} ${pathname} — DNS 리바인딩 방어`,
      );
      writeJson(res, 403, {
        error: rebindRejectionMessage(req.headers.host, "HTTP_BRIDGE_ALLOWED_HOSTS"),
      });
      return;
    }

    // /health — 인증 무.
    if (pathname === "/health" && method === "GET") {
      await handleHealth(this.routeCtx(req, res, url));
      return;
    }

    // LLM 게이트웨이 모델 목록 — OpenAI 호환 `GET /v1/models`(ADR 2026-07-25). chat 과 동일
    // 인증(gateway 토큰), 비활성=404. read-only 라 동시성 캡 밖(gatewayInflight 무증감).
    if (pathname === "/v1/models" && method === "GET") {
      await serveGatewayModels(this.routeCtx(req, res, url));
      return;
    }

    // LLM 게이트웨이 — OpenAI 호환. **브리지 role 토큰과 별개**의 전용 게이트웨이 토큰.
    // 비활성 = 404. 앱 서버가 토큰 쥐고 호출(브라우저 직접 금지). 127.0.0.1 바인드.
    if (pathname === "/v1/chat/completions" && method === "POST") {
      await serveGatewayChat(this.routeCtx(req, res, url));
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
          : pathname === "/changelog" && method === "GET"
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
              : pathname === "/chat-search" && method === "GET"
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
                : pathname === "/update-availability" && method === "GET"
                  ? "read" // 조회만 — 상태를 읽을 뿐 아무것도 바꾸지 않는다.
                : pathname === "/update-changelog" && method === "GET"
                  ? "read" // 원격 CHANGELOG 읽기 — `/changelog` 와 같은 등급.
                : pathname === "/plugins" && method === "GET"
                  ? "read" // 목록 조회.
                : pathname === "/plugins/action" && method === "POST"
                  ? "admin" // ★설치·제거·켜기·끄기 — 데몬의 능력을 바꾼다(/restart 와 동급).
                : pathname === "/log-status" && method === "GET"
                  ? "read"
                : pathname === "/log-clear" && method === "POST"
                  ? "admin" // 진단면을 지운다 — 되돌릴 수 없으므로 read/write 가 아니다.
                : pathname === "/self-update" && method === "POST"
                  ? "admin" // 데몬을 재시작한다 → /restart 와 동급(위 표 참조).
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
              : pathname === "/set-egress" && method === "POST"
                ? "write" // 설정 파일을 쓴다(위 set-session-profile 누락 전례 참조).
              : pathname === "/set-suggestion" && method === "POST"
                ? "write" // 설정 파일을 쓰므로 write. (위 set-session-profile 누락 전례 참조)
              : pathname === "/set-locale" && method === "POST"
                ? "write" // 설정 파일을 쓴다 — set-suggestion 과 같은 등급.
              : pathname === "/set-theme" && method === "POST"
                ? "write" // 설정 파일을 쓴다 — set-locale 과 같은 등급(테마 프리셋).
              : pathname === "/set-profile-color" && method === "POST"
                ? "write" // 설정 파일을 쓴다 — set-default-profile 과 같은 등급.
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
                : pathname === "/home-widgets" && method === "GET"
                  ? "read" // 배치 조회 — 쓰기는 도구(configure_home)로만 간다.
                : pathname.startsWith("/plugin-data/") && method === "GET"
                  ? // ★**프리픽스 한 줄**이다 — 플러그인마다 여기 한 줄씩 늘면 그게 곧
                    //  손으로 관리하는 목록이고, 이 사다리는 이미 한 번 빠뜨려서 read 토큰이
                    //  세션 프로파일을 바꿀 수 있었다([[feedback_hand_maintained_lists]]).
                    //  읽기만 한다 — 라우트는 값을 만들 뿐 아무것도 안 바꾼다.
                    "read"
                  : null;
    if (required !== null && !meetsRole(resolved.role, required)) {
      writeJson(res, 403, {
        error: "forbidden",
        required,
        presented: resolved.role,
      });
      return;
    }

    // 홈 위젯 배치 (2026-08-28, §J) — 화면이 "무엇을 어떤 순서로 그릴지" 를 받는 자리.
    // ★**읽기만 있다.** 쓰기는 `configure_home` 도구로만 간다 — 배치는 비서가 하는 것이고
    //  (A3), 화면에 쓰기 구멍을 내면 그게 곧 손 배치 UI 의 절반이 된다(아직 안 짓는다).
    if (pathname === "/home-widgets" && method === "GET") {
      await handleHomeWidgets(this.routeCtx(req, res, url));
      return;
    }

    // ─── 플러그인 데이터 라우트 (2026-08-28, 위젯 플랫폼 §E.2) ───────────────
    //  `/plugin-data/<plugin>/<route>?…` — 홈 위젯이 모델을 안 거치고 값을 받는 길.
    //  ★외부 호출·캐시·`needs.network` 집행은 전부 코어(`data-routes.ts`)가 한다.
    //   여기는 **주소를 값으로 바꾸는 자리**일 뿐이다(가장자리는 판단하지 않는다).
    if (pathname.startsWith("/plugin-data/") && method === "GET") {
      await handlePluginData(this.routeCtx(req, res, url));
      return;
    }

    // /events — SSE.
    if (pathname === "/events" && method === "GET") {
      await handleEvents(this.routeCtx(req, res, url));
      return;
    }

    // /inventory — JSON. collectInventory(5 카테고리) + 스케줄(능력 축 확장, 2026-07-18). 스케줄은
    // scheduler 플러그인 store(listSchedules)에서 읽어 인벤토리 아이템 shape(PluginEntry 호환:
    // name·description·enabled·source·metadata)로 매핑 — 대시보드 인벤토리 뷰가 '⏰ 스케줄'
    // 카테고리로 렌더(읽기 전용). next_run 계산은 scheduler mcp list_schedules 로직 재사용(croner
    // dry-run). 격리: 스케줄 수집 실패해도 나머지 인벤토리는 그대로 응답(빈 배열 폴백).
    if (pathname === "/inventory" && method === "GET") {
      await handleInventory(this.routeCtx(req, res, url));
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
    // 변경 이력 — 앱과 함께 배포되는 `CHANGELOG.md` 원문을 그대로 준다 (2026-08-24 사용자
    // 요청: "릴리즈 노트를 대시보드에서 확인"). 설정 뷰가 마크다운으로 렌더한다.
    // ★섹션 파싱을 **안 한다** — 전문을 보여주는 게 요청이라 자를 이유가 없고, 자르면
    //  그 판정이 회귀(`release-notes-extractable`)와 두 벌이 된다. 안 만드는 게 제일 싸다.
    // ★`appRoot()` 기준 — 홈이 아니라 **앱 아티팩트**다(헌법 SYSTEM.md 와 같은 분류).
    if (pathname === "/changelog" && method === "GET") {
      await handleChangelog(this.routeCtx(req, res, url));
      return;
    }

    if (pathname === "/inventory-item" && method === "GET") {
      await handleInventoryItem(this.routeCtx(req, res, url));
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
    // 긴 매니저의 worker.started SSE 가 replay 창(50) 밖으로 밀리면 새로고침 시 activity-only 카드
    // 라 라벨이 "(작업)"으로 뜨던 문제 → in-memory listJobs 로 label·kind·task 복원. read 게이트.
    if (pathname === "/worker-jobs" && method === "GET") {
      await handleWorkerJobs(this.routeCtx(req, res, url));
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
      await handleMcpTools(this.routeCtx(req, res, url));
      return;
    }

    if (pathname === "/shells" && method === "GET") {
      await handleShells(this.routeCtx(req, res, url));
      return;
    }

    // /shell-output — 특정 셸의 ★비소비 tail 스냅샷(마지막 16KB stdout/stderr). 대시보드
    // 표면 D(라이브 tail) 폴링용. ★불변식(ADR §1·검증 line 141): 코어 tailShell() 은 모델
    // BashOutput 의 증분 폴링 offset(stdoutRead/stderrRead)을 절대 소비하지 않는다 —
    // 이 엔드포인트를 아무리 폴링해도 모델이 받을 출력이 줄지 않는다. 없는 id 는 404.
    if (pathname === "/shell-output" && method === "GET") {
      await handleShellOutput(this.routeCtx(req, res, url));
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
      await handleContextMenuItems(this.routeCtx(req, res, url));
      return;
    }

    // /commands — JSON. 슬래시 명령 목록(빌트인 + 커스텀) 대시보드 노출. getAllCommands
    // 가 내부에서 discoverCommands 실패를 흡수(빌트인 폴백)하므로 여기선 경계 표준 에러만.
    if (pathname === "/commands" && method === "GET") {
      await handleCommands(this.routeCtx(req, res, url));
      return;
    }

    // /providers — JSON. Dashboard/Dolsoe 공통 provider interface.
    if (pathname === "/providers" && method === "GET") {
      await handleGetProviders(this.routeCtx(req, res, url));
      return;
    }

    // /model-profiles — JSON. settings.json `models.profiles` 를 대시보드가 표시(순수 read,
    // /models 슬래시와 동일 데이터원 loadModelProfiles). /inventory·/providers 와 동형(read 게이트).
    // 순서는 기본 프로파일을 맨 앞으로(models-command 렌더와 동일 결정성), 각 프로파일에 isDefault 표식.
    // 기본 = settings.json `models.default` 포인터(미설정 시 "default") — 하드코딩 아님.
    // 프로파일 부재 시 profiles:[] graceful(400/500 아님). 편집 아님 — 표시만(설정은 대화·POST /set-default-profile).
    if (pathname === "/model-profiles" && method === "GET") {
      await handleGetModelProfiles(this.routeCtx(req, res, url));
      return;
    }

    // /set-default-profile — 기본 프로파일 포인터(models.default) 설정. write 게이트(위 role 표).
    // body { name } — name 은 실존 프로파일이어야(loadModelProfiles 검증) → 없으면 400(댕글링 차단).
    // OK 면 settings.json read-modify-write(다른 키 보존) → 재시작 없이 fresh read 로 다음 턴 반영.
    if (pathname === "/set-default-profile" && method === "POST") {
      await handleSetDefaultProfile(this.routeCtx(req, res, url));
      return;
    }

    // /set-suggestion — 다음 메시지 제안 on/off. write 게이트(위 role 표).
    // body { enabled: boolean }. settings.json 의 suggestions.nextMessage.enabled **한 키만**
    // read-modify-write(다른 키 보존) → 재시작 없이 fresh read 로 다음 턴 반영.
    // /set-default-profile 과 동일 패턴 — 설정 쓰기 경로를 새로 만들지 않고 형제로 둔다.
    // /set-profile-color — 프로파일 배지 색. write 게이트(위 role 표).
    // body { name, color }. `color: null` = 지우기(기본색 복귀). 형식 판정은 코어 경계
    // (`isBadgeColor`) 한 곳 — 여기서 정규식을 또 쓰면 두 곳이 갈린다.
    if (pathname === "/set-profile-color" && method === "POST") {
      await handleSetProfileColor(this.routeCtx(req, res, url));
      return;
    }
    if (pathname === "/set-suggestion" && method === "POST") {
      await handleSetSuggestion(this.routeCtx(req, res, url));
      return;
    }

    // /set-locale — 화면 언어. write 게이트(위 role 표). body { locale: string }.
    // ★설치 안 된 언어는 **거절**한다(판정은 코어 `setLocale` 한 곳 — 여기서 목록을 다시
    //  들면 두 곳이 갈린다). 카탈로그는 서빙 때 주입되므로 반영은 새로고침에 일어난다.
    if (pathname === "/set-locale" && method === "POST") {
      await handleSetLocale(this.routeCtx(req, res, url));
      return;
    }

    // /set-theme — 테마 프리셋. write 게이트(위 role 표). body { theme?: string|null }
    // ★판정은 코어(`setAppearance`·`setTheme`) 한 곳이다 — 여기서 목록을 다시 들면 두 곳이
    //  갈린다(`/set-locale` 과 같은 규약). `theme: null` 은 해제다.
    if (pathname === "/set-theme" && method === "POST") {
      await handleSetTheme(this.routeCtx(req, res, url));
      return;
    }

    // /set-egress — "이 답도 함께 보낼" 추가 채널(전역). write 게이트(위 role 표).
    // body { channels: string[] }. settings.json 의 egress.channels 한 키만
    // read-modify-write. ★서버에 두는 이유: 브라우저에만 있으면 서버가 스스로 만드는
    // 발화(매니저 완료·스케줄·파일감시)가 사용자가 켠 걸 몰라 fan-out 을 못 탄다.
    if (pathname === "/set-egress" && method === "POST") {
      await handleSetEgress(this.routeCtx(req, res, url));
      return;
    }

    // /egress — 현재 값 + 지금 가능한 채널. 대시보드 셀렉터가 이걸로 그린다.
    if (pathname === "/egress" && method === "GET") {
      await handleGetEgress(this.routeCtx(req, res, url));
      return;
    }

    // /suggestion — 현재 값 조회(설정 화면 초기 렌더용).
    // ★종전 주석은 "read 게이트 기본" 이라고 적혀 있었는데 **기본값 같은 건 없다** — 위
    //  role 표에서 빠지면 `required=null` 이라 게이트를 **아예 안 탄다**(2026-08-30 구조
    //  검토). 그래도 결과가 같은 이유는 하나뿐이다: `read` 가 ROLE_RANK 최하위라
    //  「등급 없음 ≡ read」인 것. 우연이 아니라 성질이므로 회귀
    //  `bridge-role-table-complete` 가 그 전제를 지킨다 — `read` 아래 등급이 생기면 운다.
    if (pathname === "/suggestion" && method === "GET") {
      await handleGetSuggestion(this.routeCtx(req, res, url));
      return;
    }

    // /set-session-profile — 이 세션(대시보드 탭)만 sticky 한 모델 프로파일 선택
    // (ADR _workspace/model-dropdown_architect_contract.md §3-b). write 게이트
    // (/set-default-profile 패턴 복제). ★전역 models.default 는 절대 안 건드림 — 세션 스코프.
    // body { threadKey, profile } — profile 은 실존 프로파일 이름(loadModelProfiles 검증) 또는
    // "default"/"" (= 상속으로 되돌림 → clearSessionModelProfile). 미지 이름 → 400(constraint 2).
    // 저장 키 = (SESSION_STORAGE_CHANNEL, resolveSessionId(...)) — /messages·router 와 동일 정규화.
    if (pathname === "/set-session-profile" && method === "POST") {
      await handleSetSessionProfile(this.routeCtx(req, res, url));
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
      await handleSetModuleEnabled(this.routeCtx(req, res, url));
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
      await handleTranscribe(this.routeCtx(req, res, url));
      return;
    }

    // /chat-history — JSON. 대시보드 대화 이력 복원(기능 B). chat_log 의 최근 N 건을
    // 시간 오름차순으로 반환 → 대시보드가 SSE 연결 *전에* fetch 해 과거 채팅 버블 렌더.
    // read 게이트(위 role 표). ts 는 event.ts(쓰기 훅) 이므로 클라이언트가 SSE history
    // replay 와 ts 로 dedup 한다. ?limit= 허용(기본 200).
    // /chat-search — **전 세션 가로질러** 채팅 검색(2026-08-22). 조회만(read 게이트).
    //  ★여기는 **배관만** 한다: 질의 정규화·스니펫은 `core/chat-search.ts` 순수 함수가,
    //   DB 는 `store/chat-log.ts` 가, 세션 표시명은 `sessionDisplayName` 이 판단한다.
    //   핸들러에 판단을 두면 검사하려고 데몬을 띄워야 한다(원칙 게이트 Q7).
    if (pathname === "/chat-search" && method === "GET") {
      await handleChatSearch(this.routeCtx(req, res, url));
      return;
    }

    if (pathname === "/chat-history" && method === "GET") {
      await handleChatHistory(this.routeCtx(req, res, url));
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
      await handleEndpointCalls(this.routeCtx(req, res, url));
      return;
    }

    if (pathname === "/all-activity" && method === "GET") {
      await handleAllActivity(this.routeCtx(req, res, url));
      return;
    }

    // /sessions — JSON. 대시보드 멀티세션 탭(ADR 2026-07-15 §D6). ★채널/세션 분리로 세션이
    // 채널 무관이 됐으므로 `prefix:'dashboard:'` 필터를 폐지하고 `excludeInternal:true` 로
    // **사용자 대면 대화 세션 전체**(현행 dashboard:* + 레거시 tg:*/cli:* 과거 대화)를 반환한다
    // — 내부 파생 스레드(worker:/agent:/endpoint:/gateway:/scheduler:/`::sub::`)만 배제.
    // 텔레그램 기본 세션 = 대시보드 첫 탭 = 동일 id(DEFAULT_SESSION_ID)라 중복 0. 세션별
    // 프리뷰(chat_log 최근 1건 요약) 부착. read 게이트. SSE 는 전체 브로드캐스트 유지(D5).
    if (pathname === "/sessions" && method === "GET") {
      await handleSessions(this.routeCtx(req, res, url));
      return;
    }

    // /attachments/<rel> — 저장된 인바운드 첨부 파일 서빙(대시보드 이력 이미지/파일 렌더).
    // read 게이트(위). rel = attachmentsDir 기준 상대경로. ★path traversal 방어: 해석된 절대
    // 경로가 반드시 attachmentsDir 하위여야(../ 이스케이프·절대경로 거부). 로컬 바인딩 + 토큰
    // 게이트 뒤라 표면 작음. base64 를 DB 에 안 담고 이 파일을 재사용 = 이력 이미지 영속.
    if (pathname.startsWith("/attachments/") && method === "GET") {
      await handleAttachmentServe(this.routeCtx(req, res, url));
      return;
    }

    // /projects — JSON. 등록된 프로젝트 목록(레지스트리 조회 캐시). 대시보드 그리드 카드용.
    // 진실은 각 폴더의 PROJECT.md — 여긴 인덱스일 뿐(상세 열 때 파일 재-Read). read 게이트.
    if (pathname === "/projects" && method === "GET") {
      await handleProjects(this.routeCtx(req, res, url));
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
      await handleProjectCapability(this.routeCtx(req, res, url));
      return;
    }

    // /projects/detail?path=<abs> — JSON. 매 호출 <path>/PROJECT.md 재-Read(최신 진실) +
    // discover*(path) project-source 스킬/에이전트 + related 해소. PROJECT.md/폴더 부재 시 404.
    // recentJobs 는 P1 빈 배열([]) — G2 후속(cwd 귀속 payload 확장에 편승).
    if (pathname === "/projects/detail" && method === "GET") {
      await handleProjectDetail(this.routeCtx(req, res, url));
      return;
    }

    // /messages — POST 양방향.
    if (pathname === "/messages" && method === "POST") {
      await handleMessages(this.routeCtx(req, res, url));
      return;
    }

    // /restart — 빌트인 제어 엔드포인트(A: 대시보드 버튼). admin 토큰 게이트(위 role 표) +
    // 127.0.0.1 바인드(기본). 메시지 큐(enqueueThreadTurn) 를 타지 않고 control.restart 이벤트를
    // EventBus 에 publish → index.ts 가 구독해 shutdown("RESTART"). 멈춘 턴에도 동작. 빌트인
    // 경로라 register_endpoint 로는 등록·shadow 불가(코드 순서 = 우선순위, 커스텀 폴백 위에서 선점).
    // /log-status · /log-clear — 오늘 로그 파일 조회/비우기. 판정·수행은 코어
    // `log-file-admin` 한 곳(브리지는 배관만). ★비우기는 truncate 다 — 지우거나 옮기면
    // 데몬 fd 가 옛 파일을 따라가 로그가 조용히 사라진다(그 사고 때문에 만든 기능이다).
    if (pathname === "/log-status" && method === "GET") {
      await handleLogStatus(this.routeCtx(req, res, url));
      return;
    }
    if (pathname === "/log-clear" && method === "POST") {
      await handleLogClear(this.routeCtx(req, res, url));
      return;
    }

    // /update-availability — "받을 업데이트가 있나". 조회만(read 게이트).
    // §0 단방향: 판정은 코어 `checkUpdateAvailability` 한 곳 — 브리지는 배관만 하고
    // **아무것도 판단하지 않는다**(가장자리는 판단하지 않는다, principle-check Q7).
    // 실패는 전부 코어가 `unknown` 으로 수렴시키므로 여기서 try/catch 를 덧대지 않는다
    // (가짜 견고함 금지 — 내부 호출에 방어를 겹치지 않는다).
    if (pathname === "/update-availability" && method === "GET") {
      await handleUpdateAvailability(this.routeCtx(req, res, url));
      return;
    }

    // ─── 플러그인 관리 (2026-08-28) — 목록·설치·제거·켜기·끄기 ────────────────────
    // ★판정은 전부 코어(`core/plugins/manager.ts`) — 브리지는 배관만 한다.
    if (pathname === "/plugins" && method === "GET") {
      await handlePlugins(this.routeCtx(req, res, url));
      return;
    }
    if (pathname === "/plugins/action" && method === "POST") {
      await handlePluginsAction(this.routeCtx(req, res, url));
      return;
    }

    // /update-changelog — "받으면 뭐가 바뀌나" 전문. `/changelog`(지금 깔린 것)의 짝이고
    // 응답 모양도 **같다**(`{ markdown }`) — 그래서 설정 화면이 행 컴포넌트 하나로 둘을
    // 그린다. 조회만(read 게이트). 판정·자르기는 전부 코어에 있다.
    if (pathname === "/update-changelog" && method === "GET") {
      await handleUpdateChangelog(this.routeCtx(req, res, url));
      return;
    }

    // /self-update — 대시보드에서 자가 업데이트 실행. admin 게이트(데몬을 재시작하므로
    // /restart 와 동급). §0 단방향: 코어 `runSelfUpdate` 를 그대로 부른다 — git/npm/
    // typecheck 게이트/롤백/재시작 판단은 전부 거기 닫혀 있고 여기서 재구현하지 않는다
    // (채널이 넷째 진입점이 될 뿐 다섯째 판단이 되지 않는다).
    // 동시 실행 가드는 코어에 이미 있다(`updating` 락 → status:"busy") — 화면은 그 상태를
    // 그대로 받아 표시한다.
    if (pathname === "/self-update" && method === "POST") {
      await handleSelfUpdate(this.routeCtx(req, res, url));
      return;
    }

    if (pathname === "/restart" && method === "POST") {
      await handleRestart(this.routeCtx(req, res, url));
      return;
    }

    // /cancel-queued — 대기 중(미시작) 큐 메시지 취소(ADR 2026-07-15). admin 토큰 게이트(위
    // role 표) + 127.0.0.1 바인드. 메시지 큐(enqueueThreadTurn)를 *타지 않는* 제어 경로
    // (/restart·/stop 동형 out-of-band) — 큐 뒤에 붙으면 자기 앞 항목이 끝나야 실행돼 무의미.
    // §0 단방향: 코어 export `cancelQueuedTurn` 을 호출(코어는 http-bridge 를 모른다). 특정
    // 대기 항목을 correlationId 로 지목 취소하고 결과("cancelled"/"already-started"/"not-found")
    // 를 그대로 반환. 텔레그램 후속(/cancel 슬래시 등)도 동일 코어 primitive 재사용 가능(범위 밖).
    if (pathname === "/cancel-queued" && method === "POST") {
      await handleCancelQueued(this.routeCtx(req, res, url));
      return;
    }

    // /cancel-worker — 진행 중(running) 백그라운드 매니저 수동 취소(2026-07-16). write 게이트
    // (위 role 표) — /messages·/stop 동형 "사용자 자기 잡 제어"(admin 아님, /cancel-queued 는
    // out-of-band 큐 조작이라 admin 이었으나 이건 이미 시작된 *자기* 매니저를 멈추는 것뿐).
    // §0 단방향: 코어 export `cancelJob`(src/core/worker-jobs.ts) 를 그대로 호출 — 코어는
    // http-bridge 를 모른다. running 인 worker·agent 모두 실제 취소(U-I4 개정 2026-07-17 —
    // 코어 cancelJob 이 kind∈{worker,agent} 게이트: worker=매니저 abort, agent=서브에이전트
    // cancel-only abort 또는 claude native Task 는 부모 턴 coarse abort). done 은 false. abort 는
    // LLM 스트림은 끊지만 hung 도구 호출은 다음 도구 경계까지 못 끊을 수 있다(코어 주석 참조)
    // — 여기선 신호 발사 여부만 정직 반환.
    if (pathname === "/cancel-worker" && method === "POST") {
      await handleCancelWorker(this.routeCtx(req, res, url));
      return;
    }

    // /kill-shell — 백그라운드 셸 강제 종료(ADR 2026-07-17 Phase 2 §C). write 게이트
    // (/cancel-worker 동형 — "자기 셸 제어", admin 아님). §0 단방향: 코어 export
    // `killShellById`(file-ops-mcp.ts) 를 그대로 호출 — killTree(그룹 전체)+status=killed+
    // shell.exited 발행까지 그 안에서 처리(모델 대면 KillShell 도구와 동일 헬퍼 재사용).
    // claude 셸(SDK 소유)은 이 레인 밖 — codex/openai BG_SHELLS 에 없는 id 는 killed:false.
    if (pathname === "/kill-shell" && method === "POST") {
      await handleKillShell(this.routeCtx(req, res, url));
      return;
    }

    // /session-name — 세션 커스텀 이름 설정(채널무관·UPDATE-only·비파괴, 계약
    // _workspace/session-tabs_architect_contract.md §3-1). write 게이트(위 role 표).
    // body { threadKey, name } — name 은 string|null(빈문자→null=커스텀 제거→파생 폴백).
    // store setThreadName 이 정규화(trim·60캡·빈값→null)까지 수행 — 여기선 pass-through.
    if (pathname === "/session-name" && method === "POST") {
      await handleSessionName(this.routeCtx(req, res, url));
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
      await handleSessionArchive(this.routeCtx(req, res, url));
      return;
    }

    // /project-forget — 프로젝트 등록 해제(레지스트리 인덱스에서만 제거). ★비파괴: PROJECT.md
    // 파일·폴더는 절대 안 지운다(store forgetProject = DELETE FROM projects WHERE path=?). write
    // 게이트(위 role 표, /session-name 동형). body { path } — 정규화·검증 후 forgetProject 호출.
    if (pathname === "/project-forget" && method === "POST") {
      await handleProjectForget(this.routeCtx(req, res, url));
      return;
    }


    // /project-rename — PROJECT.md frontmatter name 갱신 + 레지스트리 캐시 갱신. write.
    if (pathname === "/project-rename" && method === "POST") {
      await handleProjectRename(this.routeCtx(req, res, url));
      return;
    }

    // /open-path — 프로젝트 폴더를 데몬 호스트의 OS 파일 탐색기로 연다(대시보드 프로젝트 카드
    // ⋯ 메뉴). ★보안: **등록된 프로젝트 경로만** 허용(임의 경로 열기·정찰 차단). execFile(배열
    // 인자, no shell)이라 셸 인젝션 0 — 경로는 검증된 등록값만 인자로 넘긴다.
    if (pathname === "/open-path" && method === "POST") {
      await handleOpenPath(this.routeCtx(req, res, url));
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
