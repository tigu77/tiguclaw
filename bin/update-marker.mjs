// Dependency-free update success contract. Unconfirmed AND confirmed records stay
// private: even a delayed legacy consumer must never see .update-complete.
export const UPDATE_PENDING_MARKER = ".update-pending";
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
 * read returns null ONLY for missing files; other IO failures suppress fallback.
 * @param {{read:(name:string)=>Promise<string|null>, remove:(name:string,raw:string)=>Promise<void>, boot:any, failed:boolean, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} io
 */
export const consumeUpdateMarker = async (io) => {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  try {
    const legacy = await io.read(".update-complete");
    let raw = await io.read(UPDATE_PENDING_MARKER);
    if (raw === null) return { handled: legacy !== null || io.failed };
    const initial = JSON.parse(raw);
    // An intermediate/old boot must not remove the final boot's rendezvous.
    if (!updateBootMatches(initial.expected, io.boot)) return { handled: true };
    const until = now() + UPDATE_CONFIRM_WAIT_MS;
    for (;;) {
      if (io.failed || await io.read(".update-failed") !== null) return { handled: true };
      const marker = JSON.parse(raw);
      if (JSON.stringify(marker.expected) !== JSON.stringify(initial.expected)) return { handled: true };
      if (updateMarkerMatches(marker, io.boot)) {
        // Read-before-unlink avoids consuming a replacement from another update.
        await io.remove(UPDATE_PENDING_MARKER, raw);
        return { handled: true, data: marker };
      }
      if (marker.mode !== "cli" || marker.state !== "pending" || now() >= until) return { handled: true };
      await sleep(250);
      raw = await io.read(UPDATE_PENDING_MARKER);
      if (raw === null) return { handled: true };
    }
  } catch { return { handled: true }; }
};
