/**
 * **엔드포인트 미리보기 자르기** — 관측에 남길 본문을 상한까지만.
 *
 * ★`index.ts` 에서 뗐다 (2026-08-30). 작은데 **두 곳이 쓴다**(엔드포인트 라우트 · 게이트웨이
 *  라우트). 두 모듈이 같은 걸 필요로 하는 순간 자리는 셋 중 하나다 — 한쪽에 두고 import
 *  하거나(순환 위험), 복사하거나(두 벌), **따로 두거나**. 셋째가 맞다.
 */
export const ENDPOINT_PREVIEW_MAX = 4000;

/** 관측 이벤트용 미리보기 — 길면 앞부분만 + 잘린 사실·원본 길이 명시(조용한 절단 금지). */
export const endpointPreview = (s: string): string => {
  const text = String(s ?? "");
  if (text.length <= ENDPOINT_PREVIEW_MAX) return text;
  return (
    text.slice(0, ENDPOINT_PREVIEW_MAX) +
    `\n\n… (전체 ${text.length.toLocaleString()}자 중 앞 ${ENDPOINT_PREVIEW_MAX.toLocaleString()}자만 표시 — 전문은 대화 기록에 보존됩니다)`
  );
};
