/**
 * 세션 도구 — **이름 변경 하나** (2026-08-07 사용자 요청).
 *
 * 왜: 세션 이름을 바꾸는 경로가 **대시보드 UI 하나뿐**이었다. 비서는 이름 없는 세션이나
 * 잘못 붙은 이름(첫 발화가 `/status` 같은 명령이면 그게 그대로 이름이 된다)을 발견해도
 * "더블클릭해서 바꾸세요" 밖에 할 수 없었다. 실제로 그 상황이 났다.
 *
 * ★범위: **이름 변경 + 보관**. 삭제는 여전히 안 넣는다(비가역).
 *
 * ★보관을 뒤늦게 넣은 이유 (2026-08-19). 이 헤더는 원래 *"삭제·보관은 넣지 않는다 — 그건
 *  **비가역이거나** 사용자 판단이 필요한 부류"* 라고 둘을 한 묶음으로 뺐다. 그런데 보관은
 *  비가역이 아니다: `unarchive` 로 그대로 돌아오고 대화 레코드(`transcripts`·`chat_log`)는
 *  손도 안 댄다. 즉 rename 을 통과시킨 그 기준("되돌릴 수 있고 최악이 사소하다")을 보관도
 *  통과한다 — 삭제와 함께 묶은 게 과했다.
 *
 *  실제로 그 대가가 나왔다: 사용자의 다른 인스턴스에서 `/sessions` 목록이 말조각 이름으로
 *  가득 찼는데(무명 세션 누적), **비서에게 치울 수단이 없어** 사용자가 하나씩 명령을 쳐야
 *  했다. 대시보드·`/sessions archive` 엔 있는 능력이 말로는 안 되던 것 — 같은 날 아침
 *  `set_model_reasoning` 과 정확히 같은 모양이다.
 *
 * ★그래도 자율로 하지 않는다. 보관은 사용자 목록에서 세션을 **치우는** 행위라, 도구 설명이
 *  "요청받았을 때만, 그리고 무엇을 치울지 먼저 보여주고" 를 명시한다(소프트 강제).
 *
 * LLM-agnostic: claude·codex·openai 세 어댑터에 **같은 의미**로 등록된다(어댑터 분기 0).
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  listThreads,
  sessionDisplayName,
  setThreadArchived,
  setThreadName,
} from "../../../store/sessions.js";
import { clearBindingsForSession } from "../../../store/channel-session.js";
import { DEFAULT_SESSION_ID } from "../../threadkey.js";
import { getFirstUserText } from "../../../store/chat-log.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** 이름 상한 — store 와 같은 규칙(trim·60캡). 여기서 미리 알려 잘림을 놀라지 않게. */
const NAME_MAX = 60;

export const createSessionToolsMcpServer = (
  /** 현 턴의 세션 좌표 — `threadKey` 생략 시 "이 대화" 로 해석. */
  currentThreadKey: string,
): McpSdkServerConfigWithInstance => {
  const renameTool = tool(
    "rename_session",
    "대화(세션)의 표시 이름을 바꾼다. threadKey 를 생략하면 **지금 이 대화**의 이름을 바꾼다. " +
      "이름을 비우면(name:\"\") 자동 이름(첫 발화 파생)으로 되돌아간다. " +
      "세션 목록이 필요하면 list_sessions 를 먼저 써라. 삭제·보관은 이 도구로 못 한다.",
    {
      name: z
        .string()
        .describe("새 이름(60자 상한, 넘으면 잘린다). 빈 문자열이면 자동 이름으로 되돌린다."),
      threadKey: z
        .string()
        .optional()
        .describe("대상 세션 id. 생략하면 지금 이 대화."),
    },
    async (args) => {
      const target = (args.threadKey ?? "").trim() || currentThreadKey;
      const raw = args.name.trim();
      // ★존재 확인은 **남의 세션을 지정했을 때만** 한다(오타 방지). 지금 이 대화는 아직
      //  행이 없을 수 있고(첫 턴은 saveSession 이 턴 끝에 행을 만든다), `setThreadName` 은
      //  바로 그 경우를 위해 placeholder 행을 만들도록 설계돼 있다. 여기서 막으면 "이 대화
      //  이름 바꿔줘" 라는 **가장 흔한 사용**이 첫 턴에 실패한다(실측으로 걸렸다).
      if (args.threadKey !== undefined && args.threadKey.trim() !== "") {
        const known = listThreads({ includeArchived: true }).some(
          (t) => t.threadKey === target,
        );
        if (!known) {
          return okText(
            `그런 세션이 없습니다: ${target}\nlist_sessions 로 정확한 id 를 확인하세요.`,
          );
        }
      }
      setThreadName(target, raw === "" ? null : raw);
      const after = raw === "" ? null : raw.slice(0, NAME_MAX);
      const shown = sessionDisplayName(target, after, getFirstUserText(target));
      const note =
        raw !== "" && raw.length > NAME_MAX ? ` (${NAME_MAX}자로 잘림)` : "";
      return okText(
        raw === ""
          ? `세션 이름을 지웠습니다 — 이제 자동 이름으로 보입니다: "${shown}" (${target})`
          : `세션 이름을 바꿨습니다: "${shown}"${note} (${target})`,
      );
    },
  );

  const listTool = tool(
    "list_sessions",
    "대화(세션) 목록 — id·표시 이름·마지막 사용 시각. rename_session 의 대상 id 를 찾을 때 쓴다.",
    {
      limit: z.number().int().min(1).max(50).optional().describe("최대 개수(기본 20)."),
    },
    async (args) => {
      const rows = listThreads({ excludeInternal: true })
        .slice(0, args.limit ?? 20)
        .map((t) => {
          const shown = sessionDisplayName(
            t.threadKey,
            t.name,
            getFirstUserText(t.threadKey),
          );
          const named = t.name !== null && t.name !== "" ? "" : " (자동 이름)";
          return `- ${shown}${named}\n    id: ${t.threadKey}  ·  마지막 사용: ${new Date(t.lastUsedAt).toISOString().slice(0, 16).replace("T", " ")}`;
        });
      return okText(
        rows.length === 0 ? "세션이 없습니다." : `세션 ${rows.length}개:\n${rows.join("\n")}`,
      );
    },
  );

  const archiveTool = tool(
    "archive_session",
    "대화(세션)를 **목록에서 숨긴다**(보관). 삭제가 아니다 — 대화 기록은 그대로 남고 " +
      "restore:true 로 언제든 되돌린다. 이름 없이 쌓인 세션이 목록을 어지럽힐 때 쓴다. " +
      "★사용자가 정리를 요청했을 때만 쓰고, **무엇을 보관할지 목록으로 먼저 보여준 뒤** 실행해라 " +
      "(list_sessions 로 확인). 지금 쓰고 있는 대화나 이름이 붙은 세션을 임의로 치우지 마라. " +
      "★보관하면 그 세션에 묶여 있던 대화방들이 **기본 세션으로 돌아간다** — 그 사실도 함께 알려라.",
    {
      threadKey: z.string().min(1).describe("대상 세션 id(list_sessions 의 id). 생략 불가 — 실수로 지금 대화를 숨기지 않게."),
      restore: z.boolean().optional().describe("true 면 보관 해제(목록에 다시 보이게)."),
    },
    async (args) => {
      const target = args.threadKey.trim();
      const restoring = args.restore === true;
      if (target === DEFAULT_SESSION_ID) {
        return okText("기본 세션은 보관할 수 없습니다(항상 존재하는 세션입니다).");
      }
      const changed = setThreadArchived(target, restoring ? null : Date.now());
      if (changed === 0) return okText(`그런 세션이 없습니다: ${target}`);
      // ★명령 경로(`/sessions archive`)와 **같은 부수효과**를 낸다 — 그쪽만 바인딩을 풀면
      //  같은 판단이 두 곳에서 갈린다. 보관된 세션에 묶인 방은 목록에 없는 곳에 계속 쌓인다.
      let note = "";
      if (!restoring) {
        const freed = clearBindingsForSession(target);
        if (freed > 0) note = ` 그 세션에 묶여 있던 대화방 ${freed}곳을 기본 세션으로 되돌렸습니다.`;
      }
      return okText(
        restoring
          ? `세션을 목록에 다시 표시했습니다: ${target}`
          : `세션을 보관했습니다(삭제 아님 — 기록은 그대로): ${target}.${note} 되돌리려면 restore:true.`,
      );
    },
  );

  return createSdkMcpServer({
    name: "session-tools",
    version: "1.0.0",
    tools: [renameTool, listTool, archiveTool],
  });
};
