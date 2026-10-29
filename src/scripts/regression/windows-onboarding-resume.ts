/** Git-less Windows/re-entry and Codex-only doctor must not contradict the runtime. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { onboardingEnv, proveOnboardingIsolation, readAudit, tsxLoader } from "./_windows-onboarding-env.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const checkResumePreservesAuth = (cliFile: string, fixture: string): Assertion => {
  mkdirSync(fixture, { recursive: true });
  const home = path.join(fixture, "home"); mkdirSync(home);
  const bin = path.join(fixture, "bin"); mkdirSync(bin);
  const envFile = path.join(home, ".env");
  const original = "TIGUCLAW_PROVIDER=codex\nOPENAI_CODEX_OAUTH_REFRESH=fixture-refresh\nHTTP_BRIDGE_TOKEN=fixture-keep\n";
  writeFileSync(envFile, original);
  writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "NPM_CALL=%s\\n" "$*"\nexit 78\n', { mode: 0o700 });
  const env = onboardingEnv(fixture, home);
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  delete env.TIGUCLAW_DISABLE_ENV_FILE;
  const r = spawnSync(process.execPath, ["--import", tsxLoader, cliFile, "onboard"], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 });
  const calls = (r.stdout ?? "").split("\n").filter((line) => line.startsWith("NPM_CALL="));
  return assert("실제 onboard 재진입: init/OAuth/서비스 없이 기존 인증·설정을 보존하고 build까지 진행", r.status === 1 && calls.length === 1 && calls[0] === "NPM_CALL=run build:prod" && readFileSync(envFile, "utf8") === original, { calls, exit: r.status, stderr: r.stderr?.slice(-250) });
};

export const checkFreshOAuthReachesChildren = (cliFile: string, fixture: string): Assertion => {
  mkdirSync(fixture, { recursive: true });
  const home = path.join(fixture, "home"); mkdirSync(home);
  const bin = path.join(fixture, "bin"); mkdirSync(bin);
  writeFileSync(path.join(home, ".env"), "TIGUCLAW_PROVIDER=codex\nOPENAI_CODEX_OAUTH_TOKEN=\nOPENAI_CODEX_OAUTH_REFRESH=\n");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh
printf 'NPM_CALL=%s\\n' "$*"
if [ "$2" = codex-auth ]; then
  printf 'TIGUCLAW_PROVIDER=codex\\nOPENAI_CODEX_OAUTH_TOKEN=fixture-new-token\\nOPENAI_CODEX_OAUTH_REFRESH=fixture-new-refresh\\n' > "$TIGUCLAW_HOME/.env"
  exit 0
fi
if [ "$OPENAI_CODEX_OAUTH_TOKEN" = fixture-new-token ]; then echo FRESH_AUTH=yes; else echo FRESH_AUTH=no; fi
exit 78
`, { mode: 0o700 });
  const env = onboardingEnv(fixture, home);
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  delete env.TIGUCLAW_DISABLE_ENV_FILE;
  const r = spawnSync(process.execPath, ["--import", tsxLoader, cliFile, "onboard"], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 });
  return assert("새 OAuth 뒤 빈 부모 인증 snapshot을 갱신해 다음 자식에게 실제 저장 결과 전달", r.status === 1 && r.stdout.includes("NPM_CALL=run codex-auth") && r.stdout.includes("NPM_CALL=run build:prod") && r.stdout.includes("FRESH_AUTH=yes") && !r.stdout.includes("NPM_CALL=run init"), { stdout: r.stdout.slice(-700), stderr: r.stderr.slice(-200), exit: r.status });
};

export const check: RegressionCheck = {
  name: "windows-onboarding-resume",
  guards: "Codex-only 인증을 doctor가 없다고 오진하던 것, 재개가 설정/OAuth를 다시 만들고 npx.ps1 정책에 막히던 것, 전용 Git가 서비스/업데이트에서 사라지는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const fixture = mkdtempSync(path.join(tmpdir(), "tiguclaw-win-onboard-"));
    try {
    const isolation = proveOnboardingIsolation(path.join(fixture, "sentinel"));
    out.push(isolation);
    if (!isolation.ok) return out;
    const isolatedEnv = (home: string): NodeJS.ProcessEnv => {
      const env = onboardingEnv(home, home);
      env.TIGUCLAW_DISABLE_ENV_FILE = "1";
      return env;
    };
    for (const mode of ["access", "refresh", "disabled", "none", "claude", "openai", "custom"]) {
      const home = path.join(fixture, mode); mkdirSync(home);
      const r = spawnSync(process.execPath, ["--import", tsxLoader, path.join(root, "src/scripts/regression/_windows-onboarding-child.ts"), mode], { cwd: home, env: isolatedEnv(home), encoding: "utf8", timeout: 30_000 });
      const line = r.stdout?.split("\n").find((x) => x.startsWith("PROBE_RESULT="));
      const v = line ? JSON.parse(line.slice("PROBE_RESULT=".length)) : {};
      out.push(assert(`독립 CLI 인증 ${mode}: runtime predicate·플러그인 게이트·자동 풀 일치`, r.status === 0 &&
        v.codex === ["access", "refresh"].includes(mode) && v.claude === (mode === "claude") && v.openai === (mode === "openai") && v.custom === (mode === "custom") &&
        v.registered === (mode !== "disabled") && (mode === "disabled" || v.tokenBlocked === true) &&
        (!["access", "refresh"].includes(mode) || v.pool.some((s: string) => s.startsWith("codex:"))), { status: r.status, result: v, error: r.stderr?.slice(-300) }));
    }
    for (const mode of ["refresh", "openai", "disabled"]) {
      const env = isolatedEnv(path.join(fixture, mode));
      env.HTTP_BRIDGE_PORT = "1"; env.DASHBOARD_PORT = "2";
      if (mode === "openai") env.OPENAI_API_KEY = "fixture-openai";
      else env.OPENAI_CODEX_OAUTH_REFRESH = "fixture-refresh";
      const r = spawnSync(process.execPath, ["--import", tsxLoader, path.join(root, "src/scripts/doctor.ts")], { cwd: path.join(fixture, mode), env, encoding: "utf8", timeout: 30_000 });
      const ready = (r.stdout ?? "").includes("available ✅ (model response not tested)");
      out.push(assert(`실제 doctor ${mode}: 설치 health 실패와 LLM 인증 유무를 별도로 판정`, (mode === "disabled" ? r.status === 1 : r.status === 0 || r.status === 1) && ready === (mode !== "disabled") &&
        (mode === "disabled" ? r.stdout.includes("No authenticated provider") : !r.stdout.includes("No authenticated provider")) &&
        (mode !== "refresh" || r.stdout.includes("codex:")), { exit: r.status, authLine: r.stdout.split("\n").find((line) => line.includes("LLM credentials")), error: r.stderr.slice(-100) }));
    }
    // Execute real CLI until build, replacing only npm. Never starts a daemon.
    if (process.platform !== "win32") {
      out.push(checkResumePreservesAuth(path.join(root, "src/cli.ts"), path.join(fixture, "resume")));
      out.push(checkFreshOAuthReachesChildren(path.join(root, "src/cli.ts"), path.join(fixture, "fresh-oauth")));
    }
    // Dep-free helper is executed as actual JS on all hosts with Windows env/path fixtures.
    const helperUrl = new URL("../../../bin/windows-tools.mjs", import.meta.url).href;
    const js = `import { applyWindowsTools } from ${JSON.stringify(helperUrl)};
      const e=${JSON.stringify({ LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', Path: 'C:\\System' })};
      e.TIGUCLAW_HOME=${JSON.stringify(fixture)}; applyWindowsTools(e,'win32',()=>true,()=>false);
      const custom={...e,CLAUDE_CODE_GIT_BASH_PATH:${JSON.stringify('D:\\custom\\bash.exe')}};
      applyWindowsTools(custom,'win32',()=>true,()=>true);
      const mac={Path:'original'};applyWindowsTools(mac,'darwin',()=>true,()=>false);
      console.log(JSON.stringify({e,custom,mac}));`;
    const tools = spawnSync(process.execPath, ["--input-type=module", "-e", js], { cwd: fixture, env: isolatedEnv(fixture), encoding: "utf8" });
    const t = tools.status === 0 ? JSON.parse(tools.stdout) : {};
    out.push(assert("새 Windows 프로세스의 전용 Git/Bash 재발견·명시 Bash 보존·다른 OS 무변경", tools.status === 0 && t.e?.Path?.includes("tiguclaw\\tools\\git\\cmd;") && t.e?.CLAUDE_CODE_GIT_BASH_PATH?.endsWith("bin\\bash.exe") && t.custom?.CLAUDE_CODE_GIT_BASH_PATH === "D:\\custom\\bash.exe" && t.mac?.Path === "original", { t, stderr: tools.stderr }));
    const installer = readFileSync(path.join(root, "install.ps1"), "utf8");
    const psCode = installer.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const relativePattern = installer.match(/\$unscopedDaemon = \$proc\.CommandLine -match '([^']+)'/);
    const relativeDaemon = relativePattern ? new RegExp(relativePattern[1]!.replace("(?i)", ""), "i") : /$a/;
    out.push(assert("상대경로 npm start/source/supervisor는 cwd 불명으로 중단하며 무관한 Node는 오인하지 않음", /if \(!\$proc.CommandLine -or \$unscopedDaemon -or/.test(installer) &&
      ['"C:\\Program Files\\nodejs\\node.exe" dist/src/index.js', 'node src/index.ts', 'node bin/daemon.mjs supervise', 'node ./dist/src/index.js', 'node .\\dist\\src\\index.js', 'node ../other/dist/src/index.js', 'node ..\\other\\src\\index.ts'].every((cmd) => relativeDaemon.test(cmd)) && !relativeDaemon.test('node unrelated-app.js'), { pattern: relativePattern?.[1], unscopedGuard: installer.match(/if \(!\$proc.CommandLine -or \$unscopedDaemon -or/)?.[0], unrelated: relativeDaemon.test("node unrelated-app.js") }));
    const cli = readFileSync(path.join(root, "src/cli.ts"), "utf8");
    // Exercise the real entrypoint, not just the exported helper. Preserve the production
    // src/bin shape in the built fixture, using only these four dependency-free files.
    const ts = await import("typescript");
    const builtRoot = path.join(fixture, "built");
    mkdirSync(path.join(builtRoot, "src/core"), { recursive: true });
    mkdirSync(path.join(builtRoot, "bin"), { recursive: true });
    writeFileSync(path.join(builtRoot, "package.json"), '{"type":"module"}');
    for (const name of ["load-env", "credential-env", "legacy-ports"]) {
      const file = path.join(root, "src/core", `${name}.ts`);
      const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      });
      writeFileSync(path.join(builtRoot, "src/core", `${name}.js`), emitted.outputText);
    }
    copyFileSync(path.join(root, "bin/windows-tools.mjs"), path.join(builtRoot, "bin/windows-tools.mjs"));
    for (const [label, entry] of [["source", path.join(root, "src/core/load-env.ts")], ["built", path.join(builtRoot, "src/core/load-env.js")]]) {
      const base = path.join(fixture, `load-env-${label}`);
      const env: NodeJS.ProcessEnv = { ...onboardingEnv(base), TIGUCLAW_DISABLE_ENV_FILE: "0" };
      const home = env.TIGUCLAW_HOME!;
      mkdirSync(path.join(home, "data"), { recursive: true });
      writeFileSync(path.join(home, "data/ports-settled"), "synthetic");
      // Only this test-owned .env is read. A static sibling must see it before the
      // Windows asset await; otherwise ordinary module-level env constants drift.
      writeFileSync(path.join(home, ".env"), "WINDOWS_ENV_ORDER_FIXTURE=synthetic-env-first\n");
      writeFileSync(path.join(base, "capture.mjs"), "export const seen=process.env.WINDOWS_ENV_ORDER_FIXTURE;");
      const siblingEntry = path.join(base, "entry.mjs");
      writeFileSync(siblingEntry, `import ${JSON.stringify(pathToFileURL(entry).href)}; import {seen} from './capture.mjs'; globalThis.__windowsEnvSeen=seen;`);
      const git = path.win32.join(env.LOCALAPPDATA!, "tiguclaw/tools/git");
      const cmd = path.win32.join(git, "cmd");
      const bash = path.win32.join(git, "bin/bash.exe");
      const files = [path.win32.join(cmd, "git.exe"), bash, path.win32.join(git, "tiguclaw-portable-git.json")];
      const mapped = files.map((_, i) => path.join(base, `synthetic-tool-${i}`));
      for (const file of mapped) writeFileSync(file, "synthetic, never executed");
      // Translate only these three synthetic Windows filenames on non-Windows hosts.
      // Every other filesystem/process call keeps its original safety guard.
      const code = `import fs from "node:fs"; import cp from "node:child_process"; import {syncBuiltinESMExports} from "node:module";
const virtual=${JSON.stringify(files)}, mapped=${JSON.stringify(mapped)}; const exists=fs.existsSync, spawn=cp.spawnSync; let gitProbes=0;
fs.existsSync=(file)=>{const i=virtual.indexOf(String(file));return exists(i<0?file:mapped[i]);};
cp.spawnSync=(command,args,...rest)=>{if(command==="git.exe"&&JSON.stringify(args)==='["--version"]'){gitProbes++;return {status:1};}return spawn(command,args,...rest);};
syncBuiltinESMExports();Object.defineProperty(process,"platform",{value:"win32"});
await import(${JSON.stringify(pathToFileURL(siblingEntry).href)});console.log("LOAD_ENV_RESULT="+JSON.stringify({bash:process.env.CLAUDE_CODE_GIT_BASH_PATH,path:process.env.PATH,gitProbes,envFirst:globalThis.__windowsEnvSeen}));`;
      const r = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", code], { cwd: base, env, encoding: "utf8", timeout: 25_000 });
      const line = r.stdout?.split("\n").find((x) => x.startsWith("LOAD_ENV_RESULT="));
      const got = line ? JSON.parse(line.slice("LOAD_ENV_RESULT=".length)) : {};
      out.push(assert(`합성 Windows의 실제 load-env ${label}: env-first를 보존하며 전용 Git/Bash 발견을 호출한다`, r.status === 0 && got.bash === bash && got.path?.startsWith(cmd + ";") && got.gitProbes === 1 && got.envFirst === "synthetic-env-first", { status: r.status, result: got, error: r.stderr?.slice(-300) }));
    }

    const daemon = readFileSync(path.join(root, "bin/daemon.mjs"), "utf8");
    const doctor = readFileSync(path.join(root, "src/scripts/doctor.ts"), "utf8");
    out.push(
      assert("배선: doctor는 auth probe 후 runtime 기본 풀의 provider 가용성으로 판정", doctor.indexOf("await registerStandaloneAuthProbes()") < doctor.indexOf("const base = describeBasePool()") && /base\.specs\.some/.test(doctor) && /providerAuthAvailable\(spec.provider\)/.test(doctor) && !/hasRegionAAuth = anthropicKey/.test(doctor), { probeAt: doctor.indexOf("await registerStandaloneAuthProbes()"), poolAt: doctor.indexOf("const base = describeBasePool()"), providerCheck: doctor.match(/providerAuthAvailable\(spec.provider\)/)?.[0] }),
      assert("배선: 서비스/업데이트 부모와 CLI가 dep-free 전용 도구 발견 사용", /applyWindowsTools\(\)/.test(daemon) && /applyWindowsTools\(env\)/.test(daemon) && /applyWindowsTools\(\)/.test(readFileSync(path.join(root, "bin/tiguclaw.mjs"), "utf8")), { daemonCalls: daemon.match(/applyWindowsTools\([^)]*\)/g), cliCalls: readFileSync(path.join(root, "bin/tiguclaw.mjs"), "utf8").match(/applyWindowsTools\([^)]*\)/g) }),
      assert("배선: Git 동의·공식 URL·SHA256 뒤에만 추출/공개, 전역 PATH/보안정책 변경 없음", installer.indexOf("$consent = Read-Host") < installer.indexOf("$release = Invoke-RestMethod") && installer.indexOf("if ($actual -ine $asset.digest.Substring(7))") < installer.indexOf("$extract = Start-Process") && installer.includes("^sha256:[a-fA-F0-9]{64}$") && installer.includes("git-for-windows/git/releases/latest") && !/Set-ExecutionPolicy|setx\s|SetEnvironmentVariable\(/i.test(psCode), { consentAt: installer.indexOf("$consent = Read-Host"), releaseAt: installer.indexOf("$release = Invoke-RestMethod"), digestAt: installer.indexOf("if ($actual -ine $asset.digest.Substring(7))"), extractAt: installer.indexOf("$extract = Start-Process"), systemChanges: psCode.match(/Set-ExecutionPolicy|setx\s|SetEnvironmentVariable\(/ig) }),
      assert("배선: 기존·부분 폴더/가동 여부 검증이 의존성 교체 앞에 있고 npm.cmd/node.exe 사용", installer.indexOf("Get-CimInstance Win32_Process") < installer.indexOf("& $Npm ci") && installer.includes("if ($ExistingInstall)") && installer.includes("Join-Path $NodeDir 'node.exe'") && !/npx tiguclaw update|^git clone/m.test(psCode) && installer.includes("Get-Command npm.cmd -ErrorAction Stop"), { processCheckAt: installer.indexOf("Get-CimInstance Win32_Process"), ciAt: installer.indexOf("& $Npm ci"), bareCommands: psCode.match(/npx tiguclaw update|^git clone/gm), npm: installer.match(/Get-Command npm.cmd -ErrorAction Stop/)?.[0] }),
      assert("배선: 모델 응답을 health/auth 존재와 구분", doctor.includes("model response not tested") && cli.includes("a real model reply has not been tested"), { doctorNotice: doctor.match(/model response not tested/)?.[0], cliNotice: cli.match(/a real model reply has not been tested/)?.[0] }),
    );
    const auditRoots = [fixture, ...["access", "refresh", "disabled", "none", "claude", "openai", "custom", "resume", "fresh-oauth"].map((name) => path.join(fixture, name))];
    const events = auditRoots.flatMap(readAudit);
    out.push(assert("모든 auth/doctor/CLI child의 자격 읽기 경로가 fixture 안이며 가드는 네트워크를 거부", events.filter((e) => e.kind === "sandbox-ready").length >= 10 && !events.some((e) => e.kind === "credential-read" && !e.allowed), { ready: events.filter((e) => e.kind === "sandbox-ready").length, deniedCredential: events.filter((e) => e.kind === "credential-read" && !e.allowed), networkBlocked: events.filter((e) => e.kind === "network-denied").length }));
    return out;
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  },
};
