import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assert, type Assertion } from "./_framework.js";
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const tsxLoader = pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href;
const guard = path.join(repo, "src/scripts/regression/_windows-onboarding-sandbox.cjs");
/** Allowlist only. No inherited tokens, NODE_OPTIONS, config roots or production HOME. */
export const onboardingEnv = (root: string, home = path.join(root, "home")): NodeJS.ProcessEnv => {
  const osHome = path.join(root, "os-home");
  for (const dir of [root, home, osHome, path.join(root, "tmp"), path.join(root, "local"), path.join(root, "config")]) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: osHome, USERPROFILE: osHome, TIGUCLAW_HOME: home,
    TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "config"), XDG_CONFIG_HOME: path.join(root, "config"),
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter),
    NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
    TIGUCLAW_TEST_SANDBOX_ROOT: root, TIGUCLAW_TEST_AUDIT: path.join(root, "audit.jsonl"),
    TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1", NO_COLOR: "1",
  };
  for (const k of ["SystemRoot", "WINDIR", "ComSpec", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
};
export const readAudit = (root: string): Array<{ kind: string; path?: string; allowed?: boolean }> => {
  try { return readFileSync(path.join(root, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};
/** Must pass before any auth/CLI probe. Tests the real loaders and an intentionally forbidden synthetic path. */
export const proveOnboardingIsolation = (base: string): Assertion => {
  const allowed = path.join(base, "allowed"); const cwd = path.join(allowed, "cwd"); mkdirSync(cwd, { recursive: true });
  const env = onboardingEnv(allowed);
  const home = env.TIGUCLAW_HOME!;
  writeFileSync(path.join(home, ".env"), "TIGUCLAW_SENTINEL_HOME=selected\n");
  writeFileSync(path.join(cwd, ".env"), "TIGUCLAW_SENTINEL_CWD=selected\n");
  writeFileSync(path.join(env.HOME!, ".env"), "TIGUCLAW_SENTINEL_OSHOME=must-not-load\n");
  const denied = path.join(base, "synthetic-denied"); mkdirSync(denied, { recursive: true });
  const deniedFile = path.join(denied, ".env"); writeFileSync(deniedFile, "TIGUCLAW_SENTINEL_FORBIDDEN=must-not-load\n");
  // Same guard must still refuse a sibling sharing the root's prefix and an owned-root link that escapes outside.
  const sibling = path.join(base, "allowed-sibling"); mkdirSync(sibling, { recursive: true });
  const siblingFile = path.join(sibling, ".env"); writeFileSync(siblingFile, "TIGUCLAW_SENTINEL_FORBIDDEN=must-not-load\n");
  const escapeLink = path.join(allowed, "escape"); symlinkSync(denied, escapeLink, "junction");
  const escapedFile = path.join(escapeLink, ".env");
  const deniedFiles = [deniedFile, siblingFile, escapedFile];
  const code = `
    await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/core/load-env.ts")).href)});
    const { installedEnvLookup } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/core/onboard-ready.ts")).href)});
    const lookup = installedEnvLookup(${JSON.stringify(path.join(home, ".env"))}, process.cwd());
    const { refreshHomeCredentials } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/core/credential-env.ts")).href)});
    refreshHomeCredentials();
    let blocked = true; for (const file of ${JSON.stringify(deniedFiles)}) { try { (await import('node:fs')).readFileSync(file, 'utf8'); blocked = false; } catch (e) { blocked &&= String(e).includes('Sandbox denied credential path'); } }
    let networkBlocked = false; try { await fetch('http://synthetic-fixture.invalid'); } catch (e) { networkBlocked = String(e).includes('Network disabled in onboarding fixture'); }
    console.log('ISOLATION_RESULT=' + JSON.stringify({ home: process.env.TIGUCLAW_SENTINEL_HOME === 'selected', cwd: process.env.TIGUCLAW_SENTINEL_CWD === 'selected', noOsHome: !process.env.TIGUCLAW_SENTINEL_OSHOME, noForbidden: !process.env.TIGUCLAW_SENTINEL_FORBIDDEN, lookup: lookup('TIGUCLAW_SENTINEL_HOME') === 'selected', blocked, networkBlocked }));
  `;
  const r = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", code], { cwd, env, encoding: "utf8", timeout: 30_000 });
  const line = r.stdout?.split("\n").find((s) => s.startsWith("ISOLATION_RESULT="));
  const result = line ? JSON.parse(line.slice("ISOLATION_RESULT=".length)) : {};
  const events = readAudit(allowed);
  const forbidden = events.filter((e) => e.kind === "credential-read" && !e.allowed);
  // process.cwd() reports the real spelling (/private/tmp) of the same owned file; compare real paths.
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const allowedReads = events.filter((e) => e.kind === "credential-read" && e.allowed).map((e) => real(e.path!));
  return assert("합성 sentinel: explicit HOME/TIGUCLAW_HOME/cwd only, credential read allowlist and network deny installed", r.status === 0 && Object.keys(result).length === 7 && Object.values(result).every(Boolean) &&
    forbidden.length === deniedFiles.length && deniedFiles.every((file, i) => forbidden[i]!.path === file) &&
    allowedReads.includes(real(path.join(home, ".env"))) && allowedReads.includes(real(path.join(cwd, ".env"))), { status: r.status, result, events, stderr: r.stderr?.slice(-300) });
};
