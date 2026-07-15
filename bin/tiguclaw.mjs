#!/usr/bin/env node
// tiguclaw CLI 실행 래퍼.
// `npm link`(또는 전역 설치) 후 `tiguclaw <명령>` 으로 사용. cwd 를 레포 루트로
// 고정해 .env·npm 스크립트·플러그인 발견이 어디서 호출하든 일관되게 동작한다.
//
// 라이프사이클 단락(ADR 2026-07-15 D2): 데몬 관리 8종은 dep-free `bin/daemon.mjs`
//   로 **직접** spawn — tsx·cli.ts·npm·node_modules 를 전혀 거치지 않는다. 깨진
//   node_modules/tsx 에서도 stop·restart·uninstall·install 이 항상 된다.
// 그 외 앱 명령(onboard/init/doctor/codex-auth/help)은 종전대로 tsx 로 src/cli.ts 실행
//   (앱 전체 deps 가 있어야 의미 있는 명령이라 tsx OK).
import { spawnSync } from "node:child_process";
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
]);

const cmd = process.argv[2];
let argv;
if (cmd !== undefined && LIFECYCLE.has(cmd)) {
  // node bin/daemon.mjs <cmd> [..rest] — 순수 node, node_modules 무관.
  argv = [path.join(root, "bin", "daemon.mjs"), ...process.argv.slice(2)];
} else {
  // tsx src/cli.ts <cmd> [..rest] — 앱 명령(전체 deps 필요).
  argv = [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "src", "cli.ts"),
    ...process.argv.slice(2),
  ];
}

const r = spawnSync(process.execPath, argv, {
  stdio: "inherit",
  cwd: root,
});
process.exit(r.status ?? 1);
