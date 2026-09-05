import { isDerivedThread } from "../../../src/core/threadkey.js";
import { homeFields, suggestHome } from "./home.js";
import { addMemory, peekMemory } from "../../../src/store/memory.js";
import { isStrongerSignal, upsertReflection } from "./analysis.js";
import { getRecentActivities } from "../../../src/store/events.js";
import {
  getRecentSkillInvocations,
  listSkillUsage,
  evaluateSkillImprove,
  MIN_INVOCATIONS,
  FAIL_RATE_THRESHOLD,
  type SkillImproveGuardSnapshot,
} from "../../../src/store/skill-usage.js";
import {
  GOVERNANCE_TOKENS,
  MIN_DISTINCT_TOOLS,
  SEGMENT_GAP_MS,
  SELF_NAMESPACE,
  SKILL_PROPOSAL_PREFIX,
  SKILL_PROPOSAL_SCAN_DAYS,
  SKILL_PROPOSAL_SCAN_LIMIT,
  SKILL_PROPOSAL_THRESHOLD,
} from "./constants.js";

// ─── V5 — 스킬화 제안 (반복 작업 능동 감지 → suggester) ───────────────────────
// 진실 소스: _workspace/skill_proposal_architect_contract.md §2·§3·§5·§6.
// 순수 함수 + maintenance interval 배치 스캔. 코어 무수정·단방향 보존.

/** 세그먼트화 입력 1행 — getRecentActivities 산출(threadKey/ts/label/kind). */
export interface ActivityRow {
  threadKey: string;
  ts: number;
  label: string;
  kind: string;
}

/** turn 근사 세그먼트 — 같은 threadKey 의 시간 인접 activity 묶음(=1 작업 근사). */
export interface ActivitySegment {
  threadKey: string;
  startTs: number;
  endTs: number;
  /** kind:"tool" label 들(원순서, 정규화 전). fingerprint 가 여기서 파생. */
  toolLabels: string[];
}

/**
 * 메타재귀 §6-2 — skill_proposal 집계는 **사람이 말을 건 대화만** 대상.
 *
 * ★**파생 턴 목록은 코어가 든다**(`threadkey.ts`). 종전엔 여기 사본이 있었고 `worker:`·
 *  `internal` 만 막았다 — 그래서 **`agent:` 가 새어 들었다**: 실측(2026-09-05) 스킬 제안
 *  8건 중 1건이 통째로 서브에이전트 턴에서 만들어졌고(«Bash→Read→Bash→Read→Bash»),
 *  그건 사용자의 작업 흐름이 아니라 **우리가 띄운 하위 작업의 탐색 모양**이다. 사본을
 *  없애면 새 파생 종류가 생겨도 여기 고칠 게 없다([[feedback_hand_maintained_lists]]).
 * ★`internal`·self 네임스페이스는 **이 플러그인 것**이라 여기 남는다(자기 산출물발 활동이
 *  fingerprint 로 재트리거되는 루프 차단 — 코어가 알 이유가 없는 사정이다).
 */
export const isAggregableThreadKey = (threadKey: string): boolean => {
  const k = threadKey.toLowerCase();
  if (isDerivedThread(k)) return false;
  if (k.startsWith("internal")) return false;
  if (k.includes(SELF_NAMESPACE)) return false; // self-growth 경로 방어
  return true;
};

/**
 * persisted llm.activity 행들을 `(threadKey, SEGMENT_GAP_MS)` 로 turn 근사
 * 세그먼트화. 입력은 store 가 `(threadKey ASC, ts ASC)` 정렬해 줬다고 가정하나,
 * 방어적으로 threadKey 별 그룹핑 후 ts 재정렬한다(순수 함수 — 입력 순서 비의존).
 *
 * 규칙(§2.1): 같은 threadKey 안에서 연속 activity 간 간격 ≤ gapMs 면 같은 세그먼트.
 * 초과 시 새 세그먼트. kind:"tool" 만 toolLabels 에 수집(turn coarse floor 는 도구
 * 신호 아님 — openai 자연 제외). worker/internal threadKey 는 §6-2 로 사전 제외.
 */
export const segmentActivities = (
  rows: ActivityRow[],
  gapMs: number = SEGMENT_GAP_MS,
): ActivitySegment[] => {
  // threadKey 별 그룹.
  const byThread = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    if (!isAggregableThreadKey(r.threadKey)) continue; // §6-2 메타재귀
    const list = byThread.get(r.threadKey);
    if (list === undefined) byThread.set(r.threadKey, [r]);
    else list.push(r);
  }

  const segments: ActivitySegment[] = [];
  for (const [threadKey, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts); // 방어적 시간순
    let cur: ActivitySegment | null = null;
    for (const r of list) {
      if (cur === null || r.ts - cur.endTs > gapMs) {
        // 새 세그먼트 시작 — 직전 세그먼트 확정.
        if (cur !== null) segments.push(cur);
        cur = { threadKey, startTs: r.ts, endTs: r.ts, toolLabels: [] };
      }
      cur.endTs = r.ts;
      if (r.kind === "tool") cur.toolLabels.push(r.label);
    }
    if (cur !== null) segments.push(cur);
  }
  return segments;
};

/**
 * 세그먼트 → fingerprint(§2.1 정규화). null 이면 fingerprint 미생성:
 *  - 고유 도구 종류 < MIN_DISTINCT_TOOLS (단일 Read 류 trivial · openai coarse turn),
 *  - 거버넌스 토큰 포함(§5 제외 — 메타·거버넌스 작업).
 *
 * 정규화: label 소문자 → 연속 중복 도구 1개로 접기 → `|` join. 인자·경로는 label 에
 * 없음(도구명만)이라 자연 충족.
 */
export const fingerprintSegment = (seg: ActivitySegment): string | null => {
  const raw = seg.toolLabels.map((l) => l.toLowerCase().trim()).filter((l) => l.length > 0);
  if (raw.length === 0) return null;

  // §5 제외 — 거버넌스 토큰이 도구 label 에 묻어 나오면 제안 대상 아님.
  for (const l of raw) {
    for (const tok of GOVERNANCE_TOKENS) {
      if (l.includes(tok)) return null;
    }
  }

  // 연속 중복 접기.
  const folded: string[] = [];
  for (const l of raw) {
    if (folded.length === 0 || folded[folded.length - 1] !== l) folded.push(l);
  }

  // 최소 고유 도구 게이트 — openai coarse turn(도구 0)·trivial 자연 제외.
  const distinct = new Set(folded);
  if (distinct.size < MIN_DISTINCT_TOOLS) return null;

  return folded.join("|");
};

/** fingerprint → 사람이 읽는 도구 시퀀스(인덱스 description 용). */
export const fingerprintToHuman = (fingerprint: string): string =>
  fingerprint
    .split("|")
    .map((t) => (t.length > 0 ? t[0]!.toUpperCase() + t.slice(1) : t))
    .join(" → ");

/** fingerprint → 멱등 reflection name slug(§3, [^a-z0-9]+→_, cap 60). */
export const fingerprintSlug = (fingerprint: string): string =>
  fingerprint.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);

/** P2 시점 상관 1건 — skill.invoked 의 (스킬명, threadKey, ts). store 가 events 경유 제공. */
export interface SkillInvoke {
  name: string;
  threadKey: string;
  ts: number;
}

/**
 * ★P2 정통 수정 (이름 기반 거버넌스 제외) — 계약 §5.2.
 *
 * 세그먼트 `(threadKey, [startTs,endTs])` 윈도에 *거버넌스 스킬* invoked 가 겹치면 그
 * 세그먼트를 제안 후보에서 제외한다. V5 의 도구-label fingerprint 토큰 추측(QA P2:
 * 스킬명이 invoke_skill *인자* 라 label 에 거의 안 묻어남 → 못 거름)을 *이름 상관*으로
 * 교체 — 이제 skill.invoked.name 으로 스킬명을 직접 안다(오탐 0).
 *
 * 거버넌스 판정은 GOVERNANCE_TOKENS(데이터 평면) substring — harness·principle-check
 * 등 자기 면제(메타재귀). fingerprintSegment 의 도구-label 매칭은 §5.3 잔존 방어로
 * OR 유지(둘 중 하나 걸리면 제외 — 오탐만 줄고 누락은 안 늘림).
 */
export const isGovernanceSegment = (
  seg: ActivitySegment,
  govInvokes: SkillInvoke[],
): boolean =>
  govInvokes.some(
    (g) =>
      g.threadKey === seg.threadKey &&
      g.ts >= seg.startTs &&
      g.ts <= seg.endTs &&
      GOVERNANCE_TOKENS.some((tok) => g.name.toLowerCase().includes(tok)),
  );

/**
 * activity 행들을 세그먼트화 → fingerprint 별 *서로 다른* 세그먼트 수 집계.
 * fingerprint(null 제외)만 카운트. evidence(샘플 세그먼트 근거)도 함께 모은다(≤3).
 *
 * `govInvokes` (P2): 스캔 윈도의 skill.invoked 시점 상관. 거버넌스 스킬이 겹친
 * 세그먼트는 fingerprint 전에 제외(이름 기반, 계약 §5.2). 미지정/빈 배열이면 §5.3
 * 잔존 방어(fingerprintSegment 도구-label)만 작동 — 회귀 0.
 */
export const aggregateFingerprints = (
  rows: ActivityRow[],
  gapMs: number = SEGMENT_GAP_MS,
  govInvokes: SkillInvoke[] = [],
): Map<string, { count: number; samples: string[]; human: string }> => {
  const segs = segmentActivities(rows, gapMs);
  const acc = new Map<string, { count: number; samples: string[]; human: string }>();
  for (const seg of segs) {
    // ★P2 — 거버넌스 스킬 invoked 가 이 세그먼트에 겹치면 제외(이름 상관).
    if (isGovernanceSegment(seg, govInvokes)) continue;
    const fp = fingerprintSegment(seg);
    if (fp === null) continue;
    const entry = acc.get(fp) ?? {
      count: 0,
      samples: [],
      human: fingerprintToHuman(fp),
    };
    entry.count += 1;
    if (entry.samples.length < 3) {
      entry.samples.push(`${seg.threadKey}@${new Date(seg.startTs).toISOString()}`);
    }
    acc.set(fp, entry);
  }
  return acc;
};

/**
 * 단일 fingerprint 후보 분석 → 임계·멱등·growth skip 통과 시 reflection 1건 박기.
 * 자동 박기 경로 *없음* — 전부 reflection(suggester, §4-3 불변식). null 이면 미박기.
 *
 * 순수성: 박기(addMemory)는 부수효과지만 V3 analyzeRepeatedSegment 선례 답습.
 * 멱등 — 같은 fingerprintSlug reflection 이 이미 있으면 재박기 skip(§6-3·§2 멱등).
 */
export const analyzeSkillProposal = (
  fingerprint: string,
  count: number,
  evidence: { samples: string[]; human: string },
  threshold: number = SKILL_PROPOSAL_THRESHOLD,
): { reflectionName: string } | null => {
  if (count < threshold) return null; // 단발·미달 무시(§2.2)

  const slug = fingerprintSlug(fingerprint);
  if (slug.length === 0) return null;
  const reflectionName = `${SKILL_PROPOSAL_PREFIX}${slug}`;

  // growth namespace skip(§6-1) — reflectionName 자체가 growth 라 자기분석 안 됨.
  //
  // ★재발은 **무시가 아니라 갱신**이다 (2026-08-02).
  //  종전엔 `이미 있으면 return null` 이라, 같은 패턴이 또 나와도 카운트도 `updated_at` 도
  //  안 움직였다. 그 결과 제안이 **두 방향으로 죽었다**:
  //   ①메모리 인덱스가 `ORDER BY updated_at DESC` 라 시간이 갈수록 밀려남 → 5주 뒤엔
  //     8건 중 5건이 **캡(8KB) 밖**이라 비서 컨텍스트에 아예 안 실렸다(실측).
  //   ②만료 기계(`archiveStaleReflections`, updatedAt 90일)가 **시계가 안 가서** 한 번도
  //     안 돌았다 — 재발 안 하는 제안조차 영원히 남았다.
  //  갱신 한 줄이면 둘 다 제 기능을 한다: 재발하면 위로 올라오고(배달), 재발이 끊기면
  //  90일 뒤 스스로 아카이브된다(가역·검색 유지). **새 기계를 만들지 않는다.**
  //
  //  ★자동 채택은 여전히 안 한다 — 스킬 작성은 능력 표면 변경이라 human-gated
  //   (`execution_boundary` 참조). 여기서 하는 건 *신호의 세기와 수명*을 바로잡는 것뿐이다.

  const description =
    `반복 작업 감지: '${evidence.human}' 패턴이 ${count}회 — 스킬화하면 반복 절약 가능. ` +
    `사용자에게 'harness 로 스킬 만들까요?' 확인 후 결정 (suggester).`;

  const body = JSON.stringify(
    {
      kind: "skill_proposal",
      observed_fingerprint: fingerprint,
      tool_sequence_human: evidence.human,
      evidence_count: count,
      sample_segments: evidence.samples,
      confidence: 0.4,
      assumed_significance:
        "같은 도구 시퀀스 반복 = 절차화 가능한 작업 후보(행동 지문 근사 — 의미 동일성은 사용자·비서 확인 단계 판정).",
      ...homeFields(suggestHome({ kind: "skill_proposal" })),
      execution_boundary:
        "self-growth 는 제안만. 스킬 파일 작성은 harness:harness(비서 프롬프트 경로).",
    },
    null,
    2,
  );

  const priorProp = peekMemory(reflectionName);
  if (priorProp !== undefined && !isStrongerSignal(priorProp.body, "evidence_count", count)) {
    return null; // 같은 창 재스캔 — 갱신하면 만료 시계만 헛돈다.
  }
  upsertReflection({ name: reflectionName, description, body });

  return { reflectionName };
};

/**
 * 배치 스캔(maintenance interval 합류) — persisted llm.activity 윈도 조회 →
 * 세그먼트화 → fingerprint 집계 → 임계 통과분 각각 analyzeSkillProposal 로 제안.
 *
 * never-throw 계약: store 조회·집계 실패해도 데몬 안 죽음(상위 runMaintenance 도
 * try/catch 지만 방어적 2겹). 박힌 제안 목록 반환(관측·bus.publish 용).
 */
export const runSkillProposalScan = (): {
  reflectionName: string;
  fingerprint: string;
  count: number;
}[] => {
  const out: { reflectionName: string; fingerprint: string; count: number }[] = [];
  const sinceTs = Date.now() - SKILL_PROPOSAL_SCAN_DAYS * 24 * 60 * 60 * 1000;
  const rows = getRecentActivities({
    sinceTs,
    limit: SKILL_PROPOSAL_SCAN_LIMIT,
  });
  // ★P2 — 같은 윈도의 skill.invoked 시점 상관(거버넌스 세그먼트 제외용, 계약 §5.2).
  // events 경유(skill.invoked 영속). 조회 실패는 빈 배열로 강등 → §5.3 잔존 방어만
  // (회귀 0, never-throw — 스캔이 죽지 않게).
  let govInvokes: SkillInvoke[] = [];
  try {
    govInvokes = getRecentSkillInvocations({
      sinceTs,
      limit: SKILL_PROPOSAL_SCAN_LIMIT,
    });
  } catch (e) {
    console.error(`self-growth: getRecentSkillInvocations failed: ${e}`);
  }
  const agg = aggregateFingerprints(rows, SEGMENT_GAP_MS, govInvokes);
  for (const [fingerprint, entry] of agg) {
    if (entry.count < SKILL_PROPOSAL_THRESHOLD) continue;
    const result = analyzeSkillProposal(fingerprint, entry.count, {
      samples: entry.samples,
      human: entry.human,
    });
    if (result !== null) {
      out.push({ reflectionName: result.reflectionName, fingerprint, count: entry.count });
    }
  }
  return out;
};

// ─── Phase 2 (2026-06-24) — 스킬 *개선* 제안 루프 (telemetry 첫 소비처) ──────────
// 진실 소스: _workspace/skill_improve_architect_contract.md + ADR Phase 2 절.
// store 의 evaluateSkillImprove(순수 함수·임계)를 먹어, 사용 多 × 실패율 高 스킬에
// `feedback_growth_skill_improve_<slug>` reflection(suggester) 1건을 박는다. 집행(스킬
// 수정)은 사람→harness:harness — self-growth 는 제안만(단방향, Phase 1 §4-3 승계).
// 신규 코어 기계 0: skill_usage·addMemory/getMemory·reflection 층·maintenance interval·
// TTL cleanup 전부 재사용. 임계는 store 단일 지점(여기선 description 표기에만 재import).

/** 개선 제안 reflection name prefix — growth namespace(isSelfNamespace) → 메타재귀 skip 자동. */
export const SKILL_IMPROVE_PREFIX = `feedback_${SELF_NAMESPACE}_skill_improve_`;
/**
 * 가드 메모 prefix — 재제안 thrash 차단의 *내부 durable 진실 소스*(계약 §3-2·§5-2).
 * 제안 메모(사용자 가시·삭제 가능)와 달리 사용자가 안 지운다 → 쿨다운 스냅샷 보존.
 * reference type·growth namespace·raw addMemory → 메타재귀 0(자기입력 재트리거 없음).
 */
export const SKILL_IMPROVE_GUARD_PREFIX = `growth_skill_improve_guard_`;

/** 스킬명 → 멱등 메모 slug(계약 §5-1, fingerprintSlug 동형 — [^a-z0-9]+→_, cap 60). */
export const skillNameSlug = (skillName: string): string =>
  skillName.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);

/**
 * §6 거버넌스 제외 — skill_usage.skill_name 이 *진짜 스킬명* 이라 GOVERNANCE_TOKENS
 * substring 직접 매칭(Phase 1.5 fingerprint 추측보다 정확, 오탐 0). harness·
 * principle-check·self-growth 등 메타·거버넌스 스킬은 개선 제안 대상 아님(자기 면제).
 */
export const isGovernanceSkill = (skillName: string): boolean => {
  const n = skillName.toLowerCase();
  return GOVERNANCE_TOKENS.some((tok) => n.includes(tok));
};

/**
 * 가드 메모 body → 스냅샷 파싱. 메모 없음/파싱 불가/필드 누락이면 null(최초 제안 취급 →
 * 누적 평가). 음수·NaN 등 비정상 필드는 0 으로 보수 폴백(never-throw). 가드 메모는
 * reference type·SKILL_IMPROVE_GUARD_PREFIX name.
 */
export const readGuardSnapshot = (
  skillName: string,
): SkillImproveGuardSnapshot | null => {
  const memo = peekMemory(`${SKILL_IMPROVE_GUARD_PREFIX}${skillNameSlug(skillName)}`);
  if (memo === undefined) return null;
  try {
    const parsed = JSON.parse(memo.body) as Record<string, unknown>;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    return {
      snapshotInvokeCount: num(parsed.snapshot_invoke_count),
      snapshotSuccessCount: num(parsed.snapshot_success_count),
      snapshotFailCount: num(parsed.snapshot_fail_count),
      snapshotTs: num(parsed.snapshot_ts),
    };
  } catch {
    return null; // 파싱 불가 → 최초 제안 취급(누적). 견고성 우선.
  }
};

/**
 * 가드 메모 upsert — 제안 박는 *순간* 현재 카운트 스냅샷으로 갱신(윈도 전진, 계약 §5-2).
 * reference type(인덱스 노이즈 최소)·growth namespace·raw addMemory(memory.write 미발행)
 * → 메타재귀 0. addMemory 가 본질적 UPSERT(name 충돌 시 덮어씀)라 매번 호출 = 윈도 전진.
 */
export const upsertGuardSnapshot = (
  skillName: string,
  snapshot: {
    invokeCount: number;
    successCount: number;
    failCount: number;
    ts: number;
  },
): void => {
  upsertReflection({
    type: "reference",
    name: `${SKILL_IMPROVE_GUARD_PREFIX}${skillNameSlug(skillName)}`,
    description: `(내부) ${skillName} 개선제안 가드 스냅샷 — 재제안 thrash 차단용`,
    body: JSON.stringify({
      kind: "skill_improve_guard",
      skill_name: skillName,
      snapshot_invoke_count: snapshot.invokeCount,
      snapshot_success_count: snapshot.successCount,
      snapshot_fail_count: snapshot.failCount,
      snapshot_ts: snapshot.ts,
    }),
  });
};

/**
 * 단일 스킬 1행 → 개선 제안 1건 박기(통과 시). null 이면 미박기.
 *
 * 파이프라인(계약 §1):
 *  1. 거버넌스 제외(isGovernanceSkill) — harness 등 자기 면제.
 *  2. 멱등 — 미해결 제안 메모(feedback_growth_skill_improve_<slug>) 존재 시 재제안 0.
 *  3. 가드 스냅샷 조회 → evaluateSkillImprove(누적 or 델타·쿨다운·임계). propose 면 박기.
 *  4. 제안 reflection(suggester) + 가드 메모 스냅샷 upsert(윈도 전진).
 *
 * 멱등(제안 메모 존재)을 evaluate *앞* 에서 거른다 — 같은 스킬 미해결 제안 1건만 떠 있게
 * (계약 §3-1). 단 가드 메모는 멱등과 *별도* 진실 소스라, 사용자가 제안 메모를 지운 뒤에도
 * 가드 스냅샷이 남아 쿨다운이 유효(thrash 차단의 핵심, 계약 §3-2).
 *
 * 순수성: 박기(addMemory)는 부수효과지만 analyzeSkillProposal 선례 답습. 호출자(배치)가
 * try/catch 로 격리.
 */
export const analyzeSkillImprove = (usage: {
  skillName: string;
  invokeCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: number;
}): {
  reflectionName: string;
  basis: "cumulative" | "delta";
  failRate: number;
} | null => {
  // 1. 거버넌스 제외(§6) — 스킬명 직접 매칭(오탐 0).
  if (isGovernanceSkill(usage.skillName)) return null;

  const slug = skillNameSlug(usage.skillName);
  if (slug.length === 0) return null;
  const reflectionName = `${SKILL_IMPROVE_PREFIX}${slug}`;

  // 2. 멱등(§3-1) — 미해결 제안 메모 있으면 재제안 0. growth namespace 라 자기분석도 skip.
  // 재발 갱신 — analysis.ts 와 같은 판정(신호가 세졌을 때만). 옛 `있으면 skip` 은
  //  인덱스 밀림 + 만료 시계 정지 둘 다를 낳았다(2026-08-02).
  const priorImp = peekMemory(reflectionName);
  if (priorImp !== undefined && !isStrongerSignal(priorImp.body, "fail_count", usage.failCount)) {
    return null; // 실패가 더 안 늘었다 — 갱신하면 만료 시계만 헛돈다.
  }

  // 3. 가드 스냅샷(있으면 델타·쿨다운, 없으면 누적) → 순수 평가(store §7).
  const guard = readGuardSnapshot(usage.skillName);
  const evalResult = evaluateSkillImprove(
    {
      skillName: usage.skillName,
      invokeCount: usage.invokeCount,
      successCount: usage.successCount,
      failCount: usage.failCount,
      lastUsedAt: usage.lastUsedAt,
    },
    guard,
  );
  if (!evalResult.propose) return null;

  // 4. 제안 reflection(suggester) — 계약 §5-1 형식. 스냅샷(가드용) 함께 기록.
  const ratePct = Math.round(evalResult.failRate * 1000) / 10; // 소수 1자리 %
  const description =
    `스킬 개선 후보: '${usage.skillName}' ${usage.invokeCount}회 중 ${usage.failCount}회 실패(${ratePct}%) — ` +
    `harness 로 개선할까요? (suggester, 사용자 확인 후 결정)`;

  const body = JSON.stringify(
    {
      kind: "skill_improve_proposal",
      skill_name: usage.skillName,
      evaluation_basis: evalResult.basis, // "cumulative"(최초) | "delta"(재평가)
      invoke_count: usage.invokeCount,
      success_count: usage.successCount,
      fail_count: usage.failCount,
      fail_rate: evalResult.failRate,
      // 가드용 스냅샷 = 제안 시점 현재값(다음 윈도 기준점). 가드 메모와 동일 값.
      snapshot_invoke_count: usage.invokeCount,
      snapshot_success_count: usage.successCount,
      snapshot_fail_count: usage.failCount,
      snapshot_ts: Date.now(),
      confidence: 0.4,
      thresholds: {
        min_invocations: MIN_INVOCATIONS,
        fail_rate_threshold: FAIL_RATE_THRESHOLD,
      },
      ...homeFields(suggestHome({ kind: "skill_improve" })),
      execution_boundary:
        "self-growth 는 skill_usage 읽기 + 제안만. 스킬 수정은 harness:harness.",
    },
    null,
    2,
  );

  upsertReflection({ name: reflectionName, description, body });

  // 가드 메모 스냅샷 upsert(§3-2·§5-2) — 제안 메모를 사용자가 지워도 이게 남아 쿨다운 유효.
  upsertGuardSnapshot(usage.skillName, {
    invokeCount: usage.invokeCount,
    successCount: usage.successCount,
    failCount: usage.failCount,
    ts: Date.now(),
  });

  return {
    reflectionName,
    basis: evalResult.basis,
    failRate: evalResult.failRate,
  };
};

/**
 * 배치 스캔(maintenance interval 합류) — listSkillUsage() → 행마다 analyzeSkillImprove.
 * never-throw: store 조회·평가·박기 실패해도 데몬·다른 maintenance 안 죽음(상위
 * runSkillImproveProposals 도 try/catch — 2겹 견고성). 박힌 제안 목록 반환(관측·publish 용).
 */
export const runSkillImproveScan = (): {
  reflectionName: string;
  skillName: string;
  basis: "cumulative" | "delta";
  failRate: number;
}[] => {
  const out: {
    reflectionName: string;
    skillName: string;
    basis: "cumulative" | "delta";
    failRate: number;
  }[] = [];
  const rows = listSkillUsage();
  for (const row of rows) {
    try {
      const result = analyzeSkillImprove(row);
      if (result !== null) {
        out.push({
          reflectionName: result.reflectionName,
          skillName: row.skillName,
          basis: result.basis,
          failRate: result.failRate,
        });
      }
    } catch (e) {
      // 행 단위 격리 — 한 스킬 평가 실패가 나머지 스캔을 못 멈추게(견고성).
      console.error(
        `self-growth: skill improve eval failed for '${row.skillName}': ${e}`,
      );
    }
  }
  return out;
};
