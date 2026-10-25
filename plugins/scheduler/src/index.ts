/**
 * scheduler plugin entry — trigger capability.
 *
 * lifecycle:
 *  - startTrigger(bus, deps?) — listSchedules({onlyEnabled:true}) → 각 row 마다 new Cron(...)
 *    + Map<id, Cron> 캐시. add_schedule MCP 호출 → onScheduleAdded hook 으로 동적 등록.
 *    delete → onScheduleDeleted 로 stop+삭제.
 *    + `scheduler.toggle` EventBus subscribe (daemon-engineer 합의) — action=enable|disable|delete.
 *  - stop() — 모든 cron 객체 stop + bus unsubscribe.
 *
 * /schedule 슬래시 토글 — daemon-engineer 합의 채택: EventBus `scheduler.toggle` event publish 패턴.
 *   src/index.ts 가 `bus.publish({type:"scheduler.toggle", payload:{id, action}})` 만 호출,
 *   plugin runtime 이 본 모듈의 subscribe 핸들러로 cron lifecycle 매핑.
 *
 * MCP server 노출 — daemon-engineer 합의: capability 무관 옵셔널 instance method `getMcpServer()`.
 *   src/index.ts 가 plugin 발견 후 `inst.getMcpServer?.()` 호출 → 정적 import 회피.
 *   named export `createSchedulerMcpServer`(팩토리) 도 외부 alt-plugin 재사용 위해 보존.
 *
 * named export `startSchedule(id)`/`stopSchedule(id)` 는 외부 호환을 위해 그대로 둡니다
 *   (V2 외부 trigger plugin / alt-frontend 가 직접 호출하는 경우). daemon-engineer 의 슬래시
 *   핸들러는 EventBus 만 사용 — 본 named export 호출 0.
 *
 * spike 가 deps 주입 가능 — runClaude/recordFiring mock 으로 라이브 cron 검증.
 */
import { Cron } from "croner";
import {
  safeUnsubscribe,
  type EventBus,
  type EventBusEvent,
} from "../../../src/core/eventbus.js";
import {
  deleteSchedule,
  getSchedule,
  isTimer,
  listSchedules,
  markSchedulerAlive,
  recordFiring as defaultRecordFiring,
  schedulerLastAlive,
  updateSchedule,
  type ScheduleRow,
} from "../../../src/store/schedules.js";
import type { PluginHost } from "../../../src/core/plugins/host.js";
import { runTriggerInSession } from "../../../src/core/trigger-in-session.js";
import { mainMessageHandler } from "../../../src/core/worker-jobs.js";
import { runClaude } from "../../../src/core/claude.js";
import { attachmentSenderFor, optionsPresenterFor } from "../../../src/core/outbound.js";
import { withExternalTurn } from "../../../src/core/inflight-turns.js";
import { isInFlight, runScheduleFiring, type RunnerDeps } from "./runner.js";
import { setSchedulerLifecycleHooks, createSchedulerMcpServer } from "./mcp.js";

export interface SchedulerPluginDeps {
  /** spike 시 runClaude/recordFiring mock 주입 — 데몬 정상 부팅 시 undefined. */
  runClaude?: RunnerDeps["runClaude"];
  recordFiring?: RunnerDeps["recordFiring"];
  /** 회귀에서 배달을 모의할 때 — 데몬 정상 부팅 시 undefined(실제 배달). */
  dispatch?: RunnerDeps["dispatch"];
  /** 회귀에서 생존 박동 주기를 줄일 때 — 미지정 = 30초. */
  aliveBeatMs?: number;
  /** cwd. 기본 process.cwd() (Phase 2 cwd_isolation 정합). */
  cwd?: string;
}

/** 놓친 실행 보충 창 — 이보다 오래 지난 것은 보충하지 않는다(타이머는 지운다). */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 이만큼 넘게 지나 울리면 «늦게 실행» 표식을 싣는다(타이머의 평범한 몇 ms 지연은 늦은 게 아니다). */
const LATE_MS = 60 * 1000;
/** setTimeout 상한(2^31-1 ms ≈ 24.8일) — 그보다 먼 시각은 나눠서 기다린다. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** 살아 있음을 적는 주기 — 갑자기 죽었을 때 보충 구간의 시작이 이만큼 이르다(그 사이 시각은 «살아 있던 동안» 으로 친다). */
const ALIVE_BEAT_MS = 30_000;

class SchedulerPlugin {
  readonly name = "scheduler";

  private bus: EventBus | null = null;
  private busUnsubscribe: (() => void) | null = null;
  private deps: SchedulerPluginDeps = {};
  private readonly crons = new Map<number, Cron>();
  /** 한 번 타이머(`once`) — 울릴 시각까지 setTimeout 하나. 재시작하면 저장된 `run_at` 으로 다시 건다. */
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** 놓친 실행 보충은 시작마다 한 번 — 부팅(`daemon.boot`)과 플러그인 재시작 두 길이 있어 겹치지 않게. */
  private catchUpDone = false;
  /** 직전에 살아 있던 마지막 시각(시작할 때 읽는다) — 보충은 (이 시각, 지금] 구간의 예정 시각만 본다. null = 모름(보충 안 함). */
  private lastAlive: number | null = null;
  private aliveTimer: ReturnType<typeof setInterval> | null = null;

  /** daemon-engineer 합의 — capability 무관 옵셔널 instance method. */
  // ★매 호출 새 인스턴스 — 데몬이 턴마다 부른다(싱글턴이면 동시 턴에서 깨진다). 호스트 = 이 턴의 좌표(만든 대화를 서버가 적는다).
  getMcpServer(host?: PluginHost): ReturnType<typeof createSchedulerMcpServer> {
    return createSchedulerMcpServer(host);
  }

  /** 실행 의존성 — cron·부팅·지금 실행이 **같은 것**을 쓴다(세 곳이 각자 만들면 갈린다). */
  private firingDeps(): RunnerDeps {
    return {
      runClaude: this.deps.runClaude ?? defaultRunClaude,
      recordFiring: this.deps.recordFiring ?? defaultRecordFiring,
      cwd: this.deps.cwd ?? process.cwd(),
      ...(this.deps.dispatch !== undefined ? { dispatch: this.deps.dispatch } : {}),
    };
  }

  /** trigger capability — loader 가 startTrigger(bus, deps) 호출. */
  async startTrigger(bus: EventBus, deps?: SchedulerPluginDeps): Promise<void> {
    this.bus = bus;
    this.deps = deps ?? {};

    // MCP add_schedule / delete_schedule → cron Map 동적 토글 hook 등록.
    setSchedulerLifecycleHooks({
      onScheduleAdded: (row) => {
        this.armRow(row);
      },
      onScheduleDeleted: (id) => {
        this.unregisterCron(id);
      },
      // MCP update_schedule → 갱신된 row 기준 cron 재등록/해제.
      //   비활성(enabled=0) 또는 reboot → cron 객체 불필요 → unregister.
      //   활성 cron → registerCron 재실행(내부에서 기존 cron stop 후 새 row 로 재등록,
      //   갱신된 cron_expr/timezone/prompt/dest 가 발화 클로저에 반영됨).
      onScheduleUpdated: (row) => {
        this.armRow(row);
      },
      // MCP run_schedule → 지금 한 번. cron·reboot 과 **같은** runScheduleFiring(겹침 방지·이력 정책·목적지 그대로).
      onScheduleRunNow: (row) => {
        const live = this.bus;
        if (live === null) return "unavailable";
        if (isInFlight(row.id)) return "busy";
        console.log(`[scheduler:${row.id}] 지금 실행 요청 — '${row.label}'`);
        void runScheduleFiring(row, live, this.firingDeps());
        return "started";
      },
    });

    // daemon-engineer 합의 — `scheduler.toggle` + scheduler v1.1 `daemon.boot` subscribe.
    // 슬래시 `/schedule enable|disable|delete` 시점에 src/index.ts 가 scheduler.toggle publish.
    // daemon.boot 은 코어 `src/index.ts` 가 "tiguclaw daemon: ready" 직후 1회 publish
    // (contract `_workspace/reboot_architect_contract.md` §3).
    this.busUnsubscribe = bus.subscribe((event) => {
      if (event.type === "scheduler.toggle") {
        this.handleToggleEvent(event);
      } else if (event.type === "daemon.boot") {
        this.handleDaemonBoot();
      }
    });

    // 부팅 시 활성 schedule 분기:
    //   triggerType='cron'   → registerCron (croner 객체 생성)
    //   triggerType='reboot' → cron 객체 0 — daemon.boot subscribe 가 발화 담당
    const rows = listSchedules({ onlyEnabled: true });
    let cronCount = 0;
    let rebootCount = 0;
    let timerCount = 0;
    for (const row of rows) {
      if (row.triggerType === "reboot") {
        rebootCount += 1;
        continue;
      }
      if (isTimer(row)) {
        timerCount += 1;
        // 지난 타이머는 부팅이 끝난 뒤 울린다(아래 runBootCatchUp) — 만든 대화의 문(메인 핸들러)이 아직 없을 수 있다.
        if (row.runAt !== null && row.runAt > Date.now()) this.armTimer(row);
        continue;
      }
      cronCount += 1;
      this.registerCron(row);
    }
    this.catchUpDone = false;
    // 직전 생존 시각(보충 구간의 시작)을 읽어 둔다. ★박동은 **보충을 마친 뒤** 시작한다(`runBootCatchUp`) — 여기서 «지금» 을 적으면
    //  `daemon.boot` 전에 죽은 부팅이 다음 부팅의 보충 몫을 지운다(재검토 10-20 R1). 적기 실패는 보충만 보수적으로 만든다(스케줄은 돈다).
    try { this.lastAlive = schedulerLastAlive(); } catch { this.lastAlive = null; }
    // 부팅 중이면 `daemon.boot` 에서, 이미 떠 있는 데몬에서 플러그인만 다시 시작했으면 지금.
    if (mainMessageHandler() !== undefined) this.runBootCatchUp();
    console.log(
      `scheduler: started, ${cronCount} active cron + ${rebootCount} active reboot schedule(s) + ${timerCount} timer(s) registered`,
    );
  }

  /** 단일 capability fallback — loader 가 start(bus) 만 호출하는 경우 호환. */
  async start(bus: EventBus): Promise<void> {
    await this.startTrigger(bus);
  }

  async stop(): Promise<void> {
    this.busUnsubscribe = safeUnsubscribe(this.busUnsubscribe);
    for (const [, cron] of this.crons) {
      try {
        cron.stop();
      } catch {
        // 무시 — 이미 stop 된 cron.
      }
    }
    this.crons.clear();
    for (const [, t] of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.aliveTimer !== null) {
      clearInterval(this.aliveTimer);
      this.aliveTimer = null;
      try { markSchedulerAlive(Date.now()); } catch { /* 마지막 박동이 남는다 */ }
    }
    this.bus = null;
  }

  // ─── EventBus `scheduler.toggle` 처리 ─────────────────────────────────────
  //   payload: { id: number, action: "enable" | "disable" | "delete" }
  // daemon-engineer 합의:
  //   - enable  → DB row 읽고 registerCron (DB enabled flag 는 슬래시 핸들러가 이미 update)
  //   - disable → unregisterCron 만 (DB enabled=0 도 슬래시 핸들러 책임)
  //   - delete  → unregisterCron 만 (DB row 삭제도 슬래시 핸들러 책임)
  // 본 plugin 은 cron 객체 lifecycle 만 — DB 변경은 호출자.
  private handleToggleEvent(event: EventBusEvent): void {
    const payload = event.payload as { id?: unknown; action?: unknown };
    if (typeof payload.id !== "number" || typeof payload.action !== "string") {
      return;
    }
    const id = payload.id;
    const action = payload.action;
    if (action === "enable") {
      const row = getSchedule(id);
      if (row === undefined) return;
      // scheduler v1.1: reboot row 면 cron 객체 등록 안 함 — 다음 daemon.boot 까지 대기.
      // 사용자가 즉시 발화 원하면 V2 의 fire_reboot_schedule MCP 사용 (contract §5).
      this.armRow(row);
    } else if (action === "disable" || action === "delete") {
      this.unregisterCron(id);
    }
  }

  // ─── scheduler v1.1 — `daemon.boot` event 처리 ─────────────────────────────
  // 코어 src/index.ts 가 "tiguclaw daemon: ready" 직후 1회 publish.
  // 활성 reboot row 모두 즉시 발화 (격리 try/catch — 한 row throw 가 다른 row 막지 않음).
  // overlap inFlight 가드는 runScheduleFiring 안 — runner.ts 그대로 재사용 (cron/reboot 발화 흐름 동일).
  private handleDaemonBoot(): void {
    const bus = this.bus;
    if (bus === null) return;
    this.runBootCatchUp();
    let rebootRows: ScheduleRow[];
    try {
      // store-auth 확정 shape — listSchedules({triggerType, onlyEnabled}) AND 결합 SQL filter.
      rebootRows = listSchedules({
        onlyEnabled: true,
        triggerType: "reboot",
      });
    } catch (e) {
      console.error("scheduler: handleDaemonBoot listSchedules failed", e);
      return;
    }
    for (const row of rebootRows) {
      // 격리 try/catch — 한 row 의 발화 throw 가 다른 row 진행 막지 않음.
      try {
        void runScheduleFiring(row, bus, this.firingDeps());
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `scheduler: reboot firing failed for id=${row.id}: ${reason}`,
        );
        bus.publish({
          type: "scheduler.error",
          ts: Date.now(),
          payload: {
            scheduleId: row.id,
            phase: "reboot-fire",
            error: reason,
          },
        });
      }
    }
  }

  private registerCron(row: ScheduleRow): void {
    // 중복 등록 가드 — 기존 cron stop 후 재등록.
    this.unregisterCron(row.id);
    const bus = this.bus;
    if (bus === null) {
      console.warn(
        `scheduler: registerCron(${row.id}) before startTrigger — skipping`,
      );
      return;
    }
    try {
      const cron = new Cron(
        row.cronExpr,
        { timezone: row.timezone, paused: false },
        () => {
          void runScheduleFiring(row, bus, this.firingDeps());
        },
      );
      this.crons.set(row.id, cron);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `scheduler: failed to register cron for schedule id=${row.id}: ${reason}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "scheduler.error",
          ts: Date.now(),
          payload: {
            scheduleId: row.id,
            phase: "register",
            error: reason,
          },
        });
      }
    }
  }

  /**
   * 행 하나를 시계에 건다 — **종류 판정은 여기 한 곳**(2026-10-21). 꺼짐·reboot(=`daemon.boot` 에서만 발화) → 걸지 않음 ·
   *  타이머 → `armTimer` · cron → `registerCron`. ★종전엔 호출부마다 따로 갈랐고 추가 경로만 reboot 을 안 걸러 `new Cron('')` 이 실패해
   *  등록할 때마다 거짓 «스케줄 실행 실패» 알림이 나갔다(외부 인스턴스 보고 — id 18·19·21). 외부용 `startSchedule` 은 타이머를 cron 으로 걸었다.
   *  ★`registerCron` 안에서 조용히 돌려보내지 않는 이유: 그러면 잘못 온 타이머가 **안 걸린 채** 넘어간다.
   */
  private armRow(row: ScheduleRow): void {
    this.unregisterCron(row.id);
    if (!row.enabled || row.triggerType === "reboot") return;
    if (isTimer(row)) this.armTimer(row);
    else this.registerCron(row);
  }

  /** 꺼져 있던 동안 지난 타이머·cron 을 보충한다 — 시작마다 한 번. */
  private runBootCatchUp(): void {
    if (this.catchUpDone) return;
    this.catchUpDone = true;
    // 보충 대상을 정했으니 이제부터 «살아 있음» 을 적는다(위 R1). 멈출 때(stop)도 박동이 돌던 경우에만 적는다.
    const beat = (): void => { try { markSchedulerAlive(Date.now()); } catch { /* 다음 박동에 */ } };
    if (this.aliveTimer !== null) clearInterval(this.aliveTimer);
    this.aliveTimer = setInterval(beat, this.deps.aliveBeatMs ?? ALIVE_BEAT_MS);
    this.aliveTimer.unref?.();
    beat(); // 보충 판정은 읽어 둔 직전 값(this.lastAlive)을 쓴다 — 여기서 덮어도 된다
    let rows: ScheduleRow[];
    try {
      rows = listSchedules({ onlyEnabled: true });
    } catch (e) {
      console.error("scheduler: 놓친 실행 보충 — 목록을 못 읽었다", e);
      return;
    }
    for (const row of rows) {
      if (isTimer(row)) this.armTimer(row);
      else if (row.triggerType === "cron") this.catchUpMissed(row);
    }
  }

  /**
   * 한 번 타이머를 건다 (2026-10-20). 울릴 시각이 지났으면 바로 울린다 — 데몬이 꺼져 있던 동안 지난 것은 **24시간 안이면 늦게 한 번**,
   *  그보다 오래면 울리지 않고 지운다(설계 §5-2, 정태님 확정). setTimeout 상한(약 24.8일)을 넘는 시각은 상한마다 다시 건다.
   */
  private armTimer(row: ScheduleRow): void {
    this.unregisterCron(row.id);
    const bus = this.bus;
    if (bus === null || row.runAt === null) return;
    const now = Date.now();
    if (row.runAt < now - CATCH_UP_WINDOW_MS) {
      try { deleteSchedule(row.id); } catch { /* 다음 부팅에 다시 본다 */ }
      console.log(`[scheduler:${row.id}] 타이머 '${row.label}' — 울릴 시각(${new Date(row.runAt).toISOString()})이 24시간 넘게 지나 울리지 않고 지웠다`);
      return;
    }
    const id = row.id;
    const t = setTimeout(() => {
      this.timers.delete(id);
      const cur = getSchedule(id);
      if (cur === undefined || !cur.enabled || cur.runAt === null) return;
      if (cur.runAt > Date.now()) { this.armTimer(cur); return; } // 상한에 걸려 일찍 깼다 — 남은 만큼 다시
      const late = Date.now() - cur.runAt >= LATE_MS ? { lateFrom: cur.runAt } : undefined;
      if (late !== undefined) console.log(`[scheduler:${id}] 타이머 '${cur.label}' 늦게 울림 — 원래 시각 ${new Date(cur.runAt).toISOString()}(데몬이 꺼져 있었다)`);
      void runScheduleFiring(cur, bus, this.firingDeps(), late);
    }, Math.min(Math.max(0, row.runAt - now), MAX_TIMEOUT_MS));
    t.unref?.();
    this.timers.set(id, t);
  }

  /**
   * 꺼져 있던 동안 놓친 cron 실행을 **한 번만** 보충한다 (2026-10-20, 설계 §5-2). 기준 = 예정 시각이 **데몬이 꺼져 있던 구간**(직전 생존 시각 뒤)에
   *  있었고, 그 뒤로 돈 적이 없고(마지막 실행·만든 시각보다 뒤), 24시간 안인가. 여러 번 놓쳤어도 마지막 한 번이다.
   *  ★«마지막 기록 이후» 만 보면 `/stop` 한 실행·꺼 뒀다 켠 스케줄까지 재시작마다 다시 돌았다(적대 검토 #5·#6) — 살아 있던 동안의 시각은 놓친 게 아니다.
   */
  private catchUpMissed(row: ScheduleRow): void {
    const bus = this.bus;
    if (bus === null) return;
    let prev: Date | undefined;
    try {
      const probe = new Cron(row.cronExpr, { timezone: row.timezone, paused: true });
      prev = probe.previousRuns(1, new Date())[0];
      probe.stop();
    } catch {
      return; // 등록 실패는 registerCron 이 이미 알렸다
    }
    if (prev === undefined) return;
    const at = prev.getTime();
    if (this.lastAlive === null || at <= this.lastAlive) return; // 살아 있던 동안의 시각 — 놓친 게 아니다(모르면 보충 안 함)
    if (at <= Math.max(row.lastFiredAt ?? 0, row.createdAt)) return;
    if (Date.now() - at > CATCH_UP_WINDOW_MS) {
      console.log(`[scheduler:${row.id}] '${row.label}' 놓친 실행(${prev.toISOString()})이 24시간보다 오래돼 보충하지 않음`);
      return;
    }
    console.log(`[scheduler:${row.id}] '${row.label}' 놓친 실행 보충 — 원래 시각 ${prev.toISOString()}(데몬이 꺼져 있었다)`);
    void runScheduleFiring(row, bus, this.firingDeps(), { lateFrom: at });
  }

  private unregisterCron(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const existing = this.crons.get(id);
    if (existing === undefined) return;
    try {
      existing.stop();
    } catch {
      // 무시.
    }
    this.crons.delete(id);
  }

  // ─── /schedule enable/disable 외부 토글 entry ─────────────────────────────
  /**
   * id 의 cron 객체 등록 (DB enabled=1 update 포함).
   * scheduler v1.1: reboot row 면 cron 객체 만들지 않음 (DB enabled 만 update) — 다음 daemon.boot 까지 대기.
   */
  startSchedule(id: number): boolean {
    const row = getSchedule(id);
    if (row === undefined) return false;
    if (!row.enabled) {
      updateSchedule(id, { enabled: true });
    }
    const updated = getSchedule(id);
    if (updated === undefined) return false;
    this.armRow(updated);
    return true;
  }

  /** id 의 cron 객체 중단 (DB enabled=0 update 포함). */
  stopSchedule(id: number): boolean {
    const row = getSchedule(id);
    if (row === undefined) return false;
    if (row.enabled) {
      updateSchedule(id, { enabled: false });
    }
    this.unregisterCron(id);
    return true;
  }
}

/** 스케줄 목적지로 묶은 선택지·파일 통로 — 채널이 그 능력이 없으면 비운다(종전 동작). */
export const scheduleChannels = (
  dest: Parameters<RunnerDeps["runClaude"]>[0]["notifyDest"],
  threadKey: string,
): { presentOptions?: NonNullable<ReturnType<typeof optionsPresenterFor>>; sendAttachment?: NonNullable<ReturnType<typeof attachmentSenderFor>> } => {
  if (dest === undefined) return {};
  const presentOptions = optionsPresenterFor(dest.channel, dest.target ?? null, threadKey);
  // 파일은 답 글자(dispatch)와 같은 규칙 — 발원 세션 없이 목적지로.
  const sendAttachment = attachmentSenderFor(dest.channel, dest.target ?? null);
  return {
    ...(presentOptions !== undefined ? { presentOptions } : {}),
    ...(sendAttachment !== undefined ? { sendAttachment } : {}),
  };
};

// 데몬 정상 부팅 시 runClaude default — 영역 A 직접 호출.
// spike 는 deps.runClaude mock 으로 대체.
/**
 * **만든 대화 안에서 처리한다** (2026-10-20) — 문·좌표·차례 확인·배달은 코어 한 곳(`runTriggerInSession` — 감시와 공용).
 *  여기 남는 것은 스케줄만의 판정(«아직 유효한가»: 지워짐·꺼짐·처리 자리 바뀜)과 표식 문구뿐이다.
 */
const runInOrigin = async (input: Parameters<RunnerDeps["runClaude"]>[0], origin: string): ReturnType<RunnerDeps["runClaude"]> => {
  const run = input.triggerRun;
  if (run?.kind !== "schedule") throw new Error("스케줄 발화가 아닙니다");
  const late = run.lateFrom !== undefined ? ` · 늦게 — 원래 ${new Date(run.lateFrom).toISOString()}` : "";
  const r = await runTriggerInSession({
    origin,
    marker: `${run.once === true ? "타이머" : "스케줄"} #${run.id} 실행${late}`,
    triggerRun: run,
    label: "scheduler",
    turnOrigin: "schedule",
    // 차례가 왔을 때 **최신 행**으로 — 기다리는 사이 바뀐 지시·목적지를 쓴다(아스트라 10-20 P1). 전용 세션 줄의 Object.assign 과 같은 판단.
    atTurn: () => {
      const latest = getSchedule(run.id);
      if (latest === undefined) return "deleted";
      if (!latest.enabled) return "disabled";
      if (latest.originThreadKey !== origin) return "moved";
      // ★줄에서 기다리는 사이 예정 시각이 **미래로 바뀌었다**(2026-10-23 한도 자동 이어가기 §3.9-a) — 옛 차례로 돌지 않는다. 실행기가 새 시각에 다시 건다.
      //  «미래» 만 보면 안 된다 — 미래 타이머의 «지금 실행»(`run_schedule`)도 같은 문을 지나는데, 시각이 그대로면 미뤄진 게 아니다(GPT 검토 R1).
      if (isTimer(latest) && latest.runAt !== null && latest.runAt > Date.now() && latest.runAt !== input.slot?.firedRunAt) return "rescheduled";
      // 이 실행이 실제로 쓴 행 상태 — 실행기가 정산 기준으로 읽는다(반환값이 아니라 실행기가 만든 칸: 핸들러가 던져도 남는다).
      if (input.slot !== undefined) input.slot.turnRunAt = latest.runAt;
      return { text: latest.prompt, dest: { channel: latest.destChannel, target: latest.destTarget } };
    },
  });
  if ("skipped" in r) return { text: "", skipped: r.skipped as "deleted" | "disabled" | "moved" | "origin-gone" | "not-run" | "rescheduled" };
  return { text: "", inOrigin: r };
};

const defaultRunClaude: RunnerDeps["runClaude"] = async (input) => {
  const { originThreadKey, ...turn } = input;
  if (originThreadKey !== null && originThreadKey !== undefined) return runInOrigin(input, originThreadKey);
  // ★진행 중 턴으로 **등록**한다 (2026-09-01). 스케줄 발화는 핸들러를 우회하므로 종전엔
  //  `/health` 의 `active_turns` 에 안 잡혔고, 배포 가드가 *"진행 중 턴 0건 — 재시작 안전"*
  //  을 찍었다. 실측: 이 경로로 도는 정리 작업이 매일 20분인데 그 창 전체가 0이었다.
  //  ★`signal` 을 **실제로 넘긴다** — 종료 경로가 `ac.abort()` 를 부르므로, 안 넘기면
  //   «끊었다» 가 거짓이 된다(등록만 하고 안 끊기는 것보다 나쁘다).
  const ac = new AbortController();
  // ★줄은 실행기(`runner.ts`)가 이미 세웠다 — 이력 정책을 줄 안에서 적용하려고 거기 둔다(2026-10-14 P3). 여기서 또 서면 같은 스레드에
  //  두 번 서서 교착이다. 여기선 진행 중 등록만.
  return withExternalTurn(
    turn.threadKey,
    // 실행 채널은 scheduler지만 중단 통지는 설정된 배달 목적지로 보낸다.
    { ac, channel: turn.channel, target: null, notifyDest: turn.notifyDest },
    () =>
      runClaude({
        // ★실행기가 채운 입력을 **통째로** 넘긴다 (2026-10-02 재검토) — 필드를 골라 넘기던 때 새로 더한 발화 표식(지금 `triggerRun`)이
        //  여기서 떨어져, 실제 발화엔 «정기 스케줄 실행» 표식이 한 번도 안 붙었다(회귀는 이 파사드를 모의로 갈아 못 봤다).
        //  notifyDest(매니저 통지 좌표)·triggerRun(발화 턴 표식) 모두 실행기가 채우는 값이다.
        ...turn,
        abortSignal: ac.signal,
        // ★선택지·파일도 스케줄의 목적지로 (2026-10-01) — 이 발화는 핸들러를 우회해 채널이 주는 통로가 없어, 선택지 도구가
        //  아예 안 붙고(글로만) `send_file` 도 막혔다. 매니저 완료 보고(worker-jobs)와 같은 처방. 고른 값은 물어본 이 스레드로.
        ...scheduleChannels(turn.notifyDest, turn.threadKey),
      }),
  );
};

export default class SchedulerPluginFactory extends SchedulerPlugin {
  constructor() {
    super();
  }
}
