import { summarizeInputComposition } from "../../core/llm-runtime/adapters/_codex-input-composition.js";
import type { ResponseInputItem } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "codex-input-composition",
  guards: "입력 구성 진단이 문자열/암호문을 노출하거나 미디어를 중복 합산하고 문자 수를 토큰으로 오인하는 회귀",
  run: async () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,PRIVATE_IMAGE" };
    const file = { type: "input_file", filename: "PRIVATE_FILE", file_data: "PRIVATE_DATA" };
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_TEXT 한글😀" }, image, file] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "PRIVATE_REPLY" }] },
      { type: "function_call", call_id: "PRIVATE_ID", name: "PRIVATE_TOOL", arguments: "PRIVATE_ARGS" },
      { type: "function_call_output", call_id: "PRIVATE_ID", output: "PRIVATE_RESULT" },
      { type: "reasoning", id: "PRIVATE_REASONING", encrypted_content: "PRIVATE_CIPHER", summary: [{ type: "summary_text", text: "PRIVATE_SUMMARY" }] },
    ] as ResponseInputItem[];
    const before = JSON.stringify(input);
    const result = summarizeInputComposition(input);
    const serialized = JSON.stringify(result);
    const empty = summarizeInputComposition([]);
    const changed = summarizeInputComposition([...input, { type: "function_call_output", call_id: "another", output: "longer output" }]);
    return [
      assert("요청 JSON의 UTF-16 문자 수와 일치", result.chars === before.length && result.unit === "utf16-json-chars", result),
      assert("항목 수와 분류별 합계 보존", result.items === 5 && Object.values(result.buckets).reduce((n,b) => n+b.chars,0)+6 === result.chars, result),
      assert("메시지/호출/결과/추론을 각각 구분", [result.buckets.user,result.buckets.assistant,result.buckets.functionCall,result.buckets.toolOutput,result.buckets.reasoning].every(b => b.count === 1 && b.chars > 0), result),
      assert("미디어는 메시지에 포함된 별도 부분 수치", result.media.images === 1 && result.media.files === 1 && result.media.chars === JSON.stringify(image).length+JSON.stringify(file).length && result.buckets.user.chars > result.media.chars, result),
      assert("원문·식별자·암호문 유출 없음", !serialized.includes("PRIVATE_") && serialized.length < 1000, result),
      assert("진단이 입력을 변경하지 않음", before === JSON.stringify(input), { unchanged: before === JSON.stringify(input) }),
      assert("빈 배열은 직렬화 괄호 2자, 항목/미디어 0", empty.chars === 2 && empty.items === 0 && empty.media.images === 0, empty),
      assert("후속 도구 결과가 해당 분류에만 증가", changed.buckets.toolOutput.count === 2 && changed.buckets.user.chars === result.buckets.user.chars && changed.chars > result.chars, changed),
    ];
  },
};
