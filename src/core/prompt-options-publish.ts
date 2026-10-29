/**
 * 대시보드 선택지 **발행 한 곳** — `prompt.options` 이벤트(대시보드가 버튼으로 그리고 대화 기록에 남는다).
 *
 * 부르는 곳은 둘이다: 코어 관측 래퍼(`prompt-options-observe.ts` — LLM 턴의 선택지 전부)와 http-bridge 의 직접 렌더
 *  (래퍼를 거치지 않는 슬래시 선택지 — `/sessions`·`/project` 는 그 채널에만 묻는다). 두 벌이면 한쪽만 고쳐져 화면이 갈린다.
 * ★2026-10-26 http-bridge 플러그인에서 옮겼다 — 코어 래퍼가 쓰려면 코어에 있어야 한다(코어는 플러그인을 import 하지 않는다).
 */
import type { ChannelMessageRef } from "../channels/types.js";
import type { EventBus } from "./eventbus.js";

export const publishPromptOptions = (
  bus: EventBus | null,
  input: {
    channel: string;
    threadKey: string;
    question: string;
    options: { label: string; value: string }[];
    note?: string;
    /** 발급 id — 대시보드가 답에 실어 보내 소비 판정(`prompt-answer-claims.ts`)을 받는다. 없으면(슬래시) 종전 그대로. */
    promptId?: string;
    /**
     * 답이 줄 서는 스레드 — 표시 세션(`threadKey`)과 다를 때만(대화 밖 작업의 질문, 2026-10-28). 서버가 정한 값이고 화면은 «바쁨»·✕ 취소 좌표로만 읽는다.
     *  답의 라우팅은 여전히 서버 대장(`promptReplySession`)이 정한다.
     */
    answerThreadKey?: string;
    /** 실제 송신 참조 — 공통 관측의 기존 한 행에 묶는다(없는 채널은 생략). */
    channelRefs?: (ChannelMessageRef & { channel: string })[];
  },
): { ok: true } | { ok: false; error: string } => {
  if (bus === null) return { ok: false, error: "control bus not started (observer not connected)" };
  try {
    bus.publish({
      type: "prompt.options",
      ts: Date.now(),
      payload: {
        channel: input.channel,
        threadKey: input.threadKey,
        question: input.question,
        options: input.options,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
        ...(input.answerThreadKey !== undefined ? { answerThreadKey: input.answerThreadKey } : {}),
        ...(input.channelRefs !== undefined ? { channelRefs: input.channelRefs } : {}),
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
