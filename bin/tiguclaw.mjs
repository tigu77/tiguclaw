#!/usr/bin/env node
// tiguclaw CLI 실행 래퍼.
// `npm link`(또는 전역 설치) 후 `tiguclaw <명령>` 으로 사용. cwd 를 레포 루트로
// 고정해 .env·npm 스크립트·플러그인 발견이 어디서 호출하든 일관되게 동작한다.
//
// 라이프사이클 단락(ADR 2026-07-15 D2): 데몬 관리 9종은 dep-free `bin/daemon.mjs`
//   로 **직접** spawn — tsx·cli.ts·npm·node_modules 를 전혀 거치지 않는다. 깨진
//   node_modules/tsx 에서도 stop·restart·uninstall·install·update 가 항상 된다
//   (update 는 자체적으로 npm ci 로 node_modules 를 복구한다).
// 그 외 앱 명령(onboard/init/doctor/codex-auth/help)은 종전대로 tsx 로 src/cli.ts 실행
//   (앱 전체 deps 가 있어야 의미 있는 명령이라 tsx OK).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 데몬 라이프사이클 명령 — dep-free 매니저로 직접 위임(tsx 우회).
const LIFECYCLE = new Set([
  "install",
  "uninstall",
  "restart",
  "stop",
  "start",
  "status",
  "logs",
  "print",
  "update",
]);

const cmd = process.argv[2];
let argv;
if (cmd !== undefined && LIFECYCLE.has(cmd)) {
  // node bin/daemon.mjs <cmd> [..rest] — 순수 node, node_modules 무관.
  argv = [path.join(root, "bin", "daemon.mjs"), ...process.argv.slice(2)];
} else {
  // tsx src/cli.ts <cmd> [..rest] — 앱 명령(전체 deps 필요).
  // ★deps 자동 부트스트랩 (2026-08-13, 사용자 요청 "깃풀 받고 tiguclaw onboard 에서 다 해결").
  //  종전엔 `git clone`/`git pull` 직후 tsx 가 없으면 이 spawn 이 **MODULE_NOT_FOUND 한 줄**로
  //  죽었다 — 첫 사용자가 보는 게 그 스택이었고, 어디에도 "npm install 먼저" 라고 안 적혀
  //  있었다(안내는 init 이 **끝난 뒤** 나온다 — 도달할 수가 없다).
  //  여기서 한 번 깔아준다: 순수 node + npm 만 쓰므로 dep-free 원칙을 안 깬다.
  const tsxEntry = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxEntry)) {
    console.log("[tiguclaw] 의존성이 없습니다 — npm ci 로 설치합니다 (최초 1회)…");
    // ci 는 lockfile 이 있어야 한다. 없으면(개발 중 체크아웃) install 로 강등.
    const useCi = existsSync(path.join(root, "package-lock.json"));
    const boot = spawnSync("npm", [useCi ? "ci" : "install"], {
      stdio: "inherit",
      cwd: root,
      shell: process.platform === "win32",
    });
    if ((boot.status ?? 1) !== 0 || !existsSync(tsxEntry)) {
      console.error(
        "[tiguclaw] 의존성 설치 실패 — 레포 루트에서 `npm ci` 를 직접 돌린 뒤 다시 시도하세요.",
      );
      process.exit(1);
    }
  }
  argv = [tsxEntry, path.join(root, "src", "cli.ts"), ...process.argv.slice(2)];
}

const r = spawnSync(process.execPath, argv, {
  stdio: "inherit",
  cwd: root,
});
process.exit(r.status ?? 1);
