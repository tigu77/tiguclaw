/** Actual Read UI function VM checks; no product runtime, browser, home, or DB boot.
 * Use the suite's tsx loader so the child also runs on the supported Node 20 baseline.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "read-missing-return-ui",
  guards: "Completed Read without output must explain missing historical content; pending must not. Main/history/worker/agent completion, delayed output replacement, keyboard parity and durationless running-marker cleanup.",
  run: async () => {
    const child = await spawnWithin(30_000, "read-missing-return-ui-vm", [
      "--import", "tsx",
      path.join(path.dirname(fileURLToPath(import.meta.url)), "_read-missing-return-ui-child.ts"),
    ], { cwd: process.cwd(), env: { ...process.env, TIGUCLAW_DISABLE_ENV_FILE: "1" } });
    let result: { ok?: boolean; checks?: Array<{ name: string; ok: boolean; error?: string }>; mutation?: { baseline?: string; missingGuardRestoredInMemory?: string; restoreOriginal?: string } } = {};
    try { result = JSON.parse(child.out); } catch { /* lifecycle assertion includes bounded child output */ }
    return [
      assert("source-only VM child completes", child.code === 0 && !child.timedOut && result.ok === true && result.checks?.length === 16,
        { ...child, out: child.out.slice(-3000) }),
      ...(result.checks ?? []).map(c => assert(c.name, c.ok, c.error ?? c.ok)),
      assert("real-source missing guard memory mutation green/red/restore-green", result.mutation?.baseline === "green" && result.mutation.missingGuardRestoredInMemory === "red" && result.mutation.restoreOriginal === "green", result.mutation),
    ];
  },
};
