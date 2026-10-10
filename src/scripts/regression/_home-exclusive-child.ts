/**
 * `daemon-home-is-exclusive` 의 자식 — **진짜 데몬 셋**을 한 홈으로 띄운다.
 *  A 기동 → 같은 홈으로 B 기동(막혀야 한다) → A 를 SIGKILL(잠금이 남는다) → C 기동(남은 잠금을 회수해야 한다).
 * 마지막 줄 JSON.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootVerdict, freePort, seedIsolatedEnv, tsxLoaderUrl } from "./_probe-helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(path.join(tmpdir(), "home-excl-"));

const kids: ChildProcess[] = [];
/**
 * 프로세스 트리를 강제로 죽인다 — 크래시·SIGKILL 과 같은 모양(exit 훅이 안 돈다). 윈도우엔 프로세스 그룹 신호(`kill(-pid)`)가 없다 —
 * `taskkill /T /F`(TerminateProcess 와 같다). 2026-10-10 윈도우 실측에서 그룹 신호가 ESRCH 로 죽어 이 검사가 통째로 못 돌았다.
 */
const hardKill = (pid: number): void => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-pid, "SIGKILL");
};
const killAll = (): void => {
  for (const k of kids) {
    try {
      if (k.pid !== undefined && k.exitCode === null) hardKill(k.pid);
    } catch {
      /* 이미 죽음 */
    }
  }
};
process.on("exit", killAll);
process.on("SIGTERM", () => process.exit(1));

const boot = async (): Promise<{ child: ChildProcess; log: () => string; gone: () => boolean; port: string }> => {
  const port = String(await freePort());
  const env = {
    TELEGRAM_BOT_TOKEN: "",
    HTTP_BRIDGE_HOST: "127.0.0.1",
    HTTP_BRIDGE_PORT: port,
    HTTP_BRIDGE_TOKEN: "home-excl",
    DASHBOARD_PORT: String(await freePort()),
  };
  seedIsolatedEnv(home, env);
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl(REPO) ?? "tsx", path.join(REPO, "src/index.ts")], {
    cwd: REPO,
    detached: true,
    env: { ...process.env, ...env, TIGUCLAW_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  let out = "";
  let gone = false;
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  child.on("exit", () => (gone = true));
  return { child, log: () => out, gone: () => gone, port };
};
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(150);
  }
  return cond();
};

const res: Record<string, unknown> = {};
const a = await boot();
await until(() => a.gone() || bootVerdict(a.log(), a.port).ok, 90_000);
res.aBooted = bootVerdict(a.log(), a.port).ok;
res.aWhy = bootVerdict(a.log(), a.port).why;
const lockFile = path.join(home, "daemon.lock");
res.lockPidIsA = existsSync(lockFile) && (JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number }).pid === a.child.pid;

if (res.aBooted === true) {
  const b = await boot();
  await until(() => b.gone(), 60_000);
  res.bExited = b.gone();
  res.bExitCode = b.child.exitCode;
  res.bSaysHeld = /이미 다른 데몬\(pid \d+\)이 쓰고 있습니다/.test(b.log());
  // B 가 DB 를 열기 전에 나갔나 — 채널·복구·리퍼 어느 것도 돌지 않았어야 한다.
  res.bTouchedNothing = !/http-bridge listening|작동 헌법 로드|bg-shells reaper|ready/.test(b.log().replace(/tiguclaw daemon: starting[^\n]*/, ""));
  res.aAliveAfterB = !a.gone();
  res.lockStillA = existsSync(lockFile) && (JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number }).pid === a.child.pid;

  // A 를 SIGKILL — exit 훅이 못 돌아 잠금이 남는다(크래시·kickstart -k 와 같은 모양).
  hardKill(a.child.pid!);
  await until(() => a.gone(), 10_000);
  res.lockLeftAfterKill = existsSync(lockFile);
  const c = await boot();
  await until(() => c.gone() || bootVerdict(c.log(), c.port).ok, 90_000);
  res.cBooted = bootVerdict(c.log(), c.port).ok;
  res.cReclaimed = /\[home-lock\] 남은 잠금 회수 — pid \d+ 없음/.test(c.log());
  res.cTail = c.gone() ? c.log().slice(-300) : "";
}
killAll();
await sleep(300);
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(res));
process.exit(0);
