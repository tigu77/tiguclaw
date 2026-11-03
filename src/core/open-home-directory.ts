import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { getPaths } from "./paths.js";
import { systemOpener } from "./onboard-ready.js";

/** Fixed server home only; no browser-supplied path or shell. Success is a request, not a visible window. */
export const openHomeDirectory = async (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof execFile = execFile,
): Promise<void> => openDirectory(getPaths().home, platform, env, run);

/** Raised before any opener runs when the host has no desktop to show a window on. */
export class NoDisplayError extends Error {
  constructor() {
    super("No desktop display available");
  }
}

/**
 * Opens a server-chosen directory in the OS file browser on the daemon machine (2026-11-03: also the project menu's folder action).
 * Callers pass only paths they resolved themselves (fixed home, a linked project's registered path) — never text from a message.
 */
export const openDirectory = async (
  dir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof execFile = execFile,
): Promise<void> => {
  if (!(await stat(dir)).isDirectory()) throw new Error("Not a directory");
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new NoDisplayError();
  }
  const args = platform === "darwin" ? ["-a", "Finder", dir] : [dir];
  await new Promise<void>((resolve, reject) => {
    const child = run(systemOpener(platform), args, { timeout: 5000, windowsHide: true }, (err) => {
      // Explorer may exit nonzero after forwarding to an existing instance. Only claim process start on Windows.
      if (platform !== "win32") err ? reject(err) : resolve();
    });
    child.once("error", reject);
    if (platform === "win32") child.once("spawn", () => resolve());
  });
};
