/**
 * 회귀: **onboard·doctor 가 두드리는 주소 = 데몬이 실제로 쓰는 주소** (2026-10-16, 아스트라 «온보딩 후속 검토» = 3차 재검토 P-a).
 *
 * 사고: 윈도우에서 홈 `.env` 에 `HTTP_BRIDGE_PORT=` 처럼 빈 값을 두고 `win-service-env.json` 에 붙잡은 포트가 남아 있으면, 데몬은
 *  붙잡은 포트로 뜨는데(`winLaunchEnv` 는 홈의 빈 값을 «안 정함» 으로 본다) onboard·doctor 는 빈 값=기본 포트로 읽어 다른 포트를
 *  두드렸다 — 서비스는 정상인데 «안 끝났다»·doctor ❌. 종전 회귀는 우리 해석 함수의 기대값을 **손으로** 적어, 데몬과 갈려도 몰랐다.
 *
 * 본다: 같은 파일(홈 .env · 붙잡은 값 · 레포 .env)에서 ①데몬 쪽 = **실제** `bin/daemon.mjs winLaunchEnv`(윈도우만) + Node
 *  `process.loadEnvFile`(홈 → 레포, load-env 와 같은 순서)을 새 프로세스에서 돌린 결과 ②`installedEnvLookup` — 둘로 만든 브리지
 *  health·대시보드 주소가 같은가. 경우: 홈 키 없음/빈 값/값 × 붙잡은 값 없음/값/빈칸 × 레포 있음/없음 × 윈도우/맥.
 *  ★예약작업의 실행 환경(setx 등)은 비워 둔다 — 그 축은 onboard 가 못 본다(로드맵 P-b, 이 검사 밖).
 *
 * 등급: **실행**(데몬의 진짜 함수 · 진짜 loadEnvFile · 대조).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const KEYS = ["HTTP_BRIDGE_PORT", "HTTP_BRIDGE_HOST", "DASHBOARD_PORT", "DASHBOARD_HOST"] as const;
// 데몬 쪽 — 깨끗한 프로세스에서 데몬과 같은 순서로 실행 환경을 만든다. 인자는 env 로 넘긴다(argv[1] 이 daemon.mjs 로 끝나면 CLI 가 돈다).
const CHILD = `
import path from "node:path";
const { DAEMON_URL, SIM_HOME, SIM_REPO, SIM_PLATFORM } = process.env;
const d = await import(DAEMON_URL);
const KEYS = ${JSON.stringify(KEYS)};
for (const k of KEYS) delete process.env[k];
if (SIM_PLATFORM === "win32") Object.assign(process.env, d.winLaunchEnv({ ...process.env }, SIM_HOME));
for (const f of [path.join(SIM_HOME, ".env"), path.join(SIM_REPO, ".env")]) { try { process.loadEnvFile(f); } catch {} }
console.log(JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))));
`;

export const check: RegressionCheck = {
  name: "onboard-sees-what-daemon-uses",
  guards: "윈도우에서 홈 .env 의 빈 값과 붙잡은 실행 환경을 데몬과 onboard·doctor 가 반대로 읽어, 정상 서비스를 «안 끝났다» 로 보던 것",
  run: async (): Promise<Assertion[]> => {
    const m = await import("../../core/onboard-ready.js");
    const daemonUrl = new URL("../../../bin/daemon.mjs", import.meta.url).href;
    const root = mkdtempSync(path.join(tmpdir(), "onboard-daemon-env-"));
    const mismatches: string[] = [];
    let cases = 0;
    try {
      for (const platform of ["win32", "darwin"] as const) {
        for (const homeState of ["none", "empty", "value"] as const) {
          for (const saved of ["none", "value", "blank"] as const) {
            for (const repo of [false, true]) {
              const dir = mkdtempSync(path.join(root, "c-"));
              const home = path.join(dir, "home");
              const repoDir = path.join(dir, "repo");
              for (const d of [home, repoDir]) mkdirSync(d, { recursive: true });
              const homeLines = ["OTHER=1"];
              if (homeState === "empty") homeLines.push("HTTP_BRIDGE_PORT=", "DASHBOARD_HOST=");
              if (homeState === "value") homeLines.push("HTTP_BRIDGE_PORT=18111", "DASHBOARD_HOST=10.1.1.1");
              writeFileSync(path.join(home, ".env"), homeLines.join("\n") + "\n");
              // blank = 빈칸만 붙잡힌 값 — 데몬은 그대로 실행 환경에 넣고 소비처가 기본값으로 읽는다(다듬어 레포로 넘기면 갈린다)
              if (saved !== "none") writeFileSync(path.join(home, "win-service-env.json"), JSON.stringify(saved === "value" ? { HTTP_BRIDGE_PORT: "18222", DASHBOARD_HOST: "10.2.2.2" } : { HTTP_BRIDGE_PORT: "  ", DASHBOARD_HOST: " " }));
              if (repo) writeFileSync(path.join(repoDir, ".env"), "HTTP_BRIDGE_PORT=18333\nDASHBOARD_HOST=10.3.3.3\n");
              const out = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
                env: { PATH: process.env.PATH ?? "", DAEMON_URL: daemonUrl, SIM_HOME: home, SIM_REPO: repoDir, SIM_PLATFORM: platform },
                encoding: "utf8",
                timeout: 20_000,
              });
              const daemonEnv = JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, string | undefined>;
              const daemonGet = (k: string): string | undefined => daemonEnv[k];
              const ours = m.installedEnvLookup(path.join(home, ".env"), repoDir, platform);
              const want = { health: m.bridgeHealthUrl(daemonGet), dash: m.dashboardUrl(daemonGet) };
              const got = { health: m.bridgeHealthUrl(ours), dash: m.dashboardUrl(ours) };
              cases += 1;
              if (want.health !== got.health || want.dash !== got.dash) {
                mismatches.push(`${platform} 홈=${homeState} 붙잡음=${saved} 레포=${repo}: 데몬 ${want.health} ${want.dash} / 우리 ${got.health} ${got.dash}`);
              }
            }
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const out: Assertion[] = [];
    out.push(assert("★같은 파일에서 데몬이 쓰는 브리지·대시보드 주소와 onboard·doctor 가 두드리는 주소가 같다(윈도우·맥 × 홈 없음/빈 값/값 × 붙잡은 값 없음/값/빈칸 × 레포)",
      cases === 36 && mismatches.length === 0, mismatches.length === 0 ? `${cases}경우 일치` : mismatches.slice(0, 4)));
    // 데몬 쪽 재현이 load-env 와 같은 순서인가(홈 → 레포) — 순서를 바꾸면 위 대조가 데몬이 아니라 가짜를 본다.
    const loadEnv = stripComments(readSourceSync("src/core/load-env.ts"));
    const homeAt = loadEnv.indexOf("const home_ok = tryLoad(homeEnv)");
    const repoAt = loadEnv.indexOf("tryLoad(repoEnv)");
    out.push(assert("데몬 쪽 재현의 전제 — load-env 는 홈 .env 를 레포 .env 보다 먼저 읽는다", homeAt > 0 && repoAt > homeAt, { homeAt, repoAt }));
    return out;
  },
};
