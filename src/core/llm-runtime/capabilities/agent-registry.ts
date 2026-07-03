/**
 * 영역 A V7.2.a — provider-agnostic agent (sub-agent) registry.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v72a-agent-discovery.md`
 *  - V7.1 `skill-registry.ts` 동형 패턴 (frontmatter 파서 재사용).
 *  - Claude Code 표준 sub-agent 정의: `.claude/agents/<name>.md` frontmatter
 *    (`name` / `description` / `model` / `tools` / `subagent_type`).
 *
 * skill 과의 구조 차이 (핵심):
 *  - skill: `<root>/<skill>/SKILL.md` (디렉터리 + 고정 파일명).
 *  - agent: `<root>/<name>.md` (디렉터리 안 .md 파일 직접). 그래서 walk 로직 분리.
 *
 * 정책 게이트:
 *  - dep 추가 0. frontmatter 파서는 `skill-registry.ts` 의 `parseFrontmatter` 재사용.
 *  - 매 호출 fs read (cache 0). V7.5+ cache 후속.
 *  - V9.3 — 세 source walk 가 tiguclaw 런타임 컨벤션으로 전환:
 *    user = `getPaths().commonAgents`(=`<home>/agents`) + project = `projectScope(cwd).agents`
 *    (=`<cwd>/agents`) + plugin = `<cwd>/plugins/<plugin>/agents/` (앱 번들, cwd 전파 안 함).
 *  - frontmatter `name`(우선)/`description` 필수. 누락 시 agent drop.
 *  - V7.2.a 는 *자동 발견 인프라만* — codex 측 `spawn_agent` MCP tool +
 *    실제 LLM turn 중첩 실행은 V7.2.b 후속.
 *  - 2026-05-25 격리 fix: claude 어댑터도 본 모듈을 직접 호출한다. SDK 는 격리
 *    모드(settingSources 미설정)라 `.claude/agents` 를 자동 발견하지 않으므로,
 *    `discoverAgents(cwd)` 결과를 SDK `options.agents` 로 주입 → native Task tool
 *    이 발견·실행. 이전 "SDK 자동 발견 — 본 모듈 호출 0" 전제는 거짓이었다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { parseFrontmatter } from "./skill-registry.js";
import { dedupeBySource } from "./dedup-by-source.js";
import { appRoot, getPaths, projectScope } from "../../paths.js";
import type { RegionASdkInput } from "../types.js";

export interface Agent {
  /** frontmatter `name` (우선) 또는 파일 basename (확장자 제외). */
  name: string;
  /** frontmatter `description` 필수 — 미존재 시 agent drop. */
  description: string;
  /** frontmatter `model` (opus/sonnet/haiku 등). 미지정 시 undefined (호출자 디폴트). */
  model?: string;
  /** frontmatter `tools` (콤마 구분 raw 문자열). 미지정 시 undefined. */
  tools?: string;
  /** absolute .md path. `getAgentDefinition` 이 매 호출 read. */
  filePath: string;
  /**
   * 발견 출처 (V9.3 — tiguclaw 런타임 컨벤션):
   *  - "user": `getPaths().commonAgents` (=`<home>/agents`)
   *  - "project": `projectScope(cwd).agents` (=`<cwd>/agents`)
   *  - "plugin": `<cwd>/plugins/<plugin>/agents/`
   */
  source: "user" | "project" | "plugin";
  /** source === "plugin" 시 plugin id (디렉터리 이름). 그 외 undefined. */
  pluginId?: string;
}

/**
 * 세 source walk → 모든 agent 회수 (V9.3 — tiguclaw 컨벤션 + cwd 인자화).
 * cwd 기본값 `process.cwd()` → 무인자 호출은 현 동작 동일 (회귀 0). cwd 는 user/project
 * 에만 영향 — plugins 줄은 앱 번들이라 `appRoot()/plugins` (α 2026-05-25: cwd 무관 앱
 * 설치 루트. dev=레포=cwd 동치, prod 정정).
 * 미존재 디렉터리는 빈 배열 (throw 0).
 *
 * V9.5 — 동일 이름 충돌 dedup(`dedupeBySource`): project > plugin > user override,
 * 이름당 1개만 (인덱스↔fetch 단일 진실). `getAgentDefinition` 의 `project ?? plugin ??
 * first` 와 동일 규칙을 discover 레벨로 확장. codex `agentIndex` 가 중복 제거 혜택,
 * claude 측은 SDK 가 agents 자동발견(Task tool)이라 discoverAgents 인덱스 미사용 →
 * C-4(plugin 회귀) 무관, plain dedup. (contract `_workspace/v95_architect_contract.md`)
 */
export const discoverAgents = async (
  cwd: string = process.cwd(),
): Promise<Agent[]> => {
  const userRoot = getPaths().commonAgents;
  const projectRoot = projectScope(cwd).agents;
  // 플러그인 2루트 (2026-05-27): 번들(appRoot, 앱 배포 코드) + 유저 설치(<home>/plugins).
  const bundledPluginsRoot = path.join(appRoot(), "plugins");
  const homePluginsRoot = getPaths().commonPlugins;

  const [userAgents, projectAgents, bundledPluginAgents, homePluginAgents] =
    await Promise.all([
      walkAgentsDir(userRoot, "user"),
      walkAgentsDir(projectRoot, "project"),
      walkPluginsAgents(bundledPluginsRoot),
      walkPluginsAgents(homePluginsRoot),
    ]);

  return dedupeBySource([
    ...userAgents,
    ...projectAgents,
    ...bundledPluginAgents,
    ...homePluginAgents,
  ]);
};

/**
 * 단일 agents 디렉터리 walk — 안의 `*.md` 파일 직접 순회.
 * (skill 의 `<dir>/SKILL.md` 와 달리 agent 는 `<dir>/<name>.md` 직접.)
 * 부재 디렉터리는 빈 배열 (realpath/readdir throw 흡수).
 */
const walkAgentsDir = async (
  root: string,
  source: "user" | "project" | "plugin",
): Promise<Agent[]> => {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return [];
  }

  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(rootReal, { withFileTypes: true });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.join(rootReal, e.name))
    .sort((a, b) => a.localeCompare(b));

  const loaded = await Promise.all(
    mdFiles.map((filePath) => loadSingleAgent(filePath, source)),
  );
  return loaded.filter((a): a is Agent => a !== null);
};

/**
 * `<cwd>/plugins/<plugin>/agents/` walk — V7.1 walkPluginsRoot 동형.
 * 각 plugin 디렉터리의 `agents/` 서브디렉터리 회수, pluginId 박음.
 */
const walkPluginsAgents = async (pluginsRoot: string): Promise<Agent[]> => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const pluginDirs = entries
    .filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    )
    .map((e) => ({ id: e.name, dir: path.join(pluginsRoot, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const perPlugin = await Promise.all(
    pluginDirs.map(async ({ id, dir }) => {
      const agentsDir = path.join(dir, "agents");
      const agents = await walkAgentsDir(agentsDir, "plugin");
      return agents.map((a) => ({ ...a, pluginId: id }));
    }),
  );

  return perPlugin.flat();
};

/**
 * 단일 agent .md 파일 → Agent 객체.
 * 누락 케이스: read 실패 / frontmatter 파싱 실패 / name·description 누락 → null.
 */
const loadSingleAgent = async (
  filePath: string,
  source: "user" | "project" | "plugin",
): Promise<Agent | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  if (frontmatter === null) return null;

  const fallbackName = path.basename(filePath, ".md").trim();
  const name = (frontmatter.name ?? "").trim() || fallbackName;
  const description = (frontmatter.description ?? "").trim();
  if (name === "" || description === "") return null;

  const model = (frontmatter.model ?? "").trim() || undefined;
  const tools = (frontmatter.tools ?? "").trim() || undefined;

  return {
    name,
    description,
    model,
    tools,
    filePath: path.resolve(filePath),
    source,
  };
};

// ─── lean 신호 정규화 (2026-06-15, architect contract §4) ───────────────
// agent.md frontmatter → 중립 lean 신호(RegionASdkInput.toolPolicy/leanMemory).
// 순수함수 — 모델/provider/adapter 조건 분기 0 (불변식 I-1). lean 은 *agent 정의의
// 속성*에서만 갈린다. 도구명→실제 도구 매핑은 어댑터 안에서(추상 누수 0, I-3).

/**
 * agent.md `tools` 필드(콤마 raw 문자열) → toolPolicy 중립 신호.
 *  - 미지정(undefined): undefined → 어댑터가 전체 도구 (회귀 0).
 *  - "none" (또는 빈/공백): { mode: "none" } → 도구 0 (lean·도구 미지원 모델 graceful).
 *  - "Read, Grep" 류 콤마 리스트: { mode: "allow", names } → allowlist (Claude Code 답습).
 * Claude Code sub-agent `tools` frontmatter 의미를 그대로 옮긴다.
 */
export const deriveToolPolicy = (
  tools: string | undefined,
): RegionASdkInput["toolPolicy"] => {
  if (tools === undefined) return undefined; // 미지정 = 전체 도구 (회귀 0).
  const s = tools.trim();
  if (s === "" || s.toLowerCase() === "none") return { mode: "none" };
  const names = s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (names.length === 0) return { mode: "none" };
  return { mode: "allow", names };
};

/**
 * agent → leanMemory 신호 (메모리 스니펫·인덱스 prepend 생략 여부).
 * 권고(task spec §5): `tools: none` 인 단순작업 child 는 lean — 장기기억은 잡음.
 * tools 미지정·allowlist agent 는 현행대로 메모리 주입(회귀 0). 모델/티어로 분기
 * 절대 금지(I-1) — 오직 agent 속성(tools)에서만 파생.
 */
export const deriveLeanMemory = (agent: Agent): boolean => {
  const policy = deriveToolPolicy(agent.tools);
  return policy?.mode === "none";
};

/**
 * agent 인덱스 → user prompt prepend 용 문자열.
 * 비어 있으면 빈 문자열 — 호출자가 prepend skip.
 *
 * `invocationHint` — 어댑터별 위임 도구가 달라 파라미터화 (LLM-agnostic).
 *  codex 는 `spawn_agent` MCP 도구(기본값), claude 는 SDK native Task 도구
 *  (`options.agents` 주입분을 subagent_type 으로 위임). 도구명을 어댑터가 주입해
 *  없는 도구로 오도되는 것을 방지.
 */
const DEFAULT_AGENT_INVOCATION_HINT =
  "`spawn_agent({name, prompt})` 도구로 실행하세요";
export const formatAgentIndex = (
  agents: ReadonlyArray<Agent>,
  invocationHint: string = DEFAULT_AGENT_INVOCATION_HINT,
): string => {
  if (agents.length === 0) return "";
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`);
  return `## 사용 가능 서브에이전트\n\n적합한 하위 작업을 위임할 서브에이전트가 있으면 ${invocationHint} (결과를 받아 이어서 행동).\n\n${lines.join("\n")}`;
};

/**
 * agent 이름 → .md raw 본문 (frontmatter 포함). V7.2.b spawn 에서 system prompt 로 사용.
 * 매 호출 fs read (cache 0). 미발견 시 undefined.
 * 우선순위: project > plugin > user.
 */
export const getAgentDefinition = async (
  name: string,
  cwd: string = process.cwd(),
): Promise<string | undefined> => {
  const agents = await discoverAgents(cwd);
  const candidates = agents.filter((a) => a.name === name);
  if (candidates.length === 0) return undefined;
  const project = candidates.find((a) => a.source === "project");
  const plugin = candidates.find((a) => a.source === "plugin");
  const chosen = project ?? plugin ?? candidates[0]!;
  try {
    return await fs.readFile(chosen.filePath, "utf8");
  } catch {
    return undefined;
  }
};

// ─── spawn_agent MCP server (V7.2.b) ─────────────────────────────────────
// codex 측 sub-agent spawn — claude 어댑터는 SDK Task tool 자동 (회귀 0).
//
// depth 가드 (OpenClaw `subagent-spawn.ts` maxSpawnDepth 단순화):
//  - 본 server 는 codex 어댑터가 *depth 0 turn 에서만* 등록.
//  - child turn 은 `subagentDepth: 1` 로 실행 → 어댑터가 본 server 미등록
//    → 재spawn 물리적 불가 (depth 1 제한).
//
// child system prompt 전략 (단일 인격 원칙 정합):
//  - agent 정의 본문은 child *user prompt prepend* (공통 SYSTEM_PROMPT 무변).
//    서브에이전트도 같은 인격의 *다른 역할* — system prompt 분기 0.

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * codex 어댑터 mcpServers 등록용 spawn_agent server 팩토리.
 *  - parentInput: 현재 turn input — child 의 channel/cwd 상속 + threadKey 파생.
 *
 * V7.2.d — child 를 **agent 정의의 `model:` 등급**으로 실행한다 (Claude Code
 * sub-agent model 답습). agent.model = "high"/"mid"/"low" 등급 → `MODEL_TIER_*`
 * 폴백 풀, 또는 "provider:model" 직접. runRegionA(facade)로 위임해 어느 어댑터든
 * (claude/codex/...) child 가능 — runner 고정(codex) 폐기. circular 회피 위해
 * runRegionA/resolveTier 는 lazy import.
 */
export const createSpawnAgentMcpServer = (
  parentInput: RegionASdkInput,
): McpSdkServerConfigWithInstance => {
  const spawnTool = tool(
    "spawn_agent",
    "정의된 서브에이전트를 1회 실행하고 그 결과 텍스트를 반환합니다. 서브에이전트는 자기 정의의 model 등급(high/mid/low)으로 실행됩니다. 사용 가능 서브에이전트 인덱스는 user prompt 의 `## 사용 가능 서브에이전트` 섹션에 prepend 되어 있습니다. 서브에이전트는 자체적으로 다시 spawn 할 수 없습니다 (depth 1 제한).",
    {
      name: z.string().min(1),
      prompt: z.string().min(1),
    },
    async (args) => {
      // 관측 잡 (kind:'agent') — 서브에이전트를 워커와 동일한 대시보드 잡으로 노출
      // (ADR 2026-07-03 subagent-worker-unify, Phase A). 실행 모델은 불변(블로킹 await).
      // markDone/markFailed 는 재주입을 안 타므로 U-I1(재주입=워커만) 자동 충족.
      // 자식 실행 threadKey = `agent:<jobId>` → 활동(llm.activity)이 그 좌표로 흘러
      // 대시보드가 워커(`worker:`)와 동형으로 서브 카드에 귀속(per-step 관측).
      const { registerJob, markDone, markFailed } = await import(
        "../../worker-jobs.js"
      );
      let jobId: string | undefined;
      try {
        // agent 정의 회수 (model 등급 포함). 우선순위 project > plugin > user.
        // V9.3 — parentInput.cwd 전파 → child 가 부모 프로젝트 스킬/에이전트 정합.
        const agents = await discoverAgents(parentInput.cwd ?? process.cwd());
        const cands = agents.filter((a) => a.name === args.name);
        if (cands.length === 0) {
          return errText(`서브에이전트 '${args.name}' 미발견.`);
        }
        const agent =
          cands.find((a) => a.source === "project") ??
          cands.find((a) => a.source === "plugin") ??
          cands[0]!;
        const def = await fs.readFile(agent.filePath, "utf8");

        // 관측 잡 등록 — threadKey=부모(어느 대화가 띄웠나 상관), 실행은 agent:<jobId>.
        // channelUserId 는 재주입/통지용인데 agent 잡은 둘 다 안 하므로 빈 문자열.
        jobId = registerJob({
          kind: "agent",
          agentName: args.name,
          label: args.name,
          task: args.prompt,
          threadKey: parentInput.threadKey,
          channel: parentInput.channel,
          channelUserId: "",
        });

        // lean 신호 — agent.md frontmatter 정규화 (2026-06-15). 어댑터 무관 중립 신호.
        //  - toolPolicy: tools: none → {mode:"none"} / 콤마 리스트 → allow / 미지정 → undefined.
        //  - leanMemory: tools: none agent 는 메모리 생략(단순작업 child). 둘 다 additive.
        const toolPolicy = deriveToolPolicy(agent.tools);
        const leanMemory = deriveLeanMemory(agent);
        const childInput: RegionASdkInput = {
          text: `${def}\n\n[Subagent Task]: ${args.prompt}`,
          threadKey: `agent:${jobId}`,
          channel: parentInput.channel,
          cwd: parentInput.cwd,
          subagentDepth: 1,
          ...(toolPolicy !== undefined ? { toolPolicy } : {}),
          ...(leanMemory ? { leanMemory: true } : {}),
        };

        // lazy import — capabilities → llm-runtime/index circular 회피.
        const { runRegionA, resolveTier } = await import("../index.js");
        const specs = resolveTier(agent.model);
        const out = await runRegionA(
          childInput,
          specs.length > 0 ? { specs } : undefined,
        );
        markDone(jobId, out.text); // 관측 완료 — 재주입 없음(결과는 아래 return 으로 부모 회수).
        return okText(out.text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (jobId !== undefined) markFailed(jobId, msg);
        return errText(msg);
      }
    },
  );

  return createSdkMcpServer({
    name: "agents",
    version: "1.0.0",
    tools: [spawnTool],
  });
};
