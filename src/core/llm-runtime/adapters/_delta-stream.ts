/**
 * 영역 A 어댑터 공유 — `llm.delta` 토큰 스트리밍 coalescer + fan-out.
 *
 * 진실 소스: `docs/decisions/2026-06-25-dashboard-chat-cc-parity.md` §5.2 + §6.2(D6)
 * + `_workspace/dashboard-cc-parity_region.md` §5.
 *
 * ★LLM-agnostic 하드게이트(원칙 #2): claude·codex·openai-agents 세 어댑터가
 * *동일 의미*의 `llm.delta` 를 발행한다. 델타 소스 위치는 어댑터마다 다르지만
 * (SDK assistant 청크 / SSE 파서 / 스트림 이벤트), 이 coalescer 를 셋이 공유하면
 * payload 모양·coalesce 정책(~80ms ∥ ~120자)·견고성(best-effort)이 코드 차원에서
 * 강제된다(parity DRY). 어댑터는 `push(delta)` 호출 + 종료 시 `flush()` 만.
 *
 * ★견고성: 모든 publish 는 try/catch — 스트리밍 발행 실패가 LLM turn 을 깨면 안 된다
 *   (delta 는 보조 점증 렌더, 권위 전체본은 channel.message.out). 발행 실패해도
 *   turn·최종본은 그대로 진행.
 *
 * ★depth-0 가드: 서브에이전트/워커(depth>0) turn 의 토큰은 화면 버블 대상이 아니다
 *   (out 도 안 냄). 어댑터가 가드를 평가해 `enabled=false` 면 이 coalescer 는 no-op
 *   (push/flush 모두 무시) — 발행 비용 0, out↔버블 1:1 유지.
 *
 * ★raw SDK 구조 금지: delta 에는 순수 텍스트 증분만(누적본·sdk_message 아님).
 */
import type { ChannelName } from "../../../channels/types.js";
import { getEventBus } from "../../eventbus.js";
import type { RegionADeltaPayload } from "../types.js";

/** coalesce 시간 윈도 — 마지막 flush 후 이 ms 경과 시 버퍼 flush. 사람 눈 "타이핑" 하한. */
const COALESCE_MS = Number(process.env.TIGUCLAW_DELTA_COALESCE_MS ?? 80);
/** coalesce 글자 상한 — 윈도 내 토큰 폭주(긴 코드블록) 시 즉시 flush(레이턴시 가드). */
const COALESCE_CHARS = Number(process.env.TIGUCLAW_DELTA_COALESCE_CHARS ?? 120);

export interface DeltaStreamConfig {
  /** depth-0 가드 결과 — false 면 coalescer 는 완전 no-op(발행 0). */
  enabled: boolean;
  channel: ChannelName;
  threadKey: string;
  adapter: "claude" | "codex" | "openai";
  /** 어댑터가 아는 시점의 사용 모델(있으면). 없으면 publish 시 생략. */
  model?: string;
}

export interface DeltaStream {
  /** 증분 텍스트 조각 적재 — coalesce 정책(시간∥글자)에 따라 묶여 발행된다. */
  push(delta: string): void;
  /** turn 종료 직전 잔여 버퍼 강제 발행(꼬리 유실 0) + 타이머 정리. 멱등. */
  flush(): void;
  /** 현재 모델 갱신(어댑터가 늦게 알게 되는 경우). best-effort 라벨. */
  setModel(model: string | undefined): void;
}

/** no-op 인스턴스 — enabled=false(depth>0) 시 어댑터 코드 분기 없이 동일 API. */
const NOOP: DeltaStream = {
  push: () => {},
  flush: () => {},
  setModel: () => {},
};

/**
 * coalescing delta 발행기 생성.
 *
 *  - `push(d)`: 버퍼에 누적. 버퍼가 COALESCE_CHARS 도달 → 즉시 flush. 아니면
 *    COALESCE_MS 타이머 예약(이미 예약돼 있으면 유지).
 *  - 타이머 만료 / 글자 상한 / 명시 flush → 버퍼를 1개 `llm.delta` 로 publish.
 *  - `flush()`: turn 종료 시 잔여 발행 + 타이머 클리어(누수 0).
 *
 * setInterval 아님 — push 가 있을 때만 setTimeout 1개. push 없는 구간엔 타이머도 없음.
 */
export function createDeltaStream(config: DeltaStreamConfig): DeltaStream {
  if (!config.enabled) return NOOP;

  const bus = getEventBus();
  let buf = "";
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let model = config.model;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const emit = (): void => {
    clearTimer();
    if (buf.length === 0) return;
    const delta = buf;
    buf = "";
    // best-effort — publish 실패가 LLM 루프를 끊지 않게(보조 렌더, 전체본은 out 권위).
    try {
      bus.publish({
        type: "llm.delta",
        ts: Date.now(),
        payload: {
          channel: config.channel,
          threadKey: config.threadKey,
          adapter: config.adapter,
          ...(model !== undefined ? { model } : {}),
          seq: seq++,
          delta,
        } satisfies RegionADeltaPayload,
      });
    } catch {
      // 무시 — 다음 델타·최종본(out)으로 자가치유. context 위생: 발행측에서 닫음.
    }
  };

  return {
    push(delta: string): void {
      if (delta.length === 0) return;
      buf += delta;
      if (buf.length >= COALESCE_CHARS) {
        emit(); // 글자 상한 — 즉시 flush(레이턴시 가드).
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(emit, COALESCE_MS); // 시간 윈도 — 마지막 적재 후 ~80ms.
      }
    },
    flush(): void {
      emit(); // 잔여 발행 + 타이머 클리어(멱등 — buf 비면 no-op).
    },
    setModel(m: string | undefined): void {
      if (m !== undefined) model = m;
    },
  };
}
