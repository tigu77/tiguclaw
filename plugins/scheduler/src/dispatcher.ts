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
    return;
  }

  if (destChannel === "http-bridge") {
    bus.publish({
      type: "scheduler.fired",
      ts: Date.now(),
      payload: {
        scheduleId,
        threadKey: destTarget ?? "http-bridge:default",
        text,
      },
    });
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
