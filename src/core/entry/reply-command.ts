// src/core/entry/reply-command.ts
/**
 * **명령 응답** — 진입점에서 꺼낸 자리 (2026-09-05 구조 감사 ③).
 *
 * ★자족 함수였다(이벤트 버스와 본문 상한만 쓴다). 그런데 `src/index.ts` 안에 살아서, 명령
 *  본문을 코어로 옮기는 순간 «코어가 진입점을 import» 하는 거꾸로가 될 뻔했다. 방향이
 *  뒤집히면 다음 사람은 순환을 풀려고 **사본**을 만든다 — 그래서 함수가 여기로 왔다.
 * ★호출부(진입점 20곳)는 한 글자도 안 바뀐다 — import 만 늘었다.
 */
import { getEventBus } from "../eventbus.js";

/** 관측 이벤트에 싣는 본문 상한 — 진입점과 명령 응답이 **같은 값**을 써야 한다. */
export const EVENT_TEXT_MAX = 50_000;

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
export const replyCommand = async (
  msg: { reply: (t: string) => Promise<unknown>; channel: string; threadKey: string },
  text: string,
  opts?: { ephemeral?: boolean },
): Promise<void> => {
  await Promise.resolve(msg.reply(text)).catch(() => {});
  try {
    getEventBus().publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: msg.channel,
        threadKey: msg.threadKey,
        text: text.slice(0, EVENT_TEXT_MAX),
        // 발행은 한다(라이브 화면엔 보인다) — 적재만 `event-persist` 가 건너뛴다.
        ...(opts?.ephemeral === true ? { ephemeral: true } : {}),
      },
    });
  } catch {
    /* 관측 발행 실패가 명령 응답을 무르지 않는다(원칙 3). */
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
