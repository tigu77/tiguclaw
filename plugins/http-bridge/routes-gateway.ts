/**
 * **게이트웨이 라우트** — `/v1/models` · `/v1/chat/completions` 의 **본문**.
 *
 * ★`index.ts` 의 `handleRequest`(2,972줄)에서 떼어냈다 (2026-08-30, R3). 이 둘만 498줄이었다.
 *
 * ★**`if (pathname === …)` 조건은 `index.ts` 에 남겼다.** 조건까지 옮기면 각 함수가
 *  *"내가 처리했나"* 를 boolean 으로 돌려줘야 하고, 그러면 본문의 `return;` 14개를 전부
 *  `return true;` 로 고쳐야 한다 — 그중 하나라도 **콜백 안**이면 타입체커가 못 잡고
 *  조용히 의미가 바뀐다. 본문만 `Promise<void>` 로 옮기면 `return;` 은 **한 글자도 안
 *  바뀐다.** 라우트가 어디 있는지도 `index.ts` 한 곳에서 계속 보인다.
 *
 * ★인증이 다르다 — 이 둘은 브리지 role 표가 아니라 **자기 게이트웨이 토큰**으로 가르고,
 *  그래서 role 표 앞에서 일찍 반환한다(회귀 `bridge-role-table-complete` 가 그 예외를 지킨다).
 */
import type http from "node:http";
import type { RouteCtx } from "./route-ctx.js";
import { safeUnsubscribe, type EventBus } from "../../src/core/eventbus.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { runRegionA } from "../../src/core/llm-runtime/index.js";
import type { Attachment } from "../../src/channels/types.js";
import { ingestAttachments } from "./attachments.js";
import {
  type GatewayChatMessage,
  resolveGatewayRuntime,
  resolveGatewaySpecs,
  buildModelsListResponse,
  extractGatewayImageAttachments,
  flattenChatMessages,
  parseGatewayTools,
} from "./gateway.js";
import { readJsonBody } from "./http-body.js";
import { endpointPreview } from "./endpoint-preview.js";


/**
 * 동시 처리 카운터 — `/v1/chat/completions` 만 증감한다.
 * ★상태는 **그걸 만지는 곳**에 둔다. 잠깐 `index.ts` 에 있었는데 여기가 맞다.
 */
let gatewayInflight = 0;

export const serveGatewayModels = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  void req;
  const gw = resolveGatewayRuntime(); // settings fresh read → 재시작 없이 반영.
  if (!gw.enabled) {
    writeJson(res, 404, { error: { message: "llm gateway disabled (settings gateway.enabled / token not set)" } });
    return;
  }
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (bearer !== gw.token) {
    writeJson(res, 401, { error: { message: "unauthorized" } });
    return;
  }
  writeJson(res, 200, buildModelsListResponse(gw.poolRaw));
};

export const serveGatewayChat = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  const gw = resolveGatewayRuntime(); // settings fresh read → 재시작 없이 반영.
  if (!gw.enabled) {
    writeJson(res, 404, { error: { message: "llm gateway disabled (settings gateway.enabled / token not set)" } });
    return;
  }
  const gwAuth = req.headers.authorization ?? "";
  const bearer = gwAuth.startsWith("Bearer ") ? gwAuth.slice("Bearer ".length).trim() : "";
  if (bearer !== gw.token) {
    writeJson(res, 401, { error: { message: "unauthorized" } });
    return;
  }
  if (gatewayInflight >= gw.maxConcurrency) {
    writeJson(res, 429, { error: { message: "gateway busy (max concurrency reached)" } });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    writeJson(res, 400, { error: { message: `invalid body: ${e instanceof Error ? e.message : String(e)}` } });
    return;
  }
  const messages = Array.isArray(body.messages)
    ? (body.messages as GatewayChatMessage[])
    : [];
  if (messages.length === 0) {
    writeJson(res, 400, { error: { message: "messages required" } });
    return;
  }
  const { system, text } = flattenChatMessages(messages);
  // 함수콜 패스스루(ADR 2026-07-25 §Decision-5) — body.tools 없으면 미주입(현행, 회귀 0).
  const gatewayTools = parseGatewayTools(body);
  // 비전(ADR 2026-07-25) — messages content 의 image_url(data: URI) → Attachment. 기존
  //   ingestAttachments/attachments seam 재사용(어댑터 vision 경로 그대로). 이미지 없으면
  //   빈 배열=현행 text-only(회귀 0). 파싱/캡 위반은 400.
  let gatewayAttachments: Attachment[] = [];
  try {
    gatewayAttachments = await ingestAttachments(
      extractGatewayImageAttachments(messages),
      ctx.channelName,
    );
  } catch (e) {
    writeJson(res, 400, {
      error: { message: `image parse failed: ${e instanceof Error ? e.message : String(e)}` },
    });
    return;
  }
  // 강제 지정한 함수가 tools 목록에 없다 = 클라이언트 실수. 조용히 auto 로 돌지 않는다.
  const forced =
    gatewayTools.externalToolChoice !== undefined &&
    typeof gatewayTools.externalToolChoice === "object"
      ? gatewayTools.externalToolChoice.name
      : undefined;
  if (forced !== undefined && !(gatewayTools.externalTools ?? []).some((t) => t.name === forced)) {
    writeJson(res, 400, {
      error: {
        message: `tool_choice 가 지정한 함수 "${forced}" 가 tools 목록에 없습니다.`,
        type: "invalid_tool_choice",
      },
    });
    return;
  }
  const specs = resolveGatewaySpecs(body.model, gw.poolRaw);
  const runInput = {
    text: text !== "" ? text : " ",
    threadKey: `gateway:${crypto.randomUUID()}`,
    channel: ctx.channelName,
    // ★`internal` 을 뗀다 (2026-08-12, 사용자 결정: "게이트웨이도 같이 남기는 게 맞지
    //  않을까"). 종전엔 persist·turn 이벤트를 통째로 스킵해서, 이벤트 미리보기(4,000자)를
    //  넘는 요청은 **어디에도 남지 않았다** — 유일한 기록이 잘린 사본이었다.
    //  엔드포인트(`endpoint:<name>:<nonce>`)는 원래 이렇게 돈다: transcripts 에 전문이
    //  남고, 화면 오염은 **threadKey 접두 필터**가 막는다(세션 목록은 이미 `gateway:` 를
    //  배제한다 — store/sessions.ts excludeInternal). 같은 표면이니 같은 규칙을 쓴다.
    //  ★부수효과도 대칭이다: 이제 게이트웨이 턴도 llm.turn_done/turn_error 를 낸다 —
    //   외부에 열린 표면의 건강이 자가 진단에 잡히는 건 옳다(대신 그 실패는 '내 대화'가
    //   아니라 외부 호출로 분류된다 — core/health-sweep.ts).
    toolPolicy: { mode: "none" as const }, // 도구 0.
    systemPromptOverride: system, // 앱 system(빈 문자열도 override — 비서 페르소나 스킵).
    ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}), // 비전.
    ...gatewayTools, // 함수콜 패스스루(externalTools/externalToolChoice, 없으면 미주입).
  };
  // ── 게이트웨이 호출 기록 (2026-08-10) ────────────────────────────────
  // ★게이트웨이는 **외부에 열린 표면**인데 정태님이 볼 자리가 없었다: transcripts 0건
  //  (internal:true 라 의도적으로 안 남긴다 — 앱 데이터를 우리 DB 에 쌓을 이유가 없다),
  //  events 는 llm.activity 뿐. "누가·언제·뭘·얼마나 썼나" 조차 남지 않았다.
  //  엔드포인트가 2026-08-01 에 같은 병을 앓고 고쳤다(endpoint.call 을 SKIP 에서 뺌).
  //  ★**본문도 남긴다** (2026-08-12, 사용자 결정: "요청·결과 다 남는 게 맞지 않나?
  //   그걸 알고 싶어서 저기에 기록이 남는 건데"). 종전 주석은 "앱 데이터라 회계·건강만"
  //   이라고 적었는데 그건 **내 판단이었고 사용자 것이 아니었다.** 티구클로에 연결해 쓰는
  //   내 앱이라면 무슨 요청이 오갔는지가 곧 이 기록의 목적이다.
  //  ★단, 게이트웨이 턴은 `internal:true` 라 transcripts 에 안 남는다 — 즉 **이 이벤트가
  //   유일한 기록**이다. 그래서 엔드포인트와 같은 미리보기 상한을 쓰되(핫경로 바운드),
  //   잘렸으면 얼마나 잘렸는지 본문에 명시한다(조용한 절단 금지).
  const gwCallId = crypto.randomUUID();
  const gwStartedAt = Date.now();
  const publishGatewayCall = (
    phase: "start" | "done",
    extra: Record<string, unknown> = {},
  ): void => {
    try {
      ctx.bus?.publish({
        type: "gateway.call",
        ts: phase === "start" ? gwStartedAt : Date.now(),
        payload: {
          callId: gwCallId,
          phase,
          model: typeof body.model === "string" ? body.model : "(기본)",
          stream: body.stream === true,
          messages: messages.length,
          ...extra,
        },
      });
    } catch {
      /* 관측 발행 실패가 응답을 무르지 않는다(원칙 3). */
    }
  };
  publishGatewayCall("start", { request: endpointPreview(runInput.text) });
  const specOpt = specs.length > 0 ? { specs } : undefined;
  const cid = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const reqModel = typeof body.model === "string" ? body.model : "tiguclaw";

  // ── 스트리밍(stream:true) — SSE, OpenAI chat.completion.chunk. 이 게이트웨이 턴의
  // llm.delta(threadKey 필터)를 구독해 content 청크로 중계. 델타 전무(비스트리밍 모델)
  // 시 완료 후 전체본 1청크 폴백. 함수콜(ADR 2026-07-25 §Decision-5) — llm.tool_call_delta
  // (형제 이벤트, llm.delta 확장 아님)를 옆에서 구독해 index-기반 tool_calls 조각으로 중계.
  // externalTools 미요청 turn 은 이 이벤트 발행처 자체가 없어 이 구독은 그냥 무동작(회귀 0). ──
  if (body.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let modelLabel = reqModel;
    let sawDelta = false;
    let sawToolCallDelta = false;
    const chunk = (delta: Record<string, unknown>, finish: string | null): void => {
      res.write(
        `data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: modelLabel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    };
    chunk({ role: "assistant" }, null);
    const unsub =
      ctx.bus !== null
        ? ctx.bus.subscribe((ev) => {
            if (ev.type !== "llm.delta") return;
            const p = ev.payload as {
              threadKey?: string;
              delta?: string;
              model?: string;
            };
            if (p.threadKey !== runInput.threadKey) return;
            if (typeof p.model === "string" && p.model !== "") modelLabel = p.model;
            if (typeof p.delta === "string" && p.delta !== "") {
              sawDelta = true;
              chunk({ content: p.delta }, null);
            }
          })
        : null;
    const unsubTool =
      ctx.bus !== null
        ? ctx.bus.subscribe((ev) => {
            if (ev.type !== "llm.tool_call_delta") return;
            const p = ev.payload as {
              threadKey?: string;
              index?: number;
              id?: string;
              name?: string;
              argumentsDelta?: string;
            };
            if (p.threadKey !== runInput.threadKey) return;
            if (typeof p.index !== "number") return;
            sawToolCallDelta = true;
            chunk(
              {
                tool_calls: [
                  {
                    index: p.index,
                    ...(typeof p.id === "string" && p.id !== "" ? { id: p.id, type: "function" } : {}),
                    function: {
                      ...(typeof p.name === "string" && p.name !== "" ? { name: p.name } : {}),
                      ...(typeof p.argumentsDelta === "string" && p.argumentsDelta !== ""
                        ? { arguments: p.argumentsDelta }
                        : {}),
                    },
                  },
                ],
              },
              null,
            );
          })
        : null;
    gatewayInflight += 1;
    try {
      const out = await runRegionA(runInput, specOpt);
      if (out.model !== undefined && out.model !== null && out.model !== "") modelLabel = out.model;
      const toolCalls = out.externalToolCalls ?? [];
      if (toolCalls.length > 0) {
        if (!sawToolCallDelta) {
          // 델타 미발행(폴링형/비스트리밍 어댑터) — llm.delta 전무 폴백과 동형: 완료 후
          // 전체 tool_calls 1청크로.
          chunk(
            {
              tool_calls: toolCalls.map((tc, i) => ({
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.argumentsJson },
              })),
            },
            null,
          );
        }
        chunk({}, "tool_calls");
      } else {
        if (!sawDelta && out.text) chunk({ content: out.text }, null); // 델타 전무 폴백.
        chunk({}, "stop");
      }
      res.write("data: [DONE]\n\n");
      publishGatewayCall("done", {
        ok: true,
        request: endpointPreview(runInput.text),
        response: endpointPreview(
          out.text !== undefined && out.text !== ""
            ? out.text
            : `(텍스트 없음 — 도구 호출 ${(out.externalToolCalls ?? []).length}건)`,
        ),
        inputTokens: out.usage?.inputTokensTotal ?? out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokensTotal ?? out.usage?.outputTokens ?? 0,
        toolCalls: (out.externalToolCalls ?? []).length,
        elapsedMs: Date.now() - gwStartedAt,
        ...(typeof out.model === "string" && out.model !== "" ? { servedBy: out.model } : {}),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      res.write(`data: ${JSON.stringify({ error: { message: reason } })}\n\n`);
      // 실패도 남긴다 — 스트리밍은 200 으로 시작해 중간에 깨지므로 상태코드로는 안 보인다.
      publishGatewayCall("done", {
        ok: false,
        request: endpointPreview(runInput.text),
        error: reason.slice(0, 300),
        elapsedMs: Date.now() - gwStartedAt,
      });
    } finally {
      if (unsub !== null) safeUnsubscribe(unsub);
      if (unsubTool !== null) safeUnsubscribe(unsubTool);
      gatewayInflight -= 1;
      res.end();
    }
    return;
  }

  // ── 비스트리밍 — out.externalToolCalls 있으면 tool_calls 응답(§Decision-5), 없으면
  // 기존 그대로(content:out.text, finish_reason:"stop") — 하위호환 100%. ──
  gatewayInflight += 1;
  try {
    const out = await runRegionA(runInput, specOpt);
    // ★prompt_tokens 는 **턴 전체 합계** (2026-07-30). `inputTokens` 는 계약상
    //  "마지막 호출 1회"(컨텍스트 참 정도)라, 도구 루프를 도는 요청에서 그걸 내보내면
    //  클라이언트 비용·예산 회계가 실제의 일부만 본다. 제3자에게 나가는 값이라
    //  우리 화면처럼 나중에 눈으로 걸러지지 않는다 — 합계가 정직하다.
    const inTok = out.usage?.inputTokensTotal ?? out.usage?.inputTokens ?? 0;
    // ★출력도 **턴 합계**다 — 바로 위 주석이 입력에 대해 말한 이유가 출력에도 그대로
    //  적용된다. 한쪽만 합계면 클라이언트 회계가 비대칭으로 틀린다(2026-08-09 벤치에서
    //  같은 비대칭이 "우리가 11배 효율적"이라는 거짓 결론을 만들었다).
    const outTok = out.usage?.outputTokensTotal ?? out.usage?.outputTokens ?? 0;
    const toolCalls = out.externalToolCalls ?? [];
    const hasToolCalls = toolCalls.length > 0;
    const bodyText = out.text ?? "";
    // ★★게이트웨이는 **반드시 결과를 준다**: tool_calls · 텍스트 · 명시적 에러 셋 중 하나.
    //  침묵도 빈 200 도 없다. 앱 입장에서 제일 나쁜 건 "아무 일도 안 일어난 것처럼 보이는
    //  성공 응답"이다 — 어디를 고쳐야 할지 알 수가 없다(2026-08-09 실사용 사고의 본체).
    if (!hasToolCalls && bodyText.trim() === "") {
      writeJson(res, 502, {
        error: {
          message:
            "모델이 빈 응답을 반환했습니다(텍스트도 함수콜도 없음). 요청은 정상 처리됐으나 결과가 비었습니다 — 모델/풀 상태를 확인하세요.",
          type: "empty_completion",
        },
      });
      return;
    }
    // ★`tool_choice:"required"` = 반드시 도구를 부른다(OpenAI 계약). 못 지켰으면 텍스트를
    //  성공인 척 돌려주지 않는다 — 앱은 tool_calls 를 기다리고 있고, 조용히 텍스트를 받으면
    //  '모델이 도구를 안 쓴다'로만 보인다(그 진단에 하루가 들었다).
    if (!hasToolCalls && gatewayTools.externalToolChoice === "required") {
      writeJson(res, 502, {
        error: {
          message: `tool_choice:"required" 인데 모델이 함수를 호출하지 않았습니다(텍스트만 반환). 모델을 바꾸거나 tool_choice 를 "auto" 로 낮추세요.`,
          type: "tool_choice_unsatisfied",
        },
      });
      return;
    }
    writeJson(res, 200, {
      id: cid,
      object: "chat.completion",
      created,
      model: out.model ?? reqModel,
      choices: [
        {
          index: 0,
          message: hasToolCalls
            ? {
                role: "assistant",
                content: null,
                tool_calls: toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.argumentsJson },
                })),
              }
            : { role: "assistant", content: out.text ?? "" },
          finish_reason: hasToolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
    });
    publishGatewayCall("done", {
      ok: true,
      request: endpointPreview(runInput.text),
      response: endpointPreview(
        out.text !== undefined && out.text !== ""
          ? out.text
          : `(텍스트 없음 — 도구 호출 ${toolCalls.length}건)`,
      ),
      inputTokens: inTok,
      outputTokens: outTok,
      toolCalls: toolCalls.length,
      elapsedMs: Date.now() - gwStartedAt,
      ...(typeof out.model === "string" && out.model !== "" ? { servedBy: out.model } : {}),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    writeJson(res, 502, { error: { message: reason } });
    // 실패도 남긴다 — 외부 표면의 건강은 성공만 봐선 안 보인다.
    publishGatewayCall("done", {
      ok: false,
      request: endpointPreview(runInput.text),
      error: reason.slice(0, 300),
      elapsedMs: Date.now() - gwStartedAt,
    });
  } finally {
    gatewayInflight -= 1;
  }
};
