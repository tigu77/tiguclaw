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
    test("★VBS 는 환경을 심지 않는다 — 심으면 그 값이 «실행 환경» 이 되어 홈 .env 를 이긴다", () => {
      const vbs = d.buildWinVbs(c);
      const envLines = vbs.split("\r\n").filter((l: string) => l.includes('sh.Environment("PROCESS")'));
      assert.equal(envLines.length, 1, envLines.join(" | ")); // node 폴더를 PATH 앞에 세우는 한 줄뿐
      assert(envLines[0].includes('("PATH")') && vbs.includes("--home"));
      assert(!vbs.includes("TOKEN"));
      return `env 줄 ${envLines.length}`;
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
    const simulate = (scenario: Scenario, opts: { notify?: boolean; handoff?: string; resetFails?: boolean; stopFails?: boolean } = {}) => {
      const h = fs.mkdtempSync(path.join(home, "case-")); fs.writeFileSync(path.join(h, "dist.js"), "ok");
      const context = { ...c, homeAbs: h, logsDir: path.join(h, "logs"), distEntry: path.join(h, "dist.js"),
        ...(scenario === "corrupt-env" ? { winEnvError: "win-service-env.json is unreadable (fixture)" } : {}) };
      const marker = path.join(h, ".update-failed");
      const calls: string[] = []; let rev = 0, status = 0, ci = 0; let lockDirty = scenario === "lock-only";
      const processFake = { platform: "win32", execPath: process.execPath, exitCode: 0, stdout: { write: () => {} },
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
        }
        if (cmd === "npm" && args[0] === "ci") {
          ci++; if (scenario !== "success" && scenario !== "lock-only" && ci === 1) { code = 1; stderr = "fixture npm EACCES opaque-fixture-secret"; }
        }
        return { status: code, stdout, stderr };
      };
      const messages: string[] = []; const fakeConsole = { log: (...a: unknown[]) => messages.push(a.join(" ")), error: (...a: unknown[]) => messages.push(a.join(" ")), warn: (...a: unknown[]) => messages.push(a.join(" ")) };
      const fds: number[] = [];
      const names = ["process", "console", "path", "existsSync", "mkdirSync", "openSync", "writeSync", "writeFileSync", "spawnSync", "isDaemonRunning", "isRegistered", "handlers", "warnWinServiceToken", "saveWinServiceEnv", "redactUpdateLog"];
      // 마커가 재가동 **전에** 있었나 — 다시 뜬 데몬이 부팅 때 읽어 통지한다.
      const startMark = (what: string) => () => calls.push(`${what}:${fs.existsSync(marker) ? "marker" : "no-marker"}`);
      const invoke = new Function(...names, body + "; return runUpdate;")(...[
        processFake, fakeConsole, path, fs.existsSync, fs.mkdirSync, (p: string, flags: string) => { const fd = fs.openSync(p, flags); fds.push(fd); return fd; }, fs.writeSync, fs.writeFileSync, spawnSync, () => true, () => true,
        { win32: { stop: () => { calls.push("STOP"); return opts.stopFails === true ? false : true; }, reenable: () => calls.push("REENABLE"), start: startMark("START"), restart: startMark("RESTART") } }, () => {}, () => calls.push("SAVE_ENV"), (text: string) => d.redactUpdateLog(text, processFake.env),
      ]);
      try { invoke(context); } finally { for (const fd of fds) fs.closeSync(fd); }
      const log = fs.readdirSync(path.join(h, "logs")).find((x) => x.startsWith("update-")); assert(log);
      const mk = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : undefined;
      return { calls, messages, exitCode: processFake.exitCode, log: fs.readFileSync(path.join(h, "logs", log), "utf8"), home: h, marker: mk };
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
    test("★예약작업 등록(winEnsureTask)은 capture 를 받았을 때만 붙잡는다 — 업데이트 뒤 재가동(start)이 붙잡으면 데몬 환경이 박힌다", () => {
      const fn = source.slice(source.indexOf("const winEnsureTask = (c, opts = {}) => {"), source.indexOf("\n};\n", source.indexOf("const winEnsureTask = (c, opts = {}) => {")) + 3);
      const runEnsure = (opts?: { capture?: boolean }) => {
        const saves: string[] = [];
        const ensure = new Function("winRemoveLegacyAutostart", "mkdirSync", "warnWinServiceToken", "saveWinServiceEnv", "writeVbs", "winVbsPath", "buildWinVbs",
          "winPs", "psq", "winTaskName", "buildWinTaskScript", "winRemoveStartupFallback", "spawnSync", "console", "winWriteStartupFallback",
          fn + "; return winEnsureTask;")(() => {}, () => {}, () => saves.push("warn"), () => saves.push("save"), () => {}, () => "x.vbs", () => "",
          () => ({ status: 0, stdout: "TASK_REGISTERED", stderr: "" }), (x: string) => x, () => "task", () => "", () => false, () => ({ status: 0 }),
          { log: () => {}, warn: () => {}, error: () => {} }, () => null);
        const mode = ensure(c, opts);
        return { mode, saves };
      };
      const start = runEnsure();
      const install = runEnsure({ capture: true });
      assert.equal(start.mode, true); assert.deepEqual(start.saves, []);
      assert(install.saves.includes("save"));
      return `start 저장 ${start.saves.length} · install 저장 ${install.saves.filter((x) => x === "save").length}`;
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
      const fakeProcess = { platform: "win32", env: { SUPERVISOR_ONLY: "1" }, on: () => {}, exit: () => {}, stdout: { write: () => {} } };
      const run = new Function("process", "spawn", "mkdirSync", "appendFileSync", "path", "execStrings", "winLaunchEnv", "WIN_SERVICE_ENV_KEYS", "Date", "setTimeout",
        sup + "; return runSupervise;")(fakeProcess, spawn, () => {}, () => {}, path, () => ["node", "x"], d.winLaunchEnv, d.WIN_SERVICE_ENV_KEYS,
        // 오래 산 것으로 보이게(스로틀 없이 즉시 재기동) — 시계를 30초씩 민다.
        class extends Date { static t = 0; static now() { this.t += 30_000; return this.t; } }, () => {});
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
      const ctx = new Function("process", "path", "os", "expandHome", "runtimeMode", "resolveLabel", "applyWinServiceEnv", bc + "; return buildCtx();")(
        fakeProcess, path, os, (x: string) => x, () => "built", () => "label",
        // 기본 인자는 모듈의 진짜 process.env 다 — 가짜 환경을 명시해 스위트 프로세스를 오염시키지 않는다.
        (homeAbs: string) => d.applyWinServiceEnv(homeAbs, fakeProcess.env));
      assert.equal(fakeProcess.env.DASHBOARD_PORT, "7020", "CLI 자신에겐 채운다(라벨·포트 판정)");
      assert.equal(ctx.launchEnv.DASHBOARD_PORT, undefined, "감독자용 실행 환경엔 없어야 한다");
      return `CLI=${fakeProcess.env.DASHBOARD_PORT} · launchEnv=${String(ctx.launchEnv.DASHBOARD_PORT)}`;
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
