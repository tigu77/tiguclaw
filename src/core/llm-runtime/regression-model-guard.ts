/** Automatic regression only. Set by its bootstrap before any product imports.
 * Not a product permission policy or a live-E2E switch. Latch the inherited flag
 * so a test clearing its environment cannot enable a real adapter in this process.
 */
const regressionNoLiveModel = process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL === "1";

/**
 * **명시적 가짜 네트워크** 표식 (2026-09-23).
 *
 * ★가드가 네트워크를 이미 가짜로 바꾼 검사까지 막고 있었다 — `globalThis.fetch` 를 스텁으로
 *  끼우고 Codex 어댑터를 실제로 돌리는 것이 이 레포의 주된 검사 방식인데(세션 ID·추론 재주입·
 *  저장 화면·취소 등), 가드가 그것과 실제 호출을 구분하지 못했다.
 * ★판정은 «지금 `fetch` 에 이 표식이 붙어 있나» 하나다 — 로드 순서와 무관하고, 테스트 코드에
 *  `fakeNetwork(...)` 로 **보이게** 적힌다(숨은 우회가 아니다). 표식 없는 스텁은 계속 막힌다.
 * ★**fetch 로만 통신하는 입구**에만 적용한다 — Claude 는 SDK 서브프로세스라 `fetch` 스텁으로
 *  막을 수 없고, OpenAI 는 SDK 내부 경로라 계속 엄격하다.
 */
export const FAKE_NETWORK = Symbol.for("tiguclaw.regression.fakeNetwork");
const networkIsFaked = (): boolean =>
  (globalThis.fetch as unknown as Record<symbol, unknown> | undefined)?.[FAKE_NETWORK] === true;

export const assertLiveModelAllowed = (opts?: { fetchOnly?: boolean }): void => {
  if (!(regressionNoLiveModel || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL === "1")) return;
  if (opts?.fetchOnly === true && networkIsFaked()) return;
  throw new Error("REGRESSION_LIVE_MODEL_BLOCKED: automatic regression requires an explicit fake adapter");
};
