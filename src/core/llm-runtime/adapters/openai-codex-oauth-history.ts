/**
 * OpenAI Codex backend — 대화 입력 조립 / SSE 파싱 / 히스토리 압축·요약 서브모듈.
 *
 * ★순수 구조 분해 (2026-07-16): openai-codex-oauth.ts 에서 로직 변경 0 으로 이동만.
 * 진실 소스·설계 근거는 메인 파일(openai-codex-oauth.ts) 헤더 주석 참조.
 * 공개 표면은 메인 파일의 배럴 re-export 로 보존된다.
 */
import type { ChannelName } from "../../../channels/types.js";
import { getEventBus } from "../../eventbus.js";
import { promises as fs } from "node:fs";
import {
  redactSecrets,
  stripInternalRuntimeScaffolding,
} from "../../outbound-sanitize.js";
import { createIdleTimer } from "../idle-timeout.js";
// ★리프에서 가져온다 — 사본 4번째를 두던 근거("단방향 유지")는 거짓이었다.
//  rate-limit.ts 는 import 0개 리프이고 같은 llm-runtime/ 트리라 순환이 생길 수 없다.
import { isRateLimited } from "../rate-limit.js";
import { CODEX_TURN_HISTORY_CHAR_CAP as STORE_TURN_HISTORY_CHAR_CAP } from "../../../store/memory.js";
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
// 2026-06-12 상향 40→150: gpt-5.5 윈도(400K)의 ~6%만 쓰던 과보수 캡 → "옛 맥락 잊음" 완화.
// ※ memory.ts 의 동명 export(40)와 *별개 노브* — 그건 claude foreign-delta 등의
//   default 라 claude(200K 윈도) 안전 위해 의도적으로 안 올림(작게 유지).
//
// ★2026-07-26 근거 정정: 종전 주석은 "ChatGPT 구독 백엔드라 토큰 과금 0(비용=레이턴시뿐)"
//  을 상향 근거로 들었다. **이 논리는 폐기한다** — 과금이 없어도 낭비는 레이턴시·컨텍스트
//  한도·품질로 돌아온다(SYSTEM.md §1 "보내는 컨텍스트도 낭비 대상"). 턴 수는 아래 char cap
//  이 실질 binding 이라 유지하되, 근거를 "공짜라서"가 아니라 "필요해서"로 바꾼다.
const CODEX_TURN_HISTORY_LIMIT = 150;

// turn count 위의 char cap — 매 턴 재전송되는 히스토리의 실질 상한(보통 이게 binding).
// 최신 turn 부터 누적, 초과 시 가장 오래된 turn drop.
//
// ★2026-07-26 하향 700K→500K — **비용이 아니라 correctness 근거**:
//  같은 날 실측(같은 엔드포인트 16건, 크기순 정렬 시 성공/실패 완전 분리)에서 이 백엔드는
//  입력이 커지면 오류가 아니라 **빈 응답**을 돌려줬다. 성공 상한 594,960자 / 실패 하한
//  825,885자. 종전 700K 캡은 그 위험 구간에 닿는 천장이었다 — 히스토리만 700K 를 채워도
//  시스템 프롬프트(실측 ~22K)가 얹히면 합계 ~717K 로 **회색지대**에 들어간다.
//
//  ★2026-07-30 — 시스템프롬프트 실측이 ~22K → **~50K** 로 늘었다(안정 스캐폴딩이
//  instructions 로 이동, prompt-assembly splitSystemContext). 그만큼을 buildTurnHistory
//  의 `instructionsChars` 로 예산에 명시로 싣는다 — 안 그러면 옮겨간 자리가 비어
//  과거 턴을 더 끌어오고 총 전송량이 조용히 늘어난다. 아래 표의 "시스템프롬프트" 항목은
//  그 새 값으로 읽어라(현 캡 200K + 50K = 250K, 실측 안전 상한 594,960자 대비 여유).
//  값 선정도 실측으로(360턴 실사용 스레드 기준, 합계 = 히스토리 + 시스템프롬프트):
//    700K → 150턴 / 716,852자  ⚠️ 회색지대   ← 종전
//    600K → 118턴 / 605,077자  ⚠️ 회색지대
//    500K → 102턴 / 519,471자  ✅ 안전       ← 채택(안전 구간 안에서 턴 최대 보존)
//    400K →  86턴 / 419,516자  ✅ 안전       (더 자를 이유 없음)
//
//  ★영향 정직히: "영향 0" 이 아니다. 그 스레드는 150턴 → 102턴으로 줄어든다. 다만 잘리는
//  건 *가장 오래된* 턴이고 thread_summaries 요약이 그 맥락을 보존한다(기록을 지우는 게
//  아니라 핫 경로만 바운드 — 유지보수 철학). 짧은 스레드는 애초에 캡에 안 닿아 무영향.
// ★store 의 값을 그대로 쓴다 (2026-07-30 원칙 검토 — 원칙 #2 실질 위반 정정).
//  종전엔 같은 이름 상수가 **두 값**이었다: store 200_000(claude·openai 가 loadThreadHistory
//  로 쓰는 값) vs 여기 500_000(codex 전용). 같은 대화를 codex↔openai 로 전환하면 회수되는
//  과거 턴 양이 **2.5배** 달랐고, store 쪽 주석은 "어댑터 charCap 과 정합"이라 적혀 있었다.
const CODEX_TURN_HISTORY_CHAR_CAP = STORE_TURN_HISTORY_CHAR_CAP;

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
  /**
   * ★`error` 이벤트(최상위) — 공식 SDK `ResponseErrorEvent` 형상
   * (`node_modules/openai/resources/responses/responses.d.ts`).
   * 종전엔 이 세 필드가 타입에도 파서에도 없어 **사유를 통째로 버렸다**(2026-07-30 실사고:
   * 백엔드가 error+response.failed 를 보내는데 우리는 "모델이 빈 응답" 으로 오진).
   */
  code?: string | null;
  message?: string;
  param?: string | null;
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
    /** `response.failed` 의 사유 — 공식 `ResponseError`(code·message). */
    error?: { code?: string; message?: string } | null;
    /** `response.incomplete` 의 사유 — `max_output_tokens` | `content_filter`. */
    incomplete_details?: { reason?: string } | null;
    status?: string;
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
  // ★cachedTokens (2026-07-26) — prefix 캐시 적중분. 종전엔 CODEX_DEBUG_USAGE=1 일 때
  //  콘솔로만 찍고 버렸다 → **캐시가 먹는지조차 알 수 없었다**. codex 는 매 도구 반복마다
  //  누적 입력을 통째로 재전송하는 구조라, 캐시 적중률이 이 어댑터의 실효 비용을 좌우한다.
  //  측정 없이 루프를 손대는 건 근거 없는 최적화라 **관측부터** 연다.
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  /** 마지막으로 본 SSE 이벤트 타입(빈 응답 진단 — completed 없이 끊겼는지). */
  lastEvent?: string;
  /**
   * ★백엔드가 **명시적으로 보고한 실패** (2026-07-30). 200 OK 로 열린 스트림 안에서
   * `error` / `response.failed` / `response.incomplete` 로 도착한다.
   * 종전엔 이 세 이벤트를 파서가 아예 안 읽어 사유가 사라졌고, 호출부는 빈 텍스트만 보고
   * "모델이 침묵" 으로 오진해 nudge 3회를 태운 뒤 틀린 에러를 냈다.
   */
  failure?: {
    source: string;
    code?: string;
    message?: string;
    param?: string;
    /**
     * ★터미널 실패 이벤트의 **원문**(잘라내고 시크릿 제거, 2026-07-30 2차).
     *
     * 1차에서 공식 SDK 형상(`code`/`message`)대로 읽었는데 이 백엔드의 `error` 이벤트는
     * **그 형상이 아니었다** — 실측 로그가 `[codex-backend-failure] error —` 로 사유 없이
     * 찍혔다(두 필드 다 부재). 문서와 실물이 다르므로 **실물을 한 번 봐야** 한다.
     * 실패 경로에서만·1건만 남으므로 소음 0.
     */
    raw?: string;
  };
  /**
   * ★이 스트림이 흘린 이벤트 타입별 개수 (2026-07-30, 관측 전용).
   *
   * `response.completed` 없이 끝난 스트림에서 **무엇이 왔는지** 를 남기기 위한 것.
   * 실사고: chunks=266 인데 텍스트도 도구도 usage 도 없이 끝났는데, 그 266조각이
   * 무슨 이벤트였는지 알 방법이 없어 "모델이 침묵" 인지 "전송이 끊김" 인지 못 갈랐다.
   * 정상 종료 스트림에서는 호출부가 쓰지 않는다(로그 폭증 방지).
   */
  eventCounts?: Record<string, number>;
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
  /** 마지막으로 본 SSE 이벤트 타입 — 빈 응답이 completed 없이 끊겼는지 판별용. */
  let lastEvent = "(없음)";
  /** 이벤트 타입별 개수 — completed 없이 끝났을 때만 호출부가 읽는다(관측 전용). */
  const eventCounts: Record<string, number> = {};
  /** 백엔드가 명시 보고한 실패(먹지 않는다 — 첫 건을 보존해 호출부로 올린다). */
  let failure: CodexSseResult["failure"];
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
          if (typeof event.type === "string") {
            eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
          }
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
          // ★형상 비종속 사유 추출 (2026-07-30 3차) — 문서(SDK 타입)와 이 백엔드의 실물이
          //  **다르다**. 1차에서 문서대로 top-level code/message 를 읽었더니 실물이 빈
          //  `error` 였다(실측 `[codex-backend-failure] error —`). 그래서 특정 경로를 더
          //  추측하는 대신, 터미널 이벤트 payload 안을 **깊이 제한으로 훑어** code/message/
          //  param/reason 을 찾는다. 내려갈 키를 손목록으로 정하지 않으므로 형상이 바뀌어도
          //  따라간다. 터미널 이벤트에만 적용 — payload 가 작고 실패 전용이라 오추출 위험 낮음.
          const digFailure = (
            root: unknown,
          ): { code?: string; message?: string; param?: string } => {
            const found: { code?: string; message?: string; param?: string } = {};
            const visit = (o: unknown, depth: number): void => {
              if (depth > 3 || o === null || typeof o !== "object") return;
              for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
                if (typeof v === "string") {
                  if (k === "code" && found.code === undefined) found.code = v;
                  else if (k === "reason" && found.code === undefined) found.code = v;
                  else if (k === "message" && found.message === undefined) found.message = v;
                  else if (k === "param" && found.param === undefined) found.param = v;
                } else if (v !== null && typeof v === "object") {
                  visit(v, depth + 1);
                }
              }
            };
            visit(root, 0);
            return found;
          };
          // ★터미널 실패 3종 — 공식 SDK 이벤트(ResponseErrorEvent / ResponseFailedEvent /
          //  ResponseIncompleteEvent). 이 백엔드는 **HTTP 200 으로 스트림을 열어놓고 그 안에서
          //  실패를 통보**한다. 종전엔 어느 분기에도 안 걸려 조용히 버려졌고(예외가 아니라
          //  무관심), 호출부는 빈 텍스트만 보고 "모델이 침묵" 으로 오진했다.
          //  첫 실패만 보존한다 — 뒤따르는 이벤트가 사유를 덮어쓰지 않게.
          // ★"첫 실패만 보존" 은 틀렸다 (2026-07-30 2차) — 이 백엔드는 `error`(사유 없음)를
          //  먼저 보내고 `response.failed`(사유 있음)를 뒤에 보낸다. 먼저 온 걸 붙들면
          //  정작 사유를 버린다. **내용이 있는 쪽으로 승격**한다.
          const hasDetail = (
            f: CodexSseResult["failure"],
          ): boolean => f !== undefined && (f.code !== undefined || f.message !== undefined);
          if (!hasDetail(failure)) {
            const terminal =
              event.type === "error" ||
              event.type === "response.failed" ||
              event.type === "response.incomplete";
            if (terminal) {
              const dug = digFailure(event);
              failure = {
                source: event.type as string,
                raw: redactSecrets(data).slice(0, 400),
                ...dug,
              };
            }
          }
          // 터미널 이벤트는 lastEvent 에도 남긴다 — "무엇으로 끝났나" 가 completed 여부만이
          // 아니라 실패 종류까지 보이게(종전엔 completed 분기에서만 대입해 전부 "(없음)").
          if (
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            lastEvent = event.type;
          }
          // response.completed — final output_text fallback + response.id 추출.
          if (event.type === "response.completed") {
            if (text === "" && typeof event.response?.output_text === "string") {
              text = event.response.output_text;
            }
            lastEvent = typeof event.type === "string" ? event.type : lastEvent;
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
              const ct = u.input_tokens_details?.cached_tokens;
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
                ...(typeof ct === "number" ? { cachedTokens: ct } : {}),
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

  // lastEvent — 빈 응답 진단용(2026-07-30). `response.completed` 가 안 왔는지 로그로 가른다.
  return {
    text,
    responseId,
    toolCalls,
    usage,
    lastEvent,
    eventCounts,
    ...(failure !== undefined ? { failure } : {}),
  };
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

/**
 * **압축 연속 실패 추적** (2026-07-29).
 *
 * ★왜: 2026-07-29 사고가 **12일간 안 보인 이유**가 이것이다. 요약이 매 턴 실패했고
 *  로그엔 매 턴 경고가 찍혔는데, **아무도 세지 않았다.** 100번 실패해도 101번째에 같은 걸
 *  보낸다. 사용자는 "말만 하고 진행을 안 해"라는 *증상*만 겪고, 원인은 로그에 조용히 쌓였다.
 *  크기 문제는 예산으로 닫았지만(planHistoryCompaction), **다음에 다른 이유로 실패하면
 *  똑같이 조용할** 구조는 그대로였다. 그래서 실패 자체를 관측 대상으로 승격한다.
 *
 * 성공하면 0 으로 리셋 — 일시적 흔들림(429·네트워크)은 통과시키고 **고착만** 드러낸다.
 */
const compactionFailStreak = new Map<string, number>();
/** 이 횟수 연속 실패하면 이벤트로 올린다(그 뒤로는 재발행하지 않는다 — 로그 폭주 방지). */
const COMPACTION_STUCK_THRESHOLD = 3;

export const noteCompactionOutcome = (
  threadKey: string,
  ok: boolean,
  reason: string,
  foldChars: number,
): void => {
  if (ok) {
    compactionFailStreak.delete(threadKey);
    return;
  }
  const n = (compactionFailStreak.get(threadKey) ?? 0) + 1;
  compactionFailStreak.set(threadKey, n);
  if (n !== COMPACTION_STUCK_THRESHOLD) return; // 임계에서 정확히 1회만.
  console.error(
    `[codex 6b] ★히스토리 압축이 ${n}회 연속 실패 — 대화 맥락이 계속 버려지는 중입니다 ` +
      `(threadKey=${threadKey}, 접으려던 양=${foldChars}자, 사유=${reason}). ` +
      `이 상태가 지속되면 비서가 하던 작업을 잊고 계획만 반복합니다.`,
  );
  try {
    getEventBus().publish({
      type: "llm.compaction_stuck",
      ts: Date.now(),
      payload: { threadKey, streak: n, foldChars, reason },
    });
  } catch {
    // 관측 발행 실패가 턴을 무르지 않는다(원칙 3).
  }
};

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
  opts?: { triggerTurns?: number; keepRecent?: number; maxFoldChars?: number },
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
  const candidates = unsummarizedTurns.slice(0, foldCount);

  // ★한 번에 접는 양을 **글자 수로 묶는다** (2026-07-29 실사고).
  //
  //  종전엔 턴 수만 봤다. 그래서 오래 산 스레드에서 "666턴 = 2,838,563자" 를 한 번에
  //  요약하라고 보냈고(실측), 컨텍스트를 한참 넘겨 **빈 응답**이 왔다. 빈 응답이면 요약을
  //  저장하지 않으니 watermark 가 그대로고, 다음 턴에 **같은 280만 자를 또** 보낸다 —
  //  매 턴 1회씩 영원히 실패하는 루프다(로그: "[codex 6b] 요약 호출이 빈 결과" 가 턴마다).
  //  그 동안 히스토리는 oldest-drop 으로 잘려나가 모델이 하던 작업의 맥락을 잃고,
  //  사용자에겐 "진행하겠습니다" 만 하고 실행을 안 하는 것으로 보였다(신고된 증상).
  //
  //  그래서 진행을 **보장**하는 쪽으로 바꾼다: 예산 안에서 접을 수 있는 만큼만 접고
  //  watermark 를 그만큼 전진시킨다. 밀린 양이 많아도 턴을 거치며 점진적으로 따라잡고,
  //  각 호출은 항상 성공 가능한 크기다.
  //
  // ★단일 턴이 예산을 넘으면 **본문을 잘라서** 접는다 (2026-07-30 검토 지적).
  //  종전엔 `toFold.length > 0` 가드 때문에 첫 턴은 크기와 무관하게 통째로 들어갔다. 즉
  //  실효 하한이 "가장 오래된 턴 하나의 크기"였고, 그 턴이 백엔드 한도를 넘으면 예산을
  //  5,000까지 줄여도 **매 턴 같은 크기를 재전송** → watermark 정지 → 07-29 와 같은 영구
  //  루프다. 실측: 압축 대상 스레드에 단일 턴 **115,130자**가 존재하고, dashboard:default
  //  에도 58,798자가 대기 중이다(라이브 실패 관측치 87,387자를 넘는 구간).
  //  요약은 원문 보존이 목적이 아니라 **맥락 압축**이므로, 넘치는 부분은 마커를 남기고
  //  자르는 편이 "영원히 못 접는" 것보다 낫다. 원본 transcripts 는 그대로 남는다.
  const budget = opts?.maxFoldChars ?? CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS;
  const toFold: CodexTurnWithId[] = [];
  let used = 0;
  for (const t of candidates) {
    const body = String(t.content ?? "");
    const room = budget - used;
    if (toFold.length > 0 && body.length > room) break;
    if (body.length > room) {
      // 첫 턴이 예산을 넘음 → 잘라서라도 접어 진행을 보장한다.
      const kept = Math.max(1, room);
      toFold.push({
        ...t,
        content: `${body.slice(0, kept)}\n…[요약 입력 상한으로 ${body.length - kept}자 생략 — 원문은 transcripts 에 보존]`,
      });
      used = budget;
      break;
    }
    toFold.push(t);
    used += body.length;
  }
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
/**
 * **지금 즉시 압축** — `/compact` 명령이 부른다. 자동 압축(임계 초과 시)과 같은 경로·같은
 * 규칙을 쓰되 트리거만 건너뛴다. ★최근 턴은 그대로 둔다(keepRecent 유지) — 사용자가
 * "당연히 최근 건 압축하지 말고" 라고 한 그 규칙이 자동/수동 양쪽에 동일하게 적용된다.
 */
/**
 * 압축 진단 한 줄 — **로그만으로 원인을 좁힐 수 있게** 수치를 싣는다 (2026-07-29).
 *
 * ★왜: 회사 인스턴스처럼 **붙어서 DB 를 볼 수 없는 곳**이 있다. 오늘 그 로그로 진단했는데
 *  "요약 호출이 빈 결과" 는 방향만 알려줬고 **얼마나 큰지가 없어** dev DB 를 봐야 280만 자를
 *  알았다. 로그가 유일한 창구인 인스턴스에선 거기서 막힌다. 그래서 판정에 필요한 수치
 *  (접은 턴/글자·남은 미요약·watermark)를 성공·실패 양쪽에 남긴다.
 */
const compactionDiag = (
  threadKey: string,
  plan: { toFold: unknown[]; nextWatermark: number },
  promptChars: number,
  totalTurns: number,
  watermark: number,
): string =>
  `threadKey=${threadKey} fold=${plan.toFold.length}턴/${promptChars}자 ` +
  `watermark=${watermark}→${plan.nextWatermark} 전체=${totalTurns}턴`;

export const compactThreadNow = async (
  channel: ChannelName,
  threadKey: string,
  model: string,
  accessToken: string,
  accountId: string | undefined,
): Promise<
  | { ok: true; foldedTurns: number; foldedChars: number; summaryChars: number }
  | { ok: false; reason: string }
> => {
  const allTurns = loadThreadHistoryWithIds(channel, threadKey);
  if (allTurns.length === 0) return { ok: false, reason: "이 대화엔 아직 기록이 없습니다." };
  const existing = getThreadSummary(threadKey);
  const watermark = existing?.compactedThrough ?? 0;
  const prior = existing?.summary ?? "";
  const unsummarized = allTurns.filter((t) => t.id > watermark);
  // triggerTurns 0 = 임계 무시(수동 호출). keepRecent 는 기본값 그대로 — 최근은 안 접는다.
  const plan = planHistoryCompaction(unsummarized, watermark, { triggerTurns: 0 });
  if (!plan.needed || plan.toFold.length === 0) {
    return { ok: false, reason: "압축할 만큼 오래된 대화가 없습니다(최근 대화는 원문 유지)." };
  }
  const folded = plan.toFold
    .map((t) => `${t.role === "assistant" ? "비서" : "사용자"}: ${t.content}`)
    .join("\n");
  const prompt =
    prior === "" ? folded : `[기존 요약]\n${prior}\n\n[이어지는 대화]\n${folded}`;
  try {
    const fresh = await summarizeViaCodex(prompt, accessToken, accountId, model);
    if (fresh.trim() === "") {
      noteCompactionOutcome(threadKey, false, "빈 결과(수동)", prompt.length);
      return { ok: false, reason: "요약 결과가 비어 압축하지 못했습니다." };
    }
    upsertThreadSummary({
      threadKey,
      summary: fresh.trim(),
      compactedThrough: plan.nextWatermark,
    });
    noteCompactionOutcome(threadKey, true, "", prompt.length);
    return {
      ok: true,
      foldedTurns: plan.toFold.length,
      foldedChars: prompt.length,
      summaryChars: fresh.trim().length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    noteCompactionOutcome(threadKey, false, msg, prompt.length);
    return { ok: false, reason: msg };
  }
};

export const buildTurnHistory = async (
  input: RegionASdkInput,
  currentPromptWithMemory: string,
  mediaItems: ResponseMediaItem[] = [],
  accessToken: string,
  accountId: string | undefined,
  model: string,
  /**
   * 이번 요청의 `instructions` 바이트 — char 예산의 **고정 비용**(2026-07-30).
   * 종전엔 조립 프리픽스가 전부 currentPromptWithMemory 안에 있어서 예산이 그걸
   * 통해 시스템 프롬프트 무게를 자동으로 셌다. 안정 조각(~30KB)이 instructions 로
   * 옮겨간 뒤로는 그 자리가 예산에서 **비어** 과거 턴을 그만큼 더 끌어온다 —
   * 총 전송량이 조용히 늘어난다. 캡의 근거가 "합계 = 히스토리 + 시스템프롬프트"
   * 이므로(위 CODEX_TURN_HISTORY_CHAR_CAP 주석의 실측 표) 여기서 명시로 센다.
   */
  instructionsChars = 0,
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
  const plan = planHistoryCompaction(unsummarized, watermark, {
    maxFoldChars: currentFoldBudget(input.threadKey),
  });

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
        console.log(
          `[codex 6b] 압축 성공 — ${compactionDiag(input.threadKey, plan, prompt.length, allTurns.length, existing?.compactedThrough ?? 0)} 요약=${summary.length}자`,
        );
        growFoldBudget(input.threadKey);
        noteCompactionOutcome(input.threadKey, true, "", prompt.length);
        // ★압축 사실을 알린다 (2026-07-29). 종전엔 **성공해도 아무도 몰랐다** — 실패만
        //  로그에 남았다. 대화가 길어져 옛 내용이 요약으로 바뀌는 건 사용자가 알아야 할
        //  상태 변화다(클로드코드가 압축을 표시하는 것과 같은 이유). 임계 초과 시에만
        //  일어나므로 매 턴 뜨지 않는다.
        try {
          getEventBus().publish({
            type: "llm.compacted",
            ts: Date.now(),
            payload: {
              threadKey: input.threadKey,
              foldedTurns: plan.toFold.length,
              foldedChars: prompt.length,
              summaryChars: summary.length,
            },
          });
        } catch {
          /* 관측 발행 실패가 턴을 무르지 않는다(원칙 3). */
        }
      } else {
        // 빈 요약 = 무의미 → 폴백(요약 미반영, 기존 watermark 유지). 조용히 X.
        console.warn(
          `[codex 6b] 요약 호출이 빈 결과 — oldest-drop 폴백 ` +
            `(${compactionDiag(input.threadKey, plan, prompt.length, allTurns.length, existing?.compactedThrough ?? 0)}) ` +
            `→ 다음 시도 예산 ${shrinkFoldBudget(input.threadKey)}자로 축소`,
        );
        noteCompactionOutcome(input.threadKey, false, "빈 결과", prompt.length);
      }
    } catch (e) {
      // 요약 실패/타임아웃 → 현행 oldest-drop 폴백. 턴은 깨지 않음(데몬 생존 원칙 3).
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[codex 6b] 요약 호출 실패 — oldest-drop 폴백 ` +
          `(${compactionDiag(input.threadKey, plan, prompt.length, allTurns.length, existing?.compactedThrough ?? 0)}): ${msg}` +
            // ★예외 경로도 축소한다 (2026-07-30 검토 지적) — 종전엔 빈 결과만 백오프를 탔다.
            //  크기 때문에 hang → idle abort 로 죽는 실패가 이 catch 로 오는데 축소가 0이면
            //  같은 크기를 계속 재시도한다. 단 429/한도는 크기 문제가 아니므로 제외.
            (isRateLimited(msg)
              ? " (한도성 실패 — 예산 유지)"
              : ` → 다음 시도 예산 ${shrinkFoldBudget(input.threadKey)}자로 축소`),
      );
      noteCompactionOutcome(input.threadKey, false, msg, prompt.length);
    }
  }

  // watermark 이후 원문 턴 (압축 성공 시 최근 keepRecent + 그간 신규, 실패 시 전체 미요약).
  // charCap/limit 가드 = 최신부터 역누적, 초과 시 oldest drop (요약이 없을 때의 안전망).
  const recentRawAll: CodexTurn[] = allTurns
    .filter((t) => t.id > watermark)
    .map((t) => ({ role: t.role, content: t.content }));

  let charSum =
    instructionsChars + currentPromptWithMemory.length + summary.length;
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
// ★소스에 NUL 리터럴을 두지 않는다(2026-07-28) — 값은 같고 표기만 바꾸다.
//  리터럴 NUL 이 있으면 file(1) 이 이 파일을 binary 로 보고 **grep 이 조용히 건너뛴다**
//  (-a 없이는 0건). 감사·검증 스크립트가 이 파일만 무음으로 놓치는 사고가 실제로 났다.
const CODEX_COMPACTED_MARKER = "\u0000__codex_compacted__\u0000";

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
/**
 * 한 번의 요약 호출에 넣을 **최대 글자 수**(UTF-16 length, 바이트 아님).
 *
 * ★진짜 한계는 **토큰**이지 글자가 아니다. 같은 글자 수라도 한국어는 영어의 3~4배 토큰을
 *  먹는다(영 1토큰≈4글자, 한 1토큰≈1~1.5글자). 그래도 글자 수로 재는 이유는 **오차가 한
 *  방향으로만 아프기 때문**이다: 크게 잡으면 요약 실패 → 영구 루프(오늘 사고), 작게 잡으면
 *  압축이 여러 번 나뉠 뿐이다. 그래서 토크나이저 의존성을 들이는 대신 **가장 토큰을 많이
 *  먹는 언어(한국어)로 실측하고 그보다 낮게** 잡는다.
 *  실측(2026-07-29, 한국어): 12만 글자 정상 요약 / 280만 글자 빈 응답 → 예산 10만.
 */
const CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS = parsePosIntEnv(
  process.env.CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS,
  40_000,
);

/**
 * **적응 백오프** — 고정 상수로는 못 맞춘다 (2026-07-30 라이브 실측).
 *
 * ★어제 10만 자로 잡았는데 **87,387자가 실패**했다(60,650자는 성공). 내 측정이 낙관적이었다:
 *  프로브는 같은 문장을 반복한 텍스트였고, 실제 대화는 한국어+코드+JSON 이라 **같은 글자
 *  수라도 토큰이 훨씬 많다.** 즉 안전한 글자 수는 **내용 밀도에 따라 달라져서** 상수로
 *  고정할 수 없다.
 *
 *  그래서 추측을 그만두고 **실패에서 배우게** 한다: 빈 결과가 오면 그 스레드의 예산을
 *  절반으로 줄이고 다음 턴에 다시 시도한다. 몇 턴 안에 반드시 삼킬 수 있는 크기에 닿는다
 *  (진행 보장). 성공하면 천천히 되돌려 평소엔 큰 덩이로 접는다.
 */
const foldBudgetByThread = new Map<string, number>();
const MIN_FOLD_CHARS = 5_000;

/** 이 스레드에 지금 쓸 예산. */
const currentFoldBudget = (threadKey: string): number =>
  foldBudgetByThread.get(threadKey) ?? CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS;

/** 실패 → 절반으로(하한 유지). 다음 턴이 더 작은 덩이로 재시도한다. */
const shrinkFoldBudget = (threadKey: string): number => {
  const next = Math.max(MIN_FOLD_CHARS, Math.floor(currentFoldBudget(threadKey) / 2));
  foldBudgetByThread.set(threadKey, next);
  return next;
};

/** 성공 → 1.5배로 완만 복귀(상한 유지). 한 번 성공한 크기 근처를 유지한다. */
const growFoldBudget = (threadKey: string): void => {
  const cur = currentFoldBudget(threadKey);
  if (cur >= CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS) return;
  foldBudgetByThread.set(
    threadKey,
    Math.min(CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS, Math.floor(cur * 1.5)),
  );
};

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
/**
 * 절단 허용오차 — 줄 경계가 목표 지점에서 이만큼 안쪽이면 거기로 당긴다.
 * 넘으면 스냅을 포기한다(내용을 과하게 버리는 것보다 줄 중간 절단이 낫다).
 */
const LINE_SNAP_TOLERANCE = 2_000;

/** head 를 마지막 개행에서 끊는다(허용오차 안일 때만). */
const snapHeadToLine = (text: string, headChars: number): string => {
  const raw = text.slice(0, headChars);
  const nl = raw.lastIndexOf("\n");
  return nl >= 0 && headChars - nl <= LINE_SNAP_TOLERANCE ? raw.slice(0, nl) : raw;
};

/** tail 을 첫 개행 다음에서 시작한다(허용오차 안일 때만). */
const snapTailToLine = (text: string, tailChars: number): string => {
  const raw = text.slice(text.length - tailChars);
  const nl = raw.indexOf("\n");
  return nl >= 0 && nl + 1 <= LINE_SNAP_TOLERANCE ? raw.slice(nl + 1) : raw;
};

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
  // ★가능하면 **줄 경계**에서 끊는다 (2026-07-29 사용자 제안). 글자 수로만 자르면 JSON·로그가
  //  줄 한복판에서 끊겨 모델이 조각을 오해한다("…"key": "va" 처럼). 다만 **될 만할 때만** —
  //  한 줄이 통째로 거대하면(미니파이 JSON 등) 스냅할 자리가 없으므로, 경계가 허용오차 안에
  //  있을 때만 당기고 아니면 종전대로 글자 수로 자른다(내용을 더 버리지 않는다).
  const head = snapHeadToLine(output, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = snapTailToLine(output, tailChars).replace(/^[\uDC00-\uDFFF]/, "");
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
