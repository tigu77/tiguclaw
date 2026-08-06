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
 * 이 도구 호출이 **서브에이전트를 띄우는가**.
 *  - `spawn_agent` — 우리 MCP 도구(claude·codex·openai 공통)
 *  - `Agent` — Claude SDK 0.3+ 빌트인
 *  - `Task` — Claude SDK 0.1~0.2 빌트인(구 설치본 호환)
 */
export const isSubagentTool = (tool: string): boolean =>
  tool === OURS || tool === "Agent" || tool === "Task";

/** 오래 걸리는 게 **정상**인 도구인가 — 느림 경고 완화·하드컷 면제의 공통 기준. */
export const isLongRunningByDesign = (tool: string): boolean =>
  isSubagentTool(tool);
