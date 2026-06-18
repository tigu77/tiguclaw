// src/scripts/install-service.ts
/**
 * install-service — tiguclaw 데몬을 OS supervisor 에 등록(상시 가동 + 자동 respawn).
 *
 * 이식형(자가호스트 배포 Phase 1): 하드코딩 경로 0 — *런타임* 값으로 유닛을 생성한다.
 *   node = process.execPath / repo = process.cwd() / home = TIGUCLAW_HOME ?? ~/.tiguclaw.
 * macOS = launchd(KeepAlive). linux/windows = Phase 2 (현재는 수동 실행 안내).
 *
 * 사용:
 *   npm run daemon:install              # 유닛 생성 + 등록
 *   npm run daemon:install -- --print   # 유닛 내용만 출력(설치 안 함, 미리보기)
 *
 * 개발 홈 보존: dev 는 `TIGUCLAW_HOME=./tiguclaw-dev npm run daemon:install` 로 실행해야
 *   기존 dev 데이터(./tiguclaw-dev)를 유지한다. 미설정 시 prod 기본 ~/.tiguclaw.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// 기본 라벨. 한 머신에서 2개 이상 인스턴스(예: prod + 검증용)를 상시 가동하려면
// TIGUCLAW_SERVICE_LABEL 로 고유 라벨을 지정한다 (홈·봇·포트도 함께 분리할 것).
const LABEL = process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

const buildLaunchdPlist = (v: {
  nodePath: string;
  tsxCli: string;
  repoRoot: string;
  homeRaw: string;
  logsDir: string;
}): string => {
  const nodeBinDir = path.dirname(v.nodePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- tiguclaw LaunchAgent — install-service 가 런타임 생성(하드코딩 경로 0). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${v.nodePath}</string>
    <string>${v.tsxCli}</string>
    <string>--env-file=.env</string>
    <string>${path.join(v.repoRoot, "src", "index.ts")}</string>
  </array>
  <key>WorkingDirectory</key><string>${v.repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TIGUCLAW_HOME</key><string>${v.homeRaw}</string>
    <key>PATH</key><string>${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${path.join(v.logsDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(v.logsDir, "launchd.err.log")}</string>
</dict>
</plist>
`;
};

const main = (): void => {
  const printOnly = process.argv.includes("--print");
  const repoRoot = process.cwd();
  const nodePath = process.execPath;
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const homeRaw =
    process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
  const homeAbs = path.resolve(repoRoot, expandHome(homeRaw));
  const logsDir = path.join(homeAbs, "logs");

  if (process.platform !== "darwin") {
    console.log(
      `install-service: 현재 OS(${process.platform})는 자동 등록 미지원 (Phase 2: linux systemd 예정).`,
    );
    console.log(
      "우선은 프로세스 매니저(pm2/systemd/nohup) 아래에서 다음을 상시 실행하세요:",
    );
    console.log(
      `  TIGUCLAW_HOME=${homeRaw} ${nodePath} ${tsxCli} --env-file=.env ${path.join(repoRoot, "src", "index.ts")}`,
    );
    return;
  }

  const plist = buildLaunchdPlist({ nodePath, tsxCli, repoRoot, homeRaw, logsDir });

  if (printOnly) {
    console.log(plist);
    return;
  }

  mkdirSync(logsDir, { recursive: true });
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LABEL}.plist`,
  );
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, "utf8");
  console.log(`생성: ${plistPath}`);

  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  // 이미 등록돼 있으면 bootout(실패 무시) 후 재등록.
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], {
      stdio: "ignore",
    });
  } catch {
    /* 미등록 — 무시 */
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain, plistPath], {
      stdio: "inherit",
    });
  } catch {
    // 일부 macOS/세션에서 bootstrap 실패 시 레거시 load 폴백.
    execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  }
  console.log(`✅ launchd 등록 완료 (KeepAlive). TIGUCLAW_HOME=${homeRaw}`);
  console.log(
    `   상태: npm run daemon:status · 로그: ${path.join(logsDir, "daemon-<날짜>.log")}`,
  );
};

main();
