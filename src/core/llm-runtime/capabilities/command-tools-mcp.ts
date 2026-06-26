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
import path from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPaths } from "../../paths.js";
import { getEventBus } from "../../eventbus.js";
import {
  discoverCommands,
  formatCommandIndex,
} from "../../entry/command-registry.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * 빌트인 네이티브 명령 — 등록 충돌 거부 대상. 채널 입구가 하드코딩 데몬 기능 슬래시를
 * command-registry fallthrough *이전에* 매치하므로, 같은 이름으로 .md 를 만들면 영원히
 * 가려진 죽은 정의가 된다. 등록 레벨에서 명시 거부해 혼동을 막는다.
 */
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  "reset",
  "memo",
  "forget",
  "memos",
  "plugins",
  "status",
  "restart",
  "update",
]);

/**
 * name 정규화 — 소문자·trim. 선행 슬래시도 허용 입력으로 받아 제거(`/daily` → `daily`).
 */
const normalizeName = (raw: string): string =>
  raw.trim().toLowerCase().replace(/^\/+/, "").trim();

/**
 * name 안전성 — 디렉터리 탈출/숨김파일 방지. 영문 소문자·숫자·하이픈·언더스코어만.
 * endpoint-tools 의 isSafeName 과 *동일 규칙*(module-private 라 복제 1개).
 */
const isSafeName = (name: string): boolean =>
  name !== "" && /^[a-z0-9][a-z0-9_-]*$/.test(name);

/** frontmatter 값 escape — 줄바꿈 제거(파서 라인 단위) + 따옴표 래핑(콜론 안전). */
const fmValue = (raw: string): string => {
  const oneLine = raw.replace(/[\r\n]+/g, " ").trim();
  return `"${oneLine.replace(/"/g, "'")}"`;
};

export const createCommandToolsMcpServer = (): McpSdkServerConfigWithInstance => {
  const registerCommand = tool(
    "register_command",
    "커스텀 슬래시 명령을 만듭니다(재사용 prompt 매크로의 슬래시 판). " +
      "<home>/commands/<name>.md 정의 파일을 작성하면 채널 입구가 매-입력 발견해 확장합니다(재시작 불요). " +
      "prompt 는 '/name' 으로 호출될 때 영역 A 에 전달할 프롬프트 템플릿이며, 본문에 $ARGUMENTS placeholder 로 호출 인자를 받을 수 있습니다. " +
      "빌트인 네이티브 명령(reset·memo·forget·memos·plugins·status·restart)과 같은 이름은 만들 수 없습니다.",
    {
      name: z
        .string()
        .min(1)
        .describe("슬래시 명령 이름(예 'daily'). 선행 슬래시는 자동 제거·소문자화. 빌트인(reset·memo·forget·memos·plugins·status·restart) 금지."),
      prompt: z
        .string()
        .min(1)
        .describe("'/name' 호출 시 영역 A 에 전달할 프롬프트 템플릿(본문). $ARGUMENTS placeholder 로 호출 인자 치환 가능."),
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

        // 3) 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기).
        const commandsDir = getPaths().commonCommands;
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
        const fileBody =
          desc !== ""
            ? `---\ndescription: ${fmValue(desc)}\n---\n${args.prompt.trim()}\n`
            : `${args.prompt.trim()}\n`;

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
          `슬래시 명령 '/${name}' 를 등록했습니다.\n` +
            `- 파일: ${filePath}\n` +
            (desc !== "" ? `- 설명: ${desc}\n` : "") +
            `동작은 즉시 적용됩니다('/${name}' 호출 가능). 텔레그램 명령 메뉴는 곧 반영됩니다.`,
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
    "등록된 커스텀 슬래시 명령을 삭제합니다(<home>/commands/<name>.md 삭제).",
    {
      name: z
        .string()
        .min(1)
        .describe("삭제할 슬래시 명령 이름(예 'daily'). 선행 슬래시는 자동 제거."),
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

        const commandsDir = getPaths().commonCommands;
        const filePath = path.join(commandsDir, `${name}.md`);
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
    tools: [registerCommand, listCommands, deleteCommand],
  });
};
