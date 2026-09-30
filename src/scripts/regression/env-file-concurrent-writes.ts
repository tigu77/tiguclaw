/**
 * 회귀: **홈 `.env` 동시 저장이 서로를 지우지 않는다** (2026-10-01, v0.63.0 릴리스 적대 검토 — 실측 3회 결정적).
 *
 * 사고(재현): 대시보드 토큰 저장과 codex 토큰 갱신처럼 두 저장이 겹치면, 둘 다 같은 옛 본문을 읽고 같은 임시 파일(`.tmp-<pid>`)에
 *  써서 한쪽은 rename 에서 던지고 다른 쪽은 성공이라 답했는데 **방금 저장한 토큰 줄이 파일에 없었다** — 재시작 뒤 401.
 * 지키는 것: 겹친 저장이 전부 성공 · 모든 키가 남는다 · 같은 키는 **나중에 부른 값** · 임시 파일 잔재 없음 · 0600 · 다른 키 보존 ·
 *  `process.env` 는 줄 서기 전에 즉시.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "env-file-concurrent-writes",
  guards: "홈 .env 동시 저장이 같은 임시 파일을 덮고 읽고-고치고-쓰기가 겹쳐, 성공이라 답한 저장의 토큰 줄이 파일에서 사라지던 것(재시작 뒤 401)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "envrace-"));
    const saved = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home;
    const envPath = path.join(home, ".env");
    writeFileSync(envPath, "OTHER_KEY=keep-me\nHTTP_BRIDGE_TOKEN=fake-bridge\n", { mode: 0o644 });
    const keys = ["REGR_ENV_A", "REGR_ENV_B", "REGR_ENV_C", "REGR_ENV_D", "REGR_ENV_E"];
    const before = keys.map((k) => process.env[k]);
    try {
      const { upsertHomeEnvVars } = await import("../../core/env-file.js");
      const p = keys.map((k, i) => upsertHomeEnvVars({ [k]: `v${i}`, REGR_ENV_SAME: `same-${i}` }));
      const immediate = keys.every((k, i) => process.env[k] === `v${i}`); // 줄 서기 전에 즉시
      const rs = await Promise.allSettled(p);
      const body = readFileSync(envPath, "utf8");
      const lines = body.split("\n").filter(Boolean);
      const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
      const leftovers = readdirSync(home).filter((f) => f.startsWith(".env.tmp"));
      const mode = (statSync(envPath).mode & 0o777).toString(8);
      return [
        assert("겹친 저장이 전부 성공한다(rename 충돌로 던지지 않는다)", rs.every((r) => r.status === "fulfilled"), rs.map((r) => r.status)),
        assert("★겹친 저장의 모든 키가 파일에 남는다", keys.every((k, i) => val(k) === `v${i}`), lines.map((l) => l.split("=")[0])),
        assert("같은 키는 나중에 부른 저장의 값이 남고, 한 줄뿐이다", val("REGR_ENV_SAME") === `same-${keys.length - 1}` && lines.filter((l) => l.startsWith("REGR_ENV_SAME=")).length === 1, val("REGR_ENV_SAME")),
        assert("다른 키를 보존하고 권한은 0600, 임시 파일 잔재가 없다", val("OTHER_KEY") === "keep-me" && val("HTTP_BRIDGE_TOKEN") === "fake-bridge" && mode === "600" && leftovers.length === 0, { mode, leftovers }),
        assert("process.env 는 파일 쓰기를 기다리지 않고 즉시 바뀐다", immediate, immediate),
      ];
    } finally {
      process.env.TIGUCLAW_HOME = saved;
      keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
      delete process.env.REGR_ENV_SAME;
    }
  },
};
