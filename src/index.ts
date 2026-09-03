import { formatResetAt, isRateLimited, parseCooldownMs } from "./core/llm-runtime/rate-limit.js";
import { flushEnvLoadLog } from "./core/load-env.js"; // ★가장 먼저 — 다른 모듈이 env 읽기 전 <home>/.env(레포 폴백) 로드.
import { repairRipgrepAtBoot } from "./core/ripgrep.js";
import "./core/net-config.js"; // ★네트워크 전 — IPv4 우선(IPv6 블랙홀 환경서 텔레그램 전멸 방지).
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  extractTelegramChatId,
  DEFAULT_SESSION_ID,
  setChannelSessionBindingLookup,
} from "./core/threadkey.js";
import {
  getChannelSessionBinding,
  setChannelSessionBinding,
  clearChannelSessionBinding,
  clearBindingsForSession,
  setSessionArchived,
} from "./store/channel-session.js";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type {
  Channel,
  ChannelName,
  IncomingMessage,
  MessageHandler,
} from "./channels/types.js";
import { initEventBus, type EventBus } from "./core/eventbus.js";
import { formatDurationKo } from "./core/format-duration.js";
import {
  setChannelPresence,
  type ChannelPresence,
} from "./core/channel-registry.js";
import {
  expandCommand,
  isEphemeralCommandText,
  parseSlashCommand,
} from "./core/entry/command-registry.js";
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
import { bundledPluginNames, initPluginManager, trackPlugin } from "./core/plugins/manager.js";
import { wirePlugin } from "./core/plugins/wire.js";
import {
  startSelfMaintenance,
  stopSelfMaintenance,
} from "./core/self-maintenance.js";
import { stripInternalRuntimeScaffolding, redactSecrets } from "./core/outbound-sanitize.js";
import { route } from "./core/router.js";
import {
  createSteeringChannel,
  type SteeringChannel,
  type SteeringInput,
} from "./core/steering.js";
import {
  contextPressureLabel,
  lookupContextWindow,
} from "./core/llm-runtime/context-windows.js";
import { runRegionA, resolveModelChain } from "./core/llm-runtime/index.js";
import { appVersion, appBuildId } from "./core/version.js";
import { getCodexTokenExpiry } from "./core/llm-runtime/adapters/openai-codex-oauth.js";
import {
  addMemory,
  countMemories,
  deleteMemory,
  listMemories,
  loadThreadHistory,
} from "./store/memory.js";
import {
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from "./store/schedules.js";
import {
  canonicalSessionChannel,
  clearSessionModelOverride,
  clearSessionContext,
  getMostRecentTelegramChatId,
  getSession,
  getSessionChannelMeta,
  getSessionModelOverride,
  initStore,
  setContextBoundary,
  setSessionModelOverride,
  SESSION_STORAGE_CHANNEL,
  listThreads,
  getThreadName,
  setThreadName,
  setThreadArchived,
  sessionDisplayName,
} from "./store/sessions.js";
import { getFirstUserText } from "./store/chat-log.js";
// codex/openai 컨텍스트 리셋 — `/clear` 가 claude(세션) 뿐 아니라 codex/openai 의
// 히스토리 재전송도 끊게 한다. boundary watermark(setContextBoundary, sessions.ts) = 이 ts
// 이전 턴은 재전송 안 함(getContextBoundary 는 codex/openai 어댑터가 소비). clearThreadSummary
// = codex 롤링 요약 드롭. 둘 다 store-auth contract 대로 (channel, threadKey[, ts]).
import { clearThreadSummary } from "./store/thread-summaries.js";
import {
  builtinModelProfiles,
  BUILTIN_DEFAULT_TIER,
} from "./core/llm-runtime/builtin-profiles.js";
import {
  parseModelSpec,
  parseModelSpecList,
  specLabel,
  errorDetail,
  resolveModelSpecs,
  listActiveCooldowns,
  poolDiversityWarning,
  restoreCooldowns,
  clearCooldowns,
} from "./core/llm-runtime/index.js";
import { appRoot, ensureHome, getPaths, migrateLegacyAgent } from "./core/paths.js";
import { readSystem } from "./core/identity.js";
import {
  diagnoseModelProfiles,
  loadModelProfiles,
  getDefaultProfileName,
} from "./core/settings.js";
import { renderModelProfiles } from "./core/entry/models-command.js";
import { renderProviders } from "./core/entry/providers-command.js";
import {
  hasSupervisorRespawn,
  shouldExitForRestart,
  cleanupSelfRestartTask,
} from "./core/restart.js";
import { initFileLogging, logFatal } from "./core/logging.js";
import { backupInfo } from "./store/backup.js";
import { startEventPersistence } from "./core/event-persist.js";
import {
  enqueueThreadTurn,
  registerWorkerHandler,
  recoverInterruptedJobs,
  listJobs,
  getJobActivity,
  STEERED_TURN_RESULT,
  cancelJobsForThread,
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
  shouldSuggestForThread,
  readSuggestionSettings,
  publishSuggestion,
} from "./core/next-message-suggestion.js";
import {
  setInflightTurnReporter,
  notifyInterruptedTurns,
  listExternalTurns,
} from "./core/inflight-turns.js";
import {
  registerChannelOutbound,
  getChannelOutbound,
} from "./core/channel-outbound.js";
import {
  beginChannelActivity,
  stopAllChannelActivity,
  DEFAULT_ACTIVITY_OPTIONS,
} from "./core/channel-activity.js";
import {
  egressSourcePrefix,
  resolveEgressTargets,
  type EgressTarget,
} from "./core/egress-targets.js";
import { withEgressPromptOptions } from "./core/prompt-options-egress.js";
import { readEgressChannels } from "./core/settings.js";
import { catalogModelKeys, modelCapsFor } from "./core/llm-runtime/model-catalog.js";
import { providerAuthAvailable } from "./core/llm-runtime/provider-availability.js";
import { listProviderNames } from "./core/llm-runtime/provider-registry.js";

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

// ★최후 그물은 **로그가 열리자마자** 건다 (2026-08-11 윈도우 신규 설치 실사고).
//  종전엔 이 파일 맨 아래(≈2,350행)에 등록했다 — `initStore()` 를 비롯한 **부팅 전체가
//  그물 밖**이었다. 실측: 신규 설치 기계에서 데몬이 8번 연속으로 `작동 헌법 로드` 직후
//  죽었는데 로그에 **에러가 한 줄도 없었다**. 핸들러가 없으니 node 가 스택을 console 을
//  거치지 않고 raw stderr 로 찍고, 윈도우 런처는 창을 숨겨(`sh.Run …, 0, False`) 그걸
//  버린다 → 사용자에게도 우리에게도 아무것도 안 남는다.
//  ★부류: **그물이 있다 ≠ 필요한 창에 쳐져 있다.** 가장 깨지기 쉬운 구간(부팅·첫 설치)이
//   하필 그물 밖이었다 — 잘 도는 기계에선 영영 안 보이는 종류의 구멍이다.
//
// "항상 떠있다"는 *수퍼바이저 respawn* 이 보장하는 것이지 코어가 모든 예외를 삼켜서가
// 아니다. 손상된 상태로 계속 도느니 crash-fast — 로그를 남기고 exit(1) → 깨끗이 재기동.
// (정상 경로의 턴 에러는 채널 입구 핸들러가 이미 catch·redact 해 데몬을 보존한다.)
// ★`logFatal` 을 쓴다(`console.error` 아님) — 그 미러는 **비동기 큐잉**이라 곧바로
// `process.exit(1)` 하면 큐가 통째로 버려진다. 실측: 직전 줄은 남고 **크래시 줄만 사라짐**.
process.on("unhandledRejection", (reason) => {
  logFatal("daemon: unhandledRejection — crash-fast for supervisor respawn:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logFatal("daemon: uncaughtException — crash-fast for supervisor respawn:", err);
  process.exit(1);
});

// ★env 로드 요약을 **여기서** 찍는다 (2026-08-01 A4b). load-env 는 import 부작용이라
//  위 initFileLogging 보다 먼저 돌아, 종전엔 이 줄이 데몬 로그에 영원히 안 남았다
//  (부팅 206회 중 0건). "어느 .env 를 쓰는가" 는 409 봇 충돌 사고의 전제였다.
flushEnvLoadLog();
// ★검색 도구(ripgrep) 해소 결과 — 같은 이유로 여기서 흘린다. 없으면 codex 계열 검색이
//  통째로 죽는데, 그 사실이 로그에 없으면 사용자는 "왜 못 찾지" 만 겪는다(윈도우 실측).
// ★진단에서 **조치**로 (2026-08-27). 종전엔 없어도 경고 한 줄이 전부였고, 그 줄을 볼
//  사람이 없어서 rg 없는 기계는 검색이 죽은 채 영원히 돌았다. 이제 없으면 받는다.
//  ★`void` — **기다리지 않는다.** 여기서 await 하면 사내 프록시·오프라인에서 데몬 기동이
//   그만큼 늦어진다. 다운로드가 끝나면 다음 Grep 호출이 알아서 새 경로를 집는다.
//   값도 굳히지 않는다(런타임은 첫 사용 때 다시 푼다).
void repairRipgrepAtBoot(getPaths().home);

console.log("tiguclaw daemon: starting");

// ── event-loop wedge 진단 (2026-07-03, gated: LOOP_DIAG=1) ──────────────────
// 데몬이 매니저 실행 중 응답불능(wedge)되는 원인 규명용. event-loop lag(타이머 드리프트)
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

// ★빈 헌법을 조용히 두지 않는다 (2026-08-05, 프롬프트 P2 정리와 한 쌍).
//  `readSystem()` 은 미러 실패·경로 오설정이면 **조용히 ""** 를 반환한다(turn 생존 우선).
//  종전엔 sysprompt 가 같은 규칙을 중복 진술해 헌법이 비어도 안전 규칙이 남았는데, 판단을
//  SYSTEM.md 한 곳으로 모은 지금은 **부재 = 위임·동사·확인 규칙 0** 이다. 그런데 그 상태가
//  에러 하나 없이 조용하다 — 그래서 부팅에서 한 번 소리내고 `/status` 가 계속 들고 있는다.
//  ★홈 미러를 없앤 뒤(2026-08-20) 이 경로가 실제로 밟히긴 훨씬 어렵다 — 정본은 appRoot
//   마커라 존재가 보장된다. 그래도 남긴다: 배포 누락·권한으로 못 읽는 경우가 남고, 그건
//   여전히 **조용하다**. 게이트를 없앨 이유가 아니라 덜 밟힐 이유일 뿐이다.
const constitutionBytes = Buffer.byteLength(readSystem(), "utf8");
if (constitutionBytes === 0) {
  console.error(
    `[boot] ★작동 헌법이 비었습니다 — ${getPaths().systemMd} 를 읽지 못했습니다. ` +
      `비서가 위임·동사·확인 규칙 없이 돕니다(/status 에 표시). 앱 정본 SYSTEM.md 배포를 확인하세요.`,
  );
} else {
  console.log(`작동 헌법 로드: ${constitutionBytes.toLocaleString()}B`);
}

initStore();
// 채널→세션 바인딩 조회 등록 (2026-07-28) — 코어(threadkey)가 store 를 직접 import 하지
// 않도록 부팅 시 주입한다. ★미등록이면 바인딩이 **조용히 무시**되고 전부 기본 세션으로
// 가므로(사용자는 "왜 세션이 안 바뀌지" 만 겪는다), initStore 직후 = DB 준비된 가장 이른
// 지점에 붙인다. 등록 실패는 그 자체가 기능 부재이므로 로그로 드러낸다.
try {
  setChannelSessionBindingLookup((channel, address) =>
    getChannelSessionBinding(channel, address),
  );
} catch (e) {
  console.error(
    `채널→세션 바인딩 조회 등록 실패 — /sessions 로 고른 세션이 무시됩니다: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}
// 쿨다운 복원(2026-07-28) — 메모리 Map 에만 있던 쿨다운이 재시작마다 사라져 매 부팅 직후
// 죽은 백엔드를 다시 두드렸다(실측 07-27: 부팅 22회 ↔ 429 22건). initStore 직후 = DB 준비된
// 가장 이른 지점. 실패해도 빈 상태로 진행(종전 동작).
restoreCooldowns();

// ★구독 인증은 **번들 플러그인**이 등록한다 (2026-09-01) — 여기엔 없다.
//  종전엔 `auth-providers.ts` 를 optional dynamic import 하는 코어 배선이었는데, 그러면
//  코어가 먼저 잡아(이 자리 < 플러그인 적재) 플러그인이 원리적으로 그 id 를 못 가져간다.
//  «플러그인으로 뺀다» 가 이름뿐이 되지 않으려면 등록 자체가 플러그인이어야 한다.
//  이제 Business 판이 빼는 단위는 코어 파일 하나가 아니라 **플러그인 디렉터리**다
//  (`plugins/weather/`·`plugins/map/` 를 배포에서 빼는 것과 같은, 이미 도는 기제).

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
  // ★**뿌리가 둘이다** (2026-08-28, 설치 형태). 번들은 앱과 함께 오고, 사용자가 깐 것은
  //  홈에 산다 — 그 자리(`<home>/plugins`)는 이미 부팅 때 만들어지고 인벤토리·스킬·에이전트
  //  등 다섯 곳이 이미 읽고 있었는데, **코드만 안 실리고 있었다.**
  //  ★홈이지 앱 폴더가 아닌 이유: 레포 `plugins/` 에 쓰면 `/update` 의 `git pull --ff-only`
  //   가 충돌해 **영구 업데이트 불능**이 된다([[project_self_dev_flag_gate]]).
  //  ★**번들이 이긴다.** 같은 이름이면 홈 것을 버린다 — 홈에서 코어 플러그인을 가로채는 건
  //   그 자체가 공격면이다(설치는 신뢰가 아니다).
  // ★관리자에 배선 재료를 한 번 넘긴다 — 이후 설치·켜기는 인자 없이 부른다.
  initPluginManager({ bus, channels, serviceStops });
  const bundled = await loadPlugins(path.join(appRoot(), "plugins"), bus);
  // ★**로드 성공이 아니라 이름의 존재**로 예약한다(2026-08-30, B-1). 종전엔 `bundled` 에서
  //  이름을 뽑아, 번들 하나가 깨지면 그 이름이 홈에 열렸다. 판정은 매니저가 소유한다 —
  //  설치 문도 같은 것을 부른다(같은 질문에 두 답이 있어서 난 사고다).
  const bundledNames = await bundledPluginNames();
  const homeRoot = getPaths().commonPlugins;
  const home = (await loadPlugins(homeRoot, bus)).filter((p) => {
    if (!bundledNames.has(p.manifest.name)) return true;
    console.warn(
      `[plugin-loader] 홈 플러그인 '${p.manifest.name}' 를 건너뜁니다 — 같은 이름의 번들 ` +
        `플러그인이 있습니다(번들이 이깁니다).`,
    );
    return false;
  });
  if (home.length > 0) {
    console.log(`[plugin-loader] 홈 플러그인 ${home.length}개 로드 (${homeRoot})`);
  }
  const loaded = [...bundled, ...home];
  for (const lp of loaded) {
    // ★배선은 **플러그인별로 격리**된다(`core/plugins/wire.ts`) — 하나가 kind 를 잘못
    //  선언하거나 start 에서 던져도 나머지는 그대로 붙는다. 종전엔 이 루프 본문 전체가
    //  아래 catch 하나에 묶여 있어서, 앞선 플러그인의 TypeError 가 **뒤의 전부**를
    //  미등록으로 만들 수 있었다(남는 흔적은 `loadPlugins failed:` 한 줄).
    // ★부팅 배선도 관리자에 등록한다 — 그래야 홈 것을 나중에 뺄 수 있다(런타임 제거).
    const wired = await wirePlugin(lp, { bus, channels, serviceStops });
    trackPlugin(lp, bundledNames.has(lp.manifest.name) ? "bundled" : "home", wired);
  }
} catch (e) {
  console.error("loadPlugins failed:", e);
}

// ★자기 보전 — DB 백업 + 자가 진단 (2026-08-12, 사용자: "기본적인 부분은 코어에").
//  **loadPlugins 의 try 바깥**이 자리다. 종전엔 이 둘의 시계가 self-growth 플러그인에
//  있어서, 플러그인 로드가 실패하면(로더는 조용히 skip 한다) 백업과 진단이 함께 멎었다 —
//  데이터 안전이 부가 기능에 얹혀 있었다. 위 catch 가 삼킨 뒤에도 여기는 반드시 돈다.
startSelfMaintenance(bus);

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
  // ★공용 판정을 쓴다 (2026-07-30 검토 지적) — 사본이 3곳이었고 그중 llm-runtime 만 claude
  //  문구를 고쳐서, 사용자에겐 여전히 "⚠️ 요청 처리 중 오류" + 원문 덤프가 나갔다(한도 안내·
  //  ETA 없음). 실측: `claude-agent-sdk error: You've hit your limit · resets 2:20am` 이
  //  이 정규식엔 false 였다. 주석은 "진실 통일"이라 적혀 있었는데 사실이 아니었다.
  const isLimit = isRateLimited(d);
  if (!isLimit) return `⚠️ 요청 처리 중 오류가 발생했습니다:\n${detail}`;
  const provMatch = d.match(/codex|anthropic|claude|openai|gemini|ollama/i);
  const prov = provMatch ? provMatch[0].toLowerCase() : "LLM";
  // ★리셋 시점 문구는 `formatResetAt` 한 곳에서 만든다 (2026-08-14) — 종전엔 여기와
  //  worker-jobs 가 각자 "N분 후" 를 만들어, 5.6일 한도가 `약 8118분 후` 로 나갔다.
  const cooldownMs = parseCooldownMs(d);
  const when = cooldownMs !== null ? ` ${formatResetAt(cooldownMs)}에 풀립니다.` : "";
  return (
    `⚠️ ${prov} 백엔드 사용 한도(rate limit)에 도달했습니다.${when}\n` +
    `지금 바로 쓰려면 다른 백엔드로 모델을 바꾸거나, 여러 모델 풀(예: codex + claude)로 두면 한도·장애 시 자동 폴백됩니다.`
  );
};

// 빌트인 슬래시 명령(라우터 우회·조기 return)의 응답 통로 — msg.reply 로 보내고 **channel.message.out
// 도 발행**한다. 그래야 대시보드 '작업 중' 표시가 꺼지고(활성=channel.message.in↔완료=out/turn_done),
// 명령 답도 대시보드 채팅/이력에 보인다. (2026-07-10: /status 등이 out 미발행이라 in 만 떠서 대시보드가
// 계속 '작업 중'이던 갭 — [[project_active_send_dashboard_visibility]] 동일 패턴.) 관측 발행 실패는 격리.
/**
 * `/logs` 본문 — 오늘 데몬 로그의 **마지막 N줄** (2026-07-31, 검토 지적 반영).
 *
 * ★세 가지를 동시에 지킨다.
 *  ①**전체를 메모리에 안 올린다.** 종전엔 `readFileSync` 로 파일 전량을 읽었다. dev 에 이미
 *   5.8MB 짜리가 있고 stream-trace·turn-end 는 턴마다 쌓인다 — 커지면 이벤트 루프가 멈추고
 *   V8 문자열 상한을 넘으면 throw 한다(**로그가 가장 필요한 순간에만 실패**). 끝에서
 *   512KB 한 번만 읽는다.
 *  ②**대화 본문을 안 내보낸다.** `sanitizeLogTail` 이 담당한다 — 판정 기준은 캐리어 이름이
 *   아니라 **로그 접두사 유무**다(그 모듈 주석 참조). 캐리어를 열거했다가 실로그의 주력
 *   형상(다중 줄 객체 덤프)을 통째로 놓친 적이 있다.
 *  ③**그래도 `replyCommand` 로 발행한다.** 발행을 끊었더니 대시보드에 아무것도 안 보였다
 *   — 발행이 곧 화면이다(대시보드는 `channel.message.out` 만 본다). ② 로 소독한 뒤라
 *   chat_log·events 에 적재돼도 안전하다.
 *  ④**헤더가 거짓말하지 않는다.** 종전엔 자르기 *전* 줄 수를 단언해 `/logs 200` 이 "200줄"
 *   이라 답하고 실제로는 36줄만 보였다(3500자 한도). 진단 도구가 표본 크기를 속이면
 *   "200줄 봤는데 아무 일도 없었다" 는 **틀린 결론**을 만든다 — 실제로 표시된 수를 센다.
 */
const LOG_TAIL_MAX_LINES = 200;
const LOG_TAIL_READ_BYTES = 512 * 1024; // 끝에서 이만큼만 본다(200줄에 차고도 남음).
const LOG_TAIL_REPLY_CHARS = 3500; // 채널 길이 한도.

const buildLogTail = async (argRaw: string): Promise<string> => {
  try {
    const n = Math.min(Math.max(parseInt(argRaw.trim(), 10) || 40, 1), LOG_TAIL_MAX_LINES);
    const { open, stat } = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = pathMod.join(getPaths().home, "logs", `daemon-${ymd}.log`);
    const size = (await stat(file)).size;
    const readFrom = Math.max(0, size - LOG_TAIL_READ_BYTES);
    const len = size - readFrom;
    const fh = await open(file, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, readFrom);
      chunk = buf.toString("utf8");
    } finally {
      await fh.close();
    }
    // 앞이 잘린 첫 줄은 버린다(파일 처음부터 읽은 게 아니면).
    const all = chunk.split(/\r?\n/).filter((l) => l !== "");
    const lines = (readFrom > 0 ? all.slice(1) : all).slice(-n);
    const { redactSecrets } = await import("./core/outbound-sanitize.js");
    const { sanitizeLogTail } = await import("./core/log-sanitize.js");
    const { out, dropped } = sanitizeLogTail(lines);
    const full = redactSecrets(out.join("\n"));
    // 3500자 한도로 앞에서 자른다 — 자른 뒤 **실제로 남은 줄 수**를 세서 헤더에 쓴다.
    const body = full.length > LOG_TAIL_REPLY_CHARS ? full.slice(-LOG_TAIL_REPLY_CHARS) : full;
    const truncated = body.length < full.length;
    // 잘린 첫 줄은 파편이라 버린다(헤더의 줄 수와 화면이 어긋나지 않게).
    const shown = truncated ? body.slice(body.indexOf("\n") + 1) : body;
    const shownLines = shown === "" ? 0 : shown.split("\n").length;
    return (
      `📜 ${ymd} ${shownLines}줄 표시` +
      `${truncated ? ` (요청 ${n} · 길이 한도로 ${out.length - shownLines}줄 잘림)` : ""}` +
      ` — 파일 ${Math.round(size / 1024)}KB${readFrom > 0 ? ", 끝부분만 읽음" : ""}\n` +
      `대화 본문은 생략됩니다 — 진단 수치만 표시` +
      `${dropped > 0 ? ` (본문 ${dropped}줄 제외)` : ""}.\n\n\`\`\`\n${shown}\n\`\`\``
    );
  } catch (e) {
    return `로그 읽기 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/**
 * 슬래시 명령 응답 — 그 채널로 보내고 **대화 기록에도 남긴다**(관측 발행 → chat_log·대시보드).
 *
 * ★`ephemeral` = **휘발성 안내** (2026-08-23 사용자 확정: "텔레그램 전용 휘발성이라고
 *  보면 될 것 같은데"). 보낸 채널에 한 번 보이고 **어디에도 안 남는다** — chat_log·
 *  대시보드·검색·이력 전부.
 *
 *  왜 필요한가: "이 대화방을 TE 세션에 묶었습니다" 는 *그 방*의 설정 확인이다. 세션
 *  기록에 남으면 대시보드엔 자기가 하지도 않은 조작이 대화처럼 끼어들고, 나중에 검색
 *  결과로도 나온다.
 *
 * ★이름 주의: 응답은 원래 한 채널로만 간다 — 특별한 건 "채널 전용" 이 아니라 **안
 *  남는다**는 것이다(처음엔 `channelOnly` 로 지었다가 고쳤다).
 * ★남아야 할 것엔 절대 쓰지 마라 — 대화·결과 보고는 기록이 곧 가치다.
 */
const replyCommand = async (
  msg: { reply: (t: string) => Promise<unknown>; channel: string; threadKey: string },
  text: string,
  opts?: { ephemeral?: boolean },
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
        // 발행은 한다(라이브 화면엔 보인다) — 적재만 `event-persist` 가 건너뛴다.
        ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
      },
    });
  } catch {
    /* 관측 발행 실패가 명령 응답을 무르지 않는다(원칙 3). */
  }
};

/**
 * **선택지를 띄우고 턴을 닫는다** — `presentOptions` 전용 통로 (2026-09-01 사용자 신고).
 *
 * ★신고: *"텔레그램에서 `/sessions` 실행하면 대시보드에서 계속 작업중으로 뜬다."*
 *  기제는 위 `replyCommand` 주석이 이미 적어둔 **그 부류의 재발**이다 —
 *  «활성 = `channel.message.in` ↔ 완료 = `.out`/`turn_done`» 인데, `presentOptions` 는
 *  채널 클로저라(cli=stdout · telegram=`ctx.reply`) **버스를 안 탄다.** 그래서 `in` 으로
 *  켜진 진행 표시를 끄는 이벤트가 **하나도 없다**(슬래시는 LLM 미경유라 `turn_done` 도 없다).
 *  대시보드의 15분 stale 스윕이 걷을 때까지 «작업 중» 이 남는다.
 *
 * ★2026-07-10 에 `/status` 로 같은 것을 겪고 `replyCommand` 로 닫았는데, **`presentOptions`
 *  경로는 그 통로를 안 거친다.** 부류가 닫힌 게 아니라 한 갈래만 닫혀 있었다.
 *
 * ★질문 문구를 그대로 실어 보낸다 — 사용자는 실제로 그 질문을 받았으므로 «나간 메시지» 가
 *  맞고, 라이브 대시보드에도 보이는 편이 낫다(지금은 «작업 중» 만 돌고 아무것도 안 보인다).
 *  `ephemeral` 이면 `event-persist` 가 적재만 건너뛴다(발행은 그대로 — 그 판정은 거기 한 곳).
 */
const presentAndClose = async (
  msg: {
    presentOptions?: (
      q: string,
      o: Array<{ label: string; value: string }>,
      extra?: { note?: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    channel: string;
    threadKey: string;
  },
  question: string,
  options: Array<{ label: string; value: string }>,
  extra: { note?: string },
  opts?: { ephemeral?: boolean },
): Promise<{ ok: boolean; error?: string }> => {
  if (msg.presentOptions === undefined) return { ok: false, error: "선택지 미지원 채널" };
  const r = await msg.presentOptions(question, options, extra);
  if (!r.ok) return r; // 실패면 호출부가 텍스트로 폴백하고, 그 폴백이 `replyCommand` 라 닫힌다.
  try {
    bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        text: question.slice(0, EVENT_TEXT_MAX),
        ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
      },
    });
  } catch {
    /* 관측 발행 실패가 선택지 렌더를 무르지 않는다(원칙 3). */
  }
  return r;
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
// ★2026-08-01: 값이 AbortController 하나였는데, 그러면 **누구에게 알려야 하는지**를 모른다.
//  위 "재시작 정직" 은 주석에만 있었고 실제로는 아무도 안 알렸다 — 실사고(A5): 배포 재시작이
//  진행 중이던 claude 턴을 죽였고 사용자는 그냥 답이 안 오는 걸로 겪었다(7분 무응답 신고).
//  통지 좌표를 같이 들고 다녀야 shutdown 이 정직해질 수 있다. 자매 레지스트리를 하나 더 만들면
//  둘이 어긋나므로(손목록 병) 값에 담는다.
interface InflightTurn {
  readonly ac: AbortController;
  readonly channel: ChannelName;
  readonly target: string | null;
}
const inflightTurns = new Map<string, InflightTurn>();

// 관측 심에 **Map 자신을 보는 getter** 를 꽂는다(사본 0 — inflight-turns.ts 주석 참조).
// ★직렬화 밖 턴(엔드포인트 등)까지 **합쳐서** 답한다 — 둘 중 하나만 세면 `/health` 가
//  "지금 재시작해도 안전" 이라고 거짓말한다(2026-08-01 엔드포인트 응답 유실).
setInflightTurnReporter({
  count: () => inflightTurns.size + listExternalTurns().length,
  keys: () => [...inflightTurns.keys(), ...listExternalTurns().map(([k]) => k)],
});

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
const publishInboundEcho = (
  msg: {
    synthetic?: boolean;
    channel: string;
    threadKey: string;
    text: string;
    attachments?: IncomingMessage["attachments"];
    correlationId?: string;
  },
  /** `ephemeral: true` = 발행은 하되 **적재는 안 한다**(event-persist 가 판정). */
  opts?: { ephemeral?: boolean },
): void => {
  // ★합성 턴도 **발행은 한다 — 텍스트 없이** (2026-08-13, 사용자: "매니저가 일을 끝내고
  //  메인이 정리하는 시점이 딱 빈 공간인 느낌"). 종전엔 통째로 `return` 이었다.
  //
  //  스킵의 의도는 옳았다(스캐폴딩 텍스트가 "나(user)" 버블로 새면 안 된다). 문제는 그
  //  하나의 이벤트가 **두 가지 일**을 하고 있었다는 것 — ①버블을 그린다 ②진행 표시를 켠다.
  //  버블을 막으려고 이벤트를 통째로 끄니 진행 표시까지 같이 꺼졌고, 매니저가 끝나고 메인이
  //  결과를 맥락 입혀 정리하는 **가장 긴 구간**이 화면상 완전한 공백이 됐다(사용자 버블도
  //  없고 작업중도 없고, 결과가 뜰 때까지 아무것도 안 바뀜).
  //
  //  그래서 신호를 가른다: `synthetic: true` + **text 미포함**으로 발행한다. 텍스트가 아예
  //  없으므로 순진한 소비자도 스캐폴딩을 흘릴 수 없고(막는 방식이 표식이 아니라 **부재**다
  //  — 표식은 안 보는 소비자가 뚫지만 없는 값은 못 그린다), 대시보드는 이 표식으로
  //  "그리지 말고 켜기만" 을 안다.
  const inAttachments = attachmentsMeta(msg.attachments);
  if (msg.synthetic === true) {
    bus.publish({
      type: "channel.message.in",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        synthetic: true,
        // 무엇 때문에 도는지 한 마디 — 진행 표시가 "왜" 를 같이 말할 수 있게.
        reason: "매니저·에이전트 결과 정리",
      },
    });
    return;
  }
  bus.publish({
    type: "channel.message.in",
    ts: Date.now(),
    payload: {
      channel: msg.channel,
      threadKey: msg.threadKey,
      text: msg.text.slice(0, EVENT_TEXT_MAX),
      // 휘발성 표식 — 발행은 그대로(버블 승격·진행 표시 살아있음), 적재만 안 한다.
      ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
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

/**
 * egress fan-out — 해석된 좌표로 배달. 한 채널 실패가 다른 채널·인입 응답을 무르지 않게 격리.
 *
 * ★성공 경로와 실패 경로가 **둘 다** 부른다. 종전엔 성공 경로에만 있어서, 턴이 실패하면
 *  텔레그램 쪽엔 "입력 중이더니 아무 말 없음"만 남았다(인바운드는 에러 메시지가 가는데
 *  egress 는 안 갔다 — 활동 표시가 붙으면 그 비대칭이 유령 신호가 된다).
 */
const fanOutEgress = async (
  targets: EgressTarget[],
  text: string,
  bus: EventBus,
  originThreadKey?: string,
): Promise<void> => {
  // ★**어디서 온 사본인지 말해준다** (2026-08-28). 판정은 `egressSourcePrefix` 한 곳에 있고
  //  여기선 이름만 조회해 넘긴다. 기본 세션이면 빈 문자열이라 평소 사용은 무변화다.
  //  (조회 실패는 삼킨다 — 라벨 때문에 배달이 죽으면 그게 더 나쁘다.)
  let prefix = "";
  try {
    prefix = egressSourcePrefix(originThreadKey, getThreadName(originThreadKey ?? ""));
  } catch {
    /* 이름을 못 읽으면 라벨 없이 간다 */
  }
  for (const t of targets) {
    try {
      await deliverOutbound({
        channel: t.channel,
        // 좌표는 턴 시작에 이미 해석됐다(기본 좌표까지) — 표시와 배달이 같은 값을 쓴다.
        // null 이면(해석 실패) deliverOutbound 가 한 번 더 시도한다.
        target: t.target,
        text: prefix + text,
        bus,
        // ★이 복사본도 **어느 세션이 낸 말인지**는 안다 (2026-08-11 실사고). 표시
        //  (observeThreadKey)는 그대로 두고 귀속만 싣는다 — 안 실으면 사용자가 텔레그램에서
        //  이 답에 답장했을 때 원래 세션을 못 찾아 공통 세션으로 떨어진다.
        originThreadKey,
        // ★이 배달은 **이미 인입 채널에 기록된 말의 사본**이다 — 적재는 원본 한 줄만.
        copyOfRecorded: true,
      });
    } catch (e) {
      console.error(
        `egress fan-out to "${t.channel}" failed (인입 응답은 정상):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
};

/**
 * 다음 메시지 제안 발행 — **이제 별도 LLM 호출이 없다** (2026-08-25).
 *
 * 종전엔 답을 보낸 뒤 `runRegionA` 를 한 번 더 불렀다. 실측: 그 호출의 컨텍스트 상한이
 * **39,600자(≈13~20K 토큰)** 였고 매 턴 바뀌는 대화라 프리픽스 캐시도 못 탔다. (코드
 * 주석엔 "최근 6턴 × 600자" 라고 적혀 있었는데 상수가 조용히 11배로 올라 있었다.)
 * 이제 메인 턴이 답변 꼬리에 `<next-message>` 로 같이 뱉고, 코어가 한 곳에서 뜯는다 —
 * 남은 비용은 출력 토큰 스무 개 남짓이고, 데드라인·폴백·프로파일 배관이 통째로 사라졌다.
 *
 * ★여기 남은 판단은 **보여줄 자리인가** 하나뿐이다: 파생 스레드(스케줄러·매니저·엔드포인트)
 *  는 사람이 보는 세션이 아니다. `synthetic` 검사는 **뺐다** — 사용자 지정이 바뀌었다:
 *  *"메인턴이 응답을 보낼 때마다"* (2026-08-25). 매니저 완료 정리 턴도 메인 턴이다.
 */
/**
 * 이미 경고한 프로파일 이름 — 같은 warn 을 매 턴 찍으면 배경소음이 되고, 배경소음은
 * 실제로 12일간 묻힌 적이 있다([[feedback_logs_must_stand_alone]]). 이름당 한 번만 말한다.
 */
const warnedSuggestionProfiles = new Set<string>();

const maybeSuggestNextMessage = (
  msg: IncomingMessage,
  suggestion: string | undefined,
): void => {
  try {
    if (suggestion === undefined || suggestion === "") return;
    if (!shouldSuggestForThread(msg.threadKey)) return;
    if (!readSuggestionSettings().enabled) return;
    publishSuggestion(msg.threadKey, suggestion, { elapsedMs: 0 });
  } catch (e) {
    // 제안 실패가 턴에 영향을 주면 안 된다 — 이미 답은 나갔다. 로그만(조용한 실패 금지).
    console.warn(
      `next-message-suggestion 실패(무해): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

const handler: MessageHandler = async (msg) => {
  // 내부 기원 합성 turn(매니저 done 재주입 등)은 인바운드 관측 발행을 스킵 — 합성 텍스트는
  // 내부 스캐폴딩(buildCompletionPrompt)이라 대시보드 chat_log 에 "나(user)"로 새면 안 된다.
  // 라우팅·발송 등 나머지 처리는 실 인바운드와 동일. 아웃바운드 관측은 아래 성공분기 단일 발행.
  // ★휘발성 명령은 **인바운드도** 안 남긴다 (2026-08-23 적대 검토 D-2). 종전엔 응답만
  //  건너뛰어 절반만 휘발했다 — 답은 사라지는데 명령은 남아 대화 기록에 *답 없는 명령
  //  버블*이 됐다. 판정은 `isEphemeralCommandText` 한 곳(command-registry).
  //
  // ★그런데 **발행을 끄면 안 된다** (2026-08-23 2라운드 E3). 이 이벤트는 기록만 하는 게
  //  아니라 대시보드의 낙관 버블 승격(correlationId)·진행 표시·에러 클리어까지 켠다 —
  //  통째로 끄면 사용자가 친 명령이 "대기 중" 버블로 **영구히 굳는다**(2026-07-16 `/stop`
  //  사고와 같은 기제, 바로 아래 주석이 그 사고를 적어둔 자리다). 그래서 **발행은 하고,
  //  표식만 단다** — `event-persist` 가 그 표식을 보고 적재만 건너뛴다. 안 남기는 판단은
  //  한 곳(저장 계층)에 있고, 여기선 그 성질을 말하기만 한다.
  publishInboundEcho(msg, { ephemeral: isEphemeralCommandText(msg.text) });
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
  // `/clear` — 컨텍스트 초기화. LLM-agnostic 이어야 하므로 세 어댑터를 모두 끊는다:
  // clearSessionContext(claude resume 끊기) → setContextBoundary(codex/openai 는 세션 대신 매 턴
  // 히스토리 재전송 → 이 ts 이전 턴 컷) → clearThreadSummary(codex 롤링 요약 드롭). 순서 고정.
  // 채널 무관 단일 지점(원칙 4). command-registry expandCommand(파일 매크로) 앞이라 커스텀
  // 매크로가 이 이름을 가릴 수 없다.
  //
  // ★사고와 그 뒤 (2026-08-20). 사용자 신고: "/clear 하니까 세션이 날아간다". 원인은 `/clear`
  //  가 `deleteSession` 을 불러 `threads` 행을 통째로 지운 것 — **대화 이름과 탭까지** 없앴다.
  //  근거 주석은 "이 세션의 모든 상태 초기화(사용자 결정 2026-05-28)" 였는데, 그때는 세션이
  //  하나뿐이라 지울 이름도 탭도 없었다. 멀티세션(2026-07-15)이 들어오며 같은 코드의 의미가
  //  조용히 바뀌었다 — **결정이 아니라 전제가 늙었다.**
  //  1차 수정은 `/clear`(맥락만)와 `/reset`(세션까지)로 갈랐는데, 사용자 판정은 **`/reset` 을
  //  빼자** 였다("/reset 도 /clear 랑 같은데"). 맞다 — 맥락이 다 지워지고 나면 남는 차이는
  //  이름·모델 override·탭뿐이고, 그걸 **명령 한 줄로 되돌릴 수 없게 지우는 것**은 이 레포의
  //  유지 철학(정리≠삭제)과 반대다. 대화를 치우고 싶으면 **보관**(archive)이 있다.
  if (trimmed === "/clear") {
    const had = clearSessionContext(sidChannel, msg.threadKey);
    setContextBoundary(sidChannel, msg.threadKey, Date.now());
    clearThreadSummary(sidChannel, msg.threadKey);
    await replyCommand(
      msg,
      // ★"세션은 그대로" 라고만 하면 **다음에 뭘 해야 하는지**를 안 준다 (2026-08-22 신고).
      //  실제로 세션을 없애려던 사용자가 `/clear` 를 쓰고, 안 없어지니 같은 이름으로 새로
      //  만들어 목록에 중복이 남았다. 여기가 그 갈림길이므로 대안을 같은 줄에 둔다.
      had
        ? "컨텍스트 초기화됨. 새 대화로 시작합니다 (이 대화의 이름·설정은 그대로예요).\n" +
          "세션 자체를 목록에서 없애려면 `/sessions archive` 입니다."
        : "초기화할 컨텍스트가 없습니다.",
    );
    return;
  }
  // `/agents` — 진행 중인 백그라운드 작업(매니저+서브에이전트) 요약. 채널 입구 fast-path
  // (LLM 턴 0, 즉답·무료·결정적). 서브·매니저 통합 잡 모델(kind) 기반 — listJobs 단일 소스.
  // 원칙 4: 상태 조회를 모델에게 안 시킴(원칙 1 슈퍼셋의 사용자-driven 갈래).
  if (trimmed === "/agents") {
    const running = listJobs({ runningOnly: true });
    if (running.length === 0) {
      await replyCommand(msg,"지금 진행 중인 백그라운드 작업이 없어요.");
      return;
    }
    const now = Date.now();
    // 경과 문구는 `core/format-duration` 한 곳에서 — 종전엔 여기·정체 보고·그 로그가 각자
    // 분 단위 나눗셈을 했고, 그러면 한 곳만 늙는다(`reset-time-is-readable` 가 잡으려던 바로
    // 그 부류). 시간 단위도 여기서 같이 얻는다(2시간짜리 잡이 "125분째" 로 보이던 것).
    const fmtElapsed = (startedAt: number): string => `${formatDurationKo(now - startedAt)}째`;
    // 최신 먼저(listJobs 가 startedAt 내림차순). 매니저/서브 구분 라벨.
    const lines = running.map((j) => {
      const icon = j.kind === "agent" ? "🤖" : "📦";
      const kindLabel = j.kind === "agent" ? "서브에이전트" : "매니저";
      const name = j.kind === "agent" ? (j.agentName ?? j.label) : j.label;
      // 모델 티어 표시(low/mid/high 등) — 매니저·서브 공통. modelTier 있고 default/빈값 아닐 때만.
      const tier =
        j.modelTier !== undefined &&
        j.modelTier !== "" &&
        String(j.modelTier).toLowerCase() !== "default"
          ? ` · ${j.modelTier}`
          : "";
      // ★지금 뭘 하고 있는지 한 줄 더 (2026-08-23). 점검은 조용한 잡에만 나가므로
      //  "잘 돌고 있나?" 가 궁금한 순간엔 통지가 없다 — 그때 답이 여기 있어야 한다.
      //  점검이 쓰는 것과 **같은 증거**를 읽는다(계측 중복 0).
      const act = getJobActivity(j.jobId);
      const doing =
        act === undefined
          ? ""
          : act.inFlight.length > 0
            ? `\n   └ ${act.inFlight
                .map((f) => `\`${f.tool}\` ${formatDurationKo(now - f.since)}째`)
                .join(", ")}`
            : `\n   └ 마지막 활동 ${formatDurationKo(now - act.lastActivityAt)} 전`;
      return `${icon} ${kindLabel} \`${name}\`${tier} — ${fmtElapsed(j.startedAt)}${doing}`;
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
  // (원칙 4: 모델 슬래시 처리 안 시킴).
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
        "  `/model anthropic:claude-sonnet-5`",
        "  `/model anthropic:claude-opus-5`",
        "  `/model codex:gpt-5-codex`",
        "",
        "참고: provider 는 `anthropic` / `codex` / `openai`. override 는 `/model reset` 으로 되돌립니다.",
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
          "예: `anthropic:claude-sonnet-5` 또는 `codex:gpt-5-codex,anthropic:claude-sonnet-5`",
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
    const userProfiles = loadModelProfiles();
    // ★설정이 0개면 런타임이 실제로 쓰는 것(빌트인 자동 조립)을 보여준다 (2026-08-13).
    //  종전엔 "프로파일 없음 + 레거시 env 안내"만 나와, 정작 그 순간 답하고 있는 모델을
    //  `/models` 로는 알 수 없었다(화면과 실행이 갈림).
    const builtin = Object.keys(userProfiles).length === 0;
    const profiles = builtin ? builtinModelProfiles() : userProfiles;
    const defaultName = builtin ? BUILTIN_DEFAULT_TIER : getDefaultProfileName();
    const sessionOverride = getSessionModelOverride(sidChannel, msg.threadKey);
    await replyCommand(
      msg,
      renderModelProfiles(
        profiles,
        sessionOverride,
        defaultName,
        process.env,
        builtin,
        // ★조회는 모듈에 있다 — 여기 인라인으로 두면 그 배선을 재려고 데몬을 띄워야 한다.
        modelCapsFor,
      ),
    );
    return;
  }
  // `/providers [이름] [검색어]` — 붙은 provider 와 그들이 주는 모델 (2026-09-02).
  // ★`/models`(내가 설정한 프로파일)의 짝이다. 종전엔 카탈로그를 부팅·매시 받아두고도
  //  그걸 읽는 곳이 비서의 도구뿐이라, 사용자는 «무슨 모델이 있는지» 볼 곳이 없었다.
  // ★조립은 여기, 판단은 렌더에. provider 이름을 코드에 적지 않는다 — 카탈로그 키와
  //  `listProviderNames()` 에서 파생시킨다(원칙 2: 새 provider 가 저절로 나타난다).
  if (trimmed === "/providers" || trimmed.startsWith("/providers ")) {
    const byProvider = new Map<string, string[]>();
    for (const key of catalogModelKeys()) {
      const at = key.indexOf(":");
      if (at <= 0) continue;
      const p = key.slice(0, at);
      const list = byProvider.get(p);
      if (list === undefined) byProvider.set(p, [key.slice(at + 1)]);
      else list.push(key.slice(at + 1));
    }
    // ★설정된 것 ∪ 카탈로그가 답한 것 — 설정했는데 0개인 provider 도 **보여준다**.
    //  안 보여주면 "왜 내 openrouter 가 없지" 에 답할 길이 없다(빈손이 곧 진단이다).
    const names = [...new Set([...listProviderNames(), ...byProvider.keys()])].sort();
    await replyCommand(
      msg,
      renderProviders(
        names.map((name) => ({
          name,
          models: byProvider.get(name) ?? [],
          authed: providerAuthAvailable(name),
        })),
        trimmed.slice("/providers".length),
        modelCapsFor,
      ),
    );
    return;
  }

  // 슬래시 명령은 채널 입구에서 파싱 (원칙 4 다채널 단일 인격, 원칙: 모델에게
  // 슬래시 처리 시키지 않는다). 첫 토큰 = 명령, 나머지 = args.
  if (trimmed.startsWith("/")) {
    // ★파서는 하나다 — 휘발성 판정(`isEphemeralCommandText`)이 같은 함수를 쓴다.
    //  여기서 손으로 가르면 그 판정과 갈리고, 갈리면 명령과 답 중 한쪽만 사라진다.
    const { cmd, args } = parseSlashCommand(trimmed);

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

    // ── /sessions — 채널 대화방을 어느 세션에 묶을지 (2026-07-28) ────────────────
    // 세션 셀렉터가 없는 채널(텔레그램·CLI)용. 대시보드 탭과 같은 일을 하되 **서버에**
    // 기억하므로 재시작·기기교체와 무관하게 유지된다. LLM 미경유(결정론) — 슬래시는
    // 모델에게 시키지 않는다는 기존 원칙 그대로.
    // 채널 무관: 텔레그램 전용이 아니라 channelAddress 를 가진 모든 채널에서 동작한다.
    if (cmd === "/sessions") {
      // ★휘발성 여부는 **하나의 판정**이 정한다 (2026-08-23 2라운드 E1). 인바운드 에코를
      //  건너뛰는 판단(`handler` 최상단)과 응답을 안 남기는 판단이 갈리면 **반쪽만 휘발**
      //  한다: 종전엔 `{ephemeral:true}` 가 성공 분기 둘에만 붙어 있어서, 오류 분기와
      //  대시보드가 늘 타는 선택지 분기에선 **명령은 사라지고 답만 남았다** — 고치려던
      //  버그의 거울상이다. 여기서 한 번 정하고 이 블록의 모든 응답이 그 값을 쓴다.
      const ephemeral = isEphemeralCommandText(trimmed);
      // 대화방 주소 — 바인딩(use/new)에만 필요. archive/unarchive 는 채널 무관이라
      // 아래 가드보다 먼저 처리된다(대시보드에서도 세션 정리가 돼야 한다).
      const addr = msg.channelAddress?.trim() ?? "";
      const sub = parseSlashCommand(trimmed).sub; // 같은 파서 — 판정과 갈릴 수 없다.
      const rest = args === "" ? "" : args.slice(sub.length).trim();
      const current = (() => {
        try {
          return getChannelSessionBinding(msg.channel, addr) ?? DEFAULT_SESSION_ID;
        } catch {
          return DEFAULT_SESSION_ID;
        }
      })();
      const nameOf = (id: string): string => {
        // ★**키로 한 건만 읽는다** (2026-08-24 6라운드). 5라운드엔 `includeArchived: true`
        //  로 고쳤는데 그게 `listThreads` 의 **기본 상한 100** 과 만나 같은 결함을
        //  되살렸다 — 실측: 활성 120 · 보관 5 → 복원 목록 이름 **5/5 유실**. 보관은
        //  `last_used_at` 을 안 건드리므로 활성·보관이 한 창을 두고 경쟁한다.
        //  상한을 키우는 건 답이 아니다(500 도 500에서 같은 결함을 낸다).
        //  질문이 "이 키의 이름" 이면 **키로 물어야 한다.**
        const name = getThreadName(id);
        // ★키 원문을 뱉지 않는다 — 종전엔 이름이 없으면 `dashboard:1784104932394-f791d2b408d6`
        //  가 그대로 목록에 떴다("이름 없는 세션" 의 정체). 파생 규칙은 대시보드와 공용.
        return sessionDisplayName(id, name, getFirstUserText(id));
      };

      // /sessions archive [id] — 목록에서 숨긴다. ★삭제가 아니다(대화 기록 보존, 복원 가능).
      //  인자 없으면 선택지로 고르게 한다(값 = `/sessions archive <id>`).
      if (sub === "archive" || sub === "unarchive") {
        const restoring = sub === "unarchive";
        const id = rest.trim();
        if (id !== "") {
          if (!restoring && id === DEFAULT_SESSION_ID) {
            await replyCommand(msg, "기본 세션은 보관할 수 없습니다(항상 존재하는 세션입니다).",
              { ephemeral },
            );
            return;
          }
          // ★보관 = 그 세션을 가리키는 **모든 방**의 바인딩 해제까지가 한 동작이다
          //  (2026-07-29 검토). 종전엔 명령을 보낸 방 하나만 봐서 다른 방은 목록에 없는
          //  세션에 계속 쌓았다. ★그 판단을 세 입구(명령·도구·엔드포인트)가 각자 갖고
          //  있다가 실제로 갈렸으므로(대시보드 탭 닫기 경로엔 아예 없었다) 이제 셋이
          //  `setSessionArchived` 하나를 부른다.
          const { changed, unboundRooms } = setSessionArchived(id, !restoring);
          if (changed === 0) {
            await replyCommand(msg, `그런 세션이 없습니다: ${id}`,
              { ephemeral },
            );
            return;
          }
          const note =
            unboundRooms > 0
              ? `\n그 세션에 묶여 있던 대화방 ${unboundRooms}곳을 **기본 세션**으로 되돌렸습니다.`
              : "";
          await replyCommand(
            msg,
            restoring
              ? `복원했습니다 — 목록에 다시 나옵니다.`
              : `보관했습니다 — 목록에서 숨깁니다. **대화 기록은 그대로 남아 있고** \`/sessions unarchive\` 로 되돌릴 수 있습니다.${note}`,
            { ephemeral },
          );
          return;
        }
        const pool = restoring
          ? listThreads({ excludeInternal: true, onlyArchived: true, limit: 20 })
          : listThreads({ excludeInternal: true, limit: 20 }).filter(
              (t: { threadKey: string }) => t.threadKey !== DEFAULT_SESSION_ID,
            );
        if (pool.length === 0) {
          await replyCommand(msg, restoring ? "보관된 세션이 없습니다." : "보관할 세션이 없습니다.",
            { ephemeral },
          );
          return;
        }
        const opts2 = pool.map((t: { threadKey: string }) => ({
          label: nameOf(t.threadKey),
          value: `/sessions ${sub} ${t.threadKey}`,
        }));
        const q = restoring ? "어떤 세션을 복원할까요?" : "어떤 세션을 보관할까요?";
        {
          const r = await presentAndClose(
            msg,
            q,
            opts2,
            {
              note: restoring
                ? "복원하면 목록에 다시 나옵니다."
                : "보관 = 목록에서 숨김. 대화 기록은 지우지 않습니다(되돌리기 가능).",
            },
            { ephemeral },
          );
          if (r.ok) return;
          console.warn(`/sessions ${sub} 선택지 렌더 실패 — 텍스트 폴백: ${r.error ?? "(사유 없음)"}`);
        }
        await replyCommand(
          msg,
          `${q}\n${opts2.map((o) => `· ${o.label} — \`${o.value}\``).join("\n")}`,
          { ephemeral },
        );
        return;
      }

      // ★셀렉터가 이미 있는 채널(대시보드)은 대상이 아니다. 그런 채널은 매 요청에
      //  explicitSessionId 를 실어 보내므로 바인딩이 **무시**되고(resolveSessionId 가 explicit
      //  우선), 게다가 http-bridge 는 channelAddress = threadKey 라 "세션이 자기를 가리키는"
      //  무의미한 행만 남는다(개발 중 실측). 조용히 되게 두면 "묶었습니다" 라고 답해 놓고
      //  아무 일도 안 일어난다 = 오늘 종일 고친 조용한 실패 부류. 명시적으로 거절한다.
      // ★explicit 유무가 아니라 **세션 정규화 자체**로 판정한다 (2026-07-29 검토).
      //  종전엔 explicitSessionId 가 있을 때만 거절했는데, http-bridge 는 threadKey 를 안 준
      //  요청에선 explicit 도 addr 도 없이 들어온다 → 가드를 통과해 바인딩 행을 쓰고
      //  "묶었습니다" 라 답하지만 그 채널은 바인딩을 **절대 읽지 않는다**(항상 explicit 를
      //  실어 보내므로) = 죽은 쓰기 + 거짓 확인. 심지어 그렇게 띄운 선택지를 대시보드에서
      //  누르면 이번엔 가드가 거절한다 — 자기가 띄운 걸 자기가 거절(검토 실측).
      //  기준: 세션 셀렉터를 가진 채널(session.explicitSessionId 를 쓰는 계열) 전체를 거절.
      const hasSelector =
        msg.channel === SESSION_STORAGE_CHANNEL ||
        (msg.session?.explicitSessionId !== undefined && msg.session.explicitSessionId !== "");
      if (hasSelector) {
        await replyCommand(
          msg,
          "이 채널은 이미 세션 셀렉터가 있습니다 — 대시보드 상단 탭에서 세션을 고르세요. `/sessions` 는 셀렉터가 없는 채널(텔레그램·CLI)용입니다.",
          { ephemeral },
        );
        return;
      }
      if (addr === "") {
        await replyCommand(
          msg,
          "이 채널은 대화방 주소가 없어 세션을 묶을 수 없습니다.",
          { ephemeral },
        );
        return;
      }
      // /sessions use <id> — 선택지 버튼이 돌려보내는 값이자 수동 입력 경로.
      if (sub === "use" && rest !== "") {
        const target = rest.trim();
        if (target === DEFAULT_SESSION_ID || target === "default") {
          clearChannelSessionBinding(msg.channel, addr);
          await replyCommand(msg, "이 대화방을 **기본 세션**으로 되돌렸습니다.",
            { ephemeral },
          );
          return;
        }
        // ★존재 판정에 **목록용 필터를 쓰지 않는다** (2026-07-29 검토). 표시 정책과 존재
        //  여부는 다른 질문이다 — 표시 필터로 존재를 판정하면 방금 만든 세션이 "그런 세션이
        //  없습니다" 가 된다(내 필터가 내 기능을 막았다). 그 표시 필터(excludeProbes)는
        //  2026-08-09 에 폐지됐지만, **판단 분리 자체는 유효하다**(보관은 아직 숨긴다).
        //  보관된 세션도 존재는 한다(복원 대상) → includeArchived.
        const exists = listThreads({ excludeInternal: true, includeArchived: true, limit: 500 }).some(
          (x: { threadKey: string }) => x.threadKey === target,
        );
        if (!exists) {
          await replyCommand(
            msg,
            `그런 세션이 없습니다: ${target}\n\`/sessions\` 로 목록을 확인하세요.`,
            { ephemeral },
          );
          return;
        }
        setChannelSessionBinding(msg.channel, addr, target);
        // 이 방의 설정 확인 — 휘발성(그 채널에 한 번 보이고 안 남는다).
        await replyCommand(
          msg,
          `이 대화방을 **${nameOf(target)}** 세션에 묶었습니다. 앞으로 이 방의 대화는 그 세션에 쌓입니다(재시작해도 유지).`,
          { ephemeral },
        );
        return;
      }

      // /sessions new [이름] — 새 세션 생성 + 즉시 바인딩(텔레그램만 쓰는 경우의 유일한 생성 수단).
      if (sub === "new") {
        // id 형식은 대시보드 새 탭과 동일(`dashboard:<uuid>`). 접두는 채널 참조가 아니라
        // ADR 이 명시한 **opaque 레거시 물리 키** 라, 같은 네임스페이스를 쓰는 게 맞다.
        const sid = `dashboard:${randomUUID()}`;
        setChannelSessionBinding(msg.channel, addr, sid);
        const wanted = rest.trim();
        // ★이름을 안 줘도 행을 만든다 (2026-07-29). 종전엔 이름이 있을 때만 setThreadName 이
        //  placeholder 를 만들어서, 무명 new 는 threads 행이 아예 없었다 → 목록에도 안 뜨고
        //  보관도 "그런 세션이 없습니다". 만든 즉시 다룰 수 있어야 만든 것이다.
        //  이름 없으면 번호식 기본명을 준다(대시보드 "세션N" 관례와 같은 의도).
        const finalName = wanted !== "" ? wanted : `세션 ${new Date().toLocaleDateString("ko-KR")}`;
        {
          try {
            setThreadName(sid, finalName); // 행이 없으면 placeholder 를 만들어 이름 보존.
          } catch (e) {
            console.warn(
              `세션 이름 저장 실패(세션은 생성됨): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        // 같은 부류 — 바인딩 확인이지 대화가 아니다. 휘발성.
        await replyCommand(
          msg,
          `새 세션 **${finalName}** 을 만들고 이 대화방을 묶었습니다.`,
          { ephemeral },
        );
        return;
      }

      // 인자 없음 — 현재 세션 + 선택지. 선택 UI 가 없는 채널(값 미지원)엔 목록 텍스트로 폴백.
      //
      // ★**이름 붙인 세션만** 뿌린다 (2026-08-22 사용자 신고: "대시보드엔 안 뜨는 애들이
      //  텔레그램엔 뜬다. 대시보드가 맞다"). 대시보드 탭은 `shouldAutoOpenTab` =
      //  `name` 이 있는 것만 여는데 여기는 전부 뿌려서, 이름을 안 붙인 세션이 **첫 발화
      //  파생 라벨**로 끼었다(`#VoxelBuilder 깃풀…` 처럼 태그로 시작하면 아예 무의미하다).
      //  같은 질문("어느 세션에 묶을까")에 두 화면이 다른 답을 주고 있었다.
      //
      // ★2026-08-09 에 폐지한 "짧은 대화 숨기기" 와는 다른 규칙이다. 그건 **길이**로
      //  추측해서 갓 시작한 진짜 대화를 지웠다. 이건 **사용자가 이름을 붙였는가** — 의도의
      //  표현이지 추측이 아니다. 대시보드가 이미 그 규칙으로 돌고 사용자가 맞다고 했다.
      //
      // ★현재 세션은 이름이 없어도 **항상 남긴다** — 지금 어디 묶여 있는지는 보여야 한다.
      // ★숨긴 개수는 **말한다**(아래 note). 조용히 접히면 사용자는 없어진 줄 안다.
      const allThreads = listThreads({ excludeInternal: true });
      const threads = allThreads
        .filter(
          (t: { threadKey: string; name?: string | null }) =>
            (t.name ?? "").trim() !== "" || t.threadKey === current,
        )
        .slice(0, 20);
      const hiddenCount = allThreads.length - threads.length;
      const options = [
        // ★기본 세션도 **이름 규칙을 그대로 탄다**(2026-08-19 사용자 신고: "기본세션은
        //  텔레그램에서 바뀐 이름이 안 나오고 계속 기본 세션으로 나온다").
        //  여기만 문자열이 박혀 있어서, 같은 화면의 헤더는 `nameOf(current)` 로 "공통" 을
        //  보여주는데 **첫 버튼만 "기본 세션"** 이었다 — 한 목록에서 두 규칙이 돌았다.
        //  `sessionDisplayName` 은 이미 "사용자 지정 > 고정 라벨" 순서라(2026-08-07 에 바로
        //  이 부류로 한 번 고쳤다), 규칙을 부르기만 하면 이름을 안 붙였을 때 "기본 세션" 도
        //  그대로 나온다. 라벨을 손으로 적는 순간 규칙 밖으로 나간다.
        {
          label: `${nameOf(DEFAULT_SESSION_ID)}${current === DEFAULT_SESSION_ID ? " ✅" : ""}`,
          value: `/sessions use ${DEFAULT_SESSION_ID}`,
        },
        ...threads
          .filter((t: { threadKey: string }) => t.threadKey !== DEFAULT_SESSION_ID)
          .map((t: { threadKey: string }) => ({
            label: `${nameOf(t.threadKey)}${t.threadKey === current ? " ✅" : ""}`,
            value: `/sessions use ${t.threadKey}`,
          })),
      ];
      const header = `현재 세션: **${nameOf(current)}**`;
      // ★잘린 것을 **말한다** — 조용히 접히면 사용자는 세션이 사라진 줄 안다. 되찾는 법도
      //  같이 준다(이름을 붙이면 목록에 올라온다 = 대시보드 탭 규칙과 동일).
      //  ★안내는 **실재하는 수단만** 적는다. `/sessions` 하위명령은 `use|new|archive|
      //   unarchive` 뿐이고 `rename` 은 없다 — 이름 붙이기는 대시보드나 자연어(비서에게
      //   말하기)로 한다. 없는 명령을 적으면 사용자가 그걸 치고 막힌다.
      const hiddenNote =
        hiddenCount > 0
          ? `\n이름 없는 세션 ${hiddenCount}개는 숨겼어요 — 이름을 붙이면 나옵니다("이 세션 이름 …로 해줘").`
          : "";
      if (msg.presentOptions !== undefined && options.length > 1) {
        // ★정리 수단을 **여기서** 알려준다 (2026-08-22 사용자 신고). 종전엔 `new` 만 적혀
        //  있어서, 안 쓰는 세션을 없애려던 사용자가 `/clear` 로 갔다 — 그건 컨텍스트만
        //  지우고 세션은 남긴다("이름·설정은 그대로예요"). 그래서 같은 이름을 다시 만들어
        //  **목록에 같은 이름이 둘** 남았다. 능력(`archive`)은 있었는데 닿을 길이 없었다.
        //  목록을 보는 그 순간이 정리하고 싶어지는 순간이므로, 안내도 그 자리에 둔다.
        const r = await presentAndClose(
          msg,
          "이 대화방을 어느 세션에 묶을까요?",
          options,
          {
            note:
              `${header}\n새로 만들기 \`/sessions new [이름]\` · 목록에서 숨기기 \`/sessions archive\`` +
              hiddenNote,
          },
          { ephemeral },
        );
        if (r.ok) return;
        // 렌더 실패 — 조용히 넘기지 않고 텍스트로 폴백(선택지가 사라지는 사고 방지).
        console.warn(`/sessions 선택지 렌더 실패 — 텍스트 폴백: ${r.error ?? "(사유 없음)"}`);
      }
      const lines = options.map((o) => `· ${o.label} — \`${o.value}\``);
      await replyCommand(
        msg,
        `${header}\n\n${lines.join("\n")}\n\n새로 만들기: \`/sessions new [이름]\`` +
          ` · 목록에서 숨기기: \`/sessions archive\`${hiddenNote}`,
        { ephemeral },
      );
      return;
    }

    // ── /cooldown — 백엔드 쿨다운 조회·해제 (2026-07-28) ─────────────────────────
    // 쿨다운은 "호출 성공 시" 풀리는데 쿨다운 중엔 그 백엔드를 안 부르므로 스스로는 안 풀린다.
    // 재인증·요금제 변경처럼 **전제가 바뀐 경우**를 위한 명시적 해제 수단(LLM 미경유).
    // 수동 압축 (2026-07-29) — /clear 가 "다 버림"이면 이건 "요약해서 보존".
    // 자동 압축과 같은 경로·같은 규칙(최근 턴은 안 접는다). codex 히스토리 전용 —
    // claude/openai 는 SDK 가 자기 컨텍스트를 관리하므로 대상이 아니다(정직 고지).
    if (cmd === "/compact") {
      const { compactThreadNow } = await import(
        "./core/llm-runtime/adapters/openai-codex-oauth-history.js"
      );
      const { resolveCodexModel } = await import(
        "./core/llm-runtime/adapters/openai-codex-oauth.js"
      );
      const { ensureFreshAccessToken, extractAccountId } = await import(
        "./core/llm-runtime/adapters/openai-codex-oauth-auth.js"
      );
      try {
        const token = await ensureFreshAccessToken();
        const r = await compactThreadNow(
          msg.channel,
          msg.threadKey,
          resolveCodexModel(),
          token,
          extractAccountId(token),
        );
        await replyCommand(
          msg,
          r.ok
            ? `🗜 압축했습니다 — 이전 ${r.foldedTurns}턴을 요약으로 접었습니다 ` +
              `(${r.foldedChars.toLocaleString()}자 → ${r.summaryChars.toLocaleString()}자).\n` +
              `최근 대화는 원문 그대로 유지됩니다.`
            : `압축하지 않았습니다 — ${r.reason}`,
        );
      } catch (e) {
        await replyCommand(
          msg,
          `압축 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }

    if (cmd === "/cooldown") {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const target = args.trim().slice(sub.length).trim();
      if (sub === "clear") {
        const cleared = clearCooldowns(target === "" ? undefined : target);
        await replyCommand(
          msg,
          cleared.length === 0
            ? target === ""
              ? "해제할 쿨다운이 없습니다."
              : `'${target}' 로 시작하는 쿨다운이 없습니다.`
            : `쿨다운 해제: ${cleared.join(", ")}\n다음 턴부터 그 백엔드를 다시 시도합니다.`,
        );
        return;
      }
      const live = listActiveCooldowns();
      if (live.length === 0) {
        await replyCommand(msg, "쿨다운 중인 백엔드가 없습니다.");
        return;
      }
      const lines = live.map((c) => {
        const mins = Math.round(c.remainingMs / 60000);
        const when = new Date(Date.now() + c.remainingMs).toLocaleString("ko-KR");
        return `· ${c.key} — ${mins >= 120 ? `${Math.round(mins / 60)}시간` : `${mins}분`} 남음 (해제 ${when})`;
      });
      await replyCommand(
        msg,
        `쿨다운 중인 백엔드:\n${lines.join("\n")}\n\n` +
          "재인증했거나 한도가 풀렸으면 `/cooldown clear` 로 즉시 해제하세요(대상 지정: `/cooldown clear codex`).",
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
            // 컨텍스트 압박 경고 — 판정은 `context-windows.ts` 가 소유한다(회귀 대상).
            const warn = contextPressureLabel(pct);
            convo = `${session.model} · 컨텍스트 ~${pct}%${warn} (입력 ${fmtTok(inTok)} / ${fmtTok(win)})`;
          } else {
            convo = `${session.model} · 컨텍스트 입력 ${fmtTok(inTok)} (윈도우 미상)`;
          }
        }

        const lines = [
          "🐂 tiguclaw 상태",
          // 빌드 식별자 — "업데이트를 받았나" 를 한 줄로 가르는 유일한 수단(버전은 마일스톤
          // 에서만 오르므로 같은 v0.15.0 이 30커밋 차이일 수 있다).
          // ★낡은 빌드 경고는 뺐다 (2026-08-02 사용자 판단) — **독자가 행동할 수 없는 말**이라서다.
          //  이 데몬은 개발 대상이면서 동시에 사용자의 실사용 비서라, 소스를 고치는 동안 격차가
          //  상시 생긴다. 사용자에겐 할 일이 없는 경고가 매번 뜬다(배경소음). 원래 막던 사고
          //  ("업데이트가 조용히 반영 안 됨")는 `/update` 쪽에 그물이 있다 — typecheck 게이트 →
          //  자동 롤백 → 실패 통지(위임 실행은 마커파일로 재가동 후 통지, selfupdate-rollback-safety).
          //  해시는 남긴다: 평소엔 조용하고 **사고 때** "어느 코드가 도는가" 에 답하는 유일한 값이다.
          `─ 버전: v${appVersion()}${appBuildId() !== "" ? ` · 빌드 ${appBuildId()}` : ""}`,
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

        // ★작동 헌법 부재 — 있을 때만 표시(0이면 생략, 배경소음 금지). 판단 규칙을 SYSTEM.md
        //  한 곳으로 모은 뒤로 **부재 = 위임·동사·확인 규칙 0** 인데 그 상태가 조용해서,
        //  부팅 로그와 함께 여기에도 든다(사용자가 조치할 수 있는 사실이다).
        if (Buffer.byteLength(readSystem(), "utf8") === 0) {
          lines.push(
            `─ ⚠️ 작동 헌법을 읽지 못했습니다 (${getPaths().systemMd}) — 판단 규칙 없이 도는 중입니다`,
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

        // ★백업은 **밀지 않고 여기서 보여준다** (2026-08-11 사용자 결정) — 매일 성공
        //  알림은 배경 소음이 되고 그러면 진짜 신호가 묻힌다. 알림은 놓치면 끝이지만
        //  `/status` 는 궁금할 때 언제나 있다.
        try {
          const b = backupInfo();
          if (b.latestAt === null) {
            lines.push("─ ⚠️ 백업: 아직 없음");
          } else {
            const mins = Math.floor((Date.now() - b.latestAt) / 60_000);
            const ago = mins < 60 ? `${mins}분 전` : `${Math.floor(mins / 60)}시간 전`;
            const mb = (b.totalBytes / 1_048_576).toFixed(0);
            const stale = mins > 48 * 60 ? "⚠️ " : "";
            lines.push(`─ ${stale}백업: ${ago} · ${b.count}벌 (${mb}MB)`);
          }
        } catch {
          /* 이 줄만 생략 — 상태 조회 전체를 무르지 않는다 */
        }

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
  // /stop 이 찾아 abort 하고, shutdown 이 중단 통지를 보낼 수 있게 등록(좌표 포함).
  const turnEntry: InflightTurn = {
    ac: turnAc,
    channel: msg.channel,
    target: msg.channelAddress ?? null,
  };
  inflightTurns.set(msg.threadKey, turnEntry);
  // ── egress 활동 표시 (2026-08-10) ──────────────────────────────────────────
  // "이 답도 함께 보낼" 채널에, 답이 나가기 전부터 "작업 중" 신호를 준다(텔레그램
  // "입력 중…"). 좌표는 여기서 한 번 풀어 fan-out 까지 그대로 쓴다.
  // ★표시 정책(지연 시작·주기·좌표별 refcount·상한)은 전부 core/channel-activity.ts —
  //  여기선 "켠다/끈다"만. egressChannels 없으면 배열이 비어 전부 no-op(회귀 0).
  // ★egress 채널 = **서버 설정**(전역) ∪ 이 메시지가 실어온 것.
  //  종전엔 브라우저가 매 전송에 실어보내는 것뿐이라, 서버가 스스로 만드는 발화
  //  (매니저 완료 재주입·스케줄·파일감시)는 사용자가 켠 걸 몰라 fan-out 을 못 탔다.
  //  실사고(2026-08-10): 몇 시간짜리 매니저 완료가 텔레그램으로 안 왔다 — 정작 그
  //  자리에 없을 확률이 가장 높은 경우다. 설정을 서버에 두니 **모든 발화가 같은 규칙**
  //  을 얻는다(합성 메시지에 플래그를 일일이 실어 나르는 배관이 아니라).
  // ★**보내는 쪽이 끌 수 있다** (2026-09-02 정태님: *"아직 텔레그램에 [probe:cache]
  //  메시지가 온다"*). 위 합집합은 «서버가 만드는 발화도 fan-out 을 타게» 하려고 넣은
  //  것인데, 그 대가로 **끌 방법이 사라졌다** — 설정에 telegram 이 있으면 프로그램이
  //  띄운 턴까지 전부 사용자 폰으로 간다(오늘 하루 내 프로브가 그렇게 울렸다).
  //  ★한 방향만 연다: `noEgress` 는 **덜 보내는** 쪽이라 안전하다(더 보내게는 못 한다).
  //   같은 규범이 오늘 플러그인 `readOnly` 에도 있다 — 조이는 건 되고 푸는 건 안 된다.
  //  ★자동 판정(이름·접두사로 «기계 세션» 을 가려내기)은 **하지 않는다**: 그건 손목록이고,
  //   무엇보다 스케줄 실패 알림처럼 **정말 가야 하는 것**을 조용히 막을 수 있다.
  //   보내는 쪽이 자기 의도를 안다.
  const egressFromSettings = msg.noEgress === true ? [] : readEgressChannels();
  const egressUnion =
    msg.noEgress === true
      ? []
      : [...new Set([...(msg.egressChannels ?? []), ...egressFromSettings])];
  const egressTargets = await resolveEgressTargets({ ...msg, egressChannels: egressUnion }, {
    getOutbound: getChannelOutbound,
    getSessionMeta: (threadKey) =>
      getSessionChannelMeta(SESSION_STORAGE_CHANNEL, threadKey),
  });
  const activityReleases = egressTargets
    // 좌표를 못 푼 채널은 표시하지 않는다 — 어디에 띄울지 모르는데 띄울 수 없다.
    .filter((t) => t.outbound.signalActivity !== undefined && t.target !== null)
    .map((t) =>
      beginChannelActivity(
        `${t.channel}:${t.target ?? ""}`,
        () => {
          // 표시 실패는 삼킨다 — 신호일 뿐이고, 여기서 던지면 턴이 죽는다.
          void t.outbound.signalActivity?.(t.target).catch(() => {});
        },
        DEFAULT_ACTIVITY_OPTIONS,
      ),
    );
  const releaseActivity = (): void => {
    for (const release of activityReleases) release();
  };
  // ── mid-turn 질문도 egress 를 탄다 (2026-08-12) ────────────────────────────
  // 답이 가는 곳이면 질문도 간다. 종전엔 선택지가 **인입 채널 클로저 하나**뿐이라,
  // 대시보드에서 시킨 작업 도중 뜬 질문이 텔레그램엔 영영 안 갔다(사용자 보고).
  // 정책·폴백은 전부 core/prompt-options-egress.ts — 여기선 좌표와 배달 통로만 준다.
  const presentOptionsForTurn = withEgressPromptOptions(
    msg.presentOptions,
    egressTargets,
    {
      deliverText: async (t, text) => {
        await deliverOutbound({
          channel: t.channel,
          target: t.target,
          text,
          bus,
          originThreadKey: msg.threadKey,
        });
      },
      // 답이 돌아와야 할 자리 = 물어본 세션. 채널이 보기와 함께 들고 있다가 실어준다.
      originThreadKey: msg.threadKey,
    },
  );
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
  // 채워 보내면 route 가 인입을 canonical 세션으로 정규화한다. 미지정(스케줄러·매니저 재주입·
  // 서브에이전트·엔드포인트 등 내부 파생 turn)이면 forward 안 함 = 현행 passthrough(회귀 0).
  const routeP = route(
    {
      ...msg,
      ...(effectiveText === msg.text ? {} : { text: effectiveText }),
      // egress 가 없으면 이 값은 msg.presentOptions **그 자체**다(래핑 0 = 회귀 0).
      ...(presentOptionsForTurn !== undefined
        ? { presentOptions: presentOptionsForTurn }
        : {}),
      // egress 가 없으면 이 값은 msg.presentOptions **그 자체**다(래핑 0 = 회귀 0).

    },
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
    // egress fan-out — 해석해 둔 좌표로(위 턴 시작). 실패 경로도 같은 헬퍼를 쓴다.
    await fanOutEgress(egressTargets, replyText, bus, msg.threadKey);
    // 다음 메시지 제안 — 답을 보낸 **뒤** 발사하고 기다리지 않는다(턴을 늦추지 않는다).
    maybeSuggestNextMessage(msg, out.nextSuggestion);
  } catch (e) {
    // 사용자 /stop 으로 중단된 턴 — 에러 아님. /stop 이 이미 안내·out 발행했으므로 조용히 종료
    // (에러 메시지 이중 발신 방지). turnAc.signal.reason 으로 판별(어댑터가 뭘 throw 하든 무관).
    if (
      turnAc.signal.aborted &&
      turnAc.signal.reason instanceof UserCancelledError
    ) {
      // egress 에도 알린다 — 활동 표시만 떴다 사라지고 아무 말이 없으면 유령이다.
      await fanOutEgress(egressTargets, "🛑 진행 중이던 작업을 중지했어요.", bus, msg.threadKey);
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
      await fanOutEgress(egressTargets, "🛑 진행 중이던 작업을 중지했어요.", bus, msg.threadKey);
      return;
    }
    // wall-clock 시간컷 제거(2026-06-23) 후 이 catch 는 어댑터/도구가 실제 던진 에러
    // (네트워크·모델 거부·idle abort 등)만 받는다 — 폴백 없이 끝나므로 사용자 노출 필수.
    // 콘솔엔 full 진단 — 스택·cause(undici "fetch failed" 등) 통째로 보존(운영자 로컬 경계).
    // ★채널·스레드 병기 (2026-07-30) — 종전엔 스택은 다 있는데 **누구 턴이 죽었는지**가
    //  없어 로그만으로 역추적이 안 됐다(바로 위 관측 발행은 둘 다 쓰고 있었다).
    console.error(
      `handler route failed (channel=${msg.channel} thread=${msg.threadKey}):`,
      e,
    );
    // 사용자엔 redact 된 detail 노출 (사용자=운영자 단일 인격, "에러가 다 보이는 게 좋겠어").
    // 보안 불변식: errorDetail 결과는 무조건 redactSecrets 통과 후에만 reply (게이트 없음).
    // 톤은 폴백 고지(⚠️)와 통일 — 성공경로(폴백)/실패경로(이 catch) 상호배타라 중복 아님.
    // reply 자체가 또 실패해도 핸들러가 throw로 죽지 않게 격리.
    const detail = redactSecrets(errorDetail(e));
    // 에러 응답도 replyCommand 로 — 실패 턴에서도 대시보드 '작업 중'이 꺼지고(out 발행) 에러가
    // 대시보드 채팅에 보인다. (성공 경로는 923+929 에서 이미 발행하므로 중복 없음 — 상호배타.)
    await replyCommand(msg, formatRegionAError(detail));
    // 성공 경로와 대칭 — 실패도 egress 로 나간다(유령 신호 방지, fanOutEgress 주석 참조).
    await fanOutEgress(egressTargets, formatRegionAError(detail), bus, msg.threadKey);
  } finally {
    // 활동 표시 해제 — 마지막 참조일 때만 실제로 멈춘다(좌표 단위 refcount).
    releaseActivity();
    // 등록 해제 — 단, 그 사이 새 턴이 덮어썼으면(직렬 큐라 이론상 없지만 방어) 건드리지 않음.
    if (inflightTurns.get(msg.threadKey) === turnEntry) {
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
      //
      // ★단, 그 "손실 0" 은 **어댑터가 안 쓴 입력을 buffer 에 남겨줄 때만** 참이다
      //  (2026-08-11 실사고). codex·openai 는 `drain()` 으로 당겨 쓰니 저절로 성립하지만,
      //  claude 는 `stream()` 이 도착 즉시 **꺼내간다** — 그래서 마지막 model-call 이후
      //  도착분이 SDK 새 턴으로 들어갔다가 턴 경계 가드에 버려지고, 여기 drain 은 빈 배열
      //  이라 재주입도 안 돼 **사용자 메시지가 통째로 증발**했다. 지금은 claude 쪽
      //  `steeringContents` 가 턴 종료 후 받은 입력을 push 로 되돌려 놓아 전제를 복원한다.
      //  ★새 stream 소비형 어댑터를 붙일 때 같은 책임을 진다(회귀 steering-leftover-recovered).
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

// 백그라운드 매니저 — thread 별 turn 직렬 큐로 채널 핸들러 래핑 (architect §4, W-I4).
// 현 핸들러엔 turn 직렬화 락이 없어, 매니저 완료-turn 재주입이 유저 interim 메시지와 같은
// thread 의 세션 resume 을 동시에 건드리면 race. enqueueThreadTurn(threadKey, …) 가
// threadKey 별로 직렬화(전역 락 아님 — 다른 thread 병렬). 같은 thread 단일 스트림인
// 일반 동작은 회귀 0(앞 turn 없으면 즉시 실행). 매니저 완료 재주입(onWorkerComplete)도
// 같은 큐에 합류해 race 0.
// ── 재시작 단일 진실 소스 ────────────────────────────────────────────────
// 텔레그램 /restart(B)·대시보드 버튼(A, control.restart)·자가업데이트(/update·도구) 모두
// 이 한 곳으로 수렴 — 한 곳을 고치면 일괄 적용. 파괴적 작업이라 명시 트리거로만 호출.
//
// 재시작은 **graceful exit 하나**로 끝난다 — 세 OS 다 supervisor 가 되살린다:
//  mac = launchd KeepAlive · linux = systemd Restart=always ·
//  win32 = 예약작업 KeepAlive(감독자 프로세스 + 1분 반복 트리거, 2026-08-22).
//
// ★종전엔 윈도우만 갈래가 따로 있었다 — 죽기 직전에 자기를 되살릴 예약작업을 **그 자리에서
//  만들어야** 했고, 그 자리가 세 번 다른 이유로 터진 끝에 Defender 가 그 패턴(런타임 작업
//  생성 + ping 지연 + 숨김 스크립트)을 악성으로 막았다. 재기동 책임을 죽는 쪽에서 **살아
//  있는 쪽**(감독자)으로 옮기자 그 갈래가 통째로 사라졌다. 여기서 코드가 줄어든 게 그 결과다.
// 재시작 완료 알림은 reboot 스케줄(id=3)이 부팅 후 자동 발화.
const restartDaemon = (source: string): boolean => {
  // ★재기동이 보장될 때만 죽는다 (2026-08-15). "spawn 실패해도 최소한 종료는 보장" 이라는
  //  종전 근거가 **거꾸로**였다: supervisor 가 있으면 확실한 종료가 곧 확실한 재기동이지만,
  //  없으면 **확실한 사망**이다. 이 가드가 08-22 Defender 차단 때 데몬을 살렸다.
  //  supervisor 를 아는 플랫폼(mac·linux·win)에선 참 — 모르는 플랫폼에서만 죽지 않는다.
  const respawnArranged = hasSupervisorRespawn();
  if (!shouldExitForRestart({ platform: process.platform, respawnArranged })) {
    // 안 죽는다. 재시작이 안 된 건 눈에 보이지만, 사라진 건 안 보인다.
    console.error(
      `daemon: 재시작 **중단** (${source}) — 재기동 수단을 확보하지 못했고 이 OS(${process.platform})엔 ` +
        `supervisor 가 없다. 지금 종료하면 자동으로 다시 뜨지 않는다. 데몬은 그대로 유지한다.`,
    );
    return false;
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
    // 동기 기록 — 바로 아래 exit(0)이 비동기 큐를 버린다(위 crash 핸들러와 같은 이유).
    logFatal("daemon: graceful shutdown 지연 — force exit");
    process.exit(0);
  }, 1500).unref();
  return true;
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
//    /clear·/model 등은 큐로) → steering 대상 아님.
//  - 합성(synthetic) turn(매니저 완료 재주입 등)은 사용자 메시지가 아니고 자체 프롬프트를 turn 으로
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
  // 종료하므로 인플라이트 턴과 race 없음(다른 상태변경 명령 /clear 등은 in-band 유지).
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
        if (restartDaemon(`telegram:${msg.channel}`)) return;
        // ★재시작을 중단했으면 **말한다**. 안 그러면 "곧 재시작합니다" 만 남고 아무 일도
        //  안 일어나 사용자가 먹통으로 오해한다(이번 사고의 사용자 체감이 정확히 그것).
        void msg
          .reply(
            "🔴 재시작을 중단했습니다 — 재기동 수단(예약작업)을 확보하지 못했어요.\n" +
              "이 OS 엔 자동 재기동(supervisor)이 없어서, 지금 껐다면 다시 안 떴을 겁니다. " +
              "데몬은 그대로 살아 있으니 하던 대화는 이어서 하시면 됩니다. 로그(`/logs`)에 원인이 남아 있어요.",
          )
          .catch(() => {});
      });
    return Promise.resolve();
  }
  // ─── 아웃오브밴드 `/logs` · `/diagnose` — 진단은 큐를 타면 안 된다 ─────────────
  //  ★검토 지적(2026-07-31): 이 둘을 in-band 로 뒀더니 **직렬 큐 뒤에 섰다.** 턴이 멈춰
  //   있을 때 쓰라고 만든 도구가 정확히 그때 같이 막힌다 — "진단 수단이 진단 대상에
  //   의존하면 안 된다" 를 커밋 메시지에 써놓고 배관을 안 봤다. /restart·/stop 과 동형으로
  //   큐를 건너뛴다.
  //  ★노출 가드: 로그에는 **다른 세션의 대화 조각**(`tail:` 서술)·chatId·절대경로가 들어간다.
  //   redactSecrets 는 env 값·토큰 패턴만 지우므로 그것만으론 부족하다. 대화 본문 캐리어를
  //   따로 지우고, 관측 발행(chat_log·events 영구 적재)도 하지 않는다.
  if (msg.text.trim().split(/\s+/)[0] === "/logs") {
    publishInboundEcho(msg);
    return (async (): Promise<void> => {
      const text = await buildLogTail(msg.text.trim().slice(5));
    // ★replyCommand 로 발행한다 — 발행이 곧 화면이다(대시보드는 channel.message.out 만
    //  본다). 직접 reply 로 바꿨더니 대시보드에서 아무것도 안 보였다(실측).
    //  적재해도 안전한 이유: sanitizeLogTail 이 대화 본문·chatId·raw 를 이미 지웠고,
    //  남는 건 시각·모듈·수치뿐이다.
    //
    // ★**await 한다**(fire-and-forget 금지). `void (async …)()` 로 띄우고 즉시 return
    //  했더니 http-bridge 의 동기 요청/응답이 답보다 먼저 끝나 **`replyText: ""`** 였다
    //  (실측 — 배포 직후 라이브에서 발각). out-of-band 의 목적은 *직렬 큐를 안 타는 것*
    //  이지 *답을 안 기다리는 것*이 아니다. 이 작업은 512KB 상한 파일 읽기라 짧다.
    //  (`/diagnose` 는 최대 2분이라 fire-and-forget 이 맞다 — 먼저 "진단 중" 을 보낸다.)
      await replyCommand(msg, text).catch(() => {});
    })();
  }
  if (msg.text.trim() === "/diagnose") {
    publishInboundEcho(msg);
    void (async (): Promise<void> => {
      await replyCommand(msg, "🔬 codex 요청 무게 A/B 진단 중… (최대 2분)").catch(
        () => {},
      );
      let out: string;
      try {
        const { runCodexWeightProbe } = await import(
          "./core/llm-runtime/codex-weight-probe.js"
        );
        const r = await runCodexWeightProbe();
        out = `${r.lines.join("\n")}\n\n→ ${r.verdict}`;
      } catch (e) {
        out = `진단 실패: ${e instanceof Error ? e.message : String(e)}`;
      }
      await replyCommand(msg, out).catch(() => {});
    })();
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
      const entry = inflightTurns.get(msg.threadKey);
      if (entry !== undefined && !entry.ac.signal.aborted) {
        entry.ac.abort(new UserCancelledError());
        // ★그 턴이 띄운 잡도 같이 끊는다 (2026-08-19). 종전엔 턴의 AbortController 만
        //  abort 해서, 서브에이전트·매니저 잡은 **계속 돌았다** — 사용자는 "중단했습니다" 를
        //  받는데 모델 호출은 자기 상한(WORKER_TIMEOUT_MS)까지 이어진다. 잡↔잡 전파는 이미 있었고
        //  (cancelDescendants) **세션 → 잡** 방향만 비어 있었다.
        //  ★몇 개를 끊었는지 말한다 — 조용한 조치는 사용자가 확인할 방법이 없다.
        const stopped = cancelJobsForThread(msg.threadKey);
        await replyCommand(
          msg,
          stopped > 0
            ? `⏹️ 진행 중이던 작업을 중단했습니다(백그라운드 작업 ${stopped}건 포함). 이어서 새로 말씀하시면 그걸로 진행할게요.`
            : "⏹️ 진행 중이던 작업을 중단했습니다. 이어서 새로 말씀하시면 그걸로 진행할게요.",
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
  // 이미 out-of-band 처리됐고, 여기 도달한 슬래시(예 /clear·/model 등 in-band 명령)는 steerable
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
  console.log(
    `tiguclaw daemon: received ${signal}, shutting down (진행 중 턴 ${inflightTurns.size + listExternalTurns().length}건)`,
  );
  // ★진행 중이던 메인 턴에 **정직 통지** (2026-08-01 A5, 실사고).
  //  종전엔 레지스트리 주석만 "재시작 정직" 이라고 적혀 있었고 알리는 코드는 없었다. 그래서
  //  배포 재시작이 사용자 턴을 죽였을 때 사용자는 **그냥 답이 안 오는 것**으로 겪었다
  //  (00:10:42 질문 → 00:13:22 재시작 → 7분 뒤 "응답이 없다" 신고).
  //  매니저 잡은 이미 부팅 복구가 "데몬 재시작으로 중단" 을 통지한다(recoverInterruptedJobs).
  //  메인 턴만 없었다 — 그 비대칭을 없앤다.
  //  ★채널 stop() **전에** 해야 한다(아래에서 채널이 닫히면 발송 경로가 사라진다).
  //  발송 실패는 삼킨다 — 통지 실패가 종료를 막으면 안 된다(force-exit 백스톱 1500ms).
  const allInflight = [
    ...[...inflightTurns.entries()].map(([k, v]) => [k, v] as const),
    ...listExternalTurns().map(([k, v]) => [k, v] as const),
  ];
  if (allInflight.length > 0) {
    const keys = allInflight.map(([k]) => k);
    console.log(`daemon: 진행 중 턴 ${keys.length}건 중단 통지 — ${keys.join(", ")}`);
    // ★통지보다 먼저 **기록**을 남긴다 (2026-08-01 두 번째 실사고).
    //  통지는 채널이 있어야 닿는다 — 엔드포인트·게이트웨이 호출은 이미 죽은 HTTP 연결이라
    //  아무도 못 받는다. 그런데 그 호출들은 **경계(iteration close·turn_done) 전에** 죽으면
    //  이벤트가 하나도 발행되지 않아 DB 에 흔적이 0 이었다 — 나중에 "왜 답이 없었나" 를
    //  DB 로도 못 밝혔다. 실패했는데 *아무것도* 안 보이는 형상. 통지가 닿든 안 닿든
    //  `llm.turn_error` 는 남긴다(SKIP_TYPES 밖이라 영속된다).
    for (const [key, t] of allInflight) {
      try {
        bus.publish({
          type: "llm.turn_error",
          ts: Date.now(),
          payload: {
            threadKey: key,
            channel: t.channel,
            error: `데몬 재시작(${signal})으로 중단 — 생성 중이던 응답은 남지 않았습니다.`,
            reason: "daemon-restart",
          },
        });
      } catch (e) {
        console.error(`daemon: 중단 기록 실패(${key}): ${String(e)}`);
      }
    }
    const n = await notifyInterruptedTurns(
      allInflight.map(([, v]) => v),
      deliverOutbound,
      (channel, reason) => console.error(`daemon: 중단 통지 실패(${channel}): ${reason}`),
    );
    console.log(`daemon: 중단 기록 ${keys.length}건 · 통지 ${n}/${keys.length}건 성공.`);
  }
  // 자기 보전 시계 정지 — 종료 중에 백업·진단이 새로 시작되지 않게(타이머·구독 누수 0).
  stopSelfMaintenance();
  // ★자식 프로세스 정리를 **맨 앞으로** (2026-07-28). 종전엔 채널·서비스 정지가 끝난 뒤에야
  //  외부 MCP·백그라운드 셸을 정리했는데, 그 앞단이 1500ms force-exit 백스톱을 넘기면
  //  자식 정리에 **도달하지 못했다**(실측 2건: 종료 시작 2초 뒤 force exit, 사이에 자식
  //  정리 로그 없음). 채널·서비스는 소켓이라 프로세스가 죽으면 OS 가 회수하지만, 자식
  //  프로세스는 우리가 안 죽이면 영구 고아다(외부 MCP 는 부팅 reaper 도 없음).
  //  → 되돌릴 수 없는 것(고아)을 먼저, 저절로 회수되는 것(소켓)을 나중에.
  // 활동 표시 타이머 정리 — 소켓과 달리 OS 가 회수해 주지 않고, 남으면 graceful
  // shutdown 의 이벤트 루프가 안 비어 force exit 로 밀린다. 동기·무해.
  stopAllChannelActivity();
  try {
    const { closeAllExternalMcp } = await import("./core/external-mcp.js");
    await closeAllExternalMcp();
  } catch (e) {
    console.error(
      `external-mcp close failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // ★await 필수 — killAllBgShells 가 async(내부 process.kill/taskkill)라 시그널 발송이
  //  실제로 끝나야 한다. killTree(그룹 전체)라 손자까지 함께 정리된다.
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
  // (자식 정리는 위로 옮겼다 — force-exit 백스톱에 잘리지 않게. 아래 exit 훅이 최후 그물.)
  process.exit(0);
};

// (최후 그물 = 자식을 spawn 하는 모듈이 자기 exit 훅을 등록한다 — file-ops-mcp.ts 의
//  백그라운드 셸, external-mcp.ts 의 stdio 자식. 소유자가 정리한다 = index 가 캡처할
//  static import 를 늘리지 않고, 자식이 없는 런타임엔 훅도 안 걸린다.)

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// 최후 그물은 **파일 로깅 직후**(≈200행)로 옮겼다 — 부팅 구간이 그물 밖이던 것을 닫는다
// (2026-08-11). 데몬이 재기동됐는데 로그에 원인이 없으면 `/logs` 로도 못 본다.

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

// 재시작으로 중단된 백그라운드 매니저를 사용자에게 정직 통지 (채널 start 후 — raw 아웃바운드).
await recoverInterruptedJobs();

// 백그라운드 셸(file-ops run_in_background) 부팅 reaper — ADR 2026-07-17 §4, Unit 1
// Phase 1. `recoverInterruptedJobs` 와 동형 위치·논리: 이전 세대(재시작 전 데몬)가 띄운
// detached 셸이 `daemon:restart`(kickstart -k) 잡그룹 이탈·hard-kill·크래시·전원상실로
// 살아남았을 수 있는 고아를 PID 재사용 신원검증 후 정리한다(killAllBgShells 의 graceful
// 경로가 못 미친 나머지 절반). never-throw(내부 완전 격리) — await 실패해도 부팅 불가 X.
// 통지 없음(셸은 사용자 통지 대상 아님, ADR §4 — 매니저와 달리 조용히 reap). 사용자 turn 처리
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
      notify?: { channel?: string; target?: string | null };
    };
    // ★사용자에게 커밋 해시·파일 수를 보이지 않는다 (2026-07-27) — 알아도 할 게 없는
    //  내부 좌표다. 진단이 필요하면 로그·`/status` 가 있다.
    // ★마커의 from/to 로 "받은 게 있었나"를 판정하지 말 것 (2026-07-28). 마커의 존재
    //  자체가 이미 "받았다"를 뜻한다 — 받을 게 없으면 self-update.ts 의 up-to-date 가
    //  early return 해 마커를 안 쓴다(요청자에겐 그 자리에서 동기 응답). 게다가
    //  win32+built 는 pull 을 마친 뒤 CLI 에 위임하므로 CLI 가 뜨는 prevSha 는 이미 새
    //  커밋 = from===to 가 항상 참 → 그걸로 분기하면 윈도우의 정상 업데이트가 전부
    //  "이미 최신" 으로 오보된다(실측). 조건 없이 완료로 보고한다.
    const text = "✅ 업데이트 완료 — 새 버전으로 재시작했습니다.";
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
