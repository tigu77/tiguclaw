/**
 * 회귀: 활동 표시(텔레그램 "입력 중…")는 **좌표 단위 상태**다 — 턴 단위가 아니다.
 *
 * 배경 (2026-08-10): 대시보드에서 "텔레그램에도 보내기"를 켜고 보낸 턴에도 텔레그램에
 *  "입력 중"이 뜨게 하려 했다. 그런데 표시는 chat 에 붙지 그 메시지에 붙지 않는다.
 *  인바운드 턴은 `enqueueThreadTurn` 이 같은 chat=같은 thread 를 직렬화해서 **우연히**
 *  안전했지만, 대시보드 세션 여럿이 같은 chat 을 겨누면 같은 좌표에 턴이 동시에 걸린다.
 *  턴마다 켜고 끄면 **먼저 끝난 턴이 아직 도는 턴의 표시까지 꺼버린다** — 같은 날 고친
 *  MCP 결함과 같은 병(좌표가 소유한 자원을 턴이 소유한 것처럼 다루는 것)이고, 이쪽은
 *  에러도 없이 표시만 사라져 더 안 보인다.
 *
 * 지키는 것 — ①지연 전엔 안 뜬다 ②겹치면 하나만 돈다 ③마지막 해제에만 멈춘다
 *  ④해제는 멱등 ⑤상한이 지나면 카운트가 남아도 멈춘다(hung 턴 영구 점등 방지).
 *
 * 타이머·시계를 주입해 **실시간에 의존하지 않는다** — 플래키한 검사는 결국 안 돌린다.
 */
import {
  beginChannelActivity,
  activeActivityCount,
  stopAllChannelActivity,
  type ActivityTimerHandle,
} from "../../core/channel-activity.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

/** 가짜 시계 + 가짜 타이머 — `advance(ms)` 로 시간을 직접 민다. */
const makeClock = (): {
  now: () => number;
  timers: {
    setTimeout: (fn: () => void, ms: number) => ActivityTimerHandle;
    clearTimeout: (h: ActivityTimerHandle) => void;
  };
  advance: (ms: number) => void;
} => {
  let t = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq;
        pending.set(id, { at: t + ms, fn });
        return id;
      },
      clearTimeout: (h) => {
        pending.delete(h as number);
      },
    },
    advance: (ms) => {
      const target = t + ms;
      // 만기된 것을 시각 순으로 하나씩 — 콜백이 다시 예약하는 것(하트비트)도 잡는다.
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, e] of pending) {
          if (e.at <= target && e.at < nextAt) {
            nextAt = e.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const entry = pending.get(nextId);
        if (entry === undefined) break;
        pending.delete(nextId);
        t = entry.at;
        entry.fn();
      }
      t = target;
    },
  };
};

const OPTS = { delayMs: 10_000, intervalMs: 4_000, ttlMs: 60_000 };

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  stopAllChannelActivity(); // 앞선 검사 잔여 0에서 시작.

  // ── ① 지연 전엔 표시하지 않는다 ─────────────────────────────────────────────
  {
    const c = makeClock();
    let ticks = 0;
    const release = beginChannelActivity("tg:1", () => (ticks += 1), {
      ...OPTS,
      timers: c.timers,
      now: c.now,
    });
    c.advance(9_000);
    const before = ticks;
    c.advance(2_000); // 11초 — 지연 통과
    out.push({
      name: "지연 전엔 안 뜨고, 지나면 뜬다",
      ok: before === 0 && ticks === 1,
      got: `9초=${before}회 11초=${ticks}회 (기대 0 / 1)`,
    });
    release();
  }

  // ── ② 같은 좌표에 턴이 겹쳐도 표시는 하나만 ────────────────────────────────
  //  ③ 그리고 먼저 끝난 턴이 남은 턴의 표시를 끄지 않는다 — 이게 이 검사의 핵심이다.
  {
    const c = makeClock();
    let ticks = 0;
    const t = { ...OPTS, timers: c.timers, now: c.now };
    const relA = beginChannelActivity("tg:9", () => (ticks += 1), t);
    const relB = beginChannelActivity("tg:9", () => (ticks += 1), t);
    c.advance(10_000); // 첫 표시
    c.advance(4_000); // 갱신 1회
    const twoTurns = ticks;
    relA(); // 앞 턴 종료 — 아직 B 가 돈다
    c.advance(4_000);
    const afterFirstRelease = ticks;
    relB(); // 마지막 해제 — 이제 멈춘다
    c.advance(20_000);
    out.push({
      name: "겹쳐도 표시는 하나만(턴 수만큼 늘지 않는다)",
      ok: twoTurns === 2,
      got: `2턴 14초=${twoTurns}회 (기대 2 — 턴별이면 4)`,
    });
    out.push({
      name: "★먼저 끝난 턴이 남은 턴의 표시를 끄지 않는다",
      ok: afterFirstRelease === twoTurns + 1,
      got: `relA 후 +${afterFirstRelease - twoTurns}회 (기대 +1)`,
    });
    out.push({
      name: "마지막 해제에만 멈춘다",
      ok: ticks === afterFirstRelease && activeActivityCount() === 0,
      got: `relB 후 추가=${ticks - afterFirstRelease}회 잔여좌표=${activeActivityCount()} (기대 0 / 0)`,
    });
  }

  // ── ④ 해제는 멱등 ──────────────────────────────────────────────────────────
  {
    const c = makeClock();
    let ticks = 0;
    const t = { ...OPTS, timers: c.timers, now: c.now };
    const relA = beginChannelActivity("tg:7", () => (ticks += 1), t);
    const relB = beginChannelActivity("tg:7", () => (ticks += 1), t);
    relA();
    relA(); // 두 번째 호출이 B 의 몫까지 까면 표시가 조기 종료된다.
    c.advance(10_000);
    out.push({
      name: "해제 멱등 — 두 번 불러도 남은 참조를 까지 않는다",
      ok: ticks === 1,
      got: `표시=${ticks}회 (기대 1 — 멱등 아니면 0)`,
    });
    relB();
  }

  // ── ⑤ 상한 — 카운트가 남아 있어도 시간으로 끊는다 ──────────────────────────
  //  해제는 턴 promise 의 settle 에 걸리는데, 이 레포는 hung 턴의 promise 를 버리는 걸
  //  허용한다. 그러면 카운트가 영영 안 내려간다 — 그래서 시간으로도 끊어야 한다.
  {
    const c = makeClock();
    let ticks = 0;
    const release = beginChannelActivity("tg:5", () => (ticks += 1), {
      ...OPTS,
      timers: c.timers,
      now: c.now,
    });
    c.advance(60_000); // 상한 도달
    const atTtl = ticks;
    c.advance(120_000); // 그 뒤로는 더 안 뜬다(해제 안 했는데도)
    out.push({
      name: "★상한 초과 시 해제 없이도 멈춘다(hung 턴 영구 점등 방지)",
      ok: ticks === atTtl && atTtl > 0,
      got: `상한까지=${atTtl}회, 이후 추가=${ticks - atTtl}회 (기대 >0 / 0)`,
    });
    release();
  }

  out.push({
    name: "검사 후 잔여 타이머 0",
    ok: activeActivityCount() === 0,
    got: `잔여 좌표=${activeActivityCount()} (기대 0)`,
  });
  stopAllChannelActivity();
  return out;
};

export const check: RegressionCheck = {
  name: "channel-activity-refcount",
  guards:
    "egress 활동 표시(텔레그램 입력 중)가 좌표 단위가 아니라 턴 단위로 켜져, 동시 세션에서 먼저 끝난 턴이 남은 턴의 표시를 끄던 것 + hung 턴이 표시를 영구 점등하던 것",
  run,
};
