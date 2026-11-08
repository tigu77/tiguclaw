// src/core/entry/reply-command.ts
/**
 * **명령 응답** — 진입점에서 꺼낸 자리 (2026-09-05 구조 감사 ③).
 *
 * ★자족 함수였다(이벤트 버스와 본문 상한만 쓴다). 그런데 `src/index.ts` 안에 살아서, 명령
 *  본문을 코어로 옮기는 순간 «코어가 진입점을 import» 하는 거꾸로가 될 뻔했다. 방향이
 *  뒤집히면 다음 사람은 순환을 풀려고 **사본**을 만든다 — 그래서 함수가 여기로 왔다.
 * ★호출부(진입점 20곳)는 한 글자도 안 바뀐다 — import 만 늘었다.
 */
import { getEventBus, type EventBus } from "../eventbus.js";
import { translate } from "../i18n.js";
import { channelRefsField } from "../event-persist.js";
import { turnSpend } from "../llm-runtime/turn-spend.js";
import type { RouteOutput } from "../router.js";
import type { ChannelMessageRef } from "../../channels/types.js";

/** 관측 이벤트에 싣는 본문 상한 — 진입점과 명령 응답이 **같은 값**을 써야 한다. */
export const EVENT_TEXT_MAX = 50_000;

/** 송신 이벤트의 좌표 — 대화 기록에 그 이벤트가 남긴 행을 «같은 대화 · 정확히 같은 시각» 으로 짚는 재료. */
export interface OutCoords {
  threadKey: string;
  ts: number;
}

/**
 * 송신 이벤트(`channel.message.out`)를 발행하고 **그 이벤트의 좌표**를 돌려준다 (2026-10-25).
 * ★egress 사본이 원본 행을 짚는 좌표를 만드는 곳은 여기 하나다 — 시각을 한 번 만들어 발행과 반환에 같이 쓴다
 *  (따로 `Date.now()` 를 부르면 1ms 어긋나 원본을 못 찾는다). 적재는 버스 구독자(`event-persist`)가 동기로 한다.
 */
export const publishReplyOut = (bus: EventBus, payload: { threadKey: string } & Record<string, unknown>): OutCoords => {
  const ts = Date.now();
  bus.publish({ type: "channel.message.out", ts, payload });
  return { threadKey: payload.threadKey, ts };
};

/**
 * **이 턴의 최종 답을 생략하나** — 판정 한 곳(2026-11-01, `docs/decisions/2026-11-01-notify-owner-report-contract.md` §3-3·§3-4).
 *  허용(메시지의 `reportDefault`) × 생략 증명(런타임 출력 — 어댑터가 깨끗한 종료에서만 싣고 호스트 안내가 붙으면 지워진 값) × 덧붙인 안내 없음(Stop 훅).
 *  ★허용 없는 메시지면 출력에 증명이 있어도 **무시한다** — 완료 재주입·raw 안전망의 경계가 이 한 조건이다.
 */
export const omitsTurnReport = (
  msg: { reportDefault?: "omit" },
  out: { reportOmitted?: true },
  appended: string,
): boolean => msg.reportDefault === "omit" && out.reportOmitted === true && appended === "";

/**
 * 턴 결과의 마지막 단계 — **생략이면 «내부 처리» 통지만 내고 돌아가고, 아니면 `deliver`(채널 답·기록·사본·제안)를 부른다.**
 *  채널로 나가는 일은 전부 `deliver` 안에만 있다 — 생략 갈래는 구조상 그걸 부를 수 없다(진입점이 그렇게 넘긴다).
 *  `deliver` 가 던지면(전송 실패) 그대로 올린다 — 생략으로 바꾸지 않는다(전달 실패 ≠ 생략, 설계 §3-4).
 */
export const finishTurnOutput = async (t: {
  msg: { reportDefault?: "omit"; channel: string; threadKey: string; triggerRun?: { kind: string }; onReportOmitted?: () => void };
  out: { reportOmitted?: true };
  appended: string;
  bus: EventBus;
  deliver: () => Promise<void>;
}): Promise<"omitted" | "delivered"> => {
  if (omitsTurnReport(t.msg, t.out, t.appended)) {
    const trigger = t.msg.triggerRun?.kind === "schedule" || t.msg.triggerRun?.kind === "watch";
    publishInternalHandled(t.bus, { channel: t.msg.channel, threadKey: t.msg.threadKey, ...(trigger ? { recordOnly: true } : {}) });
    t.msg.onReportOmitted?.();
    return "omitted";
  }
  await t.deliver();
  return "delivered";
};

/** 전용 트리거의 발송만 마감한다. 원문·usage·실행 이력은 호출자가 그대로 보존한다. */
export const finishTriggerOutput = async (t: {
  reportDefault?: "omit";
  out: { reportOmitted?: true };
  channel: string;
  threadKey: string;
  kind: "schedule" | "watch";
  bus: EventBus;
  deliver: () => Promise<void>;
}): Promise<"omitted" | "delivered"> => finishTurnOutput({
  msg: { channel: t.channel, threadKey: t.threadKey, reportDefault: t.reportDefault, triggerRun: { kind: t.kind } },
  out: t.out,
  appended: "",
  bus: t.bus,
  deliver: t.deliver,
});

/**
 * **턴의 답을 보낸다** — 채널 답(`msg.reply`) → 대화 기록·화면(`channel.message.out`) → 함께 보낼 채널 사본 → 다음 메시지 제안(2026-11-01 진입점에서 뽑음 —
 *  `finishTurnOutput` 의 `deliver` 가 이걸 부른다). 순서·필드는 옮기기 전 진입점과 같다. 사본·제안은 진입점 클로저(좌표·설정)를 넘겨받는다.
 * ★실패는 그대로 던진다 — 진입점 catch 가 실패 안내를 낸다(전송 실패 ≠ 생략).
 */
export const deliverTurnReply = async (t: {
  msg: { channel: string; threadKey: string; reply: (text: string, opts?: { replyToTrigger?: boolean }) => Promise<void | ChannelMessageRef> };
  out: Pick<RouteOutput, "text" | "replyToTrigger" | "model" | "reasoning" | "turn" | "usage">;
  replyText: string;
  bus: EventBus;
  /**
   * 완료 턴 표식을 실어도 되나 — 끼워넣기 통로에 남은 입력이 없을 때만(그 입력은 다음 턴으로 간다, 2026-10-15 적대 검토 P2).
   * ★**함수**다 — 채널 답(`msg.reply`)을 보낸 **뒤** 기록 이벤트를 만드는 그 순간에 묻는다. 값으로 미리 받으면 전송을 기다리는 사이 끼어든
   *  입력을 못 보고 표식을 단다(2026-11-01 GPT R3 — 진입점에서 옮기며 시점이 앞당겨졌던 것).
   */
  turnMarkable: () => boolean;
  /** 함께 보낼 채널 사본 — 원본 행 좌표를 짚는다. */
  fanOut: (text: string, original: OutCoords) => Promise<void>;
  /** 다음 메시지 제안 — 답을 보낸 **뒤** 발사하고 기다리지 않는다. */
  suggest: () => void;
}): Promise<void> => {
  const { msg, out } = t;
  // 인입 채널 응답 — 반환 = 실제로 보낸 채널 메시지 id(있는 채널만) — 송신 이벤트에 실어 대화 기록 행에 묶는다(답글 원문 정확 조회, 2026-10-19).
  const sentRef = await msg.reply(t.replyText, out.replyToTrigger === true ? { replyToTrigger: true } : undefined);
  // 반환 = 이 송신 이벤트의 좌표 — egress 사본이 이 원본 행을 짚는다(2026-10-25).
  const original = publishReplyOut(t.bus, {
    channel: msg.channel,
    threadKey: msg.threadKey,
    text: out.text.slice(0, EVENT_TEXT_MAX),
    ...channelRefsField(msg.channel, sentRef),
    // 실제 응답 모델(2026-07-27) — chat_log 로 영속돼 새로고침 후에도 답변에 모델이 붙는다.
    ...(typeof out.model === "string" && out.model !== "" ? { model: out.model } : {}),
    // 실제로 보낸 추론 강도·턴 비용(2026-09-29) — 비용은 실시간 카드와 **같은 판정**(`turnSpend`)으로 고른다.
    ...(typeof out.reasoning === "string" && out.reasoning !== "" ? { reasoning: out.reasoning } : {}),
    // 완료 턴 표식(2026-10-15) — 저장이 확인된 정상 답에만, 끼워넣기 잔여가 없을 때만.
    ...(out.turn !== undefined && t.turnMarkable() ? { turn: out.turn } : {}),
    ...((): Record<string, unknown> => {
      const spend = turnSpend(out.usage);
      if (spend === undefined) return {};
      const missing = out.usage?.unreportedRequests;
      return { spend: { ...spend, ...(typeof missing === "number" && missing > 0 ? { unreportedRequests: missing } : {}) } };
    })(),
  });
  await t.fanOut(t.replyText, original);
  t.suggest();
};

/**
 * 생략한 턴의 흔적 — 대화 기록(`chat_log`)에 «내부 처리» 시스템 통지 한 줄을 **남긴다**(`notice:true`). 채널로는 안 간다(버스 발행만).
 *  `audience:"internal"` — 내부 처리 표식(2026-11-02, notify-owner-report-contract §11·§12): 대시보드엔 짧은 시스템 상태 줄로 보이고(라이브·이력),
 *   세션 목록 미리보기에서만 빠진다. 저장은 행 `data.audience` 로 따라간다(`event-persist`). 라이브는 이 out 이 그 턴 카드를 마감한다.
 *  `unread:false` — 안 읽음 배지를 올리지 않는다(배지 판정은 이 필드 — `sse.js`).
 */
export const publishInternalHandled = (bus: EventBus, at: { channel: string; threadKey: string; recordOnly?: true }): OutCoords =>
  publishReplyOut(bus, {
    channel: at.channel,
    threadKey: at.threadKey,
    text: translate(at.recordOnly === true ? "srv.notice.triggerReportOmitted" : "srv.notice.handledInternally"),
    notice: true,
    unread: false,
    audience: "internal",
    ...(at.recordOnly === true ? { recordOnly: true } : {}),
  });

/**
 * 슬래시 명령 응답 — 그 채널로 보내고 **대화 기록에도 남긴다**(관측 발행 → chat_log·대시보드).
 *
 * ★`ephemeral` = **휘발성 안내** (2026-08-23 사용자 확정: "텔레그램 전용 휘발성이라고
 *  보면 될 것 같은데"). 보낸 채널에 한 번 보이고 **어디에도 안 남는다** — chat_log·
 *  대시보드·검색·이력 전부.
 *
 *  왜 필요한가: "이 대화방을 TE 세션에 묶었습니다" 는 *그 방*의 설정 확인이다. 세션
 *  기록에 남으면 대시보드엔 자기가 하지도 않은 조작이 대화처럼 끼어들고, 나중에 검색
 *  결과로도 나온다.
 *
 * ★이름 주의: 응답은 원래 한 채널로만 간다 — 특별한 건 "채널 전용" 이 아니라 **안
 *  남는다**는 것이다(처음엔 `channelOnly` 로 지었다가 고쳤다).
 * ★남아야 할 것엔 절대 쓰지 마라 — 대화·결과 보고는 기록이 곧 가치다.
 */
/**
 * @returns 기록에 남는 응답이면 그 송신 이벤트의 좌표(egress 사본이 이 행을 원본으로 짚는다), 휘발·발행 실패면 undefined.
 */
export const replyCommand = async (
  msg: { reply: (t: string, o?: { turnFailed?: boolean }) => Promise<unknown>; channel: string; threadKey: string },
  text: string,
  opts?: { ephemeral?: boolean; turnFailed?: boolean },
): Promise<OutCoords | undefined> => {
  await Promise.resolve(opts?.turnFailed === true ? msg.reply(text, { turnFailed: true }) : msg.reply(text)).catch(() => {});
  try {
    const at = publishReplyOut(getEventBus(), {
      channel: msg.channel,
      threadKey: msg.threadKey,
      text: text.slice(0, EVENT_TEXT_MAX),
      // 발행은 한다(라이브 화면엔 보인다) — 적재만 `event-persist` 가 건너뛴다.
      ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
    });
    return opts?.ephemeral === true ? undefined : at;
  } catch {
    /* 관측 발행 실패가 명령 응답을 무르지 않는다(원칙 3). */
    return undefined;
  }
};

/**
 * **선택지를 띄우고 턴을 닫는다** — `presentOptions` 전용 통로 (2026-09-01 사용자 신고).
 *
 * ★신고: *"텔레그램에서 `/sessions` 실행하면 대시보드에서 계속 작업중으로 뜬다."*
 *  기제는 위 `replyCommand` 주석이 이미 적어둔 **그 부류의 재발**이다 —
 *  «활성 = `channel.message.in` ↔ 완료 = `.out`/`turn_done`» 인데, `presentOptions` 는
 *  채널 클로저라(cli=stdout · telegram=`ctx.reply`) **버스를 안 탄다.** 그래서 `in` 으로
 *  켜진 진행 표시를 끄는 이벤트가 **하나도 없다**(슬래시는 LLM 미경유라 `turn_done` 도 없다).
 *  대시보드의 15분 stale 스윕이 걷을 때까지 «작업 중» 이 남는다.
 *
 * ★2026-07-10 에 `/status` 로 같은 것을 겪고 `replyCommand` 로 닫았는데, **`presentOptions`
 *  경로는 그 통로를 안 거친다.** 부류가 닫힌 게 아니라 한 갈래만 닫혀 있었다.
 *
 * ★질문 문구를 그대로 실어 보낸다 — 사용자는 실제로 그 질문을 받았으므로 «나간 메시지» 가
 *  맞고, 라이브 대시보드에도 보이는 편이 낫다(지금은 «작업 중» 만 돌고 아무것도 안 보인다).
 *  `ephemeral` 이면 `event-persist` 가 적재만 건너뛴다(발행은 그대로 — 그 판정은 거기 한 곳).
 */
export const presentAndClose = async (
  msg: {
    presentOptions?: (
      q: string,
      o: Array<{ label: string; value: string }>,
      extra?: { note?: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    channel: string;
    threadKey: string;
  },
  question: string,
  options: Array<{ label: string; value: string }>,
  extra: { note?: string },
  opts?: { ephemeral?: boolean },
): Promise<{ ok: boolean; error?: string }> => {
  if (msg.presentOptions === undefined) return { ok: false, error: "선택지 미지원 채널" };
  const r = await msg.presentOptions(question, options, extra);
  if (!r.ok) return r; // 실패면 호출부가 텍스트로 폴백하고, 그 폴백이 `replyCommand` 라 닫힌다.
  try {
    getEventBus().publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        text: question.slice(0, EVENT_TEXT_MAX),
        ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
      },
    });
  } catch {
    /* 관측 발행 실패가 선택지 렌더를 무르지 않는다(원칙 3). */
  }
  return r;
};
