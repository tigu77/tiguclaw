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
import { DEFAULT_SESSION_ID } from "./threadkey.js";

/**
 * **이 사본이 어느 세션에서 왔나** — 붙일 접두 (2026-08-28).
 *
 * ★사고가 근거다. 내가 번들 플러그인을 검증하려고 임의 세션(`dashboard:bundle-probe`)에
 *  말을 걸었더니, 그 답이 egress 를 타고 정태님 텔레그램에 **맥락 없는 `echo:안녕` 한 줄**로
 *  도착했다. 세션 귀속은 `recordOutboundMessage` 가 이미 들고 있었지만 그건 *답장 라우팅용*
 *  이지 **사람에게 보여주는 게 아니었다.**
 *
 * ★**막지 않고 말해준다.** 처음엔 "등록된 세션만 밖으로" 라는 게이트를 제안했다가 접었다
 *  (정태님 지적): 임의 세션은 개발 중에만 생기고, 게이트는 새 서버 개념 + 마이그레이션 +
 *  **조용한 실패**(등록을 놓치면 영영 안 감)를 끌고 온다. 라벨은 아무것도 막지 않으므로
 *  조용한 실패가 없다. 진짜 차단이 필요해지는 조건은 로드맵에 따로 서 있다.
 *
 * ★**기본 세션엔 안 붙는다** — 평소 사용은 글자 하나 안 바뀐다. 라벨이 매번 붙으면 그게
 *  배경 소음이 되고, 그러면 진짜 이상할 때 아무도 안 본다([[feedback_logs_must_stand_alone]]
 *  의 *"반복은 세라"* 와 같은 결).
 *
 * ★이름 없는 세션은 `unknown` 이다(2026-08-28 정태님). 첫 발화에서 파생하지 않는 이유는
 *  그게 **대화 내용을 다른 채널 라벨로 흘리는** 짓이기 때문이다. 어느 것인지까지 알아야
 *  하면 대시보드가 답한다 — 폰에서 필요한 답은 *"내 대화가 아니다"* 하나다.
 */
export const egressSourcePrefix = (
  originThreadKey: string | undefined,
  name: string | null | undefined,
): string => {
  if (originThreadKey === undefined || originThreadKey === "") return "";
  if (originThreadKey === DEFAULT_SESSION_ID) return "";
  const custom = name?.trim();
  return `[${custom !== undefined && custom !== "" ? custom : "unknown"}] `;
};

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
  /**
   * `reply` 가 실제로 나가는 좌표(있으면). 이름이 달라도 **여기와 같은 좌표면 건너뛴다** —
   * 워커 완료 재주입처럼 `channel`(scheduler)과 배달지(telegram)가 갈리는 경우가 있다.
   */
  replyTarget?: { channel: string; target: string | null } | undefined;
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
    // ★좌표가 같으면 건너뛴다 — 이름이 달라도 **같은 곳으로 두 번** 가면 안 된다.
    //  판정을 여기(좌표가 확정된 뒤)에 두는 이유: 위 이름 비교는 좌표를 풀기 전이라
    //  `scheduler` vs `telegram` 처럼 이름만 보고는 겹침을 알 수가 없다.
    const rt = input.replyTarget;
    if (rt !== undefined && rt.channel === ch && (rt.target ?? null) === target) continue;
    out.push({ channel: ch, target, outbound });
  }
  return out;
};
