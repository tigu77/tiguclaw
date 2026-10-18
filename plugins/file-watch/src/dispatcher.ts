/**
 * file-watch dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * 라우팅·발송·관측(channel.message.out)은 core 의 단일 통로 deliverOutbound 가 담당한다
 * (src/core/outbound.ts) — scheduler·worker·부팅통지와 동일 로직이라 통로로 합쳤다(같은 걸
 * 두 번 구현 X). 여기선 watch 식별 라벨만 얹어 위임한다.
 *
 * watcher.ts 의 fireWatch 가 runClaude 결과를 여기로 보낸다(2026-10-09 — 종전엔 아무도 안 불러 dest_channel 이 장식이었다).
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { deliverOutbound, sessionOfDestination } from "../../../src/core/outbound.js";

export interface DispatchInput {
  watchId: number;
  destChannel: string;
  destTarget: string | null;
  text: string;
  bus: EventBus;
}

export const dispatch = async (input: DispatchInput): Promise<void> => {
  // ★미배달이면 **throw 한다** — 호출자(fireWatch)가 성공으로 기록하지 않게(scheduler dispatcher 와 같은 이유:
  //  deliverOutbound 는 미등록 채널 등에서 throw 없이 delivered:false 를 돌려준다).
  const r = await deliverOutbound({
    channel: input.destChannel,
    target: input.destTarget,
    text: input.text,
    bus: input.bus,
    label: `file-watch:${input.watchId}`,
    // 표시 세션 = 목적지가 가리키는 세션(대시보드 대화를 목적지로 잡았으면 그 대화, 아니면 기본 세션) — 판정은 코어 한 곳.
    observeThreadKey: sessionOfDestination(input.destChannel, input.destTarget),
  });
  if (!r.delivered) {
    throw new Error(`Watch delivery failed — ${r.reason ?? "not delivered"}`);
  }
};
