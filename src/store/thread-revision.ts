/**
 * 스레드 요약 상태의 **단조 증가 리비전** (2026-09-29, 아스트라 검토).
 *
 * ★요약을 쓰는 경로가 셋이다 — 요청 때 · 답한 뒤 뒤에서 · 수동 `/compact`. 그리고 `/clear`·스케줄 경계가 대화를 끊는다.
 *  뒤에서 도는 요약이 끝났을 때 **그 사이 누가 상태를 바꿨는지**를 알아야 옛 결과로 덮어쓰지 않는다. 종전엔 경계·워터마크·
 *  요약 **길이**를 비교해 같은 길이의 다른 요약을 놓쳤다. 바뀔 때마다 오르는 번호 하나면 된다.
 * ★프로세스 메모리로 충분하다 — 한 홈엔 데몬 하나이고, 재시작하면 도는 요약도 없다.
 */
const revisions = new Map<string, number>();

/** 요약 저장·삭제·대화 경계 변경마다 부른다. */
export const bumpThreadRevision = (threadKey: string): void => {
  revisions.set(threadKey, (revisions.get(threadKey) ?? 0) + 1);
};

export const threadRevision = (threadKey: string): number => revisions.get(threadKey) ?? 0;
