/**
 * **서브에이전트 도구 판정 — 단일 진실** (2026-08-07).
 *
 * 사고: 백그라운드 패널의 "매니저/에이전트" 가 **항상 0** 이었다. 실측(24시간): 서브에이전트
 * 도구가 `Agent` 로 14회 호출됐는데 우리 코드는 전부 `"Task"` 를 찾고 있었다. Claude SDK 가
 * 0.3 에서 그 도구 이름을 `Task` → `Agent` 로 바꿨고, 우리는 옛 이름에 남았다.
 *
 * ★같은 이름이 **네 곳**에 흩어져 있었고 넷 다 조용히 죽었다:
 *  ①잡 등록(claude 어댑터) — 패널이 비었다
 *  ②느림 경고 임계 완화(tool-watchdog) — 정상적인 장시간 위임이 3분마다 "멈춤 의심" 경고
 *  ③**하드 타임아웃 면제**(tool-watchdog) — ★어제 넣은 13분 컷이 **정상 서브에이전트를
 *    죽일 수 있었다**. 면제 명단이 옛 이름이라 `Agent` 는 면제 밖이었다.
 *  ④대시보드 잡카드 링크 — 스텝으로 점프가 안 됐다
 *
 * 그래서 이름을 열거하는 대신 **판정 하나**를 둔다([[hand-maintained-lists]]). 상류가 또
 * 개명하면 여기 한 줄만 고치면 되고, 넷이 서로 다른 이름을 보는 일이 구조적으로 없어진다.
 *
 * ★왜 옛 이름을 남겨두나: 사용자 설치본은 SDK 버전이 제각각이다(0.1 을 쓰는 설치본에서는
 *  여전히 `Task` 가 온다). 둘 다 받는 게 맞고, 이건 목록이 아니라 **호환 창**이다.
 */

/** 우리 MCP 서브에이전트 도구(어댑터 무관). */
const OURS = "spawn_agent";

/**
 * **SDK 빌트인** 서브에이전트 도구인가 — `Agent`(0.3+) / `Task`(0.1~0.2, 구 설치본 호환).
 *
 * ★우리 `spawn_agent` 과 **반드시 구분**해야 한다 (2026-08-07 거짓 경고로 실증).
 *  SDK 빌트인은 서브가 **같은 스트림 안**에서 돌아 내부 스텝이 `parent_tool_use_id` 로
 *  올라온다 — 그래서 어댑터가 관측 잡을 등록하고 스텝을 셀 수 있다.
 *  `spawn_agent` 은 **우리 런타임**(별도 `agent:<jobId>` 좌표, 자체 잡 등록)에서 돌아
 *  그 스텝이 어댑터 스트림에 안 온다. 여기에 섞으면 어댑터가 "스텝 0" 으로 보고
 *  **일을 다 한 에이전트를 안 했다고 경고**한다(실측: codex 에서 4회 순회한 잡).
 */
export const SDK_SUBAGENT_TOOLS = ["Agent", "Task"] as const;

export const isSdkSubagentTool = (tool: string): boolean =>
  (SDK_SUBAGENT_TOOLS as readonly string[]).includes(tool);

/**
 * ★alias 를 두지 않는다 (2026-08-08 검토 결과 철회).
 *
 * 한때 `toolAliases: {Agent: "mcp__agents__spawn_agent"}` 로 습관적 호출을 회수했다.
 * 실측 결과 **그림자 잡**이 생겼다 — SDK 는 alias 이전 이름(`Agent`)을 그대로 assistant
 * `tool_use` 로 스트림에 올리므로 어댑터가 그걸 SDK 서브에이전트로 오인해 잡을 등록하고,
 * alias 는 실행을 우리 도구로 보내 **진짜 잡이 또** 등록된다. 실증(devbot DB):
 *   18:37:41 Explore failed 0초(그림자)  /  18:37:54 explore done 20초(진짜)
 * 결과는 카드 2장·거짓 "도구 0회" 경고·취소 의미 2개.
 *
 * ★그리고 alias 가 필요했던 이유는 **우리 프롬프트가 차단한 도구를 가리키고 있었기**
 *  때문이다(헌법·find_capabilities·harness 스킬·도구 설명 네 곳). 그 원인을 고쳤으므로
 *  그물 자체가 불필요하다 — 원인을 고칠 수 있으면 그물을 만들지 않는다.
 */
/**
 * 이 도구 호출이 **서브에이전트를 띄우는가**(주인이 누구든).
 *  - `spawn_agent` — 우리 MCP 도구(claude·codex·openai 공통)
 *  - `Agent`/`Task` — Claude SDK 빌트인
 * 시간 정책(느림 경고 완화·하드컷 면제·푸시 억제)은 주인과 무관하므로 이쪽을 쓴다.
 */
export const isSubagentTool = (tool: string): boolean =>
  tool === OURS || isSdkSubagentTool(tool);

/** 오래 걸리는 게 **정상**인 도구인가 — 느림 경고 완화·하드컷 면제의 공통 기준. */
export const isLongRunningByDesign = (tool: string): boolean =>
  isSubagentTool(tool);

/**
 * SDK 빌트인 서브에이전트 차단을 **깊이와 무관하게** 적용한다.
 *
 * ★함수로 뽑은 이유는 편의가 아니라 **검사 가능성**이다 (2026-08-08 적대 검토).
 *  종전엔 어댑터가 배열을 직접 펼쳤고, 회귀는 "`depth` 라는 글자가 근처에 없다" 는
 *  **철자**로 깊이 무관을 검사했다. 검토자가 `...SDK_SUBAGENT_TOOLS.filter(() => depth === 0)`
 *  로 변이하니 **그대로 통과**했다 — 손자 구멍이 다시 열리는데 게이트는 초록이었다.
 *  여기엔 `depth` 를 받을 자리가 없다. 조건을 걸려면 이 함수를 고쳐야 하고, 그러면
 *  아래 회귀가 두 인자로 직접 호출해 결과를 대조하므로 즉시 드러난다.
 *  ★검사를 세게 쓰는 게 아니라, **틀리게 쓸 수 없게** 만드는 쪽이 맞다.
 */
export const withSdkSubagentsBlocked = (base: readonly string[]): string[] => [
  ...base,
  ...SDK_SUBAGENT_TOOLS,
];
