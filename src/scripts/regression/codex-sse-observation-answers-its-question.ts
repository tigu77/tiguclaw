/**
 * 회귀: **codex SSE 관측이 자기가 묻는 질문에 답할 수 있다** (2026-09-16)
 *
 * 잡는 것: *"codex 는 진행 중에 말을 안 한다"* 를 근거 없이 결론낼 뻔한 것.
 *
 * ★배경. 실측에서 codex 는 모델 호출 35회 중 **1회**만 텍스트 세그먼트를 냈다(claude 는
 *  1,847회 중 420회). 그런데 그 수로는 두 가설을 못 가른다:
 *
 *      (a) 모델이 도구 옆에서 말을 안 한다
 *      (b) 말하는데 **우리가 안 듣는다** — 파서가 다루는 이벤트는 일곱뿐이고
 *          `response.reasoning_summary_text.delta` 는 그 목록에 **없다**
 *
 *  둘을 가르는 재료는 «어떤 이벤트가 실제로 왔나» 인데, 그건 `eventCounts` 로 이미 세고
 *  있으면서 **`response.completed` 없이 끝난 스트림에서만** 읽었다 — 즉 **정상 턴 표본이
 *  0** 이었다. `sseEndTally` 가 *"성공 턴 표본이 0 이라 답을 모른다"* 며 만들어진 것과
 *  똑같은 모양의 구멍이다([[feedback_pruned_table_absence]] 의 «부재 ≠ 0건»).
 *
 * ★세 번째 질문도 같은 처지였다. 2026-07-13 실현가능성 감사는 «한 iteration 안에서 도구
 *  뒤에 텍스트가 이어지면 순서가 뒤집힌다» 는 degrade 를 적으면서 *"실측상 거의 발생하지
 *  않는 패턴"* 이라고 **추정으로** 닫았다. 아무도 센 적이 없다. 고치는 비용(재시도 중복
 *  발행 처리)을 치르기 전에 값어치부터 재야 한다([[feedback_verify_before_asserting]]).
 *
 * ★그래서 이 검사는 **관측이 도는지**를 본다 — 수치가 얼마인지가 아니라.
 *  ①`textCharsAfterToolCall` 이 순서를 실제로 가르는가(도구 앞 텍스트는 안 세고 뒤만 센다)
 *  ②`eventCounts` 가 **정상 종료에도** 채워지는가(여기가 죽어 있던 자리다)
 *  ③턴 종료 로그가 그 둘을 **싣는가**(재고도 안 실으면 원격 기계에선 없는 것과 같다 —
 *   회사돌쇠는 원격 접속이 안 된다, [[feedback_logs_must_stand_alone]])
 *
 * 등급: **동작 검사** — 합성 SSE 를 진짜 파서에 흘린다. 네트워크·LLM 0.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import {
  parseCodexSse,
  newSseObservation,
  mergeSseObservation,
  parseCodexSseObserved,
  type CodexSseResult,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

const sse = (events: readonly unknown[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
};
const TEXT = (d: string): unknown => ({ type: "response.output_text.delta", delta: d });
const TOOL = (name: string): unknown => ({
  type: "response.output_item.added",
  item: { type: "function_call", id: "i1", call_id: "c1", name, arguments: "" },
});
const COMPLETED: unknown = { type: "response.completed", response: { id: "r1" } };

export const check: RegressionCheck = {
  name: "codex-sse-observation-answers-its-question",
  guards:
    "codex 가 도구 옆에서 말을 하는지·추론 채널로 말하는지·도구 뒤에 텍스트가 오는지를 아무도 세지 않아, 추정으로 «모델이 말을 안 한다» 라고 결론낼 뻔한 것",
  run: async (): Promise<Assertion[]> => {
    const run = (evs: readonly unknown[]): Promise<CodexSseResult> =>
      parseCodexSse(sse(evs));

    const before = await run([TEXT("말A"), TOOL("Bash"), COMPLETED]);
    const after = await run([TEXT("말A"), TOOL("Bash"), TEXT("말B다"), COMPLETED]);
    const noTool = await run([TEXT("말A"), TEXT("말B"), COMPLETED]);

    // ★증거란에 **관측**을 싣는다 — 기대값("…를 기대")만 적으면 빨간불을 봐도 무엇이
    //  관측됐는지 모른다(`suite-selfcheck` 가 그 부류를 센다). 그래서 값을 먼저 만들고
    //  단언과 증거가 **같은 값**을 보게 한다.
    const twice = (() => {
      const acc = newSseObservation();
      mergeSseObservation(acc, { eventCounts: { a: 1 }, textCharsAfterToolCall: 5 });
      mergeSseObservation(acc, { eventCounts: { a: 2, b: 1 }, textCharsAfterToolCall: 7 });
      return { acc };
    })();
    const emptyMerge = (() => {
      const acc = newSseObservation();
      mergeSseObservation(acc, {});
      mergeSseObservation(acc, { eventCounts: { a: 1 }, textCharsAfterToolCall: 0 });
      return acc;
    })();
    const unknownEv = await run([
      { type: "response.reasoning_summary_text.delta", delta: "생각" },
      COMPLETED,
    ]);
    const joined = await (async () => {
      const acc = newSseObservation();
      const r = await parseCodexSseObserved(
        acc,
        sse([TEXT("가나"), TOOL("Bash"), TEXT("다라"), COMPLETED]),
      );
      return { acc, r };
    })();
    const noText = await (async () => {
      const acc = newSseObservation();
      const r = await parseCodexSseObserved(
        acc,
        sse([{ type: "response.reasoning_summary_text.delta", delta: "생각" }, COMPLETED]),
      );
      return { acc, r };
    })();

    const out: Assertion[] = [
      assert(
        "★«도구 뒤 텍스트» 만 센다 — 도구 앞 텍스트를 같이 세면 이 수는 아무 말도 못 한다",
        before.textCharsAfterToolCall === 0 && after.textCharsAfterToolCall === 3,
        `앞만(말A→도구)=${String(before.textCharsAfterToolCall)}자 · 뒤도(말A→도구→말B다)=${String(after.textCharsAfterToolCall)}자`,
      ),
      assert(
        "도구가 없으면 0 — 기준점이 없는데 세지 않는다",
        noTool.textCharsAfterToolCall === 0,
        `도구 없는 스트림=${String(noTool.textCharsAfterToolCall)}자 (텍스트는 ${noTool.text.length}자 왔다)`,
      ),
      assert(
        "★`eventCounts` 가 **정상 종료에도** 채워진다 — 여기가 비어 있어 성공 턴 표본이 0이었다",
        Object.keys(after.eventCounts ?? {}).length >= 3 &&
          (after.eventCounts ?? {})["response.output_text.delta"] === 2 &&
          (after.eventCounts ?? {})["response.completed"] === 1,
        `정상 종료 히스토그램=${JSON.stringify(after.eventCounts)}`,
      ),
      assert(
        "★낯선 이벤트도 **이름 그대로** 남는다 — 모르는 것을 세는 게 이 관측의 목적이다",
        // 파서가 «아는 일곱» 만 세면 reasoning 채널은 영영 안 보인다. 목록이 아니라
        // 오는 것을 전부 센다는 성질을 고정한다.
        unknownEv.eventCounts?.["response.reasoning_summary_text.delta"] === 1,
        `미지 이벤트 히스토그램: ${JSON.stringify(unknownEv.eventCounts)}`,
      ),
    ];

    // ── 재고도 안 실으면 원격 기계에선 없는 것과 같다 ───────────────────────────
    const adapter = await readFile(
      new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url),
      "utf8",
    );
    out.push(
      assert(
        "★턴 종료 줄이 그 둘을 **싣는다** — 회사돌쇠는 원격 접속이 안 되고 로그가 유일한 진단면이다",
        /sseEv=\$\{/.test(adapter) && /도구뒤텍스트=\$\{sseObs\.textAfterToolChars\}/.test(adapter),
        `이벤트 히스토그램 ${/sseEv=\$\{/.test(adapter)} · 순서 계수 ${/도구뒤텍스트=\$\{sseObs\.textAfterToolChars\}/.test(adapter)}`,
      ),
      assert(
        "★합산기가 **스트림이 어떻게 끝났는지를 못 본다** — 조건을 달 재료가 인자에 없다",
        // ★소스 정규식으로 «조건 안이 아님» 을 보려다 변이가 셋 연속 뚫었다(블록 감싸기 →
        //  한 줄 조건 → 삼항). 정규식을 넓히는 건 «목록 수정» 이라 또 뚫린다. 그래서 판단을
        //  순수 함수로 빼고 **실행해서** 잰다 — `mergeSseObservation` 은 `eventCounts` 와
        //  `textCharsAfterToolCall` 만 받으므로, 어떻게 끝났는지로 가르는 편집이 이 함수
        //  안에서는 **쓸 수가 없다**.
        twice.acc.events.get("a") === 3 &&
          twice.acc.events.get("b") === 1 &&
          twice.acc.textAfterToolChars === 12,
        `두 번 합산 결과: ${JSON.stringify(Object.fromEntries(twice.acc.events))} · 글자=${twice.acc.textAfterToolChars}`,
      ),
      assert(
        "빈 결과도 **삼키지 않고** 합산에 참여한다 — 0 도 표본이다",
        emptyMerge.events.get("a") === 1 && emptyMerge.textAfterToolChars === 0,
        `필드없음+0 합산 결과: a=${String(emptyMerge.events.get("a"))} · 글자=${emptyMerge.textAfterToolChars}`,
      ),
      assert(
        "★**파싱하면 반드시 합산된다** — 둘이 한 함수라 합산만 건너뛸 수가 없다",
        // ★이게 이 검사의 핵심이다. 종전엔 `parse(...)` 뒤에 `merge(...)` 가 나란히 있었고,
        //  그 **이음매**로 변이 셋이 들어왔다(블록·한 줄 조건·삼항). 소스 정규식을 넓히는
        //  건 «목록 수정» 이라 또 뚫린다 — 이음매를 없애고 **실행으로** 잰다.
        joined.r.text === "가나다라" && // 파싱 결과는 그대로 나오고
          joined.acc.textAfterToolChars === 2 && // 관측도 같이 채워진다
          joined.acc.events.get("response.output_text.delta") === 2,
        `합본 1회: text="${joined.r.text}" · 도구뒤=${joined.acc.textAfterToolChars}자 · 히스토그램=${JSON.stringify(Object.fromEntries(joined.acc.events))}`,
      ),
      assert(
        "★**텍스트가 없어도 합산된다** — 텍스트가 안 오는 것이 바로 우리가 세려는 현상이다",
        // ★자기 변이에서 적발(M7): 합본 안에 `if (result.text !== "")` 를 달아도 통과했다.
        //  내 표본이 전부 «텍스트가 있는 스트림» 이었기 때문이다. 그런데 이 관측이 답하려는
        //  질문은 정확히 «텍스트가 안 오는데 그럼 무엇이 오나» 다 — 그 스트림에서 합산이
        //  죽으면 관측은 **자기 질문에 답할 수 없다.**
        noText.r.text === "" &&
          noText.acc.events.get("response.reasoning_summary_text.delta") === 1,
        `추론만 온 스트림: text=${noText.r.text.length}자 · 히스토그램=${JSON.stringify(Object.fromEntries(noText.acc.events))}`,
      ),
      assert(
        "★어댑터가 그 한 몸을 **부른다**(다시 갈라 놓지 않는다)",
        /parseCodexSseObserved\(/.test(adapter) &&
          // 갈라 놓으면 권위가 둘이 되고 이음매가 다시 생긴다.
          !/await parseCodexSse\(/.test(adapter) &&
          !/mergeSseObservation\(/.test(adapter),
        `합본 호출 ${/parseCodexSseObserved\(/.test(adapter)} · 원시 파서 직접호출 ${/await parseCodexSse\(/.test(adapter)} · 별도 merge ${/mergeSseObservation\(/.test(adapter)}`,
      ),
    );
    return out;
  },
};
