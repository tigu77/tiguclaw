/**
 * **한도로 끝난 실패가 «언제 다시 쓸 수 있나» 를 싣는 칸** (2026-10-23 — 설계 docs/decisions/2026-10-22-limit-auto-resume-design.md §3.2).
 *
 * ★판정은 런타임 한 곳(`runPool`)이 한다 — 오류를 꾸미기 **전에**, 그 풀에서 실제로 본 후보 결과로. 두 출구(메인 턴 catch·작업 실패)는
 *  이 칸만 읽는다. 문장에는 싣지 않는다(우리가 쓴 글을 우리가 다시 파싱하는 자리를 만들지 않는다).
 * 리프 모듈 — 런타임·작업 레지스트리·핸들러가 서로를 import 하지 않고 같은 칸을 읽게 한다.
 */

interface ResumeCarrier {
  /** 그 풀에서 쓸 수 있는 후보가 생기는 가장 이른 시각(ms). 없으면 재개 대상이 아니다. */
  limitResumeAtMs?: number;
  /** 도구가 이미 실행된 뒤 멈췄으면 그 사유(`replayBlockedReason` 이 만든 문장). */
  limitPartialReason?: string;
}

/** 런타임 전용 — 한도 오류를 던지기 직전에 싣는다. */
export const markLimitResume = (e: unknown, resumeAtMs: number, partialReason?: string): void => {
  if (!(e instanceof Error)) return;
  const c = e as Error & ResumeCarrier;
  c.limitResumeAtMs = resumeAtMs;
  if (partialReason !== undefined) c.limitPartialReason = partialReason;
};

/** 이 실패가 한도이고 그 풀이 이 시각에 쓸 수 있으면 그 시각, 아니면 undefined(= 재개하지 않는다 · 현행). */
export const resumeAtOf = (e: unknown): number | undefined => {
  if (!(e instanceof Error)) return undefined;
  const v = (e as Error & ResumeCarrier).limitResumeAtMs;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

export const partialReasonOf = (e: unknown): string | undefined => {
  if (!(e instanceof Error)) return undefined;
  const v = (e as Error & ResumeCarrier).limitPartialReason;
  return typeof v === "string" && v !== "" ? v : undefined;
};
