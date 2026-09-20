/** 실제 요청 경계에서 MCP/외부 도구의 선택 항목 계약을 검사한다. 네트워크·도구 실행 0. */
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";
import { assertIsolated } from "./_framework.js";
assertIsolated();
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
const requests: Array<{ tools: Array<{ type: string; name?: string; strict?: boolean; parameters?: unknown }> }> = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
  requests.push(body);
  return new Response([
    { type: "response.output_text.delta", delta: "검사 종료" },
    { type: "response.completed", response: { id: "synthetic", usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
};
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const schema = { type: "object", properties: { wanted: { type: "string" }, region: { type: "object", properties: { x: { type: "number" } } } }, required: ["wanted"] };
await runOpenAiCodex({ text: "합성 검사", channel: "cli", threadKey: "regr:optional", model: "gpt-5.6-sol", externalTools: [{ name: "optional_probe", description: "선택 항목 보존 검사", parameters: schema }] } as RegionASdkInput);
const functions = requests.flatMap(r => r.tools.filter(t => t.type === "function"));
const external = functions.filter(t => t.name === "optional_probe");
const internal = functions.filter(t => t.name !== "optional_probe");
console.log("OPTIONAL_RESULT " + JSON.stringify({
  internalCount: internal.length,
  internalStrictFalse: internal.length > 0 && internal.every(t => t.strict === false),
  externalStrictFalse: external.length > 0 && external.every(t => t.strict === false),
  schemaPreserved: external.length > 0 && external.every(t => JSON.stringify(t.parameters) === JSON.stringify(schema)),
}));
process.exit(0);
