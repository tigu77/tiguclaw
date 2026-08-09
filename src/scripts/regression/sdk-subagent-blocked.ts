/**
 * 회귀: **SDK 네이티브 서브에이전트 도구가 모든 깊이에서 차단된다** (2026-08-08).
 *
 * 팬아웃 경로가 둘이었다 — 우리 `spawn_agent`(관측·스티어·취소 가능, LLM 무관)과 SDK 빌트인
 * `Agent`. 후자는 우리 계약을 **하나도** 못 지켰고, 실사용에서 그대로 터졌다(10건 중 9건이
 * "발사 확인증"만 남기고 0초에 닫혔고, 대시보드엔 아무것도 안 보였다).
 *
 * ★그리고 **손자가 열려 있었다.** `disallowedTools` 는 깊이 무관 배열인데 거기 `Agent` 가
 *  없어서, `spawn_agent` 을 depth 0 에만 주는 게이트를 우회해 자식이 다시 서브를 띄울 수
 *  있었다("손자 금지는 하드" 가 claude 경로에서만 소프트였다 — 프로브로 실증).
 *
 * 이 검사가 지키는 것은 **판정·차단·alias 셋이 같은 출처를 본다**는 것이다. 이름을 새로
 * 열거하지 않는다 — `SDK_SUBAGENT_TOOLS` 하나에서 파생되는지만 본다([[hand-maintained-lists]]).
 * 상류가 또 개명하면(0.1 `Task` → 0.3 `Agent` 처럼) 배열 한 줄만 고치면 셋이 따라와야 한다.

 * ─────────────────────────────────────────────────────────────────────────────
 * ★등급: **배선 린트** (2026-08-08 레드팀 결과 표시)
 *  이 파일의 단언 상당수는 **소스를 훑는다** — 코드가 그렇게 *쓰여 있는지*는 보지만
 *  그렇게 *동작하는지*는 못 본다. `if (false)`·env 게이트·조건 강화·동의어 치환으로
 *  전부 우회된다(레드팀이 13개 변이로 실증했고 7개를 동시에 넣어도 전 스위트 초록이었다).
 *  ★그러니 **우연한 드리프트는 잡지만 적은 못 막는다.** 행동을 지켜야 하는 축은 판정을
 *   순수 함수로 뽑아 **실행**해야 한다(`swallowed-failure.ts` 가 그 예).
 *  등급을 적어 두는 이유: 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다 —
 *  다음 사람이 "여긴 그물이 있다" 고 믿고 지나간다.
 */
import { readdir, readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "sdk-subagent-blocked",
  guards:
    "SDK 빌트인 서브에이전트 도구 차단 + alias 회수 — 팬아웃 단일 경로와 손자 금지의 실제 집행",
  run: async (): Promise<Assertion[]> => {
    const { SDK_SUBAGENT_TOOLS, isSdkSubagentTool, withSdkSubagentsBlocked } =
      await import("../../core/llm-runtime/subagent-tools.js");

    const adapterUrl = new URL(
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      import.meta.url,
    );
    const adapter = await readFile(adapterUrl, "utf8");
    const registryUrl = new URL(
      "../../core/llm-runtime/capabilities/agent-registry.ts",
      import.meta.url,
    );
    const registry = await readFile(registryUrl, "utf8");

    // MCP 서버 이름은 agent-registry 가 정한다(`createSdkMcpServer({ name: "agents" })`).
    // alias 대상이 그 서버를 가리키는지 대조 — 서버를 개명하면 alias 가 **조용히** 없는
    // 도구를 가리키게 된다(그 실패는 런타임에만 보인다).
    const serverName = /createSdkMcpServer\(\{\s*name:\s*"([^"]+)"/.exec(registry)?.[1];

    // ★"고친 자리 200자 창" 이 아니라 **모델이 읽는 텍스트 전수**를 본다 (2026-08-08 검토).
    //  종전 검사는 `formatAgentIndex(...)` 주변 200자만 봤고, 그래서 같은 지시가 헌법
    //  (`_shared-sysprompt.ts`)·`find_capabilities`·`harness` 스킬에 살아 있는데도 초록이었다.
    //  손으로 좁힌 창은 그 자체가 손 관리 목록이다([[hand-maintained-lists]]).
    // ★대상도 판정도 **파생**한다 (2026-08-08 레드팀 A4). 종전엔 파일 7개와 문구 사전을
    //  손으로 들었고, 그래서 차단 대상의 **현행 이름 `Agent`** 가 사전에 없어 헌법에
    //  "`Agent` 도구를 쓰세요" 를 넣어도 통과했다(레드팀 변이). 주석엔 "SDK_SUBAGENT_TOOLS
    //  에서 파생" 이라고 써놓고 실제로는 옛 이름 철자만 봤다.
    // [경로, 최대깊이] — 루트(".")는 **재귀하지 않는다**: `_workspace/`(dev 전용 문서)까지
    // 빨아들여 산문에서 오탐이 났다. 모델이 읽는 것은 배포되는 자산뿐이다.
    const promptRoots: Array<[string, number]> = [
      ["src/core/llm-runtime/adapters", 1],
      ["src/core/llm-runtime/capabilities", 1],
      ["skills", 4],
      [".", 0], // SYSTEM.md 등 루트 md 만
    ];
    const collect = async (rel: string, maxDepth: number, depth = 0): Promise<string[]> => {
      if (depth > maxDepth) return [];
      const out: string[] = [];
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await readdir(new URL(`../../../${rel}`, import.meta.url), {
          withFileTypes: true,
        });
      } catch {
        return [];
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const child = rel === "." ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) out.push(...(await collect(child, maxDepth, depth + 1)));
        else if (/\.(ts|md)$/.test(e.name)) out.push(child);
      }
      return out;
    };
    const promptFiles = (
      await Promise.all(promptRoots.map(([r, d]) => collect(r, d)))
    ).flat();

    // 금지 문구는 **차단 목록에서 파생**한다 — 상류가 또 개명하면 배열 한 줄로 따라온다.
    const names = SDK_SUBAGENT_TOOLS.join("|");
    const bad = new RegExp(
      `\`?(?:${names})\`?\\s*(?:도구|tool)?[^\\n]{0,12}?(?:로|를|으로)\\s*` +
        `(?:위임|기동|실행|사용|호출|쓰)|subagent_type\\s*에`,
    );
    const promptOffenders: string[] = [];
    for (const rel of promptFiles) {
      let text = "";
      try {
        text = await readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
      } catch {
        promptOffenders.push(`${rel}:읽기실패`);
        continue;
      }
      // 주석을 걷어낸다 — "이걸 쓰지 마라" 설명이 그 이름을 포함하므로.
      if (rel.endsWith(".ts")) text = text.replace(/\/\/[^\n]*/g, "");
      if (bad.test(text)) promptOffenders.push(rel);
    }

    return [
      assert(
        "판정(isSdkSubagentTool)이 목록에서 파생된다 — 두 벌이 아니다",
        SDK_SUBAGENT_TOOLS.every((t) => isSdkSubagentTool(t)) &&
          !isSdkSubagentTool("spawn_agent"),
        SDK_SUBAGENT_TOOLS.join(","),
      ),
      assert(
        "★차단이 **깊이 무관**이다 — 함수를 **직접 호출해** 확인한다(철자 검사 아님)",
        // 종전엔 "`depth` 라는 글자가 근처에 없다" 로 봤고, 검토자가
        // `...SDK_SUBAGENT_TOOLS.filter(() => depth === 0)` 로 변이하니 그대로 통과했다.
        // 이제 헬퍼엔 depth 를 받을 자리가 없고, 여기서 결과를 실제로 대조한다.
        SDK_SUBAGENT_TOOLS.every((t) => withSdkSubagentsBlocked([]).includes(t)) &&
          withSdkSubagentsBlocked(["X"])[0] === "X" &&
          withSdkSubagentsBlocked([]).length === SDK_SUBAGENT_TOOLS.length,
        withSdkSubagentsBlocked([]).join(","),
      ),
      assert(
        "★어댑터가 그 헬퍼를 **거쳐서만** 차단한다(뒤에 필터를 붙일 수 없게)",
        // ★판정은 "체이닝이 없는가" 지 "배열이 짧은가" 가 아니다. 종전엔 글자 수 창(120자)에
        //  묶여 있어, 차단 목록에 항목을 더하자(2026-08-09 셸 3종) 그것만으로 빨간불이 됐고
        //  같은 이유로 체이닝 검사도 **사정거리를 잃어** 무력해졌다. 표현식을 통째로 떠서 본다.
        (() => {
          const at = adapter.indexOf("disallowedTools: withSdkSubagentsBlocked([");
          if (at === -1) return false;
          const end = adapter.indexOf("]),", at);
          if (end === -1) return false;
          // 닫는 `])` 바로 뒤가 `,` 여야 한다 — `.filter(...)` 등이 붙으면 다른 글자가 온다.
          return /^\]\),/.test(adapter.slice(end));
        })(),
        "헬퍼 단독 호출(체이닝 없음)",
      ),
      assert(
        "★모델이 읽는 텍스트 어디에도 차단된 도구를 시키는 문장이 없다(전수 — 창 아님)",
        promptOffenders.length === 0,
        promptOffenders.length === 0 ? "0건" : promptOffenders.join(", "),
      ),
    ];
  },
};
