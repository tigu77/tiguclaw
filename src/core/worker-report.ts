/**
 * **매니저 보고서 조립 — 본 보고서는 거두기 턴이 덮을 수 없다** (2026-09-14)
 *
 * ★사고: 매니저가 본 턴에 전체 검토(6,474자)를 써놓고, 늦게 온 자식 결과를 받는 거두기
 *  턴이 짧은 후속 의견(537자)을 내자 **그 537자가 최종 결과가 됐다.** 러너가
 *  `out = await rerunP` 로 `out` 을 덮고, 루프 뒤 `outcome = { result: out.text }` 가
 *  마지막 턴 텍스트만 쓰기 때문이다. 사용자가 받은 산출물은 «검토» 가 아니라 «검토가
 *  왜 안 됐는지» 였다.
 *
 * ★**이음매가 서로 다른 말을 하고 있었다.** `HARVEST_SCOPE_GUIDANCE` 는 거두기 턴에
 *  *"고치지 말고 최종 보고에 후속 제안으로만 적으세요"* 라고 **덧붙이기**를 지시하는데,
 *  배관은 그 턴의 텍스트로 **치환**했다. 모델은 시킨 대로 했고 코드가 그걸 버렸다.
 *  그래서 처방은 프롬프트를 더 세게 쓰는 것이 아니라 **배관을 그 말에 맞추는 것**이다.
 *
 * ★왜 별 모듈인가: 소유권·수명 판단(무엇이 본 보고서이고 무엇이 후속인가)을 러너 루프
 *  한가운데 두면 검사할 수가 없다. 순수 함수면 «여러 라운드·빈 응답·전문 재작성» 을
 *  표로 잴 수 있다([[feedback_simple_composable_no_duplication]]).
 */

/** 후속 구간의 머리표 — 이 줄이 «나중 판단이 앞 판단을 정정한다» 는 우선순위를 만든다. */
export const addendumHeader = (round: number): string =>
  `── 이후 도착한 작업자 결과 반영 (${round}회째) — 위 본문과 어긋나면 **이쪽이 최신 판단**이다 ──`;

/** 거두기 턴이 실패·중단됐음을 보고서에 남기는 꼬리표. 조용히 잃지 않기 위한 것이다. */
export const harvestFailureNote = (reason: string): string =>
  `── 거두기 턴이 끝나지 못했다: ${reason} — 위 본 보고서는 그 전에 완성된 것이다 ──`;

/**
 * 본 보고서 + 거두기 턴 산출물들 → 최종 결과 한 덩어리.
 *
 * 규칙 셋뿐이고, 셋 다 «무엇이 들어왔나» 로 판정한다(목록·플래그 없음):
 *  1. **빈 것은 없는 것** — 공백만 온 라운드는 보고서를 바꾸지 않는다.
 *  2. **전문을 다시 썼으면 그것이 최신** — 거두기 텍스트가 지금까지의 본문을 그대로
 *     담고 있으면 덧붙이지 않고 **교체**한다(그래야 여러 라운드에 본 보고서가 중복
 *     증식하지 않는다).
 *  3. 그 외는 **후속으로 덧붙인다** — 머리표가 붙어 앞 판단과 구분된다.
 */
export const composeWorkerReport = (
  mainText: string,
  harvestTexts: readonly string[],
): string => {
  let report = mainText.trim();
  let round = 0;
  for (const raw of harvestTexts) {
    const text = raw.trim();
    if (text === "") continue; // ① 빈 응답은 보고서를 건드리지 않는다.
    round += 1;
    if (report === "" || text.includes(report)) {
      report = text; // ② 전문 재작성 — 중복 증식 0.
      continue;
    }
    report = `${report}\n\n${addendumHeader(round)}\n${text}`; // ③ 후속.
  }
  return report;
};
