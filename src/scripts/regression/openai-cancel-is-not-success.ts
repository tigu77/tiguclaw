/**
 * 회귀: **OpenAI 어댑터 — 취소·시한은 성공이 아니다** (2026-10-18, OpenAI 동등성 감사 P1 · 아스트라 회신 §1·§5).
 *
 * 사고(실행으로 재현): Agents SDK 는 abort 에 던지지 않고 run 루프를 끝낸다(`cancelled=true`). 어댑터는 `streamed.completed` 뒤 중단을
 *  안 봐서 `/stop`·턴 시한·도구 실행 중 취소가 전부 `text:""` **성공**이 됐고, 요약기는 중단된 조각을 성공 요약으로 돌려줘
 *  **잘린 요약이 저장되고 워터마크가 넘어갔다**(수정을 되돌린 변이에서 «요약조각0 … 잘린 요약이다» 가 워터마크 10 으로 저장됨).
 * ★이 검사가 처음으로 `runOpenAi` 를 **실제 SDK 루프 끝까지** 돌린다 — 종전 그물은 실모델 가드 때문에 순수 함수만 실행했다.
 *  주입은 `injectRegressionModel`(회귀 모드에서만), `fetch` 는 표식 없이 막는다(주입이 안 닿은 경로는 즉시 실패).
 *
 * 등급: **동작** — 자식 프로세스(`_openai-run-child.ts`)에서 시나리오 하나 = 프로세스 하나.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "_openai-run-child.ts");
type J = Record<string, unknown>;

const child = async (scenario: string): Promise<J> => {
  const r = await spawnWithin(60_000, `openai-run(${scenario})`, ["--import", "tsx", CHILD, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.timedOut) return { outcome: "timeout" };
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  try {
    return line === undefined ? { outcome: "no-output", err: r.err.slice(-300) } : (JSON.parse(line) as J);
  } catch {
    return { outcome: "bad-json", line };
  }
};
const show = (o: unknown): string => JSON.stringify(o).slice(0, 300);

export const check: RegressionCheck = {
  name: "openai-cancel-is-not-success",
  guards: "OpenAI 어댑터에서 /stop·턴 시한·도구 중 취소가 빈 답의 «성공» 이 되고, 요약 중 취소가 잘린 요약을 저장해 오래된 턴을 잃던 것 — SDK 가 abort 에 던지지 않는다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const names = ["complete", "external-tool", "abort-before-output", "abort-mid-text", "abort-mid-tool", "pre-aborted", "external-then-cancel", "summary-abort", "facade-complete", "facade-abort", "no-tools-fallback"];
    const r: Record<string, J> = {};
    for (const n of await Promise.all(names.map(async (s) => [s, await child(s)] as const))) r[n[0]] = n[1];

    out.push(assert("대조군 — 정상 완료는 답을 돌려준다(가짜 Model 이 실제 SDK 루프를 끝까지 탄다)",
      r.complete?.outcome === "returned" && r.complete.text === "끝", show(r.complete)));
    out.push(assert("대조군 — 외부 도구 캡처(stopAtToolNames 정상 종료)는 실패가 아니다",
      r["external-tool"]?.outcome === "returned" && r["external-tool"].external === 1, show(r["external-tool"])));
    out.push(assert("★첫 출력 전 /stop · 이미 취소된 입력 — 사용자 취소로 올라온다(빈 성공이 아니다)",
      r["abort-before-output"]?.name === "UserCancelledError" && r["pre-aborted"]?.name === "UserCancelledError" && r["pre-aborted"].calls === 0,
      show({ a: r["abort-before-output"], b: r["pre-aborted"] })));
    out.push(assert("★텍스트 중 턴 시한 — 시한 에러로 올라온다(부분 텍스트를 성공으로 돌려주지 않는다)",
      r["abort-mid-text"]?.outcome === "threw" && r["abort-mid-text"].name === "TurnTimeoutError" &&
        // 취소된 턴의 압축 설정으로 «턴 뒤 미리 접기» 를 돌리지 않는다(끊긴 신호라 요약 0회 · 거짓 «취소됨» 로그만 남았다).
        r["abort-mid-text"].postTurnJob === false,
      show(r["abort-mid-text"])));
    out.push(assert("★도구 실행 중 /stop — 사용자 취소로 올라온다",
      r["abort-mid-tool"]?.outcome === "threw" && r["abort-mid-tool"].name === "UserCancelledError", show(r["abort-mid-tool"])));
    out.push(assert("★외부 도구 수집 직후 사용자 취소 — 정상 종료로 덮지 않는다(취소가 이긴다)",
      r["external-then-cancel"]?.outcome === "threw" && r["external-then-cancel"].name === "UserCancelledError", show(r["external-then-cancel"])));
    out.push(assert("★요약 중 /stop — 턴이 취소로 올라오고, 잘린 요약은 저장되지 않는다(워터마크 그대로)",
      r["summary-abort"]?.outcome === "threw" && r["summary-abort"].name === "UserCancelledError" &&
        r["summary-abort"].summaryCalls === 1 && r["summary-abort"].summaryAfter === r["summary-abort"].summaryBefore &&
        // 드라이버가 «취소» 로 분류 — 실패로 세면 연속 실패 경보·폴드 예산 축소로 간다.
        r["summary-abort"].summaryCancelledLogged === true && r["summary-abort"].summaryFailureLogged === false &&
        // 요약이 끊긴 뒤 본 요청에 들어가지 않는다(모델 호출 = 요약 1회뿐).
        r["summary-abort"].calls === 1,
      show(r["summary-abort"])));
    out.push(assert("★facade(`runRegionA`) — 정상 완료는 turn_done, 취소는 사용자 취소로 올라오고 **turn_done(성공 기록)을 남기지 않는다**",
      r["facade-complete"]?.outcome === "returned" && JSON.stringify(r["facade-complete"].events) === '["llm.turn_done"]' &&
        r["facade-abort"]?.name === "UserCancelledError" && !JSON.stringify(r["facade-abort"].events).includes("llm.turn_done"),
      show({ ok: r["facade-complete"], abort: r["facade-abort"] })));
    out.push(assert("도구 미지원 모델 → 도구 없이 재시도 경로에도 주입이 닿는다(실제 SDK 루프 · 두 번째 호출에 답)",
      r["no-tools-fallback"]?.outcome === "returned" && r["no-tools-fallback"].text === "도구없이" && r["no-tools-fallback"].calls === 2,
      show(r["no-tools-fallback"])));
    // 주입점은 회귀 모드에서만 받는다 — 운영에서 실모델 가드를 여는 스위치가 아니다.
    const { TIGUCLAW_REGRESSION_NO_LIVE_MODEL: _flag, ...envNoFlag } = process.env;
    const outside = await spawnWithin(30_000, "inject-outside-regression", ["--import", "tsx", "-e",
      `import("${path.join(HERE, "../../core/llm-runtime/regression-model-guard.ts").replace(/\\/g, "/")}").then((g) => { try { g.injectRegressionModel({}); console.log("ACCEPTED"); } catch (e) { console.log("REFUSED " + e.message); } })`,
    ], { stdio: ["ignore", "pipe", "pipe"], env: envNoFlag });
    out.push(assert("주입점은 회귀 모드 밖에서 거절한다(가드를 여는 일반 스위치가 아니다)", /REFUSED/.test(outside.out), outside.out.trim().slice(0, 120) || outside.err.slice(-200)));
    return out;
  },
};
