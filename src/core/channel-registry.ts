// 라이브 채널 presence 레지스트리 (ADR 2026-07-16 §D4 Phase A / U4).
//
// 왜 정적 파일 walk 가 아닌가: 브리지 인벤토리(collectChannels, inventory.ts)는 plugins/ 만
// walk 하므로 코어 채널(telegram·cli, src/channels/)이 안 뜬다. 진실원 = index.ts 가 부팅 때
// 실제로 로드·시작한 산 channels[]. 이 모듈은 그 산 목록을 프로세스 모듈레벨 상태로 노출해
// (collectInventory 와 동일 in-process 공유 패턴) http-bridge 가 읽게 한다.
//
// Phase B2(ADR 2026-07-16 §D4) — outbound 능력 플래그(canDeliver/hasDefaultTarget)를 추가한다.
// 값은 채널 outbound 레지스트리(channel-outbound.ts, Phase B1)에서 index.ts 가 조회해 채운다
// (여기 모듈은 저장/노출만 — 레지스트리 조회는 배선 지점 몫, §0 채널명 무지 유지). 컴포저 egress
// 셀렉터가 이 플래그로 후보를 거른다(U3: hasDefaultTarget 채널만 = egress 좌표 아는 채널).

export interface ChannelPresence {
  /** 채널 이름 (예: "cli", "telegram", "http-bridge"). */
  name: string;
  /** 표시용 kind 라벨 — Phase A 는 채널별 특수 로직 없이 name 을 그대로 써도 무방. */
  kind: string;
  /** "up" = 로드·시작됨. "disabled" = 존재하나 비활성(예: 텔레그램 토큰 부재). */
  status: "up" | "disabled";
  /**
   * 물리 발송 가능(outbound 레지스트리에 `deliver` 표명, ADR §D4 Phase B2). telegram/cli=true,
   * http-bridge=false(관측-전용). additive — 미지정 = 하위호환(플래그 없던 Phase A 형상).
   */
  canDeliver?: boolean;
  /**
   * 기본 배달 좌표 해석 가능(`defaultOutboundTarget()` 이 non-null 반환). egress 셀렉터 후보
   * 판단(U3). telegram=true(owner chatId), cli/http-bridge=false(주소 없음/세션 문맥 의존).
   */
  hasDefaultTarget?: boolean;
}

let _presence: ChannelPresence[] = [];

/** 부팅 채널 시작 루프 직후 index.ts 가 산 channels[] 로 1회 등록. */
export const setChannelPresence = (list: ChannelPresence[]): void => {
  _presence = list.slice();
};

/** http-bridge GET /channels 가 조회. 방어적 복사본 반환. */
export const getChannelPresence = (): ChannelPresence[] => _presence.slice();
