/** 읽기 전용 동기 판정. runtime·독립 CLI가 함께 쓴다. refresh·환경파일 로드 없음. */
export const codexAuthAvailable = (): boolean =>
  (process.env.OPENAI_CODEX_OAUTH_TOKEN ?? "") !== "" ||
  (process.env.OPENAI_CODEX_OAUTH_REFRESH ?? "") !== "";
