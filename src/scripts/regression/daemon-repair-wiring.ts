/**
 * 회귀: **`repair` 로 가는 길이 전부 이어져 있다** — 실행으로 (2026-10-23, 레드팀 10-22 G-2).
 *
 * ★왜: Windows 의 정지·업데이트·제거 실패 안내는 **전부** «`npm run daemon:repair`» 를 가리킨다 — 유일한 복구 길이다. 그런데
 *  그 길의 이음매(비 Windows 가드 · `known` · `handlers.win32.repair` · `package.json` 의 `daemon:repair` · `bin/tiguclaw.mjs` 의
 *  `LIFECYCLE` · `src/cli.ts` 의 `case "repair"`)를 하나씩 지워도 회귀가 전부 초록이었다 — `winRepair` 본문만 따로 시험했다.
 *  여기서는 소스를 대조하지 않고 **그 문으로 실제로 들어가 본다**(자식 프로세스).
 *
 * 무엇으로 가르나 — 들어간 문마다 끝에 나오는 문장:
 *  - 비 Windows: «Nothing to repair on this OS»(가드). 가드가 없으면 `handlers.darwin` 에 repair 가 없어 «not supported», `known` 에서
 *    빠지면 «unknown subcommand» 다.
 *  - Windows(가짜 플랫폼 + 가짜 `powershell`, 비 Windows 에서): `winRepair` 까지 가서 «✅ Repaired» 와 PowerShell 두 번(상태 → 권한).
 *  - Windows(진짜): 임시 라벨이라 작업이 없다 → `winRepair` 의 «Nothing to repair — no scheduled task».
 *  - `tiguclaw repair` 는 `LIFECYCLE` 로 **tsx 를 거치지 않고** 간다 — 가짜 tsx 가 불리면 «TSX-FALLBACK» 이 찍힌다.
 *
 * 등급: **동작**. 임시 폴더(가짜 레포 = `package.json`·`bin/` 사본)와 임시 홈·임시 라벨만 쓴다. 진짜 예약작업은 안 만든다·안 바꾼다.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WIN = process.platform === "win32";

export const check: RegressionCheck = {
  name: "daemon-repair-wiring",
  guards:
    "Windows 정지·업데이트·제거 실패가 가리키는 유일한 복구 길(`npm run daemon:repair`·`tiguclaw repair`)의 이음매 — 비 Windows 가드·known·handlers·package.json 스크립트·LIFECYCLE·cli case — 를 지워도 초록이던 것(레드팀 10-22 G-2)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-repair-wiring-"));
    try {
      // 가짜 레포 — 데몬 매니저는 `cwd` 를 레포 루트로 본다(`buildCtx`). 개발 레포의 `.env` 를 안 읽게 따로 둔다.
      const fake = path.join(tmp, "repo");
      mkdirSync(path.join(fake, "bin"), { recursive: true });
      for (const f of ["package.json", "bin/daemon.mjs", "bin/tiguclaw.mjs"]) copyFileSync(path.join(REPO, f), path.join(fake, f));
      // `tiguclaw` 가 lifecycle 이 아니라고 보면 tsx 로 `src/cli.ts` 를 띄운다 — 그 자리에 «불렸다» 고만 말하는 가짜를 둔다(설치 부트스트랩도 안 돈다).
      mkdirSync(path.join(fake, "node_modules", "tsx", "dist"), { recursive: true });
      writeFileSync(path.join(fake, "node_modules", "tsx", "dist", "cli.mjs"), `console.log("TSX-FALLBACK " + process.argv.slice(2).join(" "));\n`);
      const home = path.join(tmp, "home");
      mkdirSync(home);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TIGUCLAW_HOME: home,
        TIGUCLAW_SERVICE_LABEL: `tiguclaw-regr-repair-${process.pid}`,
        TIGUCLAW_DISABLE_ENV_FILE: "1",
      };
      delete env.NODE_ENV;
      const text = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = fake): SpawnSyncReturns<string> =>
        spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000, shell: WIN && cmd === "npm" });
      // 이 OS 에서 repair 문이 끝까지 이어졌을 때 나오는 문장 — 비 Windows 는 가드, Windows 는 `winRepair`(임시 라벨이라 작업 없음).
      const reached = WIN ? /Nothing to repair — no scheduled task/ : /Nothing to repair on this OS/;
      const ok = (r: SpawnSyncReturns<string>): boolean => r.status === 0 && reached.test(text(r)) && !/TSX-FALLBACK|unknown subcommand|not supported/.test(text(r));

      const direct = run(process.execPath, [path.join(fake, "bin", "daemon.mjs"), "repair"]);
      out.push(assert(`★\`node bin/daemon.mjs repair\` → ${WIN ? "winRepair(작업 없음)" : "비 Windows 가드"} · 종료 0`, ok(direct), { status: direct.status, out: text(direct).slice(0, 400) }));

      const viaNpm = run("npm", ["run", "--silent", "daemon:repair"]);
      out.push(assert("★`npm run daemon:repair`(모든 실패 안내가 가리키는 그 명령) → 같은 곳에 닿는다", ok(viaNpm), { status: viaNpm.status, out: text(viaNpm).slice(0, 400) }));

      const viaCli = run(process.execPath, [path.join(fake, "bin", "tiguclaw.mjs"), "repair"]);
      out.push(assert("★`tiguclaw repair` → 데몬 매니저로 직접(tsx·node_modules 를 안 거친다 — 깨진 설치에서도 되는 길)", ok(viaCli), { status: viaCli.status, out: text(viaCli).slice(0, 400) }));

      // `src/cli.ts` 의 case — 직접 부르는 사람도 있다(`npx tsx src/cli.ts repair`). cwd 의 `bin/daemon.mjs` 로 넘긴다.
      const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
      const viaTs = run(process.execPath, [tsx, path.join(REPO, "src", "cli.ts"), "repair"]);
      out.push(assert("★`src/cli.ts repair` → 데몬 매니저의 repair 로 넘긴다(«Unknown command» 가 아니다)", ok(viaTs) && !/Unknown command/.test(text(viaTs)), { status: viaTs.status, out: text(viaTs).slice(0, 400) }));

      if (!WIN) {
        // Windows 문 — 플랫폼만 win32 로 보이게 하고, `powershell` 은 받은 스크립트를 보고 답하는 가짜. 호출을 적어 둔다.
        const fakeBin = path.join(tmp, "fakebin");
        mkdirSync(fakeBin);
        const calls = path.join(tmp, "ps-calls.jsonl");
        const ps = path.join(fakeBin, "powershell");
        writeFileSync(
          ps,
          [
            `#!${process.execPath}`,
            `const fs = require("node:fs");`,
            `const i = process.argv.indexOf("-EncodedCommand");`,
            `const script = Buffer.from(process.argv[i + 1] ?? "", "base64").toString("utf16le");`,
            `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(script) + "\\n");`,
            `if (script.includes("TASK_STATE=")) console.log("TASK_STATE=enabled");`,
            `else if (script.includes("TASK_ACL_OK")) console.log("TASK_ACL_OK");`,
            `else { console.error("unexpected script"); process.exit(1); }`,
          ].join("\n"),
        );
        chmodSync(ps, 0o755);
        const preload = path.join(tmp, "as-win32.mjs");
        writeFileSync(preload, `Object.defineProperty(process, "platform", { value: "win32" });\n`);
        const winRun = run(process.execPath, ["--import", "file://" + preload, path.join(fake, "bin", "daemon.mjs"), "repair"], {
          PATH: fakeBin + path.delimiter + (process.env.PATH ?? ""),
        });
        let scripts: string[] = [];
        try {
          scripts = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
        } catch { scripts = []; }
        out.push(
          assert(
            "★★Windows 에서 repair → `handlers.win32.repair`(winRepair) — 상태를 읽고 권한 조각을 한 번 돌려 «✅ Repaired»(가드가 Windows 를 막지 않는다 · 표에 이어져 있다)",
            winRun.status === 0 && /✅ Repaired/.test(text(winRun)) && scripts.length === 2 &&
              scripts[0].includes("TASK_STATE=") && scripts[1].includes("SetSecurityDescriptor"),
            { status: winRun.status, out: text(winRun).slice(0, 400), calls: scripts.map((s) => s.slice(0, 60)) },
          ),
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
