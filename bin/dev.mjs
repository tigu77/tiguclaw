#!/usr/bin/env node
// dev 런처 — tsx watch + 격리 dev 홈(기본 ./tiguclaw-dev). 크로스플랫폼:
// 인라인 env("TIGUCLAW_HOME=... tsx ...")는 Windows cmd 에서 깨지므로, 여기서
// process.env 로 주입한다(bin/tiguclaw.mjs 와 동일 spawn 패턴, 새 의존성 0).
// TIGUCLAW_HOME 을 이미 지정했으면 존중, 아니면 ./tiguclaw-dev 로 prod 와 격리.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(root, "src", "index.ts");

const r = spawnSync(
  process.execPath,
  [tsxCli, "watch", "--env-file=.env", entry],
  {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      TIGUCLAW_HOME: process.env.TIGUCLAW_HOME?.trim() || "./tiguclaw-dev",
    },
  },
);
process.exit(r.status ?? 1);
