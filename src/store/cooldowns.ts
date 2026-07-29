/**
 * 어댑터 쿨다운 영속 (2026-07-28).
 *
 * ★왜 필요한가 — 쿨다운이 프로세스 메모리(`llm-runtime/index.ts` `cooldownUntil` Map)에만
 *  있어서 **재시작마다 통째로 사라졌다.** 실측(2026-07-27): 데몬 부팅 22회 · 쿨다운 기록 38건 ·
 *  429 턴 에러 22건이 1:1로 붙는다 — 매 재시작 직후 첫 턴이 이미 죽은 백엔드를 다시 두드렸다.
 *  에러 본문에는 `resets_in_seconds`(실측 5.4일)가 이미 들어 있었는데도 그렇다.
 *
 *  더 나쁜 건 관측이다: `/status` 의 "쿨다운 중인 모델" 표시(2026-07-26)는 이 Map 을 읽으므로,
 *  재시작 후엔 **"쿨다운 없음"으로 보인다.** "폴백이 6일 공백을 가렸다" 는 그 사고가 재시작
 *  한 번으로 되돌아온다.
 *
 * 설계: 키(provider) → 만료 epoch(ms) 한 행. 절대시각이라 부팅 시 남은 시간이 자동 계산된다.
 *  만료분은 로드 시 걸러내고 지운다(핫경로 바운드 — 행 수는 provider 수만큼으로 자연 제한).
 */
import { getDb } from "./sessions.js";

interface CooldownRow {
  key: string;
  until_ts: number;
}

/** 쿨다운 등록/갱신 — 같은 키는 덮어쓴다(최신 만료가 진실). */
export const saveCooldown = (key: string, untilTs: number): void => {
  try {
    getDb()
      .prepare(
        `INSERT INTO cooldowns (key, until_ts, last_probe_ts) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET until_ts = excluded.until_ts, last_probe_ts = excluded.last_probe_ts`,
      )
      .run(key, untilTs, Date.now());
  } catch (err) {
    // best-effort — 영속 실패가 턴을 깨지 않는다(메모리 Map 은 그대로 동작).
    console.error(
      `[cooldowns] save 실패(무시): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/** 쿨다운 해제(성공 회복 등). */
export const deleteCooldown = (key: string): void => {
  try {
    getDb().prepare(`DELETE FROM cooldowns WHERE key = ?`).run(key);
  } catch {
    /* best-effort */
  }
};

/**
 * 부팅 복원 — **아직 만료되지 않은** 항목만 반환하고, 만료분은 그 자리에서 정리한다.
 * 실패 시 빈 배열(쿨다운 없이 시작 = 종전 동작, 회귀 0).
 */
/**
 * 단건 조회 — 살아있으면 {해제시각, 마지막 탐침시각}, 아니면 null(만료 행은 지운다).
 *
 * ★쿨다운의 **진실은 DB** 다 (2026-07-28). 메모리 Map 만 보면 외부에서 지운 것(재인증 CLI,
 *  다른 프로세스)이 돌고 있는 데몬에 안 먹혀 "인증했는데 왜 안 풀리지" 가 된다.
 *  조회 비용은 인덱스된 PK 단건이라 무시 가능(턴당 수 회).
 */
export const getCooldownRow = (
  key: string,
  nowTs: number,
): { untilTs: number; lastProbeTs: number } | null => {
  const db = getDb();
  const row = db
    .prepare(`SELECT until_ts, last_probe_ts FROM cooldowns WHERE key = ?`)
    .get(key) as { until_ts?: number; last_probe_ts?: number } | undefined;
  const until = typeof row?.until_ts === "number" ? row.until_ts : 0;
  if (until <= 0) return null;
  if (until <= nowTs) {
    db.prepare(`DELETE FROM cooldowns WHERE key = ?`).run(key);
    return null;
  }
  return {
    untilTs: until,
    lastProbeTs: typeof row?.last_probe_ts === "number" ? row.last_probe_ts : 0,
  };
};

/** 탐침 시각 기록 — 성공·실패 무관(허용한 시점 기준). 다음 탐침 간격의 기준이 된다. */
export const markCooldownProbe = (key: string, nowTs: number): void => {
  try {
    getDb()
      .prepare(`UPDATE cooldowns SET last_probe_ts = ? WHERE key = ?`)
      .run(nowTs, key);
  } catch {
    /* best-effort — 기록 실패해도 탐침 자체는 진행(다음에 또 탐침할 뿐) */
  }
};

export const loadLiveCooldowns = (nowTs: number): Array<{ key: string; untilTs: number }> => {
  try {
    const db = getDb();
    db.prepare(`DELETE FROM cooldowns WHERE until_ts <= ?`).run(nowTs);
    const rows = db
      .prepare(`SELECT key, until_ts FROM cooldowns WHERE until_ts > ?`)
      .all(nowTs) as CooldownRow[];
    return rows.map((r) => ({ key: r.key, untilTs: r.until_ts }));
  } catch (err) {
    console.error(
      `[cooldowns] load 실패(쿨다운 없이 시작): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
};
