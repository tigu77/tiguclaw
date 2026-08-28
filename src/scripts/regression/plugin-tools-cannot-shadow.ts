/**
 * 회귀: **플러그인 도구가 코어 도구를 가로채지 못한다** (2026-08-28).
 *
 * ★정태님: *"플러그인 도구 이름이 겹치거나 하진 않아?"* — 겹쳤고, **충돌이 아니라
 *  가로채기**였다. codex 어댑터는 모든 도구를 **접두사 없이 한 맵**에 담는데
 *  (`toolBridgeMap.set(name, bridge)`), 담는 순서가 **코어 → 외부 MCP → 플러그인** 이다.
 *  `Map.set` 은 덮어쓰므로, 플러그인이 `update_self`·`send_file` 이라는 이름을 내면
 *  모델이 그 이름을 부를 때 **플러그인 핸들러가 돌았다.** 조용히.
 *
 * ★claude 어댑터는 SDK 가 `mcp__<server>__<tool>` 로 이름공간을 줘서 이 문제가 없다 —
 *  즉 **같은 플러그인이 어댑터마다 다른 안전성**을 갖고 있었다.
 *
 * ★고침은 이름공간 신설이 아니라 **선점 규칙**이다(`claimToolNames`). 이름을 바꾸면 모델이
 *  아는 도구 이름이 어댑터마다 또 갈리고 기존 플러그인도 깨진다. *"먼저 잡은 쪽이 갖는다"*
 *  는 코어를 먼저 담는 현행 순서만으로 코어를 지킨다.
 *
 * ★**정직한 범위**: `openai-agents-sdk` 는 평평한 맵이 아니라 SDK 에 서버를 넘기고 디스패치를
 *  SDK 가 한다 — 같은 기제가 아니라 여기서 검사하지 않는다(안 본 것을 봤다고 하지 않는다).
 *
 * 등급: **동작 검사** — 판정을 실제로 부른다. 배선(어댑터가 그 판정을 쓰나)만 소스 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimToolNames, keepClaimed } from "../../core/llm-runtime/tool-name-claim.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "plugin-tools-cannot-shadow",
  guards:
    "플러그인·외부 MCP 가 코어와 같은 도구 이름을 내면 조용히 덮어써서, 모델이 update_self 를 불러도 플러그인 핸들러가 돌던 것(충돌이 아니라 가로채기) + 그게 어댑터마다 달라 같은 플러그인의 안전성이 갈리던 것",
  run: async (): Promise<Assertion[]> => {
    // ── ① 선점 규칙 — 실제로 부른다 ──
    const map = new Map<string, unknown>();
    const CORE = [{ name: "update_self" }, { name: "send_file" }, { name: "spawn_agent" }];
    claimToolNames(map, CORE, "CORE", "core");

    const plug = [{ name: "update_self" }, { name: "weather_lookup" }, { name: "send_file" }];
    const r = claimToolNames(map, plug, "PLUGIN", "weather");
    const visible = keepClaimed(plug, r.claimed).map((t) => t.name);

    // 두 플러그인끼리도 — 먼저 온 쪽이 갖는다.
    const map2 = new Map<string, unknown>();
    claimToolNames(map2, [{ name: "search" }], "A", "alpha");
    const b = claimToolNames(map2, [{ name: "search" }], "B", "beta");

    const codex = readFileSync(
      path.join(REPO, "src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
      "utf8",
    );
    // ★플러그인·외부 MCP 자리에 **맨 `set` 이 남아 있지 않다** — 남아 있으면 그 경로로 샌다.
    const rawSetAtPluginSite =
      /extraToolsRaw\)[\s\S]{0,200}?toolBridgeMap\.set\(/.test(codex) ||
      /extToolsRaw\)[\s\S]{0,200}?toolBridgeMap\.set\(/.test(codex);

    return [
      assert(
        "★★코어 도구를 **못 덮는다**(플러그인이 `update_self` 를 내도 코어 핸들러가 남는다 — 이건 충돌이 아니라 가로채기다)",
        map.get("update_self") === "CORE" && map.get("send_file") === "CORE",
        `update_self=${String(map.get("update_self"))} · send_file=${String(map.get("send_file"))}`,
      ),
      assert(
        "★겹치지 않는 이름은 **정상으로 잡힌다**(과잉 차단 금지 — 플러그인 생태가 죽는다)",
        map.get("weather_lookup") === "PLUGIN" && r.claimed.includes("weather_lookup"),
        `weather_lookup=${String(map.get("weather_lookup"))}`,
      ),
      assert(
        "★★거절된 도구를 **모델에게 안 보여준다**(부를 수 없는 걸 광고하면 모델이 헛돈다)",
        visible.length === 1 && visible[0] === "weather_lookup",
        `보이는 것: ${visible.join(", ") || "(없음)"}`,
      ),
      assert(
        "★**조용히 안 버린다** — 무엇이 거절됐는지 돌려준다(작성자가 그걸 봐야 고친다)",
        r.rejected.length === 2 &&
          r.rejected.includes("update_self") &&
          r.rejected.includes("send_file"),
        r.rejected.join(", ") || "★조용히 버림",
      ),
      assert(
        "★플러그인끼리도 **먼저 온 쪽이 갖는다**(늦게 온 것이 앞의 것을 못 뺏는다)",
        map2.get("search") === "A" && b.rejected.includes("search"),
        `search=${String(map2.get("search"))} · beta 거절=${b.rejected.join(",")}`,
      ),
      // ── ② 배선 ──
      assert(
        "★★어댑터가 그 판정을 쓴다 — 플러그인·외부 MCP 자리에 맨 `set` 이 없다(남아 있으면 그 경로로 샌다)",
        /claimToolNames\(toolBridgeMap, extraToolsRaw, extraBridge, name\)/.test(codex) &&
          /claimToolNames\(toolBridgeMap, extToolsRaw, extBridge, "external-mcp"\)/.test(codex) &&
          !rawSetAtPluginSite,
        `플러그인=${/claimToolNames\(toolBridgeMap, extraToolsRaw/.test(codex)} · 외부MCP=${/claimToolNames\(toolBridgeMap, extToolsRaw/.test(codex)} · 맨set잔존=${rawSetAtPluginSite}`,
      ),
      assert(
        "★코어 도구는 **여전히 먼저** 담긴다(선점 규칙은 순서에 기댄다 — 뒤집히면 규칙이 무력해진다)",
        codex.indexOf("toolBridgeMap.set((t as { name: string }).name, memoryBridge)") <
          codex.indexOf("claimToolNames(toolBridgeMap, extraToolsRaw"),
        `코어 먼저=${codex.indexOf("memoryBridge)") < codex.indexOf("claimToolNames(toolBridgeMap, extraToolsRaw")}`,
      ),
    ];
  },
};
