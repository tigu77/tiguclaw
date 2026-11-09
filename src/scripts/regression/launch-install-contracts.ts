import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const source = await readFile(path.join(ROOT, "bin/daemon.mjs"), "utf8");
  const ast = ts.createSourceFile("daemon.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, string>();
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) declarations.set(d.name.text, `const ${d.getText(ast)};`);
  }
  const fn = (names: string[], deps: Record<string, unknown> = {}) => new Function(...Object.keys(deps), names.map(n => declarations.get(n) ?? `throw Error("missing ${n}")`).join("\n") + `\nreturn ${names.at(-1)};`)(...Object.values(deps));
  const context = { repoRoot: "/fixture/한 글 &<>\"' \\ $VAR ${VAR} %n ; &amp;", homeRaw: "/home/한 글 &<>\"' $HOME %h", homeAbs: "/home/fixture", logsDir: "/logs/a&b", nodePath: "/node/한 글 &<>\"' \\ $VAR ${VAR} %n/bin/node", runtime: "source", entry: "/entry/&<>'\".ts", tsxCli: "/tsx/&<>'\".mjs", distEntry: "/dist/&<>'\".js", label: "label&<>\"'&amp;" };
  const strings = (c: typeof context) => c.runtime === "source" ? [c.nodePath, c.tsxCli, c.entry] : [c.nodePath, c.distEntry];
  try {
    const render = fn([...(declarations.has("xmlText") ? ["xmlText"] : []), "buildLaunchdPlist"], { path, execStrings: strings });
    for (const runtime of ["source", "built"]) {
      const c = { ...context, runtime, homeRaw: context.homeRaw + "\r\n\t" };
      const xml = render(c);
      const parsed = spawnSync("/usr/bin/python3", ["-c", "import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"], { input: xml, encoding: "utf8" });
      let value: any; try { value = JSON.parse(parsed.stdout); } catch { value = null; }
      out.push(assert(`plist standard-parser roundtrip ${runtime}`, parsed.status === 0 && value?.Label === c.label && JSON.stringify(value?.ProgramArguments) === JSON.stringify(strings(c)) && value?.WorkingDirectory === c.repoRoot && value?.EnvironmentVariables.TIGUCLAW_HOME === c.homeRaw && value?.EnvironmentVariables.TIGUCLAW_RUNTIME === runtime && value?.EnvironmentVariables.PATH === path.dirname(c.nodePath) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" && value?.StandardOutPath === path.join(c.logsDir, "launchd.out.log") && value?.StandardErrorPath === path.join(c.logsDir, "launchd.err.log"), parsed.stderr));
    }
    let refused = false; try { render({ ...context, label: "bad\0" }); } catch { refused = true; }
    out.push(assert("plist rejects forbidden XML before writing", refused, undefined));
  } catch (e) { out.push(assert("plist renderer executes", false, String(e))); }
  try {
    const render = fn(["buildSystemdUnit"], { path, execStrings: strings });
    const unit = render(context);
    const execLine = unit.split("\n").find((s: string) => s.startsWith("ExecStart="));
    const envLine = unit.split("\n").find((s: string) => s.startsWith("Environment=\"TIGUCLAW_HOME="));
    out.push(assert("systemd fields quote argv, percent and dollars independently", execLine?.includes('"/node/') && execLine?.includes("$$VAR") && execLine?.includes("$${VAR}") && execLine?.includes("%%n") && execLine?.includes('\\"') && envLine?.includes("$HOME %%h") && !envLine?.includes("$$HOME") && unit.includes(`WorkingDirectory=${context.repoRoot.replace(/%/g, "%%")}\n`), unit));
    for (const runtime of ["source", "built"]) {
      const c = { ...context, runtime }; const text = render(c);
      const exec = text.split("\n").find((s: string) => s.startsWith("ExecStart="))!.slice(10);
      const tokens = exec.match(/"(?:\\.|[^"\\])*"/g) ?? [];
      const decoded = tokens.map((token: string) => JSON.parse(token).replace(/%%/g, "%").replace(/\$\$/g, "$"));
      const environment = text.split("\n").filter((s: string) => s.startsWith("Environment=")).map((s: string) => JSON.parse(s.slice(12)).replace(/%%/g, "%"));
      out.push(assert(`systemd emitted-subset semantic roundtrip ${runtime}`, tokens.join(" ") === exec && JSON.stringify(decoded) === JSON.stringify(strings(c)) && environment.includes("TIGUCLAW_HOME=" + c.homeRaw) && environment.includes("TIGUCLAW_RUNTIME=" + runtime) && environment.includes("PATH=" + path.dirname(c.nodePath) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"), { decoded, environment }));
    }
    const invalid = ["\n", "\r", "\0", "\t", "\u007f"].every(char => ["homeRaw", "repoRoot", "nodePath", "label", "runtime", "entry"].every(field => { try { render({ ...context, [field]: "bad" + char }); return false; } catch { return true; } }));
    const trailing = ["/cwd/ends ", "/cwd/ends\\"].every(repoRoot => { try { render({ ...context, repoRoot }); return false; } catch { return true; } });
    out.push(assert("systemd refuses controls and unsupported cwd suffix", invalid && trailing, undefined));
  } catch (e) { out.push(assert("systemd renderer executes", false, String(e))); }

  // Missing new helper in baseline is NOT counted as direct defect reproduction.
  let identity: { instanceIdFor(input: { home: string; repoRoot: string; runtime?: string }): string; getProcessIdentity(input: { home: string; repoRoot: string; runtime?: string }): { instanceId: string; bootId: string; startedAt: number } } | undefined;
  try { identity = await import(pathToFileURL(path.join(ROOT, "bin/runtime-identity.mjs")).href); }
  catch { out.push(assert("identity helper present (baseline absence is not a direct red proof)", false, undefined)); }
  if (identity) {
    const input = { home: ROOT, repoRoot: ROOT, runtime: "built" };
    const identityScript = `const url=${JSON.stringify(pathToFileURL(path.join(ROOT, "bin/runtime-identity.mjs")).href)}; const input=${JSON.stringify(input)}; const m=await import(url); const first=m.getProcessIdentity(input); const reload=await import(url+'?reload-fixture'); const second=reload.getProcessIdentity({...input,home:'/other'}); console.log(JSON.stringify({ok:first===second&&first.instanceId===m.instanceIdFor(input)&&first.instanceId!==m.instanceIdFor({...input,runtime:'source'})&&first.instanceId!==m.instanceIdFor({...input,home:input.home+'/other'})&&first.startedAt<=Date.now()-process.uptime()*1000+1500,bootId:first.bootId}));`;
    const child1 = spawnSync(process.execPath, ["--input-type=module", "-e", identityScript], { encoding: "utf8" });
    const child2 = spawnSync(process.execPath, ["--input-type=module", "-e", identityScript], { encoding: "utf8" });
    const first = JSON.parse(child1.stdout); const second = JSON.parse(child2.stdout);
    out.push(assert("identity survives module reload, differs by process/instance/runtime, has process start", first.ok && second.ok && first.bootId !== second.bootId, undefined));
    const copySource = await readFile(path.join(ROOT, "bin/copy-dist-assets.mjs"), "utf8");
    out.push(assert("built asset copies identity helper", copySource.includes('copyFile("bin/runtime-identity.mjs")'), undefined));
    const id = identity.instanceIdFor({ home: context.homeAbs, repoRoot: context.repoRoot, runtime: context.runtime });
    const boot = "12345678-1234-4234-8234-123456789abc";
    const valid = { ok: true, instanceId: id, bootId: boot, startedAt: Date.now() - 1000 };
    const serve = (body: string, status = 200, hang = false) => new Promise<{ port: string; stop: () => void }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", `const s=require('http').createServer((q,r)=>{if(${hang})return;r.statusCode=${status};r.end(${JSON.stringify(body)})});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`]);
      child.once("error", reject); child.stdout.once("data", (d: Buffer) => resolve({ port: String(d).trim(), stop: () => { child.kill(); } }));
    });
    // Large active arrays retain the existing health schema. 1 MiB is a finite transport bound,
    // not a supported job-count guarantee. This >4KiB case must not become a false negative.
    const large = JSON.stringify({ ...valid, active_turn_threads: Array.from({ length: 500 }, (_, i) => `thread-${i}-` + "x".repeat(80)), active_runs: Array.from({ length: 500 }, (_, i) => ({ id: i, command: "npm run fixture", cwd: "/fixture/" + "x".repeat(80) })) });
    const cases: [string, string, number, boolean, boolean][] = [
      ["valid", JSON.stringify(valid), 200, false, true], ["large active lists", large, 200, false, true],
      ["non200", JSON.stringify(valid), 503, false, false], ["invalid JSON", JSON.stringify(valid) + "junk", 200, false, false],
      ["legacy", '{"ok":true}', 200, false, false], ["false ok", JSON.stringify({ ...valid, ok: false }), 200, false, false],
      ["other instance", JSON.stringify({ ...valid, instanceId: "f".repeat(64) }), 200, false, false],
      ["wrong identity type", JSON.stringify({ ...valid, instanceId: 42 }), 200, false, false],
      ["wrong boot UUID", JSON.stringify({ ...valid, bootId: "not-a-uuid" }), 200, false, false],
      ["wrong start type", JSON.stringify({ ...valid, startedAt: "123" }), 200, false, false],
      ["zero start", JSON.stringify({ ...valid, startedAt: 0 }), 200, false, false],
      ["oversize", "x".repeat(1048577), 200, false, false], ["timeout", "", 200, true, false],
    ];
    for (const [name, body, status, hang, expected] of cases) {
      // Avoid argv size limits for oversized fixture: use a small expression in the child.
      let server;
      if (name === "oversize") {
        const child = spawn(process.execPath, ["-e", `const s=require('http').createServer((q,r)=>r.end('x'.repeat(1048577)));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`]);
        server = await new Promise<{ port: string; stop: () => void }>(resolve => child.stdout.once("data", d => resolve({ port: String(d).trim(), stop: () => { child.kill(); } })));
      } else if (name === "large active lists") {
        const child = spawn(process.execPath, ["-e", `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{const s=require('http').createServer((q,r)=>r.end(b));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))})`]);
        child.stdin.end(body);
        server = await new Promise<{ port: string; stop: () => void }>(resolve => child.stdout.once("data", d => resolve({ port: String(d).trim(), stop: () => { child.kill(); } })));
      } else server = await serve(body, status, hang);
      try {
        const health = fn(["healthSaysOurs"], { winPort: () => server.port, spawnSync, process, instanceIdFor: identity.instanceIdFor });
        const result = health(context);
        out.push(assert(`health transport ${name}`, result.ok === expected, result));
      } finally { server.stop(); }
    }
  }
  // Pure launch state machine: independent PID/health channels + generation cutoff.
  const drive = (probe: { pids: string[]; error?: string }, fresh: unknown, health: Record<string, unknown>) => {
    let clock = 100; const lines: string[] = []; const proc = { exitCode: 0 };
    const dependencies = { Date: { now: () => clock }, sleepSync: (n: number) => { clock += n; }, healthSaysOurs: () => ({ ...health }), winPort: () => "7021", console: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }, process: proc };
    const wait = fn(["waitForListening"], dependencies); const report = fn(["reportLaunch"], dependencies);
    const c = { launchExpectation: fresh }; const result = wait(c, () => probe, 1000);
    report(c, result, "started", "hint"); return { result, text: lines.join("\n"), code: proc.exitCode };
  };
  for (const probe of [{ pids: ["7"] }, { pids: [] }, { pids: [], error: "no netstat" }]) {
    const success = drive(probe, undefined, { ok: true, why: "", bootId: "new", startedAt: 100 });
    out.push(assert(`verified health succeeds independent of PID ${JSON.stringify(probe)}`, success.code === 0 && /✅/.test(success.text) && (probe.pids.length > 0 || success.text.includes("PID unavailable")), success));
    const bad = drive(probe, undefined, { ok: false, why: "bad identity" });
    out.push(assert(`unverified health fails independent of PID ${JSON.stringify(probe)}`, bad.code === 1 && !/✅/.test(bad.text) && bad.text.includes("bad identity"), bad));
  }
  for (const [name, bootId, startedAt, expected] of [["old boot", "old", 100, false], ["intermediate before final build", "new", 99, false], ["fresh", "new", 100, true]] as const) {
    const v = drive({ pids: [] }, { oldBootIds: ["old"], notBefore: 100 }, { ok: true, why: "", bootId, startedAt });
    out.push(assert(`generation ${name}`, (v.code === 0) === expected, v));
  }
  // Call-order fixtures execute real OS entry functions, with inert service dependencies.
  for (const name of ["darwinRestart", "linuxRestart", "winRestart", "linuxStart", "darwinStart", "winStart", "darwinInstall", "linuxInstall", "winInstall"]) {
    const events: string[] = []; let c: any = { ...context };
    const capture = (value: any) => { events.push("cutoff"); value.launchExpectation = { notBefore: 100, oldBootIds: ["old"] }; };
    const deps = { buildLaunchdPlist: () => "fixture", buildSystemdUnit: () => "fixture", mkdirSync: () => {}, writeFileSync: () => {}, systemdUnitPath: () => "/fixture.service", os: { userInfo: () => ({ username: "fixture" }) }, spawnSync: () => ({ status: 1 }), daemonPresence: () => ({state:"absent"}), winEnsureTask: () => true, winPort: () => "7021", healthSaysOurs: () => { events.push("baseline"); return { ok: true, bootId: "old" }; }, expectFreshLaunch: capture, isDaemonRunning: () => false, launchdDomain: () => "gui/1", launchdPlistPath: () => "/fixture.plist", existsSync: () => true, execFileSync: (_cmd: string, args: string[]) => events.push(args[0] === "bootout" ? "stop" : "service"), systemctlUser: (args: string[]) => events.push(args[0] === "daemon-reload" ? "reload" : "service"), winStopTask: () => { events.push("stop"); return { pids: [] }; }, winPs: () => { events.push("service"); return { status: 0 }; }, winEnableStartScript: () => "inert", winTaskName: () => "fixture",  reportLaunch: () => {}, waitForListening: () => ({}), listeningOnBridge: () => ({}), path, console, process: { exitCode: 0 } };
    try { fn([name], deps)(c); out.push(assert(`capture precedes ${name} service`, events.includes("cutoff") && events.indexOf("cutoff") < events.indexOf("service") && (name !== "winRestart" || events.indexOf("baseline") < events.indexOf("stop")), events)); }
    catch (e) { out.push(assert(`capture fixture ${name}`, false, String(e))); }
  }
  const update = declarations.get("runUpdate") ?? "";
  const resume = /const resumeDaemon = \(\) => \{([\s\S]*?)\n  \};/.exec(update)?.[1] ?? "";
  out.push(assert("update final resume captures and reports fresh; failure reaches backup and summary", resume.includes("expectFreshLaunch(c, updateOldBootIds)") && resume.indexOf("expectFreshLaunch") < resume.indexOf("table?.start") && resume.includes("const final = waitForListening(c, listeningOnBridge)") && resume.includes("reportLaunch(c, final") && resume.includes("return final") && update.lastIndexOf('["run", "build:prod"]') < update.lastIndexOf("resumeDaemon();") && (update.match(/if \(restartFailed\)/g) ?? []).length === 3 && update.includes("discardTree(depsBackup)"), undefined));

  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  const shell = await readFile(path.join(ROOT, "install.sh"), "utf8");
  const ps = await readFile(path.join(ROOT, "install.ps1"), "utf8");
  const overlayCi = path.join(ROOT, "_workspace/public-overlay/.github/workflows/ci.yml");
  const ci = await readFile(existsSync(overlayCi) ? overlayCi : path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  out.push(assert("minimum 22 manifests/installers/current CI; ABI dependency unchanged", pkg.engines.node === ">=22" && lock.packages[""].engines.node === ">=22" && shell.includes("MIN_NODE=22") && /\$MinNode\s*=\s*22/.test(ps) && /node-version: ['\"]?22/.test(ci) && lock.packages["node_modules/better-sqlite3"].version === "12.9.0", undefined));
  // The actual shell preflight with synthetic commands; never reaches clone/install.
  const preflight = shell.slice(shell.indexOf("command -v git"), shell.indexOf("# ── 이미 있으면"));
  for (const code of [0, 1]) {
    const script = `die(){ printf '%s\\n' "$*"; exit 42; }; git(){ return ${code}; }; ${preflight}\nprintf reached`;
    const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    out.push(assert(`git --version preflight exit ${code}`, code === 0 ? result.status === 0 && result.stdout.includes("reached") : result.status === 42 && !result.stdout.includes("reached") && result.stdout.includes("Git exists"), result.stdout));
  }
  const nodeCheck = shell.slice(shell.indexOf("node_ok() {"), shell.indexOf("\n# 공식 배포본"));
  for (const major of [20, 22]) {
    const result = spawnSync("/bin/sh", ["-c", `MIN_NODE=22; node(){ printf '${major}'; }; npm(){ :; }; ${nodeCheck}\nnode_ok`], { encoding: "utf8" });
    out.push(assert(`actual installer Node ${major} branch`, (result.status === 0) === (major === 22), undefined));
  }
  const cli = await readFile(path.join(ROOT, "src/cli.ts"), "utf8");
  const linkSection = cli.slice(cli.indexOf('  console.log("\\n[4/5]'), cli.indexOf("  // ★완료 판정"));
  const linkJs = ts.transpileModule(linkSection, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const fixture of [{ name: "linked but absent PATH", status: 0, exposed: false }, { name: "linked and exposed", status: 0, exposed: true }, { name: "permission failure", status: 1, exposed: false, error: "EACCES fixture" }, { name: "network failure", status: 1, exposed: false, error: "certificate fixture" }]) {
    const lines: string[] = []; let finds = 0;
    const execute = new Function("resolveCmd", "globalTiguclawIsOurs", "spawnSync", "process", "path", "console", linkJs + ";return { commandAvailable, manageLine };");
    try {
      const result = execute(() => ++finds > 1 && fixture.exposed ? "/fixture/tiguclaw" : null, () => true, () => ({ status: fixture.status, error: fixture.error ? { message: fixture.error } : undefined }), { platform: "darwin", cwd: () => "/fixture/install a'b", execPath: "/fixture/private node/bin/node" }, path, { log: (s: string) => lines.push(s), warn: (s: string) => lines.push(s) });
      out.push(assert(`onboard ${fixture.name}`, result.commandAvailable === fixture.exposed && (fixture.exposed || result.manageLine.includes("npm run daemon:status") && result.manageLine.includes("private node")) && (!fixture.error || lines.join("\n").includes(fixture.error)) && !lines.join("\n").includes("From any folder"), { result, lines }));
    } catch (e) { out.push(assert(`onboard ${fixture.name}`, false, String(e))); }
  }
  return out;
};
export const check: RegressionCheck = { name: "launch-install-contracts", guards: "Health identity/generation, independent PID evidence, service field escaping and honest installer requirements", run };
