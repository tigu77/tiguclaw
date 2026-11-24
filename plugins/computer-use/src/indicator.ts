/**
 * **제어 표시의 수명** (2026-11-24, ⑤ — 설계 `docs/decisions/2026-11-24-computer-use-indicator-esc.md` §3-2 · §11).
 *
 * ★표시 수명 = **리스 유효성**이다. `beginAction` 통과에 띄우고(`showIndicator`), 행동이 끝날 때마다 유휴 타이머를
 *  다시 걸고(`settleIndicator`), 리스가 만료되면 내린다. 턴 종료 이벤트는 구독하지 않는다(§14-1 결정 그대로) —
 *  리스를 쥔 동안 비서는 실제로 제어권을 쥐고 있으므로 «제어 중» 이 참이다.
 * ★**현재 도우미 하나**(`current`)만 상태를 바꾼다. `hide` 는 `current = null` 을 **먼저** 하고 죽인다 — 내린 뒤·재기동 뒤
 *  옛 도우미의 늦은 `onStop`/`onGone` 이 새 상태를 건드리지 못한다.
 * ★표시 실패는 조작을 막지 않는다(로그 한 줄). 도우미가 없으면 단추도 Esc 도 없다.
 * ★**표시의 중지 단추를 우리 클릭이 누르지 않게 하는 판단은 여기 한 곳**(`clearPillFor`) — 실행부(조작 자식)는 단추를 모른다(⑤ r4, 독립 검토 R4).
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { leaseLive, LEASE_IDLE_MS, type Desktop } from "./control.js";

export interface IndicatorHandle {
  stop(): void;
  /** 도우미 프로세스가 **끝난 것이 확인되면** 풀린다(`close` · 기동 거부 · 띄우기 전에 멈춤). 창은 프로세스와 함께 사라진다. */
  readonly closed: Promise<void>;
}

/** 표시의 중지 단추 사각형 — 계획기·실행부와 **같은 화면 좌표**(맥 CG 포인트 · Windows 물리 픽셀). */
export interface PillRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 표시 도우미 자식 프로세스 — `watchIndicatorChild` 가 쓰는 만큼만(`ChildProcess` 가 이 모양에 맞는다). */
export interface IndicatorChild {
  /** 띄워졌으면 프로세스 번호 — 없으면 기동 자체가 실패한 것이다(그때의 `error` 만 «끝남» 이다). */
  readonly pid?: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  on(ev: "error", f: (e: Error) => void): unknown;
  on(ev: "close", f: (code: number | null, sig: NodeJS.Signals | null) => void): unknown;
  kill(sig?: NodeJS.Signals): unknown;
}

const asRect = (v: unknown): PillRect | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  return typeof r["x"] === "number" && typeof r["y"] === "number" && typeof r["w"] === "number" && typeof r["h"] === "number"
    ? { x: r["x"], y: r["y"], w: r["w"], h: r["h"] }
    : null;
};

/**
 * **도우미 출력 프로토콜 — 한 곳** (2026-11-24, ⑤ Windows 확대 — 설계 `…-indicator-esc-windows.md` §3-1 · r4). 맥(JXA)·Windows(C#)
 * 도우미가 같은 줄을 낸다: `{"ready":1,"pill":사각형|null}` · `{"pill":사각형|null,"req":요청}` · `{"esc":1}` · `{"stop":1}` · `{"error":…}`.
 *
 * ★준비 줄은 창을 다 띄운 **뒤**에 온다 — `pill` 은 그때의 실제 단추 사각형(못 읽어 단추를 내렸으면 null). 빈 연습 준비 줄(`dry`)은 넘기지 않는다.
 * ★`{"pill":…,"req":…}` = 비킴 요청 `req` 를 처리한 뒤의 실제 사각형(옮김 실패면 옛 사각형 · 단추를 내렸으면 null).
 * ★`{"esc":1}` 마다 `onStop("esc")`, `{"stop":1}`(표시의 중지 단추를 누름)마다 `onStop("button")`. `{"error":…}` 는 **멈춤이 아니다**.
 * ★`onGone` 은 **한 번**: 기동 거부(`pid` 없는 `error`) 또는 실행 뒤 종료 — `exit` 가 아니라 **`close`** 에서 확정한다(마지막 오류 줄까지 읽은 뒤).
 * ★`stop()` 은 `SIGKILL` 한 번(두 번 불러도 한 번). `closed` 는 `close`·기동 거부에서만 풀린다 — **이미 뜬 자식의 `error`(신호 전달 실패 등)는
 *  끝남이 아니다**(그 창은 아직 화면에 있을 수 있다, 독립 검토 R5).
 */
export const watchIndicatorChild = (
  child: IndicatorChild,
  o: {
    onStop: (via: StopVia) => void;
    onGone: (why: string) => void;
    onReady?: (pill: PillRect | null) => void;
    onPill?: (pill: PillRect | null, req: string) => void;
  },
): IndicatorHandle => {
  const dec = new StringDecoder("utf8");
  let buf = "";
  let error: string | null = null;
  let gone = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const goneOnce = (why: string): void => {
    markClosed();
    if (gone) return;
    gone = true;
    o.onGone(why);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : dec.write(chunk);
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue; // 모르는 줄은 무시한다.
      }
      if (typeof v !== "object" || v === null) continue;
      const m = v as { esc?: unknown; stop?: unknown; error?: unknown; type?: unknown; ready?: unknown; dry?: unknown; pill?: unknown; req?: unknown };
      if (m.ready === 1) {
        if (m.dry !== 1) o.onReady?.(asRect(m.pill));
      } else if (m.esc === 1) o.onStop("esc");
      else if (m.stop === 1) o.onStop("button");
      else if ("pill" in m && typeof m.req === "string") o.onPill?.(asRect(m.pill), m.req);
      else if (m.error !== undefined && error === null) {
        const kind = typeof m.type === "string" && m.type !== "" ? ` [${m.type}]` : "";
        error = `${String(m.error)}${kind}`.slice(0, 300);
      }
    }
  });
  child.on("error", (e) => {
    // 뜨지도 못했으면 끝난 것이다. 이미 떠 있으면(신호 전달 실패 등) 끝남이 아니다 — 종료 사유에만 남기고 `close` 를 기다린다.
    if (child.pid === undefined) goneOnce(`표시 도우미 기동 실패: ${String(e).slice(0, 160)}`);
    else if (error === null) error = `프로세스 오류: ${String(e).slice(0, 160)}`;
  });
  child.on("close", (code, sig) => goneOnce(`표시 도우미 종료(${String(code ?? sig ?? "?")})${error === null ? "" : `: ${error}`}`));
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      child.kill("SIGKILL");
    },
    closed,
  };
};

/**
 * **가장자리 주황 빛** — 두 도우미(맥 `INDICATOR_SCRIPT` · Windows `INDICATOR_CS`)가 이 값 하나로 그린다(⑤ 외형 확정, 2026-11-24).
 * ★화면 가장자리에서 안쪽으로 거리 d(맥 포인트 · Windows 는 모니터 배율로 나눈 값, 정수로 내림)의 알파 =
 *  `alpha × (1 − d/width)^falloff` — 가장자리가 가장 진하고 안쪽으로 부드럽게 사라진다. `width` 안쪽(화면 가운데)은 투명.
 * ★중지 단추·커서 고리의 주황(`TINT`)과는 따로다 — 그쪽 디자인은 그대로 둔다.
 */
export const GLOW = { width: 58, alpha: 0.71, falloff: 2.1, rgb: [255, 153, 43] } as const;

/** 가장자리에서 d 만큼 안쪽 줄의 알파(위 식 그대로) — 회귀가 두 도우미의 결과와 대조하는 기준. */
export const glowAlphaAt = (d: number): number =>
  d < 0 || d >= GLOW.width ? 0 : GLOW.alpha * Math.pow(1 - Math.floor(d) / GLOW.width, GLOW.falloff);

/** 멈춤이 어디서 왔나 — Esc 키 상태(감지 보장 없음) · 표시의 중지 단추(사람·원격의 클릭). 결정(`onUserStop`)은 같다. */
export type StopVia = "esc" | "button";

/** 표시 도우미 실행부 — 맥은 `mac.startIndicator`, Windows 는 `win.startIndicator`. 던지면 기동 실패로 본다. */
export interface IndicatorBackend {
  start(o: {
    label: string;
    /** 이 세대의 비킴 요청 파일 — **부모만** 쓴다(도우미는 읽기만). */
    moveFile: string;
    onStop: (via: StopVia) => void;
    onGone: (why: string) => void;
    onReady?: (pill: PillRect | null) => void;
    onPill?: (pill: PillRect | null, req: string) => void;
  }): IndicatorHandle;
  /** 비킴 요청을 도우미에게 전한다 — 기본은 세대 파일에 덮어쓰기(도우미가 주기마다 읽는다). 검사가 전달 시점을 쥘 수 있게 여기 둔다. */
  request?: (moveFile: string, req: string) => Promise<void>;
}

/**
 * 누름이 든 발사 전 대기 상한들(⑤ r4). 준비 — 맥 도우미 기동 실측 ~0.2초 · 비킴 응답 — 도우미 주기(맥 실측 ~38ms · Windows 20ms)의 여러 배 ·
 * 종료 확인 — `SIGKILL` 뒤 `close`. 넘기면 그 세대를 내리고 **종료를 확인한 뒤에만** 단추 없이 보낸다(확인 못 하면 이번 열을 보내지 않는다).
 */
export const INDICATOR_READY_WAIT_MS = 2_000;
export const PILL_MOVE_WAIT_MS = 600;
export const INDICATOR_CLOSE_WAIT_MS = 1_500;

export interface Indicator {
  readonly backend: IndicatorBackend;
  /** 멈춤 요청·비킴 요청 파일을 만들 폴더(제품 = `os.tmpdir()`). */
  readonly stopDir: string;
  /** 표시를 내리는 유휴 — 제품 = `LEASE_IDLE_MS`(리스와 같은 값, 새 숫자 없음). */
  readonly idleMs: number;
  /** 지금 세대의 비킴 요청 파일 — 도우미가 없으면 null. 부모만 쓰고, 그 세대가 끝나면(내림·종료) 부모가 지운다. */
  move: string | null;
  /** 띄운 횟수(세대 번호) — 촬영 앞뒤가 같은 세대·같은 상태인지로 «촬영 도중 표시가 있었나» 를 가른다. */
  gen: number;
  /** 지금 세대의 준비 — 아직이면 null. `pill` = 실제 단추 사각형(단추 없음이면 null). 비킴 응답이 오면 갱신된다. */
  ready: { pill: PillRect | null } | null;
  /** 지금 세대에 보낸 비킴 요청 중 아직 응답이 없는 것(없으면 null). */
  pendingMove: string | null;
  /**
   * **내렸지만 끝난 것이 아직 확인되지 않은 도우미**(⑤ r4, 독립 검토 R5). 그 창은 아직 화면에 있을 수 있다 — 그래서 그 단추의 클릭은 여전히
   * 중지이고, 남아 있는 동안 새 표시를 띄우지 않고 누름도 보내지 않으며, 촬영에도 찍혔을 수 있다고 본다. `closed` 가 풀리면 빠진다.
   */
  zombies: Set<IndicatorHandle>;
  /** 플러그인이 멈췄다 — 새로 띄우지 않는다(`stop()` 이 세우고 `startService` 가 푼다). 진행 중 호출이 그 뒤에 표시를 되살리지 않게. */
  halted: boolean;
  /** 준비·응답·종료를 기다리는 쪽. 상태가 바뀌면 모두 깨운다. */
  waiters: Array<() => void>;
  current: IndicatorHandle | null;
  owner: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export const newIndicator = (backend: IndicatorBackend, opts: { stopDir: string; idleMs?: number }): Indicator => ({
  backend,
  stopDir: opts.stopDir,
  idleMs: opts.idleMs ?? LEASE_IDLE_MS,
  move: null,
  gen: 0,
  ready: null,
  pendingMove: null,
  zombies: new Set(),
  halted: false,
  waiters: [],
  current: null,
  owner: null,
  timer: null,
});

const clearTimer = (ind: Indicator): void => {
  if (ind.timer !== null) clearTimeout(ind.timer);
  ind.timer = null;
};

/** 한 세대의 요청 파일을 치운다(없으면 아무 일 없음). 도우미는 지우지 않는다 — 정리는 부모. */
const dropMove = (move: string | null): void => {
  if (move !== null) void fsp.rm(move, { force: true }).catch(() => {});
};

/** 촬영 구간 판정용 표본 — `[세대, 떠 있나]`. 앞뒤 표본이 다르거나 어느 쪽이든 떠 있으면 그 그림에 표시가 찍혔을 수 있다. */
export const indicatorMark = (ind: Indicator | undefined): [number, boolean] =>
  ind === undefined ? [0, false] : [ind.gen, ind.current !== null || ind.zombies.size > 0];

/** 촬영 앞뒤 표본으로 «찍혔을 수 있나» — 도중에 떴다 내려간 것까지(세대가 바뀜) 잡는다. */
export const indicatorMaybeInShot = (before: [number, boolean], after: [number, boolean]): boolean =>
  before[1] || after[1] || before[0] !== after[0];

const wake = (ind: Indicator): void => {
  const w = ind.waiters;
  ind.waiters = [];
  for (const f of w) f();
};

/** 조건이 참이 되거나(상태가 바뀔 때마다 다시 본다) 상한·취소까지 기다린다. ★`unref` 하지 않는다 — 발사가 이 대기를 기다린다. */
const waitUntil = async (ind: Indicator, cond: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted === true) return false;
    await new Promise<void>((resolve) => {
      // ★어떻게 끝나든(깨움·시한·취소) 자기 등록을 지운다 — 끝나지 않는 잔존 앞에서 재시도가 이어져도 쌓이지 않게(독립 검토 R6).
      const done = (): void => {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        const i = ind.waiters.indexOf(done);
        if (i >= 0) ind.waiters.splice(i, 1);
        resolve();
      };
      const t = setTimeout(done, left);
      signal?.addEventListener("abort", done, { once: true });
      ind.waiters.push(done);
    });
  }
};

/** 내린다 — `current` 를 **먼저** 비우고 죽인다(그 세대의 늦은 콜백은 무효가 된다). 끝났는지 기다릴 수 있게 그 핸들을 돌려준다. */
export const hideIndicator = (ind: Indicator, why: string, log: (m: string) => void): IndicatorHandle | null => {
  const h = ind.current;
  const move = ind.move;
  ind.current = null;
  ind.move = null;
  ind.ready = null;
  ind.pendingMove = null;
  ind.owner = null;
  clearTimer(ind);
  dropMove(move);
  wake(ind);
  if (h === null) return null;
  // 끝난 것이 확인될 때까지 «잔존» 으로 둔다 — 창이 아직 화면에 있을 수 있다.
  ind.zombies.add(h);
  void h.closed.then(() => {
    ind.zombies.delete(h);
    wake(ind);
  });
  try {
    h.stop();
  } catch (e) {
    log(`제어 표시 내리기 실패(${why}) — ${String(e).slice(0, 120)}`);
  }
  log(`제어 표시 내림 — ${why}`);
  return h;
};

/** 잔존 도우미가 모두 끝나기를 상한까지 기다린다 — 끝났으면 참. ★정상(SIGKILL 직후)은 수 ms 다. */
export const settleZombies = (ind: Indicator, signal?: AbortSignal): Promise<boolean> =>
  waitUntil(ind, () => ind.zombies.size === 0, INDICATOR_CLOSE_WAIT_MS, signal);

const inRect = (r: PillRect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** `clearPillFor` 의 결과 — 보내도 된다 / 이번 열을 보내지 않는다(사유는 모델·로그용). */
export type PillClear = { ok: true } | { ok: false; why: "pill-in-both" | "pill-stuck" | "cancelled" };

const sameRect = (a: PillRect | null, b: PillRect | null): boolean =>
  a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * **우리 누름이 표시의 중지 단추에 닿지 않게 — 판단 한 곳** (⑤ r4, 독립 검토 R1~R4 — 설계 §11-3).
 *
 * 발사 **전에**, 계획의 누름 점(`mousedown`·`scroll` 좌표)을 지금 단추 사각형과 대조한다. 발사 **도중**에는 단추가 움직이지 않는다 —
 * 비킴은 여기서만 요청하고, 응답을 받거나 그 세대를 끝낸 뒤에만 돌아온다(남은 요청이 다음 열에 늦게 처리되는 일이 없다).
 *  1. 준비를 기다린다(상한 `INDICATOR_READY_WAIT_MS`). 준비 줄 전에는 단추 자리를 모른다 — 넘기면 그 세대를 내리고 **종료 확인**까지.
 *  2. 단추 없음(null) · 점이 하나도 안 겹침 → 보낸다.
 *  3. 겹치면 비킴 요청(부모만 쓰는 세대 파일) → 응답(실제 새 사각형)을 상한 `PILL_MOVE_WAIT_MS` 까지. 새 자리도 겹치면(위·아래 둘 다
 *     누를 점이 있음) 보내지 않는다. 응답이 없으면 그 세대를 내리고 종료 확인.
 *  ★종료 확인(`closed`)을 상한 `INDICATOR_CLOSE_WAIT_MS` 안에 못 받으면 **보내지 않는다** — 단추가 아직 화면에 있을 수 있다.
 *  ★표시 실패(도우미가 없거나 죽음)는 조작을 막지 않는다 — 단추가 없으니 바로 보낸다.
 */
export const clearPillFor = async (
  ind: Indicator,
  points: ReadonlyArray<{ x: number; y: number }>,
  log: (m: string) => void,
  signal?: AbortSignal,
): Promise<PillClear> => {
  if (points.length === 0) return { ok: true };
  const aborted = (): boolean => signal?.aborted === true;
  // 잔존(내렸지만 끝남 미확인) 단추가 있으면 그 창이 아직 화면에 있을 수 있다 — 끝날 때까지(상한) 기다리고, 못 보면 보내지 않는다.
  const zombiesGone = async (why: string): Promise<PillClear> => {
    if (await settleZombies(ind, signal)) return { ok: true };
    if (aborted()) return { ok: false, why: "cancelled" };
    log(`제어 표시 — 내린 도우미의 종료를 확인하지 못해 이번 조작을 보내지 않음(${why})`);
    return { ok: false, why: "pill-stuck" };
  };
  const retire = async (why: string): Promise<PillClear> => {
    hideIndicator(ind, why, log);
    return zombiesGone(why);
  };
  if (ind.zombies.size > 0) {
    const z = await zombiesGone("앞서 내린 표시");
    if (!z.ok) return z;
  }
  if (ind.current === null) return { ok: true };
  const ready = await waitUntil(ind, () => ind.current === null || ind.ready !== null, INDICATOR_READY_WAIT_MS, signal);
  if (aborted()) return { ok: false, why: "cancelled" };
  // ★«현재가 비었다» 는 «사라졌다» 가 아니다 — 기다리는 사이 내려갔으면(중지·플러그인 종료·도우미 종료) 잔존이 끝났는지 한 곳에서 다시 본다(R6).
  if (ind.current === null) return zombiesGone("기다리는 사이 표시가 내려감");
  if (!ready || ind.ready === null) return retire("준비 안 됨(단추 자리 모름)");
  const hits = (r: PillRect | null): boolean => r !== null && points.some((p) => inRect(r, p.x, p.y));
  if (!hits(ind.ready.pill)) return { ok: true };
  const before = ind.ready.pill;
  const move = ind.move;
  if (move === null) return retire("비킴 요청 자리 없음");
  const req = `${randomUUID()};`;
  // ★대기 표시를 **요청을 내보내기 전에** 세운다 — 도우미가 파일 쓰기 완료 콜백보다 먼저 응답할 수 있다(독립 검토 R5).
  ind.pendingMove = req;
  try {
    await (ind.backend.request ?? ((f: string, r: string) => fsp.writeFile(f, r)))(move, req);
  } catch (e) {
    ind.pendingMove = null;
    log(`제어 표시 — 비킴 요청을 쓰지 못함 — ${String(e).slice(0, 120)}`);
    return retire("비킴 요청 실패");
  }
  const answered = await waitUntil(ind, () => ind.current === null || ind.pendingMove === null, PILL_MOVE_WAIT_MS, signal);
  if (aborted()) {
    // 취소 — 요청은 이미 나갔다. 늦은 처리가 다음 열에 닿지 않게 이 세대를 끝내고, 이번 열은 보내지 않는다.
    await retire("취소");
    return { ok: false, why: "cancelled" };
  }
  if (ind.current === null) return zombiesGone("기다리는 사이 표시가 내려감");
  if (!answered) return retire("비킴 응답 없음");
  const after = ind.ready?.pill ?? null;
  if (!hits(after)) return { ok: true };
  // 그대로다(옮기지 못함) — «두 자리 모두» 가 아니다. 이 세대를 내리고 끝남을 확인한 뒤 보낸다(다음 `do` 가 다시 띄운다).
  if (sameRect(before, after)) return retire("단추가 비키지 않음");
  log(`제어 표시 — 누를 점이 단추의 두 자리에 모두 걸림(옮기기 전 ${JSON.stringify(before)} · 뒤 ${JSON.stringify(after)})`);
  return { ok: false, why: "pill-in-both" };
};

/**
 * 띄운다(`beginAction` 통과 직후) — 이미 떠 있으면 소유자만 바꾼다. 행동이 도는 동안은 유휴로 내리지 않는다(타이머를 끈다).
 * `onStop` 은 **이 도우미가 현재일 때만** 불린다.
 */
export const showIndicator = (
  ind: Indicator,
  owner: string,
  label: string,
  onStop: (via: StopVia) => void,
  log: (m: string) => void,
): void => {
  clearTimer(ind);
  ind.owner = owner;
  if (ind.current !== null || ind.halted) return;
  // 잔존(내렸지만 끝남 미확인) 단추가 있으면 새로 띄우지 않는다 — 두 단추·옛 단추 무시를 막는다(부르는 쪽이 먼저 `settleZombies`).
  if (ind.zombies.size > 0) {
    log("제어 표시 — 앞서 내린 표시가 아직 끝나지 않아 새로 띄우지 않음");
    return;
  }
  // 세대마다 새 요청 파일 — 옛 세대에 남은 요청이 새 도우미에 닿지 않는다.
  const move = path.join(ind.stopDir, `tiguclaw-cu-move-${randomUUID()}`);
  let h: IndicatorHandle | null = null;
  try {
    h = ind.backend.start({
      label,
      moveFile: move,
      // 잔존 단추도 화면에 있는 동안은 사람의 중지다(내렸다고 그 클릭을 버리면 사람의 중지가 사라진다).
      onStop: (via) => {
        if (h !== null && (ind.current === h || ind.zombies.has(h))) onStop(via);
      },
      onReady: (pill) => {
        if (h === null || ind.current !== h) return;
        ind.ready = { pill };
        wake(ind);
      },
      onPill: (pill, req) => {
        if (h === null || ind.current !== h || ind.ready === null) return;
        ind.ready = { pill };
        if (req === ind.pendingMove) ind.pendingMove = null;
        wake(ind);
      },
      onGone: (why) => {
        // ★끝난 것이 확인된 도우미는 **자기 세대 요청 파일**을 마지막으로 치운다(세대가 지나도 그 파일은 그 세대 몫).
        dropMove(move);
        if (h === null || ind.current !== h) return;
        ind.current = null;
        ind.move = null;
        ind.ready = null;
        ind.pendingMove = null;
        ind.owner = null;
        clearTimer(ind);
        wake(ind);
        log(`제어 표시 도우미가 끝났습니다 — ${why}`);
      },
    });
  } catch (e) {
    // ★표시 실패는 조작을 막지 않는다 — 다음 `do` 가 다시 띄워 본다.
    dropMove(move);
    log(`제어 표시를 띄우지 못했습니다(조작은 계속합니다) — ${String(e).slice(0, 160)}`);
    return;
  }
  ind.current = h;
  ind.move = move;
  ind.ready = null;
  ind.pendingMove = null;
  ind.gen += 1;
};

/**
 * 행동이 끝났다(`endAction` 뒤) — 유휴 타이머를 다시 건다. 울렸을 때 리스가 만료됐으면 내린다(만료 판정은 `leaseLive` 한 곳).
 * ★행동 중에 울리는 일은 없다 — 다음 행동의 `beginAction` 통과가 `showIndicator` 에서 이 타이머를 끈다.
 */
export const settleIndicator = (ind: Indicator, d: Desktop, log: (m: string) => void): void => {
  if (ind.current === null) return;
  clearTimer(ind);
  const arm = (ms: number): void => {
    const timer = setTimeout(() => {
      if (ind.timer !== timer) return;
      ind.timer = null;
      const now = Date.now();
      if (!leaseLive(d, now, ind.idleMs)) {
        hideIndicator(ind, "유휴", log);
        return;
      }
      // ★울렸는데 리스가 아직 살아 있으면(시스템 시계가 뒤로 갔을 때) **남은 만큼 다시 건다** — 안 걸면 리스가 끝나도
      //  다음 `do`·종료 전까지 표시와 Esc 감시가 남는다. 상한은 유휴 한 번(시계가 크게 뒤로 가도 계속 다시 본다).
      const left = d.lease === null ? 1 : ind.idleMs - (now - d.lease.lastTouchedMs);
      arm(Math.min(ind.idleMs, Math.max(1, left)));
    }, ms);
    timer.unref?.();
    ind.timer = timer;
  };
  arm(ind.idleMs);
};

/**
 * **사람의 새 메시지인가** — 맞으면 그 메시지를 채널이 받은 시각(`receivedAt`), 아니면 `null`.
 *
 * ★거르는 것만 한다(합성·슬래시·시각 없음). 잠금 시각과의 비교는 `resumeByHuman` **한 곳**이다.
 * ★같은 «사람의 진짜 지시» 판정이 `src/core/llm-runtime/capabilities/file-ops-mcp.ts:1853` 에도 있다(그쪽은 같은 대화까지 본다) —
 *  설계 §3-8 에 두 자리를 적어 두었다.
 */
export const humanReceivedAt = (ev: { type: string; payload: Readonly<Record<string, unknown>> }): number | null => {
  if (ev.type !== "channel.message.in") return null;
  const p = ev.payload;
  if (p.synthetic === true) return null;
  if (typeof p.text === "string" && p.text.trimStart().startsWith("/")) return null;
  return typeof p.receivedAt === "number" && Number.isFinite(p.receivedAt) ? p.receivedAt : null;
};
