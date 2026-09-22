/** 운반용 힌트일 뿐 권한/출처 증명이 아니다. look이 서명·소유자·원본을 검증한다. */
export const SAVED_SCREEN_META = "tiguclaw/saved-screen";
export const savedScreenReference = (meta: unknown): string | undefined => {
  if (meta === null || typeof meta !== "object") return undefined;
  const ref = (meta as Record<string, unknown>)[SAVED_SCREEN_META];
  return typeof ref === "string" && ref.length <= 4096 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ref)
    ? ref : undefined;
};
export const savedScreenNote = (refs: readonly string[]): string =>
  [...new Set(refs)].map(saved => `저장된 화면 재열람: look(${JSON.stringify({ saved })})`).join("\n");
