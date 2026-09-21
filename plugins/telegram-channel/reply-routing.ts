/**
 * 답장 → **발원 세션** 라우팅 판정 한 곳 (2026-09-22).
 *
 * 왜 모듈인가 — 같은 판단이 **두 핸들러**에 필요하다(텍스트 / 첨부). 종전엔 텍스트
 * 핸들러에만 인라인으로 있었고, **첨부 경로는 라우팅도 로그도 없었다**: 사진에 캡션을
 * 달아 답글을 보내면 증상은 나는데 로그는 **0줄**이고, 보는 사람은 «미스 없음» 으로
 * 읽는다. 그 상태로는 신고를 확인할 방법이 **원리적으로 없다**
 * ([[feedback_logs_must_stand_alone]]).
 *
 * ★복제 대신 모듈인 이유가 하나 더 있다 — 인입 핸들러는 grammy 컨텍스트가 필요해
 *  회귀에서 **못 돌린다.** 그래서 이 판정이 핸들러 안에 있는 동안은 검사가 소스 grep 일
 *  수밖에 없었고, 실제로 분기를 죽여도 문자열이 남아 **통째로 초록**이었다.
 *  여기로 옮기면 검사가 **함수를 부른다** — «검사가 껄끄러우면 코드가 잘못 놓인 것»
 *  ([[feedback_simple_composable_no_duplication]]).
 */
import { routedReplySession } from "../../src/core/threadkey.js";
import {
  OUTBOUND_MESSAGE_MAP_MAX_ROWS,
  countOutboundMessageMappings,
  findSessionForOutboundMessage,
} from "../../src/store/outbound-messages.js";

export interface ReplyRouting {
  /** 매핑에서 찾은 발원 세션. `null` = 답장이 아니거나 매핑이 없다. */
  readonly repliedSession: string | null;
  /** 이 턴이 실제로 쓸 세션. */
  readonly sessionId: string;
  /**
   * «답장이 세션을 **갈랐나**» — 갈렸을 때만 그 세션, 아니면 `null`.
   * 판정은 `routedReplySession` 하나다(2026-09-05 적대 검토 P2: 같은 판단이 두 곳에
   * 있으면 한쪽만 좁혀진다).
   */
  readonly routedSession: string | null;
}

/**
 * 답장 대상 message_id 로 발원 세션을 정하고, **못 찾은 순간까지** 로그에 남긴다.
 *
 * ★사용자에게는 안 알린다 — 답장은 인용 목적으로도 쓰므로 그때마다 말을 거는 건 소음이다.
 *  로그만 남긴다.
 *
 * @param kind 어느 인입 경로인가(`text` · `attachment`). 로그에 실어 **경로별로** 센다 —
 *             신고가 어느 쪽이었는지 구분되지 않으면 진단이 안 된다.
 */
export const resolveReplyRouting = (
  chatId: string,
  repliedMsgId: number | undefined,
  boundSession: string,
  kind: "text" | "attachment",
): ReplyRouting => {
  const repliedSession =
    repliedMsgId === undefined
      ? null
      : findSessionForOutboundMessage("telegram", chatId, repliedMsgId);
  const sessionId = repliedSession ?? boundSession;

  if (repliedMsgId !== undefined && repliedSession === null) {
    // ★수치를 같이 싣는다: 표가 **비어 있나**(기록 자체가 안 되는 것)와 **차 있는데 이
    //  id 만 없나**(오래돼 잘렸거나 기록 이전 발신)가 갈린다 — 그게 다음 수를 정한다.
    // ★`null` = **조회 실패**다(0 과 다르다). 종전엔 catch 가 0 을 내서 이 줄이
    //  «기록이 안 되는 것» 이라고 **자신 있게 틀린 한 줄**을 찍었다(2026-09-22 P3).
    const n = countOutboundMessageMappings();
    console.log(
      `telegram(${kind}): 답장인데 **발원 세션을 못 찾았습니다** (message_id=${repliedMsgId}) — ` +
        `현재 세션 ${boundSession} 으로 진행합니다. ` +
        (n === null
          ? `매핑 **조회 실패**(DB) — 건수를 못 읽었습니다. 위 outbound-messages 경고를 보세요`
          : `매핑 ${n.toLocaleString()}건/상한 ${OUTBOUND_MESSAGE_MAP_MAX_ROWS.toLocaleString()}건 ` +
            `(0건이면 기록이 안 되는 것 · 상한에 가까우면 오래돼 잘린 것)`),
    );
  }

  const routedSession = routedReplySession(repliedSession, boundSession);
  if (routedSession !== null) {
    console.log(
      `telegram(${kind}): 답장 → 발원 세션으로 라우팅 (message_id=${String(repliedMsgId)} session=${routedSession})`,
    );
  }
  return { repliedSession, sessionId, routedSession };
};
