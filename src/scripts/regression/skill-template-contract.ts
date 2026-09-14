/** 스킬의 복사 가능한 예시를 실제 발견 파서·MCP 공개 스키마에 연결한다.
 * 도구 핸들러/모델은 호출하지 않고, 예시의 호출만 대역으로 수집한다.
 */
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { discoverAgents, deriveToolPolicy, createSpawnAgentMcpServer } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { createWorkerMcpServer } from "../../core/llm-runtime/capabilities/worker-registry.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";

const read = (rel: string): Promise<string> => readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
const fences = (text: string): string[] => Array.from(text.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm), m => m[1]!);

export const check: RegressionCheck = {
  name: "skill-template-contract",
  guards: "리뷰 예시의 prompt/task 불일치와 중첩 백틱 구문 오류, 에이전트 예시의 tools 목록·model 인라인 주석 파싱 손실",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const parent = { text: "template contract", threadKey: "dashboard:template-contract", channel: "dashboard" as const };
    const servers = [
      await adaptClaudeMcpServer(createWorkerMcpServer(parent), "template-manager"),
      await adaptClaudeMcpServer(createSpawnAgentMcpServer(parent), "template-agent"),
    ];
    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-template-"));
    try {
      const tools = (await Promise.all(servers.map(s => s.listTools()))).flat();
      const calls: Array<{ name: string; args: unknown }> = [];
      const bindings = Object.fromEntries(tools.map(t => [t.name, (args: unknown) => { calls.push({ name: t.name, args }); }]));
      const blocks = fences(await read("skills/code-review/references/review-orchestration.md"));
      out.push(assert("리뷰 호출 예시를 실제 문서에서 발견한다", blocks.length > 0, blocks.length));
      for (const [i, block] of blocks.entries()) {
        const before = calls.length;
        try {
          runInNewContext(block, bindings, { timeout: 1000 });
          out.push(assert(`리뷰 예시 ${i + 1}이 도구 호출을 생성한다`, calls.length > before, calls.length - before));
        } catch (error) {
          out.push(assert(`리뷰 예시 ${i + 1} 실행 가능`, false, String(error)));
        }
      }
      for (const call of calls) {
        const tool = tools.find(t => t.name === call.name)!;
        const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        const result = schema.safeParse(call.args);
        out.push(assert(`${call.name} 예시 인자가 실제 MCP 스키마를 통과한다`, result.success, result.success ? call.name : result.error.issues));
        // 예시가 빈 호출을 허용하는 약한 스키마에 기대 통과하지 않는지 확인한다.
        const empty = schema.safeParse({});
        out.push(assert(`${call.name}의 필수 인자 누락은 거부된다`, !empty.success, empty.success ? empty.data : empty.error.issues));
      }
      const agentDir = path.join(dir, ".tiguclaw", "agents");
      await mkdir(agentDir, { recursive: true });
      const cases = [
        { file: "skills/harness/references/agent-design-patterns.md", name: "agent-name", tools: ["Read", "Grep", "Glob"] },
        { file: "skills/harness/references/qa-agent-guide.md", name: "qa-inspector", tools: ["Read", "Grep", "Bash"] },
      ];
      for (const c of cases) {
        const template = fences(await read(c.file)).find(b => b.startsWith("---\n"));
        out.push(assert(`${c.name} 정의 예시가 존재한다`, template !== undefined, c.file));
        if (template === undefined) continue;
        await writeFile(path.join(agentDir, `${c.name}.md`), template);
      }
      const agents = await discoverAgents(dir);
      for (const c of cases) {
        const agent = agents.find(a => a.name === c.name && a.source === "project");
        const policy = deriveToolPolicy(agent?.tools);
        out.push(assert(`${c.name}이 의도한 high 프로파일로 발견된다`, agent?.model === "high", agent?.model));
        out.push(assert(`${c.name}의 역할에 필요한 도구 목록이 보존된다`, policy?.mode === "allow" && c.tools.every(t => policy.names.includes(t)), policy));
      }
    } finally {
      await Promise.all(servers.map(s => s.close?.()));
      await rm(dir, { recursive: true, force: true });
    }
    return out;
  },
};
