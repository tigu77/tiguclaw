/**
 * `read_past_tool_result` — 이 대화에서 앞서 실행한 도구의 결과 원문을 다시 읽는다 (2026-09-30, 압축 후 업무 연속성 단계 A).
 *
 * ★턴마다 만든다 — 대화를 클로저로 잡아야 «이 대화» 밖을 못 읽는다. 모델이 대화를 고를 수 없다.
 * ★대화를 정하는 식(세션 정체성 채널 + threadKey)은 **여기 한 곳**이다 — 어댑터는 입력을 통째로 넘긴다. 종전엔 어댑터마다
 *  `sessionChannel ?? channel` 을 따로 적어, 한쪽이 입력 채널로 잡아도 그 어댑터만 조용히 빈 도구가 됐다(적대 검토 O1).
 * ★세 어댑터 모두 붙인다. 기록(`turn_items`)은 Codex·OpenAI 턴이 남기지만 **어댑터를 섞은 대화**(Codex 실패 → Claude 폴백 등)에선
 *  Claude 턴도 그 기록이 필요하다. Claude 에는 접힌 채(이름만, 쓸 때 스키마를 연다) 실린다 — 순수 Claude 대화의 매 요청 비용을 안 늘린다.
 * 판정은 전부 저장 계층(`store/tool-recall.ts`)에 있다. 여기는 입출력 모양뿐이다.
 */
import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelName } from "../../../channels/types.js";
import { readThreadToolResult, searchThreadToolResults, TOOL_RECALL_NAME } from "../../../store/tool-recall.js";
import { onDemand } from "../tool-load-policy.js";

const okJson = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

const REASON_TEXT: Record<string, string> = {
  bad_ref: "참조 형식이 아닙니다(예: 1234#2).",
  not_found: "그런 기록이 없습니다.",
  other_conversation: "이 대화의 기록이 아닙니다.",
  before_boundary: "대화를 새로 시작하기(/clear) 전 기록이라 읽지 않습니다.",
  not_tool_result: "도구 결과 항목이 아닙니다.",
};

type TurnConversation = { channel: ChannelName; sessionChannel?: ChannelName; threadKey: string };

/** 이 턴의 대화 — 세션 정체성 채널(정규화된 세션이면 저장 채널) + threadKey. */
export const recallConversationOf = (input: TurnConversation): { channel: ChannelName; threadKey: string } => ({
  channel: input.sessionChannel ?? input.channel,
  threadKey: input.threadKey,
});

export const createToolRecallMcpServer = (input: TurnConversation): McpSdkServerConfigWithInstance => {
  const conv = recallConversationOf(input);
  return createSdkMcpServer({
    name: "tool-recall",
    version: "1.0.0",
    tools: onDemand([
      tool(
        TOOL_RECALL_NAME,
        "이 대화에서 앞서 실행한 도구의 결과를 다시 봅니다 — 이력이 요약돼 예전 결과가 안 보이면 추측하지 말고 쓰세요. " +
          "query 로 찾고(도구 이름·인자·결과 본문 부분일치, 최근 순) ref 로 전문을 읽습니다. " +
          "보관된 그대로라(아주 긴 결과는 앞·뒤만) 그 뒤 파일이 바뀌었을 수 있습니다 — 지금 상태가 필요하면 다시 읽으세요.",
        {
          query: z.string().min(1).max(200).optional(),
          ref: z.string().min(3).max(40).optional(),
          offset: z.number().int().min(0).optional(),
        },
        async (args) => {
          // ★참조 번호를 query 칸에 넣는 실수는 참조로 읽는다 (2026-10-05) — 압축 강제 벤치에서 모델이 `query: "38#13"` 으로 불러 0건을 받고
          //  «되찾을 수 없다» 며 포기했다(다음 턴엔 ref 로 바르게 써서 성공). 참조 모양은 도구 이름·인자·본문 검색어로 쓸 일이 거의 없다.
          const ref = args.ref ?? (args.query !== undefined && /^\s*\d+#\d+\s*$/.test(args.query) ? args.query.trim() : undefined);
          if (ref !== undefined) {
            const r = readThreadToolResult(conv.channel, conv.threadKey, ref, args.offset ?? 0);
            if (!r.ok) return okJson({ ok: false, unavailable: r.reason, ref: r.ref, note: REASON_TEXT[r.reason] });
            return okJson({
              ok: true,
              ref: r.ref,
              at: new Date(r.at).toISOString(),
              tool: r.tool,
              args: r.args,
              chars: r.chars,
              offset: r.offset,
              ...(r.nextOffset !== undefined ? { truncated: true, nextOffset: r.nextOffset } : {}),
              text: r.text,
            });
          }
          if (args.query === undefined) return okJson({ ok: false, error: "query 나 ref 중 하나가 필요합니다" });
          const s = searchThreadToolResults(conv.channel, conv.threadKey, args.query);
          return okJson({
            ok: true,
            query: args.query,
            total: s.total,
            ...(s.totalCapped ? { totalAtLeast: true } : {}),
            truncated: s.totalCapped || s.total > s.hits.length,
            hits: s.hits.map((h) => ({ ...h, at: new Date(h.at).toISOString() })),
            // 0건의 뜻을 말한다 — 기록은 Codex·OpenAI 턴의 도구 결과만 남는다. Claude 턴의 도구 결과는 여기 없으니 «그런 실행이 없었다» 로
            //  읽지 않게 한다(적대 재검토 P2 — 순수 Claude 대화에선 언제나 0건).
            ...(s.total === 0 ? { note: "이 대화에 보관된 도구 결과 중에는 없습니다(보관은 Codex·OpenAI 모델이 실행한 도구 결과만 — Claude 로 실행한 결과는 여기 없습니다)." } : {}),
          });
        },
      ),
    ]),
  });
};
