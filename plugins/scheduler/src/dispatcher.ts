/**
 * scheduler dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * V1 hardcoded 3종: telegram / cli / http-bridge. 그 외 = EventBus publish + warn.
 *
 * contract §3 매핑 표:
 *   telegram     → src/channels/telegram.ts 의 sendOutgoing(chatId, text)
 *   cli          → console.log (target 무시)
 *   http-bridge  → EventBus publish type="scheduler.fired" payload.threadKey=target
 *   else         → EventBus publish + console.warn
 *
 * 추가(2026-06-30): telegram·http-bridge 발신 시 `channel.message.out` 도 발행한다.
 * 스케줄러는 일반 라우트 핸들러를 우회하므로, 이게 없으면 능동 발신이 chat_log·대시보드
 * 채팅에 안 보인다(원칙 #4). cli 는 터미널 전용이라 제외. publishOut() 참조.
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { sendOutgoing as telegramSendOutgoing } from "../../../src/channels/telegram.js";

export interface DispatchInput {
  scheduleId: number;
  destChannel: string;
  destTarget: string | null;
  text: string;
  bus: EventBus;
}

// 능동 발신(스케줄)도 일반 답글과 똑같이 대시보드·이력에 보이게 한다. 스케줄러는 일반
// 라우트 핸들러(src/index.ts 의 channel.message.out 발행)를 우회하므로 여기서 명시 발행 —
// chat_log 가 이 이벤트를 기록하고 라이브 SSE 가 흘려 대시보드 채팅에 뜬다(원칙 #4 다채널
// 단일 인격). best-effort: 실패해도 실제 전송은 이미 끝났으니 throw 하지 않는다.
// threadKey 는 채널 관습(telegram=tg:<chatId>, src/channels/telegram.ts 와 동일).
const publishOut = (
  bus: EventBus,
  channel: string,
  threadKey: string,
  text: string,
): void => {
  try {
    bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: { channel, threadKey, text },
    });
  } catch {
    /* noop — 관측 발행 실패가 전송을 무르지 않는다. */
  }
};

export const dispatch = async (input: DispatchInput): Promise<void> => {
  const { destChannel, destTarget, text, bus, scheduleId } = input;

  if (destChannel === "cli") {
    console.log(`[scheduler:${scheduleId}] ${text}`);
    return;
  }

  if (destChannel === "telegram") {
    if (destTarget === null || destTarget.trim() === "") {
      throw new Error("telegram dest_target required (chatId)");
    }
    await telegramSendOutgoing(destTarget, text);
    publishOut(bus, "telegram", `tg:${destTarget}`, text); // 대시보드·이력에 표시.
    return;
  }

  if (destChannel === "http-bridge") {
    const threadKey = destTarget ?? "http-bridge:default";
    bus.publish({
      type: "scheduler.fired",
      ts: Date.now(),
      payload: { scheduleId, threadKey, text },
    });
    publishOut(bus, "http-bridge", threadKey, text); // 대시보드 채팅에 표시.
    return;
  }

  // V1 미지원 destination — EventBus publish + warn 만 (사일런트 실패 회피).
  console.warn(
    `[scheduler:${scheduleId}] unsupported dest_channel="${destChannel}" — publishing only`,
  );
  bus.publish({
    type: "scheduler.fired",
    ts: Date.now(),
    payload: {
      scheduleId,
      destChannel,
      destTarget,
      text,
      warning: "unsupported destination, publish only",
    },
  });
};
