/**
 * 영역 A V7.0 — provider-agnostic skill registry.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-codex-skill-discovery.md`
 *  - OpenClaw 답습:
 *    `~/work/tiguclaw-dev/openclaw/src/agents/skills/local-loader.ts`
 *      L96-109 `listCandidateSkillDirs` — `.`/`node_modules` prefix 제외
 *      L44-94  `loadSingleSkillDirectory` — SKILL.md frontmatter 파싱
 *      L209-219 `resolveSkillInvocationPolicy` — `disable-model-invocation` 디폴트 false
 *      L21-42 `readSkillFileSync` 의 try/catch 본체 (안전 read)
 *
 * 정책 게이트:
 *  - dep 추가 0. yaml frontmatter 파서는 자체 답습 (OpenClaw `markdown/frontmatter`
 *    의존 그대로 끌어오면 monorepo 외부 의존 폭주 → `---\n...\n---` 한 블록만 처리
 *    하는 단순 파서로 충분).
 *  - 매 호출 fs read — cache 0 (본 라운드 단순). V7.5+ cache 후속.
 *  - V9.3 — 디렉터리 walk 가 tiguclaw 런타임 컨벤션으로 전환:
 *    user = `getPaths().commonSkills`(=`<home>/skills`) + project = `projectScope(cwd).skills`
 *    (=`<cwd>/skills`). (`.claude` → tiguclaw 자체 컨벤션, ADR 2026-05-24-v9-runtime-home.)
 *    user-level + project-level 두 source 구분 박음 (`source: "user" | "project"`).
 *  - 부재 디렉터리는 빈 배열 (OpenClaw L97-108 try/catch 답습 — readdirSync throw 흡수).
 *  - 루트 자체 SKILL.md (단일 스킬 디렉터리) 우선 — 부재 시 서브디렉터리 walk
 *    (OpenClaw L123-145 답습).
 *  - frontmatter 키 → `name`, `description` 필수. 누락 시 skill drop
 *    (OpenClaw L67-72 답습). `disable-model-invocation: true` 면 `disableModelInvocation`
 *    박음 — `formatSkillIndex` 에서 제외.
 *
 * provider-agnostic 위치 (`src/core/`) — 향후 V7.1+ 플러그인 발견 통합과
 * 충돌 0. claude·codex 양 어댑터가 본 모듈을 호출한다 (claude 는 SDK 격리 모드라
 * `.claude` 자동발견 0 → discoverSkills 로 전체 인덱스 직접 구성, codex 도 동일).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { appRoot, getPaths, projectScope, projectScopeLegacy } from "../../paths.js";
import { getEventBus } from "../../eventbus.js";
import type { ChannelName } from "../../../channels/types.js";
import { dedupeBySource } from "./dedup-by-source.js";
import { listSkillUsage } from "../../../store/skill-usage.js";

export interface Skill {
  /** frontmatter `name` (우선) 또는 디렉터리 basename. */
  name: string;
  /** frontmatter `description` 필수 — 미존재 시 skill drop. */
  description: string;
  /** absolute SKILL.md path. `getSkillBody` 가 매 호출 read. */
  filePath: string;
  /** absolute skill 디렉터리 (filePath 의 parent). */
  baseDir: string;
  /**
   * 발견 출처 (V9.3+ — tiguclaw 런타임 컨벤션):
   *  - "builtin": `appRoot()/skills` (앱과 함께 배포되는 부트스트랩 기본 스킬)
   *  - "user": `getPaths().commonSkills` (=`<home>/skills`, 공통 스킬)
   *  - "project": `projectScope(cwd).skills` (=`<cwd>/skills`, 프로젝트 스킬)
   *  - "plugin": `<root>/plugins/<plugin>/skills/` (앱 번들/홈 플러그인 자산.
   *    Claude Agent SDK 가 자동 발견 못 함. invoke_skill MCP server 로 보강).
   */
  source: "builtin" | "user" | "project" | "plugin";
  /** frontmatter `disable-model-invocation: true` 시 true. 디폴트 false. */
  disableModelInvocation: boolean;
  /**
   * source === "plugin" 시 plugin id (디렉터리 이름). 그 외 undefined.
   * 디버깅·관측·향후 plugin enable/disable 정책 분기용.
   */
  pluginId?: string;
}

/**
 * 세 source walk → 모든 스킬 회수 (V9.3 — tiguclaw 런타임 컨벤션 + cwd 인자화).
 *  - user: `getPaths().commonSkills` (=`<home>/skills`)
 *  - project: `projectScope(cwd).skills` (=`<cwd>/skills`)
 *  - plugin: `<cwd>/plugins/<plugin>/skills/` (V7.1 — 앱 번들 자산. cwd 전파 안 함.)
 *
 * cwd 기본값 `process.cwd()` → 무인자 호출은 현 동작 동일 (cwd 인자 회귀 0). cwd 는
 * user/project 두 source 에만 영향 — plugins 줄은 앱 번들이라 `appRoot()/plugins`
 * (α 2026-05-25: cwd 무관 앱 설치 루트. dev=레포=cwd 동치, prod 정정).
 * 미존재 디렉터리는 빈 배열 (throw 0).
 *
 * V9.5 — 동일 이름 충돌 dedup(`dedupeBySource`): project > plugin > user override,
 * 이름당 1개만 (인덱스↔fetch 단일 진실). `getSkillBody` 의 `project ?? plugin ?? first`
 * 와 동일 규칙을 discover 레벨로 확장 (contract `_workspace/v95_architect_contract.md`).
 *
 * `opts.dedupe`: 내부/테스트용 escape hatch (dedup 전 원본 회수). 현재 프로덕션
 * 사용처 0 — claude·codex 어댑터 모두 기본 deduped 전체 인덱스를 쓴다
 * (parity, 2026-05-25 격리 fix 로 C-4 plugin-only 워크어라운드 소멸).
 */
export const discoverSkills = async (
  cwd: string = process.cwd(),
  opts: { dedupe?: boolean } = {},
): Promise<Skill[]> => {
  // builtin (2026-06-06): 앱과 함께 배포되는 부트스트랩 스킬 (`appRoot()/skills`).
  //  harness 같은 메타 능력은 외부 플러그인이 아닌 *티구클로 기본 시동 장치* 라
  //  설치 직후부터 항상 발견되어야 함. dedup 우선순위 최하 — 사용자가 홈에 같은
  //  이름을 두면 home(user) override 가 이김 ("기본 번들 + 홈 오버라이드" 모델).
  const builtinRoot = path.join(appRoot(), "skills");
  const userRoot = getPaths().commonSkills;
  const projectRoot = projectScope(cwd).skills; // .tiguclaw/skills (우선)
  const projectLegacyRoot = projectScopeLegacy(cwd).skills; // <cwd>/skills (deprecated 폴백)
  // 플러그인 2루트 (2026-05-27): 번들(appRoot, 앱 배포 코드) + 유저 설치(<home>/plugins).
  const bundledPluginsRoot = path.join(appRoot(), "plugins");
  const homePluginsRoot = getPaths().commonPlugins;

  const [
    builtinSkills,
    userSkills,
    projectSkills,
    projectLegacySkills,
    bundledPluginSkills,
    homePluginSkills,
  ] = await Promise.all([
    walkSkillsRoot(builtinRoot, "builtin"),
    walkSkillsRoot(userRoot, "user"),
    walkSkillsRoot(projectRoot, "project"),
    walkSkillsRoot(projectLegacyRoot, "project"),
    walkPluginsRoot(bundledPluginsRoot),
    walkPluginsRoot(homePluginsRoot),
  ]);

  const all = [
    ...builtinSkills,
    ...userSkills,
    ...projectSkills, // .tiguclaw/ 우선 — 같은 이름은 신규가 이기게 legacy 앞에.
    ...projectLegacySkills,
    ...bundledPluginSkills,
    ...homePluginSkills,
  ];
  return opts.dedupe === false ? all : dedupeBySource(all);
};

/**
 * V7.1 — `<cwd>/plugins/<plugin>/skills/` walk.
 * OpenClaw `resolvePluginSkillDirs` (`agents/skills/plugin-skills.ts` L46-120) 답습:
 *  - 각 plugin 디렉터리 순회 (sort + `.`/`node_modules` 제외, V7.0 listCandidateSkillDirs 동형).
 *  - 각 plugin 의 `skills/` 서브디렉터리 회수.
 *  - path escape 가드는 V7.0 walkSkillsRoot 의 realpath 검사로 자연 흡수
 *    (각 plugin 의 skills/ 가 root 가 됨).
 *  - manifest `tiguclaw.skills` 명시 선언은 V7.x 후속 (현재 0 plugin 이 사용).
 *
 * 부재 plugins/ 디렉터리는 빈 배열.
 */
const walkPluginsRoot = async (pluginsRoot: string): Promise<Skill[]> => {
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
      const skillsDir = path.join(dir, "skills");
      const skills = await walkSkillsRoot(skillsDir, "plugin");
      return skills.map((s) => ({ ...s, pluginId: id }));
    }),
  );

  return perPlugin.flat();
};

/**
 * 단일 root 디렉터리 walk.
 * (a) root 자체에 SKILL.md 있으면 단일 스킬로 회수 (OpenClaw L123-134).
 * (b) 부재 시 서브디렉터리 candidate 들 (L96-109 의 `listCandidateSkillDirs`)
 *     순회하며 SKILL.md 파싱.
 */
const walkSkillsRoot = async (
  root: string,
  source: "builtin" | "user" | "project" | "plugin",
): Promise<Skill[]> => {
  // OpenClaw L116-121 답습 — root realpath. 부재 시 빈 배열.
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return [];
  }

  // (a) root 자체에 SKILL.md — 단일 스킬 디렉터리.
  const rootSkill = await loadSingleSkillDirectory(rootReal, source);
  if (rootSkill !== null) {
    return [rootSkill];
  }

  // (b) 서브디렉터리 candidate 들 — OpenClaw L96-109 답습.
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(rootReal, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidateDirs = entries
    .filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    )
    .map((e) => path.join(rootReal, e.name))
    .sort((a, b) => a.localeCompare(b));

  const loaded = await Promise.all(
    candidateDirs.map((dir) => loadSingleSkillDirectory(dir, source)),
  );
  return loaded.filter((s): s is Skill => s !== null);
};

/**
 * 단일 스킬 디렉터리에서 SKILL.md frontmatter 파싱 → Skill 객체.
 * OpenClaw L44-94 `loadSingleSkillDirectory` 답습.
 *
 * 누락 케이스:
 *  - SKILL.md 부재 → null
 *  - frontmatter 파싱 실패 → null
 *  - `name` / `description` 누락 → null (OpenClaw L70-72)
 */
const loadSingleSkillDirectory = async (
  skillDir: string,
  source: "builtin" | "user" | "project" | "plugin",
): Promise<Skill | null> => {
  const filePath = path.join(skillDir, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  if (frontmatter === null) return null;

  const fallbackName = path.basename(skillDir).trim();
  const name = (frontmatter.name ?? "").trim() || fallbackName;
  const description = (frontmatter.description ?? "").trim();
  if (name === "" || description === "") return null;

  // OpenClaw L209-219 답습 — `disable-model-invocation` 디폴트 false.
  const disableModelInvocation = parseBool(
    frontmatter["disable-model-invocation"],
    false,
  );

  return {
    name,
    description,
    filePath: path.resolve(filePath),
    baseDir: path.resolve(skillDir),
    source,
    disableModelInvocation,
  };
};

/**
 * 단순 yaml `---` frontmatter 파서.
 *
 * OpenClaw 의 `parseFrontmatterBlock` (markdown/frontmatter.ts) 답습이되,
 * monorepo 외부 의존 회피용 자체 구현. 본 라운드 frontmatter 가 단순 (key: value
 * 라인만, multi-line/quoted/nested 0).
 *
 * shape:
 *   ---
 *   key1: value1
 *   key2: value 2 with spaces
 *   ---
 *   본문...
 *
 * 반환: 키/값 record. frontmatter block 부재 또는 닫는 `---` 부재 시 null.
 */
export const parseFrontmatter = (
  raw: string,
): Record<string, string> | null => {
  // 첫 `---` 라인 검사 — BOM 허용.
  const head = raw.replace(/^﻿/, "");
  if (!head.startsWith("---")) return null;
  const afterOpen = head.slice(3);
  // 닫는 `---` 위치 — 라인 시작이어야 함.
  const closeMatch = afterOpen.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeMatch === null || closeMatch.index === undefined) return null;
  const block = afterOpen.slice(0, closeMatch.index);
  const lines = block.split(/\r?\n/);
  const result: Record<string, string> = {};
  for (const line of lines) {
    // 빈 라인 skip. 주석(#)도 skip.
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // 둘러싼 따옴표 제거 (yaml 표준 일부 답습 — 단순한 면만).
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") result[key] = value;
  }
  return result;
};

/**
 * OpenClaw `parseFrontmatterBool` (shared/frontmatter.ts) 답습 —
 * "true"/"false"/"1"/"0"/"yes"/"no" 케이스. 미지정 시 defaultValue.
 */
export const parseBool = (
  raw: string | undefined,
  defaultValue: boolean,
): boolean => {
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return defaultValue;
};

/**
 * 스킬 인덱스 → 작동 컨텍스트(어댑터 시스템 채널) 주입용 문자열.
 * `disableModelInvocation: true` 는 제외 (LLM 자동 호출 금지 정책).
 * 비어 있으면 빈 문자열 — 호출자가 주입 skip.
 *
 * ★안정 조각이다 — 같은 스킬 집합이면 **바이트 동일**해야 한다(prompt-assembly
 * splitSystemContext). 여기 순서를 턴마다 변하는 값으로 정하지 마라.
 */
// ─── 능력 인덱스 스케일링 (ADR 2026-07-07-capability-index-scaling) ──────────
// 상한 K — 스킬/에이전트가 아무리 많아져도 상시 프롬프트 무게를 바운드. 하드코딩
// 상수(env 플래그로 빼지 않음 — future-config 안티패턴 회피). 총 ≤K 면 전부 표시
// (현행 동일·회귀 0), >K 면 상위 K + find_skills 검색 안내.
const SKILL_INDEX_CAP = 40;

// 사용빈도 랭킹 재료 — skill_usage(일반 store 테이블, self-growth 가 채움). 코어는
// opportunistic read(빈 테이블·미초기화 시 무랭킹 폴백 — 플러그인 *의존* 아님).
const skillUsageRank = (): Map<string, number> => {
  try {
    return new Map(
      listSkillUsage({ limit: 500 }).map((r) => [r.skillName, r.invokeCount]),
    );
  } catch {
    return new Map();
  }
};

export const formatSkillIndex = (skills: ReadonlyArray<Skill>): string => {
  const invocable = skills.filter((s) => !s.disableModelInvocation);
  if (invocable.length === 0) return "";
  // 헤더 다음 한 줄 — codex 측에 invoke 도구 이름 명시. sysprompt L18-22 의
  // "하네스 라우팅 — 적합 스킬 호출" 추상 지시를 *도구 이름* 으로 구체화.
  const header = `## 사용 가능 스킬\n\n적합한 스킬을 발견하면 \`invoke_skill({name})\` 도구로 본문 (frontmatter+가이드) 을 로드한 뒤 그 본문에 따라 행동하세요.`;
  const fmt = (list: ReadonlyArray<Skill>) =>
    list.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  // 캡 이하 — 전부 표시(현행과 동일, 회귀 0).
  if (invocable.length <= SKILL_INDEX_CAP) {
    return `${header}\n\n${fmt(invocable)}`;
  }
  // 캡 초과 — 사용빈도순 상위 K + 검색 안내(상시 무게 바운드). Array.sort 안정정렬로
  // 동점은 입력(discover) 순서 유지.
  // ★빈도는 **선정에만** 쓰고 **표시는 discover 순서**로 되돌린다 (2026-07-30):
  //  이 인덱스는 이제 시스템 채널(프리픽스 캐시 대상)에 실린다. 빈도순 그대로 렌더하면
  //  invoke_skill 한 번이 카운트를 올려 다음 턴 문자열이 달라지고 — 스킬이 캡을 넘는
  //  순간부터 — "스킬을 쓴 턴 다음 턴"마다 30KB 캐시가 통째로 깨진다. 선정 집합이
  //  바뀔 때만 문자열이 바뀌게 하면 무효화가 실제 변화에만 국한된다.
  const usage = skillUsageRank();
  const order = new Map(invocable.map((s, i) => [s.name, i]));
  const top = [...invocable]
    .sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0))
    .slice(0, SKILL_INDEX_CAP)
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  const rest = invocable.length - SKILL_INDEX_CAP;
  return `${header}\n\n자주 쓰는 ${SKILL_INDEX_CAP}개만 표시합니다. 나머지 ${rest}개는 \`find_skills({query})\` 로 검색하세요.\n\n${fmt(top)}`;
};

/**
 * 스킬 이름 → SKILL.md raw 본문 (frontmatter 포함).
 * 매 호출 fs read (cache 0). 미발견 시 undefined.
 *
 * 이름 매칭 우선순위 — project source 가 user 보다 우선 (project 가 cwd 컨텍스트
 * 정확). 동일 source 안에서는 발견 순서.
 */
export const getSkillBody = async (
  name: string,
  cwd: string = process.cwd(),
): Promise<string | undefined> => {
  const skills = await discoverSkills(cwd);
  const candidates = skills.filter((s) => s.name === name);
  if (candidates.length === 0) return undefined;
  // 우선순위 (2026-06-06 갱신, dedupeBySource 와 동일):
  //   project > user(home) > plugin > builtin (=appRoot/skills).
  // discoverSkills 기본 deduped 라 candidates.length===1 인 경우가 대부분 (find 들이
  // 사실상 redundant). dedupe=false escape hatch 시 명시 우선순위로 안전 선택.
  const project = candidates.find((s) => s.source === "project");
  const user = candidates.find((s) => s.source === "user");
  const plugin = candidates.find((s) => s.source === "plugin");
  const builtin = candidates.find((s) => s.source === "builtin");
  const chosen = project ?? user ?? plugin ?? builtin ?? candidates[0]!;
  try {
    return await fs.readFile(chosen.filePath, "utf8");
  } catch {
    return undefined;
  }
};

// ─── invoke_skill MCP server (V7.1) ──────────────────────────────────────
// 비표준 위치 paradox 해소: Claude Agent SDK 는 자체 표준 위치(`.claude/skills/`)만
// 자동 발견 — tiguclaw 번들 `plugins/<plugin>/skills/` 는 못 봄.
// claude 어댑터에도 본 in-process MCP server 를 등록해 codex 와 능력 동등 보장.
// codex 어댑터(V7.8~)도 본 server 를 bridge 등록해 invoke_skill 노출 — file-ops-mcp
// 중복 정의는 V7.8 에 제거됨(단일 정의 = skill-registry).
//
// V9.3 — 싱글톤 → `createSkillInvokeMcpServer(cwd)` factory 로 전환. 싱글톤은
// tool 핸들러가 `getSkillBody(name)` 를 cwd 없이 호출 → `process.cwd()` 해석되어,
// 스킬 인덱스(`discoverSkills(input.cwd)`)와 invoke 가 input.cwd≠process.cwd() 시
// 비대칭(인덱스엔 보이는 project 스킬을 invoke 가 미발견). spawn_agent factory 패턴을
// 미러해 cwd 를 클로저로 받아 인덱스↔invoke cwd 정합 보장.

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * invoke_skill MCP server 팩토리 (claude/codex/openai 공통).
 *  - cwd: 스킬 본문 해석 기준 디렉터리. 스킬 인덱스(`discoverSkills(cwd)`)와 동일
 *    cwd 를 받아 인덱스↔invoke 정합 보장. 미지정 시 `process.cwd()` (회귀 0).
 *  - ctx: 텔레메트리 상관 컨텍스트(채널·thread·어댑터). 지정 시 핸들러 성공 분기에서
 *    generic `skill.invoked` 이벤트를 발행한다(단일 지점 = 세 어댑터 자동 parity,
 *    contract §2.3). **미지정 시 발행 skip = 하위호환·회귀 0** (ctx 안 넘기는 기존
 *    호출 경로는 무영향). 발행은 never-throw 로 감싸 invoke_skill 도구 응답·데몬을
 *    절대 못 깨게(관측 best-effort, turn_done 발행 패턴 답습).
 *
 * V9.3 — 싱글톤 → factory. tool 핸들러가 `getSkillBody(name, cwd)` 로 cwd 전달.
 * spawn_agent 의 `createSpawnAgentMcpServer` factory 패턴 답습.
 */
export const createSkillInvokeMcpServer = (
  cwd: string = process.cwd(),
  ctx?: {
    channel: ChannelName;
    threadKey: string;
    adapter: "claude" | "codex" | "openai";
  },
): McpSdkServerConfigWithInstance => {
  const skillInvokeTool = tool(
    "invoke_skill",
    "발견된 스킬의 SKILL.md raw 본문 (frontmatter 포함) 을 반환합니다. 사용 가능 스킬 인덱스는 작동 컨텍스트의 `## 사용 가능 스킬` 섹션에 이미 실려 있습니다. **`path`(폴더 경로)를 주면 그 폴더의 `skills/` 기준으로 스킬을 찾습니다 — 다른 프로젝트/폴더 전용 스킬을 '들어가지 않고' 그 자리에서 사용할 때. 그 폴더에 무슨 스킬이 있는지는 project_capabilities 로 먼저 확인하세요. 미지정 시 현재 컨텍스트 기준.**",
    {
      name: z.string().min(1),
      path: z.string().optional(),
    },
    async (args) => {
      try {
        // ★path(2026-07-07) — 지정 시 그 폴더 기준으로 스킬 발견(상대경로는 현재 cwd
        // 기준 절대화). 마스터가 enter 없이 임의 폴더 전용 스킬을 per-call 로 사용.
        // 미지정 시 현재 cwd(회귀 0). V9.3 — 인덱스(discoverSkills(cwd))와 동일 컨텍스트.
        const resolveCwd =
          args.path !== undefined ? path.resolve(cwd, args.path) : cwd;
        const body = await getSkillBody(args.name, resolveCwd);
        if (body === undefined) {
          return errText(`스킬 '${args.name}' 미발견.`);
        }
        // 텔레메트리 — 성공 호출(body !== undefined)만 generic skill.invoked 발행.
        // ctx 미지정 시 skip(회귀 0). never-throw — 관측 실패가 도구 응답·데몬을
        // 절대 못 깨게(turn_done 발행 best-effort 패턴 답습). 코어는 어느 스킬인지
        // 모름(generic) — self-growth 가 데이터로만 소비(단방향).
        if (ctx !== undefined) {
          try {
            getEventBus().publish({
              type: "skill.invoked",
              ts: Date.now(),
              payload: {
                name: args.name,
                channel: ctx.channel,
                threadKey: ctx.threadKey,
                adapter: ctx.adapter,
              },
            });
          } catch {
            // 발행 실패 무시 — 관측 best-effort. 스킬 실행 결과는 그대로 반환.
          }
        }
        return okText(body);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // find_skills — 인덱스가 상한(SKILL_INDEX_CAP)으로 잘렸을 때, 필요한 스킬을
  // 이름/키워드로 검색(ADR 2026-07-07-capability-index-scaling). 부분일치(임베딩 없음),
  // 사용빈도순. throw 0(에러텍스트). cwd 는 인덱스와 동일 소스라 인덱스↔검색 정합.
  const findSkillsTool = tool(
    "find_skills",
    "이름·설명에 query 가 포함된 스킬을 검색합니다. 사용 가능 스킬이 많아 인덱스에 다 표시되지 않을 때, 필요한 스킬을 키워드/이름 조각으로 찾을 때 사용. 사용빈도순 정렬. 찾은 뒤 invoke_skill 로 로드하세요.",
    { query: z.string().min(1) },
    async (args) => {
      try {
        const invocable = (await discoverSkills(cwd)).filter(
          (s) => !s.disableModelInvocation,
        );
        const q = args.query.toLowerCase();
        const matched = invocable.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        );
        if (matched.length === 0) {
          return errText(`'${args.query}' 에 매칭되는 스킬이 없습니다.`);
        }
        const usage = skillUsageRank();
        matched.sort(
          (a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0),
        );
        const lines = matched
          .slice(0, 50)
          .map((s) => `- ${s.name}: ${s.description}`);
        return okText(
          `'${args.query}' 매칭 스킬 ${matched.length}개:\n${lines.join("\n")}`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createSdkMcpServer({
    name: "skills",
    version: "1.1.0",
    tools: [skillInvokeTool, findSkillsTool],
  });
};

/**
 * SDK 빌트인 스킬 도구 이름 — **여기가 정의점**이다(어댑터가 다시 적지 않는다).
 * `SHELL_TOOL_NAMES`·`SDK_TODO_TOOL_NAMES` 와 같은 수법.
 *
 * ★왜 막는가 (2026-08-15, 사용자 확정): SDK `Skill` 은 우리 스킬 인덱스가 아니라 **claude
 *  자기 자산**(`.claude/skills` + SDK 번들)을 본다. 그런데 tiguclaw 의 스킬 범위는 **의도적으로
 *  Claude 영역을 포함하지 않는다** — 가져오고 싶으면 `claude-wrapper-sync` 스킬로 래핑하는
 *  것이 정식 경로다. 그 스킬 §0 이 이유를 적어놨다: Claude Code 스킬은 `CLAUDE.md` 컨텍스트를
 *  전제하므로 **그냥 복사하면 겉돈다**. 래핑은 복사가 아니라 `PROJECT.md` 로의 **맥락 이전**이고,
 *  그래야 codex·openai 에서도 같은 맥락이 선다.
 *
 * ★즉 `Skill` 을 열어두면 claude 만 그 경계를 우회한다(실측 6건 중 5건). 같은 요청이 어댑터에
 *  따라 다르게 도는 것이고(#2 위반), 래퍼가 하는 맥락 이전도 건너뛴다. 게다가 claude 의 스킬
 *  사용이 `skill_usage` 통계에서 통째로 빠진다(실측: `invoke_skill` 33건이 전부 codex).
 *  덤으로 두 경로 공존이 만든 오호출도 있었다 — `Skill(skill=mcp__file-ops__Grep)`.
 *
 * ★잃는 것은 **SDK 번들 스킬**뿐이고 오늘 기준 `claude-api` 하나다(924KB·65파일, Anthropic 이
 *  SDK 버전마다 갱신하는 "Claude API 로 앱 만들기" 레퍼런스). 우리가 사본을 들면 벤더 문서를
 *  재구현하는 것이고(원칙 5) 그 사본은 늙는다 — 그 스킬 자체가 "네 사전 지식은 낡았다" 를
 *  경고하는 문서다. 그래서 **tiguclaw 능력이 아니라 Claude Code 제품 지식**으로 보고 경계 밖에
 *  둔다. 되돌리기는 이 배열에서 한 줄 빼면 된다.
 */
export const SDK_SKILL_TOOL_NAMES = ["Skill"] as const;
