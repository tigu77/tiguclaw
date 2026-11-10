/** Partial output is evidence, not success and not the failure's cause.
 * Keep the original Error identity/name/cause for authentication, limit, cancel and network classification.
 */
const reports = new WeakMap<Error, string>();
const replayBlocks = new WeakMap<Error, string>();
const notices = new WeakMap<Error, string>();
/** Display guidance is not the error's cause or a completed report. */
export const withFailureNotice = (error: Error, notice: string): void => { notices.set(error, notice); };
export const failureNoticeOf = (error: unknown): string | undefined =>
  error instanceof Error ? notices.get(error) : undefined;
export const markReplayBlocked = (error: unknown, reason: string): void => {
  if (error instanceof Error) replayBlocks.set(error, reason);
};
export const replayBlockOf = (error: unknown): string | undefined =>
  error instanceof Error ? replayBlocks.get(error) : undefined;
export const withPartialReport = (error: unknown, report: string): Error => {
  const e = error instanceof Error ? error : new Error(String(error));
  if (report !== "") reports.set(e, report);
  return e;
};
export const partialReportOf = (error: unknown): string | undefined =>
  error instanceof Error ? reports.get(error) : undefined;
