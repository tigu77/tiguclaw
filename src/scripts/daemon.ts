// src/scripts/daemon.ts
/**
 * daemon — tiguclaw 데몬 관리 CLI (크로스플랫폼: macOS / Linux / Windows).
 *
 * 단일 진실 소스. 서브커맨드: install | uninstall | restart | status | logs | print.
 *   - macOS  → launchd LaunchAgent (KeepAlive, 자동 respawn).
 *   - Linux  → systemd **user** 유닛 (Restart=always).
 *   - Windows→ Task Scheduler (ONLOGON; KeepAlive 강도는 약함 — 아래 주석 참조).
 *
 * 이식형(자가호스트): 하드코딩 경로 0 — *런타임* 값으로 유닛/plist/task 를 생성한다.
 *   node = process.execPath / repo = process.cwd() / home = TIGUCLAW_HOME ?? ~/.tiguclaw.
 *
 * 새 의존성 0 — launchctl/systemctl/schtasks 는 OS 빌트인. node builtin 만 사용
 *   (child_process/fs/os/path).
 *
 * 사용:
 *   npm run daemon:install              # 등록(상시 가동 + 자동 respawn)
 *   npm run daemon:status               # 상태
 *   npm run daemon:restart              # 재시작
 *   npm run daemon:logs                 # 로그 tail+follow
 *   npm run daemon:uninstall            # 등록 해제 + 유닛 제거
 *   tsx src/scripts/daemon.ts print     # 설치 안 하고 유닛/명령만 미리보기
 *
 * 개발 홈 보존: dev 는 `TIGUCLAW_HOME=./tiguclaw-dev npm run daemon:install` 로 실행해야
 *   기존 dev 데이터(./tiguclaw-dev)를 유지한다. 미설정 시 prod 기본 ~/.tiguclaw.
 *
 * KeepAlive 강도(솔직히): macOS(launchd KeepAlive) > Linux(systemd Restart=always)
 *   > Windows(Task Scheduler ONLOGON — crash 자동재시작 약함). 완전 parity 는 WSL2 권장.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watchFile,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// 기본 라벨. 한 머신에서 2개 이상 인스턴스(예: prod + 검증용)를 상시 가동하려면
// TIGUCLAW_SERVICE_LABEL 로 고유 라벨을 지정한다 (홈·봇·포트도 함께 분리할 것).
const LABEL = process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";

const expandHome = (p: string): string =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

interface Ctx {
  repoRoot: string;
  nodePath: string;
  tsxCli: string;
  entry: string;
  homeRaw: string;
  homeAbs: string;
  logsDir: string;
  label: string;
}

const buildCtx = (): Ctx => {
  const repoRoot = process.cwd();
  const nodePath = process.execPath;
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(repoRoot, "src", "index.ts");
  const homeRaw =
    process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
  const homeAbs = path.resolve(repoRoot, expandHome(homeRaw));
  const logsDir = path.join(homeAbs, "logs");
  return {
    repoRoot,
    nodePath,
    tsxCli,
    entry,
    homeRaw,
    homeAbs,
    logsDir,
    label: LABEL,
  };
};

// ───────────────────────────── macOS (launchd) ─────────────────────────────
// install-service.ts 의 plist 내용을 100% 동일하게 이식 (라이브 서비스가 이걸로 돈다).

const buildLaunchdPlist = (c: Ctx): string => {
  const nodeBinDir = path.dirname(c.nodePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- tiguclaw LaunchAgent — daemon.ts 가 런타임 생성(하드코딩 경로 0). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${c.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${c.nodePath}</string>
    <string>${c.tsxCli}</string>
    <string>--env-file=.env</string>
    <string>${c.entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${c.repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TIGUCLAW_HOME</key><string>${c.homeRaw}</string>
    <key>PATH</key><string>${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${path.join(c.logsDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(c.logsDir, "launchd.err.log")}</string>
</dict>
</plist>
`;
};

const launchdPlistPath = (c: Ctx): string =>
  path.join(os.homedir(), "Library", "LaunchAgents", `${c.label}.plist`);

const launchdDomain = (): string => `gui/${process.getuid?.() ?? 0}`;

const darwinInstall = (c: Ctx): void => {
  const plist = buildLaunchdPlist(c);
  mkdirSync(c.logsDir, { recursive: true });
  const plistPath = launchdPlistPath(c);
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, "utf8");
  console.log(`생성: ${plistPath}`);

  const domain = launchdDomain();
  // 이미 등록돼 있으면 bootout(실패 무시) 후 재등록.
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${c.label}`], {
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
  console.log(`✅ launchd 등록 완료 (KeepAlive). TIGUCLAW_HOME=${c.homeRaw}`);
  console.log(
    `   상태: npm run daemon:status · 로그: npm run daemon:logs (${path.join(c.logsDir, "daemon-<날짜>.log")})`,
  );
};

const darwinUninstall = (c: Ctx): void => {
  const domain = launchdDomain();
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${c.label}`], {
      stdio: "ignore",
    });
  } catch {
    /* 미등록 — 무시 */
  }
  const plistPath = launchdPlistPath(c);
  rmSync(plistPath, { force: true });
  console.log(`✅ launchd 등록 해제 + plist 제거 (${c.label}).`);
};

const darwinRestart = (c: Ctx): void => {
  const domain = launchdDomain();
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${c.label}`], {
    stdio: "inherit",
  });
  console.log("✅ restarted");
};

const darwinStatus = (c: Ctx): void => {
  const domain = launchdDomain();
  const r = spawnSync("launchctl", ["print", `${domain}/${c.label}`], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) {
    console.log("not loaded");
    return;
  }
  const lines = r.stdout
    .split("\n")
    .filter((l) => /\bstate\s*=|\bpid\s*=/.test(l))
    .map((l) => l.trim());
  console.log(lines.length ? lines.join("\n") : "not loaded");
};

const darwinPrint = (c: Ctx): void => {
  console.log(`# launchd LaunchAgent → ${launchdPlistPath(c)}`);
  console.log(buildLaunchdPlist(c));
  console.log(`# 등록:   launchctl bootstrap ${launchdDomain()} <plist>`);
  console.log(`# 재시작: launchctl kickstart -k ${launchdDomain()}/${c.label}`);
};

// ───────────────────────────── Linux (systemd user) ────────────────────────

const systemdUnitPath = (c: Ctx): string =>
  path.join(os.homedir(), ".config", "systemd", "user", `${c.label}.service`);

const buildSystemdUnit = (c: Ctx): string =>
  `[Unit]
Description=tiguclaw always-on AI assistant daemon (${c.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${c.nodePath} ${c.tsxCli} --env-file=.env ${c.entry}
WorkingDirectory=${c.repoRoot}
Environment="TIGUCLAW_HOME=${c.homeRaw}"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;

const systemctlUser = (args: string[], inherit = true): void => {
  execFileSync("systemctl", ["--user", ...args], {
    stdio: inherit ? "inherit" : "ignore",
  });
};

const linuxInstall = (c: Ctx): void => {
  mkdirSync(c.logsDir, { recursive: true });
  const unitPath = systemdUnitPath(c);
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, buildSystemdUnit(c), "utf8");
  console.log(`생성: ${unitPath}`);

  systemctlUser(["daemon-reload"]);
  systemctlUser(["enable", "--now", c.label]);
  console.log(`✅ systemd user 서비스 등록 완료 (Restart=always). TIGUCLAW_HOME=${c.homeRaw}`);
  const user = os.userInfo().username;
  console.log(
    `   로그인 없이 부팅 가동하려면: loginctl enable-linger ${user}`,
  );
  console.log(
    "   상태: npm run daemon:status · 로그: npm run daemon:logs (journal 도 가능: journalctl --user -u " +
      `${c.label} -f)`,
  );
};

const linuxUninstall = (c: Ctx): void => {
  try {
    systemctlUser(["disable", "--now", c.label]);
  } catch {
    // 미등록/비활성 — 무시.
  }
  rmSync(systemdUnitPath(c), { force: true });
  try {
    systemctlUser(["daemon-reload"]);
  } catch {
    /* 무시 */
  }
  console.log(`✅ systemd user 서비스 해제 + 유닛 제거 (${c.label}).`);
};

const linuxRestart = (c: Ctx): void => {
  systemctlUser(["restart", c.label]);
  console.log("✅ restarted");
};

const linuxStatus = (c: Ctx): void => {
  const active = spawnSync("systemctl", ["--user", "is-active", c.label], {
    encoding: "utf8",
  });
  const state = (active.stdout || active.stderr || "unknown").trim();
  const pidR = spawnSync(
    "systemctl",
    ["--user", "show", "-p", "MainPID", "--value", c.label],
    { encoding: "utf8" },
  );
  const pid = (pidR.stdout || "").trim();
  console.log(`state = ${state}`);
  if (pid && pid !== "0") console.log(`pid = ${pid}`);
};

const linuxPrint = (c: Ctx): void => {
  console.log(`# systemd user unit → ${systemdUnitPath(c)}`);
  console.log(buildSystemdUnit(c));
  console.log("# 등록:   systemctl --user daemon-reload && systemctl --user enable --now " + c.label);
  console.log(`# 재시작: systemctl --user restart ${c.label}`);
  console.log(`# 부팅가동: loginctl enable-linger ${os.userInfo().username}`);
};

// ───────────────────────────── Windows (Task Scheduler) ─────────────────────
// 한계: Task Scheduler 는 launchd 처럼 crash-KeepAlive 가 약하다. ONLOGON 으로
// 로그인 시 가동하되, crash 자동재시작이 꼭 필요하면 NSSM(선택) 또는 WSL2 를 권장.
// cwd·env 보장을 위해 TR 을 cmd 로 감싼다.

const buildWinTr = (c: Ctx): string =>
  `cmd /c cd /d "${c.repoRoot}" && set "TIGUCLAW_HOME=${c.homeRaw}" && "${c.nodePath}" "${c.tsxCli}" --env-file=.env "${c.entry}"`;

const win = (args: string[], inherit = true) =>
  spawnSync("schtasks", args, {
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });

const winInstall = (c: Ctx): void => {
  mkdirSync(c.logsDir, { recursive: true });
  const tr = buildWinTr(c);
  const r = win([
    "/Create",
    "/TN",
    c.label,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
    "/TR",
    tr,
  ]);
  if (r.status !== 0) {
    console.error(`schtasks /Create 실패 (${r.status}). 위 출력 참조.`);
    return;
  }
  console.log(`✅ Task Scheduler 등록 완료 (ONLOGON). TIGUCLAW_HOME=${c.homeRaw}`);
  console.log(
    "   주의: Task Scheduler 는 crash 자동재시작이 약합니다 (로그인 시 가동). " +
      "완전한 KeepAlive 가 필요하면 NSSM(선택) 또는 WSL2 를 권장합니다.",
  );
  console.log("   상태: npm run daemon:status · 로그: npm run daemon:logs");
};

const winUninstall = (c: Ctx): void => {
  const r = win(["/Delete", "/TN", c.label, "/F"]);
  if (r.status !== 0) {
    console.error(`schtasks /Delete 실패 (${r.status}) — 이미 없을 수 있음.`);
    return;
  }
  console.log(`✅ Task Scheduler 작업 제거 (${c.label}).`);
};

const winRestart = (c: Ctx): void => {
  win(["/End", "/TN", c.label]); // 실행 중이 아니면 실패해도 무시.
  const r = win(["/Run", "/TN", c.label]);
  if (r.status !== 0) {
    console.error(`schtasks /Run 실패 (${r.status}).`);
    return;
  }
  console.log("✅ restarted");
};

const winStatus = (c: Ctx): void => {
  const r = win(["/Query", "/TN", c.label], false);
  if (r.status !== 0) {
    console.log("not loaded");
    return;
  }
  console.log((r.stdout || "").trim() || "not loaded");
};

const winPrint = (c: Ctx): void => {
  console.log(`# Task Scheduler task → ${c.label} (ONLOGON, RL LIMITED)`);
  console.log(`# TR:`);
  console.log(buildWinTr(c));
  console.log(
    `# 등록:   schtasks /Create /TN "${c.label}" /SC ONLOGON /RL LIMITED /F /TR "<위 TR>"`,
  );
  console.log(
    `# 재시작: schtasks /End /TN "${c.label}" && schtasks /Run /TN "${c.label}"`,
  );
  console.log(
    "# 한계: crash-KeepAlive 약함 → 필요 시 NSSM(선택) 또는 WSL2 권장.",
  );
};

// ───────────────────────────── logs (전 OS 공통) ────────────────────────────
// 셸 tail 금지 — node 로 마지막 ~40줄 출력 후 follow (watchFile 폴링).

const today = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const tailLogs = (c: Ctx): void => {
  const file = path.join(c.logsDir, `daemon-${today()}.log`);
  if (!existsSync(file)) {
    console.log(`로그 파일이 아직 없습니다: ${file}`);
    console.log(
      "데몬이 한 번도 가동되지 않았거나 날짜가 바뀌었을 수 있어요. " +
        "npm run daemon:status 로 가동 여부를 확인하세요.",
    );
    return;
  }

  const readFrom = (start: number): number => {
    try {
      const buf = readFileSync(file);
      if (buf.length > start) {
        process.stdout.write(buf.subarray(start).toString("utf8"));
      }
      return buf.length;
    } catch {
      return start;
    }
  };

  // 마지막 ~40줄 출력.
  let offset = 0;
  try {
    const buf = readFileSync(file);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const last = lines.slice(Math.max(0, lines.length - 41)).join("\n");
    process.stdout.write(last);
    offset = buf.length;
  } catch {
    offset = 0;
  }

  console.log(`\n── follow: ${file} (Ctrl-C 종료) ──`);
  // fs.watchFile 폴링 — 새 바이트만 append 출력.
  watchFile(file, { interval: 500 }, () => {
    offset = readFrom(offset);
  });
};

// ───────────────────────────── dispatch ─────────────────────────────────────

type Cmd = "install" | "uninstall" | "restart" | "status" | "logs" | "print";

const handlers: Record<
  NodeJS.Platform | "default",
  Partial<Record<Exclude<Cmd, "logs">, (c: Ctx) => void>> | undefined
> = {
  darwin: {
    install: darwinInstall,
    uninstall: darwinUninstall,
    restart: darwinRestart,
    status: darwinStatus,
    print: darwinPrint,
  },
  linux: {
    install: linuxInstall,
    uninstall: linuxUninstall,
    restart: linuxRestart,
    status: linuxStatus,
    print: linuxPrint,
  },
  win32: {
    install: winInstall,
    uninstall: winUninstall,
    restart: winRestart,
    status: winStatus,
    print: winPrint,
  },
  default: undefined,
} as Record<
  NodeJS.Platform | "default",
  Partial<Record<Exclude<Cmd, "logs">, (c: Ctx) => void>> | undefined
>;

const unsupported = (c: Ctx, cmd: string): void => {
  console.log(
    `daemon: 현재 OS(${process.platform})는 자동 ${cmd} 미지원 (darwin/linux/win32 지원).`,
  );
  console.log(
    "프로세스 매니저(pm2/systemd/nohup) 아래에서 다음을 상시 실행하세요:",
  );
  console.log(
    `  TIGUCLAW_HOME=${c.homeRaw} ${c.nodePath} ${c.tsxCli} --env-file=.env ${c.entry}`,
  );
};

export const runDaemonCommand = (cmd: string): void => {
  const c = buildCtx();

  if (cmd === "logs") {
    tailLogs(c);
    return;
  }

  const known: Cmd[] = [
    "install",
    "uninstall",
    "restart",
    "status",
    "print",
  ];
  if (!known.includes(cmd as Cmd)) {
    console.error(
      `daemon: 알 수 없는 서브커맨드 '${cmd}'. ` +
        "사용: install | uninstall | restart | status | logs | print",
    );
    process.exitCode = 1;
    return;
  }

  const table = handlers[process.platform];
  const fn = table?.[cmd as Exclude<Cmd, "logs">];
  if (!fn) {
    unsupported(c, cmd);
    return;
  }
  try {
    fn(c);
  } catch (err) {
    console.error(`daemon ${cmd}: 실패 — ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

// 직접 실행 시 진입 (얇은 install-service 래퍼가 import 해도 자동 실행 X 하도록 가드).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith("daemon.ts");
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(
      "사용: tsx src/scripts/daemon.ts <install|uninstall|restart|status|logs|print>",
    );
    process.exitCode = 1;
  } else {
    runDaemonCommand(cmd);
  }
}
