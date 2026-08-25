/**
 * 회귀: **다음 메시지 제안을 메인 턴에 끼워 받는다** (2026-08-25 사용자 결정).
 *
 * 종전엔 답을 보낸 뒤 `runRegionA` 를 **한 번 더** 불러 제안 한 줄을 만들었다. 실측하니
 * 그 호출의 컨텍스트 상한이 **39,600자(≈13~20K 토큰)** 였고(8턴 × (3,000+1,200) + 6,000),
 * 매 턴 바뀌는 대화라 **프리픽스 캐시도 못 탔다**. 메인 턴은 이미 그 맥락을 들고 캐시도
 * 태웠으므로, 거기서 한 줄 더 받으면 **출력 토큰 스무 개 남짓**이다.
 *
 * ★이 방식의 **유일한 실패 모드는 유출**이다 — 표식이 사용자 화면이나 다음 턴 히스토리에
 *  남는 것. 그래서 뜯는 자리를 코어 한 곳(`callAdapter` 반환 직후, `persistOutput`·
 *  `publishTurnDone` 보다 **앞**)에 두었다. 그 순서가 깨지면 transcripts 에 태그가 쌓이고,
 *  그건 다음 턴 프롬프트로 되돌아온다(조용하고 누적된다).
 *
 * ★두 번째 계약은 **관용**이다. 모델이 안 붙이면 제안이 없을 뿐 실패가 아니다. 종전 동작도
 *  "확신 없으면 빈 줄"이었으므로 폭이 같다 — 강제하면 억지 제안이 나온다.
 *
 * ★등급: **행동 게이트**. 추출·정규화가 순수 함수라 실행해서 본다. 배선(코어가 실제로
 *  persist 앞에서 부르는가 · 프롬프트 규칙이 메인에만 실리는가)은 실행 + 소스 대조를 섞었고,
 *  어느 쪽인지 단언 이름에 적었다.
 */
import { readFile } from "node:fs/promises";
import { splitAtSuggestionTag } from "../../core/llm-runtime/adapters/_delta-stream.js";
import {
  extractInlineSuggestion,
  inlineSuggestionRule,
  SUGGESTION_MAX_CHARS,
} from "../../core/next-message-suggestion.js";
import {
  buildContextSlots,
  inlineSuggestionSlotText,
} from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const EMPTY = {
  system: "",
  env: "",
  agent: "",
  agentWarn: "",
  convoContext: "",
  memoryIndex: "",
  memorySnippet: "",
  skillIndex: "",
  agentIndex: "",
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 유출 0 — 태그는 어디 있든 화면에 안 남는다 ──────────────────────────
  const leaky = [
    "답변입니다.\n\n<next-message>그럼 배포하자</next-message>",
    "답변입니다.<next-message>그럼 배포하자</next-message>\n꼬리말",
    "<next-message>맨 앞에</next-message>답변입니다.",
    "답변입니다.\n<next-message>잘린 출력", // 닫는 태그 없음
    "둘\n<next-message>첫째</next-message>\n중간\n<next-message>둘째</next-message>",
  ];
  const leaked = leaky.filter((raw) => extractInlineSuggestion(raw).text.includes("next-message"));
  out.push(
    assert(
      "★표식이 답변 어디에 있든 남지 않는다(잘린 출력·여러 개·맨 앞 포함)",
      leaked.length === 0,
      leaked.length === 0
        ? `${leaky.length}종 확인`
        : `★유출: ${leaked.map((s) => s.slice(0, 30)).join(" | ")}`,
    ),
    assert(
      "여러 개면 **마지막**을 쓴다(꼬리가 진짜 결론이다)",
      extractInlineSuggestion(leaky[4]!).suggestion === "둘째",
      String(extractInlineSuggestion(leaky[4]!).suggestion),
    ),
    assert(
      "닫는 태그가 없어도 뜯어낸다(스트림이 잘려도 화면은 깨끗하다)",
      extractInlineSuggestion(leaky[3]!).suggestion === "잘린 출력" &&
        extractInlineSuggestion(leaky[3]!).text.trim() === "답변입니다.",
      JSON.stringify(extractInlineSuggestion(leaky[3]!)),
    ),
  );

  // ── ② 본문이 보존된다 — 뜯다가 답을 깎으면 그게 더 나쁘다 ─────────────────
  const body = "이렇게 하면 됩니다.\n\n- 첫째\n- 둘째";
  const got = extractInlineSuggestion(`${body}\n<next-message>다음</next-message>`);
  out.push(
    assert(
      "★답변 본문은 한 글자도 안 깎인다(끝 공백만 정리)",
      got.text === body && got.suggestion === "다음",
      `${JSON.stringify(got.text.slice(-12))} · ${String(got.suggestion)}`,
    ),
  );

  // ── ③ 관용 — 안 붙였으면 조용히 없다(실패가 아니다) ───────────────────────
  const noTag = ["그냥 답변입니다.", "", "  "];
  const wrong = noTag.filter((raw) => {
    const r = extractInlineSuggestion(raw);
    return r.suggestion !== null || r.text !== raw;
  });
  out.push(
    assert(
      "★표식이 없으면 아무것도 안 한다(본문 무변경 · 제안 null)",
      wrong.length === 0,
      wrong.length === 0 ? `${noTag.length}종 확인` : `★건드림: ${JSON.stringify(wrong)}`,
    ),
    assert(
      "빈 제안·공백 제안은 안 쓴다(억지 제안보다 없는 게 낫다)",
      extractInlineSuggestion("답<next-message>   </next-message>").suggestion === null &&
        extractInlineSuggestion("답<next-message></next-message>").suggestion === null,
      "빈칸 2종 거부",
    ),
    assert(
      `제안이 길이 상한(${SUGGESTION_MAX_CHARS})을 넘지 않는다`,
      (extractInlineSuggestion(`답<next-message>${"가".repeat(400)}</next-message>`).suggestion
        ?.length ?? 0) <= SUGGESTION_MAX_CHARS,
      String(
        extractInlineSuggestion(`답<next-message>${"가".repeat(400)}</next-message>`).suggestion
          ?.length,
      ),
    ),
  );

  // ── ④ 규칙은 **메인에만** 실린다 ──────────────────────────────────────────
  //  서브에이전트·매니저의 결과는 사용자 채팅창이 아니라 부른 쪽으로 간다.
  // ★설정을 **인자로** 준다 — 주변 settings.json 에 기대면 기능이 꺼진 레포에서 이 단언이
  //  항상 초록이 된다(실제로 그 구멍으로 변이 하나가 빠져나갔다).
  const on = (r: { subagentDepth?: number; workerDepth?: number }): string =>
    inlineSuggestionSlotText(r, true);
  out.push(
    assert(
      "★켜져 있고 메인이면 규칙이 **실제로 실린다**(빈 슬롯으로 조용히 통과하지 않게)",
      on({}).length > 0,
      `main=${on({}).length}B`,
    ),
    assert(
      "★서브에이전트·매니저에겐 규칙이 안 실린다(부모가 읽을 본문이 오염되지 않게)",
      on({ subagentDepth: 1 }) === "" && on({ workerDepth: 1 }) === "",
      `sub=${on({ subagentDepth: 1 }).length}B · mgr=${on({ workerDepth: 1 }).length}B`,
    ),
    assert(
      "꺼져 있으면 아무것도 안 싣는다(토큰 쓰는 기능은 명시적으로만)",
      inlineSuggestionSlotText({}, false) === "",
      `off=${inlineSuggestionSlotText({}, false).length}B`,
    ),
    assert(
      "규칙 슬롯이 **안정(system) 채널**이다(매 턴 재전송하지 않게)",
      buildContextSlots({ ...EMPTY, roleSource: {} }).find((s) => s.key === "nextSuggestion")
        ?.channel === "system",
      String(
        buildContextSlots({ ...EMPTY, roleSource: {} }).find((s) => s.key === "nextSuggestion")
          ?.channel,
      ),
    ),
    assert(
      "규칙 본문이 태그와 '확신 없으면 붙이지 마라'를 둘 다 말한다",
      inlineSuggestionRule().includes("<next-message>") &&
        /확신이 안 서면/.test(inlineSuggestionRule()),
      `${inlineSuggestionRule().length}B`,
    ),
  );

  // ── ⑤ 배선 — 뜯는 자리가 **persist 보다 앞**인가 ─────────────────────────
  //  ★이건 소스 대조다(순서를 본다). 그 한계를 이름에 적는다 — 다만 이 순서가 이 기능의
  //   유일한 실패 모드라 그물 없이 둘 수는 없다.
  const rt = await readFile(new URL("../../core/llm-runtime/index.js".replace(".js", ".ts"), import.meta.url), "utf8");
  const at = rt.indexOf("extractInlineSuggestion(output.text");
  const persistAt = rt.indexOf("persistOutput(input, output)");
  const publishAt = rt.indexOf("publishTurnDone(spec, input, output");
  out.push(
    assert(
      "★[소스 대조] 뜯기가 `persistOutput`·`publishTurnDone` 보다 **앞**이다",
      at > 0 && persistAt > at && publishAt > at,
      at > 0 && persistAt > at && publishAt > at
        ? "순서 확인"
        : `★extract=${at} publish=${publishAt} persist=${persistAt}`,
    ),
  );

  // ── ⑥ 옛 배관이 되살아나지 않았다 ─────────────────────────────────────────
  //  별도 LLM 호출을 없앤 게 이 변경의 값이다. 되살아나면 그 값이 조용히 사라진다.
  const idx = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
  const revived = /maybeSuggestNextMessage[\s\S]{0,2000}?runRegionA\(/.test(idx);
  out.push(
    assert(
      "★제안이 다시 별도 LLM 호출을 하지 않는다(끼워 받기의 값이 사라지지 않게)",
      !revived,
      revived ? "★runRegionA 재등장" : "별도 호출 0",
    ),
  );
  // ── ⑦ ★스트리밍 화면에도 안 샌다 (2026-08-25) ─────────────────────────────
  //  최종 응답에서 뜯는 것만으로는 부족하다 — 대시보드는 `llm.delta` 를 **실시간으로
  //  그린다**(`js/sse.js`). 그래서 답이 끝나는 순간 태그가 화면에 잠깐 떴다 사라진다.
  //  억제는 세 어댑터의 공유 길목(`_delta-stream.ts`)에 있어 한 곳에서 닫힌다.
  {
    const whole = splitAtSuggestionTag("답변입니다.<next-message>다음</next-message>");
    out.push(
      assert(
        "★스트림에서 여는 태그를 만나면 그 앞까지만 내보내고 멈춘다",
        whole.emit === "답변입니다." && whole.stop,
        `emit=${JSON.stringify(whole.emit)} stop=${String(whole.stop)}`,
      ),
    );
    // 청크 경계로 쪼개져 와도 새면 안 된다 — 반쪽 태그가 가장 흔한 유출 모양이다.
    const a = splitAtSuggestionTag("답변입니다.<next-");
    const b = splitAtSuggestionTag(a.hold + "message>다음");
    out.push(
      assert(
        "★태그가 청크 경계로 쪼개져도 새지 않는다(접두 꼬리를 보류했다 이어 본다)",
        a.emit === "답변입니다." && !a.stop && a.hold === "<next-" && b.emit === "" && b.stop,
        `1차 emit=${JSON.stringify(a.emit)} hold=${JSON.stringify(a.hold)} · 2차 stop=${String(b.stop)}`,
      ),
    );
    // ★반대 방향 — 정상 텍스트를 깎으면 그게 더 나쁘다.
    const plain = splitAtSuggestionTag("코드: <div>과 <span>");
    out.push(
      assert(
        "★태그가 아닌 `<` 는 한 글자도 안 깎는다(마크다운·코드가 흔히 이렇게 끝난다)",
        plain.emit + plain.hold === "코드: <div>과 <span>" && !plain.stop,
        `emit+hold=${JSON.stringify(plain.emit + plain.hold)}`,
      ),
    );
    const tail = splitAtSuggestionTag("문장이 <n");
    out.push(
      assert(
        "태그 접두처럼 끝나면 보류하되 버리지 않는다(flush·closeSegment 가 확정)",
        tail.emit === "문장이 " && tail.hold === "<n" && !tail.stop,
        `emit=${JSON.stringify(tail.emit)} hold=${JSON.stringify(tail.hold)}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "inline-next-suggestion",
  guards:
    "다음 메시지 제안이 매 턴 별도 LLM 호출(컨텍스트 상한 39,600자·캐시 미적중)을 쓰던 것 + 끼워 받으면서 생기는 유일한 실패 모드(표식이 화면·transcripts 로 유출)",
  run,
};
export default check;
