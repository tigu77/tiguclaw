/**
 * 회귀: codex 요약이 **백엔드 과부하**로 실패하면 다음 요약 예산을 줄이지 않는다 — 크기 탓 실패는 줄인다 (2026-10-05).
 *
 * 사고(벤치 `long-session-compaction` 18→11): 과부하가 이어진 날 요약 예산이 2만→1만→5천 자로 반감됐고, 그 예산으론
 * 11.6만 자 일지 턴이 안 들어가 잘리면서 첫 줄의 규칙 변경이 요약에서 사라졌다.
 * ★첫 고침(`keepsFoldBudget` 에 과부하)은 **실제 과부하 모양에 안 닿았다**(레드팀 F1, 실측): codex 는 과부하를 HTTP 200
 *  스트림 안의 `error` 이벤트로 알리는데 요약 호출이 빈 텍스트만 돌려줘, «요약이 쓸 수 없는 크기» 경로가 무조건 줄였다.
 *  판정 함수에 문자열을 넣어 보는 검사로는 이걸 못 본다 — 그래서 **실제 경로**(buildTurnHistory → 요약 호출)를 가짜
 *  fetch 위에서 돌린다.
 *
 * 등급: **동작** — 제품 경로 그대로, 네트워크만 가짜. 모델 호출 0.
 */
import { assert, assertIsolated, fakeNetwork, type Assertion, type RegressionCheck } from "./_framework.js";

const OVERLOAD = { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." };
const enc = new TextEncoder();

/** 스트림 안 실패(HTTP 200) 또는 HTTP 오류를 돌려주는 가짜 codex. */
const fakeCodex = (mode: "sse-overload" | "http-overload" | "sse-other") =>
  fakeNetwork(async () => {
    if (mode === "http-overload") return new Response(JSON.stringify({ error: OVERLOAD }), { status: 503 });
    const err = mode === "sse-overload" ? OVERLOAD : { code: "server_error", message: "The model produced an invalid response." };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", ...err })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.failed", response: { error: err } })}\n\n`));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

export const check: RegressionCheck = {
  name: "codex-summary-overload-keeps-budget",
  guards:
    "codex 백엔드 과부하(스트림 안 error 이벤트)로 요약이 실패하면 «크기 탓» 으로 세어 요약 예산을 반감해, 큰 턴이 잘리며 사용자 규칙이 요약에서 사라지던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    initStore();
    const per = Math.ceil(H.CODEX_HISTORY_COMPACT_TRIGGER_CHARS / 40);

    /** 압축이 필요한 대화를 만들고 가짜 백엔드로 한 턴을 준비한다 — 요약 단계의 경고 줄을 돌려준다. */
    const runOnce = async (mode: Parameters<typeof fakeCodex>[0]): Promise<string[]> => {
      const tk = `dashboard:regr-overload-${mode}-${Math.random().toString(36).slice(2)}`;
      const sid = `regr-ov-${mode}-${Math.random().toString(36).slice(2)}`;
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: sid });
      let ts = 1_750_000_000_000;
      for (let i = 0; i < 60; i++) {
        appendTranscript({ claudeSessionId: sid, role: i % 2 === 0 ? "user" : "assistant", content: `턴${i}:` + "가".repeat(per), ts: (ts += 60_000) });
      }
      const savedFetch = globalThis.fetch;
      const savedWarn = console.warn;
      const lines: string[] = [];
      globalThis.fetch = fakeCodex(mode);
      console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
      try {
        await H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth" } as never, "현재 턴", [], "fake-token", undefined, "fake-model");
      } finally {
        globalThis.fetch = savedFetch;
        console.warn = savedWarn;
      }
      return lines.filter((l) => /6b\]/.test(l));
    };

    const sse = await runOnce("sse-overload");
    const http = await runOnce("http-overload");
    const other = await runOnce("sse-other");
    const kept = (ls: string[]) => ls.length > 0 && ls.every((l) => /예산 유지/.test(l)) && !ls.some((l) => /축소/.test(l));
    // 문구가 아니라 **숫자**로 잰다 — «축소» 라는 글자만 보면 예산을 실제로 안 줄여도(현재값을 찍어도) 통과한다(변이로 확인).
    const shrunk = (ls: string[]) =>
      ls.some((l) => {
        const n = Number(/예산 (\d+)자로 축소/.exec(l)?.[1] ?? NaN);
        return Number.isFinite(n) && n < H.CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS;
      });
    const head = (ls: string[]) => (ls[0] ?? "(요약 단계 경고 없음)").slice(0, 160);
    return [
      assert("★스트림 안 과부하(HTTP 200 + error 이벤트)는 예산을 유지하고, 사유가 로그에 남는다", kept(sse) && sse.some((l) => /server_is_overloaded/.test(l)), head(sse)),
      assert("HTTP 503 과부하도 예산을 유지한다", kept(http), head(http)),
      assert("★과부하가 아닌 스트림 실패는 줄인다(크기 탓일 수 있다 — 같은 크기를 영원히 재시도하지 않게)", shrunk(other), head(other)),
    ];
  },
};
