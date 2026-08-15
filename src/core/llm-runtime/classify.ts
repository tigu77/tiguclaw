/**
 * 내부 분류성 1회 LLM 호출 — region facade(runRegionA) 재사용, LLM-agnostic.
 *
 * 진실 소스: `_workspace/selfgrowth_contradiction_judge_region_contract.md`.
 *
 * 설계 본질 (임무 §1~§4):
 *  - **새 어댑터·새 HTTP 클라이언트 0** (임무 §4 부품 최소). runRegionA 를 그대로 재사용해
 *    현재 활성 어댑터(claude/codex/openai/local 무엇이든)로 호출 — provider 선택·폴백은
 *    runPool 의 *동일* 코드(resolveModelSpecs)를 타므로 어댑터 if 분기 0, 모델 하드코딩 0
 *    (임무 §2 LLM-agnostic 하드게이트).
 *  - **경량화**: leanMemory:true + toolPolicy:{mode:"none"} — 메모리 인덱스 prepend 생략 +
 *    도구 0. 작은 분류엔 컨텍스트·도구가 불필요(턴이 가벼워짐).
 *  - **메타-재귀 킬스위치**: internal:true — facade 가 turn_done/turn_error 미발행 +
 *    transcripts/sessions 미persist. 이 분류 호출이 *다시* self-growth 입력 이벤트로
 *    되돌아오는 루프를 구조적으로 차단(임무 §3).
 *  - **견고성**: 짧은 타임아웃(기본 8s) + 실패·타임아웃·파싱불가 → 모두 sentinel
 *    "uncertain" 반환(throw 0). 호출자는 uncertain 을 "모순 판정 불가 = 보수적 강등"으로
 *    받는다. 데몬·턴 절대 안 죽음(임무 §3).
 *
 * 모델 tier 선택 (임무 §2 — "가장 싼/빠른 tier 를 LLM-agnostic 하게"):
 *  - 분류는 작은 작업이라 nano/low tier 가 적합. resolveTier("nano") → 없으면 "low" →
 *    둘 다 없으면 undefined(env 풀/디폴트로 폴백). tier 풀도 provider:model 콤마라
 *    어댑터 무관. self-growth 가 특정 모델을 고르지 않는다 — env 가 tier 를 정의하고,
 *    미정의면 일반 디폴트로 안전 degrade.
 */
import { resolveTier, runRegionA, type ModelSpec } from "./index.js";

/** 분류 결과 — 3진. 실패·타임아웃·파싱불가는 모두 "uncertain"(sentinel). */
export type ContradictionVerdict = "yes" | "no" | "uncertain";

export interface JudgeContradictionInput {
  /** 박기 임박한 후보 lesson 텍스트(명령형 한 줄 또는 요약). */
  candidate: string;
  /** 비교 대상 — 기존 사용자/외부 확정 메모 몇 개의 텍스트. 보통 1~5개. */
  existing: string[];
  /** 타임아웃(ms). 기본 8000. 박기 임박 순간만 호출하므로 짧게. */
  timeoutMs?: number;
}

/**
 * **내부 단발 호출**의 싼 tier 풀 해석 — nano → low → undefined(facade 디폴트). 어댑터 무관.
 *
 * ★2026-08-15: `WebFetch(prompt)` 추출도 같은 판단이 필요해져 **export** 했다. 복사하면
 *  "가장 싼 tier 고르기" 라는 같은 판단이 두 곳에 생기고, 한쪽만 늙는다. 이름도
 *  classify 전용에서 중립으로 바꿨다(정의점은 여기 하나).
 * self-growth 가 모델을 고르지 않음: env(MODEL_TIER_NANO/LOW)가 정의한 풀을 쓰고,
 * 미정의면 undefined 로 일반 디폴트(REGION_A_MODELS/anthropic)에 안전 degrade.
 */
export const cheapInternalTierSpecs = (): ModelSpec[] | undefined => {
  const nano = resolveTier("nano");
  if (nano.length > 0) return nano;
  const low = resolveTier("low");
  if (low.length > 0) return low;
  return undefined; // facade 디폴트(env REGION_A_MODELS → anthropic SDK 디폴트)
};

/** 응답 텍스트에서 yes/no/uncertain 추출. 명확치 않으면 uncertain(보수적). */
export const parseVerdict = (text: string): ContradictionVerdict => {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return "uncertain";
  // 첫 토큰 우선 — 프롬프트가 "한 단어만" 요구하므로 보통 맨 앞에 답이 온다.
  // 단어 경계로 yes/no/uncertain 탐지. 모순 신호가 둘 다 잡히면 보수적 uncertain.
  const hasYes = /\byes\b/.test(t);
  const hasNo = /\bno\b/.test(t);
  const hasUncertain = /\buncertain\b|\bunknown\b|\bunclear\b/.test(t);
  if (hasUncertain) return "uncertain";
  if (hasYes && !hasNo) return "yes";
  if (hasNo && !hasYes) return "no";
  return "uncertain"; // 모호·동시검출·미검출 → 보수적
};

const buildPrompt = (candidate: string, existing: string[]): string => {
  const existingBlock =
    existing.length === 0
      ? "(none)"
      : existing.map((e, i) => `${i + 1}. ${e}`).join("\n");
  return [
    "You are a strict consistency checker. Decide whether the CANDIDATE statement",
    "semantically contradicts ANY of the EXISTING confirmed statements.",
    "Answer with EXACTLY ONE word: yes, no, or uncertain.",
    "- yes: the candidate directly conflicts with at least one existing statement.",
    "- no: the candidate is consistent with all existing statements.",
    "- uncertain: not enough information, or ambiguous.",
    "Output the single word only. No explanation.",
    "",
    "CANDIDATE:",
    candidate,
    "",
    "EXISTING:",
    existingBlock,
    "",
    "Answer (one word):",
  ].join("\n");
};

/**
 * 모순 판정 1회 — 현재 활성 어댑터로 분류. **절대 throw 하지 않음**: 타임아웃·실패·
 * 파싱불가 → "uncertain". 호출자는 uncertain 을 보수적 강등 신호로 받는다.
 *
 * 메타-재귀 안전: internal:true 로 turn_done/turn_error 미발행 → self-growth 입력
 * 이벤트를 낳지 않음(킬스위치). leanMemory + toolPolicy:none 으로 경량 단발.
 */
export const judgeContradiction = async (
  input: JudgeContradictionInput,
): Promise<ContradictionVerdict> => {
  const timeoutMs = input.timeoutMs ?? 8000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const output = await runRegionA(
      {
        text: buildPrompt(input.candidate, input.existing),
        // 비채널 내부 호출 — 표시·집계 라벨일 뿐 라우팅 아님. self-growth 출처 식별용.
        threadKey: "self-growth:contradiction",
        channel: "internal",
        internal: true, // 메타-재귀 킬스위치 + persist skip
        leanMemory: true, // 메모리 인덱스/스니펫 prepend 생략 (경량)
        toolPolicy: { mode: "none" }, // 도구 0 (분류엔 불필요 + 미지원 모델 graceful)
        abortSignal: ac.signal, // 짧은 타임아웃
      },
      { specs: cheapInternalTierSpecs() }, // nano/low tier(있으면) — LLM-agnostic 가벼운 풀
    );
    return parseVerdict(output.text);
  } catch {
    // 타임아웃·어댑터 실패·모델거부 등 — 모두 보수적 uncertain. 데몬·턴 안 죽음.
    return "uncertain";
  } finally {
    clearTimeout(timer);
  }
};
