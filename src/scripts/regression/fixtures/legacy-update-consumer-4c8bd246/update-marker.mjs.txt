import { createHash } from "node:crypto";

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

/** Existing boot consumer only; no watcher, retry service or new destination.
 * handled refers to THIS boot's notification, not the existence of old evidence.
 * read returns null ONLY for missing files; other IO failures suppress fallback.
 * @param {{read:(name:string)=>Promise<string|null>, write:(name:string,raw:string)=>Promise<void>, remove:(name:string,raw:string)=>Promise<void>, boot:any, failed:boolean, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} io
 */
export const consumeUpdateMarker = async (io) => {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // A bounded, exact-record receipt retires notification waiting, NOT success evidence.
  // A changed/confirmed record is always reconsidered; timestamps do not expire updates.
  /** @param {string} raw */
  const fingerprint = raw => createHash("sha256").update(raw).digest("hex");
  /** @param {string} raw */
  const observe = raw => io.write(UPDATE_OBSERVATION_MARKER, fingerprint(raw));
  try {
    await io.read(".update-complete"); // Legacy is not proof of this boot's success.
    let raw = await io.read(UPDATE_PENDING_MARKER);
    if (raw === null) return { handled: io.failed };
    let initial;
    try { initial = JSON.parse(raw); } catch { return { handled: io.failed }; }
    // Intermediate/old boots neither consume nor retire the final boot's rendezvous.
    if (!updateBootMatches(initial?.expected, io.boot)) return { handled: io.failed };
    const until = now() + UPDATE_CONFIRM_WAIT_MS;
    for (;;) {
      let marker;
      try { marker = JSON.parse(raw); } catch { return { handled: io.failed }; }
      if (JSON.stringify(marker?.expected) !== JSON.stringify(initial.expected)) return { handled: io.failed };
      if (io.failed || await io.read(".update-failed") !== null) {
        // Failure wins even simultaneous confirmation. Preserve producer bytes.
        await observe(raw);
        return { handled: true };
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
