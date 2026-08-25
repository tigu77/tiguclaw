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
import {
  createDeltaStream,
  stepSuggestionStream,
} from "../../core/llm-runtime/adapters/_delta-stream.js";
import { getEventBus } from "../../core/eventbus.js";
import {
  applyInlineSuggestion,
  extractInlineSuggestion,
  inlineSuggestionRule,
  NEXT_TAG_CLOSE,
  NEXT_TAG_OPEN,
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
  const paSrc = await readFile(new URL("../../core/prompt-assembly.ts", import.meta.url), "utf8");

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
  //  ★**앞쪽**도 지킨다 (적대 검토 C4): `trimEnd` 를 `trim` 으로 바꾸면 답변 첫 줄의
  //   들여쓰기·개행이 사라진다. 코드블록·인용으로 시작하는 답이 그대로 깨진다.
  {
    const indented = "  들여쓴 첫 줄\n뒷줄";
    const got0 = extractInlineSuggestion(`${indented}<next-message>다음</next-message>`);
    out.push(
      assert(
        "★답변 **앞쪽** 공백·개행도 안 깎인다(끝만 정리한다)",
        got0.text === indented,
        JSON.stringify(got0.text),
      ),
    );
  }
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
    // ★상한을 **리터럴**과 비교한다 (재검토 G-5). 상수 자기 자신과 비교하면 상수를
    //  100000 으로 바꿔도 통과한다 — 원리적으로 못 실패하는 검사다.
    assert(
      "★제안이 길이 상한(120)을 넘지 않는다 — 고스트는 한 줄짜리 자리다",
      (extractInlineSuggestion(`답<next-message>${"가".repeat(400)}</next-message>`).suggestion
        ?.length ?? 0) <= 120 && SUGGESTION_MAX_CHARS === 120,
      String(
        extractInlineSuggestion(`답<next-message>${"가".repeat(400)}</next-message>`).suggestion
          ?.length,
      ),
    ),
    // ★G-4: BMP 밖 문자(이모지)가 경계에 걸리면 반쪽 서로게이트가 남아 고스트에 `?` 가 뜬다.
    //  코퍼스가 전부 한글이라 이 컷이 한 번도 안 돌았다.
    assert(
      "★길이 컷이 이모지를 반으로 쪼개지 않는다(고스트에 깨진 글자가 안 뜨게)",
      !/[\uD800-\uDBFF]$/.test(
        extractInlineSuggestion(`답<next-message>${"가".repeat(119)}🚀</next-message>`).suggestion ??
          "",
      ),
      JSON.stringify(
        (extractInlineSuggestion(`답<next-message>${"가".repeat(119)}🚀</next-message>`).suggestion ??
          "").slice(-2),
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
    // ★규칙 자리와 표시 자리가 **같은 판정**을 쓴다 (적대 검토 P1) — 종전엔 규칙은 depth,
    //  고스트는 threadKey 접두사로 걸러 둘이 갈렸다. 스케줄러·엔드포인트 턴(실측 34%)에
    //  규칙이 실리고 모델이 제안을 만들고 그 제안은 버려졌다.
    assert(
      "★파생 좌표(스케줄러·엔드포인트·워커)엔 규칙을 안 싣는다 — 만들어도 버려지니까",
      ["scheduler:21", "endpoint:x", "worker:abc", "agent:y", "gateway:z"].every(
        (tk) => inlineSuggestionSlotText({ threadKey: tk }, true) === "",
      ),
      ["scheduler:21", "endpoint:x", "worker:abc"]
        .map((tk) => `${tk}=${inlineSuggestionSlotText({ threadKey: tk }, true).length}B`)
        .join(" · "),
    ),
    assert(
      "사람이 보는 좌표엔 싣는다(과보수로 기능을 죽이지 않게)",
      inlineSuggestionSlotText({ threadKey: "dashboard:default" }, true).length > 0,
      `${inlineSuggestionSlotText({ threadKey: "dashboard:default" }, true).length}B`,
    ),
    assert(
      "★분류·요약 등 내부 호출엔 안 싣는다(nano 급 모델에 섞이지 않게)",
      inlineSuggestionSlotText({ internal: true }, true) === "",
      `internal=${inlineSuggestionSlotText({ internal: true }, true).length}B`,
    ),
    assert(
      "꺼져 있으면 아무것도 안 싣는다(토큰 쓰는 기능은 명시적으로만)",
      inlineSuggestionSlotText({}, false) === "",
      `off=${inlineSuggestionSlotText({}, false).length}B`,
    ),
    // ★[배선] 슬롯이 **실제 roleSource 를 받는가** (재검토 G-1). `inlineSuggestionSlot(
    //  input.roleSource)` 를 `({})` 로 바꾸면 P1·P5 가 **동시에** 되살아나는데 1,739건이
    //  초록이었다 — 판정은 검사되는데 그 판정에 값을 주는 자리가 안 검사됐다(오늘 네 번째).
    assert(
      "★[배선] 슬롯이 판정에 `input.roleSource` 를 넘긴다(빈 객체로 잘리지 않게)",
      /inlineSuggestionSlotText\(input\.roleSource,/.test(paSrc),
      /inlineSuggestionSlotText\(input\.roleSource,/.test(paSrc)
        ? "배선 확인"
        : "★인자가 끊겼다 — 파생 턴·내부 호출에 규칙이 다시 실린다",
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
  const at = rt.indexOf("applyInlineSuggestion(output)");
  const persistAt = rt.indexOf("persistOutput(input, output)");
  const publishAt = rt.indexOf("publishTurnDone(spec, input, output");
  out.push(
    assert(
      "★[소스 대조] 뜯기(`applyInlineSuggestion`)가 persist·publish 보다 **앞**이다",
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
  // ── ⑦ ★스트리밍을 **실제로 돌려서** 본다 (2026-08-25 적대 검토 재작성) ────────
  //  종전엔 순수 함수만 불렀다. 적대 검토가 그 틈으로 변이 **4건**을 통과시켰다 —
  //  `heldTail` 을 안 이어붙이기 · flush 보류분 확정 제거 · closeSegment 보류분 확정 제거 ·
  //  래치 해제 제거. 전부 **상태**가 있는 코드인데 검사엔 상태가 없었다.
  //  이제 청크 열을 실제로 push 하고 **발행된 llm.delta 전문**과 세그먼트를 대조한다.
  {
    const bus = getEventBus();
    const runStream = (chunks: string[]): { shown: string; segment: string } => {
      let shown = "";
      const off = bus.subscribe((e) => {
        if (e.type === "llm.delta") shown += String((e.payload as { delta?: string }).delta ?? "");
      });
      try {
        const ds = createDeltaStream({
          enabled: true, // ★빼면 NOOP 스트림이 와서 검사가 **아무것도 안 돌린다**(첫 판에 그랬다).
          channel: "cli",
          threadKey: `regr-stream-${chunks.length}`,
          adapter: "claude",
        });
        for (const c of chunks) ds.push(c);
        ds.flush();
        return { shown, segment: ds.closeSegment() ?? "" };
      } finally {
        off();
      }
    };

    const sanity = runStream(["가나다"]);
    out.push(
      assert(
        "★검사가 실제로 스트림을 돌린다(NOOP 스트림으로 빈손 통과하지 않게)",
        sanity.shown === "가나다" && sanity.segment === "가나다",
        `화면=${JSON.stringify(sanity.shown)}`,
      ),
    );
    const r1 = runStream(["답변입니다.", "<next-message>", "그럼 배포하자", "</next-message>"]);
    out.push(
      assert(
        "★[실행] 태그가 화면(llm.delta)·세그먼트 어디에도 안 뜬다",
        !/next.message/i.test(r1.shown) && !/next.message/i.test(r1.segment) &&
          r1.shown === "답변입니다." && r1.segment === "답변입니다.",
        `화면=${JSON.stringify(r1.shown)} 세그=${JSON.stringify(r1.segment)}`,
      ),
    );
    // 청크가 태그 한가운데를 가르는 최악 — 반쪽 태그가 가장 흔한 유출 모양이다.
    const r2 = runStream(["답변입니다.<next-", "mess", "age>그럼 배포하자</next-mes", "sage>"]);
    out.push(
      assert(
        "★[실행] 태그가 여러 청크로 쪼개져 와도 안 샌다",
        !/next.?mess/i.test(r2.shown) && r2.shown === "답변입니다.",
        `화면=${JSON.stringify(r2.shown)}`,
      ),
    );
    // ★P2 — 닫는 태그 뒤의 본문이 살아 있어야 한다(래치면 여기가 통째로 사라진다).
    const r3 = runStream(["앞부분입니다. ", "<next-message>이어서</next-message>", " 뒷부분입니다."]);
    out.push(
      assert(
        "★[실행] 닫는 태그 **뒤**의 본문이 화면에 남는다(억제가 턴 끝까지 안 간다)",
        r3.shown === "앞부분입니다.  뒷부분입니다." && r3.segment === r3.shown,
        `화면=${JSON.stringify(r3.shown)}`,
      ),
    );
    // ★G-6: **닫는** 태그가 청크 경계로 쪼개져도 억제가 풀려야 한다. 기존 r2 는 쪼개기만
    //  보고 "뒤 본문이 남는가" 를 안 물었고, r3 은 해제만 보고 쪼개지 않았다 — 한 케이스로
    //  합치면 잡힌다(재검토가 그 틈으로 변이를 통과시켰다).
    const r6 = runStream(["앞<next-", "message>제안</next-mes", "sage> 뒷부분"]);
    out.push(
      assert(
        "★[실행] 닫는 태그가 쪼개져 와도 억제가 풀리고 뒤 본문이 남는다",
        r6.shown === "앞 뒷부분" && r6.segment === "앞 뒷부분",
        `화면=${JSON.stringify(r6.shown)}`,
      ),
    );
    // ★G-10: 한 청크에 **본문 + 완결 태그**가 같이 오는 경우 — 앞 본문이 소멸하면 안 된다.
    const r7 = runStream(["본문입니다.<next-message>제안</next-message>꼬리입니다."]);
    out.push(
      assert(
        "★[실행] 한 청크에 본문과 완결 태그가 같이 와도 본문이 남는다",
        r7.shown === "본문입니다.꼬리입니다.",
        `화면=${JSON.stringify(r7.shown)}`,
      ),
    );
    // ★반대 방향 — 태그가 아닌 `<` 로 끝나는 정상 텍스트는 한 글자도 안 깎인다.
    // ★스트림이 **보류분으로 끝나는** 경우 — flush 가 확정 안 하면 그대로 사라진다.
    const r5 = runStream(["문장 끝이 <"]);
    out.push(
      assert(
        "★[실행] 보류분으로 끝나도 flush 가 확정해 내보낸다(꼬리 유실 0)",
        r5.shown === "문장 끝이 <" && r5.segment === "문장 끝이 <",
        `화면=${JSON.stringify(r5.shown)} 세그=${JSON.stringify(r5.segment)}`,
      ),
    );
    const r4 = runStream(["수식은 a <", " b 입니다.", "\n코드: <div>"]);
    out.push(
      assert(
        "★[실행] 태그가 아닌 `<` 는 보류됐다가 **반드시** 나온다(꼬리 유실 0)",
        r4.shown === "수식은 a < b 입니다.\n코드: <div>" && r4.segment === r4.shown,
        `화면=${JSON.stringify(r4.shown)}`,
      ),
    );
    // flush 없이 closeSegment 만 부르는 어댑터 경로(도구 경계)에서도 꼬리가 살아야 한다.
    {
      let shown = "";
      const off = bus.subscribe((e) => {
        if (e.type === "llm.delta") shown += String((e.payload as { delta?: string }).delta ?? "");
      });
      const ds = createDeltaStream({ enabled: true, channel: "cli", threadKey: "regr-seg", adapter: "claude" });
      ds.push("끝이 <");
      const seg = ds.closeSegment() ?? "";
      off();
      out.push(
        assert(
          "★[실행] flush 없이 closeSegment 만 불러도 보류분이 살아난다",
          seg === "끝이 <",
          `세그=${JSON.stringify(seg)} (화면=${JSON.stringify(shown)})`,
        ),
      );
    }
    // 순수 상태 함수 — 래치 해제까지 한 번 더 못박는다.
    const st = stepSuggestionStream("<next-message>x</next-message>뒤", false);
    out.push(
      assert(
        "상태 함수가 닫는 태그에서 억제를 푼다",
        st.emit === "뒤" && !st.suppressing,
        JSON.stringify(st),
      ),
    );
  }

  // ── ⑦b 반영이 **반쪽**일 수 없다 (적대 검토 A2) ────────────────────────────
  {
    const o: { text: string; nextSuggestion?: string } = {
      text: "답변입니다.<next-message>다음</next-message>",
    };
    applyInlineSuggestion(o);
    out.push(
      assert(
        "★뜯기와 반영이 한 함수다 — 태그 제거와 제안 적재가 **함께** 일어난다",
        o.text === "답변입니다." && o.nextSuggestion === "다음",
        JSON.stringify(o),
      ),
    );
    const o2: { text: string; nextSuggestion?: string } = { text: "그냥 답변" };
    applyInlineSuggestion(o2);
    out.push(
      assert(
        "표식이 없으면 본문·제안 둘 다 안 건드린다",
        o2.text === "그냥 답변" && o2.nextSuggestion === undefined,
        JSON.stringify(o2),
      ),
    );
  }

  // ── ⑧ ★태그 변종에도 원문이 안 샌다 (적대 검토 P3) ────────────────────────
  {
    const variants = [
      "<next-message >공백</next-message>",
      "<Next-Message>대소문자</Next-Message>",
      "<next_message>언더스코어</next_message>",
    ];
    const leaked = variants.filter((v) => /next.message/i.test(extractInlineSuggestion(v).text));
    out.push(
      assert(
        "★공백·대소문자·언더스코어 변종도 벗겨진다(원문이 사용자에게 안 간다)",
        leaked.length === 0,
        leaked.length === 0 ? `${variants.length}종` : `★잔존: ${leaked.join(" | ")}`,
      ),
      assert(
        "★규칙 본문이 여는·닫는 태그를 **둘 다** 말한다(한쪽만 알려주면 나머지가 샌다)",
        inlineSuggestionRule().includes(NEXT_TAG_OPEN) &&
          inlineSuggestionRule().includes(NEXT_TAG_CLOSE),
        `열기=${inlineSuggestionRule().includes(NEXT_TAG_OPEN)} 닫기=${inlineSuggestionRule().includes(NEXT_TAG_CLOSE)}`,
      ),
      assert(
        "★제안이 null 이어도 태그는 제거된다(빈 태그를 붙여도 화면엔 안 남는다)",
        extractInlineSuggestion("답<next-message></next-message>").suggestion === null &&
          !/next.message/i.test(extractInlineSuggestion("답<next-message></next-message>").text),
        JSON.stringify(extractInlineSuggestion("답<next-message></next-message>")),
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
