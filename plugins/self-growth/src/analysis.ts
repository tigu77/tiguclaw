import {
  addMemory,
  getMemory,
  listMemories,
} from "../../../src/store/memory.js";
import {
  getRecentSkillInvocations,
  recordSkillOutcome,
} from "../../../src/store/skill-usage.js";
import {
  DRIFT_THRESHOLD,
  REPEAT_THRESHOLD,
  SELF_NAMESPACE,
} from "./constants.js";

export interface MemoryWritePayload {
  name?: string;
  memoryType?: string;
  action?: string;
}

/**
 * skill.invoked generic 이벤트 payload — region(invoke_skill MCP 단일 지점)이 발행.
 * 코어 `SkillInvokedPayload`(types.ts)와 구조 동형이나 self-growth 는 *구조적으로만*
 * 소비(코어 타입 import 안 함 — 단방향, 데이터로만). name 만 필수 사용, 나머지 optional.
 */
export interface SkillInvokedPayload {
  name?: string;
  channel?: string;
  threadKey?: string;
  adapter?: string;
}

/**
 * 메모 name 에서 segment 를 robust 하게 추출 (하이픈·언더스코어 공용).
 *
 * 비서(LLM)는 feedback 메모 name 을 일관된 구분자/접두로 만들지 않는다
 * (`feedback-obs-...`, `style-...`, `feedback_growth_...` 모두 관측됨).
 * 원칙 "어떤 기능이든 LLM 무관" — 탐지가 LLM 의 정확한 네이밍에 의존하면 안 됨.
 *
 * 규칙:
 *  - `/[-_]/` 로 토큰화 (하이픈·언더스코어 모두 구분자로 취급).
 *  - 첫 토큰이 "feedback" 이면 segment = 2번째 토큰 (`feedback-obs-*` → "obs").
 *  - 첫 토큰이 "feedback" 이 아니면 segment = 첫 토큰 (`style-*` → "style").
 *  - 토큰이 부족하면 null.
 */
export const parseSegment = (name: string): string | null => {
  const tokens = name.split(/[-_]/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const first = tokens[0]!;
  if (first === "feedback") {
    // feedback 단독(2번째 토큰 없음) 은 segment 없음.
    return tokens.length >= 2 ? tokens[1]! : null;
  }
  return first;
};

/**
 * growth namespace (self-growth 자기 reflection) 메모 여부 — 하이픈·언더스코어 무관.
 * `feedback_growth_*` / `feedback-growth-*` / segment==="growth" 모두 차단.
 * plugin 자기 reflection 이 입력으로 재분석되는 메타-재귀를 막는다.
 */
export const isSelfNamespace = (name: string): boolean => {
  return parseSegment(name) === SELF_NAMESPACE;
};

/**
 * 메모 name 에서 segment 를 robust 하게 추출해, 같은 segment feedback 메모리가
 * N≥threshold 누적 시 reflection 메모리 박음. 이미 박혀 있으면 null (멱등).
 *
 * 토큰화·segment·member 매칭 모두 parseSegment 기반 — 하이픈/언더스코어/접두 무관.
 */
export const analyzeRepeatedSegment = (
  newMemoryName: string,
  threshold: number = REPEAT_THRESHOLD,
): { reflectionName: string; segment: string; members: string[] } | null => {
  const segment = parseSegment(newMemoryName);
  if (segment === null) return null;
  if (segment === SELF_NAMESPACE) return null; // 메타-재귀 차단 (growth)

  // member 매칭도 robust — 문자열 prefix 가 아니라 각 메모를 같은 규칙으로
  // 파싱해 segment 비교 (하이픈/언더스코어/접두 무관 동일 그룹핑).
  const all = listMemories({ type: "feedback", limit: 10000 });
  const members = all
    .filter((m) => parseSegment(m.name) === segment)
    .map((m) => m.name);
  if (members.length < threshold) return null;

  const reflectionName = `feedback_${SELF_NAMESPACE}_reflection_segment_${segment}`;
  if (getMemory(reflectionName) !== undefined) return null;

  const body = JSON.stringify(
    {
      observed_pattern: `feedback 메모리 segment '${segment}' 가 ${members.length}건 반복 (구분자·접두 무관 robust 그룹핑)`,
      members,
      evidence_count: members.length,
      assumed_significance:
        "동일 영역의 반복 피드백 — 상위 정책으로 통합 또는 영역 명시화 후보",
      confidence: 0.4,
      triggered_by: newMemoryName,
      suggested_action:
        "비서가 사용자에게 segment 통합/명시화 의향 명시 확인. 단발 거절 가능 (이 reflection delete).",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reflectionName,
    description: `'${segment}' segment 반복 (${members.length}건) — suggester only, 비서가 사용자 확인 후 결정`,
    body,
  });

  return { reflectionName, segment, members };
};

/**
 * V2 drift monitor — 같은 메모 update 카운트 추적.
 * N≥threshold update 시 `feedback_growth_drift_<name>` reflection 박음.
 * 멱등 — 이미 박혀 있으면 null.
 */
export const analyzeDriftPattern = (
  memoryName: string,
  updateCount: number,
  threshold: number = DRIFT_THRESHOLD,
): { reflectionName: string; updateCount: number } | null => {
  if (updateCount < threshold) return null;

  // 메타-재귀 차단 — growth namespace 메모는 분석 skip (하이픈·언더스코어 무관).
  if (isSelfNamespace(memoryName)) return null;

  const reflectionName = `feedback_${SELF_NAMESPACE}_drift_${memoryName}`;
  if (getMemory(reflectionName) !== undefined) return null;

  const body = JSON.stringify(
    {
      observed_pattern: `메모 '${memoryName}' 가 ${updateCount}회 update — 인격 정합 표류 의심`,
      target_memory: memoryName,
      update_count: updateCount,
      assumed_cause:
        "사용자 의도가 시간에 따라 변하고 있거나, 비서가 사용자 의도를 잘못 추정해 반복 정정 받는 중. SYSTEM.md §Identity 보존선 검토 후보.",
      confidence: 0.4,
      suggested_action:
        "비서가 사용자에게 해당 메모의 정합성 명시 확인. 의도 변경이면 영구 박음, 잘못 추정이면 메모 본문 검토 또는 delete.",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reflectionName,
    description: `'${memoryName}' 메모 ${updateCount}회 update — drift 의심, 사용자 확인 필요`,
    body,
  });

  return { reflectionName, updateCount };
};

/**
 * V2.1 TTL cleanup — `feedback_growth_*` reflection 메모 중 `updated_at` 이
 * thresholdDays 일 이전인 것 자동 삭제. 사용자 미확인 suggestion 의 기각 처리.
 * 삭제된 메모 갯수 반환. 0 개면 console log 0 (noise 0).
 *
 * thresholdDays = 0 시 모든 reflection 삭제 (테스트 용도).
 */
// ─── V3 입력 페이로드 (region contract — 진실 소스) ───────────────────────────
// region 이 facade 단일 지점에서 LLM-agnostic 발행. 여기선 *읽기만* — adapter 는
// 라벨일 뿐 분기 키가 아니다 (원칙 2 하드게이트). 효율 지표를 코어 라우팅으로
// 역류시키지 않는다(관측 메모까지만).
export interface TurnErrorPayload {
  channel?: string;
  threadKey?: string;
  adapter?: string;
  model?: string;
  durationMs?: number;
  ok?: boolean;
  errorKind?: string;
  message?: string;
  subagentDepth?: number;
  workerDepth?: number;
}

export interface TurnDonePayload {
  channel?: string;
  threadKey?: string;
  adapter?: string;
  model?: string;
  durationMs?: number;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  subagentDepth?: number;
  workerDepth?: number;
}

// ─── Phase 1.6 (2026-06-24) — 스킬 결과 축 상관 ──────────────────────────────
// 신호 이미 있음(skill.invoked·turn_done/turn_error), 상관만 더한다(새 이벤트 0).
// 턴 종료 이벤트(durationMs+threadKey 보유) → 턴 윈도 [ts-durationMs, ts]. 그 윈도·
// threadKey 의 skill.invoked = 그 턴에 쓰인 스킬 → 각각 recordSkillOutcome(name, ok).
//
// 귀속 휴리스틱: 한 턴에 여러 스킬 → 그 턴 결과를 invoke 된 스킬 *전부* 에 귀속.
// suggester 라 OK — Phase 2 가 집계(성공률)로 정제. 윈도에 스킬 0개면 no-op.
// 메타재귀: 읽기(getRecentSkillInvocations)+upsert(recordSkillOutcome)만 — 새 이벤트
// 발행 0이라 자기입력 루프 신규 위험 0. 워커 턴(threadKey=worker:)도 그 스킬 사용은
// 유효하니 자연 포함(거버넌스 제외는 P2 제안 경로에만 적용, 결과 누적엔 무관).

/** turn_done/turn_error 의 결과 상관 입력 — threadKey + durationMs + ok. */
export interface TurnOutcomeWindow {
  threadKey?: string;
  durationMs?: number;
  ok: boolean;
}

/**
 * 한 턴의 결과를 그 턴 윈도에 invoke 된 스킬 전부에 귀속.
 *
 * 윈도 = [endTs - durationMs, endTs]. durationMs 미지정/비양수면 윈도 미정 → no-op
 * (없는 윈도로 무관한 스킬에 오귀속하지 않음 — 보수적). threadKey 미지정도 no-op
 * (어떤 턴인지 모르면 상관 불가). getRecentSkillInvocations(sinceTs=윈도 시작)로 후보
 * 조회 후 ts ≤ endTs && threadKey 일치만 채택. 같은 스킬 여러 번 invoke 시 횟수만큼
 * 귀속(중복 제거 안 함 — invoke 마다 1 결과가 정직).
 *
 * 반환: 귀속된 스킬명 목록(관측·로그용). store 조회·upsert 실패는 호출자 try/catch.
 */
export const correlateTurnOutcome = (
  win: TurnOutcomeWindow,
  endTs: number,
): string[] => {
  const { threadKey, durationMs, ok } = win;
  if (typeof threadKey !== "string" || threadKey.length === 0) return [];
  if (typeof durationMs !== "number" || durationMs <= 0) return [];
  const startTs = endTs - durationMs;

  // sinceTs=startTs 로 윈도 하한 필터(store SQL). 상한(endTs)·threadKey 는 여기서.
  const invokes = getRecentSkillInvocations({ sinceTs: startTs });
  const attributed: string[] = [];
  for (const inv of invokes) {
    if (inv.threadKey !== threadKey) continue;
    if (inv.ts > endTs) continue; // 윈도 상한
    recordSkillOutcome(inv.name, ok);
    attributed.push(inv.name);
  }
  return attributed;
};

/**
 * 에러 message 를 군집 키로 정규화 — 휘발성 토큰(숫자·id·경로·해시) 제거 후 prefix.
 * region 이 message 를 500자 cap 하므로 여기선 다시 정규화+짧은 prefix 만.
 * 같은 종류의 실패가 표면 텍스트(타임스탬프·요청id)만 달라도 같은 키로 묶이게 한다.
 */
export const normalizeErrorMessage = (raw: string): string => {
  return (
    raw
      .toLowerCase()
      .replace(/0x[0-9a-f]+/g, "<hex>")
      .replace(/\b[0-9a-f]{8,}\b/g, "<hash>")
      // P1-b 수정(2026-06-22): 숫자 + 흔한 단위 접미사(ms/s/sec/m/min/h/kb/mb/gb/b/%)를
      // 통째로 마스킹. 단어경계(\b) 의존 시 "30000ms" 의 30000 뒤에 \b 가 없어(둘 다 단어문자)
      // 마스킹 실패 → 30000ms/45000ms 가 다른 군집키로 분산돼 threshold 누적 못 함.
      // 단위 토큰까지 함께 <n> 으로 치환해 같은 타임아웃 반복이 한 키로 묶이게 한다.
      .replace(/\d+(\.\d+)?\s*(ms|sec|s|min|m|h|kb|mb|gb|b|%)\b/g, "<n>")
      // 나머지 순수 숫자 런(단위 없는 카운트·코드·id) — 경계 무관하게 마스킹.
      .replace(/\d+(\.\d+)?/g, "<n>")
      .replace(/\/[^\s]+/g, "<path>")
      // 연속 <n>(예: "<n><n>", "<n> <n>") 1개로 접어 분산 방지.
      .replace(/(<n>\s*)+/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
  );
};

/**
 * 실패 학습 키 — (errorKind, adapter, normalized message prefix). channel/threadKey 는
 * 키에 넣지 않는다 (같은 종류 작업이 여러 thread 에서 나도 같은 패턴으로 학습되게).
 */
export const failureKey = (p: {
  errorKind: string;
  adapter: string;
  messageNorm: string;
}): string => `${p.errorKind}|${p.adapter}|${p.messageNorm}`;
