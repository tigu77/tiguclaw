/**
 * **대화 맥락 초기화 — 한 곳** (2026-09-26).
 *
 * ★`/clear` 가 하던 세 걸음(Claude 이어가기 끊기 → 경계 시각 → Codex 롤링 요약 삭제, 순서 고정)을
 *  스케줄 이력 정책도 해야 해서 뽑았다. 두 곳에 베끼면 한쪽만 늙는다([[feedback_simple_composable_no_duplication]]).
 *  세 어댑터를 모두 끊으므로 LLM 무관하다(claude=resume, codex/openai=매 턴 재전송 히스토리의 경계).
 */
import type { ChannelName } from "../channels/types.js";
import { clearSessionContext, getDb, setContextBoundary } from "./sessions.js";
import { clearThreadSummary } from "./thread-summaries.js";
import { stripAssembledPrefix } from "./memory.js";

/** 맥락을 `boundaryTs` 이전에서 끊는다. 반환 = 끊을 이어가기 세션이 있었나(`/clear` 안내 문구용). */
export const resetThreadContext = (
  channel: ChannelName,
  threadKey: string,
  boundaryTs: number = Date.now(),
): boolean => {
  const had = clearSessionContext(channel, threadKey);
  setContextBoundary(channel, threadKey, boundaryTs);
  clearThreadSummary(channel, threadKey);
  return had;
};

/**
 * 스케줄 이력 «최근 N회» 의 경계 — 순수 함수.
 *  - `keepRuns` 0 → `now`(매번 새로 시작).
 *  - N → 최신순 발화 시각의 N번째 **바로 앞**(직전 N회가 남는다). 발화가 N회보다 적으면 `null`(자를 것 없음).
 */
export const keepRunsBoundary = (
  runStartsDesc: readonly number[],
  keepRuns: number,
  now: number,
): number | null => {
  if (keepRuns <= 0) return now;
  if (runStartsDesc.length < keepRuns) return null;
  return runStartsDesc[keepRuns - 1]! - 1;
};

/**
 * 그 스레드에서 **스케줄 프롬프트로 시작한 사용자 턴**(조립 접두 제외)의 시각(최신순) = 발화 시각.
 * ★매니저 완료 재주입 같은 합성 턴도 사용자 역할로 남으므로 프롬프트 머리로 가른다
 *  (실측 2026-09-26 scheduler:21: 사용자 턴 103 중 프롬프트로 시작한 것 78).
 */
export const scheduleRunStarts = (
  channel: ChannelName,
  threadKey: string,
  prompt: string,
): number[] => {
  const head = prompt.trim().slice(0, 40);
  if (head === "") return [];
  const rows = getDb()
    .prepare(
      `SELECT t.ts, t.content FROM transcripts t
         JOIN transcript_index ti ON ti.claude_session_id = t.claude_session_id
        WHERE ti.channel = ? AND ti.thread_key = ? AND t.role = 'user'
        ORDER BY t.ts DESC, t.id DESC`,
    )
    .all(channel, threadKey) as { ts: number; content: string }[];
  const out: number[] = [];
  // ★«포함» 이 아니라 **조립 접두를 걷은 뒤 그 머리로 시작**하는가 (2026-09-26 싱크 레드팀 P2).
  //  포함으로 세면 재주입 턴이 인용한 프롬프트(`작업: "…"`)·Claude 의 «지난 대화» 블록까지 발화로 세어
  //  N회가 실제보다 적게 남았다.
  for (const r of rows) {
    if (typeof r.content === "string" && stripAssembledPrefix(r.content).trimStart().startsWith(head)) out.push(r.ts);
  }
  return out;
};

/**
 * 스케줄 발화 직전에 이력 정책을 적용한다. `keepRuns` null = 계속(아무것도 안 함).
 * 반환 = 적용한 경계(로그·검사용). 자를 것이 없으면 null.
 */
export const applyScheduleHistory = (
  channel: ChannelName,
  threadKey: string,
  prompt: string,
  keepRuns: number | null,
  now: number = Date.now(),
): { boundary: number; runs: number } | null => {
  if (keepRuns === null) return null;
  const starts = keepRuns > 0 ? scheduleRunStarts(channel, threadKey, prompt) : [];
  const boundary = keepRunsBoundary(starts, keepRuns, now);
  if (boundary === null) return null;
  resetThreadContext(channel, threadKey, boundary);
  return { boundary, runs: starts.length };
};
