/**
 * scheduler dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * 라우팅·발송·관측(channel.message.out)은 core 의 단일 통로 deliverOutbound 가 담당한다
 * (src/core/outbound.ts). 예전엔 여기서 직접 채널 분기 + telegram 발송 + publishOut 을
 * 재구현했으나, file-watch·worker·부팅통지와 똑같은 로직이라 통로로 합쳤다(같은 걸 두 번
 * 구현 X). 여기선 스케줄 식별 라벨만 얹어 위임한다.
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { deliverOutbound } from "../../../src/core/outbound.js";

export interface DispatchInput {
  scheduleId: number;
  destChannel: string;
  destTarget: string | null;
  text: string;
  bus: EventBus;
}

export const dispatch = async (input: DispatchInput): Promise<void> => {
  await deliverOutbound({
    channel: input.destChannel,
    target: input.destTarget,
    text: input.text,
    bus: input.bus,
    label: `scheduler:${input.scheduleId}`,
  });
};
