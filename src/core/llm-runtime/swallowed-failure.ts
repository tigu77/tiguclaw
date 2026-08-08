/**
 * **부작용 뒤 삼킨 실패를 사용자에게 어떻게 보이게 할 것인가** — 순수 판정 (2026-08-08).
 *
 * ★이 자리에서 하루에 **사용자 대면 결함이 두 번** 났다:
 *  ①`finalText` 를 덮어써서 화면엔 **잘린 문장만** 남았다(조기 종료와 구분 불가).
 *  ②고치면서 `deltaStream.closeSegment()` 를 직접 불러 **세그먼트를 훔쳤고**, 그 턴의
 *    텍스트가 통째로 사라져 **도구 카드만** 남았다 — 고치려던 증상을 더 정확히 재현했다.
 *  ③그 다음엔 택일→결합으로 바꾸며 stall 재시도의 **중복 문단**을 저장본에 들여놓았다.
 *
 * 세 번 다 회귀는 초록이었다. 이유는 검사가 **소스 정규식**이었기 때문이다 — 어댑터 한복판에
 * 인라인으로 있으면 "무엇이 화면에 가고 무엇이 저장되나" 를 **실행으로 물어볼 수가 없다**.
 * 그래서 판정만 여기로 뽑는다. 부수효과(발행·스트림)는 호출자가 하고, **무엇을 낼지**는
 * 여기서 정한다 — 그러면 회귀가 실제 입력을 넣고 결과를 볼 수 있다.
 *
 * ["검사가 껄끄러우면 코드가 잘못 놓인 것" — 이 레포가 /logs 규칙에서 이미 배운 것]
 */

export interface SwallowedFailureView {
  /** 그때까지 사용자가 **본** 텍스트(화면 기준). 로그의 판정 수치로도 쓴다. */
  readonly shown: string;
  /** 저장·전송될 최종 텍스트(화면에 이어 붙인 모양과 같아야 한다). */
  readonly saved: string;
  /** 스트림으로 **추가 발행**할 조각. 이미 나간 것을 다시 보내지 않는다. */
  readonly deltaText: string;
}

/**
 * @param finalText     이전 iteration 까지 확정된 텍스트(세그먼트로 이미 발행됨).
 * @param streamedSoFar 이번 iteration 에서 흘러가다 끊긴 조각(아직 세그먼트 미마감).
 * @param notice        실패 안내 문구.
 */
export const composeSwallowedFailure = (
  finalText: string,
  streamedSoFar: string,
  notice: string,
): SwallowedFailureView => {
  // ★중복을 들이지 않는다. stall 재시도는 **같은 body 로 재전송**해 모델이 텍스트를 처음부터
  //  다시 낸다 — 그래서 `streamedSoFar` 가 `finalText` 의 앞부분을 다시 담을 수 있다.
  //  포함 관계면 **긴 쪽만** 남긴다(짧은 쪽은 그 부분집합이다).
  const parts: string[] = [];
  for (const chunk of [finalText, streamedSoFar]) {
    if (chunk === "") continue;
    const dup = parts.findIndex((p) => p.includes(chunk) || chunk.includes(p));
    if (dup !== -1) {
      if (chunk.length > parts[dup]!.length) parts[dup] = chunk;
      continue;
    }
    parts.push(chunk);
  }
  const shown = parts.join("\n\n");
  return {
    shown,
    // 덮어쓰지 않고 **뒤에 붙인다** — 화면에 남은 잘린 문장 뒤로 이어져야 한 몸으로 읽힌다.
    saved: shown === "" ? notice : `${shown}\n\n${notice}`,
    // 이미 화면에 나간 `shown` 은 다시 보내지 않는다(중복 렌더 0). 구분선은 앞이 있을 때만.
    deltaText: shown === "" ? notice : `\n\n${notice}`,
  };
};
