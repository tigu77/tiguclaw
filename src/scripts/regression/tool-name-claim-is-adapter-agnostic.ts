/**
 * 회귀: **플러그인이 코어 도구 이름을 뺏는 일이 어댑터마다 다르게 굴지 않는다** (2026-09-10).
 *
 * 사고: 2026-08-28 에 «도구 이름은 먼저 잡은 쪽이 갖는다» 를 만들었는데 **codex 어댑터에만**
 * 반영했다. 같은 플러그인이 어댑터마다 셋 다 다르게 굴렀다(전부 실측):
 *
 *   codex  — 거절 + 경고 + 모델에게 안 보여줌            (부드럽게 막힘)
 *   claude — SDK 가 `mcp__<server>__<tool>` 로 이름공간   (애초에 충돌 불가)
 *   openai — `@openai/agents` 가 **던진다**:
 *            `UserError: Duplicate tool names found across MCP servers`
 *            (agents-core/dist/mcp.js L438·L462, includeServerInToolNames 기본 false)
 *            → 이름 겹치는 플러그인 하나가 **그 턴을 통째로 죽인다**
 *
 * ★외부 검토(Astra, 2026-09-10)가 *"server key 충돌과 tool-name 충돌은 다르다 — 진짜 중복
 *  이름 fixture 가 필요하다"* 고 지적했고, 그 구분을 따라가 이 갭을 찾았다. 그래서 이
 *  검사는 **fixture 로 실제 중복을 만들어** 판정을 돌린다(소스 grep 아님).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "tool-name-claim-is-adapter-agnostic",
  guards:
    "플러그인이 코어 도구 이름(update_self 등)을 내면 codex 는 막고 openai 는 턴이 통째로 " +
    "죽던 것 — 같은 플러그인이 어댑터마다 다른 안전성을 갖던 자리",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { claimToolNames, hideTakenTools, keepClaimed } = await import(
      "../../core/llm-runtime/tool-name-claim.js"
    );

    // ── ① 규칙 자체 — 먼저 잡은 쪽이 갖는다 ─────────────────────────────────
    const taken = new Set<string>(["update_self", "send_file"]);
    const map = { has: (n: string) => taken.has(n), set: (n: string) => taken.add(n) };
    const pluginTools = [{ name: "update_self" }, { name: "weather_now" }, { name: "send_file" }];
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]): void => {
      warned.push(a.map(String).join(" "));
    };
    let claim: { claimed: string[]; rejected: string[] };
    try {
      claim = claimToolNames(map, pluginTools, {}, "weather");
    } finally {
      console.warn = realWarn;
    }
    out.push(
      assert(
        "★★코어 이름은 **뺏기지 않는다** — 플러그인이 `update_self` 를 내도 코어가 그대로 갖는다",
        claim.rejected.includes("update_self") && claim.rejected.includes("send_file"),
        `거절=[${claim.rejected.join(",")}] 획득=[${claim.claimed.join(",")}]`,
      ),
      assert(
        "★안 겹치는 도구는 **정상 등록**된다 — 충돌 하나가 그 플러그인 전체를 죽이면 안 된다",
        claim.claimed.length === 1 && claim.claimed[0] === "weather_now",
        `획득=[${claim.claimed.join(",")}]`,
      ),
      assert(
        "★★조용히 버리지 않는다 — 누가 무엇을 뺏으려 했는지 로그가 말한다(플러그인 작성자는 그걸 봐야 이름을 고친다)",
        warned.some((w) => w.includes("weather") && w.includes("update_self")),
        warned.length === 0 ? "★경고 0건" : warned.join(" | ").slice(0, 130),
      ),
      assert(
        "★거절된 것은 **모델에게 안 보여준다** — 부를 수 없는 도구를 광고하지 않는다",
        keepClaimed(pluginTools, claim.claimed).length === 1,
        `노출=${JSON.stringify(keepClaimed(pluginTools, claim.claimed))}`,
      ),
    );

    // ── ② openai 경로 — SDK 가 보기 **전에** 우리가 고른다 ──────────────────
    //  이 SDK 는 이름이 겹치면 던지므로, 래퍼가 listTools 에서 미리 빼야 한다.
    const fake = {
      name: "weather",
      listTools: async (): Promise<unknown[]> => pluginTools,
    };
    const hidden = hideTakenTools(fake, new Set(claim.rejected));
    const shown = (await hidden.listTools()).map((t) => (t as { name: string }).name);
    out.push(
      assert(
        "★★래퍼가 겹치는 이름을 **SDK 에 넘기기 전에** 뺀다 — @openai/agents 는 중복을 보면 `UserError` 로 던져 그 턴을 통째로 죽인다",
        shown.length === 1 && shown[0] === "weather_now",
        `SDK 가 보게 될 목록=[${shown.join(",")}]`,
      ),
      assert(
        "★래퍼는 `listTools` 만 덮는다 — 이름·callTool 은 원본 그대로(래핑이 다른 걸 바꾸면 안 된다)",
        hidden.name === "weather" && Object.keys(hidden).length === Object.keys(fake).length,
        `name=${hidden.name} · 키=${Object.keys(hidden).join(",")}`,
      ),
    );

    // ── ③ 세 어댑터가 **같은 판정**을 쓴다 ───────────────────────────────────
    const codex = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    const openai = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-agents-sdk.ts"),
    );
    // ★claude 는 **SDK 성질**이라 우리 소스로는 못 잰다 — `mcp__` 접두사는 SDK 가 붙이지
    //  우리가 쓰지 않는다(첫 판은 주석을 벗기고 세서 빨간불이 났다: 코드가 아니라 검사가
    //  틀린 것이었다). 잴 수 있는 것으로 바꾼다: **그 이유가 규칙이 사는 자리에 적혀 있나.**
    //  다음 검토가 «claude 에 선점이 없다» 를 갭으로 다시 올리지 않게 하는 게 목적이다.
    const rule = readSourceSync("src/core/llm-runtime/tool-name-claim.ts");
    out.push(
      assert(
        "★★codex·openai 가 **같은 함수**를 부른다 — 판정을 두 벌 만들면 언젠가 갈린다(그게 이 결함의 출처다)",
        /claimToolNames\(/.test(codex) && /claimToolNames\(/.test(openai),
        `codex=${/claimToolNames\(/.test(codex)} · openai=${/claimToolNames\(/.test(openai)}`,
      ),
      assert(
        "★claude 에 선점이 **없는 이유**가 규칙 옆에 적혀 있다 — SDK 가 `mcp__<server>__<tool>` 로 이름공간을 주므로 불필요하다. 안 적어 두면 다음 검토가 이걸 갭으로 다시 올린다(실제로 내가 그랬다)",
        /claude/.test(rule) && /mcp__/.test(rule),
        (() => {
          const i = rule.indexOf("mcp__");
          return i < 0 ? "★설명 없음" : rule.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, " ");
        })(),
      ),
    );

    return out;
  },
};
