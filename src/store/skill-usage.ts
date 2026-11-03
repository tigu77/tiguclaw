/**
 * 스킬 사용 텔레메트리 — 장기 누적 카운트 (2026-06-24).
 *
 * 진실 소스: `_workspace/skill_telemetry_architect_contract.md` §3·§5.
 *
 * 역할 분리(원칙 5 — events/메모리 재구현 아님):
 *  - `skill_usage` 테이블 = *장기 누적 카운트*(prune 무관, skill_name 당 1행). 시점·
 *    threadKey 상관은 안 가짐 — 그건 events(시점 상관)의 진실.
 *  - `success_count`·`fail_count` 열은 옛 자가성장 플러그인이 쓰던 결과 축이다(2026-11-03 제거) — 쓰는 쪽이 없어
 *    값이 멈춘 채 남는다(열 삭제는 마이그레이션이라 하지 않는다). 읽기(`listSkillUsage`)는 그대로 돌려준다.
 *
 * 횟수는 코어 `invoke_skill` 이 성공 호출마다 `recordSkillInvocation` 으로 upsert 한다(2026-10-15 — 종전엔
 * 자가성장 플러그인이 `skill.invoked` 를 받아 적어서, 그 플러그인이 꺼지면 기록이 멈췄다). never-throw 는
 * 호출자 책임 — 본 모듈은 events.ts 동형 순수 CRUD.
 */
import { getDb } from "./sessions.js";

/**
 * skill.invoked 1건 반영 — 멱등 upsert(count +1, last_used 갱신).
 *
 * INSERT … ON CONFLICT 로 race-free 증분(동시 turn 도 SQLite 단일 write lock 하 안전).
 * never-throw 는 호출자(`invoke_skill` 의 try/catch). 본 함수는 throw 가능
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
 * 전체 사용 통계 — 스킬 레지스트리·대시보드. count desc, ties → 최근.
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
