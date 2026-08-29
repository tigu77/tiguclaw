/**
 * 회귀: **플러그인 MCP 를 실을까, 그리고 부딪히면 누가 이기나** (2026-08-29).
 *
 * ★적대 검토 B 가 실측으로 둘을 깼다.
 *
 *  **① 안전 논거에 강제가 0이었다.** *"도구가 없어야 하는 턴(`toolPolicy:none`)은 안
 *  다친다"* 가 `runRegionA` 기본 채우기의 유일한 근거였는데, 종전 회귀는 어댑터 파일에
 *  `toolPolicy?.mode === "none"` 이라는 **글자가 있는지**만 봤다. 세 어댑터 전부
 *  `toolsNone` 갈래에 플러그인을 주입해도 **스위트가 초록**이었다(실측 2,287건).
 *
 *  **② claude 에서 플러그인이 코어를 덮었다.** 스프레드가 마지막이라 `memory`·`skills`·
 *  `update-self` 라는 이름의 플러그인이 코어를 가로챈다. codex·openai 는 `claimToolNames`
 *  로 코어가 이기는데 claude 만 졌다 — 어댑터별로 안전성이 다르면
 *  [[feedback_every_feature_llm_agnostic]] 위반이다.
 *
 * ★그래서 판정을 `plugin-mcp-merge.ts` 한 곳으로 옮겼고, 이 검사는 **그걸 실제로 돌린다.**
 *  글자를 찾는 검사로는 이 성질을 못 지킨다는 게 위에서 실측으로 증명됐다.
 *
 * 지키는 것 넷:
 *  ① `toolsNone` 이면 **안 싣는다**(분류·webfetch 추출·엔드포인트·`host.ask` 기본).
 *  ② reach 밖이면 안 싣는다.
 *  ③ ★**코어가 이긴다** — 이름이 겹치면 플러그인 쪽을 떨어뜨린다.
 *  ④ ★**조용히 떨어뜨리지 않는다** — 사용자는 메모리·스킬이 왜 사라졌는지 알아야 한다.
 *
 * 등급: ①~④ 전부 **동작**(순수 함수 실행). 어댑터가 그 판정을 실제로 쓰는지는 배선 대조 —
 * 어댑터는 모델 없이 못 태운다. 그 한계를 여기 적어둔다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decidePluginMcp, describeShadowed } from "../../core/llm-runtime/plugin-mcp-merge.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const S = (...names: string[]): Record<string, never> =>
  Object.fromEntries(names.map((n) => [n, {} as never]));

export const check: RegressionCheck = {
  name: "plugin-mcp-merge-is-safe",
  guards:
    "runRegionA 가 모든 턴에 플러그인 MCP 를 채우게 된 뒤, 도구가 없어야 하는 턴(분류·webfetch·엔드포인트·host.ask 기본)까지 플러그인 도구를 받는 것 — 그 안전 논거를 종전엔 '어댑터 파일에 toolsNone 이라는 글자가 있나' 로만 지켜서 세 어댑터 전부 뚫려도 초록이었다 + 같은 이름의 플러그인이 코어 MCP 서버(memory·skills·update-self)를 통째로 가로채는 것(claude 만 그랬다 = 어댑터별로 안전성이 다름)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const CORE = ["memory", "skills", "update-self", "home-widgets"];

    // ── ① 도구 0 턴엔 안 싣는다 ────────────────────────────────────────────
    const none = decidePluginMcp(S("weather", "map"), CORE, true, true);
    out.push(
      assert(
        "★★`toolPolicy:none` 턴엔 플러그인 MCP 를 **안 싣는다** — 분류·webfetch 추출·엔드포인트·`host.ask` 기본이 그 부류다. 이게 *모든 턴에 채운다* 는 변경의 유일한 안전 논거이고, 종전엔 이걸 지키는 것이 **아무것도 없었다**(세 어댑터 전부 뚫려도 초록)",
        Object.keys(none.servers).length === 0 && none.reason === "tools-none",
        `실린 것 ${String(Object.keys(none.servers).length)}개 · 사유=${none.reason}`,
      ),
    );

    // ── ② reach 밖 ─────────────────────────────────────────────────────────
    const off = decidePluginMcp(S("weather"), CORE, false, false);
    out.push(
      assert(
        "reach 밖이면 안 싣는다 — `REACH.plugins` 를 좁히면 실제로 좁아진다(선언이 장식이 아니다)",
        Object.keys(off.servers).length === 0 && off.reason === "out-of-reach",
        `실린 것 ${String(Object.keys(off.servers).length)}개 · 사유=${off.reason}`,
      ),
    );

    // ── ③ 코어가 이긴다 ────────────────────────────────────────────────────
    const clash = decidePluginMcp(S("memory", "weather", "update-self"), CORE, false, true);
    out.push(
      assert(
        "★★이름이 겹치면 **코어가 이긴다** — 종전 claude 는 플러그인 스프레드가 마지막이라 `memory` 라는 이름의 플러그인이 메모리 도구를 통째로 가로챘다(codex·openai 는 코어가 이겨서 **어댑터별로 안전성이 달랐다**)",
        Object.keys(clash.servers).join(",") === "weather" &&
          clash.shadowed.sort().join(",") === "memory,update-self",
        `실림 [${Object.keys(clash.servers).join(", ")}] · 떨어뜨림 [${clash.shadowed.join(", ")}]`,
      ),
    );

    // ── ④ 조용히 떨어뜨리지 않는다 ──────────────────────────────────────────
    const msg = describeShadowed(clash.shadowed);
    out.push(
      assert(
        "★★떨어뜨렸으면 **말한다** — 조용히 덮거나 조용히 버리면 사용자는 메모리·스킬이 왜 사라졌는지(혹은 자기 플러그인이 왜 안 도는지) 영영 모른다",
        msg.includes("memory") && msg.includes("이름을 바꾸세요"),
        msg.slice(0, 70),
      ),
    );

    // ── 정상 경로 ──────────────────────────────────────────────────────────
    const okd = decidePluginMcp(S("weather", "map"), CORE, false, true);
    const empty = decidePluginMcp(undefined, CORE, false, true);
    out.push(
      assert(
        "부딪히지 않으면 그대로 싣고, 없으면 빈 채로 둔다(사유를 구분해 남긴다)",
        Object.keys(okd.servers).length === 2 &&
          okd.reason === "ok" &&
          empty.reason === "empty",
        `정상 ${String(Object.keys(okd.servers).length)}개(${okd.reason}) · 미제공=${empty.reason}`,
      ),
    );

    // ── 세 어댑터가 **그 판정을 쓴다** (배선 대조 — 등급 명시) ───────────────
    const adapters: Array<[string, string]> = [
      ["claude", "src/core/llm-runtime/adapters/claude-agent-sdk.ts"],
      ["codex", "src/core/llm-runtime/adapters/openai-codex-oauth.ts"],
      ["openai", "src/core/llm-runtime/adapters/openai-agents-sdk.ts"],
    ];
    const unguarded: string[] = [];
    for (const [label, rel] of adapters) {
      const src = readFileSync(path.join(REPO, rel), "utf8");
      if (!src.includes("extraMcpServers")) continue;
      // 판정을 쓰거나(claude), 자기 방식으로 **둘 다** 지키거나(codex·openai:
      // `!toolsNone` 블록 + `claimToolNames`/명시 게이트).
      const usesShared = src.includes("decidePluginMcp");
      const ownGuard =
        /if \(!toolsNone\)/.test(src) &&
        (src.includes("claimToolNames") || /!toolsNone && reaches\("plugins"/.test(src));
      if (!usesShared && !ownGuard) unguarded.push(label);
    }
    // ★**단언문을 검사까지로 좁혔다** (2026-08-29, 2라운드 P-5). 종전엔 *"세 어댑터가 전부
    //  코어를 지킨다"* 고 적었는데 **거짓이었다** — openai 는 `claimToolNames` 를 안 쓰고,
    //  SDK 가 중복 도구 이름에 `UserError` 를 던져 **턴 전체가 죽는다**(`@openai/agents-core`
    //  `mcp.js` 확인). 검사가 실제로 보는 건 *"도구 0 턴을 막는가"* 뿐이므로 그렇게만 적는다.
    //  코어 이름 보호의 어댑터별 비대칭은 백로그다([[project_openai_adapter_parity]]).
    out.push(
      assert(
        "★세 어댑터가 전부 **도구 0 턴에 플러그인을 안 싣는다**(공용 판정을 쓰거나 자기 `!toolsNone` 가드로) — 하나라도 빠지면 분류·엔드포인트 턴이 그 백엔드에서만 플러그인 도구를 받는다. ★코어 **이름** 보호는 어댑터마다 다르다(claude=떨어뜨림 · codex=먼저 잡은 쪽 · openai=미보호) — 이 단언은 거기까진 말하지 않는다",
        unguarded.length === 0,
        unguarded.length === 0 ? "claude=공용판정 · codex/openai=자기 가드" : `★무방비: ${unguarded.join(", ")}`,
      ),
    );

    return out;
  },
};
