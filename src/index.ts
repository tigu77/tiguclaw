import "./core/load-env.js"; // ★가장 먼저 — 다른 모듈이 env 읽기 전 <home>/.env(레포 폴백) 로드.
import "./core/net-config.js"; // ★네트워크 전 — IPv4 우선(IPv6 블랙홀 환경서 텔레그램 전멸 방지).
import os from "node:os";
import { extractTelegramChatId, DEFAULT_SESSION_ID } from "./core/threadkey.js";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage, MessageHandler } from "./channels/types.js";
import { initEventBus, type EventBus } from "./core/eventbus.js";
import {
  setChannelPresence,
  type ChannelPresence,
} from "./core/channel-registry.js";
import { registerMcpServer } from "./core/mcp-registry.js";
import { expandCommand } from "./core/entry/command-registry.js";
import {
  runStopHooks,
  runUserPromptSubmitHooks,
  setHookObserver,
} from "./core/entry/hook-runner.js";
import {
  collectInventory,
  formatInventoryForUser,
} from "./core/plugins/inventory.js";
import { loadPlugins } from "./core/plugins/loader.js";
import { stripInternalRuntimeScaffolding, redactSecrets } from "./core/outbound-sanitize.js";
import { route } from "./core/router.js";
import {
  createSteeringChannel,
  type SteeringChannel,
  type SteeringInput,
} from "./core/steering.js";
import { lookupContextWindow } from "./core/llm-runtime/context-windows.js";
import { appVersion } from "./core/version.js";
import { getCodexTokenExpiry } from "./core/llm-runtime/adapters/openai-codex-oauth.js";
import {
  addMemory,
  countMemories,
  deleteMemory,
  listMemories,
} from "./store/memory.js";
import {
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from "./store/schedules.js";
import {
  canonicalSessionChannel,
  clearSessionModelOverride,
  deleteSession,
  getMostRecentTelegramChatId,
  getSession,
  getSessionChannelMeta,
  getSessionModelOverride,
  initStore,
  setContextBoundary,
  setSessionModelOverride,
  SESSION_STORAGE_CHANNEL,
} from "./store/sessions.js";
// codex/openai 컨텍스트 리셋 — `/reset`·`/clear` 가 claude(세션) 뿐 아니라 codex/openai 의
// 히스토리 재전송도 끊게 한다. boundary watermark(setContextBoundary, sessions.ts) = 이 ts
// 이전 턴은 재전송 안 함(getContextBoundary 는 codex/openai 어댑터가 소비). clearThreadSummary
// = codex 롤링 요약 드롭. 둘 다 store-auth contract 대로 (channel, threadKey[, ts]).
import { clearThreadSummary } from "./store/thread-summaries.js";
import {
  parseModelSpec,
  parseModelSpecList,
  specLabel,
  errorDetail,
  resolveModelSpecs,
  listActiveCooldowns,
  poolDiversityWarning,
} from "./core/llm-runtime/index.js";
import { appRoot, ensureHome, getPaths, migrateLegacyAgent } from "./core/paths.js";
import {
  diagnoseModelProfiles,
  loadModelProfiles,
  getDefaultProfileName,
} from "./core/settings.js";
import { renderModelProfiles } from "./core/entry/models-command.js";
import {
  hasSupervisorRespawn,
  spawnDetachedRestart,
  cleanupSelfRestartTask,
} from "./core/restart.js";
import { initFileLogging } from "./core/logging.js";
import { startEventPersistence } from "./core/event-persist.js";
import {
  enqueueThreadTurn,
  registerWorkerHandler,
  recoverInterruptedJobs,
  listJobs,
  STEERED_TURN_RESULT,
} from "./core/worker-jobs.js";
import {
  runSelfUpdate,
  setSelfUpdateRestart,
  UPDATE_COMPLETE_MARKER,
  UPDATE_FAILED_MARKER,
  type SelfUpdateNotifyDest,
  type SelfUpdateResult,
} from "./core/self-update.js";
import { deliverOutbound } from "./core/outbound.js";
import {
  registerChannelOutbound,
  getChannelOutbound,
  type ChannelOutbound,
} from "./core/channel-outbound.js";

// `/model` set 시점 best-effort sanity (설계: model-spec-validation §3-3, 하이브리드 C).
// 차단 아님 — provider 와 model prefix 가 명백히 어긋날 때만 "혼동 가능성" 경고 1줄.
// 카탈로그가 아니라 얇은 휴리스틱 (principle-check Q5: 모델 카탈로그를 코어에 넣지 말 것).
// 새 모델명도 prefix 만 맞으면 통과 — claude-sonnet-4-7 처럼 형식상 정상·미실재 ID 는
// 일부러 통과시킨다 (그건 런타임 안전망이 권위 있게 잡음). false positive 억제 위해
// provider 가 맵에 없거나 prefix 가 하나라도 맞으면 무경고.
const MODEL_PREFIX_HINTS: Record<string, readonly string[]> = {
  anthropic: ["claude-"],
  codex: ["gpt", "o", "codex"],
  openai: ["gpt", "o"],
};

// args = 사용자가 친 `provider:model` 원문. 경고 문구(있으면) 또는 null 반환.
// 순수 함수 — 부수효과 없음. parseModelSpec 성공 후에만 호출(provider 는 유효 가정).
export const modelSpecSanityWarning = (args: string): string | null => {
  const idx = args.indexOf(":");
  if (idx === -1) return null; // parseModelSpec 통과 가정이므로 도달 안 함 — 방어.
  const provider = args.slice(0, idx).trim().toLowerCase();
  const model = args.slice(idx + 1).trim().toLowerCase();
  const hints = MODEL_PREFIX_HINTS[provider];
  // 모르는 provider 또는 빈 model → 판단 보류 (경고 안 함).
  if (hints === undefined || model === "") return null;
  // prefix 중 하나라도 맞으면 정상 — 무경고.
  if (hints.some((p) => model.startsWith(p))) return null;
  const expected = hints.map((p) => `\`${p}\``).join(" / ");
  return (
    `⚠️ \`${args}\` — ${provider} 모델은 보통 ${expected} 로 시작합니다. ` +
    "오타가 아닌지 확인하세요. (그대로 적용했고, 모델이 거부되면 다음 turn 에 " +
    "기본 모델로 자동 폴백됩니다.)"
  );
};

// 파일 로깅 최우선 활성화 — 이후 모든 console.*(부팅·plugin·route·handler 스택)가
// <home>/logs/daemon-<날짜>.log 에 미러됨 (터미널 전용 한계 해소 → 영구 파일, 사후 진단).
const logFile = initFileLogging();

console.log("tiguclaw daemon: starting");

// ── event-loop wedge 진단 (2026-07-03, gated: LOOP_DIAG=1) ──────────────────
// 데몬이 워커 실행 중 응답불능(wedge)되는 원인 규명용. event-loop lag(타이머 드리프트)
// + active handles/requests 수 + rss 를 주기 로그 → 누수(handles 단조 증가) vs 블록
// (lag 급증 후 로그 멈춤) 판별. 평시 off, 디버깅 시만 켠다.
if (process.env.LOOP_DIAG === "1") {
  const DIAG_MS = 3000;
  let last = Date.now();
  const diagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - DIAG_MS;
    last = now;
    const p = process as unknown as {
      _getActiveHandles?: () => unknown[];
      _getActiveRequests?: () => unknown[];
    };
    const h = p._getActiveHandles?.().length ?? -1;
    const r = p._getActiveRequests?.().length ?? -1;
    const rss = Math.round(process.memoryUsage().rss / 1e6);
    console.log(`[loop-diag] lag=${lag}ms handles=${h} reqs=${r} rss=${rss}MB`);
  }, DIAG_MS);
  diagTimer.unref();
}
if (logFile !== null) console.log(`tiguclaw logs: ${logFile}`);

// V9.1 — 런타임 홈 준비 (TIGUCLAW_HOME ?? ~/.tiguclaw). 부재 시 생성·시드.
await ensureHome();
console.log(`tiguclaw home: ${getPaths().home}`);

// V9.4 — readAgent 경로가 홈으로 전환되므로, 레포 ./AGENT.md(사용자 인격)를 홈으로 1회
// 마이그레이션 (홈이 untouched 시드일 때만 — 멱등·비클로버, 원본 보존). ensureHome 직후 필수.
await migrateLegacyAgent(process.cwd());

initStore();

// auth-provider 등록 (2026-07-18, 계약 §5·§8) — Tier 2 구독 인증(codex OAuth)을 레지스트리에
// self-register 하는 side-effect 모듈을 optional dynamic import 로 로드. 첫 turn 전 완료 보장
// (부팅 초기·채널 기동 전). Business/OSS 빌드는 이 파일을 EXCLUDE → import 실패 → catch 로
// graceful(레지스트리 빈 채, codex 백엔드가 조회 시 typed 에러→폴백). 코어 크래시 0.
await import("./core/llm-runtime/auth-providers.js").catch((e) => {
  console.log(
    `[auth-provider] codex 구독 인증 미등록(EXCLUDE 빌드 또는 로드 실패): ${String(e)}`,
  );
});

// 잔존 self-restart 예약작업 정리 (win32 only, best-effort). 직전 /restart 가 만든 1회성
// schtasks 작업이 이 부팅을 띄운 뒤 목록에 남아있으면 제거(멱등 — 없으면 no-op). 재발화는
// /sc once 라 어차피 안 하지만 죽은 작업 누적 방지. 실패해도 부팅 무중단.
cleanupSelfRestartTask();

// EventBus 부트 (channels 만들기 전 — region 측 module-level publish 안전).
const bus = initEventBus({ bufferSize: 1000 });

// 관측 이벤트 영속 sink — ring buffer 는 hot cache 로 두고 의미있는 이벤트를 DB 에 기록
// (감사·메트릭). publish() 무수정, subscriber 하나만 추가 (코어는 데이터로 확장).
startEventPersistence(bus);

// 훅 발화 → EventBus 배선 (self-update 의 `setSelfUpdateRestart` 와 동형 — 부팅 1회
// 레지스트리 등록, 어댑터 시그니처 불변). `hook-runner.ts` 는 매칭된 훅을 실제 spawn
// 했을 때만 emit(미설정/미매칭 훅은 콜백 0회 — 노이즈 0). 프런트 렌더는 별도 소비자
// 몫 — 여기선 `hook.activity` 로 EventBus/SSE 에 얹기만 한다.
setHookObserver((ev) => {
  bus.publish({
    type: "hook.activity",
    ts: Date.now(),
    payload: ev as unknown as Record<string, unknown>,
  });
});

const channels: Channel[] = [];

// service capability plugin 의 stop() 수집 — shutdown 이 일괄 호출(채널과 대칭).
const serviceStops: Array<{ name: string; stop: () => Promise<void> }> = [];

// ★코어 하드코딩 채널 0 (2026-07-18) — cli·telegram 모두 채널 플러그인으로 이전
// (plugins/cli-channel name="cli", plugins/telegram-channel name="telegram"). 로더가
// 발견·기동한다. telegram 무토큰이면 플러그인이 self-disable(status:"disabled").
// presence 는 채널 self-report(c.status ?? "up") — 코어가 특정 채널명 모름(§0).

// 통합 로더 — 한 plugin 인스턴스를 capability 별로 분기 등록 (contract §3 보강 D-(ii)).
// hybrid plugin (channel + observer 등) 의 인스턴스 1개 보장.
try {
  // α (2026-05-25) — plugins 는 앱 배포 아티팩트 → cwd 가 아니라 appRoot 기준 로드
  // (dev=레포=cwd 동치라 회귀 0, prod 독립앱에서 cwd≠레포여도 plugins 정상 발견).
  const loaded = await loadPlugins(
    path.join(appRoot(), "plugins"),
    bus,
  );
  for (const lp of loaded) {
    const inst = lp.instance as {
      name?: string;
      start?: (arg: unknown) => Promise<void>;
      startChannel?: (handler: MessageHandler) => Promise<void>;
      startObserver?: (eventBus: EventBus) => Promise<void>;
      startTrigger?: (eventBus: EventBus) => Promise<void>;
      startService?: (eventBus: EventBus) => Promise<void>;
      stop?: () => Promise<void>;
      getMcpServer?: () => McpSdkServerConfigWithInstance | undefined;
      outbound?: ChannelOutbound;
      status?: "up" | "disabled";
    };
    const relDir = path.relative(appRoot(), lp.pluginDir);

    // ─── MCP server registration (scheduler v1 §8.1 대안 C) ──────────────────
    // capability 무관 — plugin 인스턴스가 in-process MCP server 를 export 하면
    // registry 에 박는다. router 가 영역 A 호출 시 extraMcpServers 로 전달.
    if (typeof inst.getMcpServer === "function") {
      try {
        const server = inst.getMcpServer();
        if (server !== undefined) {
          registerMcpServer(lp.manifest.name, server);
          console.log(
            `registered mcp server from plugin: ${lp.manifest.name} (from ${relDir})`,
          );
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[plugin-loader] mcp server registration ${lp.manifest.name} failed: ${reason}`,
        );
      }
    }

    // ─── channel capability 등록 (start* 호출은 아래 channels.start loop 가 담당) ──
    if (lp.capabilities.includes("channel")) {
      const channelName =
        typeof inst.name === "string" ? inst.name : lp.manifest.name;
      const conflict = channels.some((c) => c.name === channelName);
      if (conflict) {
        console.warn(
          `channel plugin "${lp.manifest.name}" skipped (name conflict with hardcoded)`,
        );
      } else {
        // hybrid 의 경우 startChannel 우선, 단일 capability 면 start fallback.
        const startFn =
          typeof inst.startChannel === "function"
            ? inst.startChannel.bind(inst)
            : (inst.start as (h: MessageHandler) => Promise<void>).bind(inst);
        const stopFn =
          typeof inst.stop === "function"
            ? inst.stop.bind(inst)
            : async (): Promise<void> => {
                /* no-op */
              };
        channels.push({
          name: channelName,
          start: startFn,
          stop: stopFn,
          // presence 상태 forward(D1(b), §12.3) — 플러그인 채널은 wrapper 로 push 되므로
          // 인스턴스가 선언한 status 를 duck-type 으로 읽어 wrapper 에 실어야 presence 루프가
          // 본다(inst.outbound → registerChannelOutbound forward 와 동형). 미선언 = 미포함
          // → presence `?? "up"`(회귀 0).
          ...(inst.status !== undefined ? { status: inst.status } : {}),
        });
        // 아웃바운드 능력 등록(ADR 2026-07-16 §D1/§D3) — plugin 이 `outbound` 를 표명하면
        // loader 가 duck-typing 으로 읽어 코어 레지스트리에 등록(startChannel 과 동형, §0 준수:
        // core→plugin import 0). http-bridge = 관측-전용(deliver 없음) 이지만 *등록*은 한다
        // ("미등록/unsupported" 과 구분). 코어 채널은 아래 channels.start 루프가 등록.
        if (inst.outbound !== undefined) {
          registerChannelOutbound(channelName, inst.outbound);
        }
        console.log(
          `loaded channel plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      }
    }

    // ─── trigger capability — startTrigger(bus) 즉시 호출 (observer 동형) ─────
    if (lp.capabilities.includes("trigger")) {
      const startFn =
        typeof inst.startTrigger === "function"
          ? inst.startTrigger.bind(inst)
          : (inst.start as (b: EventBus) => Promise<void>).bind(inst);
      try {
        await startFn(bus);
        console.log(
          `loaded trigger plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[plugin-loader] trigger ${lp.manifest.name} start failed: ${reason}`,
        );
        try {
          bus.publish({
            type: "plugin.error",
            ts: Date.now(),
            payload: {
              pluginName: lp.manifest.name,
              phase: "start",
              error: reason,
            },
          });
        } catch {
          // bus 자체 throw — 무시.
        }
      }
    }

    // ─── observer capability — start(bus) 즉시 호출 (기존 동작 보존) ─────────────
    if (lp.capabilities.includes("observer")) {
      const startFn =
        typeof inst.startObserver === "function"
          ? inst.startObserver.bind(inst)
          : (inst.start as (b: EventBus) => Promise<void>).bind(inst);
      try {
        await startFn(bus);
        console.log(
          `loaded observer plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[plugin-loader] observer ${lp.manifest.name} start failed: ${reason}`,
        );
        try {
          bus.publish({
            type: "plugin.error",
            ts: Date.now(),
            payload: {
              pluginName: lp.manifest.name,
              phase: "start",
              error: reason,
            },
          });
        } catch {
          // bus 자체 throw — 무시.
        }
      }
    }

    // ─── service capability — startService(bus) 즉시 호출 (trigger/observer 동형) ──
    // 외부 프로세스(대시보드 등) 기동·정리. stop() 은 shutdown 이 일괄 호출.
    if (lp.capabilities.includes("service")) {
      const startFn =
        typeof inst.startService === "function"
          ? inst.startService.bind(inst)
          : (inst.start as (b: EventBus) => Promise<void>).bind(inst);
      try {
        await startFn(bus);
        if (typeof inst.stop === "function") {
          serviceStops.push({
            name: lp.manifest.name,
            stop: inst.stop.bind(inst),
          });
        }
        console.log(
          `loaded service plugin: ${lp.manifest.name} (from ${relDir})`,
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[plugin-loader] service ${lp.manifest.name} start failed: ${reason}`,
        );
        try {
          bus.publish({
            type: "plugin.error",
            ts: Date.now(),
            payload: {
              pluginName: lp.manifest.name,
              phase: "start",
              error: reason,
            },
          });
        } catch {
          // bus 자체 throw — 무시.
        }
      }
    }
  }
} catch (e) {
  console.error("loadPlugins failed:", e);
}

// channel.message.in/out 관측 이벤트의 본문 상한 — 실채팅엔 사실상 무제한(긴 답변·
// 보고서 전체 보존: 대시보드 표시·chat_log 영속·스트리밍 치환 모두 전체본). 천장은
// 인메모리 ring/SSE 가 병적으로 거대한 모델 출력에 부풀지 않게 하는 폭주 방어용일 뿐.
// (구 500자 미리보기 캡은 대시보드=로그 시절 잔재 — 진짜 채팅이 된 지금 제거.)
const EVENT_TEXT_MAX = 50_000;

// 영역 A 에러 → 사용자 친화 메시지. 사용 한도/레이트리밋(codex usage_limit_reached·429·quota 등)은
// 원문 JSON 덤프 대신 *명확한 안내*(어느 백엔드·리셋까지 대략 N분·전환/다중풀 제안)로. provider 무관
// (codex·claude·openai 등 어느 백엔드가 한도에 걸려도 동일). 그 외 에러는 원 detail 그대로 노출.
const formatRegionAError = (detail: string): string => {
  const d = detail || "";
  // 처리불가 이미지(400 invalid_request + image) — 원문 JSON 대신 명확한 안내. 스레드 자가치유는
  // 어댑터가 처리(resume 무효화)하므로 여기선 사용자 안내만. [[project_bad_image_poisons_claude_resume]]
  if (/\b400\b/.test(d) && /invalid_request_error/i.test(d) && /\bimage\b/i.test(d)) {
    return (
      `⚠️ 첨부한 이미지를 처리할 수 없습니다. 형식(JPEG·PNG·GIF·WebP)과 크기(너무 작거나 큰 이미지 불가)를 확인해 주세요.\n` +
      `다른 이미지로 다시 보내면 됩니다. (이 이미지 때문에 대화가 막히지 않도록 처리해 두었습니다.)`
    );
  }
  const isLimit = /usage_limit_reached|rate[-_ ]?limit|too many requests|\bquota\b|\b429\b/i.test(d);
  if (!isLimit) return `⚠️ 요청 처리 중 오류가 발생했습니다:\n${detail}`;
  const provMatch = d.match(/codex|anthropic|claude|openai|gemini|ollama/i);
  const prov = provMatch ? provMatch[0].toLowerCase() : "LLM";
  const secMatch =
    d.match(/"resets_in_seconds"\s*:\s*(\d+)/) || d.match(/retry[-_ ]?after["'\s:=]+(\d+)/i);
  const when = secMatch
    ? ` 약 ${Math.max(1, Math.round(Number(secMatch[1]) / 60))}분 후 리셋됩니다.`
    : "";
  return (
    `⚠️ ${prov} 백엔드 사용 한도(rate limit)에 도달했습니다.${when}\n` +
    `지금 바로 쓰려면 다른 백엔드로 모델을 바꾸거나, 여러 모델 풀(예: codex + claude)로 두면 한도·장애 시 자동 폴백됩니다.`
  );
};

// 빌트인 슬래시 명령(라우터 우회·조기 return)의 응답 통로 — msg.reply 로 보내고 **channel.message.out
// 도 발행**한다. 그래야 대시보드 '작업 중' 표시가 꺼지고(활성=channel.message.in↔완료=out/turn_done),
// 명령 답도 대시보드 채팅/이력에 보인다. (2026-07-10: /status 등이 out 미발행이라 in 만 떠서 대시보드가
// 계속 '작업 중'이던 갭 — [[project_active_send_dashboard_visibility]] 동일 패턴.) 관측 발행 실패는 격리.
const replyCommand = async (
  msg: { reply: (t: string) => Promise<unknown>; channel: string; threadKey: string },
  text: string,
): Promise<void> => {
  await Promise.resolve(msg.reply(text)).catch(() => {});
  try {
    bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        text: text.slice(0, EVENT_TEXT_MAX),
      },
    });
  } catch {
    /* 관측 발행 실패가 명령 응답을 무르지 않는다(원칙 3). */
  }
};

// 사용자 중단(/stop) — 진행 중 턴을 프로세스 안 죽이고 abort 할 때 turnAc.abort() 에 넣는 reason.
// 핸들러가 이 reason 을 보면 에러가 아니라 사용자 취소로 인지해 조용히 종료(안내는 /stop 이 담당).
class UserCancelledError extends Error {
  constructor() {
    super("user cancelled turn (/stop)");
    this.name = "UserCancelledError";
  }
}
// 진행 중 메인 채널 턴의 AbortController 레지스트리 (threadKey → turnAc). enqueueThreadTurn 이
// thread 별 직렬화하므로 thread 당 최대 1개. /stop(아웃오브밴드)이 여기서 turnAc 를 찾아 abort =
// 클로드코드식 인터럽트(옵션 c). 재시작 정직(메모리 레지스트리, 영속 0). 어댑터 분기 0(LLM-agnostic).
const inflightTurns = new Map<string, AbortController>();

// mid-turn steering (ADR 2026-07-16-midturn-steering §5) — 진행 중 턴에 새 사용자 메시지를
// "다음 model-call 경계에서 append"(손실 0)하기 위한 turn 별 SteeringChannel 레지스트리
// (inflightTurns 자매 — threadKey → SteeringChannel, thread 당 최대 1개). 핸들러가 turn 시작 시
// 생성·등록, finally 에서 close+삭제. 개입점(serializedHandler)이 진행 턴 있으면 여기로 push.
const steeringChannels = new Map<string, SteeringChannel>();
// ★feature flag — mid-turn steering. ADR §안전은 처음에 "기본 off"(라이브 대공사 안전)였으나,
// 3어댑터 구현(P1a codex/P1b openai/P1c claude) + 작업중 조기-OFF 버그픽스(2026-07-20)까지
// 검증돼 **기본 on 으로 승격**(2026-07-20). opt-out = `STEERING_ENABLED=0`(그때만 개입점 no-op·
// steeringCh 미생성·route input 미주입 = **현행 큐 바이트 동일**, 회귀 0 하드게이트 유지).
const STEERING_ENABLED = process.env.STEERING_ENABLED !== "0";

// 인바운드 첨부 → 영속용 참조 메타(base64 아님). 실제 바이트는 이미 <attachmentsDir>/<rel> 파일로
// 저장돼 있어, 대시보드가 rel 로 서빙 엔드포인트를 통해 렌더(새로고침·과거 이력 보존). rel 은
// attachmentsDir 기준 상대경로 — 그 밖(절대·상위)이면 스킵(path traversal 방어 + 서빙 키 정합).
const attachmentsMeta = (
  atts: IncomingMessage["attachments"],
): Array<{ rel: string; mime: string; name: string; kind: string; bytes?: number }> => {
  if (atts === undefined || atts.length === 0) return [];
  const dir = getPaths().attachmentsDir;
  const out: Array<{ rel: string; mime: string; name: string; kind: string; bytes?: number }> = [];
  for (const a of atts) {
    const rel = path.relative(dir, a.path);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue; // dir 밖 = 스킵.
    out.push({
      rel: rel.split(path.sep).join("/"), // URL 경로 정규화(윈도우 \ → /).
      mime: a.mimeType,
      name: a.filename,
      kind: a.kind,
      bytes: a.bytes,
    });
  }
  return out;
};

// 인바운드 echo 발행 — 대시보드 낙관적 "대기 중" 버블 승격 신호(js/sse.js 가 correlationId 로
// 매칭해 클리어). handler(in-band) 정상 경로와 serializedHandler 의 out-of-band 슬래시
// (/restart, /stop, /update — 직렬 큐를 건너뛰어 handler 를 아예 호출하지 않음) 양쪽이
// 이 헬퍼로 **배타적으로** 1회씩만 호출한다(이중발행 0). 합성(synthetic) turn 은 항상 스킵
// (버그 트레이스 2026-07-16: out-of-band 분기가 이 echo 를 안 내보내 /stop 후 "대기 중"
// 버블이 클리어 신호를 못 받아 스턱 — [[project_dashboard_multisession]] 인접 갭).
const publishInboundEcho = (msg: {
  synthetic?: boolean;
  channel: string;
  threadKey: string;
  text: string;
  attachments?: IncomingMessage["attachments"];
  correlationId?: string;
}): void => {
  if (msg.synthetic === true) return;
  const inAttachments = attachmentsMeta(msg.attachments);
  bus.publish({
    type: "channel.message.in",
    ts: Date.now(),
    payload: {
      channel: msg.channel,
      threadKey: msg.threadKey,
      text: msg.text.slice(0, EVENT_TEXT_MAX),
      ...(inAttachments.length > 0 ? { attachments: inAttachments } : {}),
      // 큐-취소(ADR 2026-07-15) — echo 에 correlationId 를 실어 대시보드가 낙관적
      // "대기 중" 버블 승격을 텍스트 대신 id 로 정확 매칭(동일 텍스트 오매칭 해소).
      // additive — 미부여(텔레그램 등)면 미포함 → 대시보드 텍스트-매칭 폴백(회귀 0).
      ...(msg.correlationId !== undefined && msg.correlationId !== ""
        ? { correlationId: msg.correlationId }
        : {}),
    },
  });
};

const handler: MessageHandler = async (msg) => {
  // 내부 기원 합성 turn(워커 done 재주입 등)은 인바운드 관측 발행을 스킵 — 합성 텍스트는
  // 내부 스캐폴딩(buildCompletionPrompt)이라 대시보드 chat_log 에 "나(user)"로 새면 안 된다.
  // 라우팅·발송 등 나머지 처리는 실 인바운드와 동일. 아웃바운드 관측은 아래 성공분기 단일 발행.
  publishInboundEcho(msg);
  const trimmed = msg.text.trim();
  // ★세션-정체성 저장 채널(채널/세션 분리 ADR 2026-07-15, QA BLOCKER 후속) — 슬래시 핸들러가
  // route() 정규화와 **동일 키**로 세션-정체성(resume/context boundary/model override/summary)
  // 을 read/write 하도록 canonical 채널을 산출한다. 텔레그램 정규화 turn(msg.channel=telegram,
  // msg.threadKey=dashboard:default)이면 SESSION_STORAGE_CHANNEL(http-bridge) → route 가 쓰는
  // 실세션 행 명중. 내부 파생/레거시 스레드면 msg.channel 그대로(회귀 0). 표시·응답·관측은
  // msg.channel(실채널) 유지 — 정체성/표시 2분리(§D3).
  const sidChannel = canonicalSessionChannel(msg.threadKey, msg.channel);
  // V7.3 — 영역 A(LLM) 로 넘길 실효 텍스트. 사용자 정의 슬래시 매크로 매치 시
  // 확장된 prompt 로 교체 (기본 = 원본). 채널 입구 단일 지점 = LLM-agnostic.
  let effectiveText = msg.text;
  // `/reset` (+ 별칭 `/clear`) — 컨텍스트 전면 초기화. LLM-agnostic 이어야 하므로 세 어댑터를
  // 모두 끊는다: deleteSession(claude 세션) → setContextBoundary(codex/openai 는 세션 대신 매 턴
  // 히스토리 재전송 → 이 ts 이전 턴 컷) → clearThreadSummary(codex 롤링 요약 드롭). 순서 고정.
  // 채널 무관 단일 지점(원칙 4). command-registry expandCommand(파일 매크로) 앞이라 커스텀
  // 매크로가 이 별칭을 가릴 수 없다. `/clear` 는 별도 로직 복제 없이 동일 경로.
  if (trimmed === "/reset" || trimmed === "/clear") {
    const had = deleteSession(sidChannel, msg.threadKey);
    setContextBoundary(sidChannel, msg.threadKey, Date.now());
    clearThreadSummary(sidChannel, msg.threadKey);
    await replyCommand(msg,
      had
        ? "컨텍스트 초기화됨. 새 대화로 시작합니다."
        : "초기화할 컨텍스트가 없습니다.",
    );
    return;
  }
  // `/agents` — 진행 중인 백그라운드 작업(워커+서브에이전트) 요약. 채널 입구 fast-path
  // (LLM 턴 0, 즉답·무료·결정적). 서브·워커 통합 잡 모델(kind) 기반 — listJobs 단일 소스.
  // 원칙 4: 상태 조회를 모델에게 안 시킴(원칙 1 슈퍼셋의 사용자-driven 갈래).
  if (trimmed === "/agents") {
    const running = listJobs({ runningOnly: true });
    if (running.length === 0) {
      await replyCommand(msg,"지금 진행 중인 백그라운드 작업이 없어요.");
      return;
    }
    const now = Date.now();
    const fmtElapsed = (startedAt: number): string => {
      const sec = Math.max(0, Math.round((now - startedAt) / 1000));
      if (sec < 60) return `${sec}초째`;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s === 0 ? `${m}분째` : `${m}분 ${s}초째`;
    };
    // 최신 먼저(listJobs 가 startedAt 내림차순). 워커/서브 구분 라벨.
    const lines = running.map((j) => {
      const icon = j.kind === "agent" ? "🤖" : "📦";
      const kindLabel = j.kind === "agent" ? "서브에이전트" : "워커";
      const name = j.kind === "agent" ? (j.agentName ?? j.label) : j.label;
      // 모델 티어 표시(low/mid/high 등) — 워커·서브 공통. modelTier 있고 default/빈값 아닐 때만.
      const tier =
        j.modelTier !== undefined &&
        j.modelTier !== "" &&
        String(j.modelTier).toLowerCase() !== "default"
          ? ` · ${j.modelTier}`
          : "";
      return `${icon} ${kindLabel} \`${name}\`${tier} — ${fmtElapsed(j.startedAt)}`;
    });
    await replyCommand(msg,
      `🔧 진행 중인 백그라운드 작업 ${running.length}개:\n\n${lines.join("\n")}`,
    );
    return;
  }
  // 주: `/restart` 는 serializedHandler 에서 enqueueThreadTurn 큐를 건너뛰고 아웃오브밴드로
  // 처리된다(멈춘 턴에 막히지 않게). 여기 in-band 핸들러까지 도달하는 일은 없다(serialized
  // 분기가 선점). 단일 재시작 진실 소스 = restartDaemon() (아래 정의).
  // `/model` — Claude Code 슈퍼셋: 세션별 메인 모델 override. 채널 입구에서 처리
  // (원칙 4: 모델 슬래시 처리 안 시킴). `/reset` 시 함께 클리어(deleteSession 통합).
  // 결정노트 2026-05-27-region-unification §gap "메인 모델 동적 전환"의 사용자-driven 갈래.
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const args = trimmed === "/model" ? "" : trimmed.slice("/model ".length).trim();
    if (args === "") {
      const current = getSessionModelOverride(sidChannel, msg.threadKey);
      const envRaw = process.env.REGION_A_MODELS ?? "";
      const envPool = envRaw === ""
        ? "(미설정 — DEFAULT_MODEL_SPEC = anthropic 디폴트)"
        : resolveModelSpecs()
            .map((s) => `${s.adapter}:${s.model === "" ? "(어댑터 디폴트)" : s.model}`)
            .join(" → ");
      const lines = [
        `현재 세션 모델 override: ${current ?? "(없음 — env 폴백 사용)"}`,
        `env REGION_A_MODELS 풀: ${envPool}`,
        "",
        "사용법:",
        "  `/model <provider:model>` — 이 세션 메인 turn 모델 변경",
        "  `/model reset` — 세션 override 해제 (env 폴백)",
        "",
        "예시:",
        "  `/model anthropic:claude-sonnet-4-6`",
        "  `/model anthropic:claude-opus-4-7`",
        "  `/model codex:gpt-5-codex`",
        "",
        "참고: provider 는 `anthropic` / `codex` / `openai`. `/reset` 시 override 도 같이 초기화.",
      ];
      await replyCommand(msg,lines.join("\n"));
      return;
    }
    if (args === "reset") {
      const had = clearSessionModelOverride(sidChannel, msg.threadKey);
      await replyCommand(msg,
        had ? "세션 모델 override 해제됨 — env 폴백 사용." : "해제할 override 가 없습니다.",
      );
      return;
    }
    // 콤마 풀 파싱 (architect 정책 b — 유효한 것만 저장 + 무효 경고, 유효 0개면 거부).
    // parseModelSpecList 는 무효 part 를 drop 하므로, 무효 식별을 위해 raw split 각각을
    // parseModelSpec 으로 재시도해 유효/무효 원문을 분리한다. 채널 입구 단일 지점 파싱
    // (원칙 4: 모델에게 슬래시/풀 처리 안 시킴).
    const rawParts = args
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const invalidParts = rawParts.filter((p) => parseModelSpec(p) === null);
    const validPool = parseModelSpecList(args);
    if (validPool.length === 0) {
      // 유효 spec 0개 → 기존 단일 거부 톤 재사용 (저장 안 함).
      await replyCommand(msg,
        `형식 오류: \`${args}\` — \`provider:model\` 형식으로 입력하세요. ` +
          "콤마로 풀(폴백 순서)도 가능합니다. provider 는 anthropic / codex / openai. " +
          "예: `anthropic:claude-sonnet-4-6` 또는 `codex:gpt-5-codex,anthropic:claude-sonnet-4-6`",
      );
      return;
    }
    // canonical 저장 — region specLabel 이 adapter→provider 복원 보장(round-trip 안전).
    // 원문이 아니라 정규화된 provider:model 풀을 저장해 router 재-parse 가 항상 성공.
    const canonical = validPool.map(specLabel).join(",");
    setSessionModelOverride(sidChannel, msg.threadKey, canonical);
    // sanity 경고 — 각 유효 spec(canonical 라벨)에 prefix 휴리스틱 적용, 합산.
    const sanityWarnings = validPool
      .map((s) => modelSpecSanityWarning(specLabel(s)))
      .filter((w): w is string => w !== null);
    const poolNote =
      validPool.length === 1
        ? ""
        : ` (${validPool.length}개 풀, 앞에서부터 폴백)`;
    const extraLines: string[] = [];
    if (invalidParts.length > 0) {
      extraLines.push(
        `⚠️ 무시된 항목: ${invalidParts.map((p) => `\`${p}\``).join(", ")} (형식 오류)`,
      );
    }
    extraLines.push(...sanityWarnings);
    await replyCommand(msg,
      `세션 모델 → \`${canonical}\`${poolNote}. 다음 turn 부터 적용.` +
        (extraLines.length === 0 ? "" : `\n${extraLines.join("\n")}`),
    );
    return;
  }
  // `/models` (복수) — 모델 프로파일 *목록 표시*. `/model`(단수, 설정)과 짝. 읽기 전용·
  // LLM-agnostic(순수 텍스트, prompt_options 아님)·채널 무관 단일 지점(원칙 2·4). 홈은
  // loadModelProfiles 가 getPaths().settings 로 자동 사용, cwd(기본)는 프로젝트 스코프 병합.
  // 렌더는 순수 함수(models-command)로 위임 — 격리 테스트 가능. args 는 무시(정보 조회).
  if (trimmed === "/models" || trimmed.startsWith("/models ")) {
    const profiles = loadModelProfiles();
    const sessionOverride = getSessionModelOverride(sidChannel, msg.threadKey);
    await replyCommand(
      msg,
      renderModelProfiles(profiles, sessionOverride, getDefaultProfileName()),
    );
    return;
  }
  // 슬래시 명령은 채널 입구에서 파싱 (원칙 4 다채널 단일 인격, 원칙: 모델에게
  // 슬래시 처리 시키지 않는다). 첫 토큰 = 명령, 나머지 = args.
  if (trimmed.startsWith("/")) {
    const sepIdx = trimmed.search(/\s/);
    const cmd = sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx);
    const args = sepIdx === -1 ? "" : trimmed.slice(sepIdx + 1).trim();

    if (cmd === "/memo") {
      if (args === "") {
        await replyCommand(msg,"`/memo <기억할 내용>` 형태로 입력하세요.");
        return;
      }
      // 자동 type='user' 고정 (V1 daemon 슬래시는 사용자 직접 입력 → 대부분 사용자 자신 정보).
      // 자동 type 분류는 V2 LLM (region 책임).
      const firstLine = args.split(/\r?\n/, 1)[0]?.trim() ?? args;
      const slug = `memo-${Date.now().toString(36)}`;
      try {
        const m = addMemory({
          type: "user",
          name: slug,
          description: firstLine,
          body: args,
        });
        await replyCommand(msg,`메모리 추가됨: ${m.name} — ${m.description}`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`메모리 추가 실패: ${err}`);
      }
      return;
    }

    if (cmd === "/forget") {
      if (args === "") {
        await replyCommand(msg,"`/forget <name>` 형태로 입력하세요.");
        return;
      }
      // 단일 토큰 가정 (공백 없는 name, V1 단순). 다중 토큰은 첫 토큰만 사용.
      const name = args.split(/\s+/, 1)[0] ?? args;
      try {
        const ok = deleteMemory(name);
        await replyCommand(msg,
          ok ? `메모리 삭제됨: ${name}` : `그런 메모리가 없습니다: ${name}`,
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`메모리 삭제 실패: ${err}`);
      }
      return;
    }

    if (cmd === "/memos") {
      // 인자 옵셔널 (기본 10, 1~50 클램프). 숫자 아니면 기본 10.
      let limit = 10;
      if (args !== "") {
        const parsed = parseInt(args, 10);
        if (!Number.isNaN(parsed)) {
          limit = Math.max(1, Math.min(50, parsed));
        }
      }
      try {
        const list = listMemories({ limit, orderBy: "updated" });
        if (list.length === 0) {
          await replyCommand(msg,"저장된 메모리 없음.");
        } else {
          const lines = list.map(
            (m) => `[${m.type}] ${m.name} — ${m.description}`,
          );
          await replyCommand(msg,lines.join("\n"));
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`메모리 목록 조회 실패: ${err}`);
      }
      return;
    }

    if (cmd === "/schedule") {
      // /schedule list | delete <id> | enable <id> | disable <id>
      // add 는 V1 미포함 — 인용 파싱 회피, 비서 자연어 MCP tool 권장.
      const subSepIdx = args.search(/\s/);
      const sub = subSepIdx === -1 ? args : args.slice(0, subSepIdx);
      const subArgs =
        subSepIdx === -1 ? "" : args.slice(subSepIdx + 1).trim();

      if (sub === "" || sub === "list") {
        try {
          const items = listSchedules();
          if (items.length === 0) {
            await replyCommand(msg,"등록된 스케줄 없음.");
          } else {
            const lines = items.map((s) => {
              const status =
                s.lastStatus === null
                  ? "—"
                  : s.lastStatus === "ok"
                    ? "ok"
                    : `err: ${s.lastError ?? "?"}`;
              const en = s.enabled ? "on" : "off";
              const dest =
                s.destTarget !== null && s.destTarget.length > 0
                  ? `${s.destChannel}:${s.destTarget}`
                  : s.destChannel;
              const triggerPart =
                s.triggerType === "reboot"
                  ? "reboot"
                  : `cron (${s.cronExpr} | ${s.timezone})`;
              return `#${s.id} [${en}] ${s.label} ${triggerPart} → ${dest} | last: ${status}`;
            });
            await replyCommand(msg,lines.join("\n"));
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await replyCommand(msg,`스케줄 목록 조회 실패: ${err}`);
        }
        return;
      }

      if (sub === "add") {
        await replyCommand(msg,
          "`/schedule add` 는 V1 슬래시에서 미지원. 비서에게 자연어로 부탁하세요 (예: \"매일 8시에 뉴스 정리해서 텔레그램으로\"). 비서가 add_schedule MCP 도구로 등록합니다.",
        );
        return;
      }

      // 그 외 subcommand 는 id 필요
      const id = parseInt(subArgs, 10);
      if (Number.isNaN(id)) {
        await replyCommand(msg,
          "`/schedule <list|delete|enable|disable> <id>` 형태로 입력하세요.",
        );
        return;
      }

      if (sub === "delete") {
        try {
          const ok = deleteSchedule(id);
          if (ok) {
            // scheduler runner 에게 cron 객체 stop 통보. scheduler plugin 이
            // subscribe 해서 처리. EventBus 의 격리 try/catch 가 publish 실패도 흡수.
            try {
              bus.publish({
                type: "scheduler.toggle",
                ts: Date.now(),
                payload: { id, action: "delete" },
              });
            } catch {
              /* bus throw — ignore */
            }
            await replyCommand(msg,`스케줄 삭제됨: #${id}`);
          } else {
            await replyCommand(msg,`그런 스케줄이 없습니다: #${id}`);
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await replyCommand(msg,`스케줄 삭제 실패: ${err}`);
        }
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const enable = sub === "enable";
        try {
          const updated = updateSchedule(id, { enabled: enable });
          if (updated === undefined) {
            await replyCommand(msg,`그런 스케줄이 없습니다: #${id}`);
          } else {
            try {
              bus.publish({
                type: "scheduler.toggle",
                ts: Date.now(),
                payload: { id, action: enable ? "enable" : "disable" },
              });
            } catch {
              /* bus throw — ignore */
            }
            await replyCommand(msg,
              `스케줄 #${id} ${enable ? "활성화" : "비활성화"}됨.`,
            );
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await replyCommand(msg,`스케줄 토글 실패: ${err}`);
        }
        return;
      }

      await replyCommand(msg,
        "`/schedule <list|delete|enable|disable> [id]` — 알 수 없는 subcommand.",
      );
      return;
    }

    if (cmd === "/plugins") {
      // 인자 무 (V1). 라우터 우회 — 인벤토리 직접 조회 후 사용자 포맷으로 응답.
      try {
        const inv = await collectInventory();
        const text = formatInventoryForUser(inv);
        await replyCommand(msg,text);
      } catch (e) {
        console.error("plugins inventory failed:", e);
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`인벤토리 조회 실패: ${err}`);
      }
      return;
    }

    if (cmd === "/status") {
      // 라우터 우회 — 데몬 현재 상태 직접 조회. 전부 DB/env/상수 읽기 (LLM 호출 0, route 미경유).
      try {
        const specs = resolveModelSpecs();
        const regionA = specs
          .map((s) => `${s.adapter}:${s.model || "(SDK 디폴트)"}`)
          .join(" → ");
        const sched = listSchedules();
        const enabled = sched.filter((s) => s.enabled).length;
        const up = Math.floor(process.uptime());
        const h = Math.floor(up / 3600);
        const m = Math.floor((up % 3600) / 60);
        const uptime = h > 0 ? `${h}시간 ${m}분` : `${m}분`;

        // 토큰 포맷 헬퍼: <1000 그대로, 86000→"86k", 1200000→"1.2M".
        const fmtTok = (n: number): string => {
          if (n < 1000) return String(n);
          if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
          return `${(n / 1_000_000).toFixed(1)}M`;
        };

        // 이번 대화: 이 thread 의 실제 모델 + 컨텍스트 사용량.
        const session = getSession(sidChannel, msg.threadKey);
        let convo: string;
        if (session === undefined || session.model === null) {
          convo = "측정 전(아직 응답 없음)";
        } else if (session.lastInputTokens === null) {
          convo = `${session.model} · 컨텍스트 측정 전`;
        } else {
          const inTok = session.lastInputTokens;
          const win = lookupContextWindow(session.model);
          if (win !== undefined) {
            const pct = Math.round((inTok / win) * 100);
            // 컨텍스트 압박 경고 — 윈도우 근접 시 /reset 유도(어댑터 무관).
            const warn =
              pct >= 85
                ? " ⚠️ 거의 참 — `/reset` 고려"
                : pct >= 70
                  ? " ⚠️ 여유 줄어듦"
                  : "";
            convo = `${session.model} · 컨텍스트 ~${pct}%${warn} (입력 ${fmtTok(inTok)} / ${fmtTok(win)})`;
          } else {
            convo = `${session.model} · 컨텍스트 입력 ${fmtTok(inTok)} (윈도우 미상)`;
          }
        }

        const runtimeMode =
          process.env.TIGUCLAW_RUNTIME === "source" ? "source" : "built";
        const lines = [
          "🐂 tiguclaw 상태",
          `─ 버전: v${appVersion()} (${runtimeMode})`,
          `─ 업타임: ${uptime}`,
          `─ 이번 대화: ${convo}`,
        ];

        // 세션 override (`/model` 로 설정) — 있을 때만 표시. 풀보다 우선이므로
        // 풀 줄 위에 둬서 사용자가 "다음 turn 무엇이 도는지" 즉시 파악.
        const statusOverride = getSessionModelOverride(
          sidChannel,
          msg.threadKey,
        );
        if (statusOverride !== null) {
          lines.push(
            `─ 세션 모델 override: \`${statusOverride}\` (다음 turn 부터 — 풀 무시, \`/model reset\` 해제)`,
          );
        }

        lines.push(`─ 모델 풀: ${regionA}`);

        // ★쿨다운 표시 (2026-07-27) — 풀에 있어도 *지금은 안 쓰이는* 모델을 알린다.
        //  실사고: ChatGPT Plus 주간 한도 소진으로 codex 가 6일 쿨다운에 들어갔는데
        //  폴백(claude)이 조용히 받아내 사용자는 로그를 뒤지기 전엔 알 수 없었다.
        //  ★푸시는 하지 않는다(폴백이 정상 동작 = 알림은 노이즈, 사용자 판단).
        //  물어봤을 때 보이면 충분하다. 없으면 줄 자체 생략(정상 시 노이즈 0).
        const cooldowns = listActiveCooldowns();
        for (const c of cooldowns) {
          const mins = Math.round(c.remainingMs / 60000);
          const when =
            mins >= 1440
              ? `${(mins / 1440).toFixed(1)}일`
              : mins >= 60
                ? `${Math.floor(mins / 60)}시간 ${mins % 60}분`
                : `${mins}분`;
          const at = new Date(Date.now() + c.remainingMs);
          const stamp = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}시`;
          lines.push(
            `─ ⏸ \`${c.key}\` 사용 불가 — ${when} 뒤 복구(${stamp}경). 그동안 풀의 다음 모델로 대체됩니다.`,
          );
        }

        // codex 토큰 만료: 미설정(undefined)이면 줄 자체 생략.
        const expiry = getCodexTokenExpiry();
        if (expiry !== undefined) {
          const days = Math.floor((expiry - Date.now()) / 86_400_000);
          const d = new Date(expiry);
          const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const warn = days < 2 ? "⚠️ " : "";
          lines.push(`─ ${warn}codex 토큰: ${days}일 후 만료 (${ymd})`);
        }

        lines.push(`─ 메모리: ${countMemories()}개`);
        lines.push(
          `─ 채널: ${channels.map((c) => c.name).join(", ")} (${channels.length})`,
        );
        lines.push(`─ 스케줄: ${sched.length}개 (활성 ${enabled})`);

        await replyCommand(msg,lines.join("\n"));
      } catch (e) {
        console.error("status failed:", e);
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`상태 조회 실패: ${err}`);
      }
      return;
    }
    // V7.3 — 하드코딩 데몬 명령 미매치 시 사용자 정의 슬래시 (.claude/commands/
    // + plugins/<name>/commands/) 조회. 발견되면 본문 prompt 확장 ($ARGUMENTS
    // 치환) → effectiveText 교체 → 아래 route 가 LLM 에 전달 (codex/claude 동등).
    // 미발견이면 effectiveText = 원본 → /foo 그대로 fall-through (기존 동작).
    const expanded = await expandCommand(cmd.slice(1), args);
    if (expanded !== undefined) {
      effectiveText = expanded;
    }
  }
  // V7.4.a — UserPromptSubmit 훅 (데몬에서 강제, 채널 입구 단일 지점 = LLM-agnostic).
  // 슬래시 확장 후의 실효 prompt 기준. exit 2 → 차단, exit 0 stdout → 컨텍스트 prepend.
  // hook 0개면 오버헤드 0. hook 실패는 격리 (데몬 생존, 원칙 3).
  const hookOut = await runUserPromptSubmitHooks({
    prompt: effectiveText,
    cwd: process.cwd(),
    channel: msg.channel,
    threadKey: msg.threadKey,
  });
  if (hookOut.block) {
    await replyCommand(msg,`요청이 훅에 의해 차단되었습니다: ${hookOut.blockReason ?? ""}`);
    return;
  }
  if (hookOut.additionalContext.length > 0) {
    effectiveText = `${hookOut.additionalContext}\n\n${effectiveText}`;
  }
  // 답글 인용 주입 (채널 무관 단일 지점 = LLM-agnostic, claude·codex 동일). 채널이
  // reply_to 원문을 실으면(telegram) "어느 메시지에 이어가는지"를 LLM 에 명시 —
  // 지시어("이거 이어서") 의 대상 모호성 해소. 미설정 채널(cli·http-bridge)은 무영향.
  // 슬래시 확장·훅 처리 후라 덮어쓰임 0. input.text 에 들어가 user turn 으로 persist.
  if (msg.replyToText !== undefined && msg.replyToText !== "") {
    effectiveText =
      "〔사용자가 다음 메시지에 답글로 보냈습니다 — 이 내용에 이어 아래 요청을 처리하세요〕\n" +
      `${msg.replyToText}\n` +
      "〔/답글 대상 메시지〕\n\n" +
      effectiveText;
  }
  // 턴 AbortController — idle(1층, region 어댑터 createIdleTimer)·외부 cancel 경로용.
  // signal 을 route→runRegionA→어댑터로 운반(어댑터가 자기 1층 idle AC 와 OR 결합).
  //
  // 2층 wall-clock 시간컷 제거 (2026-06-23) — 메인 비서 인터랙티브 턴의 wall-clock
  // 상한(createTurnTimer 무장 + Promise.race 하드데드라인)을 폐기했다. 그 하드데드라인은
  // a05c368(11h outage)에서 "hung 턴이 grammy 순차 폴러를 동결 → 채널 전체 무응답" 을
  // 푸는 band-aid 였다(폴러가 await 하므로 풀어줄 탈출구 필요). 이제 telegram.ts 폴러가
  // 비차단(턴을 절대 await 안 함, cli.ts 동형)이라 hung 턴이 채널·다른 thread 를
  // 구조적으로 막지 못한다 — 그 한 thread 의 버려진 promise 로 격리된다. 따라서 시간컷의
  // 존재 이유(채널-동결 회피)가 사라졌고, 정상 긴 작업을 자르던 부작용도 제거된다.
  // turnAc 는 idle·외부 cancel 로만 abort, wall-clock 으로는 abort 안 한다.
  const turnAc = new AbortController();
  inflightTurns.set(msg.threadKey, turnAc); // /stop 이 찾아 abort 할 수 있게 등록.
  // mid-turn steering 채널 등록(ADR 2026-07-16 §5) — flag on 일 때만 생성·등록·주입한다.
  // ★flag off = steeringCh 미생성 + steering 필드 미주입 = route input 현행 동일(회귀 0).
  // 개입점(serializedHandler)이 진행 턴을 감지하면 steeringChannels.get(threadKey).push 로 이
  // 채널에 적재 → (P1)어댑터가 drain/stream 소비. P0 에선 어댑터 미소비라 사실상 no-op.
  let steeringCh: SteeringChannel | undefined;
  if (STEERING_ENABLED) {
    steeringCh = createSteeringChannel();
    steeringChannels.set(msg.threadKey, steeringCh);
  }
  // 세션 정규화 지시(채널/세션 분리 ADR 2026-07-15) — 사용자 대면 채널이 msg.session 을
  // 채워 보내면 route 가 인입을 canonical 세션으로 정규화한다. 미지정(스케줄러·워커 재주입·
  // 서브에이전트·엔드포인트 등 내부 파생 turn)이면 forward 안 함 = 현행 passthrough(회귀 0).
  const routeP = route(
    effectiveText === msg.text ? msg : { ...msg, text: effectiveText },
    {
      abortSignal: turnAc.signal,
      ...(msg.session !== undefined ? { session: msg.session } : {}),
      // steering 소스 주입 — flag on 일 때만 존재(off 면 미포함 = 현행 opts 동일, 회귀 0).
      ...(steeringCh !== undefined ? { steering: steeringCh } : {}),
    },
  );
  try {
    const out = await routeP;
    // Stop 훅 — 응답 후처리/관측 (채널 출구 단일 지점, UserPromptSubmit 대칭).
    // 데몬은 turn 단발이라 block(계속) 의미는 무시. stdout 은 응답에 덧붙임.
    let replyText = out.text;
    const stopHook = await runStopHooks({
      response: out.text,
      cwd: process.cwd(),
      channel: msg.channel,
      threadKey: msg.threadKey,
    });
    if (stopHook.additionalContext.length > 0) {
      replyText = `${replyText}\n\n${stopHook.additionalContext}`;
    }
    // 채널 발송 직전 단일 지점 sanitize — 모델(특히 codex)이 자기 input 의
    // <system-reminder> 태그를 echo 했을 때 사용자 화면에 안 새게 한다.
    // OpenClaw `stripInternalRuntimeScaffolding` 패턴 답습. 방어 2단계 — sysprompt
    // 가 첫 방어선, 이게 두 번째. 마커가 응답 전체였던 극단(strip 후 빈 문자열)
    // 케이스는 원본 유지 + 경고 로그 — 무응답 회피, 모니터링으로 가시화.
    const sanitized = stripInternalRuntimeScaffolding(replyText);
    if (sanitized.trim() === "" && replyText.trim() !== "") {
      console.warn(
        `outbound-sanitize: response was entirely internal markers (channel=${msg.channel} thread=${msg.threadKey}) — sending raw, sysprompt/model review needed`,
      );
    } else {
      replyText = sanitized;
    }
    // 인입 채널 응답 — **항상**(현행 그대로, 바이트 동일). egress fan-out 은 이 뒤에 opt-in 추가.
    await msg.reply(
      replyText,
      out.replyToTrigger === true ? { replyToTrigger: true } : undefined,
    );
    // V1 단순+견고: route() 결과만 publish. 슬래시 응답 publish 는 V2
    // (msg.reply wrap 또는 분기별 명시 — 현 단계 회귀 위험 회피).
    bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        text: out.text.slice(0, EVENT_TEXT_MAX),
        // 실제 응답 모델(2026-07-27) — chat_log 로 영속돼 새로고침 후에도 답변에 모델이 붙는다.
        //  종전엔 활동 이벤트에만 있어, 활동이 다른 스레드(스케줄 등)에 속한 답변은 표시가 없었다.
        ...(typeof out.model === "string" && out.model !== "" ? { model: out.model } : {}),
      },
    });
    // ── egress fan-out (ADR 2026-07-16 §D4 Phase B2 / D2) ──────────────────────
    // "이 답도 함께 보낼" 추가 채널들(msg.egressChannels, 컴포저 체크박스). swap 아님 — 인입
    // 응답은 위에서 항상. 각 채널이 인입과 다르고 outbound-capable(레지스트리 등록 +
    // defaultOutboundTarget 표명)이면 deliverOutbound 로 추가 배달(채널별 분기 0, 레지스트리
    // 조회 — deliverOutbound 가 물리 발송 + 채널별 관측 발행). push-to-telegram = telegram 체크
    // 인스턴스. ★egressChannels 미지정/빈 배열이면 이 루프는 0회 = 현행 비트 동일(회귀 0).
    for (const ch of msg.egressChannels ?? []) {
      if (ch === msg.channel) continue; // 인입은 이미 위에서 응답.
      const o = getChannelOutbound(ch);
      if (o === undefined || o.defaultOutboundTarget === undefined) continue; // outbound-capable 만.
      // D2 target 체인: 명시 target 없음(컴포저 좌표 미전달) → 세션 last_channel_target(단
      // last_channel === ch 일 때만 — 타 채널 좌표 오용 방지, notifyDestFromMessage §2 가드
      // 동형) → deliverOutbound 가 null 이면 채널 defaultOutboundTarget() 로 폴백.
      let egressTarget: string | null = null;
      try {
        const meta = getSessionChannelMeta(SESSION_STORAGE_CHANNEL, msg.threadKey);
        if (
          meta !== null &&
          meta.lastChannel === ch &&
          meta.lastChannelTarget !== null &&
          meta.lastChannelTarget !== ""
        ) {
          egressTarget = meta.lastChannelTarget;
        }
      } catch {
        /* 세션 메타 조회 실패 — defaultOutboundTarget() 폴백(무해) */
      }
      // 한 채널 배달 실패가 다른 채널·인입 응답을 무르지 않게 격리(fan-out best-effort).
      try {
        await deliverOutbound({
          channel: ch,
          target: egressTarget, // null → deliverOutbound 가 defaultOutboundTarget() 로 해석.
          text: replyText,
          bus,
        });
      } catch (e) {
        console.error(
          `egress fan-out to "${ch}" failed (인입 응답은 정상):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    // 사용자 /stop 으로 중단된 턴 — 에러 아님. /stop 이 이미 안내·out 발행했으므로 조용히 종료
    // (에러 메시지 이중 발신 방지). turnAc.signal.reason 으로 판별(어댑터가 뭘 throw 하든 무관).
    if (
      turnAc.signal.aborted &&
      turnAc.signal.reason instanceof UserCancelledError
    ) {
      return;
    }
    // 잡 취소(WorkerCancelledError, U-I4 개정) — 대시보드 잡 카드에서 native Task 를 ⏹️ 중지하면
    // SDK per-Task abort 한계상 부모 턴 전체(effectiveAc)가 coarse 취소돼 이 에러가 올라온다.
    // 여기선 turnAc(부모 /stop 신호)가 아닌 effectiveAc 가 abort 된 것이라 위 UserCancelledError
    // 분기가 안 잡는다 → 던져진 에러 name 으로 판별. 잡 카드는 이미 worker.cancelled lifecycle 로
    // '취소' 표시되므로, 부모 턴엔 에러(⚠️)가 아닌 짧은 중립 통지만 보낸다(작업중 인디케이터도
    // 이 out 으로 꺼짐). 내부 토큰("모델 거부 아님") 노출 없이 깔끔히.
    if (e instanceof Error && e.name === "WorkerCancelledError") {
      await replyCommand(msg, "🛑 진행 중이던 작업을 중지했어요.");
      return;
    }
    // wall-clock 시간컷 제거(2026-06-23) 후 이 catch 는 어댑터/도구가 실제 던진 에러
    // (네트워크·모델 거부·idle abort 등)만 받는다 — 폴백 없이 끝나므로 사용자 노출 필수.
    // 콘솔엔 full 진단 — 스택·cause(undici "fetch failed" 등) 통째로 보존(운영자 로컬 경계).
    console.error("handler route failed:", e);
    // 사용자엔 redact 된 detail 노출 (사용자=운영자 단일 인격, "에러가 다 보이는 게 좋겠어").
    // 보안 불변식: errorDetail 결과는 무조건 redactSecrets 통과 후에만 reply (게이트 없음).
    // 톤은 폴백 고지(⚠️)와 통일 — 성공경로(폴백)/실패경로(이 catch) 상호배타라 중복 아님.
    // reply 자체가 또 실패해도 핸들러가 throw로 죽지 않게 격리.
    const detail = redactSecrets(errorDetail(e));
    // 에러 응답도 replyCommand 로 — 실패 턴에서도 대시보드 '작업 중'이 꺼지고(out 발행) 에러가
    // 대시보드 채팅에 보인다. (성공 경로는 923+929 에서 이미 발행하므로 중복 없음 — 상호배타.)
    await replyCommand(msg, formatRegionAError(detail));
  } finally {
    // 등록 해제 — 단, 그 사이 새 턴이 덮어썼으면(직렬 큐라 이론상 없지만 방어) 건드리지 않음.
    if (inflightTurns.get(msg.threadKey) === turnAc) {
      inflightTurns.delete(msg.threadKey);
    }
    // steering 채널 종료(ADR 2026-07-16 §5) — 턴 종료 시 close(멱등 — pending stream 대기자
    // unblock)+삭제. flag off 면 steeringCh=undefined → no-op(회귀 0). 위 방어와 동형으로 그
    // 사이 새 턴이 덮어썼으면 건드리지 않음.
    if (steeringCh !== undefined) {
      // close 를 먼저 — 이후 도착 push 는 false 반환 → 개입점이 새 턴으로 fall-through(손실 0).
      steeringCh.close();
      if (steeringChannels.get(msg.threadKey) === steeringCh) {
        steeringChannels.delete(msg.threadKey);
      }
      // ★미소비 steering 재주입(2026-07-25 라이브 실측 스킵 버그) — 턴의 마지막 model-call
      // *이후*·close *이전* 창에 push 된 입력은 소비할 경계(drain/stream)가 없어 buffer 에
      // 남는다. 그런데 push 는 true 를 반환했으므로 개입점(serializedHandler)은 새 턴도 안
      // 만들었다 → 그대로 두면 사용자 메시지가 대기도 처리도 아닌 채 조용히 스킵된다. close
      // *후* 남은 buffer 를 drain 해 새 턴으로 재주입한다. ★원자성: close 전 push=버퍼(여기서
      // drain 회수) / close 후 push=false(개입점이 새 턴) → 두 경로 어디로도 손실 0.
      const leftover = steeringCh.drain();
      if (leftover.length > 0) {
        // ★원문(raw)으로 재주입한다 (2026-07-27 라이브 버그 수정). 종전엔 framing 으로 감싼
        //  `s.text` 를 그대로 써서 (a) 사용자 화면에 "내가 보낸 메시지" 로 framing 전문이
        //  노출되고 (b) 새 턴엔 "이어갈 작업" 이 없는데 "하던 작업을 계속하라" 는 틀린 문맥이
        //  모델에 들어갔다. framing 은 *진행 중 턴에 끼워넣을 때* 만 유효하다.
        const text = leftover
          .map((s) => s.raw)
          .filter((t) => typeof t === "string" && t.trim() !== "")
          .join("\n\n");
        const atts = leftover.flatMap((s) => s.attachments ?? []);
        if (text !== "" || atts.length > 0) {
          const reinject = {
            ...msg,
            text,
            ...(atts.length > 0 ? { attachments: atts } : {}),
            receivedAt: Date.now(),
            // ★재-echo 금지 — 이 메시지는 steering buffer 에 accept 될 때 이미
            //  publishInboundEcho 로 화면에 떴다. 재주입에서 또 echo 하면 같은 메시지가
            //  두 번 보인다(사용자 지적: "대기중이면 대기중 처리가 들어갔을거고, 아니면
            //  화면에 보이잖아"). synthetic=true 가 echo 스킵의 기존 수단이다.
            synthetic: true as const,
          };
          // serializedHandler 경유 = thread 직렬 큐 합류(이 턴 finally 종료 후 실행) + 정상 턴
          // 시맨틱. 재주입 시점엔 이 채널이 이미 close+삭제라 재-steer 안 됨(새 턴으로 처리).
          void Promise.resolve(serializedHandler(reinject)).catch((e) => {
            console.error(
              "steering re-inject failed:",
              e instanceof Error ? e.message : String(e),
            );
          });
        }
      }
    }
  }
};

// 백그라운드 워커 — thread 별 turn 직렬 큐로 채널 핸들러 래핑 (architect §4, W-I4).
// 현 핸들러엔 turn 직렬화 락이 없어, 워커 완료-turn 재주입이 유저 interim 메시지와 같은
// thread 의 세션 resume 을 동시에 건드리면 race. enqueueThreadTurn(threadKey, …) 가
// threadKey 별로 직렬화(전역 락 아님 — 다른 thread 병렬). 같은 thread 단일 스트림인
// 일반 동작은 회귀 0(앞 turn 없으면 즉시 실행). 워커 완료 재주입(onWorkerComplete)도
// 같은 큐에 합류해 race 0.
// ── 재시작 단일 진실 소스 ────────────────────────────────────────────────
// 텔레그램 /restart(B)·대시보드 버튼(A, control.restart)·자가업데이트(/update·도구) 모두
// 이 한 곳으로 수렴 — 한 곳을 고치면 일괄 적용. 파괴적 작업이라 명시 트리거로만 호출.
//
// 재시작 보장은 OS 의 supervisor 유무에 따라 두 갈래 — 단, 두 갈래 모두 **graceful exit**
// 로 수렴한다(모든 OS 에서 *반드시* 새 데몬이 뜸):
//  1. mac/linux (supervisor O): graceful exit → launchd KeepAlive / systemd Restart=always
//     가 respawn. (실측 정상 — 깨지 말 것. 이중 재시작 금지.)
//  2. win32 등 (supervisor X): graceful exit 전에 **detached 헬퍼**(ping 지연 → wscript 로
//     win-launch.vbs 재기동, taskkill 미사용)를 spawn 해 새 데몬을 보장한다. taskkill /T 는
//     데몬의 *자식*인 헬퍼까지 죽여 respawn 을 깨므로(버그 #2) 쓰지 않는다 — 데몬은 mac 과
//     동형으로 graceful exit(자식·http 서버 정리 = 포트 해제)하고, 분리된 헬퍼가 대기 후
//     respawn 담당. 헬퍼 spawn 실패해도 graceful exit 는 진행(최소 종료 보장 — 견고성).
// 재시작 완료 알림은 reboot 스케줄(id=3)이 부팅 후 자동 발화.
const restartDaemon = (source: string): void => {
  if (!hasSupervisorRespawn()) {
    // supervisor 없는 OS — graceful exit 전에 분리 헬퍼로 respawn 을 보장(taskkill 무사용).
    // spawn 실패해도 아래 graceful exit 는 그대로 진행(최소한 종료는 보장).
    spawnDetachedRestart(source);
  }
  console.log(
    `daemon: restart requested (${source}) — graceful exit (` +
      (hasSupervisorRespawn()
        ? "supervisor respawn"
        : "detached helper respawn") +
      ")",
  );
  void shutdown("RESTART");
  // force-exit 백스톱 — 이 경로의 존재 이유는 "멈춘 턴에서도 무조건 죽는 탈출구"다.
  // graceful shutdown 의 server.close() 는 미추적 keep-alive 연결(예: in-flight
  // POST /messages)을 기다리며 지연될 수 있으므로, 열린 연결과 무관하게 종료를 보장한다.
  // unref() — 정상 graceful 종료가 더 빠르면 이 타이머는 프로세스를 붙잡지 않는다.
  setTimeout(() => {
    console.log("daemon: graceful shutdown 지연 — force exit");
    process.exit(0);
  }, 1500).unref();
};

// 자가 업데이트 도구(update_self) 경로용 전역 restart 콜백 등록 (index→core 단방향, 1회).
// 도구는 채널-특정 클로저로 restart 를 받기 어려워(restart=데몬 전역) 이 레지스트리에
// 의존한다 — 등록 후 update_self 는 runSelfUpdate({ notify }) 만 호출해도 재시작된다.
// 슬래시(/update)는 명시 restart 주입(우선) — 레지스트리와 공존(명시 > 레지스트리 > noop).
setSelfUpdateRestart(() => restartDaemon("self-update:tool"));

// 자가 업데이트 결과 → 사용자 친화 문구 (LLM 무경유 결정론 렌더 — 채널 무관, 슬래시·도구
// 공용 톤). status 4종 each. updating 은 from→to·파일수·"곧 재시작" 고지.
const formatSelfUpdateResult = (r: SelfUpdateResult): string => {
  if (r.status === "busy") {
    return "이미 업데이트가 진행 중입니다. 잠시 후 완료 알림이 옵니다.";
  }
  if (r.status === "up-to-date") {
    return "이미 최신 버전입니다. 변경 사항이 없어 재시작하지 않습니다.";
  }
  if (r.status === "updating") {
    const span =
      r.from !== undefined && r.to !== undefined ? `${r.from} → ${r.to}` : "최신";
    const files = r.changedFiles !== undefined ? ` (${r.changedFiles}개 파일)` : "";
    const npm = r.ranNpmInstall === true ? ", 의존성 갱신" : "";
    const sec = Math.round((r.restartInMs ?? 5000) / 1000);
    return (
      `🔄 업데이트 적용: ${span}${files}${npm}. typecheck 게이트 통과.\n` +
      `약 ${sec}초 후 재시작합니다 — 잠시 후 완료 알림이 옵니다.`
    );
  }
  // failed — typecheck 게이트 실패 시 자동 롤백·데몬 생존을 명시(먹통 아님).
  const rolled =
    r.rolledBack === true
      ? "변경은 자동 롤백됐고 데몬은 그대로 정상 동작합니다."
      : "데몬은 그대로 정상 동작합니다.";
  const detail = r.error !== undefined && r.error !== "" ? `\n원인: ${r.error}` : "";
  return `⚠️ 업데이트 실패. ${rolled}${detail}`;
};

// 슬래시·통지가 쓰는 notify dest 도출 — 메시지의 channel/threadKey 에서 generic 좌표 추출.
// telegram threadKey "tg:<chatId>" → chatId(worker-jobs deriveTargetFromThreadKey 동형, 비트 동일).
// 마커에 적재돼 *다음 부팅* 이 "업데이트 완료" 통지를 이 좌표로 보낸다(요청자에게 회신).
// ★채널/세션 분리(ADR 2026-07-15 §D3): 세션 id 가 채널 무관(dashboard:*)이 되면
// threadKey 파싱으로는 telegram chatId 를 못 얻는다. 그래서 (1) 인입 시 캡처된 배달 좌표
// `channelAddress`(telegram=chatId) 를 **최우선** 쓰고, (2) 없으면 세션 메타
// `getSessionChannelMeta(SESSION_STORAGE_CHANNEL, sessionId).lastChannelTarget`(route 가 인입
// 턴에 캡처) 로, (3) 그래도 없으면 기존 `tg:` 파싱/threadKey 폴백(회귀 0, 비트 동일)으로
// 내려간다. notifyDestFromCoords(self-update.ts)와 동형 우선순위.
const notifyDestFromMessage = (
  channel: string,
  threadKey: string,
  channelAddress?: string,
): SelfUpdateNotifyDest => {
  // (1) 캡처된 배달 좌표 우선(telegram=chatId, http=sessionId).
  const captured = channelAddress?.trim();
  if (captured !== undefined && captured !== "") {
    return { channel, target: captured };
  }
  // (2) 세션 메타 폴백 — 인입 턴이 setSessionChannelMeta 로 적재한 last_channel_target.
  // 실채널이 이 통지 채널과 같을 때만(다른 채널 좌표를 잘못 쓰지 않게). 조회 실패는 무해.
  try {
    const meta = getSessionChannelMeta(SESSION_STORAGE_CHANNEL, threadKey);
    if (
      meta !== null &&
      meta.lastChannel === channel &&
      meta.lastChannelTarget !== null &&
      meta.lastChannelTarget !== ""
    ) {
      return { channel, target: meta.lastChannelTarget };
    }
  } catch {
    /* 세션 메타 조회 실패 — 아래 파싱 폴백으로 */
  }
  // (3) 기존 파싱/threadKey 폴백(회귀 0).
  return {
    channel,
    target:
      channel === "telegram"
        ? (extractTelegramChatId(threadKey) ?? threadKey)
        : // http-bridge(대시보드 등)는 target=threadKey 를 그대로 보존해야 통지가 *원래 대화*
          // (예: dashboard:default)에 뜬다. null 로 버리면 deliverOutbound 가 "http-bridge:default"
          // generic 그룹으로 발행해 통지가 엉뚱한 스레드에 붙었다. telegram 외 채널도 threadKey 유지.
          channel !== "cli"
          ? threadKey
          : null,
  };
};

// control.restart — 채널/제어 차원 재시작 이벤트(A: http-bridge 가 토큰 게이트된 POST /restart
// 수신 시 publish). 어댑터 무관(LLM-agnostic) — 메시지 큐를 타지 않으므로 멈춘 턴에도 동작.
bus.subscribe((event) => {
  if (event.type === "control.restart") {
    const src =
      typeof event.payload.source === "string"
        ? event.payload.source
        : "control.restart";
    restartDaemon(src);
  }
});

// mid-turn steering 개입 판정(ADR 2026-07-16 §5) — steer 대상 = 일반 사용자 대화 메시지만.
//  - 슬래시(`/…`)는 제어 명령(out-of-band /stop·/restart·/update 는 위에서 이미 처리, in-band
//    /reset·/model 등은 큐로) → steering 대상 아님.
//  - 합성(synthetic) turn(워커 완료 재주입 등)은 사용자 메시지가 아니고 자체 프롬프트를 turn 으로
//    처리해야 하므로 제외(steering 으로 새면 완료 통지 유실) — publishInboundEcho 스킵 대상과 정합.
const steerable = (msg: IncomingMessage): boolean =>
  msg.synthetic !== true && !msg.text.trim().startsWith("/");

// ★steering framing(2026-07-24): mid-turn 메시지를 "새 지시"가 아니라 "작업 중 끼어든 노트"로
// 감싼다. 안 감싸면 진행 중 codex/claude 모델이 새 사용자 메시지를 새 지시로 받아 **하던 작업을
// 버리고** 그것만 답하고 턴을 끝냈다(강제완료 버그). 이 note 로 "작업 이어가되 반영/후처리" 를
// 지시. echo(publishInboundEcho)는 원문 msg 를 쓰므로 사용자 화면엔 원문만 보인다 — 이 framing 은
// 모델 입력에만 실린다. 3어댑터 전부 s.text 를 읽으므로 여기 한 곳 = LLM-agnostic parity.
const STEERING_NOTE_PREFIX =
  "[진행 중 작업에 사용자가 끼어들어 보낸 메시지입니다. 지금 하던 작업을 중단·포기하지 말고 " +
  "계속하세요 — 현재 작업에 대한 조정·추가 지시면 반영해 이어가고, 별개의 새 요청이면 지금 " +
  "작업을 마친 뒤에 다루세요. 사용자 원문:]";

// 채널 IncomingMessage → 중립 SteeringInput(ADR §3). 텍스트(framing 래핑)·첨부·도착시각만 실어 채널 무관화.
const toSteeringInput = (msg: IncomingMessage): SteeringInput => ({
  text: `${STEERING_NOTE_PREFIX}\n${msg.text}`,
  raw: msg.text, // 사용자 원문 — 재주입·표시는 반드시 이걸 쓴다(framing 노출 사고 방지).
  ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
  ts: Date.now(),
});

const serializedHandler: MessageHandler = (msg) => {
  // 아웃오브밴드 /restart — enqueueThreadTurn 직렬 큐를 건너뛰고 즉시 재시작.
  // 멈춘 턴(앞 턴 미완)이 있어도 큐 무관하게 프로세스를 죽여 respawn. /restart 는 프로세스를
  // 종료하므로 인플라이트 턴과 race 없음(다른 상태변경 명령 /reset 등은 in-band 유지).
  if (msg.text.trim() === "/restart") {
    // handler(in-band) 를 우회하므로 대시보드 낙관적 "대기 중" 버블을 클리어할 echo 를
    // 여기서 직접 낸다(2026-07-16 /stop 스턱 버블 픽스와 동형 — handler 는 절대 호출되지
    // 않으므로 이중발행 걱정 없음).
    publishInboundEcho(msg);
    void msg
      .reply(
        "🔄 곧 재시작합니다… 잠시 후 완료 알림이 옵니다.",
      )
      .catch(() => {})
      .finally(() => {
        restartDaemon(`telegram:${msg.channel}`);
      });
    return Promise.resolve();
  }
  // 아웃오브밴드 /stop — 진행 중인 이 thread 의 턴을 프로세스 안 죽이고 abort(클로드코드식 인터럽트,
  // 옵션 c). 직렬 큐를 타면 앞 턴이 끝나야 실행돼 무의미하므로 /restart 동형 out-of-band. 중단 후
  // 이어서 새 메시지를 보내면 그게 새 턴으로 처리(멈추고 방향 틀기). 진행 턴 없으면 안내만.
  if (msg.text.trim() === "/stop") {
    // 버그 픽스(2026-07-16) — 이 분기는 handler(in-band) 를 호출하지 않으므로 handler 의
    // channel.message.in echo 가 안 나가 대시보드 낙관적 "대기 중" 버블이 클리어 신호를
    // 영영 못 받아 스턱됐다(새로고침해야 사라짐). replyCommand(out) 전에 echo(in) 를 내
    // js/sse.js 가 correlationId 매칭으로 버블을 정상 유저 버블로 승격하게 한다.
    publishInboundEcho(msg);
    void (async (): Promise<void> => {
      const ac = inflightTurns.get(msg.threadKey);
      if (ac !== undefined && !ac.signal.aborted) {
        ac.abort(new UserCancelledError());
        await replyCommand(
          msg,
          "⏹️ 진행 중이던 작업을 중단했습니다. 이어서 새로 말씀하시면 그걸로 진행할게요.",
        ).catch(() => {});
      } else {
        await replyCommand(msg, "지금 진행 중인 작업이 없어요.").catch(() => {});
      }
    })();
    return Promise.resolve();
  }
  // 아웃오브밴드 /update — /restart 동형으로 직렬 큐를 건너뛴다(자가 업데이트가 재시작을
  // 트리거하므로 멈춘 턴에 막히면 안 됨). 위험 로직(git/npm/typecheck/롤백/재시작 판단)은
  // 전부 runSelfUpdate 안에 닫혀 LLM 무경유(원칙 #2). 재시작 트리거도 루틴 안에 있으므로
  // 핸들러는 restartDaemon 을 직접 부르지 않는다(이중 트리거 방지) — reply 만 하고 끝.
  if (msg.text.trim() === "/update") {
    // handler 우회 — /stop 과 동형 픽스(위 주석 참고).
    publishInboundEcho(msg);
    void (async (): Promise<void> => {
      try {
        const r = await runSelfUpdate({
          restart: () => restartDaemon(`self-update:${msg.channel}`),
          notify: notifyDestFromMessage(
            msg.channel,
            msg.threadKey,
            msg.channelAddress,
          ),
        });
        await replyCommand(msg,formatSelfUpdateResult(r)).catch(() => {});
      } catch (e) {
        // runSelfUpdate 는 throw 0 설계지만 방어적으로 catch — 데몬 생존.
        const err = redactSecrets(e instanceof Error ? e.message : String(e));
        await replyCommand(msg,`⚠️ 업데이트 처리 중 오류: ${err}`).catch(() => {});
      }
    })();
    return Promise.resolve();
  }
  // ── mid-turn steering 개입점(ADR 2026-07-16-midturn-steering §5, §"완료 데드락 + 수정" Part B) ──
  // 진행 중인 이 thread 의 채널이 존재하고 열려 있으면(=진행 턴 있음) 일반 대화 메시지(슬래시
  // 아님)를 새 별도 턴으로 큐잉하는 대신 그 SteeringChannel 로 push 해 "다음 model-call 경계에서
  // append"(손실 0, 진행 작업 유지)한다. 사용자 메시지 landed 는 publishInboundEcho 로 표시
  // (별도 턴 X — 대시보드 낙관적 버블 승격). 슬래시(/stop·/restart·/update 등 제어)는 위에서
  // 이미 out-of-band 처리됐고, 여기 도달한 슬래시(예 /reset·/model 등 in-band 명령)는 steerable
  // =false 로 걸러 현행 큐 경로 유지 — 제어 명령은 steering 대상 아님.
  // ★flag off(기본) → 이 분기 통째 skip → 아래 enqueueThreadTurn = **현행 바이트 동일**(회귀 0).
  // ★Part B — push 반환값이 진짜 게이트(채널 존재+open). 종전 `inflightTurns.has` 게이트는
  // 제거: claude 어댑터가 result 수신 시 채널을 즉시 close 하므로(Part A), result 후 턴 finally
  // 의 map delete 사이(수 초 가능한 async 구간)에 도착한 메시지는 채널이 이미 닫혀 있어
  // push 가 false 를 반환한다 — 이때 fall-through 해 아래 enqueueThreadTurn = **새 턴**(ADR
  // "result 후 도착 = 다음 턴" 시맨틱 정합, 조용한 드롭 0).
  if (STEERING_ENABLED && steerable(msg)) {
    const accepted =
      steeringChannels.get(msg.threadKey)?.push(toSteeringInput(msg)) === true;
    if (accepted) {
      publishInboundEcho(msg); // 사용자 메시지 landed 표시(별도 턴 안 만듦).
      // enqueueThreadTurn 안 함 — 진행 턴이 경계에서 소비. ★단, 이 핸들러는 *즉시* resolve
      // 하므로 이를 await 하는 POST /messages 가 **원래 턴 종료 전에** 반환한다 → 대시보드 클라가
      // "턴 완료"로 오인해 작업중을 조기에 끄던 버그(2026-07-20). STEERED_TURN_RESULT sentinel 로
      // resolve 해 http-bridge 가 `{steered:true}` 로 응답 → 클라가 작업중 유지(실제 종료 = 원래
      // 턴의 SSE out/turn_done). CANCELLED_TURN_RESULT 와 동형. 비-대시보드 채널(telegram/cli)은
      // 반환값을 작업표시에 안 쓰므로 무영향(#2 채널무관). flag off 면 이 분기 미도달 = 회귀 0.
      return Promise.resolve(STEERED_TURN_RESULT as unknown as void);
    }
    // 미적재(채널 없음=진행 턴 없음 / 닫힘=result 후 꼬리창) → 아래로 fall-through, 새 턴.
  }
  // 큐-취소(ADR 2026-07-15) — 클라 correlationId 를 큐 항목 식별 키로 전달. 대기 중(미시작)
  // 항목을 대시보드 ✕ 버튼→POST /cancel-queued→cancelQueuedTurn 이 지목 취소 가능. 미부여
  // (텔레그램·cli·스케줄·합성 turn)는 익명 항목 = 취소 불가·현행 동작(회귀 0). 취소된 항목은
  // CANCELLED_TURN_RESULT 로 no-op resolve → POST 핸들러가 {cancelled:true} 응답(G1).
  return enqueueThreadTurn(msg.threadKey, () => handler(msg), {
    id: msg.correlationId,
  });
};

// 완료 재주입(onWorkerComplete)이 메인 핸들러를 재진입할 수 있게 등록 (W-I1 단일 인격).
// 재주입도 직렬 큐를 타도록 serializedHandler 를 넘긴다(완료-turn ↔ 유저 turn 직렬).
registerWorkerHandler(serializedHandler);

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`tiguclaw daemon: received ${signal}, shutting down`);
  for (const ch of channels) {
    try {
      await ch.stop();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`${ch.name} stop failed: ${err}`);
    }
  }
  for (const svc of serviceStops) {
    try {
      await svc.stop();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`service ${svc.name} stop failed: ${err}`);
    }
  }
  // 외부 MCP 서버(codex/openai 가 연결한 persistent 프로세스) 정리 — orphan 0(ADR §1e).
  try {
    const { closeAllExternalMcp } = await import("./core/external-mcp.js");
    await closeAllExternalMcp();
  } catch (e) {
    console.error(
      `external-mcp close failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 백그라운드 Bash 셸(file-ops run_in_background) 정리 — orphan 0 (외부 MCP 와 동형).
  // graceful self-exit(/restart) 경로에서 조용한 장기 셸(손자 포함)이 고아로 남는 구멍을
  // killTree(그룹 전체 종료)로 닫는다(ADR 2026-07-17 §3, Unit 1 Phase 0). ★await 필수 —
  // killAllBgShells 가 async(내부에서 process.kill/taskkill 실행)라 아래 process.exit(0)
  // 전에 시그널 발송이 실제로 끝나야 한다(fire-and-forget 이면 exit 가 먼저 뜰 수 있음).
  try {
    const { killAllBgShells } = await import(
      "./core/llm-runtime/capabilities/file-ops-mcp.js"
    );
    await killAllBgShells();
  } catch (e) {
    console.error(
      `bg-shells kill failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// 최후 그물 — 어디서도 안 잡힌 예외/거부. "항상 떠있다"는 *수퍼바이저(launchd
// KeepAlive)의 respawn* 이 보장하는 것이지 코어가 모든 예외를 삼켜서가 아니다.
// 손상된 상태로 계속 도느니 crash-fast — 로그를 남기고 exit(1) → 깨끗이 재기동.
// (정상 경로의 턴 에러는 채널 입구 핸들러가 이미 catch·redact 해 데몬을 보존한다.)
process.on("unhandledRejection", (reason) => {
  console.error(
    "daemon: unhandledRejection — crash-fast for supervisor respawn:",
    reason,
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(
    "daemon: uncaughtException — crash-fast for supervisor respawn:",
    err,
  );
  process.exit(1);
});

for (const ch of channels) {
  // 아웃바운드 능력 등록(ADR 2026-07-16 §D1/§D3) — 코어 채널(cli/telegram)이 `outbound` 를
  // 표명하면 코어 레지스트리에 등록(switch→데이터 등록). plugin 채널은 위 loader 가 이미 등록
  // (여기 push 된 plugin 객체엔 outbound 없음 → 이중 등록 0). start 성공 여부와 무관하게 등록.
  if (ch.outbound !== undefined) registerChannelOutbound(ch.name, ch.outbound);
  try {
    await ch.start(serializedHandler);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`${ch.name} failed: ${err}`);
  }
}

// 채널 presence 등록 (ADR 2026-07-16 §D4 Phase A / U4) — 산 channels[] 를 진실원으로
// http-bridge GET /channels 에 노출(순수 가시성, outbound 라우팅 무관). 코어·플러그인 채널
// 모두 로드된 것을 "up" 으로. ★텔레그램 토큰 부재로 push 안 된 경우(위 line 183 warn 분기)는
// "존재하나 꺼짐"을 사용자가 보도록 disabled 로 명시 추가(토큰 있으면 이미 channels[] 에 있어
// 중복 추가 금지). kind 는 표시용 — Phase A 는 채널별 특수 로직 없이 c.name 을 그대로 쓴다.
{
  // outbound 능력 플래그(ADR 2026-07-16 §D4 Phase B2) — 코어 레지스트리(위 등록 완료)를 조회해
  // canDeliver(`deliver` 표명)·hasDefaultTarget(`defaultOutboundTarget()` non-null)을 채운다.
  // 컴포저 egress 셀렉터가 hasDefaultTarget 채널만 노출(U3). defaultOutboundTarget 은 sync|async
  // 둘 다 허용(interface) — await 로 통일. 조회 실패(예외)는 false(무해·안전 기본). §0: 채널명
  // 하드코딩 0(레지스트리 조회만).
  const outboundFlags = async (
    name: string,
  ): Promise<{ canDeliver: boolean; hasDefaultTarget: boolean }> => {
    const o = getChannelOutbound(name);
    if (o === undefined) return { canDeliver: false, hasDefaultTarget: false };
    let hasDefaultTarget = false;
    try {
      const t =
        o.defaultOutboundTarget !== undefined
          ? await o.defaultOutboundTarget()
          : null;
      hasDefaultTarget = typeof t === "string" && t.trim() !== "";
    } catch {
      hasDefaultTarget = false;
    }
    return { canDeliver: o.deliver !== undefined, hasDefaultTarget };
  };
  // 범용 presence — 채널이 스스로 status 선언(§12.4). 미선언 채널(cli·http-bridge)은
  // `?? "up"` 폴백(회귀 0). 무토큰 telegram 플러그인은 자기 channels[] 에 있고 status:
  // "disabled" 를 보고하므로, 옛 `name:"telegram"` 하드코딩 특수분기가 불필요(§0 순개선).
  const presence: ChannelPresence[] = await Promise.all(
    channels.map(async (c) => ({
      name: c.name,
      kind: c.name,
      status: c.status ?? "up",
      ...(await outboundFlags(c.name)),
    })),
  );
  setChannelPresence(presence);
}

// 재시작으로 중단된 백그라운드 워커를 사용자에게 정직 통지 (채널 start 후 — raw 아웃바운드).
await recoverInterruptedJobs();

// 백그라운드 셸(file-ops run_in_background) 부팅 reaper — ADR 2026-07-17 §4, Unit 1
// Phase 1. `recoverInterruptedJobs` 와 동형 위치·논리: 이전 세대(재시작 전 데몬)가 띄운
// detached 셸이 `daemon:restart`(kickstart -k) 잡그룹 이탈·hard-kill·크래시·전원상실로
// 살아남았을 수 있는 고아를 PID 재사용 신원검증 후 정리한다(killAllBgShells 의 graceful
// 경로가 못 미친 나머지 절반). never-throw(내부 완전 격리) — await 실패해도 부팅 불가 X.
// 통지 없음(셸은 사용자 통지 대상 아님, ADR §4 — 워커와 달리 조용히 reap). 사용자 turn 처리
// 시작 전(채널 start 이후) 실행 — 신규 셸이 아직 없어 status='running' 잔류=전부 이전 세대.
try {
  const { reapPreviousGeneration } = await import(
    "./core/llm-runtime/capabilities/file-ops-mcp.js"
  );
  await reapPreviousGeneration();
} catch (e) {
  console.error(
    `bg-shells reaper failed (부팅 계속): ${e instanceof Error ? e.message : String(e)}`,
  );
}

// 자가 업데이트 실패 통지 — 위임 CLI update(telegram /update)가 실패·롤백하면 조용히 옛
// 버전으로 재가동될 뿐 요청자는 원인을 못 봤다(윈도우 "빌드 실패"). CLI 가 롤백 전 남긴
// <home>/.update-failed 마커를 부팅 시 1회 소비해 실패 단계+로그 경로를 요청자에게 통지 후
// 삭제(멱등). .update-complete 소비와 대칭. best-effort — 파싱·발송 실패해도 마커는 삭제.
const updateFailedNotified = await (async (): Promise<boolean> => {
  const markerPath = path.join(getPaths().home, UPDATE_FAILED_MARKER);
  let raw: string;
  try {
    raw = await fsp.readFile(markerPath, "utf8");
  } catch {
    return false; // 마커 없음 = 실패 아님.
  }
  try {
    const data = JSON.parse(raw) as {
      stage?: string;
      detail?: string;
      logPath?: string | null;
      notify?: { channel?: string; target?: string | null };
    };
    const stage = typeof data.stage === "string" ? data.stage : "unknown";
    const detail = typeof data.detail === "string" && data.detail ? `\n${data.detail}` : "";
    const logLine =
      typeof data.logPath === "string" && data.logPath ? `\n로그: ${data.logPath}` : "";
    const text = `❌ 업데이트 실패 (단계: ${stage}) — 이전 버전으로 되돌려 재가동했습니다.${detail}${logLine}`;
    await deliverOutbound({
      channel: data.notify?.channel ?? "cli",
      target: data.notify?.target ?? null,
      text,
      bus,
      observeThreadKey: DEFAULT_SESSION_ID,
    });
  } catch (e) {
    console.error(
      `self-update: 부팅 실패 통지 실패(마커는 삭제): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    try {
      await fsp.unlink(markerPath);
    } catch {
      /* 이미 없음/권한 — 무시 */
    }
  }
  return true;
})();

// 자가 업데이트 완료 통지 — 부팅 시 <home>/.update-complete 마커가 있으면 읽어 요청자에게
// "업데이트 완료 vX→vY" 1회 통지 후 마커 삭제(멱등). 채널 start 이후(send 가능 시점)라야
// raw 아웃바운드가 도달. best-effort — 마커 깨졌거나 발송 실패해도 부팅을 막지 않고 마커는
// 삭제한다(재통지 루프 0). dest 는 마커에 적재된 notify 좌표(요청 슬래시/도구의 channel·target).
const updateNotified = await (async (): Promise<boolean> => {
  const markerPath = path.join(getPaths().home, UPDATE_COMPLETE_MARKER);
  let raw: string;
  try {
    raw = await fsp.readFile(markerPath, "utf8");
  } catch {
    return false; // 마커 없음 = 일반 부팅 — 아래 일반 재시작 통지가 담당.
  }
  // 본문 파싱·통지 실패와 무관하게 마커는 반드시 삭제(1회성 보장).
  const unlinkMarker = async (): Promise<void> => {
    try {
      await fsp.unlink(markerPath);
    } catch {
      /* 이미 없음/권한 — 무시 */
    }
  };
  try {
    const data = JSON.parse(raw) as {
      from?: string;
      to?: string;
      changedFiles?: number;
      notify?: { channel?: string; target?: string | null };
    };
    const span =
      typeof data.from === "string" && typeof data.to === "string"
        ? ` (${data.from} → ${data.to})`
        : "";
    const files =
      typeof data.changedFiles === "number"
        ? ` · ${data.changedFiles}개 파일`
        : "";
    const text = `✅ 업데이트 완료${span}${files} — 새 버전으로 재시작했습니다.`;
    // 단일 통로 — 라우팅·발송·관측(대시보드 표시)을 deliverOutbound 가 담당(채널 미지정=cli).
    // 세션 귀속 = 기본 세션(업데이트 통지는 세션 없는 시스템 발화 → 새 세션 생성 대신
    // dashboard:default 메인 채팅에 표시). 배달은 요청자 좌표(notify) 그대로.
    await deliverOutbound({
      channel: data.notify?.channel ?? "cli",
      target: data.notify?.target ?? null,
      text,
      bus,
      observeThreadKey: DEFAULT_SESSION_ID,
    });
  } catch (e) {
    console.error(
      `self-update: 부팅 완료 통지 실패(마커는 삭제): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    await unlinkMarker();
  }
  // 마커가 있었으면(=업데이트 부팅) 통지 담당은 여기 — 아래 일반 재시작 통지는 생략.
  return true;
})();

// 매 부팅 재시작 통지 — 업데이트 통지가 없었던 부팅(=일반 /restart · 크래시 · launchd
// 자동재시작)이면 가장 최근 텔레그램 상대에게 "✅ 재시작 완료" 1회. 대상은 DB 의 최근
// 대화(설정·seed 불필요 — /restart 명령자도 최근 thread 라 자동 커버). best-effort —
// 대상 없거나(설치 직후) 발송 실패해도 부팅 무영향. v1: 디바운스 없음(크래시 루프는
// launchd/schtasks respawn 스로틀에 의존, "계속 죽는다" 신호로도 유용).
// ★사용자가 자기 reboot 스케줄로 재시작 통지를 이미 굴리면(대개 이름 들어간 개인화 문구)
// built-in 은 물러나 중복을 피한다. 그런 스케줄이 없을 때(신규 설치 등)만 built-in 이 기본
// 통지를 담당 — /restart '완료 알림' 약속을 제로 셋업으로 충족하면서 중복 0.
if (!updateNotified && !updateFailedNotified) {
  try {
    const hasRebootSchedule =
      listSchedules({ onlyEnabled: true, triggerType: "reboot" }).length > 0;
    if (!hasRebootSchedule) {
      const chatId = getMostRecentTelegramChatId();
      const text = "✅ 재시작 완료";
      // 단일 통로 — telegram 이면 발송+관측(대시보드 표시), 대상 없으면(설치 직후) cli 로 콘솔만.
      // 세션 귀속 = 기본 세션(재시작 통지 = 세션 없는 시스템 발화 → dashboard:default 표시).
      await deliverOutbound({
        channel: chatId !== null ? "telegram" : "cli",
        target: chatId,
        text,
        bus,
        observeThreadKey: DEFAULT_SESSION_ID,
      });
    }
  } catch (e) {
    console.error(
      `restart-notify: 부팅 통지 실패: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// 모델 풀 단일-provider 소프트 경고 (부팅 1회) — 폴백 그물 부재 가시화.
const poolWarn = poolDiversityWarning();
if (poolWarn !== null) console.warn(poolWarn);

// 모델 프로파일 검증 진단 (부팅 1회, ADR model-profiles (d)) — 댕글링 fallback·순환·빈 풀·
// 무효 shape 를 로그로 표면화. never-throw at boot: 경고+강등만(데몬 거부 금지). resolve-time
// cycle-guard(resolveProfileChain)가 실집행이라 여기서는 사용자 가시화가 목적.
for (const issue of diagnoseModelProfiles()) {
  console.warn(`⚠️ [model-profiles] ${issue}`);
}

console.log("tiguclaw daemon: ready");

// daemon.boot event — scheduler v1.1 reboot trigger contract §3.
// 모든 채널·plugin 이 wire 된 후 publish (race 0). reboot trigger subscribe 가
// 이미 startTrigger 시점에 박힘 (synchronous subscribe). publisher 격리는
// EventBus 의 try/catch 가 흡수 — 데몬 부팅 자체에 영향 0.
bus.publish({
  type: "daemon.boot",
  ts: Date.now(),
  payload: {
    pid: process.pid,
    channels: channels.map((c) => c.name),
    hostname: os.hostname(),
  },
});
