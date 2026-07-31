/**
 * 회귀: **턴이 왜 거기서 끝났는지 로그만으로 재구성된다** (2026-07-30).
 *
 * 사고: 사용자가 "검증한다더니 가만히 있다"고 신고했다(회사 인스턴스, 원격 접속 불가).
 * 로그에 남은 건 `[stream-trace]` tail 뿐이라 **가드가 왜 통과시켰는지 알 수 없었다** —
 * `needsClosingReport` 가 첫 줄(`text !== ""`)에서 빠졌는지, `toolCallsSinceText === 0`
 * 이었는지 구분할 재료가 없어 추론밖에 못 했다. 스티어링이 그 턴에 몇 번 끼어들었는지도
 * 이터레이션별 줄을 세어야 알았다.
 *
 * ★원격 인스턴스(회사돌쇠·회사PC·윈도우)는 DB 조회도 불가 — **로그가 유일한 진단면**이다.
 * 그래서 판정 지점에서 판정 재료를 전부 한 줄로 남긴다. 이 검사는 그 줄이 사라지거나
 * 재료가 빠지는 것을 막는다(순수 로직이 아니라 **관측 가능성**을 지키는 그물).
 */
import { needsClosingReport } from "../../core/llm-runtime/adapters/_turn-completion.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "turn-end-diagnosability",
  guards:
    "턴이 왜 끝났는지(가드가 왜 통과시켰는지) 로그에 재료가 없어 원격 인스턴스 신고를 추론으로만 다루던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // 판정 규칙의 두 분기가 **구분 가능해야** 로그가 쓸모 있다 — 둘 다 "종료" 로 끝나지만
    // 원인이 다르다. 실사고(14:35)는 앞쪽이었다: 텍스트가 있어 첫 줄에서 빠져나갔다.
    const byText = needsClosingReport({
      text: "…검증이 남아 있습니다",
      finalText: "…검증이 남아 있습니다",
      toolCallsSinceText: 4,
      toolNamesSinceText: ["Read", "Edit"],
    });
    const byNoTools = needsClosingReport({
      text: "",
      finalText: "완료했습니다",
      toolCallsSinceText: 0,
      toolNamesSinceText: [],
    });
    out.push(
      assert(
        "★두 '종료' 는 원인이 다르다 — 로그가 그걸 가를 수 있어야 한다",
        byText === false && byNoTools === false,
        `텍스트있음→${byText} / 도구없음→${byNoTools} (둘 다 종료지만 재료가 달라야 구분됨)`,
      ),
    );

    // ★배선 — 판정 재료가 전부 한 줄에 실린다. 하나라도 빠지면 그 축은 다시 추론이 된다.
    const w = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        // ★`model=` 를 못박는다 — 어제 반나절의 결정적 증거가 "같은 초에 어느 모델이
        //  실패했나" 였는데, 그때 로그엔 모델명이 없어 "서브에이전트는 다른 모델일 것"
        //  이라는 **추정**으로 갔다. 이름이 빠지면 그 진단이 다시 불가능해진다.
        // ★`console.log(` 까지 붙여 **무조건 출력**임을 못박는다. 태그만 보면
        //  `if (process.env.X === "1") console.log(...)` 로 감싸도 초록이라, 평시 로그에서
        //  판정 재료 7종이 통째로 사라진다(검토 변이 확인).
        //  ★줄 시작 앵커(`^\s*console\.log\($`)로 **무조건 출력**임을 못박는다. 앵커가
        //   없으면 `if (process.env.X) console.log(` 로 감싸도 매칭돼 초록이었다.
        //  ★두 줄을 **한 패턴**으로 묶어야 한다. `/^\s*console\.log\($/m` 만 따로 두면
        //   같은 파일의 **다른** console.log 를 맞혀서, 이 호출만 env 게이트 뒤로 숨겨도
        //   초록이었다(실제로 변이 잔재가 작업 트리에 남았는데 스위트가 통과했다).
        /^\s*console\.log\(\s*`\[codex-turn-end\] model=\$\{model\}/m,
        /closing=\$\{closing \? "재요청" : "종료"\}/, // 가드 판정 결과
        /text=\$\{text\.length\} finalText=\$\{finalText\.length\}/, // 첫 줄 분기 판별
        /toolsSinceText=\$\{toolCallsSinceText\}/, // 두 번째 분기 판별
        /steered=\$\{steeredTotal\}/, // 스티어링 개입 횟수(턴 누적)
        /tail: \$\{tail\}/, // 예고형/보고형 사람 판단용
        /sseEnd=\$\{\[\.\.\.sseEndTally/, // 스트림이 어떻게 끝났는지(completed 유무) 집계
      ],
    );
    out.push(
      assert(
        "★판정 재료 7종이 턴 종료 한 줄에 전부 실린다(모델명 포함)",
        w.ok,
        w.ok ? "7개 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );

    // 스티어링 주입은 **정상 동작**이다 — [error] 로 찍으면 로그 훑을 때 진짜 에러와 섞인다
    // (실측: 회사 로그의 error 3건이 전부 이것이었다).
    const lvl = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [/console\.log\(\s*`\[codex-oauth steering\] injected/],
    );
    out.push(
      assert(
        "스티어링 주입은 [error] 가 아니라 [log] 로 찍는다",
        lvl.ok,
        lvl.ok ? "log 레벨 확인" : "여전히 console.error — 진짜 에러와 섞인다",
      ),
    );
    // ★completed 없이 끝난 스트림은 **무엇이 왔는지**까지 남겨야 판단 재료가 된다.
    //  실사고에서 chunks=266 만 알고 그 266조각의 정체를 몰라 "모델 침묵"인지
    //  "전송 절단"인지 못 갈랐다. 드문 경로라 상세 1줄이 소음이 되지 않는다.
    const inc = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [/\[codex-sse-incomplete\]/, /events=\[\$\{hist \|\| "없음"\}\]/],
    );
    out.push(
      assert(
        "★completed 없이 끝난 스트림은 이벤트 히스토그램과 함께 남는다",
        inc.ok,
        inc.ok ? "상세 로그 확인" : `누락 ${inc.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
