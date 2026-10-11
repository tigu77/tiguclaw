/**
 * 데이터 기반 커스텀 슬래시 명령 — 등록/조회/삭제 MCP 도구 (region 파트).
 *
 * 진실 소스: command-registry (`src/core/entry/command-registry.ts`:
 *  `discoverCommands`/`expandCommand`/`formatCommandIndex`). 슬래시 명령 = `<home>/commands/<name>.md`
 *  (frontmatter `description:` optional + 본문 = LLM 에 보내는 prompt template, `$ARGUMENTS` 치환).
 * 동형 패턴: `endpoint-tools-mcp.ts` `createEndpointToolsMcpServer` (LLM-agnostic
 *  createSdkMcpServer 1개, 어댑터 분기 0). command-registry·telegram.ts 미변경 — import 만.
 *
 * 슬래시 명령은 *항상 prompt* 라 mode/restricted 개념이 없다(엔드포인트와 다른 점).
 * 채널 입구(`src/index.ts`)가 단일 지점에서 expandCommand 로 확장 → 영역 A 로 일반 prompt
 * 전달. codex/claude/openai 어느 어댑터든 자동 동등(LLM 무관).
 *
 * 도구 3종:
 *  - register_command → `<home>/commands/<name>.md` 작성(frontmatter description + 본문=prompt).
 *  - list_commands    → discoverCommands → formatCommandIndex.
 *  - delete_command   → `<home>/commands/<name>.md` 삭제.
 *
 * 검증·정규화 (endpoint 도구 동형):
 *  - name 정규화: 소문자·trim. isSafeName(`^[a-z0-9][a-z0-9_-]*$`, 디렉터리 탈출 방어).
 *  - 빌트인 네이티브 명령 충돌 거부(reset·memo·forget·memos·plugins·status·restart).
 *  - 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기).
 *  - `getPaths().commonCommands`(=`<home>/commands`) 에 작성, mkdir 백스톱.
 *
 * 메뉴 즉시 반영: register/delete 가 파일 쓰기/삭제 *성공 후* `commands.changed` 이벤트를
 *  publish → telegram 채널이 구독해 setMyCommands 재설정(daemon-engineer 파트). list 는 publish 안 함.
 *
 * 어댑터 등록 가드: 각 어댑터가 `!toolsNone && depth === 0 && workerDepth === 0` turn 에만
 *  등록 — endpoint/worker 도구와 *동일* 가드. lean(toolsNone) 턴엔 미노출.
 */
import { coreMcpServer } from "./_core-server.js";
import { promises as fs } from "node:fs";
import { isSafeCapabilityName } from "./_names.js";
import path from "node:path";
import {
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPaths, projectScope } from "../../paths.js";
import { findRegisteredProject } from "../../session-projects.js";
import { getEventBus } from "../../eventbus.js";
import {
  discoverCommands,
  findCommandFile,
  isWalkedCommandFolder,
  listCommandsIn,
  maxCommandFolderDepth,
  formatCommandIndex,
  BUILTIN_COMMANDS as BUILTIN_COMMANDS_ARRAY,
  UNLISTED_BUILTIN_COMMANDS,
} from "../../entry/command-registry.js";
import { onDemand } from "../tool-load-policy.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * 빌트인 네이티브 명령 예약어 — 등록 충돌 거부 대상. 채널 입구가 하드코딩 데몬 기능 슬래시를
 * command-registry fallthrough *이전에* 매치하므로, 같은 이름으로 .md 를 만들면 영원히
 * 가려진 죽은 정의가 된다. 등록 레벨에서 명시 거부해 혼동을 막는다.
 *
 * 단일 canonical 소스(`command-registry` `BUILTIN_COMMANDS`)에서 파생 — 이전엔 여기 8개만
 * 하드코딩돼 clear·agents·model·schedule·stop 이 예약어에서 빠져 커스텀 명령이 빌트인을
 * 가릴 수 있었다(갭). 이제 canonical 이 늘면 예약어도 자동 편입된다.
 */
// ★목록에 **없는** 빌트인도 예약한다 (2026-09-06 적대 검토 P2). 목록에서만 파생하면,
//  «자동완성에서 뺀다» 는 결정이 «그 이름을 남에게 연다» 로 새어 나간다.
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  ...BUILTIN_COMMANDS_ARRAY.map((c) => c.name),
  ...UNLISTED_BUILTIN_COMMANDS,
]);

/** 빌트인 이름 목록 — 도구 설명·힌트에 보간(canonical 파생, 프로즈 열거 하드코딩 방지). */
const RESERVED_NAMES = BUILTIN_COMMANDS_ARRAY.map((c) => c.name).join("·");

/**
 * name 정규화 — 소문자·trim. 선행 슬래시도 허용 입력으로 받아 제거(`/daily` → `daily`).
 */
const normalizeName = (raw: string): string =>
  raw.trim().toLowerCase().replace(/^\/+/, "").trim();

/**
 * name 안전성 — 디렉터리 탈출/숨김파일 방지. 영문 소문자·숫자·하이픈·언더스코어만.
 * 이름 판정은 `_names.ts` 가 소유한다(사본 제거 2026-08-01).
 */
// 이름 판정은 `_names.ts` 단일 정본 — 사본을 두면 조용히 갈린다(2026-08-01).
const isSafeName = isSafeCapabilityName;

/** frontmatter 값 escape — 줄바꿈 제거(파서 라인 단위) + 따옴표 래핑(콜론 안전). */
const fmValue = (raw: string): string => {
  const oneLine = raw.replace(/[\r\n]+/g, " ").trim();
  return `"${oneLine.replace(/"/g, "'")}"`;
};

/**
 * 커맨드 파일을 둘 폴더 — 전역(`<home>/commands`) 또는 등록 프로젝트의 `.tiguclaw/commands`(대화에 연결하면 그 대화의
 * 📁 메뉴·`/` 목록에 뜬다). 프로젝트를 못 찾으면 이유 문장.
 */
const commandsDirFor = (project: string | undefined): { dir: string; label: string } | { error: string } => {
  if (project === undefined || project.trim() === "") return { dir: getPaths().commonCommands, label: "전역" };
  const found = findRegisteredProject(project);
  if (found.project === undefined) {
    return {
      error:
        found.candidates.length > 1
          ? `'${project}' 이라는 프로젝트가 여럿입니다 — 경로로 지정하세요: ${found.candidates.map((p) => p.path).join(" · ")}`
          : `'${project}' 은(는) 등록된 프로젝트가 아닙니다 — project_list 로 확인하세요.`,
    };
  }
  return { dir: projectScope(found.project.path).commands, label: `프로젝트 ${found.project.name}` };
};

/**
 * 묶음(하위 폴더) 경로 — `배포/스테이징` 처럼 `/` 로 단을 나눈다. 빈 문자열 = 맨 위(묶음 해제). 이름은 한글도 된다(메뉴에 그대로 보인다).
 * ★폴더 밖으로 못 나간다 — `..`·절대 경로·숨김(`.`)·윈도우 금지 글자를 거절하고, 탐색 상한보다 깊게는 안 만든다(만들어도 목록에서 안 보인다).
 */
const parseGroup = (raw: string): { segments: string[] } | { error: string } => {
  // NFC 로 맞춘다 — 같은 한글 이름이 조합형/완성형으로 갈리면 맥에선 한 폴더, 리눅스에선 두 폴더가 됐다(릴리스 검토 F10).
  const segments = raw.normalize("NFC").split("/").map((x) => x.trim()).filter((x) => x !== "");
  if (segments.length > maxCommandFolderDepth()) return { error: `묶음은 ${maxCommandFolderDepth()}단까지입니다 — '${raw}'` };
  for (const seg of segments) {
    // 탐색이 안 들어가는 폴더(점·node_modules)·끝 점/공백(윈도우가 벗겨 다른 이름이 된다)도 거절한다(릴리스 검토 F4·F10).
    if (seg === "." || seg === ".." || !isWalkedCommandFolder(seg) || /[. ]$/.test(seg) || /[\\:*?"<>|\x00-\x1f]/.test(seg) || seg.length > 64) {
      return { error: `묶음 이름 '${seg}' 은(는) 쓸 수 없습니다(점으로 시작·\\ : * ? " < > | 금지).` };
    }
  }
  return { segments };
};

/** 묶음별 목록 — 맨 위 먼저, 그다음 묶음 경로 순. 한 줄 = `- /이름 — 설명`. */
const formatGrouped = (cmds: ReadonlyArray<{ name: string; description: string; folder?: string }>): string => {
  const by = new Map<string, string[]>();
  for (const c of cmds) {
    // 폴더 이름은 손으로 만든 것일 수 있다 — 제어 글자(줄바꿈)를 지워 도구 결과에 엉뚱한 줄이 끼지 않게(릴리스 검토 F7).
    const k = (c.folder ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
    const line = `- /${c.name}${c.description ? ` — ${c.description}` : ""}`;
    by.set(k, [...(by.get(k) ?? []), line]);
  }
  return [...by.keys()]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map((k) => `${k === "" ? "(맨 위)" : `[${k.split("/").join(" › ")}]`}\n${by.get(k)!.join("\n")}`)
    .join("\n\n");
};

/**
 * 같은 파일인가 — **실제 경로로** 본다(적대 검토 F2). 탐색은 실제 경로를 주고 우리는 조립한 경로를 써서, 심링크 아래 홈(맥 `/tmp`→
 * `/private/tmp` · 외장 디스크로 링크한 `~/work`)에선 같은 파일을 «다르다» 로 보고 방금 쓴 파일을 지웠다. 없는 파일은 폴더만 실제로 푼다.
 */
const samePath = async (a: string, b: string): Promise<boolean> => {
  const real = async (p: string): Promise<string> => {
    try {
      return await fs.realpath(p);
    } catch {
      const dir = await fs.realpath(path.dirname(p)).catch(() => path.resolve(path.dirname(p)));
      return path.join(dir, path.basename(p));
    }
  };
  const [x, y] = await Promise.all([real(a), real(b)]);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** 비면 지운다 — 묶음을 옮기고 남은 빈 폴더가 메뉴엔 안 보이지만 파일로는 남아 헷갈린다. 묶음 뿌리(commands)까지만. */
const pruneEmptyDirs = async (fromRaw: string, rootRaw: string): Promise<void> => {
  // 실제 경로로 비교한다 — 같은 폴더가 두 모양(맥 `/var` ↔ `/private/var`)이면 «뿌리 안인가» 가 어긋나 아무것도 안 치웠다.
  const real = async (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));
  const root = await real(rootRaw);
  for (let d = await real(fromRaw); path.relative(root, d) !== "" && !path.relative(root, d).startsWith("..") && !path.isAbsolute(path.relative(root, d)); d = path.dirname(d)) {
    try {
      await fs.rmdir(d); // 비어 있지 않으면 던진다 — 거기서 멈춘다
    } catch {
      return;
    }
  }
};

export const createCommandToolsMcpServer = (): McpSdkServerConfigWithInstance => {
  const registerCommand = tool(
    "register_command",
    "커스텀 슬래시 명령을 만듭니다. 두 종류: ①프롬프트형(prompt) — '/name' 이 비서에게 그 글을 보낸다($ARGUMENTS 로 인자). " +
      "②실행형(run, project 필수) — 비서 턴 없이 그 프로젝트 폴더에서 셸 한 줄을 돌리고 결과를 보낸다(배포·빌드·테스트). " +
      "project 를 주면 그 프로젝트의 .tiguclaw/commands 에, 없으면 전역(<home>/commands)에 만든다. 재시작 불요. " +
      "★묶음: group('배포/스테이징')을 주면 그 하위 폴더에 둔다 — 메뉴에 배포 › 스테이징 › /이름 으로 보인다(전역·프로젝트 둘 다). " +
      "이미 있는 명령에 group 만 주면(prompt·run 없이) 내용은 그대로 두고 그 묶음으로 **옮긴다**(group '' = 맨 위로). " +
      "부르는 이름은 묶음과 무관하게 /이름 이라 폴더가 달라도 이름은 겹칠 수 없다. 지금 묶음은 list_commands 로 본다. " +
      "실행형을 만들 땐 project-commands 스킬의 요령을 따른다(저장 전에 내용을 보여 주고 확인). " +
      `빌트인 네이티브 명령(${RESERVED_NAMES})과 같은 이름은 만들 수 없습니다.`,
    {
      name: z
        .string()
        .min(1)
        .describe(`슬래시 명령 이름(예 'daily'). 선행 슬래시는 자동 제거·소문자화. 빌트인(${RESERVED_NAMES}) 금지.`),
      prompt: z
        .string()
        .optional()
        .describe("프롬프트형: '/name' 호출 시 비서에게 보낼 글(본문). $ARGUMENTS 로 호출 인자 치환. run 과 둘 중 하나만."),
      run: z
        .string()
        .optional()
        .describe("실행형: 프로젝트 폴더에서 돌릴 셸 **한 줄**(예 'npm run deploy'). 여러 단계는 npm 스크립트나 스크립트 파일로 묶고 이 줄이 부른다. project 필수. $ARGUMENTS 치환."),
      confirm: z
        .boolean()
        .optional()
        .describe("실행형만: true 면 돌리기 전에 사용자에게 한 번 묻는다(배포처럼 되돌리기 어려운 일)."),
      project: z
        .string()
        .optional()
        .describe("등록된 프로젝트 이름 또는 경로 — 주면 그 프로젝트의 커맨드로 만든다(대화에 연결하면 메뉴에 뜬다)."),
      description: z
        .string()
        .optional()
        .describe("명령 설명(슬래시 인덱스·텔레그램 메뉴 표시용)."),
      overwrite: z
        .boolean()
        .optional()
        .describe("true 면 같은 이름의 기존 명령을 덮어씁니다. 기본 false(충돌 시 거부)."),
      group: z
        .string()
        .optional()
        .describe("묶음(하위 폴더) 경로 — 예 '배포' · '배포/스테이징'. '' 는 맨 위. 안 주면 새 명령은 맨 위, 기존 명령은 제자리."),
    },
    async (args) => {
      try {
        // 1) name 정규화 + 안전성.
        const name = normalizeName(args.name);
        if (name === "") {
          return errText("name 이 비어 있습니다. 유효한 슬래시 명령 이름을 지정하세요(예 'daily').");
        }
        if (!isSafeName(name)) {
          return errText(
            `name '${args.name}' 이 유효하지 않습니다(영문 소문자·숫자·하이픈·언더스코어만, 첫 글자는 영숫자). 다른 이름을 쓰세요.`,
          );
        }

        // 2) 빌트인 네이티브 명령 충돌 거부.
        if (BUILTIN_COMMANDS.has(name)) {
          return errText(
            `'${name}' 는 빌트인 네이티브 명령이라 커스텀 슬래시로 등록할 수 없습니다(가려진 죽은 정의 방지). ` +
              `예약 이름: ${[...BUILTIN_COMMANDS].join(", ")}. 다른 이름을 쓰세요.`,
          );
        }

        // 2a) 묶음 — 주면 검사(폴더 밖 탈출·깊이).
        const group = args.group === undefined ? undefined : parseGroup(args.group);
        if (group !== undefined && "error" in group) return errText(group.error);
        const whereEarly = commandsDirFor(args.project);
        if ("error" in whereEarly) return errText(whereEarly.error);

        // 2b) 종류 — 프롬프트형·실행형 중 하나. 실행형은 프로젝트에서만(어느 폴더에서 돌지가 곧 프로젝트다).
        const prompt = (args.prompt ?? "").trim();
        const run = (args.run ?? "").trim();
        // ★옮기기만 — 내용 없이 group 만 주면 기존 명령을 그 묶음으로 옮긴다(내용을 다시 쓰게 하면 비서가 본문을 옮겨 적다 바꾼다).
        if (prompt === "" && run === "" && group !== undefined) {
          // 옮기기만이다 — 설명·확인·덮어쓰기를 같이 주면 조용히 버리지 않고 알린다(릴리스 검토 F6).
          if (args.description !== undefined || args.confirm !== undefined || args.overwrite !== undefined) {
            return errText("옮기기(group 만)에는 description·confirm·overwrite 를 같이 쓸 수 없습니다 — 내용까지 바꾸려면 prompt 나 run 과 overwrite: true 를 주세요.");
          }
          const from = await findCommandFile(whereEarly.dir, name);
          if (from === undefined) {
            return errText(`옮길 명령 '/${name}' 이 없습니다(${whereEarly.label}). 새로 만들려면 prompt 나 run 을 주세요. list_commands 로 목록을 볼 수 있습니다.`);
          }
          const to = path.join(whereEarly.dir, ...group.segments, `${name}.md`);
          if (!(await samePath(from, to))) {
            // ★그 자리에 같은 이름의 **다른** 파일이 이미 있으면 덮지 않는다 — 손으로 둔 것일 수 있다(적대 검토 F6: rename 이 조용히 덮었다).
            if (await fs.stat(to).then(() => true, () => false)) {
              return errText(`'${to}' 에 같은 이름의 명령 파일이 이미 있어 옮기지 않았습니다 — 둘 중 하나를 delete_command 로 지우거나 이름을 바꾸세요.`);
            }
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.rename(from, to);
            await pruneEmptyDirs(path.dirname(from), whereEarly.dir);
            getEventBus().publish({ type: "commands.changed", ts: Date.now(), payload: {} });
          }
          const shown = group.segments.length === 0 ? "맨 위" : group.segments.join(" › ");
          return okText(`'/${name}' 을(를) ${shown} 로 옮겼습니다(${whereEarly.label}). 부르는 이름은 그대로 /${name} 입니다.`);
        }
        if ((prompt === "") === (run === "")) {
          return errText("prompt(프롬프트형)와 run(실행형) 중 **하나만** 주세요(기존 명령을 묶음으로 옮기기만 하려면 group 만 주세요).");
        }
        if (run !== "" && (args.project ?? "").trim() === "") {
          return errText("실행형(run)은 project 가 필요합니다 — 그 프로젝트 폴더에서 돈다.");
        }
        if (/[\r\n]/.test(run)) {
          return errText("run 은 한 줄입니다 — 여러 단계는 npm 스크립트나 스크립트 파일로 묶고 run 이 그걸 부르게 하세요.");
        }
        const where = commandsDirFor(args.project);
        if ("error" in where) return errText(where.error);

        // 3) 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기). ★하위 폴더(묶음)에 있는 같은 이름도 본다 — 덮어쓰면 그 자리에 쓴다.
        //  group 을 주면 그 묶음에 쓴다(덮어쓰기면 옛 자리의 파일은 지운다 — 같은 이름이 두 폴더에 남으면 앞의 것만 쓰인다).
        const commandsDir = where.dir;
        const existing = await findCommandFile(commandsDir, name);
        const filePath =
          group !== undefined ? path.join(commandsDir, ...group.segments, `${name}.md`) : existing ?? path.join(commandsDir, `${name}.md`);
        if (args.overwrite !== true && existing !== undefined) {
          return errText(
            `슬래시 명령 '${name}' 가 이미 존재합니다(${existing}). 덮어쓰려면 overwrite: true 를 지정하거나, 먼저 delete_command 로 삭제하세요.`,
          );
        }

        // 4) frontmatter(description optional) + 본문=prompt 조립. parseFrontmatter 가
        //    읽을 단순 key:value. frontmatter 없어도 유효하나, description 있으면 기록.
        const desc = (args.description ?? "").trim();
        // ★run 은 작은따옴표로 감싸 그대로 둔다 — 파서가 바깥 한 쌍만 벗기므로 안의 따옴표·콜론이 보존된다
        //  (fmValue 는 큰따옴표를 작은따옴표로 바꿔 셸 명령의 뜻을 바꾼다).
        const fm = [
          ...(desc !== "" ? [`description: ${fmValue(desc)}`] : []),
          ...(run !== "" ? [`run: '${run}'`] : []),
          ...(run !== "" && args.confirm === true ? ["confirm: true"] : []),
        ];
        // ★머리 블록을 **항상** 쓴다 — 없으면 prompt 가 `---` 로 시작할 때 그게 머리로 읽혀, 프롬프트형으로 만든 것이
        //  `run:` 실행형이 됐다(적대 검토: 도구 응답엔 «실행형» 표시도 없었다).
        const fileBody = `---\n${fm.length > 0 ? `${fm.join("\n")}\n` : ""}---\n${prompt !== "" ? `${prompt}\n` : ""}`;

        // 5) 디렉터리 ensure(백스톱 — ensureHome 이 이미 만들지만 멱등) + 쓰기.
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, fileBody, "utf8");
        if (existing !== undefined && !(await samePath(existing, filePath))) {
          await fs.unlink(existing).catch(() => undefined);
          await pruneEmptyDirs(path.dirname(existing), commandsDir);
        }

        // 6) ★ 메뉴 즉시 반영 — 쓰기 성공 후 commands.changed publish.
        //    telegram 채널이 구독해 setMyCommands 재설정(daemon 파트).
        getEventBus().publish({
          type: "commands.changed",
          ts: Date.now(),
          payload: {},
        });

        return okText(
          `슬래시 명령 '/${name}' 를 등록했습니다(${where.label}${run !== "" ? " · 실행형" : ""}).\n` +
            `- 파일: ${filePath}\n` +
            (desc !== "" ? `- 설명: ${desc}\n` : "") +
            (run !== "" ? `- 실행: ${run}${args.confirm === true ? " (실행 전 확인)" : ""}\n` : "") +
            (args.project !== undefined && args.project.trim() !== ""
              ? `이 프로젝트를 대화에 연결하면 📁 메뉴와 '/' 목록에 뜹니다(텔레그램은 /project).`
              : `동작은 즉시 적용됩니다('/${name}' 호출 가능). 텔레그램 명령 메뉴는 곧 반영됩니다.`),
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const listCommands = tool(
    "list_commands",
    "등록된 커스텀 슬래시 명령 목록을 조회합니다. 사용자가 '어떤 슬래시 명령이 있어?' 류로 물을 때 사용하세요. " +
      "project 를 주면 그 프로젝트의 명령을 **묶음(하위 폴더)과 함께** 보여 줍니다 — 묶거나 정리하기 전에 보세요.",
    { project: z.string().optional().describe("등록된 프로젝트 이름 또는 경로 — 주면 그 프로젝트의 명령(묶음 포함). 안 주면 전체 목록 + 전역 명령의 묶음.") },
    async (args) => {
      try {
        if (args.project !== undefined && args.project.trim() !== "") {
          const where = commandsDirFor(args.project);
          if ("error" in where) return errText(where.error);
          const own = await listCommandsIn(where.dir);
          if (own.length === 0) return okText(`${where.label} 에 커스텀 슬래시 명령이 없습니다.`);
          return okText(`## ${where.label} 슬래시 명령\n\n${formatGrouped(own)}`);
        }
        const globals = await listCommandsIn(getPaths().commonCommands);
        const commands = await discoverCommands();
        const index = formatCommandIndex(commands);
        if (index === "") {
          return okText("등록된 커스텀 슬래시 명령이 없습니다.");
        }
        const grouped = globals.some((c) => c.folder !== undefined && c.folder !== "")
          ? `\n\n## 전역 명령 묶음\n\n${formatGrouped(globals)}`
          : "";
        return okText(`## 커스텀 슬래시 명령\n\n${index}${grouped}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const deleteCommand = tool(
    "delete_command",
    "등록된 커스텀 슬래시 명령을 삭제합니다(전역 <home>/commands, 또는 project 를 주면 그 프로젝트의 .tiguclaw/commands).",
    {
      name: z
        .string()
        .min(1)
        .describe("삭제할 슬래시 명령 이름(예 'daily'). 선행 슬래시는 자동 제거."),
      project: z.string().optional().describe("프로젝트 커맨드면 그 프로젝트 이름 또는 경로."),
    },
    async (args) => {
      try {
        const name = normalizeName(args.name);
        if (name === "") {
          return errText("삭제할 슬래시 명령의 name 을 지정하세요.");
        }
        if (!isSafeName(name)) {
          return errText(`'${name}' 는 유효한 슬래시 명령 이름이 아닙니다.`);
        }

        const where = commandsDirFor(args.project);
        if ("error" in where) return errText(where.error);
        const filePath = (await findCommandFile(where.dir, name)) ?? path.join(where.dir, `${name}.md`); // 하위 폴더(묶음)에 있어도 찾는다
        try {
          await fs.unlink(filePath);
        } catch {
          return errText(
            `슬래시 명령 '${name}' 를 찾을 수 없습니다(${filePath}). list_commands 로 목록을 확인하세요. ` +
              `(project·plugin 출처 명령은 user 홈에 없어 이 도구로 삭제할 수 없습니다.)`,
          );
        }

        // ★ 메뉴 즉시 반영 — 삭제 성공 후 commands.changed publish.
        getEventBus().publish({
          type: "commands.changed",
          ts: Date.now(),
          payload: {},
        });

        return okText(`슬래시 명령 '/${name}' 를 삭제했습니다(${filePath}). 텔레그램 명령 메뉴는 곧 반영됩니다.`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return coreMcpServer({
    name: "commands",
    version: "1.0.0",
    tools: onDemand([registerCommand, listCommands, deleteCommand]),
  });
};
