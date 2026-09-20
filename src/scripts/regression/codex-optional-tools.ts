import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "codex-optional-tools",
  guards: "Responses의 자동 strict 변환이 선택 필드를 필수화해 look에 1×1 영역·빈 frameId를 강제 생성하던 실제 사고",
  run: async () => {
    const r = await spawnWithin(30_000, "Codex 도구 요청 캡처", ["--import", "tsx", fileURLToPath(new URL("./_codex-optional-tools-child.ts", import.meta.url))]);
    const line = r.out.split(/\r?\n/).find(l => l.startsWith("OPTIONAL_RESULT "));
    const v = line === undefined ? {} : JSON.parse(line.slice("OPTIONAL_RESULT ".length)) as Record<string, unknown>;
    return [
      assert("실제 어댑터 요청의 MCP 함수는 optional 계약을 보존한다", !r.timedOut && v.internalStrictFalse === true, line ?? r.err.slice(-1500)),
      assert("외부 앱 함수도 같은 optional 계약을 보존한다", v.externalStrictFalse === true, v),
      assert("외부 JSON Schema의 required와 중첩 선택 필드를 바꾸지 않는다", v.schemaPreserved === true, v),
    ];
  },
};
