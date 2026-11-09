// Dependency-free identity shared by the lifecycle CLI and the daemon.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/** @param {string} value */
const canonical = (value) => {
  let resolved = path.resolve(value);
  try { resolved = realpathSync.native(resolved); } catch { /* not created yet */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** @param {{home: string, repoRoot: string, runtime?: string}} input */
export const instanceIdFor = ({ home, repoRoot, runtime }) => createHash("sha256")
  .update(JSON.stringify([canonical(home), canonical(repoRoot), runtime?.trim() === "source" ? "source" : "built"]))
  .digest("hex");

// Symbol.for survives module/plugin reloads. Call only AFTER load-env with resolveHome/sourceRoot.
const key = Symbol.for("tiguclaw.process-identity");
const revisionKey = Symbol.for("tiguclaw.boot-revision");
/** Set once from self-update's existing module-load build snapshot, never disk at request time.
 * @param {string | null} revision */
export const setBootRevision = (revision) => {
  const globals = /** @type {any} */ (globalThis);
  if (!(revisionKey in globals)) globals[revisionKey] = revision;
};
/** @param {{home: string, repoRoot: string, runtime?: string}} input */
export const getProcessIdentity = (input) => {
  const globals = /** @type {any} */ (globalThis);
  return globals[key] ??= Object.freeze({
    instanceId: instanceIdFor(input),
    bootId: randomUUID(),
    get revision() { return globals[revisionKey] ?? null; },
    startedAt: Math.floor(Date.now() - process.uptime() * 1000),
  });
};
