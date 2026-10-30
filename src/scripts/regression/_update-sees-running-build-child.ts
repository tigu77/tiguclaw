/**
 * `update-sees-running-build` 의 자식 — 실제 git 저장소에서 `runSelfUpdate` 를 분기마다 돌리고 결과를 JSON 한 줄로 낸다.
 *
 * ★자식인 이유: 성공 경로는 재시작을 예약한 채 업데이트 잠금을 **죽을 때까지** 쥔다(self-update.ts finally) — 러너 안에서 돌리면
 *  뒤의 다른 검사가 «진행 중» 을 받는다. PATH(npm·rg 대역)·`TIGUCLAW_RUNTIME` 을 바꾸는 것도 이 프로세스 안에 가둔다.
 * ★외부로 안 나간다: npm 은 대역(호출만 기록), rg 는 대역(`--version` 만), tsc 는 저장소 안 가짜, git 원격은 로컬 bare.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPaths } from "../../core/paths.js";
import { BUILD_COMMIT_FILE, UPDATE_COMPLETE_MARKER, runSelfUpdate } from "../../core/self-update.js";
import { translate } from "../../core/i18n.js";

const NO_SUPERVISOR_KEY = "srv.update.err.staleNoSupervisor";

const REPO = path.resolve(import.meta.dirname, "../../..");
const root = mkdtempSync(path.join(os.tmpdir(), "upd-running-build-"));
let cleanupLinks: string[] = [];
const g = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

try {
  // ── 대역 ──
  const shim = path.join(root, "shim");
  mkdirSync(shim);
  const npmLog = path.join(root, "npm.log");
  const tscLog = path.join(root, "tsc.log");
  writeFileSync(path.join(shim, "npm"), `#!/bin/sh\necho "$*" >> "${npmLog}"\n[ "$NPM_MODE" = fail ] && exit 97\nexit 0\n`);
  writeFileSync(path.join(shim, "rg"), "#!/bin/sh\necho 'ripgrep 14.1.0'\n");
  for (const f of ["npm", "rg"]) chmodSync(path.join(shim, f), 0o755);
  process.env.PATH = `${shim}${path.delimiter}${process.env.PATH ?? ""}`;

  // ── 저장소: c0(옛) → h(지금), 원격과 같다(받을 커밋 없음) ──
  const origin = path.join(root, "origin.git");
  const app = path.join(root, "app");
  g(["init", "-q", "--bare", "-b", "main", origin], root);
  g(["clone", "-q", origin, app], root);
  g(["config", "user.email", "r@r.invalid"], app);
  g(["config", "user.name", "r"], app);
  writeFileSync(path.join(app, ".gitignore"), "dist/\nnode_modules/\nbin/\n.dist-*\n");
  writeFileSync(path.join(app, "a.txt"), "0\n");
  mkdirSync(path.join(app, "plugins", "p"), { recursive: true });
  writeFileSync(path.join(app, "plugins", "p", "package.json"), "{}\n");
  g(["add", "-A"], app);
  g(["commit", "-q", "-m", "c0"], app);
  const c0 = g(["rev-parse", "HEAD"], app);
  writeFileSync(path.join(app, "a.txt"), "1\n");
  g(["commit", "-q", "-am", "h"], app);
  g(["push", "-q", "-u", "origin", "main"], app);
  const h = g(["rev-parse", "HEAD"], app);

  // ── 빌드 도구: 진짜 기록 스크립트 + 가짜 tsc(모드로 emit 여부) + native 검사 대역 ──
  mkdirSync(path.join(app, "bin"), { recursive: true });
  copyFileSync(path.join(REPO, "bin", "copy-dist-assets.mjs"), path.join(app, "bin", "copy-dist-assets.mjs"));
  writeFileSync(path.join(app, "bin", "check-native.cjs"), "process.exit(process.env.FAKE_NATIVE === 'fail' ? 1 : 0);\n");
  const tscDir = path.join(app, "node_modules", "typescript", "bin");
  mkdirSync(tscDir, { recursive: true });
  writeFileSync(
    path.join(tscDir, "tsc"),
    `const fs = require("fs"); const path = require("path"); const a = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(tscLog)}, a.join(" ") + "\\n");\n` +
      `if (a.includes("--noEmit")) process.exit(0);\n` +
      `const out = a[a.indexOf("--outDir") + 1];\n` +
      `if (process.env.FAKE_TSC === "emit") { fs.mkdirSync(path.join(out, "src"), { recursive: true }); fs.writeFileSync(path.join(out, "src", "index.js"), "// built\\n"); process.exit(0); }\n` +
      `process.exit(2);\n`,
  );

  const dist = path.join(app, "dist");
  const setDisk = (sha: string | null): void => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "old.js"), "// 돌고 있던 빌드\n");
    if (sha === null) rmSync(path.join(dist, BUILD_COMMIT_FILE), { force: true });
    else writeFileSync(path.join(dist, BUILD_COMMIT_FILE), `${sha}\n`);
  };
  const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
  const marker = path.join(getPaths().home, UPDATE_COMPLETE_MARKER);

  type Spec = {
    name: string;
    runtime: "built" | "source";
    running?: string | null; // 생략 = 부팅 기록(이 자식은 소스로 돈다 → 판정 대상 아님)
    disk: string | null;
    npm?: "ok" | "fail";
    tsc?: "emit" | "none";
    native?: "fail";
    dirty?: boolean;
    /** 이 프로세스를 KeepAlive 서비스가 관리하는가(주입). 생략 = 참 — 분기 사례는 감독자 있는 경로를 잰다. */
    keepAlive?: boolean;
    /** 원격에 새 커밋을 올린 뒤 부른다(HEAD 가 움직이는 정상 업데이트). */
    pullNew?: boolean;
  };
  // ripgrep 확보 시도 — ensureRipgrepBestEffort 가 남기는 로그 줄로 센다(최신 경로·안내 경로 둘 다 돌아야 한다).
  const rgLines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (/ripgrep/i.test(line)) rgLines.push(line);
    origLog(...a);
  };
  const run = async (s: Spec): Promise<Record<string, unknown>> => {
    rmSync(npmLog, { force: true });
    rmSync(tscLog, { force: true });
    rmSync(marker, { force: true });
    setDisk(s.disk);
    process.env.TIGUCLAW_RUNTIME = s.runtime;
    process.env.NPM_MODE = s.npm ?? "ok";
    process.env.FAKE_TSC = s.tsc ?? "none";
    if (s.native !== undefined) process.env.FAKE_NATIVE = s.native;
    else delete process.env.FAKE_NATIVE;
    if (s.dirty === true) writeFileSync(path.join(app, "a.txt"), "user edit\n");
    if (s.pullNew === true) {
      const pusher = path.join(root, `pusher-${s.name}`);
      g(["clone", "-q", origin, pusher], root);
      g(["config", "user.email", "r@r.invalid"], pusher);
      g(["config", "user.name", "r"], pusher);
      writeFileSync(path.join(pusher, "a.txt"), "2\n");
      g(["commit", "-q", "-am", "next"], pusher);
      g(["push", "-q", "origin", "main"], pusher);
    }
    rgLines.length = 0;
    let restarted = 0;
    const r = await runSelfUpdate({
      cwd: app,
      restart: () => {
        restarted++;
        return true;
      },
      restartDelayMs: 10,
      ...(s.running !== undefined ? { runningBuild: s.running } : {}),
      keepAlive: s.keepAlive ?? true,
    });
    await new Promise((res) => setTimeout(res, 150));
    const out = {
      name: s.name,
      status: r.status,
      from: r.from,
      to: r.to,
      changedFiles: r.changedFiles,
      rolledBack: r.rolledBack,
      error: (r.error ?? "").slice(0, 160),
      restarted,
      npm: lines(npmLog),
      tsc: lines(tscLog),
      head: g(["rev-parse", "HEAD"], app),
      diskStamp: existsSync(path.join(dist, BUILD_COMMIT_FILE)) ? readFileSync(path.join(dist, BUILD_COMMIT_FILE), "utf8").trim() : null,
      oldKept: existsSync(path.join(dist, "old.js")),
      newEntry: existsSync(path.join(dist, "src", "index.js")),
      leftovers: readdirSync(app).filter((n) => n.startsWith(".dist-")),
      userEdit: readFileSync(path.join(app, "a.txt"), "utf8"),
      marker: existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>) : null,
      noSupervisor: r.error === translate(NO_SUPERVISOR_KEY),
      ripgrep: rgLines.length,
    };
    // 원격을 되돌린다 — 뒤 사례는 «받을 커밋 없음» 이어야 한다(실패 경로가 HEAD 를 이미 pull 전으로 되돌렸다).
    if (s.pullNew === true) g(["push", "-q", "-f", "origin", `${h}:main`], app);
    if (s.dirty === true) g(["checkout", "-q", "--", "a.txt"], app);
    rmSync(marker, { force: true });
    return out;
  };

  const results: Record<string, unknown>[] = [];
  // 성공(잠금을 쥔 채 끝난다)은 반드시 마지막.
  for (const s of [
    { name: "latest", runtime: "built", running: h, disk: h },
    { name: "source-runtime", runtime: "source", running: c0, disk: c0 },
    { name: "boot-from-source", runtime: "built", disk: c0 },
    { name: "dirty", runtime: "built", running: c0, disk: c0, dirty: true },
    { name: "install-fails", runtime: "built", running: c0, disk: h, npm: "fail" },
    { name: "native-fails", runtime: "built", running: null, disk: h, native: "fail" },
    { name: "disk-stale-rebuild-fails", runtime: "built", running: h, disk: null, tsc: "none" },
    // ★감독자가 측정되지 않으면(R2) 새 갈래는 아무것도 바꾸지 않는다 — 종전처럼 살아 있으면서 안내만.
    { name: "running-stale-unsupervised", runtime: "built", running: c0, disk: c0, tsc: "emit", keepAlive: false },
    { name: "disk-stale-unsupervised", runtime: "built", running: h, disk: null, tsc: "emit", keepAlive: false },
    { name: "latest-unsupervised", runtime: "built", running: h, disk: h, keepAlive: false },
    // 범위 밖 확인: HEAD 가 움직이는 정상 업데이트는 측정과 무관하게 종전 계약(재빌드로 간다 — 여기선 빌드 실패로 롤백).
    { name: "pull-unsupervised", runtime: "built", running: h, disk: h, tsc: "none", keepAlive: false, pullNew: true },
    { name: "running-stale-success", runtime: "built", running: c0, disk: c0, tsc: "emit" },
  ] satisfies Spec[]) {
    results.push(await run(s));
  }

  // ── 실제 built 배치에서 **부팅 기록**을 읽는가 — 주입 없이 (2026-10-30 GPT 검토 R1) ──
  //  위 사례는 전부 `runningBuild` 를 주입한다. 여기서는 빌드 산출물처럼 놓인 모듈(appRoot = <repo>/dist ≠ sourceRoot)을
  //  그대로 싣는다 — 실린 순간의 기록이 «돌고 있는 빌드» 이고, 그 뒤 디스크가 바뀌어도 그 값이어야 한다.
  const borigin = path.join(root, "borigin.git");
  const seed = path.join(root, "bseed");
  g(["init", "-q", "--bare", "-b", "main", borigin], root);
  g(["clone", "-q", borigin, seed], root);
  g(["config", "user.email", "r@r.invalid"], seed);
  g(["config", "user.name", "r"], seed);
  writeFileSync(path.join(seed, ".gitignore"), "dist/\nnode_modules\ntsconfig.build.json\n");
  writeFileSync(path.join(seed, "a.txt"), "0\n");
  g(["add", "-A"], seed);
  g(["commit", "-q", "-m", "b0"], seed);
  const b0 = g(["rev-parse", "HEAD"], seed);
  writeFileSync(path.join(seed, "a.txt"), "1\n");
  g(["commit", "-q", "-am", "bh"], seed);
  g(["push", "-q", "-u", "origin", "main"], seed);
  const bh = g(["rev-parse", "HEAD"], seed);
  // 산출물 배치 하나 = 원격과 같은 클론 + <클론>/dist/{src,plugins,SYSTEM.md} + <클론>/tsconfig.build.json(소스 루트 표식).
  //  코드는 소스 사본(tsx 가 싣는다 — `src/scripts` 제외), 의존성은 원본 node_modules 로의 링크 하나(읽기만 — npm 은 위 대역이 막는다).
  //  ★부팅마다 **다른 경로**에 둔다 — 같은 파일을 다시 import 하면 모듈 캐시가 첫 부팅을 돌려준다(쿼리 문자열로도 안 갈린다).
  const links: string[] = [];
  const layoutWith = (name: string, stamp: string): { dir: string; art: string; modUrl: string } => {
    const dir = path.join(root, name);
    g(["clone", "-q", borigin, dir], root);
    const art = path.join(dir, "dist");
    cpSync(path.join(REPO, "src"), path.join(art, "src"), {
      recursive: true,
      filter: (s) => s !== path.join(REPO, "src", "scripts"),
    });
    mkdirSync(path.join(art, "plugins"), { recursive: true });
    writeFileSync(path.join(art, "SYSTEM.md"), "\n");
    cpSync(path.join(REPO, "locales"), path.join(art, "locales"), { recursive: true });
    writeFileSync(path.join(dir, "tsconfig.build.json"), "{}\n");
    symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
    links.push(path.join(dir, "node_modules"));
    writeFileSync(path.join(art, BUILD_COMMIT_FILE), `${stamp}\n`);
    return { dir, art, modUrl: pathToFileURL(path.join(art, "src", "core", "self-update.ts")).href };
  };
  cleanupLinks = links;
  // measure = 감독자 여부도 주입하지 않는다 — 이 자식은 launchd 작업이 아니므로 측정은 거짓이어야 한다(리눅스는 측정 수단 없음 = 거짓).
  const bootRun = async (m: { runSelfUpdate: typeof runSelfUpdate }, layout: string, measure = false): Promise<Record<string, unknown>> => {
    rmSync(npmLog, { force: true });
    rmSync(marker, { force: true });
    process.env.TIGUCLAW_RUNTIME = "built";
    process.env.NPM_MODE = "fail";
    let restarted = 0;
    const r = await m.runSelfUpdate({
      cwd: layout,
      restart: () => { restarted++; return true; },
      restartDelayMs: 10,
      ...(measure ? {} : { keepAlive: true }),
    });
    await new Promise((res) => setTimeout(res, 100));
    rmSync(marker, { force: true });
    return {
      status: r.status, from: r.from, to: r.to, restarted, npm: lines(npmLog), head: g(["rev-parse", "HEAD"], layout),
      noSupervisor: r.error === translate(NO_SUPERVISOR_KEY),
    };
  };
  // ① 옛 빌드(b0)로 부팅 → 부팅 **뒤에** 디스크 기록만 HEAD 로 — 돌고 있는 것은 여전히 b0 다.
  const stale = layoutWith("built-stale", b0);
  const booted = (await import(stale.modUrl)) as { runSelfUpdate: typeof runSelfUpdate };
  writeFileSync(path.join(stale.art, BUILD_COMMIT_FILE), `${bh}\n`);
  const bootStale = await bootRun(booted, stale.dir);
  // ①′ 같은 프로세스·같은 상태에서 감독자도 **측정**한다(주입 0) — 이 자식은 KeepAlive 작업이 아니다 → 아무것도 안 바꾼다.
  const bootUnmeasured = await bootRun(booted, stale.dir, true);
  // ② HEAD 빌드로 부팅 — 실행 = 디스크 = HEAD.
  const fresh = layoutWith("built-fresh", bh);
  const freshMod = (await import(fresh.modUrl)) as { runSelfUpdate: typeof runSelfUpdate };
  const bootFresh = await bootRun(freshMod, fresh.dir);
  // ③ 빌드로 도는데 부팅 때 기록이 **없다**(git 을 못 읽은 빌드 · tsc 가 실패한 in-place 빌드 뒤 재시작) — 모르는 것이니 «최신» 이 아니다.
  const blank = layoutWith("built-unstamped", bh);
  rmSync(path.join(blank.art, BUILD_COMMIT_FILE), { force: true });
  const blankMod = (await import(blank.modUrl)) as { runSelfUpdate: typeof runSelfUpdate };
  const bootBlank = await bootRun(blankMod, blank.dir);
  console.log = origLog;
  console.log(JSON.stringify({ c0, h, results, b0, bh, bootStale, bootUnmeasured, bootFresh, bootBlank }));
} finally {
  // 링크는 링크만 먼저 뗀다 — 너머(원본 node_modules)는 건드리지 않는다.
  for (const l of cleanupLinks) {
    try {
      unlinkSync(l);
    } catch {
      /* 이미 없다 */
    }
  }
  rmSync(root, { recursive: true, force: true });
}
