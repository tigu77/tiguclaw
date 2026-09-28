/**
 * **대화 맥락 초기화 — 한 곳** (2026-09-26).
 *
 * ★`/clear` 가 하던 세 걸음(Claude 이어가기 끊기 → 경계 시각 → Codex 롤링 요약 삭제, 순서 고정)을
 *  스케줄 이력 정책도 해야 해서 뽑았다. 두 곳에 베끼면 한쪽만 늙는다([[feedback_simple_composable_no_duplication]]).
 *  세 어댑터를 모두 끊으므로 LLM 무관하다(claude=resume, codex/openai=매 턴 재전송 히스토리의 경계).
 */
import type { ChannelName } from "../channels/types.js";
import { clearSessionContext, getContextBoundary, getDb, setContextBoundary } from "./sessions.js";
import { clearThreadSummary } from "./thread-summaries.js";
import { stripAssembledPrefix } from "./memory.js";
import { scheduleRunTimes } from "./schedules.js";

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
 * «직전 N회» 가 볼 발화 시각(최신순)과 그 출처 — **판정은 여기 한 곳**.
 *  - 발화 기록(`schedule_runs`)이 N개 이상이면 그것 — 프롬프트를 고쳐도 흔들리지 않는다.
 *  - 모자라면(기록이 생기기 전 발화가 섞인 기존 스케줄) 종전 방식(프롬프트 머리 일치)으로 대신한다. ★한계: 그 사이에
 *   프롬프트를 고치면 옛 결함이 남는다 — 기록이 N개 쌓이면 저절로 사라진다.
 */
export const runStartsFor = (
  channel: ChannelName,
  threadKey: string,
  prompt: string,
  keepRuns: number,
  scheduleId?: number,
): { starts: number[]; source: "log" | "prompt" } => {
  if (scheduleId !== undefined) {
    const logged = scheduleRunTimes(scheduleId, keepRuns);
    if (logged.length >= keepRuns) return { starts: logged, source: "log" };
  }
  return { starts: scheduleRunStarts(channel, threadKey, prompt, keepRuns), source: "prompt" };
};

/**
 * 그 스레드에서 **스케줄 프롬프트로 시작한 사용자 턴**(조립 접두 제외)의 시각(최신순) = 발화 시각.
 * ★이제 대신 쓰는 길이다 — 정본은 발화 기록(`runStartsFor`). 프롬프트를 고치면 이전 발화를 못 찾는다.
 * ★매니저 완료 재주입 같은 합성 턴도 사용자 역할로 남으므로 프롬프트 머리로 가른다
 *  (실측 2026-09-26 scheduler:21: 사용자 턴 103 중 프롬프트로 시작한 것 78).
 */
export const scheduleRunStarts = (
  channel: ChannelName,
  threadKey: string,
  prompt: string,
  /** 최신순으로 이만큼 찾으면 멈춘다 — 경계 계산엔 N번째까지만 필요하다(전체 검토 2026-09-28: 발화마다 전 기록을 읽었다). */
  limit: number = Number.POSITIVE_INFINITY,
): number[] => {
  const head = prompt.trim().slice(0, 40);
  if (head === "" || limit <= 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT t.ts, t.content FROM transcripts t
         JOIN transcript_index ti ON ti.claude_session_id = t.claude_session_id
        WHERE ti.channel = ? AND ti.thread_key = ? AND t.role = 'user'
        ORDER BY t.ts DESC, t.id DESC`,
    )
    .iterate(channel, threadKey) as IterableIterator<{ ts: number; content: string }>;
  const out: number[] = [];
  // ★«포함» 이 아니라 **조립 접두를 걷은 뒤 그 머리로 시작**하는가 (2026-09-26 싱크 레드팀 P2).
  //  포함으로 세면 재주입 턴이 인용한 프롬프트(`작업: "…"`)·Claude 의 «지난 대화» 블록까지 발화로 세어
  //  N회가 실제보다 적게 남았다.
  for (const r of rows) {
    if (typeof r.content === "string" && stripAssembledPrefix(r.content).trimStart().startsWith(head)) out.push(r.ts);
    if (out.length >= limit) break; // 반복자를 끊으면 better-sqlite3 가 문장을 정리한다.
  }
  return out;
};

/**
 * 스케줄 발화 직전에 이력 정책을 적용한다. `keepRuns` null = 계속(아무것도 안 함).
 * 반환 = 적용한 경계와 남긴 발화 수(로그·검사용). 자를 것이 없거나 경계가 그대로면 null.
 */
export const applyScheduleHistory = (
  channel: ChannelName,
  threadKey: string,
  prompt: string,
  keepRuns: number | null,
  now: number = Date.now(),
  /** 발화 기록을 볼 스케줄 — 없으면 프롬프트 머리 일치만(종전). */
  scheduleId?: number,
): { boundary: number; kept: number; source: "log" | "prompt" | "fresh" } | null => {
  if (keepRuns === null) return null;
  // 0(매번 새로)은 발화 시각을 안 본다 — 출처를 «기록» 이라 적으면 로그가 거짓이 된다(적대 검토 2026-09-28).
  const { starts, source } = keepRuns > 0 ? runStartsFor(channel, threadKey, prompt, keepRuns, scheduleId) : { starts: [], source: "fresh" as const };
  const boundary = keepRunsBoundary(starts, keepRuns, now);
  if (boundary === null) return null;
  // ★경계는 **앞으로만** 간다(전체 검토 2026-09-28). 종전엔 무조건 덮어써, `/clear`·«매번 새로» 로 잘라 둔 이력보다
  //  앞으로 경계를 되돌려 **지운 대화를 되살렸다**. 경계가 그대로면 초기화도 안 한다(요약·Claude 이어가기 보존).
  //  ★한계: 발화마다 실행이 하나씩 쌓이므로 «직전 N회» 경계는 대개 매번 정말로 한 칸 나아간다 — 그때 요약을 지우고
  //   이어가기를 끊는 것은 정책의 본질이다(요약엔 경계 밖 내용이 섞여 일부만 뗄 수 없다). N회 원문이 요약 기준보다
  //   크면 매 발화 다시 요약한다 — N 을 작게 두는 정책이다.
  if (boundary <= getContextBoundary(channel, threadKey)) return null;
  resetThreadContext(channel, threadKey, boundary);
  return { boundary, kept: starts.length, source }; // 남긴 발화 수(N) — 조회가 N 개에서 멈추므로 «전체 발화 수» 가 아니다
};
