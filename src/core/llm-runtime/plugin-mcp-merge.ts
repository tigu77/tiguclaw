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
 * ★그래서 **판단을 함수로** 뽑았다 — 어댑터 안에 인라인이면 검사하려고 모델을 띄워야 하고,
 *  그러면 회귀가 약해진다(principle-check Q7).
 *
 * ★**지금 이걸 쓰는 것은 claude 하나다** (2026-08-29, 2라운드 G-4 정정). 처음엔 이 머리말이
 *  *"세 어댑터가 같은 것을 쓴다"* 고 적었는데 **거짓이었다** — codex 는 `!toolsNone` 블록 +
 *  `claimToolNames` 로 자기 방식으로 지키고, **openai 는 코어 이름을 안 지킨다**(SDK 가
 *  중복 도구 이름에 `UserError` 를 던져 턴 전체가 죽는다). 세 어댑터의 안전성은 아직
 *  다르고, 그 사실을 여기 적어두는 게 맞다([[project_openai_adapter_parity]]: 헤더가 거짓인
 *  부류를 이 레포는 이미 겪었다).
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

/** 사람이 읽는 한 줄. */
export const describeShadowed = (plugin: readonly string[]): string =>
  `[plugin-mcp] 코어와 이름이 겹쳐 실지 않았습니다: ${plugin.join(", ")} — ` +
  `플러그인 이름을 바꾸세요(코어 도구가 우선합니다).`;

/**
 * 충돌 경고 — **좌표당 한 번만**. 매 턴 찍으면 배경 소음이 되고, 그러면 진짜일 때 아무도
 * 안 본다([[feedback_logs_must_stand_alone]]). 이 레포엔 이미 같은 관용구가 있다
 * (`threadkey.ts` 의 `warnBindingLookupOnce`).
 */
const warned = new Set<string>();
export const warnShadowedOnce = (plugin: readonly string[]): void => {
  const key = [...plugin].sort().join(",");
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(describeShadowed(plugin));
};

/**
 * **이번 턴에 실제로 서는 MCP 서버 맵과 그 이름들** — 한 곳에서 낸다.
 *
 * ★어댑터 안에 흩어져 있던 조립을 여기로 뺐다 (2026-08-30). 3라운드 적대 검토가 심은
 *  변이 셋이 **살아남은 자리**가 정확히 여기였다:
 *
 *  - **M5** `coreKeys` 에서 lean 을 빼기 → 플러그인이 코어 도구 이름을 덮는다
 *  - **M7** 병합 지점에서 플러그인을 지우기 → 도구가 조용히 사라진다
 *  - **M26** 활성 목록에서 외부 MCP 를 빼기 → `find_capabilities` 가 거짓 목록을 광고한다
 *
 *  셋 다 어댑터 지역 변수 사이의 **스프레드 한 줄**이라, 검사가 소스를 grep 하는 것 말고는
 *  할 게 없었다(그래서 변이가 살았다). 순수 함수로 나오면 **실행해서** 잡을 수 있다
 *  ([[feedback_simple_composable_no_duplication]] — 검사가 껄끄러우면 코드가 잘못 놓인 것).
 *
 * ★**활성 이름이 같은 계산에서 나온다**는 게 요점이다. 종전엔 서버 맵과 `find_capabilities`
 *  가 볼 목록이 **두 번** 조립됐고, 한쪽만 고치면 *"광고는 하는데 없는 도구"* 가 된다.
 */
export const assembleMcpServers = <T>(args: {
  /** 코어 서버들(이번 턴 lean 여부가 이미 반영된 것). */
  /** 코어 서버들 — SDK 인스턴스형·stdio형이 섞인다(어댑터의 실제 맵 타입 그대로). */
  readonly lean: Readonly<Record<string, T>>;
  /** 최종 리터럴에서 **플러그인 뒤에** 붙는 코어 키들 — 이름이 겹치면 플러그인이 진다. */
  readonly lateCoreKeys: readonly string[];
  /** 플러그인·외부에서 온 것(미판정). */
  readonly extra: Record<string, McpSdkServerConfigWithInstance> | undefined;
  /** 외부 MCP(`mcp.json`) — 이번 턴에 실제로 연결된 것만. */
  readonly external: Readonly<Record<string, unknown>>;
  readonly toolsNone: boolean;
  readonly inReach: boolean;
}): {
  servers: Record<string, T>;
  activeNames: string[];
  shadowed: string[];
  reason: string;
} => {
  const decided = decidePluginMcp(
    args.extra,
    [...Object.keys(args.lean), ...args.lateCoreKeys],
    args.toolsNone,
    args.inReach,
  );
  // ★`decidePluginMcp` 는 **키만** 본다(어느 것을 실을지). 그래서 값 타입을 좁히지 않고
  //  여기서만 어댑터의 맵 타입으로 되돌린다 — 판정은 이름의 문제이지 값의 문제가 아니다.
  const servers: Record<string, T> = {
    ...args.lean,
    ...(decided.servers as unknown as Record<string, T>),
  };
  return {
    servers,
    // ★같은 계산에서 낸다 — 두 번 조립하면 광고와 실물이 갈린다.
    activeNames: Object.keys({ ...servers, ...args.external }),
    shadowed: decided.shadowed,
    reason: decided.reason,
  };
};
