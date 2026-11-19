/**
 * **도구 결과 한 건의 크기 계약** — 어댑터 중립 자리(2026-11-19, docs/decisions/2026-11-19-tool-output-recovery-design.md §3-1).
 *
 * ★왜 여기인가: 진입 상한은 Codex 어댑터가 정하지만, 그 상한 안에 **들어가야 하는 쪽**(결과 재조회 응답·예약 목록 페이지)은
 *  어댑터 밖이다. 숫자를 두 곳에 적으면 한쪽만 바뀌는 순간 재조회가 다시 잘린다(개발클로드 회신 §4-4 «한쪽에서 끌어 쓴다»).
 *  환경 변수 이름은 종전 그대로(`CODEX_TOOL_OUTPUT_*`) — 설정을 바꾼 설치본이 그대로 따른다.
 */

/** 공통 env 파서 — 양의 정수만, 아니면 기본값. */
export const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * 단일 도구 결과의 모델 입력 **진입 상한**(자). 넘으면 머리+꼬리만 보이고 가운데는 참조로 다시 읽는다.
 * 16,000자 ≈ 4.5K tok — 한 결과가 턴 내내 매 요청 따라다녀도 부담이 작은 크기. 한 번에 읽는 분량이지 정보 삭제 경계가 아니다.
 */
export const TOOL_OUTPUT_ENTRY_CAP = parsePosIntEnv(process.env.CODEX_TOOL_OUTPUT_ENTRY_CAP, 16_000);
export const TOOL_OUTPUT_HEAD_CHARS = parsePosIntEnv(process.env.CODEX_TOOL_OUTPUT_HEAD_CHARS, 8_000);
export const TOOL_OUTPUT_TAIL_CHARS = parsePosIntEnv(process.env.CODEX_TOOL_OUTPUT_TAIL_CHARS, 4_000);

/**
 * 결과 한 건의 **보존 상한**(자, 표식 포함) — 가린 보존본이 이보다 길면 앞·뒤만 남기고 가운데는 «회수 불가» 로 결과 안에 적는다.
 * 무제한 보존은 목표가 아니다(통합 인계 §1). 이번 사건(22,735자)·Read 한 번이 대개 들어가고, 재조회 6~7번으로 끝까지 읽는다.
 */
export const TOOL_OUTPUT_RETAIN_CHARS = 100_000;
