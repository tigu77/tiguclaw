/**
 * Windows 시작 환경 · 업데이트 실패 경로. OS/네트워크/모델 부작용은 전부 fake, 파일은 임시 홈만.
 *
 * ★2026-10-05 적대 검토로 의미가 바뀌었다. 첫 판(`f9dbb846`)은 이 검사가 «처음 본 값을 영구히 붙잡는다» 를 지켰다 —
 *  PATH 를 저장하고(그 뒤 깐 git·python 을 못 찾음), `.env` 값을 저장본으로 복사해 VBS 로 심고(`.env` 를 고쳐도
 *  `/restart` 가 옛 값), lock 파일 드리프트를 사용자 편집으로 거절하고(업데이트 영구 거절), 위임 `/update` 가 pull 뒤에
 *  멈춰도 HEAD 를 그대로 뒀다(코드만 새것·빌드 옛것·다음 업데이트는 «최신»). 지금 지키는 것은 그 반대다.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateFailedText } from "../../core/self-update.js";
import { type Assertion, type RegressionCheck } from "./_framework.js";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const check: RegressionCheck = { guards: "Windows 업데이트 후 별도 인스턴스 환경 유실 · 저장본이 PATH·.env 를 영구 고정 · pull 뒤 고착 · lock 드리프트 영구 거절 · 거짓 실패 통지", name: "windows-update-environment", run: async () => {
  const checks: Assertion[] = [];
  const test = (name: string, fn: () => string | void) => {
    try { const got = fn(); checks.push({ name, ok: true, got: got ?? "확인" }); }
    catch (err) { checks.push({ name, ok: false, got: String(err) }); }
  };
  const daemonUrl = new URL("../../../bin/daemon.mjs", import.meta.url).href;
  const d: any = await import(daemonUrl);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tigu-win-update-"));
  try {
    // repoRoot 는 `.env` 없는 임시 폴더 — 개발 레포의 `.env` 를 읽으면 개발 기계와 공개 CI 에서 결과가 갈린다.
    const fakeRepo = fs.mkdtempSync(path.join(home, "repo-"));
    const c = { homeAbs: home, homeRaw: home, label: "inspection.7020", repoRoot: fakeRepo,
      nodePath: process.execPath, runtime: "built", logsDir: path.join(home, "logs"),
      distEntry: path.join(home, "dist-entry.js"), pidFile: path.join(home, "daemon.pid") };
    const savedFile = () => JSON.parse(fs.readFileSync(path.join(home, "win-service-env.json"), "utf8"));
    test("기본 인스턴스: 저장본 없는 홈은 환경을 덮지 않는다", () => {
      const env = { DASHBOARD_PORT: "7010", HTTP_BRIDGE_PORT: "7011" };
      d.applyWinServiceEnv(home, env); assert.deepEqual(env, { DASHBOARD_PORT: "7010", HTTP_BRIDGE_PORT: "7011" });
    });
    const env = { HTTP_BRIDGE_PORT: "7021", DASHBOARD_PORT: "7020", HTTP_BRIDGE_HOST: "127.0.0.1",
      USERPROFILE: "C:\\isolated profile", HOME: "C:\\isolated profile", APPDATA: "C:\\isolated profile\\AppData",
      CODEX_HOME: "C:\\isolated profile\\.codex", CLAUDE_CONFIG_DIR: "C:\\isolated profile\\.claude",
      PATH: "C:\\node24;C:\\npm;C:\\Windows",
      npm_config_userconfig: "C:\\empty.npmrc", npm_config_globalconfig: "C:\\empty-global.npmrc",
      HTTP_BRIDGE_TOKEN: "do-not-persist-test-token", CLAUDE_CODE_OAUTH_TOKEN: "do-not-persist-test-oauth",
      TIGUCLAW_UPDATE_PREV_SHA: "one-shot-sha", UNRELATED_VALUE: "not-persisted" };
    test("셸에서만 준 인스턴스 값(포트·프로필 폴더·npm 설정·라벨)은 붙잡고, 비밀·일회성·OS 프로필 값은 안 붙잡는다", () => {
      d.saveWinServiceEnv(c, env);
      const saved = savedFile();
      assert.equal(saved.TIGUCLAW_SERVICE_LABEL, c.label);
      for (const k of ["HTTP_BRIDGE_PORT", "DASHBOARD_PORT", "CODEX_HOME", "npm_config_userconfig"]) assert.equal(saved[k], (env as any)[k], k);
      // ★PATH·프로필은 Windows 가 예약작업 기동마다 새로 준다 — 붙잡으면 설치 순간에 굳는다.
      for (const k of ["PATH", "USERPROFILE", "HOME", "APPDATA", "HTTP_BRIDGE_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "TIGUCLAW_UPDATE_PREV_SHA", "UNRELATED_VALUE"]) assert.equal(saved[k], undefined, k);
      return Object.keys(saved).join(",");
    });
    test("★PATH 는 굳지 않는다 — 나중 기동의 PATH(그 뒤 깐 git·python 포함)가 그대로 간다", () => {
      const later = d.winLaunchEnv({ PATH: "C:\\node24;C:\\Git\\cmd;C:\\Python312;C:\\Windows" }, home);
      assert.equal(later.PATH, "C:\\node24;C:\\Git\\cmd;C:\\Python312;C:\\Windows");
      return later.PATH;
    });
    test("붙잡은 값은 기동 때 채워진다 — 단 지금 실행 환경이 준 값이 이긴다", () => {
      const fresh = d.winLaunchEnv({}, home);
      assert.equal(fresh.HTTP_BRIDGE_PORT, "7021"); assert.equal(fresh.CODEX_HOME, env.CODEX_HOME);
      const shell = d.winLaunchEnv({ HTTP_BRIDGE_PORT: "7031" }, home);
      assert.equal(shell.HTTP_BRIDGE_PORT, "7031");
      return `저장본 ${fresh.HTTP_BRIDGE_PORT} · 셸 ${shell.HTTP_BRIDGE_PORT}`;
    });
    test("★홈 .env 가 정본 — .env 에 적힌 키는 저장본이 덮지 않는다(.env 를 고친 뒤 /restart 가 새 값으로 뜬다)", () => {
      fs.writeFileSync(path.join(home, ".env"), "HTTP_BRIDGE_PORT=7029\nHTTP_BRIDGE_TOKEN=private-test-only\n");
      // 감독자는 기동마다 이걸 다시 계산한다 — 저장본의 7021 이 실려 가면 데몬의 .env 로드가 못 이긴다.
      const launch = d.winLaunchEnv({}, home);
      assert.equal(launch.HTTP_BRIDGE_PORT, undefined);
      // 다시 저장하면 .env 가 정한 키는 저장본에서 빠진다.
      d.saveWinServiceEnv(c, { ...env, HTTP_BRIDGE_PORT: "7021" });
      assert.equal(savedFile().HTTP_BRIDGE_PORT, undefined);
      return `기동 env 포트=${String(launch.HTTP_BRIDGE_PORT)} · 저장본 포트=${String(savedFile().HTTP_BRIDGE_PORT)}`;
    });
    test("레포 .env 에 있는 키도 붙잡지 않는다 — 데몬이 직접 읽고, 붙잡으면 그 파일에서 지워도 남는다", () => {
      fs.writeFileSync(path.join(fakeRepo, ".env"), "TZ=Asia/Seoul\n");
      try {
        d.saveWinServiceEnv(c, { ...env, TZ: "Asia/Seoul" });
        assert.equal(savedFile().TZ, undefined);
      } finally { fs.rmSync(path.join(fakeRepo, ".env")); }
    });
    test("저장본에 비밀·임의 키를 넣어도 기동 환경으로 안 새어 나간다", () => {
      const saved = savedFile(); saved.HTTP_BRIDGE_TOKEN = "injected-secret"; saved.NODE_OPTIONS = "--require evil";
      fs.writeFileSync(path.join(home, "win-service-env.json"), JSON.stringify(saved));
      const launch = d.winLaunchEnv({}, home);
      assert.equal(launch.HTTP_BRIDGE_TOKEN, undefined); assert.equal(launch.NODE_OPTIONS, undefined);
    });
    test("★예약작업 액션은 환경을 심지 않는다 — 심으면 그 값이 «실행 환경» 이 되어 홈 .env 를 이긴다", () => {
      const a = d.winTaskAction(c);
      assert.equal(a.execute, d.winConhostPath());
      assert(a.argument.startsWith("--headless ") && a.argument.includes("--home"), a.argument);
      assert(!/TOKEN|PATH=|\bset\b/i.test(a.argument), a.argument);
      // 값으로도 본다 — 키 이름 검사만으론 토큰 **값**을 덧붙이는 변이가 통과했다(적대 검토 G5).
      for (const v of ["do-not-persist-test-token", "do-not-persist-test-oauth", "private-test-only", "injected-secret"]) assert(!a.argument.includes(v), v);
      return "액션 = conhost --headless 감독자 · 환경 0";
    });
    test("손상된 저장본: 다른 기본 인스턴스로 fallback 금지(던진다)", () => {
      const file = path.join(home, "win-service-env.json"); const before = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, "{"); try { assert.throws(() => d.winLaunchEnv({}, home)); } finally { fs.writeFileSync(file, before); }
    });
    test("실패 로그 비밀 지우기", () => {
      const text = d.redactUpdateLog('opaque-test-secret Bearer abcdefghi https://user:password@example.test token=foo', { SOME_TOKEN: 'opaque-test-secret' });
      for (const secret of ['opaque-test-secret', 'abcdefghi', 'password', 'token=foo']) assert(!text.includes(secret));
    });

    // ── runUpdate 를 가짜 OS 경계 위에서 실제로 돈다 ─────────────────────────────────────────────
    const source = fs.readFileSync(path.join(repo, "bin/daemon.mjs"), "utf8");
    const body = source.slice(source.indexOf("const runUpdate = (c) => {"), source.indexOf("\n/**\n * @param {Ctx} c\n * @param {string} cmd", source.indexOf("const runUpdate = (c) => {")));
    type Scenario = "success" | "npm-fail" | "dirty" | "lock-only" | "rollback-dirty" | "corrupt-env" | "pull-fail";
    type SimOpts = { notify?: boolean; handoff?: string; resetFails?: boolean; stopFails?: boolean; revivedDuringCi?: boolean; platform?: "win32" | "darwin";
      // ★2026-10-29 — 포트와 무관한 존재 판정 · 의존성 트리 옮겨 두기. `deps` 를 주면 이 케이스만의 레포에 진짜 `node_modules` 를 만든다
      //  (tree = 폴더 · link = 다른 폴더를 가리키는 링크). fs 는 진짜이고, 실패만 골라 주입한다.
      presence?: "running" | "stopped" | "unknown"; portClosed?: boolean; registered?: boolean; deps?: "tree" | "link"; leftovers?: string[];
      ciFail?: (n: number) => boolean; buildFail?: (n: number) => boolean; statusFailFrom?: number;
      renameFail?: (from: string, to: string) => boolean; rmFail?: (p: string) => boolean;
      // ★진짜 `handlers` 표(소스에서)와 진짜 `winPresence` 로 돈다 — 스캔 결과만 준다(GPT 코드 검토 R1: 가짜 표에 presence 를 꽂으면 연결이 빠져도 초록).
      scan?: { targets: string[]; portDaemons: string[]; error?: string } };
    const handlersSrc = source.slice(source.indexOf("const handlers = {"), source.indexOf("\n};\n", source.indexOf("const handlers = {")) + 3);
    const presenceSrc = source.slice(source.indexOf("const winPresence = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winPresence = (c) => {")) + 3);
    const handlerNames = [...new Set([...handlersSrc.matchAll(/:\s*([a-z][A-Za-z]+),/g)].map((m) => m[1] as string))].filter((n) => n !== "undefined");
    const simulate = (scenario: Scenario, opts: SimOpts = {}) => {
      const h = fs.mkdtempSync(path.join(home, "case-")); fs.writeFileSync(path.join(h, "dist.js"), "ok");
      // 의존성 케이스는 자기 레포를 쓴다(공유 fakeRepo 에 node_modules 를 만들면 다른 케이스가 오염된다).
      const repoRoot = opts.deps !== undefined || opts.leftovers !== undefined ? path.join(h, "repo") : fakeRepo;
      const shared = path.join(h, "shared-deps");
      if (repoRoot !== fakeRepo) {
        fs.mkdirSync(repoRoot);
        for (const l of opts.leftovers ?? []) { fs.mkdirSync(path.join(repoRoot, l)); fs.writeFileSync(path.join(repoRoot, l, "marker.txt"), l); }
        if (opts.deps === "tree") { fs.mkdirSync(path.join(repoRoot, "node_modules", "sdk"), { recursive: true }); fs.writeFileSync(path.join(repoRoot, "node_modules", "sdk", "marker.txt"), "old-tree"); }
        if (opts.deps === "link") { fs.mkdirSync(path.join(shared, "sdk"), { recursive: true }); fs.writeFileSync(path.join(shared, "sdk", "marker.txt"), "shared-tree"); fs.symlinkSync(shared, path.join(repoRoot, "node_modules"), "dir"); }
      }
      const context = { ...c, repoRoot, homeAbs: h, logsDir: path.join(h, "logs"), distEntry: path.join(h, "dist.js"),
        ...(scenario === "corrupt-env" ? { winEnvError: "win-service-env.json is unreadable (fixture)" } : {}) };
      const nm = path.join(repoRoot, "node_modules");
      const short = (p: string) => path.basename(p).replace(/-\d+$/, "-N");
      const marker = path.join(h, ".update-failed");
      const calls: string[] = []; let rev = 0, status = 0, ci = 0, build = 0; let lockDirty = scenario === "lock-only";
      // 데몬이 떠 있나 — 멈추면 내려가고, `revivedDuringCi` 면 설치 도중 무언가가 다시 띄운다(2026-10-19 윈도우돌쇠 실측).
      let running = true;
      // «업데이트 중» 표식 — 종료 처리기는 모아 뒀다가 끝에 부른다(진짜 프로세스 종료를 흉내).
      const lockFile = path.join(h, ".update-in-progress"); const exitHandlers: (() => void)[] = [];
      const lockState = () => (fs.existsSync(lockFile) ? "lock" : "no-lock");
      const processFake = { platform: opts.platform ?? "win32", execPath: process.execPath, pid: process.pid, exitCode: 0, stdout: { write: () => {} },
        on: (ev: string, fn: () => void) => { if (ev === "exit") exitHandlers.push(fn); },
        env: { HTTP_BRIDGE_TOKEN: "opaque-fixture-secret", ...(opts.notify ? { TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "fixture" } : {}),
          ...(opts.handoff ? { TIGUCLAW_UPDATE_PREV_SHA: opts.handoff } : {}) } };
      const spawnSync = (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(" ")); let stdout = "", stderr = "", code = 0;
        if (cmd === "git" && args[0] === "rev-parse") stdout = ++rev === 1 ? "1111111" : "2222222";
        if (cmd === "git" && args[0] === "checkout" && args.includes("package-lock.json")) lockDirty = false;
        if (cmd === "git" && args[0] === "pull" && scenario === "pull-fail") { code = 1; stderr = "fixture: could not resolve host"; }
        if (cmd === "git" && args[0] === "reset" && opts.resetFails) { code = 1; stderr = "fixture: reset refused"; }
        if (cmd === "git" && args[0] === "status") {
          status++;
          if (lockDirty) stdout = " M package-lock.json\n";
          if (scenario === "dirty" || (scenario === "rollback-dirty" && status > 1)) stdout = " M src/edited.ts\n";
          if (opts.statusFailFrom !== undefined && status >= opts.statusFailFrom) { code = 128; stderr = "fixture: status failed"; }
        }
        if (cmd === "npm" && args[0] === "ci") {
          calls.push(`CI:${lockState()}`);
          if (opts.revivedDuringCi === true) running = true;
          ci++;
          const fails = opts.ciFail !== undefined ? opts.ciFail(ci) : scenario !== "success" && scenario !== "lock-only" && ci === 1;
          // 의존성 케이스: npm 은 그 자리에 트리를 만든다 — 실패면 반쯤(현장 모양: 일부만 남음), 성공이면 새 트리.
          if (opts.deps !== undefined) {
            if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) calls.push("CI-THROUGH-LINK");
            fs.mkdirSync(path.join(nm, "sdk"), { recursive: true });
            fs.writeFileSync(path.join(nm, "sdk", "marker.txt"), fails ? "partial" : `new-tree-${ci}`);
          }
          if (fails) { code = 1; stderr = "fixture npm EACCES opaque-fixture-secret"; }
        }
        if (cmd === "npm" && args[0] === "run" && args[1] === "build:prod") {
          build++;
          if (opts.buildFail?.(build) === true) { code = 1; stderr = "fixture: tsc failed"; }
        }
        return { status: code, stdout, stderr };
      };
      // 진짜 fs 위에 실패만 골라 넣는다 — 무엇을 옮기고 지웠는지 기록한다.
      const renameW = (a: string, b: string) => {
        if (opts.renameFail?.(a, b) === true) { calls.push(`MV-FAIL:${short(a)}>${short(b)}`); throw new Error(`EPERM: operation not permitted, rename '${short(a)}'`); }
        fs.renameSync(a, b); calls.push(`MV:${short(a)}>${short(b)}`);
      };
      const rmW = (p: string, o?: fs.RmOptions) => {
        if (path.basename(p).startsWith(".node_modules") || p === nm) { if (opts.rmFail?.(p) === true) { calls.push(`RM-FAIL:${short(p)}`); throw new Error("EBUSY fixture"); } calls.push(`RM:${short(p)}`); }
        fs.rmSync(p, o);
      };
      const unlinkW = (p: string) => {
        if (opts.rmFail?.(p) === true) { calls.push(`UNLINK-FAIL:${short(p)}`); throw new Error("EBUSY fixture"); }
        calls.push(`UNLINK:${short(p)}`); fs.unlinkSync(p);
      };
      const messages: string[] = []; const fakeConsole = { log: (...a: unknown[]) => messages.push(a.join(" ")), error: (...a: unknown[]) => messages.push(a.join(" ")), warn: (...a: unknown[]) => messages.push(a.join(" ")) };
      const fds: number[] = [];
      // ★`lstatSync`·`readdirSync`·`renameSync`·`unlinkSync`·`sleepSync` 를 **반드시** 넘긴다 — 안 넘기면 본문의 try/catch 가 ReferenceError 를
      //  삼켜 «node_modules 없음» 으로 조용히 통과한다(2026-10-29 실측: 넘기기 전에도 47건이 초록이었다).
      const names = ["process", "console", "path", "existsSync", "mkdirSync", "openSync", "writeSync", "writeFileSync", "spawnSync", "isDaemonRunning", "isRegistered", "handlers", "warnWinServiceToken", "saveWinServiceEnv", "redactUpdateLog", "rmSync", "updateLockPath",
        "lstatSync", "readdirSync", "renameSync", "unlinkSync", "sleepSync"];
      // 마커가 재가동 **전에** 있었나 — 다시 뜬 데몬이 부팅 때 읽어 통지한다.
      const startMark = (what: string) => () => calls.push(`${what}:${fs.existsSync(marker) ? "marker" : "no-marker"}`, `${what}@${lockState()}`);
      const presenceFake = opts.presence === undefined ? {} : { presence: () => { calls.push("PRESENCE"); return { state: opts.presence, pids: opts.presence === "running" ? ["777"] : [], why: "fixture: process list query failed" }; } };
      const ops = { stop: () => { calls.push("STOP"); if (opts.stopFails !== true) running = false; return opts.stopFails === true ? false : true; }, reenable: () => calls.push("REENABLE"), start: startMark("START"), restart: startMark("RESTART") };
      // 진짜 표: 표에 적힌 이름마다 가짜를 넣되 정지·기동은 위 기록기로, 존재 판정만 진짜 본문(스캔 결과 주입)으로.
      const realTable = () => {
        const winPresence = new Function("winScan", presenceSrc + "; return winPresence;")(() => { calls.push("SCAN"); return opts.scan; });
        const byName: Record<string, unknown> = { winStop: ops.stop, winReenable: ops.reenable, winStart: ops.start, winRestart: ops.restart, winPresence,
          darwinStop: ops.stop, darwinStart: ops.start, darwinRestart: ops.restart };
        return new Function(...handlerNames, handlersSrc + "; return handlers;")(...handlerNames.map((n) => byName[n] ?? (() => calls.push(`UNEXPECTED:${n}`))));
      };
      const table = opts.scan !== undefined ? realTable() : ((t: unknown) => ({ win32: t, darwin: t }))({ ...ops, ...presenceFake });
      const invoke = new Function(...names, body + "; return runUpdate;")(...[
        processFake, fakeConsole, path, fs.existsSync, fs.mkdirSync, (p: string, flags: string) => { const fd = fs.openSync(p, flags); fds.push(fd); return fd; }, fs.writeSync, fs.writeFileSync, spawnSync, () => running && opts.portClosed !== true, () => opts.registered !== false,
        table, () => {}, () => calls.push("SAVE_ENV"), (text: string) => d.redactUpdateLog(text, processFake.env),
        rmW, d.updateLockPath,
        fs.lstatSync, fs.readdirSync, renameW, unlinkW, () => {},
      ]);
      try { invoke(context); } finally { for (const fd of fds) fs.closeSync(fd); }
      const lockAfterRun = lockState(); for (const fn of exitHandlers) fn(); const lockAfterExit = lockState();
      const log = fs.readdirSync(path.join(h, "logs")).find((x) => x.startsWith("update-")); assert(log);
      const mk = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : undefined;
      const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return "(none)"; } };
      const markerIn = (dir: string) => (fs.existsSync(path.join(dir, "sdk", "marker.txt")) ? read(path.join(dir, "sdk", "marker.txt")) : read(path.join(dir, "marker.txt")));
      const entries = repoRoot === fakeRepo ? [] : fs.readdirSync(repoRoot).filter((x) => x.startsWith(".node_modules")).map((x) => ({ name: x.replace(/-\d+$/, "-N"), marker: markerIn(path.join(repoRoot, x)) }));
      const depsNow = repoRoot === fakeRepo ? "(n/a)" : read(path.join(nm, "sdk", "marker.txt"));
      const sharedNow = opts.deps === "link" ? { marker: read(path.join(shared, "sdk", "marker.txt")), files: fs.readdirSync(shared).join(",") } : undefined;
      return { calls, messages, exitCode: processFake.exitCode, log: fs.readFileSync(path.join(h, "logs", log), "utf8"), home: h, marker: mk, lockAfterRun, lockAfterExit, depsNow, entries, sharedNow, ci, build };
    };
    const has = (calls: string[], re: RegExp) => calls.some((x) => re.test(x));
    test("멈춘 뒤 실패(npm): stderr·단계 로그 보존·비밀 제거 · 되돌리고 «rolled-back» 마커를 재가동 **전에** 쓴다", () => {
      const r = simulate("npm-fail", { notify: true }); assert.equal(r.exitCode, 1); assert(r.log.includes("fixture npm EACCES")); assert(!r.log.includes("opaque-fixture-secret"));
      assert(r.calls.includes("git reset --keep 1111111")); assert(r.calls.includes("START:marker"), r.calls.join(" | "));
      assert.equal(r.marker?.outcome, "rolled-back");
      // ★롤백은 이전 판을 **다시 빌드**한다 — 실패한 빌드가 새 코드 .js 를 dist 에 남겼을 수 있다(재검토 P2).
      assert(r.calls.indexOf("npm run build:prod", r.calls.indexOf("git reset --keep 1111111")) > 0, r.calls.join(" | "));
      return `outcome=${r.marker?.outcome}`;
    });
    test("★데몬이 안 멈추면 설치 전에 그만둔다 — npm ci 0 · 받은 코드는 돌고 있는 빌드로 되돌림 · «unchanged» 마커 · 띄우지는 않되 예약작업은 다시 켠다", () => {
      // 2026-10-08 외부 검토 F2: 종전엔 stop 반환을 안 봐서 Windows 에서 데몬이 살아 있는 채로 npm ci 가 돌았다(파일 잠금).
      const r = simulate("success", { notify: true, stopFails: true });
      assert.equal(r.exitCode, 1); assert(r.calls.includes("STOP"));
      assert(!has(r.calls, /^npm /), r.calls.join(" | ")); assert(r.calls.includes("git reset --keep 1111111"), r.calls.join(" | "));
      assert(!has(r.calls, /^(START|RESTART)/), r.calls.join(" | ")); assert.equal(r.marker?.outcome, "unchanged");
      // ★stop 이 먼저 작업을 껐다 — 다시 안 켜면 남은 데몬이 죽은 뒤 영영 안 뜬다(2026-10-08 적대 검토 P1).
      assert(r.calls.includes("REENABLE"), r.calls.join(" | "));
      return `npm 0 · outcome=${r.marker?.outcome} · 작업 다시 켬`;
    });
    test("성공: lock 정리→pull→stop→npm→build→start, 완료 마커", () => {
      const r = simulate("success", { notify: true }); assert.equal(r.exitCode, 0); assert(r.calls.includes("npm run build:prod")); assert(has(r.calls, /^START/));
      assert(r.calls.indexOf("git pull --ff-only") < r.calls.indexOf("STOP"));
      assert(fs.existsSync(path.join(r.home, ".update-complete")));
    });
    test("★멈춰 둔 사이 데몬이 다시 떴으면(설치 도중 되살아남) 빌드 뒤 **재시작**한다 — start 는 «이미 실행 중» 이라 옛 빌드가 남는다(윈도우돌쇠 10-19 실측)", () => {
      const r = simulate("success", { revivedDuringCi: true });
      assert.equal(r.exitCode, 0, r.messages.join(" | ")); assert(has(r.calls, /^RESTART/), r.calls.join(" | ")); assert(!has(r.calls, /^START/), r.calls.join(" | "));
      assert(r.calls.findIndex((x) => /^RESTART/.test(x)) > r.calls.indexOf("npm run build:prod"), r.calls.join(" | "));
      assert(r.messages.some((m) => m.includes("came back while the update was running")), r.messages.join(" | "));
      const plain = simulate("success"); assert(has(plain.calls, /^START/) && !has(plain.calls, /^RESTART/), plain.calls.join(" | "));
      // 맥도 같은 공통 경로다 — `launchctl bootstrap` 이 «이미 적재됨» 이면 재시작하지 않으므로 같은 구멍이 있었다.
      const mac = simulate("success", { revivedDuringCi: true, platform: "darwin" }); assert(has(mac.calls, /^RESTART/) && !has(mac.calls, /^START/), mac.calls.join(" | "));
      return "되살아났으면 빌드 뒤 RESTART(윈도우·맥) · 아니면 START";
    });
    test("★«업데이트 중» 표식: 멈추기 전에 쓰고 설치 내내 있다 · 재가동 **전에** 지운다(성공·롤백·되살아남·정지 실패) · 종료 때도 지운다", () => {
      // 표식이 있는 동안 감독자는 데몬을 안 띄운다(windows-single-supervisor) — 남아 있으면 재가동이 아무것도 못 띄운다.
      const cases = { ok: simulate("success"), rollback: simulate("npm-fail"), revived: simulate("success", { revivedDuringCi: true }), stopFail: simulate("success", { stopFails: true }) };
      for (const [k, r] of Object.entries(cases)) {
        if (k !== "stopFail") assert(r.calls.includes("CI:lock"), `${k}: ${r.calls.join(" | ")}`);
        assert(!r.calls.some((x) => /^(START|RESTART)@lock$/.test(x)), `${k}: ${r.calls.join(" | ")}`);
        assert.equal(r.lockAfterRun, "no-lock", k);
      }
      assert(has(cases.ok.calls, /^START@no-lock$/) && has(cases.revived.calls, /^RESTART@no-lock$/), cases.ok.calls.join(" | "));
      // 어느 경로가 지우는 걸 잊어도 프로세스가 끝날 때 지워진다 — 표식이 남아 1시간 동안 데몬이 안 뜨는 일이 없게.
      const s = fs.readFileSync(path.join(repo, "bin/daemon.mjs"), "utf8");
      assert(/process\.on\("exit", \(\) => rmSync\(updateLockPath\(c\)/.test(s), "종료 처리기 없음");
      return "설치 중 표식 · 재가동 전 해제 4경로";
    });
    test("★요약 줄의 «Daemon resumed.» 는 실제로 다시 띄운 경로에서만 — 돌지 않던 홈(미등록 포함)은 «안 띄웠다» 고 말한다", () => {
      // 2026-10-29 Windows 현장(사용자 보고): 데몬 없는 시험 홈의 업데이트가 «not registered» 를 말한 뒤 마지막 줄에서 «Daemon resumed.» 로 뒤집었다.
      const last = (r: { messages: string[] }) => r.messages.filter((m) => /update complete/.test(m)).join(" | ");
      // 현장 모양 = 미등록 · 미가동(시험 라벨) — 그리고 등록됐지만 멈춰 있던 홈.
      for (const registered of [false, true]) {
        const idle = simulate("success", { presence: "stopped", portClosed: true, registered });
        const said = registered ? /was not running — start it with/ : /not registered — run 'tiguclaw install'/;
        assert.equal(idle.exitCode, 0); assert(!has(idle.calls, /^(START|RESTART)/), idle.calls.join(" | "));
        assert(idle.messages.some((m) => said.test(m)), `registered=${registered}: ${idle.messages.join(" | ")}`);
        assert(!/Daemon resumed/.test(last(idle)) && /was not running, so it was not started/.test(last(idle)), `registered=${registered}: ${last(idle)}`);
      }
      const resumed = simulate("success");
      assert(has(resumed.calls, /^START/) && /Daemon resumed\./.test(last(resumed)), last(resumed));
      return "미등록·미가동 / 등록·미가동 = «안 띄웠다» · 돌던 홈 = resumed";
    });
    test("★lock 파일만 바뀌었으면(우리 npm 이 다시 씀) 되돌리고 업데이트를 계속한다 — 거절하면 영영 업데이트가 안 된다", () => {
      const r = simulate("lock-only"); assert.equal(r.exitCode, 0, r.messages.join(" | "));
      assert(r.calls.indexOf("git checkout -- package-lock.json") < r.calls.indexOf("git pull --ff-only"));
      return `exit ${r.exitCode}`;
    });
    test("다른 추적 파일의 미커밋 변경: 멈추기 전에 중단 · 파일 이름을 댄다 · 위임이 아니면 HEAD 를 안 건드린다", () => {
      const r = simulate("dirty"); assert.equal(r.exitCode, 1); assert(!r.calls.includes("STOP")); assert(!has(r.calls, /reset|pull/));
      assert(r.messages.some((m) => m.includes("src/edited.ts")), r.messages.join(" | "));
    });
    test("★위임 /update 가 pull 뒤 사전 단계에서 멈추면 HEAD 를 되돌리고(코드=도는 빌드) 실패를 알리려 데몬을 다시 띄운다", () => {
      const r = simulate("dirty", { notify: true, handoff: "0000000" });
      assert.equal(r.exitCode, 1); assert(r.calls.includes("git reset --keep 0000000"), r.calls.join(" | "));
      assert(!r.calls.includes("STOP")); assert(r.calls.includes("RESTART:marker"), r.calls.join(" | "));
      assert.equal(r.marker?.outcome, "unchanged");
      return `outcome=${r.marker?.outcome}`;
    });
    test("업데이트 중 새 변경: 롤백 reset 은 생략(사용자 파일 보존) · «needs-check» 마커 · 데몬은 다시 띄운다", () => {
      const r = simulate("rollback-dirty", { notify: true }); assert.equal(r.exitCode, 1); assert(!has(r.calls, /git reset/));
      assert.equal(r.marker?.outcome, "needs-check"); assert(r.calls.includes("START:marker"), r.calls.join(" | "));
      return `outcome=${r.marker?.outcome}`;
    });
    // ── 2026-10-29: 포트와 무관한 존재 판정(A1) ─────────────────────────────────────────────────
    test("★포트가 닫혀 있어도 이 홈의 프로세스가 살아 있으면 멈추고 설치한다 · 조회가 실패하면 설치하지 않는다(npm 0·코드 되돌림·재가동 0) · 없으면 종전대로", () => {
      const alive = simulate("success", { presence: "running", portClosed: true });
      assert(alive.calls.includes("STOP") && alive.calls.indexOf("STOP") < alive.calls.findIndex((x) => /^CI:/.test(x)) && has(alive.calls, /^START/), alive.calls.join(" | "));
      const blind = simulate("success", { presence: "unknown", notify: true, portClosed: true });
      assert.equal(blind.exitCode, 1);
      assert(!blind.calls.includes("STOP") && !has(blind.calls, /^npm /) && !has(blind.calls, /^(START|RESTART)/), blind.calls.join(" | "));
      assert(blind.calls.includes("git reset --keep 1111111") && blind.marker?.outcome === "unchanged", `${blind.calls.join(" | ")} · ${JSON.stringify(blind.marker)}`);
      assert(blind.messages.some((m) => /could not check whether this instance's daemon is running/.test(m)), blind.messages.join(" | "));
      const gone = simulate("success", { presence: "stopped", portClosed: true });
      assert(!gone.calls.includes("STOP") && has(gone.calls, /^CI:/) && !has(gone.calls, /^(START|RESTART)/), gone.calls.join(" | "));
      // 맥·리눅스(존재 판정 없음)는 종전 그대로 — 포트만 본다
      const mac = simulate("success", { platform: "darwin" });
      assert(!mac.calls.includes("PRESENCE") && mac.calls.includes("STOP"), mac.calls.join(" | "));
      return "살아 있음=정지 후 설치 · 모름=설치 0 · 없음=정지 없이";
    });
    test("★진짜 handlers 표 + 진짜 winPresence: 포트 닫힘 + 이 홈 감독자 PID → 정지 후 설치 · 조회 실패 → 설치 0 · 아무것도 없음 → 정지 없이 · 맥 표엔 존재 판정 없음", () => {
      const alive = simulate("success", { scan: { targets: ["555"], portDaemons: [] }, portClosed: true });
      assert(alive.calls.includes("SCAN") && alive.calls.includes("STOP") && has(alive.calls, /^CI:/) && !has(alive.calls, /^UNEXPECTED/), alive.calls.join(" | "));
      assert(alive.messages.some((m) => /processes are running \(PID 555\)/.test(m)), alive.messages.join(" | "));
      const blind = simulate("success", { scan: { targets: [], portDaemons: [], error: "the process list query failed (exit 1: denied)" }, portClosed: true, notify: true });
      assert(!blind.calls.includes("STOP") && !has(blind.calls, /^npm /) && blind.marker?.outcome === "unchanged", blind.calls.join(" | "));
      assert(blind.messages.some((m) => /exit 1: denied/.test(m)), blind.messages.join(" | "));
      const none = simulate("success", { scan: { targets: [], portDaemons: [] }, portClosed: true });
      assert(none.calls.includes("SCAN") && !none.calls.includes("STOP") && has(none.calls, /^CI:/), none.calls.join(" | "));
      const mac = simulate("success", { scan: { targets: ["555"], portDaemons: [] }, platform: "darwin" });
      assert(!mac.calls.includes("SCAN") && mac.calls.includes("STOP"), mac.calls.join(" | "));
      return "표 연결 · 진짜 판정";
    });
    // ── 2026-10-29: 의존성 트리를 옮겨 두고 설치한다(A2) — fs 는 진짜 ─────────────────────────────
    test("★성공: 옛 트리를 옮겨 두고(npm 은 빈 자리에 깐다) · 재가동 **뒤** 버린다 · 남는 것 0", () => {
      const r = simulate("success", { deps: "tree" });
      assert.equal(r.exitCode, 0, r.messages.join(" | "));
      assert.equal(r.depsNow, "new-tree-1");
      const stash = r.calls.indexOf("MV:node_modules>.node_modules-prev-N");
      const ci = r.calls.findIndex((x) => /^CI:/.test(x));
      const start = r.calls.findIndex((x) => /^START/.test(x));
      const discard = r.calls.indexOf("MV:.node_modules-prev-N>.node_modules-discard-N");
      assert(stash >= 0 && stash > r.calls.indexOf("STOP") && stash < ci, r.calls.join(" | "));
      assert(discard > start && start > 0, `버리기는 재가동 뒤: ${r.calls.join(" | ")}`);
      assert.deepEqual(r.entries, [], JSON.stringify(r.entries));
      return "옮김 → 설치 → 재가동 → 버림";
    });
    test("★설치가 두 번 다 실패해도(현장 모양) 업데이트 직전 트리가 그대로 돌아온다 — 롤백 npm 없음 · rolled-back · 다시 띄움", () => {
      const r = simulate("npm-fail", { deps: "tree", notify: true, ciFail: () => true });
      assert.equal(r.depsNow, "old-tree"); assert.equal(r.ci, 1, `롤백이 npm ci 를 또 돌렸다: ${r.calls.join(" | ")}`);
      assert.equal(r.marker?.outcome, "rolled-back"); assert(r.calls.includes("START:marker"), r.calls.join(" | "));
      assert.deepEqual(r.entries.filter((e) => e.name.startsWith(".node_modules-prev")), [], JSON.stringify(r.entries));
      return `deps=${r.depsNow} · ci ${r.ci}회`;
    });
    test("★빌드·네이티브가 실패해도 옛 트리로 돌아온다(새 트리는 걷는다) · 이전 판 재빌드는 종전대로", () => {
      const r = simulate("success", { deps: "tree", notify: true, buildFail: (n) => n === 1 });
      assert.equal(r.depsNow, "old-tree"); assert.equal(r.ci, 1); assert.equal(r.build, 2, r.calls.join(" | "));
      assert.equal(r.marker?.outcome, "rolled-back");
      return `deps=${r.depsNow} · build ${r.build}회`;
    });
    test("★옛 트리를 옮기지 못하면(무언가 쥐고 있다) 설치하지 않는다 — npm·빌드 0 · 트리 그대로 · 코드 되돌림 · 다시 띄움", () => {
      const r = simulate("success", { deps: "tree", notify: true, renameFail: (_a, b) => b.includes(".node_modules-prev-") });
      assert.equal(r.exitCode, 1);
      assert(!has(r.calls, /^npm /), r.calls.join(" | ")); assert.equal(r.depsNow, "old-tree");
      assert(r.calls.filter((x) => /^MV-FAIL:node_modules>/.test(x)).length === 3, `세 번 시도: ${r.calls.join(" | ")}`);
      assert(r.calls.includes("git reset --keep 1111111") && r.marker?.stage === "dependencies" && r.marker?.outcome === "rolled-back", JSON.stringify(r.marker));
      assert(r.calls.includes("START:marker"), r.calls.join(" | "));
      return `npm 0 · outcome=${r.marker?.outcome}`;
    });
    test("★옛 트리를 되돌리지 못하면 «needs-check» · 업데이터는 안 띄움 · 옛 트리는 지우지 않고 경로를 말한다", () => {
      const r = simulate("npm-fail", { deps: "tree", notify: true, ciFail: () => true, renameFail: (a, b) => a.includes(".node_modules-prev-") && path.basename(b) === "node_modules" });
      assert.equal(r.marker?.outcome, "needs-check"); assert(!has(r.calls, /^(START|RESTART)/), r.calls.join(" | "));
      const kept = r.entries.find((e) => e.name === ".node_modules-prev-N");
      assert(kept?.marker === "old-tree", JSON.stringify(r.entries));
      assert(r.messages.some((m) => /could not put the previous dependencies back/.test(m) && /\.node_modules-prev-\d+/.test(m)), r.messages.join(" | "));
      assert(/previous dependencies kept at/.test(r.marker?.detail ?? ""), JSON.stringify(r.marker));
      return `outcome=${r.marker?.outcome} · 옛 트리 보존`;
    });
    test("★지난 업데이트가 남긴 것: «버릴 것» 만 지우고 «옮겨 둔 것(prev)» 은 남기며 알린다(유일하게 쓸 만한 트리일 수 있다)", () => {
      const r = simulate("success", { deps: "tree", leftovers: [".node_modules-discard-1", ".node_modules-prev-2"] });
      assert.equal(r.exitCode, 0, r.messages.join(" | "));
      assert.deepEqual(r.entries, [{ name: ".node_modules-prev-N", marker: ".node_modules-prev-2" }], JSON.stringify(r.entries));
      assert(r.messages.some((m) => /found .*\.node_modules-prev-2/.test(m)), r.messages.join(" | "));
      return "discard 지움 · prev 보존";
    });
    test("★node_modules 가 링크면 링크만 옮기고 지운다 — 링크 너머(다른 설치의 트리)엔 쓰기·삭제 0 · 지우기가 실패해도 너머에 표식을 안 쓴다", () => {
      const ok = simulate("success", { deps: "link" });
      assert(!ok.calls.includes("CI-THROUGH-LINK"), ok.calls.join(" | "));
      assert.deepEqual(ok.sharedNow, { marker: "shared-tree", files: "sdk" }); assert.equal(ok.depsNow, "new-tree-1");
      assert(ok.calls.includes("UNLINK:.node_modules-discard-N") && !ok.calls.some((x) => /^RM:\.node_modules-discard/.test(x)), ok.calls.join(" | "));
      const stuck = simulate("success", { deps: "link", rmFail: (p) => path.basename(p).startsWith(".node_modules-discard-") });
      assert.deepEqual(stuck.sharedNow, { marker: "shared-tree", files: "sdk" });
      assert(stuck.entries.some((e) => e.name === ".node_modules-discard-N"), JSON.stringify(stuck.entries));
      const fail = simulate("npm-fail", { deps: "link", ciFail: () => true });
      assert.deepEqual(fail.sharedNow, { marker: "shared-tree", files: "sdk" });
      assert(fs.lstatSync(path.join(fail.home, "repo", "node_modules")).isSymbolicLink(), "실패하면 링크가 돌아와야 한다");
      return "너머 무사 · 링크 복원";
    });
    test("★rollback 교차표 — 의존성 축 × 코드 축: rolled-back 은 둘 다 됐을 때만 · 의존성이 깨지면 띄우지 않는다 · 코드 축이 그걸 덮지 않는다", () => {
      type Row = { name: string; o: SimOpts; outcome: string; start: boolean; buildCalls?: number };
      const restored: SimOpts = { deps: "tree", notify: true, ciFail: () => true };
      const lost: SimOpts = { ...restored, renameFail: (a, b) => a.includes(".node_modules-prev-") && path.basename(b) === "node_modules" };
      const untouched: SimOpts = { deps: "tree", notify: true, renameFail: (_a, b) => b.includes(".node_modules-prev-") };
      const rows: Row[] = [];
      for (const [dn, d0, depsOk, startOk] of [["복원", restored, true, true], ["복원 실패", lost, false, false], ["손대지 않음", untouched, true, true]] as const) {
        rows.push({ name: `${dn} × 코드 성공`, o: d0, outcome: depsOk ? "rolled-back" : "needs-check", start: startOk });
        rows.push({ name: `${dn} × status 변경`, o: { ...d0, statusFailFrom: undefined }, outcome: "needs-check", start: startOk });
        rows.push({ name: `${dn} × status 조회 실패`, o: { ...d0, statusFailFrom: 2 }, outcome: "needs-check", start: startOk });
        rows.push({ name: `${dn} × reset 실패`, o: { ...d0, resetFails: true }, outcome: "needs-check", start: startOk });
        rows.push({ name: `${dn} × 이전 판 재빌드 실패`, o: { ...d0, buildFail: () => true }, outcome: dn === "손대지 않음" ? "rolled-back" : "needs-check", start: startOk, buildCalls: dn === "손대지 않음" ? 0 : undefined });
      }
      const bad: string[] = [];
      for (const row of rows) {
        const r = simulate(row.name.includes("status 변경") ? "rollback-dirty" : row.o.ciFail ? "npm-fail" : "success", row.o);
        const started = has(r.calls, /^(START|RESTART)/);
        const markerFirst = !started || r.calls.includes("START:marker") || r.calls.includes("RESTART:marker");
        if (r.marker?.outcome !== row.outcome || started !== row.start || !markerFirst || (row.buildCalls !== undefined && r.build !== row.buildCalls) || r.ci > 1) {
          bad.push(`${row.name}: outcome=${r.marker?.outcome} start=${started} build=${r.build} ci=${r.ci}`);
        }
      }
      assert.deepEqual(bad, []);
      return `${rows.length}칸`;
    });
    test("★옮겨 둔 트리가 없던 설치(백업 없음): reset **뒤** 이전 lock 으로 다시 깐다 · 재설치 실패 → needs-check·안 띄움 · 재빌드 실패 → needs-check·띄움 · 코드를 못 되돌리면 다시 깔지 않는다", () => {
      const twice = simulate("npm-fail", { notify: true, ciFail: () => true });
      assert(twice.calls.indexOf("git reset --keep 1111111") < twice.calls.lastIndexOf("CI:lock") && twice.ci === 2, twice.calls.join(" | "));
      assert.equal(twice.marker?.outcome, "needs-check"); assert(!has(twice.calls, /^(START|RESTART)/), twice.calls.join(" | "));
      const rebuild = simulate("npm-fail", { notify: true, buildFail: () => true });
      assert.equal(rebuild.marker?.outcome, "needs-check"); assert(has(rebuild.calls, /^START/), rebuild.calls.join(" | "));
      const ok = simulate("npm-fail", { notify: true });
      assert.equal(ok.marker?.outcome, "rolled-back"); assert(has(ok.calls, /^START/));
      const noReset = simulate("npm-fail", { notify: true, resetFails: true });
      assert.equal(noReset.ci, 1, noReset.calls.join(" | ")); assert.equal(noReset.marker?.outcome, "needs-check"); assert(has(noReset.calls, /^START/), "종전대로 띄운다");
      return "순서·재설치 실패·재빌드 실패·reset 실패";
    });
    test("★업데이트는 시작 환경을 저장하지 않는다(어느 경로든) — 위임 환경은 데몬이 .env 를 올려 둔 것이라 저장하면 지운 값이 되살아난다", () => {
      const all = (["success", "npm-fail", "dirty", "lock-only", "rollback-dirty", "pull-fail"] as Scenario[]).map((sc) => simulate(sc, { notify: true, handoff: "0000000" }));
      assert(all.every((r) => !r.calls.includes("SAVE_ENV")), "runUpdate 가 저장했다");
      // 저장은 사람이 셸에서 부르는 install 만 — start(업데이트 뒤 재가동이 부른다)는 안 한다.
      const installSrc = source.slice(source.indexOf("const winInstall = (c) => {"), source.indexOf("const winInstall = (c) => {") + 200);
      const startSrc = source.slice(source.indexOf("const winStart = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winStart = (c) => {")));
      assert(/winEnsureTask\(c, \{ capture: true \}\)/.test(installSrc), "install 이 붙잡지 않는다");
      assert(/winEnsureTask\(c\)/.test(startSrc) && !/capture/.test(startSrc), "start 가 붙잡는다");
      return `시나리오 ${all.length}개 저장 0`;
    });
    // ★winEnsureTask 를 실제 본문으로 돌린다 — 의존은 기록형 가짜(적대 검토 G2: 삭제가 «있다» 만 보고 «성공 뒤에만» 은 안 봤다).
    const ensureSrc = source.slice(source.indexOf("const winEnsureTask = (c, opts = {}) => {"), source.indexOf("\n};\n", source.indexOf("const winEnsureTask = (c, opts = {}) => {")) + 3);
    const runEnsure = (o: { capture?: boolean; register?: boolean; exists?: boolean; fallback?: string | null; supported?: boolean; legacyStartup?: boolean } = {}) => {
      const ev: string[] = [];
      const ensure = new Function("winRemoveLegacyAutostart", "mkdirSync", "warnWinServiceToken", "saveWinServiceEnv", "rmSync", "winLegacyVbsPath",
        "winPs", "psq", "winTaskName", "buildWinTaskScript", "winRemoveStartupFallback", "winTaskExists", "console", "winWriteStartupFallback",
        "winHeadlessSupported", "winKillRunning", "os", "winLegacyStartupVbsPath", "existsSync",
        ensureSrc + "; return winEnsureTask;")(() => ev.push("legacy-autostart"), () => {}, () => ev.push("warn"), () => ev.push("save"),
        (p: string) => ev.push("rm:" + path.basename(p)), () => "H\\win-launch.vbs",
        (script: string) => {
          if (script === "REGISTER") { ev.push("register"); return o.register === false ? { status: 0, stdout: "TASK_ERR: denied", stderr: "" } : { status: 0, stdout: "TASK_REGISTERED", stderr: "" }; }
          ev.push("disable-stop"); return { status: 0, stdout: "", stderr: "" };
        },
        (x: string) => x, () => "task", () => "REGISTER", () => { ev.push("remove-fallback"); return false; }, () => o.exists === true,
        { log: () => {}, warn: () => {}, error: () => {} }, () => { ev.push("write-fallback"); return o.fallback ?? null; },
        () => o.supported !== false, () => { ev.push("kill"); return []; }, { release: () => "10.0.14393" },
        () => "Startup\\tiguclaw.vbs", () => o.legacyStartup === true);
      return { mode: ensure(c, o.capture === true ? { capture: true } : {}), ev };
    };
    test("★예약작업 등록(winEnsureTask)은 capture 를 받았을 때만 붙잡는다 — 업데이트 뒤 재가동(start)이 붙잡으면 데몬 환경이 박힌다", () => {
      const start = runEnsure();
      const install = runEnsure({ capture: true });
      assert.equal(start.mode, true); assert(!start.ev.includes("save"), start.ev.join(","));
      assert(install.ev.includes("save"));
      return `start 저장 0 · install 저장 ${install.ev.filter((x) => x === "save").length}`;
    });
    test("★옛 VBS 런처는 새 등록이 성공한 뒤에만 지운다 · 성공하면 폴백을 걷는다 · 등록이 프로세스를 죽이지 않는다(셸 도구로 부르면 자기 자신까지 죽었다)", () => {
      const ok = runEnsure();
      assert.deepEqual(ok.ev.filter((x) => x !== "legacy-autostart"), ["disable-stop", "register", "rm:H\\win-launch.vbs", "remove-fallback"]);
      const all = [runEnsure({ capture: true }), runEnsure({ register: false, exists: true }), runEnsure({ register: false, exists: false, fallback: null })];
      assert(all.every((r) => !r.ev.includes("kill")), "winEnsureTask 가 프로세스를 죽인다");
      const keep = runEnsure({ register: false, exists: true });
      assert.equal(keep.mode, true); assert(!keep.ev.some((x) => x.startsWith("rm:")), keep.ev.join(","));
      const fb = runEnsure({ register: false, exists: false, fallback: "X.lnk" });
      assert.equal(fb.mode, "fallback"); assert(!fb.ev.some((x) => x.startsWith("rm:")), fb.ev.join(","));
      return `성공 ${ok.ev.join("→")} · 실패 갈래 삭제 0`;
    });
    test("★자동시작을 둘 다 못 걸어도 «지금만» 으로 돌려준다(호출부가 띄운다) — 종전엔 감독자를 아예 안 띄웠다", () => {
      const r = runEnsure({ register: false, exists: false, fallback: null });
      assert.equal(r.mode, "now-only");
      const bodyOf = (fn: string) => source.slice(source.indexOf(fn), source.indexOf("\n};\n", source.indexOf(fn)));
      assert(/mode === "now-only"\) \{[\s\S]{0,600}?winLaunchSupervisor\(c\);\s*process\.exitCode = 1;\s*\} else if \(mode === false\)/.test(bodyOf("const winInstall = (c) => {")), "install");
      return `mode=${r.mode}`;
    });
    // ★winStart 를 실제 본문으로 — 모드별로 무엇을 하나(재검토 G1·G2: now-only 갈래를 무력화해도 정규식 검사는 초록이었다).
    const startSrc = source.slice(source.indexOf("const winStart = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winStart = (c) => {")) + 3);
    const runStart = (o: { running?: boolean; mode?: unknown; enableFails?: boolean }) => {
      const ev: string[] = [];
      const prevCode = process.exitCode;
      process.exitCode = undefined;
      const start = new Function("isDaemonRunning", "winPort", "winEnsureTask", "winTaskName", "winLaunchSupervisor", "winPs", "winEnableStartScript",
        "reportLaunch", "waitForListening", "listeningOnBridge", "path", "console", "winLaunchLegacyStartup", startSrc + "; return winStart;")(
        () => o.running === true, () => 7021, () => { ev.push("ensure"); return o.mode; }, () => "task", () => ev.push("launch"),
        (x: string) => { ev.push(x); return { status: o.enableFails === true ? 1 : 0, stdout: "", stderr: "" }; }, () => "ENABLE_START",
        () => ev.push("report"), () => true, () => true, path, { log: () => {}, warn: () => ev.push("warn"), error: () => ev.push("error") },
        () => ev.push("launch-legacy"));
      start(c);
      const code = process.exitCode;
      process.exitCode = prevCode;
      return { ev, code };
    };
    test("★start: 이미 돌면 아무것도 안 한다(등록·기동 0) · 예약작업=켜고 띄움 · 폴백·지금만=직접 기동 · 지금만은 실패 코드 없이 경고 · 등록 불가=실패", () => {
      const running = runStart({ running: true, mode: true });
      assert.deepEqual(running.ev, []); assert.equal(running.code, undefined);
      const task = runStart({ mode: true });
      assert.deepEqual(task.ev, ["ensure", "ENABLE_START", "report"]); assert.equal(task.code, undefined);
      const fb = runStart({ mode: "fallback" });
      assert.deepEqual(fb.ev, ["ensure", "launch", "report"]);
      const now = runStart({ mode: "now-only" });
      assert.deepEqual(now.ev, ["ensure", "warn", "launch", "report"]); assert.equal(now.code, undefined);
      const none = runStart({ mode: false });
      assert.deepEqual(none.ev, ["ensure", "error"]); assert.equal(none.code, 1);
      // 1809 미만 + 옛 시작프로그램 — /update 뒤 start 가 그 런처로 띄운다(리뷰 10-18: 종전엔 아무것도 안 떴다).
      const legacy = runStart({ mode: "legacy-startup" });
      assert.deepEqual(legacy.ev, ["ensure", "launch-legacy", "report"]); assert.equal(legacy.code, undefined);
      return "모드 5갈래";
    });
    test("작업 존재 판정 = schtasks /query 의 종료 코드", () => {
      const fn = source.slice(source.indexOf("const winTaskExists = (c) =>"), source.indexOf(";\n", source.indexOf("const winTaskExists = (c) =>")) + 2);
      const mk = (status: number) => new Function("spawnSync", "winTaskName", fn + " return winTaskExists;")(
        (cmd: string, args: string[]) => { assert.equal(cmd, "schtasks"); assert.deepEqual(args, ["/query", "/tn", "task"]); return { status }; }, () => "task");
      assert.equal(mk(0)(c), true); assert.equal(mk(1)(c), false);
    });
    test("★--headless 를 모르는 옛 윈도우는 아무것도 바꾸지 않는다(옛 등록 유지) · 판정은 1809(17763)부터", () => {
      const keep = runEnsure({ supported: false, exists: true });
      const none = runEnsure({ supported: false, exists: false });
      // 예약작업이 막혀 옛 시작프로그램 `.vbs` 로 돌던 기계 — 그 런처를 그대로 쓴다(리뷰 10-18: false 를 돌려 /update 뒤 아무것도 안 떴다).
      const legacy = runEnsure({ supported: false, exists: false, legacyStartup: true });
      assert.equal(keep.mode, true); assert.equal(none.mode, false); assert.equal(legacy.mode, "legacy-startup");
      assert.deepEqual([...keep.ev, ...none.ev, ...legacy.ev], []);
      const cases = { "10.0.17134": false, "10.0.17763": true, "10.0.26200": true, "25.3.0": true } as Record<string, boolean>;
      for (const [rel, want] of Object.entries(cases)) assert.equal(d.winHeadlessSupported(rel), want, rel);
      return "옛 빌드 변경 0";
    });
    test("★등록 스크립트의 실제 출력 — 액션 한 줄이 winTaskAction 그대로(conhost 절대경로·작업 폴더) · 대입 한 번", () => {
      const script: string = d.buildWinTaskScript(c);
      const a = d.winTaskAction(c);
      const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
      const lines = script.split("\n").filter((l) => /New-ScheduledTaskAction/.test(l));
      assert.deepEqual(lines, [`$action = New-ScheduledTaskAction -Execute ${q(a.execute)} -Argument ${q(a.argument)} -WorkingDirectory ${q(c.repoRoot)}`]);
      assert.equal((script.match(/^\$action\s*=/gm) ?? []).length, 1);
      assert(/Register-ScheduledTask [^\n]*-Action \$action /.test(script));
      assert.equal(d.winConhostPath({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\conhost.exe");
      assert.equal(d.winConhostPath({}), "C:\\Windows\\System32\\conhost.exe");
      return a.execute;
    });
    test("★등록 직후 설치한 사용자 본인에게 작업 전체 권한(FA)을 준다 — 관리자 창에서 설치하면 본인은 읽기(FR)만 받아 일반 창의 업데이트·정지가 «Access is denied» 였다(집 윈도우 10-21) · 멱등 · 실패해도 등록은 무르지 않는다", () => {
      const script: string = d.buildWinTaskScript(c);
      const grant: string = d.buildWinTaskGrantScript(c);
      const reg = script.indexOf("Register-ScheduledTask");
      const ok = script.indexOf("'TASK_REGISTERED'");
      const at = script.indexOf(grant);
      assert(reg >= 0 && ok > reg && at > ok, `순서: register=${reg} registered=${ok} grant=${at}`);
      assert(/WindowsIdentity\]::GetCurrent\(\)\.User\.Value/.test(grant), "본인 SID");
      assert(/GetSecurityDescriptor\(4\)/.test(grant) && /SetSecurityDescriptor\(\$sd \+ '\(A;;FA;;;' \+ \$me \+ '\)', 0\)/.test(grant), "DACL 에 본인 FA");
      assert(/-notlike \('\*\(A;;FA;;;' \+ \$me \+ '\)\*'\)/.test(grant), "이미 있으면 다시 안 붙인다(멱등)");
      assert(/^try \{/.test(grant) && /\} catch \{ 'TASK_ACL_ERR: ' \+ \$_\.Exception\.Message \}$/.test(grant), "자기 try/catch — 등록을 무르지 않는다");
      // ★작업 계정 SID 와 실행 계정 SID 가 같을 때만 고친다(아스트라 10-22 P2) — 비교가 **권한 변경보다 앞**이고, 못 풀면 일치로 치지 않는다.
      const cmp = grant.indexOf("elseif ($psid -ne $me)");
      const unres = grant.indexOf("if ($psid -eq '') { 'TASK_ACL_UNRESOLVED ");
      const set = grant.indexOf("SetSecurityDescriptor");
      assert(/Principal\.UserId/.test(grant) && /NTAccount\(\$pu\)\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/.test(grant), "작업 계정을 SID 로 푼다(이름 비교 아님)");
      assert(unres >= 0 && cmp > unres && set > cmp, `순서: 못 풂=${unres} 불일치=${cmp} 변경=${set}`);
      return "등록 → 확인 → (계정 일치일 때만) 권한";
    });
    test("PowerShell 오류(CLIXML)는 오류 문장만 한 줄로 — 진행 표시(«모듈을 준비하는 중»)·XML 을 로그에 쏟지 않는다", () => {
      const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><TN RefId="0"><T>x</T></TN><MS><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV></PR></MS></Obj><S S="Error">Disable-ScheduledTask : 액세스가 거부되었습니다._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>';
      assert.equal(d.psErrorText({ stdout: "", stderr: clixml }), "Disable-ScheduledTask : 액세스가 거부되었습니다.");
      // 실기 모양(집 윈도우 10-21) — 본문 뒤에 위치·소스 인용·CategoryInfo 가 같은 Error 조각으로 잇따른다
      const real = '#< CLIXML <Objs><S S="Error">Disable-ScheduledTask : Access is denied._x000D__x000A_</S><S S="Error">At line:1 char:52_x000D__x000A_</S><S S="Error">+ ... ing]::UTF8; Disable-ScheduledTask -TaskName _x000D__x000A_</S><S S="Error">+ CategoryInfo          : PermissionDenied: (PS_ScheduledTask:Root/Microsoft/...S_ScheduledTask) [Disable-Schedule</S><S S="Error">dTask], CimException_x000D__x000A_</S></Objs>';
      assert.equal(d.psErrorText({ stdout: "", stderr: real }), "Disable-ScheduledTask : Access is denied.");
      assert.equal(d.psErrorText({ stdout: "", stderr: "plain error" }), "plain error");
      assert.equal(d.psErrorText({ stdout: "", stderr: "" }), "no output");
      return "문장만";
    });
    test("★긴 오류 문장은 콘솔 폭에서 접혀 여러 조각으로 오고 접힌 자리에도 줄 끝이 붙는다 — 문장을 끝까지 잇는다(레드팀 10-22 P-2, Windows 검증 기기 10-23 실측 모양 그대로)", () => {
      // 실측: `Get-Item 'C:\no\such\tiguclaw-p2-xxx…'` 을 `winPsArgs` 로 — 폭 118 에서 접혔다. 종전 결과는 첫 조각(«…xxxx» 에서 끊김).
      const x = "x".repeat(180);
      const msg = `Get-Item : Cannot find path 'C:\\no\\such\\tiguclaw-p2-${x}' because it does not exist.`;
      const W = 118;
      const wrapped = [msg.slice(0, W), msg.slice(W, 2 * W), msg.slice(2 * W)];
      const S = (t: string) => `<S S="Error">${t}_x000D__x000A_</S>`;
      const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1">' + wrapped.map(S).join("") + S("At line:1 char:83") +
        S("+ ... nce='Stop'; Get-Item 'C:\\no\\such\\tiguclaw-p2-xxxxxxxxxxxxxxxxxxxxxxxx ...") +
        // 부속 줄도 폭을 채워 접힌다(실측: CategoryInfo 가 118 에서 «…ItemNotFoundExcep » / «   tion»)
        S("    + CategoryInfo          : ObjectNotFound: (C:\\no\\such\\tigu...xxxxxxxxxxxxxxx:String) [Get-Item], ItemNotFoundExcep ".padEnd(W).slice(0, W)) +
        S("   tion") + S(" ") + "</Objs>";
      assert.equal(wrapped[0].length, W); assert.equal(wrapped[1].length, W);
      assert.equal(d.psErrorText({ stdout: "", stderr: clixml }), msg);
      // 접힘이 없는 짧은 출력에서 가장 긴 줄이 문장이어도 부속 줄(«위치 줄:»)을 붙이지 않는다
      const short = '#< CLIXML <Objs>' + S("Disable-ScheduledTask : 액세스가 거부되었습니다.") + S("위치 줄:1 문자:1") + "</Objs>";
      assert.equal(d.psErrorText({ stdout: "", stderr: short }), "Disable-ScheduledTask : 액세스가 거부되었습니다.");
      // 진짜 줄바꿈 — 폭에 닿은 줄이 하나뿐이면 접힘의 증거가 아니다: 붙이지 않고 공백으로 잇는다(GPT R1)
      const twoLines = '#< CLIXML <Objs>' + S("Disable-ScheduledTask : first diagnostic sentence.") + S("Second sentence.") + S("At line:1 char:1") + "</Objs>";
      assert.equal(d.psErrorText({ stdout: "", stderr: twoLines }), "Disable-ScheduledTask : first diagnostic sentence. Second sentence.");
      // 문장 앞의 부속 줄은 건너뛴다(종전 필터와 같다 — 거기서 멈추면 «no error text», GPT R1)
      const lead = '#< CLIXML <Objs>' + S("At line:1 char:1") + S("Disable-ScheduledTask : Access is denied.") + S("+ CategoryInfo : PermissionDenied") + "</Objs>";
      assert.equal(d.psErrorText({ stdout: "", stderr: lead }), "Disable-ScheduledTask : Access is denied.");
      // 문장 덩어리는 빈 줄에서 끝난다 — 그 뒤의 (부속 줄 아닌) 꼬리를 붙이지 않는다(GPT R2)
      const blankTail = '#< CLIXML <Objs>' + S("Disable-ScheduledTask : Access is denied.") + S(" ") + S("diagnostic tail") + "</Objs>";
      assert.equal(d.psErrorText({ stdout: "", stderr: blankTail }), "Disable-ScheduledTask : Access is denied.");
      return "끝까지 · 부속 줄 안 붙음 · 진짜 줄바꿈은 공백 · 앞 부속 줄 건너뜀 · 빈 줄에서 끝";
    });
    // ★winStop·winUninstall·winRepair 를 실제 본문으로 — 의존은 주입한 것뿐이라, 본문이 다른 것(환경 저장·재등록)을 부르면 ReferenceError 로 빨개진다.
    const bodyOf = (name: string): string => source.slice(source.indexOf(`const ${name} = (c) => {`), source.indexOf("\n};\n", source.indexOf(`const ${name} = (c) => {`)) + 3);
    type TS = { state: "enabled" | "disabled" | "missing" | "unknown"; why?: string };
    const sink = () => {
      const out: string[] = [];
      return {
        out,
        con: { log: (m: string) => out.push("log:" + m), error: (m: string) => out.push("err:" + m), warn: (m: string) => out.push("warn:" + m) },
        proc: { set exitCode(v: number) { out.push("exit:" + v); }, get exitCode() { return 0; } },
      };
    };
    // `fallback` = 시작프로그램 폴백 파일이 있다(작업이 없어도 로그온 때 다시 뜬다). 등록 판정은 진짜 `stoppedLine` 으로 문구가 된다.
    //  폴백 판정도 **진짜 본문**(`winHasStartupFallback`) — 경로 목록·파일 존재만 주입한다(정지 줄과 업데이트 안내가 같은 판정을 본다).
    const oneLiner = (name: string): string => source.slice(source.indexOf(`const ${name} = (c) =>`), source.indexOf(";\n", source.indexOf(`const ${name} = (c) =>`)) + 2);
    const hasFallbackOf = (fallback: boolean): ((c: unknown) => boolean) => new Function("winStartupFallbackPaths", "existsSync", oneLiner("winHasStartupFallback") + " return winHasStartupFallback;")(
      () => [null, "C:\\fixture\\startup.lnk"], (p: string) => fallback && p.endsWith("startup.lnk"));
    const runStop = (o: { survived?: string[]; state?: TS; locked?: boolean; fallback?: boolean }) => {
      const k = sink();
      const prevCode = process.exitCode;
      const r = new Function("winStopTask", "winTaskState", "winTaskName", "activeUpdateLock", "winHasStartupFallback", "stoppedLine", "console", "process", bodyOf("winStop") + "; return winStop;")(
        () => ({ pids: o.survived ?? [] }), () => o.state ?? { state: "disabled" }, () => "task", () => (o.locked === true ? { pid: 1 } : null),
        hasFallbackOf(o.fallback === true), d.stoppedLine, k.con, k.proc,
      )(c);
      process.exitCode = prevCode;
      return { r, out: k.out };
    };
    test("★작업 상태는 네 값 — 켜짐·꺼짐·없음·모름. «없음» 은 오류 번호(0x80070002)로만, 못 읽은 것은 «모름»(꺼짐·없음으로 바꾸지 않는다)", () => {
      const st = (stdout: string, stderr = "", status: number | null = 0) => d.parseWinTaskState({ stdout, stderr, status });
      assert.deepEqual(st("TASK_STATE=enabled"), { state: "enabled" });
      assert.deepEqual(st("TASK_STATE=disabled"), { state: "disabled" });
      assert.deepEqual(st("TASK_STATE=missing"), { state: "missing" });
      assert.deepEqual(st("TASK_STATE=unknown 액세스가 거부되었습니다."), { state: "unknown", why: "액세스가 거부되었습니다." });
      assert.equal(st("", "PowerShell did not respond — gave up after 20s", null).state, "unknown");
      assert.equal(st("", "#< CLIXML <Objs><S S=\"Error\">denied</S></Objs>", 1).state, "unknown");
      const script: string = d.buildWinTaskStateScript(c);
      assert(/GetTask\(/.test(script) && /HResult -eq -2147024894/.test(script) && !/찾을 수 없|not found/i.test(script), "없음 = 번호로");
      return "네 갈래";
    });
    test("★손으로 멈추기: 작업이 켜진 채 → 실패(«1분 안에 다시 뜬다 + repair») · 상태를 못 읽음 → 실패(성공으로 덮지 않음) · 업데이트 중 → 진행 · 꺼짐·없음 → 정상", () => {
      const stuck = runStop({ state: { state: "enabled" } });
      const unknown = runStop({ state: { state: "unknown", why: "Access is denied" } });
      const updating = runStop({ state: { state: "enabled" }, locked: true });
      const off = runStop({ state: { state: "disabled" } });
      const gone = runStop({ state: { state: "missing" } });
      const ok = (x: { out: string[] }) => x.out.some((m) => /✅ stopped/.test(m));
      assert.equal(stuck.r, false); assert(stuck.out.some((m) => /will not stick/.test(m) && /daemon:repair/.test(m)) && stuck.out.includes("exit:1") && !ok(stuck), stuck.out.join(" | "));
      assert.equal(unknown.r, false); assert(unknown.out.some((m) => /could not confirm/.test(m) && /Access is denied/.test(m)) && unknown.out.includes("exit:1") && !ok(unknown), unknown.out.join(" | "));
      assert(updating.r === true && ok(updating), updating.out.join(" | "));
      assert(off.r === true && ok(off) && gone.r === true && ok(gone), [...off.out, ...gone.out].join(" | "));
      return "켜짐=실패 · 모름=실패 · 업데이트 중=진행 · 꺼짐/없음=정상";
    });
    test("★정지 성공 줄은 등록을 확인한 만큼만 말한다 — 작업 없음·폴백 없음=«not registered» · 꺼짐 또는 폴백=«still registered» · 업데이트 중(안 읽음)=등록을 말하지 않음 · 맥·리눅스도 같다", () => {
      // 2026-10-29 Windows 현장(사용자 보고): 등록 안 된 시험 라벨을 멈췄는데 «still registered» 가 찍혔다.
      const line = (x: { out: string[] }) => x.out.find((m) => /✅ stopped/.test(m)) ?? "(none)";
      const gone = line(runStop({ state: { state: "missing" } }));
      const goneButFallback = line(runStop({ state: { state: "missing" }, fallback: true }));
      const off = line(runStop({ state: { state: "disabled" } }));
      const updating = line(runStop({ state: { state: "missing" }, locked: true }));
      assert(/not registered/.test(gone) && !/still registered/.test(gone), gone);
      assert(/still registered/.test(goneButFallback) && /still registered/.test(off), `${goneButFallback} | ${off}`);
      assert(!/registered/.test(updating) && updating.includes(c.label), updating);
      // 맥·리눅스 — 실제 본문, 등록 판정만 주입
      const out: string[] = []; const con = { log: (m: string) => out.push(m), error: (m: string) => out.push(m) };
      const mac = (reg: boolean) => new Function("launchdDomain", "execFileSync", "isRegistered", "stoppedLine", "console", bodyOf("darwinStop") + "; return darwinStop;")(
        () => "gui/1", () => { throw new Error("not loaded"); }, () => reg, d.stoppedLine, con)(c);
      const lin = (reg: boolean) => new Function("systemctlUser", "isRegistered", "stoppedLine", "console", "process", bodyOf("linuxStop") + "; return linuxStop;")(
        () => "", () => reg, d.stoppedLine, con, { exitCode: 0 })(c);
      mac(false); mac(true); lin(false); lin(true);
      assert.deepEqual(out.map((m) => (/not registered/.test(m) ? "no" : /still registered/.test(m) ? "yes" : "?")), ["no", "yes", "no", "yes"], out.join(" | "));
      return `${gone} · ${updating}`;
    });
    test("★업데이트의 등록 판정(isRegistered)도 시작프로그램 폴백을 등록으로 본다 — 폴백만 있는 설치에 «not registered — run install» 을 말하지 않는다 · 폴백이 있으면 schtasks 를 부르지 않는다", () => {
      // 2026-10-29: 정지 줄은 폴백을 «등록됨» 으로 쳤는데 업데이트 안내는 예약작업만 봤다(같은 판단이 두 곳).
      const run = (o: { task: boolean; fallback: boolean }) => {
        let queries = 0;
        const reg = new Function("process", "existsSync", "launchdPlistPath", "systemdUnitPath", "winHasStartupFallback", "winTaskExists", bodyOf("isRegistered") + "; return isRegistered;")(
          { platform: "win32" }, () => { throw new Error("윈도우 판정이 파일 경로를 따로 보면 안 된다"); }, () => "", () => "",
          hasFallbackOf(o.fallback), () => { queries += 1; return o.task; },
        )(c) as boolean;
        return { reg, queries };
      };
      const fbOnly = run({ task: false, fallback: true });
      const taskOnly = run({ task: true, fallback: false });
      const none = run({ task: false, fallback: false });
      assert.deepEqual(fbOnly, { reg: true, queries: 0 }, JSON.stringify(fbOnly));
      assert.deepEqual(taskOnly, { reg: true, queries: 1 }, JSON.stringify(taskOnly));
      assert.deepEqual(none, { reg: false, queries: 1 }, JSON.stringify(none));
      return "폴백만=등록(조회 0) · 작업만=등록 · 둘 다 없음=미등록(조회 1)";
    });
    const runUninstall = (o: { unreg: string; after: TS }) => {
      const k = sink();
      const prevCode = process.exitCode;
      new Function("winPs", "psq", "winTaskName", "winKillRunning", "winRemoveLegacyAutostart", "winRemoveStartupFallback", "rmSync", "winLegacyVbsPath", "winTaskState", "console", "process",
        bodyOf("winUninstall") + "; return winUninstall;")(
        () => ({ status: 0, stdout: o.unreg, stderr: "" }), (x: string) => `'${x}'`, () => "task", () => [], () => {}, () => false, () => {}, () => "x.vbs", () => o.after, k.con, k.proc,
      )(c);
      process.exitCode = prevCode;
      return k.out;
    };
    test("★제거는 작업이 **없어진 것을 확인**했을 때만 «✅ Unregistered» — 삭제 거부·남음·못 읽음은 실패와 repair 안내(종전: 결과를 안 보고 성공을 찍었다)", () => {
      const done = runUninstall({ unreg: "TASK_UNREGISTERED", after: { state: "missing" } });
      const denied = runUninstall({ unreg: "TASK_UNREG_ERR Access is denied.", after: { state: "disabled" } });
      const left = runUninstall({ unreg: "TASK_UNREGISTERED", after: { state: "enabled" } });
      const unknown = runUninstall({ unreg: "TASK_UNREGISTERED", after: { state: "unknown", why: "timeout" } });
      assert(done.some((m) => /✅ Unregistered/.test(m)) && !done.includes("exit:1"), done.join(" | "));
      for (const [name, o] of [["denied", denied], ["left", left], ["unknown", unknown]] as const) {
        assert(!o.some((m) => /✅ Unregistered/.test(m)) && o.includes("exit:1") && o.some((m) => /could not remove/.test(m) && /daemon:repair/.test(m)), name + ": " + o.join(" | "));
      }
      assert(denied.some((m) => /Access is denied/.test(m)) && unknown.some((m) => /timeout/.test(m)), "이유를 싣는다");
      return "없음 확인=성공 · 나머지=실패";
    });
    const runRepair = (o: { before: TS; grant: string }) => {
      const k = sink();
      const calls: string[] = [];
      const prevCode = process.exitCode;
      new Function("winTaskState", "winPs", "buildWinTaskGrantScript", "winTaskName", "psErrorText", "console", "process", bodyOf("winRepair") + "; return winRepair;")(
        () => o.before, (sc: string) => { calls.push(sc); return { status: 0, stdout: o.grant, stderr: "" }; }, () => "GRANT", () => "task", () => "ps-err", k.con, k.proc,
      )({ ...c, homeRaw: "" });
      process.exitCode = prevCode;
      return { out: k.out, calls };
    };
    test("★repair 는 **권한만** 고친다 — 권한 조각 하나만 돌리고(환경 저장·재등록·기동 0), 거부되면 관리자 창에서 같은 명령을 정확히 안내 · 작업이 없으면 할 일 없음 · 작업 계정과 다른 계정·못 푼 계정이면 «복구됨» 없이 실패", () => {
      const other = runRepair({ before: { state: "enabled" }, grant: "TASK_ACL_MISMATCH SYSTEM (S-1-5-18) runner=S-1-5-21-1" });
      // ★실제 출력은 끝이 trim 된 모양이다(`winPs` 의 stdout.trim — 이름이 빈 «못 풂» 은 공백까지 잘린다, 실측표와 같다).
      const unres = runRepair({ before: { state: "enabled" }, grant: "TASK_ACL_UNRESOLVED" });
      for (const [nm, x] of [["other", other], ["unresolved", unres]] as const) {
        assert(!x.out.some((m) => /✅ Repaired/.test(m)) && x.out.includes("exit:1") && x.out.some((m) => /not repaired/.test(m) && /Nothing was changed/.test(m)), nm + ": " + x.out.join(" | "));
      }
      assert(other.out.some((m) => /different account/.test(m) && /S-1-5-18/.test(m)), "다른 계정이라고 말한다");
      const ok = runRepair({ before: { state: "enabled" }, grant: "TASK_ACL_OK" });
      const denied = runRepair({ before: { state: "disabled" }, grant: "TASK_ACL_ERR: Access is denied." });
      const none = runRepair({ before: { state: "missing" }, grant: "TASK_ACL_OK" });
      assert.deepEqual(ok.calls, ["GRANT"]); assert(ok.out.some((m) => /✅ Repaired/.test(m)) && !ok.out.includes("exit:1"), ok.out.join(" | "));
      assert(denied.out.some((m) => /administrator/.test(m) && /npm run daemon:repair/.test(m) && /Access is denied/.test(m)) && denied.out.includes("exit:1"), denied.out.join(" | "));
      assert.deepEqual(none.calls, []); assert(none.out.some((m) => /Nothing to repair/.test(m)), none.out.join(" | "));
      return "조각 1회 · 거부=관리자 안내 · 없음=할 일 없음";
    });
    test("★시작프로그램 폴백 = 같은 액션의 .lnk(창 최소화) · 걷을 때 .lnk 와 옛 .vbs 둘 다", () => {
      const a = d.winTaskAction(c);
      const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
      const sc: string = d.buildWinShortcutScript(c, "X.lnk");
      for (const part of [`CreateShortcut('X.lnk')`, `$s.TargetPath = ${q(a.execute)};`, `$s.Arguments = ${q(a.argument)};`, `$s.WorkingDirectory = ${q(c.repoRoot)};`, "$s.WindowStyle = 7;", "'LNK_OK'"]) assert(sc.includes(part), part);
      const prev = process.env.APPDATA;
      const appData = fs.mkdtempSync(path.join(home, "appdata-"));
      try {
        process.env.APPDATA = appData;
        const lnk: string = d.winStartupLnkPath(c);
        assert(lnk.endsWith(path.join("Startup", `${c.label}.lnk`)), lnk);
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        fs.writeFileSync(lnk, ""); fs.writeFileSync(path.join(path.dirname(lnk), `${c.label}.vbs`), "");
        assert.equal(d.winRemoveStartupFallback(c), true);
        assert.deepEqual(fs.readdirSync(path.dirname(lnk)), []);
      } finally { if (prev === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev; }
      return "폴백 .lnk · 걷기 2/2";
    });
    test("★옛 VBS 런처 경로 = 옛 코드가 쓰던 바로 그 파일(홈의 win-launch.vbs) — 이름이 갈리면 넘어온 기계에 옛 파일이 남는다", () => {
      assert.equal(d.winLegacyVbsPath(c), path.join(home, "win-launch.vbs"));
    });
    test("★감독자 직접 기동(폴백·지금만) = conhost --headless 절대경로 · 분리 실행 · 실패를 말한다", () => {
      const fn = source.slice(source.indexOf("const winLaunchSupervisor = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winLaunchSupervisor = (c) => {")) + 3);
      const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
      const handlers: Record<string, (e: Error) => void> = {};
      const errors: string[] = [];
      const launch = new Function("spawn", "winConhostPath", "winSuperviseArgv", "console", fn + "; return winLaunchSupervisor;")(
        (cmd: string, args: string[], opts: Record<string, unknown>) => { calls.push({ cmd, args, opts }); return { on: (n: string, h: (e: Error) => void) => { handlers[n] = h; }, unref: () => {} }; },
        d.winConhostPath, d.winSuperviseArgv, { error: (m: string) => errors.push(m), log: () => {}, warn: () => {} });
      launch(c);
      const call = calls[0];
      assert(call !== undefined && call.cmd === d.winConhostPath() && call.args[0] === "--headless", JSON.stringify(call));
      assert.deepEqual(call.args.slice(1), d.winSuperviseArgv(c)); assert.equal(call.opts.detached, true);
      handlers.error?.(new Error("ENOENT conhost"));
      assert(errors.some((m) => m.includes("ENOENT conhost")), "기동 실패를 삼켰다");
      return call.cmd;
    });
    test("★uninstall 이 옛 VBS 런처·폴백을 걷는다", () => {
      const fn = source.slice(source.indexOf("const winUninstall = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winUninstall = (c) => {")) + 3);
      const ev: string[] = [];
      const un = new Function("winPs", "psq", "winTaskName", "winKillRunning", "winRemoveLegacyAutostart", "winRemoveStartupFallback", "rmSync", "winLegacyVbsPath", "winTaskState", "console", "process",
        fn + "; return winUninstall;")((s: string) => { ev.push(/Unregister/.test(s) ? "unregister" : "ps"); return { status: 0, stdout: "TASK_UNREGISTERED", stderr: "" }; }, (x: string) => x, () => "task",
        () => { ev.push("kill"); return []; }, () => ev.push("legacy-autostart"), () => { ev.push("remove-fallback"); return true; },
        (p: string) => ev.push("rm:" + path.basename(p)), () => "H\\win-launch.vbs", () => ({ state: "missing" }), { log: () => {}, warn: () => {}, error: () => {} }, { exitCode: 0 });
      un(c);
      for (const want of ["unregister", "kill", "remove-fallback", "rm:H\\win-launch.vbs"]) assert(ev.includes(want), `${want} 없음: ${ev.join(",")}`);
      return ev.join("→");
    });
    test("★위임 CLI 의 pull 이 실패해도(네트워크 등) HEAD 를 되돌린다 — 안 그러면 코드만 새것으로 고착", () => {
      const r = simulate("pull-fail", { notify: true, handoff: "0000000" });
      assert.equal(r.exitCode, 1); assert(r.calls.includes("git reset --keep 0000000"), r.calls.join(" | ")); assert.equal(r.marker?.outcome, "unchanged");
    });
    test("HEAD 를 못 되돌렸으면 «needs-check» — «nothing was changed» 라고 말하지 않는다", () => {
      const r = simulate("dirty", { notify: true, handoff: "0000000", resetFails: true });
      assert.equal(r.marker?.outcome, "needs-check", JSON.stringify(r.marker));
    });
    test("위임이 아니면(터미널) 멈출 때 데몬을 재가동하지 않는다 — 돌던 데몬을 괜히 끊지 않는다", () => {
      const r = simulate("dirty");
      assert(!has(r.calls, /^(RESTART|START)/), r.calls.join(" | "));
    });
    test("손상된 저장본: 아무 인스턴스도 안 건드린다(멈춤·재가동·pull 0) · 위임이면 HEAD 만 되돌린다", () => {
      const r = simulate("corrupt-env", { notify: true, handoff: "0000000" });
      assert.equal(r.exitCode, 1); assert(!has(r.calls, /^(STOP|START|RESTART)|pull/), r.calls.join(" | "));
      assert(r.calls.includes("git reset --keep 0000000")); assert.equal(r.marker?.stage, "startup environment");
    });
    // ── 감독자: 데몬을 띄울 **때마다** 기동 환경을 다시 계산한다 ───────────────────────────────────
    //  감독자 자신의 환경을 물려주면 감독자가 뜬 순간의 값이 굳어, .env 를 고친 뒤 `/restart`(데몬만 다시 뜸)가 옛 값으로 떴다.
    test("★감독자는 데몬 재기동마다 .env 를 다시 본다 — 두 번째 기동은 그새 .env 에 적은 값을 저장본보다 우선한다", () => {
      const h = fs.mkdtempSync(path.join(home, "sup-"));
      fs.writeFileSync(path.join(h, "win-service-env.json"), JSON.stringify({ DASHBOARD_PORT: "7020" }));
      const sup = source.slice(source.indexOf("const runSupervise = (c) => {"), source.indexOf("\n};\n", source.indexOf("const runSupervise = (c) => {")) + 3);
      const envs: Array<Record<string, string | undefined>> = [];
      const exits: Array<() => void> = [];
      const spawn = (_exe: string, _args: string[], o: { env: Record<string, string | undefined> }) => {
        envs.push(o.env);
        return { pid: envs.length, kill: () => {}, on: (ev: string, fn: (code: number, sig: null) => void) => { if (ev === "exit") exits.push(() => fn(0, null)); } };
      };
      const fakeProcess = { platform: "win32", env: { SUPERVISOR_ONLY: "1" }, on: () => {}, exit: () => {}, stdout: { write: () => {} }, stderr: { on: () => {}, write: () => true } };
      const run = new Function("process", "spawn", "mkdirSync", "appendFileSync", "path", "execStrings", "winLaunchEnv", "WIN_SERVICE_ENV_KEYS", "Date", "setTimeout",
        "spawnSync", "winSupervisorQueryArgs", "winSupervisorIsDuplicate", "statSync", "writeFileSync", "net", "winSupervisorPipeName", "activeUpdateLock",
        sup + "; return runSupervise;")(fakeProcess, spawn, () => {}, () => {}, path, () => ["node", "x"], d.winLaunchEnv, d.WIN_SERVICE_ENV_KEYS,
        // 오래 산 것으로 보이게(스로틀 없이 즉시 재기동) — 시계를 30초씩 민다.
        class extends Date { static t = 0; static now() { this.t += 30_000; return this.t; } }, () => {},
        // 다른 감독자 없음(질의 결과 빈 것 — 판정은 `windows-single-supervisor` 가 본다).
        () => ({ stdout: "" }), () => [], d.winSupervisorIsDuplicate, () => ({ mtimeMs: 0 }), () => {},
        // 잠금은 바로 잡힌다(판정은 `windows-single-supervisor` 가 본다).
        { createServer: () => ({ on: () => {}, listen: (_n: string, cb: () => void) => cb() }) }, () => "pipe", () => null);
      run({ ...c, homeAbs: h, homeRaw: h, logsDir: path.join(h, "logs"), launchEnv: { LAUNCH_ONLY: "1" } });
      const first = envs[0]?.DASHBOARD_PORT;
      fs.writeFileSync(path.join(h, ".env"), "DASHBOARD_PORT=7099\n"); // 사용자가 .env 를 고치고 /restart
      exits[0]?.();
      const second = envs[1];
      assert.equal(first, "7020"); assert(second !== undefined, "재기동 안 됨");
      assert.equal(second.DASHBOARD_PORT, undefined, "저장본 값이 실려 가면 데몬의 .env 로드가 못 이긴다");
      assert.equal(second.LAUNCH_ONLY, "1"); assert.equal(second.SUPERVISOR_ONLY, undefined);
      return `1차=${first} · 2차=${String(second.DASHBOARD_PORT)}(→ 데몬이 .env 7099 를 읽는다)`;
    });
    test("★감독자에게 넘기는 «실행 환경» 은 저장본을 채우기 **전** 사본이다 — 같은 객체면 채운 값이 실행 환경으로 섞여 .env 를 이긴다", () => {
      const h = fs.mkdtempSync(path.join(home, "ctx-"));
      fs.writeFileSync(path.join(h, "win-service-env.json"), JSON.stringify({ DASHBOARD_PORT: "7020" }));
      const bc = source.slice(source.indexOf("const buildCtx = () => {"), source.indexOf("\n};\n", source.indexOf("const buildCtx = () => {")) + 3);
      const fakeProcess = { platform: "win32", execPath: process.execPath, cwd: () => repo, env: { TIGUCLAW_HOME: h, PATH: "C:\\Windows" } as Record<string, string> };
      const ctx = new Function("process", "path", "os", "expandHome", "runtimeMode", "resolveLabel", "settleLegacyPorts", "winLaunchEnv", "applyWinServiceEnv", bc + "; return buildCtx();")(
        fakeProcess, path, os, (x: string) => x, () => "built", () => "label", () => [], d.winLaunchEnv, // 포트 고정은 아래 검사가 본다
        // 기본 인자는 모듈의 진짜 process.env 다 — 가짜 환경을 명시해 스위트 프로세스를 오염시키지 않는다.
        (homeAbs: string) => d.applyWinServiceEnv(homeAbs, fakeProcess.env));
      assert.equal(fakeProcess.env.DASHBOARD_PORT, "7020", "CLI 자신에겐 채운다(라벨·포트 판정)");
      assert.equal(ctx.launchEnv.DASHBOARD_PORT, undefined, "감독자용 실행 환경엔 없어야 한다");
      return `CLI=${fakeProcess.env.DASHBOARD_PORT} · launchEnv=${String(ctx.launchEnv.DASHBOARD_PORT)}`;
    });
    test("★기존 설치 고정은 `win-service-env.json` 의 포트도 «정해진 값» 으로 본다 — 안 보면 옛 기본값을 .env 에 적어 저장본(7021)을 가린다", () => {
      const h = fs.mkdtempSync(path.join(home, "settle-"));
      fs.mkdirSync(path.join(h, "data"));
      fs.writeFileSync(path.join(h, "data", "tiguclaw.db"), ""); // 업데이트 전부터 쓰던 홈
      fs.writeFileSync(path.join(h, "win-service-env.json"), JSON.stringify({ HTTP_BRIDGE_PORT: "7021" }));
      const bc = source.slice(source.indexOf("const buildCtx = () => {"), source.indexOf("\n};\n", source.indexOf("const buildCtx = () => {")) + 3);
      const fakeProcess = { platform: "win32", execPath: process.execPath, cwd: () => h, env: { TIGUCLAW_HOME: h, PATH: "C:\\Windows" } as Record<string, string> };
      new Function("process", "path", "os", "expandHome", "runtimeMode", "resolveLabel", "settleLegacyPorts", "winLaunchEnv", "applyWinServiceEnv", bc + "; return buildCtx();")(
        fakeProcess, path, os, (x: string) => x, () => "built", () => "label", d.settleLegacyPorts, d.winLaunchEnv,
        (homeAbs: string) => d.applyWinServiceEnv(homeAbs, fakeProcess.env));
      const written = fs.readFileSync(path.join(h, ".env"), "utf8");
      assert(!/^HTTP_BRIDGE_PORT=/m.test(written), `저장본이 정한 키를 .env 에 고정했다:\n${written}`);
      assert(/^DASHBOARD_PORT=7010$/m.test(written), `어디에도 없는 키는 고정해야 한다:\n${written}`);
      assert.equal(fakeProcess.env.HTTP_BRIDGE_PORT, "7021", "CLI 가 저장본 포트를 써야 한다");
      return `bridge=${fakeProcess.env.HTTP_BRIDGE_PORT}(저장본) · .env 에는 DASHBOARD_PORT 만`;
    });
    test("★저장본이 손상됐으면 고정도 미룬다 — 지금 적으면 저장본을 고친 뒤에도 .env 의 7011 이 그 포트를 가린다", () => {
      const h = fs.mkdtempSync(path.join(home, "settle-bad-"));
      fs.mkdirSync(path.join(h, "data"));
      fs.writeFileSync(path.join(h, "data", "tiguclaw.db"), "");
      fs.writeFileSync(path.join(h, "win-service-env.json"), "{ 깨진");
      const bc = source.slice(source.indexOf("const buildCtx = () => {"), source.indexOf("\n};\n", source.indexOf("const buildCtx = () => {")) + 3);
      const fakeProcess = { platform: "win32", execPath: process.execPath, cwd: () => h, env: { TIGUCLAW_HOME: h, PATH: "C:\\Windows" } as Record<string, string> };
      const ctx = new Function("process", "path", "os", "expandHome", "runtimeMode", "resolveLabel", "settleLegacyPorts", "winLaunchEnv", "applyWinServiceEnv", bc + "; return buildCtx();")(
        fakeProcess, path, os, (x: string) => x, () => "built", () => "label", d.settleLegacyPorts, d.winLaunchEnv,
        (homeAbs: string) => d.applyWinServiceEnv(homeAbs, fakeProcess.env));
      assert(typeof ctx.winEnvError === "string", "손상 사유를 들고 가야 한다");
      assert(!fs.existsSync(path.join(h, ".env")), `.env 에 고정했다:\n${fs.existsSync(path.join(h, ".env")) ? fs.readFileSync(path.join(h, ".env"), "utf8") : ""}`);
      assert(!fs.existsSync(path.join(h, "data", "ports-settled")), "표식을 남겼다 — 고친 뒤에도 다시 판단하지 않는다");
      return "고정 0 · 표식 0 · 사유 있음";
    });
    test("★실패 통지는 마커의 outcome 대로만 말한다 — «되돌리고 다시 띄웠다» 는 실제로 그랬을 때만", () => {
      const un = updateFailedText({ stage: "git status", outcome: "unchanged" });
      const rb = updateFailedText({ stage: "build", outcome: "rolled-back" });
      const nc = updateFailedText({ stage: "build", outcome: "needs-check" });
      const old = updateFailedText({ stage: "build" });
      const claims = (t: string) => /rolled back to the previous version and restarted/.test(t);
      assert(!claims(un) && /nothing was changed/.test(un), un);
      assert(claims(rb), rb);
      assert(!claims(nc) && /tiguclaw update/.test(nc), nc);
      assert(!claims(old), old); // outcome 없는 옛 마커 — 무엇을 했는지 모른다
      // 배선 — 부팅 때 마커를 읽는 자리가 이 함수를 쓴다(고정 문장이 남아 있으면 위 판정이 아무 데도 안 간다).
      const idx = fs.readFileSync(path.join(repo, "src/index.ts"), "utf8");
      assert(/updateFailedText\(data\)/.test(idx) && !/rolled back to the previous version and restarted/.test(idx), "index.ts 가 고정 문장을 쓴다");
      return [un, nc].map((t) => t.slice(0, 70)).join(" | ");
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return checks;
}};
