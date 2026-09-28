/**
 * 회귀: **claude `ToolSearch` 카드에 불러온 도구가 보인다** (2026-09-28 도구 카드 점검).
 *
 * ★사고: `ToolSearch` 의 결과는 텍스트가 아니라 `tool_reference` 블록이라, 결과를 텍스트만 읽는 추출기에서 통째로 빠져
 *  카드 출력이 늘 비었다(dev 13/13 · 개발돌쇠 19/19). 모양은 실제 세션 기록에서 확인했다:
 *  `{"type":"tool_reference","tool_name":"WebSearch"}`.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "tool-card-toolsearch-output",
  guards: "claude ToolSearch 결과(tool_reference 블록)가 텍스트 추출에서 빠져 도구 카드 출력이 늘 비던 것",
  run: async (): Promise<Assertion[]> => {
    const { extractToolResults } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
    const { buildActivityOutput } = await import("../../core/llm-runtime/adapters/_activity-output.js");
    const msg = (content: unknown[]) => ({ type: "user", message: { role: "user", content } });
    const refs = extractToolResults(msg([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "WebSearch" }, { type: "tool_reference", tool_name: "WebFetch" }] }]));
    const mixed = extractToolResults(msg([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "찾음" }, { type: "tool_reference", tool_name: "Grep" }] }]));
    const plain = extractToolResults(msg([{ type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]));
    const out = buildActivityOutput("ToolSearch", refs[0]?.text);
    return [
      assert("★불러온 도구 이름이 결과 텍스트가 된다(한 줄에 하나)", refs[0]?.text === "WebSearch\nWebFetch", refs),
      assert("텍스트와 참조가 섞이면 텍스트 뒤에 이름", mixed[0]?.text === "찾음\nGrep", mixed),
      assert("반대 방향: 텍스트만 있는 결과는 종전과 같다(이어 붙임)", plain[0]?.text === "ab", plain),
      assert("카드 출력이 생긴다", out !== undefined && JSON.stringify(out).includes("WebFetch"), out),
    ];
  },
};
