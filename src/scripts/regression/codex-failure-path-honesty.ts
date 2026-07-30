/**
 * 회귀: **실패 경로가 정직하고, 진단이 실패할 때 남고, 사용자가 멈추면 멈춘다** (2026-07-31).
 *
 * 전체검토 P1 6건. 전부 "관측·복구를 위해 넣은 장치가 정작 필요한 순간에만 안 도는" 부류다.
 *
 *  ①**히스토그램이 실패 때만 안 찍혔다.** `[codex-sse-incomplete]` 는 completed 없이 끝난
 *   스트림의 이벤트 분포를 남기려고 만든 건데, 바로 위 `throw` 가 이 블록보다 앞서서
 *   **성공적으로 끝난 스트림에서만** 출력됐다. 사고 로그에 한 줄도 없던 이유.
 *  ②**`error` 가 lastEvent 에 안 남았다.** 2026-07-30 반나절 사고에서 실제로 온 이벤트가
 *   `error/server_is_overloaded` 인데, 기록 대상이 `response.failed`·`response.incomplete`
 *   뿐이라 그 턴들의 lastEvent 는 전부 "(없음)" 이었다.
 *  ③**결정적 실패를 27초 재시도했다.** `response.incomplete`(max_output_tokens·content_filter)
 *   는 같은 body 를 다시 보내면 같은 벽이다. transient 취급 = 시간만 태우고 같은 자리.
 *  ④**멈추라고 해도 안 멈췄다.** 백오프 `sleep` 이 signal 을 안 받아, `/stop`·턴 타임아웃
 *   뒤에도 최대 27초 동안 죽은 백엔드에 계속 재전송했다.
 *  ⑤**백엔드 JSON 400자가 답장에 실렸다.** 로그용 사유(raw 포함)와 사용자용 사유가 같은
 *   문자열이었다.
 *  ⑥**타임아웃인데 "다른 모델로 이어서 시도합니다".** 단일 모델 세션에서 잡은 거짓말이
 *   TurnTimeoutError 경로로 되살아나 있었다 — 그 경로는 폴백을 명시 단락한다.
 */
import { sourceHas, sourceOrder } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CODEX = "../../core/llm-runtime/adapters/openai-codex-oauth.ts";

export const check: RegressionCheck = {
  name: "codex-failure-path-honesty",
  guards:
    "실패 스트림의 진단이 안 찍히고, error 가 lastEvent 에 안 남고, 결정적 실패를 27초 재시도하고, /stop 이 안 먹고, 백엔드 원문이 답장에 실리고, 타임아웃에 폴백을 약속하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 순서 — 히스토그램이 throw 보다 **먼저**. 순서가 뒤집히면 실패 때 침묵으로 되돌아간다.
    const order = await sourceOrder(CODEX, [
      /codex-sse-incomplete/,
      /throw new CodexBackendFailureError\(/,
    ]);
    out.push(
      assert(
        "★스트림 실패 히스토그램이 throw 보다 먼저 찍힌다(실패 때 남는다)",
        order.ok,
        order.ok ? "순서 확인" : order.detail,
      ),
    );

    // ② error 이벤트가 lastEvent 에 남는다 — 그 사고에서 실제로 온 이벤트.
    const lastEv = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.ts",
      // ★`lastEvent = event.type;` 까지 붙여서 본다. 세 줄만 보면 **같은 파일의 `terminal`
      //  판정**(failure 추출용)이 대신 매칭돼, 버그를 되돌려도 초록이었다 — 변이로 확인.
      //  terminal 쪽은 `...incomplete";` 로 끝나고 이쪽은 `) {` 로 이어져 갈린다.
      [
        /event\.type === "error" \|\|\s*event\.type === "response\.failed" \|\|\s*event\.type === "response\.incomplete"\s*\) \{\s*lastEvent = event\.type;/,
      ],
    );
    out.push(
      assert(
        "★`error` 도 lastEvent 에 기록된다(사고 때 실제로 온 이벤트)",
        lastEv.ok,
        lastEv.ok ? "확인" : `누락 ${lastEv.missing.join(" ")}`,
      ),
    );

    // ③ response.incomplete = 비재시도. ④ sleep 취소 가능. ⑤ 사용자 대면 사유 분리.
    const failure = await sourceHas(CODEX, [
      // 결정적 실패는 retryable=false 로 태워 보낸다.
      /f\.source !== "response\.incomplete"/,
      /e\.retryable &&/,
      // 백오프가 signal 을 받고, 깨면 재전송하지 않는다.
      /await sleep\(wait, effectiveAc\.signal\)/,
      /if \(effectiveAc\.signal\.aborted\) throw e;/,
      // 사용자 답장엔 raw 를 뺀 판.
      /\$\{e\.userWhy\}/,
    ]);
    out.push(
      assert(
        "★결정적 실패는 재시도 안 하고, 백오프는 취소되고, 답장엔 백엔드 원문이 안 실린다",
        failure.ok,
        failure.ok ? "5개 확인" : `누락 ${failure.missing.join(" ")}`,
      ),
    );

    // sleep 자체가 signal 을 실제로 소비하는지 — 시그니처만 받고 무시하면 무의미.
    const sleepImpl = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth-auth.ts",
      [
        /export const sleep = \(ms: number, signal\?: AbortSignal\)/,
        /signal\?\.addEventListener\("abort", finish, \{ once: true \}\)/,
        /clearTimeout\(timer\)/,
      ],
    );
    out.push(
      assert(
        "★sleep 이 abort 에서 실제로 깨고 타이머를 정리한다",
        sleepImpl.ok,
        sleepImpl.ok ? "3개 확인" : `누락 ${sleepImpl.missing.join(" ")}`,
      ),
    );

    // ⑥ 타임아웃 경로에서 hasFallback 이 거짓말하지 않는다.
    const honest = await sourceHas("../../core/llm-runtime/index.ts", [
      /specIndex < effectivePool\.length - 1 && !\(e instanceof TurnTimeoutError\)/,
    ]);
    out.push(
      assert(
        "★폴백을 단락하는 타임아웃 경로에서 '다음 모델 시도' 를 약속하지 않는다",
        honest.ok,
        honest.ok ? "확인" : `누락 ${honest.missing.join(" ")}`,
      ),
    );

    // 부록 — 집계가 프로세스 수명보다 짧게 배출된다(실측: 부팅당 3.6턴 → 임계만으론 0줄).
    const rollup = await sourceHas("../../core/llm-runtime/index.ts", [
      /process\.on\("exit", \(\) => \{/,
      /if \(rollupTurns > 0\) flushPrefixCacheRollup/,
    ]);
    out.push(
      assert(
        "★prefix-cache 집계가 종료 시에도 배출된다(임계만 두면 하루 0줄이었다)",
        rollup.ok,
        rollup.ok ? "확인" : `누락 ${rollup.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
