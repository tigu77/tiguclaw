/**
 * 실제 어댑터 결과 적재 함수를 **실행해** 첫 전송 전에 새 출력이 사라지는 결함을 검사한다.
 *
 * ★종전엔 어댑터 소스에서 «C2 주석 ~ iteration += 1» 구간을 **문자열로 잘라 transpile** 해서
 *  돌렸다. 의도는 옳았다(별도 모형으로 순서를 복제하지 않는다). 하지만 그 구간이 함수로
 *  빠지자 앵커가 사라져 검사가 통째로 던졌다 — **검사가 리팩터를 막는 자리**였다.
 *  지금은 제품이 쓰는 `appendToolResultsToInput` 을 **그대로 부른다**: 모형도 없고 소스
 *  슬라이싱도 없다(지키려는 성질은 «그 모듈이 그렇게 한다» 이지 «그 파일 안에 그렇게
 *  적혀 있다» 가 아니다).
 */
import {
  appendToolResultsToInput,
  capToolOutputForEntry,
  isToolMediaMessage,
  type ResponseInputItem,
  type ResponseMediaItem,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type ToolResult = { callId: string; output: string; media: ResponseMediaItem[] };

export const check: RegressionCheck = {
  name: "codex-fresh-tool-output",
  guards: "병렬 도구 결과를 모델에 한 번도 전달하기 전에 최근 3개 밖의 본문을 압축하던 것",
  run: async (): Promise<Assertion[]> => {
    const input: ResponseInputItem[] = [];
    const batch = (prefix: string, count: number, size = 3000): ToolResult[] =>
      Array.from({ length: count }, (_, i) => ({
        callId: `${prefix}-${i}`,
        output: `${prefix}-${i}\n${"x".repeat(size)}`,
        media: [],
      }));
    const push = (outputs: ToolResult[]): number => {
      input.push(
        ...outputs.map(
          (o) =>
            ({
              type: "function_call",
              call_id: o.callId,
              name: "Read",
              arguments: "{}",
            }) as ResponseInputItem,
        ),
      );
      return appendToolResultsToInput(input, outputs);
    };
    const outputs = (): { call_id: string; output: string }[] =>
      input.filter(
        (i): i is Extract<ResponseInputItem, { type: "function_call_output" }> =>
          i.type === "function_call_output",
      );

    const first = batch("first", 5);
    const count = push(first);
    const assertions = [
      assert(
        "첫 병렬 결과 5개가 모두 첫 요청에 전달됨",
        count === 0 && outputs().every((o, i) => o.output === first[i]?.output),
        outputs().map((o) => o.output.length),
      ),
    ];
    const second = batch("second", 4);
    const oldCount = push(second);
    assertions.push(
      assert(
        "이미 전달한 오래된 결과는 계속 압축",
        oldCount === 2 && outputs()[0]?.output !== first[0]?.output,
        oldCount,
      ),
    );
    assertions.push(
      assert(
        "다음 배치 4개도 모두 보존",
        outputs()
          .slice(-4)
          .every((o, i) => o.output === second[i]?.output),
        outputs()
          .slice(-4)
          .map((o) => o.output.length),
      ),
    );
    const big = batch("big", 1, 50_000);
    big[0]?.media.push({ type: "input_image", image_url: "data:image/png;base64,AA==" });
    push(big);
    const last = outputs().at(-1);
    assertions.push(
      assert(
        "단일 출력 진입 cap은 유지",
        last?.output === capToolOutputForEntry(big[0]?.output ?? "") &&
          (last?.output.length ?? 0) < 16_500,
        last?.output.length,
      ),
    );
    const tail = input.at(-1);
    assertions.push(
      assert(
        "도구 이미지 연결 유지",
        // ★«묶음인가» 는 제품 함수가 판정한다 — 여기 규칙을 또 적으면 갈린다(2026-09-21).
        //  종전엔 `content[0] === input_image` 였는데, 라벨 한 줄이 앞에 붙자 빨개졌다.
        //  이 검사가 지키려는 것은 «자리» 가 아니라 «그림이 실려 왔는가» 다.
        isToolMediaMessage(tail) &&
          tail?.type === "message" &&
          tail.content.some((c) => c.type === "input_image"),
        tail,
      ),
    );
    for (let i = 0; i < 30; i++) push(batch(`long-${i}`, 5, 50_000));
    const totalChars = outputs().reduce((n, o) => n + o.output.length, 0);
    assertions.push(
      assert("긴 루프에서도 과거 본문 누적은 제한", totalChars < 150_000, totalChars),
    );
    const calls = input
      .filter((i) => i.type === "function_call")
      .map((i) => (i as { call_id: string }).call_id);
    assertions.push(
      assert(
        "호출·응답 ID 대응 보존",
        calls.length === outputs().length &&
          outputs().every((o, i) => o.call_id === calls[i]),
        calls.length,
      ),
    );
    return assertions;
  },
};
