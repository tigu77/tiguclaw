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
  // ★json_valid 가드(2026-07-09, getRecentActivities 동형): 깨진 JSON payload 행이 json_extract
  // 를 통째로 터뜨리지 못하게 inner 에서 유효 행만 걸러 투영.
  const innerWhere: string[] = [`type = 'skill.invoked'`, `json_valid(payload)`];
  const params: unknown[] = [];
  if (opts?.sinceTs !== undefined) {
    innerWhere.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 5000;
  const rows = getDb()
    .prepare(
      `SELECT name, threadKey, ts FROM (
         SELECT
           json_extract(payload, '$.name')      AS name,
           json_extract(payload, '$.threadKey') AS threadKey,
           ts
         FROM events
         WHERE ${innerWhere.join(" AND ")}
       )
       WHERE name IS NOT NULL AND threadKey IS NOT NULL
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

// ─── self-growth Phase 2 (2026-06-24) — 스킬 *개선* 제안 평가 (telemetry 첫 소비) ──
// 진실 소스: _workspace/skill_improve_architect_contract.md §2·§3·§4·§7 + ADR Phase 2 절.
//
// store 의 책임은 *순수 평가 함수 + 임계 상수* 단일 지점뿐(계약 §7 작업 분배). 거버넌스
// 제외·메모 R/W·멱등·박기는 self-growth(메모 store 는 self-growth 도메인 — SQL 에 스킬명
// 하드코딩 0). 이 함수는 DB 를 안 만진다 — listSkillUsage 의 1행 + (선택)가드 스냅샷만 본다.

/**
 * 임계 상수 (계약 §4) — 기본값 + env override. Phase 1 REPEAT_THRESHOLD 패턴 답습.
 * 운영 튜닝 노브일 뿐 어댑터 분기 키 아님(원칙 2 무관). env 가 NaN/≤0 등 비정상이면
 * 기본값으로 폴백(never-throw). 분기 키 아니라 스팸 방지 임계 = focus_on_essence 정당.
 */
const parseIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parseFloatEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 최소 사용량 — 통계 의미·단발 스팸 방지. */
export const MIN_INVOCATIONS = parseIntEnv(
  process.env.TIGUCLAW_SKILL_IMPROVE_MIN_INVOCATIONS,
  5,
);
/** 누적/델타 공통 실패율 임계(30%). */
export const FAIL_RATE_THRESHOLD = parseFloatEnv(
  process.env.TIGUCLAW_SKILL_IMPROVE_FAIL_RATE,
  0.3,
);
/** 재평가 전 필요한 *신규* 호출 수(쿨다운 — 충분히 더 써본 뒤에만 다시 본다). */
export const COOLDOWN_INVOCATIONS = parseIntEnv(
  process.env.TIGUCLAW_SKILL_IMPROVE_COOLDOWN,
  5,
);

/** 가드 메모(growth_skill_improve_guard_<slug>)에 담기는 durable 스냅샷(계약 §3-2·§5-2). */
export interface SkillImproveGuardSnapshot {
  snapshotInvokeCount: number;
  snapshotSuccessCount: number;
  snapshotFailCount: number;
  snapshotTs: number;
}

/** listSkillUsage() 1행 — evaluateSkillImprove 입력(누적 카운트). */
export interface SkillUsageRow {
  skillName: string;
  invokeCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: number;
}

/** propose 판정 결과 — basis 가 cumulative(최초)/delta(재평가) 중 어느 쪽으로 본 건지 함께. */
export interface SkillImproveEvaluation {
  propose: boolean;
  basis: "cumulative" | "delta";
  /** 판정에 쓴 실패율(누적 또는 델타). 제안 메모 body 근거 기록용. */
  failRate: number;
}

/**
 * 스킬 1행 + (선택)가드 스냅샷 → 개선 제안 여부 평가 (순수 함수, DB 무접근).
 *
 * 거버넌스 제외·멱등(미해결 제안 메모 존재)은 *호출자(self-growth)* 책임 — 이 함수는
 * 그 이전에 통과한 행만 받는다. 여기선 임계·쿨다운·누적/델타 실패율만 본다.
 *
 * **스냅샷 null(최초 제안 — 가드 메모 없음):** 누적 `fail/invoke`(전체 이력이 유일 신호).
 *  - propose = `invokeCount ≥ MIN_INVOCATIONS` AND `누적 실패율 ≥ FAIL_RATE_THRESHOLD`.
 *
 * **스냅샷 있음(재평가):** 신규분만 본다(과거 실패 오염 제거 = 자가교정의 본질).
 *  1. 쿨다운 — `invokeCount − snapInvoke < COOLDOWN_INVOCATIONS` 면 **propose=false**
 *     (충분한 새 호출이 쌓이기 전엔 재평가 자체를 보류 — thrash 차단).
 *  2. 델타 실패율 = `(fail−snapFail)/(invoke−snapInvoke)`. 신규 분모(신규 호출 수)도
 *     `≥ MIN_INVOCATIONS` 여야 통계 의미(쿨다운 통과만으론 부족할 수 있음 — 둘 다 게이트).
 *  3. propose = `델타 실패율 ≥ FAIL_RATE_THRESHOLD`(신규분도 나쁨 = 개선 안 먹힘/새 양상).
 *     신규분이 깨끗하면 false(개선이 먹혔다 — 가드 스냅샷만 전진은 호출자가).
 *
 * 비정상 입력(invoke ≤ 0, 신규 분모 ≤ 0 등)은 propose=false 로 보수적 수렴(never-throw —
 * 분기 없음, 나눗셈 가드만). 음수 델타(스냅샷이 현재보다 큼 — 카운트 리셋 등 이상)도 false.
 */
export const evaluateSkillImprove = (
  usage: SkillUsageRow,
  guardSnapshot: SkillImproveGuardSnapshot | null,
): SkillImproveEvaluation => {
  const { invokeCount, failCount } = usage;

  // ── 최초 제안(가드 메모 없음) — 누적 실패율(계약 §2 표). ──
  if (guardSnapshot === null) {
    if (invokeCount < MIN_INVOCATIONS) {
      return { propose: false, basis: "cumulative", failRate: 0 };
    }
    if (invokeCount <= 0) {
      return { propose: false, basis: "cumulative", failRate: 0 };
    }
    const cumRate = failCount / invokeCount;
    return {
      propose: cumRate >= FAIL_RATE_THRESHOLD,
      basis: "cumulative",
      failRate: cumRate,
    };
  }

  // ── 재평가(가드 메모 있음) — 신규-호출 쿨다운 + 델타 실패율(계약 §3-2·§3-3). ──
  const newInvokes = invokeCount - guardSnapshot.snapshotInvokeCount;
  const newFails = failCount - guardSnapshot.snapshotFailCount;

  // 쿨다운 — 충분한 새 호출이 쌓이기 전엔 재평가 보류.
  if (newInvokes < COOLDOWN_INVOCATIONS) {
    return { propose: false, basis: "delta", failRate: 0 };
  }
  // 신규 분모도 최소 사용량 게이트(통계 의미) + 0 나눗셈·음수 가드.
  if (newInvokes < MIN_INVOCATIONS || newInvokes <= 0) {
    return { propose: false, basis: "delta", failRate: 0 };
  }
  // 음수 fail(스냅샷 > 현재 — 카운트 이상)은 0 으로 클램프(보수적, 실패율 음수 방지).
  const deltaFails = newFails > 0 ? newFails : 0;
  const deltaRate = deltaFails / newInvokes;
  return {
    propose: deltaRate >= FAIL_RATE_THRESHOLD,
    basis: "delta",
    failRate: deltaRate,
  };
};
