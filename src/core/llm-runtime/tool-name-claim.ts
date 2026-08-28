// src/core/llm-runtime/tool-name-claim.ts
/**
 * **도구 이름은 먼저 잡은 쪽이 갖는다** — 늦게 온 것이 코어를 덮지 못하게 (2026-08-28).
 *
 * ★정태님: *"플러그인 도구 이름이 겹치거나 하진 않아?"* — 겹쳤고, **충돌이 아니라
 *  가로채기**였다. codex·openai 어댑터는 모든 도구를 **접두사 없이 한 맵**에 담는데
 *  (`toolBridgeMap.set(name, bridge)`), 플러그인·외부 MCP 가 **코어보다 나중**에 담긴다.
 *  그래서 플러그인이 `update_self` 나 `send_file` 이라는 이름을 내면 모델이 그 이름을
 *  부를 때 **플러그인 핸들러가 돈다.** 조용히.
 *
 * ★claude 어댑터는 SDK 가 `mcp__<server>__<tool>` 로 이름공간을 줘서 이 문제가 없다 —
 *  즉 **같은 플러그인이 어댑터마다 다른 안전성**을 갖고 있었다. 그건 "모든 기능 LLM
 *  무관" 이 깨진 자리다.
 *
 * ★고침은 이름공간을 새로 만드는 게 아니라 **선점 규칙**이다. 이름을 바꾸면 모델이 아는
 *  도구 이름이 어댑터마다 또 갈리고(그게 원래 문제다), 기존 플러그인도 전부 깨진다.
 *  *"먼저 잡은 쪽이 갖는다"* 는 코어를 먼저 담는 현행 순서만으로 코어를 지킨다.
 *
 * ★**조용히 버리지 않는다.** 거절할 때 누가 무엇을 뺏으려 했는지 로그에 남긴다 —
 *  플러그인 작성자는 그걸 봐야 이름을 고친다([[feedback_logs_must_stand_alone]]).
 */

/** 도구 이름 → 그걸 처리할 브리지. 어댑터가 들고 있는 맵의 최소 면. */
export type ToolClaimMap = { has(name: string): boolean; set(name: string, v: unknown): unknown };

export interface ToolClaimResult {
  /** 실제로 잡은 이름들(모델에게 낼 것). */
  readonly claimed: string[];
  /** 이미 있어서 거절한 이름들. */
  readonly rejected: string[];
}

/**
 * `tools` 중 **아직 안 잡힌 이름만** 맵에 넣는다.
 *
 * @param owner 로그에 찍을 주인(플러그인 이름·외부 MCP 서버명).
 */
export const claimToolNames = (
  map: ToolClaimMap,
  tools: readonly unknown[],
  bridge: unknown,
  owner: string,
): ToolClaimResult => {
  const claimed: string[] = [];
  const rejected: string[] = [];
  for (const t of tools) {
    const name = (t as { name?: unknown }).name;
    if (typeof name !== "string" || name === "") continue;
    if (map.has(name)) {
      rejected.push(name);
      continue;
    }
    map.set(name, bridge);
    claimed.push(name);
  }
  if (rejected.length > 0) {
    console.warn(
      `[tools] '${owner}' 의 도구 ${rejected.length}개가 이미 쓰이는 이름이라 **거절**했습니다: ` +
        `${rejected.join(", ")}. 이름을 바꾸세요(예: '${owner}_<동작>'). ` +
        `먼저 잡은 쪽이 갖습니다 — 코어 도구를 덮을 수 없습니다.`,
    );
  }
  return { claimed, rejected };
};

/** 거절된 것을 뺀 도구 목록 — 모델에게 **잡은 것만** 보여준다(부를 수 없는 걸 광고하지 않게). */
export const keepClaimed = <T>(tools: readonly T[], claimed: readonly string[]): T[] =>
  tools.filter((t) => claimed.includes(String((t as { name?: unknown }).name ?? "")));
