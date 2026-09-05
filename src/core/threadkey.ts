/**
 * threadKey 채널 관습의 단일 정의점.
 *
 * threadKey 형식(채널별): telegram=`tg:<chatId>`, cli=`cli:<id>`, http-bridge=자유.
 * telegram 의 `tg:<chatId>` 접두 추출이 여러 곳(부팅 통지·매니저 통지·자가업데이트 좌표·
 * 프롬프트 컨텍스트·최근 대화 조회)에서 제각각 `slice("tg:".length)` 로 복제됐다. 관습이
 * 바뀌면 전부 손대야 하므로 여기 하나로 모은다(같은 걸 두 번 구현 X).
 */

/** telegram threadKey 접두. */
export const TELEGRAM_THREAD_PREFIX = "tg:";

/**
 * 기본(첫) 세션 id — 채널 무관 대화 실타래의 단일 상수
 * (ADR `docs/decisions/2026-07-15-channel-session-decoupling.md` §D2/§D4).
 *
 * ★값은 기존 물리 키 `"dashboard:default"` 를 **재사용**한다(Phase 1 무이관 계승,
 * 사용자 U1 확정). 대시보드 기본 세션의 기존 resume/transcripts/chat_log 를 그대로
 * 승계하고, 셀렉터 없는 채널(telegram·cli·http default) 인입이 이제 이 세션으로 수렴한다.
 *
 * ★§0 단방향 불변식: 이 문자열은 코어가 "dashboard" 채널을 특수 참조하는 게 아니라,
 * *마이그레이션 0* 을 위해 승계하는 **opaque 한 레거시 물리 키**일 뿐이다. resolver 는
 * 채널 정체성으로 분기하지 않는다(아래 참조). Phase 2 에서 PK 가 세션 id 단독으로
 * 축소되면 이 값의 형태는 순수 내부 관습이 된다.
 */
export const DEFAULT_SESSION_ID = "dashboard:default";

/**
 * **파생 턴 접두사** — 사람이 말을 건 대화가 아니라 **우리가 만든 턴**의 좌표들.
 *
 * ★한 곳에 둔다 (2026-09-05). 종전엔 이 목록이 소비처마다 따로 있었고, 그래서
 *  **자가성장의 사본에 `agent:` 가 빠져 있었다** — 실측: 스킬 제안 8건 중 1건이 통째로
 *  서브에이전트 턴에서 만들어졌다(우리가 띄운 하위 작업의 도구 순서를 «사용자 작업 흐름»
 *  으로 읽은 것이다). 손으로 관리하는 목록은 반드시 드리프트한다
 *  ([[feedback_hand_maintained_lists]]) — 특히 **새 종류가 늘 때 조용히 새어 든다.**
 * ★자리가 여기인 이유: 이건 좌표의 성질이다. 소비처(제안 UI·자가성장)가 각자 아는 게
 *  아니라 **좌표를 아는 곳**이 말해야 한다.
 * ★파생 턴은 전부 접두사로 **자기 출신을 밝힌다** — 그게 판정 기준이고, 이름 열거가 아니다.
 */
export const DERIVED_THREAD_PREFIXES = [
  "scheduler:",
  "worker:",
  "agent:",
  "endpoint:",
  "gateway:",
] as const;

/** 이 좌표가 파생 턴인가(= 사람이 말을 건 대화가 아닌가). */
export const isDerivedThread = (threadKey: string): boolean =>
  DERIVED_THREAD_PREFIXES.some((p) => threadKey.startsWith(p));

/**
 * 세션 정체성의 단일 정의점 — 채널이 자기 정체성을 threadKey 에 인코딩하던 로직을
 * 여기 하나로 모은다(ADR §D1). 채널은 더 이상 세션 정체성을 소유하지 않는다.
 *
 * 정책(Phase 1, 확정 (a)):
 *  - `explicitSessionId` 가 있으면(대시보드 활성 탭이 자기 세션 id 를 명시 전달) 그대로 통과.
 *  - 없으면(세션 셀렉터 없는 채널: telegram·cli·http default) → `DEFAULT_SESSION_ID`(기본 세션).
 *
 * ★§0 단방향: 범용 함수 — `channel`("telegram"/"dashboard" 등)은 opaque 데이터로만 받고
 * 특정 채널명으로 분기하지 않는다. 셀렉터 유무는 호출부가 `explicitSessionId` 전달 여부로
 * 표현한다(채널 레이어 관습). 코어는 채널 정체성을 모른다.
 *
 * ★확장점 (b) 채널→세션 바인딩(§D5, 지금은 미구현): 다중 chat/사용자로 확장되면
 * 아래 "else" 갈래에 `channel_session_binding(channel, channelAddress) → sessionId`
 * 조회를 **한 겹만** 얹으면 된다. 나머지 아키텍처(세션 id 채널 무관·주소 캡처·세션별
 * 직렬 큐)는 (b) 를 이미 지원한다. 이번 설계는 (b) 를 배제하지 않는다.
 *
 * @param channel        인입 채널명(opaque). 현재 정책은 이 값으로 분기하지 않는다.
 * @param channelAddress 채널 주소(telegram chatId, http threadKey 등). 현재 미사용 —
 *                       (b) 바인딩 확장점의 조회 키로 예약. Phase 1 에서는 무시.
 * @param explicitSessionId 세션 셀렉터가 있는 채널(대시보드 탭)이 명시한 세션 id.
 */
export const resolveSessionId = (
  channel: string,
  channelAddress?: string,
  explicitSessionId?: string,
): string => {
  const explicit = explicitSessionId?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  // ── (b) 채널→세션 바인딩 (2026-07-28 구현 — 위 주석의 확장점) ──────────────
  // 세션 셀렉터가 없는 채널이 `/sessions` 로 고른 세션을 여기서 되살린다. 한 겹만 얹는다.
  // ★조회 실패(store 미초기화·DB 오류)는 **기본 세션으로 안전 degrade** 하되 조용히 넘기지
  //  않는다 — 사용자는 "왜 다른 세션으로 가지" 를 알 길이 없으므로 로그를 남긴다.
  //  (로그는 1회성 소음이 되지 않게 실패 종류별 첫 발생만.)
  const addr = channelAddress?.trim();
  if (addr !== undefined && addr !== "") {
    try {
      const bound = lookupBinding(channel, addr);
      if (bound !== null && bound !== "") return bound;
    } catch (e) {
      warnBindingLookupOnce(e);
    }
  }
  return DEFAULT_SESSION_ID;
};

/** 바인딩 조회 주입점 — 코어가 store 를 직접 import 하지 않게 한다(단방향 유지). */
type BindingLookup = (channel: string, channelAddress: string) => string | null;
let lookupBindingImpl: BindingLookup | null = null;
let bindingWarned = false;

const lookupBinding: BindingLookup = (channel, channelAddress) =>
  lookupBindingImpl === null ? null : lookupBindingImpl(channel, channelAddress);

const warnBindingLookupOnce = (e: unknown): void => {
  if (bindingWarned) return;
  bindingWarned = true;
  console.warn(
    `threadkey: 채널→세션 바인딩 조회 실패 — 기본 세션으로 진행합니다: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
};

/**
 * 바인딩 조회 구현 등록 — 부팅 시 1회(index.ts). 미등록이면 바인딩 없음으로 동작하므로
 * 기존 경로(기본 세션)와 완전히 동일하다(테스트·검증 스크립트에서 DB 없이 임포트 가능).
 */
export const setChannelSessionBindingLookup = (fn: BindingLookup | null): void => {
  lookupBindingImpl = fn;
};

/**
 * threadKey 가 `tg:<chatId>` 면 chatId(trim), 아니면 null.
 * 접두 없음·chatId 빈 문자열 → null (호출부가 `?? threadKey` 등으로 폴백 결정).
 */
export const extractTelegramChatId = (threadKey: string): string | null => {
  if (!threadKey.startsWith(TELEGRAM_THREAD_PREFIX)) return null;
  const chatId = threadKey.slice(TELEGRAM_THREAD_PREFIX.length).trim();
  return chatId.length > 0 ? chatId : null;
};
