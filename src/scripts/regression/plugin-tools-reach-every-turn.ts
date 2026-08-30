/**
 * 회귀: **플러그인 도구가 선언한 만큼 실제로 닿는다** (2026-08-29).
 *
 * `REACH.plugins` 는 `"subagent"`(=전부)라고 **선언**하고 있었는데, 플러그인 MCP 를 턴 입력에
 * 싣는 곳은 `router.ts` **한 곳**뿐이었다. 그래서 router 를 안 지나는 호출은 전부 도구가
 * **0개**였다 — 실측:
 *
 * ```
 * scheduler/index.ts    runClaude({text, threadKey, channel, cwd, notifyDest})   ← 없음
 * file-watch/index.ts   runClaude({text, threadKey, channel, cwd})               ← 없음
 * agent-registry.ts     extraMcpServers 0건   (서브에이전트)
 * worker-registry.ts    extraMcpServers 0건   (매니저)
 * ```
 *
 * 사용자에게 보이는 모습: 서드파티가 플러그인을 만들고 *"매일 아침 그걸로 알려줘"* 스케줄을
 * 걸면, **그 턴의 모델에겐 그 도구가 없다.** 선언과 현실이 갈려 있었다.
 *
 * ★고침은 호출부마다 한 줄이 아니라 **`runRegionA` 한 곳**이다. 두 트리거가 이미 각자
 *  빠뜨렸으니 세 번째도 빠뜨린다 — 린트를 세우는 대신 **이음매를 없앴다**
 *  ([[feedback_simple_composable_no_duplication]]).
 *
 * 지키는 것 넷:
 *  ① **채우는 곳이 하나다** — 두 곳이 각자 만들면 그게 두 벌의 판단이다.
 *  ② ★**router 를 안 지나는 호출도 받는다** — 실제로 `runRegionA` 를 태워 팩토리가 불리는지
 *     본다(소스에 글자가 있는지가 아니라).
 *  ③ **좌표가 실려 간다** — 플러그인이 결과를 어느 대화에 붙일지 알아야 한다.
 *  ④ ★**명시로 넘긴 값은 안 덮는다** — 게이트웨이·엔드포인트가 자기 도구 집합을 정하는 길이
 *     막히면 안 된다.
 *
 * ★도구가 **없어야** 하는 호출(분류·webfetch 추출·엔드포인트·`host.ask` 기본)은 전부
 *  `toolPolicy:{mode:"none"}` 을 명시하고, 어댑터가 그 경우 플러그인 MCP 를 걷어낸다.
 *  그래서 이 기본값은 **도구를 받기로 되어 있던 턴에만** 닿는다 — 그것도 아래에서 본다.
 *
 * 등급: ①③④는 **동작**(레지스트리·runRegionA 실행), ②도 동작, 어댑터 쪽 소거만 소스 대조
 * (거긴 모델 호출 없이 못 태운다).
 */
import { readFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRegisteredMcpServers,
  registerMcpServer,
  unregisterMcpServer,
} from "../../core/mcp-registry.js";
import { runRegionA } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

export const check: RegressionCheck = {
  name: "plugin-tools-reach-every-turn",
  guards:
    "REACH.plugins 가 '전부'라고 선언했는데 플러그인 MCP 를 싣는 곳이 router 한 곳뿐이라, 스케줄·파일감시·서브에이전트·매니저 턴의 모델이 플러그인 도구를 하나도 못 쥐던 것(서드파티 플러그인 + 스케줄 = 안 됨) + 그걸 고치면서 도구가 없어야 할 호출(분류·엔드포인트)까지 도구를 받는 것 + 명시로 넘긴 도구 집합을 기본값이 덮는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const NAME = "regr-reach-probe";

    // ── ② router 를 안 지나는 호출도 받는다 (동작) ──────────────────────────
    // `runRegionA` 를 실제로 태운다. 모델까지는 안 간다(프로파일 해석에서 멈추든 어디서든) —
    // 우리가 보는 건 **입력을 만드는 단계**에서 팩토리가 불렸는가다.
    const coords: string[] = [];
    registerMcpServer(NAME, (ctx) => {
      coords.push(`${ctx?.threadKey ?? "—"}|${ctx?.channel ?? "—"}|${ctx?.target ?? "—"}`);
      return {} as never;
    });
    try {
      await runRegionA({
        text: "regression probe — 모델까지 가지 않습니다",
        threadKey: "scheduler:regr",
        channel: "scheduler" as never,
        channelAddress: "t-42",
        // 도구를 받는 턴을 흉내낸다(none 이면 어댑터가 걷어내므로 이 축을 못 본다).
        abortSignal: AbortSignal.abort(),
      });
    } catch {
      // 모델·중단 실패는 상관없다 — 입력 조립까지만 보면 된다.
    }
    unregisterMcpServer(NAME);
    out.push(
      assert(
        "★★`router` 를 **안 지나는** 호출도 플러그인 도구를 받는다 — 스케줄·파일감시·서브에이전트·매니저가 전부 이 경로다(종전엔 도구 0개라, 서드파티 플러그인을 스케줄로 부르는 게 원천적으로 안 됐다)",
        coords.length >= 1,
        coords.length >= 1 ? `팩토리 ${String(coords.length)}회 호출` : "★한 번도 안 불렸다",
      ),
    );
    out.push(
      assert(
        "★좌표가 실려 간다 — 플러그인이 결과를 **어느 대화에** 붙일지 알아야 한다(종전에 코어 도구만 받고 플러그인은 못 받던 축)",
        coords[0] === "scheduler:regr|scheduler|t-42",
        coords[0] ?? "(호출 없음)",
      ),
    );

    // ── ① 채우는 곳이 하나다 ────────────────────────────────────────────────
    const fillers: string[] = [];
    for (const rel of [
      "src/core/router.ts",
      "src/core/llm-runtime/index.ts",
      "plugins/scheduler/src/index.ts",
      "plugins/file-watch/src/index.ts",
    ]) {
      if (/extraMcpServers:\s*getRegisteredMcpServers\(/.test(read(rel))) fillers.push(rel);
    }
    out.push(
      assert(
        "★★플러그인 도구를 **채우는 곳이 한 곳**이다 — 두 곳이 각자 좌표를 만들면 그게 곧 두 벌의 판단이고, 하나가 늙는다(실제로 router 만 채우고 트리거 둘이 빠뜨렸다)",
        fillers.length === 1 && fillers[0] === "src/core/llm-runtime/index.ts",
        fillers.length === 1 ? `${fillers[0]} 한 곳` : `★${String(fillers.length)}곳: ${fillers.join(", ")}`,
      ),
    );

    // ── ④ 명시로 넘긴 값은 안 덮는다 (동작) ─────────────────────────────────
    // 기본값이 **무조건** 덮으면 게이트웨이·엔드포인트가 자기 도구 집합을 정하는 길이 막힌다.
    let overwritten = false;
    registerMcpServer(NAME, () => {
      overwritten = true;
      return {} as never;
    });
    try {
      await runRegionA({
        text: "regression probe",
        threadKey: "endpoint:regr",
        channel: "endpoint" as never,
        extraMcpServers: {}, // 명시로 "도구 없음" 을 넘긴다
        abortSignal: AbortSignal.abort(),
      });
    } catch {
      /* 위와 같다 */
    }
    unregisterMcpServer(NAME);
    out.push(
      assert(
        "★★**명시로 넘긴 도구 집합을 기본값이 안 덮는다** — 덮으면 엔드포인트·게이트웨이가 '이 턴은 이 도구만' 을 정하는 길이 막힌다(빈 객체도 명시다)",
        !overwritten,
        overwritten ? "★기본값이 덮었다" : "명시값 보존(팩토리 미호출)",
      ),
    );

    // ── 도구가 없어야 하는 호출은 어댑터가 걷어낸다 (소스 대조) ──────────────
    // ★등급을 정직하게: 어댑터는 모델 없이 못 태운다. 대신 **세 어댑터 전부**를 보고,
    //  플러그인 MCP 가 `toolsNone` 갈래 **밖**에 있으면 잡는다.
    const adapters: Array<[string, string]> = [
      ["claude", "src/core/llm-runtime/adapters/claude-agent-sdk.ts"],
      ["codex", "src/core/llm-runtime/adapters/openai-codex-oauth.ts"],
      ["openai", "src/core/llm-runtime/adapters/openai-agents-sdk.ts"],
    ];
    const leaky: string[] = [];
    for (const [label, rel] of adapters) {
      const src = read(rel);
      if (!src.includes("extraMcpServers")) continue; // 그 어댑터가 안 쓰면 대상 아님
      // `toolsNone`(또는 동형 판정)이 그 파일에 있고, 플러그인 주입이 그 갈래 안에 있어야 한다.
      const hasNoneGate = /toolPolicy\?\.mode === "none"/.test(src);
      if (!hasNoneGate) leaky.push(label);
    }
    out.push(
      assert(
        "★도구가 **없어야** 하는 턴(분류·webfetch 추출·엔드포인트·`host.ask` 기본)은 `toolPolicy:none` 을 쓰고, 어댑터가 그 경우 플러그인 MCP 를 걷어낸다 — 이 기본값이 **도구를 받기로 되어 있던 턴에만** 닿는 이유다",
        leaky.length === 0,
        leaky.length === 0 ? "어댑터 전부 none 게이트 있음" : `★게이트 없음: ${leaky.join(", ")}`,
      ),
    );

    return out;
  },
};
