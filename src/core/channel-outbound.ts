/**
 * 채널 outbound 레지스트리 (ADR 2026-07-16 §D1) — `deliverOutbound` 의 채널 switch 를
 * *데이터 등록*으로 대체하는 코어 소유 레지스트리.
 *
 * 채널이 자기 아웃바운드 능력(`deliver` = 물리 발송 + `defaultOutboundTarget` = 기본
 * 배달 좌표)을 코어에 밀어 넣고(plugin→core, 기존 `startChannel` duck-typing 과 동형),
 * 코어는 채널 이름을 하드코딩하지 않고 조회만 한다(§0 단방향 불변식 *강화*: switch 의
 * `"telegram"`/`"http-bridge"` 문자열·telegram import 제거). 미래 slack/discord 는
 * 이 인터페이스만 구현하면 UI·코어 재작업 0 으로 라우팅에 자동 등장.
 */

export interface ChannelOutbound {
  /** 물리 발송. 없으면(=undefined) 관측-전용 채널(http-bridge/대시보드처럼 SSE 가 배달). */
  deliver?: (target: string | null, text: string) => Promise<void>;
  /**
   * 채널이 아는 기본 배달 좌표(target 미지정 시). telegram=owner chatId, slack=기본 채널.
   * null = 기본 좌표 없음(호출자가 명시 target 필수). 셀렉터 노출 판단 재료.
   */
  defaultOutboundTarget?: () => (string | null) | Promise<string | null>;
  /** (선택·YAGNI) 다중 좌표 열거 — 슬랙 채널 목록 등. 지금은 미구현(ADR §7 U5). */
  listTargets?: () => Promise<{ id: string; label: string }[]>;
}

const registry = new Map<string, ChannelOutbound>();

/** 채널 아웃바운드 등록(부팅 채널 로딩 시점 — switch 가 존재하던 것과 동일 시점). */
export const registerChannelOutbound = (
  name: string,
  o: ChannelOutbound,
): void => {
  registry.set(name, o);
};

/**
 * 등록된 채널 아웃바운드 조회. `undefined` = 미등록(현행 switch default = "unsupported" warn).
 * *등록됐지만 `deliver` 없음* 은 관측-전용(http-bridge) — "미등록" 과 레지스트리 존재로 구분.
 */
/**
 * 지금 발송 가능한 채널 이름들 — **오타를 만들 때 잡기 위해** (2026-07-31 전체검토 P1).
 * `add_schedule` 의 `dest_channel` 이 `z.string().max(64)` 뿐이라 한 글자만 틀려도
 * 영구 무발신이 됐고, 그마저 `ok` 로 기록돼 자가 점검도 못 잡았다.
 */
export const listOutboundChannels = (): string[] => [...registry.keys()].sort();

export const getChannelOutbound = (
  name: string,
): ChannelOutbound | undefined => registry.get(name);

/**
 * 관측(`channel.message.out`) threadKey — 현행 `deliverOutbound` 관습을 비트 동일 함수화.
 *   telegram → `tg:${target}` (src/channels/telegram.ts 관습과 동일).
 *   그 외     → `target ?? "<channel>:default"` (http-bridge 등 generic 그룹 폴백).
 * ADR §D6 U6: `tg:` 접두를 채널이 스스로 만들게 이관하는 건 별건 저우선(현행 관습 유지).
 */
export const threadKeyForObservation = (
  channel: string,
  target: string | null,
): string =>
  channel === "telegram" ? `tg:${target}` : (target ?? `${channel}:default`);
