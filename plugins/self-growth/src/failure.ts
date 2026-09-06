import {
  peekMemory,
  listMemories,
  searchMemories,
} from "../../../src/store/memory.js";
import { listSkillUsage } from "../../../src/store/skill-usage.js";
import { isStrongerSignal, upsertReflection } from "./analysis.js";
import { homeFields, suggestHome } from "./home.js";
import {
  getDirective,
  upsertDirective,
} from "../../../src/store/self-growth-md.js";
import {
  judgeContradiction,
  type ContradictionVerdict,
} from "../../../src/core/llm-runtime/classify.js";
import {
  type CauseCategory,
  type FailureReflection,
} from "../../../src/core/llm-runtime/classify-failure.js";
import {
  CONTRADICTION_EXISTING_CAP,
  CONTRADICTION_TIMEOUT_MS,
  FAILURE_DIRECTIVE_GROUP,
  FAILURE_THRESHOLD,
  SELF_NAMESPACE,
} from "./constants.js";
import {
  failureKey,
  isSelfNamespace,
  normalizeErrorMessage,
} from "./analysis.js";
import { analyzeSkillImprove } from "./skills.js";

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
        if (peekMemory(reflectionName) === undefined) {
          upsertReflection({
            name: reflectionName,
            description: `반복 실패 (${input.errorKind}·${input.adapter}, ${input.count}회) — SELF_GROWTH.md 쓰기 실패로 강등, 사용자 확인 후 결정`,
            body: JSON.stringify(
              {
                observed_pattern: `(${input.errorKind} · ${input.adapter}) '${messageNorm}' 가 ${input.count}회 누적`,
                evidence_count: input.count,
                self_growth_md_write_failed: true,
                // ★원인을 **모른다** — 여기 온 이유는 SELF_GROWTH.md 쓰기가 실패해서다(디스크·권한).
                //  종전엔 `cause:"prompt_config", hasCause:true` 를 **상수로** 넘겨,
                //  방금 실패한 그 일("SELF_GROWTH.md 로 올려라")을 다음 할 일로 실었다
                //  (적대 검토 P5). 판정 함수의 «모르면 ask» 를 호출부가 뚫고 있었다.
                ...homeFields(suggestHome({ kind: "failure", errorKind: input.errorKind, hasCause: false })),
                blocked_by: "SELF_GROWTH.md 쓰기 실패 — 디스크/권한 점검이 먼저다.",
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
    if (peekMemory(reflectionName) !== undefined) {
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
        // ★여기 온 이유가 «모순 의심» 또는 «판단 불확실» 이다 — 그런데 종전엔 원인을
        //  `prompt_config` 로 **지어내** 강등 사유와 정반대인 directive 를 냈다(적대 검토 P5).
        //  불확실해서 내린 것을 확신이 필요한 자리로 보내면 안 된다.
        ...homeFields(suggestHome({ kind: "failure", errorKind: input.errorKind, hasCause: false })),
        demoted_because:
          verdict === "yes"
            ? "LLM 의미 모순 의심 — 기존 사용자 확정과 충돌할 수 있어 자동 확정에서 내렸다."
            : "LLM 모순판단 불확실(타임아웃·모호) — 보수적으로 내렸다.",
      },
      null,
      2,
    );
    upsertReflection({
      name: reflectionName,
      description: `반복 실패 (${input.errorKind}·${input.adapter}, ${input.count}회) — LLM 모순판단=${verdict}, suggester only, 사용자 확인 후 결정`,
      body: demoteBody,
    });
    return { memoryName: reflectionName, autoLanded: false, key, target: "memory" };
  }

  // 자격 미달/모호 → reflection(suggester) 강등 (기존 동작 — 동기 1차 게이트 탈락).
  // 이름이 feedback_growth_* (self namespace) 라 후속 add 분석에서 자동 skip 됨(루프 (i)/(ii)).
  if (peekMemory(reflectionName) !== undefined) {
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
      ...homeFields(suggestHome({ kind: "failure", cause: "uncertain", errorKind: input.errorKind, hasCause: false })),
      demoted_because: "저위험 자동 확정 자격 미달(게이트 사유는 gate_reasons).",
    },
    null,
    2,
  );
  upsertReflection({
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
        // ★모순 탐색은 아카이브도 본다 — 사용자가 인덱스에서 내렸어도 «확정한 사실» 은
        //  그대로다. 안 보면 이미 정한 것과 부딪히는 제안을 다시 낸다.
        const hits = searchMemories(kw, 5, { includeArchived: true });
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

// ─── Phase 7a (2026-07-02) — 실패 주도 개선 (worker.failed → reflect → 라우팅) ───
// 진실 소스: _workspace/self_growth_failure_driven_architect.md §2·§3 + ADR
// 2026-07-02. worker.failed 는 "무슨 작업이 실패했나"(task)를 아는 1급 신호 —
// turn_error("어댑터가 왜 끝났나")보다 풍부. 게이트 A(의미)·B(반복 threshold=2) 통과 +
// 비멱등 순간에만 reflect 1회(비용 bound). 전부 suggester(자동 확정 0 — 7b 별건).

// worker.failed threshold=1 — 실패 시 즉시 분석(반복 대기 X). 근거(2026-07-02 라이브 실측
// 정정): 비서가 매니저 task·label 을 매 실행 리워딩 → 2회 실패해도 다른 키 → 반복 그룹핑이
// 근본 불안정(반복 게이트 무의미). 게다가 매니저 실패는 드문 신호라 스팸방지용 반복 게이트가
// 불필요하고, 사용자 비전("*실패했으면* 원인 분석해 제안")과도 정합. 비용 bound 는 멱등
// (같은 키 이미 학습 → LLM skip) + gate A(취소·무근거 drop) + 매니저 실패의 희소성으로 유지.
// (ADR 결정 #1 을 실측이 정정 — turn_error 는 빈발이라 FAILURE_THRESHOLD=3 유지.)
export const WORKER_FAILURE_THRESHOLD = 1;

/**
 * worker.failed 이벤트 payload — 코어 worker-jobs 가 발행(worker-jobs.ts markFailed →
 * publishWorkerLifecycle). self-growth 는 *구조적으로만* 소비(코어 타입 import 안 함 —
 * 단방향 §0, 데이터로만). 코어가 error≤300자·task≤500자 로 이미 cap 한다.
 */
export interface WorkerFailedPayload {
  jobId?: string;
  label?: string;
  /** 원 thread(worker:<id> 아님 — worker-jobs record.threadKey). self namespace 방어용. */
  threadKey?: string;
  status?: string;
  /** redact 된 원인(≤300자). 게이트 A: task 와 둘 다 비면 drop. */
  error?: string;
  /** 매니저 작업 지시(≤500자). 작업 근사 키의 원천. */
  task?: string;
}

/**
 * 작업 근사 키 — worker.failed 의 task 를 정규화(normalizeErrorMessage 재사용 — 휘발
 * 토큰·경로·id·숫자 마스킹). 같은 일일 매니저가 표면 텍스트만 달라도 같은 키로 묶이게 한다.
 * 빈 task 는 빈 문자열(호출자 게이트 A 가 error·task 둘 다 빈 경우를 이미 drop).
 */
export const normalizeTaskKey = (task: string): string =>
  normalizeErrorMessage(task);

/**
 * worker.failed error 문자열에서 errorKind 근사 — LLM-agnostic 문자열 휴리스틱(분기 키 아님,
 * 집계 라벨). worker-jobs payload 는 handleTurnError 처럼 errorKind 를 안 실어주므로 여기서
 * 근사. evaluateFailureLowRiskGate 의 KNOWN_KINDS(timeout·model_rejected·error)와 정합.
 */
export const deriveWorkerErrorKind = (error: string): string => {
  const t = error.toLowerCase();
  if (/시간 초과|타임아웃|idle|timeout|무진전|stall|spinning/.test(t)) return "timeout";
  if (/usage_limit|usage limit|429|rate.?limit|거부|rejected|refus/.test(t))
    return "model_rejected";
  return "error";
};

/**
 * worker.failed error 문자열에서 adapter 라벨 근사 — *사실* 로만 프롬프트/집계에 들어감
 * (분기 키 절대 아님, 원칙 2). 미검출이면 "unknown"(어댑터 무관 처리).
 */
export const deriveWorkerAdapter = (error: string): string => {
  const t = error.toLowerCase();
  if (t.includes("codex")) return "codex";
  if (t.includes("claude") || t.includes("anthropic")) return "claude";
  if (t.includes("openai") || t.includes("gpt")) return "openai";
  if (t.includes("ollama") || t.includes("local")) return "local";
  return "unknown";
};

/**
 * Phase 7a 라우팅 순수함수 — reflect 결과(cause)로 저장 경로 결정 + reflection 박기.
 * **전부 suggester(자동 확정 0)** — 7b(저위험 자율확정)는 구현 안 함. 모든 경로가 reflection
 * 또는 skill_reflection(기존 analyzeSkillImprove 위임). null 이면 미박기(멱등·근거부족).
 *
 * 라우팅 규칙(§2.3):
 *  - skill + relatedSkills 있음 → analyzeSkillImprove 경로 위임(skill_reflection). 단
 *    self-growth 는 스킬파일 안 씀(harness 가 씀). relatedSkills 비면 reflection 강등.
 *  - prompt_config / task_design / uncertain → feedback_growth_failure_<slug> reflection.
 *    (uncertain 은 보수 강등 — 사용자 확인. §3-3: 회색지대 기본값 task_design 계열.)
 *  - core → feedback_growth_core_flag_<slug> reflection **only**(자동 확정 절대 0).
 *
 * 멱등: 같은 slug reflection 이 이미 있으면 재박기 skip(getMemory). skill 경로는
 * analyzeSkillImprove 가 자체 멱등(제안 메모 존재 시 재제안 0).
 */
export const routeFailureReflection = (input: {
  /** 작업 근사 slug(멱등 키). key 원문(정규화 task)에서 [^a-z0-9]+→_ cap 60. */
  key: string;
  reflection: FailureReflection;
  task?: string;
  errorKind: string;
  adapter: string;
  count: number;
  relatedSkills: string[];
}): { target: "skill_reflection" | "reflection" | "core_flag"; name: string } | null => {
  const slug = input.key.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
  if (slug.length === 0) return null;
  const cause: CauseCategory = input.reflection.cause;

  // ── skill 유형 + 관련 스킬 확인됨 → 기존 skill-improve 경로 위임(자동 확정 0, harness 집행) ──
  if (cause === "skill" && input.relatedSkills.length > 0) {
    // 실패 윈도에 겹친 각 스킬에 대해 개선 제안 시도. analyzeSkillImprove 는 자체 멱등·
    // 거버넌스 제외·가드 쿨다운·임계(skill_usage 누적) — 통과분만 reflection 박음. 이 경로가
    // 하나라도 박으면 skill_reflection 으로 보고, 전부 미박(임계 미달 등)이면 reflection 강등.
    let landedName: string | null = null;
    for (const skillName of input.relatedSkills) {
      try {
        const usage = listSkillUsage().find((u) => u.skillName === skillName);
        if (usage === undefined) continue;
        const r = analyzeSkillImprove(usage);
        if (r !== null && landedName === null) landedName = r.reflectionName;
      } catch (e) {
        console.error(`self-growth: routeFailureReflection skill improve failed for '${skillName}': ${e}`);
      }
    }
    if (landedName !== null) {
      return { target: "skill_reflection", name: landedName };
    }
    // 스킬 개선 임계 미달 등 → 아래 일반 reflection 으로 강등(신호 유실 0).
  }

  // ── core → core_flag reflection only(자동 확정 절대 0 — 개발자만 코드 수정) ──
  if (cause === "core") {
    const name = `feedback_${SELF_NAMESPACE}_core_flag_${slug}`;
    // 재발 갱신 — 실패가 더 쌓이면 신호가 세진 것이다(그게 FAILURE_THRESHOLD 의 전제).
    //  옛 `있으면 skip` 은 카운트·updated_at 을 얼려 인덱스 밀림 + 만료 정지를 낳았다.
    //  ★자동 확정은 여전히 0 — 코어 수정은 개발자 몫이다. 신호의 세기만 바로잡는다.
    const priorFlag = peekMemory(name);
    if (priorFlag !== undefined && !isStrongerSignal(priorFlag.body, "evidence_count", input.count)) {
      return null;
    }
    upsertReflection({ name, description: `[코어 플래그] '${(input.task ?? "").slice(0, 80)}' 작업 반복 실패(${input.count}회) — self-growth 원인분석: 코어 코드/구조 의심. 개발자 확인 필요(자율수정 대상 아님).`, body: buildFailureReflectionBody({
        cause,
        reflection: input.reflection,
        task: input.task,
        errorKind: input.errorKind,
        adapter: input.adapter,
        count: input.count,
        relatedSkills: input.relatedSkills,
        guidance:
          "이건 개발자가 코드로 봐야 하는 코어 이슈일 수 있습니다(자율수정 대상 아님). harness/개발자가 관찰된 증상·재현 맥락을 읽고 판단하세요. self-growth 는 코어를 수정하지 않으며 이 메모를 코어가 읽지도 않습니다(단방향).",
      }) });
    return { target: "core_flag", name };
  }

  // ── prompt_config / task_design / uncertain(+ skill 강등분) → 일반 reflection ──
  // ★**원인을 모르면 안 남긴다** (2026-09-05 재구성). 실측: 실패반성 12건 중 **8건**이
  //  `one_line_cause: ""` · `suggested_fix: ""` · `cause_category: "uncertain"` 이었다 —
  //  남는 건 오류 지문과 *"사용자에게 확인하세요"* 뿐이고, 그건 없느니만 못하다(자리를
  //  차지하고 읽는 사람의 시간을 쓴다). 원인을 아는 유일한 주체는 그 턴을 돌던 비서이지
  //  이벤트만 받는 이 플러그인이 아니다 — 모르면 **비워두는 게 정직하다.**
  //  ★신호 자체는 안 잃는다: 실패 카운트는 `failureKey` 누적으로 살아 있고, 원인이 잡히는
  //   순간(다음 실패에서 LLM 이 한 줄을 뽑으면) 그때 박힌다.
  const hasCause =
    input.reflection.oneLine.trim() !== "" || input.reflection.suggestedFix.trim() !== "";
  if (!hasCause) return null;

  const name = `feedback_${SELF_NAMESPACE}_failure_${slug}`;
  const priorFail = peekMemory(name);
  if (priorFail !== undefined && !isStrongerSignal(priorFail.body, "evidence_count", input.count)) {
    return null; // 실패가 더 안 늘었다 — 갱신하면 만료 시계만 헛돈다.
  }
  upsertReflection({ name, description: `반복 매니저 실패 '${(input.task ?? "").slice(0, 80)}' (${input.errorKind}·${input.adapter}, ${input.count}회) — 원인분석=${cause}, suggester only, 사용자/harness 확인 후 결정`, body: buildFailureReflectionBody({
      cause,
      reflection: input.reflection,
      task: input.task,
      errorKind: input.errorKind,
      adapter: input.adapter,
      count: input.count,
      relatedSkills: input.relatedSkills,
      guidance:
        cause === "task_design"
          ? "작업 설계 개선 후보(멱등·증분·분할·타임아웃 넉넉히). 비서가 사용자에게 이 매니저 작업을 이렇게 다시 설계할지 확인 후 진행하세요. self-growth 는 제안만 — 자동 확정하지 않습니다."
          : cause === "prompt_config"
            ? "설정·프롬프트·타임아웃 값 조정 후보. 비서가 사용자에게 확인하거나 사용자가 직접 교정하세요. self-growth 는 제안만."
            : "원인 불확실(보수 강등) 또는 관련 스킬 미상 — 비서가 사용자에게 이 반복 실패 대응 의향을 명시 확인하세요. self-growth 는 제안만.",
    }) });
  return { target: "reflection", name };
};

/**
 * 실패 reflection body 빌더(관찰·원인·제안·안내). routeFailureReflection 공용.
 * observed(관찰)·cause·oneLine(원인)·suggestedFix(제안)·guidance(harness/사용자 확인 안내).
 */
const buildFailureReflectionBody = (input: {
  cause: CauseCategory;
  reflection: FailureReflection;
  task?: string;
  errorKind: string;
  adapter: string;
  count: number;
  relatedSkills: string[];
  guidance: string;
}): string =>
  JSON.stringify(
    {
      kind: "failure_driven_improvement",
      observed_pattern: `매니저 작업 '${(input.task ?? "").slice(0, 200)}' 가 ${input.count}회 실패 (${input.errorKind} · ${input.adapter})`,
      cause_category: input.cause,
      one_line_cause: input.reflection.oneLine,
      suggested_fix: input.reflection.suggestedFix,
      related_skills: input.relatedSkills,
      evidence_count: input.count,
      confidence: 0.4,
      // ★«확인하세요» 대신 **어디로 갈지**를 말한다 (2026-09-05). 판정은 `home.ts` 한 곳.
      ...homeFields(
        suggestHome({
          kind: "failure",
          cause: input.cause,
          errorKind: input.errorKind,
          hasCause: input.reflection.oneLine.trim() !== "",
        }),
      ),
      guidance: input.guidance,
      execution_boundary:
        "self-growth 는 제안만(suggester) — 스킬 파일 수정은 harness, 코어 수정은 개발자, 설정 변경은 사용자. 자동 확정 0.",
    },
    null,
    2,
  );
