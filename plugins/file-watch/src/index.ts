/**
 * file-watch plugin entry — trigger capability (narrative §9 (viii) "외부 작성자" V2 본격 진입).
 *
 * 핵심 책임:
 *   1. 부팅 시 listWatches({onlyEnabled:true}) → 각 row 별 chokidar watcher 등록.
 *   2. add_watch MCP 호출 → mcp.ts lifecycle hook → registerWatcher 동적 등록.
 *   3. delete_watch MCP 호출 → mcp.ts lifecycle hook → unregisterWatcher 정리.
 *   4. EventBus `file-watch.toggle` subscribe — payload {id, action: enable|disable|delete}.
 *      scheduler.toggle 패턴 답습 (`plugins/scheduler/src/index.ts` 의 handleToggleEvent 동형).
 *
 * lifecycle 2 method:
 *   - startTrigger(bus, deps?) — fan-out 부팅 + bus subscribe.
 *   - stop() — chokidar 인스턴스 close + bus unsubscribe.
 *
 * MCP server 노출 — daemon-engineer 합의: capability 무관 옵셔널 instance method `getMcpServer()`.
 *
 * 외부 작성자 reference: scheduler 와 동급 — manifest 1 + lifecycle 2 + EventBus + MCP + dispatcher.
 * 자세한 가이드는 README.md.
 */
import {
  safeUnsubscribe,
  type EventBus,
  type EventBusEvent,
} from "../../../src/core/eventbus.js";
import { runClaude } from "../../../src/core/claude.js";
import {
  getWatch,
  listWatches,
  recordFiring as defaultRecordFiring,
  updateWatch,
  type WatchRow,
} from "../../../src/store/watches.js";
import { registerWatcher, unregisterWatcher, type WatcherDeps } from "./watcher.js";
import { setFileWatchLifecycleHooks, createFileWatchMcpServer } from "./mcp.js";

export interface FileWatchPluginDeps {
  /** spike 시 runClaude mock 주입 — 데몬 정상 부팅 시 undefined. */
  runClaude?: WatcherDeps["runClaude"];
  /** spike 시 recordFiring mock 주입. */
  recordFiring?: WatcherDeps["recordFiring"];
  /** cwd. 기본 process.cwd() (Phase 2 cwd_isolation 정합). */
  cwd?: string;
}

class FileWatchPlugin {
  readonly name = "file-watch";

  private bus: EventBus | null = null;
  private busUnsubscribe: (() => void) | null = null;
  private deps: FileWatchPluginDeps = {};

  /** daemon-engineer 합의 — capability 무관 옵셔널 instance method. */
  // ★매 호출 새 인스턴스 — 데몬이 턴마다 부른다(싱글턴이면 동시 턴에서 깨진다).
  getMcpServer(): ReturnType<typeof createFileWatchMcpServer> {
    return createFileWatchMcpServer();
  }

  /** trigger capability — loader 가 startTrigger(bus, deps) 호출. */
  async startTrigger(bus: EventBus, deps?: FileWatchPluginDeps): Promise<void> {
    this.bus = bus;
    this.deps = deps ?? {};

    // MCP add_watch / delete_watch → watcher Map 동적 토글 hook 등록.
    setFileWatchLifecycleHooks({
      onWatchAdded: (row) => {
        this.register(row);
      },
      onWatchDeleted: (id) => {
        unregisterWatcher(id);
      },
    });

    // EventBus `file-watch.toggle` subscribe (scheduler.toggle 동형).
    this.busUnsubscribe = bus.subscribe((event) => {
      if (event.type === "file-watch.toggle") {
        this.handleToggleEvent(event);
      }
    });

    // 부팅 시 활성 watch 모두 등록.
    const rows = listWatches({ onlyEnabled: true });
    let okCount = 0;
    for (const row of rows) {
      try {
        this.register(row);
        okCount += 1;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `file-watch: failed to register watch id=${row.id}: ${reason}`,
        );
        bus.publish({
          type: "file-watch.error",
          ts: Date.now(),
          payload: { watchId: row.id, phase: "register", error: reason },
        });
      }
    }
    console.log(`file-watch: started, ${okCount} active watch(es) registered`);
  }

  /** 단일 capability fallback — loader 가 start(bus) 만 호출하는 경우 호환. */
  async start(bus: EventBus): Promise<void> {
    await this.startTrigger(bus);
  }

  async stop(): Promise<void> {
    this.busUnsubscribe = safeUnsubscribe(this.busUnsubscribe);
    // 모든 watcher close.
    for (const row of listWatches()) {
      unregisterWatcher(row.id);
    }
    this.bus = null;
  }

  // ─── EventBus `file-watch.toggle` 처리 ───────────────────────────────────
  //   payload: { id: number, action: "enable" | "disable" | "delete" }
  // scheduler.toggle 동형 — DB enabled flag 는 슬래시 핸들러 책임, 본 plugin 은
  // watcher 객체 lifecycle 만.
  private handleToggleEvent(event: EventBusEvent): void {
    const payload = event.payload as { id?: unknown; action?: unknown };
    if (typeof payload.id !== "number" || typeof payload.action !== "string") {
      return;
    }
    const id = payload.id;
    const action = payload.action;
    if (action === "enable") {
      const row = getWatch(id);
      if (row === undefined) return;
      this.register(row);
    } else if (action === "disable" || action === "delete") {
      unregisterWatcher(id);
    }
  }

  private register(row: WatchRow): void {
    const bus = this.bus;
    if (bus === null) {
      console.warn(
        `file-watch: register(${row.id}) before startTrigger — skipping`,
      );
      return;
    }
    registerWatcher(row, bus, {
      runClaude: this.deps.runClaude ?? defaultRunClaude,
      recordFiring: this.deps.recordFiring ?? defaultRecordFiring,
      cwd: this.deps.cwd ?? process.cwd(),
    });
  }

  // ─── /watch enable/disable 외부 토글 entry (V2 슬래시 후속) ──────────────
  startWatch(id: number): boolean {
    const row = getWatch(id);
    if (row === undefined) return false;
    if (!row.enabled) {
      updateWatch(id, { enabled: true });
    }
    const updated = getWatch(id);
    if (updated === undefined) return false;
    this.register(updated);
    return true;
  }

  stopWatch(id: number): boolean {
    const row = getWatch(id);
    if (row === undefined) return false;
    if (row.enabled) {
      updateWatch(id, { enabled: false });
    }
    unregisterWatcher(id);
    return true;
  }
}

// 데몬 정상 부팅 시 runClaude default — 영역 A 직접 호출.
const defaultRunClaude: WatcherDeps["runClaude"] = async (input) => {
  return runClaude({
    text: input.text,
    threadKey: input.threadKey,
    channel: input.channel,
    cwd: input.cwd,
  });
};

// ─── singleton instance — src/index.ts 가 enable/disable 슬래시에서 접근 ──
let instance: FileWatchPlugin | null = null;

export const getFileWatchInstance = (): FileWatchPlugin | null => instance;

export default class FileWatchPluginFactory extends FileWatchPlugin {
  constructor() {
    super();
    instance = this;
  }
}
