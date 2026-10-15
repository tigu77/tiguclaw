/**
 * **가지 기록 쓰기** — 한 트랜잭션 (2026-10-15 대화 가지치기 v1 ②단계, 설계 §4 ⑥).
 *
 * 절차(줄·적재 따라잡기·SDK 복제)는 코어 `core/thread-fork.ts` 가 하고, 여기는 확정된 좌표를 **한 번에** 쓴다. 커밋 전엔 가지가
 *  어디에도 안 보이고(목록은 `threads` 행으로 뜬다), 실패하면 전부 롤백된다.
 * 복사: 세션 설정(프로젝트·모델 프로파일·모델 덮어쓰기)·요약·활성 경계·글자당 토큰. 복사 안 함: 매니저·할 일·스케줄·감시·채널 바인딩·
 *  알림 목적지(`last_channel`) — 분기 뒤 도착하는 매니저 결과는 원래 대화로 간다(설계 §4).
 */
import type { ChannelName } from "../channels/types.js";
import { getDb } from "./sessions.js";

export interface ForkRecordInput {
  channel: ChannelName;
  parentKey: string;
  childKey: string;
  /** T — 물려받는 부모 기록 상한(`transcripts.id`). */
  throughTranscriptId: number;
  /** Tc — 물려받는 화면 기록 상한(`chat_log.id`). */
  throughChatId: number;
  /**
   * 메시지 지점에서 갈랐을 때만 — 그 답의 시각. 도구 스텝 상한이자 활성 경계 검사 기준. 끝에서 가르면 없다(v1 그대로: 모든 것을 물려받으니
   *  경계도 그대로 복사하고, 도구 스텝 상한은 만든 시각).
   */
  throughTs?: number;
  name: string;
  /** Claude SDK 복제본 — 없으면 «SDK 없는 가지»(`/clear` 와 같은 무효화 값: sid `''` · 해시 NULL). */
  sdk?: { sessionId: string; jsonlPath: string; lines: number; bytes: number; includedThrough: number | null; systemPromptHash: string | null };
}

/**
 * 최종 트랜잭션 안의 거절 — 검사한 요약·경계와 복사하는 값이 **같은 읽기**다(아스트라 회신 3). SDK 복제를 기다리는 사이 답한 뒤 접기가
 *  요약을 T 너머로 진전시켰으면 여기서 걸린다 — 조용히 요약을 빼고 성공시키지 않는다.
 */
export class ForkRecordRejected extends Error {
  constructor(readonly reason: "summarized" | "cleared_after", detail: string) {
    super(detail);
  }
}

/** 이미 있는 가지면 그 행 — 같은 childKey 재시도는 두 번째 가지를 만들지 않는다(설계 §4 ③). */
export const forkExists = (channel: ChannelName, childKey: string): boolean =>
  getDb().prepare(`SELECT 1 FROM thread_lineage WHERE channel = ? AND thread_key = ?`).get(channel, childKey) !== undefined;

export const writeForkRecords = (f: ForkRecordInput): void => {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    // ★물려줄 요약·활성 경계는 **이 읽기**로 검사하고 아래에서 같은 행을 복사한다(트랜잭션은 동기라 그 사이 바뀌지 않는다).
    //  요약이 상한 T 너머까지 접었으면 그 요약엔 갈라진 지점 **뒤** 내용이 섞여 있다 · 경계가 갈라진 시각 뒤면 그 시점의 경계를 모른다.
    //  끝에서 가르면 T 가 «지금» 의 최대라 요약 검사는 저절로 통과하고, 경계 검사는 하지 않는다(시각 없음 = 전부 물려받음).
    const sum = db.prepare(`SELECT compacted_through FROM thread_summaries WHERE thread_key = ?`).get(f.parentKey) as { compacted_through: number } | undefined;
    if (sum !== undefined && sum.compacted_through > f.throughTranscriptId) {
      throw new ForkRecordRejected("summarized", `요약 워터마크 ${sum.compacted_through} > 상한 ${f.throughTranscriptId}`);
    }
    const cb = db.prepare(`SELECT boundary_ts FROM context_boundaries WHERE channel = ? AND thread_key = ?`).get(f.channel, f.parentKey) as { boundary_ts: number } | undefined;
    if (f.throughTs !== undefined && cb !== undefined && cb.boundary_ts > f.throughTs) {
      throw new ForkRecordRejected("cleared_after", `활성 경계 ${cb.boundary_ts} > 갈라진 시각 ${f.throughTs}`);
    }
    const parent = db
      .prepare(`SELECT model FROM threads WHERE channel = ? AND channel_thread_id = ?`)
      .get(f.channel, f.parentKey) as { model: string | null } | undefined;
    db.prepare(
      `INSERT INTO thread_lineage (channel, thread_key, parent_key, through_transcript_id, through_chat_id, sdk_session_id, sdk_included_through, through_ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.channel, f.childKey, f.parentKey, f.throughTranscriptId, f.throughChatId, f.sdk?.sessionId ?? null, f.sdk?.includedThrough ?? null, f.throughTs ?? null, now);
    db.prepare(
      `INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.channel, f.childKey, f.sdk?.sessionId ?? "", parent?.model ?? null, f.sdk?.systemPromptHash ?? null, now, now, f.name);
    if (f.sdk !== undefined) {
      // 적재기 선등록 — 복제본 끝까지 «읽었다» 로 둔다. 다음 Claude 턴 뒤 적재기가 **꼬리만** 읽는다(복제 내용은 부모 행으로 이미 소속).
      db.prepare(
        `INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed, bytes_indexed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(f.channel, f.childKey, f.sdk.sessionId, f.sdk.jsonlPath, now, f.sdk.lines, f.sdk.bytes);
    }
    const copy = (sql: string, ...args: unknown[]): void => { db.prepare(sql).run(...args); };
    copy(`INSERT INTO thread_summaries (thread_key, summary, compacted_through, updated_at)
            SELECT ?, summary, compacted_through, ? FROM thread_summaries WHERE thread_key = ?`, f.childKey, now, f.parentKey);
    copy(`INSERT INTO context_boundaries (channel, thread_key, boundary_ts, created_at)
            SELECT channel, ?, boundary_ts, ? FROM context_boundaries WHERE channel = ? AND thread_key = ?`, f.childKey, now, f.channel, f.parentKey);
    copy(`INSERT INTO session_projects (thread_key, project_path, linked_at)
            SELECT ?, project_path, ? FROM session_projects WHERE thread_key = ?`, f.childKey, now, f.parentKey);
    copy(`INSERT INTO session_model_profile (channel, thread_key, profile_name, updated_at)
            SELECT channel, ?, profile_name, ? FROM session_model_profile WHERE channel = ? AND thread_key = ?`, f.childKey, now, f.channel, f.parentKey);
    copy(`INSERT INTO session_model_override (channel, thread_key, model_spec, updated_at)
            SELECT channel, ?, model_spec, ? FROM session_model_override WHERE channel = ? AND thread_key = ?`, f.childKey, now, f.channel, f.parentKey);
    copy(`INSERT INTO thread_token_density (thread_key, chars, tokens, updated_at)
            SELECT ?, chars, tokens, ? FROM thread_token_density WHERE thread_key = ?`, f.childKey, now, f.parentKey);
  })();
};

/** 이름 끝의 ` (n)` — 가지의 가지도 같은 바탕에서 번호만 오른다(정태님 결정 §8). */
const NUMBER_SUFFIX = /\s\((\d+)\)$/;

/**
 * **원래 이름 + 번호** — 끝의 ` (n)` 을 걷은 바탕에, 같은 바탕의 이름들 중 비어 있는 가장 작은 번호(2부터).
 * `아침 뉴스` → `아침 뉴스 (2)` · 그 가지를 또 가르면 `아침 뉴스 (3)`. 이름 상한(60자)을 넘으면 바탕을 줄인다.
 */
export const forkName = (parentName: string, taken: ReadonlySet<string>): string => {
  const base = parentName.trim().replace(NUMBER_SUFFIX, "").trim() || "Session";
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const name = `${base.slice(0, 60 - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
};

/** 그 채널에 이미 있는 대화 이름들(번호 고르기 재료). */
export const sessionNames = (channel: ChannelName): Set<string> =>
  new Set((getDb()
    .prepare(`SELECT name FROM threads WHERE channel = ? AND name IS NOT NULL`)
    .all(channel) as { name: string }[]).map((r) => r.name));
