/**
 * **완료 턴 표식** — 메시지 지점 가지치기가 «이 답까지» 를 정확히 자르는 좌표 (2026-10-15, 설계 `docs/decisions/2026-10-15-fork-from-message-design.md`
 *  «유효 계약 — 구현 기준» §1).
 *
 * 화면 기록(`chat_log`)과 모델 기록(`transcripts`)엔 서로를 가리키는 칸이 없어서, 턴 저장이 **확인된 순간** 그 좌표를 답과 함께 남긴다.
 * 확인 못 하면 표식이 없다 — 그 답에선 갈라낼 수 없고(메뉴가 안 뜬다), 추정해서 성공시키지 않는다(아스트라 회신 1).
 */
import type { ChannelName } from "../channels/types.js";
import { getDb } from "./sessions.js";
import { includedEnd } from "./thread-members.js";

export interface TurnMark {
  /** 턴 uuid — 화면 카드가 이 값으로 가리킨다(라이브·복원 같은 값). */
  id: string;
  /** T — 복사 상한(저장 확인 직후 전역 최대 `transcripts.id`). 소속 판정과 함께만 쓴다. ★S 로 재사용 금지(아스트라 2차 회신 1). */
  through: number;
  /** 이 턴이 Claude 로 답했을 때 — 그 지점까지의 SDK 체크포인트. */
  claude?: {
    sid: string;
    /** 마지막 최상위 assistant 메시지 uuid — `forkSession(sid, { upToMessageId })`. */
    uuid: string;
    /** S — 이 시점의 `includedEnd`(대화 행만). 나중에 그 sid 의 최신 끝을 다시 구하지 않는다. */
    includedThrough: number | null;
    /** 이 턴이 쓴 sysprompt hash — 복제본에 이 값을 기록한다(현재 부모 hash 복사 금지, 아스트라 2차 회신 3). */
    systemPromptHash: string | null;
  };
}

const maxTranscriptId = (): number => (getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM transcripts`).get() as { m: number }).m;

/** Codex·OpenAI — `appendApiTurn` 이 성공한 뒤 부른다(같은 대화의 다음 턴은 아직 시작 전 — 같은 줄 안). */
export const apiTurnMark = (id: string): TurnMark => ({ id, through: maxTranscriptId() });

/**
 * Claude — 적재가 **이번 답의 마지막 메시지까지** 읽었을 때만(`transcript_index.last_message_uuid` = 그 uuid). 적재기는 완전한 줄에서만
 *  그 칸을 남기므로 «덜 쓴 마지막 줄» · «파일 없음» 은 저절로 불일치다. 이미 적재돼 새 줄이 0 이어도 칸이 맞으면 발급한다.
 */
export const claudeTurnMark = (
  id: string,
  at: { channel: ChannelName; threadKey: string; sid: string; uuid: string | undefined; systemPromptHash: string | null },
): TurnMark | undefined => {
  if (at.uuid === undefined) return undefined;
  const row = getDb()
    .prepare(`SELECT last_message_uuid FROM transcript_index WHERE channel = ? AND thread_key = ? AND claude_session_id = ?`)
    .get(at.channel, at.threadKey, at.sid) as { last_message_uuid: string | null } | undefined;
  if (row?.last_message_uuid !== at.uuid) return undefined;
  return {
    id,
    through: maxTranscriptId(),
    claude: { sid: at.sid, uuid: at.uuid, includedThrough: includedEnd(at.channel, at.threadKey, at.sid), systemPromptHash: at.systemPromptHash },
  };
};
