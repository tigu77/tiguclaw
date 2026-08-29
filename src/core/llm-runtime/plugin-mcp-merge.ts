// src/core/llm-runtime/plugin-mcp-merge.ts
/**
 * **플러그인 MCP 를 이 턴에 실을까, 그리고 코어와 부딪히면 누가 이기나** (2026-08-29).
 *
 * ★적대 검토 B 가 두 가지를 실측으로 깼다.
 *
 *  **① "도구가 없어야 하는 턴은 안 다친다" 에 강제가 0이었다.** 그 주장이 이번 변경의
 *  유일한 안전 논거였는데, 회귀는 어댑터 파일에 `toolPolicy?.mode === "none"` 이라는
 *  **글자가 있는지**만 봤다. 세 어댑터 전부 `toolsNone` 갈래에 플러그인을 주입해도
 *  **스위트가 초록**이었다(실측 2,287건). 게이트웨이·엔드포인트·분류·webfetch 가 플러그인
 *  도구를 받게 돼도 아무도 안 본다.
 *
 *  **② claude 에서 플러그인이 코어 서버 키를 덮었다.** 스프레드가 객체 리터럴 **마지막**
 *  이고 이름 검증이 없어서, `memory`·`skills`·`update-self`·`home-widgets` 라는 이름의
 *  플러그인이 코어를 통째로 가로챈다. codex·openai 는 `claimToolNames`(먼저 잡은 쪽)라
 *  코어가 이기는데 **claude 만 진다** — 어댑터별로 안전성이 다르면 그건
 *  [[feedback_every_feature_llm_agnostic]] 위반이다.
 *
 * ★그래서 **판단을 여기 하나로** 옮긴다. 세 어댑터가 각자 손으로 하던 것을 한 함수로 모으면
 *  ⓐ 갈리지 않고 ⓑ **회귀가 실제로 돌려볼 수 있다**(어댑터 안에 인라인이면 모델을 띄워야
 *  검사가 된다 — principle-check Q7 의 "검사가 껄끄러우면 코드가 잘못 놓인 것").
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export interface PluginMcpDecision {
  /** 실제로 실을 것. */
  readonly servers: Record<string, McpSdkServerConfigWithInstance>;
  /** 코어와 부딪혀 **떨어뜨린** 이름들. 비어 있지 않으면 로그로 말한다. */
  readonly shadowed: string[];
  /** 왜 비었나 — 진단용. `"ok"` 면 실었다. */
  readonly reason: "ok" | "tools-none" | "out-of-reach" | "empty";
}

/**
 * 이 턴에 실을 플러그인 MCP 를 정한다.
 *
 * @param extra      호출자가 넘긴 플러그인 서버들(`runRegionA` 가 채운다)
 * @param coreKeys   이 어댑터가 이미 쓰고 있는 서버 키들 — **코어가 이긴다**
 * @param toolsNone  `toolPolicy:{mode:"none"}` 인가(분류·엔드포인트·`host.ask` 기본)
 * @param inReach    `reaches("plugins", turnKind)` 결과
 */
export const decidePluginMcp = (
  extra: Record<string, McpSdkServerConfigWithInstance> | undefined,
  coreKeys: readonly string[],
  toolsNone: boolean,
  inReach: boolean,
): PluginMcpDecision => {
  // ★**도구 0 턴엔 안 싣는다.** 이게 "안 다친다" 의 실체다 — 종전엔 어댑터마다 흩어진
  //  `if` 였고 어느 것도 검사되지 않았다.
  if (toolsNone) return { servers: {}, shadowed: [], reason: "tools-none" };
  if (!inReach) return { servers: {}, shadowed: [], reason: "out-of-reach" };
  const entries = Object.entries(extra ?? {});
  if (entries.length === 0) return { servers: {}, shadowed: [], reason: "empty" };

  // ★**코어가 이긴다.** 플러그인 이름을 단속하지 않는 대신(과한 억제 금지), 부딪히면
  //  플러그인 쪽을 떨어뜨리고 **말한다**. 조용히 덮으면 사용자는 메모리·스킬이 왜
  //  사라졌는지 영영 모른다.
  const core = new Set(coreKeys);
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  const shadowed: string[] = [];
  for (const [k, v] of entries) {
    if (core.has(k)) shadowed.push(k);
    else servers[k] = v;
  }
  return { servers, shadowed, reason: "ok" };
};

/** 사람이 읽는 한 줄 — 세 어댑터가 **같은 문장**을 쓴다. */
export const describeShadowed = (plugin: readonly string[]): string =>
  `[plugin-mcp] 코어와 이름이 겹쳐 실지 않았습니다: ${plugin.join(", ")} — ` +
  `플러그인 이름을 바꾸세요(코어 도구가 우선합니다).`;
