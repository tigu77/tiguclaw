/**
 * **우리 MCP 서버 생성 — 도구를 접지 않는다** (2026-08-15).
 *
 * SDK 기본값은 도구를 **접고**(`defer_loading`) `ToolSearch` 로 열게 한다. 실측해보니
 * 그게 우리에겐 손해다:
 *
 *  · 관측된 `ToolSearch` 호출이 **전부 `select:` 형태**였다 — `select:mcp__file-ops__Bash`,
 *    `select:mcp__skills__invoke_skill`, `select:mcp__memory__read_memory`. 즉 "뭐가 있지?"
 *    를 묻는 **탐색이 아니라**, 이름을 이미 아는 도구의 스키마를 여는 **왕복**이다.
 *    그것도 우리 최다 사용 도구(`Bash` 450회)에 대해서.
 *  · 펼치는 비용은 작다: 도구 48개 전체가 **22,525자**(codex 실측, 매 호출 고정). 매 턴
 *    동일한 안정 블록이라 프리픽스 캐시에 들어간다. 반면 왕복은 캐시로 회수되지 않는 실비다.
 *
 * ★결정적인 근거는 **어댑터 비대칭**이다(사용자 지적): `ToolSearch` 는 claude(SDK)에만
 *  있고 codex·openai 엔 없다. 그런데 codex 는 같은 48개를 **전부 펼친 채로 잘 돈다**.
 *  같은 도구 집합인데 한쪽만 접고 있고, 안 접는 쪽이 멀쩡하다 — 그러면 접는 게 필요한
 *  능력이라는 근거가 없다. 필요했다면 공통으로 만들었어야 하고, 아니면 claude 도 안 쓰는
 *  게 맞다. 후자를 택한다.
 *
 * ★스킬은 이 축이 아니다. 스킬은 도구가 아니라 **인덱스**(이름+한 줄, `SKILL_INDEX_CAP=40`)
 *  로 실리고 본문은 `invoke_skill` 로 부를 때 온다 — 그 접기 규칙은 **우리가 만들었고 세
 *  어댑터 공통**이다. 도구 축만 claude 가 다른 규칙을 타고 있었다.
 *
 * ★**여기가 정의점이다.** 20곳에 `alwaysLoad: true` 를 손으로 붙이면 새 서버가 생길 때마다
 *  빠뜨릴 자리가 생긴다(손으로 관리하는 목록 = 드리프트 신호). 우리 서버는 전부 이 함수로
 *  만들고, 정책은 여기서만 바꾼다.
 *
 * ★**외부 MCP 서버엔 쓰지 않는다.** 사용자가 등록한 stdio/http 서버에 `alwaysLoad` 를 켜면
 *  turn-1 프롬프트를 만들 때 도구가 있어야 해서 **부팅이 연결까지 블로킹된다**(최대 5초,
 *  SDK 문서 명시). 우리 in-process 서버는 연결이 즉시라 그 대가가 없다.
 */
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

type OurServerConfig = Omit<
  Parameters<typeof createSdkMcpServer>[0],
  "alwaysLoad"
>;

export const createOurMcpServer = (
  config: OurServerConfig,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({ ...config, alwaysLoad: true });
