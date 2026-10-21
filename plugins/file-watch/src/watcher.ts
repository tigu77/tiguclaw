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
 *   4) 결과 텍스트를 dest_channel/dest_target 으로 보낸다(dispatcher.ts → core deliverOutbound — 스케줄 알림과 같은 배달 경로).
 *      빈 결과면 보내지 않는다.
 *   5) recordFiring(id, {ok}) + EventBus publish "file-watch.fired".
 *   6) 격리 try/catch — runClaude throw 면 recordFiring(id, {ok:false, error}) + "file-watch.error"(phase fire),
 *      배달 실패면 «내용 생성됨·전달 실패» 로 recordFiring(ok:false, `dispatch: …`) + "file-watch.error"(phase dispatch).
 *
 * ★종전엔 dispatcher 를 아무도 안 불렀다(«V1 = 발화 자체가 의도») (2026-10-09 사용자 결정으로 고침). 그런데 `add_watch` 는
 *  dest_channel 을 필수로 받고 README 예시도 «요약해서 cli/텔레그램으로» 였다 — 사용자는 아무것도 못 받는데 기록은 ok 였다.
 */
import { isUserCancelled } from "../../../src/core/steering.js";
import path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { EventBus } from "../../../src/core/eventbus.js";
import type { WatchRow } from "../../../src/store/watches.js";
import type { TriggerRun } from "../../../src/core/llm-runtime/types.js";
import { dispatch } from "./dispatcher.js";

export interface WatcherDeps {
  /** runClaude 주입 — spike 에서 mock 가능. */
  runClaude: (input: {
    text: string;
    threadKey: string;
    channel: string;
    cwd: string;
    /**
     * 이 턴의 **사람 도달 좌표**(감시의 배달 목적지) — 스케줄 실행기와 같은 필드(`RegionAInput.notifyDest`).
     * 쓰는 곳: 이 턴이 띄운 매니저·서브의 완료 보고 · 쿨다운 알림 · 재시작 중단 통지. 감시 결과 자체는 여기로 자동 push 하지 않는다(아래 dispatch 가 보낸다).
     * ★2026-10-20 회사돌쇠: 종전엔 `interruptDest` 라는 다른 이름으로 들고 있다가 파사드가 **빼고** 넘겨, 감시가 띄운 매니저의 완료 보고가
     *  내부 채널 `file-watch` 로 가 미배달됐다(스케줄은 10-xx 부터 이 필드를 실었다 — 같은 판단이 두 플러그인에서 갈렸다).
     */
    notifyDest: { channel: string; target: string | null };
    /** 이 턴이 이 감시의 발화임 — 대화 컨텍스트가 «파일 감시 실행 · 변경만으로 누가 바꿨는지 모른다» 를 말한다(`TriggerRun`). */
    triggerRun: TriggerRun;
    /** 감시를 만든 대화(2026-10-20) — 있으면 파사드가 **그 대화의 줄**에 턴을 넣고, 답은 그 턴이 직접 목적지로 보낸다. null = 전용 세션. */
    originThreadKey: string | null;
  }) => Promise<{
    text: string;
    /**
     * 실행하지 않았다(모델 호출 0) — 기록·배달하지 않는다. `deleted`·`disabled` = 줄에서 기다리는 사이 감시가 지워지거나 꺼짐(스케줄
     *  `SKIPPED_IN_QUEUE` 와 같은 판단) · `moved` = 그새 처리 자리가 바뀜 · `origin-gone` = 만든 대화가 사라짐(★전용 세션으로 몰래 돌리지 않는다 — 오류로 남긴다) ·
     *  `not-run` = 차례가 오기 전에 핸들러가 끝냈다(데몬 종료 중 — 실행도 실패도 아니다).
     */
    skipped?: "deleted" | "disabled" | "moved" | "origin-gone" | "not-run";
    /** 만든 대화 안에서 돌았다 — 답은 그 턴이 이미 목적지로 보냈다(여기서 또 보내면 두 번). `failed` = 그 턴이 실패 안내로 끝남. */
    inOrigin?: { replied: number; failed?: string; dest?: { channel: string; target: string | null } };
  }>;
  /** recordFiring 주입 — spike 에서 mock 가능. */
  recordFiring: (
    id: number,
    result: { ok: boolean; path?: string; event?: string; error?: string },
  ) => void;
  /** cwd — 데몬 부팅 시 process.cwd() 박힘. */
  cwd: string;
  /** dispatcher 주입 — 회귀에서 mock 가능(scheduler runner 와 같은 자리). 미지정 = 실제 배달. */
  dispatch?: typeof dispatch;
  /**
   * 발화 때 **최신 행**을 읽는다(2026-10-20 레드팀 P-1). 감시기는 등록 때 행을 붙잡고 있어, `update_watch`(처리 자리 옮기기)가 재시작 전까지
   *  안 먹었다 — 옮긴 감시가 옛 대화로 가 «moved» 로 매번 조용히 건너뛰었다. 미지정(회귀 일부) = 붙잡은 행 그대로.
   */
  latestRow?: (id: number) => WatchRow | undefined;
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

export const registerWatcher = (
  row: WatchRow,
  bus: EventBus,
  deps: WatcherDeps,
): void => {
  // 중복 등록 가드 — 기존 watcher close 후 재등록.
  unregisterWatcher(row.id);

  const watchPath = path.resolve(row.path);
  const opts = chokidarOptionsFor(row);

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
    // pattern — `ignored` 는 stats 를 아는 파일에만 걸리므로(삭제 이벤트엔 stats 가 없다) 여기서도 같은 판정으로 거른다.
    if (!matchesWatchPattern(row.pattern, eventPath, watchPath)) return;

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
  deferredWatches.delete(id);
};

/**
 * 감시 패턴 — 부분 문자열(V1, 정식 glob 은 V2). 패턴이 없으면 전부. 판정은 여기 한 곳(chokidar `ignored` 와 이벤트 처리가 같이 쓴다).
 * ★**감시 루트 기준 상대경로**에 건다 (2026-10-08 적대 검토) — 절대경로 전체에 걸면 루트 폴더 이름에 패턴이 들어 있을 때(`…/notes-txt/`
 *  에 `txt`) 모든 파일이 통과해 필터가 무력했다.
 */
export const matchesWatchPattern = (pattern: string | null, p: string, root?: string): boolean =>
  pattern === null || pattern.length === 0 || (root === undefined ? p : path.relative(root, p)).includes(pattern);

/**
 * chokidar 옵션 — 감시 행 하나로 정한다(회귀가 실제 chokidar 에 그대로 넣어 본다).
 * ★`ignored` 는 **파일에만** 패턴을 건다 (2026-10-08 외부 검토 F4). 종전엔 경로 전체에 걸어 감시 루트·중간 폴더가 패턴(`.txt`)을
 *  안 담으면 순회에서 통째로 빠졌다 — 필터를 준 감시는 **아무 이벤트도 못 받았다.** chokidar 는 `ignored` 를 stats 없이 한 번,
 *  있으면 또 한 번 부르므로 «stats 를 아는 파일» 만 거른다(그 문서의 예와 같은 꼴).
 */
export const chokidarOptionsFor = (row: Pick<WatchRow, "path" | "recursive" | "debounceMs" | "pattern">): Parameters<typeof watch>[1] => ({
  persistent: true,
  ignoreInitial: true,
  depth: row.recursive ? undefined : 0,
  awaitWriteFinish: {
    stabilityThreshold: Math.max(0, row.debounceMs),
    pollInterval: 100,
  },
  ...(row.pattern !== null && row.pattern.length > 0
    ? { ignored: (p: string, stats?: { isFile(): boolean }) => stats?.isFile() === true && !matchesWatchPattern(row.pattern, p, path.resolve(row.path)) }
    : {}),
});

/** 단일 발화 — 격리 try/catch + recordFiring + EventBus publish. */
/**
 * overlap 가드 — watch id 별 in-flight 추적 (scheduler `inFlight` 와 동형).
 *
 * ★없으면: 파일 N개가 한꺼번에 떨어지면 `add` 이벤트 N회 → **같은 threadKey
 *  (`file-watch:<id>`)로 동시 LLM 턴 N개**가 발사된다. 그 스레드의 resume/history 를
 *  동시에 갱신해 race 가 나고(직렬 큐가 존재하는 이유 그 자체), 비용도 N배가 된다.
 *  debounce_ms 는 chokidar `awaitWriteFinish`(파일 1개의 쓰기 안정화)로만 매핑돼 있어
 *  서로 다른 파일의 동시 발화는 전혀 억제하지 못한다 — 그 구멍을 여기서 닫는다.
 *  scheduler 는 이미 같은 가드를 갖고 있다(runner.ts inFlight).
 */
const inFlightWatches = new Set<number>();
/**
 * 실행 중에 온 이벤트 — 버리지 않고 모았다가 끝나면 **한 번 더** 발화한다 (2026-10-09 적대 검토 P3).
 * ★종전엔 overlap 가드가 겹친 이벤트를 로그 한 줄로 **영구히** 버렸다 — .pdf 3개를 한꺼번에 떨구면 runClaude 1회,
 *  나머지 2개는 처리되지 않은 채 끝났다. 동시 턴을 막는 가드의 목적(같은 스레드 race·N배 비용)은 지키면서,
 *  몰린 것들은 경로 목록으로 묶어 한 턴에 넘긴다(N개가 몰려도 추가 턴은 1회).
 * 키 = `이벤트\0경로` — 같은 파일의 같은 이벤트가 여러 번 와도 한 번만 넘긴다. row 는 마지막에 본 것(갱신 반영).
 */
const pendingWatches = new Map<number, { row: WatchRow; bus: EventBus; deps: WatcherDeps; items: Map<string, { event: string; path: string }> }>();

/** 이어 발화에 넘기는 경로 상한 — 폴더 통째 복사(수천 개)가 거대한 프롬프트 한 턴이 되지 않게. 넘치면 «외 N건». */
const PENDING_PATHS_MAX = 50;

/**
 * 이어 발화 상한에 걸려 **보류한** 대기분 — 버리지 않고 다음 변경이 오면 그 발화에 합친다 (2026-10-09 재확인 검토).
 * ★상한에 걸린 대기분을 버렸더니, 이어 발화가 도는 동안 사용자가 정당하게 떨군 파일이 영구히 빠졌다(c.pdf). 보류하면 둘 다 풀린다:
 *  턴이 감시 폴더에 쓰는 자기 루프는 더 돌 턴이 없으니 멈추고, 정당한 파일은 다음 변경 때 함께 처리된다.
 */
const deferredWatches = new Map<number, Map<string, { event: string; path: string }>>();

/** 모은 항목 → 발화 인자. {path} = 경로 목록(줄바꿈, 50개 + «외 N건»), {event} = 이벤트 종류(쉼표). 하나뿐이면 원래 모양 그대로다. */
const toFireArgs = (items: Array<{ event: string; path: string }>): { event: string; path: string } => {
  const events = [...new Set(items.map((x) => x.event))].join(",");
  const shown = items.slice(0, PENDING_PATHS_MAX).map((x) => x.path);
  const paths = (items.length > PENDING_PATHS_MAX ? [...shown, `… 외 ${String(items.length - PENDING_PATHS_MAX)}건`] : shown).join("\n");
  return { event: events, path: paths };
};

const fireWatch = async (
  row: WatchRow,
  event: string,
  eventPath: string,
  bus: EventBus,
  deps: WatcherDeps,
  /** 대기분으로 이어 발화한 것인가 — 이어 발화는 **한 번까지**다(아래 finally). */
  followUp = false,
): Promise<void> => {
  // 최신 행으로 판단한다 — 처리 자리·프롬프트·목적지는 바뀔 수 있다(경로·패턴은 감시를 다시 걸어야 바뀐다).
  if (deps.latestRow !== undefined) {
    const latest = deps.latestRow(row.id);
    if (latest === undefined || !latest.enabled) {
      console.log(`[file-watch:${row.id}] '${row.label}' 발화 직전 ${latest === undefined ? "지워짐" : "꺼짐"} — 실행 안 함`);
      return;
    }
    row = latest;
  }
  if (inFlightWatches.has(row.id)) {
    const pending = pendingWatches.get(row.id) ?? { row, bus, deps, items: new Map() };
    pending.row = row;
    pending.items.set(`${event}\0${eventPath}`, { event, path: eventPath });
    pendingWatches.set(row.id, pending);
    console.log(
      `file-watch: watch ${row.id} 이미 실행 중 — 이번 ${event}(${eventPath}) 는 끝난 뒤 이어서 처리합니다(대기 ${pending.items.size}건).`,
    );
    return;
  }
  // 보류해 둔 대기분이 있으면 이번 발화에 합친다(이번 것이 마지막 줄 — 하나뿐이던 모양이 아니게 된다).
  const held = deferredWatches.get(row.id);
  if (held !== undefined && held.size > 0) {
    deferredWatches.delete(row.id);
    held.set(`${event}\0${eventPath}`, { event, path: eventPath });
    const merged = toFireArgs([...held.values()]);
    console.log(`file-watch: watch ${row.id} 보류해 둔 ${held.size - 1}건을 이번 변경과 함께 처리합니다.`);
    event = merged.event;
    eventPath = merged.path;
  }
  inFlightWatches.add(row.id);
  // ★한 실행을 로그만으로 따라갈 수 있게(회사 PC 10-19 — 원격 불가라 로그가 1차 진단면): 시작(원인·경로 수) → 이력 정책(파사드) →
  //  끝(결과 길이·배달처·소요) 또는 실패. 경로는 첫 하나와 개수만(합친 발화는 수십 개일 수 있다).
  const paths = eventPath.split("\n");
  const tag = `[file-watch:${row.id}] '${row.label}'`;
  const startedAt = Date.now();
  const secs = (): string => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  console.log(
    `${tag} 발화 — ${event} · 경로 ${paths.length}개(${paths[0] ?? ""}${paths.length > 1 ? " 외" : ""})` +
      `${followUp ? " · 실행 중 쌓인 변경 이어 처리" : held !== undefined && held.size > 0 ? " · 보류분 합침" : ""} → ${row.destChannel}:${row.destTarget ?? "-"}` +
      ` · 처리 ${row.originThreadKey ?? `전용 세션 file-watch:${row.id}`}`,
  );
  try {
  try {
    const text = substitutePrompt(row.prompt, { path: eventPath, event });
    const result = await deps.runClaude({
      text,
      threadKey: `file-watch:${row.id}`,
      channel: "file-watch",
      cwd: deps.cwd,
      notifyDest: { channel: row.destChannel, target: row.destTarget },
      triggerRun: { kind: "watch", id: row.id, event, path: eventPath },
      originThreadKey: row.originThreadKey,
    });
    // 실행하지 않았다 — 지운·끈 감시의 일을 기록하거나 보내지 않는다(«ok» 로 적으면 끈 감시가 돈 것처럼 보인다).
    if (result.skipped === "origin-gone") {
      // ★실패다 — 만든 대화가 없어 처리할 자리가 없다. 전용 세션으로 돌리지 않는다(설계: 몰래 폴백 금지). 자가 진단이 last_status 로 본다.
      const error = `감시를 만든 대화(${row.originThreadKey ?? "-"})가 없어 실행하지 않았습니다`;
      console.error(`${tag} ${error} · ${secs()}`);
      deps.recordFiring(row.id, { ok: false, path: eventPath, event, error });
      bus.publish({ type: "file-watch.error", ts: Date.now(), payload: { watchId: row.id, phase: "origin", path: eventPath, event, destChannel: row.destChannel, error } });
      return;
    }
    if (result.skipped !== undefined) {
      const why = result.skipped === "deleted" ? "줄에서 기다리는 사이 지워짐" : result.skipped === "disabled" ? "줄에서 기다리는 사이 꺼짐"
        : result.skipped === "not-run" ? "차례가 오기 전에 끝남(데몬 종료 중)" : "줄에서 기다리는 사이 처리 자리가 바뀜";
      console.log(`${tag} ${why} — 실행 안 함 · ${secs()}`);
      return;
    }
    if (result.inOrigin !== undefined) {
      // 만든 대화 안에서 돌았다 — 답은 그 턴이 목적지로 이미 보냈다(관측도 그 대화에). 여기서는 기록만.
      const { replied, failed } = result.inOrigin;
      // 그 실행이 **실제로 쓴** 목적지(차례에서 확정) — 발화 때 행은 그새 바뀌었을 수 있다(아스트라 재검토 10-20).
      const used = result.inOrigin.dest ?? { channel: row.destChannel, target: row.destTarget };
      if (failed !== undefined) {
        console.error(`${tag} 끝 — 만든 대화(${row.originThreadKey})에서 실패: ${failed.slice(0, 200)} · ${secs()}`);
        deps.recordFiring(row.id, { ok: false, path: eventPath, event, error: failed.slice(0, 500) });
        return;
      }
      console.log(`${tag} 끝 — 만든 대화(${row.originThreadKey})에서 처리 · 답 ${replied}자 → ${used.channel}:${used.target ?? "-"} · ${secs()}`);
      deps.recordFiring(row.id, { ok: true, path: eventPath, event });
      bus.publish({ type: "file-watch.fired", ts: Date.now(), payload: { watchId: row.id, path: eventPath, event, ok: true } });
      return;
    }
    // 결과를 목적지로 — 빈 결과면 보낼 것이 없다. 배달 실패는 생성 실패와 갈라 적는다(스케줄러와 같은 모양).
    if (result.text.trim() !== "") {
      try {
        await (deps.dispatch ?? dispatch)({
          watchId: row.id,
          destChannel: row.destChannel,
          destTarget: row.destTarget,
          text: result.text,
          bus,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[file-watch:${row.id}] '${row.label}' → ${row.destChannel}:${row.destTarget} DISPATCH FAILED (내용 생성됨·전달 실패): ${reason}`,
        );
        console.error(`${tag} 끝 — 결과 ${result.text.length}자 생성 · 배달 실패 · ${secs()}`);
        deps.recordFiring(row.id, { ok: false, path: eventPath, event, error: `dispatch: ${reason}` });
        bus.publish({
          type: "file-watch.error",
          ts: Date.now(),
          payload: { watchId: row.id, phase: "dispatch", path: eventPath, event, destChannel: row.destChannel, error: reason },
        });
        return;
      }
    }
    console.log(
      result.text.trim() === ""
        ? `${tag} 끝 — 빈 결과(보내지 않음) · ${secs()}`
        : `${tag} 끝 — 결과 ${result.text.length}자 → ${row.destChannel}:${row.destTarget ?? "-"} 배달 · ${secs()}`,
    );
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
    // 사용자가 `/stop` 으로 멈춘 건 실패가 아니다(2026-10-14 재검토 P2) — 스케줄 실행기와 같은 규칙.
    if (isUserCancelled(e)) {
      console.log(`[file-watch:${row.id}] '${row.label}' 사용자 중지(/stop) — 실패로 기록하지 않음`);
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    // 종전엔 실행 실패가 기록(DB)·이벤트에만 남고 데몬 로그엔 한 줄도 없었다.
    console.error(`${tag} 실패 — ${reason.slice(0, 300)} · ${secs()}`);
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
  } finally {
    inFlightWatches.delete(row.id);
    const pending = pendingWatches.get(row.id);
    if (pending !== undefined) {
      pendingWatches.delete(row.id);
      if (!watchers.has(row.id)) {
        // 실행 중에 감시가 지워졌다 — 지워진 감시의 일을 하지 않는다(남은 건수만 남긴다).
        console.log(`file-watch: watch ${row.id} 가 삭제돼 대기 ${pending.items.size}건을 처리하지 않습니다.`);
      } else if (followUp) {
        // ★이어 발화 **도중에** 또 쌓였다 — 턴이 감시 폴더에 결과를 쓰고 있으면 또 이을 때마다 자기 출력을 다시 먹는다
        //  (2026-10-09 재검토: 9초에 9턴, 돌 때마다 배달). 그래서 이어 발화는 한 번까지 — 다만 **버리지 않고 보류한다**:
        //  그 사이 사용자가 떨군 정당한 파일일 수도 있다(재확인 검토). 다음 변경이 오면 그 발화에 합친다.
        const held = deferredWatches.get(row.id) ?? new Map<string, { event: string; path: string }>();
        for (const [k, v] of pending.items) held.set(k, v);
        deferredWatches.set(row.id, held);
        console.warn(
          `file-watch: watch ${row.id} 이어 처리 중에 또 ${pending.items.size}건이 생겨 보류합니다(보류 ${held.size}건) — 다음 변경 때 함께 처리합니다` +
            `(턴이 감시 폴더에 결과를 쓰고 있다면 감시 밖에 쓰거나 패턴으로 제외하세요).`,
        );
      } else {
        const items = [...pending.items.values()];
        const args = toFireArgs(items);
        console.log(`file-watch: watch ${row.id} 대기 ${items.length}건을 이어서 처리합니다.`);
        void fireWatch(pending.row, args.event, args.path, pending.bus, pending.deps, true);
      }
    }
  }
};
