/**
 * 라우터 — 입력 메시지를 LLM 런타임으로 dispatch.
 *
 * 진실 소스: `_workspace/region_unification_architect_contract.md` (결정 1·2).
 * V8 영역 통합: 영역 A/B 구분·prefix·분류 전부 폐기. 단일 파이프라인 pass-through.
 * 깊은 사고는 prefix 가 아니라 비서가 부리는 능력(서브에이전트 모델 지정 경로).
 */
import type { IncomingMessage } from "../channels/types.js";
import {
  clearSessionModelOverride,
  getSessionModelOverride,
} from "../store/sessions.js";
import { runClaude } from "./claude.js";
import { parseModelSpecList } from "./llm-runtime/index.js";
import { getRegisteredMcpServers } from "./mcp-registry.js";

export interface RouteOutput {
  text: string;
  /**
   * LLM 런타임 output 에서 그대로 전달 — 이 turn 응답을 트리거 메시지 직접 답글로 마킹.
   */
  replyToTrigger?: boolean;
  /**
   * 세션 모델 override 가 런타임에 거부되어 자동 폴백했음을 호출자에게 통과.
   * (고지 문구는 이미 text 에 facade 가 덧붙였음 — 이 필드는 관측/메타 용.)
   */
  modelOverrideRejected?: { requested: string; fellBackTo: string };
}

export const route = async (
  msg: IncomingMessage,
  // 2층 턴 타임아웃 신호 (additive, 2026-06-17). 핸들러가 턴당 AbortController 의
  // signal 을 운반 → runRegionA(input.abortSignal) → 어댑터가 1층 idle AC 와 OR 결합.
  // 미전달(스케줄러 등 비채널 turn) = undefined = 현행 1층-only 동작 그대로(회귀 0, TT-I7).
  // router 는 신호를 *소비하지 않고 그대로 운반만* 한다(router 순수성 유지).
  //
  // toolPolicy (additive, 2026-06-18, custom-endpoints contract §7-3): 이 턴에 적용할
  // 도구 정책. 커스텀 HTTP 엔드포인트(restricted=mode:none)가 무인 full-turn 의 blast
  // radius 를 가두기 위해 주입한다. abortSignal 운반과 완전 동형 — router 는 값을
  // *소비/해석하지 않고* runClaude input.toolPolicy 로 그대로 운반만 한다(router 순수성).
  // 미전달(채널·스케줄러 등 기존 호출자) = undefined = 전체 도구 = 현행 동작(회귀 0).
  opts?: {
    abortSignal?: AbortSignal;
    toolPolicy?: { mode: "none" } | { mode: "allow"; names: string[] };
  },
): Promise<RouteOutput> => {
  // 세션 모델 override (`/model <provider:model[,provider:model...]>` 로 설정) 조회.
  // 콤마 멀티스펙 풀 지원(2026-06-02) — 단일에서 풀로 확장.
  // 있으면 풀(여러 spec)로 runClaude 에 주입 → resolveModelSpecs 가 opts.specs 우선
  // → env 폴백 무시. runPool 이 풀 순서대로 시도(첫 성공 반환) → 풀 내 폴백은 이미 됨.
  // 빈 풀(유효 0) → specs 미주입 → 기존 동작(REGION_A_MODELS env 풀) 그대로.
  // override 풀 *전체*가 모델거부로 소진되면 facade 가 env 풀로 1회 폴백 +
  // modelOverrideRejected 신호 → 아래에서 깨진 override DB clear (의미 불변).
  // canonical 저장(`/model` 핸들러) 덕에 parseModelSpecList 는 항상 성공이나, DB 에
  // 구버전 무효 문자열이 남아있을 가능성 대비 빈 풀 가드 유지(env 폴백).
  const overrideRaw = getSessionModelOverride(msg.channel, msg.threadKey);
  const overridePool =
    overrideRaw !== null ? parseModelSpecList(overrideRaw) : [];

  const out = await runClaude(
    {
      text: msg.text,
      threadKey: msg.threadKey,
      channel: msg.channel,
      attachments: msg.attachments,
      sendAttachment: msg.sendAttachment,
      // 축1(2026-06-25) — 선택지 제시 클로저를 sendAttachment 와 동일 경로로 운반.
      presentOptions: msg.presentOptions,
      extraMcpServers: getRegisteredMcpServers(),
      // 2층 턴 타임아웃 — 핸들러가 만든 turn signal 을 어댑터까지 운반. 미전달 시
      // undefined → 어댑터가 idle AC 만 link → 1층-only(회귀 0, TT-I7).
      abortSignal: opts?.abortSignal,
      // 도구 정책 운반(custom-endpoints §7-3) — 미전달 시 undefined = 전체 도구(회귀 0).
      toolPolicy: opts?.toolPolicy,
    },
    overridePool.length > 0 ? { specs: overridePool } : undefined,
  );
  // override 가 런타임에 거부되어 폴백한 경우 — 깨진 override 를 DB 에서 제거해
  // 다음 turn 정상화 (매 turn 경고 반복 방지). DB 쓰기는 router 경유(facade 는 순수).
  // 사용자가 다시 `/model` 로 지정하기 전까지는 env 풀(기본)로 동작.
  if (out.modelOverrideRejected !== undefined) {
    clearSessionModelOverride(msg.channel, msg.threadKey);
    console.warn(
      `route: model override '${out.modelOverrideRejected.requested}' rejected → ` +
        `cleared (fell back to '${out.modelOverrideRejected.fellBackTo}') ` +
        `channel=${msg.channel} thread=${msg.threadKey}`,
    );
  }
  console.log(
    `route channel=${msg.channel} thread=${msg.threadKey}` +
      (overrideRaw !== null ? ` model_override=${overrideRaw}` : ""),
  );
  return {
    text: out.text,
    replyToTrigger: out.replyToTrigger,
    modelOverrideRejected: out.modelOverrideRejected,
  };
};
