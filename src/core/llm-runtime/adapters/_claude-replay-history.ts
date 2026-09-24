import { loadThreadHistory } from "../../../store/memory.js";

/** 재개용 델타와 재개 실패 시 쓸 최근 전체 기록을 구분한다. */
export const loadClaudeReplayHistory = (
  channel: Parameters<typeof loadThreadHistory>[0],
  threadKey: string,
  resumeSessionId: string | undefined,
) => {
  const full = loadThreadHistory(channel, threadKey);
  const delta = resumeSessionId
    ? loadThreadHistory(channel, threadKey, { afterSessionId: resumeSessionId })
    : full;
  return { full, delta };
};
