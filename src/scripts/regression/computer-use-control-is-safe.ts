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
  | { t: "keyup"; key: string };
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
  | { ok: true; events: LowEvent[]; holds: { keys: string[]; buttons: Button[] }; describe: string }
  | { ok: false; why: "offscreen" | "empty" };

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
  frameRejection: (why: string) => string;
  plan: (action: Record<string, unknown>, frame: Frame) => Plan;
  planRejection: (why: "offscreen" | "empty") => string;
  beginRejection: (b: Exclude<Begin, { ok: true }>) => string;
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
      rememberFrame,
      FRAME_KEEP,
      plan,
      planRejection,
      beginRejection,
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
        frameRejection("stale").includes("30초") && frameRejection("unknown").includes("3장"),
        `${frameRejection("stale").slice(0, 50)} / ${frameRejection("unknown").slice(0, 50)}`,
      ),
    );
    out.push(
      assert(
        "★거절 문구가 **무엇을 해야 하는지**까지 말한다(사유만 던지면 모델이 멈춘다)",
        ["unknown", "stale", "other-owner"].every((w) =>
          frameRejection(w).includes("observe_screen"),
        ),
        frameRejection("unknown").slice(0, 60),
      ),
    );

    // ── ④ 계획 — 좌표 변환이 **한 곳에서만** 일어난다 ──────────────────────────
    {
      const f = frameAt("f1", "A", T);
      const click = plan({ kind: "click", frameId: "f1", x: 800, y: 517, button: "left", count: 1 }, f);
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
      const off = plan({ kind: "click", frameId: "f1", x: 1600, y: 10, button: "left", count: 1 }, f);
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
      const typed = plan({ kind: "type", frameId: "f1", text: "한글 테스트" }, f);
      const emptyType = plan({ kind: "type", frameId: "f1", text: "" }, f);
      const emptyScroll = plan({ kind: "scroll", frameId: "f1", x: 10, y: 10, dx: 0, dy: 0 }, f);
      const emptyKeys = plan({ kind: "key", frameId: "f1", keys: [] }, f);
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
          "빈 입력·0 스크롤·빈 조합은 «할 일 없음» 으로 거절한다(빈 이벤트를 쏘지 않는다)",
          !plan({ kind: "type", frameId: "f1", text: "" }, f).ok &&
            !plan({ kind: "scroll", frameId: "f1", x: 10, y: 10, dx: 0, dy: 0 }, f).ok &&
            !plan({ kind: "key", frameId: "f1", keys: [] }, f).ok,
          `type=${JSON.stringify(emptyType)} scroll=${JSON.stringify(emptyScroll)} key=${JSON.stringify(emptyKeys)}`,
        ),
      );
    }

    // ── ⑥ 조합키 — **역순으로 놓고**, 도중엔 장부에 오른다 ────────────────────
    {
      const f = frameAt("f1", "A", T);
      const k = plan({ kind: "key", frameId: "f1", keys: ["cmd", "shift", "4"] }, f);
      const seq = k.ok ? k.events.map((e) => `${e.t}:${"key" in e ? e.key : ""}`) : [];
      out.push(
        assert(
          "★수식키를 **역순으로 놓는다**(Shift 를 먼저 놓으면 짝이 어긋난다)",
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
          "★조합키는 계획 도중 **눌린 채 있으므로 장부에 오른다** — 자식이 죽으면 그것으로 되돌린다",
          k.ok && JSON.stringify(k.holds.keys) === JSON.stringify(["cmd", "shift"]),
          JSON.stringify(k.ok ? k.holds : k),
        ),
      );
      out.push(
        assert(
          "수식키가 아닌 이름은 **그대로 넘긴다**(손 목록을 늘리지 않는다 — 실행부가 규칙으로 옮긴다)",
          k.ok && seq.includes("keydown:4"),
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
      const dr = plan(
        { kind: "drag", frameId: "f1", fromX: 100, fromY: 100, toX: 300, toY: 200, button: "left" },
        f,
      );
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
          "★드래그는 **버튼을 장부에 올린다** — 계획 도중 눌린 채 지나므로 자식이 죽으면 남는다",
          dr.ok && JSON.stringify(dr.holds.buttons) === JSON.stringify(["left"]),
          JSON.stringify(dr.ok ? dr.holds : dr),
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
          !plan({ kind: "drag", frameId: "f1", fromX: 10, fromY: 10, toX: 10, toY: 10, button: "left" }, f).ok &&
            !plan({ kind: "drag", frameId: "f1", fromX: 10, fromY: 10, toX: 1600, toY: 10, button: "left" }, f).ok,
          `${JSON.stringify(plan({ kind: "drag", frameId: "f1", fromX: 10, fromY: 10, toX: 10, toY: 10, button: "left" }, f))}`,
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
      const shiftDrag = plan(
        { kind: "drag", frameId: "f1", fromX: 100, fromY: 100, toX: 300, toY: 200, button: "left", hold: ["shift"] },
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
          "★누른 채: 수식키가 **장부에 오른다**(행동 끝까지 눌려 있으므로)",
          shiftDrag.ok &&
            shiftDrag.holds.keys.includes("shift") &&
            shiftDrag.holds.buttons.includes("left"),
          JSON.stringify(shiftDrag.ok ? shiftDrag.holds : shiftDrag),
        ),
      );
      const twoMods = plan(
        { kind: "click", frameId: "f1", x: 100, y: 100, button: "left", count: 1, hold: ["cmd", "shift"] },
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
          plan({ kind: "click", frameId: "f1", x: 10, y: 10, button: "left", count: 1 }, f).ok &&
            !(plan({ kind: "click", frameId: "f1", x: 10, y: 10, button: "left", count: 1 }, f) as { events: { t: string }[] }).events.some((e) => e.t === "keydown"),
          JSON.stringify((plan({ kind: "click", frameId: "f1", x: 10, y: 10, button: "left", count: 1 }, f) as { events: { t: string }[] }).events.map((e) => e.t)),
        ),
      );
      const smooth = plan({ kind: "drag", frameId: "f1", fromX: 10, fromY: 10, toX: 500, toY: 400, button: "left" }, f);
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

    return out;
  },
};
