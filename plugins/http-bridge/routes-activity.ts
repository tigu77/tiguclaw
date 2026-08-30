/**
 * **활동 라우트** — SSE 이벤트 스트림 · 엔드포인트 호출 · 전체 활동.
 *
 * ★`/events` 는 **연결을 붙들고 있는** 유일한 라우트다(SSE). 그래서 `ctx.sseClients` 를
 *  만지고, 다른 라우트와 수명이 다르다 — 자리를 가른 이유가 그것이다.
 */
// 신규 SSE 접속 history replay 에서 제외할 고volume 스트리밍 타입.
// - llm.delta: 토큰 증분(P5). 재연결이 옛 턴 토큰을 재생해 깨진 부분 버블을 만들지 않도록.
//   라이브 fan-out 은 통과(진행 중 턴 실시간엔 필요), history(과거 재생)에서만 제외.
//   최종 권위 전체본은 channel.message.out 이라 델타 재생 없이도 수렴.
// - llm.sdk_message: claude firehose. 같은 고volume·감사가치 낮음(영속 SKIP 과 동렬).
// core/event-persist.ts 의 SKIP_TYPES 와 의미는 비슷하나 모듈 경계가 달라 로컬 set(과결합 회피).
const HISTORY_EXCLUDE = new Set<string>(["llm.delta", "llm.sdk_message"]);

import { writeJson } from "../../src/core/net/write-json.js";
import { redactSecrets } from "../../src/core/outbound-sanitize.js";
import { getRecentChatLog } from "../../src/store/chat-log.js";
import { listEvents } from "../../src/store/events.js";
import { historyActivities } from "./history-activities.js";
import type { RouteCtx } from "./route-ctx.js";

export const handleEvents = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // 초기 history 푸시 (bus 가 붙어있을 때만).
  // 고volume 스트리밍 타입(llm.delta 등)은 재생 제외 — 라이브 fan-out 은 통과, history 만 필터.
  if (ctx.bus !== null) {
    const recent = ctx.bus
      .history({ limit: 50 })
      .filter((e) => !HISTORY_EXCLUDE.has(e.type));
    for (const e of recent) {
      try {
        res.write(`data: ${redactSecrets(JSON.stringify(e))}\n\n`); // 위와 같은 이유.
      } catch {
        return;
      }
    }
  }
  ctx.sseClients.add(res);
  // 하트비트 — 연결 유지 + **클라이언트 liveness 관측**(2026-07-26).
  //  종전엔 SSE 코멘트(`: ping`)만 보냈는데, 코멘트는 EventSource 의 onmessage 를
  //  발화시키지 않아 **브라우저가 "핑이 끊겼다"를 알 방법이 없었다**. 그래서 연결이
  //  조용히 half-open 으로 죽으면(맥 절전·네트워크 전환·프록시 idle) onerror 도 안 뜨고
  //  readyState 는 OPEN 이라 재연결이 영영 안 걸려, 그 뒤 발행된 이벤트(worker.done 등)를
  //  못 받아 카드가 "실행 중"으로 영구히 남았다(실측: 끝난 매니저가 30분째 도는 것처럼 보임).
  //  → 코멘트 대신 **실제 이벤트**로 보내 클라가 수신 시각을 추적/워치독할 수 있게 한다.
  //  `stream.heartbeat` 는 EventBus 를 타지 않는 **전송 계층 전용** 신호(영속·관측 대상 아님)
  //  라 소비자(대시보드)는 렌더하지 않고 liveness 갱신에만 쓴다.
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "stream.heartbeat", ts: Date.now() })}\n\n`);
    } catch {
      /* 끊긴 소켓 — close/error 가 cleanup 처리 */
    }
  }, 20_000);
  (heartbeat as { unref?: () => void }).unref?.();
  const cleanup = (): void => {
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  return;
};

export const handleEndpointCalls = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  try {
    const raw = url.searchParams.get("limit");
    const n = raw !== null ? parseInt(raw, 10) : NaN;
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 60;
    // 한 호출이 start/done 2건이므로 넉넉히 읽어 callId 로 접는다(done 이 start 를 대체).
    // ★엔드포인트와 게이트웨이를 **한 목록으로** 준다 (2026-08-10). 둘 다 "외부가
    //  나를 호출한 기록" 이라 사용자가 보는 질문이 같다("누가·언제·뭘·얼마나").
    //  화면을 둘로 나누면 같은 판단이 두 곳에 생기고, 어느 쪽을 봐야 할지도 매번
    //  고민거리가 된다. 구분은 `kind` 필드로 주고 필터는 뷰가 한다.
    const rows = listEvents({
      types: ["endpoint.call", "gateway.call"],
      limit: limit * 3,
    });
    const byCall = new Map<
      string,
      { ts: number; kind: string; payload: Record<string, unknown> }
    >();
    for (const r of rows) {
      // ★`PersistedEvent.payload` 는 **JSON 문자열**이다(객체 아님). 캐스팅으로 넘기면
      //  조용히 빈 값이 나간다 — tsc 가 잡아줬다.
      let pl: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(r.payload);
        pl =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        continue; // 깨진 행은 건너뛴다(한 행이 이력 전체를 막지 않게).
      }
      const kind = r.type === "gateway.call" ? "gateway" : "endpoint";
      // callId 는 각 축에서만 유일하므로 kind 를 섞어 키를 만든다(충돌 0).
      const id = `${kind}:${String(pl.callId ?? r.ts)}`;
      const prev = byCall.get(id);
      // done(phase!=="start") 이 start 를 이긴다. 같은 phase 면 나중 것.
      if (prev === undefined || pl.phase !== "start" || prev.payload.phase === "start") {
        byCall.set(id, { ts: r.ts, kind, payload: pl });
      }
    }
    // ★start 만 있고 done 이 없는 호출 = **끝을 못 본 호출**(데몬 재시작 등).
    //  그대로 두면 화면에 영원히 "진행 중" 으로 보인다 — 오늘 고친 "실패했는데 아무것도
    //  안 보이는" 것의 화면판이다. 진행 중일 수 없는 시간이 지났으면 미완으로 못 박는다.
    const STALE_MS = 10 * 60_000;
    const now = Date.now();
    const calls = [...byCall.values()]
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit)
      .map((c) =>
        c.payload.phase === "start" && now - c.ts > STALE_MS
          ? {
              ts: c.ts,
              kind: c.kind,
              ...c.payload,
              phase: "done",
              ok: false,
              response:
                "(완료 기록 없음 — 데몬 재시작 등으로 중단된 호출입니다. 생성 중이던 응답은 남지 않았습니다.)",
            }
          : { ts: c.ts, kind: c.kind, ...c.payload },
      );
    writeJson(res, 200, { calls, generatedAt: new Date().toISOString() });
  } catch (e) {
    writeJson(res, 500, { error: String(e) });
  }
  return;
};

export const handleAllActivity = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  try {
    const limitRaw = url.searchParams.get("limit");
    const parsed = limitRaw !== null ? parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    const beforeRaw = url.searchParams.get("beforeTs");
    const beforeParsed =
      beforeRaw !== null ? parseInt(beforeRaw, 10) : NaN;
    const beforeTs =
      Number.isFinite(beforeParsed) && beforeParsed > 0
        ? beforeParsed
        : undefined;
    // ★`/all-activity` 는 복합 커서를 **안 쓴다**. 이 뷰는 chat_log 와 llm.activity 를
    //  ts 로 병합해 한 축으로 페이징하므로, chat_log 의 id 를 두 번째 축으로 넣으면
    //  activities 쪽엔 뜻이 없는 값이 된다(반쪽 커서). 제대로 하려면 테이블별 커서가
    //  필요하다 — 백로그. 보내는 클라이언트도 없다(`activity.js:303` 은 beforeTs 만).

    const entries = getRecentChatLog({
      limit,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
    });
    writeJson(res, 200, {
      entries,
      // /chat-history 와 동일 규칙 — 상한은 역방향 페이지(beforeTs)에서만.
      activities: historyActivities(entries, undefined, beforeTs !== undefined),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};
