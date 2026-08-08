/**
 * 회귀: **과거 턴의 본문은 정본(chat_log)에서 온다** — ★행동 게이트 (2026-08-08).
 *
 * 사용자 신고: 12,650자 답변이 대시보드에서 300자쯤에서 끊겨 보였고 **새로고침해도 같았다**.
 *
 * 원인은 이력 병합의 **중복 제거가 잘린 쪽을 남긴 것**이었다. 대시보드는 과거 턴을
 *  ①`llm.activity kind:"text"` 세그먼트(도구와의 인터리브 **위치**)
 *  ②`chat_log` 항목(대화 **정본**)
 * 둘로 재구성하는데, 세그먼트를 그린 뒤 뒤따르는 assistant 정본을 "중복" 으로 **버렸다**.
 * 그런데 세그먼트는 `events` 에 있고 그 테이블엔 페이로드 상한이 있어 **긴 답변이 잘린 채**
 * 저장된다(실측: 12,650자 → 301자). 즉 **잘린 사본을 남기고 무손실 정본을 버렸다.**
 *
 * 고침은 역할을 나눈 것이다 — 세그먼트는 **위치**, 정본은 **내용**. 판정은 "세그먼트가 정본의
 * 앞부분인가"다. 한 턴에 세그먼트가 여럿이면(도구와 교차) 뒤쪽 것은 정본의 *뒷부분*이라
 * 안 걸린다 — 그래야 앞 세그먼트 내용이 **중복 렌더되지 않는다**.
 *
 * ★이 검사는 그 판정을 **실제로 실행한다**. 대시보드 js 는 모듈이 아니라 평범한 스크립트라
 *  import 가 안 되므로, 파일에서 함수 본문을 뽑아 `new Function` 으로 만들어 호출한다.
 *  소스에 문자열이 있는지 보는 것과 **동작을 보는 것**은 다르다(오늘 그 차이로 세 번 데였다).
 */
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "history-canonical-body",
  guards:
    "과거 턴 본문이 잘린 세그먼트가 아니라 chat_log 정본에서 온다 — 새로고침해도 잘려 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(
      new URL("../../../packages/dashboard/js/history-render.js", import.meta.url),
      "utf8",
    );
    // 판정 함수 본문만 추출 — 파일 전체는 브라우저 전역(document 등)에 의존해 실행 불가.
    const m = /const canonicalBodyFor = \(segText, entryText\) => \{([\s\S]*?)\n      \};/.exec(src);
    const fn =
      m === null
        ? null
        : (new Function("segText", "entryText", m[1]!) as (
            a: unknown,
            b: unknown,
          ) => string | null);

    const seg300 = "가".repeat(300) + "…";
    const full = "가".repeat(300) + "나".repeat(12_000);

    // ★판정만 보면 **호출부를 지워도 통과한다**(변이로 확인 — 오늘 세 번째로 같은 실수).
    //  그래서 병합 함수(`groupMergedItems`)를 통째로 돌려 **배선**까지 본다.
    const gm = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(src);
    const hp = /const canonicalBodyFor = \([\s\S]*?\n {6}\};/.exec(src);
    type Unit = { kind: string; act?: { text?: string } };
    const ctx: { group?: (e: unknown[], a: unknown[]) => Unit[] } = {};
    if (gm !== null && hp !== null) {
      vm.createContext(ctx);
      vm.runInContext(
        `const renderedMsgKeys = new Set();
         const msgKey = (ts, role) => ts + "|" + role;
         ${hp[0]}
         ${gm[0]}
         this.group = groupMergedItems;`,
        ctx,
      );
    }
    const TK = "dashboard:default";
    const units =
      ctx.group === undefined
        ? []
        : ctx.group(
            [{ ts: 200, role: "assistant", threadKey: TK, text: full }],
            [{ ts: 100, threadKey: TK, kind: "text", seq: 0, text: seg300 }],
          );
    const textUnit = units.find((u) => u.kind === "text");

    return [
      assert(
        "판정 함수를 실제로 뽑아 실행했다(문자열 검사 아님)",
        fn !== null,
        fn === null ? "★추출 실패 — 함수 이름/형태가 바뀌었나" : "추출·실행 OK",
      ),
      assert(
        "★잘린 세그먼트 자리에 **정본 전문**이 올라온다(사고 재현 크기)",
        fn !== null && fn(seg300, full) === full,
        fn === null ? "-" : `결과 ${String(fn(seg300, full) ?? "null").length}자`,
      ),
      assert(
        "★도구와 교차된 **뒤쪽 세그먼트**는 올리지 않는다(앞 세그먼트 중복 렌더 방지)",
        // 뒤쪽 세그먼트는 정본의 *뒷부분*이라 startsWith 에 안 걸린다.
        fn !== null && fn("뒷부분 텍스트", "앞부분 텍스트\n\n뒷부분 텍스트") === null,
        fn === null ? "-" : String(fn("뒷부분 텍스트", "앞부분 텍스트\n\n뒷부분 텍스트")),
      ),
      assert(
        "★**병합이 실제로** 정본을 올린다(판정만 맞고 호출부가 빠지는 것을 잡는다)",
        textUnit !== undefined && textUnit.act?.text === full,
        textUnit === undefined
          ? "★텍스트 유닛 없음"
          : `${String(textUnit.act?.text ?? "").length}자`,
      ),
      assert(
        "안 잘린 세그먼트는 그대로 둔다(불필요한 교체 0)",
        fn !== null && fn("짧은 답변", "짧은 답변") === null,
        fn === null ? "-" : String(fn("짧은 답변", "짧은 답변")),
      ),
      assert(
        "빈 값·비문자열에 안전하다(정본이 없거나 형태가 다를 때)",
        fn !== null &&
          fn("", "무엇") === null &&
          fn("무엇", "") === null &&
          fn("무엇", undefined) === null,
        "가드 OK",
      ),
    ];
  },
};
