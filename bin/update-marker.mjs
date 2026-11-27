import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

// Dependency-free update success contract. Unconfirmed AND confirmed records stay
// private: even a delayed legacy consumer must never see .update-complete.
export const UPDATE_PENDING_MARKER = ".update-pending";
// Consumer-only receipt. Never rewrite pending: the CLI producer confirms by raw CAS.
export const UPDATE_OBSERVATION_MARKER = ".update-observed";
// Once this boot is serving: launching PowerShell may still be returning (30s),
// then inner + final wait (20s each), bounded netstat/HTTP (2.5s each),
// restart settle (1.5s), and poll margins. One boot-local wait, never a watcher.
export const UPDATE_CONFIRM_WAIT_MS = 30000 + 2 * (20000 + 2500 + 2500) + 1500 + 1000;

/** @param {any} expected @param {any} boot */
export const updateBootMatches = (expected, boot) => Boolean(
  expected && boot && /^[a-f0-9]{64}$/.test(expected.instanceId) &&
  boot.instanceId === expected.instanceId &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(boot.bootId) &&
  Number.isSafeInteger(expected.notBefore) && expected.notBefore > 0 &&
  Number.isSafeInteger(boot.startedAt) && boot.startedAt >= expected.notBefore && boot.startedAt <= Date.now() &&
  Array.isArray(expected.oldBootIds) && !expected.oldBootIds.includes(boot.bootId) &&
  typeof expected.revision === "string" && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(expected.revision) &&
  boot.revision === expected.revision
);

/** Only this predicate authorizes update success, for either producer.
 * @param {any} marker @param {any} boot */
export const updateMarkerMatches = (marker, boot) => {
  if (!updateBootMatches(marker?.expected, boot)) return false;
  if (marker.mode === "direct") return marker.state === "ready";
  const confirmed = marker.confirmed;
  return marker.mode === "cli" && marker.state === "confirmed" && updateBootMatches(marker.expected, confirmed) &&
    ["instanceId", "bootId", "startedAt", "revision"].every(key => confirmed[key] === boot[key]);
};

/** How long a CLI waits for a running consumer/boot to finish with the notice slot before giving up (2026-11-27 §15).
 * Longer than the outbound retry budget a legacy boot consumer may spend delivering (it deletes only after sending). */
export const UPDATE_SLOT_WAIT_MS = 120000;

/** The shared failure-notice slot of a home: "empty" (ENOENT), "occupied" (a record is there), or "unknown" (could not tell).
 * One judgment for the daemon's intake and the CLI's start (§15 G1/G2) — unknown is never treated as empty.
 * @param {string} home @param {(p: string) => unknown} [lstat] @returns {"empty" | "occupied" | "unknown"} */
export const updateSlotState = (home, lstat = lstatSync) => {
  try {
    lstat(path.join(home, ".update-failed"));
    return "occupied";
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT" ? "empty" : "unknown";
  }
};

/** Home identity for Windows pipe names — the supervisor lock and the update pipes share it (only the suffix differs).
 * @param {string} homeAbs */
export const homePipeHash = (homeAbs) => createHash("sha256").update(path.win32.resolve(String(homeAbs)).toLowerCase()).digest("hex").slice(0, 16);
/** Update pipes are named from the home's REAL path — a junction/symlink alias of the same folder must give the same name
 * (the shared notice slot is the same file either way). Falls back to the given path if it cannot be resolved. @param {string} homeAbs */
const updatePipeHash = (homeAbs) => {
  let real = String(homeAbs);
  try { real = realpathSync.native(real); } catch { /* unresolved — use as given */ }
  return homePipeHash(real);
};
/** Windows: held by the one process allowed to change this home's install (the daemon before handing off, then the CLI). @param {string} homeAbs */
export const updateRunPipeName = (homeAbs) => `\\\\.\\pipe\\tiguclaw-update-${updatePipeHash(homeAbs)}`;
/** Windows: held by the daemon while it hands an update to its CLI — opened while it still holds the run pipe, so one per home. @param {string} homeAbs */
export const updateHandoffPipeName = (homeAbs) => `\\\\.\\pipe\\tiguclaw-update-handoff-${updatePipeHash(homeAbs)}`;

/** One update request = one attempt id, written by its producer into pending and failure records.
 * Different ONLY when both records carry an id and the ids differ — a record without an id
 * (older producer) is never guessed to be another attempt, so failure still wins as before.
 * @param {any} a @param {any} b */
export const sameUpdateAttempt = (a, b) =>
  !(typeof a?.attempt === "string" && typeof b?.attempt === "string") || a.attempt === b.attempt;

/** Existing boot consumer only; no watcher, retry service or new destination.
 * handled refers to THIS boot's notification, not the existence of old evidence.
 * read returns null ONLY for missing files; other IO failures suppress fallback.
 * failure = the failure record this boot already consumed (parsed; {} if unreadable/broken), null if none.
 * Reading a failure here only arbitrates; it is never consumed here. A same-attempt failure that appears
 * while waiting is returned as failureRaw (the bytes read) as a signal: the caller claims the record by
 * atomic rename and notifies what it claimed, this boot.
 * @param {{read:(name:string)=>Promise<string|null>, write:(name:string,raw:string)=>Promise<void>, remove:(name:string,raw:string)=>Promise<void>, boot:any, failure:any, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} io
 * @returns {Promise<{handled:boolean, data?:any, failureRaw?:string}>}
 */
export const consumeUpdateMarker = async (io) => {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const failedAtBoot = io.failure !== null && io.failure !== undefined;
  // A bounded, exact-record receipt retires notification waiting, NOT success evidence.
  // A changed/confirmed record is always reconsidered; timestamps do not expire updates.
  /** @param {string} raw */
  const fingerprint = raw => createHash("sha256").update(raw).digest("hex");
  /** @param {string} raw */
  const observe = raw => io.write(UPDATE_OBSERVATION_MARKER, fingerprint(raw));
  try {
    await io.read(".update-complete"); // Legacy is not proof of this boot's success.
    let raw = await io.read(UPDATE_PENDING_MARKER);
    if (raw === null) return { handled: failedAtBoot };
    let initial;
    try { initial = JSON.parse(raw); } catch { return { handled: failedAtBoot }; }
    // Intermediate/old boots neither consume nor retire the final boot's rendezvous.
    if (!updateBootMatches(initial?.expected, io.boot)) return { handled: failedAtBoot };
    const until = now() + UPDATE_CONFIRM_WAIT_MS;
    for (;;) {
      let marker;
      try { marker = JSON.parse(raw); } catch { return { handled: failedAtBoot }; }
      if (JSON.stringify(marker?.expected) !== JSON.stringify(initial.expected)) return { handled: failedAtBoot };
      // Failure of THIS attempt wins even simultaneous confirmation. Preserve producer bytes.
      if (failedAtBoot && sameUpdateAttempt(io.failure, marker)) {
        await observe(raw);
        return { handled: true };
      }
      const failureRaw = await io.read(".update-failed");
      if (failureRaw !== null) {
        let failure;
        try { failure = JSON.parse(failureRaw); } catch { failure = {}; }
        if (sameUpdateAttempt(failure, marker)) {
          await observe(raw);
          return { handled: true, failureRaw };
        }
        // Another attempt's failure: its own consumer notifies it; it does not decide this attempt.
      }
      if (updateMarkerMatches(marker, io.boot)) {
        // Read-before-unlink avoids consuming a replacement from another update.
        await io.remove(UPDATE_PENDING_MARKER, raw);
        return { handled: true, data: marker };
      }
      if (marker.mode !== "cli" || marker.state !== "pending") return { handled: false };
      if (await io.read(UPDATE_OBSERVATION_MARKER) === fingerprint(raw)) return { handled: false };
      if (now() >= until) {
        await observe(raw);
        return { handled: true };
      }
      await sleep(250);
      raw = await io.read(UPDATE_PENDING_MARKER);
      if (raw === null) return { handled: true };
    }
  } catch { return { handled: true }; }
};
