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
import { recordChatMessage } from "../store/chat-log.js";

const SKIP_TYPES = new Set<string>([
  "llm.sdk_message",
  "llm.delta", // 고volume 토큰 스트리밍(보조 점증 렌더) — 전체본은 channel.message.out·transcripts 가 이미 보관.
  "channel.message.in",
  "channel.message.out",
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

const RETENTION_KEEP = 10_000; // 최근 N건 유지.
const PRUNE_EVERY = 256; // N건마다 1회 prune(매 insert prune 회피).

/**
 * 영속 sink 등록 — 부팅 시 1회. 핸들러는 *throw 하지 않는다*: subscriber throw 는
 * EventBus 가 plugin.error 를 publish → 그 이벤트를 우리가 또 받아 insert 재실패 →
 * 재귀 위험. 내부 try/catch + console.error 로 닫아 bus·데몬을 보존(원칙 3).
 */
export const startEventPersistence = (bus: EventBus): void => {
  let sinceLastPrune = 0;
  bus.subscribe((event) => {
    if (SKIP_TYPES.has(event.type)) return;
    try {
      const payload = truncatePayloadJson(event.payload, MAX_PAYLOAD_CHARS);
      insertEvent(event.ts, event.type, payload);
      if (++sinceLastPrune >= PRUNE_EVERY) {
        sinceLastPrune = 0;
        pruneEvents(RETENTION_KEEP);
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
      // text·threadKey·channel 누락이면 스킵(recordChatMessage 도 빈 text 스킵).
      if (text === "" || threadKey === "" || channel === "") return;
      recordChatMessage({
        ts: event.ts, // ★event.ts 그대로 — 클라이언트 dedup 키.
        threadKey,
        channel,
        role: event.type === "channel.message.out" ? "assistant" : "user",
        text,
      });
    } catch (e) {
      console.error(
        "event-persist: chat_log 적재 실패:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
};
