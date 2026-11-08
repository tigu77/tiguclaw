/** Read actual-result metadata, strict preview bounds and SDK customData pairing. No live model/network/DB. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "read-card-observation",
  guards: "Read plain output lost empty/EOF/real blank rows and actual ranges; SDK normalization removed observation; long rows exceeded preview bounds or looked complete",
  run: async () => {
    assertIsolated();
    const child = await spawnWithin(60_000, "read-observation", ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "_read-card-observation-child.ts")], {
      cwd: process.cwd(), env: { ...process.env, TIGUCLAW_DISABLE_ENV_FILE: "1" },
    });
    const line = child.out.trim().split("\n").reverse().find(s => s.startsWith('{"checks":'));
    let result: { checks?: Array<{ name: string; ok: boolean; got?: unknown }> } = {};
    try { result = JSON.parse(line ?? "{}"); } catch { /* lifecycle assertion below diagnoses child failure */ }
    return [assert("isolated Read + actual SDK fake-model child completes", child.code === 0 && !child.timedOut && !!result.checks?.length, { ...child, out: child.out.slice(-2000) }),
      ...(result.checks ?? []).map(c => assert(c.name, c.ok, c.got ?? c.ok))];
  },
};
