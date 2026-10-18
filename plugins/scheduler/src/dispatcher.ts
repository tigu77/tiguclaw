/**
 * scheduler dispatcher — virtual prompt 발화 결과를 destination channel 로 push.
 *
 * 라우팅·발송·관측(channel.message.out)은 core 의 단일 통로 deliverOutbound 가 담당한다
 * (src/core/outbound.ts). 예전엔 여기서 직접 채널 분기 + telegram 발송 + publishOut 을
 * 재구현했으나, file-watch·worker·부팅통지와 똑같은 로직이라 통로로 합쳤다(같은 걸 두 번
 * 구현 X). 여기선 스케줄 식별 라벨만 얹어 위임한다.
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import { deliverOutbound, sessionOfDestination } from "../../../src/core/outbound.js";

export interface DispatchInput {
  scheduleId: number;
  destChannel: string;
  destTarget: string | null;
  text: string;
  bus: EventBus;
}

export const dispatch = async (input: DispatchInput): Promise<void> => {
  // ★미배달이면 **throw 한다** — 호출자(runner)가 성공으로 기록하지 않게.
  //  종전엔 deliverOutbound 가 조용히 return 해서 `recordFiring(ok:true)` 가 찍혔다:
  //  매일 아침 LLM 을 태워 리포트를 만들고, 아무 데도 안 보내고, DB 엔 ok, 자가 점검은
  //  `last_status='error'` 만 보므로 **영영 안 잡혔다**(2026-07-31 전체검토 P1).
  //  여기서 throw 해도 안전하다 — runner 가 try/catch 로 감싸 `ok:false` 로 기록한다.
  const r = await deliverOutbound({
    channel: input.destChannel,
    target: input.destTarget,
    text: input.text,
    bus: input.bus,
    label: `scheduler:${input.scheduleId}`,
    // 표시 세션 = 목적지가 가리키는 세션(대시보드 대화를 목적지로 잡았으면 그 대화, 아니면 기본 세션) — 판정은 코어 한 곳.
    observeThreadKey: sessionOfDestination(input.destChannel, input.destTarget),
  });
  if (!r.delivered) {
    throw new Error(`Schedule delivery failed — ${r.reason ?? "not delivered"}`);
  }
};
