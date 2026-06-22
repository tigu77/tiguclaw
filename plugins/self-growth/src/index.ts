/**
 * self-growth plugin — observer capability (자가 성장 V1, 2026-05-22).
 *
 * 역할 (확장 여지 — V1 은 Reflection 단계만, V2+ 에서 Validator/Cleanup/Drift 등 추가):
 *  - V1 (지금): 시간 축 관측 + 반복 패턴 추정 + suggestion 메모리 박기. *적용 0* (원칙 5).
 *  - V2+ 예: contradiction detection · TTL/stale cleanup · drift monitor · 사후 회고 cron.
 *
 * V1 동작:
 *  - memory.write event subscribe.
 *  - 새 feedback_<segment>_* 메모리 add 시 같은 segment 의 누적 count.
 *  - N≥3 누적 → reflection 메모리 박음 (feedback_growth_reflection_segment_<segment>).
 *  - 비서가 매 turn 인덱스 prepend 로 자동 회수 → 사용자에게 명시 확인 후 결정.
 *
 * 원칙 정합:
 *  - 원칙 5: 직접 정책 수정 X — reflection 메모리만 박음 (suggester).
 *  - 원칙 6/12: 반복 패턴 (N≥3) 만 정책화 — 단발 무시.
 *  - 원칙 3: body 에 observed/assumed/confidence 분리 JSON.
 *  - 원칙 20: 코어 sysprompt·5대 원칙·security 무수정 — 메모리만 박음.
 *  - 메타-재귀 차단: feedback_growth_* prefix 는 분석 skip (자기 트리거 막음).
 */
import type { EventBus, EventBusEvent } from "../../../src/core/eventbus.js";
import {
  addMemory,
  deleteMemory,
  getMemory,
  listMemories,
  searchMemories,
} from "../../../src/store/memory.js";
import { getPaths } from "../../../src/core/paths.js";
// V4 (2026-06-22) — 확정 지침 층. 저위험 통과분을 reference 메모 대신 SELF_GROWTH.md
// 에 upsert(키 덮어쓰기·이중저장 0). 코어는 이 파일을 모름 — self-growth 가 데이터로만.
import {
  cleanupDirectives,
  getDirective,
  upsertDirective,
  type DirectiveSource,
} from "../../../src/store/self-growth-md.js";
// V3.1 (2026-06-22) — 저위험 박기 직전 LLM 의미 모순판단 2차 게이트.
// region facade(runRegionA) 경유 단일 진입점 — 어댑터 분기 0·모델 하드코딩 0(원칙 2).
// never-throw 계약: 타임아웃·실패·파싱불가 → "uncertain"(보수적 강등 sentinel).
// internal:true 라 turn 이벤트 미발행 → 메타-재귀 구조적 차단(contract §3).
import {
  judgeContradiction,
  type ContradictionVerdict,
} from "../../../src/core/llm-runtime/classify.js";

export const REPEAT_THRESHOLD = 3;
export const SELF_NAMESPACE = "growth";

// V2 (2026-05-23) — drift monitor. 같은 메모가 N≥5 update 시 *인격 표류* 의심.
// 카운트는 플러그인 내부 Map — 데몬 재시작 시 리셋 (마지막 부팅 이후 누적만).
// reflection 멱등 — 이미 박힌 drift reflection 있으면 skip.
export const DRIFT_THRESHOLD = 5;

// V2.1 (2026-05-23) — TTL cleanup. 90일 미접근 reflection 메모 자동 삭제.
// reflection 은 *사용자 미확인 suggestion* 이라 90일 지나면 기각된 것으로 해석.
// 데몬 시작 시 + 1시간 간격 setInterval 검사.
export const REFLECTION_TTL_DAYS = 90;
export const TTL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1시간

// V2.2 (2026-05-23) — 사후 회고 cron. 매 7일 1회 회고 메모 자동 생성.
// 마지막 회고 메모의 updated_at 검사로 멱등 (데몬 재시작 시점 어긋남 무관).
// cleanup 과 같은 1시간 interval 안에서 추가 호출.
export const WEEKLY_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

// V3 (2026-06-22) — 작업에서 배우기. 입력 축 확장: llm.turn_error(실패) +
// llm.turn_done(효율). region contract(selfgrowth_events_region_contract.md)
// 가 진실 소스. ADR 2026-06-22-self-growth-v3-learn-from-work 가드레일 6종 준수.
//
// 실패 학습: 같은 (errorKind, adapter, message prefix) 패턴이 N≥threshold 누적 시
// 학습 (단발 무시 — 원칙 6/12). 누적 카운트는 부팅 이후 in-memory Map (영구성 불필요,
// 기존 drift Map 답습). cap 으로 메모리 누수 방지.
export const FAILURE_THRESHOLD = REPEAT_THRESHOLD; // N≥3 답습
// 실패/효율 키 Map 의 최대 엔트리 수 — 초과 시 가장 오래된 키부터 제거 (LRU-ish).
export const PATTERN_MAP_CAP = 2000;

// V3.1 — LLM 모순판단 게이트 (박기 임박 순간만 1회 호출).
// 타임아웃 짧게(동기 EventBus 핸들러가 데몬을 길게 블로킹 못 하게, ADR 가드레일 c ≤15s).
export const CONTRADICTION_TIMEOUT_MS = 10_000;
// existing 비교 대상 cap — 토큰·본질(과하게 주지 말 것). 관련 상위 N개만.
export const CONTRADICTION_EXISTING_CAP = 5;

// V4 (2026-06-22) — 확정 지침 층 포인터 + 마이그레이션.
// 포인터 메모: 매 턴 메모리 인덱스 prepend 로 generic 주입돼 비서가 SELF_GROWTH.md 를
// Read 하게 유도(단방향). growth namespace 라 self-growth 자기분석 skip 됨(메타재귀 0).
export const POINTER_MEMO_NAME = "growth_directive_pointer";
// V3 레거시 reference 메모 prefix — V4 가 1회 SELF_GROWTH.md 로 이관 후 삭제(이중 노출 0).
export const LEGACY_LESSON_PREFIX = "growth_failure_lesson_";
// 실패 지침의 SELF_GROWTH.md 그룹 라벨(사람이 읽는 분류).
export const FAILURE_DIRECTIVE_GROUP = "failure";

interface MemoryWritePayload {
  name?: string;
  memoryType?: string;
  action?: string;
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
interface TurnErrorPayload {
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

interface TurnDonePayload {
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

/**
 * V3 실패 학습 — 같은 (errorKind·adapter·message 군집) 패턴이 count≥threshold 누적 시
 * 학습. 멱등(이미 확정/강등돼 있으면 빠른 반환). 단발(count<threshold)은 무시.
 *
 * 저위험 자격은 evaluateLowRiskGate 가 판정 —
 *  - V4: 자격(+LLM 비모순) 통과 시 **SELF_GROWTH.md 확정 지침 upsert**(reference 메모 아님,
 *    이중 저장 0). target="directive", autoLanded=true.
 *  - 미달/모호/모순/불확실 → reflection(suggester) 강등 (feedback 메모, 사용자 확인 경로).
 *
 * count 누적은 호출자(플러그인 Map)가 관리. 여기선 분류·확정/강등만.
 */
export const analyzeFailurePattern = async (input: {
  errorKind: string;
  adapter: string;
  message: string;
  count: number;
  threshold?: number;
}): Promise<{
  /** directive 확정이면 SELF_GROWTH.md 안 키, 강등이면 reflection 메모 name. */
  memoryName: string;
  autoLanded: boolean;
  key: string;
  /** "directive" = SELF_GROWTH.md 확정 / "memory" = feedback reflection 강등. */
  target: "directive" | "memory";
} | null> => {
  const threshold = input.threshold ?? FAILURE_THRESHOLD;
  if (input.count < threshold) return null; // 단발/미달 무시

  const messageNorm = normalizeErrorMessage(input.message);
  const key = failureKey({
    errorKind: input.errorKind,
    adapter: input.adapter,
    messageNorm,
  });

  // 멱등 키 — 키 해시를 안정 slug 로 인코딩.
  // V4: 저위험 통과분의 *목적지* 가 reference 메모 → SELF_GROWTH.md 확정 지침으로 전환.
  // directiveKey 는 SELF_GROWTH.md 안 안정 키(같은 상황 재확정 시 그 블록 덮어쓰기).
  // reflectionName(강등분) 은 그대로 feedback 메모(suggester) — 사용자 확인 경로 유지.
  const slug = key.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
  const directiveKey = `failure_${slug}`;
  const reflectionName = `feedback_${SELF_NAMESPACE}_failure_${slug}`;

  // 명령형 한 줄 description — searchMemories 가 상황에서 소환. 모순판단 candidate 로도 쓴다.
  const description = `${input.adapter} 작업 중 '${messageNorm}' (${input.errorKind}) 반복 — 이 작업 땐 사전에 입력·인자·타임아웃을 점검할 것`;

  // ── 1차: 싼 동기 게이트 (키워드 모순·unknown kind·self adapter 등) ──────────────
  const gate = evaluateFailureLowRiskGate({
    errorKind: input.errorKind,
    adapter: input.adapter,
    messageNorm,
  });

  if (gate.lowRisk) {
    // 멱등 — 이미 확정 지침이 있으면 LLM 호출 없이 즉시 반환(빈도 bound, ADR 가드레일 b).
    // V4: 멱등 대상이 reference 메모 → SELF_GROWTH.md 확정 지침(getDirective) 으로 전환.
    // 같은 directiveKey 가 이미 SELF_GROWTH.md 에 있으면 재upsert·LLM 모두 skip.
    // (upsertDirective 가 본질적으로 덮어쓰기라 매번 호출해도 무해하나, LLM 비용 절감 위해
    //  멱등 단락. 메타-재귀 (iii)는 별도로 닫혀 있다: SELF_GROWTH.md 쓰기는 이벤트 미발행 +
    //  handleTurnError 가 self-adapter 입력 skip — 박기는 허용·자기입력 루프는 차단.)
    if ((await getDirective(directiveKey)) !== null) {
      return { memoryName: directiveKey, autoLanded: true, key, target: "directive" };
    }

    // ── 2차: LLM 의미 모순판단 (V3.1) — 박기 *임박 그 자리에서만* 1회 ───────────
    // 동기 1차 게이트를 다 통과하고 멱등도 아닌, 진짜 박기 직전 후보에만 비싼 LLM 호출.
    // region facade(runRegionA) 경유 — 어댑터 분기 0(원칙 2). never-throw.
    const existing = selectContradictionExisting();
    const { verdict, durationMs } = await judgeContradictionGate(
      description,
      existing,
    );

    if (verdict === "no") {
      // 명백 비모순 → SELF_GROWTH.md 확정 지침 upsert (reference 메모 박지 않음 — 이중저장 0).
      // 본문은 명령형 한 줄 + 관측 근거 1줄(사람·비서가 1 Read 로 읽기 좋게).
      const text = [
        description,
        `(근거: ${input.count}회 누적 · 모순판단=${verdict} · ${durationMs}ms · 비교 ${existing.length}건)`,
      ].join("\n");
      const landed = await upsertDirective({
        key: directiveKey,
        text,
        source: "auto",
        group: FAILURE_DIRECTIVE_GROUP,
      });
      if (landed === null) {
        // 파일 쓰기 실패(디스크·권한 등) → 신호 잃지 않게 reflection 강등으로 폴백.
        if (getMemory(reflectionName) === undefined) {
          addMemory({
            type: "feedback",
            name: reflectionName,
            description: `반복 실패 (${input.errorKind}·${input.adapter}, ${input.count}회) — SELF_GROWTH.md 쓰기 실패로 강등, 사용자 확인 후 결정`,
            body: JSON.stringify(
              {
                observed_pattern: `(${input.errorKind} · ${input.adapter}) '${messageNorm}' 가 ${input.count}회 누적`,
                evidence_count: input.count,
                self_growth_md_write_failed: true,
                suggested_action:
                  "SELF_GROWTH.md 확정 지침 쓰기 실패 — 디스크/권한 점검. 비서가 사용자에게 이 패턴 대응 의향 명시 확인.",
              },
              null,
              2,
            ),
          });
        }
        return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
      }
      return { memoryName: directiveKey, autoLanded: true, key, target: "directive" };
    }

    // verdict === "yes"(모순) / "uncertain"(실패·불확실·타임아웃) → 보수적 강등.
    // LLM 을 박기 *강행* 근거로 쓰지 않음 — 불확실이면 무조건 강등(ADR 가드레일 c).
    if (getMemory(reflectionName) !== undefined) {
      return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
    }
    const demoteBody = JSON.stringify(
      {
        observed_pattern: `(${input.errorKind} · ${input.adapter}) '${messageNorm}' 가 ${input.count}회 누적`,
        error_kind: input.errorKind,
        adapter: input.adapter,
        message_normalized: messageNorm,
        evidence_count: input.count,
        low_risk_auto_landed: false,
        gate_reasons: gate.reasons,
        llm_contradiction_verdict: verdict, // V3.1 근거 기록 (ADR 가드레일 d)
        llm_contradiction_duration_ms: durationMs,
        llm_contradiction_existing_count: existing.length,
        confidence: 0.4,
        suggested_action:
          verdict === "yes"
            ? "LLM 의미 모순 의심(verdict=yes): 이 lesson 이 기존 사용자 확정 메모(feedback/identity 류)와 충돌 가능. 비서가 사용자에게 명시 확인 후 결정 — 자동 박기 강등."
            : "LLM 모순판단 불확실(verdict=uncertain: 타임아웃·실패·모호). 보수적 강등 — 비서가 사용자에게 이 반복 실패 패턴 대응 의향 명시 확인 후 결정.",
      },
      null,
      2,
    );
    addMemory({
      type: "feedback",
      name: reflectionName,
      description: `반복 실패 (${input.errorKind}·${input.adapter}, ${input.count}회) — LLM 모순판단=${verdict}, suggester only, 사용자 확인 후 결정`,
      body: demoteBody,
    });
    return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
  }

  // 자격 미달/모호 → reflection(suggester) 강등 (기존 동작 — 동기 1차 게이트 탈락).
  // 이름이 feedback_growth_* (self namespace) 라 후속 add 분석에서 자동 skip 됨(루프 (i)/(ii)).
  if (getMemory(reflectionName) !== undefined) {
    return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
  }
  const body = JSON.stringify(
    {
      observed_pattern: `(${input.errorKind} · ${input.adapter}) '${messageNorm}' 가 ${input.count}회 누적`,
      error_kind: input.errorKind,
      adapter: input.adapter,
      message_normalized: messageNorm,
      evidence_count: input.count,
      low_risk_auto_landed: false,
      gate_reasons: gate.reasons,
      confidence: 0.4,
      suggested_action:
        "비서가 사용자에게 이 반복 실패 패턴 대응(메모화/회피 규칙) 의향 명시 확인. 자동 박기 자격 미달이라 suggester only.",
    },
    null,
    2,
  );
  addMemory({
    type: "feedback",
    name: reflectionName,
    description: `반복 실패 (${input.errorKind}·${input.adapter}, ${input.count}회) — suggester only, 사용자 확인 후 결정`,
    body,
  });
  return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
};

/**
 * 저위험 자동 박기 자격 판정 (ADR 저위험 체크리스트, 실패 학습용).
 * 전부 통과여야 lowRisk=true. 하나라도 불확실/미충족 → false (보수적 강등이 기본).
 *
 * 실패 학습은 *관측된 운영 사실* 이라 비가역 아님·인격 영향 없음은 구조적으로 충족.
 * 핵심 위험축은 (a) 기존 active 메모와의 모순 (b) 사실성(가치판단 아님)이다.
 * 모순 검사는 보수적 — 의심되면 무조건 reflection 강등(architect 경고: segment
 * 매칭 수준이라 약함, 의심 시 강등이 기본).
 */
export const evaluateFailureLowRiskGate = (input: {
  errorKind: string;
  adapter: string;
  messageNorm: string;
}): { lowRisk: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  let lowRisk = true;

  // 메타-재귀 아님 — self namespace 산출물발 신호면 자격 박탈.
  // (어댑터 라벨이 growth 일 리 없지만 방어적.)
  if (input.adapter.toLowerCase().includes(SELF_NAMESPACE)) {
    lowRisk = false;
    reasons.push("meta_recursion_suspected");
  }

  // 사실·운영 학습 — errorKind 가 알려진 운영 분류여야 (가치판단/모호 텍스트 배제).
  const KNOWN_KINDS = new Set(["timeout", "model_rejected", "error"]);
  if (!KNOWN_KINDS.has(input.errorKind)) {
    lowRisk = false;
    reasons.push("unknown_error_kind");
  }

  // 모순 검사 (보수적) — 같은 패턴에 대해 사용자가 명시 확인한 기존 active 메모가
  // 이미 있고, 그게 self-growth 산출물이 아니라면(=사용자/외부 확정) 자동 덮어쓰기 금지.
  //
  // P1-a 수정(2026-06-22): searchMemories 는 query 전체를 단일 phrase 로 FTS MATCH 한다
  // (src/store/memory.ts). 다토큰 messageNorm 의 연속 문자열이 기존 메모에 통째로 없으면
  // 매칭 0 → 모순을 거의 못 잡았다(검사 사실상 비활성). 의미 키워드별로 분해해 OR 검색하고,
  // *어떤* 비-growth 메모라도 의미 키워드에 걸리면 모순 의심으로 강등한다.
  // 검색이 한 번이라도 실패하면 "모순 없음을 확신 못 함" → 강등(의심 시 강등이 기본).
  const keywords = extractContradictionKeywords(input.messageNorm, input.adapter);
  if (keywords.length === 0) {
    // 의미 키워드 0 (마스킹 후 토큰이 없음) → 모순 유무를 판정할 근거 없음 → 강등.
    lowRisk = false;
    reasons.push("contradiction_indeterminate_no_keywords");
  } else {
    for (const kw of keywords) {
      try {
        const hits = searchMemories(kw, 5);
        const contradicting = hits.find(
          (m) =>
            // self-growth 산출물(reflection/lesson)이 아닌 = 사용자/외부 확정 메모면 모순 의심.
            !isSelfNamespace(m.name) &&
            !m.name.startsWith("growth_failure_lesson_"),
        );
        if (contradicting !== undefined) {
          lowRisk = false;
          reasons.push(`possible_contradiction:${contradicting.name}`);
          break;
        }
      } catch {
        // 단일 키워드 검색 실패 → 모순 없음을 확신 못 함 → 보수적 강등.
        lowRisk = false;
        reasons.push("contradiction_check_failed");
        break;
      }
    }
  }

  if (lowRisk) reasons.push("all_low_risk_checks_passed");
  return { lowRisk, reasons };
};

/**
 * 모순 검사용 의미 키워드 추출 — normalizeErrorMessage 산출물에서 마스킹 토큰(<n>/<hex>/
 * <hash>/<path>)·구분자·짧은 불용어를 제거하고 어댑터 라벨도 한 토큰으로 더한다.
 * searchMemories 가 phrase 매칭이라 다토큰을 한 번에 못 잡으므로, 키워드별 개별 검색을 위해
 * 분해한다. 길이 3 미만 토큰은 FTS 노이즈라 제외. 최대 6개(검색 비용 cap).
 */
export const extractContradictionKeywords = (
  messageNorm: string,
  adapter: string,
): string[] => {
  const masked = new Set(["n", "hex", "hash", "path"]);
  const tokens = messageNorm
    .replace(/<([a-z]+)>/g, " $1 ") // <n> 등을 토큰 경계로
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !masked.has(t));
  const uniq = Array.from(new Set(tokens));
  if (adapter.length >= 3) uniq.push(adapter.toLowerCase());
  return Array.from(new Set(uniq)).slice(0, 6);
};

/**
 * V3.1 — LLM 모순판단의 `existing` 비교 대상 선별.
 *
 * "기존 active 사용자 확정 메모"(특히 feedback/identity 류)만 골라 후보 lesson 과
 * 의미 모순을 LLM 에게 묻는다. self-growth 자기 산출물(growth namespace reflection·
 * growth_failure_lesson_* lesson·weekly review·drift)은 **제외** — 자기 산출물과
 * 비교하면 메타-재귀적 자기참조라 모순판단 의미 없음 + 토큰 낭비.
 *
 * 포함 기준: type ∈ {feedback, user}(사용자/정체성 확정 메모) 중 self namespace 가 아닌 것.
 * (reference 류는 비서가 박는 사실·운영 메모라 "사용자 의도" 모순 비교 대상으로 부적합.)
 * 최신순(updated_at desc) 상위 N개로 cap — 과하게 주지 않음(토큰·본질).
 *
 * 각 항목은 `description`(명령형 한 줄 의도)만 준다 — body 전체는 토큰 과다.
 */
export const selectContradictionExisting = (
  cap: number = CONTRADICTION_EXISTING_CAP,
): string[] => {
  const candidates = [
    ...listMemories({ type: "feedback", limit: 10000, orderBy: "updated" }),
    ...listMemories({ type: "user", limit: 10000, orderBy: "updated" }),
  ];
  // 최신순 정렬(두 type 병합 후) — 사용자 최신 확정 의도 우선.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of candidates) {
    // self-growth 자기 산출물 제외 (growth namespace reflection·review·drift 전부).
    if (isSelfNamespace(m.name)) continue;
    if (m.name.startsWith("growth_failure_lesson_")) continue;
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const text = m.description.trim();
    if (text.length === 0) continue;
    out.push(`[${m.type}] ${text}`);
    if (out.length >= cap) break;
  }
  return out;
};

/**
 * V3.1 — 박기 임박 순간 1회 LLM 의미 모순판단 게이트.
 *
 * **호출 위치 계약(ADR 가드레일 b)**: 동기 `evaluateFailureLowRiskGate` 가 모든 싼 체크
 * (unknown kind·self adapter·키워드 모순·반복 등)를 통과시키고 count≥threshold 인
 * *박기 직전* 에만 호출. 매 후보·매 이벤트 호출 금지(낭비 줄이는 학습기가 매번 LLM 쓰면
 * 자기모순). 멱등(getMemory 중복) 체크는 호출 *앞* 에서 이미 거른다.
 *
 * judgeContradiction 은 never-throw(타임아웃·실패·파싱불가 → "uncertain"). 따라서
 * try/catch 불필요하나, 방어적으로 감싸 verdict 미산출 시 "uncertain"(보수 강등)로 수렴.
 *
 * 판정:
 *  - "no"(명백 비모순) → 자동 박기 허용.
 *  - "yes"(모순) / "uncertain"(실패·불확실) → 강등(reflection). LLM 을 박기 *허용* 에만
 *    쓰고 *강행* 근거로 쓰지 않음(ADR 가드레일 c, no-cross-adapter-fallback).
 */
export const judgeContradictionGate = async (
  candidate: string,
  existing: string[],
  timeoutMs: number = CONTRADICTION_TIMEOUT_MS,
): Promise<{ verdict: ContradictionVerdict; durationMs: number }> => {
  const start = Date.now();
  let verdict: ContradictionVerdict;
  try {
    verdict = await judgeContradiction({ candidate, existing, timeoutMs });
  } catch {
    // 계약상 도달 불가(never-throw)지만 방어적으로 보수 강등.
    verdict = "uncertain";
  }
  return { verdict, durationMs: Date.now() - start };
};

/**
 * V3 효율 관측 — turn_done 의 durationMs/토큰을 (adapter, model) 별로 누적 관측한다.
 * **관측 메모(비서가 읽는 신호)까지만** — 코어 라우팅 분기 절대 금지(원칙 2 하드게이트).
 * 토큰 필드는 자주 없음(openai) → "있을 때만" 합산, 0/거짓값 박지 않음.
 *
 * 순수 함수 — 누적 상태(EfficiencyAccumulator)는 호출자가 보유. 여기선 갱신만 반환.
 * 메모는 박지 않는다(효율은 신호 누적 → 주간 회고/명시 조회에서 소비). 효율 신호가
 * 또 다른 turn 을 낳지 않으므로 메타-재귀 0.
 */
export interface EfficiencyAccumulator {
  turns: number;
  totalDurationMs: number;
  // 토큰은 *보고된 턴만* 분모로 — 없는 턴은 분모에서 제외(정직한 미측정).
  tokenSampledTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export const emptyEfficiencyAccumulator = (): EfficiencyAccumulator => ({
  turns: 0,
  totalDurationMs: 0,
  tokenSampledTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
});

export const efficiencyKey = (adapter: string, model?: string): string =>
  `${adapter}|${model ?? "_"}`;

/**
 * 단일 turn_done 을 accumulator 에 반영. durationMs 양수일 때만 카운트.
 * 토큰은 양수(>0)일 때만 합산 — 0/음수/누락은 미측정으로 간주(생략, 거짓값 금지).
 */
export const accumulateEfficiency = (
  acc: EfficiencyAccumulator,
  sample: { durationMs?: number; inputTokens?: number; outputTokens?: number },
): EfficiencyAccumulator => {
  const next: EfficiencyAccumulator = { ...acc };
  if (typeof sample.durationMs === "number" && sample.durationMs > 0) {
    next.turns += 1;
    next.totalDurationMs += sample.durationMs;
  }
  const hasIn =
    typeof sample.inputTokens === "number" && sample.inputTokens > 0;
  const hasOut =
    typeof sample.outputTokens === "number" && sample.outputTokens > 0;
  if (hasIn || hasOut) {
    next.tokenSampledTurns += 1;
    if (hasIn) next.totalInputTokens += sample.inputTokens as number;
    if (hasOut) next.totalOutputTokens += sample.outputTokens as number;
  }
  return next;
};

/**
 * V2.2 사후 회고 — 지난 7일 동안 박힌 reflection 통계를 회고 메모로 박음.
 * 이미 7일 안에 회고 박힌 적 있으면 null (멱등). 강제 박기 = force=true.
 * 회고 name: `feedback_growth_weekly_review_<YYYY-MM-DD>`.
 */
export const generateWeeklyReview = (
  force: boolean = false,
): { reviewName: string; segmentCount: number; driftCount: number } | null => {
  const all = listMemories({ type: "feedback", limit: 10000 });
  const now = Date.now();
  const weekAgo = now - WEEKLY_REVIEW_INTERVAL_MS;

  // 멱등 — 최근 7일 안 회고 박힌 적 있으면 skip.
  if (!force) {
    const recent = all.find(
      (m) =>
        m.name.startsWith(`feedback_${SELF_NAMESPACE}_weekly_review_`) &&
        m.updatedAt >= weekAgo,
    );
    if (recent !== undefined) return null;
  }

  // 지난 7일 동안 생성된 reflection 통계.
  const segmentReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_reflection_segment_`) &&
      m.updatedAt >= weekAgo,
  );
  const driftReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_drift_`) &&
      m.updatedAt >= weekAgo,
  );

  const date = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const reviewName = `feedback_${SELF_NAMESPACE}_weekly_review_${date}`;

  const body = JSON.stringify(
    {
      review_period: `최근 7일 (${new Date(weekAgo).toISOString().slice(0, 10)} ~ ${date})`,
      segment_reflection_count: segmentReflections.length,
      segment_reflection_names: segmentReflections.map((m) => m.name),
      drift_reflection_count: driftReflections.length,
      drift_reflection_names: driftReflections.map((m) => m.name),
      total_memory_count: all.length,
      suggested_action:
        segmentReflections.length + driftReflections.length > 0
          ? "비서가 사용자에게 이번 주 reflection 정리 의향 명시 확인."
          : "이번 주 신호 0 — 정상 운영.",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reviewName,
    description: `이번 주 회고 — segment ${segmentReflections.length}건, drift ${driftReflections.length}건`,
    body,
  });

  return {
    reviewName,
    segmentCount: segmentReflections.length,
    driftCount: driftReflections.length,
  };
};

export const cleanupStaleReflections = (
  thresholdDays: number = REFLECTION_TTL_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const all = listMemories({ type: "feedback", limit: 10000 });
  const targets = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_`) &&
      m.updatedAt <= cutoffMs,
  );
  for (const m of targets) {
    try {
      deleteMemory(m.name);
    } catch {
      // 무시 — 다른 프로세스가 동시 삭제했을 수 있음.
    }
  }
  return targets.length;
};

// ─── V4 — 확정 지침 층 포인터·마이그레이션·사람 승격 ──────────────────────────

/**
 * V4 포인터 메모 (단방향 핵심) — `growth_directive_pointer` 1건 멱등 upsert.
 *
 * description 이 매 턴 메모리 인덱스(listMemoriesForIndex) prepend 로 generic 주입돼
 * 비서가 *작업 시작 시 SELF_GROWTH.md 를 Read 해 적용* 하게 유도한다. **코어는 이 메모도
 * SELF_GROWTH.md 도 모른다** — self-growth 가 데이터로만 박는 단방향(임무 §3).
 *
 * growth namespace(parseSegment="growth") 라 후속 add 분석에서 self-growth 자기분석
 * skip(메타재귀 0). addMemory 는 raw store 라 memory.write 미발행 → 자기입력 루프 0.
 * 멱등 — 이미 있으면 description/body 갱신만(addMemory UPSERT). never-throw.
 */
export const ensureDirectivePointer = (): boolean => {
  try {
    const file = getPaths().selfGrowthMd;
    addMemory({
      type: "reference",
      name: POINTER_MEMO_NAME,
      description: `작업 시작 시 확정 지침 파일을 Read 해 적용하라: ${file}`,
      body: JSON.stringify(
        {
          purpose:
            "self-growth 확정 지침 층(SELF_GROWTH.md) 으로의 단방향 포인터. 작업 착수 전 이 파일을 Read 해 해당 상황 지침을 적용하라.",
          path: file,
          note: "코어는 이 파일을 모름 — self-growth 가 데이터로만 관리. 자율 확정은 저위험 한정, 사용자 승격분은 source:user.",
        },
        null,
        2,
      ),
    });
    return true;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`self-growth: ensureDirectivePointer failed: ${reason}`);
    return false;
  }
};

/**
 * V4 1회 마이그레이션 — V3 가 박아둔 `growth_failure_lesson_*` reference 메모를
 * SELF_GROWTH.md 확정 지침으로 옮기고 *메모는 삭제*(이중 노출 0, 임무 §2).
 *
 * 멱등: 옮긴 메모는 삭제되므로 다음 실행 땐 대상 0. directiveKey 는 `failure_<slug>`
 * (V4 신규 경로와 동일 규칙) — 같은 패턴이 신규로 다시 확정돼도 같은 키 덮어쓰기.
 * upsert 성공분만 메모 삭제(실패 시 메모 보존 = 데이터 유실 0). never-throw.
 *
 * @returns 옮겨 삭제된 메모 수.
 */
export const migrateLegacyLessons = async (): Promise<number> => {
  let migrated = 0;
  try {
    const all = listMemories({ type: "reference", limit: 10000 });
    const legacy = all.filter((m) => m.name.startsWith(LEGACY_LESSON_PREFIX));
    for (const m of legacy) {
      // name: growth_failure_lesson_<slug> → directiveKey: failure_<slug>
      const slug = m.name.slice(LEGACY_LESSON_PREFIX.length);
      const directiveKey = `failure_${slug}`;
      const landed = await upsertDirective({
        key: directiveKey,
        text: m.description,
        source: "auto",
        group: FAILURE_DIRECTIVE_GROUP,
      });
      if (landed === null) continue; // 파일 쓰기 실패 → 메모 보존(유실 0).
      try {
        deleteMemory(m.name);
        migrated++;
      } catch {
        // 삭제 실패해도 지침은 들어감 — 다음 실행이 재시도(upsert 멱등이라 이중노출 0:
        // 같은 키 덮어쓰기 + 메모만 잔존). 잔존 메모는 후속 실행에서 재삭제 시도.
      }
    }
    if (migrated > 0) {
      console.log(
        `self-growth: V4 migration — ${migrated} legacy lesson(s) → SELF_GROWTH.md (memos deleted)`,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`self-growth: migrateLegacyLessons failed: ${reason}`);
  }
  return migrated;
};

/**
 * V4 사람 승격 경로 (임무 §4) — 사용자가 확정/직접 교정한 지침을 SELF_GROWTH.md 에 올린다.
 * 자율 경로와 *같은 upsert 재사용* (동일 키 덮어쓰기·캡·TTL). 단 source 기본 "user" 라
 * 캡/TTL 자동 폐기에서 보호된다(명시 확정 보존). 비서가 사용자 승인 후 호출하는 진입점.
 *
 * 같은 키가 이미 auto 로 있으면 user 로 승격(덮어씀) — source 가 user 로 올라가면
 * 이후 자동 정리 대상에서 제외(applyCapAndTtl 의 user 보호). never-throw.
 */
export const promoteDirective = (input: {
  key: string;
  text: string;
  group?: string;
  source?: DirectiveSource;
}): Promise<boolean> =>
  upsertDirective({
    key: input.key,
    text: input.text,
    group: input.group,
    source: input.source ?? "user",
  }).then(
    (d) => d !== null,
    () => false,
  );

class SelfGrowthPlugin {
  readonly name = "self-growth";
  private bus: EventBus | null = null;
  private unsubscribe: (() => void) | null = null;
  // V2 — 메모 update 카운트 (이 데몬 부팅 이후 누적). 재시작 시 리셋.
  private updateCounts: Map<string, number> = new Map();
  // V2.1 — TTL cleanup interval handle.
  private cleanupInterval: NodeJS.Timeout | null = null;
  // V3 — 실패 패턴 누적 카운트 (부팅 이후 in-memory, 영구성 불필요). cap 으로 누수 방지.
  private failureCounts: Map<string, number> = new Map();
  // V3 — 효율 관측 누적 ((adapter,model) 별). 관측 신호까지만 — 라우팅 분기 0.
  private efficiency: Map<string, EfficiencyAccumulator> = new Map();

  async startObserver(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event);
    });
    // V4 — 시작 시 1회: 포인터 메모 멱등 upsert(단방향 핵심) + 레거시 lesson 마이그레이션.
    // 포인터는 동기·즉시. 마이그레이션은 async(파일 쓰기) → fire-and-forget(내부 never-throw).
    ensureDirectivePointer();
    void migrateLegacyLessons();
    // V2.1+V2.2 — 시작 시 즉시 1회 + 1시간 간격 maintenance (cleanup + 주간 회고 + 지침 정리).
    this.runMaintenance();
    this.cleanupInterval = setInterval(() => {
      this.runMaintenance();
    }, TTL_CLEANUP_INTERVAL_MS);
    console.log(
      "self-growth: started, subscribe[memory.write, llm.turn_error, llm.turn_done] + TTL cleanup + weekly review + SELF_GROWTH.md directives",
    );
  }

  private runMaintenance(): void {
    this.runCleanup();
    this.runWeeklyReview();
    this.runDirectiveCleanup();
  }

  // V4 — SELF_GROWTH.md 확정 지침 cap/TTL 정리. maintenance interval 안에서 호출.
  // cleanupDirectives 가 직렬화(writeLock)·never-throw → 동시 쓰기 경합 0. async fire-and-forget.
  private runDirectiveCleanup(): void {
    void cleanupDirectives().then(
      (removed) => {
        if (removed > 0) {
          console.log(
            `self-growth: directive cleanup — ${removed} stale/over-cap directive(s) removed`,
          );
        }
      },
      (e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`self-growth: directive cleanup failed: ${reason}`);
      },
    );
  }

  private runCleanup(): void {
    try {
      const removed = cleanupStaleReflections();
      if (removed > 0) {
        console.log(
          `self-growth: TTL cleanup — ${removed} stale reflection(s) removed`,
        );
        if (this.bus !== null) {
          this.bus.publish({
            type: "self_growth.cleanup.run",
            ts: Date.now(),
            payload: { removed },
          });
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: cleanup failed: ${reason}`);
    }
  }

  // V2.2 — 매 7일 1회 회고 박기 (멱등). cleanup 과 같은 interval 안에서 호출.
  private runWeeklyReview(): void {
    try {
      const result = generateWeeklyReview();
      if (result === null) return;
      console.log(
        `self-growth: weekly review — segment=${result.segmentCount} drift=${result.driftCount}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.weekly_review.added",
          ts: Date.now(),
          payload: {
            reviewName: result.reviewName,
            segmentCount: result.segmentCount,
            driftCount: result.driftCount,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: weekly review failed: ${reason}`);
    }
  }

  async start(bus: EventBus): Promise<void> {
    await this.startObserver(bus);
  }

  async stop(): Promise<void> {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        // 무시.
      }
      this.unsubscribe = null;
    }
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.bus = null;
  }

  private handle(event: EventBusEvent): void {
    // V3 — 입력 축 3종 라우팅. 각 분기 try/catch 는 내부 핸들러가 보유.
    switch (event.type) {
      case "memory.write":
        this.handleMemoryWrite(event.payload as MemoryWritePayload);
        return;
      case "llm.turn_error":
        // fire-and-forget — handleTurnError 는 async(박기 직전 LLM 모순판단)이나
        // 내부 try/catch 로 never-reject. void 로 floating promise 의도 명시.
        void this.handleTurnError(event.payload as TurnErrorPayload);
        return;
      case "llm.turn_done":
        this.handleTurnDone(event.payload as TurnDonePayload);
        return;
      default:
        return;
    }
  }

  private handleMemoryWrite(payload: MemoryWritePayload): void {
    if (typeof payload.name !== "string") return;
    if (payload.action === "add") {
      this.handleAdd(payload.name);
    } else if (payload.action === "update") {
      this.handleUpdate(payload.name);
    }
  }

  // V3 — Map cap (LRU-ish): 초과 시 가장 먼저 들어온 키부터 제거. Map 은 삽입 순서
  // 보존이므로 keys().next() 가 가장 오래된 키. 누수 방지(원칙 6 견고성).
  private capMap<V>(m: Map<string, V>, cap: number): void {
    while (m.size > cap) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  // V3 실패 학습 — turn_error 구독. 같은 (errorKind·adapter·message 군집) 패턴이
  // N≥threshold 누적 시 학습. 단발 무시(원칙 6/12).
  // V3.1 — analyzeFailurePattern 가 async(박기 직전 LLM 모순판단 1회). handle() 는
  // 핸들러를 await 하지 않으므로(EventBus 동기 구독) 여기서 자체 await + catch 로 닫는다.
  // judgeContradiction 은 never-throw + 짧은 타임아웃(10s)이라 데몬 동결 위험 bound.
  private async handleTurnError(payload: TurnErrorPayload): Promise<void> {
    try {
      // 메타-재귀 차단 (iii): self-growth 자신이 LLM 턴을 돌리지 않으므로 region
      // turn_error 는 본 플러그인이 입력으로 되돌리는 루프가 없다. 방어적으로
      // adapter 라벨이 self namespace 면 skip. (모순판단 internal:true 라 turn 이벤트
      // 미발행 → 모순판단 호출 자체도 자기입력을 낳지 않음 — 구조적 차단 유지.)
      const adapter =
        typeof payload.adapter === "string" ? payload.adapter : "";
      if (adapter === "" || adapter.toLowerCase().includes(SELF_NAMESPACE)) {
        return;
      }
      const errorKind =
        typeof payload.errorKind === "string" ? payload.errorKind : "error";
      const message = typeof payload.message === "string" ? payload.message : "";
      if (message === "") return; // 군집 키 없음 — 학습 불가

      const messageNorm = normalizeErrorMessage(message);
      const key = failureKey({ errorKind, adapter, messageNorm });
      const count = (this.failureCounts.get(key) ?? 0) + 1;
      this.failureCounts.set(key, count);
      this.capMap(this.failureCounts, PATTERN_MAP_CAP);

      const result = await analyzeFailurePattern({
        errorKind,
        adapter,
        message,
        count,
      });
      if (result === null) return;

      console.log(
        `self-growth: failure ${
          result.autoLanded
            ? "확정 지침 SELF_GROWTH.md 박힘"
            : "reflection 강등"
        } — ${result.target}:${result.memoryName} (count=${count})`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.failure.learned",
          ts: Date.now(),
          payload: {
            memoryName: result.memoryName,
            autoLanded: result.autoLanded,
            target: result.target, // V4 — "directive"(SELF_GROWTH.md) | "memory"(reflection)
            errorKind,
            adapter,
            count,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: turn_error handler failed: ${reason}`);
    }
  }

  // V3 효율 관측 — turn_done 구독. durationMs/토큰을 (adapter,model) 별 누적.
  // **관측 신호까지만** — 코어 라우팅 분기 절대 만들지 않음(원칙 2 하드게이트).
  // 토큰은 "있을 때만" 합산(openai 자주 누락). 메모는 박지 않음(루프 0).
  private handleTurnDone(payload: TurnDonePayload): void {
    try {
      const adapter =
        typeof payload.adapter === "string" ? payload.adapter : "";
      if (adapter === "" || adapter.toLowerCase().includes(SELF_NAMESPACE)) {
        return;
      }
      const model = typeof payload.model === "string" ? payload.model : undefined;
      const key = efficiencyKey(adapter, model);
      const acc = this.efficiency.get(key) ?? emptyEfficiencyAccumulator();
      const next = accumulateEfficiency(acc, {
        durationMs: payload.durationMs,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
      });
      this.efficiency.set(key, next);
      this.capMap(this.efficiency, PATTERN_MAP_CAP);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: turn_done handler failed: ${reason}`);
    }
  }

  private handleAdd(name: string): void {
    try {
      const result = analyzeRepeatedSegment(name);
      if (result === null) return;
      console.log(
        `self-growth: reflection 박힘 — segment='${result.segment}', members=${result.members.length}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.reflection.added",
          ts: Date.now(),
          payload: {
            reflectionName: result.reflectionName,
            segment: result.segment,
            memberCount: result.members.length,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: analyze (add) failed: ${reason}`);
    }
  }

  // V2 — update event 처리. 누적 카운트 N≥5 시 drift reflection 박음.
  private handleUpdate(name: string): void {
    const next = (this.updateCounts.get(name) ?? 0) + 1;
    this.updateCounts.set(name, next);

    try {
      const result = analyzeDriftPattern(name, next);
      if (result === null) return;
      console.log(
        `self-growth: drift reflection 박힘 — name='${name}', updates=${result.updateCount}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.drift.detected",
          ts: Date.now(),
          payload: {
            reflectionName: result.reflectionName,
            target: name,
            updateCount: result.updateCount,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: analyze (update) failed: ${reason}`);
    }
  }
}

export default class SelfGrowthPluginFactory extends SelfGrowthPlugin {}
