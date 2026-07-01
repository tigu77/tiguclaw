/**
 * threadKey 채널 관습의 단일 정의점.
 *
 * threadKey 형식(채널별): telegram=`tg:<chatId>`, cli=`cli:<id>`, http-bridge=자유.
 * telegram 의 `tg:<chatId>` 접두 추출이 여러 곳(부팅 통지·워커 통지·자가업데이트 좌표·
 * 프롬프트 컨텍스트·최근 대화 조회)에서 제각각 `slice("tg:".length)` 로 복제됐다. 관습이
 * 바뀌면 전부 손대야 하므로 여기 하나로 모은다(같은 걸 두 번 구현 X).
 */

/** telegram threadKey 접두. */
export const TELEGRAM_THREAD_PREFIX = "tg:";

/**
 * threadKey 가 `tg:<chatId>` 면 chatId(trim), 아니면 null.
 * 접두 없음·chatId 빈 문자열 → null (호출부가 `?? threadKey` 등으로 폴백 결정).
 */
export const extractTelegramChatId = (threadKey: string): string | null => {
  if (!threadKey.startsWith(TELEGRAM_THREAD_PREFIX)) return null;
  const chatId = threadKey.slice(TELEGRAM_THREAD_PREFIX.length).trim();
  return chatId.length > 0 ? chatId : null;
};
