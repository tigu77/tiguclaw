// Test-only preload. Only synthetic fixture credentials may be read; all network is denied.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const root = path.resolve(process.env.TIGUCLAW_TEST_SANDBOX_ROOT || '__missing_sandbox__');
const audit = process.env.TIGUCLAW_TEST_AUDIT;
if (!process.env.TIGUCLAW_TEST_SANDBOX_ROOT || !audit || !path.resolve(audit).startsWith(root + path.sep)) throw new Error('Missing sealed test sandbox');
const append = fs.appendFileSync.bind(fs);
const realpath = fs.realpathSync.bind(fs);
const event = (kind, extra) => append(audit, JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
const filePath = (file) => file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : typeof file === 'string' ? file : undefined;
const credential = (file) => /(?:^|[\\/])\.env(?:$|[.\-])|[\\/]\.(?:aws|ssh|claude|codex)(?:[\\/]|$)|(?:^|[\\/])(?:credentials(?:\.json)?|auth\.json|\.git-credentials|\.npmrc)$/.test(file);
// The same owned root may be spelled through a symlinked parent (macOS /tmp -> /private/tmp); realpath results use the real spelling.
let realRoot = root; try { realRoot = realpath(root); } catch { /* checked lexically below */ }
const inRoot = (p) => p.startsWith(root + path.sep) || p.startsWith(realRoot + path.sep);
const check = (file, via) => {
  const value = filePath(file); if (value === undefined || !credential(value)) return;
  const abs = path.resolve(value);
  let resolved;
  if (inRoot(abs)) { try { resolved = realpath(abs); } catch { /* nonexistent fixture is fine */ } }
  const allowed = inRoot(abs) && (resolved === undefined || resolved.startsWith(realRoot + path.sep));
  event('credential-read', { path: abs, via, allowed });
  if (!allowed) throw new Error('Sandbox denied credential path: ' + abs);
};
for (const name of ['readFileSync', 'readFile', 'openSync', 'open']) {
  const original = fs[name];
  fs[name] = function(file, ...args) { check(file, name); return original.call(this, file, ...args); };
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) { check(file, 'promises.' + name); return original.call(this, file, ...args); };
}
const load = process.loadEnvFile?.bind(process);
if (load) process.loadEnvFile = (file = '.env') => { check(file, 'process.loadEnvFile'); return load(file); };
const deniedNetwork = (api) => (..._args) => { event('network-denied', { api }); throw new Error('Network disabled in onboarding fixture: ' + api); };
globalThis.fetch = deniedNetwork('fetch');
for (const mod of ['http', 'https']) for (const name of ['request', 'get']) require('node:' + mod)[name] = deniedNetwork(mod + '.' + name);
const net = require('node:net');
net.connect = deniedNetwork('net.connect'); net.createConnection = deniedNetwork('net.createConnection');
net.Socket.prototype.connect = deniedNetwork('Socket.connect');
require('node:tls').connect = deniedNetwork('tls.connect');
const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => {
  // Product native-module probes may use the same Node executable; npm may only be our fake.
  const fakeNpm = path.join(root, 'bin', process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const allow = cmd === process.execPath || ((cmd === 'npm' || cmd === 'npm.cmd') &&
    (opts?.env || process.env).PATH?.split(path.delimiter)[0] === path.dirname(fakeNpm));
  event('spawn', { command: String(cmd), args: (args || []).map(String).filter((a) => ['run', 'init', 'codex-auth', 'claude-auth', 'build:prod', 'daemon:install', 'doctor'].includes(a)), allowed: allow });
  if (!allow) throw new Error('Sandbox denied subprocess');
  return spawnSync(cmd, args, opts);
};
const spawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  const allowed = typeof cmd === 'string' && path.isAbsolute(cmd) && /[\\/]node_modules[\\/]@esbuild[\\/][^\\/]+[\\/]bin[\\/]esbuild$/.test(cmd);
  event('spawn', { command: String(cmd), allowed, kind: 'compiler' });
  if (!allowed) throw new Error('Sandbox denied asynchronous subprocess');
  return spawn(cmd, args, opts);
};
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = () => { event('spawn-denied', { api: name }); throw new Error('Sandbox denied subprocess: ' + name); };
}
require('node:module').syncBuiltinESMExports();
event('sandbox-ready', { root });
