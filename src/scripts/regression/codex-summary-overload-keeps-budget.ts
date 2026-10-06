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

type Ev = Record<string, unknown>;
const PARTIAL = "부분 요약 ".repeat(60); // 약 360자 — 하한(50자)을 넘는 «쓸 만해 보이는» 조각
const textDelta = (t: string): Ev => ({ type: "response.output_text.delta", delta: t });
/** 시나리오마다 백엔드가 흘리는 이벤트. `http-overload` 만 HTTP 오류로 답한다. */
const SCENARIOS: Record<string, Ev[] | "http-overload"> = {
  // 사유 있는 error 하나
  "sse-overload": [{ type: "error", ...OVERLOAD }, { type: "response.failed", response: { error: OVERLOAD } }],
  // ★실측 모양 — 사유 없는 error 다음에 사유 있는 response.failed(파서가 내용 있는 쪽으로 승격 → source=response.failed)
  "sse-silent-then-failed": [{ type: "error" }, { type: "response.failed", response: { error: OVERLOAD } }],
  "http-overload": "http-overload",
  // 과부하가 아닌 생성 실패
  "sse-other": [{ type: "error", code: "server_error", message: "The model produced an invalid response." }],
  // 출력 상한으로 끊긴 부분 요약 — 써야 한다
  "partial-incomplete": [textDelta(PARTIAL), { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }],
  // 생성 도중 과부하 — 앞 조각은 잘린 것이라 버리고, 예산은 유지
  "partial-then-overload": [textDelta(PARTIAL), { type: "error", ...OVERLOAD }],
  // ★실측 모양 앞에 부분 텍스트 — 파서가 source=response.failed 로 올린다. «error 일 때만 버린다» 로 좁히면 잘린 조각이 확정된다
  "partial-silent-then-failed": [textDelta(PARTIAL), { type: "error" }, { type: "response.failed", response: { error: OVERLOAD } }],
  // 사유 없는 실패 — 원문은 로그에만, 오류 문장(=/compact 답장)엔 안 싣는다
  "silent-failed": [{ type: "response.failed", response: { id: "resp_regr", status: "failed" } }],
};
const fakeCodex = (mode: string) =>
  fakeNetwork(async () => {
    const sc = SCENARIOS[mode]!;
    if (sc === "http-overload") return new Response(JSON.stringify({ error: OVERLOAD }), { status: 503 });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ev of sc) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
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
    const runOnce = async (mode: string): Promise<string[]> => {
      const tk = `dashboard:regr-overload-${mode}-${Math.random().toString(36).slice(2)}`;
      const sid = `regr-ov-${mode}-${Math.random().toString(36).slice(2)}`;
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: sid });
      let ts = 1_750_000_000_000;
      for (let i = 0; i < 60; i++) {
        appendTranscript({ claudeSessionId: sid, role: i % 2 === 0 ? "user" : "assistant", content: `턴${i}:` + "가".repeat(per), ts: (ts += 60_000) });
      }
      const savedFetch = globalThis.fetch;
      const savedWarn = console.warn;
      const savedLog = console.log;
      const lines: string[] = [];
      globalThis.fetch = fakeCodex(mode);
      console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
      try {
        await H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth" } as never, "현재 턴", [], "fake-token", undefined, "fake-model");
      } finally {
        globalThis.fetch = savedFetch;
        console.warn = savedWarn;
        console.log = savedLog;
      }
      return lines.filter((l) => /6b\]/.test(l));
    };

    const sse = await runOnce("sse-overload");
    const silentThenFailed = await runOnce("sse-silent-then-failed");
    const http = await runOnce("http-overload");
    const other = await runOnce("sse-other");
    const partialOk = await runOnce("partial-incomplete");
    const partialOverload = await runOnce("partial-then-overload");
    const partialSilentFailed = await runOnce("partial-silent-then-failed");
    const silent = await runOnce("silent-failed");
    const kept = (ls: string[]) => {
      const fails = ls.filter((l) => /요약 호출 실패|쓸 수 없는/.test(l));
      return fails.length > 0 && fails.every((l) => /예산 유지/.test(l)) && !ls.some((l) => /축소/.test(l));
    };
    // 문구가 아니라 **숫자**로 잰다 — «축소» 라는 글자만 보면 예산을 실제로 안 줄여도(현재값을 찍어도) 통과한다(변이로 확인).
    const shrunk = (ls: string[]) =>
      ls.some((l) => {
        const n = Number(/예산 (\d+)자로 축소/.exec(l)?.[1] ?? NaN);
        return Number.isFinite(n) && n < H.CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS;
      });
    const succeeded = (ls: string[]) => ls.some((l) => /압축 성공/.test(l)) && !ls.some((l) => /요약 호출 실패|쓸 수 없는/.test(l));
    const head = (ls: string[]) => (ls.find((l) => /6b\]/.test(l)) ?? "(요약 단계 줄 없음)").slice(0, 160);
    const failLine = (ls: string[]) => ls.find((l) => /요약 호출 실패/.test(l)) ?? "";
    return [
      assert("★스트림 안 과부하(HTTP 200 + error 이벤트)는 예산을 유지하고, 사유가 로그에 남는다", kept(sse) && sse.some((l) => /server_is_overloaded/.test(l)), head(sse)),
      assert("★실측 모양(사유 없는 error → 사유 있는 response.failed)도 예산을 유지한다", kept(silentThenFailed), head(silentThenFailed)),
      assert("HTTP 503 과부하도 예산을 유지한다", kept(http), head(http)),
      assert("★과부하가 아닌 스트림 실패는 줄인다(크기 탓일 수 있다 — 같은 크기를 영원히 재시도하지 않게)", shrunk(other), head(other)),
      assert("★출력 상한으로 끊긴 부분 요약은 쓴다(실패로 버리지 않는다)", succeeded(partialOk), head(partialOk)),
      assert("★생성 도중 과부하로 끊기면 앞 조각을 요약으로 확정하지 않고, 예산은 유지한다", kept(partialOverload) && !partialOverload.some((l) => /압축 성공/.test(l)), head(partialOverload)),
      assert("★실측 모양(부분 텍스트 → 사유 없는 error → 사유 있는 response.failed)도 조각을 확정하지 않고 예산을 유지한다",
        kept(partialSilentFailed) && !partialSilentFailed.some((l) => /압축 성공/.test(l)), head(partialSilentFailed)),
      assert("★버린 조각 길이는 로그에만 — 실패 문장(분류기 입력)에 숫자를 섞지 않는다(길이 429 면 한도로 읽힌다)",
        partialOverload.some((l) => /받은 조각 \d+자를 요약으로 쓰지 않는다/.test(l)) && !/discarded|조각 \d+자/.test(failLine(partialOverload)),
        failLine(partialOverload).slice(0, 160)),
      assert("사유 없는 실패는 원문을 로그에만 남기고 오류 문장(/compact 답장)엔 싣지 않는다",
        silent.some((l) => /요약 스트림 실패 원문/.test(l) && /resp_regr/.test(l)) && failLine(silent) !== "" && !/resp_regr/.test(failLine(silent)),
        failLine(silent).slice(0, 160)),
    ];
  },
};
