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
 *   named export `schedulerMcpServer` 도 외부 alt-plugin 재사용 위해 보존.
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
  getSchedule,
  listSchedules,
  recordFiring as defaultRecordFiring,
  updateSchedule,
  type ScheduleRow,
} from "../../../src/store/schedules.js";
import { runClaude } from "../../../src/core/claude.js";
import { runScheduleFiring, type RunnerDeps } from "./runner.js";
import { setSchedulerLifecycleHooks, schedulerMcpServer } from "./mcp.js";

export interface SchedulerPluginDeps {
  /** spike 시 runClaude/recordFiring mock 주입 — 데몬 정상 부팅 시 undefined. */
  runClaude?: RunnerDeps["runClaude"];
  recordFiring?: RunnerDeps["recordFiring"];
  /** cwd. 기본 process.cwd() (Phase 2 cwd_isolation 정합). */
  cwd?: string;
}

class SchedulerPlugin {
  readonly name = "scheduler";

  private bus: EventBus | null = null;
  private busUnsubscribe: (() => void) | null = null;
  private deps: SchedulerPluginDeps = {};
  private readonly crons = new Map<number, Cron>();

  /** daemon-engineer 합의 — capability 무관 옵셔널 instance method. */
  getMcpServer(): typeof schedulerMcpServer {
    return schedulerMcpServer;
  }

  /** trigger capability — loader 가 startTrigger(bus, deps) 호출. */
  async startTrigger(bus: EventBus, deps?: SchedulerPluginDeps): Promise<void> {
    this.bus = bus;
    this.deps = deps ?? {};

    // MCP add_schedule / delete_schedule → cron Map 동적 토글 hook 등록.
    setSchedulerLifecycleHooks({
      onScheduleAdded: (row) => {
        this.registerCron(row);
      },
      onScheduleDeleted: (id) => {
        this.unregisterCron(id);
      },
      // MCP update_schedule → 갱신된 row 기준 cron 재등록/해제.
      //   비활성(enabled=0) 또는 reboot → cron 객체 불필요 → unregister.
      //   활성 cron → registerCron 재실행(내부에서 기존 cron stop 후 새 row 로 재등록,
      //   갱신된 cron_expr/timezone/prompt/dest 가 발화 클로저에 반영됨).
      onScheduleUpdated: (row) => {
        if (!row.enabled || row.triggerType === "reboot") {
          this.unregisterCron(row.id);
        } else {
          this.registerCron(row);
        }
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
    for (const row of rows) {
      if (row.triggerType === "reboot") {
        rebootCount += 1;
        continue;
      }
      cronCount += 1;
      this.registerCron(row);
    }
    console.log(
      `scheduler: started, ${cronCount} active cron + ${rebootCount} active reboot schedule(s) registered`,
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
      if (row.triggerType === "reboot") return;
      this.registerCron(row);
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
        void runScheduleFiring(row, bus, {
          runClaude: this.deps.runClaude ?? defaultRunClaude,
          recordFiring: this.deps.recordFiring ?? defaultRecordFiring,
          cwd: this.deps.cwd ?? process.cwd(),
        });
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
          void runScheduleFiring(row, bus, {
            runClaude: this.deps.runClaude ?? defaultRunClaude,
            recordFiring: this.deps.recordFiring ?? defaultRecordFiring,
            cwd: this.deps.cwd ?? process.cwd(),
          });
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

  private unregisterCron(id: number): void {
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
    if (updated.triggerType === "reboot") return true;
    this.registerCron(updated);
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

// 데몬 정상 부팅 시 runClaude default — 영역 A 직접 호출.
// spike 는 deps.runClaude mock 으로 대체.
const defaultRunClaude: RunnerDeps["runClaude"] = async (input) => {
  return runClaude({
    text: input.text,
    threadKey: input.threadKey,
    channel: input.channel,
    cwd: input.cwd,
    // 워커 통지 dest forward — runner 가 채운 generic 좌표를 RegionASdkInput.notifyDest 로
    // 그대로 넘긴다(어댑터는 미독해, 워커 발사 도구만 읽음). 미지정이면 회귀 0.
    notifyDest: input.notifyDest,
  });
};

// ─── singleton instance — src/index.ts 가 enable/disable 슬래시에서 접근 ──
let instance: SchedulerPlugin | null = null;

export const getSchedulerInstance = (): SchedulerPlugin | null => instance;

export default class SchedulerPluginFactory extends SchedulerPlugin {
  constructor() {
    super();
    instance = this;
  }
}
