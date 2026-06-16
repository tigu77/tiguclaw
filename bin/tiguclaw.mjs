#!/usr/bin/env node
// tiguclaw CLI 실행 래퍼 — src/cli.ts 를 tsx 로 실행한다(소스 직접 구동).
// `npm link`(또는 전역 설치) 후 `tiguclaw <명령>` 으로 사용. cwd 를 레포 루트로
// 고정해 .env·npm 스크립트·플러그인 발견이 어디서 호출하든 일관되게 동작한다.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const cliTs = path.join(root, "src", "cli.ts");

const r = spawnSync(process.execPath, [tsxCli, cliTs, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
process.exit(r.status ?? 1);
