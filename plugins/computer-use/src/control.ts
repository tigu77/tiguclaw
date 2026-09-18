/**
 * **조작의 «판단» 전부 — 순수** (2026-09-17, 설계 §15).
 *
 * ★`observe.ts` 와 같은 규율이다: 여기에 `spawn` 이 없다. 조작에서 이게 관측보다 더 중요한
 *  이유는 **클릭이 되돌릴 수 없기 때문**이다 — «엉뚱한 데를 눌렀다» 를 검사로 잡으려면
 *  판단이 실행에서 떨어져 있어야 한다([[feedback_simple_composable_no_duplication]] —
 *  "검사가 껄끄러우면 코드가 잘못 놓인 것").
 *
 * ★★**여기가 «공통» 이다** (§15-7). mac 은 `CGEvent`, Windows 는 `SendInput` 이라 실행부는
 *  원리적으로 갈리지만, **무엇을 쏠지 정하는 일**은 하나다. 그래서 이 파일이 내는 것은
 *  «행동» 이 아니라 **`LowEvent` 목록**이다 — 실행부는 그걸 순서대로 쏘기만 한다.
 *
 * ★설계 §14 의 계약 셋이 여기 산다:
 *  - **소유자·취소**(§14-1) — 소유자는 턴의 `AbortSignal` 이고, 정리 순서는 한 함수 안에서.
 *  - **직렬화**(§14-2) — 활성 행동 하나 · 행동 중 유휴 만료 금지 · 장부는 리스와 같은 객체.
 *  - **프레임**(§14-3) — 행동은 `frameId` 를 받고, **행동이 자기 프레임을 무효화한다.**
 */
import { imagePointToScreen, type FrameGeometry } from "./observe.js";

// ─── 행동 — 모델이 부르는 모양 ────────────────────────────────────────────────

export type Button = "left" | "right" | "middle";

/**
 * ★**넷뿐이다**(§15-2). 드래그는 안 넣는다 — 중간 상태가 가장 긴 행동이라 첫 종단을
 *  통과한 뒤다.
 * ★**전부 `frameId` 를 받는다.** 좌표가 없는 `type`·`key` 도 받는 이유: 요구하는 것이
 *  좌표가 아니라 «방금 본 화면 위에서 하는 행동인가» 이기 때문이다.
 */
/**
 * **누른 채 쓸 수식키** — «양손» (2026-09-17 정태님).
 *
 * ★`Shift`+드래그(직선 유지·범위 선택) · `Cmd`+클릭(새 탭·다중 선택) · `Alt`+스크롤(확대)처럼
 *  **한 손은 키, 한 손은 마우스**인 동작이 실제로 흔하다. 이것을 «키 도구 따로, 마우스 도구
 *  따로» 로 하면 **턴 사이에 키가 눌린 채** 남는다 — §15-1 이 없앤 상태다.
 * ★그래서 한 행동 안에 싣는다: 눌러두고 → 행동하고 → **역순으로 놓는다.** 자식 하나로 끝난다.
 */
export type Hold = readonly Modifier[];

export type Action =
  | { kind: "click"; frameId: string; x: number; y: number; button: Button; count: number; hold?: Hold }
  | { kind: "type"; frameId: string; text: string }
  | { kind: "key"; frameId: string; keys: readonly string[] }
  | { kind: "scroll"; frameId: string; x: number; y: number; dx: number; dy: number; hold?: Hold }
  /**
   * ★**드래그는 첫 종단을 통과한 뒤에 붙였다**(2026-09-17, §15-2 의 약속대로). 중간 상태가
   *  가장 긴 행동이라 마지막이다 — 버튼이 **눌린 채로** 여러 이벤트를 지난다.
   */
  | {
      kind: "drag";
      frameId: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      button: Button;
      hold?: Hold;
    };

// ─── 실행부에 주는 저수준 지시 — 플랫폼 중립 ──────────────────────────────────

/**
 * ★좌표는 **화면 좌표**(mac=포인트 · Windows=픽셀)다 — 이미지 픽셀이 아니다.
 *  변환은 `plan()` 이 끝냈다. 실행부는 **계산하지 않는다**(계산이 두 곳이면 갈린다).
 * ★`unicode` 가 따로 있는 이유: 양 OS 가 **코드포인트를 직접 주입**하는 길을 갖고 있고
 *  (`CGEventKeyboardSetUnicodeString` · `KEYEVENTF_UNICODE`), 그래야 한글이 IME 조합을
 *  안 지난다. 「키 코드로 한 글자씩」 은 한글에서 성립하지 않는다.
 */
export type LowEvent =
  | { t: "mousemove"; x: number; y: number }
  | { t: "mousedown"; x: number; y: number; button: Button; count: number }
  /**
   * ★좌표가 **선택**이다 — 없으면 실행부가 «지금 커서 자리» 에서 뗀다. 정리(`releasePlan`)는
   *  커서가 어디 있는지 모르는데, 거기서 (0,0) 을 쓰면 **화면 구석으로 끌어다 놓는** 것이
   *  된다(드래그 중 취소가 정확히 그 상황이다).
   */
  | { t: "mouseup"; x?: number; y?: number; button: Button; count: number }
  /**
   * **버튼을 누른 채 이동** — `mousemove` 와 **다른 이벤트**다. OS 가 드래그를 별도 타입으로
   * 쏘기 때문에(mac `LeftMouseDragged`), 누른 채 `mousemove` 를 쏘면 앱이 드래그로 안 읽는다.
   */
  | { t: "mousedrag"; x: number; y: number; button: Button }
  | { t: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: "unicode"; text: string }
  | { t: "keydown"; key: string }
  | { t: "keyup"; key: string };

/**
 * **키 이름** — 실행부가 OS 코드로 옮긴다. 여기선 이름만 안다.
 *
 * ★목록을 손으로 늘리지 않는다([[feedback_hand_maintained_lists]]). 수식키만 이름으로 알고,
 *  나머지 한 글자는 **그대로 넘긴다** — 실행부가 «한 글자면 유니코드로» 라는 **규칙**으로
 *  처리한다. 그래서 `["cmd","c"]` 도 `["ctrl","한"]` 도 목록 갱신 없이 성립한다.
 */
/**
 * ★`win` 이 여기 있어야 하는 이유 (2026-09-18, 회사돌쇠 3차 §7-5).
 *
 * 실행부(Windows)는 진작 `win` 을 알고 있었고 주석도 «진짜 Windows 키가 필요하면 win 을
 * 받는다» 고 약속했는데, **이 목록에 없어서 수식키로 취급되지 않았다** — `["win","r"]` 이
 * *win 눌렀다 뗐다, 그다음 r* 로 나갔다. 조합이 아니라 두 번의 단독 입력이다.
 * 셋(실행부·이 목록·도구 스키마)이 서로 다른 말을 하고 있었다.
 */
export const MODIFIERS = ["cmd", "ctrl", "alt", "shift", "win"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const isModifier = (k: string): k is Modifier =>
  (MODIFIERS as readonly string[]).includes(k);

// ─── 프레임 — 무엇을 보고 하는 행동인가 ──────────────────────────────────────

export interface Frame {
  id: string;
  /** 캡처 시각(ms). 나이 판정에 쓴다. */
  atMs: number;
  geometry: FrameGeometry;
  /** 이 프레임을 찍은 소유자(스레드). 남의 프레임 위에서 클릭하지 않는다. */
  owner: string;
}

/**
 * 프레임 유효 시한 — **잠정**.
 *
 * ★★안 잰 값이다. 짧으면 «봤는데 또 찍어라» 가 잦고, 길면 낡은 화면 위에서 누른다.
 *  실사용 로그의 «프레임 만료» 빈도로 재서 확정한다 — 직감으로 박은 숫자를 «정해진 것» 으로
 *  읽지 마라.
 * ★그리고 **시한이 프레임 유효성의 전부가 아니다** — 유효한 프레임이어도 UI 가 그대로라는
 *  보장은 없다(§14-3). 그건 재관측으로만 안다.
 */
export const FRAME_TTL_MS = 30_000;

/** ★`not-latest` 가 없어졌다 — 최근 몇 장을 같이 들고 있으므로 «최신이 아님» 이 거절 사유가 아니다. */
export type FrameReject = "unknown" | "stale" | "other-owner";

export type FrameCheck = { ok: true; frame: Frame } | { ok: false; why: FrameReject };

/**
 * **이 행동이 설 수 있는 프레임인가** — 순수.
 *
 * ★거절 사유가 넷인 이유: 각각 **처방이 다르다.** «다시 찍어라»(stale·not-latest)와
 *  «네 것이 아니다»(other-owner)와 «그런 프레임이 없다»(unknown)를 한 문장으로 뭉치면
 *  모델이 무엇을 해야 할지 모른다.
 */
export const FRAME_KEEP = 3;

/** 새 프레임을 앞에 놓고 **최근 몇 장만** 남긴다 — 순수. */
export const rememberFrame = (kept: readonly Frame[] | undefined, frame: Frame): Frame[] =>
  [frame, ...(kept ?? []).filter((f) => f.id !== frame.id)].slice(0, FRAME_KEEP);

export const frameCheck = (
  kept: readonly Frame[] | undefined,
  frameId: string,
  owner: string,
  nowMs: number,
  ttlMs = FRAME_TTL_MS,
): FrameCheck => {
  const found = (kept ?? []).find((f) => f.id === frameId);
  if (found === undefined) return { ok: false, why: "unknown" };
  if (found.owner !== owner) return { ok: false, why: "other-owner" };
  // ★**행동이 목록을 통째로 비운다**(`endAction`) — 그래서 «클릭했으면 다시 봐라» 는 그대로
  //  강제되고, 그 사이에 여러 장을 들고 있는 것은 안전을 안 깎는다.
  if (nowMs - found.atMs > ttlMs) return { ok: false, why: "stale" };
  return { ok: true, frame: found };
};

/** 거절을 모델이 읽는 말로 — 무엇을 해야 하는지까지 적는다. */
export const frameRejection = (why: FrameReject): string => {
  switch (why) {
    case "unknown":
      return (
        "그 화면(frameId)을 모릅니다 — **직전 행동이 화면을 바꿨거나**(행동은 화면 id 를 전부 " +
        `무효화합니다) 너무 오래전 것입니다(최근 ${String(FRAME_KEEP)}장만 유효). ` +
        "`observe_screen` 으로 지금 화면을 보고 좌표를 다시 정하세요."
      );
    case "stale":
      // ★**규칙을 같이 말한다** (2026-09-17 돌쇠 4차). 바로 위 `unknown` 은 «최근 3장만
      //  유효» 라고 알려주는데 이쪽만 안 알려줘서 비대칭이었다. 처음 쓰는 사람이 오류 한
      //  번으로 수명을 배우게 한다.
      return `그 화면은 너무 오래됐습니다(**${String(Math.round(FRAME_TTL_MS / 1000))}초** 지나면 만료됩니다). \`observe_screen\` 으로 다시 보세요.`;
    case "other-owner":
      return "그 화면은 다른 작업이 찍은 것입니다. 직접 `observe_screen` 으로 보세요.";
  }
};

// ─── 데스크톱 상태 — 리스 · 활성 행동 · 입력 장부가 **한 객체** ───────────────

/**
 * ★**셋을 한 객체에 둔다**(§14-2). 따로 두면 갈린다 — 리스는 놨는데 장부에 키가 남는
 *  상태가 표현 가능해지고, 그 상태는 «Shift 가 눌린 채 남는» 첫 증상이 된다.
 */
export interface Desktop {
  lease: { owner: string; lastTouchedMs: number } | null;
  /** 실행 중인 행동. 있는 동안 유휴 만료를 멈추고, 두 번째 행동을 막는다. */
  active: { owner: string; startedMs: number } | null;
  /** 이 순간 **우리가 눌러둔** 것. 실행부가 죽어도 부모가 이걸로 되돌린다. */
  held: { keys: string[]; buttons: Button[] };
  /** 소유자별 **최신 프레임 하나**. 옛 프레임을 안 들고 있는 것이 «최신만» 규칙의 구현이다. */
  frames: Map<string, Frame[]>;
  /**
   * **우리가 마지막으로 입력을 쏜 시각.** 없으면 아직 안 쐈다.
   *
   * ★이게 없으면 사용자 가드가 **우리 입력을 사람으로 읽는다**(실기에서 그렇게 막혔다).
   *  리스·장부와 **같은 객체**에 두는 이유도 같다 — 갈리면 그 순간 판정이 어긋난다.
   */
  lastSelfInputMs: number | null;
}

export const newDesktop = (): Desktop => ({
  lease: null,
  active: null,
  held: { keys: [], buttons: [] },
  frames: new Map(),
  lastSelfInputMs: null,
});

export const LEASE_IDLE_MS = 60_000;

export type Begin =
  | { ok: true }
  | { ok: false; reason: "busy-other"; heldBy: string }
  | { ok: false; reason: "busy-self" }
  | { ok: false; reason: "user-active" }
  /**
   * ★**«사람이 쓰는 중» 과 «모른다» 를 가른다** (2026-09-17, 회사돌쇠 Windows 실기).
   *
   * 둘 다 **막는 것은 같다**(모르면 안 누른다 — 조작은 되돌릴 수 없다). 그런데 종전엔 답도
   * 같아서, **실행부가 컴파일에 실패해 유휴를 못 읽은 것**이 «사람이 쓰는 중» 으로 보였다.
   * 호출자는 기다리면 풀릴 줄 알고 기다렸고, 진짜 원인은 로그 속에 있었다.
   * ★막는 것과 **왜 막았는지 말하는 것**은 다른 일이다.
   */
  | { ok: false; reason: "idle-unknown" };

/**
 * **행동을 시작해도 되나** — 순수 판정 + 상태 전이.
 *
 * 순서가 뜻을 갖는다:
 *  1. **사람이 쓰는 중이면 아무도 못 한다**(§3-4). 리스를 쥐고 있어도 마찬가지 —
 *     ★가드가 리스 **뒤**에 오면 «내 리스니까» 로 사람 손 위에서 누르게 된다.
 *  2. 다른 소유자가 쥐고 있으면 즉시 실패(큐 없음 — 숨은 대기를 만들지 않는다).
 *  3. ★**같은 소유자여도 행동이 돌고 있으면 실패다**(§14-2). 리스는 «다른 소유자» 만 막지
 *     자기 자신의 병렬 도구 호출을 막지 않는다 — 여기가 그 구멍이었다.
 */
export const beginAction = (
  d: Desktop,
  owner: string,
  nowMs: number,
  idleSeconds: number | null,
  opts?: { leaseIdleMs?: number; userWindowMs?: number },
): Begin => {
  // ★**모르면 막는다 — 다만 «모른다» 고 말한다.** 판정 불가를 «사람이 쓰는 중» 으로
  //  보고하면 원인이 가려진다(실행부 실패가 그렇게 숨었다).
  if (idleSeconds === null || !Number.isFinite(idleSeconds)) {
    return { ok: false, reason: "idle-unknown" };
  }
  // ★«우리가 마지막으로 쏜 때» 를 같이 본다 — 안 그러면 **자기 클릭에 자기가 막힌다**.
  if (userIsActive(idleSeconds, nowMs, d.lastSelfInputMs, { windowMs: opts?.userWindowMs })) {
    return { ok: false, reason: "user-active" };
  }
  if (d.active !== null) {
    // 같은 소유자든 아니든 **하나뿐**이다. 사유만 갈라 말한다.
    return d.active.owner === owner
      ? { ok: false, reason: "busy-self" }
      : { ok: false, reason: "busy-other", heldBy: d.active.owner };
  }
  const expired = d.lease !== null && nowMs - d.lease.lastTouchedMs >= (opts?.leaseIdleMs ?? LEASE_IDLE_MS);
  if (d.lease !== null && !expired && d.lease.owner !== owner) {
    return { ok: false, reason: "busy-other", heldBy: d.lease.owner };
  }
  d.lease = { owner, lastTouchedMs: nowMs };
  d.active = { owner, startedMs: nowMs };
  return { ok: true };
};

/**
 * **행동이 끝났다** — 성공이든 실패든 **반드시** 부른다(`finally`).
 *
 * ★**프레임을 여기서 버린다.** 행동은 화면을 바꾸므로 자기가 본 프레임을 무효화한다 —
 *  이게 «클릭 → 재관측» 을 규율이 아니라 **구조**로 만드는 한 줄이다.
 * ★리스는 **안 놓는다.** 이어지는 행동(클릭 → 입력)이 흔하고, 매번 놓으면 그 사이에 남이
 *  끼어든다. 놓는 것은 소유자 반납·취소·유휴 셋뿐이다(§3-3).
 */
export const endAction = (d: Desktop, owner: string, nowMs: number): void => {
  if (d.active !== null && d.active.owner === owner) d.active = null;
  if (d.lease !== null && d.lease.owner === owner) d.lease.lastTouchedMs = nowMs;
  d.frames.delete(owner);
};

/**
 * **취소·정리 — 순서가 전부다**(§14-1).
 *
 *     입력 중지 → 장부의 키·버튼 **전부 놓기** → 리스 해제
 *
 * ★세 단계가 **한 함수 안**에 있어야 «해제가 끝나기 전에 다음 소유자가 들어오는» 창이
 *  안 생긴다. 그래서 이 함수는 **놓을 목록을 돌려주고** 호출부가 그걸 쏜 뒤 상태가 빈다 —
 *  즉 «놓기» 가 실패해도 장부에 남아 다음 정리에서 다시 시도된다(조용히 지우지 않는다).
 */
export const releasePlan = (d: Desktop): LowEvent[] => {
  const out: LowEvent[] = [];
  // 버튼 먼저 — 마우스가 눌린 채 키를 놓으면 그 사이 드래그로 해석될 수 있다.
  // ★좌표를 **안 싣는다** — 실행부가 지금 커서 자리에서 뗀다. (0,0) 을 쓰면 드래그 중
  //  취소가 «구석으로 끌어다 놓기» 가 된다.
  for (const b of d.held.buttons) out.push({ t: "mouseup", button: b, count: 1 });
  // 키는 **역순**으로 — 누른 순서의 반대가 수식키 짝을 맞춘다(Shift 를 먼저 놓지 않는다).
  for (const k of [...d.held.keys].reverse()) out.push({ t: "keyup", key: k });
  return out;
};

/** 놓기가 **실제로 성공한 뒤** 장부를 비운다 — 성공 전에 비우면 눌린 키가 미아가 된다. */
export const forgetHeld = (d: Desktop): void => {
  d.held = { keys: [], buttons: [] };
};

export const releaseLease = (d: Desktop, owner: string): void => {
  if (d.lease !== null && d.lease.owner === owner) d.lease = null;
  if (d.active !== null && d.active.owner === owner) d.active = null;
  d.frames.delete(owner);
};

// ─── §3-4 사용자 충돌 가드 ────────────────────────────────────────────────────

/**
 * ★★**2초는 안 잰 값이다**(설계 §3-4). 짧으면 충돌하고 길면 비서가 굶는다.
 * ★**«모르면 쓰는 중»** — 판정 불가를 «비어 있다» 로 읽으면 사람 손 위에서 클릭한다.
 *  관측에선 모름을 통과시켰지만(가역) 조작은 반대다.
 */
export const USER_ACTIVE_WINDOW_MS = 2_000;

/**
 * **우리 입력이 OS 유휴 시계를 리셋한 것을 감안하는 여유** — 잠정.
 *
 * ★발사 시각과 OS 가 그 입력을 기록하는 시각 사이의 미끄러짐을 덮는다. 너무 크면 **우리
 *  직후에 사람이 만진 것**을 놓치고, 너무 작으면 우리 입력을 사람으로 오인해 스스로 막힌다.
 */
export const SELF_INPUT_GRACE_MS = 400;

/**
 * **사람이 지금 그 기계를 쓰고 있나** — 순수 (2026-09-17, 실기로 다시 씀).
 *
 * ★★**OS 유휴만으로는 못 가린다**(맥 실측). 우리가 쏜 **클릭은 HID 유휴 시계를 리셋한다** —
 *  이벤트 탭을 세션(1)으로 바꿔도 마찬가지고, 이동만 예외다. 그래서 첫 구현은 클릭 직후의
 *  타이핑이 **자기 입력에 자기가 막혔다**(`user-active`). 설계가 Windows 위험으로 적어둔
 *  그 모양이 맥에서 먼저 났다.
 *
 * ★처방은 설계가 이미 적어둔 것이다 — **우리 입력 시각을 기억하고, 그보다 나중의 입력만
 *  «사람» 으로 친다.** 그래서 이 함수는 «마지막 입력이 언제였나» 를 «우리가 마지막으로 쏜
 *  때» 와 **비교**한다.
 * ★**플랫폼 공통이다.** Windows `GetLastInputInfo` 도 소스를 못 가르므로 같은 처방이 든다 —
 *  §15-7 이 말한 «공통» 의 값이 여기서 한 번 더 나온다.
 * ★대가: 우리 입력 직후 **여유 시간 안에** 사람이 만지면 그건 못 본다. 그 창을 0으로 만들
 *  방법은 없다(OS 가 둘을 구분해 주지 않는다) — 그래서 여유를 **작게** 둔다.
 */
export const userIsActive = (
  idleSeconds: number | null,
  nowMs: number,
  lastSelfInputMs: number | null,
  opts?: { windowMs?: number; selfGraceMs?: number },
): boolean => {
  if (idleSeconds === null || !Number.isFinite(idleSeconds)) return true; // 모르면 쓰는 중
  const windowMs = opts?.windowMs ?? USER_ACTIVE_WINDOW_MS;
  const grace = opts?.selfGraceMs ?? SELF_INPUT_GRACE_MS;
  if (idleSeconds * 1000 >= windowMs) return false; // 충분히 조용하다 — 누가 만졌든 오래됐다
  // 방금 입력이 있었다. **그게 우리 것인가?**
  const lastInputMs = nowMs - idleSeconds * 1000;
  if (lastSelfInputMs !== null && lastInputMs <= lastSelfInputMs + grace) return false;
  return true;
};

// ─── 계획 — 행동 하나를 저수준 이벤트 목록으로 ───────────────────────────────

export type Plan =
  | { ok: true; events: LowEvent[]; holds: { keys: string[]; buttons: Button[] }; describe: string }
  | { ok: false; why: "offscreen" | "empty" };

/**
 * **행동 → 이벤트 목록** — 순수. 좌표 변환이 여기서 **한 번만** 일어난다.
 *
 * ★`holds` 는 «이 계획이 도중에 눌러두는 것» 이다. 실행부가 죽어도 부모가 이걸로 되돌린다
 *  (§15-1 — `SendInput`·`CGEventPost` 는 프로세스가 죽어도 눌린 상태를 시스템에 남긴다).
 * ★`describe` 를 같이 내는 이유: 결과가 «성공» 뿐이면 모델이 무엇을 했는지 **기억으로**
 *  재구성하게 되고, 그게 중복 클릭의 입구다(§15-2).
 */
/**
 * **누른 채 감싸기** — 순수. 여기 한 곳에서만 감싼다(행동마다 따로 하면 갈린다).
 *
 * ★수식키를 **역순으로 놓는** 규칙은 `key` 행동과 **같은 규칙**이다. 두 곳에 쓰지 않으려고
 *  래퍼로 뺐다 — 같은 판단이 두 곳이면 한쪽만 고쳐진다.
 */
const withHold = (hold: Hold | undefined, inner: Plan): Plan => {
  if (!inner.ok || hold === undefined || hold.length === 0) return inner;
  const mods = hold.filter(isModifier);
  if (mods.length === 0) return inner;
  return {
    ok: true,
    events: [
      ...mods.map((m): LowEvent => ({ t: "keydown", key: m })),
      ...inner.events,
      ...[...mods].reverse().map((m): LowEvent => ({ t: "keyup", key: m })),
    ],
    // ★행동이 끝날 때까지 **눌린 채**다 — 장부에 오른다(자식이 죽으면 이걸로 되돌린다).
    holds: { keys: [...mods, ...inner.holds.keys], buttons: inner.holds.buttons },
    describe: `${mods.join("+")} 를 누른 채 ${inner.describe}`,
  };
};

export const plan = (action: Action, frame: Frame): Plan =>
  withHold("hold" in action ? action.hold : undefined, planInner(action, frame));

const planInner = (action: Action, frame: Frame): Plan => {
  switch (action.kind) {
    case "click": {
      const pt = imagePointToScreen({ x: action.x, y: action.y }, frame.geometry);
      if (pt === null) return { ok: false, why: "offscreen" };
      const ev: LowEvent[] = [{ t: "mousemove", x: pt.x, y: pt.y }];
      for (let i = 1; i <= action.count; i += 1) {
        ev.push({ t: "mousedown", x: pt.x, y: pt.y, button: action.button, count: i });
        ev.push({ t: "mouseup", x: pt.x, y: pt.y, button: action.button, count: i });
      }
      return {
        ok: true,
        events: ev,
        // ★**버튼을 장부에 안 올린다** — 이 계획은 누른 것을 자기 안에서 전부 뗀다.
        //  장부는 «계획이 끝나도 눌린 채 남는 것» 을 위한 자리다(지금은 드래그가 없어 빈다).
        holds: { keys: [], buttons: [] },
        // ★**어느 단위의 좌표인지 밝힌다** (2026-09-18, 회사돌쇠 4차). 관측 응답은 «화면
        //  좌표(당신이 준 그림 좌표를 옮긴 값)» 라고 붙여 주는데 행동 응답만 안 붙었다 —
        //  모델이 이 수를 «내가 준 그림 좌표» 로 되읽고 다음 좌표를 거기서 셈할 수 있다.
        //  둘을 나란히 적으면 되읽을 여지가 없다.
        describe: `그림 (${action.x},${action.y}) = 화면 (${pt.x},${pt.y}) 을 ${action.button === "left" ? "왼쪽" : action.button === "right" ? "오른쪽" : "가운데"} 버튼으로 ${action.count}번 눌렀습니다`,
      };
    }
    case "scroll": {
      const pt = imagePointToScreen({ x: action.x, y: action.y }, frame.geometry);
      if (pt === null) return { ok: false, why: "offscreen" };
      if (action.dx === 0 && action.dy === 0) return { ok: false, why: "empty" };
      return {
        ok: true,
        events: [
          { t: "mousemove", x: pt.x, y: pt.y },
          { t: "scroll", x: pt.x, y: pt.y, dx: action.dx, dy: action.dy },
        ],
        holds: { keys: [], buttons: [] },
        // ★★**«보냈다» 와 «됐다» 를 가른다** (2026-09-17 돌쇠 지적). 스크롤은 **경계에
        //  닿으면 아무 일도 안 일어나는데** 도구가 «스크롤했습니다» 라고 답했다. 실제로
        //  그것 때문에 «스크롤이 안 된다» 는 오진이 한 번 나왔다(뷰가 이미 맨 아래였다).
        //  우리가 아는 것은 **입력을 보냈다** 까지다 — 효과는 재관측만이 안다.
        // ★«끝에 닿았다» 만 적어두면 **덜 움직인 것을 «경계였구나» 로 읽는다** (3차 §7-3).
        //  실측: 앱이 한 이벤트로 받는 양에 상한이 있어, 끝이 아닌데도 덜 움직인다.
        describe: `그림 (${action.x},${action.y}) = 화면 (${pt.x},${pt.y}) 에서 ${action.dy !== 0 ? `세로 ${action.dy}` : ""}${action.dx !== 0 ? ` 가로 ${action.dx}` : ""} 만큼 스크롤 입력을 보냈습니다(끝에 닿았거나 앱이 한 번에 받는 양이 제한돼 **덜 움직일 수 있습니다** — 재관측으로 확인하세요)`,
      };
    }
    case "drag": {
      const from = imagePointToScreen({ x: action.fromX, y: action.fromY }, frame.geometry);
      const to = imagePointToScreen({ x: action.toX, y: action.toY }, frame.geometry);
      if (from === null || to === null) return { ok: false, why: "offscreen" };
      if (from.x === to.x && from.y === to.y) return { ok: false, why: "empty" };
      // ★**중간 이동을 넣는다.** down → up 만 쏘면 앱이 «클릭» 으로 읽고 끌리지 않는다.
      //  창 이동·선택처럼 경로를 보는 UI 가 많다.
      // ★**부드럽게**(2026-09-17 정태님). 단계가 적으면 커서가 «순간이동» 하듯 가고, 경로를
      //  보는 UI(스냅·자석·드래그 미리보기)가 중간을 놓친다. 실행부가 이벤트마다 ~12ms 를
      //  두므로 24단계면 약 0.3초 — 사람 손과 비슷한 속도다.
      const STEPS = 24;
      const ev: LowEvent[] = [
        { t: "mousemove", x: from.x, y: from.y },
        { t: "mousedown", x: from.x, y: from.y, button: action.button, count: 1 },
      ];
      for (let i = 1; i <= STEPS; i += 1) {
        ev.push({
          t: "mousedrag",
          x: Math.round(from.x + ((to.x - from.x) * i) / STEPS),
          y: Math.round(from.y + ((to.y - from.y) * i) / STEPS),
          button: action.button,
        });
      }
      ev.push({ t: "mouseup", x: to.x, y: to.y, button: action.button, count: 1 });
      return {
        ok: true,
        events: ev,
        // ★**버튼이 장부에 오른다** — 계획 도중 눌린 채로 지나므로, 자식이 여기서 죽으면
        //  버튼이 눌린 채 남는다. §15-1 이 «지금은 드래그가 없어 장부가 빈다» 고 적었는데,
        //  이제 안 빈다. 장부를 미리 만들어 둔 값이 여기서 나온다.
        holds: { keys: [], buttons: [action.button] },
        describe: `그림 (${action.fromX},${action.fromY})→(${action.toX},${action.toY}) = 화면 (${from.x},${from.y})→(${to.x},${to.y}) 로 끌었습니다`,
      };
    }
    case "type": {
      if (action.text === "") return { ok: false, why: "empty" };
      // ★**한 덩이로 주입한다** — 글자마다 키코드를 찾지 않는다. 그 길은 한글에서 성립하지
      //  않고(조합 문자), 양 OS 가 코드포인트 주입을 제공하는 이유가 그것이다.
      return {
        ok: true,
        events: [{ t: "unicode", text: action.text }],
        holds: { keys: [], buttons: [] },
        describe: `${action.text.length}자를 입력으로 보냈습니다`,
      };
    }
    case "key": {
      if (action.keys.length === 0) return { ok: false, why: "empty" };
      const mods = action.keys.filter(isModifier);
      const rest = action.keys.filter((k) => !isModifier(k));
      const ev: LowEvent[] = [];
      for (const m of mods) ev.push({ t: "keydown", key: m });
      for (const k of rest) {
        ev.push({ t: "keydown", key: k });
        ev.push({ t: "keyup", key: k });
      }
      // ★수식키는 **역순**으로 놓는다 — 누른 순서의 반대여야 짝이 맞는다.
      for (const m of [...mods].reverse()) ev.push({ t: "keyup", key: m });
      return {
        ok: true,
        events: ev,
        // ★수식키는 계획 도중 **눌린 채로 있다** — 여기서 자식이 죽으면 남는다. 그래서 장부.
        holds: { keys: [...mods], buttons: [] },
        describe: `${action.keys.join("+")} 를 키 입력으로 보냈습니다`,
      };
    }
  }
};

/** 계획이 실패했을 때 모델에게 할 말. */
export const planRejection = (why: "offscreen" | "empty"): string =>
  why === "offscreen"
    ? "그 좌표는 이미지 밖입니다. 관측 결과의 이미지 안쪽 픽셀 좌표로 주세요 — 화면 좌표나 0~1 비율이 아닙니다."
    : "할 일이 비어 있습니다(빈 문자열·0 스크롤·빈 키 조합).";

/** 리스를 못 잡았을 때 — 기다리라고 하지 않는다(큐가 아니다). */
export const beginRejection = (b: Exclude<Begin, { ok: true }>): string => {
  switch (b.reason) {
    case "user-active":
      return "지금 사용자가 그 컴퓨터를 쓰고 있습니다. 화면 보기는 되지만 조작은 하지 않습니다 — 잠시 뒤 다시 시도하거나 사용자에게 물어보세요.";
    case "idle-unknown":
      return (
        "사람이 그 컴퓨터를 쓰는 중인지 **알 수 없어서** 조작하지 않았습니다(유휴 시간을 읽지 " +
        "못했습니다). 기다려도 저절로 풀리지 않습니다 — **로그를 보고 원인을 확인**하세요. " +
        "화면 보기는 그대로 됩니다."
      );
    case "busy-self":
      return "이미 다른 조작이 진행 중입니다. **한 번에 하나씩** 하세요 — 앞의 결과를 받고 나서 다음을 부르세요.";
    case "busy-other":
      return `데스크톱이 사용 중입니다 (${b.heldBy} 가 쓰는 중). 기다리지 말고 그 작업이 끝난 뒤 다시 시도하거나, 매니저라면 자식 작업의 순서를 세워 주세요.`;
  }
};
