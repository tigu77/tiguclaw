/**
 * file-watch watcher — chokidar wrapping + dispatch.
 *
 * opts 매핑 (contract §2·§3):
 *   recursive: false       → chokidar `depth: 0`
 *   recursive: true        → chokidar `depth: undefined` (기본 = 무한)
 *   debounce_ms            → chokidar `awaitWriteFinish.stabilityThreshold`
 *   pattern (glob)         → chokidar `ignored` (pattern 매치되지 *않는* path 는 ignore)
 *   event_filter           → chokidar event(add/change/unlink) 필터 (콤마 리스트)
 *
 * event callback 흐름 (contract §5):
 *   1) event_filter 필터링 — 매치 안 되면 즉시 return (recordFiring 호출 0).
 *   2) prompt placeholder `{path}` `{event}` 치환.
 *   3) runClaude({ text: substituted, threadKey: `file-watch:${id}`, channel: "file-watch", cwd }) 호출.
 *   4) recordFiring(id, {ok}) + EventBus publish "file-watch.fired".
 *   5) 격리 try/catch — throw 시 recordFiring(id, {ok:false, error}) + EventBus publish "file-watch.error".
 *
 * dispatcher 는 V1 미사용 — runClaude 결과는 채널별 destination push 가 아닌
 * EventBus publish 만 (file-watch 의도 = 발화 자체. scheduler 처럼 응답 push 가 필요한
 * 케이스는 dispatcher.ts 직접 호출 — README 가이드).
 */
import path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { EventBus } from "../../../src/core/eventbus.js";
import type { WatchRow } from "../../../src/store/watches.js";

export interface WatcherDeps {
  /** runClaude 주입 — spike 에서 mock 가능. */
  runClaude: (input: {
    text: string;
    threadKey: string;
    channel: string;
    cwd: string;
  }) => Promise<{ text: string }>;
  /** recordFiring 주입 — spike 에서 mock 가능. */
  recordFiring: (
    id: number,
    result: { ok: boolean; path?: string; event?: string; error?: string },
  ) => void;
  /** cwd — 데몬 부팅 시 process.cwd() 박힘. */
  cwd: string;
}

/** event_filter 문자열 → Set 정규화. 'all' 또는 빈 값은 모두 통과.
 *  케이스 보존 — chokidar event 자체가 camelCase (addDir/unlinkDir). 'all'만 lower-check.
 */
const parseEventFilter = (filter: string): Set<string> | null => {
  const f = filter.trim();
  if (f === "" || f.toLowerCase() === "all") return null;
  return new Set(
    f
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
};

/** chokidar event 이름은 add/change/unlink/addDir/unlinkDir/ready/error 등 — 발화 대상 5종만. */
const FIREABLE_EVENTS = new Set([
  "add",
  "change",
  "unlink",
  "addDir",
  "unlinkDir",
]);

/** prompt placeholder 치환. */
export const substitutePrompt = (
  prompt: string,
  ctx: { path: string; event: string },
): string => {
  return prompt
    .split("{path}")
    .join(ctx.path)
    .split("{event}")
    .join(ctx.event);
};

/** event_filter 매치 검사 (export — spike 에서 직접 검증). */
export const matchesEventFilter = (
  event: string,
  filter: string,
): boolean => {
  const set = parseEventFilter(filter);
  if (set === null) return true;
  return set.has(event);
};

// ─── module-scope watcher Map — registerWatcher/unregisterWatcher 가 공유 ──
const watchers = new Map<number, FSWatcher>();

export const isRegistered = (id: number): boolean => watchers.has(id);

export const registerWatcher = (
  row: WatchRow,
  bus: EventBus,
  deps: WatcherDeps,
): void => {
  // 중복 등록 가드 — 기존 watcher close 후 재등록.
  unregisterWatcher(row.id);

  // chokidar opts 매핑.
  const watchPath = path.resolve(row.path);
  const opts: Parameters<typeof watch>[1] = {
    persistent: true,
    ignoreInitial: true,
    depth: row.recursive ? undefined : 0,
    awaitWriteFinish: {
      stabilityThreshold: Math.max(0, row.debounceMs),
      pollInterval: 100,
    },
  };
  // pattern: chokidar `ignored` 는 *제외* 의미 — pattern 매치되지 *않는* path 만 ignore 처리.
  // V1 단순화: pattern 이 부분 문자열 매치 (path.includes(pattern)). 정식 glob 은 V2.
  if (row.pattern !== null && row.pattern.length > 0) {
    const needle = row.pattern;
    opts.ignored = (p: string) => {
      // path 가 pattern 을 포함하지 않으면 ignore.
      return !p.includes(needle);
    };
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(watchPath, opts);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `file-watch: chokidar.watch failed for id=${row.id}: ${reason}`,
    );
    bus.publish({
      type: "file-watch.error",
      ts: Date.now(),
      payload: { watchId: row.id, phase: "register", error: reason },
    });
    return;
  }

  const handleEvent = (event: string, eventPath: string): void => {
    // FIREABLE 이 아니면 무시 (ready/error 등).
    if (!FIREABLE_EVENTS.has(event)) return;
    // event_filter 매치 안 되면 skip.
    if (!matchesEventFilter(event, row.eventFilter)) return;

    void fireWatch(row, event, eventPath, bus, deps);
  };

  watcher.on("all", handleEvent);
  watcher.on("error", (err) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`file-watch: watcher error id=${row.id}: ${reason}`);
    bus.publish({
      type: "file-watch.error",
      ts: Date.now(),
      payload: { watchId: row.id, phase: "watcher", error: reason },
    });
  });

  watchers.set(row.id, watcher);
};

export const unregisterWatcher = (id: number): void => {
  const existing = watchers.get(id);
  if (existing === undefined) return;
  try {
    void existing.close();
  } catch {
    // 무시.
  }
  watchers.delete(id);
};

/** 단일 발화 — 격리 try/catch + recordFiring + EventBus publish. */
const fireWatch = async (
  row: WatchRow,
  event: string,
  eventPath: string,
  bus: EventBus,
  deps: WatcherDeps,
): Promise<void> => {
  try {
    const text = substitutePrompt(row.prompt, { path: eventPath, event });
    await deps.runClaude({
      text,
      threadKey: `file-watch:${row.id}`,
      channel: "file-watch",
      cwd: deps.cwd,
    });
    deps.recordFiring(row.id, { ok: true, path: eventPath, event });
    bus.publish({
      type: "file-watch.fired",
      ts: Date.now(),
      payload: {
        watchId: row.id,
        path: eventPath,
        event,
        ok: true,
      },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    deps.recordFiring(row.id, {
      ok: false,
      path: eventPath,
      event,
      error: reason,
    });
    bus.publish({
      type: "file-watch.error",
      ts: Date.now(),
      payload: {
        watchId: row.id,
        phase: "fire",
        path: eventPath,
        event,
        error: reason,
      },
    });
  }
};
