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
 * 개발 홈 보존: dev 는 `TIGUCLAW_HOME=./tiguclaw-dev TIGUCLAW_RUNTIME=source npm run daemon:install`
 *   (또는 `npm run daemon:install:dev`) 로 실행해야 기존 dev 데이터(./tiguclaw-dev)를 유지하고,
 *   **dev 는 source 로 고정**된다(기본이 built 이므로 dev 는 반드시 source 명시). 미설정 시
 *   prod 기본 = home ~/.tiguclaw · runtime built.
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

// 런타임 모드 (ADR 2026-07-14-built-artifact-production-runtime D2, Amendment 2026-07-14) —
//   명시 env 만 진실. **기본 built**(뒤집힘: 실사용자 "설치=프로덕션" 기대).
//   built(기본): `node dist/src/index.js` — tsx 미경유(선빌드 산출물). 미설정·오타·빈값 전부 built.
//   source: `node <tsx cli> src/index.ts` — dev 전용. 정확히 "source" 일 때만 source 로 낙착.
// mode-persistence(아래 install): 해석된 모드를 유닛 env(TIGUCLAW_RUNTIME=<mode>)에 새겨,
//   실행 데몬·self-update 가 자기 모드를 확실히 알고, 기존 설치가 기본값 변경에 안 휩쓸린다(D4).
type RuntimeMode = "source" | "built";
const runtimeMode = (): RuntimeMode =>
  process.env.TIGUCLAW_RUNTIME?.trim() === "source" ? "source" : "built";

interface Ctx {
  repoRoot: string;
  nodePath: string;
  tsxCli: string;
  entry: string;
  /** built 진입점 = dist/src/index.js (tsconfig.build.json rootDir="." 미러 레이아웃). */
  distEntry: string;
  runtime: RuntimeMode;
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
  const distEntry = path.join(repoRoot, "dist", "src", "index.js");
  const homeRaw =
    process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
  const homeAbs = path.resolve(repoRoot, expandHome(homeRaw));
  const logsDir = path.join(homeAbs, "logs");
  return {
    repoRoot,
    nodePath,
    tsxCli,
    entry,
    distEntry,
    runtime: runtimeMode(),
    homeRaw,
    homeAbs,
    logsDir,
    label: LABEL,
  };
};

/**
 * 데몬 실행 argv — 모드별 분기(D2). 유닛(plist/systemd)·VBS·안내가 전부 이 하나만 쓴다.
 *   source: [node, tsxCli, src/index.ts]  — 종전과 **바이트 동일**(dev 무회귀 보장).
 *   built:  [node, dist/src/index.js]      — tsx 미경유 순수 node.
 * WorkingDirectory·TIGUCLAW_HOME 등 나머지 유닛 필드는 모드 무관 동일.
 */
const execStrings = (c: Ctx): string[] =>
  c.runtime === "built"
    ? [c.nodePath, c.distEntry]
    : [c.nodePath, c.tsxCli, c.entry];

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
${execStrings(c)
  .map((s) => `    <string>${s}</string>`)
  .join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${c.repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TIGUCLAW_HOME</key><string>${c.homeRaw}</string>
    <key>TIGUCLAW_RUNTIME</key><string>${c.runtime}</string>
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
ExecStart=${execStrings(c).join(" ")}
WorkingDirectory=${c.repoRoot}
Environment="TIGUCLAW_HOME=${c.homeRaw}"
Environment="TIGUCLAW_RUNTIME=${c.runtime}"
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

// ───────────────────────────── Windows (HKCU Run 키 + 숨김 VBS) ─────────────
// schtasks /Create 는 환경(그룹정책·ONLOGON 권한)에 따라 Access denied 가 난다.
// HKCU\...\Run 은 *사용자 자기 레지스트리* 라 관리자 권한 없이 항상 쓰기 가능 →
// 로그온 시 자동 가동. 콘솔창이 뜨지 않도록 VBS 로 숨겨 실행. crash 자동재시작은
// 없음(로그온 가동) — 완전한 KeepAlive 가 필요하면 NSSM(선택) 또는 WSL2 권장.

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const winVbsPath = (c: Ctx): string => path.join(c.homeAbs, "win-launch.vbs");

// bridge 포트(.env 우선 → env → 3001). status/restart 의 실행 PID 추정용.
const winPort = (c: Ctx): string => {
  try {
    const m = readFileSync(path.join(c.homeAbs, ".env"), "utf8").match(
      /^HTTP_BRIDGE_PORT=(.*)$/m,
    );
    if (m !== null && m[1]!.trim() !== "") return m[1]!.trim();
  } catch {
    /* .env 없음 — 기본값 */
  }
  return process.env.HTTP_BRIDGE_PORT?.trim() || "3001";
};

// 숨김(0)·비대기(False) 로 데몬을 띄우는 VBS. cwd=repoRoot, TIGUCLAW_HOME 주입.
const buildWinVbs = (c: Ctx): string => {
  const inner =
    `cmd /c cd /d "${c.repoRoot}" && set "TIGUCLAW_HOME=${c.homeRaw}" && ` +
    `set "TIGUCLAW_RUNTIME=${c.runtime}" && ` +
    execStrings(c)
      .map((s) => `"${s}"`)
      .join(" ");
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${inner.replace(/"/g, '""')}", 0, False`,
    "",
  ].join("\r\n");
};

const winReg = (args: string[]) =>
  spawnSync("reg", args, { stdio: "pipe", encoding: "utf8" });

// 지금 즉시 1회 가동(숨김 VBS 실행).
const winLaunch = (c: Ctx) =>
  spawnSync("wscript", [winVbsPath(c)], { stdio: "ignore" });

// bridge 포트를 LISTEN 중인 PID(실행 중 데몬 추정).
const winListeningPids = (c: Ctx): string[] => {
  const ns = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  const pids = new Set<string>();
  const needle = `:${winPort(c)}`;
  for (const l of (ns.stdout ?? "").split(/\r?\n/)) {
    if (l.includes(needle) && /LISTENING/i.test(l)) {
      const pid = l.trim().split(/\s+/).pop();
      if (pid !== undefined && pid !== "0") pids.add(pid);
    }
  }
  return [...pids];
};

const winKillRunning = (c: Ctx): void => {
  for (const pid of winListeningPids(c))
    spawnSync("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore" });
};

const winInstall = (c: Ctx): void => {
  mkdirSync(c.logsDir, { recursive: true });
  writeFileSync(winVbsPath(c), buildWinVbs(c), "utf8");
  // Run 값명 = 라벨(다중 인스턴스 분리). 값 = wscript 가 숨김 VBS 실행.
  const r = winReg([
    "add",
    RUN_KEY,
    "/v",
    c.label,
    "/t",
    "REG_SZ",
    "/d",
    `wscript "${winVbsPath(c)}"`,
    "/f",
  ]);
  if (r.status !== 0) {
    console.error(`레지스트리 Run 등록 실패 (${r.status}).`);
    console.error((r.stderr || r.stdout || "").trim());
    return;
  }
  console.log(
    `✅ 등록 완료 — 로그온 시 자동 가동 (HKCU Run, 관리자 권한 불요). TIGUCLAW_HOME=${c.homeRaw}`,
  );
  console.log(
    "   주의: crash 자동재시작은 없습니다(로그온 가동). 완전한 KeepAlive 는 WSL2/NSSM.",
  );
  winLaunch(c); // 지금 바로 1회 가동.
  console.log(
    "   지금 가동 시작 — 상태: npm run daemon:status · 로그: npm run daemon:logs",
  );
};

const winUninstall = (c: Ctx): void => {
  winKillRunning(c);
  winReg(["delete", RUN_KEY, "/v", c.label, "/f"]);
  rmSync(winVbsPath(c), { force: true });
  console.log(`✅ 등록 해제 (Run 키 + VBS 제거, ${c.label}).`);
};

const winRestart = (c: Ctx): void => {
  winKillRunning(c); // 실행 중이면 종료(bridge 포트 PID).
  winLaunch(c); // 숨김 재가동.
  console.log("✅ restarted");
};

const winStatus = (c: Ctx): void => {
  const reg = winReg(["query", RUN_KEY, "/v", c.label]);
  console.log(`registered (HKCU Run): ${reg.status === 0 ? "yes" : "no"}`);
  const pids = winListeningPids(c);
  if (pids.length > 0) {
    console.log(`running: yes (pid ${pids.join(", ")}, port ${winPort(c)})`);
  } else {
    console.log(
      `running: 불명 (port ${winPort(c)} 미LISTEN — 작업관리자에서 node 확인)`,
    );
  }
};

const winPrint = (c: Ctx): void => {
  console.log(
    "# Windows: HKCU Run 키 + 숨김 VBS 런처 (관리자 권한 불요, 로그온 가동)",
  );
  console.log(`# Run 키: ${RUN_KEY}  값명=${c.label}`);
  console.log(`#   값 = wscript "${winVbsPath(c)}"`);
  console.log(`# VBS: ${winVbsPath(c)}`);
  console.log("# --- VBS 내용 ---");
  console.log(buildWinVbs(c));
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
    `  TIGUCLAW_HOME=${c.homeRaw} ${execStrings(c).join(" ")}`,
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

  // 어떤 런타임 모드로 유닛을 생성/미리보기하는지 명시(D2 — 추론 아님, env 진실).
  if (cmd === "install" || cmd === "print") {
    console.log(
      `# TIGUCLAW_RUNTIME=${c.runtime} — 실행: ${execStrings(c)
        .slice(1)
        .join(" ")} (WorkingDirectory=${c.repoRoot})`,
    );
    if (c.runtime === "built" && !existsSync(c.distEntry)) {
      console.warn(
        `# ⚠ built 모드인데 ${c.distEntry} 가 없습니다 — 먼저 'npm run build:prod' 로 dist 를 만드세요.`,
      );
    }
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
