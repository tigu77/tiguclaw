/**
 * 회귀: **find_capabilities 는 이번 턴에 실제로 조립된 서버의 도구를 말한다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고: 카탈로그가 손 목록이라 낡았다 — 실제 코어 서버(session-tools·model-settings·home-widgets·tool-recall)가 «외부 연결
 *  MCP · 도구 0개» 로 광고됐고, agents 항목엔 실제 도구(`wait_for_worker`·`read_worker_result`)가 없었고, «claude 는 SDK
 *  빌트인 TodoWrite/Bash» 같은 사실과 다른 문구가 남아 있었다. 모델이 자기 능력을 이걸로 매핑한다.
 *
 * ★등급: 동작 — 어댑터처럼 진짜 코어 서버들을 만든 **직후** find_capabilities 를 만들어 부르고, 답의 도구 목록을 그 서버들의
 *  실제 도구 정의와 대조한다(기대값을 손으로 적지 않는다 — 그게 이번 사고다).
 */
import { createSessionToolsMcpServer } from "../../core/llm-runtime/capabilities/session-tools-mcp.js";
import { createHomeWidgetsMcpServer } from "../../core/llm-runtime/capabilities/home-widgets-mcp.js";
import { createModelSettingsMcpServer } from "../../core/llm-runtime/capabilities/model-settings-mcp.js";
import { createTodoMcpServer } from "../../core/llm-runtime/capabilities/todo-mcp.js";
import { createSpawnAgentMcpServer } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { createFindCapabilitiesMcpServer } from "../../core/llm-runtime/capabilities/find-capabilities-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";
import { getPaths } from "../../core/paths.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const textOf = (content: unknown): string => {
  const arr = Array.isArray(content) ? content : [content];
  return (arr[0] as { text?: string } | undefined)?.text ?? JSON.stringify(content);
};
/** 그 서버의 진짜 도구 이름 — 브리지로 listTools 해서 받는다(정의가 정본). */
const realTools = async (cfg: McpSdkServerConfigWithInstance, name: string): Promise<string[]> => {
  const b = await adaptClaudeMcpServer(cfg, name);
  try {
    return (await b.listTools()).map((t) => (t as { name: string }).name);
  } finally {
    await b.close();
  }
};
/** 답에서 그 능력 줄의 도구 목록. */
const listedTools = (body: string, name: string): string[] | undefined => {
  const line = body.split("\n").find((l) => l.startsWith(`- **${name}**`));
  const m = line === undefined ? null : /\(도구: ([^)]*)\)/.exec(line);
  return line === undefined ? undefined : m === null ? [] : m[1]!.split(", ").filter((s) => s !== "");
};

export const check: RegressionCheck = {
  name: "find-capabilities-reads-real-servers",
  guards: "find_capabilities 손 카탈로그가 낡아 실제 코어 서버를 «외부 연결 MCP · 도구 0개» 로, agents 도구 누락, 사실과 다른 어댑터 문구를 광고하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // 어댑터가 하듯 이번 턴의 코어 서버를 만든다.
    const servers: Record<string, McpSdkServerConfigWithInstance> = {
      "session-tools": createSessionToolsMcpServer("dashboard:fc"),
      "home-widgets": createHomeWidgetsMcpServer(),
      "model-settings": createModelSettingsMcpServer(getPaths().home),
      todo: createTodoMcpServer("dashboard:fc"),
      agents: createSpawnAgentMcpServer({ text: "", threadKey: "dashboard:fc", channel: "dashboard" } as RegionASdkInput),
    };
    const fc = await adaptClaudeMcpServer(createFindCapabilitiesMcpServer([...Object.keys(servers), "my-external"]), "find-capabilities");
    const body = textOf(await fc.callTool("find_capabilities", {}));
    await fc.close();

    for (const name of ["session-tools", "home-widgets", "model-settings"]) {
      const want = await realTools(servers[name]!, name);
      const got = listedTools(body, name);
      out.push(
        assert(
          `★코어 서버 ${name} 은 외부 MCP 가 아니라 실제 도구로 광고된다`,
          got !== undefined && want.length > 0 && want.every((t) => got.includes(t)) && !new RegExp(`외부 연결 MCP 서버\\(${name}\\)`).test(body),
          `실제=${want.join(",")} · 광고=${got === undefined ? "(줄 없음)" : got.join(",")}`,
        ),
      );
    }
    {
      const want = await realTools(servers.agents!, "agents");
      const got = listedTools(body, "agents") ?? [];
      out.push(
        assert(
          "★agents 항목이 실제 도구 전부를 말한다(wait_for_worker·read_worker_result 포함)",
          want.length > 0 && want.every((t) => got.includes(t)),
          `실제=${want.join(",")} · 광고=${got.join(",")}`,
        ),
      );
    }
    out.push(
      assert(
        "사실과 다른 어댑터 문구가 없다(claude 도 todo·셸을 우리 도구로 쓴다)",
        !/claude 는 SDK 빌트인/.test(body),
        /claude 는 SDK 빌트인/.test(body) ? "★낡은 문구 남음" : "없음",
      ),
    );
    out.push(
      assert(
        "코어가 만든 적 없는 이름은 여전히 외부 연결 MCP 로 안내한다",
        /외부 연결 MCP 서버\(my-external\)/.test(body),
        /my-external/.test(body) ? "외부 안내 있음" : "★누락",
      ),
    );
    return out;
  },
};
