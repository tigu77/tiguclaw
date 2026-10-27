/**
 * **LLM 턴 선택지의 관측은 코어가 한 번** (2026-10-26, 설계 `docs/decisions/2026-10-26-prompt-options-observation-and-telegram-session-label.md` §A2).
 *
 * ★사고(격리 재현): 텔레그램에서 시작한 턴이 `prompt_options` 를 부르면 텔레그램엔 버튼이 가고 도구는 `ok:true` 인데,
 *  대시보드엔 `prompt.options` 가 **0건**이었다(새로고침해도 없음). 답 글은 채널이 보내고 관측(`channel.message.out`)은
 *  코어가 세션 키로 한 번 내는데, 선택지만 그 처방이 없어 **http-bridge 가 직접 그릴 때만** 대시보드에 떴다.
 *  텔레그램 목적지의 매니저 완료·점검·대화 안 트리거·대화 밖 스케줄도 같은 모양이었다.
 *
 * ★한 줄: 렌더가 한 곳 이상 성공하면 **그 턴의 답이 보이는 세션**에 관측을 정확히 한 번 낸다. 채널은 보내기만 한다.
 * ★발행 소유권은 **경로**로 가른다(설계 R1-1) — 이 래퍼를 지난 호출엔 `observedByCore: true` 를 실어 관측 채널(http-bridge)이
 *  대상과 무관하게 직접 발행하지 않게 한다. 표식 없는 호출(슬래시 선택지)만 채널이 직접 그린다(그 채널 한정 의미 보존).
 * ★질문마다 발급 id 를 붙인다 — 같은 질문이 여러 채널에 살 때 답은 한 번만 처리된다(`prompt-answer-claims.ts`).
 * ★채널 이름 하드코딩 0, 순수 조합 함수 — 배달·발행을 주입받아 그대로 동작 검사가 된다.
 */
import type { IncomingMessage } from "../channels/types.js";
import type { EventBus } from "./eventbus.js";
import { getEventBus } from "./eventbus.js";
import { issuePromptId } from "./prompt-answer-claims.js";
import { publishPromptOptions } from "./prompt-options-publish.js";

export const withPromptOptionsObservation = (
  present: IncomingMessage["presentOptions"],
  at: {
    /** 관측 payload 의 채널(누가 물었나 표시용). */
    channel: string;
    /** 관측 세션 — 그 턴의 답이 보이는 세션. */
    threadKey: string;
    /** 답 처리 세션이 표시 세션과 다를 때(대화 밖 스케줄)만 명시한다. */
    replyToSession?: string;
    /** 생략하면 전역 버스. */
    bus?: EventBus;
  },
): IncomingMessage["presentOptions"] => {
  // 렌더할 곳이 없으면 도구를 안 붙인다(종전 그대로) — 관측만 있는 «선택지» 는 답이 돌아올 통로가 없다.
  if (present === undefined) return undefined;
  return async (question, options, opts) => {
    const promptId = issuePromptId(at.replyToSession ?? at.threadKey);
    const r = await present(question, options, {
      ...(opts?.note !== undefined ? { note: opts.note } : {}),
      promptId,
      observedByCore: true,
    });
    // 렌더 전부 실패면 관측도 없다 — 도구가 텍스트로 폴백하고, 그 글이 답과 함께 양쪽에 보인다.
    if (!r.ok) return r;
    const p = publishPromptOptions(at.bus ?? getEventBus(), {
      channel: at.channel,
      threadKey: at.threadKey,
      question,
      options,
      ...(opts?.note !== undefined ? { note: opts.note } : {}),
      promptId,
      ...(r.channelRefs !== undefined ? { channelRefs: r.channelRefs } : {}),
    });
    if (!p.ok) {
      // 관측 실패가 렌더를 무르지 않는다 — 사용자는 다른 채널에서 이미 받았다. 조용히 넘기지는 않는다.
      console.error(`선택지 관측 발행 실패(렌더는 성공) — thread=${at.threadKey}: ${p.error}`);
    }
    return r;
  };
};
