/**
 * 회귀: **입력창 위 진행 표시는 「내 대화」의 상태다** (2026-08-21, 사용자 요청).
 *
 * 사고: 그 줄은 내 입력창 **바로 위**라 누구나 "내 요청 상태" 로 읽는다. 그런데 판정이
 * `activeTurns.size > 0` 이었다 — 내 대화가 놀고 있어도 **다른 세션의 턴**이나
 * **백그라운드 잡**이 하나 있으면 "돌쇠 작업 중" 이 떴다. 헤드리스로 둘 다 재현했다:
 *
 *   ② 남의 세션만 도는 척 → activeTurns=1 내세션포함=false 배너="✳️ 돌쇠 작업 중"
 *   ③ 백그라운드 잡만 도는 척 → activeTurns=1 배너="✳️ 돌쇠 작업 중"
 *
 * ★2026-08-06 에 **같은 이유로 경과시간은 고쳤는데 깃발 자체는 안 고쳤다** — 고쳐진 축과
 *  안 고쳐진 축이 나란히 있던 자리다(이 레포에서 흔한 모양이라 여기 적어 둔다).
 *
 * 지키는 것:
 *  ①내 세션에 진행 중 턴이 있을 때만 "작업 중" 이다
 *  ②메인이 비었고 백그라운드만 돌면 **대기 중**이다 — 다른 상태이고, 다르게 보인다
 *  ③아무것도 없으면 숨는다
 *  ④무엇을 하는 중인지 구분해서 말한다(생각 중 / 답변 쓰는 중 / 도구 실행 중)
 *  ⑤경과시간은 **내 턴의 것만** — 모르면(복원분) 안 쓴다
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS = (n: string): string =>
  readFileSync(path.join(REPO, "packages/dashboard/js", n), "utf8");

/** `const <name> = (` 부터 짝 맞는 `}` 까지. */
const sliceFn = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return `${src.slice(start, i + 1)};`;
    }
  }
  return null;
};

type View = { show: boolean; label: string; elapsed: string; idle: boolean };

export const check: RegressionCheck = {
  name: "working-banner-is-mine",
  guards:
    "내 대화가 놀고 있는데 다른 세션의 턴이나 백그라운드 잡 때문에 '작업 중' 이 뜨던 것 + 무엇을 하는 중인지 알 수 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = JS("axis1-options.js");

    const fn = sliceFn(src, "workingBannerView");
    out.push(
      assert(
        "★진행 표시 판정이 순수 함수다(렌더 안이면 브라우저를 띄워야만 확인된다)",
        fn !== null,
        fn === null ? "★workingBannerView 없음" : `${fn.length}자`,
      ),
    );
    if (fn === null) return out;

    // ★`doingText` 는 **실물을 올린다**(util.js 정의점) — 스텁으로 대신하면 "무엇을 하는
    //  중인지" 단언이 스텁을 검사하게 된다. `fmtElapsed` 는 경과 **유무**만 보므로 표식.
    const doing = sliceFn(JS("util.js"), "doingText");
    out.push(
      assert(
        "★진행 단계 문구가 공유 정의점(util.js doingText)에 있다 — 메인 표시와 잡 카드가 같은 말을 쓴다",
        doing !== null,
        doing === null ? "★doingText 없음" : `${doing.length}자`,
      ),
    );
    if (doing === null) return out;
    const view = new Function(
      `const fmtElapsed = (ms) => "ELAPSED(" + ms + ")";${doing}${fn}return workingBannerView;`,
    )() as (v: Record<string, unknown>) => View;

    const base = { assistantName: "돌쇠", now: 10_000 };

    // ① 내 턴이 있을 때만 작업 중.
    const mine = view({ ...base, mineActive: true, mineStart: 4_000, otherCount: 0, bgRunning: 0 });
    out.push(
      assert(
        "내 세션에 진행 중 턴이 있으면 작업 중이고 경과시간이 붙는다",
        mine.show && !mine.idle && mine.elapsed.includes("6000"),
        `label="${mine.label}" elapsed="${mine.elapsed}"`,
      ),
    );

    // ★남의 세션만 도는 경우 — 재현했던 그 상황.
    const other = view({ ...base, mineActive: false, mineStart: null, otherCount: 3, bgRunning: 0 });
    out.push(
      assert(
        "★다른 세션만 도는 동안 내 화면은 '작업 중' 이라고 하지 않는다(재현된 오표시)",
        other.show === false,
        other.show ? `★뜸: "${other.label}"` : "숨김",
      ),
    );

    // (남의 세션 수가 내 줄에 안 섞이는지는 **배선 쪽**이 본다 — `working-elapsed-own-session`
    //  이 실물 `paintWorking` 으로 ③남 있음 / ④남 없음의 출력을 비교한다. 같은 판단을 두
    //  파일에 적지 않는다.)

    // ② 백그라운드만 도는 경우 = 대기 중(다른 상태).
    const bg = view({ ...base, mineActive: false, mineStart: null, otherCount: 0, bgRunning: 2 });
    out.push(
      assert(
        "★메인이 비었고 백그라운드만 돌면 '대기 중' 이다 — 작업 중과 다른 상태로 보인다",
        bg.show && bg.idle && bg.label.includes("대기") && !bg.label.includes("작업 중"),
        `label="${bg.label}" idle=${bg.idle}`,
      ),
    );
    out.push(
      assert(
        "대기 중엔 경과시간을 쓰지 않는다(내 턴이 아니라 잴 것이 없다)",
        bg.elapsed === "",
        `elapsed="${bg.elapsed}"`,
      ),
    );

    // ③ 아무것도 없으면 숨는다.
    const none = view({ ...base, mineActive: false, mineStart: null, otherCount: 0, bgRunning: 0 });
    out.push(
      assert("아무것도 안 돌면 숨는다", none.show === false, `show=${none.show}`),
    );

    // ④ 무엇을 하는 중인지 구분한다.
    const phases: Array<[unknown, string]> = [
      [null, "생각 중"],
      [{ kind: "text", label: "text" }, "답변 쓰는 중"],
      [{ kind: "tool", label: "Read" }, "Read 실행 중"],
    ];
    const wrong = phases.filter(
      ([p, want]) =>
        !view({ ...base, mineActive: true, mineStart: 4_000, otherCount: 0, bgRunning: 0, phase: p })
          .label.includes(want),
    );
    out.push(
      assert(
        "★무엇을 하는 중인지 구분해서 말한다(생각 중 / 답변 쓰는 중 / 도구 실행 중)",
        wrong.length === 0,
        wrong.length === 0
          ? phases.map(([, w]) => w).join(" · ")
          : `★안 맞음 ${wrong.length}건`,
      ),
    );

    // ⑤ 시작시각을 모르면(새로고침 복원분) 경과시간을 지어내지 않는다.
    const restored = view({
      ...base,
      mineActive: true,
      mineStart: null,
      otherCount: 0,
      bgRunning: 0,
    });
    out.push(
      assert(
        "★복원분(시작시각 미상)은 경과시간을 지어내지 않는다",
        restored.show && restored.elapsed === "",
        `elapsed="${restored.elapsed}"`,
      ),
    );

    // 배선 — 백그라운드 잡은 **메인 상태에 안 섞인다**: 워커 활동을 걸러낸 뒤에만 단계를 싣는다.
    const sse = JS("sse.js");
    const wIdx = sse.indexOf("handleWorkerActivity(ap, ts)");
    const pIdx = sse.indexOf("setTurnPhase(");
    out.push(
      assert(
        "★진행 단계는 워커 활동을 걸러낸 **뒤**에 실린다(백그라운드가 메인 상태로 새지 않는다)",
        wIdx >= 0 && pIdx > wIdx,
        `handleWorkerActivity=${wIdx} · setTurnPhase=${pIdx}`,
      ),
    );
    // ★매니저·에이전트 카드도 **같은 판정**으로 자기 상태를 말한다 (2026-08-21 사용자 제안).
    //  스텝 목록은 접혀 있을 수 있어 카드 머리에 실린다. 문구를 각자 만들면 같은 상태를
    //  두 이름으로 부르게 되므로, 정의점(`doingText`)을 쓰는지 본다.
    {
      const drawer = JS("background-drawer.js");
      const wIdx = drawer.indexOf("const handleWorkerActivity");
      const uses = drawer.slice(wIdx < 0 ? 0 : wIdx).includes("doingText(");
      out.push(
        assert(
          "★잡 카드도 지금 무엇을 하는 중인지 보여준다 — 메인 표시와 같은 정의점을 쓴다",
          wIdx >= 0 && uses,
          `handleWorkerActivity=${wIdx} · doingText 사용=${uses}`,
        ),
      );
      out.push(
        assert(
          "끝난·취소 중인 잡의 상태를 덮어쓰지 않는다(진행 중일 때만 단계를 싣는다)",
          /status === "running"[\s\S]{0,120}?doingText\(/.test(drawer),
          `running 가드=${/status === "running"[\s\S]{0,120}?doingText\(/.test(drawer)}`,
        ),
      );
    }

    out.push(
      assert(
        "턴이 끝나면 단계를 지운다(옛 단계가 다음 턴에 눌러붙지 않게)",
        /markTurnDone[\s\S]{0,200}?turnPhase\.delete/.test(src),
        `turnPhase 정리=${/markTurnDone[\s\S]{0,200}?turnPhase\.delete/.test(src)}`,
      ),
    );
    return out;
  },
};
