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
 * 우리 `spawn_agent` 이 SDK 에 노출되는 이름 — MCP 서버 `agents`(agent-registry.ts) 안의 도구.
 * alias 의 **대상**이라 서버 이름이 바뀌면 여기도 같이 바뀌어야 한다(회귀가 대조한다).
 */
export const OURS_MCP_TOOL = `mcp__agents__${OURS}`;

/**
 * **습관적 SDK 이름 호출을 우리 도구로 회수**하는 alias 맵 (2026-08-08).
 *
 * 차단(`disallowedTools`)만으로도 모델은 스스로 `spawn_agent` 을 찾는다(실측). 이건 그 위의
 * 얇은 안전망 — 스킬 문서·사용자 프롬프트가 "Agent 도구로 …" 라고 **이름을 지시**하면 모델이
 * 그걸 emit 할 수 있고(SDK 문서가 든 예시가 정확히 그 경우), 그때 unknown 으로 죽는 대신
 * 우리 것으로 간다. alias 는 이름만 바꾸고 **스키마는 우리 것이 노출**되므로 인자 어댑팅이
 * 필요 없다(프로브로 확인: `{prompt}` 만 왔고 `subagent_type` 은 안 왔다).
 *
 * ★차단 목록과 **같은 출처**(SDK_SUBAGENT_TOOLS)에서 파생한다 — 한쪽만 늘어나는 드리프트가
 *  구조적으로 불가능하게. 상류가 또 개명하면 배열 한 줄만 고치면 셋(판정·차단·alias)이 따라온다.
 */
export const sdkSubagentAliases = (): Record<string, string> =>
  Object.fromEntries(SDK_SUBAGENT_TOOLS.map((t) => [t, OURS_MCP_TOOL]));

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
