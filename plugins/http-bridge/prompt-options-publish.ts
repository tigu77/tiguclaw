/**
 * 대시보드 선택지 **발행 한 곳** — 인입 턴(`routes-chat` 의 presentOptions)과 좌표 발신(`outbound.presentOptionsTo`)이
 * 같이 쓴다 (2026-10-01). 두 벌이면 한쪽만 고쳐져 화면이 갈린다.
 *
 * 대시보드는 SSE 채널이라 inline keyboard 대신 `prompt.options` 이벤트를 낸다 — 화면이 버튼으로 그리고, 클릭 값을
 * POST /messages 로 흘려보낸다(사용자가 그 값을 입력한 것과 동치). 비차단: 1회 발행 후 즉시 결과.
 */
import type { EventBus } from "../../src/core/eventbus.js";

export const publishPromptOptions = (
  bus: EventBus | null,
  input: {
    channel: string;
    threadKey: string;
    question: string;
    options: { label: string; value: string }[];
    note?: string;
  },
): { ok: true } | { ok: false; error: string } => {
  if (bus === null) return { ok: false, error: "control bus not started (관측 미연결)" };
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
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
