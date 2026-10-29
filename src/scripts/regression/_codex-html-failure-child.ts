/**
 * `codex-html-failure-summarized` 의 자식 — codex 어댑터를 가짜 네트워크로 실제로 돌려 **HTML 오류 페이지(520)** 를 받게 한다.
 * (`_adapter-failure-child` 와 같은 이유로 자식이다: `fetch` 를 스텁하고 인증을 전역 등록한다. 시나리오 하나 = 프로세스 하나.)
 *
 * 출력: 마지막 줄 JSON — `{ outcome, text, advice: { checkOrAskAgain } }`.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const scenario = process.argv[2] ?? "";
// 합성 — Cloudflare 520 페이지 형상(제목·인라인 CSS). 실물 캡처가 아니다.
const CF_520_HTML =
  '<!DOCTYPE html>\n<html lang="en-US">\n<head>\n<title>chatgpt.com | 520: Web server is returning an unknown error</title>\n' +
  '<meta charset="UTF-8" />\n<style>body{margin:0;padding:0;font-family:-apple-system,system-ui}.cf-error{color:#404040}</style>\n' +
  '</head><body><div class="cf-error">Error code 520</div></body></html>';
const enc = new TextEncoder();
const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const streamResponse = (events: unknown[]): Response =>
  new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse(events))); c.close(); } }), { status: 200 });
const html520 = (): Response => new Response(CF_520_HTML, { status: 520, headers: { "content-type": "text/html; charset=UTF-8" } });
const sideEffect = (cid: string): unknown[] => {
  const a = JSON.stringify({ name: `regr-${cid}`, kind: "note", summary: "회귀 검사용", body: "x" });
  return [
    { type: "response.output_item.added", item: { type: "function_call", id: `fc_${cid}`, call_id: cid, name: "add_memory" } },
    { type: "response.function_call_arguments.delta", delta: a },
    { type: "response.output_item.done", item: { type: "function_call", id: `fc_${cid}`, call_id: cid, name: "add_memory", arguments: a } },
    { type: "response.completed", response: { id: `r-${cid}`, usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
};

const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "chf-"));
  let calls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async () => {
    calls += 1;
    switch (scenario) {
      case "side-effect-then-520":
        return calls === 1 ? streamResponse(sideEffect("c1")) : html520();
      case "520-no-side-effect":
      case "oauth-refresh-520":
      case "oauth-exchange-520":
      case "compact-http-520":
        return html520();
      case "compact-sse-html":
        return streamResponse([{ type: "response.output_text.delta", delta: "부분 요약" }, { type: "error", code: "bad_gateway", message: CF_520_HTML }]);
      case "side-effect-then-sse-html":
        // 글을 흘린 뒤 스트림 안 실패 — 재전송 없이 바로 안내로 끝난다(27초 백오프를 타지 않게).
        return calls === 1
          ? streamResponse(sideEffect("c1"))
          : streamResponse([{ type: "response.output_text.delta", delta: "부분 답" }, { type: "error", code: "bad_gateway", message: CF_520_HTML }]);
      default:
        throw new Error(`unknown scenario ${scenario}`);
    }
  });
  // OAuth 토큰 엔드포인트 실패 — 함수를 직접 부른다(합성 값 · 520 이라 성공 분기·`.env` 쓰기에 닿지 않는다).
  if (scenario === "oauth-refresh-520" || scenario === "oauth-exchange-520") {
    const auth = await import("../../core/llm-runtime/adapters/openai-codex-oauth-auth.js");
    let text = "";
    try {
      if (scenario === "oauth-refresh-520") await auth.refreshAccessToken("regression-fake-refresh");
      else await auth.exchangeAuthorizationCode("regression-fake-code", "regression-fake-verifier");
      console.log(JSON.stringify({ outcome: "returned", text, calls }));
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
      console.log(JSON.stringify({ outcome: "threw", text, calls }));
    }
    return;
  }
  const { initStore } = await import("../../store/sessions.js");
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  const { translate } = await import("../../core/i18n.js");
  initStore();
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  // 수동 `/compact` — 실제 `compactThreadNow`(요약기 이음매 없이 `summarizeViaCodex` 의 fetch·SSE 분기)를 가짜 네트워크로 돌린다.
  if (scenario === "compact-http-520" || scenario === "compact-sse-html") {
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    H.setSummarizerPort(null);
    const tk = `agent:regr-chf-${scenario}`;
    indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: tk });
    for (let i = 0; i < 32; i++) appendTranscript({ claudeSessionId: tk, role: i % 2 ? "assistant" : "user", content: `합성 대화 ${i}`, ts: 1_000 + i });
    const r = await H.compactThreadNow("http-bridge", tk, "gpt-fake", "regression-fake-token", undefined);
    // 사용자에게 나가는 문장 그대로(`/compact` 의 «건너뜀» 답) — 사유가 카탈로그 문구에 실린다.
    const reply = r.ok ? "" : translate("srv.compact.skipped", { reason: r.reason });
    console.log(JSON.stringify({ outcome: r.ok ? "compacted" : "skipped", text: reply, calls }));
    return;
  }
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  let outcome = "returned";
  let text = "";
  try {
    const out = await runOpenAiCodex({ text: "회귀 검사 요청", threadKey: `regr:chf-${scenario}`, channel: "cli", model: "gpt-fake" } as never);
    text = out.text;
  } catch (e) {
    outcome = "threw";
    text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  console.log(JSON.stringify({ outcome, text, calls, advice: { checkOrAskAgain: translate("srv.codex.checkOrAskAgain") } }));
};

void main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.log(JSON.stringify({ outcome: "crashed", text: String(e) }));
    process.exit(1);
  },
);
