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

const SKIP_TYPES = new Set<string>([
  "llm.sdk_message",
  "channel.message.in",
  "channel.message.out",
]);

const MAX_PAYLOAD_CHARS = 4000; // 페이로드 비대 가드(큰 snapshot 절단).
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
      let payload = JSON.stringify(event.payload ?? {});
      if (payload.length > MAX_PAYLOAD_CHARS) {
        payload = `${payload.slice(0, MAX_PAYLOAD_CHARS)}…(truncated)`;
      }
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
};
