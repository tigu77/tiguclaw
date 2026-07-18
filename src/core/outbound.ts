/**
 * deliverOutbound — 능동·직접 발신의 *단일 통로*.
 *
 * 채널 라우팅 + 실제 발송 + 관측(`channel.message.out`) 발행을 한 곳에서 한다. 스케줄러·
 * file-watch·worker 완료·부팅 통지 등 *일반 턴 답글 핸들러를 우회하는* 모든 발신이 이걸
 * 통과한다. 이전엔 이 셋(라우팅·발송·관측)을 각 발신처가 제각각 재구현해, 어떤 경로는
 * 대시보드에 보이고(관측 발행함) 어떤 건 안 보이는(빠뜨림) 불일치가 있었다. 이 통로로
 * 모아 그 부류를 없앤다(단순·견고, 같은 걸 두 번 구현 X).
 *
 * 단방향 불변식(§6, ADR 2026-07-16 §D6 강화): core 함수다. 채널 이름을 하드코딩하지 않고
 * 채널 outbound 레지스트리(`channel-outbound.ts`)를 *조회*만 한다 — 채널(코어·플러그인)이
 * 자기 `deliver`/`defaultOutboundTarget` 를 데이터로 등록하고(plugin→core, startChannel
 * duck-typing 과 동형) 코어는 telegram/http-bridge 문자열·telegram import 를 알지 않는다.
 * 플러그인이 이 함수를 부르는 건 허용(plugin→core).
 */
import type { EventBus } from "./eventbus.js";
import { getEventBus } from "./eventbus.js";
import {
  getChannelOutbound,
  threadKeyForObservation,
} from "./channel-outbound.js";

export interface OutboundInput {
  /** 목적지 채널명 — "telegram" | "cli" | "http-bridge" | (그 외=미지원). */
  channel: string;
  /** 채널 내 목적지 — telegram=chatId, http-bridge=threadKey. cli 는 무시. */
  target: string | null;
  text: string;
  /** 관측 발행용 bus. 생략 시 getEventBus(). */
  bus?: EventBus;
  /** cli/미지원 로그 접두 라벨(예: "scheduler:3"). */
  label?: string;
  /**
   * 관측(`channel.message.out`) 발행 여부(additive, 기본 true) — 물리 발송(telegram send 등)은
   * 이 값과 무관하게 항상 수행한다. false 는 *핸들러(index.ts)가 관측을 발행하는 재주입 경로*
   * 전용 — 워커 done 재주입 reply 가 물리 발송만 하고 관측은 핸들러 성공분기 단일 지점에
   * 위임해, 일반 turn 과 대칭(대시보드 이중 버블 0)을 이루게 한다. 우회 통지(handler 미경유:
   * failed/cancelled·done 안전망·부팅 복구)는 이 값을 지정하지 않아 기본 true = 관측 유지.
   */
  observe?: boolean;
  /**
   * 관측(세션 귀속)용 threadKey — 배달 좌표(channel/target)와 **독립**. 세션을 아는 caller 가
   * 채운다(예: 스케줄·워커·통지가 `dashboard:default` 등 세션 id 를 실어보냄). 미전달 시 현행
   * 물리 채널 키(`threadKeyForObservation`) 폴백 = 회귀 0. §D3 정체성/표시 2분리: 관측
   * threadKey 는 *세션*이며 채널은 payload.channel 이 운반한다. opaque 문자열(세션 id)로만
   * 받는다 — 세션→값 결정은 caller(plugin) 몫(§0 단방향: 코어는 채널명 분기·telegram import 없음).
   */
  observeThreadKey?: string;
}

// 관측(channel.message.out) 발행 — 대시보드 chat_log·라이브 SSE 가 이걸 받아 능동 발신도
// 일반 답글처럼 보여준다(원칙 #4). best-effort: 관측 발행 실패가 실제 전송을 무르지 않는다.
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

/**
 * (channel, target) 로 text 를 발송하고 `channel.message.out` 를 발행한다.
 * 채널 outbound 레지스트리 조회로 라우팅(ADR 2026-07-16 §D1, switch→데이터 등록):
 *   등록됨 + deliver 有  → 물리 발송(telegram=sendOutgoing) + (observe 면) publishOut
 *   등록됨 + deliver 無  → 관측-전용(http-bridge). publishOut 이 대시보드 SSE 배달
 *   미등록               → console.warn(사일런트 실패 회피). 실제 전달 수단 없음
 * target 미지정 시 채널의 `defaultOutboundTarget()` 로 해석(telegram=owner chatId 등).
 * 전송 실패(예: telegram target 없음)는 채널 `deliver` 가 throw — 호출자가 판단(부팅 통지
 * 등은 best-effort catch, 스케줄러는 last_status 에 반영). 관측 발행만 실패하는 건 삼켜진다.
 */
export const deliverOutbound = async (input: OutboundInput): Promise<void> => {
  const { channel, target, text, label } = input;
  const bus = input.bus ?? getEventBus();
  const observe = input.observe !== false; // 기본 true; false 만 관측 억제(물리 발송 불변).
  const tag = label !== undefined ? `[${label}] ` : "";

  const o = getChannelOutbound(channel);
  if (o === undefined) {
    // 미등록 채널 — 사일런트 실패 회피(정직 경고). 실제 전달 수단 없음(현행 switch default).
    console.warn(
      `deliverOutbound: unsupported channel "${channel}" (target=${
        target ?? "—"
      }) — no delivery:\n${tag}${text}`,
    );
    return;
  }

  // target 해석: 명시 target 우선, 없으면 채널의 기본 좌표(defaultOutboundTarget).
  const resolved =
    target ??
    (o.defaultOutboundTarget !== undefined
      ? await o.defaultOutboundTarget()
      : null);

  // 물리 발송(deliver 있는 채널만) — telegram=sendOutgoing. 관측-전용(http-bridge)은 스킵.
  if (o.deliver !== undefined) await o.deliver(resolved, text);

  // 관측은 항상(채널무관) — 대시보드 chat_log·라이브 SSE(원칙 #4). observe:false 만 억제.
  // 관측 threadKey = caller 가 준 세션 id(observeThreadKey) 우선, 없으면 물리 채널 키 폴백
  //  (회귀 0). 배달 좌표(channel/target)와 세션 귀속의 분리 — §D3.
  if (observe) {
    publishOut(
      bus,
      channel,
      input.observeThreadKey ?? threadKeyForObservation(channel, resolved),
      text,
    );
  }
};
