/** Execute only installer-generated retry text and synthetic npm.cmd, never the installer/network. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion } from "./_framework.js";

export const powershellRetryAssertions = (ps: string, repo: string): Assertion[] => {
  const iso = mkdtempSync(path.join(tmpdir(), "install-ps-retry-"));
  const dir = path.join(iso, "후보 좌석 $HOME 'tc'");
  const nodeDir = path.join(dir, ".node");
  mkdirSync(nodeDir, { recursive: true });
  const psExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"), TIGUCLAW_RETRY_DIR: dir, TIGUCLAW_RETRY_REPO: repo };
  const run = (command: string) => spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding; ${command}`], { encoding: "utf8", env, timeout: 15_000, windowsHide: true });
  try {
    const syntax = run(`$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:TIGUCLAW_RETRY_REPO 'install.ps1'),[ref]$t,[ref]$e); if ($e.Count) { $e | Out-String | Write-Output; exit 1 }`);
    const adviceStart = ps.indexOf("# ★**안내하는 명령");
    const adviceEnd = ps.indexOf("# ★이제서야 npm", adviceStart);
    const block = adviceStart >= 0 && adviceEnd > adviceStart ? ps.slice(adviceStart, adviceEnd) : "";
    const retry = /^\s*Then retry:\s*(.+)$/m.exec(ps)?.[1] ?? "";
    const fake = path.join(nodeDir, "probe.cjs");
    writeFileSync(fake, `const path=require('node:path'); const parts=(process.env.PATH||'').split(';'); if(!parts.some(p=>path.resolve(p).toLowerCase()===path.resolve(__dirname).toLowerCase()) || !parts.some(p=>/system32/i.test(p))) process.exit(3); console.log('npm-ran '+process.argv.slice(2).join(' ')+' @'+process.cwd());`);
    writeFileSync(path.join(nodeDir, "npm.cmd"), `@echo off\r\n@"${process.execPath}" "%~dp0probe.cjs" %*\r\n`, "utf8");
    // The first shell expands the exact product's advice. The second starts without private Node on PATH.
    const shown = run(`$ErrorActionPreference='Stop'; $Dir=$env:TIGUCLAW_RETRY_DIR; $NodeDir=Join-Path $Dir '.node'; $NeedNode=$true; ${block}\nWrite-Output "${retry}"`);
    const cmd = shown.stdout.trim();
    const executed = run(`$ErrorActionPreference='Stop'; ${cmd}`);
    return [
      assert("Windows 설치자 install.ps1가 실제로 파싱된다", syntax.status === 0, syntax.stderr || syntax.stdout || `status=${syntax.status}`),
      assert("PowerShell 전용 Node 재시도 안내가 새 셸에서 실행된다(공백·한글·$·따옴표 및 기존 PATH 유지)", block !== "" && retry !== "" && shown.status === 0 && executed.status === 0 && executed.stdout.trim() === `npm-ran ci --ignore-scripts=false @${dir}`, { shownStatus: shown.status, status: executed.status, command: cmd, stdout: executed.stdout, stderr: executed.stderr }),
    ];
  } finally { rmSync(iso, { recursive: true, force: true }); }
};
