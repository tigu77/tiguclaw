/** Test-only link fixtures — shipped with the regression suite (this file); `bench/isolation/test-links.mjs` re-exports it for
 *  the dev-only bench tests (top-level `bench/` is not shipped, so shipped checks must not reach into it).
 *  Windows refuses symlinks without Developer Mode/admin (EPERM, v4 Windows log 2026-11-05):
 *  directory links become junctions, which any user can create and lstat reports as links; file links have no
 *  unprivileged equivalent, so that one case is skipped with this marker — bench-response-relay.ts accepts the
 *  marker only on Windows and reports it as not run, never as passed. `platform`/`symlink`/`env` exist for test-links.test.mjs.
 *  The refusal condition lives only here (`isWindowsFileLinkRefusal`); regression checks load this module instead of copying it. */
import fs from 'node:fs';
export const WINDOWS_FILE_LINK_SKIP = 'windows-file-symlink-privilege';
/** Wording for a skipped file-link assertion — says what happened, not why (the cause is not established). */
export const FILE_LINK_NOT_RUN = '이 환경에서 파일 symlink 생성 거부됨 — 미실행';
/** Test-only switch: pretend to be Windows refusing file symlinks, so the refusal branches run on any machine. */
export const SIMULATE_FILE_LINK_REFUSAL_ENV = 'TIGUCLAW_TEST_SIMULATE_FILE_LINK_REFUSAL';
export const isWindowsFileLinkRefusal = (e, platform) => platform === 'win32' && e?.code === 'EPERM' && e?.syscall === 'symlink';
export function linkDir(target, at, { platform = process.platform, symlink = fs.symlinkSync } = {}) {
  symlink(target, at, platform === 'win32' ? 'junction' : 'dir');
}
const refusedSymlink = (target, at) => {
  throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${at}'`), { code: 'EPERM', errno: -4048, syscall: 'symlink', path: target, dest: at });
};
/** Creates a file symlink: `true` when created, the skip reason when this environment refuses it; anything else throws. */
export function linkFile(target, at, { platform = process.platform, symlink = fs.symlinkSync, env = process.env } = {}) {
  const simulate = env[SIMULATE_FILE_LINK_REFUSAL_ENV] === '1';
  try { (simulate ? refusedSymlink : symlink)(target, at, 'file'); return true; }
  catch (e) {
    if (!isWindowsFileLinkRefusal(e, simulate ? 'win32' : platform)) throw e;
    return `${WINDOWS_FILE_LINK_SKIP}: ${e.message}`;
  }
}
export function linkFileOrSkip(t, target, at, { platform = process.platform, symlink = fs.symlinkSync } = {}) {
  try { symlink(target, at, 'file'); return true; }
  catch (e) {
    if (!isWindowsFileLinkRefusal(e, platform)) throw e;
    t.skip(`${WINDOWS_FILE_LINK_SKIP}: ${e.message}`); return false;
  }
}
