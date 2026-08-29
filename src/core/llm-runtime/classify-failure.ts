/**
 * 실패 원인 분석 1회 LLM 호출 — classify.ts(judgeContradiction) 형제. self-growth
 * Phase 7a(실패 주도 개선)의 reflect 노드.
 *
 * 진실 소스: `_workspace/self_growth_failure_driven_architect.md` §2.2 +
 * ADR `docs/decisions/2026-07-02-self-growth-failure-driven-improvement.md`.
 *
 * 설계 본질 (classify.ts 답습 — 형제라 동일 계약):
 *  - **새 어댑터·새 HTTP 클라이언트 0**: runRegionA facade 를 그대로 재사용해 현재 활성
 *    어댑터(claude/codex/openai/local 무엇이든)로 호출. provider 선택·폴백은 runPool
 *    의 동일 코드를 타므로 어댑터 if 분기 0, 모델 하드코딩 0 (원칙 2 LLM-agnostic 하드게이트).
 *    payload 의 adapter 는 프롬프트에 *사실* 로만 들어가는 집계 라벨 — 분기 키가 아니다.
 *  - **경량화**: leanMemory:true + toolPolicy:{mode:"none"} — 메모리 인덱스 prepend 생략 +
 *    도구 0 (작은 분류엔 불필요).
 *  - **메타-재귀 킬스위치**: internal:true — facade 가 turn_done/turn_error/worker.failed
 *    미발행 + transcripts/sessions 미persist. 이 분석 호출이 *다시* self-growth 입력
 *    신호(worker.failed/turn_error)로 되돌아오는 루프를 구조적으로 차단(contract §4-1).
 *  - **견고성(never-throw)**: 짧은 타임아웃(기본 8s) + 실패·타임아웃·파싱불가 → 모두
 *    sentinel `{ cause:"uncertain", ... }` 반환(throw 0). 호출자는 uncertain 을
 *    "원인 판정 불가 = 보수적 강등(사용자 확인)"으로 받는다. 데몬·턴 절대 안 죽음.
 *
 * 모델 tier 선택 (원칙 2 — "가장 싼/빠른 tier 를 LLM-agnostic 하게"):
 *  - classify.ts classifyTierSpecs 와 동일: nano → low → undefined(facade 디폴트).
 *    self-growth 가 특정 모델을 고르지 않는다 — env 가 tier 를 정의하고, 미정의면
 *    일반 디폴트로 안전 degrade. tier 풀도 provider:model 콤마라 어댑터 무관.
 */
import { resolveTier, runRegionA, type ModelSpec } from "./index.js";

/**
 * 실패 원인 유형 — 5진. 실패·타임아웃·파싱불가는 모두 "uncertain"(sentinel).
 *  - skill        : 특정 스킬 결함(스킬 사용과 상관).
 *  - prompt_config : 설정·프롬프트·타임아웃값 등의 조정.
 *  - task_design   : 작업을 멱등·증분·분할해야 함(작업 자체를 다시 짜야).
 *  - core          : 코어 코드 버그·구조 한계(개발자 플래그 — 자율수정 0).
 *  - uncertain     : 정보 부족·모호·분석 실패(보수 강등 sentinel).
 */
export type CauseCategory =
  | "skill"
  | "prompt_config"
  | "task_design"
  | "core"
  | "uncertain";

export interface FailureReflection {
  /** 원인 유형. 파싱 실패·타임아웃·불확실은 "uncertain". */
  cause: CauseCategory;
  /** 한 줄 원인(사람이 읽는 근거). */
  oneLine: string;
  /** 한 줄 제안(유형별 적용 힌트). */
  suggestedFix: string;
}

export interface ReflectFailureCauseInput {
  /** 매니저 작업 지시 근사(무슨 작업이었나 — turn_error 가 못 가진 정보). */
  task?: string;
  /** 에러 종류 라벨(timeout·model_rejected·error 등). 집계 라벨. */
  errorKind?: string;
  /** 활성 어댑터 라벨(codex·claude 등). *사실* 로만 프롬프트에 들어감 — 분기 키 아님. */
  adapter?: string;
  /** redact 된 원인 문자열(worker.failed error). */
  error?: string;
  /** 실패 윈도에 겹친 skill.invoked 이름들(있으면). skill 유형 라우팅의 근거. */
  relatedSkills?: string[];
  /** 타임아웃(ms). 기본 8000(classify.ts 답습). 박기 임박 순간만 호출하므로 짧게. */
  timeoutMs?: number;
}

/**
 * 분류 tier 풀 해석 — nano → low → undefined(facade 디폴트). classify.ts 와 동일.
 * self-growth 가 모델을 고르지 않음: env(MODEL_TIER_NANO/LOW)가 정의한 풀을 쓰고,
 * 미정의면 undefined 로 일반 디폴트(REGION_A_MODELS/anthropic)에 안전 degrade.
 */
const classifyTierSpecs = (): ModelSpec[] | undefined => {
  const nano = resolveTier("nano");
  if (nano.length > 0) return nano;
  const low = resolveTier("low");
  if (low.length > 0) return low;
  return undefined; // facade 디폴트(env REGION_A_MODELS → anthropic SDK 디폴트)
};

const VALID_CAUSES: ReadonlySet<CauseCategory> = new Set<CauseCategory>([
  "skill",
  "prompt_config",
  "task_design",
  "core",
  "uncertain",
]);

/**
 * 응답 텍스트에서 { cause, oneLine, suggestedFix } 추출. classify.ts parseVerdict 정신 —
 * 구조화 실패 시 보수적 uncertain(sentinel). 다음 순서로 견고하게 시도:
 *  1) JSON 블록(가장 바깥 { ... }) 파싱 → cause/one_line|oneLine/suggested_fix|suggestedFix.
 *  2) 파싱 불가·cause 미검출 → 원문에서 유형 키워드 스캔(첫 매칭). 그래도 없으면 uncertain.
 * cause 가 유효 유형이 아니면 uncertain(보수). 어떤 경로든 절대 throw 하지 않는다.
 */
export const parseFailureReflection = (text: string): FailureReflection => {
  const raw = text.trim();
  const fallback: FailureReflection = {
    cause: "uncertain",
    oneLine: "",
    suggestedFix: "",
  };
  if (raw.length === 0) return fallback;

  // 1) JSON 블록 추출(가장 바깥 중괄호). 모델이 앞뒤에 설명을 붙여도 견고.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const block = raw.slice(start, end + 1);
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      const causeRaw =
        typeof parsed.cause === "string" ? parsed.cause.trim().toLowerCase() : "";
      const cause = (VALID_CAUSES.has(causeRaw as CauseCategory)
        ? causeRaw
        : "uncertain") as CauseCategory;
      const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
      const oneLine = str(parsed.oneLine) || str(parsed.one_line);
      const suggestedFix = str(parsed.suggestedFix) || str(parsed.suggested_fix);
      return { cause, oneLine, suggestedFix };
    } catch {
      // JSON 파싱 실패 → 아래 키워드 스캔 폴백.
    }
  }

  // 2) 키워드 스캔 폴백 — 구조화 실패해도 명시 유형어가 있으면 채택(보수적, oneLine=원문 cap).
  const t = raw.toLowerCase();
  const scan: CauseCategory[] = [
    "skill",
    "prompt_config",
    "task_design",
    "core",
    "uncertain",
  ];
  for (const c of scan) {
    // prompt_config/task_design 은 공백·하이픈 변형도 허용(prompt config, task design 등).
    const variant = c.replace(/_/g, "[ _-]?");
    if (new RegExp(`\\b${variant}\\b`).test(t)) {
      return { cause: c, oneLine: raw.slice(0, 300), suggestedFix: "" };
    }
  }
  return fallback;
};

const buildPrompt = (input: ReflectFailureCauseInput): string => {
  const task = (input.task ?? "").trim() || "(작업 지시 없음)";
  const errorKind = (input.errorKind ?? "").trim() || "(unknown)";
  const adapter = (input.adapter ?? "").trim() || "(unknown)";
  const error = (input.error ?? "").trim() || "(원인 문자열 없음)";
  const skills =
    input.relatedSkills !== undefined && input.relatedSkills.length > 0
      ? input.relatedSkills.join(", ")
      : "(없음)";
  return [
    "아래 작업이 아래 원인으로 실패했다. 무엇을 고쳐야 하는가?",
    "다음 중 하나로 분류하라:",
    "- skill: 특정 스킬(절차·지침)의 결함이 원인.",
    "- prompt_config: 설정·프롬프트·타임아웃 값 등의 조정이 필요.",
    "- task_design: 작업을 멱등·증분·분할하도록 다시 설계해야 함.",
    "- core: 코어 코드 버그·구조적 한계(개발자가 코드로 봐야 함).",
    "- uncertain: 정보가 부족하거나 모호함.",
    "",
    "반드시 아래 형태의 JSON 한 개만 출력하라(설명·코드펜스 금지):",
    `{"cause":"<위 5개 중 하나>","oneLine":"<한 줄 원인>","suggestedFix":"<한 줄 제안>"}`,
    "",
    `작업: ${task}`,
    `에러 종류: ${errorKind}`,
    `어댑터: ${adapter}`,
    `관련 스킬: ${skills}`,
    "원인 문자열:",
    error,
  ].join("\n");
};

/**
 * 실패 원인 분석 1회 — 현재 활성 어댑터로 분류. **절대 throw 하지 않음**: 타임아웃·실패·
 * 파싱불가 → `{ cause:"uncertain", ... }`. 호출자는 uncertain 을 보수적 강등(사용자 확인)
 * 신호로 받는다.
 *
 * 메타-재귀 안전: internal:true 로 turn_done/turn_error/worker.failed 미발행 → self-growth
 * 입력 신호를 낳지 않음(킬스위치). leanMemory + toolPolicy:none 으로 경량 단발.
 */
export const reflectFailureCause = async (
  input: ReflectFailureCauseInput,
): Promise<FailureReflection> => {
  const timeoutMs = input.timeoutMs ?? 8000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const output = await runRegionA(
      {
        text: buildPrompt(input),
        // 비채널 내부 호출 — 표시·집계 라벨일 뿐 라우팅 아님. self-growth 출처 식별용.
        threadKey: "self-growth:failure-reflect",
        channel: "internal",
        internal: true, // 메타-재귀 킬스위치 + persist skip (turn/worker 이벤트 미발행)
        leanMemory: true, // 메모리 인덱스/스니펫 prepend 생략 (경량)
        toolPolicy: { mode: "none" }, // 도구 0 (분류엔 불필요 + 미지원 모델 graceful)
        abortSignal: ac.signal, // 짧은 타임아웃
      },
      { specs: classifyTierSpecs() }, // nano/low tier(있으면) — LLM-agnostic 가벼운 풀
    );
    return parseFailureReflection(output.text);
  } catch {
    // 타임아웃·어댑터 실패·모델거부 등 — 모두 보수적 uncertain. 데몬·턴 안 죽음.
    return { cause: "uncertain", oneLine: "", suggestedFix: "" };
  } finally {
    clearTimeout(timer);
  }
};
