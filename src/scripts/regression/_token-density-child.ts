/**
 * 글자당 토큰 기록을 **router → Codex 어댑터 → 사용량 → 저장** 실제 경로로 돌린다. 네트워크 0.
 * 가짜 서버가 받은 요청 크기의 1/2.2 를 입력 토큰으로 돌려준다 — 어댑터가 «보낸 글자 / 그 호출의 입력 토큰» 을 그 대화에 남기는가.
 */
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
assertIsolated();
pinModelForTest("codex:gpt-6-sol");
// 설정된 모델 입력 상한 — 요청 조립이 실제로 읽어 이력 상한에 반영하는가(순수 함수만 보면 배선을 빼도 초록이었다).
{
  const { readFileSync, writeFileSync } = await import("node:fs");
  const f = `${process.env.TIGUCLAW_HOME}/settings.json`;
  const cfg = JSON.parse(readFileSync(f, "utf8")) as { models: Record<string, unknown> };
  cfg.models.limits = { "codex:gpt-6-sol": { maxInputChars: 400_000 } };
  writeFileSync(f, JSON.stringify(cfg));
}
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

let lastBodyLen = 0;
let sawImage = false;
// 그림이 실린 요청엔 토큰을 **적게** 돌려준다(base64 는 토큰이 거의 안 든다) — 그대로 재면 비율이 부푼다. ★«믿을 수 없는 비율» 필터(8)
//  안쪽 값(6)으로 준다 — 밖이면 필터가 먼저 막아 «그림 요청은 안 잰다» 가 검사되지 않는다(변이 생존).
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = String(init?.body ?? "");
  lastBodyLen = body.length;
  const hasImage = body.includes('"type":"input_image"');
  if (hasImage) sawImage = true;
  const msg = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "답", annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: msg },
    { type: "response.output_text.delta", delta: "답" },
    { type: "response.output_item.done", output_index: 0, item: msg },
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: hasImage ? Math.round(lastBodyLen / 6) : Math.round(lastBodyLen / 2.2), output_tokens: 1, input_tokens_details: { cached_tokens: Math.round(lastBodyLen / 2.2 / 2) } } } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
});
const realLog = console.log.bind(console);
const lines: string[] = [];
console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
console.warn = () => {};

const { route } = await import("../../core/router.js");
const { tokenDensityOf } = await import("../../store/token-density.js");
const { writeFileSync } = await import("node:fs");
const { getPaths } = await import("../../core/paths.js");
const img = `${getPaths().home}/density-test.png`;
// 1×1 PNG 를 크게 부풀린 그림(바이트가 커야 base64 가 비율을 흔든다).
writeFileSync(img, Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), Buffer.alloc(200_000)]));
let error = "";
let afterFirst: number | null = null;
try {
  await route({ channel: "dashboard", channelUserId: "u", receivedAt: Date.now(), reply: async () => {}, threadKey: "regr:density", text: "안녕" } as IncomingMessage);
  afterFirst = tokenDensityOf("regr:density") ?? null;
  await route({ channel: "dashboard", channelUserId: "u", receivedAt: Date.now(), reply: async () => {}, threadKey: "regr:density", text: "이 그림 봐",
    attachments: [{ kind: "image", mimeType: "image/png", path: img, filename: "density-test.png", bytes: 200_067 }] } as unknown as IncomingMessage);
} catch (e) { error = e instanceof Error ? e.message : String(e); }
const { historyTriggerChars, buildTurnHistory, historyCapUsedFor } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
const { recordTokenDensity } = await import("../../store/token-density.js");
recordTokenDensity("regr:limit", 500_000, 100_000); // 비율 5 — 창 기준으론 594,960 까지 가지만 설정 40만이 먼저
await buildTurnHistory({ threadKey: "regr:limit", channel: "http-bridge", provider: "codex-oauth" } as never, "q", [], "t", undefined, "gpt-6-sol", 47_000);
const limitCap = historyCapUsedFor("regr:limit") ?? null;
const turnEnd = lines.find((l) => l.includes("[codex-turn-end]")) ?? "";
realLog("DENSITY_RESULT " + JSON.stringify({
  density: afterFirst, afterImage: tokenDensityOf("regr:density") ?? null, sawImage, bodyLen: lastBodyLen,
  capInLog: /이력상한=([\d,]+)자\(이번 요청/.exec(turnEnd)?.[1]?.replace(/,/g, "") ?? null, turnEnd: turnEnd.slice(0, 400),
  trigExplicit: historyTriggerChars(47_000, 500_000), limitCap, error }));
process.exit(0);
