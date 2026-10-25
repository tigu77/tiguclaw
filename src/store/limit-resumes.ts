/**
 * 한도 자동 이어가기 상태 — 사람의 대화(세션)당 한 행 (2026-10-23, 설계 docs/decisions/2026-10-22-limit-auto-resume-design.md §3.4).
 *
 * 판단은 여기 없다(`core/limit-resume.ts`). 여기는 읽고 쓰는 것만 — 전부 동기(better-sqlite3)라 같은 프로세스 안에서 두 실패가 끼어들 수 없다.
 * ★목록이 둘이다 — `items`(대기: 아직 어느 재개 턴도 안 맡은 것) · `claimedItems`(지금 도는 재개 턴이 넘겨받은 것). 한 칸이면 재개 턴이 도는 사이
 *  다른 실패가 그 목록을 덮어, 못 끝낸 일이 다음 깨움에서 빠졌다(GPT 검토 R1).
 */
import { getDb } from "./sessions.js";

/** 한도로 멈춘 것 하나 — 깨우는 글의 재료(코드가 고르는 것은 «무엇이 멈췄나» 까지다). */
export interface LimitStopItem {
  kind: "turn" | "job";
  /** 멈춘 시각(ms). */
  at: number;
  /** `turn` — 그 턴 입력 앞부분. */
  text?: string;
  /** 도구가 일부 실행된 뒤 멈췄으면 그 사유. */
  partial?: string;
  /** `job` — 라벨·jobId·프로파일. */
  label?: string;
  jobId?: string;
  modelTier?: string;
}

export interface LimitResumeRow {
  threadKey: string;
  scheduleId: number | null;
  /** 대기 — 다음 재개 턴이 맡을 것. */
  items: LimitStopItem[];
  /** 지금 도는 재개 턴이 맡은 것(`claimed` 일 때만 의미). */
  claimedItems: LimitStopItem[];
  arms: number;
  claimed: boolean;
  updatedAt: number;
}

interface DbRow {
  thread_key: string;
  schedule_id: number | null;
  items: string;
  claimed_items: string;
  arms: number;
  claimed: number;
  updated_at: number;
}

const parseItems = (raw: string): LimitStopItem[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === "object") as LimitStopItem[]) : [];
  } catch {
    return [];
  }
};

const toRow = (r: DbRow): LimitResumeRow => ({
  threadKey: r.thread_key,
  scheduleId: r.schedule_id,
  items: parseItems(r.items),
  claimedItems: parseItems(r.claimed_items),
  arms: r.arms,
  claimed: r.claimed !== 0,
  updatedAt: r.updated_at,
});

const COLS = "thread_key, schedule_id, items, claimed_items, arms, claimed, updated_at";

export const getLimitResume = (threadKey: string): LimitResumeRow | undefined => {
  const r = getDb().prepare(`SELECT ${COLS} FROM limit_resumes WHERE thread_key = ?`).get(threadKey) as DbRow | undefined;
  return r === undefined ? undefined : toRow(r);
};

/** 부팅 정리용 — «넘겨받음» 이 남은 행 전부. */
export const listClaimedLimitResumes = (): LimitResumeRow[] =>
  (getDb().prepare(`SELECT ${COLS} FROM limit_resumes WHERE claimed != 0`).all() as DbRow[]).map(toRow);

export const putLimitResume = (row: Omit<LimitResumeRow, "updatedAt">, now: number = Date.now()): void => {
  getDb()
    .prepare(
      `INSERT INTO limit_resumes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET schedule_id = excluded.schedule_id, items = excluded.items, claimed_items = excluded.claimed_items,
         arms = excluded.arms, claimed = excluded.claimed, updated_at = excluded.updated_at`,
    )
    .run(row.threadKey, row.scheduleId, JSON.stringify(row.items), JSON.stringify(row.claimedItems), row.arms, row.claimed ? 1 : 0, now);
};

/**
 * 재개 턴이 실제로 시작했다 — 그 타이머의 **대기 목록을 넘겨받는다**(대기는 비고, 맡은 목록이 된다). 그 대화 것만(옮긴 타이머는 옛 대화가 못 맡는다).
 */
export const claimLimitResumeRow = (scheduleId: number, threadKey: string): number =>
  getDb()
    .prepare(`UPDATE limit_resumes SET claimed = 1, claimed_items = items, items = '[]', updated_at = ? WHERE schedule_id = ? AND thread_key = ?`)
    .run(Date.now(), scheduleId, threadKey).changes;

/**
 * 재개 턴이 끝났다 — 그 턴이 **맡은 세대만** 내려놓는다(대기 목록·예약은 그대로). 한도로 실패해 이미 대기로 돌려줬으면(`claimed=0`) 아무것도 안 한다.
 * ★안 내려놓으면 끝난 항목이 «맡은 것» 으로 남아, 재시작 때 부팅 정리가 그것을 대기로 되돌렸다(GPT 검토 R2).
 */
export const releaseLimitResumeRow = (scheduleId: number, threadKey: string): number =>
  getDb()
    .prepare(`UPDATE limit_resumes SET claimed = 0, claimed_items = '[]', updated_at = ? WHERE schedule_id = ? AND thread_key = ? AND claimed != 0`)
    .run(Date.now(), scheduleId, threadKey).changes;

/** 사람이 쓴 메시지가 왔다 — 자동으로 건 횟수를 처음부터. 표가 비면 PK 조회 한 번. */
export const resetLimitResumeArmsRow = (threadKey: string): number =>
  getDb().prepare(`UPDATE limit_resumes SET arms = 0 WHERE thread_key = ? AND arms != 0`).run(threadKey).changes;
