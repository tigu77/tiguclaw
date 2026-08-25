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
import { recordOutboundMessage } from "../store/outbound-messages.js";
import {
  getChannelOutbound,
  listOutboundChannels,
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
   * 이 배달이 **이미 기록된 말의 사본**인가 (2026-08-25). egress fan-out 전용.
   *
   * 사고: 대시보드에서 답한 말이 텔레그램으로도 나가면서 `chat_log` 에 **두 줄**이 됐다
   * (원본 `dashboard:default` + 사본 `tg:<id>`). 대화는 한 번 일어난 일인데 기록이 둘이면
   * 검색·이력·컨텍스트에 같은 말이 두 번 잡힌다 — **배달이 는다고 대화가 늘지 않는다.**
   * 물리 발송·답장 라우팅(`recordOutboundMessage`)은 그대로, **적재만** 건너뛴다.
   */
  copyOfRecorded?: boolean;
  /**
   * 관측(세션 귀속)용 threadKey — 배달 좌표(channel/target)와 **독립**. 세션을 아는 caller 가
   * 채운다(예: 스케줄·워커·통지가 `dashboard:default` 등 세션 id 를 실어보냄). 미전달 시 현행
   * 물리 채널 키(`threadKeyForObservation`) 폴백 = 회귀 0. §D3 정체성/표시 2분리: 관측
   * threadKey 는 *세션*이며 채널은 payload.channel 이 운반한다. opaque 문자열(세션 id)로만
   * 받는다 — 세션→값 결정은 caller(plugin) 몫(§0 단방향: 코어는 채널명 분기·telegram import 없음).
   */
  observeThreadKey?: string;
  /**
   * **이 말을 낸 세션** — 답장 라우팅(그 메시지에 답하면 그 세션으로)의 재료.
   *
   * ★`observeThreadKey` 와 갈라놓은 이유 (2026-08-11 실사고): 그 필드는 *"어디에 표시할까"*
   *  를 정하는데, 답장 매핑은 *"누가 한 말인가"* 를 묻는다. **질문이 다르다.** 한 필드가
   *  둘을 겸하니 egress fan-out(대화방에 복사로 보내는 경로)이 표시 중복을 피하려고 그 필드를
   *  비웠고, 그 순간 **답장 매핑까지 같이 사라졌다** — 사용자가 텔레그램에서 그 답에
   *  답장했더니 원래 세션이 아니라 공통 세션으로 들어갔다.
   *
   *  미전달 시 `observeThreadKey` 폴백 = 기존 호출부 전부 회귀 0.
   */
  originThreadKey?: string;
  /**
   * **시스템 통지**인가(기본 false = 비서 발화).
   *
   * ★사용자 신고(2026-07-27): 작업 중 메시지를 보냈더니 "⏳ 도구에서 멈춰 있어요" 가 도착해
   *  "이런 메시지가 나한테 *응답으로* 오는데?" — 스케줄 실패·자가 점검 같은 인프라 통지가
   *  비서가 한 말과 **완전히 같은 모양**으로 대화에 들어가고 있었다(chat_log 도 role=assistant).
   *  통지를 없애는 건 관측을 버리는 것이라 답이 아니고, 진짜 문제는 *구분이 없다* 는 것이다.
   *  그래서 여기서 **의도만** 표시하고, 어떻게 보일지는 각 채널 렌더가 정한다(§0 단방향 —
   *  코어는 채널명으로 분기하지 않는다).
   */
  notice?: boolean;
}

// 관측(channel.message.out) 발행 — 대시보드 chat_log·라이브 SSE 가 이걸 받아 능동 발신도
// 일반 답글처럼 보여준다(원칙 #4). best-effort: 관측 발행 실패가 실제 전송을 무르지 않는다.
// threadKey 는 채널 관습(telegram=tg:<chatId>, src/channels/telegram.ts 와 동일).
const publishOut = (
  bus: EventBus,
  channel: string,
  threadKey: string,
  text: string,
  notice: boolean,
  copy = false,
): void => {
  try {
    bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      // notice = 시스템 통지(비서 발화 아님). false 면 키 자체를 생략해 기존 소비자 회귀 0.
      payload: {
        channel,
        threadKey,
        text,
        ...(notice ? { notice: true } : {}),
        // ★사본 표식 — 이미 다른 좌표에 기록된 말의 **복사 배달**이다(egress fan-out).
        //  발행은 하고(라이브 신호는 살린다) `event-persist` 가 **적재만** 건너뛴다.
        //  `ephemeral` 과 같은 결이다 — 발행을 끄면 그 이벤트에 얹힌 다른 일까지 꺼진다.
        ...(copy ? { copyOfRecorded: true } : {}),
      },
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
/**
 * 배달 결과 — 호출자가 성공/실패를 **알 수 있어야** 한다 (2026-07-31 전체검토 P1).
 * throw 대신 반환값인 이유: 호출부 5곳이 `void deliverOutbound(...)` 로 띄우고 있어
 * throw 로 바꾸면 unhandled rejection → crash-fast 가 된다(고치려던 것보다 큰 사고).
 */
export interface OutboundResult {
  readonly delivered: boolean;
  /** 미배달 사유(사람이 읽는 한 줄). delivered=true 면 undefined. */
  readonly reason?: string;
}

export const deliverOutbound = async (
  input: OutboundInput,
): Promise<OutboundResult> => {
  const { channel, target, text, label } = input;
  const bus = input.bus ?? getEventBus();
  const observe = input.observe !== false; // 기본 true; false 만 관측 억제(물리 발송 불변).
  const tag = label !== undefined ? `[${label}] ` : "";

  const o = getChannelOutbound(channel);
  if (o === undefined) {
    // ★미등록 채널 = **배달 실패**다. 종전엔 warn 만 찍고 조용히 return 했고, 호출한
    //  스케줄러는 그걸 성공으로 보고 `recordFiring(ok:true)` + `scheduler.fired{ok:true}`
    //  를 남겼다 — 매일 아침 LLM 을 태워 리포트를 만들고, 아무 데도 안 보내고, DB 엔 ok,
    //  대시보드엔 아무것도, 자가 점검은 `last_status='error'` 만 보므로 **영영 안 잡힘**.
    //  실경로: TELEGRAM_BOT_TOKEN 부재 → 채널이 outbound 미등록 → 여기로 온다.
    const known = listOutboundChannels();
    const reason =
      `발송 채널 "${channel}" 이 등록돼 있지 않습니다` +
      `${known.length > 0 ? ` (사용 가능: ${known.join(", ")})` : " (등록된 채널 없음)"}`;
    console.warn(
      `deliverOutbound: ${reason} (target=${target ?? "—"}) — 미배달 ${text.length}자${
        label !== undefined ? ` [${label}]` : ""
      }`,
    );
    return { delivered: false, reason };
  }

  // target 해석: 명시 target 우선, 없으면 채널의 기본 좌표(defaultOutboundTarget).
  const resolved =
    target ??
    (o.defaultOutboundTarget !== undefined
      ? await o.defaultOutboundTarget()
      : null);

  // 물리 발송(deliver 있는 채널만) — telegram=sendOutgoing. 관측-전용(http-bridge)은 스킵.
  const sent = o.deliver !== undefined ? await o.deliver(resolved, text) : undefined;

  // ★"이 메시지는 어느 세션 것" 기록 (2026-08-10) — 그 메시지에 **답장하면 그 세션으로**
  //  라우팅하기 위한 재료. egress 로 한 대화방에 여러 세션의 답이 섞여 오면서 필요해졌다.
  //  채널이 id 를 안 주거나(계약상 선택) 세션을 모르면 그냥 건너뛴다 = 기존 동작.
  const sentIds =
    sent !== undefined && sent !== null && Array.isArray(sent.messageIds)
      ? sent.messageIds
      : [];
  // 귀속은 originThreadKey 가 정본이고, 없으면 observeThreadKey 로 폴백한다(회귀 0).
  const originKey = input.originThreadKey ?? input.observeThreadKey;
  if (sentIds.length > 0 && resolved !== null && originKey !== undefined) {
    const now = Date.now();
    for (const mid of sentIds) {
      recordOutboundMessage(channel, resolved, mid, originKey, now);
    }
  }

  // 관측은 항상(채널무관) — 대시보드 chat_log·라이브 SSE(원칙 #4). observe:false 만 억제.
  // 관측 threadKey = caller 가 준 세션 id(observeThreadKey) 우선, 없으면 물리 채널 키 폴백
  //  (회귀 0). 배달 좌표(channel/target)와 세션 귀속의 분리 — §D3.
  if (observe) {
    publishOut(
      bus,
      channel,
      input.observeThreadKey ?? threadKeyForObservation(channel, resolved),
      text,
      input.notice === true,
      input.copyOfRecorded === true,
    );
  }
  return { delivered: true };
};
