/**
 * file-watch dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * 라우팅·발송·관측(channel.message.out)은 core 의 단일 통로 deliverOutbound 가 담당한다
 * (src/core/outbound.ts) — scheduler·worker·부팅통지와 동일 로직이라 통로로 합쳤다(같은 걸
 * 두 번 구현 X). 여기선 watch 식별 라벨만 얹어 위임한다.
 *
 * V1 watcher.ts 는 본 dispatcher 직접 호출 0 — file-watch 의도는 *발화 자체*(EventBus
 * publish). 응답 push 가 필요하면 fireWatch 안에서 본 dispatch 를 호출 추가 가능.
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { deliverOutbound } from "../../../src/core/outbound.js";

export interface DispatchInput {
  watchId: number;
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
    label: `file-watch:${input.watchId}`,
  });
};
