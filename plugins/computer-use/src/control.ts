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
  | { t: "keyup"; key: string }
  /**
   * **시간만 보낸다** — 경계가 **아니다**(§15-23·15-27 계약 1).
   *
   * ★`wait` 는 «대상이 맞는지» 확인하지 않는다. 기다린 뒤 «이제 바뀌었겠지» 로 넘어가는
   *  열은 계약 위반이고, 그런 대기가 필요하면 **`do` 를 끊고 다시 본다.**
   */
  | { t: "wait"; ms: number }
  /**
   * **여기까지 왔다** — 실행부가 이 줄을 stdout 에 **흘린다**(계약 3).
   *
   * ★이게 없으면 자식이 죽었을 때 «몇 번째에서 멈췄나» 를 말할 수단이 아예 없다.
   *  ★Windows 는 줄마다 **명시적 flush** 가 필요하다 — 실측 1/3 vs 3/3(§15-27).
   */
  | { t: "mark"; i: number }
  /**
   * **쏘기 직전 재확인** — 전면 창이 여전히 그것인가(계약 1).
   *
   * ★★**자식 «안» 에 있어야 한다.** 실측: 자식 안 0.10ms(mac)·0.030ms(Windows) vs 따로
   *  띄우면 64ms — **640배**다. 밖으로 나가는 순간 «매 step 마다» 가 불가능해진다.
   * ★★**«모른다» 는 «같다» 가 아니다.** 실행부가 전면 창을 못 읽으면(실측: 데스크톱 없는
   *  세션에서 `GetForegroundWindow()` 가 0) **멈춘다** — 조작은 모르면 안 누른다(§14-7).
   */
  | { t: "guard"; front: string };

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
  /** 캡처 시각(ms). 관측 기록에 쓴다. */
  atMs: number;
  /** 전달 이미지와 관측 대상이 완전히 같을 때만 반복 안내에 사용한다. */
  observation?: { fingerprint: string; repeats: number };
  geometry: FrameGeometry;
  /** 이 프레임을 찍은 소유자(스레드). 남의 프레임 위에서 클릭하지 않는다. */
  owner: string;
  /**
   * **이 프레임을 찍은 대상** — 사후 관측이 **같은 화면**을 다시 본다(2026-09-19).
   *
   * ★★이게 없어서 `do` 가 사후 장면을 `{kind:"screen"}` 으로 **고정**해 찍었다. 보조
   *  모니터 위에서 행동해도 주 모니터가 돌아왔고, 그러면 모델이 **다른 화면으로 결과를
   *  판정**한다. 「무엇을 보고 한 행동인가」가 프레임의 정의인데 그 절반이 빠져 있었다.
   */
  target: import("./observe.js").CaptureTarget;
  /**
   * **찍을 때의 전면 창** — 열 안의 재확인이 이 값과 비교한다(계약 1).
   *
   * ★`null` = 그때 못 읽었다. 그러면 비교할 기준이 없으므로 **가드를 넣지 않는다** —
   *  없는 기준으로 막으면 조작이 통째로 불능이 되고, 그건 «모르면 안 누른다» 가 아니라
   *  «모르면 아무것도 못 한다» 다. 대신 그 사실을 응답에 적는다(가드가 없었다고).
   */
  front: string | null;
}

/** 시간 경과만으로 프레임을 거절하지 않는다. 재관측 필요성은 모델이 판단한다.
 * 소유권·실행 후 무효화·최근 관측 보관 한도는 유지한다. */
export type FrameReject = "missing" | "unknown" | "other-owner";
export type FrameCheck =
  | { ok: true; frame: Frame }
  | { ok: false; why: FrameReject };
export const FRAME_KEEP = 3;

/** 새 프레임을 앞에 놓고 **최근 몇 장만** 남긴다 — 순수. */
export const rememberFrame = (kept: readonly Frame[] | undefined, frame: Frame): Frame[] =>
  [frame, ...(kept ?? []).filter((f) => f.id !== frame.id)].slice(0, FRAME_KEEP);

export const frameCheck = (
  kept: readonly Frame[] | undefined,
  frameId: string,
  owner: string,
): FrameCheck => {
  // ★★**«안 준 것» 과 «모르는 것» 은 처방이 다르다** (2026-09-18, 아스트라 실기 101분).
  //  종전엔 빈 문자열이 `unknown` 으로 흘러 «`look` 으로 지금 화면을 보고 좌표를
  //  다시 정하세요» 라는 답을 받았다. 그런데 **모델이 이미 하고 있던 것이 그 호출**이었다 —
  //  처방이 제 발을 가리켰고, 같은 인자로 **720번** 같은 오류를 받았다.
  //  ★한 번도 받은 적이 없는 것과, 받았는데 낡은 것은 **다른 말을 해야 한다.**
  if (frameId.trim() === "") return { ok: false, why: "missing" };
  const found = (kept ?? []).find((f) => f.id === frameId);
  if (found === undefined) return { ok: false, why: "unknown" };
  if (found.owner !== owner) return { ok: false, why: "other-owner" };
  // ★**행동이 목록을 통째로 비운다**(`endAction`) — 그래서 «클릭했으면 다시 봐라» 는 그대로
  //  강제되고, 그 사이에 여러 장을 들고 있는 것은 안전을 안 깎는다.
  return { ok: true, frame: found };
};

/** 거절을 모델이 읽는 말로 — 무엇을 해야 하는지까지 적는다. */
/**
 * **입력을 쏘다가 실패했을 때** 뭐라고 말하나 — 순수.
 *
 * ★★**«실패했다» 가 아니라 «어디까지 갔는지 모른다» 다** (2026-09-18, 아스트라 설계 검토).
 *
 *  이 세션 내내 쫓은 것은 **«보냈는데 안 됐다»** 였다(스크롤 포화·UIPI·앱이 안 받는 단축키).
 *  그 처방은 «재관측» 이다. 그런데 반대편이 있다 — **«됐는데 모른다».**
 *  자식이 시한에 걸려 SIGKILL 되면 이벤트가 **어디까지 나갔는지 알 방법이 없다.**
 *  그 처방은 정반대다: **다시 보내지 마라.**
 *
 * ★우리 조작은 **되돌릴 수 없다.** «실패했다» 로 읽혀 모델이 같은 것을 또 보내면
 *  **두 번 눌린다** — 보내기·결제·삭제가 두 번이다. 문구 하나가 그 갈림길에 있다.
 *
 * ★지금 `post` 층에서 «아무것도 안 나갔다» 를 **밖에서 구분할 수 없다**(자식이 죽은 시점을
 *  모른다). 그래서 넷으로 나누지 않고 **«모른다» 하나로 정직하게** 말한다. 셋으로 가르는
 *  것(행동/관측/안정)은 새 계약의 몫이다 — 없는 구분을 문구로 지어내지 않는다.
 */
export const postFailureMessage = (
  reason: "timeout" | "failed",
  detail: string,
): string =>
  [
    reason === "timeout"
      ? "★입력을 보내던 중 **시한을 넘겨 끊겼습니다** — 어디까지 나갔는지 알 수 없습니다."
      : "★입력을 보내던 중 **오류로 멈췄습니다** — 어디까지 나갔는지 알 수 없습니다.",
    `사유: ${detail}`,
    "**같은 행동을 다시 보내지 마세요** — 이미 적용됐을 수 있습니다(되돌릴 수 없습니다).",
    "`look` 으로 **지금 화면을 먼저 보고**, 무엇이 적용됐는지 확인한 뒤 판단하세요.",
  ].join("\n");

/**
 * **왜 못 썼나 + 다음에 무엇을 하나** — 둘은 **다른 축**이다 (2026-09-20, 보완 인계서 ①).
 *
 * ★★첫 판은 `stale` **하나만** `gaveImage` 를 봤다. 그런데 호출부는 **모든 사유**에
 *  새 그림을 실어 보낸다 — 그래서 `unknown`·`missing`·`other-owner` 는 그림을 받고도
 *  «`look` 으로 다시 보세요» 를 같이 냈다. 한 답에 **서로 다른 다음 행동**이 둘이다.
 *  (실측으로 확인: `frameRejection("unknown", {gaveImage:true})` 에 그 문장이 그대로 있었다.)
 * ★★그래서 **구조를 바꾼다** — 사유별 «설명» 과 «다음 수» 를 갈라 두고, 다음 수는
 *  **그림을 줬는지 한 곳에서** 고른다. 분기마다 기억해야 하는 구조는 또 빠뜨린다
 *  ([[feedback_hand_maintained_lists]] 의 그 모양이다).
 */
export const frameRejection = (why: FrameReject, opts?: { gaveImage?: boolean }): string => {
  // ① 왜 못 썼나 — 사유마다 다르고, 그림 유무와 **무관**하다.
  const because: Record<FrameReject, string> = {
    missing: "«화면 id» 를 아직 못 받으셨습니다.",
    unknown:
      "그 화면(frameId)을 모릅니다 — **직전 행동이 화면을 바꿨거나**(행동은 화면 id 를 전부 " +
      `무효화합니다) 너무 오래전 것입니다(최근 ${String(FRAME_KEEP)}장만 유효).`,
    "other-owner": "그 화면은 다른 작업이 찍은 것입니다.",
  };
  // ② 다음에 무엇을 하나 — **그림을 줬으면 그걸 쓰면 된다.** 못 줬을 때만 재관측을 말한다.
  const next: Record<FrameReject, string> = {
    // ★`missing` 의 재관측 안내는 «인자를 빼고» 가 핵심이다 — 부르고 있는 것이 그 도구라
    //  «다시 관측하라» 만으로는 같은 인자가 다시 온다(2026-09-18, 720회·101분).
    missing:
      "`look` 을 **아무 인자 없이** 한 번 부르세요 — `region` 도 `frameId` 도 **빼고**입니다. " +
      "그러면 전체 화면 그림과 함께 «화면 id» 를 드립니다.",
    unknown: "`look` 으로 지금 화면을 보고 좌표를 다시 정하세요.",
    "other-owner": "직접 `look` 으로 보세요.",
  };
  const gave =
    "★**아래 그림이 방금 찍은 새 화면입니다** — 그 «화면 id» 를 쓰고, 좌표는 **이 그림 " +
    "기준**으로 다시 읽으세요. `look` 을 따로 부르지 않아도 됩니다.";
  return `${because[why]} ${opts?.gaveImage === true ? gave : next[why]}`;
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
  /**
   * **같은 이유로 연달아 막힌 횟수** (2026-09-20, 정태님 실기).
   *
   * ★★«기다렸다 다시» 에 **횟수가 없었다.** 사용자가 키보드를 계속 쓰면 유휴 가드가 매번
   *  막고, 모델은 스킬이 시킨 대로 기다렸다 다시 부른다 — 실기에서 **8분 넘게** 같은
   *  `look`+`do` 를 돌았다(정태님이 그 동안 다른 창에서 타이핑 중이었으니 풀릴 수가 없다).
   * ★가드는 옳다(사람 손 위에서 조작하면 안 된다). 틀린 것은 **막힌 뒤의 안내**다 —
   *  «기다려라» 만 있고 «언제 그만두고 사람에게 말해라» 가 없었다.
   * ★**모델이 안 들고 있는 카운터는 우리가 든다.** 매 호출이 독립이라 모델은 «몇 번째인지»
   *  를 셀 수 없다. 세어서 말해주면 그때부터는 판단할 수 있다.
   * ★★**소유자별이다** (2026-09-20, 적대 검토 F7). 첫 판은 데스크톱에 **한 칸**이었는데,
   *  `sharedDesktop` 은 모듈 전역 싱글턴이라 매니저·서브에이전트가 **번갈아** 막히면
   *  매번 1로 리셋돼 승급이 **영영 안 걸린다** — 8분 루프를 끊으려고 넣은 것이 정확히
   *  «여럿이 같은 데스크톱을 쓸 때» 안 걸렸다. 그리고 아무나 한 번 통과하면 **남의
   *  연속까지 지웠다.** 소유자별로 들면 둘 다 없어진다.
   */
  blocked: Map<string, { reason: string; n: number }>;
}

export const newDesktop = (): Desktop => ({
  lease: null,
  active: null,
  held: { keys: [], buttons: [] },
  frames: new Map(),
  lastSelfInputMs: null,
  blocked: new Map(),
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
 * ★**프레임을 여기서 버린다.** 행동은 공유 데스크톱을 바꾸므로 모든 소유자의 이전 프레임을 무효화한다 —
 *  이게 «클릭 → 재관측» 을 규율이 아니라 **구조**로 만드는 한 줄이다.
 * ★리스는 **안 놓는다.** 이어지는 행동(클릭 → 입력)이 흔하고, 매번 놓으면 그 사이에 남이
 *  끼어든다. 놓는 것은 소유자 반납·취소·유휴 셋뿐이다(§3-3).
 */
export const endAction = (
  d: Desktop,
  owner: string,
  nowMs: number,
  /**
   * ★★**발사 전 거절이면 프레임을 살린다** (2026-09-19, 아스트라 외부 검토).
   *
   * 종전엔 «행동을 시도했으면» 무조건 버렸다. 그런데 좌표가 그림 밖이라 **계획 단계에서
   * 거절**된 경우처럼 **이벤트를 하나도 안 보낸** 호출까지 프레임을 지웠고, 그 거절 문구가
   * *"좌표를 다시 정하세요"* 라고 말한다 — **가리킨 그 프레임을 방금 자기가 지운 채로.**
   * 모델은 고친 좌표로 다시 부르고 「모르는 화면 id」를 받는다.
   * ★기준은 «시도했나» 가 아니라 **«쐈거나, 쐈는지 모르나»** 다. 화면이 안 바뀌었으면
   *  프레임은 여전히 유효하다.
   */
  opts?: { keepFrames?: boolean },
): void => {
  if (d.active !== null && d.active.owner === owner) d.active = null;
  if (d.lease !== null && d.lease.owner === owner) d.lease.lastTouchedMs = nowMs;
  if (opts?.keepFrames !== true) d.frames.clear();
};

/**
 * **장부를 합친다** — 순수 (2026-09-19, 아스트라 외부 검토 ⑩).
 *
 * ★★종전엔 새 행동이 `desktop.held` 에 **대입**해서 **이전 정리 실패분을 잃었다.**
 *  `releasePlan` 의 주석은 *"놓기가 실패해도 장부에 남아 다음 정리에서 다시 시도된다"*
 *  고 약속하는데, 그 재시도 경로를 **대입이 끊고 있었다** — 주석이 거짓이 된다.
 * ★중복은 안 넣는다(같은 키를 두 번 놓을 일이 없다).
 */
export const mergeHeld = (
  prev: { keys: readonly string[]; buttons: readonly Button[] },
  add: { keys: readonly string[]; buttons: readonly Button[] },
): { keys: string[]; buttons: Button[] } => ({
  keys: [...prev.keys, ...add.keys.filter((k) => !prev.keys.includes(k))],
  buttons: [...prev.buttons, ...add.buttons.filter((b) => !prev.buttons.includes(b))],
});

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

/** 계획이 실패했을 때 모델에게 할 말. */
export const planRejection = (why: PlanReject, detail?: string): string => {
  switch (why) {
    case "offscreen":
      return "그 좌표는 이미지 밖입니다. 관측 결과의 이미지 안쪽 픽셀 좌표로 주세요 — 화면 좌표나 0~1 비율이 아닙니다.";
    case "empty":
      return "할 일이 비어 있습니다(빈 문자열·0 스크롤·빈 키 조합·2점 미만 경로).";
    case "too-many":
      return `한 번에 낼 수 있는 손짓은 ${String(STEPS_MAX)}개까지입니다. 열을 끊고, 끊은 자리에서 \`look\` 으로 다시 보세요 — 긴 열일수록 중간에 어긋났을 때 되돌릴 수 없는 몫이 큽니다.`;
    case "unsupported-key":
      // ★**무엇이 문제이고 무엇을 쓸 수 있나**를 같이 말한다 — 사유만 던지면 같은 이름으로 다시 온다.
      return (
        `${detail === undefined ? "그 키" : `«${detail}»`} 는 이 플랫폼에서 낼 수 없습니다.\n` +
        `쓸 수 있는 것: 수식키(${MODIFIERS.join("·")}) · 이름 있는 키(${KEY_NAMES.join("·")}) · ` +
        "**기본 평면의 한 글자**(`a`·`가`·`5` 처럼).\n" +
        // ★★**거절만 하고 다음 길을 안 알려주면 모델은 같은 것을 다시 보낸다**
        //  (2026-09-19, 아스트라 4차 §3). 계약을 좁혔으면 **안내도 같이** 좁혀야 한다 —
        //  «한 글자면 그대로 들어간다» 를 남겨두면 `🙂` 를 거절하면서 «한 글자는 된다» 고
        //  말하는 셈이다.
        "★`🙂`·`𝐀` 같은 **보충 평면 문자는 키로 못 냅니다**(물리 키가 없습니다) — " +
        "**글자를 넣는 것이 목적이면 `steps` 의 `type` 원소**를 쓰세요.\n" +
        "★기능키(f1…)도 아직 없습니다. 그리고 맥에는 Windows 키가 없습니다 — **그 플랫폼의 주 수식키는 `cmd`** 입니다(Windows 에서는 Ctrl 로 갑니다).\n" +
        // ★★**이건 «다시 보면 풀리는» 종류가 아니다** (2026-09-20, 긴급 인계서 A).
        //  실기에서 `WIN+R` 이 막힌 뒤 `look` 이 **10회 연속**으로 돌았다(그 구간 `do` 는 0회).
        //  모델은 막히면 관측으로 복구하려 드는데, 키 이름 문제는 화면과 무관하다.
        //  **어떤 복구가 맞는지**를 거절문이 직접 말해야 한다.
        "★★**화면을 다시 찍어도 풀리지 않습니다** — 이건 화면이 아니라 **키 이름**의 문제입니다. " +
        "`look` 을 다시 부르지 말고, 위 목록에서 **키 인자를 고쳐** 같은 `do` 를 다시 부르세요."
      );
    case "scroll-too-big":
      return `한 번에 굴릴 수 있는 양을 넘었습니다(|dx|·|dy| ≤ ${String(SCROLL_MAX)}). 나눠서 굴리고 **사이사이 다시 보세요** — 그만큼 굴렸으면 화면이 이미 달라져 있습니다.`;
    case "unbalanced-key":
      // ★**장부가 거짓이 되는 것**을 막는 거절이다(계약 2). 안 누른 키를 뗀다고 적으면,
      //  정리할 때 **우리 것이 아닌 키**를 놓게 된다 — 사용자가 누르고 있던 것을 깬다.
      return "누르지 않은 키를 떼려고 했습니다. `keydown` 과 `keyup` 은 **같은 열 안에서** 짝을 맞춰 주세요.";
  }
};

/** 리스를 못 잡았을 때 — 기다리라고 하지 않는다(큐가 아니다). */
/** 이 횟수부터는 «기다려라» 가 아니라 «사람에게 말해라» 다. */
export const BLOCKED_ASK_USER_AT = 3;

export const beginRejection = (b: Exclude<Begin, { ok: true }>, streak = 1): string => {
  switch (b.reason) {
    case "user-active":
      // ★★**«기다려라» 에 끝을 붙인다.** 사용자가 계속 쓰고 있으면 기다림은 안 풀린다 —
      //  그때 필요한 것은 더 기다리는 게 아니라 **사람에게 말하는 것**이다.
      return streak >= BLOCKED_ASK_USER_AT
        ? `★**${String(streak)}번째로 같은 이유로 막혔습니다** — 사용자가 계속 그 컴퓨터를 ` +
            "쓰고 있습니다. **더 기다리지 마세요.** 지금 하던 것을 멈추고 사용자에게 " +
            "«키보드·마우스에서 손을 떼시면 이어서 하겠습니다» 라고 말한 뒤, 답을 받고 다시 " +
            "시작하세요. 화면 보기는 그대로 됩니다."
        : "지금 사용자가 그 컴퓨터를 쓰고 있습니다. 화면 보기는 되지만 조작은 하지 않습니다.\n" +
          // ★★**`look` 은 «지금 조작해도 되나» 를 안 알려준다** (2026-09-20, 긴급 인계서 B).
          //  실기에서 모델이 막힌 뒤 `look` 을 10회 연속 불렀다 — 관측으로는 유휴 상태를
          //  알 수 없으니 **같은 화면을 다시 찍는 것이 대기의 대용이 될 수 없다.**
          "★**`look` 을 반복해도 풀렸는지 알 수 없습니다** — 관측은 «지금 조작해도 되는가» 를 " +
          "말해주지 않습니다. 잠시 뒤 **`do` 를 다시** 시도하거나, 사용자에게 물어보세요.";
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

// ─── 열(steps) — `do` 의 본체 (2026-09-19, §15-23·15-27) ─────────────────────

/**
 * **손짓 하나** — 완전 원시가 아니다(§15-23).
 *
 * ★`click` 을 `down`/`up` 둘로 **안 쪼갠다**: mac 더블클릭은 `kCGMouseEventClickState` 라
 *  두 번 누르는 것으로 **표현이 안 된다**(코드 확인). 어휘의 단위는 «OS 가 한 뜻으로 받는
 *  것» 이지 «가장 작은 것» 이 아니다.
 * ★`hold` 가 없다 — 수식키는 `keydown`/`keyup` **원소**로 열 안에 드러난다. 그래서
 *  「shift 누른 채 여러 번 클릭」이 특별한 개념 없이 그냥 열이 된다.
 * ★`drag` 가 **경로**를 받는다 — 종전 `from → to` 직선 하나라 곡선을 못 그렸고, 오리를
 *  직선 32개로 근사하며 32번 재관측했다(44분). **잘못된 추상이 잘못된 답을 만들었다.**
 */
export type Step =
  | { t: "click"; x: number; y: number; button?: Button; count?: number }
  | { t: "drag"; path: readonly { x: number; y: number }[]; button?: Button }
  | { t: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: "type"; text: string }
  | { t: "keydown"; key: string }
  | { t: "keyup"; key: string }
  | { t: "wait"; ms: number };

/** 열 하나의 상한 — 잠정. ★안 잰 값이다(예산 계약이 실제 상한을 정한다, §15-27 계약 4). */
export const STEPS_MAX = 64;

/**
 * 드래그 보간 — 구간을 **이 픽셀마다** 한 점씩 나눈다.
 *
 * ★옛 계획기는 거리와 무관하게 24단계였다. 실행부가 이벤트마다 ~12ms 를 두므로 24단계면
 *  약 0.3초 — 사람 손과 비슷한 속도다. 경로를 받게 되면서 **거리 비례**로 바꿨다:
 *  짧은 구간까지 24로 쪼개면 곡선 하나가 수백 이벤트가 되고, 그만큼 느려진다.
 * ★★**안 잰 값이다.** 「16px 마다」는 옛 24단계를 전형적인 창 이동 거리(~400px)에 맞춘
 *  것이지 실측이 아니다 — 스냅·자석 UI 가 놓치는 간격을 재서 확정해야 한다.
 */
export const DRAG_STEP_PX = 16;
/** 한 구간이 낼 수 있는 중간 점의 상한 — 긴 구간 하나가 열 전체를 잡아먹지 않게. */
export const DRAG_MAX_SUBSTEPS = 32;

export type StepsPlan =
  | {
      ok: true;
      events: LowEvent[];
      /**
       * **열이 끝난 뒤에도 눌린 채 남는 것** — 짝이 안 맞은 `keydown` 들이다.
       * 정상 종료 뒤의 정리 대상이고, 결과 보고가 «아직 눌려 있다» 고 말할 근거다.
       */
      holds: { keys: string[]; buttons: Button[] };
      /**
       * ★★**열이 «도중에» 누르는 것 전부** — 부모 장부에 **쏘기 전에** 오르는 값이다(계약 2).
       *
       * ★`holds` 와 다르다: 짝이 맞은 `keydown`/`keyup` 도, 드래그의 버튼도 **여기 든다.**
       *  자식이 `mousedown` 과 `mouseup` **사이에서 죽으면** 버튼이 눌린 채 시스템에 남기
       *  때문이다 — 되돌릴 근거는 장부뿐인데, 「끝나고 남는 것」만 담으면 그 순간 장부가
       *  **비어 있다.**
       * ★이 구분을 잃을 뻔했다: 열로 옮기며 `holds.buttons` 를 늘 빈 배열로 뒀고, 옛 회귀를
       *  포팅하다 그 자리에서 잡혔다([[feedback_scope_of_a_fix]] 의 «계약변경 → 호출부»).
       */
      touched: { keys: string[]; buttons: Button[] };
      /** step 별 한 줄 설명 — 결과 보고가 «무엇을 했나» 를 말할 재료다. */
      describes: string[];
    }
  | {
      ok: false;
      why: PlanReject;
      /** 거절을 부른 구체적인 값(키 이름 등) — 문구가 **무엇이 문제인지** 말할 재료다. */
      detail?: string;
    };

/**
 * 열을 거절하는 사유 — ★**한 곳에만 적는다.** 여기와 `planRejection` 에 따로 적으면 한쪽만
 * 늘어나고, 그때 컴파일러가 아무 말도 안 한다([[feedback_hand_maintained_lists]]).
 */
export type PlanReject =
  | "offscreen"
  | "empty"
  | "too-many"
  | "unbalanced-key"
  | "unsupported-key"
  | "scroll-too-big";

/**
 * **이 플랫폼에 없는 키 이름** — 순수 (2026-09-19, 아스트라 외부 검토 5-2).
 *
 * ★★종전엔 스키마가 `win` 을 광고하고 **mac 실행부가 던졌다.** 그리고 그 던짐은 열
 *  **한가운데**에서 일어난다 — 앞 step 은 이미 발사된 뒤다. 「없는 키」를 **쏘기 전에**
 *  걸러야 부분 실행이 안 생긴다.
 * ★손 목록이지만 **묶여 있다**: 회귀가 «여기 적힌 이름을 실행부가 실제로 거절하는가» 를
 *  재므로, 둘이 갈리면 빨개진다([[feedback_hand_maintained_lists]] 의 처방 그대로).
 */
export const PLATFORM_KEY_GAPS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["win"],
};

/**
 * **이름으로 부를 수 있는 키** — 양 실행부의 표가 **공통으로** 아는 것.
 *
 * ★★**금지 목록이 아니라 허용 목록이다**(2026-09-19, 아스트라 재검토 §2). 처음엔
 *  `PLATFORM_KEY_GAPS` 하나로 막았는데 그건 **아는 이름만** 막는다 — `f5` 는 양쪽 표
 *  **어디에도 없는데** 계획을 통과하고, 실행부가 **열 한가운데서** 던진다. 앞 step 은
 *  이미 발사된 뒤다. 「이미 아는 한 입력을 막았다」가 아니라 **「어떤 미지원 입력도 앞선
 *  행동을 실행시키지 않는다」** 여야 한다([[feedback_hand_maintained_lists]]).
 * ★한 글자는 **규칙으로** 통과한다(실행부가 유니코드로 낸다) — 그래서 목록에 글자·숫자를
 *  넣지 않는다. 목록은 «한 글자로 못 쓰는 이름» 만 진다.
 * ★이 목록은 회귀가 **양 실행부 표와 대조**한다 — 한쪽에만 생기면 빨개진다.
 */
export const KEY_NAMES: readonly string[] = [
  "enter", "return", "tab", "esc", "escape", "space", "backspace", "delete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
];

/**
 * **이 플랫폼에서 그 키를 낼 수 있나** — 순수.
 *
 * ★세 갈래뿐이다: 수식키 · 이름 있는 키 · **한 글자**(유니코드로 낸다).
 *  셋 다 아니면 실행부가 던진다 — 그러니 **쏘기 전에** 여기서 거른다.
 */
/**
 * **키 이름을 입력 경계에서 한 번 정규화한다** (2026-09-20, 긴급 인계서 A).
 *
 * ★★사고: 수식키는 `isModifier` 가 **원문으로** 비교하고 named key 만 `toLowerCase` 를
 *  썼다. 그래서 실측으로 `win`=통과 / **`WIN`=거절**, `ctrl`=통과 / **`CTRL`=거절**,
 *  그런데 `enter`·`ENTER` 는 **둘 다 통과**였다. 모델이 `WIN+R` 을 보내면 `unsupported-key`
 *  로 막히는데, **그건 화면을 다시 찍어서 풀리는 종류가 아니다** — 실기에서 그 뒤
 *  `look` 이 **10회 연속**으로 돌았다(그 구간 `do` 는 0회).
 * ★★**한 글자는 절대 안 바꾼다.** `R` 과 `r` 은 다른 입력이고, `type` 본문은 더더욱이다.
 *  바꾸는 것은 **여러 글자짜리 이름**뿐이다(`WIN`·`CTRL`·`Shift`·`ENTER`…).
 * ★그리고 정규화한 값이 **검증·발사·장부·해제까지 같은 값으로 흐른다.** 검증만 소문자로
 *  하고 장부에 원문을 담으면 «누른 키» 와 «뗄 키» 가 갈린다 — 그게 미아를 만든다.
 * ★mac 의 `win` 금지를 **대문자로 우회할 수 없다** — 정규화가 금지 판정보다 앞에 온다.
 */
export const normalizeKey = (name: string): string =>
  name.length > 1 ? name.toLowerCase() : name;

export const supportedKey = (rawName: string, platform?: string): boolean => {
  // ★**금지 판정보다 정규화가 먼저다** — 안 그러면 `WIN` 이 mac 의 `win` 금지를 지나간다.
  const name = normalizeKey(rawName);
  const gaps = platform === undefined ? [] : (PLATFORM_KEY_GAPS[platform] ?? []);
  if (gaps.includes(name)) return false;
  if (isModifier(name)) return true;
  if (KEY_NAMES.includes(name)) return true;
  // ★★**실행부와 «한 글자» 의 뜻이 같아야 한다** (2026-09-19, 아스트라 3차 §2).
  //  처음엔 `[...name].length`(코드포인트)로 셌는데 **양 실행부는 UTF-16 길이**로 본다
  //  (`String(name).length !== 1` · `$n.Length -ne 1`). 그래서 `🙂`(코드포인트 1 · UTF-16 2)가
  //  **계획을 통과하고 실행부가 던졌다** — 앞 step 은 이미 발사된 뒤다. `f5` 와 **같은
  //  실패 모양이 다른 입력으로** 남아 있었다.
  //  ★★더 나쁜 것은 **내 회귀가 그 거짓 계약을 단언으로 박아** 두었다는 것이다
  //   («이모지도 키로 된다»). 검사가 제품과 다른 약속을 고정하면 그 검사는 방패가 아니라
  //   **잠금**이다.
  //  ★보충 평면 문자를 **넣을** 길이 없어지는 것은 아니다 — 그건 `key` 가 아니라
  //   **`type` 원소**가 진다(유니코드 주입은 거기가 정본이다).
  return name.length === 1;
};

/**
 * **한 step 이 낼 수 있는 스크롤 상한** — 잠정.
 *
 * ★★**실행부의 상한에 도달하지 못하게** 두는 값이다(2026-09-19). Windows 는 한 번에 120씩
 *  최대 200회를 도는데 `units = dy × 2` 라, `|dy| > 12,000` 이면 **조용히 잘린다** —
 *  「쐈는데 일부만 됐고 아무도 모른다」가 된다. 상한을 그 절반에 둬서 **가드가 도달
 *  불가**가 되게 한다([[project_hotpath_bound_preserve_record]] 의 «캡 있는 자리에 반드시
 *  도달해야 할 것을 두지 마라»).
 * ★6,000 = 100눈금 ≈ 300줄. 한 step 에 그 이상이 필요하면 **끊고 다시 보는 것**이 맞다 —
 *  그만큼 굴렸으면 화면이 완전히 달라져 있다.
 */
export const SCROLL_MAX = 6_000;

/**
 * **열 → 이벤트 목록** — 순수. 좌표 변환도 장부 계산도 여기서 **한 번만** 일어난다.
 *
 * ★★**장부는 열 전체가 가진다**(계약 2). 개별 원소가 자기 수식키를 치우지 않는다 —
 *  `keydown shift → drag → keyup shift` 에서 `drag` 가 스스로 정리하면 바깥 계약이 깨진다.
 *  여기서는 `keydown`/`keyup` 원소가 장부를 **누적**하고, 끝에 남은 것이 `holds` 다.
 * ★**가드는 «쏘기 직전»** 에 넣는다 — 글자·키를 내는 원소 앞이다. 마우스 원소는 **좌표가
 *  창을 고르므로** 가드 대신 좌표 판정(`imagePointToScreen`)이 그 일을 한다.
 * ★`frame.front` 가 `null` 이면 가드를 **안 넣는다**: 비교 기준이 없는데 막으면 «모르면 안
 *  누른다» 가 아니라 «모르면 아무것도 못 한다» 가 된다(§15-27 계약 1).
 */
export const planSteps = (
  steps: readonly Step[],
  frame: Frame,
  /** 없는 키를 **쏘기 전에** 거르기 위한 플랫폼. 없으면 그 검사를 건너뛴다(순수 검사용). */
  platform?: string,
): StepsPlan => {
  if (steps.length === 0) return { ok: false, why: "empty" };
  if (steps.length > STEPS_MAX) return { ok: false, why: "too-many" };
  // ★**발사 전에** 전수로 본다 — 실행부가 열 한가운데서 던지면 앞 step 은 이미 나갔다.
  for (const st of steps) {
    if ((st.t === "keydown" || st.t === "keyup") && !supportedKey(st.key, platform))
      return { ok: false, why: "unsupported-key", detail: st.key };
    if (st.t === "scroll" && (Math.abs(st.dx) > SCROLL_MAX || Math.abs(st.dy) > SCROLL_MAX))
      return { ok: false, why: "scroll-too-big" };
  }

  const events: LowEvent[] = [];
  const describes: string[] = [];
  const heldKeys: string[] = [];
  const touchedKeys: string[] = [];
  const touchedButtons: Button[] = [];
  const touchButton = (b: Button): void => {
    if (!touchedButtons.includes(b)) touchedButtons.push(b);
  };
  const guard = (): void => {
    if (frame.front !== null) events.push({ t: "guard", front: frame.front });
  };

  for (let i = 0; i < steps.length; i += 1) {
    const st = steps[i];
    if (st === undefined) continue;
    events.push({ t: "mark", i });
    switch (st.t) {
      case "click": {
        const pt = imagePointToScreen({ x: st.x, y: st.y }, frame.geometry);
        if (pt === null) return { ok: false, why: "offscreen" };
        const button = st.button ?? "left";
        const count = st.count ?? 1;
        touchButton(button);
        events.push({ t: "mousemove", x: pt.x, y: pt.y });
        for (let n = 1; n <= count; n += 1) {
          events.push({ t: "mousedown", x: pt.x, y: pt.y, button, count: n });
          events.push({ t: "mouseup", x: pt.x, y: pt.y, button, count: n });
        }
        describes.push(
          `그림 (${st.x},${st.y}) = 화면 (${pt.x},${pt.y}) 을 ${buttonName(button)} 버튼으로 ${count}번 눌렀습니다`,
        );
        break;
      }
      case "drag": {
        // ★경로는 **두 점 이상**이어야 한다 — 한 점짜리 드래그는 클릭이고, 그건 다른 원소다.
        if (st.path.length < 2) return { ok: false, why: "empty" };
        const button = st.button ?? "left";
        touchButton(button);
        const pts: { x: number; y: number }[] = [];
        for (const p of st.path) {
          const q = imagePointToScreen(p, frame.geometry);
          if (q === null) return { ok: false, why: "offscreen" };
          pts.push(q);
        }
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first === undefined || last === undefined) return { ok: false, why: "empty" };
        events.push({ t: "mousemove", x: first.x, y: first.y });
        events.push({ t: "mousedown", x: first.x, y: first.y, button, count: 1 });
        // ★★**구간마다 «사이» 를 채운다** — 준 점만 쏘면 두 점짜리 경로가 **한 번에 튄다.**
        //  down → up 만 있으면 앱이 «클릭» 으로 읽고, 점이 듬성하면 경로를 보는 UI(스냅·
        //  자석·드래그 미리보기)가 중간을 놓친다.
        //  ★경로를 받기로 하면서 이 보장을 **잃을 뻔했다**: 종전 계획기가 24단계로 보간하던
        //   것을 «모델이 점을 촘촘히 주면 된다» 로 미루면, 촘촘히 안 주는 순간 조용히 나빠진다.
        //   **모델의 성의에 기대는 보장은 보장이 아니다.**
        //  ★거리에 비례해 나눈다 — 짧은 구간까지 24로 쪼개면 곡선 하나가 수백 이벤트가 된다
        //   (실행부가 이벤트마다 ~12ms 를 둔다).
        let prev = first;
        for (const q of pts.slice(1)) {
          const dist = Math.hypot(q.x - prev.x, q.y - prev.y);
          const n = Math.max(1, Math.min(DRAG_MAX_SUBSTEPS, Math.ceil(dist / DRAG_STEP_PX)));
          for (let k = 1; k <= n; k += 1) {
            events.push({
              t: "mousedrag",
              x: Math.round(prev.x + ((q.x - prev.x) * k) / n),
              y: Math.round(prev.y + ((q.y - prev.y) * k) / n),
              button,
            });
          }
          prev = q;
        }
        events.push({ t: "mouseup", x: last.x, y: last.y, button, count: 1 });
        describes.push(
          `그림 (${String(st.path[0]?.x)},${String(st.path[0]?.y)}) 에서 ${st.path.length}점 경로로 끌어 (${String(st.path[st.path.length - 1]?.x)},${String(st.path[st.path.length - 1]?.y)}) 에 놓았습니다`,
        );
        break;
      }
      case "scroll": {
        // ★**0 스크롤은 «할 일 없음» 이다** — 옛 계획기가 지키던 것을 열로 옮기며 잃었고,
        //  포팅한 회귀가 그 자리에서 잡았다. 빈 이벤트를 쏘면 «했다» 는 기록만 남는다.
        if (st.dx === 0 && st.dy === 0) return { ok: false, why: "empty" };
        const pt = imagePointToScreen({ x: st.x, y: st.y }, frame.geometry);
        if (pt === null) return { ok: false, why: "offscreen" };
        events.push({ t: "mousemove", x: pt.x, y: pt.y });
        events.push({ t: "scroll", x: pt.x, y: pt.y, dx: st.dx, dy: st.dy });
        describes.push(`그림 (${st.x},${st.y}) 에서 dx=${st.dx} dy=${st.dy} 만큼 굴렸습니다`);
        break;
      }
      case "type": {
        if (st.text.length === 0) return { ok: false, why: "empty" };
        guard();
        events.push({ t: "unicode", text: st.text });
        describes.push(`${st.text.length}자를 입력했습니다`);
        break;
      }
      case "keydown": {
        guard();
        events.push({ t: "keydown", key: st.key });
        heldKeys.push(st.key);
        if (!touchedKeys.includes(st.key)) touchedKeys.push(st.key);
        describes.push(`${st.key} 를 눌렀습니다(아직 안 뗌)`);
        break;
      }
      case "keyup": {
        guard();
        // ★**안 누른 것을 뗄 수 없다** — 열 안에서 짝이 안 맞으면 장부가 거짓이 되고,
        //  그 장부로 정리하면 **우리 것이 아닌 키를 놓는다**(계약 2).
        const at = heldKeys.lastIndexOf(st.key);
        if (at < 0) return { ok: false, why: "unbalanced-key" };
        heldKeys.splice(at, 1);
        events.push({ t: "keyup", key: st.key });
        describes.push(`${st.key} 를 뗐습니다`);
        break;
      }
      case "wait": {
        events.push({ t: "wait", ms: st.ms });
        describes.push(`${st.ms}ms 기다렸습니다`);
        break;
      }
    }
  }
  return {
    ok: true,
    events,
    holds: { keys: heldKeys, buttons: [] },
    touched: { keys: touchedKeys, buttons: touchedButtons },
    describes,
  };
};

const buttonName = (b: Button): string =>
  b === "left" ? "왼쪽" : b === "right" ? "오른쪽" : "가운데";

/** step 하나의 운명 — §15-27 계약 3 의 어휘 그대로. */
export type StepStatus = "완료" | "불명" | "미실행";

export interface StepsOutcome {
  status: StepStatus[];
  /** 가드가 멈춘 자리(있으면). `saw` 는 그때 실제 전면 창. */
  stoppedAt?: { i: number; why: "front-changed" | "front-unknown"; saw: string };
}

/**
 * **자식이 남긴 줄 → step 별 운명** — 순수(계약 3).
 *
 * ★★**«마지막으로 본 것» 다음은 «완료» 가 아니라 «불명» 이다.** 자식이 `mark i` 를 흘린
 *  뒤 죽었다면 그 step 은 **시작은 했는데 끝을 모른다** — 되돌릴 수 없는 도구에서 그
 *  구분이 전부다(«안 했다» 면 다시 하면 되고, «모른다» 면 사람이 화면을 봐야 한다).
 * ★**완전한 줄만 읽는다** — 죽은 자식의 마지막 줄은 중간에서 잘려 있을 수 있다.
 * ★성공(`childOk`)이고 **가드가 안 멈췄으면** 전부 «완료» 다. 이때 줄을 세어 맞춰보지
 *  **않는다**: 버퍼링 때문에 줄이 덜 왔을 수 있고(Windows 실측), 그걸 «불명» 으로 읽으면
 *  **멀쩡한 실행을 의심**하게 된다. 판정의 근거는 자식의 **종료 상태**이지 줄 수가 아니다.
 *
 * ★★**그런데 «종료 상태» 만 믿으면 안 된다**(2026-09-19, 실기가 즉시 잡았다). 가드가 멈춘
 *  실행은 **자식이 정상 종료(0)한 부분 실행**이다 — 처음 쓸 때 `childOk` 를 먼저 보고
 *  단락시켜서, 2번 step 이 아예 안 돌았는데 «완료» 라고 답했다. **먼저 읽고 그다음 판정한다.**
 */
export const stepsOutcome = (
  stdout: string,
  stepCount: number,
  childOk: boolean,
): StepsOutcome => {
  let lastMark: number | null = null;
  let stopped: StepsOutcome["stoppedAt"];
  // 마지막 줄은 잘려 있을 수 있으므로 **파싱되는 줄만** 쓴다.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let v: { step?: number; stopped?: number; why?: string; saw?: string };
    try {
      v = JSON.parse(trimmed) as typeof v;
    } catch {
      continue;
    }
    if (typeof v.step === "number") lastMark = v.step;
    if (typeof v.stopped === "number" && (v.why === "front-changed" || v.why === "front-unknown")) {
      stopped = { i: v.stopped, why: v.why, saw: typeof v.saw === "string" ? v.saw : "(못 읽음)" };
    }
  }

  // 가드가 안 멈췄고 자식이 정상 종료했으면 전부 완료다.
  if (stopped === undefined && childOk) {
    return { status: Array.from({ length: stepCount }, () => "완료" as const) };
  }

  const status: StepStatus[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    if (stopped !== undefined) {
      // 가드가 멈춘 것은 **쏘기 전**이다 — 그 step 부터는 확실히 «미실행» 이다.
      status.push(i < stopped.i ? "완료" : "미실행");
      continue;
    }
    if (lastMark === null) status.push("미실행");
    else if (i < lastMark) status.push("완료");
    else if (i === lastMark) status.push("불명");
    else status.push("미실행");
  }
  return stopped === undefined ? { status } : { status, stoppedAt: stopped };
};
