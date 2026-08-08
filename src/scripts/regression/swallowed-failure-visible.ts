/**
 * 회귀: **삼킨 실패가 화면과 저장본 양쪽에 온전히 남는다** — ★행동 게이트 (2026-08-08).
 *
 * 이 자리에서 하루에 **사용자 대면 결함이 세 번** 났고, 세 번 다 회귀는 초록이었다:
 *  ①`finalText` 덮어쓰기 → 화면엔 **잘린 문장만**(조기 종료와 구분 불가)
 *  ②원시 `closeSegment()` 로 **세그먼트를 훔침** → 그 턴 텍스트가 통째로 사라지고 도구만 남음
 *  ③택일→결합으로 바꾸며 stall 재시도의 **중복 문단**을 저장본에 들여놓음
 *
 * ★검사가 매번 초록이었던 이유는 하나다 — **소스 정규식이었다.** 어댑터 한복판의 인라인
 *  로직은 "무엇이 화면에 가고 무엇이 저장되나" 를 **실행으로 물어볼 수가 없다.** 레드팀이
 *  `if (process.env.X === "1") { …발행… }` 한 줄로 8개 단언을 전부 통과시켜 증명했다.
 *
 * 그래서 판정을 `composeSwallowedFailure`(순수)로 뽑고, 여기서 **실제 입력을 넣어 결과를
 * 본다**. 위 세 결함은 전부 이 함수의 입출력으로 표현되므로 재발하면 빨간불이 된다.
 *
 * ★남은 한계(정직하게): 어댑터가 그 판정을 **실제로 쓰는지**는 여전히 소스 검사다. 닫으려면
 *  어댑터를 실행해야 하고 그건 SDK·네트워크가 필요하다. 아래 `[린트]` 표시가 붙은 단언은
 *  **우연한 드리프트는 잡지만 적은 못 막는다** — 등급을 적어 다음 사람이 속지 않게 한다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "swallowed-failure-visible",
  guards:
    "삼킨 실패의 화면·저장본 구성 — 잘린 문장만 남거나, 텍스트가 사라지거나, 중복되지 않게",
  run: async (): Promise<Assertion[]> => {
    const { composeSwallowedFailure } = await import(
      "../../core/llm-runtime/swallowed-failure.js"
    );
    const N = "요청 처리 중 오류가 발생했습니다 — terminated";

    // ①덮어쓰기 금지 — 화면에 있던 것이 저장본에도 있어야 한다.
    const cut = composeSwallowedFailure("", "네. M6-a 부터 시작하겠습니다", N);
    // ②다중 iteration — 앞 조각이 버려지면 안 된다(택일 시절의 결함).
    const multi = composeSwallowedFailure("T1 결과 정리", "T2 진행 중", N);
    // ③stall 재시도 중복 — 재전송이 앞부분을 다시 냈다. 한 번만 남아야 한다.
    const dup = composeSwallowedFailure("앞부분", "앞부분 그리고 뒷부분", N);
    // ④빈 턴 — 안내만.
    const empty = composeSwallowedFailure("", "", N);

    const src = await readFile(
      new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url),
      "utf8",
    );
    // ★창을 쓰지 않는다. 고정 바이트 창은 본문이 자라면 뒷부분을 조용히 놓치고(방금 그렇게
    //  걸렸다), 중괄호 균형은 본문 안 정규식 리터럴에 부서진다(레드팀 실증). **행동은 위
    //  순수 함수가 지키므로** 아래 린트는 파일 전체에서 공존만 본다 — 창 관리가 필요 없다.
    const body = src.replace(/\/\/[^\n]*/g, "");

    return [
      assert(
        "★화면에 나간 텍스트가 저장본에 **남는다**(덮어쓰기 금지 — 잘린 문장만 남던 사고)",
        cut.saved.startsWith("네. M6-a 부터 시작하겠습니다") && cut.saved.includes(N),
        cut.saved.slice(0, 40),
      ),
      assert(
        "★이미 나간 조각은 **다시 안 보낸다**(중복 렌더 0) — delta 엔 안내만",
        cut.deltaText.trim() === N && !cut.deltaText.includes("M6-a"),
        JSON.stringify(cut.deltaText).slice(0, 40),
      ),
      assert(
        "★다중 iteration 에서 앞 조각이 안 버려진다(택일 시절 결함)",
        multi.saved.includes("T1 결과 정리") && multi.saved.includes("T2 진행 중"),
        multi.saved.slice(0, 40),
      ),
      assert(
        "★stall 재시도 중복이 저장본에 안 들어간다(결합으로 바꾸며 새로 연 창)",
        (dup.saved.match(/앞부분/g) ?? []).length === 1 && dup.saved.includes("뒷부분"),
        `앞부분 ${(dup.saved.match(/앞부분/g) ?? []).length}회`,
      ),
      assert(
        "빈 턴이면 안내만(구분선 없이)",
        empty.saved === N && empty.deltaText === N && empty.shown === "",
        empty.saved.slice(0, 30),
      ),
      assert(
        "[린트] 어댑터가 그 판정을 쓴다(직접 조립으로 되돌아가지 않게)",
        /composeSwallowedFailure\(/.test(body) && /finalText = view\.saved/.test(body),
        "판정 경유",
      ),
      assert(
        "[린트] 원시 closeSegment 는 **헬퍼 안에서만**(세그먼트 훔치기 금지)",
        // 정상 호출은 `closeTextSegment()` 정의 안 **딱 1회**다(뽑기와 발행이 한 몸).
        // 그 밖에서 부르면 버퍼만 비워 대시보드 턴 뷰의 텍스트가 사라진다(실측 사고).
        (body.match(/deltaStream\.closeSegment\(\)/g) ?? []).length === 1,
        `원시 호출 ${(body.match(/deltaStream\.closeSegment\(\)/g) ?? []).length}회`,
      ),
      assert(
        "[린트] 삼키기 전에 판정 수치와 함께 로그를 남긴다",
        /codex-swallowed/.test(body) &&
          /iter=\$\{iteration\}/.test(body) &&
          /shown=\$\{view\.shown\.length\}/.test(body),
        "iter·tools·shown",
      ),
    ];
  },
};
