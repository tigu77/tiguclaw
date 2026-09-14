/** 실제 어댑터 결과 적재 구간을 실행해 첫 전송 전에 새 출력이 사라지는 결함을 검사한다. */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { capToolOutputForEntry, compactOldToolOutputs } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-fresh-tool-output",
  guards: "병렬 도구 결과를 모델에 한 번도 전달하기 전에 최근 3개 밖의 본문을 압축하던 것",
  run: async (): Promise<Assertion[]> => {
    const source = readFileSync(new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url), "utf8");
    const c2 = source.indexOf("      // C2 (compaction, architect §C2)");
    const start = source.lastIndexOf("      );", c2) + "      );".length;
    const end = source.indexOf("      iteration += 1;", c2);
    if (c2 < 0 || start < 8 || end < start) throw new Error("Codex 결과 적재 구간을 찾지 못함");
    // 결과 변환·미디어 연결·압축의 실제 순서를 함께 실행한다. 별도 모형으로 순서를 복제하지 않는다.
    const body = ts.transpileModule(`let turnCompacted = 0;\n${source.slice(start, end)}\nreturn turnCompacted;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const apply = new Function("inputArray", "toolOutputs", "capToolOutputForEntry", "compactOldToolOutputs", body);
    const input: any[] = [];
    const batch = (prefix: string, count: number, size = 3000) => Array.from({ length: count }, (_, i) => ({
      callId: `${prefix}-${i}`, output: `${prefix}-${i}\n${"x".repeat(size)}`, media: [] as unknown[],
    }));
    const push = (outputs: ReturnType<typeof batch>): number => {
      input.push(...outputs.map(o => ({ type: "function_call", call_id: o.callId, name: "Read", arguments: "{}" })));
      return apply(input, outputs, capToolOutputForEntry, compactOldToolOutputs);
    };
    const outputs = () => input.filter(i => i.type === "function_call_output");
    const first = batch("first", 5);
    const count = push(first);
    const assertions = [assert("첫 병렬 결과 5개가 모두 첫 요청에 전달됨", count === 0 && outputs().every((o, i) => o.output === first[i]!.output), outputs().map(o => o.output.length))];
    const second = batch("second", 4);
    const oldCount = push(second);
    assertions.push(assert("이미 전달한 오래된 결과는 계속 압축", oldCount === 2 && outputs()[0].output !== first[0]!.output, oldCount));
    assertions.push(assert("다음 배치 4개도 모두 보존", outputs().slice(-4).every((o, i) => o.output === second[i]!.output), outputs().slice(-4).map(o => o.output.length)));
    const big = batch("big", 1, 50000);
    big[0]!.media.push({ type: "input_image", image_url: "data:image/png;base64,AA==" });
    push(big);
    assertions.push(assert("단일 출력 진입 cap은 유지", outputs().at(-1).output === capToolOutputForEntry(big[0]!.output) && outputs().at(-1).output.length < 16500, outputs().at(-1).output.length));
    assertions.push(assert("도구 이미지 연결 유지", input.at(-1).role === "user" && input.at(-1).content[0].type === "input_image", input.at(-1)));
    for (let i = 0; i < 30; i++) push(batch(`long-${i}`, 5, 50000));
    assertions.push(assert("긴 루프에서도 과거 본문 누적은 제한", outputs().reduce((n, o) => n + o.output.length, 0) < 150000, outputs().reduce((n, o) => n + o.output.length, 0)));
    const calls = input.filter(i => i.type === "function_call").map(i => i.call_id);
    assertions.push(assert("호출·응답 ID 대응 보존", calls.length === outputs().length && outputs().every((o, i) => o.call_id === calls[i]), calls.length));
    return assertions;
  },
};
