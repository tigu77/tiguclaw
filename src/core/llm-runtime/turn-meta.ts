/**
 * **턴을 시작할 때 «이 모델 · 이 강도» 를 한 번 알린다** — `llm.turn_meta` (2026-09-30 정태님).
 *
 * ★왜: 강도는 turn_done 에만 실렸다. 매니저 잡은 긴 턴 하나로 도는 일이 많아 **잡이 끝날 때까지 잡 카드에
 *  강도가 안 떴고**, 채팅 카드도 턴이 끝나야 붙었다. 강도는 턴을 시작할 때 이미 정해진다.
 * ★값은 **어댑터가 실제로 보낼 변수 그대로**다(부르는 자리 = 그 변수를 정한 자리). 파사드가 따로 계산하면 codex 의
 *  빈 모델 → 환경변수·기본 모델 같은 어댑터 규칙과 갈린다. 끝의 turn_done 이 최종값이다(여기는 먼저 보이는 것뿐).
 * ★`reasoning` 이 없으면 «보내지 않음» — 화면이 그 모델의 기본으로 읽는다(Claude 는 실행기가 모델별 기본을 보낸다).
 */
import { getEventBus } from "../eventbus.js";

export const publishTurnMeta = (input: {
  threadKey: string;
  internal?: boolean;
  adapter: string;
  model: string | undefined;
  reasoning: string | undefined;
}): void => {
  // 분류성 내부 호출은 턴 이벤트를 안 낸다(turn_done 과 같은 규칙).
  if (input.internal === true || typeof input.model !== "string" || input.model.trim() === "") return;
  try {
    getEventBus().publish({
      type: "llm.turn_meta",
      ts: Date.now(),
      payload: {
        threadKey: input.threadKey,
        adapter: input.adapter,
        model: input.model.trim(),
        ...(typeof input.reasoning === "string" && input.reasoning !== "" ? { reasoning: input.reasoning } : {}),
      },
    });
  } catch (e) {
    console.error("llm-runtime: turn_meta publish failed:", e);
  }
};
