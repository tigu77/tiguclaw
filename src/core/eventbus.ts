/**
 * EventBus 코어 — 관측 진입 인프라 (Phase B dashboard contract §4).
 *
 * 단순+견고:
 *  - In-memory ring buffer (Array push + shift cap, 디폴트 1000).
 *  - publish 동기. async fan-out 은 V2.
 *  - Subscriber 격리 — handler throw 가 (i) 다른 subscriber 또는 (ii) publish caller
 *    에 영향 0. throw 시 자동 `plugin.error` publish (recursion guard: plugin.error
 *    처리 중 발생한 throw 는 console.error 만, 추가 publish 안 함).
 *  - history(opts) — buffer 복사본 + filter (limit/sinceTs/types) 반환.
 *
 * type = string (literal union 강제 X) — 외부 plugin 자체 type publish 가능 (narrative
 * backpressure: marketplace 견딤).
 *
 * V1 이벤트 타입 (확장 가능):
 *   channel.message.in / channel.message.out / llm.sdk_message
 *   memory.write / plugin.error
 */

export interface EventBusEvent {
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface EventBus {
  publish(event: EventBusEvent): void;
  subscribe(handler: (event: EventBusEvent) => void): () => void;
  history(opts?: {
    limit?: number;
    sinceTs?: number;
    types?: string[];
  }): EventBusEvent[];
}

export interface EventBusOptions {
  bufferSize?: number;
}

const DEFAULT_BUFFER_SIZE = 1000;

export const createEventBus = (opts?: EventBusOptions): EventBus => {
  const cap = Math.max(1, opts?.bufferSize ?? DEFAULT_BUFFER_SIZE);
  const buffer: EventBusEvent[] = [];
  const subscribers = new Set<(event: EventBusEvent) => void>();
  // recursion guard: plugin.error publish 중 또 다른 throw 발생 시
  // 다시 plugin.error publish 하지 않음 (무한 루프 차단).
  let inErrorPublish = false;

  const publish = (event: EventBusEvent): void => {
    // ring buffer cap (oldest 삭제).
    buffer.push(event);
    while (buffer.length > cap) buffer.shift();

    const isErrorEvent = event.type === "plugin.error";
    if (isErrorEvent) inErrorPublish = true;
    try {
      for (const handler of subscribers) {
        try {
          handler(event);
        } catch (err) {
          if (inErrorPublish) {
            // recursion guard — error handler 가 throw 한 경우.
            // 추가 publish 없이 console 만.
            // eslint-disable-next-line no-console
            console.error("eventbus: error subscriber threw", err);
            continue;
          }
          // 다른 subscriber 격리 — 별도 try 로 publish 동기 호출.
          inErrorPublish = true;
          try {
            const errEvent: EventBusEvent = {
              type: "plugin.error",
              ts: Date.now(),
              payload: {
                phase: "runtime",
                source: "eventbus.subscriber",
                eventType: event.type,
                error: err instanceof Error ? err.message : String(err),
              },
            };
            buffer.push(errEvent);
            while (buffer.length > cap) buffer.shift();
            for (const h of subscribers) {
              try {
                h(errEvent);
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error("eventbus: error subscriber threw", e);
              }
            }
          } finally {
            inErrorPublish = false;
          }
        }
      }
    } finally {
      if (isErrorEvent) inErrorPublish = false;
    }
  };

  const subscribe = (
    handler: (event: EventBusEvent) => void,
  ): (() => void) => {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  };

  const history = (opts?: {
    limit?: number;
    sinceTs?: number;
    types?: string[];
  }): EventBusEvent[] => {
    let out = buffer.slice();
    if (opts?.sinceTs !== undefined) {
      const since = opts.sinceTs;
      out = out.filter((e) => e.ts >= since);
    }
    if (opts?.types !== undefined && opts.types.length > 0) {
      const set = new Set(opts.types);
      out = out.filter((e) => set.has(e.type));
    }
    if (opts?.limit !== undefined && opts.limit > 0 && out.length > opts.limit) {
      out = out.slice(out.length - opts.limit);
    }
    return out;
  };

  return { publish, subscribe, history };
};

// ─── 모듈 전역 singleton (lazy init) ──────────────────────────────────────
// daemon 부트스트랩에서 명시 init 도 가능 (initEventBus alias) — 둘 다 호환.
let singleton: EventBus | undefined;

export const getEventBus = (): EventBus => {
  if (singleton === undefined) {
    singleton = createEventBus({ bufferSize: DEFAULT_BUFFER_SIZE });
  }
  return singleton;
};

/**
 * subscribe() 반환 unsub 을 안전 호출(예외 삼킴)하고 null 반환 — 플러그인 stop() 공통.
 * `this.unsub = safeUnsubscribe(this.unsub)` 한 줄로 "있으면 해지·실패 무시·null 화" 를
 * 대체한다(4개 플러그인이 동일 try/catch/null 관용구를 복제하던 것 단일화). 이미 null 이면
 * no-op. 순수 함수 — 상속·추상층 0.
 */
export const safeUnsubscribe = (unsub: (() => void) | null): null => {
  if (unsub !== null) {
    try {
      unsub();
    } catch {
      /* 해지 실패는 무시 — stop 은 best-effort. */
    }
  }
  return null;
};

/**
 * daemon 부트스트랩이 명시 호출 가능. 이미 init 되어 있으면 기존 인스턴스 반환
 * (옵션 변경은 무시 — first-init wins). 테스트 reset 은 V2.
 */
export const initEventBus = (opts?: EventBusOptions): EventBus => {
  if (singleton === undefined) {
    singleton = createEventBus(opts);
  }
  return singleton;
};
