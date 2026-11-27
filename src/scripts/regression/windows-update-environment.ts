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
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { delegatedUpdateSpawnArgs, formatSelfUpdateResult, notifyDestFromCoords, updateDelegationEnv, updateFailedText, updateOriginSession } from "../../core/self-update.js";
import { makeBootRunner } from "./_update-boot-harness.js";
import { renderResult as renderUpdateSelfResult } from "../../core/llm-runtime/capabilities/update-self-mcp.js";
import { translate } from "../../core/i18n.js";
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
  const identity = await import(new URL("../../../bin/runtime-identity.mjs", import.meta.url).href);
  const contract = await import(new URL("../../../bin/update-marker.mjs", import.meta.url).href);
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
    // 시그니처가 `(c)`(수정 전 대조 사본) · `(c, gate = {})`(§15) 둘 다 — 같은 실행기로 수정 전 빨강을 잰다.
    const runUpdateAt = source.search(/const runUpdate = \(c(, gate = \{\})?\) => \{/);
    const body = source.slice(runUpdateAt, source.indexOf("\n/**\n * @param {Ctx} c\n * @param {string} cmd", runUpdateAt));
    type Scenario = "success" | "npm-fail" | "dirty" | "lock-only" | "rollback-dirty" | "corrupt-env" | "pull-fail";
    type SimOpts = { legacyComplete?: boolean; privateDirect?: boolean; wrongRevision?: boolean; staleAfterResume?: boolean; notify?: boolean; handoff?: string; reportFrom?: string; resetFails?: boolean; stopFails?: boolean; startFails?: "exit" | "throw"; revivedDuringCi?: boolean; platform?: "win32" | "darwin" | "linux";
      // ★2026-11-25 — 늦은 기동: 진짜 winStart 모양(기동 명령 → 안쪽 대기 → reportLaunch)을 지나는 동안엔 아직 안 떴다가 그 뒤 뜬다(late) · 끝내 안 뜬다(never) · 포트는 열렸지만 health 가 안 맞는다(healthDown).
      boot?: "late" | "never"; healthDown?: boolean; thread?: string; seedAttempt?: string; preFailed?: string; claimBeforeUnsent?: boolean; claimBeforeLink?: boolean; healthPendingWaits?: number; healthCostMs?: number; logOpenFail?: boolean; healthPendingUntilMs?: number; gate?: Record<string, unknown>; delegate?: { channel: string; threadKey: string; address?: string; base?: Record<string, string> }; stagedWriteFail?: boolean; linkFail?: boolean; symlinkFail?: boolean; racePublish?: string;
      // v4(§12, 미배포)의 공개 잠금 디렉터리가 남아 있다(lockHeld — 잠금을 쥔 채 강제 종료된 생산자의 잔류물).
      lockHeld?: boolean;
      // Windows 비대체 이동(`winMoveNoReplace` — 실제 PowerShell 대신 같은 의미의 대역): lost-reply = 옮긴 뒤 응답만 잃음(시한) · fail = 못 옮김(접근 거부).
      psMove?: "lost-reply" | "fail";
      // 이동이 성공을 알리지 않은 뒤 임시본 확인(lstat)이 ENOENT 외로 실패한다(공유 끊김·권한) — 공개됐는지 모른다.
      stagedStatFail?: boolean;
      // rename 실패에 코드를 단다 · 옆 보존 이름이 이미 있다(D2 #5).
      renameFailCode?: string; precreateUnsent?: "first" | "first3" | "all"; precreateStaged?: string; raceEach?: boolean; seedPending?: unknown; prePlaced?: Record<string, string>;
      // ★혼합 link 경합(§13): 이 생산자의 link 가 EEXIST 외로 실패한 뒤, 대체 공개(link 아닌 수단)로 고정 경로를 **만들기 직전**에 다른 생산자의 link 가 성공한다.
      otherPublishesBeforeFallback?: string;
      // §14 — 앞선 실행이 남긴 홈을 그대로 이어 쓴다(같은 홈의 두 번째 요청).
      reuseHome?: string;
      // §14 — 생산자가 옆 보존 이름을 빈 예약(`wx`)으로 만들 때마다, rename 으로 채우기 **전에** 부팅 소비자가 그 이름을 선점해 간다(소비자의 선점과 같은 rename).
      claimReservations?: boolean;
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
      const h = opts.reuseHome ?? fs.mkdtempSync(path.join(home, "case-")); fs.writeFileSync(path.join(h, "dist.js"), "ok");
      // 의존성 케이스는 자기 레포를 쓴다(공유 fakeRepo 에 node_modules 를 만들면 다른 케이스가 오염된다).
      const repoRoot = opts.deps !== undefined || opts.leftovers !== undefined ? path.join(h, "repo") : fakeRepo;
      const shared = path.join(h, "shared-deps");
      if (repoRoot !== fakeRepo) {
        fs.mkdirSync(repoRoot);
        for (const l of opts.leftovers ?? []) { fs.mkdirSync(path.join(repoRoot, l)); fs.writeFileSync(path.join(repoRoot, l, "marker.txt"), l); }
        if (opts.deps === "tree") { fs.mkdirSync(path.join(repoRoot, "node_modules", "sdk"), { recursive: true }); fs.writeFileSync(path.join(repoRoot, "node_modules", "sdk", "marker.txt"), "old-tree"); }
        if (opts.deps === "link") { fs.mkdirSync(path.join(shared, "sdk"), { recursive: true }); fs.writeFileSync(path.join(shared, "sdk", "marker.txt"), "shared-tree");
          // Windows 는 junction — 디렉터리 symlink 는 권한(개발자 모드·관리자)이 있어야 만들어져 EPERM 이었다(Windows 실측 10-30). 현장의 링크된
          //  node_modules 도 대개 junction 이고, 제품 판정(`lstatSync().isSymbolicLink()`·`unlinkSync`)이 그것을 링크로 다뤄야 한다 — 검사는 그대로다.
          fs.symlinkSync(shared, path.join(repoRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir"); }
      }
      const context = { ...c, repoRoot, homeAbs: h, logsDir: path.join(h, "logs"), distEntry: path.join(h, "dist.js"),
        ...(scenario === "corrupt-env" ? { winEnvError: "win-service-env.json is unreadable (fixture)" } : {}) };
      const nm = path.join(repoRoot, "node_modules");
      const short = (p: string) => path.basename(p).replace(/-\d+$/, "-N");
      const marker = path.join(h, ".update-failed");
      if(opts.legacyComplete || opts.privateDirect) fs.writeFileSync(path.join(h,opts.legacyComplete?".update-complete":".update-pending"),JSON.stringify({mode:"direct",state:"ready",...(opts.seedAttempt?{attempt:opts.seedAttempt}:{}),notify:{channel:"legacy-destination",target:"original-target"}}));
      if(opts.preFailed!==undefined)fs.writeFileSync(marker,opts.preFailed);
      if(opts.seedPending!==undefined)fs.writeFileSync(path.join(h,".update-pending"),JSON.stringify(opts.seedPending));
      for(const [n,v] of Object.entries(opts.prePlaced??{}))fs.writeFileSync(path.join(h,n),v);
      const publishLock = path.join(h, ".update-failed.lock");
      if (opts.lockHeld === true) fs.mkdirSync(publishLock);
      const markerObservations: {legacy:boolean;pending:any}[]=[];
      const observeMarker=()=>{let pending;try{pending=JSON.parse(fs.readFileSync(path.join(h,".update-pending"),"utf8"));}catch{}markerObservations.push({legacy:fs.existsSync(path.join(h,".update-complete")),pending});};
      const calls: string[] = []; let rev = 0, status = 0, ci = 0, build = 0; let lockDirty = scenario === "lock-only";
      // 데몬이 떠 있나 — 멈추면 내려가고, `revivedDuringCi` 면 설치 도중 무언가가 다시 띄운다(2026-10-19 윈도우돌쇠 실측).
      let running = true; let launched = false; let generation = "old"; let processStartedAt = Date.now() - 1000;
      // «업데이트 중» 표식 — 종료 처리기는 모아 뒀다가 끝에 부른다(진짜 프로세스 종료를 흉내).
      const lockFile = path.join(h, ".update-in-progress"); const exitHandlers: (() => void)[] = [];
      const lockState = () => (fs.existsSync(lockFile) ? "lock" : "no-lock");
      const processFake = { platform: opts.platform ?? "win32", execPath: process.execPath, pid: process.pid, exitCode: 0, stdout: { write: () => {} },
        on: (ev: string, fn: () => void) => { if (ev === "exit") exitHandlers.push(fn); },
        env: { HTTP_BRIDGE_TOKEN: "opaque-fixture-secret", ...(opts.notify ? { TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "fixture", TIGUCLAW_UPDATE_NOTIFY_TARGET: "original-target", ...(opts.thread !== undefined ? { TIGUCLAW_UPDATE_NOTIFY_THREAD: opts.thread } : {}) } : {}),
          ...(opts.handoff ? { TIGUCLAW_UPDATE_PREV_SHA: opts.handoff } : {}),
          // 실제 요청 좌표(`notifyDestFromCoords`) → 실제 위임 env 함수가 만든 **그 객체**를 CLI 가 받는다(구현 검토 I1 #7).
          ...(opts.delegate !== undefined ? delegatedUpdateSpawnArgs({ notify: notifyDestFromCoords(opts.delegate.channel, opts.delegate.threadKey, opts.delegate.address) }, "1111111", "1111111", opts.delegate.base ?? {}).options.env : {}), ...(opts.reportFrom !== undefined ? { TIGUCLAW_UPDATE_REPORT_FROM: opts.reportFrom } : {}) } };
      const spawnSync = (cmd: string, args: string[]) => {
        observeMarker(); calls.push([cmd, ...args].join(" ")); let stdout = "", stderr = "", code = 0;
        if (cmd === "git" && args[0] === "rev-parse") stdout = ++rev === 1 ? "1111111" : "2".repeat(40);
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
          if (opts.revivedDuringCi === true) { running = true; generation = "intermediate"; processStartedAt = Date.now() - 1; }
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
      // 다른 생산자의 link 공개가 이 생산자의 대체 공개 직전에 끼어든다(한 번) — 그 이름을 만드는 것은 link 와 같은 «새 이름 생성» 이다.
      // 옆 보존 이름이 이미 있다(D2 #5) — 그 원문은 그대로여야 하고 이번 것은 다른 이름으로(파일 · 디렉터리 기록이면 비지 않은 디렉터리로 미리 둔다).
      const precreateAside = (to: string, asDir = false) => {
        if (opts.precreateUnsent === undefined || !to.includes(".update-failed.unsent-") || fs.existsSync(to)) return;
        if (opts.precreateUnsent !== "all" && calls.filter((x) => x.startsWith("PRECREATED-UNSENT:")).length >= (opts.precreateUnsent === "first3" ? 3 : 1)) return;
        if (asDir) { fs.mkdirSync(to); fs.writeFileSync(path.join(to, "record.json"), `preserved-${path.basename(to)}`); } else fs.writeFileSync(to, `preserved-${path.basename(to)}`);
        calls.push(`PRECREATED-UNSENT:${path.basename(to)}`);
      };
      // 쓸기 대상 이름(`.unsent-*`)에 나타난 순간의 내용 — 완성본만 보여야 한다(빈 예약 0 — §15 D1 #8).
      const asideSeen: { name: string; complete: boolean }[] = [];
      const observeAside = (to: string) => {
        if (!to.includes(".update-failed.unsent-")) return;
        const file = fs.statSync(to).isDirectory() ? path.join(to, "record.json") : to;
        let complete = false; try { complete = typeof JSON.parse(fs.readFileSync(file, "utf8")).stage === "string"; } catch { /* 빈/깨진 */ }
        asideSeen.push({ name: path.basename(to), complete });
      };
      const otherLinks = () => { if (opts.otherPublishesBeforeFallback !== undefined && !fs.existsSync(marker) && !calls.includes("OTHER-LINKED")) { fs.writeFileSync(marker, opts.otherPublishesBeforeFallback); calls.push("OTHER-LINKED"); } };
      // 진짜 fs 위에 실패만 골라 넣는다 — 무엇을 옮기고 지웠는지 기록한다.
      const renameW = (a: string, b: string) => {
        // 생산자가 옛 실패를 읽은 뒤 옮기기 직전에 부팅 소비자가 먼저 선점했다 — 실제 ENOENT(code 포함)로 흉내.
        if (opts.claimBeforeUnsent === true && a.endsWith(".update-failed") && b.includes(".unsent-")) { fs.renameSync(a, `${a}.claim-sim`); calls.push("CLAIMED-BY-CONSUMER"); throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" }); }
        if (opts.renameFail?.(a, b) === true) { calls.push(`MV-FAIL:${short(a)}>${short(b)}`); throw Object.assign(new Error(`${opts.renameFailCode ?? "EPERM"}: rename failed '${short(a)}' (fixture)`), opts.renameFailCode !== undefined ? { code: opts.renameFailCode } : {}); }
        // 완성본을 고정 경로로 옮기는(link 불가 폴백) 순간 공개 잠금이 있었나 — 잠금 밖 rename 공개는 I3-1 의 덮어쓰기다.
        if (a.includes(".update-failed.next-") && b.endsWith(".update-failed")) { otherLinks(); calls.push(`PUBLISH-BY-RENAME:${fs.existsSync(publishLock) ? "locked" : "UNLOCKED"}`); }
        if (a.endsWith(".d") && b.includes(".update-failed.unsent-")) precreateAside(b, true);
        fs.renameSync(a, b); calls.push(`MV:${short(a)}>${short(b)}`);
        observeAside(b);
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
        "lstatSync", "readdirSync", "renameSync", "unlinkSync", "sleepSync", "healthSaysOurs", "UPDATE_SLOT_WAIT_MS", "monoNow", "listeningOnBridge", "expectFreshLaunch", "waitForListening", "reportLaunch", "UPDATE_PENDING_MARKER", "updateBootMatches", "updateMarkerMatches", "instanceIdFor", "readFileSync", "randomUUID", "linkSync", "rmdirSync", "winMoveNoReplace", "symlinkSync"];
      // 마커가 재가동 **전에** 있었나 — 다시 뜬 데몬이 부팅 때 읽어 통지한다.
      const startMark = (what: string) => () => calls.push(`${what}:${fs.existsSync(marker) ? "marker" : "no-marker"}`, `${what}@${lockState()}`);
      const presenceFake = opts.presence === undefined ? {} : { presence: () => { calls.push("PRESENCE"); return { state: opts.presence, pids: opts.presence === "running" ? ["777"] : [], why: "fixture: process list query failed" }; } };
      // 재가동 실패 — 진짜 start 는 `reportLaunch` 로 exitCode 1 을 세우거나(launch 확인 실패) `execFileSync` 가 던진다(launchctl·systemctl).
      const launch = (what: string) => () => { observeMarker(); startMark(what)();
        if (opts.boot !== undefined) { report(context, wait(context, probe, 0), "started", "inner"); calls.push(`INNER:${processFake.exitCode}`); if (opts.boot === "never") { if (opts.startFails === "exit") processFake.exitCode = 1; return; } }
        running = true; launched = true; generation = "fresh"; processStartedAt = opts.staleAfterResume ? 1 : Date.now(); if (opts.startFails === "exit") processFake.exitCode = 1; if (opts.startFails === "throw") throw new Error("fixture: launchctl load failed"); };
      const ops = { stop: () => { calls.push("STOP"); if (opts.stopFails !== true) running = false; return opts.stopFails === true ? false : true; }, reenable: () => calls.push("REENABLE"), start: launch("START"), restart: launch("RESTART") };
      // 진짜 표: 표에 적힌 이름마다 가짜를 넣되 정지·기동은 위 기록기로, 존재 판정만 진짜 본문(스캔 결과 주입)으로.
      const realTable = () => {
        const winPresence = new Function("winScan", presenceSrc + "; return winPresence;")(() => { calls.push("SCAN"); return opts.scan; });
        const byName: Record<string, unknown> = { winStop: ops.stop, winReenable: ops.reenable, winStart: ops.start, winRestart: ops.restart, winPresence,
          darwinStop: ops.stop, darwinStart: ops.start, darwinRestart: ops.restart };
        return new Function(...handlerNames, handlersSrc + "; return handlers;")(...handlerNames.map((n) => byName[n] ?? (() => calls.push(`UNEXPECTED:${n}`))));
      };
      const table = opts.scan !== undefined ? realTable() : ((t: unknown) => ({ win32: t, darwin: t, linux: t }))({ ...ops, ...presenceFake });
      const one = (name: string) => source.slice(source.indexOf(`const ${name} = (`), source.indexOf("\n};", source.indexOf(`const ${name} = (`)) + 3);
      // 데몬이 직전 업데이트 결과를 처리 중 — 정지 직전 확인의 대기(SETTLE-WAIT)가 이 횟수에 닿을 때까지 참(§15).
      // 가상 단조 시계 — 수면은 그만큼, `/health` 조회는 `healthCostMs` 만큼 흐른다(조회가 느려도 상한은 실제 경과로 — §15 I1 #4).
      const clock = { t: 0 };
      const health = () => ({ ...((clock.t += opts.healthCostMs ?? 0), {}), ...(opts.healthPendingWaits !== undefined ? { updateResultsPending: calls.filter((x) => x === "SETTLE-WAIT").length < opts.healthPendingWaits } : {}),
        ...(opts.healthPendingUntilMs !== undefined ? { updateResultsPending: clock.t < opts.healthPendingUntilMs } : {}), ok: running && (launched || opts.portClosed !== true) && !(opts.healthDown === true && launched), why: running ? "fixture health" : "no answer (ECONNREFUSED)", instanceId: identity.instanceIdFor({home:context.homeAbs,repoRoot:context.repoRoot,runtime:context.runtime}), revision: (opts.wrongRevision && launched ? "3" : "2").repeat(40), bootId: ({old:"11111111-1111-4111-8111-111111111111",intermediate:"22222222-2222-4222-8222-222222222222",fresh:"33333333-3333-4333-8333-333333333333"} as Record<string,string>)[generation], startedAt: processStartedAt });
      const probe = () => ({ pids: running && opts.portClosed !== true ? ["777"] : [] });
      const capture = new Function("healthSaysOurs", one("expectFreshLaunch") + ";return expectFreshLaunch;")(health);
      const wait = new Function("healthSaysOurs", "sleepSync", "updateBootMatches", one("waitForListening") + ";return waitForListening;")(health, () => {}, contract.updateBootMatches);
      const report = new Function("process", "console", "winPort", one("reportLaunch") + ";return reportLaunch;")(processFake, fakeConsole, () => "7021");
      const invoke = new Function(...names, body + "; return runUpdate;")(...[
        processFake, fakeConsole, path, fs.existsSync, (p: string, ...a: unknown[]) => { if (String(p).endsWith(".update-failed.lock")) calls.push("MKDIR-LOCK"); return (fs.mkdirSync as (...x: unknown[]) => unknown)(p, ...a); }, (p: string, flags: string) => { if (opts.logOpenFail === true && p.includes(`${path.sep}logs${path.sep}update-`)) throw Object.assign(new Error("EACCES: permission denied, open (fixture)"), { code: "EACCES" }); const fd = fs.openSync(p, flags); fds.push(fd); return fd; }, fs.writeSync,
        (p: string, ...a: unknown[]) => {
          if (opts.stagedWriteFail === true && p.includes(".update-failed.next-")) throw new Error("ENOSPC: no space left on device (fixture)");
          // 고정 경로를 직접 쓰는 공개는 없어야 한다(쓰는 중인 원문이 보이거나 덮는다) — 있으면 남겨 단언이 잡게 한다.
          if (p === marker) calls.push(`PUBLISH-BY-WRITE:${(a[1] as { flag?: string } | undefined)?.flag ?? "w"}`);
          // 계산된 바로 그 임시 경로에 앞선 원문이 이미 있다 — 배타 생성이면 그 바이트가 그대로여야 한다.
          if (opts.precreateStaged !== undefined && p.includes(".update-failed.next-") && !fs.existsSync(p)) { fs.writeFileSync(p, opts.precreateStaged); calls.push(`PRECREATED:${path.basename(p)}`); }
          if (opts.precreateUnsent !== undefined && p.includes(".update-failed.unsent-") && !fs.existsSync(p) && (opts.precreateUnsent === "all" || calls.filter((x) => x.startsWith("PRECREATED-UNSENT:")).length < (opts.precreateUnsent === "first3" ? 3 : 1))) { fs.writeFileSync(p, `preserved-${path.basename(p)}`); calls.push(`PRECREATED-UNSENT:${path.basename(p)}`); }
          (fs.writeFileSync as (...x: unknown[]) => void)(p, ...a);
          // 쓸기 이름에 직접 쓰는 순간도 관측한다 — 빈 예약(종전 `moveAside`)이면 미완성으로 잡힌다.
          if (p.includes(".update-failed.unsent-")) { let complete = false; try { complete = typeof JSON.parse(String(a[0])).stage === "string"; } catch { /* 빈·깨진 */ } asideSeen.push({ name: path.basename(p), complete }); }
          if (opts.claimReservations === true && p.includes(".update-failed.unsent-") && a[0] === "") { const n = calls.filter((x) => x.startsWith("CLAIMED-RESERVATION:")).length; fs.renameSync(p, `${marker}.claim-sim-res-${n}`); calls.push(`CLAIMED-RESERVATION:${n}`); }
        }, spawnSync, () => running && opts.portClosed !== true, () => opts.registered !== false,
        table, () => {}, () => calls.push("SAVE_ENV"), (text: string) => d.redactUpdateLog(text, processFake.env),
        rmW, d.updateLockPath,
        (p: string, ...a: unknown[]) => { if (p.endsWith(".update-failed")) calls.push("LSTAT-FIXED");
          if (opts.stagedStatFail === true && p.includes(".update-failed.next-")) { calls.push(`LSTAT-STAGED-FAIL:${p}`); throw Object.assign(new Error("EACCES: permission denied, lstat (fixture)"), { code: "EACCES" }); }
          return (fs.lstatSync as (...x: unknown[]) => unknown)(p, ...a); },
        fs.readdirSync, renameW, unlinkW,
        // 잠은 즉시 — 100ms 잠(v4 의 공개 잠금 대기 간격)은 남겨 «기다리지 않는다» 를 단언한다.
        (ms: number) => { clock.t += ms; if (ms === 100) calls.push("LOCK-WAIT"); if (ms === 250) calls.push("SETTLE-WAIT"); }, health, contract.UPDATE_SLOT_WAIT_MS, () => clock.t, probe,
        (ctx: unknown, old: string[]) => { calls.push(`CAPTURE:${build}:${generation}`); return capture(ctx, old); },
        (ctx: unknown, p: unknown) => wait(ctx, p, 0), report,
        contract.UPDATE_PENDING_MARKER, contract.updateBootMatches, contract.updateMarkerMatches, identity.instanceIdFor, fs.readFileSync, randomUUID,
        (a: string, b: string) => {
          // 다른 생산자가 «비어 있음» 을 본 뒤 먼저 공개했다 — 대체하지 않는 공개라면 EEXIST 가 나야 한다(link 실패와도 겹쳐 본다).
          if (opts.racePublish !== undefined && b.endsWith(".update-failed") && !fs.existsSync(b) && !calls.includes("RACE")) { fs.writeFileSync(b, opts.racePublish); calls.push("RACE"); }
          // 공개할 때마다 다른 생산자가 먼저 채운다(재시도마다 EEXIST).
          if (opts.raceEach === true && b.endsWith(".update-failed") && !fs.existsSync(b)) { const n = calls.filter((x) => x.startsWith("RACE-")).length + 1; fs.writeFileSync(b, JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: `race-${n}` })); calls.push(`RACE-${n}`); }
          // 공개 직전 부팅 소비자가 고정 경로의 앞선 기록을 선점해 간다(rename) — 비었으니 이번 것이 고정 경로에 놓여야 한다.
          if (opts.claimBeforeLink === true && b.endsWith(".update-failed") && fs.existsSync(b) && !calls.includes("CLAIMED-BY-CONSUMER")) { fs.renameSync(b, `${b}.claim-sim`); calls.push("CLAIMED-BY-CONSUMER"); }
          precreateAside(b);
          if (opts.linkFail === true) { calls.push("LINK-FAIL"); throw Object.assign(new Error("EPERM: operation not permitted, link (fixture)"), { code: "EPERM" }); }
          fs.linkSync(a, b); calls.push(`LINK:${path.basename(a).replace(/\.next-.*/, ".next-*")}>${path.basename(b).replace(/\.unsent-.*/, ".unsent-*")}`);
          observeAside(b);
        },
        (p: string) => { calls.push(`RMDIR:${path.basename(p)}`); fs.rmdirSync(p); },
        // Windows 비대체 이동의 대역 — `MoveFileEx`(REPLACE_EXISTING 없이)와 같은 뜻: 자리가 차 있으면 «exists», 아니면 원자적으로 옮긴다(단일 스레드라 확인+이동이 끊기지 않는다).
        //  실제 PowerShell 스크립트의 문자열은 아래 별도 검사가, 실제 의미는 Windows 인계 검증이 본다.
        (from: string, to: string) => {
          otherLinks(); precreateAside(to); calls.push(`PS-MOVE:${path.basename(from).replace(/\.next-.*/, ".next-*")}>${path.basename(to).replace(/\.unsent-.*/, ".unsent-*")}`);
          if (opts.psMove === "fail") return "Access to the path is denied. (exit 1)";
          if (fs.existsSync(to)) return "exists";
          fs.renameSync(from, to); observeAside(to);
          return opts.psMove === "lost-reply" ? "PowerShell did not respond — gave up after 30s (exit none)" : "moved";
        },
        // 상대 symlink 공개(§16 b — POSIX link 불가 홈). symlinkFail = 링크도 못 만드는 볼륨(Linux vfat 등) — EPERM.
        (target: string, at: string) => {
          if (opts.racePublish !== undefined && at.endsWith(".update-failed") && !fs.existsSync(at) && !calls.includes("RACE")) { fs.writeFileSync(at, opts.racePublish); calls.push("RACE"); }
          if (opts.symlinkFail === true) { calls.push("SYMLINK-FAIL"); throw Object.assign(new Error("EPERM: operation not permitted, symlink (fixture)"), { code: "EPERM" }); }
          fs.symlinkSync(target, at); calls.push(`SYMLINK:${target.replace(/\.next-.*/, ".next-*")}>${path.basename(at)}`);
        },
      ]);
      let returned: unknown;
      try { returned = invoke(context, opts.gate === undefined ? undefined : { env: processFake.env, ...opts.gate }); } finally { for (const fd of fds) fs.closeSync(fd); }
      const lockAfterRun = lockState(); for (const fn of exitHandlers) fn(); const lockAfterExit = lockState();
      const log = fs.existsSync(path.join(h, "logs")) ? fs.readdirSync(path.join(h, "logs")).find((x) => x.startsWith("update-")) : undefined; assert(log !== undefined || opts.logOpenFail === true);
      const mk = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : undefined;
      const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return "(none)"; } };
      const markerIn = (dir: string) => (fs.existsSync(path.join(dir, "sdk", "marker.txt")) ? read(path.join(dir, "sdk", "marker.txt")) : read(path.join(dir, "marker.txt")));
      const entries = repoRoot === fakeRepo ? [] : fs.readdirSync(repoRoot).filter((x) => x.startsWith(".node_modules")).map((x) => ({ name: x.replace(/-\d+$/, "-N"), marker: markerIn(path.join(repoRoot, x)) }));
      const depsNow = repoRoot === fakeRepo ? "(n/a)" : read(path.join(nm, "sdk", "marker.txt"));
      const sharedNow = opts.deps === "link" ? { marker: read(path.join(shared, "sdk", "marker.txt")), files: fs.readdirSync(shared).join(",") } : undefined;
      return { returned, asideSeen, markerObservations, completion: JSON.parse(read(path.join(h,".update-pending")) === "(none)" ? "null" : read(path.join(h,".update-pending"))), calls, messages, exitCode: processFake.exitCode, log: log === undefined ? "" : fs.readFileSync(path.join(h, "logs", log), "utf8"), home: h, marker: mk, lockAfterRun, lockAfterExit, depsNow, entries, sharedNow, ci, build };
    };
    test("actual CLI completion: private pending before boot, exact final boot and destination; legacy never exposed", () => {
      for(const seed of [{legacyComplete:true},{privateDirect:true}]) {
        const r=simulate("success",seed);
        assert.equal(r.exitCode,0);assert.equal(r.completion?.state,"confirmed");
        assert(contract.updateMarkerMatches(r.completion,r.completion.confirmed));
        assert.equal(r.completion.notify.target,"original-target");
        assert(r.markerObservations.every(o=>!o.legacy));
        assert(r.markerObservations.some(o=>o.pending?.expected===null&&o.pending?.state==="pending"));
        assert(r.markerObservations.some(o=>o.pending?.expected?.revision==="2".repeat(40)&&o.pending?.state==="pending"));
        assert(!fs.existsSync(path.join(r.home,".update-complete")));
      }
      return "real runUpdate + synthetic fs; legacy/direct preclaim, final exact boot";
    });
    test("actual CLI wrong revision / launch failure: success0, backup kept, original failure destination", () => {
      for(const fault of [{wrongRevision:true},{startFails:"exit" as const},{staleAfterResume:true}]) {
        const r=simulate("success",{legacyComplete:true,deps:"tree",...fault});
        assert.equal(r.exitCode,1);assert.equal(r.completion?.state,"failed");
        assert.equal(r.marker?.notify.target,"original-target");assert.equal(r.marker?.stage,"restart");
        assert(r.entries.some(e=>e.marker==="old-tree"));
        assert(!r.messages.some(m=>m.includes("✅ update complete")));
        assert(!contract.updateMarkerMatches(r.completion,r.completion.confirmed));
      }
      const rollback=simulate("npm-fail",{legacyComplete:true});
      assert.equal(rollback.marker?.notify.target,"original-target");
      assert(!contract.updateMarkerMatches(rollback.completion,rollback.completion?.confirmed));
      return "revision/cutoff/start rejection + rollback, original destination";
    });
    // ── 2026-11-25 Windows 운영 관측: 안쪽 대기 뒤 늦게 뜬 새 데몬 — 최종 판정·귀속·이음매 ─────────────────────────
    const bootRunner = await makeBootRunner(repo);
    const fspReal = { readFile: (n: string) => fs.promises.readFile(n, "utf8"), writeFile: (n: string, raw: string) => fs.promises.writeFile(n, raw, "utf8"),
      unlink: (n: string) => fs.promises.unlink(n), rename: (a: string, b: string) => fs.promises.rename(a, b), readdir: (dir: string) => fs.promises.readdir(dir) };
    // 실제 runUpdate 가 쓴 홈 파일을 실제 부팅 소비 영역(실제 발원 세션 판정·실제 실패 문구)으로 넘긴다. 시계는 가상.
    const consumeAt = async (r: ReturnType<typeof simulate>, boot: unknown) => {
      const k = { t: 0 };
      return bootRunner({ fsp: fspReal, home: r.home, boot, updateOriginSession, updateFailedText, translate, now: () => k.t, sleep: async (ms) => { k.t += ms; } });
    };
    const laterBoot = (r: ReturnType<typeof simulate>) => ({ instanceId: r.completion?.expected?.instanceId, bootId: "44444444-4444-4444-8444-444444444444", startedAt: Date.now(), revision: "2".repeat(40) });
    test("★늦은 기동: 안쪽 대기 미확인 뒤 최종 대기가 새 부팅을 확인하면 exit 0 · confirmed · 실패 마커 0 → 요청 세션에 성공 1·실패 0", () => {
      const r = simulate("success", { notify: true, thread: "dashboard:side", boot: "late", deps: "tree" });
      assert(r.calls.includes("INNER:0"), `안쪽 대기가 실패 코드를 세웠다: ${r.calls.join(" | ")}`);
      assert(r.messages.some((m) => /not confirmed yet/.test(m)), r.messages.join("\n"));
      assert.equal(r.exitCode, 0, r.messages.join("\n")); assert.equal(r.completion?.state, "confirmed"); assert.equal(r.marker, undefined);
      assert(!r.messages.some((m) => m.includes("🔴")), r.messages.join("\n"));
      assert(!r.entries.some((e) => e.marker === "old-tree"), "성공인데 옛 트리를 남겼다");
      return "exit0·confirmed";
    });
    test("★이음매: 위임 env(실제 함수) → 실제 CLI 가 쓴 원문 → 실제 부팅 소비 — 늦은 성공·무응답·포트만·구 revision·런처 오류", () => {
      const env = updateDelegationEnv({ STALE: "x" }, { prevSha: "1111111", reportFrom: "1111111", notify: { channel: "fixture", target: "original-target", threadKey: "dashboard:side" } });
      assert.equal(env.TIGUCLAW_UPDATE_NOTIFY_THREAD, "dashboard:side"); assert.equal(env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL, "fixture"); assert.equal(env.TIGUCLAW_UPDATE_NOTIFY_TARGET, "original-target");
      const noThread = updateDelegationEnv({ TIGUCLAW_UPDATE_NOTIFY_THREAD: "leaked" }, { prevSha: "1111111", reportFrom: "1111111", notify: { channel: "fixture", target: null } });
      assert.equal(noThread.TIGUCLAW_UPDATE_NOTIFY_THREAD, "", "데몬 환경에 남은 세션이 새어 들었다");
      // 좌표 없는 요청(HTTP `/update`)은 데몬이 물려받은 옛 좌표를 싣지 않는다(구현 검토 I1 #2).
      const bare = updateDelegationEnv({ TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "telegram", TIGUCLAW_UPDATE_NOTIFY_TARGET: "old-chat", TIGUCLAW_UPDATE_NOTIFY_THREAD: "dashboard:old", PATH: "keep" }, { prevSha: "1111111", reportFrom: "1111111" });
      assert(bare.TIGUCLAW_UPDATE_NOTIFY_CHANNEL === undefined && bare.TIGUCLAW_UPDATE_NOTIFY_TARGET === undefined && bare.TIGUCLAW_UPDATE_NOTIFY_THREAD === undefined && bare.PATH === "keep", JSON.stringify(bare));
      // `/update` 의 좌표 함수(index.ts)를 실제로 돌린다 — 세 갈래 모두 요청 세션을 싣는다.
      const idx = fs.readFileSync(path.join(repo, "src/index.ts"), "utf8");
      const nd = idx.slice(idx.indexOf("const notifyDestFromMessage = ("), idx.indexOf("\n};\n", idx.indexOf("const notifyDestFromMessage = (")) + 3);
      const js = ts.transpileModule(nd, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const mk = (meta: unknown) => new Function("getSessionChannelMeta", "SESSION_STORAGE_CHANNEL", "telegramTargetFor", js + ";return notifyDestFromMessage;")(() => meta, "fixture-store", () => "tg-chat");
      const cap = mk(null)("telegram", "dashboard:side", "chat-9"), viaMeta = mk({ lastChannel: "telegram", lastChannelTarget: "chat-8" })("telegram", "dashboard:side"), fb = mk(null)("telegram", "dashboard:side");
      assert(cap.threadKey === "dashboard:side" && cap.target === "chat-9" && viaMeta.threadKey === "dashboard:side" && viaMeta.target === "chat-8" && fb.threadKey === "dashboard:side" && fb.target === "tg-chat", JSON.stringify({ cap, viaMeta, fb }));
      return "env ok";
    });
    const seam: Array<[string, SimOpts, "success" | "restart-unconfirmed" | "restart-error"]> = [
      ["late boot", { boot: "late" }, "success"],
      ["never answers", { boot: "never" }, "restart-unconfirmed"],
      ["port only (health mismatch)", { healthDown: true }, "restart-unconfirmed"],
      ["old revision", { wrongRevision: true }, "restart-unconfirmed"],
      ["launcher error then verified", { boot: "late", startFails: "exit" }, "restart-error"],
      ["launcher error, never answers", { boot: "never", startFails: "exit" }, "restart-unconfirmed"],
    ];
    for (const [label, fault, want] of seam) {
      checks.push(await (async () => {
        const name = `★이음매 ${label}: CLI exit·마커·부팅 소비 (성공,실패) 개수와 귀속`;
        try {
          const r = simulate("success", { delegate: { channel: "fixture", threadKey: "dashboard:side", address: "original-target", base: { TIGUCLAW_UPDATE_NOTIFY_CHANNEL: "stale", TIGUCLAW_UPDATE_NOTIFY_TARGET: "stale-chat", TIGUCLAW_UPDATE_NOTIFY_THREAD: "dashboard:stale" } }, ...fault });
          const boot = want === "success" ? r.completion?.confirmed : laterBoot(r);
          const b = await consumeAt(r, boot);
          const success = b.deliveries.filter((d) => /Update complete/.test(d.text)), failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          assert.equal(r.exitCode, want === "success" ? 0 : 1, r.messages.join("\n"));
          assert.equal(success.length, want === "success" ? 1 : 0, JSON.stringify(b.deliveries)); assert.equal(failure.length, want === "success" ? 0 : 1, JSON.stringify(b.deliveries));
          assert.equal(b.restart.length, 0);
          for (const d of b.deliveries) { assert.equal(d.channel, "fixture"); assert.equal(d.target, "original-target"); assert.equal(d.observeThreadKey, "dashboard:side"); assert.equal(d.originThreadKey, "dashboard:side"); }
          if (want !== "success") {
            assert.equal(r.marker?.outcome, want); assert.equal(r.marker?.stage, "restart"); assert.equal(r.marker?.attempt, r.completion?.attempt);
            assert(failure[0]!.text.includes("No rollback was attempted") && !/could not be fully restored/.test(failure[0]!.text), failure[0]!.text);
            // CLI 마지막 요약도 같은 판정(구현 검토 I1 #6) — «실행 중» 과 «영영 안 뜸» 을 동시에 말하지 않는다.
            const summary = r.messages.find((m) => m.startsWith("🔴 The update was applied")) ?? "";
            assert(want === "restart-error" ? /new version is running/.test(summary) : /could not be confirmed/.test(summary), summary);
            assert(!/will not come back on its own/.test(summary), summary);
          }
          assert(!fs.existsSync(path.join(r.home, ".update-failed")), "실패 마커가 소비되지 않았다");
          const again = await consumeAt(r, { ...laterBoot(r), bootId: "55555555-5555-4555-8555-555555555555" });
          assert.equal(again.deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "같은 시도를 다음 부팅이 또 보냈다");
          return { name, ok: true, got: `exit=${r.exitCode} (${success.length},${failure.length}) outcome=${r.marker?.outcome ?? "-"}` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
    }
    test("옛 데몬에서 시작한 업데이트(세션 env 없음) · 옛 pending(시도 없음) 계승 — 세션을 지어내지 않고, 새 시도 id 를 쓴다", () => {
      const r = simulate("success", { notify: true, boot: "never" });
      assert.equal(r.marker?.notify?.threadKey, undefined); assert.equal(r.completion?.notify?.threadKey, undefined);
      assert(typeof r.marker?.attempt === "string" && r.marker.attempt === r.completion?.attempt, JSON.stringify(r.marker));
      const inherited = simulate("success", { privateDirect: true, seedAttempt: "seed-attempt", boot: "never" });
      assert.equal(inherited.marker?.attempt, "seed-attempt", "env 없이 물려받은 좌표면 그 시도 id 를 잇는다");
      const fresh = simulate("success", { privateDirect: true, seedAttempt: "seed-attempt", notify: true, boot: "never" });
      assert(fresh.marker?.attempt !== "seed-attempt" && fresh.marker?.notify?.channel === "fixture", "새 env 좌표에 옛 시도 id 를 붙였다");
      const legacySeed = simulate("success", { privateDirect: true, boot: "never" });
      assert(typeof legacySeed.marker?.attempt === "string" && legacySeed.marker.attempt.length > 0);
      return "ok";
    });
    test("★롤백 뒤 재가동 미확인·명령 예외 — 마커는 rolled-back(재기동 단정 없음) · CLI 로그가 미확인을 가른다 · 예외가 CLI 밖으로 안 나간다", () => {
      const un = simulate("npm-fail", { notify: true, boot: "never" });
      assert.equal(un.marker?.outcome, "rolled-back"); assert.equal(un.exitCode, 1);
      assert(un.messages.some((m) => /rolled back to 1111111, but the restart was not confirmed/.test(m)), un.messages.join("\n"));
      const th = simulate("npm-fail", { notify: true, startFails: "throw" });
      assert.equal(th.exitCode, 1); assert(th.messages.some((m) => /but the restart command failed/.test(m)), th.messages.join("\n"));
      const ok = simulate("npm-fail", { notify: true, boot: "late" });
      assert(!ok.messages.some((m) => /restart was not confirmed/.test(m)), ok.messages.join("\n"));
      return "ok";
    });
    test("★다른 시도의 미소비 실패는 그 자리에 그대로(§15 G3) — 이번 실패만 옆 보존(완성본)·로그", () => {
      const pre = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier" });
      const r = simulate("npm-fail", { notify: true, preFailed: pre } as SimOpts);
      assert.equal(fs.readFileSync(path.join(r.home, ".update-failed"), "utf8"), pre, "앞선 기록을 옮기거나 바꿨다");
      const kept = fs.readdirSync(r.home).filter((n) => n.startsWith(".update-failed.unsent-"));
      assert.equal(kept.length, 1, fs.readdirSync(r.home).join(","));
      const ours = JSON.parse(fs.readFileSync(path.join(r.home, kept[0]!), "utf8"));
      assert(ours.attempt !== "earlier" && ours.outcome === "rolled-back", JSON.stringify(ours));
      assert(!r.calls.some((x) => /^MV:\.update-failed>/.test(x)), `앞선 기록을 옮겼다: ${r.calls.join(" | ")}`);
      assert(r.messages.some((m) => m.includes("holds another update's notice — left as it is")) && r.messages.some((m) => m.endsWith(`this notice is kept at ${path.join(r.home, kept[0]!)}; a daemon of this version or later picks it up and tries to send it to its requester.`)), r.messages.join("\n"));
      assert(r.asideSeen.length === 1 && r.asideSeen.every((a) => a.complete), JSON.stringify(r.asideSeen));
      return kept[0]!;
    });
    test("★실패 마커는 완성본만 공개(임시 파일 → link)", () => {
      const r = simulate("npm-fail", { notify: true });
      assert(r.calls.includes("LINK:.update-failed.next-*>.update-failed"), r.calls.filter((x) => x.includes("update-failed")).join(" | ") || "(no publish)");
      assert.deepEqual(fs.readdirSync(r.home).filter((n) => n.startsWith(".update-failed")), [".update-failed"]);
      return "link";
    });
    test("★이번 실패를 다 쓰기 전엔 옛 실패를 옮기지 않는다 · 공개(rename) 실패는 남은 경로와 함께 로그", () => {
      const pre = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier" });
      const noWrite = simulate("npm-fail", { notify: true, preFailed: pre, stagedWriteFail: true });
      assert.equal(JSON.parse(fs.readFileSync(path.join(noWrite.home, ".update-failed"), "utf8")).attempt, "earlier", "쓰지도 못했는데 옛 실패를 옮겼다");
      assert.equal(fs.readdirSync(noWrite.home).filter((n) => n.includes(".unsent-")).length, 0);
      assert(noWrite.messages.some((m) => /could not write the failure notice/.test(m)), noWrite.messages.join("\n"));
      // 공개 수단이 모두 막힘(link 불가 + Windows 비대체 이동도 실패) — 이번 원문은 임시 이름 그대로·경로·두 사유와 함께 로그 · 옆 보존 0.
      const noPub = simulate("npm-fail", { notify: true, linkFail: true, psMove: "fail" });
      const staged = fs.readdirSync(noPub.home).filter((n) => n.startsWith(".update-failed.next-"));
      assert(staged.length === 1 && !fs.existsSync(path.join(noPub.home, ".update-failed")), fs.readdirSync(noPub.home).join(","));
      assert(noPub.messages.some((m) => m.includes(`it is kept at ${path.join(noPub.home, staged[0]!)}`)), noPub.messages.join("\n"));
      assert(!noPub.calls.some((x) => x.includes(".unsent-")), noPub.calls.join(" | "));
      assert(noPub.messages.some((m) => /could not publish the failure notice \(EPERM: operation not permitted, link \(fixture\); the no-replace move did not report success: Access to the path is denied/.test(m)), noPub.messages.join("\n"));
      return "order ok";
    });
    test("★두 생산자가 둘 다 «비어 있음» 을 본 뒤 공개해도 먼저 것을 덮지 않는다(대체하지 않는 공개) · 같은 PID 의 앞선 보존본도 그대로", () => {
      const other = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "concurrent" });
      const r = simulate("npm-fail", { notify: true, racePublish: other });
      assert(r.calls.includes("RACE"), r.calls.join(" | "));
      // 먼저 공개된 기록이 고정 경로에 그대로(§15 G3 — 옛 판 소비자가 지금 읽고 있을 수 있다) · 이번 것은 옆 보존.
      assert.equal(fs.readFileSync(path.join(r.home, ".update-failed"), "utf8"), other, "먼저 공개된 기록을 옮기거나 덮었다");
      const kept = fs.readdirSync(r.home).filter((n) => n.startsWith(".update-failed.unsent-"));
      assert(kept.length === 1 && JSON.parse(fs.readFileSync(path.join(r.home, kept[0]!), "utf8")).attempt !== "concurrent", fs.readdirSync(r.home).join(","));
      // link 불가 + 경쟁 공개: Windows 비대체 이동이 «exists» → 이번 것은 옆 보존(비대체 이동으로) · 먼저 것은 그대로.
      const lf = simulate("npm-fail", { notify: true, racePublish: other, linkFail: true });
      assert.equal(fs.readFileSync(path.join(lf.home, ".update-failed"), "utf8"), other, `link 불가 경로가 먼저 공개된 기록을 바꿨다: ${fs.readdirSync(lf.home).join(",")}`);
      const lfKept = fs.readdirSync(lf.home).filter((n) => n.startsWith(".update-failed.unsent-"));
      assert(lfKept.length === 1 && JSON.parse(fs.readFileSync(path.join(lf.home, lfKept[0]!), "utf8")).outcome === "rolled-back", fs.readdirSync(lf.home).join(","));
      assert.deepEqual(lf.calls.filter((x) => /^PS-MOVE/.test(x)), ["PS-MOVE:.update-failed.next-*>.update-failed", "PS-MOVE:.update-failed.next-*>.update-failed.unsent-*"], lf.calls.join(" | "));
      // 같은 경로에 앞선 원문이 있으면 배타 생성이 실패하고 그 바이트는 그대로(옛 «PID 이름» 보존본 + 새 이름 충돌 둘 다).
      const stale = `.update-failed.next-${process.pid}`;
      const p = simulate("npm-fail", { notify: true, precreateStaged: "earlier-preserved", prePlaced: { [stale]: "older-pid-preserved" } } as SimOpts);
      const pre = p.calls.find((x) => x.startsWith("PRECREATED:"))?.slice("PRECREATED:".length);
      assert(pre !== undefined && fs.readFileSync(path.join(p.home, pre), "utf8") === "earlier-preserved", `배타 생성이 아니다: ${pre}`);
      assert.equal(fs.readFileSync(path.join(p.home, stale), "utf8"), "older-pid-preserved");
      assert(p.messages.some((m) => /could not write the failure notice/.test(m)), p.messages.join("\n"));
      // 다른 생산자가 고정 경로를 먼저 채우면(경합) 그 기록이 그대로 — 재시도로 비우지 않는다.
      const ra = simulate("npm-fail", { notify: true, raceEach: true });
      assert.equal(JSON.parse(fs.readFileSync(path.join(ra.home, ".update-failed"), "utf8")).attempt, "race-1", fs.readdirSync(ra.home).join(","));
      const aside = fs.readdirSync(ra.home).filter((n) => n.startsWith(".update-failed.unsent-")).map((n) => JSON.parse(fs.readFileSync(path.join(ra.home, n), "utf8")).attempt);
      assert(aside.length === 1 && !String(aside[0]).startsWith("race-"), JSON.stringify(aside));
      return kept[0]!;
    });
    // ── §12 hard link 불가 홈(FAT·일부 공유): 실패 기록을 완성본으로 공개해 배달까지 ─────────────────────────────
    const homeNames = (h: string) => fs.readdirSync(h).filter((n) => n.startsWith(".update-failed")).sort();
    for (const [label, scenario, fault, want] of [
      ["재가동 미확인(늦은 기동 사고 모양)", "success", { boot: "never" }, "restart-unconfirmed"],
      ["롤백", "npm-fail", {}, "rolled-back"],
    ] as const) {
      checks.push(await (async () => {
        const name = `★link 불가 홈 — ${label}: 실패 기록이 고정 경로에 완성본으로 공개 → 실제 부팅 소비가 요청 세션에 실패 1 · 다음 부팅 0`;
        try {
          const r = simulate(scenario, { delegate: { channel: "fixture", threadKey: "dashboard:side", address: "original-target" }, linkFail: true, ...fault });
          assert(r.calls.includes("LINK-FAIL"), r.calls.join(" | "));
          // 공개는 Windows 비대체 이동 한 번(§13) — 대체하는 rename·직접 쓰기 공개·잠금·대기는 없다.
          assert.deepEqual(r.calls.filter((x) => /^(PUBLISH-BY-|MKDIR-LOCK|LOCK-WAIT|RMDIR|PS-MOVE)/.test(x)), ["PS-MOVE:.update-failed.next-*>.update-failed"], r.calls.filter((x) => /update-failed|PUBLISH|LOCK/.test(x)).join(" | "));
          assert.equal(r.marker?.outcome, want); assert.equal(r.marker?.notify?.threadKey, "dashboard:side");
          assert.deepEqual(homeNames(r.home), [".update-failed"], "임시본·보존본이 남았다");
          const b = await consumeAt(r, laterBoot(r));
          const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          assert.equal(failure.length, 1, JSON.stringify(b.deliveries)); assert.equal(b.boot.delivered, true);
          assert(failure[0]!.channel === "fixture" && failure[0]!.target === "original-target" && failure[0]!.observeThreadKey === "dashboard:side" && failure[0]!.originThreadKey === "dashboard:side", JSON.stringify(failure[0]));
          assert.equal(b.deliveries.filter((d) => /Update complete/.test(d.text)).length, 0);
          const again = await consumeAt(r, { ...laterBoot(r), bootId: "55555555-5555-4555-8555-555555555555" });
          assert.equal(again.deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "같은 실패를 다음 부팅이 또 보냈다");
          return { name, ok: true, got: `outcome=${r.marker?.outcome} · 배달 1 · 다음 부팅 0` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
    }
    test("★link 불가 홈 경합(§15 G3) — 같은 시도 기록·소비자 선점: 기존 기록은 그 자리, 이번 것은 비대체 이동으로만(고정 경로가 비면 거기, 차 있으면 옆)", () => {
      const preSame = JSON.stringify({ stage: "earlier-stage", outcome: "rolled-back", attempt: "live-attempt" });
      const same = simulate("npm-fail", { seedPending: { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat" } }, preFailed: preSame, linkFail: true });
      assert.equal(fs.readFileSync(path.join(same.home, ".update-failed"), "utf8"), preSame, "같은 시도의 앞선 기록도 바꾸지 않는다");
      const sameKept = fs.readdirSync(same.home).filter((n) => n.startsWith(".update-failed.unsent-")).map((n) => JSON.parse(fs.readFileSync(path.join(same.home, n), "utf8")));
      assert(sameKept.length === 1 && sameKept[0].attempt === "live-attempt" && sameKept[0].stage !== "earlier-stage", JSON.stringify(sameKept));
      // 공개 직전 소비자가 앞선 기록을 선점(rename) — 고정 경로가 비었으니 이번 것은 고정 경로, 옆 보존 0.
      const claimed = simulate("npm-fail", { notify: true, preFailed: JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier" }), claimBeforeLink: true, linkFail: true });
      assert.equal(JSON.parse(fs.readFileSync(path.join(claimed.home, ".update-failed.claim-sim"), "utf8")).attempt, "earlier");
      assert.notEqual(JSON.parse(fs.readFileSync(path.join(claimed.home, ".update-failed"), "utf8")).attempt, "earlier");
      assert.equal(fs.readdirSync(claimed.home).filter((n) => n.includes(".unsent-") || n.includes(".next-")).length, 0, fs.readdirSync(claimed.home).join(","));
      for (const r of [same, claimed]) assert(r.calls.filter((x) => /^(PUBLISH-BY-|MKDIR-LOCK|LOCK-WAIT|RMDIR|LSTAT-FIXED|MV:\.update-failed>)/.test(x)).length === 0, r.calls.join(" | "));
      return "same→aside(ours) · claim→publish · 잠금·점유 확인·대체 rename·옮기기 0";
    });
    test("★공개에 잠금이 없다(§13) — 남은 v4 잠금 디렉터리는 보지도 지우지도 않는다(link 되는 홈·안 되는 홈) · 대기 0", () => {
      for (const linkFail of [false, true]) {
        const r = simulate("npm-fail", { notify: true, lockHeld: true, linkFail });
        assert(r.marker?.outcome === "rolled-back", `linkFail=${linkFail}: ${r.calls.join(" | ")}`);
        assert(fs.existsSync(path.join(r.home, ".update-failed.lock")), "남의 잠금 디렉터리를 지웠다");
        assert(!r.calls.some((x) => /^(MKDIR-LOCK|LOCK-WAIT|RMDIR|PUBLISH-BY-|LSTAT-FIXED)/.test(x)), `linkFail=${linkFail}: ${r.calls.join(" | ")}`);
        assert.deepEqual(r.calls.filter((x) => /^(LINK:|PS-MOVE)/.test(x)), linkFail ? ["PS-MOVE:.update-failed.next-*>.update-failed"] : ["LINK:.update-failed.next-*>.update-failed"], r.calls.join(" | "));
      }
      return "잠금 무시 · link 홈=link · 불가 홈=비대체 이동";
    });
    test("★옆 보존 자리도 대체하지 않는다 — 계산한 .unsent-* 이름이 이미 있으면 그 원문은 그대로, 다른 이름으로(link 홈·Windows link 불가·POSIX 디렉터리 기록)", () => {
      const pre = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier" });
      for (const [label, o] of [["link", {}], ["win link 불가", { linkFail: true }], ["darwin 디렉터리", { linkFail: true, platform: "darwin" as const }]] as const) {
        const r = simulate("npm-fail", { notify: true, preFailed: pre, precreateUnsent: "first", ...o } as SimOpts);
        const first = r.calls.find((x) => x.startsWith("PRECREATED-UNSENT:"))?.slice("PRECREATED-UNSENT:".length);
        assert(first !== undefined, `${label}: 충돌 fixture 가 안 걸렸다 ${r.calls.join(" | ")}`);
        const firstPath = path.join(r.home, first);
        const firstRaw = fs.statSync(firstPath).isDirectory() ? fs.readFileSync(path.join(firstPath, "record.json"), "utf8") : fs.readFileSync(firstPath, "utf8");
        assert.equal(firstRaw, `preserved-${first}`, `${label}: 옆 보존 자리를 대체했다`);
        assert.equal(fs.readFileSync(path.join(r.home, ".update-failed"), "utf8"), pre, `${label}: 앞선 고정 기록을 바꿨다`);
        const ours = fs.readdirSync(r.home).filter((n) => n.startsWith(".update-failed.unsent-") && n !== first);
        assert.equal(ours.length, 1, `${label}: ${homeNames(r.home).join(",")}`);
        const oursPath = path.join(r.home, ours[0]!);
        const oursRec = JSON.parse(fs.statSync(oursPath).isDirectory() ? fs.readFileSync(path.join(oursPath, "record.json"), "utf8") : fs.readFileSync(oursPath, "utf8"));
        assert(oursRec.outcome === "rolled-back" && oursRec.attempt !== "earlier", `${label}: ${JSON.stringify(oursRec)}`);
      }
      // 이름 후보 셋이 모두 차 있다 — 그 셋은 그대로, 이번 것은 임시본 그대로(쓸기 대상 아님) · 경로 로그.
      const all = simulate("npm-fail", { notify: true, preFailed: pre, precreateUnsent: "all" });
      for (const n of fs.readdirSync(all.home).filter((x) => x.startsWith(".update-failed.unsent-"))) assert.equal(fs.readFileSync(path.join(all.home, n), "utf8"), `preserved-${n}`, n);
      const staged = fs.readdirSync(all.home).filter((n) => n.startsWith(".update-failed.next-"));
      assert.equal(staged.length, 1, homeNames(all.home).join(","));
      assert(all.messages.some((m) => m.includes("could not keep the failure notice aside") && m.endsWith(`it is kept at ${path.join(all.home, staged[0]!)} (not sent).`)), all.messages.join("\n"));
      return "occupied aside names untouched";
    });
    // ── §13 v4 의 남은 두 반례: 혼합 link 경합 · 강제 종료 잔류물 ─────────────────────────────────────────
    const recordFiles = (h: string) => homeNames(h).filter((n) => fs.statSync(path.join(h, n)).isFile()).map((n) => ({ n, raw: fs.readFileSync(path.join(h, n), "utf8") }));
    const side = { channel: "fixture", threadKey: "dashboard:side", address: "original-target" };
    const nextBoot = (r: ReturnType<typeof simulate>) => ({ ...laterBoot(r), bootId: "55555555-5555-4555-8555-555555555555" });
    checks.push(await (async () => {
      const name = "★혼합 link 경합(§13) — link 가 EEXIST 외로 실패한 생산자의 대체 공개 직전에 다른 생산자의 link 가 성공해도 그 기록을 덮지 않는다 · 두 기록이 각자 좌표로 1회(§14) · 다음 부팅 0";
      try {
        const other = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "linked-other", notify: { channel: "fixture", target: "other-target" } });
        const r = simulate("npm-fail", { delegate: side, linkFail: true, otherPublishesBeforeFallback: other });
        assert(r.calls.includes("OTHER-LINKED"), r.calls.filter((x) => /update-failed|OTHER|PUBLISH/.test(x)).join(" | "));
        const now = recordFiles(r.home);
        assert.equal(now.filter((f) => f.raw === other).length, 1, `다른 생산자의 link 공개를 덮었다: ${now.map((f) => f.n).join(",")}`);
        assert(now.some((f) => f.n === ".update-failed" && f.raw === other), `먼저 놓인 기록은 고정 경로에 그대로(§15 G3): ${now.map((f) => f.n).join(",")}`);
        assert(r.marker === undefined || r.marker.attempt === "linked-other", "고정 경로는 다른 생산자 기록");
        const oursAside = now.filter((f) => f.n.startsWith(".update-failed.unsent-")).map((f) => JSON.parse(f.raw));
        assert(oursAside.length === 1 && oursAside[0].outcome === "rolled-back" && oursAside[0].notify?.threadKey === "dashboard:side", JSON.stringify(oursAside));
        const b = await consumeAt(r, laterBoot(r));
        const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
        const ours = failure.filter((d) => d.target === "original-target"), theirs = failure.filter((d) => d.target === "other-target");
        assert(failure.length === 2 && ours.length === 1 && ours[0]!.observeThreadKey === "dashboard:side" && theirs.length === 1 && theirs[0]!.observeThreadKey === "dashboard:default", JSON.stringify(b.deliveries));
        assert.equal((await consumeAt(r, nextBoot(r))).deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
        assert.deepEqual(homeNames(r.home), [], "소비 뒤 기록이 남았다");
        return { name, ok: true, got: "덮음 0 · 두 기록 각자 1 · 다음 부팅 0" };
      } catch (err) { return { name, ok: false, got: String(err) }; }
    })());
    for (const [label, leftover] of [
      ["v4 공개 잠금 + 임시본(잠금을 쥔 채 강제 종료)", { lockHeld: true, prePlaced: { ".update-failed.next-killed": JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "killed" }) } }],
      ["임시본만(공개 전에 강제 종료)", { prePlaced: { ".update-failed.next-killed": JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "killed" }) } }],
    ] as const) {
      checks.push(await (async () => {
        const name = `★강제 종료 잔류물(§13) — ${label}: link 불가 홈의 다음 생산자 실패가 요청 세션에 1회 배달 · 다음 부팅 0 · 잔류 원문 보존`;
        try {
          const r = simulate("npm-fail", { delegate: side, linkFail: true, ...leftover } as SimOpts);
          const b = await consumeAt(r, laterBoot(r));
          const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          assert(failure.length === 1 && failure[0]!.target === "original-target" && failure[0]!.observeThreadKey === "dashboard:side" && b.boot.delivered === true,
            `다음 통지가 배달되지 않았다: ${JSON.stringify(b.deliveries)} · ${homeNames(r.home).join(",")} · ${r.messages.filter((m) => /failure notice/.test(m)).join(" / ")}`);
          assert.equal((await consumeAt(r, nextBoot(r))).deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
          const killed = (leftover as { prePlaced?: Record<string, string> }).prePlaced?.[".update-failed.next-killed"];
          if (killed !== undefined) assert.equal(recordFiles(r.home).filter((f) => f.raw === killed).length, 1, "잔류 원문을 지웠다");
          return { name, ok: true, got: `배달 1 · 다음 부팅 0 · 남은 이름 ${homeNames(r.home).join(",") || "-"}` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
    }
    // ── §14 승인 없이 줄었던 배달 복원: 두 시도 각각 1 · POSIX link 불가 단일 1 ─────────────────────────────────
    for (const linkFail of [false, true]) {
      checks.push(await (async () => {
        const name = `★두 시도 각각(§14) — Windows 위임 두 요청의 실패가 같은 홈에 겹쳐도 다음 부팅이 각 요청 좌표로 1씩 · 다음 부팅 0 (${linkFail ? "link 불가 홈" : "link 홈"})`;
        try {
          const sideA = { channel: "fixture", threadKey: "dashboard:side-a", address: "target-a" }, sideB = { channel: "fixture", threadKey: "dashboard:side-b", address: "target-b" };
          const a = simulate("success", { delegate: sideA, boot: "never", linkFail });
          assert.equal(a.marker?.outcome, "restart-unconfirmed");
          const b = simulate("npm-fail", { delegate: sideB, linkFail, reuseHome: a.home });
          // A 는 고정 경로에 그대로(§15 G3) · B 는 옆 보존(완성본).
          assert.equal(b.marker?.attempt, a.marker?.attempt, `A 의 고정 기록이 바뀌었다: ${homeNames(a.home).join(",")}`);
          const aside = homeNames(a.home).filter((n) => n.startsWith(".update-failed.unsent-"));
          const bRec = aside.length === 1 ? JSON.parse(fs.readFileSync(path.join(a.home, aside[0]!), "utf8")) : null;
          assert(bRec?.outcome === "rolled-back" && bRec?.notify?.threadKey === "dashboard:side-b", homeNames(a.home).join(","));
          const boot = await consumeAt(b, laterBoot(b));
          const failure = boot.deliveries.filter((d) => /Update failed/.test(d.text));
          const toA = failure.filter((d) => d.target === "target-a"), toB = failure.filter((d) => d.target === "target-b");
          assert(failure.length === 2 && toA.length === 1 && toB.length === 1, `원 요청별 배달: A=${toA.length} B=${toB.length} · ${JSON.stringify(boot.deliveries)}`);
          assert(toA[0]!.observeThreadKey === "dashboard:side-a" && toA[0]!.originThreadKey === "dashboard:side-a" && toB[0]!.observeThreadKey === "dashboard:side-b" && toB[0]!.originThreadKey === "dashboard:side-b", JSON.stringify(failure));
          assert(/restart could not be confirmed|No rollback was attempted/.test(toA[0]!.text) && !/No rollback was attempted/.test(toB[0]!.text), `${toA[0]!.text} / ${toB[0]!.text}`);
          assert.equal(boot.success.length, 0); assert.equal(boot.restart.length, 0);
          assert.deepEqual(homeNames(a.home), [], "소비 뒤 기록이 남았다");
          const again = await consumeAt(b, nextBoot(b));
          assert.equal(again.deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
          return { name, ok: true, got: `A=${toA.length} B=${toB.length} · 다음 부팅 0` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
    }
    checks.push(await (async () => {
      const name = "★쓸기 이름엔 완성본만(§15 G3, D1 #8) — 옆 보존 이름이 나타나는 순간마다 완성된 기록 · 빈 예약 파일 0 → 다음 부팅이 두 요청 각자 1 · 그다음 0";
      try {
        const other = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier", notify: { channel: "fixture", target: "other-target" } });
        for (const o of [{}, { linkFail: true }, { linkFail: true, platform: "darwin" as const }]) {
          const r = simulate("npm-fail", { delegate: side, preFailed: other, ...o } as SimOpts);
          assert(r.asideSeen.length === 1 && r.asideSeen.every((a) => a.complete), `${JSON.stringify(o)}: ${JSON.stringify(r.asideSeen)} · ${r.calls.filter((x) => /unsent|PS-|LINK/.test(x)).join(" | ")}`);
          assert(!r.calls.some((x) => /^PUBLISH-BY-WRITE/.test(x)), r.calls.join(" | "));
          const b = await consumeAt(r, laterBoot(r));
          const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          const ours = failure.filter((d) => d.target === "original-target"), theirs = failure.filter((d) => d.target === "other-target");
          assert(failure.length === 2 && ours.length === 1 && ours[0]!.observeThreadKey === "dashboard:side" && theirs.length === 1, `${JSON.stringify(o)}: ${JSON.stringify(b.deliveries)}`);
          assert.equal((await consumeAt(r, nextBoot(r))).deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
          assert.deepEqual(homeNames(r.home), [], `소비 뒤 남음: ${homeNames(r.home).join(",")}`);
        }
        return { name, ok: true, got: "link·Windows 비대체 이동·POSIX 디렉터리 — 완성본만 · 각자 1 · 다음 0" };
      } catch (err) { return { name, ok: false, got: String(err) }; }
    })());
    for (const platform of ["darwin", "linux"] as const) for (const [label, scenario, fault, want] of [
      ["재가동 미확인", "success", { boot: "never" }, "restart-unconfirmed"],
      ["롤백", "npm-fail", {}, "rolled-back"],
    ] as const) {
      // §16 b — symlink 되는 볼륨: 고정 슬롯에 완성 임시본을 가리키는 상대 링크로(대체 0) → 현 판 부팅 1 · 임시본까지 치움 · 다음 0
      checks.push(await (async () => {
        const name = `★POSIX link 불가 단일(§16 b) ${platform} ${label} — symlink 되면 고정 슬롯에 완성본 링크로 공개(대체·잠금·이동 0) → 현 판 부팅이 요청 좌표로 1 · 링크 대상 임시본까지 치움 · 다음 부팅 0`;
        try {
          const live = { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat", threadKey: "dashboard:side" } };
          const r = simulate(scenario, { platform, linkFail: true, seedPending: live, ...fault });
          assert(r.calls.includes("LINK-FAIL") && r.calls.some((x) => x === "SYMLINK:.update-failed.next-*>.update-failed") && !r.calls.some((x) => /^(PUBLISH-BY-|PS-MOVE|MKDIR-LOCK)/.test(x)), r.calls.filter((x) => /update-failed|PUBLISH|LINK|PS-/.test(x)).join(" | "));
          const fixed = path.join(r.home, ".update-failed");
          const names = homeNames(r.home);
          assert(fs.lstatSync(fixed).isSymbolicLink() && /^\.update-failed\.next-/.test(fs.readlinkSync(fixed)) && names.length === 2 && names.includes(fs.readlinkSync(fixed)), names.join(","));
          assert(r.marker?.outcome === want && r.marker?.attempt === "live-attempt" && r.marker?.notify?.target === "live-chat", JSON.stringify(r.marker));
          const b = await consumeAt(r, laterBoot(r));
          const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          assert(failure.length === 1 && b.boot.consumed === true && failure[0]!.channel === "telegram" && failure[0]!.target === "live-chat" && failure[0]!.observeThreadKey === "dashboard:side", JSON.stringify(b.deliveries));
          assert.deepEqual(homeNames(r.home), [], `소비 뒤 남음(링크 대상 임시본 포함): ${homeNames(r.home).join(",")}`);
          assert.equal(b.success.length, 0);
          assert.equal((await consumeAt(r, nextBoot(r))).deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
          return { name, ok: true, got: `outcome=${want} · 링크 공개 · 배달 1 · 다음 부팅 0 · 잔류 0` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
      checks.push(await (async () => {
        const name = `★POSIX link·symlink 모두 불가 단일(§15 G3) ${platform} ${label} — 고정 경로는 대체하지 않는다: 직접 모드 요청을 이은 CLI 의 실패가 디렉터리 기록(옆 보존)으로 → 요청 좌표로 1 · 다음 부팅 0`;
        try {
          const live = { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat", threadKey: "dashboard:side" } };
          const r = simulate(scenario, { platform, linkFail: true, symlinkFail: true, seedPending: live, ...fault });
          assert(r.calls.includes("LINK-FAIL") && r.calls.includes("SYMLINK-FAIL") && !r.calls.some((x) => /^(PUBLISH-BY-|PS-MOVE)/.test(x)), r.calls.filter((x) => /update-failed|PUBLISH|LINK|PS-/.test(x)).join(" | "));
          const names = homeNames(r.home);
          assert(names.length === 1 && names[0]!.startsWith(".update-failed.unsent-") && fs.statSync(path.join(r.home, names[0]!)).isDirectory(), names.join(","));
          r.marker = JSON.parse(fs.readFileSync(path.join(r.home, names[0]!, "record.json"), "utf8"));
          assert(r.marker?.outcome === want && r.marker?.attempt === "live-attempt" && r.marker?.notify?.target === "live-chat" && r.marker?.notify?.threadKey === "dashboard:side", JSON.stringify(r.marker));
          const b = await consumeAt(r, laterBoot(r));
          const failure = b.deliveries.filter((d) => /Update failed/.test(d.text));
          // 고정 슬롯은 비어 있다 — 옆 보존 쓸기가 그 좌표로 한 번(§14·§15).
          assert(failure.length === 1 && b.boot.consumed === false && failure[0]!.channel === "telegram" && failure[0]!.target === "live-chat" && failure[0]!.observeThreadKey === "dashboard:side", JSON.stringify(b.deliveries));
          assert.deepEqual(homeNames(r.home), [], `소비 뒤 남음: ${homeNames(r.home).join(",")}`);
          assert.equal(b.success.length, 0);
          assert.equal((await consumeAt(r, nextBoot(r))).deliveries.filter((d) => /Update (complete|failed)/.test(d.text)).length, 0, "다음 부팅이 또 보냈다");
          return { name, ok: true, got: `outcome=${want} · 배달 1 · 다음 부팅 0` };
        } catch (err) { return { name, ok: false, got: String(err) }; }
      })());
    }
    test("★§16 거절 갈래(`runUpdate` gate.refused.record) 반환 = 놓인 곳 → 놓였는지 모르면 후보 → 쓸기 대상에 없음이 확실할 때만 null — 거절 보고의 record", () => {
      const refusedGate = { gate: { refused: { reason: "fixture refusal", record: true } }, delegate: side } as SimOpts;
      const asideOf = (h: string) => homeNames(h).filter((n) => n.startsWith(".update-failed.unsent-"));
      // 정상(link) — 놓인 옆 보존 경로
      const ok = simulate("success", { ...refusedGate });
      assert(typeof ok.returned === "string" && asideOf(ok.home).length === 1 && ok.returned === path.join(ok.home, asideOf(ok.home)[0]!), `${String(ok.returned)} | ${homeNames(ok.home).join(",")}`);
      // Windows link 불가 + 비대체 이동 응답 유실 + 임시본 확인 실패 — 실제로는 옮겨졌다: 후보(그 이름)를 돌려준다
      const unk = simulate("success", { ...refusedGate, linkFail: true, psMove: "lost-reply", stagedStatFail: true });
      assert(typeof unk.returned === "string" && asideOf(unk.home).length === 1 && unk.returned === path.join(unk.home, asideOf(unk.home)[0]!), `${String(unk.returned)} | ${homeNames(unk.home).join(",")}`);
      // 이동 실패(임시본 확인 성공 — 임시본 그대로) · 임시본 쓰기 실패 — 쓸기 대상에 없음이 확실: null
      const fail = simulate("success", { ...refusedGate, linkFail: true, psMove: "fail" });
      assert(fail.returned === null && asideOf(fail.home).length === 0 && homeNames(fail.home).some((n) => n.startsWith(".update-failed.next-")), `${String(fail.returned)} | ${homeNames(fail.home).join(",")}`);
      const nowrite = simulate("success", { ...refusedGate, stagedWriteFail: true });
      assert(nowrite.returned === null && homeNames(nowrite.home).length === 0, `${String(nowrite.returned)} | ${homeNames(nowrite.home).join(",")}`);
      // 거절 갈래는 변경 전에 끝난다 — git·정지 0
      assert(![ok, unk, fail, nowrite].some((r) => r.calls.some((x) => /^git |^STOP|^npm /.test(x))), ok.calls.join(" | "));
      return "놓임=경로 · 불명=후보 · 실패=null";
    });
    test("★Windows 비대체 이동(§13) — 응답만 잃어도 옮겨졌으면 공개로 본다 · POSIX link 불가 홈은 고정 경로 대체 rename(§14 — 이동·잠금·직접 쓰기 0) · 스크립트는 대체하지 않는 File.Move", () => {
      const lost = simulate("npm-fail", { notify: true, linkFail: true, psMove: "lost-reply" });
      assert(lost.marker?.outcome === "rolled-back" && homeNames(lost.home).join(",") === ".update-failed" && !lost.messages.some((m) => /could not (publish|confirm)|failure notice/.test(m)), `${homeNames(lost.home).join(",")} · ${lost.messages.filter((m) => /failure notice/.test(m)).join(" / ")}`);
      for (const platform of ["darwin", "linux"] as const) {
        const px = simulate("npm-fail", { notify: true, linkFail: true, symlinkFail: true, platform });
        const names = homeNames(px.home);
        assert(names.length === 1 && names[0]!.startsWith(".update-failed.unsent-") && fs.statSync(path.join(px.home, names[0]!)).isDirectory() && px.marker === undefined, `${platform}: ${names.join(",")} | ${px.calls.join(" | ")}`);
        assert(!px.calls.some((x) => /^(PS-MOVE|PUBLISH-BY-|MKDIR-LOCK|LOCK-WAIT|LSTAT-FIXED)/.test(x)), `${platform}: ${px.calls.join(" | ")}`);
        assert(px.messages.some((m) => /can neither hard-link nor symlink — the notice cannot be put in the shared slot without replacing/.test(m)), px.messages.join("\n"));
        // §16 b — 링크가 되면 고정 슬롯에 링크(대체·이동·잠금·직접 쓰기 0) · 차 있으면(EEXIST — 다른 생산자가 먼저) 그 원문 그대로·이번 것은 디렉터리 옆 보존.
        const sl = simulate("npm-fail", { notify: true, linkFail: true, platform });
        assert(fs.lstatSync(path.join(sl.home, ".update-failed")).isSymbolicLink() && sl.marker?.outcome === "rolled-back" && !sl.calls.some((x) => /^(PS-MOVE|PUBLISH-BY-|MKDIR-LOCK|LOCK-WAIT|LSTAT-FIXED)/.test(x)) && !sl.messages.some((m) => /hard-link|symlink/.test(m)), `${platform}: ${homeNames(sl.home).join(",")} | ${sl.calls.join(" | ")}`);
        const otherRaw = JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "racer" });
        const rc = simulate("npm-fail", { notify: true, linkFail: true, platform, racePublish: otherRaw });
        const rcAside = homeNames(rc.home).filter((n) => n.startsWith(".update-failed.unsent-"));
        assert(rc.calls.includes("RACE") && !fs.lstatSync(path.join(rc.home, ".update-failed")).isSymbolicLink() && fs.readFileSync(path.join(rc.home, ".update-failed"), "utf8") === otherRaw && rcAside.length === 1 && fs.statSync(path.join(rc.home, rcAside[0]!)).isDirectory() &&
          JSON.parse(fs.readFileSync(path.join(rc.home, rcAside[0]!, "record.json"), "utf8")).outcome === "rolled-back" && !homeNames(rc.home).some((n) => n.includes(".next-")), `${platform}: ${homeNames(rc.home).join(",")} | ${rc.calls.join(" | ")}`);
        // 디렉터리 기록마저 못 옮기면 임시 디렉터리 그대로(쓸기 대상 아님) — 경로 로그.
        const stuck = simulate("npm-fail", { notify: true, linkFail: true, symlinkFail: true, platform, renameFail: (a: string, b: string) => a.endsWith(".d") && b.includes(".update-failed.unsent-") } as SimOpts);
        const sn = homeNames(stuck.home);
        assert(sn.length === 1 && sn[0]!.startsWith(".update-failed.next-") && sn[0]!.endsWith(".d"), `${platform}: ${sn.join(",")}`);
        assert(stuck.messages.some((m) => m.includes("could not keep the failure notice aside") && m.endsWith(`it is kept at ${path.join(stuck.home, sn[0]!)} (not sent).`)), stuck.messages.join("\n"));
      }
      // 이동 응답 없음 + 임시본 확인 실패(EACCES) — 공개됐는지 모른다: 성공으로도 «보존·미발송» 으로도 말하지 않는다(옆 보존 0).
      for (const psMove of ["fail", "lost-reply"] as const) {
        const un = simulate("npm-fail", { notify: true, linkFail: true, psMove, stagedStatFail: true });
        const stagedPath = un.calls.find((x) => x.startsWith("LSTAT-STAGED-FAIL:"))?.slice("LSTAT-STAGED-FAIL:".length);
        assert(stagedPath !== undefined && !un.calls.some((x) => x.includes(".unsent-")), `${psMove}: ${un.calls.join(" | ")}`);
        // 두 경로를 정확히 — 고정 경로는 임시본 경로의 접두사라 포함 검사로는 한쪽만 찍어도 통과한다(I2).
        assert(un.messages.some((m) => m.startsWith("update: could not confirm whether the failure notice was published (") && m.includes("the staged notice could not be checked (EACCES")
          && m.endsWith(`check ${path.join(un.home, ".update-failed")} and ${stagedPath}.`)) && !un.messages.some((m) => /\(not sent\)/.test(m)), `${psMove}: ${un.messages.join("\n")}`);
      }
      // 경로는 데이터(UTF-8 base64)로 — 굽은 작은따옴표·작은따옴표·비ASCII 가 있는 홈도 그 경로 그대로 넘어간다.
      const odd = ["C:\\Users\\O’Brien‘s it's 홈\\.update-failed.next-1", "C:\\Users\\O’Brien‘s it's 홈\\.update-failed"];
      const script = d.winMoveNoReplaceScript(odd[0]!, odd[1]!);
      const enc = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
      assert.deepEqual(enc, odd, script);
      assert(/\[System\.IO\.File\]::Move\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[^']+'\)\), \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[^']+'\)\)\); 'MOVED'/.test(script), script);
      assert(!/[’‘]|it's|-Force|Move-Item|\$true/.test(script), script);
      assert(/-band 0xFFFF\) -in 80, 183\) \{ 'EXISTS' \} else \{ throw/.test(script) && script.includes("'MOVED'") && script.includes("$ErrorActionPreference = 'Stop'"), script);
      // 결과 읽기: 정상 종료의 마지막 줄만 — 오류·시한·엉뚱한 출력은 사유 문자열(호출자가 임시본 존재로 가른다).
      const rd = (status: number | null, stdout: string, stderr = "") => d.winMoveNoReplaceResult({ status, stdout, stderr });
      assert.equal(rd(0, "MOVED"), "moved"); assert.equal(rd(0, "noise\r\nEXISTS\r\n".trim()), "exists"); assert.equal(rd(0, "line\nMOVED"), "moved");
      for (const [st, out, err] of [[0, "", ""], [0, "MOVED?", ""], [1, "MOVED", "boom"], [null, "", "PowerShell did not respond — gave up after 30s"], [1, "", "#< CLIXML\r\n<Objs><S S=\"Error\">Access to the path is denied._x000D__x000A_</S></Objs>"]] as const) {
        const v = rd(st, out, err);
        assert(v !== "moved" && v !== "exists" && v.includes(`(exit ${st ?? "none"})`), `${JSON.stringify([st, out, err])} → ${v}`);
      }
      assert(rd(1, "", "#< CLIXML\r\n<Objs><S S=\"Error\">Access to the path is denied._x000D__x000A_</S></Objs>").startsWith("Access to the path is denied."));
      return "lost-reply→공개 · POSIX→보존 · 스크립트 비대체 · 결과 읽기";
    });
    test("★좌표 없는 새 위임은 남은 옛 pending(실패·확정)의 좌표·시도를 잇지 않는다 — 살아 있는 직접 모드 ready 만 잇는다", () => {
      for (const [mode, state] of [["cli", "failed"], ["cli", "confirmed"], ["cli", "pending"], ["direct", "failed"]] as const) {
        const r = simulate("success", { seedPending: { mode, state, attempt: "old-attempt", notify: { channel: "telegram", target: "old-chat", threadKey: "dashboard:old" } }, boot: "never" });
        // 새 기록이 **있고** 새 시도 id 를 가진 뒤에야 «상속 안 함» 이 뜻을 갖는다(기록이 없어도 아래 두 조건은 참이다 — I4).
        assert(r.completion !== null && typeof r.completion?.attempt === "string" && r.completion.attempt.length > 0 && r.completion.expected?.revision === "2".repeat(40), `${mode}/${state}: ${JSON.stringify(r.completion)}`);
        assert(r.completion?.notify === undefined && r.completion?.attempt !== "old-attempt", `${mode}/${state}: ${JSON.stringify(r.completion)}`);
      }
      const live = simulate("success", { seedPending: { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat" } }, boot: "late" });
      assert(live.completion?.attempt === "live-attempt" && live.completion?.notify?.target === "live-chat", JSON.stringify(live.completion));
      return "ok";
    });
    test("★공개 직전 소비자가 앞선 기록을 선점했으면 이번 실패는 고정 경로 — 옆 보존 없음(§15 G3)", () => {
      const r = simulate("npm-fail", { notify: true, preFailed: JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "earlier" }), claimBeforeLink: true });
      assert(r.calls.includes("CLAIMED-BY-CONSUMER"), r.calls.join(" | "));
      assert.equal(JSON.parse(fs.readFileSync(path.join(r.home, ".update-failed.claim-sim"), "utf8")).attempt, "earlier");
      const fixed = JSON.parse(fs.readFileSync(path.join(r.home, ".update-failed"), "utf8"));
      assert(fixed.attempt !== "earlier" && fixed.outcome === "rolled-back", JSON.stringify(fixed));
      assert.equal(fs.readdirSync(r.home).filter((n) => n.includes(".unsent-")).length, 0, fs.readdirSync(r.home).join(","));
      return "claim=A · fixed=B · unsent 0";
    });
    // ── §15 — 실행권을 못 얻은 실행은 변경 전에 끝난다 · 옛 판 부모 세션 키 · 정지·재시작 직전 확인 · 부팅 결과 처리 끝 ─────────────
    test("★§15 거절된 실행(gate.refused): git·정지·재시작·pending 잇기·옛 표식 격리 0 · record 면 요청 좌표로 not-started 옆 보존 1, 아니면 0", () => {
      const live = { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat" } };
      // 실행 빌드(표시값)가 checkout 과 다른 경우 — 기록의 «checkout» 과 `from` 엔 checkout(앵커)만 남는다(I3 #4)
      const rec = simulate("success", { delegate: side, reportFrom: "0abcdef9", gate: { refused: { reason: "another update is already running in this home", record: true } }, seedPending: live, legacyComplete: false } as SimOpts);
      assert.deepEqual(rec.calls.filter((x) => /^(git|npm|STOP|START|RESTART)/.test(x)), [], rec.calls.join(" | "));
      assert.deepEqual(rec.completion, live, "pending 을 잇거나 바꿨다");
      const aside = homeNames(rec.home).filter((n) => n.startsWith(".update-failed.unsent-"));
      assert(aside.length === 1 && !fs.existsSync(path.join(rec.home, ".update-failed")), homeNames(rec.home).join(","));
      const a = JSON.parse(fs.readFileSync(path.join(rec.home, aside[0]!), "utf8"));
      assert(a.outcome === "not-started" && a.stage === "start" && a.notify?.target === "original-target" && a.notify?.threadKey === "dashboard:side" && /did not start the install: another update is already running/.test(a.detail) && /checkout was at 1111111 before it fetched/.test(a.detail) && !/0abcdef/.test(a.detail) && a.from === "1111111", JSON.stringify(a));
      assert.equal(rec.exitCode, 1);
      const quiet = simulate("success", { delegate: side, gate: { refused: { reason: "x", record: false } } } as SimOpts);
      assert(homeNames(quiet.home).length === 0 && quiet.calls.filter((x) => /^(git|npm|STOP)/.test(x)).length === 0, `${homeNames(quiet.home).join(",")} ${quiet.calls.join(" | ")}`);
      // 진단 로그를 못 열어도 거절 기록은 남는다(I1 #2) — 로그·git 에 기대지 않는다.
      const noLog = simulate("success", { delegate: side, logOpenFail: true, gate: { refused: { reason: "another update is already running in this home", record: true } } } as SimOpts);
      const noLogAside = homeNames(noLog.home).filter((n) => n.startsWith(".update-failed.unsent-"));
      const noLogRec = noLogAside.length === 1 ? JSON.parse(fs.readFileSync(path.join(noLog.home, noLogAside[0]!), "utf8")) : null;
      assert(noLogRec?.outcome === "not-started" && noLogRec?.logPath === null && !updateFailedText(noLogRec).includes(translate("srv.update.logLine", { path: "" }).trim().replace(/\s*$/, "")) && noLog.calls.filter((x) => /^git/.test(x)).length === 0, `${homeNames(noLog.home).join(",")} ${JSON.stringify(noLogRec)} ${noLog.calls.join(" | ")}`);
      const legacy = simulate("success", { legacyComplete: true, gate: { refused: { reason: "x", record: false } } } as SimOpts);
      assert(fs.existsSync(path.join(legacy.home, ".update-complete")) && !fs.existsSync(path.join(legacy.home, ".update-pending")), "옛 표식을 격리했다");
      return "refused → 변경 0";
    });
    test("★§15 옛 판 부모의 자식(gate.dropThread): 세션 키는 버린다 — 채널·대상은 env 그대로", () => {
      const r = simulate("npm-fail", { delegate: side, gate: { dropThread: true } } as SimOpts);
      assert(r.marker?.notify?.target === "original-target" && r.marker?.notify?.threadKey === undefined, JSON.stringify(r.marker?.notify));
      const keep = simulate("npm-fail", { delegate: side, gate: {} } as SimOpts);
      assert.equal(keep.marker?.notify?.threadKey, "dashboard:side");
      return "dropThread → threadKey 없음";
    });
    test("★§15 정지 직전 확인: 데몬이 결과를 처리 중이면 끝날 때까지 기다린 뒤 정지 · 끝까지면 정지 0·표식 0·코드 되돌림", () => {
      const ok = simulate("success", { notify: true, healthPendingWaits: 2 });
      const i = ok.calls.indexOf("STOP"), waits = ok.calls.slice(0, Math.max(i, 0)).filter((x) => x === "SETTLE-WAIT").length;
      assert(i > 0 && waits === 2 && ok.exitCode === 0, ok.calls.join(" | "));
      const stuck = simulate("success", { notify: true, healthPendingWaits: Infinity });
      assert(!stuck.calls.includes("STOP") && !stuck.calls.some((x) => /^npm ci/.test(x)), stuck.calls.join(" | "));
      assert(stuck.calls.filter((x) => x === "SETTLE-WAIT").length === 480 && stuck.calls.some((x) => /^git reset --keep/.test(x)), `waits=${stuck.calls.filter((x) => x === "SETTLE-WAIT").length}`);
      assert(stuck.marker?.outcome === "unchanged" && stuck.marker?.stage === "stop" && stuck.lockAfterRun === "no-lock" && stuck.exitCode === 1, JSON.stringify(stuck.marker));
      // 기록의 사유도 관측한 만큼만(I3 #2)
      const notSettled = "could not confirm within 120 seconds that the daemon had finished delivering the previous update's results";
      assert(stuck.marker?.detail === notSettled, JSON.stringify(stuck.marker));
      // 조회가 느려도(한 번 2초) 상한은 실제 경과로 — 횟수(480)가 아니라 120초에 닿으면 멈춘다(I1 #4).
      const slow = simulate("success", { notify: true, healthPendingWaits: Infinity, healthCostMs: 2000 });
      const slowWaits = slow.calls.filter((x) => x === "SETTLE-WAIT").length;
      assert(!slow.calls.includes("STOP") && slowWaits > 0 && slowWaits < 60, `waits=${slowWaits} · ${slow.calls.includes("STOP")}`);
      // 마감에 닿은 뒤 처음으로 «처리 끝» 이 보여도 정지 근거가 아니다(I2 #5).
      //  조회 1초 · 잠 250ms — 96번째 잠 뒤의 조회가 마감(120초)을 넘겨 끝나는데 그 조회가 처음으로 «처리 끝» 을 보인다.
      const after = simulate("success", { notify: true, healthPendingWaits: 96, healthCostMs: 1000 });
      assert(!after.calls.includes("STOP") && after.marker?.stage === "stop" && after.marker?.detail === notSettled, `${after.calls.slice(-6).join(" | ")} · ${JSON.stringify(after.marker)}`);
      return `대기 ${waits} 뒤 정지 · 만료 → 정지 0 · 느린 조회 ${slowWaits}회에 상한 · 마감 뒤 관측 불인정`;
    });
    test("★§15 abortBeforeStop: 결과 처리 중이면 재시작하지 않는다(기록이 놓였으면 «다음 재시작에서 전달») · 남의 감독자 표식은 지우지 않는다", () => {
      const pend = simulate("pull-fail", { notify: true, healthPendingWaits: Infinity, prePlaced: { ".update-in-progress": "other-run" } } as SimOpts);
      assert(!pend.calls.includes("RESTART") && fs.readFileSync(path.join(pend.home, ".update-in-progress"), "utf8") === "other-run", pend.calls.join(" | "));
      // 사유는 관측한 만큼만 — «배달 중» 이 아니라 «기한 안에 끝났음을 확인하지 못했다»(I3 #2)
      assert(pend.messages.some((m) => m.includes("not restarting the daemon: could not confirm within 120 seconds that it had finished delivering earlier results — this notice (") && m.endsWith(".update-failed) is tried for delivery when the daemon next starts.")) && !pend.messages.some((m) => /is delivered when|while it delivers/.test(m)), pend.messages.join("\n"));
      const done = simulate("pull-fail", { notify: true, healthPendingWaits: 0, prePlaced: { ".update-in-progress": "other-run" } } as SimOpts);
      assert(done.calls.some((x) => x.startsWith("RESTART")) && fs.readFileSync(path.join(done.home, ".update-in-progress"), "utf8") === "other-run", done.calls.join(" | "));
      // 기록을 놓지 못했으면 «전달» 을 말하지 않는다(D7 #5).
      const lost = simulate("pull-fail", { notify: true, healthPendingWaits: Infinity, stagedWriteFail: true } as SimOpts);
      assert(lost.messages.some((m) => m.includes("where this notice is (or why it could not be kept) is logged above")) && !lost.messages.some((m) => /tried for delivery|is delivered/.test(m)), lost.messages.join("\n"));
      return "재시작 0 · 표식 보존";
    });
    checks.push(await (async () => {
      const name = "★§15 부팅 결과 처리 끝(`endBootUpdateResults`)은 업데이트 결과 배달(실패·성공·옆 보존) 뒤, 일반 재시작 통지 전에 한 번";
      try {
        const late = simulate("success", { notify: true, boot: "late" });
        const b = await consumeAt(late, late.completion?.confirmed);
        assert(b.success.length === 1 && b.ends.length === 1 && b.ends[0] === b.deliveries.length, JSON.stringify({ ends: b.ends, d: b.deliveries.length }));
        const plain = await consumeAt({ ...late, home: fs.mkdtempSync(path.join(home, "plain-")) } as ReturnType<typeof simulate>, laterBoot(late));
        assert(plain.restart.length === 1 && plain.ends.length === 1 && plain.ends[0] === 0, JSON.stringify({ ends: plain.ends, restart: plain.restart.length }));
        return { name, ok: true, got: `ends=${JSON.stringify(b.ends)} · 일반 재시작 전 ${JSON.stringify(plain.ends)}` };
      } catch (err) { return { name, ok: false, got: String(err) }; }
    })());
    // ── §15 옛 판 소비자 겹침(`evidence/c6-old-consumer.log` overlap — 현행 v6 = A 2·B 0) ─────────────────────────
    checks.push(await (async () => {
      const name = "★§15 옛 판 소비자 겹침: 옛 판(4c8bd246)이 고정 기록 A 를 읽는 동안 현 판 CLI B 가 실패를 공개 → B 는 A 를 바꾸지 않는다 · A 는 옛 판이 1회 · B 는 현 판 부팅이 1회 · 다음 부팅 0";
      const fx = path.join(repo, "src/scripts/regression/fixtures/legacy-update-consumer-4c8bd246");
      const legacyRoot = fs.mkdtempSync(path.join(home, "legacy-4c8bd246-"));
      try {
        fs.mkdirSync(path.join(legacyRoot, "src")); fs.mkdirSync(path.join(legacyRoot, "bin"));
        fs.copyFileSync(path.join(fx, "index-region.ts.txt"), path.join(legacyRoot, "src", "index.ts"));
        fs.copyFileSync(path.join(fx, "update-marker.mjs.txt"), path.join(legacyRoot, "bin", "update-marker.mjs"));
        const oldRunner = await makeBootRunner(legacyRoot);
        const sideA = { channel: "fixture", threadKey: "dashboard:side-a", address: "target-a" }, sideB = { channel: "fixture", threadKey: "dashboard:side-b", address: "target-b" };
        const a = simulate("npm-fail", { delegate: sideA });
        const aRaw = fs.readFileSync(path.join(a.home, ".update-failed"), "utf8");
        let fired = false; let bAside: string[] = []; let fixedDuringB = "";
        const hooked = { ...fspReal, readFile: async (n: string) => { const v = await fspReal.readFile(n); if (!fired && n === path.join(a.home, ".update-failed")) { fired = true; simulate("npm-fail", { delegate: sideB, reuseHome: a.home }); fixedDuringB = fs.readFileSync(n, "utf8"); bAside = homeNames(a.home).filter((x) => x.startsWith(".update-failed.unsent-")); } return v; } };
        const k = { t: 0 };
        const oldBoot = await oldRunner({ fsp: hooked, home: a.home, boot: laterBoot(a), updateOriginSession, updateFailedText, translate, now: () => k.t, sleep: async (ms) => { k.t += ms; } });
        assert(fired && fixedDuringB === aRaw && bAside.length === 1, `B 가 A 를 바꿨거나 옆에 두지 않았다: fixed=${fixedDuringB === aRaw} aside=${bAside.join(",")}`);
        const newBoot = await consumeAt(a, { ...nextBoot(a), bootId: "66666666-6666-4666-8666-666666666666" });
        const last = await consumeAt(a, { ...nextBoot(a), bootId: "77777777-7777-4777-8777-777777777777" });
        const all = [...oldBoot.deliveries, ...newBoot.deliveries, ...last.deliveries].filter((x) => /Update failed/.test(x.text));
        const toA = all.filter((x) => x.target === "target-a"), toB = all.filter((x) => x.target === "target-b");
        assert(toA.length === 1 && toB.length === 1 && oldBoot.failure.length === 1 && oldBoot.failure[0]!.target === "target-a" && newBoot.failure.length === 1 && newBoot.failure[0]!.target === "target-b" && newBoot.failure[0]!.observeThreadKey === "dashboard:side-b" && last.failure.length === 0,
          `A=${toA.length} B=${toB.length} · old=${JSON.stringify(oldBoot.failure.map((x) => x.target))} new=${JSON.stringify(newBoot.failure.map((x) => x.target))} last=${last.failure.length}`);
        return { name, ok: true, got: `A=${toA.length}(옛 판) · B=${toB.length}(현 판) · 다음 0` };
      } catch (err) { return { name, ok: false, got: String(err) }; } finally { fs.rmSync(legacyRoot, { recursive: true, force: true }); }
    })());
    // ── §16 b 옛 판 소비자(롤백 부팅) — POSIX link 불가 홈의 단일 실패가 고정 슬롯에 링크로: 옛 판이 바로 1회(§15 의 지연 회귀 해소) ─────────────
    for (const platform of ["darwin", "linux"] as const) checks.push(await (async () => {
      const name = `★§16 b 옛 판 소비자(롤백 부팅, ${platform}) — link 불가 홈의 단일 실패가 symlink 로 고정 슬롯에 → 옛 판(4c8bd246)이 링크를 따라 요청 대상에 1 · 링크만 지움 → 다음 현 판 부팅 실패 0 · 링크 대상 임시본 1 남음(다시 안 나감)`;
      const fx = path.join(repo, "src/scripts/regression/fixtures/legacy-update-consumer-4c8bd246");
      const legacyRoot = fs.mkdtempSync(path.join(home, "legacy-4c8bd246-"));
      try {
        fs.mkdirSync(path.join(legacyRoot, "src")); fs.mkdirSync(path.join(legacyRoot, "bin"));
        fs.copyFileSync(path.join(fx, "index-region.ts.txt"), path.join(legacyRoot, "src", "index.ts"));
        fs.copyFileSync(path.join(fx, "update-marker.mjs.txt"), path.join(legacyRoot, "bin", "update-marker.mjs"));
        const oldRunner = await makeBootRunner(legacyRoot);
        const live = { mode: "direct", state: "ready", attempt: "live-attempt", notify: { channel: "telegram", target: "live-chat", threadKey: "dashboard:side" } };
        const r = simulate("npm-fail", { platform, linkFail: true, seedPending: live });
        assert(fs.lstatSync(path.join(r.home, ".update-failed")).isSymbolicLink(), homeNames(r.home).join(","));
        const k = { t: 0 };
        const oldBoot = await oldRunner({ fsp: fspReal, home: r.home, boot: laterBoot(r), updateOriginSession, updateFailedText, translate, now: () => k.t, sleep: async (ms) => { k.t += ms; } });
        const left = homeNames(r.home);
        const newBoot = await consumeAt(r, nextBoot(r));
        assert(oldBoot.failure.length === 1 && oldBoot.failure[0]!.channel === "telegram" && oldBoot.failure[0]!.target === "live-chat" && /Update failed/.test(oldBoot.failure[0]!.text) &&
          left.length === 1 && left[0]!.startsWith(".update-failed.next-") && newBoot.failure.length === 0 && JSON.stringify(homeNames(r.home)) === JSON.stringify(left),
          `old=${JSON.stringify(oldBoot.failure)} left=${left.join(",")} new=${JSON.stringify(newBoot.failure)}`);
        return { name, ok: true, got: `옛 판 1 · 다음 현 판 0 · 남은 임시본 ${left[0]}` };
      } catch (err) { return { name, ok: false, got: String(err) }; } finally { fs.rmSync(legacyRoot, { recursive: true, force: true }); }
    })());
    checks.push(await (async () => {
      const name = "★§16 b 현 판 소비자: 고정 슬롯 링크의 대상이 같은 폴더 임시본(`.update-failed.next-*`)이 아니면 배달은 하되 그 대상은 지우지 않는다(홈 밖 파일 그대로) · 링크 선점본은 치움 · 다음 0";
      try {
        const h = fs.mkdtempSync(path.join(home, "foreign-link-"));
        const outside = path.join(path.dirname(h), `${path.basename(h)}-outside.json`);
        fs.writeFileSync(outside, JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "x", notify: { channel: "fixture", target: "t-link", threadKey: "dashboard:side" } }));
        fs.symlinkSync(path.join("..", path.basename(outside)), path.join(h, ".update-failed"));
        const r0 = { home: h } as ReturnType<typeof simulate>;
        const b = await consumeAt(r0, laterBoot({ ...r0, completion: null } as ReturnType<typeof simulate>));
        const f = b.deliveries.filter((x) => /Update failed/.test(x.text));
        assert(f.length === 1 && f[0]!.target === "t-link" && fs.existsSync(outside) && homeNames(h).length === 0, JSON.stringify({ f, names: fs.readdirSync(h), outside: fs.existsSync(outside) }));
        const again = await consumeAt(r0, { ...laterBoot({ ...r0, completion: null } as ReturnType<typeof simulate>), bootId: "55555555-5555-4555-8555-555555555555" });
        assert.equal(again.deliveries.filter((x) => /Update failed/.test(x.text)).length, 0);
        fs.rmSync(outside, { force: true });
        return { name, ok: true, got: "배달 1 · 대상 그대로 · 다음 0" };
      } catch (err) { return { name, ok: false, got: String(err) }; }
    })());
    test("★§15 healthSaysOurs 는 `/health` 의 updateResultsPending 을 그대로 돌려준다(불리언만 — 옛 판은 없음)", () => {
      const src = source.slice(source.indexOf("const healthSaysOurs = (c) => {"), source.indexOf("\n};", source.indexOf("const healthSaysOurs = (c) => {")) + 3);
      const id = "a".repeat(64);
      const mk = (extra: Record<string, unknown>) => new Function("winPort", "spawnSync", "process", "instanceIdFor", src + ";return healthSaysOurs;")(
        () => "7021", () => ({ status: 0, stdout: JSON.stringify({ ok: true, instanceId: id, bootId: "33333333-3333-4333-8333-333333333333", startedAt: Date.now() - 10, revision: "2".repeat(40), ...extra }), stderr: "HTTP 200" }), process, () => id);
      const t = mk({ updateResultsPending: true })({}), f = mk({ updateResultsPending: false })({}), none = mk({})({}), str = mk({ updateResultsPending: "yes" })({});
      assert(t.ok && t.updateResultsPending === true && f.updateResultsPending === false && none.updateResultsPending === undefined && str.updateResultsPending === undefined, JSON.stringify({ t, f, none, str }));
      return "true/false/없음/형식 오류";
    });
    checks.push(await (async () => {
      const name = "★§15 쓸기의 디렉터리 기록: record.json 만 소비하고 빈 디렉터리만 치운다 — 다른 항목이 있으면 선점본째 보존(재귀 삭제 0) · 배달 1 · 다음 0";
      try {
        const h = fs.mkdtempSync(path.join(home, "dirrec-"));
        const dir = path.join(h, ".update-failed.unsent-fixture");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ stage: "build", outcome: "rolled-back", attempt: "x", notify: { channel: "fixture", target: "t-dir", threadKey: "dashboard:side" } }));
        fs.writeFileSync(path.join(dir, "keep-me.txt"), "extra bytes");
        const r0 = { home: h } as ReturnType<typeof simulate>;
        const b = await consumeAt(r0, laterBoot({ ...r0, completion: null } as ReturnType<typeof simulate>));
        const f = b.deliveries.filter((x) => /Update failed/.test(x.text));
        const claims = fs.readdirSync(h).filter((n) => n.includes(".claim-"));
        assert(f.length === 1 && f[0]!.target === "t-dir" && claims.length === 1 && fs.readFileSync(path.join(h, claims[0]!, "keep-me.txt"), "utf8") === "extra bytes" && !fs.existsSync(path.join(h, claims[0]!, "record.json")), JSON.stringify({ f, names: fs.readdirSync(h) }));
        const again = await consumeAt(r0, { ...laterBoot({ ...r0, completion: null } as ReturnType<typeof simulate>), bootId: "55555555-5555-4555-8555-555555555555" });
        assert.equal(again.deliveries.filter((x) => /Update failed/.test(x.text)).length, 0);
        return { name, ok: true, got: `배달 1 · 보존 ${claims[0]}` };
      } catch (err) { return { name, ok: false, got: String(err) }; }
    })());
    test("수동 start/restart 는 지연이 새지 않는다 — 업데이트 밖 reportLaunch 미확인은 여전히 exit 1", () => {
      const src = source.slice(source.indexOf("const reportLaunch = ("), source.indexOf("\n};", source.indexOf("const reportLaunch = (")) + 3);
      const proc = { exitCode: 0 as number | undefined }; const msgs: string[] = [];
      const rep = new Function("process", "console", "winPort", src + ";return reportLaunch;")(proc, { log: () => {}, warn: (m: string) => msgs.push(m), error: (m: string) => msgs.push(m) }, () => "7021");
      const w = { pids: [], last: { pids: [], health: { ok: false, why: "x" } }, lastKnown: null, everSeen: false, probeFailures: 0, waitedMs: 20000, verified: false, healthWhy: "x" };
      rep({}, w, "started", "h"); assert.equal(proc.exitCode, 1);
      proc.exitCode = 0; rep({ deferLaunchVerdict: false }, w, "started", "h"); assert.equal(proc.exitCode, 1);
      proc.exitCode = 0; rep({ deferLaunchVerdict: true }, w, "started", "h"); assert.equal(proc.exitCode, 0);
      return "plain=1 · deferred=0";
    });
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
      assert(fs.existsSync(path.join(r.home, ".update-pending")));
    });
    test("★완료 표시의 «무엇에서» 는 호출자가 준 실행 빌드 — 롤백·되돌리기 앵커는 여전히 pull 전 HEAD (v0.79.1 잔여 P2)", () => {
      // 받을 커밋 없이 빌드만 뒤처져 위임되면 pull 전 HEAD == 새 HEAD 라 완료 로그·마커가 «B → B» 였다(Windows 실측 «0c555dd → 0c555dd»).
      const done = (r: { home: string }) => JSON.parse(fs.readFileSync(path.join(r.home, ".update-pending"), "utf8")) as { from: string; to: string };
      const ok = simulate("success", { notify: true, handoff: "1111111", reportFrom: "0abcdef9" });
      assert.equal(ok.exitCode, 0, ok.messages.join(" | "));
      assert.equal(done(ok).from, "0abcdef", JSON.stringify(done(ok)));
      assert(ok.messages.some((m) => m.includes("update complete: 0abcdef → 2222222")), ok.messages.join(" | "));
      // 실패 경로: 되돌리는 곳은 앵커(1111111)다 — 표시값으로 reset 하면 사용자 checkout 을 엉뚱한 곳으로 옮긴다.
      const bad = simulate("npm-fail", { notify: true, handoff: "1111111", reportFrom: "0abcdef9" });
      assert(bad.calls.includes("git reset --keep 1111111") && !has(bad.calls, /0abcdef/), bad.calls.join(" | "));
      // 재가동 실패 요약도 같은 표시값.
      const nostart = simulate("success", { notify: true, handoff: "1111111", reportFrom: "0abcdef9", startFails: "exit" });
      assert(nostart.messages.some((m) => m.includes("0abcdef → 2222222")), nostart.messages.join(" | "));
      // 없거나 형식이 틀리면 종전대로 앵커 — 셸 문자 같은 값을 그대로 싣지 않는다.
      const plain = simulate("success", { notify: true, handoff: "1111111" });
      const junk = simulate("success", { notify: true, handoff: "1111111", reportFrom: "zz; rm -rf" });
      assert.equal(done(plain).from, "1111111"); assert.equal(done(junk).from, "1111111");
      // 생산자: 위임 env 에 실행 빌드를 따로 싣는다(앵커 키와 다른 키).
      const su = fs.readFileSync(path.join(repo, "src/core/self-update.ts"), "utf8");
      // 위임 env 는 spawn 과 같은 함수로 만든다 — 함수의 값과 spawn 배선을 따로 본다.
      const de = updateDelegationEnv({}, { prevSha: "1111111", reportFrom: "0abcdef9" });
      assert(de.TIGUCLAW_UPDATE_PREV_SHA === "1111111" && de.TIGUCLAW_UPDATE_REPORT_FROM === "0abcdef9" && /const d = delegatedUpdateSpawnArgs\(deps, prevSha, reportFrom, process\.env, handoffToken\);[\s\S]{0,400}const child = \(deps\.spawnChild \?\? spawn\)\(d\.command, d\.args, d\.options\);/.test(su), "self-update 위임 env");
      // 위임 인자 함수가 요청 좌표를 env 로 옮긴다(호출부는 deps 를 그대로 넘긴다 — 위 정규식).
      const sp = delegatedUpdateSpawnArgs({ notify: { channel: "fixture", target: "t", threadKey: "dashboard:side" } }, "1111111", "0abcdef9", { TIGUCLAW_UPDATE_NOTIFY_THREAD: "stale" });
      assert(sp.options.env.TIGUCLAW_UPDATE_NOTIFY_THREAD === "dashboard:side" && sp.options.env.TIGUCLAW_UPDATE_NOTIFY_TARGET === "t" && sp.options.detached === true && sp.args.at(-1) === "update", JSON.stringify(sp));
      return `마커 from=${done(ok).from} · 실패 reset=1111111 · 없음/형식 오류=앵커`;
    });
    test("★Windows 위임 응답은 재시작 시각을 지어내지 않는다 — «약 5초» 는 직접 예약한 경로에서만 (실측 약 2분 49초)", () => {
      const delegated = { status: "updating" as const, from: "aaaaaaa", to: "bbbbbbb", changedFiles: 3 };
      const scheduled = { ...delegated, restartInMs: 5000 };
      const slash = formatSelfUpdateResult(delegated);
      assert(slash.includes(translate("srv.update.restartingAfterBuild")) && !slash.includes(translate("srv.update.restartingIn", { sec: 5 })), slash);
      assert(formatSelfUpdateResult(scheduled).includes(translate("srv.update.restartingIn", { sec: 5 })), formatSelfUpdateResult(scheduled));
      // 도구(update_self)도 같은 판단·같은 카탈로그 — 화면 언어를 따른다(이 스위트는 영어 카탈로그로 돈다: 한국어 리터럴이면 여기서 빨강).
      const tool = renderUpdateSelfResult(delegated);
      assert(tool.includes(translate("srv.update.restartingAfterBuild")) && !tool.includes(translate("srv.update.restartingIn", { sec: 5 })), tool);
      assert(renderUpdateSelfResult(scheduled).includes(translate("srv.update.restartingIn", { sec: 5 })), renderUpdateSelfResult(scheduled));
      return slash.split("\n").pop();
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
    test("★설치·빌드는 됐는데 재가동이 실패하면(종료코드·예외, start·restart) 옮겨 둔 옛 트리를 버리지 않는다 — 정확한 경로·«의존성뿐·이전 판 것» 을 말하고 ✅ 를 찍지 않는다", () => {
      // 2026-10-30: 종전엔 재가동 결과를 보기 **전에** 백업을 무조건 버렸다 — 실패한 순간 복구 재료가 사라졌다.
      const cases = { exit: simulate("success", { deps: "tree", startFails: "exit" }), throw: simulate("success", { deps: "tree", startFails: "throw" }),
        revived: simulate("success", { deps: "tree", startFails: "exit", revivedDuringCi: true }), revivedThrow: simulate("success", { deps: "tree", startFails: "throw", revivedDuringCi: true }),
        mac: simulate("success", { deps: "tree", startFails: "throw", platform: "darwin" }),
        // 세 OS 가 같은 공통 경로다 — 판정이 OS 를 갈라도 잡히게(독립 변이 사냥: «linux 만 빼기» 가 초록이었다).
        linux: simulate("success", { deps: "tree", startFails: "exit", platform: "linux" }), linuxThrow: simulate("success", { deps: "tree", startFails: "throw", platform: "linux" }) };
      for (const [k, r] of Object.entries(cases)) {
        const all = r.messages.join(" | ");
        assert.equal(r.exitCode, 1, `${k}: ${all}`); assert.equal(r.depsNow, "new-tree-1", k);
        assert.deepEqual(r.entries, [{ name: ".node_modules-prev-N", marker: "old-tree" }], `${k}: ${JSON.stringify(r.entries)}`);
        assert(!has(r.calls, /^(MV|RM|UNLINK)(-FAIL)?:\.node_modules-prev-N/), `${k}: ${r.calls.join(" | ")}`);
        const kept = r.messages.find((m) => /Kept the dependencies from before the update at /.test(m)) ?? "";
        // 실제로 남은 폴더의 **전체 경로**(타임스탬프 포함)를 말해야 한다 — 접두사만 보면 없는 경로를 말해도 통과한다(GPT 검토 R1).
        const real = fs.readdirSync(path.join(r.home, "repo")).filter((x) => x.startsWith(".node_modules-prev-"));
        assert(real.length === 1 && kept.includes(`at ${path.join(r.home, "repo", real[0] as string)} — `), `${k}: ${real.join(",")} · ${kept}`);
        assert(/node_modules only/.test(kept) && kept.includes("1111111"), `${k}: ${all}`);
        // 복구됐다·되돌릴 수 있다고 말하지 않는다(의존성뿐이라 지금 코드와 짝이 아니다).
        assert(!/restor|roll(ed)? ?back|revert/i.test(kept), `${k}: ${kept}`);
        assert(r.messages.some((m) => /🔴 The update was applied/.test(m)) && !r.messages.some((m) => /update complete/.test(m)), `${k}: ${all}`);
      }
      assert(has(cases.revived.calls, /^RESTART/) && has(cases.revivedThrow.calls, /^RESTART/) && cases.throw.messages.some((m) => /restart command failed: fixture: launchctl load failed/.test(m)), cases.throw.messages.join(" | "));
      // 다음 업데이트는 그 트리를 지우지 않고 알린다(종전 «prev 는 남긴다» 규칙 그대로).
      return "종료코드·예외·재시작·맥 = 백업 보존 + 경로";
    });
    test("★재가동하지 않는 정상 경로(멈춰 있던·미등록 홈)는 종전대로 옛 트리를 버린다 — 남는 것 0 · exit 0", () => {
      for (const registered of [true, false]) {
        const r = simulate("success", { deps: "tree", presence: "stopped", portClosed: true, registered });
        assert.equal(r.exitCode, 0, r.messages.join(" | ")); assert(!has(r.calls, /^(START|RESTART)/), r.calls.join(" | "));
        assert.deepEqual(r.entries, [], `registered=${registered}: ${JSON.stringify(r.entries)}`);
        assert(!r.messages.some((m) => /Kept the dependencies/.test(m)), r.messages.join(" | "));
      }
      return "미가동 = 정리";
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
      const installSrc = source.slice(source.indexOf("const winInstall = (c) => {"), source.indexOf("\n};\n", source.indexOf("const winInstall = (c) => {")));
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
        // 지운 경로를 **그대로** 적는다 — 가짜 `winLegacyVbsPath` 가 준 값과 같은가를 본다(basename 은 Windows 에서 `\` 를 잘라 기대와 갈렸다).
        (p: string) => ev.push("rm:" + p), () => "H\\win-launch.vbs",
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
      const ev: string[] = []; let waits = 0;
      const prevCode = process.exitCode;
      process.exitCode = undefined;
      const start = new Function("isDaemonRunning", "winPort", "winEnsureTask", "winTaskName", "winLaunchSupervisor", "winPs", "winEnableStartScript",
        "reportLaunch", "waitForListening", "listeningOnBridge", "path", "console", "winLaunchLegacyStartup", "expectFreshLaunch", "daemonPresence", startSrc + "; return winStart;")(
        () => o.running === true, () => 7021, () => { ev.push("ensure"); return o.mode; }, () => "task", () => ev.push("launch"),
        (x: string) => { ev.push(x); return { status: o.enableFails === true ? 1 : 0, stdout: "", stderr: "" }; }, () => "ENABLE_START",
        () => ev.push("report"), () => { waits++; return true; }, () => true, path, { log: () => {}, warn: () => ev.push("warn"), error: () => ev.push("error") },
        () => ev.push("launch-legacy"), () => {}, () => ({state:o.running?"running":"absent"}));
      start(c);
      const code = process.exitCode;
      process.exitCode = prevCode;
      return { ev, code, waits };
    };
    test("★start: 예약작업 활성화 실패는 실제 실패 주입으로 검출하고 완료 보고하지 않는다", () => {
      const failed = runStart({ mode: true, enableFails: true });
      assert.deepEqual(failed.ev, ["ensure", "ENABLE_START", "error"]);
      assert.equal(failed.code, 1);
      assert.equal(failed.waits, 0);
      return "enable failure: error + exit1, no launch/wait/report";
    });
    test("★최종 빌드 뒤 cutoff: 중간 세대 배제·fresh 실패면 백업 보존과 완료 요약 실패", () => {
      const bad = simulate("success", { deps: "tree", revivedDuringCi: true, staleAfterResume: true });
      assert.equal(bad.exitCode, 1);
      assert(bad.calls.includes("CAPTURE:1:intermediate"), bad.calls.join(" | "));
      assert(bad.calls.indexOf("CAPTURE:1:intermediate") > bad.calls.indexOf("npm run build:prod"));
      assert(bad.entries.some(e => e.marker === "old-tree"), JSON.stringify(bad.entries));
      assert(!bad.messages.some(m => m.includes("✅ update complete")));
      const good = simulate("success", { deps: "tree", revivedDuringCi: true });
      assert.equal(good.exitCode, 0);
      assert(good.calls.includes("CAPTURE:1:intermediate"));
      assert(good.messages.some(m => m.includes("✅ update complete")));
      return "real resume + wait/report; same build, stale vs fresh generation";
    });
    test("★start: 이미 돌면 아무것도 안 한다(등록·기동 0) · 예약작업=켜고 띄움 · 폴백·지금만=직접 기동 · 지금만은 실패 코드 없이 경고 · 등록 불가=실패", () => {
      const running = runStart({ running: true, mode: true });
      assert.deepEqual(running.ev, []); assert.equal(running.code, undefined);
      const task = runStart({ mode: true });
      assert.deepEqual(task.ev, ["ensure", "ENABLE_START", "report"]); assert.equal(task.code, undefined); assert.equal(task.waits, 1);
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
        (p: string) => ev.push("rm:" + p), () => "H\\win-launch.vbs", () => ({ state: "missing" }), { log: () => {}, warn: () => {}, error: () => {} }, { exitCode: 0 });
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
      const claims = (t: string) => /rolled back to the previous version/.test(t);
      assert(!claims(un) && /nothing was changed/.test(un), un);
      // ★롤백 마커는 재기동 **전**에 쓴다 — «재가동했다» 를 단정하지 않는다(2026-11-25 설계 R1 #4).
      assert(claims(rb) && !/restarted/.test(rb), rb);
      const ru = updateFailedText({ stage: "restart", outcome: "restart-unconfirmed" });
      const re = updateFailedText({ stage: "restart", outcome: "restart-error" });
      assert(!claims(ru) && /No rollback was attempted/.test(ru) && /could not be confirmed/.test(ru) && !/could not be fully restored/.test(ru), ru);
      assert(!claims(re) && /No rollback was attempted/.test(re) && /start command reported an error/.test(re), re);
      assert(!claims(nc) && /tiguclaw update/.test(nc), nc);
      assert(!claims(old), old); // outcome 없는 옛 마커 — 무엇을 했는지 모른다
      // 배선 — 부팅 때 마커를 읽는 자리가 이 함수를 쓴다(고정 문장이 남아 있으면 위 판정이 아무 데도 안 간다).
      const idx = fs.readFileSync(path.join(repo, "src/index.ts"), "utf8");
      assert(/updateFailedText\(data[ )]/.test(idx) && !/rolled back to the previous version and restarted/.test(idx), "index.ts 가 고정 문장을 쓴다");
      return [un, nc].map((t) => t.slice(0, 70)).join(" | ");
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return checks;
}};
