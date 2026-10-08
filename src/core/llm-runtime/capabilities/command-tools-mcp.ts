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
import { promises as fs } from "node:fs";
import { isSafeCapabilityName } from "./_names.js";
import path from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPaths, projectScope } from "../../paths.js";
import { findRegisteredProject } from "../../session-projects.js";
import { getEventBus } from "../../eventbus.js";
import {
  discoverCommands,
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

export const createCommandToolsMcpServer = (): McpSdkServerConfigWithInstance => {
  const registerCommand = tool(
    "register_command",
    "커스텀 슬래시 명령을 만듭니다. 두 종류: ①프롬프트형(prompt) — '/name' 이 비서에게 그 글을 보낸다($ARGUMENTS 로 인자). " +
      "②실행형(run, project 필수) — 비서 턴 없이 그 프로젝트 폴더에서 셸 한 줄을 돌리고 결과를 보낸다(배포·빌드·테스트). " +
      "project 를 주면 그 프로젝트의 .tiguclaw/commands 에, 없으면 전역(<home>/commands)에 만든다. 재시작 불요. " +
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

        // 2b) 종류 — 프롬프트형·실행형 중 하나. 실행형은 프로젝트에서만(어느 폴더에서 돌지가 곧 프로젝트다).
        const prompt = (args.prompt ?? "").trim();
        const run = (args.run ?? "").trim();
        if ((prompt === "") === (run === "")) {
          return errText("prompt(프롬프트형)와 run(실행형) 중 **하나만** 주세요.");
        }
        if (run !== "" && (args.project ?? "").trim() === "") {
          return errText("실행형(run)은 project 가 필요합니다 — 그 프로젝트 폴더에서 돈다.");
        }
        if (/[\r\n]/.test(run)) {
          return errText("run 은 한 줄입니다 — 여러 단계는 npm 스크립트나 스크립트 파일로 묶고 run 이 그걸 부르게 하세요.");
        }
        const where = commandsDirFor(args.project);
        if ("error" in where) return errText(where.error);

        // 3) 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기).
        const commandsDir = where.dir;
        const filePath = path.join(commandsDir, `${name}.md`);
        if (args.overwrite !== true) {
          let exists = false;
          try {
            await fs.access(filePath);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) {
            return errText(
              `슬래시 명령 '${name}' 가 이미 존재합니다(${filePath}). 덮어쓰려면 overwrite: true 를 지정하거나, 먼저 delete_command 로 삭제하세요.`,
            );
          }
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
        await fs.mkdir(commandsDir, { recursive: true });
        await fs.writeFile(filePath, fileBody, "utf8");

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
    "등록된 커스텀 슬래시 명령 목록을 조회합니다. 사용자가 '어떤 슬래시 명령이 있어?' 류로 물을 때 사용하세요.",
    {},
    async () => {
      try {
        const commands = await discoverCommands();
        const index = formatCommandIndex(commands);
        if (index === "") {
          return okText("등록된 커스텀 슬래시 명령이 없습니다.");
        }
        return okText(`## 커스텀 슬래시 명령\n\n${index}`);
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
        const filePath = path.join(where.dir, `${name}.md`);
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

  return createSdkMcpServer({
    name: "commands",
    version: "1.0.0",
    tools: onDemand([registerCommand, listCommands, deleteCommand]),
  });
};
