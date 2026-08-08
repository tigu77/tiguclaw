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
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "sdk-subagent-blocked",
  guards:
    "SDK 빌트인 서브에이전트 도구 차단 + alias 회수 — 팬아웃 단일 경로와 손자 금지의 실제 집행",
  run: async (): Promise<Assertion[]> => {
    const {
      SDK_SUBAGENT_TOOLS,
      isSdkSubagentTool,
      sdkSubagentAliases,
      OURS_MCP_TOOL,
    } = await import("../../core/llm-runtime/subagent-tools.js");

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

    const aliases = sdkSubagentAliases();
    // MCP 서버 이름은 agent-registry 가 정한다(`createSdkMcpServer({ name: "agents" })`).
    // alias 대상이 그 서버를 가리키는지 대조 — 서버를 개명하면 alias 가 **조용히** 없는
    // 도구를 가리키게 된다(그 실패는 런타임에만 보인다).
    const serverName = /createSdkMcpServer\(\{\s*name:\s*"([^"]+)"/.exec(registry)?.[1];

    return [
      assert(
        "판정(isSdkSubagentTool)이 목록에서 파생된다 — 두 벌이 아니다",
        SDK_SUBAGENT_TOOLS.every((t) => isSdkSubagentTool(t)) &&
          !isSdkSubagentTool("spawn_agent"),
        SDK_SUBAGENT_TOOLS.join(","),
      ),
      assert(
        "★차단 목록이 그 배열을 그대로 편다(이름을 다시 적지 않는다)",
        /disallowedTools:\s*\[[^\]]*\.\.\.SDK_SUBAGENT_TOOLS/s.test(adapter),
        /\.\.\.SDK_SUBAGENT_TOOLS/.test(adapter) ? "spread 사용" : "★하드코딩 의심",
      ),
      assert(
        "★차단이 **깊이 무관**이다 — 자식도 막혀야 손자 금지가 하드가 된다",
        // disallowedTools 가 depth 로 갈라지면(삼항·조건 spread) 자식만 뚫린다.
        !/disallowedTools:\s*depth/.test(adapter) &&
          !/depth[^\n]*\?\s*\[[^\]]*SDK_SUBAGENT_TOOLS/.test(adapter),
        "depth 분기 없음",
      ),
      assert(
        "alias 가 SDK 이름 전부를 덮는다(한쪽만 늘어나는 드리프트 0)",
        SDK_SUBAGENT_TOOLS.every((t) => aliases[t] === OURS_MCP_TOOL) &&
          Object.keys(aliases).length === SDK_SUBAGENT_TOOLS.length,
        Object.entries(aliases).map(([k, v]) => `${k}→${v}`).join(", "),
      ),
      assert(
        "★alias 대상이 실제 MCP 서버 이름과 일치한다(서버 개명 시 조용히 깨지지 않게)",
        serverName !== undefined && OURS_MCP_TOOL.startsWith(`mcp__${serverName}__`),
        `서버=${serverName ?? "못찾음"} · 대상=${OURS_MCP_TOOL}`,
      ),
      assert(
        "★alias 로 넘어온 SDK 인자 이름(subagent_type)도 받는다 — 습관적 첫 호출이 안 깨지게",
        // 실측(2026-08-08 라이브): 차단 상태에선 우리 스키마가 컨텍스트에 없어 모델이
        // 기억 속 SDK 인자로 부른다 → `subagent_type:"Explore"` 로 와서 검증 에러가 났다.
        /subagent_type:\s*z\.string\(\)/.test(registry) &&
          /rawArgs\.name \?\? rawArgs\.subagent_type/.test(registry),
        "동의어 수용",
      ),
      assert(
        "★프롬프트가 **차단한 도구를 가리키지 않는다** — 어댑터 전용 위임 힌트 0",
        // 종전엔 claude 인덱스에만 "`Task` 도구로 위임하세요(subagent_type 에 …)" 를 주입했다.
        // 그 도구를 막아놓고 프롬프트가 계속 가리키면 **매 위임의 첫 호출이 깨진다**(실측).
        // 셋이 같은 기본 힌트(`spawn_agent({name, prompt})`)를 쓰면 분기 자체가 없다.
        !/formatAgentIndex\([\s\S]{0,200}Task` 도구로/.test(adapter) &&
          !/formatAgentIndex\([\s\S]{0,200}subagent_type 에/.test(adapter),
        "어댑터 전용 힌트 없음",
      ),
      assert(
        "★alias 는 그 도구가 실제로 있는 조건에서만 걸린다(depth 0 + 비-lean)",
        /depth === 0 && !toolsNone[\s\S]{0,120}toolAliases: sdkSubagentAliases\(\)/.test(adapter),
        "조건부 spread",
      ),
    ];
  },
};
