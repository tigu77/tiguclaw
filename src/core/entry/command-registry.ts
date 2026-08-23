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

/**
 * 빌트인(하드코딩) 슬래시 명령의 채널중립 표현 — 커스텀 `Command` 와 달리 파일이 없다.
 * 채널 입구(`src/index.ts`)가 command-registry fallthrough *이전에* 하드코딩 매치하는
 * 데몬 기능 슬래시. 여기 정의가 그 목록의 단일 canonical 소스.
 */
export interface BuiltinCommand {
  /** 슬래시 이름(선행 슬래시 제외). `/name` 으로 호출. */
  name: string;
  /** 사용자 노출 설명(텔레그램 메뉴·대시보드·MCP 인덱스 공용). */
  description: string;
}

/**
 * ★빌트인 슬래시 명령의 단일 canonical 소스 (진실 = `src/index.ts` 하드코딩 분기).
 *
 * 목적: 이전엔 이 목록이 3곳(telegram refreshMenu 배열·command-tools-mcp 예약어 Set·
 * index.ts 분기)에 중복·drift 됐다(채널마다 명령이 다르게 보임 = 원칙 4 단일 인격 위반).
 * 이제 텔레그램·대시보드·MCP 가 모두 이 상수(또는 `getAllCommands`)를 소비한다.
 *
 * 신규 빌트인 슬래시를 `src/index.ts` 에 추가하면 반드시 여기에도 한 줄 추가할 것.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  // ★`/reset` 은 뺐다 (2026-08-20 사용자 결정) — `/clear` 와 거의 같은데 되돌릴 수 없이
  //  대화 이름·모델 설정·탭까지 지웠다. 치우고 싶으면 **보관**(archive)이 있다.
  { name: "clear", description: "대화 컨텍스트 초기화 (이름·설정은 유지)" },
  { name: "compact", description: "대화 압축 — 오래된 대화를 요약으로 접는다(최근 대화는 원문 유지)" },
  { name: "memo", description: "메모리 추가" },
  { name: "forget", description: "메모리 삭제" },
  { name: "memos", description: "메모리 목록 조회" },
  { name: "plugins", description: "설치·활성 플러그인 목록" },
  { name: "agents", description: "진행 중인 백그라운드 작업(매니저·서브에이전트)" },
  { name: "status", description: "시스템 상태" },
  { name: "restart", description: "데몬 재시작" },
  { name: "update", description: "tiguclaw 최신으로 업데이트" },
  { name: "cooldown", description: "백엔드 쿨다운 조회·해제(재인증·한도 회복 시)" },
  { name: "sessions", description: "세션 선택·생성·보관(목록·전환·new·archive)" },
  { name: "model", description: "세션 메인 모델 선택/조회" },
  { name: "models", description: "모델 프로파일 목록 표시" },
  { name: "schedule", description: "스케줄 관리(목록·삭제·활성·비활성)" },
  { name: "stop", description: "진행 중 턴 중단" },
] as const;

/**
 * **휘발성 명령** — 그 대화방에만 보이고 기록에 안 남는 슬래시 (2026-08-23).
 *
 * ★판정을 여기 한 곳에 둔다. 소비처가 둘이라 각자 적으면 갈린다:
 *  ①채널 입구가 **인바운드 에코**를 건너뛰고(명령 자체가 안 남게)
 *  ②`replyCommand(..., {ephemeral:true})` 가 **응답 관측**을 건너뛴다.
 *  종전엔 ②만 있어서 **절반만 휘발**했다 — 답은 사라지는데 명령은 남아, 대화 기록에
 *  *답 없는 명령 버블*이 남았다(라이브 DB 실측 140행). 짝이 있을 때보다 오히려 어색하다.
 *
 * ★대상 기준: **그 방의 설정을 바꾸는 조작 확인**만. 대화·결과 보고는 기록이 곧 가치라
 *  절대 넣지 마라(넣으면 이력에서 조용히 사라진다).
 */
/**
 * 슬래시 명령 한 줄을 가른다 — **핸들러와 판정이 같은 문을 쓰게 하는 유일한 파서**.
 *
 * ★두 벌이면 갈린다. 실제로 하루에 두 번 갈렸다(2026-08-23):
 *   ①판정은 원문 접두 매칭인데 핸들러는 `split(/\s+/)` → `/sessions  use x`(공백 2개)가
 *     핸들러엔 `use` 인데 판정엔 아니었다
 *   ②그걸 고치며 판정만 명령 토큰을 소문자로 접었는데 핸들러는 `cmd === "/sessions"` 로
 *     구분 비교 → `/SESSIONS use x` 가 반대 방향으로 갈렸다
 *   두 번 다 결과는 같다: **명령과 답 중 한쪽만 사라진다.** 검사를 더 짜는 대신 갈릴 수
 *   있는 구조를 없앤다. [[feedback_hand_maintained_lists]]
 *
 * 규칙(핸들러의 기존 동작 그대로): 명령 토큰은 **대소문자 구분**, 하위명령은 소문자로 접는다.
 */
export const parseSlashCommand = (
  text: string,
): { cmd: string; args: string; sub: string; rest: string } => {
  const trimmed = (typeof text === "string" ? text : "").trim();
  const sepIdx = trimmed.search(/\s/);
  const cmd = sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx);
  const args = sepIdx === -1 ? "" : trimmed.slice(sepIdx + 1).trim();
  const sub = args === "" ? "" : (args.split(/\s+/)[0] ?? "").toLowerCase();
  const rest = args.slice(sub.length).trim(); // 하위명령 뒤 나머지(대상 id 등).
  return { cmd, args, sub, rest };
};

/** 이 입력이 휘발성 명령인가 — 입구(에코 스킵)와 응답(관측 스킵)이 같은 답을 쓰게. */
export const isEphemeralCommandText = (text: string): boolean => {
  const { cmd, sub, rest } = parseSlashCommand(text);
  if (cmd !== "/sessions") return false;
  // ★**선택지를 띄우는 호출은 휘발**이다 (2026-08-23 4라운드). 인자 없는 `/sessions` 와
  //  인자 없는 `archive|unarchive` 는 목록/선택 UI 이지 대화가 아니다. 그런데 그 응답은
  //  **어느 채널에서도 기록되지 않는다** — `presentOptions` 는 cli=stdout, telegram=
  //  `ctx.reply` 라 버스를 안 타고, `prompt.options` 를 발행하는 http-bridge 는 이 분기에
  //  오지도 않는다(`hasSelector` 로 조기 반환). 실측: CLI 에서 `/sessions` 를 치면
  //  chat_log 에 `user:/sessions` 만 남는다 — **답 없는 명령 버블**, 우리가 4점으로
  //  고쳤다던 그 모양 그대로다. 명령만 남기느니 짝을 맞춰 둘 다 안 남긴다.
  //  ★선택 결과는 잃지 않는다 — 번호를 고르면 `/sessions archive <id>` 가 다시 들어오고
  //   **그 쌍은 기록된다**(상태 변경이므로). 조회는 휘발, 변경은 기록.
  // ★**열거가 아니라 판정이다** (2026-08-24 5라운드). 종전엔 하위명령을 열거하고
  //  기본값을 `false`(=기록)로 뒀는데, **핸들러의 기본 분기가 곧 선택지 분기**다
  //  (`/sessions foo`·`/sessions list`·`/sessions rename` 전부 선택지로 답한다).
  //  두 기본값이 정반대라 미지 하위명령마다 **답 없는 명령 버블**이 남았다 — 실측:
  //  `user:/sessions foo` 만 남고 답이 없다. 우리가 3점으로 닫았다고 선언한 그 모양이다.
  //  뒤집는다: **기록되는 것은 id 를 동반한 상태 변경뿐**이고 나머지는 전부 휘발이다
  //  (핸들러의 분기 구조와 동형이라 새 하위명령이 생겨도 안 갈린다).
  //  [[feedback_hand_maintained_lists]] 이름 열거를 새로 만들려는 순간 멈춰라.
  return !((sub === "archive" || sub === "unarchive") && rest !== "");
};

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

/**
 * ★빌트인 + 발견 커스텀 슬래시 명령의 병합 목록 — 채널중립 `{name, description}[]`.
 *
 * 텔레그램·대시보드·MCP 가 공통으로 소비하는 단일 진입점. 채널별 변환(정규식 필터·slice·
 * `{command}` 리네임 등)은 각 어댑터에 잔류시키고, 여기선 순수 목록만 낸다.
 *
 * happy path 에 예외를 묻지 않도록 try/catch 는 이 병합 경계에만 둔다: `discoverCommands`
 * 가 던지면(fs 오류 등) 빌트인만이라도 반환해 명령 메뉴가 통째로 사라지지 않게 한다.
 */
export const getAllCommands = async (cwd?: string): Promise<BuiltinCommand[]> => {
  const builtins = BUILTIN_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
  }));
  let discovered: Command[] = [];
  try {
    discovered = await discoverCommands(cwd);
  } catch {
    return builtins;
  }
  return [
    ...builtins,
    ...discovered.map((c) => ({ name: c.name, description: c.description })),
  ];
};
