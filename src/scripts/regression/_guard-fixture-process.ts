/** Process ownership for dashboard-proxy/stop-starting fixtures only (not product lifecycle). */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { rm } from "node:fs/promises";

/** Own detached POSIX group / Windows tree, including tsx's actual worker. */
const signalTree = (child: ChildProcess, force: boolean): void => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
  }
};

export const stopFixtureProcess = async (child: ChildProcess): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let closed = false;
  const onClose = (): void => { closed = true; };
  child.once("close", onClose);
  signalTree(child, false);
  const wait = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (!closed && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  };
  await wait(3000);
  if (!closed) { signalTree(child, true); await wait(2000); }
  child.off("close", onClose);
  return closed;
};

/** Child fixture crash/normal exit must not orphan its daemon. */
export const reapFixtureOnExit = (child: ChildProcess): void => {
  process.once("exit", () => signalTree(child, true));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => { signalTree(child, true); process.exit(1); });
  }
};

/** Cleanup is reported separately: it must never replace the product assertion results. */
export const removeFixtureHome = async (home: string): Promise<string | null> => {
  try { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
};

export const spawnFixtureWithin = async (
  ms: number, args: string[], opts: SpawnOptions,
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> => {
  const child = spawn(process.execPath, args, { ...opts, detached: process.platform !== "win32" });
  let out = "", err = "", timedOut = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (s: string) => { out += s; });
  child.stderr?.on("data", (s: string) => { err += s; });
  return await new Promise((resolve) => {
    let done = false;
    // A timed-out child has no exit code of its own. Windows `taskkill /F` closes it with 1 before stopFixtureProcess
    // resolves, so a timeout looked like an ordinary failure — the v4 Windows log (status 1, empty stderr) has that shape,
    // cause not confirmed. Never report that code.
    const finish = (code: number | null): void => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ code: timedOut ? null : code, out, err, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stopFixtureProcess(child).then(() => finish(null));
    }, ms);
    child.once("error", (e) => { err += e.message; finish(null); });
    child.once("close", finish);
  });
};
