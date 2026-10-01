/**
 * 회귀: **Codex 웹 검색 인용 표식이 화면·텔레그램·기록에 남지 않는다** (2026-10-01 — 회사돌쇠 실사용 신고).
 *
 * 사고: 웹 검색을 쓴 Codex 답 끝에 `. citeturn0search1turn0search6` 가 붙어 나갔다. 백엔드가 출처 자리를 사설 영역 문자
 *  `U+E200 cite U+E202 turn0search… U+E201` 로 끼우는데, 제어 문자는 안 보이고 글자만 남는다. 실험에서도 116회 중 1회 재현.
 * 지키는 것: 출처 표식은 덩어리째(앞 공백까지) 지운다 · 다른 종류는 본문을 지우지 않고 제어 문자만 뺀다 · 표식 없는 글은
 *  그대로 · **실시간 조각**(llm.delta)에서도 조각 경계를 넘어 갈라진 표식이 새지 않는다 · 끝까지 안 닫힌 출처 표식도 ·
 *  **최종 답·기록**(runRegionA)에서도.
 */
import { releaseCitationHold, stepCitationStream, stripCitationMarkers } from "../../core/citation-markers.js";
import { createDeltaStream } from "../../core/llm-runtime/adapters/_delta-stream.js";
import { getEventBus } from "../../core/eventbus.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const O = "\uE200", S = "\uE202", C = "\uE201";

export const check: RegressionCheck = {
  name: "citation-markers-stripped",
  guards: "Codex 웹 검색 인용 표식(U+E200 cite …)이 답 끝에 «citeturn0search1turn0search6» 로 남아 화면·텔레그램·기록에 나가던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // 실제 로그의 꼬리(회사돌쇠 10-01) 모양 그대로.
    const real = `이어가겠습니다. ${O}cite${S}turn0search0${C}`;
    const multi = `확인했습니다. ${O}cite${S}turn0search1${S}turn0search6${C} 다음 문장.`;
    const other = `${O}entity${S}["company","오픈AI"]${C} 소식`;
    const plain = "표식 없는 글 — 그대로 둔다. <b>태그</b>도.";
    const bad = (t: string): boolean => /[\uE200-\uE202]|citeturn|turn0search/.test(t);
    out.push(assert("★출처 표식은 덩어리째 지운다 — 끝에 붙은 건 앞 공백까지, 중간 것은 뒤 공백까지(실제 로그 · 여러 출처)",
      stripCitationMarkers(real) === "이어가겠습니다." && stripCitationMarkers(multi) === "확인했습니다. 다음 문장.",
      { real: stripCitationMarkers(real), multi: stripCitationMarkers(multi) }));
    out.push(assert("다른 종류는 본문을 지우지 않고 보이지 않는 제어 문자만 뺀다 · 표식 없는 글은 같은 문자열",
      stripCitationMarkers(other).includes("오픈AI") && !/[\uE200-\uE202]/.test(stripCitationMarkers(other)) && stripCitationMarkers(plain) === plain,
      stripCitationMarkers(other)));
    out.push(assert("조각 판정: 안 닫힌 표식은 붙들고 · 끝까지 안 닫힌 출처 표식은 버린다",
      JSON.stringify(stepCitationStream(`다. ${O}ci`)) === JSON.stringify({ emit: "다. ", hold: `${O}ci`, eatSpace: false }) && releaseCitationHold(`${O}cite${S}turn0`) === "",
      stepCitationStream(`다. ${O}ci`)));

    // ★실시간 조각 — 실제 스트림을 돌려 발행된 llm.delta 전문을 본다(조각 경계에서 표식이 갈라져 와도).
    const bus = getEventBus();
    // end: 턴 끝 처리 순서 — "segment" = closeSegment 만(도구 경계) · "flush" = flush 만(스트림 종료).
    const runStream = (chunks: string[], end: "segment" | "flush" = "segment"): { shown: string; segment: string } => {
      let shown = "";
      const off = bus.subscribe((e) => { if (e.type === "llm.delta") shown += String((e.payload as { delta?: string }).delta ?? ""); });
      try {
        const ds = createDeltaStream({ enabled: true, channel: "cli", threadKey: `regr-cite-${chunks.length}-${end}`, adapter: "codex" });
        for (const c of chunks) ds.push(c);
        let segment = "";
        if (end === "segment") { segment = ds.closeSegment() ?? ""; ds.flush(); } else { ds.flush(); segment = ds.closeSegment() ?? ""; }
        return { shown, segment };
      } finally { off(); }
    };
    const perChar = (t: string): string[] => Array.from(t);
    const split = runStream(["확인했습니다. ", `${O}ci`, `te${S}turn0sea`, `rch1${S}turn0search6${C}`, " 다음 문장."]);
    const tail = runStream(["끝입니다.", ` ${O}cite${S}turn0search`]); // 끝까지 안 닫힘
    const sanity = runStream(["가나다"]);
    out.push(assert("★[실행] 실시간 화면(llm.delta)·세그먼트: 갈라져 온 표식도 새지 않고 본문은 그대로 · 끝까지 안 닫힌 것도",
      sanity.shown === "가나다" && split.shown === "확인했습니다. 다음 문장." && split.segment === split.shown && !bad(tail.shown) && tail.shown.trimEnd() === "끝입니다.",
      { split, tail }));

    // ★안 닫힌 표식(스트림 중단·출력 상한) — 표식 글자만 지우고 **뒤 본문은 살린다** · 스트림과 최종본이 같은 글(적대 검토 P2).
    const unclosed = `확인했습니다 ${O}cite${S}turn0search1 그리고 다음 문장도 중요합니다.`;
    const uStream = runStream(perChar(unclosed));
    const uFinal = stripCitationMarkers(unclosed);
    // 출처 25개 묶음(수백 자) — 상한에 걸려 새지 않는다 · 인접한 두 표식 · 끝 처리(도구 경계 / 스트림 종료) 각각에서 붙든 것을 놓는다.
    const many = `결과 ${O}cite${Array.from({ length: 25 }, (_, i) => `${S}turn0search${i}`).join("")}${C} 다음.`;
    const mStream = runStream(perChar(many));
    const adjacent = runStream(["A ", `${O}cite${S}t1${C}`, ` B ${O}ci`, `te${S}t2${C} 끝.`]);
    const segEnd = runStream(["끝 ", `${O}cite${S}turn0`], "segment");
    const flushEnd = runStream(["본문 ", `${O}cite${S}t`], "flush");
    // 다른 종류를 붙들었다가 놓을 때 — 글자는 살리고 제어 문자만 뺀다(도구 경계·종료 각각에서 **그 자리에서** 놓는다).
    const otherSeg = runStream(["목록 ", `${O}navlist`], "segment");
    const otherFlush = runStream(["목록 ", `${O}navlist`], "flush");
    // 닫힌 표식과 안 닫힌 꼬리가 한 조각에 같이 — 꼬리를 붙들 때 앞부분의 닫힌 표식도 걷는다.
    const oneChunk = runStream([`A ${O}cite${S}t1${C} B ${O}ci`, `te${S}t2${C} 끝.`]);
    out.push(assert("★[실행] 안 닫힌 표식: 뒤 본문을 살리고 스트림·최종본이 같다 · 출처 25개 묶음도 안 샌다 · 인접 표식 · 도구 경계·종료 각각 놓는다",
      uStream.shown === "확인했습니다 그리고 다음 문장도 중요합니다." && uFinal === uStream.shown &&
        !bad(mStream.shown) && mStream.shown === "결과 다음." && adjacent.shown === "A B 끝." &&
        segEnd.segment.trimEnd() === "끝" && !bad(segEnd.segment) && flushEnd.shown.trimEnd() === "본문" && !bad(flushEnd.shown) &&
        otherSeg.segment === "목록 navlist" && otherFlush.shown === "목록 navlist" && oneChunk.shown === "A B 끝.",
      { uStream: uStream.shown, uFinal, many: mStream.shown.slice(0, 40), adjacent: adjacent.shown, segEnd, flushEnd, otherSeg: otherSeg.segment, otherFlush: otherFlush.shown, oneChunk: oneChunk.shown }));

    // ★최종 답·기록 — 시험용 어댑터로 실제 runRegionA 를 돌린다(세 어댑터 공통 자리).
    const { initStore, getDb } = await import("../../store/sessions.js");
    initStore();
    const RT = await import("../../core/llm-runtime/index.js");
    const sid = `s-cite-${Date.now()}`;
    // 제안 태그 안에도 표식이 섞여 올 수 있다 — 걷기가 제안 추출보다 **앞**이어야 제안에도 안 남는다(순서).
    const undo = RT.__setAdapterForTest(async () => ({ text: `${real}\n<next-message>출처 ${O}cite${S}turn0search2${C} 보여줘</next-message>`, sessionId: sid }));
    let finalText = "", finalSug = "";
    try {
      const o = await RT.runRegionA({ channel: "http-bridge", threadKey: `regr:cite:${sid}`, text: "검색해줘" } as never, { specs: [{ adapter: "codex-oauth", model: "gpt-6-sol" } as never] });
      finalText = o.text; finalSug = String((o as { nextSuggestion?: string }).nextSuggestion ?? "");
    } finally { undo(); }
    const stored = (getDb().prepare(`SELECT content FROM transcripts WHERE claude_session_id = ? AND role = 'assistant'`).get(sid) as { content?: string } | undefined)?.content ?? "";
    out.push(assert("★[실행] 최종 답(화면·텔레그램)·제안·모델이 읽는 기록에 표식이 없다",
      finalText === "이어가겠습니다." && !bad(stored) && stored.startsWith("이어가겠습니다.") && finalSug === "출처 보여줘", { finalText, stored, finalSug }));
    return out;
  },
};
