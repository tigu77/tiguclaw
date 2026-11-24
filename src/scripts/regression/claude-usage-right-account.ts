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
 *  ③ 같은 계정으로 답해도 CLI 숫자는 표시·저장하지 않는다 — `/usage` 와 `auth status` 는 별개 프로세스라 그 사이 재로그인을 가를 수
 *     없다(⑦). 대가: 확인된 값(턴·엔드포인트)이 없으면 같은 계정이어도 «확인할 수 없다» (2026-11-21 정태님)
 *  ④ 다른 계정인데 낡은 턴 값이 있으면 그 값(측정 시각과 함께 — 화면이 «N시간 전 측정» 을 붙인다)
 *  ⑤ 토큰 계정이나 CLI 계정을 **모르면**(확인 불가) CLI 숫자를 쓰지 않고 «확인할 수 없다» — 터미널 로그인을 요구하지 않는다
 *     (2026-11-21 정태님 «이후에도 확인된 값만 쓰자» — 10-10 의 «모르면 막지 않는다» 를 대체) · 낡은 턴 값이 있으면 그 값
 *  ⑥ 토큰 조직 조회가 실패 응답이면 그 응답 머리의 조직을 귀속 근거로 쓰지 않는다
 *  ⑦ `/usage` 뒤 `auth status` 전에 CLI 가 B→A 로 다시 로그인해도 B 의 숫자를 표시·저장하지 않는다 · 지금 토큰의 턴 값이 있으면 그 값
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
    const runCase = async (tag: string, turns: typeof turnsFresh | undefined, cliOrg: string, tokenOrg: string | null, modelsOk = true): Promise<{ u: Usage; spawns: number }> => {
      const dir = await fsp.mkdtemp(`${os.tmpdir()}/usage-acct-`);
      fakeCli(cliOrg);
      cliSpawns = 0;
      globalThis.fetch = (async (url: string) => ({
        ok: modelsOk || !String(url).includes("/v1/models"),
        status: modelsOk || !String(url).includes("/v1/models") ? 200 : 502,
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
      out.push(
        assert(
          "★③ 같은 계정으로 답해도 CLI 숫자는 쓰지 않는다 — 확인된 값이 없으면 «확인할 수 없다»(로그인 안내 아님)",
          (c.u.windows ?? []).length === 0 && c.u.unavailable === true && /확인할 수 없어/.test(String(c.u.reason)) && !/login|로그인/.test(String(c.u.reason)) && c.spawns === 2,
          { 창: c.u.windows, 이유: c.u.reason, CLI: c.spawns },
        ),
      );
      const d = await runCase("mismatch-old", turnsOld, "org-cli", "org-token");
      // ⑤ 모름 — 토큰 조직이 안 온다(응답 머리 없음) · CLI 조직이 안 온다(`auth status` 에 orgId 없음)
      for (const [tag, cliOrg, tokenOrg] of [["tok-unknown", "org-same", null], ["cli-unknown", "", "org-same"]] as const) {
        const e = await runCase(tag, undefined, cliOrg, tokenOrg);
        out.push(
          assert(
            `★★⑤ (${tag}) CLI 숫자가 이 설치의 계정 것인지 모르면 숫자 대신 «확인할 수 없다» — 로그인 안내 아님`,
            (e.u.windows ?? []).length === 0 && e.u.unavailable === true && /확인할 수 없어/.test(String(e.u.reason)) && !/login|로그인/.test(String(e.u.reason)),
            { 창: e.u.windows, 이유: e.u.reason },
          ),
        );
      }
      // ⑥ 모델 목록이 실패 응답(502)인데 조직 머리가 붙어 왔다 — 실패 응답의 머리는 귀속 근거가 아니다(G3)
      const g = await runCase("models-502", undefined, "org-same", "org-same", false);
      out.push(
        assert(
          "★⑥ 토큰 조직 조회가 실패 응답이면 그 머리의 조직으로 CLI 숫자를 귀속하지 않는다 — «확인할 수 없다»",
          (g.u.windows ?? []).length === 0 && g.u.unavailable === true && /확인할 수 없어/.test(String(g.u.reason)),
          { 창: g.u.windows, 이유: g.u.reason },
        ),
      );
      const f = await runCase("unknown-old", turnsOld, "org-same", null);
      out.push(
        assert("⑤ 모르는데 낡은 턴 값(지금 토큰의 실측)이 있으면 그 값을 측정 시각과 함께(CLI 숫자 X)", f.u.windows?.[0]?.remainingPercent === 88 && f.u.measuredAt === turnsOld.measuredAt, {
          창: f.u.windows,
        }),
      );
      out.push(
        assert(
          "④ 다른 계정인데 낡은 턴 값이 있으면 그 값을 측정 시각과 함께(CLI 숫자 X)",
          d.u.windows?.[0]?.remainingPercent === 88 && d.u.measuredAt === turnsOld.measuredAt,
          { 창: d.u.windows, 측정: d.u.measuredAt },
        ),
      );
      // ⑦ CLI 로그인이 `/usage` 와 `auth status` 사이에 바뀐다(두 호출은 별개 프로세스 — 2026-11-21 남은 차단 #1).
      //  CLI 는 B 로 로그인된 채 `/usage`(B 의 숫자 — 10% 남음)를 내고, 그 직후 A(= 이 설치의 토큰 조직)로 다시 로그인한다.
      //  각 프로세스는 **뜰 때의** 로그인을 읽는다. B 의 숫자가 A 의 값으로 표시·저장되면 안 된다 — 지금 토큰(A)의 턴 값이 있으면 그 값.
      for (const [tag, turns] of [["none", undefined], ["turn", turnsOld]] as const) {
        let cliLogin = "org-B";
        cpCjs.spawn = (...a: unknown[]) => {
          if (!/claude(\.exe)?$/.test(String(a[0]))) return realSpawn(...a);
          cliSpawns += 1;
          const args = (a[1] as string[]) ?? [];
          const who = cliLogin;
          const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
          p.stdout = new EventEmitter();
          p.kill = () => {};
          const used = who === "org-B" ? 90 : 30;
          const outText = args[0] === "auth"
            ? JSON.stringify({ loggedIn: true, orgId: who })
            : JSON.stringify({ result: `Current session: ${used}% used · resets Oct 10 at 7:40pm (Asia/Seoul)\nCurrent week (all models): 50% used · resets Oct 14 at 8pm (Asia/Seoul)` });
          setImmediate(() => {
            p.stdout.emit("data", outText);
            p.emit("close", 0);
            if (args[0] !== "auth") cliLogin = "org-A"; // `/usage` 가 끝나자마자 CLI 를 A 로 다시 로그인
          });
          return p;
        };
        syncBuiltinESMExports();
        const dir = await fsp.mkdtemp(`${os.tmpdir()}/usage-acct-`);
        cliSpawns = 0;
        globalThis.fetch = (async (url: string) => ({
          ok: true,
          status: 200,
          headers: { get: (k: string) => (String(url).includes("/v1/models") && k.toLowerCase() === "anthropic-organization-id" ? "org-A" : null) },
          json: async () => ({}),
          text: async () => "",
        })) as never;
        try {
          const P = (await import(`${modUrl}?acct-switch-${tag}`)).default as new () => { startService: (b: unknown, h: unknown) => Promise<void> };
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
          const u = ((await (h.captured?.getUsage as (f?: boolean) => Promise<Usage>)(true)) ?? {}) as Usage;
          const cached = await fsp.readFile(`${dir}/usage-cache.json`, "utf8").then((s) => JSON.parse(s) as { value?: Usage | null }, () => undefined);
          const shownB = (u.windows ?? []).some((w) => w.windowSeconds === 18_000 && w.remainingPercent === 10);
          const savedB = (cached?.value?.windows ?? []).some((w) => w.windowSeconds === 18_000 && w.remainingPercent === 10);
          const answerOk =
            turns === undefined
              ? (u.windows ?? []).length === 0 && u.unavailable === true && /확인할 수 없어/.test(String(u.reason))
              : u.windows?.[0]?.remainingPercent === 88 && u.measuredAt === turns.measuredAt;
          out.push(
            assert(`★★⑦ (${tag}) \`/usage\` 뒤 \`auth status\` 전에 CLI 로그인이 B→A 로 바뀌어도 B 의 숫자를 A(이 설치) 값으로 표시·저장하지 않는다 — ${turns === undefined ? "«확인할 수 없다»" : "지금 토큰의 턴 값"}`, !shownB && !savedB && answerOk && (cached?.value ?? null) === null && cliSpawns === 2, {
              창: u.windows,
              이유: u.reason,
              저장: cached?.value ?? null,
              CLI: cliSpawns,
            }),
          );
        } finally {
          globalThis.fetch = realFetch;
          restoreCli();
          await fsp.rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    }
    return out;
  },
};

export default check;
