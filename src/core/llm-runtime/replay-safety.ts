/**
 * **부작용이 시작되면 그 논리 턴은 다시 돌리지 않는다** (2026-09-14)
 *
 * ★사고의 모양(외부 검토): 모델 후보 전환은 `runPool` 이 하는데 **도구 실행은 어댑터 안에서**
 *  일어난다. 그래서 예외를 받은 풀은 *"이미 부작용이 시작됐는지"* 를 알 수 없었고, 그대로
 *  다음 후보로 넘겨 **같은 요청을 처음부터 다시** 돌렸다. 파일 쓰기·발송·외부 API 가 그 사이에
 *  있었으면 **두 번 실행**된다 — 되돌릴 수 없는 부류다.
 *
 * ★같은 판정이 **내부 재시작**에도 필요하다: claude 의 resume 실패 후 fresh 재시작,
 *  openai 의 tools-unsupported 후 no-tools 재시작. 셋 다 «원 요청을 다시 돌린다» 는 점에서
 *  같으므로 상태를 **논리 턴 하나**가 공유한다.
 *
 * ★**성공이 아니라 dispatch 직전에 표시한다.** 도구는 효과를 낸 뒤에 실패할 수 있다 —
 *  성공 후에 찍으면 «반쯤 실행되고 실패한» 것이 안전한 것으로 보인다.
 *
 * ★**이름으로 안전을 추정하지 않는다**(외부 MCP). `read_`·`get_` 으로 시작해도 남의 서버가
 *  무엇을 하는지 우리는 모른다. 우리 도구만 분류표(`isReadOnlyTool`)를 믿는다 — 그 표는
 *  `fix-fallout` 회귀가 «등록된 도구가 전부 분류돼 있나» 로 지킨다.
 */

/** 논리 턴 하나가 공유하는 상태. 실패·정리·후보 변경으로 **초기화하지 않는다**. */
export interface ReplayGuard {
  /** 되돌릴 수 없는 도구가 **실행에 들어갔다**. 한 번 참이면 다시 거짓이 되지 않는다. */
  unsafe: boolean;
  /** 그 첫 도구 이름 — 실패 보고가 «무엇까지 갔나» 를 말할 수 있게. */
  firstTool?: string;
}

export const createReplayGuard = (): ReplayGuard => ({ unsafe: false });

/**
 * 도구 dispatch **직전**에 부른다.
 *
 * @param readOnly 우리가 **분류한** 읽기 전용인가. 외부 MCP 는 언제나 `false` 로 넘긴다
 *   (이름 규약이 없고, 남의 부작용을 우리가 알 수 없다).
 */
export const markToolDispatch = (
  guard: ReplayGuard | undefined,
  toolName: string,
  readOnly: boolean,
): void => {
  if (guard === undefined || readOnly) return;
  if (!guard.unsafe) {
    guard.unsafe = true;
    guard.firstTool = toolName;
  }
};

/** 이 턴을 다시 돌려도 되나 — `runPool` 의 폴백과 어댑터 내부 재시작이 함께 본다. */
export const canReplay = (guard: ReplayGuard | undefined): boolean =>
  guard === undefined || !guard.unsafe;

/** 폴백을 멈춘 이유를 사람이 읽는 한 줄로. */
export const replayBlockedReason = (guard: ReplayGuard): string =>
  `이미 '${guard.firstTool ?? "도구"}' 실행에 들어가 다시 돌릴 수 없습니다 — 같은 요청을 재실행하면 그 도구가 두 번 실행됩니다.`;
