/**
 * OpenAI Codex backend — 대화 입력 조립 / SSE 파싱 / 히스토리 압축·요약 서브모듈.
 *
 * ★순수 구조 분해 (2026-07-16): openai-codex-oauth.ts 에서 로직 변경 0 으로 이동만.
 * 진실 소스·설계 근거는 메인 파일(openai-codex-oauth.ts) 헤더 주석 참조.
 * 공개 표면은 메인 파일의 배럴 re-export 로 보존된다.
 */
import { promises as fs } from "node:fs";
import { stripInternalRuntimeScaffolding } from "../../outbound-sanitize.js";
import { createIdleTimer } from "../idle-timeout.js";
import {
  loadThreadHistoryWithIds,
  type CodexTurn,
  type CodexTurnWithId,
} from "../../../store/memory.js";
import {
  getThreadSummary,
  upsertThreadSummary,
} from "../../../store/thread-summaries.js";
import type { RegionASdkInput } from "../types.js";
import type { SteeringInput } from "../../steering.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// codex 가 매 턴 재전송하는 thread 히스토리 윈도 (codex 의 1차 컨텍스트 기제).
// 2026-06-12 상향 40→150: gpt-5.5 윈도(400K)의 ~6%만 쓰던 과보수 캡 → "옛 맥락 잊음"
// 완화. ChatGPT 구독 백엔드라 토큰 과금 0(비용=레이턴시뿐). 150턴 ≈ 윈도 ~20%.
// ※ memory.ts 의 동명 export(40)와 *별개 노브* — 그건 claude foreign-delta 등의
//   default 라 claude(200K 윈도) 안전 위해 의도적으로 안 올림(작게 유지).
const CODEX_TURN_HISTORY_LIMIT = 150;

// turn count 위의 char cap — 단일 turn 이 비정상적으로 길 때 overflow 방지.
// 2026-06-12 상향 200K→700K (≈175k token 상한, 윈도 절반). 최신 turn 부터 누적,
// 초과 시 가장 오래된 turn drop. 보통 150턴 limit 가 먼저 binding (이건 안전 ceiling).
const CODEX_TURN_HISTORY_CHAR_CAP = 700_000;

/**
 * V5.1' — Codex Responses API SSE event 의 부분 타입.
 *
 * V3.3 본체의 `response.output_text.delta` event 누적 + `response.completed`
 * event 의 final fallback 외에, V5.1' 신규 — `response.completed` event 에서
 * `event.response.id` 추출 → sessionId 매핑.
 */
interface CodexSseEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    output_text?: string;
    output?: Array<{
      content?: Array<{ text?: string; type?: string }>;
    }>;
    // V5.10 — prompt_cache_key 효과 메트릭 (OpenAI Responses API usage shape).
    usage?: {
      input_tokens?: number;
      input_tokens_details?: {
        cached_tokens?: number;
      };
      output_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * V5.3 신규 — function_call lifecycle 누적용 turn 상태.
 *
 * OpenClaw `openai-transport-stream.ts` L407-508 답습:
 *  - `response.output_item.added (item.type==="function_call")` — call 시작.
 *    `currentToolCall` 박음. id / call_id / name 회수.
 *  - `response.function_call_arguments.delta` — `partialJson` 누적.
 *  - `response.output_item.done (item.type==="function_call")` — call 종료.
 *    `pending` 배열에 push. turn 종료 후 agentic loop 가 callTool → 다음 turn input.
 *
 * V5.1' 의 `text` 누적 (assistant message) 본체 보존 — function_call 과 병행 진행.
 */
export interface CodexToolCall {
  id: string | undefined; // function_call item id (e.g. `fc_...`)
  callId: string; // `call_id` — function_call_output 의 match key
  name: string;
  partialJson: string;
}

export interface CodexSseResult {
  text: string;
  responseId: string | undefined;
  toolCalls: CodexToolCall[];
  /**
   * /status 개편 — 이 turn 의 토큰 사용량 (`response.completed` usage 에서 추출).
   * usage event 부재 시 미설정 (graceful).
   */
  // 2026-06-07 — reasoningTokens 추가 (빈 응답 진단용, optional. 일반 status 표시는 무영향).
  //  ChatGPT 백엔드의 reasoning.effort 가 텍스트 슬롯 잠식하는지 측정.
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
}

/**
 * V5.3 — SSE stream parser. V5.1' 본체 + function_call 3 분기 (OpenClaw L407-508).
 *
 * 반환:
 *  - text: accumulated assistant 응답 본문 (`response.output_text.delta` 누적)
 *  - responseId: `response.completed` event 의 `response.id`
 *  - toolCalls: 본 turn 안에서 lifecycle 완성된 function_call 들 (0 또는 N개)
 *
 * 비-JSON 라인 (heartbeat 등) 은 skip. `[DONE]` 시그널 도 skip.
 */
export const parseCodexSse = async (
  body: ReadableStream<Uint8Array>,
  // 유휴 타임아웃 heartbeat — chunk 수신마다 호출(타이머 reset). 미지정 = no-op
  // (회귀 0 — 기존 호출부 호환). abort 시 reader.read() 가 reject → throw 전파.
  onChunk?: () => void,
  // llm.delta fan-out — output_text.delta 누적 시점마다 증분 텍스트 호출(onChunk 선례).
  // 미지정 = no-op(회귀 0). coalesce·publish 는 호출부 책임(파서 순수성 보존).
  onTextDelta?: (delta: string) => void,
  // 진전(progress) heartbeat — *실제 진전* 이벤트(output_text.delta·function_call 시작)
  // 에만 호출. no-progress 타이머 reset 용(in_progress heartbeat 는 진전 아님 → 미호출).
  // 미지정 = no-op(회귀 0).
  onProgress?: () => void,
  // externalTools 패스스루 스트리밍(2026-07-26, additive) — function_call lifecycle 의
  // 3분기(added→arguments.delta→done) 에서 index-기반 조각을 호출부에 노출한다. index 는
  // 이 parseCodexSse 호출(=1 iteration) 안에서 function_call 등장 순서(0,1,2…) — 병렬
  // 호출도 SSE 상 순차 도착이라 순서 그대로 인덱스가 된다. 미지정 = no-op(회귀 0, 기존
  // onTextDelta/onProgress 선례와 동형). 필터링(externalTools 이름 매치 여부)·발행(llm.
  // tool_call_delta publish)은 호출부(어댑터) 책임 — 파서는 순수 조각만 넘긴다.
  onToolCallDelta?: (info: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }) => void,
): Promise<CodexSseResult> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseId: string | undefined;
  let usage:
    | { inputTokens: number; outputTokens: number; reasoningTokens?: number }
    | undefined;
  const toolCalls: CodexToolCall[] = [];
  let currentToolCall: CodexToolCall | null = null;
  // externalTools 스트리밍용 — 현재 진행 중인 function_call 의 index(이 파서 호출 안 단조).
  let currentToolCallIndex = -1;
  const debugTools = process.env.CODEX_DEBUG_TOOLS === "1";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // chunk 도착 = 살아있음 신호 → 타이머 reset (first→idle 전환).
    onChunk?.();
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const block of parts) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as CodexSseEvent;
          // 진단(gated) — codex 백엔드가 흘리는 SSE event.type 실측용. "생각 중"에 어떤
          // 이벤트(reasoning delta vs 무이벤트 keep-alive)가 오는지 = progress-aware 가드
          // 가능성 판별. 기본 off (CODEX_DEBUG_TOOLS/INPUT 동형 gated 진단 인프라).
          if (process.env.CODEX_DEBUG_SSE === "1") {
            console.error(`[codex-sse] ${event.type}`);
          }
          // output_text.delta event 의 delta 누적 (표준 SSE 패턴).
          if (
            event.type === "response.output_text.delta" &&
            typeof event.delta === "string"
          ) {
            text += event.delta;
            // llm.delta fan-out — 순수 텍스트 증분만(누적본 아님). 호출부 coalescer 가
            // ~80ms∥120자로 묶어 publish. 미지정(onTextDelta===undefined)이면 no-op.
            onTextDelta?.(event.delta);
            onProgress?.(); // 실제 output = 진전 → no-progress 타이머 reset.
          }
          // V5.3 — function_call lifecycle 1 분기: output_item.added.
          // OpenClaw L407-418 답습 — partialJson 시작값 = item.arguments (대개 "").
          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            const callId = event.item.call_id ?? "";
            currentToolCall = {
              id: event.item.id,
              callId,
              name: event.item.name ?? "",
              partialJson: typeof event.item.arguments === "string" ? event.item.arguments : "",
            };
            currentToolCallIndex += 1;
            onProgress?.(); // 도구 호출 시작 = 진전 → no-progress 타이머 reset.
            onToolCallDelta?.({
              index: currentToolCallIndex,
              id: callId !== "" ? callId : currentToolCall.id,
              name: currentToolCall.name,
            });
            if (debugTools) {
              // ADR §6 (c) — Codex backend SSE event 라이브 입증용 1줄 로그.
              console.error(
                `[codex-oauth debug] sse event=${event.type} item.type=function_call name=${currentToolCall.name} call_id=${callId}`,
              );
            }
          }
          // V5.3 — function_call lifecycle 2 분기: arguments.delta 누적.
          // OpenClaw L439-449 답습 — partialJson string concat (parse 0, done 시점에서만).
          else if (
            event.type === "response.function_call_arguments.delta" &&
            currentToolCall !== null &&
            typeof event.delta === "string"
          ) {
            currentToolCall.partialJson += event.delta;
            onToolCallDelta?.({
              index: currentToolCallIndex,
              argumentsDelta: event.delta,
            });
          }
          // V5.3 — function_call lifecycle 3 분기: output_item.done.
          // OpenClaw L491-507 답습 — partialJson final 확정 후 toolCalls 에 push.
          else if (
            event.type === "response.output_item.done" &&
            event.item?.type === "function_call" &&
            currentToolCall !== null
          ) {
            // OpenClaw: item.arguments 가 있으면 우선, 없으면 partialJson 사용.
            const finalJson =
              typeof event.item.arguments === "string" && event.item.arguments !== ""
                ? event.item.arguments
                : currentToolCall.partialJson;
            toolCalls.push({
              id: event.item.id ?? currentToolCall.id,
              callId: event.item.call_id ?? currentToolCall.callId,
              name: event.item.name ?? currentToolCall.name,
              partialJson: finalJson,
            });
            currentToolCall = null;
          }
          // response.completed — final output_text fallback + response.id 추출.
          if (event.type === "response.completed") {
            if (text === "" && typeof event.response?.output_text === "string") {
              text = event.response.output_text;
            }
            if (typeof event.response?.id === "string") {
              responseId = event.response.id;
            }
            // /status 개편 — usage 항상 캡처 (CODEX_DEBUG_USAGE gate 밖). 이미 받는
            // event 에서 추출 (추가 호출 0). usage 부재 시 미설정 (graceful).
            if (event.response?.usage) {
              const u = event.response.usage;
              // 2026-06-07 — reasoning_tokens 추출 (output_tokens_details 안에 있음).
              //  ChatGPT 백엔드 응답 shape: usage.output_tokens_details.reasoning_tokens.
              //  부재 시 undefined (graceful — 기존 호출자 무영향, fallback 진단에만 사용).
              const rt = (
                u as { output_tokens_details?: { reasoning_tokens?: number } }
              ).output_tokens_details?.reasoning_tokens;
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
              };
            }
            // V5.10 — prompt_cache_key 효과 메트릭. CODEX_DEBUG_USAGE=1 gate.
            if (process.env.CODEX_DEBUG_USAGE === "1" && event.response?.usage) {
              const u = event.response.usage;
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              const input = u.input_tokens ?? 0;
              const hitRate = input > 0 ? Math.round((cached / input) * 100) : 0;
              console.log(
                `[codex-oauth debug] usage input=${input} cached=${cached} (${hitRate}%) output=${u.output_tokens ?? 0} total=${u.total_tokens ?? 0}`,
              );
            }
          }
        } catch {
          // 비-JSON 라인 (heartbeat 등) skip.
        }
      }
    }
  }

  return { text, responseId, toolCalls, usage };
};

/**
 * V5.1' 신규 — input 누적 본체. prior turn 들 + 현재 turn 의 ResponseInput[]
 * shape 누적.
 *
 * 정책 (architect 계약서 §5.2):
 *  - prior session 이 `codex-` prefix sid 면 transcripts 회수 → ResponseInput shape 변환.
 *  - prior 가 claude sid (UUID v4) 또는 부재면 새 세션 시작 — 누적 0, 현재 turn user만.
 *  - turn 갯수 limit = `CODEX_TURN_HISTORY_LIMIT` (40).
 *
 * 반환: Codex Responses API 가 받는 `input: [...]` 배열 본체.
 */
// 멀티모달 (2026-05-28) — content 원소에 input_image / input_file 추가. codex
// /responses 가 input_image(이미지) · input_file(PDF) 를 받는다 실측 확인 (둘 다 HTTP
// 200 + 내용 정확 인식: 구글 로고 / PDF 텍스트). 텍스트 전용 가정(구 L566 주석)은 폐기
// — 백엔드는 vision/문서를 지원, 우리가 안 보냈을 뿐이었음.
export type ResponseMediaItem =
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; filename: string; file_data: string };
export type ResponseContentItem =
  | { type: "input_text" | "output_text"; text: string }
  | ResponseMediaItem;
export type ResponseInputMessage = {
  type: "message";
  role: "user" | "assistant";
  content: ResponseContentItem[];
};

// 현재 turn 미디어 첨부 → Responses native content items (data URI).
//  - 현재 turn 만 native 전달. 과거 turn 은 transcripts 의 placeholder text(formatAttachments)
//    로 인지 — cross-adapter 단일 히스토리·연속성 유지 (바이너리 transcripts 미적재).
//  - image → input_image. PDF(application/pdf) → input_file. 그 외(audio/video/voice,
//    비-PDF document)는 placeholder text 경로 인지 유지 (텍스트 문서는 Read 로 충분).
//  - 읽기 실패·과대 파일은 skip → placeholder text 가 경로/메타 인지 보장 (조용한 실패 0).
const MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;
export const buildMediaContentItems = async (
  attachments: RegionASdkInput["attachments"],
): Promise<ResponseMediaItem[]> => {
  if (attachments === undefined) return [];
  const items: ResponseMediaItem[] = [];
  for (const a of attachments) {
    if (a.bytes > MAX_INLINE_MEDIA_BYTES) continue;
    try {
      if (a.kind === "image") {
        const b64 = (await fs.readFile(a.path)).toString("base64");
        items.push({
          type: "input_image",
          image_url: `data:${a.mimeType};base64,${b64}`,
        });
      } else if (a.kind === "document" && a.mimeType === "application/pdf") {
        const b64 = (await fs.readFile(a.path)).toString("base64");
        items.push({
          type: "input_file",
          filename: a.filename,
          file_data: `data:application/pdf;base64,${b64}`,
        });
      }
    } catch {
      /* 읽기 실패 → placeholder text 가 경로/메타로 인지 보장. */
    }
  }
  return items;
};

// V5.3 — OpenClaw L302-311 답습. function_call item 은 message 와 동등한 input array 원소.
export type ResponseInputFunctionCall = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

// V5.3 — OpenClaw L324-342 답습. function_call_output 도 input array 의 1 원소.
// (image branch 는 본 어댑터 미사용 — 텍스트 only.)
export type ResponseInputFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseInputFunctionCall
  | ResponseInputFunctionCallOutput;

/**
 * 6b — 격리(isolated) 최소 요약 호출. codex 자체 머신(token/headers/CODEX_BASE_URL
 * /responses fetch + parseCodexSse)을 *얇게* 재사용해 codex 안에서 닫는다.
 *
 * 격리 불변식 (재귀·레이어링 방지):
 *  - thread 히스토리 로딩 X (loadThreadHistory* 절대 호출 금지 — 재귀의 핵심 차단).
 *  - 도구 X (tools 키 omit), prompt_cache_key X (메인 캐시 충돌 회피), store:false.
 *  - instructions = "간결 요약기" 단발. 입력 = [요약 지시] + (기존요약 + 오래된 턴).
 *  - idle/turn 타임아웃은 base 구성(작은 bounded 호출 — 전 턴 면제 대상인 비서 작업
 *    turn 이 아니라 컨텍스트 위생 유틸. 실패 시 호출자가 oldest-drop 으로 graceful 폴백).
 *
 * 실패/타임아웃은 throw — 호출자(buildTurnHistory)가 catch 해 oldest-drop 폴백.
 */
const SUMMARIZE_INSTRUCTIONS =
  "당신은 간결한 대화 요약기입니다. 주어진 대화 조각을 한국어 3~6문장으로 요약하세요. " +
  "핵심 결정·사실·미해결 항목·사용자 의도를 보존하고, 인사·잡담은 생략하세요. " +
  "요약 텍스트만 출력하고 머리말/메타설명은 붙이지 마세요.";

async function summarizeViaCodex(
  text: string,
  accessToken: string,
  accountId: string | undefined,
  model: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  // 최소 payload — tools 없음, prompt_cache_key 없음(메인 thread 캐시 충돌 회피),
  // store:false, stream:true. reasoning 최소화로 요약 텍스트 슬롯 확보(finalFlush 동형).
  const body = JSON.stringify({
    model,
    instructions: SUMMARIZE_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `다음 대화 조각을 위 지침대로 요약하세요:\n\n${text}`,
          },
        ],
      },
    ],
    stream: true,
    store: false,
    reasoning: { effort: "none" },
  });

  // idle/turn 타임아웃 — 작은 bounded 호출이라 base 면 충분(비서 작업 turn 아님 →
  // 전 턴 면제 비대상. 실패해도 호출자 oldest-drop 폴백이라 안전).
  const ac = new AbortController();
  const idleTimer = createIdleTimer(ac);
  try {
    const res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Codex 요약 호출 실패: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    if (res.body === null) {
      throw new Error("Codex 요약 응답 body 가 null — SSE 스트림 부재.");
    }
    const result = await parseCodexSse(res.body, () => idleTimer.beat());
    return result.text;
  } finally {
    idleTimer.done();
  }
}

/**
 * 6b — 압축 계획 (순수 함수, LLM·DB 호출 0, 결정적 → 단위 테스트 용이).
 *
 * 입력: watermark 이후 전체 타임라인(allTurns, ts ASC, id 동반) + 현재 watermark.
 * 출력: 이번에 *접을* 오래된 턴 목록(toFold)과, 접은 뒤의 새 watermark(nextWatermark).
 *
 * 트리거 가드: 미요약(= watermark 이후) 턴 수가 TRIGGER_TURNS 이하면 압축 불요
 * (needed=false, toFold=[]). 초과 시에만 [가장 오래된 … (len - keepRecent)] 를 접는다.
 * 최근 keepRecent 턴은 항상 원문 유지(최신 맥락 손상 0). 매 턴 재요약 방지 핵심.
 */
export interface HistoryCompactionPlan {
  needed: boolean;
  toFold: CodexTurnWithId[];
  nextWatermark: number;
}

export const planHistoryCompaction = (
  unsummarizedTurns: CodexTurnWithId[],
  currentWatermark: number,
  opts?: { triggerTurns?: number; keepRecent?: number },
): HistoryCompactionPlan => {
  const triggerTurns = opts?.triggerTurns ?? CODEX_HISTORY_COMPACT_TRIGGER_TURNS;
  const keepRecent = opts?.keepRecent ?? CODEX_HISTORY_COMPACT_KEEP_RECENT;

  // 미요약 턴이 임계 이하 → 압축 불요 (현행 = 요약 호출 0, 회귀 0).
  if (unsummarizedTurns.length <= triggerTurns) {
    return { needed: false, toFold: [], nextWatermark: currentWatermark };
  }
  // 최근 keepRecent 는 원문 유지, 그 이전만 접는다.
  const foldCount = unsummarizedTurns.length - keepRecent;
  if (foldCount <= 0) {
    return { needed: false, toFold: [], nextWatermark: currentWatermark };
  }
  const toFold = unsummarizedTurns.slice(0, foldCount);
  // 접힌 마지막 턴의 transcript id 가 새 watermark (그 id 이하 = 요약에 흡수됨).
  const last = toFold[toFold.length - 1] as CodexTurnWithId;
  return { needed: true, toFold, nextWatermark: last.id };
};

/** 요약 합성 턴 1개 ([summary] → user role 스캐폴딩 메시지). 빈 요약이면 undefined. */
const buildSummaryTurn = (summary: string): ResponseInputItem | undefined => {
  const trimmed = summary.trim();
  if (trimmed === "") return undefined;
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<system-reminder>\n${CODEX_SUMMARY_TURN_HEADER}\n${trimmed}\n</system-reminder>`,
      },
    ],
  };
};

/**
 * input 재구성 (순수 함수) — [요약 합성 턴?] + [watermark 이후 원문 턴] + [현재 turn].
 *
 * recentRaw = watermark 이후 원문으로 보낼 턴들 (압축이 끝난 뒤의 최근 턴 = 항상 원문).
 * summary = 누적 롤링 요약 (없으면 ""). charCap/limit 가드는 호출자가 recentRaw 산출
 * 시점에 이미 적용 — 본 함수는 wrap 만 (결정적). 요약 턴은 맨 앞(가장 오래된 맥락).
 */
export const buildCodexInputArray = (
  recentRaw: CodexTurn[],
  summary: string,
  currentTurn: ResponseInputItem,
): ResponseInputItem[] => {
  const out: ResponseInputItem[] = [];
  const summaryTurn = buildSummaryTurn(summary);
  if (summaryTurn !== undefined) out.push(summaryTurn);
  for (const t of recentRaw) {
    // 과거 user 턴의 <system-reminder> 스캐폴딩(SYSTEM.md·AGENT.md·메모리 인덱스 등) 제거.
    // 매 턴 필요한 스캐폴딩은 *현재 턴*(currentTurn)에 fresh 로 들어있으므로, 히스토리
    // 턴마다 중복 재전송하면 SYSTEM.md(~11KB)가 턴 수만큼 곱해져 입력 토큰을 폭증시킨다
    // (claude發 턴은 jsonl 이 조립본을 저장 → codex 가 통째 재전송). assistant 턴엔 스캐폴딩
    // 없음, codex發 raw 턴엔 블록이 없어 no-op. 출구위생 함수 재사용(DRY).
    const text =
      t.role === "assistant"
        ? t.content
        : stripInternalRuntimeScaffolding(t.content).trim() || t.content;
    out.push({
      type: "message",
      role: t.role,
      content: [
        {
          type:
            t.role === "assistant"
              ? ("output_text" as const)
              : ("input_text" as const),
          text,
        },
      ],
    });
  }
  out.push(currentTurn);
  return out;
};

const buildCurrentTurn = (
  currentPromptWithMemory: string,
  mediaItems: ResponseMediaItem[],
): ResponseInputItem => ({
  type: "message",
  role: "user",
  // 현재 turn = [미디어 블록들…] + [텍스트]. 미디어 없으면 텍스트만 (회귀 0).
  content: [...mediaItems, { type: "input_text", text: currentPromptWithMemory }],
});

/**
 * P1a mid-turn steering (ADR `2026-07-16-midturn-steering.md` §codex) — 진행 중 codex
 * 턴 루프 상단에서 drain 한 사용자 steering 메시지를 **초기 사용자 턴과 바이트 동형** 의
 * `ResponseInputItem`(user message)으로 조립한다.
 *
 * ★새 포맷 만들지 않음 — 초기 유저 턴이 쓰는 그 빌더(`buildMediaContentItems` +
 * `buildCurrentTurn`)를 그대로 재사용한다. 결과 shape = `{ type:"message", role:"user",
 * content:[...media, { type:"input_text", text }] }` 로 초기 turn 과 동일(첨부 있으면
 * input_image/input_file 동형 media item).
 *
 * ★스캐폴딩(SYSTEM.md·메모리 인덱스 등 currentPromptWithMemory prefix)은 붙이지 않는다 —
 * 그건 이미 진행 턴 inputArray 최상단(currentTurn)에 fresh 로 있고, mid-loop user 메시지는
 * 순수 사용자 발화(text + 첨부)여야 한다. 초기 사용자 발화가 대화에 이어 온 것과 동형.
 */
export const buildSteeringInputItem = async (
  s: SteeringInput,
): Promise<ResponseInputItem> => {
  const mediaItems = await buildMediaContentItems(s.attachments);
  return buildCurrentTurn(s.text, mediaItems);
};

/**
 * 6b — input 누적 본체 (요약 압축 통합). async — 압축 트리거 시 summarizeViaCodex 1회.
 *
 * 동작:
 *  1) 전체 타임라인(id 동반)을 watermark 기준으로 [요약됨 | 미요약]으로 가른다.
 *  2) 미요약이 임계 초과면(planHistoryCompaction) 오래된 턴 + 기존 요약 → summarizeViaCodex
 *     → 갱신 요약 + watermark 전진(upsert). 임계 이하면 압축 0 (현행 동작).
 *  3) 요약 호출 실패/타임아웃 → console.warn + 현행 oldest-drop 폴백(요약 없이 진행,
 *     턴은 깨지 않음 — 데몬 생존 원칙 3).
 *  4) 입력 = [요약 합성 턴?] + [watermark 이후 원문 턴(charCap 가드)] + [현재 turn].
 *
 * 첫 turn(매핑 0)·짧은 thread(임계 미만) = 요약 0 + 현행과 동일 입력(회귀 0).
 */
export const buildTurnHistory = async (
  input: RegionASdkInput,
  currentPromptWithMemory: string,
  mediaItems: ResponseMediaItem[] = [],
  accessToken: string,
  accountId: string | undefined,
  model: string,
): Promise<ResponseInputItem[]> => {
  const currentTurn = buildCurrentTurn(currentPromptWithMemory, mediaItems);

  // 전체 타임라인 (id 동반, cap 없음) — 압축 결정 전용. 첫 turn → [].
  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성은 canonical 저장 채널로 키잉
  // (sessionChannel, 미지정 → channel 폴백·회귀 0). runOpenAiCodex 의 idChannel 과 동일 규칙.
  const allTurns = loadThreadHistoryWithIds(
    input.sessionChannel ?? input.channel,
    input.threadKey,
  );
  if (allTurns.length === 0) {
    return [currentTurn];
  }

  // 기존 롤링 요약 + watermark 회수 (없으면 watermark 0 = 전부 미요약).
  let existing = getThreadSummary(input.threadKey);
  let watermark = existing?.compactedThrough ?? 0;
  let summary = existing?.summary ?? "";

  // watermark 이후(미요약) 턴만 추려 압축 트리거 판정.
  const unsummarized = allTurns.filter((t) => t.id > watermark);
  const plan = planHistoryCompaction(unsummarized, watermark);

  if (plan.needed) {
    // 오래된 턴 + 기존 요약 → 요약 LLM 호출 1회 (isolated, 재귀 없음).
    const foldedText = plan.toFold
      .map((t) => `${t.role === "assistant" ? "비서" : "사용자"}: ${t.content}`)
      .join("\n");
    const prompt =
      summary === ""
        ? foldedText
        : `[기존 요약]\n${summary}\n\n[이어지는 대화]\n${foldedText}`;
    try {
      const fresh = await summarizeViaCodex(prompt, accessToken, accountId, model);
      if (fresh.trim() !== "") {
        summary = fresh.trim();
        watermark = plan.nextWatermark;
        upsertThreadSummary({
          threadKey: input.threadKey,
          summary,
          compactedThrough: watermark,
        });
      } else {
        // 빈 요약 = 무의미 → 폴백(요약 미반영, 기존 watermark 유지). 조용히 X.
        console.warn(
          `[codex 6b] 요약 호출이 빈 결과 — oldest-drop 폴백 (threadKey=${input.threadKey})`,
        );
      }
    } catch (e) {
      // 요약 실패/타임아웃 → 현행 oldest-drop 폴백. 턴은 깨지 않음(데몬 생존 원칙 3).
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[codex 6b] 요약 호출 실패 — oldest-drop 폴백 (threadKey=${input.threadKey}): ${msg}`,
      );
    }
  }

  // watermark 이후 원문 턴 (압축 성공 시 최근 keepRecent + 그간 신규, 실패 시 전체 미요약).
  // charCap/limit 가드 = 최신부터 역누적, 초과 시 oldest drop (요약이 없을 때의 안전망).
  const recentRawAll: CodexTurn[] = allTurns
    .filter((t) => t.id > watermark)
    .map((t) => ({ role: t.role, content: t.content }));

  let charSum = currentPromptWithMemory.length + summary.length;
  const recentRaw: CodexTurn[] = [];
  for (let i = recentRawAll.length - 1; i >= 0; i--) {
    if (recentRaw.length >= CODEX_TURN_HISTORY_LIMIT) break;
    const t = recentRawAll[i] as CodexTurn;
    if (charSum + t.content.length > CODEX_TURN_HISTORY_CHAR_CAP) break;
    charSum += t.content.length;
    recentRaw.unshift(t);
  }

  return buildCodexInputArray(recentRaw, summary, currentTurn);
};

// V5.3 — agentic loop iteration 노브. 2026-07-03 "자동 이어가기" 재설계로 25 cap 의
// 이중 역할(런어웨이 방어 + 작업 완료 신호)을 분리했다.
//
// ★역할 재정의: CODEX_MAX_TOOL_ITERATIONS(25)는 더 이상 *작업 완료 cap* 이 아니라
//   **soft checkpoint 간격**이다 — 25·50·75… 마다 "안 끝났으면 계속하라" 가벼운 진행
//   nudge 1회를 넣을 뿐, 강제 마무리(tools:[])는 하지 않는다(아래 루프 참조).
//   과거 이 값에서 강제 flush 하던 탓에 위키 정리처럼 도구 30~50+ 가 정당한 큰 작업이
//   매번 25 에서 잘려 부분보고로 끝났다. claude SDK 는 사실상 무제한으로 완주하므로
//   이건 #2 LLM-agnostic parity 갭이었다 — 본 변경이 그 갭을 복구한다.
//
// ★런어웨이 방어는 raw iteration count 가 아니라 (a) progress-aware stall 가드
//   (createIdleTimer + CODEX_NO_PROGRESS_MS, output/tool 진전에만 beat), (b) 턴
//   타임아웃 wall-clock 백스톱, (c) 아래 절대 백스톱(HARD) 3중이 담당한다. (a)/(b)는
//   *실제 무진전*만 컷하므로 정당한 긴 작업은 안 끊는다 — count 보다 똑똑한 방어다.
//   ⚠ 본 변경은 (a)/(b)가 루프 바깥에 살아있음에 *의존*한다(런어웨이가 여전히 바운드).
//
// env override — 사용자가 비용/안전 트레이드오프를 데몬 재시작만으로 조정 (양수 정수만).
export const parseCapEnv = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return 25;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 25;
};

// ── Context compaction 상수 (architect contract §6.4, 2026-06-16) ──────────────
// codex 루프(우리 수동 while)가 tool output 을 pruning 0 으로 누적·매 iteration
// 재전송하는 O(N²) 낭비를 잡는 두 노브. LLM 호출 0 — 순수 문자열 truncate + 참조
// 치환만. claude/openai 어댑터는 SDK 가 자체 효율 관리 → 무수정(층2 native 위임,
// LLM-agnostic 하드게이트 정합). 매직넘버 금지 — 보수적 기본값 + env override.
//
// 공통 env 파서 — 양의 정수만, 아니면 기본값. (parseCapEnv 와 동일 정책, 임의 기본.)
export const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// C2 — 단일 tool output 의 inputArray 진입 cap. 초과 시 머리+꼬리만 남기고 중간
// 치환. 도구 자체 cap(Bash 1MB·Read 2000라인)과 *별개* 의 어댑터 진입 게이트.
// 16,000자 ≈ 4.5K tok (gpt-5.5 윈도 400K 의 ~1%) — 한 도구 결과가 25 iteration
// 따라다녀도 부담 작은 수준.
const CODEX_TOOL_OUTPUT_ENTRY_CAP = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_ENTRY_CAP,
  16_000,
);
const CODEX_TOOL_OUTPUT_HEAD_CHARS = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_HEAD_CHARS,
  8_000,
);
const CODEX_TOOL_OUTPUT_TAIL_CHARS = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_TAIL_CHARS,
  4_000,
);

// C1 — inputArray 의 오래된 function_call_output 본문을 placeholder 로 치환할 때
// raw 유지할 최근 output 개수 K. 모델이 직전 작업 맥락은 온전히 봐야 다음 행동을
// 정하므로 최근 K개는 raw. K=3 (architect 권고) — 너무 작으면 재호출 핑퐁↑.
const CODEX_COMPACT_KEEP_RECENT = parsePosIntEnv(
  process.env.CODEX_COMPACT_KEEP_RECENT,
  3,
);
// C1 — 이 길이 이하 output 은 압축해도 이득 < placeholder 오버헤드라 그냥 둔다.
const CODEX_COMPACT_MIN_OUTPUT = parsePosIntEnv(
  process.env.CODEX_COMPACT_MIN_OUTPUT,
  2_000,
);

// 압축된 output 임을 표시하는 안정 마커. idempotent 보장 — 이미 이 마커가 박힌
// output 은 (a) 짧아 임계 미달로 자연 제외 + (b) 마커 검사로 명시 제외(이중 안전).
const CODEX_COMPACTED_MARKER = " __codex_compacted__ ";

// ── 6b: 대화 히스토리 롤링 요약 압축 상수 (architect contract §6b, 2026-06-19) ────
// codex 는 resume 없어 매 턴 전체 히스토리 재전송 → loadThreadHistory 의 oldest-drop
// 이 긴 대화 초반을 통째 버린다. 버리는 대신 오래된 턴을 요약 1덩어리로 접어 보존.
// 매직넘버 금지 — 상수 + env override (parsePosIntEnv, idle-timeout 정책 답습).
//
// ⚠ 위 tool-output 압축의 CODEX_COMPACT_KEEP_RECENT(=3, 도구 출력 본문 보존)와는
//    *별개 노브*다. 이쪽은 대화 *턴* 보존 수 → 충돌 회피 위해 별도 env 이름 사용.
//
// 트리거: 미요약(watermark 이후) 턴이 TRIGGER_TURNS 초과 시 압축 1회. 기존 150턴/700KB
// 하드캡(loadThreadHistory)보다 *먼저* 선제 발동(100 < 150)해 초반 맥락이 drop 되기
// 전에 요약으로 흡수. 매 턴 재요약 X — 임계 재초과 시에만(롤링이라 비용 분할상환).
const CODEX_HISTORY_COMPACT_TRIGGER_TURNS = parsePosIntEnv(
  process.env.CODEX_COMPACT_TRIGGER_TURNS,
  100,
);
// 항상 원문 유지할 최근 턴 수 — 최신 맥락 손상 0 (요약은 이보다 오래된 턴만 대상).
const CODEX_HISTORY_COMPACT_KEEP_RECENT = parsePosIntEnv(
  process.env.CODEX_COMPACT_KEEP_RECENT_TURNS,
  30,
);

// 요약 합성 턴을 감싸는 스캐폴딩 헤더 — assembleUserPrompt 의 <system-reminder> 패턴
// 답습. 메인 모델이 "하네스가 주는 배경 정보(사용자 발화 아님)"로 인지 → 그대로 echo
// 하지 않음. user role 메시지지만 내부 스캐폴딩 형태라 딴소리·메아리 방지.
const CODEX_SUMMARY_TURN_HEADER =
  "〔이전 대화 요약 — 하네스 제공 배경, 사용자 발화 아님〕";

/**
 * C2: 단일 tool output 의 inputArray 진입 cap. 임계 초과 시 머리+꼬리만 남기고
 * 중간을 참조 안내로 치환. 순수 함수 (LLM 호출 0, 결정적).
 *
 * - cap 이하면 원본 그대로 반환 (짧은 출력 = 현행과 100% 동일, 회귀 0).
 * - head+tail 이 cap 이상이면 잘릴 게 없으므로 원본 반환 (방어).
 */
export const capToolOutputForEntry = (
  output: string,
  opts?: { cap?: number; headChars?: number; tailChars?: number },
): string => {
  const cap = opts?.cap ?? CODEX_TOOL_OUTPUT_ENTRY_CAP;
  const headChars = opts?.headChars ?? CODEX_TOOL_OUTPUT_HEAD_CHARS;
  const tailChars = opts?.tailChars ?? CODEX_TOOL_OUTPUT_TAIL_CHARS;
  if (output.length <= cap) return output;
  // 머리+꼬리가 원본 이상이면 절약 없음 → 그대로.
  if (headChars + tailChars >= output.length) return output;
  const omitted = output.length - headChars - tailChars;
  // 경계에서 surrogate pair(이모지 등)가 쪼개지면 lone surrogate(깨진 글자)가 남는다.
  // head 끝의 lone high-surrogate, tail 앞의 lone low-surrogate 만 제거(최대 1 code unit).
  const head = output.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = output.slice(output.length - tailChars).replace(/^[\uDC00-\uDFFF]/, "");
  return (
    `${head}\n…[중략 ${omitted}자 — 전체 출력이 잘렸습니다. ` +
    `특정 부분이 필요하면 Read offset/limit 또는 Grep 으로 좁혀 재요청하세요.]…\n` +
    `${tail}`
  );
};

/**
 * C1: inputArray 의 오래된 function_call_output 본문을 placeholder 로 치환한다.
 * in-place 변형 (push-only 구조에 압축 패스로 삽입). 순수하진 않으나(부수효과)
 * LLM 호출 0·결정적.
 *
 * 불변식 (architect §6.3):
 *  - call_id 쌍 정합: function_call item·call_id 는 절대 손대지 않고, 오직
 *    function_call_output 의 `output` 문자열만 교체 (삭제 0 → Responses shape 무손상).
 *  - 최근 keepRecent 개의 function_call_output 은 raw 유지 (모델 직전 맥락 보존).
 *  - minOutputChars 이하 output 은 압축 안 함 (placeholder 오버헤드 회피).
 *  - idempotent: 이미 마커가 박힌 output 은 건너뜀.
 */
export const compactOldToolOutputs = (
  inputArray: ResponseInputItem[],
  opts?: { keepRecent?: number; minOutputChars?: number },
): void => {
  const keepRecent = opts?.keepRecent ?? CODEX_COMPACT_KEEP_RECENT;
  const minOutputChars = opts?.minOutputChars ?? CODEX_COMPACT_MIN_OUTPUT;

  // function_call_output 만의 인덱스 목록 (시간순 = 배열순). 최근 keepRecent 개는
  // 보존, 그 이전(= 앞쪽 인덱스)만 압축 대상.
  const outputIdxs: number[] = [];
  for (let i = 0; i < inputArray.length; i++) {
    if (inputArray[i]?.type === "function_call_output") outputIdxs.push(i);
  }
  if (outputIdxs.length <= keepRecent) return; // 압축할 만큼 안 쌓임 → no-op.

  const compactUntil = outputIdxs.length - keepRecent; // [0, compactUntil) 만 압축.
  for (let j = 0; j < compactUntil; j++) {
    const item = inputArray[outputIdxs[j] as number] as ResponseInputFunctionCallOutput;
    const body = item.output;
    if (body.length < minOutputChars) continue; // 짧음 → 그냥 둠.
    if (body.startsWith(CODEX_COMPACTED_MARKER)) continue; // 이미 압축됨 (idempotent).
    item.output =
      `${CODEX_COMPACTED_MARKER}[이전 도구 출력 생략 — 약 ${body.length}자. ` +
      `필요하면 같은 인자로 도구를 재호출하세요.]`;
  }
};
