/**
 * V7.3 — provider-agnostic 슬래시 커맨드 (사용자 정의 prompt 매크로) registry.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v73-slash-commands.md`
 *  - Claude Code 표준 슬래시 커맨드: `.claude/commands/<name>.md`.
 *    본문 = LLM 에 보내는 prompt template. `$ARGUMENTS` = 전체 인자 치환.
 *    frontmatter (optional): `description` / `argument-hint` / `model` 등.
 *  - V7.2.a `agent-registry.ts` 동형 (`<name>.md` 직접 파일 구조).
 *
 * LLM-agnostic 핵심 (README 능력 매트릭스 "슬래시 명령 — 채널 어댑터에서 파싱"):
 *  - 슬래시는 *채널 입구* (`src/index.ts`) 단일 지점에서 확장 → 영역 A(runRegionA)
 *    로 일반 prompt 전달. codex/claude 어느 어댑터든 자동 동등 (LLM 무관).
 *  - 하드코딩 데몬 기능 슬래시 (`/memo`/`/schedule`/`/plugins` 등) 와 분리 —
 *    하드코딩 미매치 시에만 본 registry fallthrough (데몬 기능 보호).
 *
 * 정책 게이트:
 *  - dep 추가 0. frontmatter 파서는 `skill-registry.ts` `parseFrontmatter` 재사용.
 *  - 매 호출 fs read (cache 0). V7.5+ cache 후속.
 *  - V9.3 — 세 source walk 가 tiguclaw 런타임 컨벤션으로 전환:
 *    user = `getPaths().commonCommands`(=`<home>/commands`) + project = `projectScope(cwd).commands`
 *    (=`<cwd>/commands`) + plugin = `<cwd>/plugins/<plugin>/commands/` (앱 번들, cwd 전파 안 함).
 *  - frontmatter 는 *optional* — agent/skill 과 달리 슬래시 본문 자체가 prompt
 *    이므로 frontmatter 없어도 유효 (name = 파일 basename, description = "").
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../llm-runtime/capabilities/skill-registry.js";
import { dedupeBySource } from "../llm-runtime/capabilities/dedup-by-source.js";
import { appRoot, getPaths, projectScope, projectScopeLegacy } from "../paths.js";

export interface Command {
  /** 슬래시 이름 = 파일 basename (확장자 제외). `/name` 으로 호출. */
  name: string;
  /** frontmatter `description` (optional, 인덱스 표시용). 미존재 시 "". */
  description: string;
  /** absolute .md path. `expandCommand` 가 매 호출 read. */
  filePath: string;
  /** 발견 출처 — "user" | "project" | "plugin". */
  source: "user" | "project" | "plugin";
  /** source === "plugin" 시 plugin id. */
  pluginId?: string;
}

/**
 * 세 source walk → 모든 슬래시 커맨드 회수 (V9.3 — tiguclaw 컨벤션 + cwd 인자화).
 * cwd 기본값 `process.cwd()` → 무인자 호출은 현 동작 동일 (회귀 0). cwd 는 user/project
 * 에만 영향 — plugins 줄은 앱 번들이라 `appRoot()/plugins` (α 2026-05-25: cwd 무관 앱
 * 설치 루트. dev=레포=cwd 동치, prod 정정).
 * 미존재 디렉터리는 빈 배열.
 *
 * V9.5 — 동일 이름 충돌 dedup(`dedupeBySource`): project > plugin > user override,
 * 이름당 1개만 (인덱스↔fetch 단일 진실). `expandCommand` 의 `project ?? plugin ?? first`
 * 와 동일 규칙을 discover 레벨로 확장. 슬래시 인덱스는 `expandCommand` 단일 경로로
 * 소비 → C-4(plugin 필터) 무관, plain dedup. (contract `_workspace/v95_architect_contract.md`)
 */
export const discoverCommands = async (
  cwd: string = process.cwd(),
): Promise<Command[]> => {
  const userRoot = getPaths().commonCommands;
  const projectRoot = projectScope(cwd).commands; // .tiguclaw/commands (우선)
  const projectLegacyRoot = projectScopeLegacy(cwd).commands; // <cwd>/commands (deprecated 폴백)
  // 플러그인 2루트 (2026-05-27): 번들(appRoot, 앱 배포 코드) + 유저 설치(<home>/plugins).
  const bundledPluginsRoot = path.join(appRoot(), "plugins");
  const homePluginsRoot = getPaths().commonPlugins;

  const [userCmds, projectCmds, projectLegacyCmds, bundledPluginCmds, homePluginCmds] =
    await Promise.all([
      walkCommandsDir(userRoot, "user"),
      walkCommandsDir(projectRoot, "project"),
      walkCommandsDir(projectLegacyRoot, "project"),
      walkPluginsCommands(bundledPluginsRoot),
      walkPluginsCommands(homePluginsRoot),
    ]);

  return dedupeBySource([
    ...userCmds,
    ...projectCmds, // .tiguclaw/ 우선 — 같은 이름은 신규가 이기게 legacy 앞에.
    ...projectLegacyCmds,
    ...bundledPluginCmds,
    ...homePluginCmds,
  ]);
};

/**
 * 단일 commands 디렉터리 walk — 안의 `*.md` 파일 직접 순회 (agent-registry 동형).
 * 부재 디렉터리는 빈 배열.
 */
const walkCommandsDir = async (
  root: string,
  source: "user" | "project" | "plugin",
): Promise<Command[]> => {
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
    mdFiles.map((filePath) => loadSingleCommand(filePath, source)),
  );
  return loaded.filter((c): c is Command => c !== null);
};

/** `<cwd>/plugins/<plugin>/commands/` walk — V7.2.a walkPluginsAgents 동형. */
const walkPluginsCommands = async (pluginsRoot: string): Promise<Command[]> => {
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
      const cmdsDir = path.join(dir, "commands");
      const cmds = await walkCommandsDir(cmdsDir, "plugin");
      return cmds.map((c) => ({ ...c, pluginId: id }));
    }),
  );

  return perPlugin.flat();
};

/**
 * 단일 커맨드 .md → Command 객체.
 * frontmatter optional — name 은 항상 파일 basename (Claude Code 표준).
 * read 실패만 null (frontmatter 없어도 유효).
 */
const loadSingleCommand = async (
  filePath: string,
  source: "user" | "project" | "plugin",
): Promise<Command | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const name = path.basename(filePath, ".md").trim();
  if (name === "") return null;

  // frontmatter 는 optional — 있으면 description 추출, 없으면 "".
  const frontmatter = parseFrontmatter(raw);
  const description = (frontmatter?.description ?? "").trim();

  return {
    name,
    description,
    filePath: path.resolve(filePath),
    source,
  };
};

/**
 * 슬래시 본문에서 frontmatter 블록 제거 → 순수 prompt template 반환.
 * frontmatter 부재 시 raw 전체.
 */
const stripFrontmatter = (raw: string): string => {
  const head = raw.replace(/^﻿/, "");
  if (!head.startsWith("---")) return raw;
  const afterOpen = head.slice(3);
  const closeMatch = afterOpen.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeMatch === null || closeMatch.index === undefined) return raw;
  // 닫는 `---` 라인 이후 본문.
  const bodyStart = 3 + closeMatch.index + closeMatch[0].length;
  return head.slice(bodyStart);
};

/**
 * 슬래시 커맨드 → 확장된 prompt.
 *  - 본문에서 frontmatter 제거.
 *  - `$ARGUMENTS` → 전체 args 치환 (Claude Code 표준).
 *  - 미발견 시 undefined.
 *
 * 우선순위: project > plugin > user.
 * `$1`/`$2` 위치 인자는 V7.3.1 후속 (현재 `$ARGUMENTS` 만).
 */
export const expandCommand = async (
  name: string,
  args: string,
  cwd: string = process.cwd(),
): Promise<string | undefined> => {
  const commands = await discoverCommands(cwd);
  const candidates = commands.filter((c) => c.name === name);
  if (candidates.length === 0) return undefined;
  const project = candidates.find((c) => c.source === "project");
  const plugin = candidates.find((c) => c.source === "plugin");
  const chosen = project ?? plugin ?? candidates[0]!;

  let raw: string;
  try {
    raw = await fs.readFile(chosen.filePath, "utf8");
  } catch {
    return undefined;
  }

  const body = stripFrontmatter(raw).trim();
  // $ARGUMENTS 치환 — 전역. args 빈 문자열이면 빈 치환.
  return body.replaceAll("$ARGUMENTS", args);
};

/**
 * 슬래시 인덱스 (텔레그램 setMyCommands·도움말 등 향후 활용).
 * 비어 있으면 빈 문자열.
 */
export const formatCommandIndex = (commands: ReadonlyArray<Command>): string => {
  if (commands.length === 0) return "";
  const lines = commands.map(
    (c) => `- /${c.name}${c.description ? ` — ${c.description}` : ""}`,
  );
  return lines.join("\n");
};
