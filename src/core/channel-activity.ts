/**
 * 채널 활동 표시(텔레그램 "입력 중…" 등)의 **정책**을 코어가 소유한다.
 *
 * 채널이 주는 건 "한 번 표시"(`ChannelOutbound.signalActivity`)뿐이고, 언제 시작할지·
 * 얼마나 자주 갱신할지·언제 멈출지는 전부 여기서 정한다. 채널마다 이 판단을 복제하면
 * 같은 판단이 여러 곳에 생긴다(판단은 한 곳, 표현은 가장자리).
 *
 * ★왜 refcount 인가 — 표시는 **좌표 단위 상태**이지 턴 단위가 아니다.
 *  텔레그램 "입력 중"은 chat 에 붙지 그 메시지에 붙지 않는다. 인바운드 턴은
 *  `enqueueThreadTurn` 이 같은 chat=같은 thread 를 직렬화해서 우연히 안전했지만,
 *  대시보드 세션 여럿이 각자 egress 로 같은 chat 을 겨누면 **같은 좌표에 턴이 동시에**
 *  걸린다. 그때 턴마다 켜고 끄면 먼저 끝난 턴이 아직 도는 턴의 표시까지 꺼버린다.
 *  (2026-08-10 에 고친 MCP 결함과 같은 병 — 좌표/프로세스가 소유한 자원을 턴이 소유한
 *   것처럼 다루는 것. 그쪽은 시끄럽게 죽었고 이쪽은 조용히 표시만 사라진다.)
 *
 * ★왜 상한(TTL) 인가 — 해제는 턴 promise 의 settle 에 걸린다. 그런데 이 레포는 hung 턴의
 *  promise 를 **버리는 걸 의도적으로 허용**한다(turn-abandon ≫ daemon-freeze). 그러면
 *  카운트가 영영 안 내려가고 표시가 계속 돈다. 인바운드는 그 대화가 어차피 막혀 있어
 *  사용자가 알지만, egress 는 다른 채널에서 도는 턴이라 **영문도 모르고 켜져 있게** 된다.
 *  그래서 카운트와 무관하게 시간으로 끊는다.
 *
 * ★왜 지연 시작인가 — 짧은 턴까지 깜빡이면 신호가 아니라 소음이다. 그리고 실패하는 턴은
 *  대개 금방 끝나므로, 지연은 "표시만 뜨고 아무것도 안 오는" 유령을 대부분 없앤다.
 *
 * 타이머·시계를 주입받는 이유는 테스트다 — 실시간에 의존하면 검사가 플래키해지고,
 * 플래키한 검사는 결국 안 돌린다.
 */

export type ActivityTimerHandle = unknown;

export interface ActivityTimers {
  setTimeout: (fn: () => void, ms: number) => ActivityTimerHandle;
  clearTimeout: (handle: ActivityTimerHandle) => void;
}

export interface ActivityOptions {
  /** 이만큼 지나야 처음 표시한다(짧은 턴은 아예 안 깜빡인다). */
  delayMs: number;
  /** 갱신 간격. 텔레그램 chat action 은 5초 유지라 4초. */
  intervalMs: number;
  /** 표시 상한 — 지나면 카운트가 남아 있어도 멈춘다(hung 턴 영구 점등 방지). */
  ttlMs: number;
  timers?: ActivityTimers;
  now?: () => number;
}

/** 기본값 — 호출부가 매번 숫자를 고르지 않게(같은 판단이 여러 곳에 생기지 않게). */
export const DEFAULT_ACTIVITY_OPTIONS: Omit<
  ActivityOptions,
  "timers" | "now"
> = {
  delayMs: 10_000,
  intervalMs: 4_000,
  ttlMs: 10 * 60_000,
};

interface Entry {
  count: number;
  handle: ActivityTimerHandle | null;
  /** 이 시각을 지나면 멈춘다(begin 마다 자기 몫만큼 연장). */
  deadline: number;
  tick: () => void;
  timers: ActivityTimers;
  now: () => number;
  intervalMs: number;
}

const ENTRIES = new Map<string, Entry>();

const realTimers: ActivityTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

const stopTicking = (entry: Entry): void => {
  if (entry.handle !== null) {
    entry.timers.clearTimeout(entry.handle);
    entry.handle = null;
  }
};

const arm = (key: string, entry: Entry, ms: number): void => {
  entry.handle = entry.timers.setTimeout(() => {
    entry.handle = null;
    // 상한 초과 — 카운트가 남아 있어도 더는 표시하지 않는다.
    if (entry.now() >= entry.deadline) return;
    entry.tick();
    arm(key, entry, entry.intervalMs);
  }, ms);
};

/**
 * 좌표(`key`)에 활동 표시를 켠다. 반환값을 부르면 내린다(**멱등** — 두 번 불러도 한 번).
 *
 * 같은 좌표에 여럿이 켜면 표시는 하나만 돌고, **마지막 하나가 내릴 때** 멈춘다.
 */
export const beginChannelActivity = (
  key: string,
  tick: () => void,
  opts: ActivityOptions,
): (() => void) => {
  const timers = opts.timers ?? realTimers;
  const now = opts.now ?? Date.now;

  let entry = ENTRIES.get(key);
  if (entry === undefined) {
    entry = {
      count: 0,
      handle: null,
      deadline: 0,
      tick,
      timers,
      now,
      intervalMs: opts.intervalMs,
    };
    ENTRIES.set(key, entry);
  }
  entry.tick = tick; // 같은 좌표면 하는 일이 같다 — 마지막 등록으로 갱신.
  entry.count += 1;
  entry.deadline = Math.max(entry.deadline, now() + opts.ttlMs);
  // 아직 안 돌고 있으면(첫 참조이거나 상한으로 멈춰 있었으면) 지연 후 시작.
  if (entry.handle === null) arm(key, entry, opts.delayMs);

  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const e = ENTRIES.get(key);
    if (e === undefined) return;
    e.count -= 1;
    if (e.count > 0) return;
    stopTicking(e);
    ENTRIES.delete(key);
  };
};

/** 검사·종료용 — 지금 표시 중인 좌표 수. */
export const activeActivityCount = (): number => ENTRIES.size;

/** 데몬 종료 시 전부 정리(타이머 누수 0). */
export const stopAllChannelActivity = (): void => {
  for (const entry of ENTRIES.values()) stopTicking(entry);
  ENTRIES.clear();
};
