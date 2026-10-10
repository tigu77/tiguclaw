/**
 * 회귀: **Claude 구독 토큰 발급이 화면에서 끝난다** — 터미널에서 명령을 돌려 토큰을 복사해 오지 않는다 (2026-09-30).
 *
 * 사고(정태님): 발급 버튼이 «`npm run claude-auth` 를 그 기계 터미널에서 돌리고 나온 토큰을 붙여넣으라» 였다 — «이건
 *  아니지». 번들 발급기는 TTY 가 필요한데, python `pty.fork()` 는 부모 TTY 없이도 가짜 터미널을 준다(실측). 그래서 코어가
 *  발급기를 띄워 로그인 주소를 화면에 넘기고, 사용자가 붙여넣은 **코드**를 발급기에 넣어 나온 토큰을 저장한다.
 * ★회귀는 실제 실행기를 띄우지 않는다 — **진짜처럼 TTY 가 아니면 침묵하는** 가짜 발급기를 넣는다(중계가 빠지면 빨개진다).
 * ★저장(`acceptClaudeToken` — Anthropic 확인·.env·쉼 해제)은 대역으로 받는다. 그 판단은 `claude-token-accept` 가 본다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, skip, type Assertion, type RegressionCheck } from "./_framework.js";

const FAKE = fileURLToPath(new URL("./_fake-claude-issuer.mjs", import.meta.url));

export const check: RegressionCheck = {
  name: "claude-token-issue-in-dashboard",
  guards: "Claude 구독 토큰 발급 버튼이 «그 기계 터미널에서 명령을 돌리고 토큰을 붙여넣으라» 로 끝나던 것 — 폰·원격에선 발급할 길이 없었다",
  run: async (): Promise<Assertion[]> => {
    if (process.platform === "win32") {
      // ★윈도우 — 발급기를 **새 콘솔 창**(진짜 터미널)으로 띄운다(2026-10-10 정태님). 가짜 발급기가 그 창에서 «TTY 인가» 와 우리 자격이
      //  안 물려졌는지를 표식에 남기고, 부모 창(cmd /k)을 닫는다. 창이 사용자에게 보이는지는 세션 문제라 여기선 못 본다(SSH = 세션 0).
      const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      // 경로에 공백·& ·% 가 있어도 명령이 쪼개지지 않는다(적대 검토 F7 — `C:\\Users\\R&D\\…`).
      const dir = mkdtempSync(`${tmpdir()}/tiguclaw-regression-console R&D %PATH% `);
      const mark = `${dir}/mark.json`;
      const script = `${dir}/issuer.cjs`;
      (await import("node:fs")).writeFileSync(
        script,
        `require("fs").writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ tty: process.stdout.isTTY === true, tokenEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, arg: process.argv[2] ?? null })); try { process.kill(process.ppid); } catch {}`,
      );
      const m = await import("../../core/llm-runtime/claude-token-issue.js");
      const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-regression-should-not-leak";
      let r: unknown;
      try {
        r = await m.beginClaudeTokenIssue([process.execPath, script, "setup-token"]);
        for (let i = 0; i < 100 && !existsSync(mark); i++) await new Promise((res) => setTimeout(res, 100));
      } finally {
        if (savedTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTok;
      }
      const got = existsSync(mark) ? (JSON.parse(readFileSync(mark, "utf8")) as { tty: boolean; tokenEnv: string | null; arg: string | null }) : null;
      rmSync(dir, { recursive: true, force: true });
      const def = m.consoleIssuerCommand();
      return [
        assert("★기본 발급 명령이 가리키는 파일이 실제로 있다(설치 기본값 built 에서도 — appRoot=dist 엔 bin/ 이 없다)", existsSync(def.args[0]!), def.args[0]),
        assert(
          "★윈도우: 발급기를 새 콘솔 창(진짜 터미널 — TTY)으로 띄우고, 우리 토큰은 물려주지 않는다 · 경로의 공백·&·% 도 지킨다",
          (r as { ok?: boolean; console?: boolean })?.ok === true && (r as { console?: boolean }).console === true && got?.tty === true && got.tokenEnv === null && got.arg === "setup-token",
          { 결과: r, 발급기: got },
        ),
      ];
    }
    try { execFileSync("python3", ["--version"], { stdio: "ignore" }); } catch {
      return [skip("화면 발급", "python3 없음 — 이 기계에선 종전 방식으로 안내한다")];
    }
    const m = await import("../../core/llm-runtime/claude-token-issue.js");
    const issuer = [process.execPath, FAKE];
    {
      // 윈도우 새 창이 돌릴 기본 명령 — 어느 플랫폼에서든 그 파일이 있어야 한다(적대 검토 G7: 어떤 플랫폼에서도 안 돌아 F1 이 통과했다).
      const { existsSync: ex } = await import("node:fs");
      const def = m.consoleIssuerCommand();
      if (!ex(def.args[0]!)) return [assert("★기본 발급 명령이 가리키는 파일이 실제로 있다", false, def.args[0])];
    }
    const saved: string[] = [];
    const accept = async (t: string) => { saved.push(t); return { ok: true, message: "saved" }; };
    const out: Assertion[] = [];
    // ★실패해도 러너가 멈추지 않게 — 변이로 세션을 놓친 발급기가 남으면 이벤트 루프를 붙잡아 스위트가 끝나지 않았다(적대 검토).
    //  이 검사가 띄운 가짜 발급기만 pid 로 모아 끝에 치운다.
    const { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pidDir = mkdtempSync(`${tmpdir()}/tiguclaw-regression-issuer-`);
    let pidN = 0;
    const savedPidEnv = process.env.FAKE_ISSUER_PIDFILE;
    const nextPidFile = (): string => { const f = `${pidDir}/pid-${pidN++}`; process.env.FAKE_ISSUER_PIDFILE = f; return f; };
    try {
    nextPidFile();
    const b1 = await m.beginClaudeTokenIssue(issuer);
    const bad = await m.finishClaudeTokenIssue("wrong-code#st", accept);
    out.push(assert(
      "★가짜 터미널로 띄운 발급기가 로그인 주소를 통째로(줄바꿈 없이) 준다 · 틀린 코드는 저장하지 않고 오류를 말한다",
      b1.ok && "url" in b1 && b1.url.length > 300 && b1.url.includes("state=") && !bad.ok && /OAuth error/.test(bad.message) && saved.length === 0,
      { b1: b1.ok && "url" in b1 ? b1.url.length : b1, bad },
    ));

    nextPidFile();
    const b2 = await m.beginClaudeTokenIssue(issuer);
    const good = await m.finishClaudeTokenIssue("  good-code#st\n", accept);
    out.push(assert(
      "★맞는 코드 → 발급기가 낸 토큰이 저장으로 간다(토큰이 끊김 없이 한 덩어리로)",
      b2.ok && good.ok && saved.length === 1 && saved[0]!.includes(`sk-ant-oat01-${"A".repeat(90)}`),
      { b2: b2.ok, good, savedHasToken: saved.map((t) => t.includes("sk-ant-oat01-")) },
    ));

    // 토큰을 직접 붙여넣으면(이미 받아 둔 것) — 발급기가 떠 있어도 종전 길로 저장하고 발급기는 치운다.
    nextPidFile();
    await m.beginClaudeTokenIssue(issuer);
    const direct = await m.finishClaudeTokenIssue(`sk-ant-oat01-${"B".repeat(90)}`, accept);
    const noSession = await m.finishClaudeTokenIssue("some-code", accept);
    out.push(assert(
      "토큰을 붙여넣으면 토큰으로 저장 · 발급기가 없으면 붙여넣은 글은 종전 판단(저장 경로)으로 간다",
      direct.ok && saved[1]!.includes("B".repeat(90)) && noSession.ok && saved[2] === "some-code",
      { direct, noSession, saved: saved.length },
    ));
    // ★코드를 넣고 기다리는 사이 버튼을 다시 누르면, 늦게 끝난 앞 마무리가 **새 발급기를 닫지 않는다**(적대 검토 — 종전엔 전역 «지금 발급» 을 닫았다).
    nextPidFile();
    await m.beginClaudeTokenIssue(issuer);
    const slow = m.finishClaudeTokenIssue("silent-code#st", accept);
    await new Promise((res) => setTimeout(res, 300));
    nextPidFile();
    const b3 = await m.beginClaudeTokenIssue(issuer);
    const slowDone = await slow;
    const savedBefore = saved.length;
    const fresh = await m.finishClaudeTokenIssue("good-code#st", accept);
    out.push(assert(
      "★기다리던 앞 마무리가 끝나도 다시 누른 발급기는 살아 있다 — 그 발급기에 넣은 코드로 토큰이 나온다",
      b3.ok && !slowDone.ok && fresh.ok && saved.length === savedBefore + 1 && saved.at(-1)!.includes(`sk-ant-oat01-${"A".repeat(90)}`),
      { b3: b3.ok, slowDone: slowDone.ok, fresh, last: saved.at(-1)?.slice(0, 20) },
    ));
    // ★부모(데몬)가 갑자기 죽으면 발급기도 같이 끝난다 — 코드를 안 넣은 채 배포·재시작하면 발급기·중계가 고아로 남던 것(적대 검토 실측).
    const pidfile = nextPidFile();
    const mod = fileURLToPath(new URL("../../core/llm-runtime/claude-token-issue.ts", import.meta.url));
    const script = `const m = await import(${JSON.stringify(mod)}); const b = await m.beginClaudeTokenIssue(${JSON.stringify(issuer)}); console.log(b.ok ? "READY" : "FAIL"); process.exit(0);`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, FAKE_ISSUER_PIDFILE: pidfile, FAKE_ISSUER_IGNORE_HUP: "1" }, encoding: "utf8", timeout: 30_000 });
    const issuerPid = existsSync(pidfile) ? Number(readFileSync(pidfile, "utf8")) : 0;
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 5_000;
    while (issuerPid > 0 && alive(issuerPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    const orphan = issuerPid > 0 && alive(issuerPid);
    if (orphan) { try { process.kill(issuerPid, "SIGKILL"); } catch { /* 이미 끝남 */ } }
    out.push(assert("★데몬이 갑자기 끝나면 발급기도 같이 끝난다(고아 프로세스가 남지 않는다)",
      r.stdout.includes("READY") && issuerPid > 0 && !orphan, { ready: r.stdout.trim().slice(0, 40), issuerPid, orphan }));
    return out;
    } finally {
      if (savedPidEnv === undefined) delete process.env.FAKE_ISSUER_PIDFILE; else process.env.FAKE_ISSUER_PIDFILE = savedPidEnv;
      for (const f of readdirSync(pidDir)) {
        const pid = Number(readFileSync(`${pidDir}/${f}`, "utf8"));
        if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* 이미 끝남 */ } }
      }
      rmSync(pidDir, { recursive: true, force: true });
    }
  },
};
