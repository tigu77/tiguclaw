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

    // ★도구 반복 상한(HARD)이 **조용히** 발동하던 것 (2026-08-14).
    //  모델은 사용자에게 "도구 호출 한도에 도달했습니다" 라고 말한다 — 우리가 그 문구를
    //  nudge 로 넣기 때문이다. 그런데 로그엔 그 사건이 한 줄도 없어서, "자꾸 한도에
    //  걸린다"는 신고를 `[codex-turn-end]` 의 iter 값으로 역추론할 수밖에 없었다.
    //  ★수치가 같이 실려야 한다 — 몇/몇 회인지(임계 대비 위치)와 무슨 도구를 반복했는지가
    //   없으면 "정당하게 긴 작업" 과 "루프" 를 못 가른다(그게 유일하게 중요한 판단이다).
    // ★변이가 뚫은 두 수법을 막는다 (2026-08-14 적대 검토 ⑨·⑩):
    //  ①줄-시작 앵커는 **같은 줄** 게이트만 막는다 — 앞 **줄**에 `if (env)` 를 두면 통과했다.
    //  ②필드 단언이 같은 파일의 **다른 로그 줄**에 기생한다 — ext-tools 에서 thread 를
    //    지워도 tool-cap 줄이 대신 만족시켰다. 그래서 **블록 단위**로 자른 뒤 그 안에서 본다.
    //  ★`blockOf` 는 태그부터 그 호출의 닫는 `);` 까지 = 한 로그 문장. 판정 대상이 마크업이
    //   아니라 그 문장이라는 것을 코드로 못 박는다.
    const codexSrc = await (async () => {
      const { readFile } = await import("node:fs/promises");
      return readFile(
        new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url),
        "utf8",
      );
    })();
    /** 로그 태그가 있는 **한 문장**(console.*( … );)만 잘라낸다. */
    const blockOf = (tag: string): string => {
      const at = codexSrc.indexOf(tag);
      if (at < 0) return "";
      const start = codexSrc.lastIndexOf("console.", at);
      const end = codexSrc.indexOf("\n        );", at);
      return start < 0 || end < 0 ? codexSrc.slice(Math.max(0, at - 200), at + 600) : codexSrc.slice(start, end);
    };
    /** 그 문장이 **조건 없이** 실행되는가 — 바로 앞 줄이 `if (`/`&&` 로 끝나면 게이트된 것. */
    const unconditional = (tag: string): boolean => {
      const at = codexSrc.indexOf(tag);
      if (at < 0) return false;
      const lineStart = codexSrc.lastIndexOf("\n", codexSrc.lastIndexOf("console.", at));
      const prev = codexSrc.slice(codexSrc.lastIndexOf("\n", lineStart - 1) + 1, lineStart).trim();
      return !/^if\s*\(|&&\s*$|\?\s*$/.test(prev);
    };
    const capBlock = blockOf("[codex-tool-cap]");
    out.push(
      assert(
        "★도구 상한 로그가 **조건 없이** 찍히고 판정 수치를 자기 문장 안에 담는다",
        unconditional("[codex-tool-cap]") &&
          /iter=\$\{iterLabel\(iteration, iterationBase, CODEX_MAX_TOOL_ITERATIONS_HARD\)\}/.test(capBlock) &&
          // ★분자·분모가 **같은 좌표계**여야 한다 (2026-09-01 적대 검토 F4). 이어가기가
          //  창을 옮기면서 분자만 절대값이 됐고, 실제 로그가 `iter=1639/150` 을 찍었다 —
          //  분자가 분모를 열 배 넘으니 원격에서 그 줄만 보는 사람은 계산이 깨졌다고 읽는다.
          //  이름을 열거하는 대신 **규칙**으로 본다: 이 파일 어디에도 절대 iteration 을
          //  창 크기로 나눈 분수가 없다. 새 로그 줄이 생겨도 같이 걸린다.
          !/\$\{iteration\}\/\$\{CODEX_MAX_TOOL_ITERATIONS_HARD\}/.test(codexSrc) &&
          /thread=\$\{input\.threadKey\}/.test(capBlock) &&
          /상위\(\$\{top\}\)/.test(capBlock) &&
          // `top` 이 항상 빈 문자열이 되면 수치가 사라진다 — 실제로 뚫린 변이(.slice(0,0)).
          /\.slice\(0,\s*5\)/.test(codexSrc),
        `무조건=${unconditional("[codex-tool-cap]")} 블록=${capBlock.length}자`,
      ),
    );
    const extBlock = blockOf("[codex-ext-tools]");
    out.push(
      assert(
        "★게이트웨이 패스스루 로그도 무조건 + thread 좌표를 **자기 문장 안에** 담는다",
        unconditional("[codex-ext-tools]") &&
          /thread=\$\{input\.threadKey\}/.test(extBlock) &&
          /호출\(\$\{externalMatched\.map\(/.test(extBlock),
        `무조건=${unconditional("[codex-ext-tools]")} 블록=${extBlock.length}자`,
      ),
    );
    out.push(
      assert(
        "진행 로그(25·50·75…)도 무조건 찍힌다",
        unconditional("[codex-tool-progress]"),
        `무조건=${unconditional("[codex-tool-progress]")}`,
      ),
    );
    // ★추론 강도 전달도 같은 부류 — env 블록으로 감싸면 기능이 조용히 꺼진다(적대 검토 ③).
    //  ★2026-08-24: 앞에 `input.reasoning ??` 가 붙었다(프로파일 풀 원소 > 전역 > 카탈로그).
    //   패턴을 그에 맞추되 **의도는 그대로** — env 뒤로 숨지 않는지를 본다.
    out.push(
      assert(
        "★추론 강도 전달이 env 게이트 뒤로 숨지 않는다",
        /\} else \{\n(?:.*\n)*?\s*const effort = input\.reasoning \?\? resolveReasoningEffort\("codex", model, input\.cwd\);/.test(codexSrc) &&
          !/process\.env\.[A-Z_]+[^\n]*\n\s*const effort = /.test(codexSrc),
        "미게이트 확인",
      ),
    );
    const cap = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /^\s*console\.warn\(\s*`\[codex-tool-cap\]/m, // 무조건 출력 + warn 레벨(드문 사건)
        /iter=\$\{iterLabel\(iteration, iterationBase, CODEX_MAX_TOOL_ITERATIONS_HARD\)\}/, // 라벨은 한 곳(openai-codex-oauth-loop.ts)에서 만든다
        /thread=\$\{input\.threadKey\}/, // 어느 대화인가(원격 진단의 유일한 좌표)
        /상위\(\$\{top\}\)/, // 무엇을 반복했나 — 루프 판별
        /^\s*console\.log\(\s*`\[codex-tool-progress\]/m, // 부딪히기 전에 커지는 게 보인다
      ],
    );
    out.push(
      assert(
        "★도구 반복 상한은 수치와 함께 로그에 남는다(조용히 발동 금지)",
        cap.ok,
        cap.ok ? "cap 로그 5요소 확인" : `누락 ${cap.missing.join(" ")}`,
      ),
    );

    // ★외부 도구 패스스루 종료도 남아야 한다 (2026-08-14). `[codex-turn-end]` 는
    //  `toolCalls.length === 0` 분기 **안에서만** 찍히는데, 패스스루 break 는 그 앞이다 —
    //  그래서 게이트웨이 로그의 turn-end 는 전부 "도구 0회" 턴뿐이었고, 도구를 돌려준
    //  라운드는 한 줄도 안 남았다. 클라이언트가 "도구 호출 한도에 걸린다" 고 신고해도
    //  우리 로그로는 라운드가 몇 번이었는지 **원리적으로 확인 불가**였다.
    const ext = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /^\s*console\.log\(\s*`\[codex-ext-tools\]/m,
        /thread=\$\{input\.threadKey\}/,
        /호출\(\$\{externalMatched\.map\(/, // 무슨 도구를 돌려줬나
      ],
    );
    out.push(
      assert(
        "★외부 도구 패스스루로 끝난 턴도 로그에 남는다(게이트웨이 라운드가 보인다)",
        ext.ok,
        ext.ok ? "패스스루 로그 확인" : `누락 ${ext.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
