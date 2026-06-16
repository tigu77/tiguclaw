/**
 * file-watch dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * V1 hardcoded 3종 (scheduler dispatcher 동형, 외부 작성자 reference 가시성 위해 직접 작성):
 *   telegram     → src/channels/telegram.ts 의 sendOutgoing(chatId, text)
 *   cli          → console.log (target 무시)
 *   http-bridge  → EventBus publish type="file-watch.fired" payload.threadKey=target
 *   else         → EventBus publish + console.warn
 *
 * V1 watcher.ts 는 본 dispatcher 직접 호출 0 — file-watch 의도는 *발화 자체* (EventBus publish 만).
 * scheduler 처럼 응답 push 가 필요한 케이스는 watcher.ts 의 fireWatch 안에서 본 dispatcher 호출
 * 추가 가능. 외부 작성자 자기 trigger plugin 에서 자유 결정.
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { sendOutgoing as telegramSendOutgoing } from "../../../src/channels/telegram.js";

export interface DispatchInput {
  watchId: number;
  destChannel: string;
  destTarget: string | null;
  text: string;
  bus: EventBus;
}

export const dispatch = async (input: DispatchInput): Promise<void> => {
  const { destChannel, destTarget, text, bus, watchId } = input;

  if (destChannel === "cli") {
    console.log(`[file-watch:${watchId}] ${text}`);
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
      type: "file-watch.fired",
      ts: Date.now(),
      payload: {
        watchId,
        threadKey: destTarget ?? "http-bridge:default",
        text,
      },
    });
    return;
  }

  // V1 미지원 destination — EventBus publish + warn 만 (사일런트 실패 회피).
  console.warn(
    `[file-watch:${watchId}] unsupported dest_channel="${destChannel}" — publishing only`,
  );
  bus.publish({
    type: "file-watch.fired",
    ts: Date.now(),
    payload: {
      watchId,
      destChannel,
      destTarget,
      text,
      warning: "unsupported destination, publish only",
    },
  });
};
