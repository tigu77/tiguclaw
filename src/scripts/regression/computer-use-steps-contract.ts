/**
 * 회귀: **열(`steps`)의 계약 넷** (2026-09-19, §15-27).
 *
 * `do` 는 되돌릴 수 없는 것을 **여러 개 연달아** 낸다. 그래서 「무엇을 쏘나」만큼 「어디서
 * 멈추나 · 무엇이 눌린 채 남나 · 어디까지 갔다고 말하나」가 계약이다. 여기가 그 셋을 잰다.
 *
 * ★**순수부만** 잰다 — 실행부 스모크는 `computer-use-{mac,windows}-executor-runs` 가 따로
 *  본다. 이 파일은 입력을 한 번도 내지 않는다(principle-check Q7).
 */
// ★**리터럴 import 로 `plugins/` 를 짚지 않는다** — `npm run build`(rootDir=src)가 TS6059 로
//  죽고, typecheck 도 스위트도 초록이라 릴리스 게이트까지 가서야 보인다(`src-stays-inside-src`).
//  그래서 형제 검사들과 같이 `loadPluginModule` 로 받고 인터페이스를 손으로 적는다.
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
  owner: string;
  front: string | null;
  geometry: Geometry;
}
interface LowEvent {
  t: string;
  [k: string]: unknown;
}
type Step = Record<string, unknown>;
type StepsPlan =
  | {
      ok: true;
      events: LowEvent[];
      holds: { keys: string[]; buttons: Button[] };
      touched: { keys: string[]; buttons: Button[] };
      describes: string[];
    }
  | { ok: false; why: "offscreen" | "empty" | "too-many" | "unbalanced-key" };
interface StepsModule {
  planSteps: (steps: readonly Step[], f: Frame) => StepsPlan;
  planRejection: (why: "offscreen" | "empty" | "too-many" | "unbalanced-key") => string;
  stepsOutcome: (
    stdout: string,
    stepCount: number,
    childOk: boolean,
  ) => { status: string[]; stoppedAt?: { i: number; why: string; saw: string } };
  STEPS_MAX: number;
}

/** 1:1 배율·원점 0 — 그림 좌표가 그대로 화면 좌표가 되어 **계약만** 남는다. */
const frame = (front: string | null): Frame => ({
  id: "f1",
  atMs: 1_000,
  owner: "t1",
  front,
  geometry: {
    deliveredPx: { w: 100, h: 100 },
    capturedPx: { w: 100, h: 100 },
    originPt: { x: 0, y: 0 },
    scale: 1,
  },
});

const kinds = (evs: readonly LowEvent[]): string[] => evs.map((e) => e.t);

export const check: RegressionCheck = {
  name: "computer-use-steps-contract",
  guards:
    "열 중간에 전면 창이 바뀌었는데 계속 쏴서 남의 창에 글자가 들어가는 것 · " +
    "원소가 자기 수식키를 치워 바깥 열의 장부가 거짓이 되는 것 · " +
    "누르지 않은 키를 떼겠다고 해서 정리가 **우리 것이 아닌 키**를 놓는 것 · " +
    "가드가 멈춘 부분 실행을 «자식이 정상 종료했으니 전부 완료» 로 읽는 것 · " +
    "죽은 자식이 시작만 한 step 을 «안 했다» 로 읽어 다시 누르게 하는 것",
  run: async (): Promise<Assertion[]> => {
    const { planSteps, planRejection, stepsOutcome, STEPS_MAX } =
      await loadPluginModule<StepsModule>("../../../plugins/computer-use/src/control.ts");
    const out: Assertion[] = [];

    // ── 계약 1 — 가드는 **글자·키 직전에만**, 그리고 기준이 없으면 안 넣는다 ─────
    const typed = planSteps([{ t: "type", text: "가" }], frame("TextEdit:1"));
    out.push(
      assert(
        "★글자를 내기 **직전에** 전면 창 가드가 선다",
        typed.ok && kinds(typed.events).join(">") === "mark>guard>unicode",
        typed.ok ? kinds(typed.events).join(">") : `계획 실패(${typed.why})`,
      ),
    );
    const clicked = planSteps([{ t: "click", x: 10, y: 10 }], frame("TextEdit:1"));
    out.push(
      assert(
        "마우스 원소엔 가드가 **안** 선다 — 좌표가 창을 고르므로 판정이 좌표 쪽에 있다",
        clicked.ok && !kinds(clicked.events).includes("guard"),
        clicked.ok ? kinds(clicked.events).join(">") : `계획 실패(${clicked.why})`,
      ),
    );
    // ★기준이 없는데 막으면 «모르면 안 누른다» 가 아니라 «모르면 아무것도 못 한다» 가 된다.
    const noFront = planSteps([{ t: "type", text: "가" }], frame(null));
    out.push(
      assert(
        "★전면 창을 **모를 때**는 가드를 안 넣는다(기준 없는 차단은 기능 불능이다)",
        noFront.ok && !kinds(noFront.events).includes("guard"),
        noFront.ok ? kinds(noFront.events).join(">") : `계획 실패(${noFront.why})`,
      ),
    );

    // ── 계약 2 — 장부는 **열 전체**가 가진다 ───────────────────────────────────
    const held = planSteps(
      [
        { t: "keydown", key: "shift" },
        { t: "click", x: 1, y: 1 },
        { t: "click", x: 2, y: 2 },
      ],
      frame("A:1"),
    );
    out.push(
      assert(
        "★★열이 끝나도 **안 뗀 키는 장부에 남는다** — 부모가 그걸로 되돌린다",
        held.ok && held.holds.keys.join(",") === "shift",
        held.ok ? `holds=${JSON.stringify(held.holds)}` : `계획 실패(${held.why})`,
      ),
    );
    const balanced = planSteps(
      [
        { t: "keydown", key: "shift" },
        { t: "click", x: 1, y: 1 },
        { t: "keyup", key: "shift" },
      ],
      frame("A:1"),
    );
    out.push(
      assert(
        "짝을 맞춘 열은 장부를 **비운 채** 끝난다",
        balanced.ok && balanced.holds.keys.length === 0,
        balanced.ok ? `holds=${JSON.stringify(balanced.holds)}` : `계획 실패(${balanced.why})`,
      ),
    );
    // ★★안 누른 키를 떼겠다고 하면 **거절**한다. 통과시키면 장부가 거짓이 되고, 그 장부로
    //  정리하면 **사용자가 누르고 있던 키**를 놓는다.
    const unbalanced = planSteps([{ t: "keyup", key: "shift" }], frame("A:1"));
    out.push(
      assert(
        "★★누르지 않은 키를 떼려 하면 **거절**한다(장부가 거짓이 되면 남의 키를 놓는다)",
        !unbalanced.ok && unbalanced.why === "unbalanced-key",
        unbalanced.ok ? "통과시켰다" : `why=${unbalanced.why}`,
      ),
    );
    out.push(
      assert(
        "거절 사유 넷이 **각각 다른 말**을 한다(한 문구로 뭉뚱그리지 않는다)",
        new Set(
          (["offscreen", "empty", "too-many", "unbalanced-key"] as const).map((w) =>
            planRejection(w),
          ),
        ).size === 4,
        `서로 다른 문구 ${String(
          new Set(
            (["offscreen", "empty", "too-many", "unbalanced-key"] as const).map((w) =>
              planRejection(w),
            ),
          ).size,
        )}개`,
      ),
    );

    // ── 상한 ────────────────────────────────────────────────────────────────
    const many: Step[] = Array.from({ length: STEPS_MAX + 1 }, () => ({ t: "wait", ms: 1 }));
    const tooMany = planSteps(many, frame("A:1"));
    out.push(
      assert(
        `열이 ${String(STEPS_MAX)}개를 넘으면 거절한다 — 긴 열일수록 어긋났을 때 되돌릴 수 없는 몫이 크다`,
        !tooMany.ok && tooMany.why === "too-many",
        tooMany.ok ? "통과시켰다" : `why=${tooMany.why}`,
      ),
    );

    // ── 계약 3 — «어디까지 갔나» ───────────────────────────────────────────────
    // ★★가드가 멈춘 실행은 **자식이 정상 종료(0)한 부분 실행**이다. 실기에서 이걸
    //  «childOk 니까 전부 완료» 로 읽어 2번이 안 돌았는데 완료라고 답한 적이 있다.
    const stopped = stepsOutcome(
      '{"step":0}\n{"step":1}\n{"stopped":1,"why":"front-changed","saw":"Other:9"}\n{"items":4,"fired":0}',
      3,
      true,
    );
    out.push(
      assert(
        "★★가드가 멈추면 **정상 종료여도** 전부 완료가 아니다 — 멈춘 자리부터 «미실행»",
        stopped.status.join(",") === "완료,미실행,미실행" && stopped.stoppedAt?.i === 1,
        `status=${stopped.status.join(",")} stopped=${JSON.stringify(stopped.stoppedAt ?? null)}`,
      ),
    );
    out.push(
      assert(
        "멈춘 이유와 **그때 실제로 본 창**을 같이 들고 온다(«왜» 없이는 못 고친다)",
        stopped.stoppedAt?.why === "front-changed" && stopped.stoppedAt.saw === "Other:9",
        JSON.stringify(stopped.stoppedAt ?? null),
      ),
    );
    // ★★시작만 하고 죽은 step 은 «미실행» 이 아니라 **«불명»** 이다 — 되돌릴 수 없는
    //  도구에서 그 구분이 전부다(«안 했다» 면 다시 하면 되고, «모른다» 면 사람이 봐야 한다).
    const killed = stepsOutcome('{"step":0}\n{"step":1}\n{"ste', 4, false);
    out.push(
      assert(
        "★★죽은 자식이 **시작만 한** step 은 «불명» 이다(«미실행» 으로 읽으면 두 번 누른다)",
        killed.status.join(",") === "완료,불명,미실행,미실행",
        `status=${killed.status.join(",")}`,
      ),
    );
    out.push(
      assert(
        "잘린 마지막 줄은 **버린다** — 죽은 자식의 끝 줄은 중간에서 끊겨 있다",
        killed.status[1] === "불명",
        `잘린 조각 '{\"ste' 를 step 으로 세지 않았다 → ${String(killed.status[1])}`,
      ),
    );
    out.push(
      assert(
        "아무 줄도 못 받고 죽었으면 전부 «미실행» 이다(시작한 증거가 없다)",
        stepsOutcome("", 3, false).status.join(",") === "미실행,미실행,미실행",
        stepsOutcome("", 3, false).status.join(","),
      ),
    );
    out.push(
      assert(
        "정상 종료 + 가드 멈춤 없음 = 전부 «완료» (줄 수로 의심하지 않는다 — Windows 는 버퍼링한다)",
        stepsOutcome("", 3, true).status.join(",") === "완료,완료,완료",
        stepsOutcome("", 3, true).status.join(","),
      ),
    );

    // ── 곡선 드래그 — 「잘못된 추상이 잘못된 답을 만든다」의 수정분 ──────────────
    const curve = planSteps(
      [{ t: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 9 }, { x: 9, y: 2 }] }],
      frame("A:1"),
    );
    out.push(
      assert(
        "★드래그가 **경로**를 받는다 — 곡선을 직선 여러 개로 쪼개 매번 재관측하지 않는다",
        curve.ok && kinds(curve.events).join(">") === "mark>mousemove>mousedown>mousedrag>mousedrag>mouseup",
        curve.ok ? kinds(curve.events).join(">") : `계획 실패(${curve.why})`,
      ),
    );
    out.push(
      assert(
        "한 점짜리 경로는 거절한다(그건 클릭이고, 다른 원소다)",
        !planSteps([{ t: "drag", path: [{ x: 1, y: 1 }] }], frame("A:1")).ok,
        JSON.stringify(planSteps([{ t: "drag", path: [{ x: 1, y: 1 }] }], frame("A:1"))),
      ),
    );

    // ── mark 는 **모든** step 앞에 선다 — 하나라도 빠지면 그 step 의 운명을 모른다 ──
    const mixed = planSteps(
      [
        { t: "click", x: 1, y: 1 },
        { t: "wait", ms: 10 },
        { t: "type", text: "a" },
      ],
      frame("A:1"),
    );
    out.push(
      assert(
        "★모든 step 앞에 `mark` 가 선다 — 하나라도 빠지면 그 step 의 운명을 영영 모른다",
        mixed.ok && mixed.events.filter((e) => e.t === "mark").length === 3,
        mixed.ok
          ? `mark ${String(mixed.events.filter((e) => e.t === "mark").length)}개 / step 3개`
          : `계획 실패(${mixed.why})`,
      ),
    );

    return out;
  },
};
