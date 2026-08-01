/**
 * 관측 이벤트 영속 sink — EventBus 의 *의미있는* 이벤트를 SQLite 에 기록.
 *
 * 설계 (코어는 데이터로 확장): publish() 를 손대지 않고 subscriber 하나만 붙인다.
 * EventBus 의 ring buffer 는 hot cache(SSE·dashboard 라이브)로 남기고, 이 sink 가
 * 영속 이력(감사·메트릭)을 담당한다. logging.ts(콘솔→파일 미러)와 동형 인프라.
 *
 * 제외(SKIP): 고volume 스트리밍(`llm.sdk_message`)·대화 본문(`channel.message.in/out`,
 * 이미 transcripts 에 있고 PII) — 개별 감사 가치 0. 나머지(에러·발화·lifecycle·memory.write
 * + 미래 신규 type)는 기본 영속(allowlist 아닌 denylist — 새 의미있는 이벤트 자동 포함).
 */
import type { EventBus } from "./eventbus.js";
import { insertEvent, pruneEvents } from "../store/events.js";
import { pruneInternalThreads } from "../store/sessions.js";
import { recordChatMessage } from "../store/chat-log.js";
import { isChatVisibleEvent } from "./chat-visible-events.js";
import { redactSecrets } from "./outbound-sanitize.js";
import type { ChatAttachmentMeta } from "../store/chat-log.js";

const SKIP_TYPES = new Set<string>([
  "llm.sdk_message",
  "llm.delta", // 고volume 토큰 스트리밍(보조 점증 렌더) — 전체본은 channel.message.out·transcripts 가 이미 보관.
  // llm.delta 의 형제 이벤트(2026-07-26, ADR 2026-07-25-llm-gateway-openrouter-scope §Decision-5) —
  // 함수콜 인자 스트리밍 조각. externalToolCalls 최종본이 RegionASdkOutput/게이트웨이 응답에
  // 실려 별도 경로로 이미 확정되므로(llm.delta↔channel.message.out 관계와 동형) 개별 조각의
  // 감사 가치 0 — 동일 사유로 SKIP.
  "llm.tool_call_delta",
  "channel.message.in",
  "channel.message.out",
  // 엔드포인트 호출 관측(요청+응답 전문) — 라이브 SSE 로만 대시보드에 전달. 영속 시 sanitize 가
  // 전문을 300자 절단 + events 테이블 비대 → SKIP. 전체 기록은 transcripts 에 이미 영속.
  "endpoint.call",
]);

// 페이로드 비대 가드. 리치 도구 카드(diff ≤~7.5KB / output ≤~4.5KB, ADR 2026-07-09)를
// 수용하되 그 위는 절단. ★절단은 반드시 *유효 JSON* 이어야 한다 — 원본 문자열 슬라이스는
// JSON 중간을 잘라 깨진 JSON 을 만들고(`{…(truncated)`), events.payload 를 json_extract 로
// 읽는 소비자(getRecentActivities·skill-usage)를 통째로 터뜨린다(2026-07-09 self-growth 사고).
// 값은 리치 카드 최대(diff 60줄/6000자 → JSON+escape ~8KB)를 여유 있게 보존하도록 잡음.
const MAX_PAYLOAD_CHARS = 10000;

/**
 * payload 를 최대 `maxChars` 로 직렬화하되 **항상 유효 JSON** 을 반환.
 * 상한 초과 시: 스칼라·짧은 문자열 필드(threadKey/label/kind/seq 등 = 조회 키)는 보존하고
 * 큰 객체/배열(diff/output 등)은 생략 → 이벤트 정체성·조회 가능성 유지 + 유효 JSON 보장.
 */
export const truncatePayloadJson = (payload: unknown, maxChars: number): string => {
  const full = JSON.stringify(payload ?? {});
  if (full.length <= maxChars) return full;
  const src =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { _truncated: true };
  for (const [k, v] of Object.entries(src)) {
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.length > 300 ? v.slice(0, 300) + "…" : v;
    // 객체/배열(리치 diff/output 등)은 생략 — 유효 JSON 유지 + 조회 키 보존.
  }
  const s = JSON.stringify(out);
  return s.length <= maxChars ? s : `{"_truncated":true}`; // 스칼라도 초과하는 극단 → 유효 하드폴백.
};

// export: maintenance.ts(runMaintenanceScan) 가 events store health 판정(count vs bound)에
// 재사용 — 값 중복 정의 금지(단일 소스, P1 runtime-maintenance).
export const RETENTION_KEEP = 10_000; // 최근 N건 유지.
const PRUNE_EVERY = 256; // N건마다 1회 prune(매 insert prune 회피).
/** 주기 정리 — 재시작이 잦아 카운터가 굶는 것을 막는 두 번째 축(효율 감사 2026-07-30). */
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

// ─── threads 내부 파생 스레드 프루닝 (효율감사 P3, 2026-07-16) ────────────────────
// `threads`(worker:/agent:/endpoint:/gateway:/`::sub::`)는 프루닝 기제가 없어 무한증가
// 중이었다(실측: agent 75·sub 46·worker 23·endpoint 19, 이 세션 서브 스폰만으로도 계속 증가).
// events 의 PRUNE_EVERY 배치 정리와 *같은 주기*에 얹는다 — 별도 타이머 없이(원칙 3: 코어
// 단순 불변) events insert 트래픽에 올라탄 저비용 tick. 내부 잡은 분/시간 단위로 완료되므로
// 30일은 활성 잡을 절대 안 건드리는 보수적 TTL([[project_hotpath_bound_preserve_record]] —
// 핫경로만 바운드, transcripts/chat_log 레코드는 별 테이블이라 무영향·콜드 보존).
// ★scheduler: 스레드는 pruneInternalThreads 내부에서 이미 제외(재사용되는 반복 스레드).
export const INTERNAL_THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30일.

/**
 * 영속 sink 등록 — 부팅 시 1회. 핸들러는 *throw 하지 않는다*: subscriber throw 는
 * EventBus 가 plugin.error 를 publish → 그 이벤트를 우리가 또 받아 insert 재실패 →
 * 재귀 위험. 내부 try/catch + console.error 로 닫아 bus·데몬을 보존(원칙 3).
 */
export const startEventPersistence = (bus: EventBus): void => {
  let sinceLastPrune = 0;

  /**
   * 정리 1회 — 카운터·타이머·부팅이 모두 이걸 부른다. best-effort(원칙 3).
   */
  const runPrune = (why: string): void => {
    try {
      const removed = pruneEvents(RETENTION_KEEP);
      pruneInternalThreads(INTERNAL_THREAD_RETENTION_MS);
      if (removed > 0) {
        console.log(`event-persist: 정리 ${removed}행 (${why}).`);
      }
    } catch (e) {
      console.error(
        `event-persist: 정리 실패 (${why}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  // ★부팅 1회 + 주기 타이머 (2026-07-30 효율 감사 지적).
  //
  //  종전엔 **`sinceLastPrune` 카운터 하나**가 유일한 트리거였다. 그런데 그건 프로세스
  //  로컬이고 `PRUNE_EVERY=256` 이라, 실측(이벤트율 111건/시간)으로는 발화에 **연속 138분**
  //  가동이 필요하다. 그런데 데몬 부팅이 **하루 21~32회**(평균 간격 48.8분) — 카운터가 256에
  //  닿기 전에 매번 0으로 리셋된다. 그래서 events 가 10,124건까지 자랐고 보존창은 3.8일에
  //  머물렀다. **코드엔 바운드가 있고 집행 경로가 비어 있던 것**이다(그 자체가 오늘 여러 번
  //  나온 부류 — 만들어 두고 안 도는 것).
  //  카운터는 그대로 두고(폭주 시 즉시 반응) 부팅·주기를 더한다 — 재시작이 잦아도 굶지 않는다.
  runPrune("부팅");
  const pruneTimer = setInterval(() => runPrune("주기"), PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.(); // 프로세스 종료를 붙잡지 않는다.
  bus.subscribe((event) => {
    if (SKIP_TYPES.has(event.type)) return;
    try {
      // ★영속·방출되는 payload 는 게이트 없이 redact (2026-07-28 보안 감사).
      //  실측: 이 경로로 `TELEGRAM_BOT_TOKEN` 10행 · `HTTP_BRIDGE_TOKEN` 2행이 events 에
      //  **평문으로** 들어가 있었다(도구 Read/Bash 출력이 llm.activity.payload.output.text 에
      //  통째로 담긴다). 게다가 llm.activity 는 SSE HISTORY_EXCLUDE 대상이 아니라
      //  `/events`(요구 role=**read**)로 그대로 나간다 → 최저권한 토큰 하나로 admin·봇 토큰을
      //  관측할 수 있어 role 계층이 무의미해진다.
      //  redactSecrets 는 종전에 *에러 경로 전용* 이었다("정상 응답엔 불필요"). 그 전제는
      //  사용자 답변 텍스트엔 참이지만 **도구 출력 이벤트엔 거짓**이다 — 여기서 무조건 통과시킨다.
      //  ★단 이건 **DB 만** 닫는다 (2026-07-29 정정): redact 대상은 insertEvent 로 넘기는
      //   *문자열 사본* 이고 버스 payload 객체는 그대로다. SSE fan-out 은 별도 subscriber 라
      //   거기서 따로 닫는다(plugins/http-bridge 의 startObserver·history replay).
      const payload = redactSecrets(
        truncatePayloadJson(event.payload, MAX_PAYLOAD_CHARS),
      );
      insertEvent(event.ts, event.type, payload);
      if (++sinceLastPrune >= PRUNE_EVERY) {
        sinceLastPrune = 0;
        runPrune("건수");
      }
    } catch (e) {
      console.error(
        "event-persist: insert 실패:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });

  startChatLogPersistence(bus);
  startStreamTracePersistence(bus);
};

/**
 * 스트리밍 서술 트레이스 (2026-07-03) — `llm.delta`(고volume 토큰, SKIP_TYPES 제외)를
 * *coalesce* 해 주기적 스냅샷을 **로그로만** 남긴다(`[stream-trace]`; DB events 아님).
 *
 * 배경: 완료된 turn 의 전체본은 transcripts/channel.message.out 에 있으나, *진행 중·멈춘·
 * 루프* turn 의 스트리밍 서술은 어디에도 안 남아(delta denylist) 사후 진단 불가였다(실측:
 * 워커가 무한 재탐색처럼 보이는데 delta 미영속이라 확인 못 함). → threadKey 별로 델타를
 * 모아 ~12s 또는 ~1500자마다 tail 스냅샷 1건 로그. ★로그 전용 근거: 완료턴은 transcripts
 * 와 중복이고, events 는 최근 1만 건 prune 이라 스트리밍 트레이스가 에러·lifecycle 을 밀어내는
 * 보존 오염. 로그(일자별 파일)는 그 문제 0 + grep 으로 충분. 저volume + 누수 가드(동시 추적
 * 상한·turn 경계 정리). throw 금지(재귀 위험, 위 sink 동일 정책).
 */
const startStreamTracePersistence = (bus: EventBus): void => {
  const FLUSH_MS = 12_000; // 최소 스냅샷 간격.
  const FLUSH_CHARS = 1500; // 이만큼 쌓이면 조기 flush.
  const TAIL_CHARS = 400; // 스냅샷에 담는 최근 텍스트 길이(루프=반복 tail 판별용).
  const MAX_TRACKED = 32; // 동시 추적 threadKey 상한(누수 가드).
  const traces = new Map<
    string,
    { chunk: string; totalLen: number; lastFlushTs: number }
  >();

  const flush = (tk: string, ts: number, reason: string): void => {
    const s = traces.get(tk);
    if (!s || s.chunk === "") return;
    const tail =
      s.chunk.length > TAIL_CHARS ? `…${s.chunk.slice(-TAIL_CHARS)}` : s.chunk;
    // ★로그로만 남긴다(DB events 아님). 근거: (a)완료턴 전체본은 transcripts 에 이미 있어
    // DB 트레이스는 중복, (b)events 는 최근 1만 건 prune 이라 스트리밍 트레이스가 에러·
    // lifecycle 같은 중요한 이벤트를 밀어내는 보존 오염. 로그는 일자별 파일이라 그 문제 0 +
    // grep(threadKey·시각·반복 tail)으로 진행중·멈춘·루프 턴 서술을 사후 확인하기에 충분.
    console.log(
      `[stream-trace] ${tk} total=${s.totalLen} +${s.chunk.length}(${reason}) tail: ${tail
        .replace(/\s+/g, " ")
        .slice(-140)}`,
    );
    s.chunk = "";
    s.lastFlushTs = ts;
  };

  bus.subscribe((event) => {
    try {
      if (event.type === "llm.delta") {
        const p = (event.payload ?? {}) as { threadKey?: unknown; delta?: unknown };
        const tk = typeof p.threadKey === "string" ? p.threadKey : "";
        const d = typeof p.delta === "string" ? p.delta : "";
        if (tk === "" || d === "") return;
        let s = traces.get(tk);
        if (!s) {
          if (traces.size >= MAX_TRACKED) return; // 상한 초과 시 무시(드묾, 누수 방지).
          s = { chunk: "", totalLen: 0, lastFlushTs: event.ts };
          traces.set(tk, s);
        }
        s.chunk += d;
        s.totalLen += d.length;
        if (s.chunk.length >= FLUSH_CHARS || event.ts - s.lastFlushTs >= FLUSH_MS) {
          flush(tk, event.ts, "periodic");
        }
        return;
      }
      // turn 경계 — 남은 chunk flush + 상태 정리(stall 은 재개하니 유지).
      if (
        event.type === "llm.turn_done" ||
        event.type === "llm.turn_error" ||
        event.type === "llm.stream_stall"
      ) {
        const p = (event.payload ?? {}) as { threadKey?: unknown };
        const tk = typeof p.threadKey === "string" ? p.threadKey : "";
        if (tk === "") return;
        flush(tk, event.ts, event.type.replace("llm.", ""));
        if (event.type !== "llm.stream_stall") traces.delete(tk);
      }
    } catch {
      /* best-effort — throw 금지(subscriber throw → plugin.error 재귀). */
    }
  });
};

/**
 * 대화 이력 영속 sink (기능 B, 2026-06-25) — generic events 와 *별개* 추가 구독.
 *
 * EventBus 의 `channel.message.in`(사용자) / `channel.message.out`(비서) 를 받아 깨끗한
 * 텍스트만 `chat_log` 에 적재한다. 위 generic sink 의 SKIP_TYPES 가 이 두 type 을 제외하므로
 * events 테이블과 책임이 겹치지 않는다(전용 테이블 = 대시보드 채팅 흐름 복원·PII 분리).
 *
 * ★ts 는 *이벤트의 ts 를 그대로* 기록한다(Date.now() 아님). 대시보드가 `/chat-history` 로
 * 그린 과거 메시지와 SSE history replay(최근 50) 가 겹칠 때 동일 ts 로 dedup 할 수 있게.
 *
 * 모든 채널(telegram·dashboard·cli) 통합 캡처 — 채널 무관·단일 인격. recordChatMessage 가
 * 이미 best-effort boundary(내부 try/catch)지만, 구독 콜백에서도 이중 try/catch 로 감싼다
 * (subscriber throw → plugin.error 재귀 위험 차단, 위 generic sink 와 동일 정책).
 */
const startChatLogPersistence = (bus: EventBus): void => {
  bus.subscribe((event) => {
    // ★대화 가시 이벤트(선택지·통지 등)도 여기서 대화 기록에 남긴다 (2026-08-01).
    //  종전엔 메시지 2종만 남겨서, 채팅에 버블로 보이는 나머지는 DB 에 없었다 →
    //  탭 이동(=/chat-history 복원)에서만 사라졌다. 판정은 chat-visible-events 단일 정본.
    if (isChatVisibleEvent(event.type)) {
      try {
        const p = event.payload ?? {};
        const threadKey = typeof p.threadKey === "string" ? p.threadKey : "";
        const channel = typeof p.channel === "string" ? p.channel : "";
        // 좌표 없는 이벤트는 어느 대화에 붙일지 모른다 — 남기지 않는다(엉뚱한 탭 오염 방지).
        if (threadKey === "") return;
        recordChatMessage({
          ts: event.ts, // ★event.ts 그대로 — 라이브 렌더와 같은 dedup 키.
          threadKey,
          channel: channel !== "" ? channel : "http-bridge",
          role: "assistant",
          text: "", // 본문은 payload 에 있다. 문구는 프런트 렌더러가 짓는다(서버 재조립 금지).
          notice: true,
          kind: event.type,
          data: p,
        });
      } catch (e) {
        console.error(
          "event-persist: 대화 가시 이벤트 적재 실패:",
          e instanceof Error ? e.message : String(e),
        );
      }
      return;
    }
    if (
      event.type !== "channel.message.in" &&
      event.type !== "channel.message.out"
    ) {
      return;
    }
    try {
      const payload = event.payload ?? {};
      const text = typeof payload.text === "string" ? payload.text : "";
      const threadKey =
        typeof payload.threadKey === "string" ? payload.threadKey : "";
      const channel =
        typeof payload.channel === "string" ? payload.channel : "";
      // 첨부 참조 메타(있으면) — 새로고침 후에도 이미지/파일이 이력에 남게. 이벤트 발행자
      // (index.ts channel.message.in)가 base64 아닌 rel/mime/name/kind 만 실어 보낸다.
      const attachments = Array.isArray(payload.attachments)
        ? (payload.attachments as ChatAttachmentMeta[])
        : undefined;
      const hasAtt = attachments !== undefined && attachments.length > 0;
      // threadKey·channel 누락이면 스킵. text 는 첨부가 있으면 비어도 통과(이미지-only 메시지).
      if (threadKey === "" || channel === "") return;
      if (text === "" && !hasAtt) return;
      recordChatMessage({
        ts: event.ts, // ★event.ts 그대로 — 클라이언트 dedup 키.
        threadKey,
        channel,
        role: event.type === "channel.message.out" ? "assistant" : "user",
        text,
        ...(hasAtt ? { attachments } : {}),
        // 시스템 통지 표식 승계 — 새로고침 후에도 비서 발화와 구분되게. 라이브만 구분되면
        // 같은 데이터가 경로마다 달라진다(모델 표시에서 겪은 함정과 동형).
        ...(payload.notice === true ? { notice: true } : {}),
        // 실제 응답 모델 — 있으면 함께 영속(새로고침 후 표시). 없으면 키 생략(거짓값 금지).
        ...(typeof payload.model === "string" && payload.model !== ""
          ? { model: payload.model }
          : {}),
      });
    } catch (e) {
      console.error(
        "event-persist: chat_log 적재 실패:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
};
