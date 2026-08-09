/**
 * 세션 도구 — **이름 변경 하나** (2026-08-07 사용자 요청).
 *
 * 왜: 세션 이름을 바꾸는 경로가 **대시보드 UI 하나뿐**이었다. 비서는 이름 없는 세션이나
 * 잘못 붙은 이름(첫 발화가 `/status` 같은 명령이면 그게 그대로 이름이 된다)을 발견해도
 * "더블클릭해서 바꾸세요" 밖에 할 수 없었다. 실제로 그 상황이 났다.
 *
 * ★범위를 좁게 잡는다 — **이름 변경만**. 세션 삭제·보관은 넣지 않는다: 그건 비가역이거나
 *  사용자 판단이 필요한 부류라, 도구로 주면 비서가 지울 수 있게 된다(파괴적 행위는 명시
 *  승인). 이름 변경은 되돌릴 수 있고 최악이 사소하다 = 자동 조치 판단 기준을 통과한다.
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
  setThreadName,
} from "../../../store/sessions.js";
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

  return createSdkMcpServer({
    name: "session-tools",
    version: "1.0.0",
    tools: [renameTool, listTool],
  });
};
