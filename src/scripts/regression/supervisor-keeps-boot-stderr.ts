/**
 * 회귀: **Windows 감독자는 데몬이 로거를 세우기 전에 죽은 이유를 로그에 남긴다** (2026-10-29).
 *
 * 사고(Windows 현장 보고): 재기동 직후 데몬이 0.1초 만에 exit 1 로 되풀이 죽었다. 감독자 로그엔 «exited after 0s (code=1)» 뿐이었다.
 *  앱 로거·최후 그물(`src/index.ts`)은 **정적 import 가 다 풀린 뒤**에야 선다 — 의존성이 빠져 `ERR_MODULE_NOT_FOUND` 로 죽으면 node 가
 *  stderr 에 찍고 끝나는데, 예약작업은 창 없는 콘솔·직접 기동은 `ignore` 라 어디에도 안 남았다. 의존성만 복원하자 같은 코드가 정상으로 떴다.
 *
 * 지키는 것: 비정상 종료 때 stderr **끝부분**을 가려서 감독자 로그에 · 같은 것이 되풀이되면 한 줄 · 정상 종료·정지는 안 남김 · `end` 가
 *  exit 앞/뒤/안 옴(300ms)이어도 같은 결과 · 기다리는 사이 정지 요청이 오면 재기동 0 · 조각 경계·버퍼 경계에 걸친 비밀이 새지 않음.
 *  그리고 데몬 쪽 — stderr 쓰기 오류가 데몬을 끝내지 않는다(감독자만 죽으면 읽는 쪽이 사라진다, 직접 기동은 감독자를 아무도 안 되살린다).
 *
 * 등급: **동작** — 실제 `runSupervise` 본문(OS 경계만 주입) · 실제 자식 node 1회(없는 패키지 import) · 실제 `initFileLogging()` 을 자식에서.
 *  Windows 의 실제 파이프·conhost 아래 모양은 여기서 못 잰다(인계).
 */
import { spawn as realSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsxLoaderUrl } from "./_probe-helpers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRET = `sk-${"fixture".repeat(2)}-${"9".repeat(18)}`; // 토큰 «모양» 리터럴을 소스에 두지 않는다(시크릿 게이트) — 조립한다

type Logged = { lines: string[]; exited: number[]; throttled: number[]; spawned: number; respawn: (() => void) | null; stop: (() => void) | null };

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const src = fs.readFileSync(path.join(REPO, "bin/daemon.mjs"), "utf8");
  const d = (await import(new URL("../../../bin/daemon.mjs", import.meta.url).href)) as {
    stderrMaskEnv: (env: NodeJS.ProcessEnv, dirs: string[]) => NodeJS.ProcessEnv;
    maskedStderrTail: (raw: string, cut: boolean, env: NodeJS.ProcessEnv, keep?: number) => string;
    winLaunchEnv: unknown; WIN_SERVICE_ENV_KEYS: string[]; winSupervisorIsDuplicate: unknown;
  };
  const supSrc = src.slice(src.indexOf("const runSupervise = (c) => {"), src.indexOf("\n};\n", src.indexOf("const runSupervise = (c) => {")) + 3);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tigu-sup-stderr-"));
  try {
    const c = { homeAbs: tmp, homeRaw: tmp, repoRoot: tmp, label: "L", runtime: "built", logsDir: path.join(tmp, "logs"), launchEnv: undefined };

    /** 실제 runSupervise 를 돈다 — spawn 만 갈아끼운다. 데몬 하나가 뜰 때마다 `child` 를 넘긴다. */
    const supervise = (spawnFn: (...a: unknown[]) => unknown, exec: string[] = ["node", "x"]) => {
      const L: Logged = { lines: [], exited: [], throttled: [], spawned: 0, respawn: null, stop: null };
      const fakeProcess = {
        platform: "linux", pid: 1, env: { API_KEY: SECRET, PATH: "/bin" },
        on: (ev: string, fn: () => void) => { if (ev === "SIGTERM") L.stop = fn; },
        exit: (code: number) => { L.exited.push(code); },
        stdout: { write: () => true }, stderr: { on: () => {}, write: () => true },
      };
      const timer = (fn: () => void, ms: number) => { if (ms === 300) return setTimeout(fn, ms); L.throttled.push(ms); L.respawn = fn; return 0; };
      new Function("process", "spawn", "mkdirSync", "appendFileSync", "path", "execStrings", "winLaunchEnv", "WIN_SERVICE_ENV_KEYS", "Date", "setTimeout",
        "spawnSync", "winSupervisorQueryArgs", "winSupervisorIsDuplicate", "statSync", "writeFileSync", "net", "winSupervisorPipeName", "activeUpdateLock",
        "stderrMaskEnv", "maskedStderrTail", supSrc + "; return runSupervise;")(
        fakeProcess, (...a: unknown[]) => { L.spawned += 1; return spawnFn(...a); }, () => {}, (_p: string, line: string) => { L.lines.push(line); }, path, () => exec,
        d.winLaunchEnv, d.WIN_SERVICE_ENV_KEYS, Date, timer, () => ({ stdout: "" }), () => [], d.winSupervisorIsDuplicate, () => ({ mtimeMs: 0 }), () => {},
        {}, () => "pipe", () => null, d.stderrMaskEnv, d.maskedStderrTail,
      )(c);
      return L;
    };
    /** 가짜 자식 — stderr 는 진짜 스트림, 종료 순서는 시험이 정한다. */
    const fakeChild = () => {
      const ch = Object.assign(new EventEmitter(), { pid: 42, stderr: new PassThrough(), kill: () => {} });
      return ch;
    };
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const text = (L: Logged) => L.lines.join("");

    // ① end 가 exit 앞 — 원인이 가려진 채 남는다 · 되풀이는 한 줄
    {
      const kids: ReturnType<typeof fakeChild>[] = [];
      const L = supervise(() => { const k = fakeChild(); kids.push(k); return k; });
      const boom = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/claude-agent-sdk' imported from x.js\n  key=${SECRET}\n  token=opaque${"x".repeat(12)}\n`;
      const k1 = kids[0]!;
      // 비밀을 두 조각에 걸쳐 쓴다 — 조각 경계에서도 가려져야 한다
      k1.stderr.write(boom.slice(0, boom.indexOf(SECRET) + 6)); k1.stderr.write(boom.slice(boom.indexOf(SECRET) + 6)); k1.stderr.end();
      await settle(20);
      k1.emit("exit", 1, null);
      await settle(20);
      const first = text(L);
      L.respawn?.();
      const k2 = kids[1]!;
      k2.stderr.write(boom); k2.stderr.end(); await settle(20); k2.emit("exit", 1, null); await settle(20);
      const second = text(L).slice(first.length);
      out.push(assert(
        "★비정상 종료: stderr 끝부분이 감독자 로그에 — 원인 줄 보존 · 조각 경계의 비밀·token= 값 가림 · 되풀이는 크래시 줄에 한마디만",
        /daemon stderr before exit/.test(first) && /ERR_MODULE_NOT_FOUND/.test(first) && !first.includes(SECRET) && !first.includes(`opaque${"x".repeat(12)}`) &&
          /stderr same as before \(2 in a row\)/.test(second) && !/daemon stderr before exit/.test(second) && L.throttled.length === 2,
        { first: first.slice(0, 400), second: second.slice(0, 300), throttled: L.throttled },
      ));
    }
    // ② end 가 exit 뒤 · ③ end 가 안 옴(후손이 stderr 를 쥐었다) — 300ms 안에 끝내고 받은 만큼 남긴다
    {
      const kids: ReturnType<typeof fakeChild>[] = [];
      const L = supervise(() => { const k = fakeChild(); kids.push(k); return k; });
      const k1 = kids[0]!;
      k1.emit("exit", 1, null);
      k1.stderr.write("late: SyntaxError in boot module\n"); k1.stderr.end();
      await settle(60);
      const after = text(L);
      L.respawn?.();
      const k2 = kids[1]!;
      k2.stderr.write("held: descendant keeps the pipe\n");
      await settle(10);
      const t0 = Date.now();
      k2.emit("exit", 3, null);
      while (L.throttled.length < 2 && Date.now() - t0 < 2000) await settle(20);
      const waited = Date.now() - t0;
      out.push(assert(
        "★end 가 exit 뒤에 와도 · 안 와도(300ms 에 끝) 받은 만큼 남기고 종전대로 재기동 판단",
        /late: SyntaxError/.test(after) && /held: descendant/.test(text(L)) && L.throttled.length === 2 && waited >= 250 && waited < 1500,
        { after: after.slice(0, 200), waited, throttled: L.throttled },
      ));
    }
    // ④ 기다리는 사이 정지 요청 → 재기동 0 · ⑤ 정상 종료 → 남길 것 없음
    {
      const kids: ReturnType<typeof fakeChild>[] = [];
      const L = supervise(() => { const k = fakeChild(); kids.push(k); return k; });
      kids[0]!.stderr.write("dying\n");
      kids[0]!.emit("exit", 1, null);
      L.stop?.();
      await settle(400);
      const stopped = { exited: [...L.exited], throttled: L.throttled.length, spawned: L.spawned };
      const L2 = supervise(() => { const k = fakeChild(); kids.push(k); return k; });
      const k = kids[kids.length - 1]!;
      k.stderr.write("normal shutdown noise\n"); k.stderr.end(); await settle(10); k.emit("exit", 0, null); await settle(20);
      out.push(assert(
        "★기다리는 사이 정지 요청이 오면 재기동하지 않는다 · 정상 종료(code 0)는 stderr 를 남기지 않는다",
        stopped.exited.includes(0) && stopped.throttled === 0 && stopped.spawned === 1 && !/daemon stderr before exit/.test(text(L2)) && L2.throttled.length === 1,
        { stopped, normal: text(L2).slice(0, 200) },
      ));
    }
    // ⑥ 버퍼 앞이 잘렸을 때 — 잘린 비밀 꼬리·잘린 token= 꼬리가 새지 않는다(가린 뒤 자른다)
    {
      const env = { API_KEY: SECRET };
      const tailOfSecret = SECRET.slice(SECRET.length - 16);
      // 실제로 앞이 잘리는 건 버퍼가 4,096+8,192자를 넘었을 때다 — 그만큼 긴 입력으로(짧으면 앞머리 버리기에 다 먹힌다).
      const filler = `${"y".repeat(99)}\n`.repeat(20);
      const cutSecret = d.maskedStderrTail(`${tailOfSecret} after\n${filler}end line`, true, env, 4096);
      const cutToken = d.maskedStderrTail(`en=${"q".repeat(40)} rest\n${filler}keep this line\n`, true, {}, 4096);
      const full = d.maskedStderrTail(`${"z".repeat(5000)}\nkey ${SECRET}\nlast`, false, env, 4096);
      const longSecret = "L".repeat(600);
      const longCut = d.maskedStderrTail(`${longSecret.slice(300)} x\n${"w ".repeat(400)}\nend`, true, { MY_TOKEN: longSecret }, 4096);
      out.push(assert(
        "★잘린 앞머리는 버린다(가장 긴 비밀 길이 + 첫 공백까지) · 온전한 비밀은 가린 뒤 끝 4,096자",
        !cutSecret.includes(tailOfSecret) && /end line/.test(cutSecret) && !cutToken.includes("q".repeat(20)) && /keep this line/.test(cutToken) &&
          full.length <= 4096 && !full.includes(SECRET) && /\[REDACTED\]/.test(full) && /last$/.test(full) && !longCut.includes("L".repeat(50)),
        { cutSecret: cutSecret.slice(0, 80), cutToken: cutToken.slice(0, 80), fullTail: full.slice(-40), longCut: longCut.slice(0, 60) },
      ));
    }
    // ⑦ 홈·레포 .env 의 비밀도 가린다(데몬이 직접 읽어 감독자 env 엔 없다)
    {
      const dir = fs.mkdtempSync(path.join(tmp, "envdir-"));
      fs.writeFileSync(path.join(dir, ".env"), `HTTP_BRIDGE_TOKEN=${SECRET}x\nPLAIN=visible-value\n`);
      const env = d.stderrMaskEnv({ PATH: "/bin" }, [dir, path.join(tmp, "no-such")]);
      const masked = d.maskedStderrTail(`boom ${SECRET}x and visible-value`, false, env);
      out.push(assert("홈·레포 .env 의 비밀류 값도 가린다 · 비밀 아닌 값은 그대로", !masked.includes(SECRET) && masked.includes("visible-value"), masked));
    }
    // ⑧ 실제 자식 node — 없는 패키지를 import 하고 죽는다. 진짜 파이프로 원인이 들어오는가
    {
      const bad = path.join(tmp, "boot-fails.mjs");
      fs.writeFileSync(bad, 'import x from "tiguclaw-no-such-package-zz";\nconsole.log(x);\n');
      const L = supervise((exe: unknown, args: unknown, o: unknown) => realSpawn(exe as string, args as string[], o as object), [process.execPath, bad]);
      const t0 = Date.now();
      while (L.throttled.length === 0 && Date.now() - t0 < 10_000) await settle(50);
      out.push(assert(
        "★실제 자식 node 가 import 단계에서 죽으면 ERR_MODULE_NOT_FOUND 가 감독자 로그에 남는다(맥 파이프 — Windows 는 인계)",
        /ERR_MODULE_NOT_FOUND/.test(text(L)) && /tiguclaw-no-such-package-zz/.test(text(L)) && L.throttled.length === 1,
        text(L).slice(0, 500),
      ));
    }
    // ⑨ 데몬 쪽 그물 — 실제 initFileLogging() 을 부른 자식에서 stderr 쓰기 오류가 나도 최후 그물(uncaughtException → exit)에 안 걸린다
    {
      const home = fs.mkdtempSync(path.join(tmp, "home-"));
      // import 지정자는 URL 이다 — Windows 절대경로(`C:\…`)를 그대로 넣으면 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 로 제품에 닿기 전에 죽는다(Windows 실측 10-30).
      const logging = pathToFileURL(path.join(REPO, "src/core/logging.ts")).href;
      const script = [
        `import { initFileLogging } from ${JSON.stringify(logging)};`,
        "initFileLogging();",
        'process.on("uncaughtException", () => process.exit(7));',
        'const e = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });',
        'process.stderr.emit("error", e);',
        "setTimeout(() => process.exit(0), 50);",
      ].join("\n");
      const file = path.join(tmp, "stderr-guard-child.mts");
      fs.writeFileSync(file, script);
      const r = spawnSync(process.execPath, ["--import", tsxLoaderUrl(REPO) ?? "tsx", file], {
        encoding: "utf8", timeout: 30_000, cwd: REPO,
        env: { PATH: process.env.PATH ?? "", TIGUCLAW_HOME: home, TIGUCLAW_DISABLE_ENV_FILE: "1" },
      });
      out.push(assert(
        "★데몬 stderr 쓰기 오류가 데몬을 끝내지 않는다 — 실제 initFileLogging() 의 그물(빼면 exit 7)",
        r.status === 0,
        { status: r.status, stderr: (r.stderr ?? "").slice(0, 300) },
      ));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "supervisor-keeps-boot-stderr",
  guards:
    "Windows 감독자 아래 데몬이 로거를 세우기 전(정적 import)에 죽으면 원인이 어디에도 안 남던 것 — 0.1초 exit 1 루프에 «exited after 0s» 뿐이었다",
  run,
};
