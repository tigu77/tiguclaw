// @ts-check
/** App-private PortableGit discovery. Never edits machine/user PATH or policy. */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import * as util from "node:util";
import { spawnSync } from "node:child_process";

/**
 * The installer and fresh CLI/supervisor processes use the same per-user location.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform
 * @param {(file: string) => boolean} exists
 * @param {() => boolean} hasGit
 */
export const applyWindowsTools = (
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  hasGit = () => spawnSync("git.exe", ["--version"], { stdio: "ignore", env, windowsHide: true }).status === 0,
) => {
  if (platform !== "win32" || !env.LOCALAPPDATA) return;
  const git = path.win32.join(env.LOCALAPPDATA, "tiguclaw", "tools", "git");
  const cmd = path.win32.join(git, "cmd");
  if (!exists(path.win32.join(cmd, "git.exe")) || !exists(path.win32.join(git, "bin", "bash.exe")) ||
      !exists(path.win32.join(git, "tiguclaw-portable-git.json"))) return;
  // Windows env keys are case-insensitive; plain test dictionaries need the same treatment.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  if (!hasGit()) env[pathKey] = `${cmd};${env[pathKey] ?? ""}`;
  if (!env.CLAUDE_CODE_GIT_BASH_PATH) {
    // Respect a user's explicit home setting before supplying a process-only default.
    // parseEnv is optional on the earliest supported Node 20; do not fail module linking.
    let configured;
    try {
      const parse = /** @type {{ parseEnv?: (body: string) => Record<string, string> }} */ (util).parseEnv;
      const home = env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
      configured = parse?.(readFileSync(path.join(home, ".env"), "utf8")).CLAUDE_CODE_GIT_BASH_PATH;
    } catch { /* No home .env: fresh installation. */ }
    env.CLAUDE_CODE_GIT_BASH_PATH = configured || path.win32.join(git, "bin", "bash.exe");
  }
};
