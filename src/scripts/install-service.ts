// src/scripts/install-service.ts
/**
 * install-service — 하위호환 얇은 래퍼.
 *
 * 데몬 설치/관리의 단일 진실 소스는 이제 `bin/daemon.mjs` 다 (ADR 2026-07-15,
 * 의존성-프리 라이프사이클 매니저. 크로스플랫폼: macOS launchd / Linux systemd user /
 * Windows HKCU Run+VBS). 이 파일은 기존 진입점(`tiguclaw install-service`, 문서 참조)을
 * 깨지 않기 위해 install 을 dep-free 매니저로 위임(spawn)한다.
 *
 * `--print` 플래그는 daemon.mjs 의 `print` 서브커맨드로 매핑(미리보기).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

// bin/daemon.mjs 를 순수 node 로 실행(tsx 미경유). repoRoot 기준 상대경로 해석.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const daemonMjs = path.join(repoRoot, "bin", "daemon.mjs");
const printOnly = process.argv.includes("--print");

const r = spawnSync(process.execPath, [daemonMjs, printOnly ? "print" : "install"], {
  stdio: "inherit",
  cwd: repoRoot,
});
process.exit(r.status ?? 1);
