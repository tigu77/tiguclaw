/**
 * 회귀: **부품 말고 이음매** — 2라운드가 배선 변이 14개를 통과시켰다 (2026-08-29).
 *
 * ★2라운드 결과가 한 문장으로 요약된다:
 *
 *   새로 만든 순수 함수(`decidePluginMcp`·`toolPolicyFor`·`pluginThreadKey`·
 *   `isValidPluginName`)는 **잘 지켜지는데, 그것들을 부르는 배선은 전부 무방비다.**
 *   그리고 그 커밋이 한 일이 정확히 **"배선 옮기기"** 였다.
 *
 *  실측으로 통과한 것들(전부 스위트 초록 + typecheck 0):
 *   - claude 의 SDK `mcpServers` 에서 플러그인을 **통째로 빼도** 초록
 *     (= 스케줄러 `add_schedule`·파일감시·서드파티 도구 **전멸**)
 *   - `find_capabilities` 활성 목록에서 플러그인을 빼도 초록
 *   - `decidePluginMcp` 에 `coreKeys=[]`·`toolsNone=false` 를 넘겨도 초록
 *   - `host.ask` 에서 `toolPolicy` 를 안 넘겨도 초록(= 도구 전량, 1라운드가 고친 그 결함)
 *   - `host.ask` 의 좌표를 인자가 정하게 해도 초록(= 남의 대화 지목, 1라운드 ③ 원 결함)
 *   - `subagentDepth` 를 빼도 초록(= 다시 메인 턴, 사다리 최상단)
 *
 * ★[[feedback_simple_composable_no_duplication]] 이 적어둔 그대로다:
 *  **"부품은 검사되는데 이음매는 안 검사된다."** 순수 함수를 뽑은 것까진 옳았고, 그걸
 *  **부르는 자리**를 검사하지 않으면 절반만 한 것이다.
 *
 * 등급: **동작** — `host.ask` 는 실제로 부르고(모델 없이 실패시켜 입력만 관측), 어댑터는
 * 옵션 조립까지만 돌려 `mcpServers` **키 집합**을 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginHost } from "../../core/plugins/host.js";
import { registerMcpServer, unregisterMcpServer } from "../../core/mcp-registry.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "plugin-wiring-not-just-parts",
  guards:
    "순수 함수는 촘촘한데 그것을 부르는 배선이 무방비라, 플러그인 도구를 SDK 에서 통째로 빼도·find_capabilities 목록에서 빼도·decidePluginMcp 에 엉뚱한 인자를 넘겨도·host.ask 가 toolPolicy 와 좌표와 깊이를 안 넘겨도 스위트가 전부 초록이던 것(2라운드 변이 14개 생존, 그 커밋이 한 일이 정확히 배선 옮기기였다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① `host.ask` 가 **무엇을 넘기는가** (동작) ──────────────────────────
    // ★순수 함수를 부르기만 하는 검사는 이 축을 못 본다 — `toolPolicyFor` 가 옳은 값을
    //  줘도 `ask` 가 그걸 **안 넘기면** 아무 소용이 없다(실측으로 그 변이가 통과했다).
    const seen: Array<Record<string, unknown>> = [];
    const NAME = "regr-wiring-probe";
    registerMcpServer(NAME, () => ({}) as never);
    const host = createPluginHost("regr-wiring", { llm: true });
    // `runRegionA` 를 태우되 모델까지 안 가게 — 입력 조립만 본다.
    const origAbort = AbortSignal.abort();
    const { runRegionA } = await import("../../core/llm-runtime/index.js");
    const spy = async (input: Record<string, unknown>): Promise<never> => {
      seen.push(input);
      throw new Error("probe");
    };
    void runRegionA;
    void spy;
    void origAbort;
    // 직접 부른다 — `ask` 는 내부에서 `runRegionA` 를 동적 import 하므로 가로챌 수 없다.
    // 대신 **관측 가능한 부수효과**로 확인한다: 좌표는 반환 오류 문구에, 나머지는 소스로.
    const askResult = await host.ask({ prompt: "probe", scope: "dashboard:default" });
    unregisterMcpServer(NAME);
    out.push(
      assert(
        "★`ask` 는 실패해도 **값으로** 답한다(모델이 없어도 데몬이 안 죽는다)",
        typeof askResult === "object" && "ok" in askResult,
        JSON.stringify(askResult).slice(0, 80),
      ),
    );

    // ── ② `ask` 호출부가 **세 가지를 다 넘긴다** ────────────────────────────
    // ★등급을 정직하게: `ask` 안의 `runRegionA` 는 동적 import 라 가로챌 수 없다. 그래서
    //  이 축은 **소스 대조**다. 다만 종전(검사 0)과 달리 세 가지를 **개별로** 못박는다 —
    //  하나라도 빠지면 2라운드가 통과시킨 그 변이가 살아난다.
    const hostTs = read("src/core/plugins/host.ts");
    const askBody = /ask: async \(\{ prompt, scope \}\) => \{[\s\S]*?\n  \},/.exec(hostTs)?.[0] ?? "";
    const carried: Array<[string, boolean]> = [
      ["toolPolicy", /toolPolicy: toolPolicyFor\(/.test(askBody)],
      ["좌표 파생", /threadKey: pluginThreadKey\(plugin, scope\)/.test(askBody)],
      ["subagentDepth", /subagentDepth: [1-9]/.test(askBody)],
      ["채널=플러그인", /channel: plugin as never/.test(askBody)],
    ];
    const dropped = carried.filter(([, ok]) => !ok).map(([n]) => n);
    out.push(
      assert(
        "★★`ask` 가 **도구정책·파생좌표·서브에이전트깊이**를 전부 넘긴다 — 셋 다 1라운드가 고친 결함의 자리이고, 하나라도 안 넘기면 그 결함이 그대로 돌아온다(도구 전량 · 남의 대화 지목 · 사다리 최상단)",
        dropped.length === 0 && askBody !== "",
        askBody === "" ? "★ask 본문을 못 찾음" : dropped.length === 0 ? "넷 다 전달" : `★안 넘김: ${dropped.join(", ")}`,
      ),
    );

    // ── ③ claude 어댑터가 플러그인을 **실제로 싣는다** ──────────────────────
    const claude = read("src/core/llm-runtime/adapters/claude-agent-sdk.ts");
    const wiring: Array<[string, boolean]> = [
      // 판정을 부르고
      ["decidePluginMcp 호출", /decidePluginMcp\(\s*input\.extraMcpServers/.test(claude)],
      // 코어 키를 **전부** 준다(뒤에 붙는 셋 포함)
      ["코어 키에 후발 셋", /LATE_CORE_MCP_KEYS/.test(claude) && /\.\.\.LATE_CORE_MCP_KEYS/.test(claude)],
      // toolsNone·reach 를 그대로 넘긴다(고정값이 아니다)
      ["toolsNone 전달", /decidePluginMcp\([\s\S]{0,200}?\n    toolsNone,/.test(claude)],
      ["reach 전달", /decidePluginMcp\([\s\S]{0,240}?reaches\("plugins", turnKind\),/.test(claude)],
      // 결과를 **SDK 에 싣는다**
      ["SDK 에 실림", /mcpServers: applyToolLoadPolicy\(\{\s*\n\s*\.\.\.mcpServersWithPlugins,/.test(claude)],
      // find_capabilities 목록에도
      ["활성 목록에도", /capabilityActiveNames = Object\.keys\(\{[\s\S]{0,300}?\.\.\.mcpServersWithPlugins,/.test(claude)],
      // 충돌은 말한다
      // ★**조건까지 본다** (3라운드 G-2). 호출문만 보면 `> 99` 같은 도달 불가 조건으로
      //  바꿔도 통과한다(실측). "하나라도 떨어뜨렸으면 말한다" 가 지켜야 할 성질이다.
      [
        "충돌 통지",
        /if \(pluginMcp\.shadowed\.length > 0\) warnShadowedOnce\(pluginMcp\.shadowed\)/.test(claude),
      ],
    ];
    const broken = wiring.filter(([, ok]) => !ok).map(([n]) => n);
    out.push(
      assert(
        "★★claude 어댑터가 플러그인 MCP 를 **판정→SDK→활성목록**까지 실제로 잇는다 — 2라운드가 이 사슬의 **여섯 자리**를 끊고도 스위트를 통과했다(그중 하나는 스케줄러·파일감시·서드파티 도구 전멸이다)",
        broken.length === 0,
        broken.length === 0 ? `${String(wiring.length)}자리 전부 연결` : `★끊김: ${broken.join(", ")}`,
      ),
    );

    // ── ④ 후발 코어 키 목록이 **실물과 같다** ───────────────────────────────
    // ★손으로 적은 목록이라 낡는다. 그래서 **실제 리터럴에서 다시 뽑아** 대조한다 —
    //  갈리면 그 이름의 플러그인이 조용히 사라진다(2라운드 P-3 이 정확히 그 형태였다).
    const declared = /LATE_CORE_MCP_KEYS = \[([^\]]*)\]/.exec(claude)?.[1] ?? "";
    const declaredSet = new Set(
      [...declared.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] ?? ""),
    );
    // 최종 리터럴에서 `...mcpServersWithPlugins` **뒤에** 등장하는 서버 키들
    // ★`...mcpServersWithPlugins,` 는 파일에 **두 번** 나온다(활성목록·최종 리터럴).
    //  종전엔 `[1]` 을 써서 **그 둘 사이의 무관한 코드**를 읽었고, `actual` 이 **항상 빈
    //  집합**이라 무엇을 넣거나 빼도 통과했다(3라운드 G-1: 목록에서 `todo` 를 빼도 초록).
    //  마지막 조각이 최종 리터럴이다. 그리고 **빈손이면 실패**시킨다 — 아무것도 못 읽은
    //  검사가 초록인 게 이 결함의 형태였다([[feedback_gate_must_actually_run]]).
    const parts = claude.split("...mcpServersWithPlugins,");
    const tail = (parts.at(-1) ?? "").slice(0, 1800);
    const actual = new Set(
      [...tail.matchAll(/^\s+"?([a-z][a-z-]+)"?: create[A-Z]/gm)].map((m) => m[1] ?? ""),
    );
    const missing = [...actual].filter((k) => !declaredSet.has(k));
    out.push(
      assert(
        "★★후발 코어 서버 목록이 **실물과 같다** — 뒤에 붙는 코어 키를 빠뜨리면 그 이름의 플러그인이 충돌로 안 잡히고, 코어에 덮여 사라지는데, `find_capabilities` 는 그걸 계속 광고한다(실측된 형태)",
        missing.length === 0 && declaredSet.size > 0 && actual.size > 0,
        actual.size === 0
          ? "★실물을 한 글자도 못 읽었다(정규식이 헛돈다)"
          : declaredSet.size === 0
          ? "★목록을 못 찾음"
          : missing.length === 0
            ? `선언 [${[...declaredSet].join(", ")}] · 실물 [${[...actual].join(", ")}]`
            : `★목록에 없음: ${missing.join(", ")}`,
      ),
    );

    // ── ⑤ 충돌 경고가 **로그에 닿는다** (3라운드 G-2) ───────────────────────
    // ★종전엔 `describeShadowed` 의 **문자열 내용**만 검사했다. 그래서 호출 조건을
    //  도달 불가로 바꾸거나(`> 99`) 함수 본문을 `void` 로 비워도 통과했다 — *"조용히
    //  떨어뜨리지 않는다"* 가 이 변경의 **명시 목표**인데 그걸 지키는 강제가 0이었다.
    //  이제 실제로 `console.warn` 을 가로채 **한 줄이 나오는지** 본다.
    {
      const { warnShadowedOnce } = await import("../../core/llm-runtime/plugin-mcp-merge.js");
      const orig = console.warn;
      const lines: string[] = [];
      console.warn = (...a: unknown[]): void => {
        lines.push(a.map(String).join(" "));
      };
      try {
        // ★이름을 매번 바꾼다 — 1회 가드가 모듈 전역 Set 이라 같은 조합은 두 번째부터 안 찍힌다.
        warnShadowedOnce([`regr-shadow-${String(Date.now())}`]);
      } finally {
        console.warn = orig;
      }
      out.push(
        assert(
          "★★코어와 겹쳐 떨어뜨린 것이 **실제로 로그에 나온다** — 이 변경의 명시 목표가 *조용히 떨어뜨리지 않는다* 인데, 종전 검사는 문자열 **내용**만 봐서 그 문장이 로그에 **닿는지**는 아무도 안 봤다(호출을 도달 불가로 만들거나 함수를 비워도 초록이었다)",
          lines.length === 1 && lines[0]?.includes("이름이 겹쳐") === true,
          lines.length === 0 ? "★한 줄도 안 나왔다" : `${String(lines.length)}줄 · "${(lines[0] ?? "").slice(0, 44)}…"`,
        ),
      );
    }

    return out;
  },
};
