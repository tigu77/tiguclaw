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

/**
 * **재실행 안전 판정 — 외부 MCP 는 이름으로 추정하지 않는다** (2026-09-15 회사 아스트라 지적).
 *
 * ★종전엔 codex 만 «외부 MCP 면 무조건 부작용으로 본다» 를 지켰고 claude·openai 는
 *  `isReadOnlyTool(이름)` 만 봤다. 그래서 서드파티 MCP 가 `get_*`·`list_*` 처럼 **읽기처럼
 *  보이는 이름**을 쓰면 실제로 부작용이 있어도 안전으로 분류돼, 폴백 때 **두 번 실행**됐다.
 * ★우리 빌트인 도구는 우리가 이름과 성질을 같이 정했으니 이름으로 판정해도 된다. 외부
 *  MCP 는 **남이 지은 이름**이라 그 전제가 성립하지 않는다 — 그래서 출처가 판정에 들어간다.
 * ★판정을 여기 한 곳에 둔다. 세 어댑터가 각자 `!external && readOnly` 를 적으면 언젠가
 *  한쪽만 고쳐진다([[feedback_hand_maintained_lists]]) — 실제로 그렇게 갈려 있었다.
 */
export const isReplaySafeTool = (opts: {
  /** 이 도구가 외부 MCP 에서 왔나(우리가 이름을 안 지었나). */
  external: boolean;
  /** 우리 빌트인 이름 규칙상 읽기 전용인가. */
  readOnlyByName: boolean;
}): boolean => !opts.external && opts.readOnlyByName;

/**
 * `mcp__<서버>__<도구>` 에서 서버 이름을 뽑는다(그 모양이 아니면 `undefined`).
 * claude SDK 만 이 접두사를 붙인다 — codex·openai 브리지는 무접두사 규약이다.
 */
export const mcpServerOf = (rawToolName: string): string | undefined => {
  if (!rawToolName.startsWith("mcp__")) return undefined;
  const parts = rawToolName.split("__");
  if (parts.length < 3) return undefined;
  // ★**서버 이름에 `__` 가 들어갈 수 있다** (2026-09-15, 레드팀 P6). `mcp__my__server__tool`
  //  에서 `parts[1]` 을 쓰면 `my` 가 나와 판정이 어긋난다. `normalizeToolName` 이 도구명으로
  //  **마지막 조각**을 쓰므로, 서버는 그 반대편 — **처음과 마지막을 뺀 전부**다.
  return parts.slice(1, -1).join("__");
};

/** 이 턴을 다시 돌려도 되나 — `runPool` 의 폴백과 어댑터 내부 재시작이 함께 본다. */
export const canReplay = (guard: ReplayGuard | undefined): boolean =>
  guard === undefined || !guard.unsafe;

/** 폴백을 멈춘 이유를 사람이 읽는 한 줄로. */
export const replayBlockedReason = (guard: ReplayGuard): string =>
  `이미 '${guard.firstTool ?? "도구"}' 실행에 들어가 다시 돌릴 수 없습니다 — 같은 요청을 재실행하면 그 도구가 두 번 실행됩니다.`;
