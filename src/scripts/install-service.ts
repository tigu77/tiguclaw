// src/scripts/install-service.ts
/**
 * install-service — 하위호환 얇은 래퍼.
 *
 * 데몬 설치/관리의 단일 진실 소스는 이제 `src/scripts/daemon.ts` 다 (크로스플랫폼:
 * macOS launchd / Linux systemd user / Windows Task Scheduler). 이 파일은 기존
 * 진입점(`npm run daemon:install`, 문서 참조)을 깨지 않기 위해 install 을 위임한다.
 *
 * `--print` 플래그는 daemon.ts 의 `print` 서브커맨드로 매핑(미리보기).
 */
import process from "node:process";
import { runDaemonCommand } from "./daemon.js";

const printOnly = process.argv.includes("--print");
runDaemonCommand(printOnly ? "print" : "install");
