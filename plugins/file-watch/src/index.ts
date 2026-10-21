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
import { runExternalTurn } from "../../../src/core/external-turn.js";
import type { WorkerNotifyDest } from "../../../src/core/worker-jobs.js";
import type { PluginHost } from "../../../src/core/plugins/host.js";
import {
  getWatch,
  listWatches,
  recordFiring as defaultRecordFiring,
  recordWatchRun,
  updateWatch,
  watchRunTimes,
  type WatchRow,
} from "../../../src/store/watches.js";
import { applyRunHistory } from "../../../src/store/thread-reset.js";
import { canonicalSessionChannel } from "../../../src/store/sessions.js";
import { runTriggerInSession } from "../../../src/core/trigger-in-session.js";
import { registerWatcher, substitutePrompt, unregisterWatcher, type WatcherDeps } from "./watcher.js";
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
  getMcpServer(host?: PluginHost): ReturnType<typeof createFileWatchMcpServer> {
    // ★호스트를 넘긴다 — 감시를 «만든 대화» 로 적는 기준이 그 턴의 좌표다(2026-10-20).
    return createFileWatchMcpServer(host);
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
      // 발화 때 최신 행(처리 자리·프롬프트·목적지) — update_watch 가 재시작 없이 먹게(레드팀 10-20 P-1).
      latestRow: getWatch,
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

/**
 * 이력 정책 — **스레드 줄 안에서 발화 직전에** 적용한다(스케줄 실행기와 같은 이유: 줄 앞 턴이 이어가기를 되살리면 «매번 새로» 가
 * 사라진다). 정책은 발화 때 새로 읽는다(설정=데이터). 못 적용해도 발화는 한다(이력이 길 뿐 결과는 나간다).
 * 반환 = 로그 한 줄에 실을 설명 — 로그만 보고 «이 실행이 무엇을 보고 판단했나» 를 가를 수 있게.
 * ★한계(«직전 N회»): 발화 기록이 N개 쌓이기 전엔 프롬프트 머리 일치로 대신하는데, 감시 지시는 `{path}` 를 치환해 저장되므로 머리에
 *  `{path}` 가 있으면 이전 실행을 못 찾는다 → 덜 자른다(기억을 과하게 버리지 않는 쪽이지만 N회 제한을 정확히 지킨 것은 아니다).
 *  기록이 N개 쌓이면 저절로 정확해진다. «매번 새로»(0)는 발화 시각을 안 봐서 이 한계와 무관하다.
 */
const applyWatchHistory = (row: WatchRow, threadKey: string): string => {
  const watchId = row.id;
  if (row.keepRuns === null) return "이어감(keep_runs 없음 — 이전 실행 대화를 그대로 봄)";
  try {
    const applied = applyRunHistory(
      canonicalSessionChannel(threadKey, "file-watch"),
      threadKey,
      row.prompt,
      row.keepRuns,
      Date.now(),
      (limit) => watchRunTimes(watchId, limit),
    );
    // ★`null` 의 원인은 둘이다 — 발화 기록이 N회에 못 미침 · 계산한 경계가 이미 있는 경계보다 앞(예: «매번 새로» 였다가 «직전 N회» 로
    //  바꾼 직후 — 경계는 앞으로만 간다). 어느 쪽인지 여기선 모르니 **단정하지 않는다**(아스트라 10-19 보완 1).
    if (applied === null) return `직전 ${row.keepRuns}회 — 이력 경계 변경 없음(기록 부족 또는 기존 경계 유지)`;
    const at = new Date(applied.boundary).toISOString();
    return applied.source === "fresh"
      ? `매번 새로 — ${at} 이전을 끊음`
      : `직전 ${applied.kept}회만 남기고 ${at} 이전을 끊음(발화 시각 출처: ${applied.source === "log" ? "발화 기록" : "프롬프트 일치 — 기록이 아직 모자람"})`;
  } catch (e) {
    return `적용 실패 — 이어서 발화: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/**
 * **만든 대화 안에서 처리한다** (2026-10-20 정태님) — 문·좌표·차례 확인·배달은 코어 한 곳(`runTriggerInSession` — 스케줄 타이머와 공용).
 *  여기 남는 것은 감시만의 판정(«아직 유효한가»: 지워짐·꺼짐·처리 자리 바뀜)과 결과 모양 맞추기뿐이다.
 */
const runInOrigin = async (
  input: Parameters<WatcherDeps["runClaude"]>[0],
  origin: string,
): ReturnType<WatcherDeps["runClaude"]> => {
  const run = input.triggerRun;
  if (run.kind !== "watch") throw new Error("파일 감시 발화가 아닙니다");
  const watchId = run.id;
  const r = await runTriggerInSession({
    origin,
    marker: `파일 감시 #${watchId} 실행 · ${run.event} ${run.path.split("\n")[0] ?? ""}`,
    triggerRun: run,
    label: "file-watch",
    turnOrigin: "file-watch",
    // 차례가 왔을 때 **최신 행**으로 — 기다리는 사이 바뀐 지시·목적지를 쓴다(아스트라 10-20 P1). 지시는 같은 치환(감시기의 `substitutePrompt`)으로 다시 만든다.
    atTurn: () => {
      const latest = getWatch(watchId);
      if (latest === undefined) return "deleted";
      if (!latest.enabled) return "disabled";
      if (latest.originThreadKey !== origin) return "moved";
      return { text: substitutePrompt(latest.prompt, { path: run.path, event: run.event }), dest: { channel: latest.destChannel, target: latest.destTarget } };
    },
  });
  if ("skipped" in r) return { text: "", skipped: r.skipped as "deleted" | "disabled" | "moved" | "origin-gone" | "not-run" };
  return { text: "", inOrigin: r };
};

// 데몬 정상 부팅 시 runClaude default — 영역 A 직접 호출.
const defaultRunClaude: WatcherDeps["runClaude"] = async (input) => {
  if (input.originThreadKey !== null && input.originThreadKey !== undefined) return runInOrigin(input, input.originThreadKey);
  // 스케줄러와 **같은 이유·같은 처방** — 이 경로도 핸들러를 우회하므로 진행 중 등록이
  // 없으면 `/health` 가 0을 답하고 배포 가드가 도는 작업을 죽인다(`inflight-turns.ts` 주석).
  const ac = new AbortController();
  // ★같은 스레드 줄에 선다 — 완료 재주입과 동시에 돌지 않게(`external-turn.ts`, 2026-10-14 아침 뉴스 두 번).
  return runExternalTurn(
    input.threadKey,
    { ac, channel: input.channel, target: null, notifyDest: input.notifyDest as WorkerNotifyDest },
    async () => {
      // ★입력을 **통째로** 넘긴다 — 필드를 골라 넘기면 실행기가 새로 싣는 값이 여기서 조용히 떨어진다(스케줄러 파사드가
      //  2026-10-02 에 그렇게 발화 표식을 잃었고, 이 파사드는 2026-10-20 까지 사람 도달 좌표를 빼고 넘겨 감시가 띄운 매니저의
      //  완료 보고가 미배달됐다 — 회사돌쇠). 좌표는 `notifyDest` 그대로 모델 턴에 간다(매니저 발사·쿨다운 알림이 읽는다).
      const turn = { ...input, notifyDest: input.notifyDest as WorkerNotifyDest };
      const watchId = turn.triggerRun.id;
      // ★줄에서 기다리는 사이 감시가 지워지거나 꺼질 수 있다 — **줄 안에서 최신 행을 다시 읽고** 그렇다면 돌리지 않는다(적대 검토 10-19 P2,
      //  실측 재현: 지운 감시가 모델을 돌리고 배달까지 했다). 스케줄 실행기가 10-14 에 고친 것과 같은 판단(`runner.ts` SKIPPED_IN_QUEUE).
      const latest = getWatch(watchId);
      if (latest === undefined) return { text: "", skipped: "deleted" as const };
      if (!latest.enabled) return { text: "", skipped: "disabled" as const };
      // 발화 시작 = 줄에 선 시각이 아니라 **실제로 도는 시각**(«직전 N회» 경계가 이 실행을 통째로 품게).
      const startedAt = Date.now();
      console.log(`[file-watch:${watchId}] 이력 정책: ${applyWatchHistory(latest, turn.threadKey)}`);
      const out = await runClaude({ ...turn, abortSignal: ac.signal });
      // ★대화가 남은 발화만 적는다(스케줄 실행기와 같은 규칙) — 기록 실패가 결과·배달을 막지 않는다(다음은 프롬프트 일치로).
      if (out.text.trim() !== "") {
        try {
          recordWatchRun(watchId, startedAt);
        } catch (e) {
          console.warn(`[file-watch:${watchId}] 발화 기록 실패 — 이력 정책은 프롬프트 일치로 대신합니다: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },
  );
};

export default class FileWatchPluginFactory extends FileWatchPlugin {
  constructor() {
    super();
  }
}
