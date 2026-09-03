/**
 * **대화 라우트** — 보내기·이력·검색.
 *
 * ★`/messages` 가 브리지에서 제일 무거운 라우트다(231줄) — 첨부를 받고, 좌표를 정규화하고,
 *  낙관 버블을 발행하고, 비서에게 넘긴다. **인입의 유일한 문**이라 여기서 새면 대화가 샌다.
 */
import { AttachmentError } from "./attachments.js";
import { HANDLER_TIMEOUT_MS } from "./route-ctx.js";
import type { Attachment, IncomingMessage } from "../../src/channels/types.js";
import { getAssistantName } from "../../src/core/identity.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { resolveSessionId } from "../../src/core/threadkey.js";
import { isCancelledTurnResult, isSteeredTurnResult } from "../../src/core/worker-jobs.js";
import { getRecentChatLog } from "../../src/store/chat-log.js";
import { ingestAttachments, persistOutboundAttachment } from "./attachments.js";
import { historyActivities } from "./history-activities.js";
import { readJsonBody } from "./http-body.js";
import type { RouteCtx } from "./route-ctx.js";

export const handleMessages = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  if (ctx.channelHandler === null) {
    writeJson(res, 503, { error: "channel not started" });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${msg}` });
    return;
  }
  const text =
    typeof body.text === "string" ? body.text.trim() : "";
  // 첨부(#2) — 붙여넣은 파일을 홈에 저장해 Attachment[] 구성. 캡 위반·저장 실패 = 400.
  let attachments: Attachment[] = [];
  try {
    attachments = await ingestAttachments(body.attachments, ctx.channelName);
  } catch (e) {
    writeJson(res, 400, {
      error:
        e instanceof AttachmentError
          ? e.message
          : `attachment 처리 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }
  // 파일만 보내는 경우(캡션 없는 첨부)도 허용 — text 또는 attachments 중 하나면 진행.
  if (text === "" && attachments.length === 0) {
    writeJson(res, 400, { error: "text 또는 attachments 가 필요합니다." });
    return;
  }
  // 채널/세션 분리(ADR 2026-07-15 §D1/§D2) — 대시보드는 활성 탭 세션 id 를 body.threadKey
  // 로 명시 전달(explicitSessionId → resolveSessionId passthrough). 비-대시보드 http
  // default(threadKey 미부여)는 기본 세션(DEFAULT_SESSION_ID)으로 수렴. channelAddress =
  // http 배달 좌표(= sessionId, 대시보드가 SSE 를 그 탭으로 라우팅). msg.threadKey=sessionId
  // 로 세팅(직렬 큐/`/cancel-queued`/`/stop` 정합) + session 으로 route 가 canonical
  // (http-bridge, sessionId) 로 정규화. 세션 id 는 채널 무관 — telegram/cli 기본 세션과 공유.
  const explicitSessionId =
    typeof body.threadKey === "string" && body.threadKey.trim() !== ""
      ? body.threadKey.trim()
      : undefined;
  const threadKey = resolveSessionId(
    ctx.channelName,
    explicitSessionId,
    explicitSessionId,
  );
  const channelUserId =
    typeof body.userId === "string" && body.userId.trim() !== ""
      ? body.userId
      : "http-bridge";

  let replyText = "";
  // 축1(2026-06-25) — 선택지 제시. http-bridge 는 SSE 채널이므로 inline keyboard
  // (telegram) 대신 EventBus 에 `prompt.options` 이벤트를 publish 한다. 대시보드가
  // SSE 로 받아 버튼 묶음을 채팅 흐름에 렌더하고, 클릭 시 그 value 를 POST /messages
  // {text:value} 로 흘려보낸다(= 사용자가 그 값을 입력한 것과 동치, route() 단일 인격
  // 재진입). 비차단: 이벤트 1회 publish 후 즉시 {ok:true}. bus 미연결(observer 미부착)
  // 환경에선 렌더 경로가 없으므로 {ok:false} → MCP 도구가 텍스트 제시로 graceful 폴백.
  const bus = ctx.bus;
  const presentOptions: IncomingMessage["presentOptions"] = async (
    question,
    options,
    presentOpts,
  ) => {
    if (bus === null) {
      return { ok: false, error: "control bus not started (관측 미연결)" };
    }
    try {
      bus.publish({
        type: "prompt.options",
        ts: Date.now(),
        payload: {
          channel: ctx.channelName,
          threadKey,
          question,
          options,
          ...(presentOpts?.note !== undefined
            ? { note: presentOpts.note }
            : {}),
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  // 답글 인용(대시보드 등) — body.replyToText 를 중립 필드로 실어 route 직전 인용 주입
  // (telegram 의 reply_to_message 와 동형·LLM-agnostic, index.ts 934 단일 지점). 캡 1500.
  const replyToText =
    typeof body.replyToText === "string" ? body.replyToText.trim().slice(0, 1500) : "";
  // 큐-취소 correlationId(ADR 2026-07-15) — 클라(대시보드)가 전송 순간 만든 상관 id.
  // 실제 사용자 인바운드(POST /messages)만 실린다 — 이 값을 큐 항목 식별 키로 전달해
  // 대기 중(미시작) 항목을 나중에 POST /cancel-queued 로 지목 취소 가능. 미부여 = 익명
  // 큐 항목(현행 동작). 어댑터는 이 값을 안 읽는다(순수 큐 상관, #2 LLM-agnostic).
  const correlationId =
    typeof body.correlationId === "string" ? body.correlationId.trim() : "";
  // egress fan-out(ADR 2026-07-16 §D4 Phase B2) — 컴포저 체크박스가 "이 답도 함께 보낼"
  // 추가 채널들(예 telegram)을 body.outboundChannels(string[]) 로 실어 온다. swap 아님 —
  // 인입 채널 응답은 항상 유지. 여기선 문자열 배열 검증만(라우팅·outbound-capable 여부는 코어
  // handler 가 레지스트리 조회로) → egressChannels 중립 필드로 전달. 미지정/빈 배열/비배열 =
  // undefined(현행 동작·회귀 0). 중복·빈문자 제거.
  const egressChannels = Array.isArray(body.outboundChannels)
    ? [
        ...new Set(
          body.outboundChannels
            .filter((c): c is string => typeof c === "string")
            .map((c) => c.trim())
            .filter((c) => c !== ""),
        ),
      ]
    : [];
  // 아웃바운드 첨부(send_file, #2 parity) — 텔레그램 sendDocument 와 동형의 추상 의도
  // 렌더. send_file 된 절대경로를 통제 디렉터리로 복사(servable rel 확보)한 뒤,
  // `channel.message.out` 이벤트에 additive `attachments:[{rel,name,mime,kind,caption?}]`
  // 를 실어 발행한다 → 대시보드가 SSE 로 받아 첨부 카드(미리보기+받기 버튼)로 렌더하고,
  // event-persist 가 chat_log(role:assistant)에 영속(인바운드 첨부 영속과 대칭 = 새로고침·
  // 재시작 후에도 유지). 멱등은 호출자(send_file 도구, per-turn sentPaths)가 보장 — 채널은
  // 복사+발행 1회만. bus 미연결(observer 미부착)이면 렌더 경로 없음 → {ok:false}.
  const channelName = ctx.channelName;
  const sendAttachment: IncomingMessage["sendAttachment"] = async (
    filePath,
    opts,
  ) => {
    const meta = await persistOutboundAttachment(filePath, channelName).catch(
      () => null,
    );
    if (meta === null) {
      return {
        ok: false,
        error: `파일을 찾을 수 없거나 접근할 수 없습니다: ${filePath}`,
      };
    }
    if (bus === null) {
      return { ok: false, error: "control bus not started (대시보드 미연결)" };
    }
    try {
      bus.publish({
        type: "channel.message.out",
        ts: Date.now(),
        payload: {
          channel: channelName,
          threadKey,
          text: "", // 첨부-only 아웃바운드(캡션은 attachment.caption 으로). 최종 답변 text-out 과 별개 버블.
          attachments: [
            {
              rel: meta.rel,
              mime: meta.mime,
              name: meta.name,
              kind: meta.kind,
              bytes: meta.bytes,
              ...(opts?.caption !== undefined && opts.caption !== ""
                ? { caption: opts.caption }
                : {}),
            },
          ],
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const msg: IncomingMessage = {
    channel: ctx.channelName,
    channelUserId,
    threadKey,
    // 배달 좌표(http) = sessionId. 세션 정규화 지시(session) — 대시보드는 explicitSessionId
    // 로 활성 탭 세션 passthrough, 비-대시보드는 미부여 → route 가 DEFAULT 로 수렴.
    channelAddress: threadKey,
    session: {
      ...(explicitSessionId !== undefined ? { explicitSessionId } : {}),
      channelAddress: threadKey,
    },
    text,
    receivedAt: Date.now(),
    ...(replyToText !== "" ? { replyToText } : {}),
    ...(correlationId !== "" ? { correlationId } : {}),
    ...(egressChannels.length > 0 ? { egressChannels } : {}),
    // ★`noEgress: true` 면 이 답을 다른 채널로 복사하지 않는다 — 프로그램이 띄우는 턴
    //  (프로브·스크립트·통합)이 사용자 폰을 울리지 않게. 덜 보내는 쪽이라 안전하다.
    ...(body.noEgress === true ? { noEgress: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    reply: async (out: string): Promise<void> => {
      replyText = out;
    },
    sendAttachment,
    presentOptions,
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("timeout"));
    }, HANDLER_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([ctx.channelHandler(msg), timeoutP]);
    // 큐-취소(ADR 2026-07-15, G1) — 이 항목이 대기 중 취소돼 handler 미실행 no-op
    // resolve 면 정상 흐름으로 {replyText:"", cancelled:true} 응답(에러 아님). 클라는
    // 이미 취소 UI 를 로컬 처리했으므로 무시 가능. isCancelledTurnResult 가 sentinel 판정.
    if (isCancelledTurnResult(outcome)) {
      writeJson(res, 200, { replyText: "", cancelled: true });
    } else if (isSteeredTurnResult(outcome)) {
      // mid-turn steering 주입(ADR 2026-07-16) — 이 메시지는 새 턴이 아니라 진행 턴에
      // append 됐고 핸들러가 즉시 resolve 한다(원래 턴은 아직 진행). 클라가 이 200-반환을
      // "턴 완료"로 오인해 작업중을 조기에 끄지 않도록 steered 플래그를 실어 응답한다.
      // 실제 종료는 원래 턴의 SSE channel.message.out/turn_done 이 담당(steering 조기-off 픽스).
      writeJson(res, 200, { replyText: "", steered: true });
    } else {
      writeJson(res, 200, { replyText });
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (reason === "timeout") {
      writeJson(res, 504, { error: "timeout" });
    } else {
      writeJson(res, 500, { error: reason });
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  return;
};

export const handleChatHistory = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  try {
    const limitRaw = url.searchParams.get("limit");
    const parsed = limitRaw !== null ? parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    // beforeTs — 페이지네이션(스크롤 더보기). 그 시각 *이전* N 건을 ASC 반환.
    // 안전 파싱: 유효 양수만 전달, 그 외엔 undefined(= 최신 묶음).
    const beforeRaw = url.searchParams.get("beforeTs");
    const beforeParsed =
      beforeRaw !== null ? parseInt(beforeRaw, 10) : NaN;
    const beforeTs =
      Number.isFinite(beforeParsed) && beforeParsed > 0
        ? beforeParsed
        : undefined;
    // threadKey — 멀티세션 탭(ADR 2026-07-15 D5.3). 지정 시 그 스레드만, 미지정 시
    // 현행(전 스레드 병합, 회귀 0). limit/beforeTs 와 결합.
    const threadKeyRaw = url.searchParams.get("threadKey");
    const threadKey =
      threadKeyRaw !== null && threadKeyRaw.trim() !== ""
        ? threadKeyRaw
        : undefined;
    // 복합 커서의 두 번째 축 — 같은 ts 가 여럿일 때 경계 행이 유실되는 것을 막는다.
    // ★2026-08-23 3라운드: 이 파싱을 한 번 **잘못 지웠다.** "죽은 코드" 라고 판단한 건
    //  `/all-activity` 쪽이었는데 일괄 치환이 두 핸들러를 다 잡아서 **살아 있는 이쪽**이
    //  지워졌고, 주석·커밋 메시지·백로그가 셋 다 반대로 적혔다. 실측 귀결: 동률 3행 ×
    //  40그룹(120행)을 끝까지 페이징해 **96행만 수집 — 24행(20%) 영구 유실**.
    //  보내는 쪽은 `history-render.js:468,517`(위로 더보기·점프) 두 곳이다 — 지우기 전에
    //  **보내는 쪽을 grep** 했으면 30초에 보였다. [[feedback_verify_before_asserting]]
    const beforeIdRaw2 = parseInt(url.searchParams.get("beforeId") ?? "", 10);
    const beforeId2 =
      Number.isFinite(beforeIdRaw2) && beforeIdRaw2 > 0 ? beforeIdRaw2 : undefined;
    const entries = getRecentChatLog({
      limit,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
      ...(beforeId2 !== undefined ? { beforeId: beforeId2 } : {}),
      ...(threadKey !== undefined ? { threadKey } : {}),
    });
    // 비서 표시 이름(AGENT.md 이름 필드, 없으면 tiguclaw) — 대시보드 채팅 라벨용.
    // activities(기능 B) — 이력에 도구 스텝 복원(새로고침 후에도 도구 사용 표시).
    writeJson(res, 200, {
      entries,
      // 상한은 역방향 페이지네이션(beforeTs)일 때만 — 최신 페이지는 진행 중 턴의
      // 활동이 chat_log 마지막 행보다 뒤에 있어 상한을 걸면 통째로 사라진다.
      activities: historyActivities(entries, threadKey, beforeTs !== undefined),
      assistantName: getAssistantName(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleChatSearch = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  try {
    // ★조합(정규화→조회→스니펫→총건수)은 `core/chat-search.searchConversations` 한 곳이다.
    //  비서의 `search_conversations` 도구도 **같은 함수**를 쓴다 — 여기서 다시 조합하면
    //  도구와 화면이 다른 답을 준다.
    const { searchConversations } = await import("../../src/core/chat-search.js");
    const n = (v: string | null): number | undefined => {
      const x = parseInt(v ?? "", 10);
      return Number.isFinite(x) && x > 0 ? x : undefined;
    };
    const tkRaw = url.searchParams.get("threadKey");
    const threadKey = tkRaw !== null && tkRaw.trim() !== "" ? tkRaw : undefined;
    const r = await searchConversations(url.searchParams.get("q") ?? "", {
      ...(n(url.searchParams.get("limit")) !== undefined
        ? { limit: n(url.searchParams.get("limit"))! }
        : {}),
      ...(threadKey !== undefined ? { threadKey } : {}),
      ...(n(url.searchParams.get("beforeTs")) !== undefined
        ? { beforeTs: n(url.searchParams.get("beforeTs"))! }
        : {}),
      ...(n(url.searchParams.get("beforeId")) !== undefined
        ? { beforeId: n(url.searchParams.get("beforeId"))! }
        : {}),
    });
    // 너무 짧다 = 오류가 아니라 **아직 검색할 게 아니다**. 빈 결과로 조용히 답한다.
    if (r.tooShort) {
      writeJson(res, 200, { hits: [], query: "", tooShort: true });
      return;
    }
    writeJson(res, 200, {
      hits: r.hits,
      total: r.total,
      limit: r.limit,
      query: r.query,
      scope: r.scope,
    });
  } catch (err) {
    writeJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return;
};
