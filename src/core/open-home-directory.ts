import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { getPaths } from "./paths.js";
import { systemOpener } from "./onboard-ready.js";

/** Fixed server home only; no browser-supplied path or shell. Success is a request, not a visible window. */
export const openHomeDirectory = async (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof execFile = execFile,
): Promise<void> => {
  const home = getPaths().home;
  if (!(await stat(home)).isDirectory()) throw new Error("Home is not a directory");
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error("No desktop display available");
  }
  const args = platform === "darwin" ? ["-a", "Finder", home] : [home];
  await new Promise<void>((resolve, reject) => {
    const child = run(systemOpener(platform), args, { timeout: 5000, windowsHide: true }, (err) => {
      // Explorer may exit nonzero after forwarding to an existing instance. Only claim process start on Windows.
      if (platform !== "win32") err ? reject(err) : resolve();
    });
    child.once("error", reject);
    if (platform === "win32") child.once("spawn", () => resolve());
  });
};
