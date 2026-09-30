/**
 * 회귀: **Claude 구독 토큰 발급이 화면에서 끝난다** — 터미널에서 명령을 돌려 토큰을 복사해 오지 않는다 (2026-09-30).
 *
 * 사고(정태님): 발급 버튼이 «`npm run claude-auth` 를 그 기계 터미널에서 돌리고 나온 토큰을 붙여넣으라» 였다 — «이건
 *  아니지». 번들 발급기는 TTY 가 필요한데, python `pty.fork()` 는 부모 TTY 없이도 가짜 터미널을 준다(실측). 그래서 코어가
 *  발급기를 띄워 로그인 주소를 화면에 넘기고, 사용자가 붙여넣은 **코드**를 발급기에 넣어 나온 토큰을 저장한다.
 * ★회귀는 실제 실행기를 띄우지 않는다 — **진짜처럼 TTY 가 아니면 침묵하는** 가짜 발급기를 넣는다(중계가 빠지면 빨개진다).
 * ★저장(`acceptClaudeToken` — Anthropic 확인·.env·쉼 해제)은 대역으로 받는다. 그 판단은 `claude-token-accept` 가 본다.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, skip, type Assertion, type RegressionCheck } from "./_framework.js";

const FAKE = fileURLToPath(new URL("./_fake-claude-issuer.mjs", import.meta.url));

export const check: RegressionCheck = {
  name: "claude-token-issue-in-dashboard",
  guards: "Claude 구독 토큰 발급 버튼이 «그 기계 터미널에서 명령을 돌리고 토큰을 붙여넣으라» 로 끝나던 것 — 폰·원격에선 발급할 길이 없었다",
  run: async (): Promise<Assertion[]> => {
    if (process.platform === "win32") return [skip("화면 발급", "Windows 는 python pty 가 없어 종전 방식(명령 + 붙여넣기)으로 안내한다")];
    try { execFileSync("python3", ["--version"], { stdio: "ignore" }); } catch {
      return [skip("화면 발급", "python3 없음 — 이 기계에선 종전 방식으로 안내한다")];
    }
    const m = await import("../../core/llm-runtime/claude-token-issue.js");
    const issuer = [process.execPath, FAKE];
    const saved: string[] = [];
    const accept = async (t: string) => { saved.push(t); return { ok: true, message: "saved" }; };
    const out: Assertion[] = [];

    const b1 = await m.beginClaudeTokenIssue(issuer);
    const bad = await m.finishClaudeTokenIssue("wrong-code#st", accept);
    out.push(assert(
      "★가짜 터미널로 띄운 발급기가 로그인 주소를 통째로(줄바꿈 없이) 준다 · 틀린 코드는 저장하지 않고 오류를 말한다",
      b1.ok && b1.url.length > 300 && b1.url.includes("state=") && !bad.ok && /OAuth error/.test(bad.message) && saved.length === 0,
      { b1: b1.ok ? b1.url.length : b1, bad },
    ));

    const b2 = await m.beginClaudeTokenIssue(issuer);
    const good = await m.finishClaudeTokenIssue("  good-code#st\n", accept);
    out.push(assert(
      "★맞는 코드 → 발급기가 낸 토큰이 저장으로 간다(토큰이 끊김 없이 한 덩어리로)",
      b2.ok && good.ok && saved.length === 1 && saved[0]!.includes(`sk-ant-oat01-${"A".repeat(90)}`),
      { b2: b2.ok, good, savedHasToken: saved.map((t) => t.includes("sk-ant-oat01-")) },
    ));

    // 토큰을 직접 붙여넣으면(이미 받아 둔 것) — 발급기가 떠 있어도 종전 길로 저장하고 발급기는 치운다.
    await m.beginClaudeTokenIssue(issuer);
    const direct = await m.finishClaudeTokenIssue(`sk-ant-oat01-${"B".repeat(90)}`, accept);
    const noSession = await m.finishClaudeTokenIssue("some-code", accept);
    out.push(assert(
      "토큰을 붙여넣으면 토큰으로 저장 · 발급기가 없으면 붙여넣은 글은 종전 판단(저장 경로)으로 간다",
      direct.ok && saved[1]!.includes("B".repeat(90)) && noSession.ok && saved[2] === "some-code",
      { direct, noSession, saved: saved.length },
    ));
    return out;
  },
};
