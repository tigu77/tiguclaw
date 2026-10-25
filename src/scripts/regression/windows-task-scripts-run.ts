/**
 * 회귀: **Windows 작업 스크립트를 실제 PowerShell 로 실행해 의미를 본다** (2026-10-23, 레드팀 10-22 G-1·P-2).
 *
 * ★왜: `buildWinTaskStateScript`·`buildWinTaskGrantScript` 는 부분 문자열·순서로만 검사돼, catch 의 «모름→꺼짐» · «못 푼 계정→일치» ·
 *  «모든 오류→없음» · «OK 를 Set 앞으로» · «멱등 제거» 가 전부 초록이었다(`windows-update-environment`). 스크립트의 뜻은 PowerShell 이 정한다 —
 *  그래서 **돌려 본다.** 진짜 예약작업은 만들지도 바꾸지도 않는다: «없음» 만 진짜 COM(없는 이름 조회 — 읽기)이고, 나머지는
 *  `New-Object -ComObject` 를 가린 가짜 작업 객체다(PowerShell 은 함수를 cmdlet 보다 먼저 찾는다).
 * ★판정부와 묶는다: 가짜 작업이 낸 **실제 출력**을 `parseWinTaskState`·`winRepair` 에 그대로 넣는다. 맥에서 도는 판정 검사
 *  (`windows-update-environment`)의 고정 입력이 실제 모양인지가 여기서 확인된다.
 * ★Windows 전용 — 다른 OS 에선 PowerShell·작업 스케줄러·계정 API 가 없어 **명시적 비대상**이다(Windows 검증 기기에서 돈다).
 *
 * 등급: **동작**(실제 PowerShell). 임시 라벨만 쓴다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skip, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "windows-task-scripts-run",
  guards: "Windows 작업 상태·권한 스크립트를 부분 문자열로만 봐서 catch 의미·계정 판정·OK 순서·멱등이 무방비이던 것(레드팀 10-22 G-1) · 긴 PowerShell 오류가 콘솔 폭에서 잘리던 것(P-2)",
  run: async (): Promise<Assertion[]> => {
    const checks: Assertion[] = [];
    const test = (name: string, fn: () => string | void) => {
      try { const got = fn(); checks.push({ name, ok: true, got: got ?? "확인" }); }
      catch (err) { checks.push({ name, ok: false, got: String(err) }); }
    };
    const d: any = await import(new URL("../../../bin/daemon.mjs", import.meta.url).href);
    const source = fs.readFileSync(path.join(repo, "bin/daemon.mjs"), "utf8");
    const c = { homeAbs: os.tmpdir(), homeRaw: "", label: "x", repoRoot: repo };
    // winRepair 본문을 그대로 — 의존은 주입한 것뿐(`windows-update-environment` 와 같은 방식).
    const bodyOf = (name: string): string => source.slice(source.indexOf(`const ${name} = (c) => {`), source.indexOf("\n};\n", source.indexOf(`const ${name} = (c) => {`)) + 3);
    const runRepair = (o: { before: { state: string }; grant: string }) => {
      const out: string[] = [];
      const con = { log: (m: string) => out.push("log:" + m), error: (m: string) => out.push("err:" + m), warn: (m: string) => out.push("warn:" + m) };
      const proc = { set exitCode(v: number) { out.push("exit:" + v); }, get exitCode() { return 0; } };
      new Function("winTaskState", "winPs", "buildWinTaskGrantScript", "winTaskName", "psErrorText", "console", "process", bodyOf("winRepair") + "; return winRepair;")(
        () => o.before, () => ({ status: 0, stdout: o.grant, stderr: "" }), () => "GRANT", () => "task", () => "ps-err", con, proc,
      )(c);
      return { out };
    };
    // ★실제 PowerShell 로 — 상태·권한 스크립트를 **실행해서** 그 의미를 본다(레드팀 10-22 G-1: 부분 문자열·순서만 봐서 catch 의 «모름→꺼짐»·
    //  «못 푼 계정→일치»·«모든 오류→없음»·«OK 를 Set 앞으로»·«멱등 제거» 가 초록이었다). 진짜 예약작업은 안 만든다·안 바꾼다 —
    //  «없음» 만 진짜 COM(없는 이름 조회, 읽기)이고, 나머지는 `New-Object -ComObject` 를 가린 가짜 작업 객체다(함수가 cmdlet 보다 먼저 잡힌다).
    //  가짜 작업이 내는 출력은 아래 판정부(`parseWinTaskState`·`winRepair`)에 그대로 넣는다 — 맥에서 도는 판정 검사의 입력이 실제 모양이라는 묶음이다.
    const WIN = process.platform === "win32";
    const psRun = (script: string) => {
      const r = spawnSync("powershell", d.winPsArgs(script), { encoding: "utf8", timeout: 90_000 });
      return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() || (r.error ? String(r.error) : "") };
    };
    /** 가짜 Schedule.Service — `GetTask` 가 돌려줄 것(또는 던질 것)과 권한 조각이 쓰는 값. SetSecurityDescriptor 호출은 `SETS=` 줄로 적는다. */
    const fakeCom = (o: { task?: string; enabled?: boolean; user?: string; sd?: string; setThrows?: boolean }) =>
      [
        `$global:__me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
        `$global:__sets = @()`,
        `function New-Object { param([string]$TypeName, [object[]]$ArgumentList, [string]$ComObject)`,
        `  if (-not $ComObject) { if ($ArgumentList) { return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList } else { return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName } }`,
        `  $p = Microsoft.PowerShell.Utility\\New-Object psobject; $p | Add-Member NoteProperty UserId (${o.user ?? "$global:__me"})`,
        `  $def = Microsoft.PowerShell.Utility\\New-Object psobject; $def | Add-Member NoteProperty Principal $p`,
        `  $t = Microsoft.PowerShell.Utility\\New-Object psobject; $t | Add-Member NoteProperty Enabled $${o.enabled === true ? "true" : "false"}; $t | Add-Member NoteProperty Definition $def`,
        `  $t | Add-Member ScriptMethod GetSecurityDescriptor { param($f) ${o.sd ?? `'D:(A;;FR;;;' + $global:__me + ')'`} }`,
        `  $t | Add-Member ScriptMethod SetSecurityDescriptor { param($sd, $f) ${o.setThrows === true ? "throw 'Access is denied.'" : `$global:__sets += ,($sd + '|' + $f)`} }`,
        `  $global:__task = $t`,
        `  $global:__folder = Microsoft.PowerShell.Utility\\New-Object psobject`,
        `  $global:__folder | Add-Member ScriptMethod GetTask { param($n) ${o.task === "denied" ? "throw [Runtime.InteropServices.COMException]::new('Access is denied.', -2147024891)" : "$global:__task"} }`,
        `  $svc = Microsoft.PowerShell.Utility\\New-Object psobject; $svc | Add-Member ScriptMethod Connect { }; $svc | Add-Member ScriptMethod GetFolder { param($x) $global:__folder }`,
        `  return $svc }`,
      ].join("\n");
    const winC = { ...c, label: `tiguclaw-regr-nosuch-${process.pid}` };
    if (!WIN) {
      checks.push(skip("★실제 PowerShell 로 상태 스크립트 — 켜짐·꺼짐·없음(진짜 COM)·모름", "PowerShell·작업 스케줄러가 없는 OS — Windows 에서 돈다(Windows 검증 기기)"));
      checks.push(skip("★실제 PowerShell 로 권한 스크립트 — 일치·이름·다른 계정·못 풂·멱등·Set 실패", "PowerShell·Windows 계정 API 가 없는 OS — Windows 에서 돈다(Windows 검증 기기)"));
      checks.push(skip("★실제 PowerShell 의 긴 오류(콘솔 폭 접힘)를 끝까지", "PowerShell 이 없는 OS — 같은 모양의 실측 고정 입력은 `windows-update-environment` 가 맥에서 본다"));
    } else {
      test("★실제 PowerShell 로 상태 스크립트 — 켜짐·꺼짐·없음(진짜 COM, 없는 이름)·모름(권한 거부 → «꺼짐»·«없음» 으로 바꾸지 않는다)", () => {
        const st = (pre: string) => d.parseWinTaskState(psRun(pre + "\n" + d.buildWinTaskStateScript(winC)));
        const real = st("");
        const on = st(fakeCom({ enabled: true }));
        const off = st(fakeCom({ enabled: false }));
        const denied = st(fakeCom({ task: "denied" }));
        assert.deepEqual(real, { state: "missing" }, JSON.stringify(real));
        assert.deepEqual(on, { state: "enabled" }, JSON.stringify(on));
        assert.deepEqual(off, { state: "disabled" }, JSON.stringify(off));
        assert(denied.state === "unknown" && (denied.why ?? "").length > 0, JSON.stringify(denied));
        return `없음·켜짐·꺼짐·모름(${denied.why?.slice(0, 40)})`;
      });
      test("★실제 PowerShell 로 권한 스크립트 — 같은 계정(SID·이름)만 본인 FA 를 **한 번** 더하고 그 뒤에 OK · 다른 계정·못 푼 계정은 안 바꾼다 · 이미 있으면 다시 안 붙인다 · Set 이 거부되면 OK 없이 ERR — 그리고 그 출력을 repair 판정에 넣는다", () => {
        const grant = (o: Parameters<typeof fakeCom>[0]) => {
          const r = psRun(fakeCom(o) + "\n" + d.buildWinTaskGrantScript(winC) + "\n'SETS=' + ($global:__sets -join ' ## ')");
          const sets = (/SETS=(.*)$/m.exec(r.stdout)?.[1] ?? "").split(" ## ").filter(Boolean); // SDDL 에 «;» 가 든다 — 구분자는 그 밖의 것
          return { r: { ...r, stdout: r.stdout.replace(/\r?\n?SETS=.*$/m, "").trim() }, sets };
        };
        const sid = grant({});
        const name = grant({ user: "$env:USERNAME" });
        const other = grant({ user: "'S-1-5-18'" });
        const unres = grant({ user: "'tiguclaw-no-such-account-xyz'" });
        const again = grant({ sd: `'D:(A;;FR;;;' + $global:__me + ')(A;;FA;;;' + $global:__me + ')'` });
        const refused = grant({ setThrows: true });
        assert(sid.r.stdout === "TASK_ACL_OK" && sid.sets.length === 1 && /^D:\(A;;FR;;;(S-[\d-]+)\)\(A;;FA;;;\1\)\|0$/.test(sid.sets[0]), JSON.stringify(sid));
        assert(name.r.stdout === "TASK_ACL_OK" && name.sets.length === 1, JSON.stringify(name));
        assert(/^TASK_ACL_MISMATCH S-1-5-18 \(S-1-5-18\) runner=S-1-5-/.test(other.r.stdout) && other.sets.length === 0 && !other.r.stdout.includes("TASK_ACL_OK"), JSON.stringify(other));
        assert(/^TASK_ACL_UNRESOLVED tiguclaw-no-such-account-xyz$/.test(unres.r.stdout) && unres.sets.length === 0 && !unres.r.stdout.includes("TASK_ACL_OK"), JSON.stringify(unres));
        assert(again.r.stdout === "TASK_ACL_OK" && again.sets.length === 0, JSON.stringify(again));
        assert(/^TASK_ACL_ERR: /.test(refused.r.stdout) && !refused.r.stdout.includes("TASK_ACL_OK"), JSON.stringify(refused));
        // 판정부에 그대로 — 실제 출력이 맞는 문장으로 간다
        const said = (x: { r: { stdout: string } }) => runRepair({ before: { state: "enabled" }, grant: x.r.stdout }).out.join(" | ");
        assert(/✅ Repaired/.test(said(sid)), said(sid));
        assert(/different account/.test(said(other)) && !/✅/.test(said(other)), said(other));
        assert(/could not resolve/.test(said(unres)) && !/✅/.test(said(unres)), said(unres));
        assert(/could not repair/.test(said(refused)) && /administrator/.test(said(refused)) && !/✅/.test(said(refused)), said(refused));
        return "일치=1회 · 이름 풀림 · 다른=0 · 못 풂=0 · 멱등=0 · 거부=ERR";
      });
      test("★실제 PowerShell 의 긴 오류(콘솔 폭에서 접힘)를 끝까지 — 문장 끝(«…-end'»)까지 남고 부속 줄은 안 붙는다", () => {
        const long = "tiguclaw-p2-" + "x".repeat(180) + "-end";
        const r = psRun(`$ErrorActionPreference = 'Stop'; Get-Item 'C:\\no\\such\\${long}'`);
        const t: string = d.psErrorText(r);
        assert(t.includes(`${long}'`) && !/At line|위치 줄|CategoryInfo/.test(t), JSON.stringify({ t, chunks: (r.stderr.match(/<S S="Error">/g) ?? []).length }));
        return t.slice(-60);
      });
    }
    return checks;
  },
};

export default check;
