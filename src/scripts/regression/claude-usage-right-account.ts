/**
 * 회귀: **Claude 구독 한도는 이 설치의 토큰 계정 것만 보인다** (2026-10-10 정태님: «한도가 항상 똑같이 나오네» · «셋업토큰 정보로
 * 한도정보를 가져올 수 없나?» · «cli 인증과 달라서 표시할 수 없다고 알려주면»).
 *
 * 사고: 한도는 이 기계 Claude Code CLI 의 `/usage` 로 가져왔는데, CLI 는 **자기 로그인 계정**의 한도를 말한다 — 이 설치의 토큰과
 *  다른 계정이면 남의 숫자가 «인증됨» 옆에 떴다. 그리고 SDK 가 턴마다 토큰 자신의 사용률을 주는데 쓰지 않았다.
 *
 * 지키는 것(실제 플러그인 `getUsage` · 가짜 CLI · 가짜 fetch):
 *  ① 턴에서 받은 사용률이 최근이면 그것을 쓰고 CLI 를 띄우지 않는다
 *  ② CLI 계정(`auth status` orgId) ≠ 토큰 계정(모델 목록 응답 머리) → 숫자 대신 «다른 계정이라 표시할 수 없다»
 *  ③ 같은 계정이면 CLI 값 그대로
 *  ④ 다른 계정인데 낡은 턴 값이 있으면 그 값(측정 시각과 함께 — 화면이 «N시간 전 측정» 을 붙인다)
 *
 * 등급: **동작**(네트워크·CLI 0).
 */
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const cpCjs = createRequire(import.meta.url)("node:child_process") as { spawn: (...a: unknown[]) => unknown };
const realSpawn = cpCjs.spawn;
let cliSpawns = 0;
/** `/usage` 와 `auth status` 에 각각 답하는 가짜 CLI. */
const fakeCli = (cliOrg: string): void => {
  cpCjs.spawn = (...a: unknown[]) => {
    if (!/claude(\.exe)?$/.test(String(a[0]))) return realSpawn(...a);
    cliSpawns += 1;
    const args = (a[1] as string[]) ?? [];
    const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
    p.stdout = new EventEmitter();
    p.kill = () => {};
    const out = args[0] === "auth"
      ? JSON.stringify({ loggedIn: true, orgId: cliOrg })
      : JSON.stringify({ result: "Current session: 30% used · resets Oct 10 at 7:40pm (Asia/Seoul)\nCurrent week (all models): 50% used · resets Oct 14 at 8pm (Asia/Seoul)" });
    setImmediate(() => {
      p.stdout.emit("data", out);
      p.emit("close", 0);
    });
    return p;
  };
  syncBuiltinESMExports();
};
const restoreCli = (): void => {
  cpCjs.spawn = realSpawn;
  syncBuiltinESMExports();
};

type Usage = { windows?: { windowSeconds: number; remainingPercent?: number }[]; measuredAt?: number; unavailable?: boolean; reason?: string };

export const check: RegressionCheck = {
  name: "claude-usage-right-account",
  guards: "Claude 구독 한도 화면이 이 기계 CLI 의 다른 계정 숫자를 «인증됨» 옆에 띄우던 것 + 턴마다 오는 토큰 자신의 사용률을 안 쓰던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const modUrl = new URL("../../../plugins/claude-subscription-auth/index.mjs", import.meta.url).href;
    const realFetch = globalThis.fetch;
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-regression-fake";
    const turnsFresh = { measuredAt: Date.now() - 60_000, windows: [{ windowSeconds: 18_000, remainingPercent: 88 }, { windowSeconds: 604_800, remainingPercent: 71 }] };
    const turnsOld = { ...turnsFresh, measuredAt: Date.now() - 5 * 3_600_000 };
    const runCase = async (tag: string, turns: typeof turnsFresh | undefined, cliOrg: string, tokenOrg: string): Promise<{ u: Usage; spawns: number }> => {
      const dir = await fsp.mkdtemp(`${os.tmpdir()}/usage-acct-`);
      fakeCli(cliOrg);
      cliSpawns = 0;
      globalThis.fetch = (async (url: string) => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (String(url).includes("/v1/models") && k.toLowerCase() === "anthropic-organization-id" ? tokenOrg : null) },
        json: async () => ({}),
        text: async () => "",
      })) as never;
      try {
        const P = (await import(`${modUrl}?acct-${tag}`)).default as new () => { startService: (b: unknown, h: unknown) => Promise<void> };
        const h = {
          dataDir: dir,
          locale: "ko",
          log: () => {},
          captured: undefined as Record<string, unknown> | undefined,
          registerAuthProvider: (pp: Record<string, unknown>) => {
            h.captured = pp;
            return { ok: true as const };
          },
          claudeUsageFromTurns: () => turns,
        };
        await new P().startService(null, h);
        const u = (await (h.captured?.getUsage as (f?: boolean) => Promise<Usage>)(true)) ?? {};
        return { u, spawns: cliSpawns };
      } finally {
        globalThis.fetch = realFetch;
        restoreCli();
        await fsp.rm(dir, { recursive: true, force: true });
      }
    };
    try {
      const a = await runCase("fresh", turnsFresh, "org-cli", "org-token");
      out.push(assert("★① 턴에서 받은 사용률이 최근이면 그것(토큰 자신의 값) — CLI 를 안 띄운다", a.u.windows?.[0]?.remainingPercent === 88 && a.spawns === 0, { 창: a.u.windows, CLI: a.spawns }));
      const b = await runCase("mismatch", undefined, "org-cli", "org-token");
      out.push(
        assert(
          "★② CLI 계정 ≠ 토큰 계정이면 숫자 대신 «다른 계정이라 표시할 수 없다»",
          (b.u.windows ?? []).length === 0 && b.u.unavailable === true && /다른 계정/.test(String(b.u.reason)),
          { 창: b.u.windows, 이유: b.u.reason },
        ),
      );
      const c = await runCase("same", undefined, "org-same", "org-same");
      out.push(assert("③ 같은 계정이면 CLI 값 그대로", c.u.windows?.[0]?.remainingPercent === 70, { 창: c.u.windows }));
      const d = await runCase("mismatch-old", turnsOld, "org-cli", "org-token");
      out.push(
        assert(
          "④ 다른 계정인데 낡은 턴 값이 있으면 그 값을 측정 시각과 함께(CLI 숫자 X)",
          d.u.windows?.[0]?.remainingPercent === 88 && d.u.measuredAt === turnsOld.measuredAt,
          { 창: d.u.windows, 측정: d.u.measuredAt },
        ),
      );
    } finally {
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    }
    return out;
  },
};

export default check;
