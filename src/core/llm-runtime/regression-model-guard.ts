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

/**
 * **회귀 전용 가짜 Model 주입점** (2026-10-18, OpenAI 동등성 아스트라 회신 §5).
 *
 * ★OpenAI 어댑터는 SDK 내부 경로라 `fetch` 표식으로 열 수 없었고, 그래서 회귀가 `runOpenAi` 를 끝까지 한 번도 못 돌렸다
 *  (취소가 «빈 성공» 이 된 결함이 그 사각에 있었다). 가드를 여는 대신 **실제 SDK 루프에 끼울 Model 을 주입**한다.
 * ★회귀 모드(위 latch)가 아니면 던진다 — 운영 입력·환경변수로 가드를 여는 일반 스위치가 아니다. «Model 객체라서 통과» 도 아니다
 *  (실제 호환 서버도 Model 객체로 붙는다). 어댑터는 주입이 **있을 때만** 실모델 가드를 건너뛰고, 모든 모델 생성 자리가 이 값을 쓴다.
 */
let injectedRegressionModel: unknown;
export const injectRegressionModel = (model: unknown): void => {
  if (!(regressionNoLiveModel || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL === "1")) {
    throw new Error("injectRegressionModel: regression mode only");
  }
  injectedRegressionModel = model;
};
export const regressionModel = (): unknown => injectedRegressionModel;
