/**
 * Mid-turn steering 프리미티브 (코어 소유 — 단방향 §0: 어댑터·채널 이름 참조 0).
 *
 * 진실 소스: `docs/decisions/2026-07-16-midturn-steering.md` §3(프리미티브)·§4(계약 필드).
 *
 * 사용자가 비서 작업(턴) 중에 보낸 메시지를 **그 턴에 즉시 반영**(steering)하기 위한
 * 채널·LLM 무관 중립 큐. 핸들러가 turn 마다 1개 생성해 `Map<threadKey, SteeringChannel>`
 * (inflightTurns 자매)에 등록하고 finally 에서 close 한다. producer=핸들러(개입점 push),
 * consumer=어댑터(P1 이후 — P0 에선 소비 0).
 *
 * 두 소비 shape 를 모두 노출한다(SDK idiom 흡수 — presentOptions/sendAttachment 가 클로저로
 * 흡수하는 것과 동형, 과한 추상 아님):
 *  - `drain()`  : 비블로킹 pull-all — codex 루프 상단·openai callModelInputFilter 가 소비.
 *  - `stream()` : 도착 시 yield 하는 async 제너레이터 — claude streaming-input prompt 가 소비.
 * 공통 계약 = "대기 steering 은 다음 model-call 경계에서 대화에 append"(ADR §계약2).
 *
 * ★견고성(ADR §3): close() 멱등, drain 은 빈 배열 안전, stream 은 close/abort 에 종료 보장
 * (무한대기 0). 부품 1개(작은 async 큐)로 최소 표면 유지(단순성 게이트 §Q6).
 */
import type { Attachment } from "../channels/types.js";

/** 채널이 만드는 중립 steering 의도(채널·LLM 무관). telegram·대시보드·cli·http 동형. */
export interface SteeringInput {
  /** steer 텍스트 — 진행 턴에 끼워넣을 사용자 메시지 본문. */
  text: string;
  /**
   * 멀티모달 parity — 첨부도 steer 가능(없으면 생략). `IncomingMessage.attachments` 와
   * 동형(운반 타입 `Attachment` = SDK 비종속, path+메타만).
   */
  attachments?: Attachment[];
  /** 도착 시각(관측·정렬용). 개입점이 Date.now() 로 채운다. */
  ts: number;
}

export interface SteeringChannel {
  /**
   * producer(핸들러 개입점) — 대기 steering 1건 적재 + pending stream 대기자 unblock.
   * 반환값(ADR §"완료 데드락 + 수정" Part B) — `true`=적재 성공(진행 턴에 반영),
   * `false`=채널이 이미 close 됨(result 후 손실창 — 호출자는 새 턴으로 fall-through 해야
   * 손실 0 유지). 호출자는 index.ts 개입점 1곳뿐(codex/openai 는 drain 소비라 반환값 무영향).
   */
  push(msg: SteeringInput): boolean;
  /** consumer(codex/openai) — 비블로킹 pull-all(버퍼 반환+클리어, 빈 배열 안전). */
  drain(): SteeringInput[];
  /** consumer(claude) — 도착 시 yield, close/abort 시 종료(무한대기 0). */
  stream(signal: AbortSignal): AsyncGenerator<SteeringInput>;
  /** 턴 종료 — 멱등. pending stream 대기자 unblock(→ 제너레이터 종료). */
  close(): void;
}

/**
 * 작은 async 큐 1개. push=버퍼 append + waiter resolve, drain=버퍼 반환+클리어,
 * stream=버퍼 flush 후 새 도착 await(close/abort 시 return), close=멱등 + waiter unblock.
 */
export const createSteeringChannel = (): SteeringChannel => {
  const buffer: SteeringInput[] = [];
  // stream() 이 새 도착을 기다리며 등록한 resolve 들. push/close 가 깨운다.
  let waiters: Array<() => void> = [];
  let closed = false;

  // 대기 중인 stream 소비자 전부 깨우기(push 도착·close 공통). 스냅샷 후 클리어 —
  // 깨어난 소비자가 다시 등록하는 것과 재진입 충돌 0.
  const wake = (): void => {
    if (waiters.length === 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    push(msg: SteeringInput): boolean {
      // 턴 종료(close) 후 도착 = 소비자 없음 → 드롭 + false 반환(호출자가 새 턴으로
      // fall-through 해 손실 0 유지 — ADR §Part B). close↔push 경합 방어(P0 부터 동일 가드,
      // 반환형만 boolean 화).
      if (closed) return false;
      buffer.push(msg);
      wake();
      return true;
    },
    drain(): SteeringInput[] {
      if (buffer.length === 0) return []; // 빈 배열 안전.
      return buffer.splice(0, buffer.length);
    },
    async *stream(signal: AbortSignal): AsyncGenerator<SteeringInput> {
      if (signal.aborted) return; // 이미 abort — 즉시 종료(무한대기 0).
      const onAbort = (): void => wake(); // abort 도 대기자를 깨워 루프가 재평가 후 종료.
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          // 1) 버퍼 flush — 도착분 즉시 yield.
          for (;;) {
            if (signal.aborted) return;
            const next = buffer.shift();
            if (next === undefined) break;
            yield next;
          }
          // 2) 종료 조건 — close 또는 abort 면 즉시 종료.
          if (closed || signal.aborted) return;
          // 3) 새 도착/close/abort 대기(무한대기 0 — wake 가 push·close·abort 에서 호출).
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close(): void {
      if (closed) return; // 멱등.
      closed = true;
      wake(); // pending stream 대기자 unblock → 루프가 closed 감지 후 종료.
    },
  };
};
