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
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";

const CODEX = "../../core/llm-runtime/adapters/openai-codex-oauth.ts";

export const check: RegressionCheck = {
  name: "codex-failure-path-honesty",
  guards:
    "실패 스트림의 진단이 안 찍히고, error 가 lastEvent 에 안 남고, 결정적 실패를 27초 재시도하고, /stop 이 안 먹고, 백엔드 원문이 답장에 실리고, 타임아웃에 폴백을 약속하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 순서 — 히스토그램이 throw 보다 **먼저**. 순서가 뒤집히면 실패 때 침묵으로 되돌아간다.
    // ★겨냥을 좁힌다: `codex-sse-incomplete` 만 보면 **주석**이 먼저 매칭되고(이 레포는
    //  주석에 로그 태그를 관례적으로 인용한다), 조건을 `endKey === "completed"` 로 뒤집는
    //  변이도 통과한다 — 둘 다 원래 증상("성공한 스트림에서만 찍힘")을 그대로 만든다.
    const order = await sourceOrder(CODEX, [
      /if \(endKey === "none"\) \{/,
      /console\.warn\(\s*`\[codex-sse-incomplete\]/,
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

    // ★③④⑤ — **동작으로** 본다. 종전엔 소스 문자열만 봐서, `sleep` 을 abort 에서 안 깨게
    //  바꿔도·`retryable` 을 항상 true 로 만들어도·`userWhy` 를 `why` 로 바꿔도 전부 초록
    //  이었다(검토 변이 확인). `sleep` 은 10ms 안에 결판나는 순수 함수인데 grep 을 했다.
    const { sleep } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-auth.js"
    );
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = sleep(5_000, ac.signal);
    ac.abort();
    // ★`within` 으로 감싼다 — sleep 이 abort 에서 **안 깨는** 변이를 넣으면 이 await 가
    //  영영 안 끝나 **스위트가 통째로 멈춘다**(빨간불보다 나쁘다 — _framework.ts 주석).
    //  실제로 그렇게 만들어봤고, 그래서 시한을 들려 보낸다.
    const woke = await within(1_000, "abort 후 sleep 반환", pending);
    const wokeMs = Date.now() - t0;
    out.push(
      assert(
        "★sleep 이 abort 에서 **실제로** 깬다(/stop 이 27초 백오프를 못 뚫던 것)",
        "value" in woke && wokeMs < 500,
        "timedOut" in woke ? woke.timedOut : `abort 후 ${wokeMs}ms 만에 반환(기대 <500)`,
      ),
    );
    const t1 = Date.now();
    await sleep(120);
    const normalMs = Date.now() - t1;
    out.push(
      assert(
        "signal 없이도 정상 대기한다(조기 resolve 로 백오프가 죽지 않는다)",
        normalMs >= 100,
        `${normalMs}ms 대기(기대 ≥100)`,
      ),
    );

    // ★스톨 백오프가 **실제로 기다리는지** — 어댑터 제어흐름 그대로 재현한다.
    //  이 분기는 `reason instanceof IdleTimeoutError` 일 때만 들어오고, signal 이 reason 을
    //  가지려면 **이미 aborted** 여야 한다. 그래서 iteration signal 을 주면 항상 0ms 가 되어
    //  문서화된 knob(CODEX_STALL_BACKOFF_MS, ADR 2026-07-02)이 말없이 죽는다.
    const iterAc = new AbortController();
    iterAc.abort(new Error("idle"));
    const t2 = Date.now();
    await sleep(150, iterAc.signal);
    const deadMs = Date.now() - t2;
    const turnAc = new AbortController(); // 턴 예산은 아직 살아있다
    const t3 = Date.now();
    await sleep(150, turnAc.signal);
    const aliveMs = Date.now() - t3;
    out.push(
      assert(
        "★스톨 백오프는 **턴 예산** signal 을 봐야 한다(iteration signal 이면 항상 0ms)",
        deadMs < 50 && aliveMs >= 120,
        `iteration signal=${deadMs}ms(죽음) / 턴 signal=${aliveMs}ms(살아있음)`,
      ),
    );
    const stallWiring = await sourceHas(CODEX, [
      /await sleep\(CODEX_STALL_BACKOFF_MS, input\.abortSignal\)/,
    ]);
    out.push(
      assert(
        "★그 signal 이 실제로 배선돼 있다",
        stallWiring.ok,
        stallWiring.ok ? "input.abortSignal 확인" : `누락 ${stallWiring.missing.join(" ")}`,
      ),
    );

    // ③⑤ 배선 — 동작으로 못 보는 부분(throw 인자)은 **겨냥을 좁혀** 못박는다.
    const failure = await sourceHas(CODEX, [
      // 결정적 실패는 retryable=false 로. 생성 지점을 통째로 겨냥한다.
      /throw new CodexBackendFailureError\(\s*why,\s*userWhy,\s*f\.source !== "response\.incomplete",\s*\);/,
      // 클래스가 그 값을 **저장**한다(생성자에서 무시하면 위 겨냥이 무의미).
      /readonly retryable: boolean,/,
      /if \(\s*e\.retryable &&/,
      // 백오프가 취소되고, 깨면 재전송하지 않는다.
      /await sleep\(wait, effectiveAc\.signal\)/,
      /if \(effectiveAc\.signal\.aborted\) throw e;/,
      // 사용자 답장엔 raw 를 뺀 판 + retryable 별 실효 대책.
      /\$\{e\.userWhy\}\$\{ranList\}\\n\\n\$\{codexFailureAdvice\(e\)\}/,
    ]);
    out.push(
      assert(
        "★결정적 실패는 재시도 안 하고, 답장엔 백엔드 원문이 안 실린다",
        failure.ok,
        failure.ok ? "6개 확인" : `누락 ${failure.missing.join(" ")}`,
      ),
    );

    // ★안내가 자기모순이 아니다 — retryable=false 인데 "잠시 후 다시 시도" 를 권하던 것.
    const { codexFailureAdviceForTest } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth.js"
    );
    const adviceDeterministic = codexFailureAdviceForTest(
      "response.incomplete/max_output_tokens",
      false,
    );
    const adviceTransient = codexFailureAdviceForTest(
      "response.failed/server_is_overloaded",
      true,
    );
    out.push(
      assert(
        "★재시도 무의미한 실패에 '잠시 후 다시 시도' 를 권하지 않는다",
        !adviceDeterministic.includes("잠시 후 다시") &&
          adviceDeterministic.includes("나눠") &&
          adviceTransient.includes("잠시 후 다시"),
        `결정적="${adviceDeterministic.slice(0, 40)}…" / 일시적="${adviceTransient.slice(0, 20)}…"`,
      ),
    );

    // ★/diagnose 시한 — `PROBE_TIMEOUT_MS` 만 보면 이 파일에 4번 나와서(선언·메시지 2곳)
    //  `setTimeout(() => {}, …)` 로 abort 를 떼어내도 초록이었다(검토 변이 확인).
    //  ①실제로 abort 를 걸고 ②fetch 에 물리고 ③read 가 reject 될 때 결과로 돌려주는지.
    const probe = await sourceHas("../../core/llm-runtime/codex-weight-probe.ts", [
      /const killer = setTimeout\(\(\) => ac\.abort\(\), PROBE_TIMEOUT_MS\);/,
      /signal: ac\.signal,/,
      // ★abort 는 `reader.read()` 를 reject 시킨다 — try 로 감싸지 않으면 **이미 모은
      //  진단 결과를 통째로 버린다**(LEAN 성공/HEAVY 무응답 이라는 유일한 신호).
      /\} catch \(e\) \{\s*clearTimeout\(killer\);\s*\/\/ 시한이면 그 사실을 \*\*결과로\*\* 돌려준다/,
    ]);
    out.push(
      assert(
        "★/diagnose 시한이 실제로 abort 를 걸고, 끊겨도 부분 결과를 살린다",
        probe.ok,
        probe.ok ? "3개 확인" : `누락 ${probe.missing.join(" ")}`,
      ),
    );

    // ★진단 코드가 두 벌이 아니다 — 셸 스크립트가 자기 send() 사본을 갖고 있어서
    //  `/diagnose` 에만 시한을 넣었을 때 `npm run diagnose:codex` 는 20분 매달림이
    //  그대로였다. 커밋 메시지엔 이미 "사본 0" 이라 적혀 있었다(거짓).
    const shellThin = await sourceHas("../../scripts/diagnose-codex.ts", [
      /import \{ runCodexWeightProbe \}/,
      /await runCodexWeightProbe\(\)/,
    ]);
    const shellDup = await sourceHas("../../scripts/diagnose-codex.ts", [/CODEX_BASE_URL/]);
    out.push(
      assert(
        "★셸 진단이 본체 함수를 쓴다(자기 HTTP 사본을 갖지 않는다)",
        shellThin.ok && !shellDup.ok,
        shellThin.ok && !shellDup.ok
          ? "껍데기 확인"
          : shellDup.ok
            ? "자기 요청 사본이 되살아났다"
            : `누락 ${shellThin.missing.join(" ")}`,
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
