/**
 * egress("이 답도 함께 보낼" 채널) **좌표 해석** — 턴 시작에 한 번 푼다.
 *
 * ★왜 별 모듈인가: 이 판정이 `index.ts` 안에 있었을 때 동작 검사가 불가능했다(그 파일은
 *  import 만으로 데몬이 뜬다). 그래서 refcount 모듈만 검사했고, **정확히 검사 못 한
 *  자리에서 결함이 나왔다** — 좌표를 못 풀어 활동 표시가 안 떴다(2026-08-10 라이브).
 *  조회를 주입받아 순수 함수로 만들면 그대로 검사된다.
 *
 * ★기본 좌표까지 **여기서** 푼다. 종전엔 `deliverOutbound` 안에서만 풀었는데, 그러면
 *  배달은 되고(내부 폴백) 좌표가 필요한 다른 소비자(활동 표시)는 `null` 을 받아 조용히
 *  아무것도 안 한다. 좌표를 아는 곳이 둘이면 하나는 반드시 뒤처진다 — 한 곳에서 풀어
 *  표시와 배달이 **같은 좌표**를 쓰게 한다.
 */
import type { ChannelOutbound } from "./channel-outbound.js";

export interface EgressTarget {
  channel: string;
  /** 해석된 배달 좌표. `null` = 좌표를 못 찾음(배달도 표시도 불가). */
  target: string | null;
  outbound: ChannelOutbound;
}

export interface EgressResolveDeps {
  getOutbound: (name: string) => ChannelOutbound | undefined;
  /** 세션의 마지막 채널·좌표(없으면 null). 조회 실패는 호출부가 null 로 흡수. */
  getSessionMeta: (
    threadKey: string,
  ) => { lastChannel: string; lastChannelTarget: string | null } | null;
}

export interface EgressResolveInput {
  /** 인입 채널 — 자기 자신은 egress 대상이 아니다(이미 별도 경로로 응답). */
  channel: string;
  threadKey: string;
  egressChannels?: string[] | undefined;
}

/**
 * 좌표 체인: ①세션 `last_channel_target`(단 `last_channel === ch` 일 때만 — 타 채널
 * 좌표 오용 방지) → ②채널의 `defaultOutboundTarget()`(sync|async 둘 다).
 */
export const resolveEgressTargets = async (
  input: EgressResolveInput,
  deps: EgressResolveDeps,
): Promise<EgressTarget[]> => {
  const out: EgressTarget[] = [];
  for (const ch of input.egressChannels ?? []) {
    if (ch === input.channel) continue;
    const outbound = deps.getOutbound(ch);
    // outbound-capable 만 — `defaultOutboundTarget` 표명이 곧 "좌표를 아는 채널".
    if (outbound === undefined || outbound.defaultOutboundTarget === undefined) {
      continue;
    }
    let target: string | null = null;
    try {
      const meta = deps.getSessionMeta(input.threadKey);
      if (
        meta !== null &&
        meta.lastChannel === ch &&
        meta.lastChannelTarget !== null &&
        meta.lastChannelTarget !== ""
      ) {
        target = meta.lastChannelTarget;
      }
    } catch {
      /* 세션 메타 조회 실패 — 아래 기본 좌표로 폴백(무해) */
    }
    if (target === null) {
      try {
        target = (await outbound.defaultOutboundTarget()) ?? null;
      } catch {
        target = null; // 기본 좌표 해석 실패 — 배달은 deliverOutbound 가 다시 시도한다.
      }
    }
    out.push({ channel: ch, target, outbound });
  }
  return out;
};
