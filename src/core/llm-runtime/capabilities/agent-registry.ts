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
import { appRoot, getPaths, projectScope, projectScopeLegacy } from "../../paths.js";
import type { RegionASdkInput } from "../types.js";

export interface Agent {
  /** frontmatter `name` (우선) 또는 파일 basename (확장자 제외). */
  name: string;
  /** frontmatter `description` 필수 — 미존재 시 agent drop. */
  description: string;
  /**
   * frontmatter `model`. settings.json 의 프로파일 이름(default/high/mid/low 또는 커스텀)을
   * 쓰면 그 프로파일의 풀+폴백으로 실행(resolveModelChain). `provider:model` 직접 지정도 가능.
   * 미지정 시 undefined(호출자 디폴트). (claude 네이티브 Task 는 opus/sonnet/haiku 3등급 축약,
   * codex/openai 서브에이전트는 프로파일 체인 완전 사용 — ADR 경계 c.)
   */
  model?: string;
  /** frontmatter `tools` (콤마 구분 raw 문자열). 미지정 시 undefined. */
  tools?: string;
  /** absolute .md path. `getAgentDefinition` 이 매 호출 read. */
  filePath: string;
  /**
   * 발견 출처 (V9.3 — tiguclaw 런타임 컨벤션):
   *  - "builtin": `appRoot()/agents` (앱 번들 빌트인 범용 에이전트 — quick/general 등)
   *  - "user": `getPaths().commonAgents` (=`<home>/agents`)
   *  - "project": `projectScope(cwd).agents` (=`<cwd>/agents`)
   *  - "plugin": `<cwd>/plugins/<plugin>/agents/`
   */
  source: "builtin" | "user" | "project" | "plugin";
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
  // 빌트인 범용 에이전트 (appRoot()/agents) — 앱과 함께 배포되는 quick/general 등.
  // 사용자가 명세를 안 써도 저티어(quick=low) 즉석 위임이 되게. skills 의 appRoot()/skills
  // 미러. dedupeBySource rank 최하(builtin) — 홈에 같은 이름 두면 사용자 것이 우선.
  const builtinRoot = path.join(appRoot(), "agents");
  const userRoot = getPaths().commonAgents;
  const projectRoot = projectScope(cwd).agents; // .tiguclaw/agents (우선)
  const projectLegacyRoot = projectScopeLegacy(cwd).agents; // <cwd>/agents (deprecated 폴백)
  // 플러그인 2루트 (2026-05-27): 번들(appRoot, 앱 배포 코드) + 유저 설치(<home>/plugins).
  const bundledPluginsRoot = path.join(appRoot(), "plugins");
  const homePluginsRoot = getPaths().commonPlugins;

  const [
    builtinAgents,
    userAgents,
    projectAgents,
    projectLegacyAgents,
    bundledPluginAgents,
    homePluginAgents,
  ] = await Promise.all([
    walkAgentsDir(builtinRoot, "builtin"),
    walkAgentsDir(userRoot, "user"),
    walkAgentsDir(projectRoot, "project"),
    walkAgentsDir(projectLegacyRoot, "project"),
    walkPluginsAgents(bundledPluginsRoot),
    walkPluginsAgents(homePluginsRoot),
  ]);

  return dedupeBySource([
    ...builtinAgents,
    ...userAgents,
    ...projectAgents, // .tiguclaw/ 우선 — 같은 이름은 신규가 이기게 legacy 앞에.
    ...projectLegacyAgents,
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
  source: "builtin" | "user" | "project" | "plugin",
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
  source: "builtin" | "user" | "project" | "plugin",
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

// ─── 능력 인덱스 스케일링 (ADR 2026-07-07-capability-index-scaling) ──────────
// 상한 K — 에이전트가 아무리 많아져도 상시 프롬프트 무게 바운드. 총 ≤K 전부 표시
// (회귀 0), >K 상위 K + find_agents 검색 안내. 랭킹=source(project 우선)+이름
// (에이전트 사용 텔레메트리 부재 — 별건, ADR §4).
const AGENT_INDEX_CAP = 40;
const agentSourceRank = (s: Agent["source"]): number =>
  s === "project" ? 0 : s === "user" ? 1 : s === "plugin" ? 2 : 3;

export const formatAgentIndex = (
  agents: ReadonlyArray<Agent>,
  invocationHint: string = DEFAULT_AGENT_INVOCATION_HINT,
): string => {
  if (agents.length === 0) return "";
  const header = `## 사용 가능 서브에이전트\n\n적합한 하위 작업을 위임할 서브에이전트가 있으면 ${invocationHint} (결과를 받아 이어서 행동).`;
  const fmt = (list: ReadonlyArray<Agent>) =>
    list.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  if (agents.length <= AGENT_INDEX_CAP) {
    return `${header}\n\n${fmt(agents)}`;
  }
  const top = [...agents]
    .sort((a, b) => {
      const r = agentSourceRank(a.source) - agentSourceRank(b.source);
      return r !== 0 ? r : a.name.localeCompare(b.name);
    })
    .slice(0, AGENT_INDEX_CAP);
  const rest = agents.length - AGENT_INDEX_CAP;
  return `${header}\n\n${AGENT_INDEX_CAP}개만 표시합니다. 나머지 ${rest}개는 \`find_agents({query})\` 로 검색하세요.\n\n${fmt(top)}`;
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
    "정의된 서브에이전트를 1회 실행하고 그 결과 텍스트를 반환합니다. 서브에이전트는 자기 정의의 `model` 로 실행됩니다 — `model` 에 settings.json 의 프로파일 이름(default/high/mid/low 또는 커스텀)을 쓰면 그 프로파일의 풀+폴백으로 실행되고, `provider:model` 직접 지정도 가능합니다(가용 프로파일은 user prompt 의 `## 모델 프로파일` 섹션 참고 — 작업 성격에 어울리는 걸 고르세요: 설계·분석=high, 구현=mid, 요약·분류=low). claude 네이티브 Task 서브에이전트는 opus/sonnet/haiku 3등급으로 축약됩니다. 사용 가능 서브에이전트 인덱스는 user prompt 의 `## 사용 가능 서브에이전트` 섹션에 prepend 되어 있습니다. 서브에이전트는 자체적으로 다시 spawn 할 수 없습니다 (depth 1 제한). **`path`(폴더 경로)를 주면 그 폴더 컨텍스트로 실행됩니다 — 그 폴더의 에이전트 명세로 생성되고, 그 폴더 전용 스킬/파일작업(상대경로)이 그 폴더 기준이 됩니다. 미지정 시 현재 컨텍스트 상속. 서로 다른 path 로 여러 번 호출하면 폴더(프로젝트)별 병렬 위임이 됩니다.** 그 폴더에 무슨 에이전트/스킬이 있는지는 project_capabilities 로 먼저 확인하세요.",
    {
      name: z.string().min(1),
      prompt: z.string().min(1),
      path: z.string().optional(),
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
        // ★3a(2026-07-07) — 위임 대상 cwd 결정. path 지정 시 그 폴더로 스코프
        // (상대경로는 부모 cwd 기준 절대화), 미지정 시 부모 cwd 상속(회귀 0). 이 cwd 로
        // 에이전트 명세를 발견하고 자식을 실행 → 자식이 그 폴더의 에이전트/스킬/파일
        // 작업(상대경로) 정합. 서로 다른 path 로 다중 호출 = 폴더(프로젝트)별 병렬 위임.
        // ★코어는 "프로젝트"를 모른다 — 인자는 일반 path(디렉터리)일 뿐(단방향 §0).
        const parentCwd = parentInput.cwd ?? process.cwd();
        const targetCwd =
          args.path !== undefined
            ? path.resolve(parentCwd, args.path)
            : parentCwd;
        // agent 정의 회수 (model 등급 포함). 우선순위 project > plugin > user.
        // targetCwd 로 발견 → project 지정 시 그 프로젝트의 에이전트 명세를 집는다.
        const agents = await discoverAgents(targetCwd);
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
          modelTier: agent.model ?? "default",
          // 실행 cwd 기록 — 대시보드가 프로젝트별 서브에이전트 귀속(ADR §6 G2).
          // targetCwd = path 지정 시 그 폴더, 미지정 시 부모 cwd(=무귀속 근사).
          cwd: targetCwd,
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
          cwd: targetCwd,
          subagentDepth: 1,
          ...(toolPolicy !== undefined ? { toolPolicy } : {}),
          ...(leanMemory ? { leanMemory: true } : {}),
        };

        // lazy import — capabilities → llm-runtime/index circular 회피.
        // resolveModelChain(2026-07-14) — agent.model 이 프로파일이면 .fallback 체인까지
        //  운반(예 high→default), 레거시 티어/직접 spec 이면 단일 풀. 빈 체인 = 어댑터 디폴트.
        const { runRegionA, resolveModelChain } = await import("../index.js");
        const chain = resolveModelChain(agent.model, targetCwd);
        const out = await runRegionA(
          childInput,
          chain.length > 0 ? { chain } : undefined,
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

  // find_agents — 인덱스가 상한(AGENT_INDEX_CAP)으로 잘렸을 때, 필요한 서브에이전트를
  // 이름/키워드로 검색(ADR 2026-07-07-capability-index-scaling). 부분일치, throw 0.
  // parentInput.cwd 소스라 인덱스↔검색↔spawn 정합.
  const findAgentsTool = tool(
    "find_agents",
    "이름·설명에 query 가 포함된 서브에이전트를 검색합니다. 사용 가능 서브에이전트가 많아 인덱스에 다 표시되지 않을 때 키워드/이름 조각으로 찾을 때 사용. 찾은 뒤 spawn_agent 로 위임하세요.",
    { query: z.string().min(1) },
    async (args) => {
      try {
        const agents = await discoverAgents(parentInput.cwd ?? process.cwd());
        const q = args.query.toLowerCase();
        const matched = agents.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        );
        if (matched.length === 0) {
          return errText(`'${args.query}' 에 매칭되는 서브에이전트가 없습니다.`);
        }
        const lines = matched
          .slice(0, 50)
          .map(
            (a) =>
              `- ${a.name} (모델: ${a.model ?? "default"}): ${a.description}`,
          );
        return okText(
          `'${args.query}' 매칭 서브에이전트 ${matched.length}개:\n${lines.join("\n")}`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createSdkMcpServer({
    name: "agents",
    version: "1.1.0",
    tools: [spawnTool, findAgentsTool],
  });
};
