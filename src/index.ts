import os from "node:os";
import { extractTelegramChatId } from "./core/threadkey.js";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { CliChannel } from "./channels/cli.js";
import { TelegramChannel } from "./channels/telegram.js";
import type { Channel, MessageHandler } from "./channels/types.js";
import { initEventBus, type EventBus } from "./core/eventbus.js";
import { registerMcpServer } from "./core/mcp-registry.js";
import { expandCommand } from "./core/entry/command-registry.js";
import {
  runStopHooks,
  runUserPromptSubmitHooks,
} from "./core/entry/hook-runner.js";
import {
  collectInventory,
  formatInventoryForUser,
} from "./core/plugins/inventory.js";
import { loadPlugins } from "./core/plugins/loader.js";
import { stripInternalRuntimeScaffolding, redactSecrets } from "./core/outbound-sanitize.js";
import { route } from "./core/router.js";
import { lookupContextWindow } from "./core/llm-runtime/context-windows.js";
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
  clearSessionModelOverride,
  deleteSession,
  getMostRecentTelegramChatId,
  getSession,
  getSessionModelOverride,
  initStore,
  setSessionModelOverride,
} from "./store/sessions.js";
import {
  parseModelSpec,
  parseModelSpecList,
  specLabel,
  errorDetail,
  resolveModelSpecs,
  poolDiversityWarning,
} from "./core/llm-runtime/index.js";
import { appRoot, ensureHome, getPaths, migrateLegacyAgent } from "./core/paths.js";
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
} from "./core/worker-jobs.js";
import {
  runSelfUpdate,
  setSelfUpdateRestart,
  UPDATE_COMPLETE_MARKER,
  type SelfUpdateNotifyDest,
  type SelfUpdateResult,
} from "./core/self-update.js";
import { deliverOutbound } from "./core/outbound.js";

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

// 잔존 self-restart 예약작업 정리 (win32 only, best-effort). 직전 /restart 가 만든 1회성
// schtasks 작업이 이 부팅을 띄운 뒤 목록에 남아있으면 제거(멱등 — 없으면 no-op). 재발화는
// /sc once 라 어차피 안 하지만 죽은 작업 누적 방지. 실패해도 부팅 무중단.
cleanupSelfRestartTask();

// EventBus 부트 (channels 만들기 전 — region 측 module-level publish 안전).
const bus = initEventBus({ bufferSize: 1000 });

// 관측 이벤트 영속 sink — ring buffer 는 hot cache 로 두고 의미있는 이벤트를 DB 에 기록
// (감사·메트릭). publish() 무수정, subscriber 하나만 추가 (코어는 데이터로 확장).
startEventPersistence(bus);

const channels: Channel[] = [];

// service capability plugin 의 stop() 수집 — shutdown 이 일괄 호출(채널과 대칭).
const serviceStops: Array<{ name: string; stop: () => Promise<void> }> = [];

channels.push(new CliChannel());

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (telegramToken !== undefined && telegramToken.trim() !== "") {
  channels.push(new TelegramChannel());
} else {
  console.warn("telegram: TELEGRAM_BOT_TOKEN not set, channel disabled");
}

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
        });
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

const handler: MessageHandler = async (msg) => {
  bus.publish({
    type: "channel.message.in",
    ts: Date.now(),
    payload: {
      channel: msg.channel,
      threadKey: msg.threadKey,
      text: msg.text.slice(0, EVENT_TEXT_MAX),
    },
  });
  const trimmed = msg.text.trim();
  // V7.3 — 영역 A(LLM) 로 넘길 실효 텍스트. 사용자 정의 슬래시 매크로 매치 시
  // 확장된 prompt 로 교체 (기본 = 원본). 채널 입구 단일 지점 = LLM-agnostic.
  let effectiveText = msg.text;
  if (trimmed === "/reset") {
    const had = deleteSession(msg.channel, msg.threadKey);
    await msg.reply(
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
      await msg.reply("지금 진행 중인 백그라운드 작업이 없어요.");
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
      // 서브에이전트면 모델 티어도 표시(low/mid/high 등). 워커는 티어 없음(기본 풀).
      const tier =
        j.kind === "agent" && j.modelTier !== undefined && j.modelTier !== ""
          ? ` · ${j.modelTier}`
          : "";
      return `${icon} ${kindLabel} \`${name}\`${tier} — ${fmtElapsed(j.startedAt)}`;
    });
    await msg.reply(
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
      const current = getSessionModelOverride(msg.channel, msg.threadKey);
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
      await msg.reply(lines.join("\n"));
      return;
    }
    if (args === "reset") {
      const had = clearSessionModelOverride(msg.channel, msg.threadKey);
      await msg.reply(
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
      await msg.reply(
        `형식 오류: \`${args}\` — \`provider:model\` 형식으로 입력하세요. ` +
          "콤마로 풀(폴백 순서)도 가능합니다. provider 는 anthropic / codex / openai. " +
          "예: `anthropic:claude-sonnet-4-6` 또는 `codex:gpt-5-codex,anthropic:claude-sonnet-4-6`",
      );
      return;
    }
    // canonical 저장 — region specLabel 이 adapter→provider 복원 보장(round-trip 안전).
    // 원문이 아니라 정규화된 provider:model 풀을 저장해 router 재-parse 가 항상 성공.
    const canonical = validPool.map(specLabel).join(",");
    setSessionModelOverride(msg.channel, msg.threadKey, canonical);
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
    await msg.reply(
      `세션 모델 → \`${canonical}\`${poolNote}. 다음 turn 부터 적용.` +
        (extraLines.length === 0 ? "" : `\n${extraLines.join("\n")}`),
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
        await msg.reply("`/memo <기억할 내용>` 형태로 입력하세요.");
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
        await msg.reply(`메모리 추가됨: ${m.name} — ${m.description}`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await msg.reply(`메모리 추가 실패: ${err}`);
      }
      return;
    }

    if (cmd === "/forget") {
      if (args === "") {
        await msg.reply("`/forget <name>` 형태로 입력하세요.");
        return;
      }
      // 단일 토큰 가정 (공백 없는 name, V1 단순). 다중 토큰은 첫 토큰만 사용.
      const name = args.split(/\s+/, 1)[0] ?? args;
      try {
        const ok = deleteMemory(name);
        await msg.reply(
          ok ? `메모리 삭제됨: ${name}` : `그런 메모리가 없습니다: ${name}`,
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await msg.reply(`메모리 삭제 실패: ${err}`);
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
          await msg.reply("저장된 메모리 없음.");
        } else {
          const lines = list.map(
            (m) => `[${m.type}] ${m.name} — ${m.description}`,
          );
          await msg.reply(lines.join("\n"));
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await msg.reply(`메모리 목록 조회 실패: ${err}`);
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
            await msg.reply("등록된 스케줄 없음.");
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
            await msg.reply(lines.join("\n"));
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await msg.reply(`스케줄 목록 조회 실패: ${err}`);
        }
        return;
      }

      if (sub === "add") {
        await msg.reply(
          "`/schedule add` 는 V1 슬래시에서 미지원. 비서에게 자연어로 부탁하세요 (예: \"매일 8시에 뉴스 정리해서 텔레그램으로\"). 비서가 add_schedule MCP 도구로 등록합니다.",
        );
        return;
      }

      // 그 외 subcommand 는 id 필요
      const id = parseInt(subArgs, 10);
      if (Number.isNaN(id)) {
        await msg.reply(
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
            await msg.reply(`스케줄 삭제됨: #${id}`);
          } else {
            await msg.reply(`그런 스케줄이 없습니다: #${id}`);
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await msg.reply(`스케줄 삭제 실패: ${err}`);
        }
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const enable = sub === "enable";
        try {
          const updated = updateSchedule(id, { enabled: enable });
          if (updated === undefined) {
            await msg.reply(`그런 스케줄이 없습니다: #${id}`);
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
            await msg.reply(
              `스케줄 #${id} ${enable ? "활성화" : "비활성화"}됨.`,
            );
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await msg.reply(`스케줄 토글 실패: ${err}`);
        }
        return;
      }

      await msg.reply(
        "`/schedule <list|delete|enable|disable> [id]` — 알 수 없는 subcommand.",
      );
      return;
    }

    if (cmd === "/plugins") {
      // 인자 무 (V1). 라우터 우회 — 인벤토리 직접 조회 후 사용자 포맷으로 응답.
      try {
        const inv = await collectInventory();
        const text = formatInventoryForUser(inv);
        await msg.reply(text);
      } catch (e) {
        console.error("plugins inventory failed:", e);
        const err = e instanceof Error ? e.message : String(e);
        await msg.reply(`인벤토리 조회 실패: ${err}`);
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
        const session = getSession(msg.channel, msg.threadKey);
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

        const lines = [
          "🐂 tiguclaw 상태",
          `─ 업타임: ${uptime}`,
          `─ 이번 대화: ${convo}`,
        ];

        // 세션 override (`/model` 로 설정) — 있을 때만 표시. 풀보다 우선이므로
        // 풀 줄 위에 둬서 사용자가 "다음 turn 무엇이 도는지" 즉시 파악.
        const statusOverride = getSessionModelOverride(
          msg.channel,
          msg.threadKey,
        );
        if (statusOverride !== null) {
          lines.push(
            `─ 세션 모델 override: \`${statusOverride}\` (다음 turn 부터 — 풀 무시, \`/model reset\` 해제)`,
          );
        }

        lines.push(`─ 모델 풀: ${regionA}`);

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

        await msg.reply(lines.join("\n"));
      } catch (e) {
        console.error("status failed:", e);
        const err = e instanceof Error ? e.message : String(e);
        await msg.reply(`상태 조회 실패: ${err}`);
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
    await msg.reply(`요청이 훅에 의해 차단되었습니다: ${hookOut.blockReason ?? ""}`);
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
  const routeP = route(
    effectiveText === msg.text ? msg : { ...msg, text: effectiveText },
    { abortSignal: turnAc.signal },
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
      },
    });
  } catch (e) {
    // wall-clock 시간컷 제거(2026-06-23) 후 이 catch 는 어댑터/도구가 실제 던진 에러
    // (네트워크·모델 거부·idle abort 등)만 받는다 — 폴백 없이 끝나므로 사용자 노출 필수.
    // 콘솔엔 full 진단 — 스택·cause(undici "fetch failed" 등) 통째로 보존(운영자 로컬 경계).
    console.error("handler route failed:", e);
    // 사용자엔 redact 된 detail 노출 (사용자=운영자 단일 인격, "에러가 다 보이는 게 좋겠어").
    // 보안 불변식: errorDetail 결과는 무조건 redactSecrets 통과 후에만 reply (게이트 없음).
    // 톤은 폴백 고지(⚠️)와 통일 — 성공경로(폴백)/실패경로(이 catch) 상호배타라 중복 아님.
    // reply 자체가 또 실패해도 핸들러가 throw로 죽지 않게 격리.
    const detail = redactSecrets(errorDetail(e));
    await msg
      .reply(`⚠️ 요청 처리 중 오류가 발생했습니다:\n${detail}`)
      .catch(() => {});
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
const notifyDestFromMessage = (
  channel: string,
  threadKey: string,
): SelfUpdateNotifyDest => ({
  channel,
  target:
    channel === "telegram"
      ? (extractTelegramChatId(threadKey) ?? threadKey)
      : null,
});

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

const serializedHandler: MessageHandler = (msg) => {
  // 아웃오브밴드 /restart — enqueueThreadTurn 직렬 큐를 건너뛰고 즉시 재시작.
  // 멈춘 턴(앞 턴 미완)이 있어도 큐 무관하게 프로세스를 죽여 respawn. /restart 는 프로세스를
  // 종료하므로 인플라이트 턴과 race 없음(다른 상태변경 명령 /reset 등은 in-band 유지).
  if (msg.text.trim() === "/restart") {
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
  // 아웃오브밴드 /update — /restart 동형으로 직렬 큐를 건너뛴다(자가 업데이트가 재시작을
  // 트리거하므로 멈춘 턴에 막히면 안 됨). 위험 로직(git/npm/typecheck/롤백/재시작 판단)은
  // 전부 runSelfUpdate 안에 닫혀 LLM 무경유(원칙 #2). 재시작 트리거도 루틴 안에 있으므로
  // 핸들러는 restartDaemon 을 직접 부르지 않는다(이중 트리거 방지) — reply 만 하고 끝.
  if (msg.text.trim() === "/update") {
    void (async (): Promise<void> => {
      try {
        const r = await runSelfUpdate({
          restart: () => restartDaemon(`self-update:${msg.channel}`),
          notify: notifyDestFromMessage(msg.channel, msg.threadKey),
        });
        await msg.reply(formatSelfUpdateResult(r)).catch(() => {});
      } catch (e) {
        // runSelfUpdate 는 throw 0 설계지만 방어적으로 catch — 데몬 생존.
        const err = redactSecrets(e instanceof Error ? e.message : String(e));
        await msg.reply(`⚠️ 업데이트 처리 중 오류: ${err}`).catch(() => {});
      }
    })();
    return Promise.resolve();
  }
  return enqueueThreadTurn(msg.threadKey, () => handler(msg));
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
  try {
    await ch.start(serializedHandler);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`${ch.name} failed: ${err}`);
  }
}

// 재시작으로 중단된 백그라운드 워커를 사용자에게 정직 통지 (채널 start 후 — raw 아웃바운드).
await recoverInterruptedJobs();

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
    await deliverOutbound({
      channel: data.notify?.channel ?? "cli",
      target: data.notify?.target ?? null,
      text,
      bus,
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
if (!updateNotified) {
  try {
    const hasRebootSchedule =
      listSchedules({ onlyEnabled: true, triggerType: "reboot" }).length > 0;
    if (!hasRebootSchedule) {
      const chatId = getMostRecentTelegramChatId();
      const text = "✅ 재시작 완료";
      // 단일 통로 — telegram 이면 발송+관측(대시보드 표시), 대상 없으면(설치 직후) cli 로 콘솔만.
      await deliverOutbound({
        channel: chatId !== null ? "telegram" : "cli",
        target: chatId,
        text,
        bus,
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
