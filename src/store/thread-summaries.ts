/**
 * 6b — codex 대화 히스토리 롤링 요약 압축의 영속 계층 (get/upsert).
 *
 * 진실 소스: architect contract §6b (2026-06-19). 테이블 정의는 sessions.ts initStore.
 *
 * thread_summaries = (thread_key) 당 단일 행. codex 가 매 턴 전체 히스토리를 재전송하는
 * 결함을 codex 안에서 닫기 위한 보조 저장소 (LLM-agnostic #2 — claude 무관).
 *  - summary: 오래된 턴들을 접은 누적 요약 텍스트 (롤링 — 매 압축마다 기존 요약 + 새
 *    오래된 턴을 합쳐 재요약).
 *  - compactedThrough: 요약에 접힌 마지막 transcript id (watermark). loadThreadHistory
 *    의 ts ASC, id ASC 단일 타임라인 기준. 이 id 이하 턴은 요약에 흡수됨 → 원문 재전송
 *    불요.
 *
 * codex 어댑터 외엔 호출 안 함 (어댑터별 if 가 facade 로 새지 않게). 순수 DB I/O.
 */
import { getDb } from "./sessions.js";

export interface ThreadSummary {
  threadKey: string;
  summary: string;
  compactedThrough: number;
  updatedAt: number;
}

interface ThreadSummaryRow {
  thread_key: string;
  summary: string;
  compacted_through: number;
  updated_at: number;
}

const requireDb = (caller: string) => {
  try {
    return getDb();
  } catch (err) {
    throw new Error(
      `initStore() must be called before ${caller}() — store is not initialized.`,
      { cause: err },
    );
  }
};

/** thread 의 롤링 요약 + watermark 회수. 부재(첫 압축 전) → undefined. */
export const getThreadSummary = (
  threadKey: string,
): ThreadSummary | undefined => {
  const db = requireDb("getThreadSummary");
  const row = db
    .prepare(
      `SELECT thread_key, summary, compacted_through, updated_at
       FROM thread_summaries WHERE thread_key = ?`,
    )
    .get(threadKey) as ThreadSummaryRow | undefined;
  if (row === undefined) return undefined;
  return {
    threadKey: row.thread_key,
    summary: row.summary,
    compactedThrough: row.compacted_through,
    updatedAt: row.updated_at,
  };
};

/** thread 요약 upsert (롤링 — 압축 1회당 1번). watermark 전진. */
export const upsertThreadSummary = (input: {
  threadKey: string;
  summary: string;
  compactedThrough: number;
}): void => {
  const db = requireDb("upsertThreadSummary");
  const now = Date.now();
  db.prepare(
    `INSERT INTO thread_summaries (thread_key, summary, compacted_through, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_key) DO UPDATE SET
       summary = excluded.summary,
       compacted_through = excluded.compacted_through,
       updated_at = excluded.updated_at`,
  ).run(input.threadKey, input.summary, input.compactedThrough, now);
};
