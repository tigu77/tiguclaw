import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Windows already supplies PowerShell/.NET. No Python/Bash install or silent skip.
const powershell = (script: string, input?: string) => spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
], { input, encoding: "utf8", timeout: 15_000 });
const completed = (result: ReturnType<typeof spawnSync>, status: number) =>
  !result.error && result.signal === null && result.status === status;
// Search the terminator only after the opening marker; missing/empty ranges must fail closed.
const section = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || !source.slice(start, end).trim()) throw Error(`missing or empty section: ${startMarker}`);
  return source.slice(start, end);
};
const psPlist = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$xml = [Xml.XmlDocument]::new()
$xml.PreserveWhitespace = $true
$xml.XmlResolver = $null
$xml.LoadXml([Console]::In.ReadToEnd())
function Read-Dict($element) {
  $result = @{}
  $nodes = @($element.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
  for ($i = 0; $i -lt $nodes.Count; $i += 2) {
    $value = $nodes[$i + 1]
    switch ($value.Name) {
      'array' { $result[$nodes[$i].InnerText] = @($value.SelectNodes('string') | ForEach-Object { $_.InnerText }) }
      'dict' { $result[$nodes[$i].InnerText] = Read-Dict $value }
      default { $result[$nodes[$i].InnerText] = $value.InnerText }
    }
  }
  return $result
}
Read-Dict ($xml.DocumentElement.SelectSingleNode('dict')) | ConvertTo-Json -Depth 8 -Compress
`;


const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  out.push(assert("section ignores earlier terminator and retains actual branch", section("END before START body END", "START", "END") === "START body ", undefined));
  for (const [name, text, start, end] of [
    ["missing start", "body END", "START", "END"], ["missing end", "START body", "START", "END"],
    ["reversed", "END START body", "START", "END"], ["empty", "END", "", "END"],
    ["whitespace", "  END", " ", "END"],
  ]) {
    let rejected = false;
    try { section(text, start, end); } catch { rejected = true; }
    out.push(assert(`section rejects ${name}`, rejected, undefined));
  }
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
      const parsed = process.platform === "win32" ? powershell(psPlist, xml) : spawnSync("/usr/bin/python3", ["-c", "import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"], { input: xml, encoding: "utf8", timeout: 15_000 });
      let value: any; try { value = JSON.parse(parsed.stdout.replace(/^\uFEFF/, "")); } catch { value = null; }
      out.push(assert(`plist standard-parser roundtrip ${runtime}`, completed(parsed, 0) && value?.Label === c.label && JSON.stringify(value?.ProgramArguments) === JSON.stringify(strings(c)) && value?.WorkingDirectory === c.repoRoot && value?.EnvironmentVariables.TIGUCLAW_HOME === c.homeRaw && value?.EnvironmentVariables.TIGUCLAW_RUNTIME === runtime && value?.EnvironmentVariables.PATH === path.dirname(c.nodePath) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" && value?.StandardOutPath === path.join(c.logsDir, "launchd.out.log") && value?.StandardErrorPath === path.join(c.logsDir, "launchd.err.log"), { stderr: parsed.stderr, error: parsed.error?.message, status: parsed.status, signal: parsed.signal }));
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
  for (const [name, result] of [
    ["missing runner", spawnSync(path.join(ROOT, "__missing_installer_runner__"), [], { encoding: "utf8", timeout: 100 })],
    ["runner timeout", spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 100 })],
  ] as const) {
    out.push(assert(`process failure is not normal installer rejection: ${name}`, !!result.error && !completed(result, 0) && !completed(result, 1) && !completed(result, 42), { error: result.error?.message, status: result.status, signal: result.signal }));
  }
  // Execute only actual installer branches with inert Git/Node; never clone/install.
  const windows = process.platform === "win32";
  // Validate both source ranges even when only the host's shell can execute.
  const psPreflight = section(ps, "& $GitExe --version", "if ($ExistingInstall)");
  const shPreflight = section(shell, "command -v git", "# ── 이미 있으면");
  out.push(assert("both installer Git ranges retain rejection and continuation", psPreflight.includes("$LASTEXITCODE") && psPreflight.includes("Git exists") && shPreflight.includes("git --version") && shPreflight.includes("Git exists"), undefined));
  const preflight = windows ? psPreflight : shPreflight;
  out.push(assert("installer Git branch extracted", preflight.includes(windows ? "$LASTEXITCODE" : "git --version") && preflight.includes("Git exists"), undefined));
  for (const code of [0, 1]) {
    const result = windows
      ? powershell(`$ErrorActionPreference = 'Stop'; function Die($m) { Write-Output $m; exit 42 }; function Git-Fixture { $global:LASTEXITCODE = ${code} }; $GitExe = 'Git-Fixture'; ${preflight}\nWrite-Output 'reached'`)
      : spawnSync("/bin/sh", ["-c", `die(){ echo "$*"; exit 42; }; git(){ return ${code}; }; ${preflight}\necho reached`], { encoding: "utf8", timeout: 15_000 });
    out.push(assert(`git --version preflight exit ${code}`, completed(result, code === 0 ? 0 : 42) && (code === 0 ? result.stdout.includes("reached") : !result.stdout.includes("reached") && result.stdout.includes("Git exists")), { stdout: result.stdout, stderr: result.stderr, error: result.error?.message, status: result.status, signal: result.signal }));
  }
  const nodeCheck = windows
    ? section(ps, "function Test-NodeOk {", "\nfunction Install-PrivateNode")
    : section(shell, "node_ok() {", "\n# 공식 배포본");
  out.push(assert("installer Node branch extracted", nodeCheck.includes(windows ? "$maj -ge $MinNode" : '"$MIN_NODE"'), undefined));
  for (const major of [20, 22]) {
    const result = windows
      ? powershell(`$ErrorActionPreference = 'Stop'; $MinNode = 22; function node.exe { 'v${major}.0.0' }; function npm.cmd { }; ${nodeCheck}\nif (Test-NodeOk) { exit 0 } else { exit 1 }`)
      : spawnSync("/bin/sh", ["-c", `MIN_NODE=22; node(){ printf '${major}'; }; npm(){ :; }; ${nodeCheck}\nnode_ok`], { encoding: "utf8", timeout: 15_000 });
    out.push(assert(`actual installer Node ${major} branch`, completed(result, major === 22 ? 0 : 1), { stdout: result.stdout, stderr: result.stderr, error: result.error?.message, status: result.status, signal: result.signal }));
  }
  const cli = await readFile(path.join(ROOT, "src/cli.ts"), "utf8");
  const linkSection = section(cli, '  console.log("\\n[4/5]', "  // ★완료 판정");
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
