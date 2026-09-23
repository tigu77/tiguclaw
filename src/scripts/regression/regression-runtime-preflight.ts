/** Windows native fs crashes must be diagnosed before the suite, not hidden by exclusions. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "regression-runtime-preflight",
  guards: "Windows Node 24.12.0 cpSync Unicode destination aborts the whole suite natively; diagnose runtime before discovery without dropping tests",
  run: async () => {
    assertIsolated();
    const results: Assertion[] = [];
    const assert = (ok: unknown, message: string, got = String(ok)): void => { results.push({ name: message, ok: Boolean(ok), got }); };
    const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    assert(source.indexOf("assertRegressionRuntime();") < source.indexOf('await import("../../store/sessions.js")'), "preflight must precede product evaluation");
    assert(source.indexOf('process.env.TIGUCLAW_DISABLE_ENV_FILE = "1"') < source.indexOf("assertRegressionRuntime();"), "preflight must follow environment seal");
    if (process.platform !== "win32") return results;
    const root = mkdtempSync(path.join(tmpdir(), "preflight-regression-"));
    const helper = new URL("./_runtime-preflight.ts", import.meta.url).href;
    try {
      // Fault the actual child-side native operation; parent stays real.
      const hook = path.join(root, "fault.mjs");
      const marker = path.join(root, "reached.txt");
      writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; fs.cpSync=()=>process.exit(73); syncBuiltinESMExports();`);
      const code = `const {assertRegressionRuntime}=await import(${JSON.stringify(helper)}); assertRegressionRuntime(); (await import('node:fs')).writeFileSync(${JSON.stringify(marker)},'reached');`;
      const base: NodeJS.ProcessEnv = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
      const regDir = path.join(root, "src/scripts/regression");
      const storeDir = path.join(root, "src/store");
      mkdirSync(regDir, { recursive: true });
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      writeFileSync(path.join(regDir, "run.ts"), source);
      writeFileSync(path.join(regDir, "_runtime-preflight.ts"), readFileSync(new URL("./_runtime-preflight.ts", import.meta.url), "utf8"));
      writeFileSync(path.join(storeDir, "sessions.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'product evaluated'); export const initStore=()=>{}; export const closeStore=()=>{};`);
      const failed = spawnSync(process.execPath, ["--import", "tsx", path.join(regDir, "run.ts")], {
        encoding: "utf8", timeout: 30_000, env: { ...base, NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --import=${JSON.stringify(pathToFileURL(hook).href)}` },
      });
      assert(failed.status !== 0 && !failed.error, "faulted runtime must fail normally");
      assert(failed.stderr.includes("runtime preflight failed") && failed.stderr.includes("exit=73"), "report child failure and remedy", failed.stderr);
      assert(!existsSync(marker), "must not continue after failed preflight");
      const passed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        encoding: "utf8", timeout: 30_000, env: base,
      });
      assert(passed.status === 0, `healthy runtime must continue: ${passed.stderr}`);
      assert(existsSync(marker), "healthy runtime reaches next step");
    } finally { rmSync(root, { recursive: true, force: true }); }
    return results;
  },
};
