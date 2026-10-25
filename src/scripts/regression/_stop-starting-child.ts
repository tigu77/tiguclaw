/**
 * `stop-reaches-starting-turn` 의 자식 프로브 — **진짜 데몬을 띄워** `UserPromptSubmit` 훅을 장벽으로 세우고, 훅이 기다리는 동안 `/stop` 을 보낸다.
 *
 * 왜 진짜 데몬인가: 이 틈은 `src/index.ts` 핸들러 클로저 안(훅 대기 → 진행 중 등록)이라 import 로 못 뽑는다(`_ephemeral-wiring-child` 와 같은 이유).
 * 모델 호출 관측: 회귀 모드 데몬은 모델을 부르면 `REGRESSION_LIVE_MODEL_BLOCKED` 로 실패하고 그 오류 안내가 CLI 로 나온다 — 그 글이
 *  **안 나오면** 모델 호출 0 이다. 양성 대조(멈추지 않은 턴은 그 글이 나온다·차단 훅은 차단 안내가 나온다)를 같이 돌려 «안 나옴» 이 공허하지 않게 한다.
 * 출력: 마지막 줄 JSON — 단계별로 그 구간에 CLI 로 나온 글.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootVerdict, freePort, reapOnExit, seedIsolatedEnv } from "./_probe-helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  const home = process.env.PROBE_HOME ?? "";
  const port = String(await freePort());
  const dashPort = String(await freePort());
  // 장벽 훅 — 시작하면 `waiting` 을 만들고 `release` 가 생길 때까지 기다린다. `code` 가 2 면 차단(stderr = 사유).
  const hook = path.join(home, "barrier-hook.sh");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      `H='${home}'`,
      'touch "$H/waiting"',
      'while [ ! -f "$H/release" ]; do sleep 0.05; done',
      'code=$(cat "$H/code" 2>/dev/null || echo 0)',
      'rm -f "$H/release" "$H/waiting"',
      'if [ "$code" = "2" ]; then echo "regr-barrier-block" >&2; exit 2; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ locale: "en", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `sh '${hook}'`, timeout: 30 }] }] } }),
  );
  seedIsolatedEnv(home, { TELEGRAM_BOT_TOKEN: "", HTTP_BRIDGE_PORT: port, HTTP_BRIDGE_TOKEN: "stop-starting-probe", DASHBOARD_PORT: dashPort });
  const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src/index.ts")], {
    cwd: REPO,
    detached: true,
    env: {
      ...process.env,
      TIGUCLAW_HOME: home,
      TELEGRAM_BOT_TOKEN: "",
      HTTP_BRIDGE_HOST: "127.0.0.1",
      HTTP_BRIDGE_PORT: port,
      HTTP_BRIDGE_TOKEN: "stop-starting-probe",
      DASHBOARD_PORT: dashPort,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  reapOnExit(child.pid);
  let gone = false;
  child.on("exit", () => { gone = true; });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond() || gone) return cond();
      await sleep(50);
    }
    return cond();
  };
  await until(() => /EADDRINUSE/.test(out) || out.includes(`http-bridge listening on http://127.0.0.1:${port}`), 60_000);
  const verdict = bootVerdict(out, port);
  const steps: Record<string, string> = {};
  const waiting = path.join(home, "waiting");
  const release = (code: 0 | 2): void => {
    writeFileSync(path.join(home, "code"), String(code));
    writeFileSync(path.join(home, "release"), "");
  };
  /** 한 단계 — 시작 위치부터 그 단계가 끝날 때까지 나온 글을 모은다. */
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    const from = out.length;
    await run();
    steps[name] = out.slice(from);
  };
  const send = (line: string): void => { child.stdin.write(`${line}\n`); };
  const sendAndHold = async (text: string): Promise<boolean> => {
    rmSync(waiting, { force: true });
    send(text);
    return until(() => existsSync(waiting), 15_000);
  };
  let held = { a: false, b: false, c: false, d: false };
  if (verdict.ok) {
    // ⓐ 훅이 기다리는 동안 `/stop` → 훅 **통과**로 해제: 모델 호출 0 · `/stop` 답은 «멈춤».
    await step("a", async () => {
      held.a = await sendAndHold("regr-probe-a hello");
      send("/stop");
      await until(() => out.includes("Stopped the current turn") || out.includes("Nothing is in progress"), 10_000);
      release(0);
      await sleep(2500);
    });
    // 끝난 뒤 «시작 중» 표시가 남지 않는다 — 다음 `/stop` 은 «진행 중 없음».
    await step("idleAfter", async () => {
      send("/stop");
      await until(() => out.includes("Nothing is in progress") || out.includes("Stopped the current turn"), 10_000);
      await sleep(300);
    });
    // ⓑ 같은 순서를 훅 **차단**으로 해제 — 차단 안내도 안 나간다.
    await step("b", async () => {
      held.b = await sendAndHold("regr-probe-b hello");
      send("/stop");
      await until(() => out.includes("Stopped the current turn"), 10_000);
      release(2);
      await sleep(2500);
    });
    // 양성 대조 ① — 멈추지 않으면 그 턴은 모델을 부른다(회귀 모드라 그 실패 안내가 나온다).
    await step("c", async () => {
      held.c = await sendAndHold("regr-probe-c hello");
      release(0);
      await until(() => out.includes("REGRESSION_LIVE_MODEL_BLOCKED"), 15_000);
      await sleep(300);
    });
    // 양성 대조 ② — 멈추지 않은 차단 훅은 차단 안내가 나온다.
    await step("d", async () => {
      held.d = await sendAndHold("regr-probe-d hello");
      release(2);
      await until(() => out.includes("A hook blocked this request"), 15_000);
      await sleep(300);
    });
  }
  child.stdin.end();
  try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await sleep(1500);
  try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  console.log(JSON.stringify({ booted: verdict.ok, why: verdict.why, held, steps, tail: verdict.ok ? "" : out.slice(-600) }));
  process.exit(0);
};

void main();
