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
import { getEventBus } from "../../eventbus.js";
import type { SteeringChannel } from "../../steering.js";
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
import type { RegionASdkInput, RegionASdkOutput } from "../types.js";

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
 *  세 어댑터 공통 `spawn_agent` MCP 도구 (claude 의 SDK native Task/Agent 는 차단됨)
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
  // ★대소문자를 구분하지 않는다 (2026-08-08 검토). 모델이 SDK 어휘를 습관으로 쓰면
  //  `Explore`(대문자)로 오는데 우리 정의는 `explore` 다 — 한 글자 차이로 미발견이었다.
  //  이름은 파일명에서 오고 관례상 소문자라, 대소문자 무시가 충돌을 만들지 않는다.
  const lower = name.toLowerCase();
  const candidates = agents.filter((a) => a.name.toLowerCase() === lower);
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
 * 에이전트 정의 → 자식 turn 입력. **awaited(`wait:true`)·detached(`wait:false`) 공용.**
 *
 * ★함수로 뽑은 이유(ADR 2026-08-19 Q7 조건): 종전엔 이 변환이 spawn_agent 핸들러에
 *  인라인이라, 백그라운드 경로가 생기면 **복사**될 수밖에 없었다. 복사하면 갈린다 —
 *  그리고 갈린 쪽은 조용하다(자식이 도구를 못 쓰거나 선택지를 못 내는데 에러가 없다).
 *  둘 중 하나만 고치는 일이 반드시 생기므로, 애초에 소유자를 하나로 둔다.
 *
 * 여기 담기는 판단 넷 — 어느 것도 경로마다 달라선 안 된다:
 *  - 프롬프트 조립(`정의 + [Subagent Task]`)
 *  - `toolPolicy`: `tools: none` → {mode:"none"} / 콤마 리스트 → allow / 미지정 → undefined
 *  - `leanMemory`: `tools: none` 에이전트는 메모리 생략(단순작업 child)
 *  - `presentOptions` 전파: 없으면 자식이 선택지를 못 낸다(부모와 동일 능력이 원칙)
 */
const buildAgentChildInput = (o: {
  jobId: string;
  agent: Agent;
  def: string;
  prompt: string;
  targetCwd: string;
  parentInput: RegionASdkInput;
  abortSignal: AbortSignal;
  /** detached 경로만 넘긴다 — 돌고 있는 서브에 지시를 얹는 채널(ADR §2). */
  steering?: SteeringChannel;
}): RegionASdkInput => {
  const toolPolicy = deriveToolPolicy(o.agent.tools);
  const leanMemory = deriveLeanMemory(o.agent);
  return {
    text: `${o.def}\n\n[Subagent Task]: ${o.prompt}`,
    threadKey: `agent:${o.jobId}`,
    channel: o.parentInput.channel,
    cwd: o.targetCwd,
    subagentDepth: 1,
    abortSignal: o.abortSignal,
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
    ...(leanMemory ? { leanMemory: true } : {}),
    // presentOptions 전파(2026-07-17, AskUserQuestion 차단 파리티) — 부모 채널의
    // 인터랙티브 선택지 렌더 클로저를 자식에도 상속. 이게 없으면 prompt-options MCP 가
    // 자식 turn 에 미등록(claude-agent-sdk.ts 게이트 = presentOptions!==undefined) →
    // 자식이 "선택지 제시 불가"로 저하한다.
    ...(o.parentInput.presentOptions !== undefined
      ? { presentOptions: o.parentInput.presentOptions }
      : {}),
    ...(o.steering !== undefined ? { steering: o.steering } : {}),
  };
};

/**
 * **백그라운드 서브에이전트 실행** — `spawn_agent(wait:false)` (ADR 2026-08-19).
 *
 * 동기 반환한다(자식은 detached promise). throw 금지 — 모든 종료는 `onWorkerComplete`
 * 로 닫는다. 형태는 `worker-registry.ts` 의 runner 와 같다: 그쪽이 이미 스티어 채널·
 * 잔여 회수·자원 해제·통지를 다 갖고 있어서, 새 프리미티브가 **0개**다.
 *
 * ★워커 runner 와 **다른 점 하나**: 하드 백스톱(Promise.race)을 두지 않는다. 워커는
 *  `WORKER_TIMEOUT_MS` 를 갖지만 서브는 `createJobAbort(timeoutMs: SUBAGENT_TIMEOUT_MS)`
 *  가 이미 자체 상한이고, 그 위에 두 번째 상한을 얹으면 어느 쪽이 끊었는지 로그가
 *  갈린다(경계 순서 불변식은 *중첩*을 요구하지 중복을 요구하지 않는다).
 */
export const startDetachedAgent = (o: {
  jobId: string;
  agent: Agent;
  def: string;
  prompt: string;
  targetCwd: string;
  parentInput: RegionASdkInput;
  abort: { signal: AbortSignal; done: () => void };
  /**
   * 자식 실행 주입 — **검사 전용**. 기본은 진짜 `runRegionA`.
   *
   * ★왜 이음매가 필요한가 (2026-08-20 전체 검토 A-F1, 위험도 5): 이 함수 안의
   *  `onWorkerComplete` 호출을 **지워도 1,299건 스위트가 전부 초록**이었다. 결과가
   *  아무에게도 안 가고, `markDone/markFailed` 가 그 안이라 잡이 영원히 running 으로
   *  굳고, 매니저는 2시간 상한까지 그 자식을 거둔다 — 헤드라인 기능이 통째로 무음 사망.
   *  회귀가 `onWorkerComplete` 를 **직접** 부르고 실행 경로는 문자열로만 봤기 때문이다.
   *  모델 호출만 갈아끼우면 나머지 배선은 **진짜로** 돌릴 수 있다.
   */
  __runForTest?: (input: RegionASdkInput) => Promise<RegionASdkOutput>;
}): void => {
  void (async () => {
    const {
      onWorkerComplete,
      setSteerChannel,
      clearSteerChannel,
      getSteerChannel,
      WORKER_STEERING_ENABLED,
      notifyJobOwner,
      getJob,
    } = await import("../../worker-jobs.js");
    const { createSteeringChannel } = await import("../../steering.js");

    // ★서브에도 스티어 채널 (ADR §2). 오래 도는 게 기본이 되면 개입 수단이 있어야 한다.
    //  `setSteerChannel` 은 jobId 기준이라 kind 를 안 본다 — 매니저용으로 만든 배관이
    //  그대로 맞는다(중복 구현 0). 끄면(WORKER_STEERING_ENABLED=0) 채널 자체를 안 만든다:
    //  steering 유무가 claude 실행 경로(string-prompt ↔ streaming-input)를 바꾸므로.
    const steerCh = WORKER_STEERING_ENABLED ? createSteeringChannel() : undefined;
    if (steerCh !== undefined) setSteerChannel(o.jobId, steerCh);

    let outcome: { result: string } | { error: string };
    /** 서브가 끝나는 순간 도착해 반영 못 한 지시(원문). 결과 보고 뒤에 정직 통지. */
    let pendingSteerNotice: string[] = [];
    try {
      const inject = o.__runForTest;
      const { runRegionA, resolveModelChain } = inject
        ? { runRegionA: null as never, resolveModelChain: (() => []) as unknown as typeof import("../index.js").resolveModelChain }
        : await import("../index.js");
      const chain = resolveModelChain(o.agent.model, o.targetCwd);
      const childInput = buildAgentChildInput({
        jobId: o.jobId,
        agent: o.agent,
        def: o.def,
        prompt: o.prompt,
        targetCwd: o.targetCwd,
        parentInput: o.parentInput,
        abortSignal: o.abort.signal,
        ...(steerCh !== undefined ? { steering: steerCh } : {}),
      });
      const out = inject
        ? await inject(childInput)
        : await runRegionA(childInput, chain.length > 0 ? { chain } : undefined);
      outcome = { result: out.text };
    } catch (e) {
      outcome = { error: e instanceof Error ? e.message : String(e) };
    } finally {
      o.abort.done();
      // 스티어 채널 종료 + 잔여 회수. 서브에겐 다음 턴이 없으므로 그냥 close 하면 막
      // 도착한 지시가 조용히 사라진다(워커와 같은 손실창 — 같은 처리로 닫는다).
      if (steerCh !== undefined) {
        // ★**레지스트리에서 현재 채널을 다시 읽는다** (2026-08-20 적대 검토 A-F5).
        //  `steerJob` 은 채널이 닫혔어도 잡이 살아 있으면 갈아끼우고 `"delivered"` 를 준다.
        //  그런데 여기서 **자기 지역 변수**를 drain 하면 그 새 채널을 아무도 안 읽는다 —
        //  지시가 사라지는데 사용자에겐 "전달했어요" 가 뜨고, 잔여 통지조차 안 나간다.
        //  (`startDetachedAgent` 는 회전을 안 하므로 항상 이 창에 노출돼 있었다.)
        const current = getSteerChannel(o.jobId) ?? steerCh;
        clearSteerChannel(o.jobId);
        current.close();
        pendingSteerNotice = current
          .drain()
          .map((m) => m.raw)
          .filter((t) => t !== "");
        // 지역 참조가 다른 객체면 그쪽 잔여도 함께 회수한다(교체 순간 갇힌 것).
        if (current !== steerCh) {
          steerCh.close();
          pendingSteerNotice.push(
            ...steerCh.drain().map((m) => m.raw).filter((t) => t !== ""),
          );
        }
      }
    }

    // 결과를 소환자에게 — 매니저면 그 턴의 steering 큐, 세션이면 새 턴(deliverToSummoner).
    try {
      await onWorkerComplete(o.jobId, outcome);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `agent-registry: 백그라운드 서브 완료 통지 예외 흡수 (job=${o.jobId}): ${reason}`,
      );
    }

    if (pendingSteerNotice.length > 0) {
      const job = getJob(o.jobId);
      if (job !== undefined) {
        try {
          await notifyJobOwner(
            job,
            `⚠️ 방금 보내신 지시는 '${job.label}' 서브에이전트가 **이미 끝난 뒤** 도착해서 반영되지 않았어요:\n` +
              pendingSteerNotice.map((t) => `· ${t}`).join("\n") +
              `\n필요하면 위 결과를 보고 다시 시켜주세요.`,
          );
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`agent-registry: 잔여 steer 통지 실패 (job=${o.jobId}): ${reason}`);
        }
      }
    }
  })();
};

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
    "정의된 서브에이전트를 1회 실행하고 그 결과 텍스트를 반환합니다. 서브에이전트는 자기 정의의 `model` 로 실행됩니다 — `model` 에 settings.json 의 프로파일 이름(default/high/mid/low 또는 커스텀)을 쓰면 그 프로파일의 풀+폴백으로 실행되고, `provider:model` 직접 지정도 가능합니다(가용 프로파일은 작동 컨텍스트의 `## 모델 프로파일` 섹션 참고 — 작업 성격에 어울리는 걸 고르세요: 설계·분석=high, 구현=mid, 요약·분류=low). 사용 가능 서브에이전트 인덱스는 작동 컨텍스트의 `## 사용 가능 서브에이전트` 섹션에 이미 실려 있습니다. 서브에이전트는 자체적으로 다시 spawn 할 수 없습니다 (depth 1 제한). **`path`(폴더 경로)를 주면 그 폴더 컨텍스트로 실행됩니다 — 그 폴더의 에이전트 명세로 생성되고, 그 폴더 전용 스킬/파일작업(상대경로)이 그 폴더 기준이 됩니다. 미지정 시 현재 컨텍스트 상속. 서로 다른 path 로 여러 번 호출하면 폴더(프로젝트)별 병렬 위임이 됩니다.** 그 폴더에 무슨 에이전트/스킬이 있는지는 project_capabilities 로 먼저 확인하세요. **선택 기준**: 결과를 *이번 답변 안에서* 써서 다음 판단을 해야 할 때는 그대로 부르세요(기본 `wait:true` — 부모 턴을 붙잡고 기다립니다). 오래 걸리거나 여러 개를 동시에 돌리고 싶으면 **`wait:false`** 로 부르세요 — 즉시 jobId 를 받고 계속 진행할 수 있으며, **끝나면 결과가 당신에게 돌아옵니다**(당신이 매니저면 진행 중인 턴에 이어지고, 메인 대화면 새 답변으로 옵니다). 소환해놓고 잊는 게 아니라 *지금 안 기다릴 뿐* 입니다. 규모가 크고 스스로 팬아웃까지 해야 하는 작업은 run_in_background(매니저) 가 더 맞습니다.",
    {
      // ★`subagent_type` 은 SDK 빌트인 `Agent` 의 인자 이름이다 (2026-08-08).
      //  그 도구를 차단한 뒤에도 모델은 **습관으로** 그 이름을 부르고(그래서 toolAliases 로
      //  여기로 회수한다), 그때 인자는 **기억 속 SDK 스키마**로 온다 — 차단 상태에선 우리
      //  스키마가 컨텍스트에 없으니까. 실측: 첫 호출이 `subagent_type:"Explore"` 로 와서
      //  검증 에러 → 모델이 스키마를 다시 읽고 재호출(자가 교정은 됐지만 실패 카드가 남았다).
      //  둘 다 받아 그 왕복을 없앤다. 정본은 `name` — 설명·인덱스가 쓰는 이름이다.
      name: z.string().min(1).optional(),
      subagent_type: z.string().min(1).optional(),
      prompt: z.string().min(1),
      path: z.string().optional(),
      // ★기본 true = 현행 동작 (Q1 슈퍼셋 — 능력 추가만, 제거 0).
      wait: z
        .boolean()
        .optional()
        .describe(
          "결과를 이 답변 안에서 기다릴지. 기본 true(기다림). false 면 즉시 jobId 를 반환하고 계속 진행할 수 있으며, 끝나면 결과가 당신에게 돌아옵니다 — 오래 걸릴 작업이나 여러 개를 동시에 돌릴 때 씁니다.",
        ),
    },
    async (rawArgs) => {
      const agentName = rawArgs.name ?? rawArgs.subagent_type;
      if (agentName === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "name(서브에이전트 이름)이 필요합니다. 사용 가능 목록은 작동 컨텍스트의 `## 사용 가능 서브에이전트` 섹션에 있습니다.",
            },
          ],
          isError: true,
        };
      }
      const args = { ...rawArgs, name: agentName };
      // 관측 잡 (kind:'agent') — 서브에이전트를 워커와 동일한 대시보드 잡으로 노출
      // (ADR 2026-07-03 subagent-worker-unify, Phase A). 실행 모델은 불변(블로킹 await).
      // markDone/markFailed 는 재주입을 안 타므로 U-I1(재주입=워커만) 자동 충족.
      // 자식 실행 threadKey = `agent:<jobId>` → 활동(llm.activity)이 그 좌표로 흘러
      // 대시보드가 워커(`worker:`)와 동형으로 서브 카드에 귀속(per-step 관측).
      const { registerJob, markDone, markFailed, createJobAbort, WorkerCancelledError, SUBAGENT_TIMEOUT_MS } =
        await import("../../worker-jobs.js");
      // 중복 스폰 판정 — LLM 무관 공용(어댑터 3종에 흩어지지 않게 코어에 둔다).
      const { findDuplicateSpawn, rememberSpawn, spawnKey } = await import("../../spawn-dedupe.js");
      const { toolsWereExpected } = await import("./tools-expected.js");
      let jobId: string | undefined;
      let abort: ReturnType<typeof createJobAbort> | undefined;
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
        // ★대소문자를 구분하지 않는다 (2026-08-08). 모델이 SDK 어휘를 습관으로 쓰면
        //  `Explore`(대문자)로 오는데 우리 정의는 `explore` 다 — 한 글자 차이로 미발견이었다.
        //  이름은 파일명에서 오고 전부 소문자-하이픈이라(전수 확인) 폴딩 충돌이 없다.
        //  ★앞 라운드엔 이 수정을 `getAgentDefinition` 에 넣었는데 **그 함수는 호출자가
        //   0개**였다(레드팀 적발). 고치는 자리를 확인하지 않으면 고친 게 아니다.
        const wanted = args.name.toLowerCase();
        const cands = agents.filter((a) => a.name.toLowerCase() === wanted);
        if (cands.length === 0) {
          // ★후보를 **알려준다**. 종전엔 막다른 문자열이라 모델이 턴 하나를 더 태웠다 —
          //  같은 스코프에 목록이 있는데 안 쓰고 있었다.
          const names = agents.map((a) => a.name).sort();
          const shown = names.slice(0, 20).join(", ");
          return errText(
            `서브에이전트 '${args.name}' 미발견. 사용 가능: ${shown}` +
              (names.length > 20 ? ` 외 ${names.length - 20}개(find_agents 로 검색)` : ""),
          );
        }
        const agent =
          cands.find((a) => a.source === "project") ??
          cands.find((a) => a.source === "plugin") ??
          cands[0]!;
        const def = await fs.readFile(agent.filePath, "utf8");

        // ★같은 창에 **같은 인자**로 또 왔으면 다시 안 띄운다 (2026-08-20 사용자 신고).
        //  모델이 한 응답에 동일 `spawn_agent` 을 두 번 발행해 에이전트가 둘 떴다(토큰 2배).
        //  병렬 팬아웃은 이 기능의 목적이라 막지 않는다 — 막는 건 **동일 인자**뿐이다.
        //  조용히 삼키지 않고 로그를 남긴 뒤, 모델에겐 **이미 띄웠다는 사실**을 돌려준다.
        {
          const key = spawnKey({
            tool: "spawn_agent", name: args.name, prompt: args.prompt, path: targetCwd,
          });
          const dup = findDuplicateSpawn(parentInput.threadKey, key, Date.now());
          if (dup !== undefined) {
            console.warn(
              `[spawn-dedupe] '${args.name}' 를 같은 인자로 다시 소환하려 했습니다 — ` +
                `기존 jobId=${dup} 를 그대로 씁니다 (thread=${parentInput.threadKey}).`,
            );
            return okText(
              `'${args.name}' 는 **이미 방금 띄웠습니다** (jobId=${dup}). 같은 인자라 새로 띄우지 않았습니다.\n` +
                `그 작업이 끝나면 결과가 돌아옵니다 — 다시 부르지 말고 계속 진행하세요.`,
            );
          }
        }

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
          // ★종전엔 `""` 였고 주석이 "agent 잡은 재주입·통지를 둘 다 안 하므로" 라고
          //  단언했다. `wait:false` 가 생기면서 **그 단언이 거짓이 됐다** — detached 서브는
          //  onWorkerComplete 를 타고 소환자에게 결과를 돌려준다. 워커와 같은 근거로
          //  같은 값을 쓴다(재주입 reply 는 threadKey 로 좌표를 잡는다, worker-registry 동형).
          //  awaited 경로는 이 필드를 안 읽으므로 값이 생겨도 회귀 0.
          channelUserId: parentInput.threadKey,
          // 실행 축 — 재시작 복구가 "통지할 소환자가 있나" 를 이걸로 가른다(ADR Q0).
          detached: rawArgs.wait === false,
        });
        rememberSpawn(
          parentInput.threadKey,
          spawnKey({ tool: "spawn_agent", name: args.name, prompt: args.prompt, path: targetCwd }),
          jobId,
          Date.now(),
        );

        // 취소용 abort 핸들 (U-I4 개정, 2026-07-17) — 백그라운드 잡 카드 중지 버튼이 이
        // jobId 로 cancelJob() 을 부르면 signal 이 abort 돼 runRegionA 가 reject 한다.
        // timeoutMs 생략 = cancel-only(자동 타임아웃 없음 — 부모 턴 종속). 워커는 timeoutMs 지정.
        // ★자체 상한을 준다 (2026-07-29 검토). 종전엔 cancel-only 라 멈춘 서브에이전트가
        //  부모 턴을 브리지 천장까지 잡았다. 안쪽(이 상한)이 바깥(천장=상한+5분)보다 먼저
        //  끝나야 "무엇이 왜 끝났는지" 가 정확히 남는다 — 경계 순서 불변식의 안쪽 축.
        abort = createJobAbort(jobId, { timeoutMs: SUBAGENT_TIMEOUT_MS });

        // ─── wait:false — 소환하고 **턴을 놓는다**. 책임은 안 놓는다 (ADR 2026-08-19) ───
        //  결과는 `deliverToSummoner` 가 소환자에게 되돌린다: 매니저면 그 턴의 steering
        //  큐로, 세션이면 새 턴으로. 즉 "안 기다리지만 반드시 거둔다".
        //  ★abort 는 여기서 done() 하면 안 된다 — 자식이 아직 돌고 있고, 중지 버튼·
        //   부모 취소 캐스케이드가 이 핸들로 자식을 끊는다. detached runner 가 해제한다.
        if (rawArgs.wait === false) {
          startDetachedAgent({
            jobId,
            agent,
            def,
            prompt: args.prompt,
            targetCwd,
            parentInput,
            abort,
          });
          abort = undefined; // 아래 공통 finally 가 조기 해제하지 않도록 소유권 이전.
          return okText(
            `'${args.name}' 를 백그라운드로 시작했습니다 (jobId=${jobId}).\n` +
              `기다리지 않고 계속 진행하세요 — 끝나면 결과가 당신에게 돌아옵니다.\n` +
              `진행 상황은 list_workers, 중지는 cancel_worker 로 볼 수 있습니다.`,
          );
        }

        const childInput = buildAgentChildInput({
          jobId,
          agent,
          def,
          prompt: args.prompt,
          targetCwd,
          parentInput,
          abortSignal: abort.signal,
        });

        // lazy import — capabilities → llm-runtime/index circular 회피.
        // resolveModelChain(2026-07-14) — agent.model 이 프로파일이면 .fallback 체인까지
        //  운반(예 high→default), 레거시 티어/직접 spec 이면 단일 풀. 빈 체인 = 어댑터 디폴트.
        const { runRegionA, resolveModelChain } = await import("../index.js");
        const chain = resolveModelChain(agent.model, targetCwd);
        // ★도구 0회 신호 (2026-08-08 이관) — 종전엔 claude 어댑터의 SDK Task 경로에만 있었다.
        //  그 경로를 막으면서 신호가 **통째로 죽었다**(정리하다 발견). 위임이 우리 루프로
        //  일원화됐으니 판정도 여기로 온다 — 그리고 여기 오면서 **세 어댑터 공통**이 된다.
        //  실측 근거: 파일을 읽으라고 시켰는데 도구 0회로 값을 지어냈고(실제 0.18.0 인데
        //  "0.5.5"), 40초 대기를 17초에 백그라운드로 던지고 끝냈다. 정상 건은 9~30회 쓴다.
        //  ★단정하지 않는다 — 요약·판단만 시키면 0회가 정상이다. 실패로 닫지 않고 신호만.
        const childKey = `agent:${jobId}`;
        let childToolSteps = 0;
        const busRef = getEventBus();
        const unsub = busRef.subscribe((ev) => {
          if (ev.type !== "llm.activity") return;
          if (ev.payload?.threadKey !== childKey) return;
          // ★allowlist 다 (검토 지적, 2026-08-08). 처음엔 `kind !== "text"` 로 썼는데
          //  그건 **denylist** 라 새 kind 가 생기면 조용히 열린다. ★정직하게: 유니온의
          //  `"turn"` 은 **현재 어디서도 발행되지 않는다**(레드팀 실측) — 즉 그 위험은
          //  가정이었고 좁혀서 잃은 것도 없다. 그래도 allowlist 가 맞다(방향이 안전하다).
          //  ★단위 주의: 도구 1개당 `phase` start+end **2건**이 온다 — 이 카운터는 실제
          //   도구 수의 2배다. `=== 0` 판정에만 쓰므로 무해하지만, 0 아닌 임계를 넣거나
          //   숫자를 노출하려면 `phase` 를 봐야 한다. 원본(어댑터 `entry.seq`)도 구조적으로
          //  도구만 셌다 — 그 의미를 그대로 옮기려면 도구를 **명시적으로** 세야 한다.
          if (ev.payload?.kind !== "tool") return;
          childToolSteps += 1;
        });
        let out: RegionASdkOutput;
        try {
          out = await runRegionA(
            childInput,
            chain.length > 0 ? { chain } : undefined,
          );
        } finally {
          // 정상·throw·취소 모두 해제 — cancelHooks 누수 0(worker-registry.ts 동형 패턴).
          abort.done();
          try { unsub(); } catch { /* best-effort */ }
        }
        // ★"도구 0회" 만으로 경고하지 않는다 (2026-08-20 사용자 신고). 핑·질의·판단을
        //  시키는 스폰이 정상 용법이 되면서, 시킨 대로 한 에이전트에게 "지어냈을 수 있다"
        //  고 말하고 있었다. 판정은 `toolsWereExpected` 한 곳 — 근거는 그 파일에.
        if (childToolSteps === 0 && toolsWereExpected(args.prompt)) {
          console.warn(
            `[agent-no-tools] ${parentInput.threadKey} 서브에이전트 '${args.name}' 가 ` +
              `도구를 **한 번도 쓰지 않고** 끝났습니다(내부 스텝 0). 지시가 파일·명령 실행을 ` +
              `요구했다면 결과가 지어낸 것일 수 있습니다 — 반환 ${out.text.length}자.`,
          );
          try {
            busRef.publish({
              // ★`worker.` 접두 금지 — sse.js 가 worker.* 를 타입 없이 블라인드 라우팅해
              //  상태 없는 페이로드가 카드 상태를 건드린다. 이건 잡 생애주기가 아니라 품질 신호다.
              type: "llm.agent_no_tools",
              ts: Date.now(),
              payload: {
                channel: parentInput.channel,
                threadKey: parentInput.threadKey,
                jobId,
                agentName: args.name,
                task: args.prompt.slice(0, 200),
                resultChars: out.text.length,
              },
            });
          } catch { /* best-effort — 관측 실패가 완료를 무르지 않는다 */ }
        }
        markDone(jobId, out.text); // 관측 완료 — 재주입 없음(결과는 아래 return 으로 부모 회수).
        return okText(out.text);
      } catch (e) {
        // 위 finally 가 이미 abort.done() 을 부르므로 여기서 재호출 불요(멱등이라도 무해).
        const isCancelled = e instanceof WorkerCancelledError;
        const msg = isCancelled
          ? "사용자 요청으로 취소되었습니다."
          : e instanceof Error
            ? e.message
            : String(e);
        // #1 가드(markDone/markFailed 의 status==="cancelled" 보존)가 있어 여기서 markFailed 를
        // 불러도 이미 cancelled 인 잡은 뒤집히지 않는다 — 안전하게 그대로 호출.
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
