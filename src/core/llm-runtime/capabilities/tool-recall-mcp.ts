/**
 * `read_past_tool_result` — 이 대화에서 앞서 실행한 도구의 결과 원문을 다시 읽는다 (2026-09-30, 압축 후 업무 연속성 단계 A).
 *
 * ★턴마다 만든다 — 대화를 클로저로 잡아야 «이 대화» 밖을 못 읽는다. 모델이 대화를 고를 수 없다.
 * ★대화를 정하는 식(세션 정체성 채널 + threadKey)은 **여기 한 곳**이다 — 어댑터는 입력을 통째로 넘긴다. 종전엔 어댑터마다
 *  `sessionChannel ?? channel` 을 따로 적어, 한쪽이 입력 채널로 잡아도 그 어댑터만 조용히 빈 도구가 됐다(적대 검토 O1).
 * ★세 어댑터 모두 붙인다. 기록(`turn_items`)은 Codex·OpenAI 턴이 남기지만 **어댑터를 섞은 대화**(Codex 실패 → Claude 폴백 등)에선
 *  Claude 턴도 그 기록이 필요하다. Claude 에는 접힌 채(이름만, 쓸 때 스키마를 연다) 실린다 — 순수 Claude 대화의 매 요청 비용을 안 늘린다.
 * ★**현재 턴도 읽는다**(2026-11-19, docs/decisions/2026-11-19-tool-output-recovery-design.md §3-1) — 어댑터가 실행 보관함을 넘기면
 *  그 실행에서 생략된 결과를 실행 참조(`r<토큰>.<순번>`)로 읽는다. 다른 실행의 보관함은 클로저 밖이라 안 보인다. 끝난 턴의 실행 참조는
 *  저장본에서 같은 참조로 찾는다.
 * ★응답 JSON 전체가 진입 상한 안이다(`toolRecallResponse`) — 이어 읽기 표지(`nextOffset`·`eof`)가 잘리지 않는다.
 * ★응답은 가린 것으로 만든다 — 본문·인자는 저장·보관 때 가렸고, 요청에서 온 글(`query`·틀린 `ref`)·저장된 도구 이름은 여기서 가린다.
 *  결과 진입이 일반 도구와 같은 길로 한 번 더 가려 저장한다(턴 안 입력은 원문) — 응답 크기는 그 가린 뒤 길이까지 상한 안이다.
 * 판정은 전부 저장 계층(`store/tool-recall.ts`)·보관함에 있다. 여기는 입출력 모양뿐이다.
 */
import { coreMcpServer } from "./_core-server.js";
import { z } from "zod";
import { tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelName } from "../../../channels/types.js";
import { loadThreadToolResult, searchThreadToolResults, toolRecallFailureResponse, toolRecallResponse, toolRecallSearchResponse, TOOL_RECALL_NAME, type ToolRecallLoaded } from "../../../store/tool-recall.js";
import { onDemand } from "../tool-load-policy.js";
import { RUN_REF_RE, type ToolOutputLedger } from "../tool-output-ledger.js";

const okJson = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

const REASON_TEXT: Record<string, string> = {
  bad_ref: "참조 형식이 아닙니다(예: 1234#2 또는 rk3f9a2xq.3).",
  not_found: "그런 기록이 없습니다.",
  other_conversation: "이 대화의 기록이 아닙니다.",
  before_boundary: "대화를 새로 시작하기(/clear) 전 기록이라 읽지 않습니다.",
  not_tool_result: "도구 결과 항목이 아닙니다.",
};
/** 실행 참조를 못 찾았을 때 — 끝났지만 기록되지 않은 실행이거나 남의 참조다. */
const RUN_REF_NOT_FOUND = "그 실행 참조를 찾지 못했습니다 — 기록되지 않고 끝난 실행(취소·실패)이거나 다른 실행·대화의 참조입니다. query 로 찾아보세요.";

/** 한 실행이 들고 있는 저장본 결과 수. */
const LOADED_KEEP = 4;

type TurnConversation = { channel: ChannelName; sessionChannel?: ChannelName; threadKey: string };

/** 이 턴의 대화 — 세션 정체성 채널(정규화된 세션이면 저장 채널) + threadKey. */
export const recallConversationOf = (input: TurnConversation): { channel: ChannelName; threadKey: string } => ({
  channel: input.sessionChannel ?? input.channel,
  threadKey: input.threadKey,
});

/** 참조 모양 — 저장 참조 또는 실행 참조. query 칸에 넣은 참조도 참조로 읽는다. */
const looksLikeRef = (s: string): boolean => /^\s*\d+#\d+\s*$/.test(s) || RUN_REF_RE.test(s.trim());

export const createToolRecallMcpServer = (
  input: TurnConversation,
  /** 이 실행의 결과 보관함(Codex) — 없으면 저장본만 읽는다. */
  ledger?: ToolOutputLedger,
): McpSdkServerConfigWithInstance => {
  const conv = recallConversationOf(input);
  // 이 실행에서 저장본에서 꺼낸 결과 — 이어 읽기마다 저장소를 다시 훑지 않는다(단건 조회는 턴 크기에 비례한다, `store/tool-recall.ts` pairOf).
  //  실행이 끝나면 버린다. 최근 몇 건만(한 결과를 끝까지 읽는 흐름이면 충분하다).
  const loaded = new Map<string, Extract<ToolRecallLoaded, { ok: true }>>();
  const load = (ref: string): ToolRecallLoaded => {
    const live = RUN_REF_RE.test(ref) ? ledger?.get(ref) : undefined;
    if (live !== undefined) return { ok: true, ref, at: live.at, tool: live.tool, args: live.args, text: live.text };
    const hit = loaded.get(ref);
    if (hit !== undefined) return hit;
    const r = loadThreadToolResult(conv.channel, conv.threadKey, ref);
    if (r.ok) {
      loaded.set(ref, r);
      if (loaded.size > LOADED_KEEP) loaded.delete(loaded.keys().next().value!);
    }
    return r;
  };
  return coreMcpServer({
    name: "tool-recall",
    version: "1.0.0",
    tools: onDemand([
      tool(
        TOOL_RECALL_NAME,
        "이 대화에서 앞서 실행한 도구의 결과를 다시 봅니다 — 결과가 길어 가운데가 생략됐거나(안내에 ref·offset 이 적혀 있으면 그대로 쓰세요, 같은 턴에서도 됩니다), " +
          "이력이 요약돼 예전 결과가 안 보이면 추측하지 말고 쓰세요. 원 도구를 다시 실행하지 마세요. " +
          "query 로 찾고(도구 이름·인자·결과 본문 부분일치, 최근 순) ref 로 읽습니다 — 한 번에 읽는 양이 정해져 있어 truncated 면 nextOffset 을 offset 에 넣어 이어 읽고, eof 면 끝입니다. " +
          '인자가 길어 잘렸으면 part:"args" 로 인자를 읽습니다. ' +
          "보관된 그대로라(비밀값 가림 · 아주 긴 결과는 보존 상한 넘는 가운데가 없음) 그 뒤 파일이 바뀌었을 수 있습니다 — 지금 상태가 필요하면 다시 읽으세요.",
        {
          query: z.string().min(1).max(200).optional(),
          ref: z.string().min(3).max(40).optional(),
          offset: z.number().int().min(0).optional(),
          part: z.enum(["output", "args"]).optional(),
        },
        async (args) => {
          // ★참조 번호를 query 칸에 넣는 실수는 참조로 읽는다 (2026-10-05) — 압축 강제 벤치에서 모델이 `query: "38#13"` 으로 불러 0건을 받고
          //  «되찾을 수 없다» 며 포기했다(다음 턴엔 ref 로 바르게 써서 성공). 참조 모양은 도구 이름·인자·본문 검색어로 쓸 일이 거의 없다.
          const ref = (args.ref ?? (args.query !== undefined && looksLikeRef(args.query) ? args.query : undefined))?.trim();
          if (ref !== undefined) {
            const r = load(ref);
            if (!r.ok) {
              const note = r.reason === "not_found" && RUN_REF_RE.test(ref) ? RUN_REF_NOT_FOUND : REASON_TEXT[r.reason];
              return okJson(toolRecallFailureResponse(r, note));
            }
            return okJson(toolRecallResponse(r, { offset: args.offset ?? 0, part: args.part ?? "output" }));
          }
          if (args.query === undefined) return okJson({ ok: false, error: "query 나 ref 중 하나가 필요합니다" });
          return okJson(toolRecallSearchResponse(searchThreadToolResults(conv.channel, conv.threadKey, args.query), args.query));
        },
      ),
    ]),
  });
};
