/**
 * 스킬 사용 텔레메트리 — 장기 누적 카운트 (self-growth Phase 1.5, 2026-06-24).
 *
 * 진실 소스: `_workspace/skill_telemetry_architect_contract.md` §3·§5.
 *
 * 역할 분리(원칙 5 — events/메모리 재구현 아님):
 *  - `skill_usage` 테이블 = *장기 누적 카운트*(prune 무관, skill_name 당 1행). 시점·
 *    threadKey 상관은 안 가짐 — 그건 events(시점 상관)의 진실.
 *  - `getRecentSkillInvocations` 는 events(`type='skill.invoked'`) 경유 *시점 상관*
 *    (P2 세그먼트-거버넌스 제외용). skill_usage 와 목적 분리.
 *
 * 코어는 이 모듈을 모른다(단방향). self-growth 가 generic `skill.invoked` 를 구독해
 * `recordSkillInvocation` 으로 upsert. never-throw 는 호출자(self-growth) 책임 —
 * 본 모듈은 events.ts 동형 순수 CRUD.
 */
import { getDb } from "./sessions.js";

/**
 * skill.invoked 1건 반영 — 멱등 upsert(count +1, last_used 갱신).
 *
 * INSERT … ON CONFLICT 로 race-free 증분(동시 turn 도 SQLite 단일 write lock 하 안전).
 * never-throw 는 호출자(self-growth handleSkillInvoked try/catch). 본 함수는 throw 가능
 * — DB 실패 시 호출자가 가린다(원칙 3, 데몬 생존).
 */
export const recordSkillInvocation = (skillName: string, ts: number): void => {
  getDb()
    .prepare(
      `INSERT INTO skill_usage (skill_name, invoke_count, last_used_at)
         VALUES (?, 1, ?)
       ON CONFLICT(skill_name) DO UPDATE SET
         invoke_count = invoke_count + 1,
         last_used_at = excluded.last_used_at`,
    )
    .run(skillName, ts);
};

/**
 * skill 결과 1건 반영 — Phase 1.6(2026-06-24, 결과 축). ok=true → success_count+1,
 * ok=false → fail_count+1. "이 스킬 자꾸 실패한다"를 계산 가능하게 누적(Phase 2 연료).
 *
 * UPDATE only(upsert 안 함): self-growth 가 *그 턴에 invoke 된* 스킬에만 귀속하므로
 * 행은 recordSkillInvocation 가 *선행해 이미 존재*한다(invoke 없는 결과 귀속은 정의상
 * 불가). 행이 없으면(이론상 invoke 누락) UPDATE 가 0행 변경 = 조용한 no-op — 없는
 * 스킬 carcass row 를 만들지 않는다(스키마 위생). never-throw 는 호출자(self-growth
 * 턴 핸들러 try/catch). 본 함수는 events.ts 동형 순수 CRUD — throw 가능, 호출자가 가림.
 */
export const recordSkillOutcome = (skillName: string, ok: boolean): void => {
  const column = ok ? "success_count" : "fail_count";
  getDb()
    .prepare(
      `UPDATE skill_usage SET ${column} = ${column} + 1 WHERE skill_name = ?`,
    )
    .run(skillName);
};

/** 단일 스킬 누적 카운트 — P2/대시보드 조회. 없으면 null. */
export const getSkillUsage = (
  skillName: string,
): {
  invokeCount: number;
  lastUsedAt: number;
  successCount: number;
  failCount: number;
} | null => {
  const row = getDb()
    .prepare(
      `SELECT invoke_count AS invokeCount, last_used_at AS lastUsedAt,
              success_count AS successCount, fail_count AS failCount
         FROM skill_usage
        WHERE skill_name = ?`,
    )
    .get(skillName) as
    | {
        invokeCount: number;
        lastUsedAt: number;
        successCount: number;
        failCount: number;
      }
    | undefined;
  return row ?? null;
};

/**
 * 전체 사용 통계 — Phase 2(개선/정리 루프) 입력 + 대시보드. count desc, ties → 최근.
 * limit 미지정 시 cap(무한 반환 방지).
 */
export const listSkillUsage = (opts?: {
  limit?: number;
}): {
  skillName: string;
  invokeCount: number;
  lastUsedAt: number;
  successCount: number;
  failCount: number;
}[] => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 200;
  return getDb()
    .prepare(
      `SELECT skill_name AS skillName, invoke_count AS invokeCount, last_used_at AS lastUsedAt,
              success_count AS successCount, fail_count AS failCount
         FROM skill_usage
        ORDER BY invoke_count DESC, last_used_at DESC
        LIMIT ?`,
    )
    .all(limit) as {
    skillName: string;
    invokeCount: number;
    lastUsedAt: number;
    successCount: number;
    failCount: number;
  }[];
};

/**
 * 스캔 윈도 안 skill.invoked 의 `(name, threadKey, ts)` 목록 — P2 세그먼트-거버넌스
 * 제외용 *시점 상관*. `getRecentActivities`(events.ts) 동형 SELECT —
 * `type='skill.invoked'` + json_extract(payload).
 *
 * 거버넌스 이름 판정은 호출자(self-growth `GOVERNANCE_TOKENS`)가 한다 — store SQL 에
 * 이름 하드코딩 안 함(원칙 5, 테스트·진화 용이). skill.invoked 는 events denylist 라
 * *자동 영속*(SKIP_TYPES 아님). name/threadKey 누락 행(구버전·ctx 미지정)은 자연 제외.
 *
 * 주의(역할 분리): 시각·threadKey 상관은 events 가 진실 — skill_usage 는 카운트만이라
 * 시점 상관에 못 씀. 그래서 이 조회는 skill_usage 가 아니라 events 경유.
 */
export const getRecentSkillInvocations = (opts?: {
  sinceTs?: number;
  limit?: number;
}): { name: string; threadKey: string; ts: number }[] => {
  const where: string[] = [
    `type = 'skill.invoked'`,
    `json_extract(payload, '$.name') IS NOT NULL`,
    `json_extract(payload, '$.threadKey') IS NOT NULL`,
  ];
  const params: unknown[] = [];
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 5000;
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(payload, '$.name')      AS name,
         json_extract(payload, '$.threadKey') AS threadKey,
         ts
       FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    name: string | null;
    threadKey: string | null;
    ts: number;
  }[];
  return rows
    .filter(
      (r): r is { name: string; threadKey: string; ts: number } =>
        typeof r.name === "string" && typeof r.threadKey === "string",
    )
    .map((r) => ({ name: r.name, threadKey: r.threadKey, ts: r.ts }));
};
