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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  target: CaptureTarget;
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
  | {
      ok: false;
      why: "offscreen" | "empty" | "too-many" | "unbalanced-key" | "unsupported-key" | "scroll-too-big";
      detail?: string;
    };
interface Desktop {
  lease: { owner: string; lastTouchedMs: number } | null;
  active: { owner: string; startedMs: number } | null;
  held: { keys: string[]; buttons: Button[] };
  frames: Map<string, Frame[]>;
  lastSelfInputMs: number | null;
}
type CaptureTarget =
  | { kind: "screen" }
  | { kind: "display"; index: number }
  | { kind: "region"; x: number; y: number; width: number; height: number };
interface ScreenRect { x: number; y: number; w: number; h: number; scale?: number }
interface ObserveModule {
  afterActionTarget: (t: CaptureTarget, s: readonly ScreenRect[] | undefined) => CaptureTarget;
}
interface StepsModule {
  planSteps: (steps: readonly Step[], f: Frame, platform?: string) => StepsPlan;
  newDesktop: () => Desktop;
  endAction: (d: Desktop, owner: string, nowMs: number, o?: { keepFrames?: boolean }) => void;
  PLATFORM_KEY_GAPS: Readonly<Record<string, readonly string[]>>;
  supportedKey: (name: string, platform?: string) => boolean;
  SCROLL_MAX: number;
  mergeHeld: (
    a: { keys: readonly string[]; buttons: readonly Button[] },
    b: { keys: readonly string[]; buttons: readonly Button[] },
  ) => { keys: string[]; buttons: Button[] };
  planRejection: (
    why: "offscreen" | "empty" | "too-many" | "unbalanced-key" | "unsupported-key" | "scroll-too-big",
    detail?: string,
  ) => string;
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
  target: { kind: "screen" },
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
    const { planSteps, planRejection, stepsOutcome, STEPS_MAX, newDesktop, endAction, mergeHeld,
      PLATFORM_KEY_GAPS, SCROLL_MAX, supportedKey } =
      await loadPluginModule<StepsModule>("../../../plugins/computer-use/src/control.ts");
    const { afterActionTarget } = await loadPluginModule<ObserveModule>(
      "../../../plugins/computer-use/src/observe.ts",
    );
    const out: Assertion[] = [];
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = (rel: string): string =>
      readFileSync(path.join(here, "../../../plugins/computer-use/src", rel), "utf8");

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
        "거절 사유 여섯이 **각각 다른 말**을 한다(한 문구로 뭉뚱그리지 않는다)",
        new Set(
          (["offscreen", "empty", "too-many", "unbalanced-key", "unsupported-key", "scroll-too-big"] as const).map((w) =>
            planRejection(w),
          ),
        ).size === 6,
        `서로 다른 문구 ${String(
          new Set(
            (["offscreen", "empty", "too-many", "unbalanced-key", "unsupported-key", "scroll-too-big"] as const).map((w) =>
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

    // ── ★없는 키는 **쏘기 전에** 거른다 (아스트라 외부 검토 5-2) ─────────────────
    //  ★★종전엔 스키마가 `win` 을 광고하고 mac 실행부가 **열 한가운데서** 던졌다 —
    //   앞 step 은 이미 발사된 뒤라 **부분 실행**이 남는다.
    {
      const withWin = planSteps(
        [{ t: "type", text: "a" }, { t: "keydown", key: "win" }, { t: "keyup", key: "win" }],
        frame("A:1"),
        "darwin",
      );
      out.push(
        assert(
          "★★맥에 없는 키(`win`)가 든 열은 **아무것도 쏘기 전에** 거절된다(앞 step 이 먼저 나가면 안 된다)",
          !withWin.ok && withWin.why === "unsupported-key",
          withWin.ok ? `통과시켰다 — 이벤트 ${String(withWin.events.length)}개` : `why=${withWin.why}`,
        ),
      );
      out.push(
        assert(
          "Windows 에서는 같은 열이 **통과한다**(가드가 다 막으면 그것도 결함이다)",
          planSteps([{ t: "keydown", key: "win" }, { t: "keyup", key: "win" }], frame("A:1"), "win32").ok,
          JSON.stringify(
            planSteps([{ t: "keydown", key: "win" }, { t: "keyup", key: "win" }], frame("A:1"), "win32").ok,
          ),
        ),
      );
      // ★★**금지 목록이 아니라 허용 목록이다** (2026-09-19, 아스트라 재검토 §2).
      //  종전 검사는 `win` 하나만 막았다 — `f5` 는 **양쪽 표 어디에도 없는데** 계획을
      //  통과하고 실행부가 **열 한가운데서** 던진다. 앞 step 은 이미 발사된 뒤다.
      //  요지는 «이미 아는 한 입력을 막았다» 가 아니라 **«어떤 미지원 입력도 앞선 행동을
      //  실행시키지 않는다»** 이다.
      const withF5 = planSteps(
        [{ t: "click", x: 1, y: 1 }, { t: "keydown", key: "f5" }, { t: "keyup", key: "f5" }],
        frame("A:1"),
        "win32",
      );
      out.push(
        assert(
          "★★양쪽 표에 **없는 이름**(f5)이 든 열은 거절된다 — 앞의 click 이 먼저 나가면 안 된다",
          !withF5.ok && withF5.why === "unsupported-key",
          withF5.ok ? `통과시켰다 — 이벤트 ${String(withF5.events.length)}개` : `why=${withF5.why}`,
        ),
      );
      out.push(
        assert(
          "★거절 문구가 **무엇이 문제인지** 짚는다(사유만 던지면 같은 이름으로 다시 온다)",
          planRejection("unsupported-key", "f5").includes("f5"),
          planRejection("unsupported-key", "f5").split("\n")[0] ?? "",
        ),
      );
      out.push(
        assert(
          "★반대 방향 — 쓸 수 있는 것은 **막지 않는다**(수식키·이름 있는 키·한 글자)",
          supportedKey("shift", "win32") &&
            supportedKey("pagedown", "darwin") &&
            supportedKey("가", "darwin"),
          `shift=${String(supportedKey("shift", "win32"))} pagedown=${String(supportedKey("pagedown", "darwin"))} 가=${String(supportedKey("가", "darwin"))}`,
        ),
      );
      // ★★**«한 글자» 의 뜻이 실행부와 같아야 한다** (2026-09-19, 아스트라 3차 §2).
      //  `🙂`·`𝐀` 는 **코드포인트 1 · UTF-16 2** 다. 양 실행부는 UTF-16 길이로 보므로
      //  이것들을 **키로 못 받는다** — 계획기가 통과시키면 `f5` 와 **같은 부분 실행**이 난다.
      //  ★★여기 있던 옛 단언은 «이모지도 키로 된다» 였다 — **제품이 안 지키는 계약을 검사가
      //   고정**하고 있었다. 검사가 제품과 다른 약속을 박으면 방패가 아니라 잠금이다.
      out.push(
        assert(
          "★★보충 평면 문자(🙂·𝐀)는 **키로 거절**한다 — 실행부의 «한 글자» 와 뜻이 같아야 한다",
          !supportedKey("🙂", "darwin") && !supportedKey("𝐀", "win32"),
          `🙂=${String(supportedKey("🙂", "darwin"))} 𝐀=${String(supportedKey("𝐀", "win32"))} (둘 다 false 여야)`,
        ),
      );
      out.push(
        assert(
          "★그래도 **넣을 길은 있다** — 그건 `key` 가 아니라 `type` 원소가 진다(유니코드 주입의 정본)",
          planSteps([{ t: "type", text: "🙂" }], frame("A:1"), "darwin").ok,
          JSON.stringify(planSteps([{ t: "type", text: "🙂" }], frame("A:1"), "darwin").ok),
        ),
      );

      // ★★**손 목록을 실행부에 묶는다** — 여기 적힌 이름을 실행부가 실제로 거절해야 한다.
      //  안 묶으면 이 목록이 조용히 낡는다([[feedback_hand_maintained_lists]]).
      const macSrc = src("mac.ts");
      const unbound = (PLATFORM_KEY_GAPS["darwin"] ?? []).filter((k) => !macSrc.includes(`'${k}'`));
      out.push(
        assert(
          "★★목록의 이름을 **실행부가 실제로 거절한다** — 둘이 갈리면 목록이 거짓이 된다",
          unbound.length === 0,
          unbound.length === 0
            ? `darwin 공백: ${(PLATFORM_KEY_GAPS["darwin"] ?? []).join(",")} — 전부 mac.ts 에 있다`
            : `mac.ts 가 모르는 이름: ${unbound.join(",")}`,
        ),
      );
    }

    // ── ★스크롤 상한이 **실행부 가드에 도달하지 못한다** (아스트라 외부 검토 6) ────
    //  ★★Windows 는 `units = dy × 2` 를 120씩 **최대 200회** 돈다 = 24,000 이 천장이다.
    //   스키마에 상한이 없으면 `|dy| > 12,000` 이 **조용히 잘린다** — 쐈는데 일부만 되고
    //   아무도 모른다. 상한을 천장의 **절반**에 둬서 도달 자체를 불가능하게 한다.
    {
      const winSrc = src("win.ts");
      const guard = Number(/\$guard -lt (\d+)/.exec(winSrc)?.[1] ?? "0");
      const mult = Number(/\[int\]\$e\.dy \* (\d+)/.exec(winSrc)?.[1] ?? "0");
      const ceiling = guard * 120;
      out.push(
        assert(
          "★★스키마 상한 × 배수 < 실행부 천장 — **가드에 도달할 수 없다**(도달하면 조용히 잘린다)",
          guard > 0 && mult > 0 && SCROLL_MAX * mult < ceiling,
          `SCROLL_MAX=${String(SCROLL_MAX)} × ${String(mult)} = ${String(SCROLL_MAX * mult)} · 천장 ${String(guard)}×120 = ${String(ceiling)}`,
        ),
      );
      out.push(
        assert(
          "상한을 넘는 스크롤은 **계획 단계에서** 거절한다(실행부까지 가지 않는다)",
          !planSteps([{ t: "scroll", x: 1, y: 1, dx: 0, dy: SCROLL_MAX + 1 }], frame("A:1")).ok,
          JSON.stringify(planSteps([{ t: "scroll", x: 1, y: 1, dx: 0, dy: SCROLL_MAX + 1 }], frame("A:1"))),
        ),
      );
    }

    // ── ★유출 검사가 **두 방향**으로 맞다 (2026-09-19, 아스트라 지적을 재서 닫음) ────
    //  `key` 는 삭제된 도구 이름이자 **지금 step 의 필드 이름**이다. 그래서 이 판정은
    //  «도구를 권하는 말» 만 잡고 «필드를 설명하는 말» 은 안 잡아야 한다. 양쪽을 잰다.
    {
      const advisesRe = (n: string): RegExp =>
        new RegExp(`[\`'"]?${n}[\`'"]?\\s*(를|을)\\s*(쓰|사용|부르)`);
      const hit = ["key 를 쓰세요", "`key` 를 쓰세요", "\"key\" 를 사용하세요"];
      const miss = ["key 필드를 쓰세요", "key: z.string()", "keydown 을 쓰세요", "그 key 값을 보세요"];
      out.push(
        assert(
          "★★삭제된 **도구를 권하는 말**은 잡는다 — 백틱·따옴표로 감싸도(우리 문체가 그렇다)",
          hit.every((t) => advisesRe("key").test(t)),
          hit.map((t) => `${t}→${String(advisesRe("key").test(t))}`).join(" · "),
        ),
      );
      out.push(
        assert(
          "★반대 방향 — **필드·step 이름으로 쓰는 말**은 안 잡는다(막으면 안 되는 것을 안 막는다)",
          miss.every((t) => !advisesRe("key").test(t)),
          miss.map((t) => `${t}→${String(advisesRe("key").test(t))}`).join(" · "),
        ),
      );
    }

    // ── ★거절이 **다음 길**을 알려준다 (아스트라 4차 §3) ───────────────────────
    //  ★★계약을 좁혔으면 **안내도 같이** 좁혀야 한다. «한 글자면 그대로 들어간다» 를
    //   남겨두면 `🙂` 를 거절하면서 «한 글자는 된다» 고 말하는 셈이고, 모델은 같은 것을
    //   다시 보낸다 — 이 레포가 101분을 쓴 그 모양이다(`eaa2dec2`).
    out.push(
      assert(
        "★★보충 평면 문자를 거절하면서 **`type` 원소를 안내**한다(거절만 하면 같은 것이 다시 온다)",
        planRejection("unsupported-key", "🙂").includes("type"),
        planRejection("unsupported-key", "🙂").split("\n").slice(-2).join(" / ").slice(0, 120),
      ),
    );
    out.push(
      assert(
        "★안내가 **«한 글자면 다 된다» 고 말하지 않는다** — 계약이 좁아진 만큼 문구도 좁다",
        /기본 평면/.test(planRejection("unsupported-key", "🙂")),
        planRejection("unsupported-key", "🙂").split("\n")[1] ?? "",
      ),
    );

    // ── ★화면 선택 기준이 **한 곳**이다 (아스트라 재검토 §4) ────────────────────
    //  ★종전엔 사후 관측이 «첫 교차», 좌표 기준이 «최대 겹침» 이었다 — 두 화면에 **걸친**
    //   region 에서 **기준 화면과 관측 화면이 갈릴** 수 있다. 그리고 「첫 교차」는 화면
    //   **열거 순서**에 답이 달린다.
    {
      const a: ScreenRect[] = [
        { x: 0, y: 0, w: 1920, h: 1080 },
        { x: 1920, y: 0, w: 1920, h: 1080 },
      ];
      // 오른쪽 화면에 더 많이 걸친 네모 — 배열 순서를 뒤집어도 같은 화면을 골라야 한다.
      const straddling = { kind: "region" as const, x: 1900, y: 100, width: 200, height: 100 };
      const first = afterActionTarget(straddling, a);
      const reversed = afterActionTarget(straddling, [...a].reverse());
      out.push(
        assert(
          "★★걸친 region 은 **더 많이 걸친 화면**을 고른다(첫 교차가 아니다)",
          JSON.stringify(first) === JSON.stringify({ kind: "display", index: 2 }),
          JSON.stringify(first),
        ),
      );
      out.push(
        assert(
          "★화면 **열거 순서**를 바꿔도 같은 화면을 고른다 — 순서에 답이 달리면 안 된다",
          JSON.stringify(reversed) === JSON.stringify({ kind: "display", index: 1 }),
          `정순=${JSON.stringify(first)} 역순=${JSON.stringify(reversed)} (같은 물리 화면)`,
        ),
      );
    }

    // ── ★사후 관측은 **행동한 그 화면**을 본다 (2026-09-19, 아스트라 외부 검토 ①) ──────
    //  ★★종전엔 `do` 가 `{kind:"screen"}` 으로 **고정**해 찍어서, 보조 모니터 위에서
    //   행동해도 **주 모니터**가 돌아왔다 — 모델이 **다른 화면으로 결과를 판정**한다.
    const twoScreens: ScreenRect[] = [
      { x: 0, y: 0, w: 1920, h: 1080 },
      { x: 1920, y: 0, w: 1920, h: 1080 },
    ];
    out.push(
      assert(
        "★★보조 디스플레이 프레임의 사후 관측이 **그 디스플레이**를 본다(주 화면으로 안 바뀐다)",
        JSON.stringify(afterActionTarget({ kind: "display", index: 2 }, twoScreens)) ===
          JSON.stringify({ kind: "display", index: 2 }),
        JSON.stringify(afterActionTarget({ kind: "display", index: 2 }, twoScreens)),
      ),
    );
    out.push(
      assert(
        "★확대(region)는 **그 화면 전체로 넓힌다** — 행동은 그 네모 **밖**도 바꾼다(대화상자·새 창)",
        JSON.stringify(
          afterActionTarget({ kind: "region", x: 2000, y: 100, width: 50, height: 50 }, twoScreens),
        ) === JSON.stringify({ kind: "display", index: 2 }),
        JSON.stringify(
          afterActionTarget({ kind: "region", x: 2000, y: 100, width: 50, height: 50 }, twoScreens),
        ),
      ),
    );
    out.push(
      assert(
        "★★배치를 **모르면 넓히지 않는다** — 주 화면으로 **조용히 갈아타지 않는다**",
        JSON.stringify(
          afterActionTarget({ kind: "region", x: 10, y: 10, width: 5, height: 5 }, undefined),
        ) === JSON.stringify({ kind: "region", x: 10, y: 10, width: 5, height: 5 }),
        JSON.stringify(
          afterActionTarget({ kind: "region", x: 10, y: 10, width: 5, height: 5 }, undefined),
        ),
      ),
    );

    // ── ★발사 **전** 거절은 프레임을 살린다 (아스트라 외부 검토 ②) ──────────────
    //  ★★거절 문구가 *"좌표를 고쳐 다시 요청하라"* 라고 말하는데, 종전엔 그 프레임을
    //   **방금 자기가 지운 채로** 그렇게 말했다. 안내와 수명이 충돌했다.
    {
      const d = newDesktop();
      const f = frame("A:1");
      d.frames.set("t1", [f]);
      endAction(d, "t1", 2_000, { keepFrames: true });
      out.push(
        assert(
          "★★계획 단계 거절(발사 0)이면 **프레임이 살아 있다** — 좌표를 고쳐 같은 id 로 다시 부를 수 있다",
          d.frames.get("t1")?.length === 1 && d.active === null,
          `frames=${String(d.frames.get("t1")?.length ?? 0)} active=${JSON.stringify(d.active)}`,
        ),
      );
    }
    {
      const d = newDesktop();
      d.frames.set("t1", [frame("A:1")]);
      endAction(d, "t1", 2_000);
      out.push(
        assert(
          "쐈으면(기본) 프레임을 **버린다** — 화면이 바뀌었으니 옛 좌표는 못 쓴다",
          (d.frames.get("t1")?.length ?? 0) === 0,
          `frames=${String(d.frames.get("t1")?.length ?? 0)}`,
        ),
      );
    }

    // ── ★장부는 **덮어쓰지 않고 합친다** (아스트라 외부 검토 ③) ────────────────
    //  ★★`releasePlan` 주석이 *"놓기가 실패해도 장부에 남아 다음 정리에서 다시 시도된다"*
    //   고 약속하는데, 새 행동의 **대입**이 그 재시도 경로를 끊고 있었다 — 주석이 거짓이 된다.
    out.push(
      assert(
        "★★이전 미해제 입력이 새 행동의 장부에 **보존된다**(대입이면 조용히 사라진다)",
        (() => {
          const m = mergeHeld({ keys: ["shift"], buttons: ["left"] }, { keys: ["cmd"], buttons: [] });
          return m.keys.includes("shift") && m.keys.includes("cmd") && m.buttons.includes("left");
        })(),
        JSON.stringify(mergeHeld({ keys: ["shift"], buttons: ["left"] }, { keys: ["cmd"], buttons: [] })),
      ),
    );
    out.push(
      assert(
        "같은 키를 두 번 담지 않는다(두 번 놓을 일이 없다)",
        mergeHeld({ keys: ["shift"], buttons: [] }, { keys: ["shift"], buttons: [] }).keys.length === 1,
        JSON.stringify(mergeHeld({ keys: ["shift"], buttons: [] }, { keys: ["shift"], buttons: [] })),
      ),
    );

    // ── ★삭제된 도구 이름이 **처방에 남아 있지 않다** (2026-09-19, 아스트라 외부 검토 ④) ──
    //  ★`look`/`do` 통합으로 `type_text`·`click`·`key`·`drag`·`scroll` 도구가 사라졌는데,
    //   실행부의 오류 문구가 *"글자를 넣으려면 type_text 를 쓰세요"* 라고 말하고 있었다.
    //   그 문구는 `postFailureMessage` 를 타고 **모델에게 그대로 간다** — 모델은 없는 도구를
    //   부르고 또 실패한다.
    //  ★★이 레포는 이미 같은 값을 치렀다(`eaa2dec2` 「처방이 제 발을 가리켜 720번 같은
    //   오류를 받았다 — 101분」). 사람이 기억해서 지키는 자리가 아니다.
    //  ★`t: "type"` 처럼 **새 어휘**는 걸리면 안 되므로 도구 이름만 센다.
    // ★`key` 가 빠져 있었다 (2026-09-19, 아스트라 4차 §4) — 주석은 «다섯» 이라 적고 목록은
    //  넷이었다. ★`key` 는 **step 이름이자 필드 이름**으로 살아 있으므로 단순 포함으로 세면
    //  안 된다 — 아래 «권유 말투» 판정이 그걸 가른다(`key` 를 쓰세요 ↔ `key: z.string()`).
    const GONE = ["type_text", "observe_screen", "click", "drag", "scroll", "key"];
    const leaked: string[] = [];
    // ★★**파일 목록을 손으로 적지 않는다** (2026-09-19, 아스트라 3차 §6). 종전엔 다섯 개를
    //  박아 뒀고, 그래서 **새 오류 경로가 생기면 검사 대상에서 조용히 빠졌다** — 이 검사가
    //  막으려던 것이 바로 «없는 도구를 권하는 처방» 인데, 그게 새 파일에 생기면 못 본다.
    //  폴더에서 **유도**한다: 여기 `.ts` 가 늘면 자동으로 대상이 된다.
    const files = readdirSync(path.join(here, "../../../plugins/computer-use/src")).filter((f) =>
      f.endsWith(".ts"),
    );
    for (const f of files) {
      const text = src(f);
      for (const name of GONE) {
        // 주석·설계 서술에서 «옛 이름» 을 회고하는 것은 허용한다 — 모델에게 가는 것은
        // **따옴표 안의 문자열**이므로, 코드 줄에 든 것만 센다.
        // ★`click`·`drag`·`scroll` 은 **step 이름으로 살아 있다** — `t: "click"` 같은 어휘는
        //  걸리면 안 된다. 그래서 «도구를 권하는 말투» 만 센다: 그 이름 뒤에 «를/을 쓰…» 가
        //  붙는 자리(«… type_text 를 쓰세요»)가 이 결함의 실제 모양이었다.
        for (const line of text.split("\n")) {
          const code = line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          // ★★백틱·따옴표를 감안한다 — 우리 문체는 이름을 `이렇게` 감싼다. 감안 안 하면
          //  **정작 진짜를 놓친다**(실측: «`key` 를 쓰세요» 가 안 걸렸다).
          //  ★그리고 «`key` **필드를** 쓰세요» 는 안 걸려야 한다 — `key` 는 step 의 필드
          //   이름으로 **살아 있다**. 아래 단언이 두 방향을 같이 잰다.
          const advises = new RegExp(`[\`'"]?${name}[\`'"]?\\s*(를|을)\\s*(쓰|사용|부르)`).test(code);
          const bareOldTool =
            (name === "type_text" || name === "observe_screen") && code.includes(name);
          if (advises || bareOldTool) leaked.push(`${f}: ${line.trim().slice(0, 70)}`);
        }
      }
    }
    out.push(
      assert(
        "★★삭제된 도구 이름이 **모델에게 가는 문구**에 안 남았다(없는 도구를 권하면 그 루프가 다시 돈다)",
        leaked.length === 0,
        leaked.length === 0
          ? `검사한 이름 ${String(GONE.length)}개 × 파일 ${String(files.length)}개(폴더에서 유도) · 유출 0`
          : leaked.join(" | "),
      ),
    );

    return out;
  },
};
