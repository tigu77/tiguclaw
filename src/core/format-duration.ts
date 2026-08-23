/**
 * 사람이 읽는 **경과시간** 문구 — 단일 판단.
 *
 * ★왜 모았나 (2026-08-22): 같은 계산이 세 곳에 흩어져 있었다 — `/agents` 의 경과 표시,
 *  잡 점검 보고, 그 로그. 셋 다 분 단위 나눗셈을 각자 했고, 그러면 한 곳만 늙는다
 *  (`reset-time-is-readable` 회귀가 잡으려던 부류 — 한도 리셋 문구를 두 소비처가 각자
 *  만들어 한쪽이 `약 8118분 후` 로 남았던 사고).
 *
 * ★`formatResetAt`(rate-limit.ts) 과는 **다른 질문**이다: 저건 "언제 풀리나"(미래 시각),
 *  이건 "얼마나 지났나"(경과). 합치면 문구가 서로를 오염시킨다.
 */

/**
 * 경과 ms → `"45초"` / `"3분"` / `"3분 20초"` / `"2시간 5분"`.
 *
 * 음수(시계 역행)는 0으로 클램프 — "-3분" 이 사용자에게 나가지 않게.
 * 조사("…째")는 **호출부가 붙인다** — 문장마다 어울리는 조사가 달라서 여기서 정하면
 * 변형이 늘어난다.
 */
export const formatDurationKo = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const totalMin = Math.floor(sec / 60);
  if (totalMin < 60) {
    const s = sec % 60;
    return s === 0 ? `${totalMin}분` : `${totalMin}분 ${s}초`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
};
