/**
 * 회귀: **조작이 겹치지도, 사람 손 위에서 눌리지도, 낡은 화면 위에서 일어나지도 않는다**
 * (2026-09-17, 설계 §15).
 *
 * ★관측 회귀(`computer-use-observation-is-bounded`)와 가르는 기준은 «관측 대 조작» 이다.
 *  거기는 «매달리지 않는다·쌓이지 않는다», 여기는 **«되돌릴 수 없는 일을 함부로 하지
 *  않는다»** 다. 클릭은 취소가 없다.
 *
 * ★이 검사는 **순수부를 실행한다.** 실제 커서를 움직이지 않는다 — 회귀가 사용자 화면을
 *  조작하면 안 되고(principle-check Q7), 무엇보다 결과가 결정적이지 않다.
 * ★★그래서 **이 검사가 못 보는 것**을 여기 적어둔다: 실행부가 이 계획을 «실제로 그대로
 *  쏘는가» 는 실기다. 그 자리는 §14-4 의 종단 검증이다.
 */
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Button = "left" | "right" | "middle";
interface Geometry {
  deliveredPx: { w: number; h: number };
  capturedPx: { w: number; h: number };
  originPt: { x: number; y: number };
  scale: number;
}
interface Frame {
  id: string;
  atMs: number;
  geometry: Geometry;
  owner: string;
}
type LowEvent =
  | { t: "mousemove"; x: number; y: number }
  | { t: "mousedown"; x: number; y: number; button: Button; count: number }
  | { t: "mouseup"; x?: number; y?: number; button: Button; count: number }
  | { t: "mousedrag"; x: number; y: number; button: Button }
  | { t: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: "unicode"; text: string }
  | { t: "keydown"; key: string }
  | { t: "keyup"; key: string }
  // ★열 배관 — `plan1` 이 걷어낸다(여기선 좌표·짝만 본다, `computer-use-steps-contract` 가 따로 잰다).
  | { t: "wait"; ms: number }
  | { t: "mark"; i: number }
  | { t: "guard"; front: string };
interface Desktop {
  lastSelfInputMs: number | null;
  lease: { owner: string; lastTouchedMs: number } | null;
  active: { owner: string; startedMs: number } | null;
  held: { keys: string[]; buttons: Button[] };
  frames: Map<string, Frame[]>;
}
type Begin =
  | { ok: true }
  | { ok: false; reason: "busy-other"; heldBy: string }
  | { ok: false; reason: "busy-self" }
  | { ok: false; reason: "user-active" }
  | { ok: false; reason: "idle-unknown" };
type Plan =
  | {
      ok: true;
      events: LowEvent[];
      holds: { keys: string[]; buttons: Button[] };
      touched: { keys: string[]; buttons: Button[] };
      describes: string[];
    }
  | { ok: false; why: "offscreen" | "empty" | "too-many" | "unbalanced-key" };

interface ControlModule {
  newDesktop: () => Desktop;
  beginAction: (
    d: Desktop,
    owner: string,
    nowMs: number,
    idleSeconds: number | null,
    opts?: { leaseIdleMs?: number; userWindowMs?: number },
  ) => Begin;
  endAction: (d: Desktop, owner: string, nowMs: number) => void;
  releasePlan: (d: Desktop) => LowEvent[];
  forgetHeld: (d: Desktop) => void;
  releaseLease: (d: Desktop, owner: string) => void;
  rememberFrame: (kept: readonly Frame[] | undefined, frame: Frame) => Frame[];
  FRAME_KEEP: number;
  frameCheck: (
    kept: readonly Frame[] | undefined,
    frameId: string,
    owner: string,
    nowMs: number,
    ttlMs?: number,
  ) => { ok: true; frame: Frame } | { ok: false; why: string };
  frameRejection: (why: string, opts?: { gaveImage?: boolean }) => string;
  postFailureMessage: (reason: "timeout" | "failed", detail: string) => string;
  planSteps: (steps: readonly Record<string, unknown>[], frame: Frame) => Plan;
  planRejection: (why: string, detail?: string) => string;
  beginRejection: (b: Exclude<Begin, { ok: true }>, streak?: number) => string;
  BLOCKED_ASK_USER_AT: number;
  normalizeKey: (n: string) => string;
  supportedKey: (n: string, platform?: string) => boolean;
  userIsActive: (
    idleSeconds: number | null,
    nowMs: number,
    lastSelfInputMs: number | null,
    opts?: { windowMs?: number; selfGraceMs?: number },
  ) => boolean;
  SELF_INPUT_GRACE_MS: number;
  FRAME_TTL_MS: number;
  LEASE_IDLE_MS: number;
}

/** 실측 기하(맥, 2026-09-16): 캡처 3456×2234px · 배율 2 · 전달 긴 변 1600px. */
const GEO: Geometry = {
  deliveredPx: { w: 1600, h: 1034 },
  capturedPx: { w: 3456, h: 2234 },
  originPt: { x: 0, y: 0 },
  scale: 2,
};
const frameAt = (id: string, owner: string, atMs: number): Frame => ({ id, atMs, geometry: GEO, owner });

export const check: RegressionCheck = {
  name: "computer-use-control-is-safe",
  guards:
    "되돌릴 수 없는 조작이 사람 손 위에서 일어나는 것 · 같은 소유자의 병렬 호출이 입력을 섞는 것 · 낡거나 남의 화면 좌표로 누르는 것 · 취소 때 키가 눌린 채 남는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const {
      newDesktop,
      beginAction,
      endAction,
      releasePlan,
      forgetHeld,
      releaseLease,
      frameCheck,
      frameRejection,
      postFailureMessage,
      rememberFrame,
      FRAME_KEEP,
      planSteps,
      planRejection,
      BLOCKED_ASK_USER_AT,
      beginRejection,
      normalizeKey,
      supportedKey,
      userIsActive,
      FRAME_TTL_MS,
      LEASE_IDLE_MS,
      SELF_INPUT_GRACE_MS,
    } = await loadPluginModule<ControlModule>("../../../plugins/computer-use/src/control.ts");

    const T = 1_000_000;
    const IDLE = 30; // 사람이 30초째 안 건드림 = 가드 통과

    // ── ① 사람이 쓰는 중이면 **아무도** 못 한다 ─────────────────────────────────
    //  ★가드가 리스 **뒤**에 오면 «내 리스니까» 로 사람 손 위에서 누른다. 순서를 잰다.
    {
      const d = newDesktop();
      const first = beginAction(d, "A", T, IDLE);
      endAction(d, "A", T);
      const onUser = beginAction(d, "A", T + 1, 0.1); // 같은 소유자·리스 보유·사람 활동 중
      out.push(
        assert(
          "★사람이 쓰는 중이면 **리스를 쥔 소유자도** 못 누른다(가드가 리스보다 앞이다)",
          first.ok && !onUser.ok && !onUser.ok && onUser.reason === "user-active",
          `첫 취득 ${first.ok} · 사람활동중 ${JSON.stringify(onUser)}`,
        ),
      );
    }
    out.push(
      assert(
        "★사용자 활동을 **모르면 «쓰는 중»** 으로 본다(모름을 빈손으로 읽으면 사람 손 위에서 누른다)",
        userIsActive(null, T, null) &&
          userIsActive(Number.NaN, T, null) &&
          userIsActive(0.5, T, null) &&
          !userIsActive(10, T, null),
        `null=${userIsActive(null, T, null)} NaN=${userIsActive(Number.NaN, T, null)} 0.5s=${userIsActive(0.5, T, null)} 10s=${userIsActive(10, T, null)}`,
      ),
    );

    // ── ② 직렬화 — 리스는 «다른 소유자» 만 막는다(§14-2) ───────────────────────
    {
      const d = newDesktop();
      const a1 = beginAction(d, "A", T, IDLE);
      const a2 = beginAction(d, "A", T + 10, IDLE); // ★같은 소유자의 두 번째 호출
      const b1 = beginAction(d, "B", T + 10, IDLE);
      out.push(
        assert(
          "★**같은 소유자**의 병렬 행동도 거절한다 — 리스만으론 안 막힌다(그 구멍이 §14-2 다)",
          a1.ok && !a2.ok && !a2.ok && a2.reason === "busy-self",
          JSON.stringify(a2),
        ),
      );
      out.push(
        assert(
          "다른 소유자는 **즉시** 실패한다(큐가 아니다 — 숨은 대기를 만들지 않는다)",
          !b1.ok && b1.reason === "busy-other" && b1.heldBy === "A",
          JSON.stringify(b1),
        ),
      );
      // 행동 중에는 유휴가 지나도 남이 못 가져간다.
      const steal = beginAction(d, "B", T + LEASE_IDLE_MS * 3, IDLE);
      out.push(
        assert(
          "★**행동 중에는 유휴 만료로 뺏기지 않는다** — 긴 입력이 자기 리스를 잃으면 안 된다",
          !steal.ok && steal.reason === "busy-other",
          JSON.stringify(steal),
        ),
      );
      endAction(d, "A", T + 20);
      const after = beginAction(d, "B", T + 20 + LEASE_IDLE_MS, IDLE);
      out.push(
        assert(
          "행동이 끝나고 유휴가 지나면 남이 가져간다(죽은 소유자가 영원히 붙들지 않는다)",
          after.ok,
          JSON.stringify(after),
        ),
      );
    }

    // ── ③ 프레임 — 행동이 **자기 프레임을 무효화**한다(§14-3) ──────────────────
    {
      const d = newDesktop();
      d.frames.set("A", [frameAt("f1", "A", T)]);
      beginAction(d, "A", T, IDLE);
      const before = frameCheck(d.frames.get("A"), "f1", "A", T + 100);
      endAction(d, "A", T + 200); // ← 행동 종료가 프레임을 버린다
      const afterAct = frameCheck(d.frames.get("A"), "f1", "A", T + 300);
      out.push(
        assert(
          "★행동이 끝나면 그 프레임이 **죽는다** — «클릭했으면 다시 봐라» 가 규율이 아니라 구조다",
          before.ok && !afterAct.ok && afterAct.why === "unknown",
          `행동 전 ${before.ok} · 행동 후 ${JSON.stringify(afterAct)}`,
        ),
      );
    }
    out.push(
      assert(
        "프레임: 남의 것·낡은 것·최신 아닌 것을 **사유를 갈라** 거절한다(처방이 다르다)",
        (frameCheck([frameAt("f1", "B", T)], "f1", "A", T) as { why: string }).why === "other-owner" &&
          (frameCheck([frameAt("f1", "A", T)], "f1", "A", T + FRAME_TTL_MS + 1) as { why: string }).why === "stale" &&
          (frameCheck([frameAt("f2", "A", T)], "f1", "A", T) as { why: string }).why === "unknown",
        `${JSON.stringify(frameCheck([frameAt("f2", "A", T)], "f1", "A", T))}`,
      ),
    );
    out.push(
      assert(
        "★거절 문구가 **규칙까지** 말한다 — 오류 한 번으로 수명·한도를 배우게 한다(둘이 비대칭이면 안 된다)",
        // ★**초 수를 리터럴로 적지 않는다** — 상수를 바꾸면 검사가 «틀린 값» 을 고정한다
          //  (2026-09-20 에 30→10 으로 바꾸며 실제로 여기서 걸렸다). 상수에서 유도한다.
          frameRejection("stale").includes(`${String(Math.round(FRAME_TTL_MS / 1000))}초`) &&
            frameRejection("unknown").includes("3장"),
        `${frameRejection("stale").slice(0, 50)} / ${frameRejection("unknown").slice(0, 50)}`,
      ),
    );
    out.push(
      assert(
        "★거절 문구가 **무엇을 해야 하는지**까지 말한다(사유만 던지면 모델이 멈춘다)",
        ["unknown", "stale", "other-owner"].every((w) =>
          frameRejection(w).includes("look"),
        ),
        frameRejection("unknown").slice(0, 60),
      ),
    );

    /**
     * 옛 `plan(action)` 자리 — **계획기는 이제 `planSteps` 하나다**(2026-09-19, `look`/`do`).
     *
     * ★열 배관(`mark`·`guard`)은 `computer-use-steps-contract` 가 따로 잰다. 여기서는
     *  **좌표 변환과 짝 맞춤**만 보므로 그 둘을 걷어내고 본다 — 같은 것을 두 곳에서 재면
     *  한쪽만 고쳐지고, 그게 이 레포가 반복해 온 실패다.
     */
    const plan1 = (steps: readonly Record<string, unknown>[], f: Frame): Plan => {
      const p = planSteps(steps, f);
      return p.ok
        ? { ...p, events: p.events.filter((e) => e.t !== "mark" && e.t !== "guard") }
        : p;
    };

    // ── ④ 계획 — 좌표 변환이 **한 곳에서만** 일어난다 ──────────────────────────
    {
      const f = frameAt("f1", "A", T);
      const click = plan1([{ t: "click", x: 800, y: 517, button: "left", count: 1 }], f);
      // 800/1600 × 3456 = 1728px → ÷ 배율 2 = 864pt
      out.push(
        assert(
          "클릭: 이미지 픽셀 → 화면 좌표 변환이 계획 안에서 끝난다(실행부는 계산하지 않는다)",
          click.ok &&
            click.events[0]?.t === "mousemove" &&
            (click.events[0] as { x: number; y: number }).x === 864,
          JSON.stringify(click.ok ? click.events[0] : click),
        ),
      );
      out.push(
        assert(
          "★클릭은 **누른 것을 자기 안에서 전부 뗀다**(down/up 짝) — 장부에 버튼을 안 남긴다",
          click.ok &&
            click.events.filter((e) => e.t === "mousedown").length ===
              click.events.filter((e) => e.t === "mouseup").length &&
            click.holds.buttons.length === 0,
          JSON.stringify(click.ok ? click.events.map((e) => e.t) : click),
        ),
      );
      const off = plan1([{ t: "click", x: 1600, y: 10, button: "left", count: 1 }], f);
      out.push(
        assert(
          "★이미지 **경계 밖**은 계획 단계에서 거절한다 — 폭 값 자체(1600)는 밖이다(픽셀 인덱스는 0..1599)",
          !off.ok && off.why === "offscreen",
          JSON.stringify(off),
        ),
      );
      out.push(
        assert(
          "거절 문구가 **어떤 좌표계를 달라는지** 말한다(0~1 비율·화면 좌표 오용을 막는다)",
          planRejection("offscreen").includes("이미지 안쪽") && planRejection("offscreen").includes("0~1"),
          planRejection("offscreen").slice(0, 70),
        ),
      );
    }

    // ── ⑤ 한글 — **코드포인트 한 덩이**로 간다 ────────────────────────────────
    {
      const f = frameAt("f1", "A", T);
      const typed = plan1([{ t: "type", text: "한글 테스트" }], f);
      const emptyType = plan1([{ t: "type", text: "" }], f);
      const emptyScroll = plan1([{ t: "scroll", x: 10, y: 10, dx: 0, dy: 0 }], f);
      const emptyKeys = planSteps([], f);
      out.push(
        assert(
          "★타이핑은 **유니코드 한 덩이**다 — 글자마다 키코드를 찾으면 한글이 조합에서 깨진다",
          typed.ok &&
            typed.events.length === 1 &&
            typed.events[0]?.t === "unicode" &&
            (typed.events[0] as { text: string }).text === "한글 테스트",
          JSON.stringify(typed.ok ? typed.events : typed),
        ),
      );
      out.push(
        assert(
          "빈 입력·0 스크롤·빈 열은 «할 일 없음» 으로 거절한다(빈 이벤트를 쏘지 않는다)",
          !plan1([{ t: "type", text: "" }], f).ok &&
            !plan1([{ t: "scroll", x: 10, y: 10, dx: 0, dy: 0 }], f).ok &&
            !planSteps([], f).ok,
          `type=${JSON.stringify(emptyType)} scroll=${JSON.stringify(emptyScroll)} key=${JSON.stringify(emptyKeys)}`,
        ),
      );
    }

    // ── ⑥ ★수식키 — **순서를 정하는 쪽이 바뀌었다** (2026-09-19, `look`/`do`) ─────
    //  옛 `key` 행동은 `["cmd","shift","4"]` 를 받아 계획기가 **역순 놓기를 대신** 정했다.
    //  ★이제 열에 `keydown`/`keyup` 이 **드러나 있으므로 순서는 모델이 쓴다** — 계획기가
    //   지키는 것은 「쓴 대로 나가는가」와 「짝이 맞는가」뿐이다. 그래서 여기서 재는 것도
    //   «계획기가 뒤집어 주는가» 가 아니라 **«거짓 장부를 만들지 않는가»** 로 바뀐다.
    //  ★★역순 놓기는 사라진 게 아니라 **정리(`releasePlan`)로 옮겨갔다** — 자식이 죽어
    //   장부로 되돌릴 때가 순서가 실제로 중요한 유일한 자리다(⑦ 이 잰다).
    {
      const f = frameAt("f1", "A", T);
      const k = plan1(
        [
          { t: "keydown", key: "cmd" },
          { t: "keydown", key: "shift" },
          { t: "keydown", key: "4" },
          { t: "keyup", key: "4" },
          { t: "keyup", key: "shift" },
          { t: "keyup", key: "cmd" },
        ],
        f,
      );
      const seq = k.ok ? k.events.map((e) => `${e.t}:${"key" in e ? e.key : ""}`) : [];
      out.push(
        assert(
          "★열에 쓴 키 순서가 **그대로** 나간다(계획기가 몰래 재배열하지 않는다)",
          JSON.stringify(seq) ===
            JSON.stringify([
              "keydown:cmd",
              "keydown:shift",
              "keydown:4",
              "keyup:4",
              "keyup:shift",
              "keyup:cmd",
            ]),
          JSON.stringify(seq),
        ),
      );
      out.push(
        assert(
          "★짝이 맞은 열은 장부를 **비운 채** 끝난다 — 남길 것이 없다",
          k.ok && k.holds.keys.length === 0,
          JSON.stringify(k.ok ? k.holds : k),
        ),
      );
      out.push(
        assert(
          "★★중간에 끊긴 열(뗌이 없음)은 **장부에 남긴다** — 자식이 죽으면 그것으로 되돌린다",
          (() => {
            const half = plan1([{ t: "keydown", key: "cmd" }, { t: "keydown", key: "shift" }], f);
            return half.ok && JSON.stringify(half.holds.keys) === JSON.stringify(["cmd", "shift"]);
          })(),
          JSON.stringify(
            (() => {
              const half = plan1([{ t: "keydown", key: "cmd" }, { t: "keydown", key: "shift" }], f);
              return half.ok ? half.holds : half;
            })(),
          ),
        ),
      );
      out.push(
        assert(
          "수식키가 아닌 이름은 **그대로 넘긴다**(손 목록을 늘리지 않는다 — 실행부가 규칙으로 옮긴다)",
          seq.includes("keydown:4"),
          JSON.stringify(seq),
        ),
      );
    }

    // ── ⑦ 취소·정리 — **순서가 전부다**(§14-1) ────────────────────────────────
    {
      const d = newDesktop();
      beginAction(d, "A", T, IDLE);
      d.held = { keys: ["cmd", "shift"], buttons: ["left"] };
      const rel = releasePlan(d);
      out.push(
        assert(
          "★정리는 **버튼 먼저, 키는 역순** — 마우스가 눌린 채 키를 놓으면 그 사이가 드래그로 읽힌다",
          JSON.stringify(rel.map((e) => `${e.t}:${"key" in e ? e.key : "button" in e ? e.button : ""}`)) ===
            JSON.stringify(["mouseup:left", "keyup:shift", "keyup:cmd"]),
          JSON.stringify(rel),
        ),
      );
      out.push(
        assert(
          "★**놓기 전에는 장부를 안 비운다** — 실패하면 다음 정리가 다시 시도해야 한다",
          d.held.keys.length === 2 && d.held.buttons.length === 1,
          JSON.stringify(d.held),
        ),
      );
      forgetHeld(d);
      releaseLease(d, "A");
      out.push(
        assert(
          "★정리가 끝나면 장부가 비고 리스·활성·프레임이 **함께** 사라진다(반만 남는 상태가 없다)",
          d.held.keys.length === 0 &&
            d.held.buttons.length === 0 &&
            d.lease === null &&
            d.active === null &&
            d.frames.size === 0,
          JSON.stringify({ held: d.held, lease: d.lease, active: d.active, frames: d.frames.size }),
        ),
      );
      const next = beginAction(d, "B", T + 1, IDLE);
      out.push(
        assert(
          "정리 뒤에는 다음 소유자가 **바로** 잡는다(해제가 끝났으니 기다릴 이유가 없다)",
          next.ok,
          JSON.stringify(next),
        ),
      );
    }

    // ── ⑧ 거절 문구가 «기다려라» 라고 하지 않는다 ─────────────────────────────
    out.push(
      assert(
        "★바쁨 안내가 **기다리라고 하지 않는다**(큐가 아니다 — 숨은 대기는 도구 호출을 매단다)",
        !beginRejection({ ok: false, reason: "busy-other", heldBy: "worker:1" }).includes("기다리") ||
          beginRejection({ ok: false, reason: "busy-other", heldBy: "worker:1" }).includes("기다리지 말고"),
        beginRejection({ ok: false, reason: "busy-self" }).slice(0, 50),
      ),
    );
    out.push(
      assert(
        "사람이 쓰는 중이라는 안내는 **관측은 된다**는 것까지 말한다(모델이 아예 포기하지 않게)",
        beginRejection({ ok: false, reason: "user-active" }).includes("화면 보기는 되지만"),
        beginRejection({ ok: false, reason: "user-active" }).slice(0, 60),
      ),
    );

    // ── ⑨ ★**자기 입력에 자기가 막히지 않는다** (2026-09-17 실기에서 잡혔다) ─────────
    //  ★실제로 일어난 일: 클릭 직후의 타이핑이 `user-active` 로 거절됐다. 우리가 쏜 클릭이
    //   **OS 의 유휴 시계를 리셋**하기 때문이다(맥은 이벤트 탭을 바꿔도 클릭은 리셋한다).
    //   그래서 «마지막 입력이 우리 것인가» 를 같이 본다.
    //  ★이 판정은 **플랫폼 공통**이다 — Windows `GetLastInputInfo` 도 소스를 못 가른다.
    {
      const justClicked = T - 120; // 0.12초 전에 우리가 쐈다
      out.push(
        assert(
          "★우리가 방금 쏜 입력은 **사람으로 세지 않는다**(클릭 직후 타이핑이 자기 가드에 막히던 것)",
          !userIsActive(0.12, T, justClicked),
          `idle=0.12s · 우리입력 ${T - justClicked}ms 전 → active=${userIsActive(0.12, T, justClicked)}`,
        ),
      );
      const userTypedAfter = T - 3_000; // 우리 입력은 3초 전, 마지막 입력은 0.1초 전
      out.push(
        assert(
          "★**우리 입력보다 나중의 입력은 사람**이다 — 그때는 막는다(가드가 죽으면 안 된다)",
          userIsActive(0.1, T, userTypedAfter),
          `idle=0.1s · 우리입력 ${T - userTypedAfter}ms 전 → active=${userIsActive(0.1, T, userTypedAfter)}`,
        ),
      );
      out.push(
        assert(
          "★한 번도 안 쐈으면(null) 방금 입력은 **사람**이다(기본이 안전한 쪽이다)",
          userIsActive(0.1, T, null),
          `null → active=${userIsActive(0.1, T, null)}`,
        ),
      );
      out.push(
        assert(
          "여유(grace) 밖이면 우리 것이라도 사람으로 본다 — 여유는 **미끄러짐만** 덮는다",
          userIsActive(0.1, T, T - 100 - SELF_INPUT_GRACE_MS - 500),
          `grace=${SELF_INPUT_GRACE_MS}ms · 우리입력 ${100 + SELF_INPUT_GRACE_MS + 500}ms 전`,
        ),
      );
      // 그리고 **행동 경로 전체**로도 한 번 — 순수 판정이 맞아도 배선이 틀리면 소용없다.
      const d = newDesktop();
      d.lastSelfInputMs = T - 120;
      const again = beginAction(d, "A", T, 0.12);
      out.push(
        assert(
          "★행동 경로: 클릭 직후 **이어지는 입력이 통과한다**(실기 재현 — 여기가 막혔었다)",
          again.ok,
          JSON.stringify(again),
        ),
      );
    }

    // ── ⑩ ★드래그 — 창 이동·크기 조절이 이 하나로 된다 (2026-09-17) ──────────────
    //  ★«결국 down → 이동 → up» 이 맞다. 그래서 **도구를 셋으로 쪼개지 않았다** — 쪼개면
    //   버튼이 **턴 사이에** 눌린 채 남고, 그건 §15-1 이 없앤 상태다. 합쳐두면 눌린 창이
    //   자식 하나의 수명만큼으로 묶인다.
    {
      const f = frameAt("f1", "A", T);
      const dr = plan1([{ t: "drag", path: [{ x: 100, y: 100 }, { x: 300, y: 200 }], button: "left" }], f);
      const kinds = dr.ok ? dr.events.map((e) => e.t) : [];
      out.push(
        assert(
          "★드래그는 **누른 채 이동**(mousedrag)을 낸다 — 누른 채 mousemove 를 쏘면 앱이 안 끌린다",
          dr.ok && kinds.filter((k) => k === "mousedrag").length >= 2,
          JSON.stringify(kinds.slice(0, 6)),
        ),
      );
      out.push(
        assert(
          "드래그 순서: 이동 → 누르기 → (끌기…) → 떼기. 그리고 **떼기로 끝난다**",
          kinds[0] === "mousemove" && kinds[1] === "mousedown" && kinds[kinds.length - 1] === "mouseup",
          JSON.stringify([kinds[0], kinds[1], kinds[kinds.length - 1]]),
        ),
      );
      out.push(
        assert(
          "★★드래그는 **버튼을 «도중 장부»(touched)에 올린다** — down 과 up **사이에서** 자식이 " +
            "죽으면 눌린 채 남는데, 「끝나고 남는 것」(holds)만 담으면 그 순간 장부가 비어 있다",
          dr.ok &&
            JSON.stringify(dr.touched.buttons) === JSON.stringify(["left"]) &&
            dr.holds.buttons.length === 0,
          JSON.stringify(dr.ok ? { touched: dr.touched, holds: dr.holds } : dr),
        ),
      );
      const last = dr.ok ? dr.events[dr.events.length - 1] : undefined;
      out.push(
        assert(
          "드래그의 끝 좌표가 **놓을 자리**다(중간에서 떼면 엉뚱한 데 떨군다)",
          last !== undefined && last.t === "mouseup" && (last as { x?: number }).x === 324,
          JSON.stringify(last),
        ),
      );
      out.push(
        assert(
          "제자리 드래그·화면 밖은 계획 단계에서 거절한다",
          !plan1([{ t: "drag", path: [{ x: 10, y: 10 }], button: "left" }], f).ok &&
            !plan1([{ t: "drag", path: [{ x: 10, y: 10 }, { x: 1600, y: 10 }], button: "left" }], f).ok,
          `${JSON.stringify(plan1([{ t: "drag", path: [{ x: 10, y: 10 }], button: "left" }], f))}`,
        ),
      );
      // ★정리가 **좌표 없이** 뗀다 — (0,0) 을 쓰면 드래그 중 취소가 «구석으로 끌어다 놓기» 다.
      const d2 = newDesktop();
      d2.held = { keys: [], buttons: ["left"] };
      const rel2 = releasePlan(d2);
      out.push(
        assert(
          "★드래그 중 취소: 떼기에 **좌표를 안 싣는다**(실행부가 지금 커서 자리에서 뗀다)",
          rel2.length === 1 &&
            rel2[0]?.t === "mouseup" &&
            (rel2[0] as { x?: number }).x === undefined,
          JSON.stringify(rel2),
        ),
      );
    }

    // ── ⑪ ★«양손» — 수식키를 누른 채 마우스 (2026-09-17 정태님) ─────────────────
    //  ★키 도구·마우스 도구를 따로 부르면 **턴 사이에 키가 눌린 채** 남는다(§15-1 이 없앤
    //   상태). 한 행동에 실으면 자식 하나로 끝난다.
    {
      const f = frameAt("f1", "A", T);
      const shiftDrag = plan1(
        [
          { t: "keydown", key: "shift" },
          { t: "drag", path: [{ x: 100, y: 100 }, { x: 300, y: 200 }], button: "left" },
          { t: "keyup", key: "shift" },
        ],
        f,
      );
      const seq = shiftDrag.ok ? shiftDrag.events.map((e) => e.t) : [];
      out.push(
        assert(
          "★누른 채: **먼저 누르고 마지막에 놓는다** — 마우스 동작이 그 사이에 온다",
          seq[0] === "keydown" && seq[seq.length - 1] === "keyup" && seq.includes("mousedrag"),
          JSON.stringify([seq[0], seq[1], seq[seq.length - 2], seq[seq.length - 1]]),
        ),
      );
      out.push(
        assert(
          "★누른 채: 수식키와 버튼이 **도중 장부에 오른다** — 열 중간에서 죽어도 되돌릴 근거가 남는다",
          shiftDrag.ok &&
            shiftDrag.touched.keys.includes("shift") &&
            shiftDrag.touched.buttons.includes("left"),
          JSON.stringify(shiftDrag.ok ? shiftDrag.touched : shiftDrag),
        ),
      );
      const twoMods = plan1(
        [
          { t: "keydown", key: "cmd" },
          { t: "keydown", key: "shift" },
          { t: "click", x: 100, y: 100, button: "left", count: 1 },
          { t: "keyup", key: "shift" },
          { t: "keyup", key: "cmd" },
        ],
        f,
      );
      const ks = twoMods.ok
        ? twoMods.events.filter((e) => e.t === "keydown" || e.t === "keyup").map((e) => `${e.t}:${(e as { key: string }).key}`)
        : [];
      out.push(
        assert(
          "★누른 채: 수식키 여럿은 **역순으로 놓는다**(`key` 행동과 같은 규칙 — 래퍼 한 곳에서)",
          JSON.stringify(ks) === JSON.stringify(["keydown:cmd", "keydown:shift", "keyup:shift", "keyup:cmd"]),
          JSON.stringify(ks),
        ),
      );
      out.push(
        assert(
          "누른 채가 없으면 **아무것도 안 감싼다**(정상 경로에 잡음 0)",
          plan1([{ t: "click", x: 10, y: 10, button: "left", count: 1 }], f).ok &&
            !(plan1([{ t: "click", x: 10, y: 10, button: "left", count: 1 }], f) as { events: { t: string }[] }).events.some((e) => e.t === "keydown"),
          JSON.stringify((plan1([{ t: "click", x: 10, y: 10, button: "left", count: 1 }], f) as { events: { t: string }[] }).events.map((e) => e.t)),
        ),
      );
      const smooth = plan1([{ t: "drag", path: [{ x: 10, y: 10 }, { x: 500, y: 400 }], button: "left" }], f);
      out.push(
        assert(
          "★드래그가 **부드럽다** — 중간 이동이 충분히 많다(적으면 경로를 보는 UI 가 놓친다)",
          smooth.ok && smooth.events.filter((e) => e.t === "mousedrag").length >= 20,
          `끌기 이벤트 ${smooth.ok ? smooth.events.filter((e) => e.t === "mousedrag").length : 0}개`,
        ),
      );
    }

    // ── ⑫ ★프레임 여러 장 — «최신 하나» 는 안전 조건이 아니었다 (2026-09-17 돌쇠 3차) ──
    //  ★한 장만 두니 **확대를 한 번 하면 직전 전체 그림이 죽어서** 두 군데를 보려면 왕복이
    //   배가 됐다. 안전에 필요한 불변식은 «최신 하나» 가 아니라 **«행동이 전부 무효화한다»**
    //   이고, 그건 아래 단언이 지킨다.
    {
      const f1 = frameAt("wide", "A", T);
      const f2 = frameAt("zoom1", "A", T + 10);
      const f3 = frameAt("zoom2", "A", T + 20);
      const kept = rememberFrame(rememberFrame(rememberFrame(undefined, f1), f2), f3);
      out.push(
        assert(
          "★확대를 해도 **직전 전체 그림이 살아 있다**(두 군데를 보려고 다시 찍지 않아도 된다)",
          frameCheck(kept, "wide", "A", T + 30).ok && frameCheck(kept, "zoom2", "A", T + 30).ok,
          JSON.stringify(kept.map((f) => f.id)),
        ),
      );
      out.push(
        assert(
          `최근 ${String(FRAME_KEEP)}장만 남는다(무한히 쌓이지 않는다)`,
          rememberFrame(kept, frameAt("zoom3", "A", T + 30)).length === FRAME_KEEP,
          JSON.stringify(rememberFrame(kept, frameAt("zoom3", "A", T + 30)).map((f) => f.id)),
        ),
      );
      out.push(
        assert(
          "낡은 것은 밀려난다 — 밀려난 id 는 더 이상 안 선다",
          !frameCheck(rememberFrame(kept, frameAt("zoom3", "A", T + 30)), "wide", "A", T + 30).ok,
          JSON.stringify(rememberFrame(kept, frameAt("zoom3", "A", T + 30)).map((f) => f.id)),
        ),
      );
      // ★**행동은 전부 비운다** — 여러 장을 들고 있어도 이 불변식이 안전을 지킨다.
      const d3 = newDesktop();
      d3.frames.set("A", kept);
      beginAction(d3, "A", T, 30);
      endAction(d3, "A", T + 1);
      out.push(
        assert(
          "★행동 하나가 **그 소유자의 프레임을 전부** 무효화한다(여러 장이어도 마찬가지)",
          !frameCheck(d3.frames.get("A"), "wide", "A", T + 2).ok &&
            !frameCheck(d3.frames.get("A"), "zoom2", "A", T + 2).ok,
          JSON.stringify(d3.frames.get("A") ?? []),
        ),
      );
    }

    // ── ⑬ ★«사람이 쓰는 중» 과 «모른다» 를 가른다 (2026-09-17, Windows 실기) ──────
    //  ★실제로 일어난 일: Windows 실행부가 C# 컴파일에 실패해 유휴를 못 읽었고, 그게
    //   «사람이 쓰는 중» 으로 보고됐다. 호출자는 기다리면 풀릴 줄 알고 기다렸는데,
    //   **저절로 풀리지 않는 종류**였다. 막는 것과 «왜 막았는지» 는 다른 일이다.
    {
      const d = newDesktop();
      const unknown = beginAction(d, "A", T, null);
      out.push(
        assert(
          "★유휴를 **못 읽으면** «모른다» 로 막는다 — «사람이 쓰는 중» 으로 보고하지 않는다",
          !unknown.ok && unknown.reason === "idle-unknown",
          JSON.stringify(unknown),
        ),
      );
      out.push(
        assert(
          "모르는 것도 **막는 것은 같다**(조작은 되돌릴 수 없다 — 기본이 안전한 쪽)",
          !unknown.ok,
          JSON.stringify(unknown),
        ),
      );
      const d2 = newDesktop();
      const nan = beginAction(d2, "A", T, Number.NaN);
      out.push(
        assert(
          "숫자가 아닌 값도 «모른다» 다(조용히 통과시키지 않는다)",
          !nan.ok && nan.reason === "idle-unknown",
          JSON.stringify(nan),
        ),
      );
      const msg = beginRejection({ ok: false, reason: "idle-unknown" });
      out.push(
        assert(
          "★«모른다» 안내가 **저절로 안 풀린다는 것과 어디를 볼지**를 말한다(기다리게 두지 않는다)",
          msg.includes("알 수 없") && msg.includes("로그") && !msg.includes("잠시 뒤"),
          msg.slice(0, 80),
        ),
      );
      // 그리고 **진짜 사용자 활동**은 여전히 자기 사유로 나온다(둘이 섞이면 안 된다).
      const d3 = newDesktop();
      const busy = beginAction(d3, "A", T, 0.1);
      out.push(
        assert(
          "진짜 사용자 활동은 그대로 «사람이 쓰는 중» 이다(가르느라 잃지 않았다)",
          !busy.ok && busy.reason === "user-active",
          JSON.stringify(busy),
        ),
      );
    }

    // ── 빈 «화면 id» 는 «안 준 것» 이다 (2026-09-18, 아스트라 실기 101분) ─────
    //  ★`frameId: ""` 가 `unknown` 으로 흘러 «`observe_screen` 으로 지금 화면을 보고
    //   좌표를 다시 정하세요» 라는 답을 받았다. 그런데 **모델이 부르고 있던 것이 그
    //   도구**였다 — 처방이 제 발을 가리켰고, 같은 인자로 **720번** 같은 오류를 받으며
    //   101분을 썼다. 화면은 한 장도 못 얻었고 조작은 0회였다.
    //  ★이 검사는 «문구가 예쁜가» 가 아니라 **«무엇을 다르게 하라고 말하는가»** 를 잰다.
    {
      const d = newDesktop();
      d.frames.set("A", [{ id: "f1", atMs: T, owner: "A", geometry: GEO }]);
      const empty = frameCheck(d.frames.get("A"), "", "A", T + 100);
      const blank = frameCheck(d.frames.get("A"), "   ", "A", T + 100);
      out.push(
        assert(
          "★빈 «화면 id» 는 «모르는 id» 가 아니라 **«안 줬다»** 로 갈린다(처방이 다르다)",
          !empty.ok && empty.why === "missing" && !blank.ok && blank.why === "missing",
          `빈문자열=${JSON.stringify(empty)} · 공백=${JSON.stringify(blank)}`,
        ),
      );
      const miss = frameRejection("missing");
      out.push(
        assert(
          "★★처방이 **인자를 빼라**고 말한다 — «다시 관측하라» 는 이 자리에서 제 발을 가리킨다",
          miss.includes("없이") && miss.includes("region") && miss.includes("frameId"),
          miss.slice(0, 110),
        ),
      );
      out.push(
        assert(
          "모르는 id 는 여전히 **자기 사유**로 나온다(둘을 가르느라 하나를 잃지 않았다)",
          (() => {
            const unk = frameCheck(d.frames.get("A"), "없는id", "A", T + 100);
            return !unk.ok && unk.why === "unknown" && frameRejection("unknown") !== miss;
          })(),
          JSON.stringify(frameCheck(d.frames.get("A"), "없는id", "A", T + 100)),
        ),
      );
    }

    // ── 쏘다가 끊긴 것은 «실패» 가 아니라 «모름» 이다 (2026-09-18, 아스트라 설계 검토) ──
    //  ★이 세션은 «보냈는데 안 됐다» 만 다섯 라운드 쫓았다. 반대편이 있다 — «됐는데 모른다».
    //   자식이 SIGKILL 되면 이벤트가 어디까지 나갔는지 밖에서 알 수 없다.
    //   처방이 정반대다: 전자는 재관측, 후자는 **재시도 금지**.
    //  ★조작은 되돌릴 수 없다. «실패했다» 로 읽혀 모델이 또 보내면 **두 번 눌린다**.
    {
      const to = postFailureMessage("timeout", "4000ms 초과");
      const fa = postFailureMessage("failed", "알 수 없는 키 이름: 없는키");
      out.push(
        assert(
          "★★«실패했다» 고 말하지 않는다 — **어디까지 갔는지 모른다**고 말한다",
          !to.includes("실패했습니다") &&
            !fa.includes("실패했습니다") &&
            to.includes("알 수 없습니다") &&
            fa.includes("알 수 없습니다"),
          to.split("\n")[0] ?? "",
        ),
      );
      out.push(
        assert(
          "★★**다시 보내지 말라**고 말한다 — 되돌릴 수 없으니 재시도가 두 번 누르는 것이다",
          to.includes("다시 보내지 마세요") && fa.includes("다시 보내지 마세요"),
          to.slice(0, 120),
        ),
      );
      out.push(
        assert(
          "먼저 **보라**고 말하고, 끊긴 것과 오류로 멈춘 것을 **다른 문장**으로 가른다",
          // ★비교는 **첫 줄**끼리다 (자기 변이로 적발). 전체 문자열을 견주면 `detail` 이
          //  달라서 늘 다르고, 그러면 «사유를 가른다» 를 재는 게 아니라 «입력이 다르다» 를
          //  재는 공허한 단언이 된다.
          to.includes("look") &&
            fa.includes("look") &&
            to.split("\n")[0] !== fa.split("\n")[0],
          `${to.split("\n")[0] ?? ""} / ${fa.split("\n")[0] ?? ""}`,
        ),
      );
      out.push(
        assert(
          "«왜» 를 그대로 싣는다(로그에만 두지 않는다)",
          to.includes("4000ms 초과") && fa.includes("없는키"),
          fa.slice(0, 120),
        ),
      );
    }
    // ── ★«기다려라» 에 끝이 있다 (2026-09-20, 정태님 실기 8분 반복) ─────────────────
    //  ★가드는 옳다 — 틀린 것은 **막힌 뒤의 안내**였다. «기다렸다 다시» 만 있고 «언제
    //   그만두고 사람에게 말해라» 가 없어서, 사용자가 계속 타이핑하는 동안 모델이 같은
    //   관측·조작을 무한히 반복했다. 매 호출이 독립이라 **모델은 몇 번째인지 못 센다** —
    //   그래서 우리가 세어 말해준다.
    {
      const one = beginRejection({ ok: false, reason: "user-active" }, 1);
      const many = beginRejection({ ok: false, reason: "user-active" }, BLOCKED_ASK_USER_AT);
      out.push(
        assert(
          "★처음 막히면 «기다려라» 다 — 한 번 만에 사람을 부르면 그게 더 시끄럽다",
          !/더 기다리지 마세요/.test(one),
          one.slice(0, 60),
        ),
      );
      out.push(
        assert(
          `★★${String(BLOCKED_ASK_USER_AT)}번째엔 «사람에게 말해라» 로 바뀐다 — 안 바뀌면 무한 반복이다`,
          /더 기다리지 마세요/.test(many) && /손을 떼/.test(many),
          many.slice(0, 70),
        ),
      );
      out.push(
        assert(
          "★막힌 뒤에도 **화면 보기는 된다**고 말한다 — 상황 설명은 할 수 있어야 한다",
          /화면 보기는 그대로/.test(many),
          many.slice(-40),
        ),
      );
    }
    // ── ★키 이름 정규화와 «실패별 복구 과제» (2026-09-20, 긴급 인계서 A) ────────────
    //  ★★실측: 수식키만 **원문으로** 비교해서 `win`=통과 / **`WIN`=거절**,
    //   `ctrl`=통과 / **`CTRL`=거절**, 그런데 `enter`·`ENTER` 는 **둘 다 통과**였다.
    //   `WIN+R` 이 막힌 뒤 실기에서 `look` 이 **10회 연속**으로 돌았다 — 키 이름 문제는
    //   화면과 무관해서 **관측으로는 영영 안 풀린다.**
    {
      out.push(
        assert(
          "★대소문자가 판정을 가르지 않는다 — `WIN`·`CTRL`·`SHIFT` 가 소문자와 같게 취급된다",
          ["win", "ctrl", "shift", "enter"].every(
            (k) => supportedKey(k, "win32") === supportedKey(k.toUpperCase(), "win32"),
          ),
          ["win", "ctrl", "shift", "enter"]
            .map((k) => `${k}=${String(supportedKey(k, "win32"))}/${k.toUpperCase()}=${String(supportedKey(k.toUpperCase(), "win32"))}`)
            .join(" · "),
        ),
      );
      out.push(
        assert(
          "★★그래도 **mac 의 `win` 금지를 대문자로 우회할 수 없다** — 정규화가 금지보다 앞이다",
          !supportedKey("WIN", "darwin") && !supportedKey("win", "darwin"),
          `darwin: win=${String(supportedKey("win", "darwin"))} WIN=${String(supportedKey("WIN", "darwin"))}`,
        ),
      );
      out.push(
        assert(
          "★**한 글자는 안 바꾼다** — `R` 과 `r` 은 다른 입력이다",
          normalizeKey("R") === "R" && normalizeKey("r") === "r" && normalizeKey("CTRL") === "ctrl",
          `R→${normalizeKey("R")} · r→${normalizeKey("r")} · CTRL→${normalizeKey("CTRL")}`,
        ),
      );
      // ★**실패별 복구 과제가 서로 다르다** — 한 답에 두 지시가 섞이면 모델이 엉뚱한 쪽을 한다.
      out.push(
        assert(
          "★★`unsupported-key` 는 «화면을 다시 찍어도 안 풀린다» 고 말한다 — 키를 고치라는 뜻",
          /화면을 다시 찍어도 풀리지 않습니다/.test(planRejection("unsupported-key", "WIN")) &&
            /키 인자를 고쳐/.test(planRejection("unsupported-key", "WIN")),
          planRejection("unsupported-key", "WIN").slice(-50),
        ),
      );
      out.push(
        assert(
          "★★새 그림을 준 `stale` 응답엔 «`look` 으로 다시 보세요» 가 **없다**(지시가 둘이면 안 된다)",
          !/look` 으로 다시 보세요/.test(frameRejection("stale", { gaveImage: true })) &&
            /look` 으로 다시 보세요/.test(frameRejection("stale")),
          `그림있음=${frameRejection("stale", { gaveImage: true }).slice(-20)} · 없음=${frameRejection("stale").slice(-20)}`,
        ),
      );
      out.push(
        assert(
          "★`user-active` 는 «`look` 으로는 확인 못 한다» 고 말한다 — 관측이 대기의 대용이 아니다",
          /look` 을 반복해도 풀렸는지 알 수 없습니다/.test(beginRejection({ ok: false, reason: "user-active" }, 1)),
          beginRejection({ ok: false, reason: "user-active" }, 1).slice(-60),
        ),
      );
    }



    return out;
  },
};
