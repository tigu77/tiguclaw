// @ts-check
// bin/daemon.mjs
/**
 * daemon — tiguclaw 데몬 관리 CLI (크로스플랫폼: macOS / Linux / Windows).
 *
 * ★의존성-프리 라이프사이클 매니저 (ADR 2026-07-15). Node 빌트인만 import
 *   (child_process/fs/os/path/process) → tsx·node_modules 없이도 항상 동작.
 *   깨진 node_modules/tsx 에서도 stop·restart·uninstall·install 이 된다.
 *
 * 단일 진실 소스. 서브커맨드:
 *   install | uninstall | restart | stop | start | status | logs | print | update.
 *   - macOS  → launchd LaunchAgent (KeepAlive, 자동 respawn).
 *   - Linux  → systemd **user** 유닛 (Restart=always).
 *   - Windows→ HKCU Run 키 + 숨김 VBS (ONLOGON; KeepAlive 강도는 약함 — 아래 주석 참조).
 *
 * update = 터미널 직접 자가 갱신(채팅 /update 와 별개). dep-free 라 깨진
 *   node_modules/tsx/typescript 에서도 `npm ci` 로 스스로 복구한다. 순서:
 *   (돌고 있으면) stop → npm ci → build(built 만) → start. 실패 시 prevSha 롤백.
 *
 * 등록(=자동가동 설정 존재) ↔ 실행(=프로세스 생존) 분리 (ADR 2026-07-15 D3):
 *   - stop  = 실행만 중지, 등록 유지 (plist/유닛/Run키 파일 안 지움).
 *   - start = 다시 실행.
 *   - uninstall = 등록까지 제거.
 *
 * 이식형(자가호스트): 하드코딩 경로 0 — *런타임* 값으로 유닛/plist/task 를 생성한다.
 *   node = process.execPath / repo = process.cwd() / home = TIGUCLAW_HOME ?? ~/.tiguclaw.
 *
 * 새 의존성 0 — launchctl/systemctl/reg 는 OS 빌트인. node builtin 만 사용
 *   (child_process/fs/os/path).
 *
 * 사용:
 *   npm run daemon:install              # 등록(상시 가동 + 자동 respawn)
 *   npm run daemon:status               # 상태
 *   npm run daemon:restart              # 재시작
 *   npm run daemon:stop                 # 실행 중지 (등록 유지)
 *   npm run daemon:start                # 재실행 (등록 유지)
 *   npm run daemon:logs                 # 로그 tail+follow
 *   npm run daemon:uninstall            # 등록 해제 + 유닛 제거
 *   npm run daemon:update               # dep-free 자가 갱신 (stop→npm ci→build→start)
 *   node bin/daemon.mjs print           # 설치 안 하고 유닛/명령만 미리보기
 *
 * 개발 홈 보존: dev 는 `TIGUCLAW_HOME=./tiguclaw-dev TIGUCLAW_RUNTIME=source npm run daemon:install`
 *   (또는 `npm run daemon:install:dev`) 로 실행해야 기존 dev 데이터(./tiguclaw-dev)를 유지하고,
 *   **dev 는 source 로 고정**된다(기본이 built 이므로 dev 는 반드시 source 명시). 미설정 시
 *   prod 기본 = home ~/.tiguclaw · runtime built.
 *
 * KeepAlive 강도(솔직히): macOS(launchd KeepAlive) > Linux(systemd Restart=always)
 *   > Windows(HKCU Run ONLOGON — crash 자동재시작 약함). 완전 parity 는 WSL2 권장.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  watchFile,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// 기본 라벨. 한 머신에서 2개 이상 인스턴스(예: prod + 검증용)를 상시 가동하려면
// TIGUCLAW_SERVICE_LABEL 로 고유 라벨을 지정한다 (홈·봇·포트도 함께 분리할 것).
const LABEL = process.env.TIGUCLAW_SERVICE_LABEL?.trim() || "com.tiguclaw.daemon";

/**
 * @param {string} p
 * @returns {string}
 */
const expandHome = (p) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

// 런타임 모드 (ADR 2026-07-14-built-artifact-production-runtime D2, Amendment 2026-07-14) —
//   명시 env 만 진실. **기본 built**(뒤집힘: 실사용자 "설치=프로덕션" 기대).
//   built(기본): `node dist/src/index.js` — tsx 미경유(선빌드 산출물). 미설정·오타·빈값 전부 built.
//   source: `node <tsx cli> src/index.ts` — dev 전용. 정확히 "source" 일 때만 source 로 낙착.
// mode-persistence(아래 install): 해석된 모드를 유닛 env(TIGUCLAW_RUNTIME=<mode>)에 새겨,
//   실행 데몬·self-update 가 자기 모드를 확실히 알고, 기존 설치가 기본값 변경에 안 휩쓸린다(D4).
/** @typedef {"source" | "built"} RuntimeMode */
/** @returns {RuntimeMode} */
const runtimeMode = () =>
  process.env.TIGUCLAW_RUNTIME?.trim() === "source" ? "source" : "built";

/**
 * @typedef {Object} Ctx
 * @property {string} repoRoot
 * @property {string} nodePath
 * @property {string} tsxCli
 * @property {string} entry
 * @property {string} distEntry built 진입점 = dist/src/index.js (tsconfig.build.json rootDir="." 미러 레이아웃).
 * @property {RuntimeMode} runtime
 * @property {string} homeRaw
 * @property {string} homeAbs
 * @property {string} logsDir
 * @property {string} label
 */

/** @returns {Ctx} */
const buildCtx = () => {
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
 * @param {Ctx} c
 * @returns {string[]}
 */
const execStrings = (c) =>
  c.runtime === "built"
    ? [c.nodePath, c.distEntry]
    : [c.nodePath, c.tsxCli, c.entry];

// ───────────────────────────── macOS (launchd) ─────────────────────────────
// install-service.ts 의 plist 내용을 100% 동일하게 이식 (라이브 서비스가 이걸로 돈다).

/**
 * @param {Ctx} c
 * @returns {string}
 */
const buildLaunchdPlist = (c) => {
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

/**
 * @param {Ctx} c
 * @returns {string}
 */
const launchdPlistPath = (c) =>
  path.join(os.homedir(), "Library", "LaunchAgents", `${c.label}.plist`);

/** @returns {string} */
const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`;

/** @param {Ctx} c */
const darwinInstall = (c) => {
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

/** @param {Ctx} c */
const darwinUninstall = (c) => {
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

/** @param {Ctx} c */
const darwinRestart = (c) => {
  const domain = launchdDomain();
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${c.label}`], {
    stdio: "inherit",
  });
  console.log("✅ restarted");
};

// stop = 실행만 중지, plist(등록) 유지 (D3). bootout 은 KeepAlive respawn 도 멈춘다.
/** @param {Ctx} c */
const darwinStop = (c) => {
  const domain = launchdDomain();
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${c.label}`], {
      stdio: "inherit",
    });
  } catch {
    /* 미로드 — 이미 정지 상태로 간주 */
  }
  console.log(`✅ stopped (등록 유지 — 재개: npm run daemon:start). ${c.label}`);
};

// start = plist 재작성 없이 재적재(재실행). 등록 파일은 이미 디스크에 있어야 한다.
/** @param {Ctx} c */
const darwinStart = (c) => {
  const domain = launchdDomain();
  const plistPath = launchdPlistPath(c);
  if (!existsSync(plistPath)) {
    console.error(
      `daemon start: 등록 plist 가 없습니다 (${plistPath}). 먼저 install 하세요.`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain, plistPath], {
      stdio: "inherit",
    });
  } catch {
    // 이미 적재돼 있거나 세션 이슈 — 레거시 load 폴백.
    execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  }
  console.log("✅ started");
};

/** @param {Ctx} c */
const darwinStatus = (c) => {
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

/** @param {Ctx} c */
const darwinPrint = (c) => {
  console.log(`# launchd LaunchAgent → ${launchdPlistPath(c)}`);
  console.log(buildLaunchdPlist(c));
  console.log(`# 등록:   launchctl bootstrap ${launchdDomain()} <plist>`);
  console.log(`# 재시작: launchctl kickstart -k ${launchdDomain()}/${c.label}`);
};

// ───────────────────────────── Linux (systemd user) ────────────────────────

/**
 * @param {Ctx} c
 * @returns {string}
 */
const systemdUnitPath = (c) =>
  path.join(os.homedir(), ".config", "systemd", "user", `${c.label}.service`);

/**
 * @param {Ctx} c
 * @returns {string}
 */
const buildSystemdUnit = (c) =>
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

/**
 * @param {string[]} args
 * @param {boolean} [inherit]
 */
const systemctlUser = (args, inherit = true) => {
  execFileSync("systemctl", ["--user", ...args], {
    stdio: inherit ? "inherit" : "ignore",
  });
};

/** @param {Ctx} c */
const linuxInstall = (c) => {
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

/** @param {Ctx} c */
const linuxUninstall = (c) => {
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

/** @param {Ctx} c */
const linuxRestart = (c) => {
  systemctlUser(["restart", c.label]);
  console.log("✅ restarted");
};

// stop = 실행만 중지, 유닛 enable(등록) 유지 (D3).
/** @param {Ctx} c */
const linuxStop = (c) => {
  systemctlUser(["stop", c.label]);
  console.log(`✅ stopped (등록 유지 — 재개: npm run daemon:start). ${c.label}`);
};

// start = 재실행. 유닛은 이미 디스크에 있어야 한다.
/** @param {Ctx} c */
const linuxStart = (c) => {
  systemctlUser(["start", c.label]);
  console.log("✅ started");
};

/** @param {Ctx} c */
const linuxStatus = (c) => {
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

/** @param {Ctx} c */
const linuxPrint = (c) => {
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
/**
 * @param {Ctx} c
 * @returns {string}
 */
const winVbsPath = (c) => path.join(c.homeAbs, "win-launch.vbs");

// bridge 포트(.env 우선 → env → 3001). status/restart 의 실행 PID 추정용.
/**
 * @param {Ctx} c
 * @returns {string}
 */
const winPort = (c) => {
  try {
    const m = readFileSync(path.join(c.homeAbs, ".env"), "utf8").match(
      /^HTTP_BRIDGE_PORT=(.*)$/m,
    );
    if (m !== null && m[1].trim() !== "") return m[1].trim();
  } catch {
    /* .env 없음 — 기본값 */
  }
  return process.env.HTTP_BRIDGE_PORT?.trim() || "7011";
};

// 숨김(0)·비대기(False) 로 데몬을 띄우는 VBS. cwd=repoRoot, TIGUCLAW_HOME 주입.
/**
 * @param {Ctx} c
 * @returns {string}
 */
const buildWinVbs = (c) => {
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

/** @param {string[]} args */
const winReg = (args) =>
  spawnSync("reg", args, { stdio: "pipe", encoding: "utf8" });

// 지금 즉시 1회 가동(숨김 VBS 실행).
/** @param {Ctx} c */
const winLaunch = (c) =>
  spawnSync("wscript", [winVbsPath(c)], { stdio: "ignore" });

// bridge 포트를 LISTEN 중인 PID(실행 중 데몬 추정).
/**
 * @param {Ctx} c
 * @returns {string[]}
 */
const winListeningPids = (c) => {
  const ns = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  /** @type {Set<string>} */
  const pids = new Set();
  const needle = `:${winPort(c)}`;
  for (const l of (ns.stdout ?? "").split(/\r?\n/)) {
    if (l.includes(needle) && /LISTENING/i.test(l)) {
      const pid = l.trim().split(/\s+/).pop();
      if (pid !== undefined && pid !== "0") pids.add(pid);
    }
  }
  return [...pids];
};

/** @param {Ctx} c */
const winKillRunning = (c) => {
  for (const pid of winListeningPids(c))
    spawnSync("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore" });
};

/** @param {Ctx} c */
const winInstall = (c) => {
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

/** @param {Ctx} c */
const winUninstall = (c) => {
  winKillRunning(c);
  winReg(["delete", RUN_KEY, "/v", c.label, "/f"]);
  rmSync(winVbsPath(c), { force: true });
  console.log(`✅ 등록 해제 (Run 키 + VBS 제거, ${c.label}).`);
};

/** @param {Ctx} c */
const winRestart = (c) => {
  winKillRunning(c); // 실행 중이면 종료(bridge 포트 PID).
  winLaunch(c); // 숨김 재가동.
  console.log("✅ restarted");
};

// stop = 실행만 중지(bridge 포트 PID kill), Run 키·VBS(등록) 유지 (D3).
// 포트 미LISTEN 시 대상 못 찾을 수 있음(기존 status/restart 와 동일 한계 — ADR U3).
/** @param {Ctx} c */
const winStop = (c) => {
  winKillRunning(c);
  console.log(`✅ stopped (등록 유지 — 재개: npm run daemon:start). ${c.label}`);
};

// start = 재실행(숨김 VBS). Run 키·VBS 는 이미 있어야 한다.
/** @param {Ctx} c */
const winStart = (c) => {
  if (!existsSync(winVbsPath(c))) {
    console.error(
      `daemon start: 런처 VBS 가 없습니다 (${winVbsPath(c)}). 먼저 install 하세요.`,
    );
    process.exitCode = 1;
    return;
  }
  winLaunch(c);
  console.log("✅ started");
};

/** @param {Ctx} c */
const winStatus = (c) => {
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

/** @param {Ctx} c */
const winPrint = (c) => {
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

/** @returns {string} */
const today = () => {
  const d = new Date();
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** @param {Ctx} c */
const tailLogs = (c) => {
  const file = path.join(c.logsDir, `daemon-${today()}.log`);
  if (!existsSync(file)) {
    console.log(`로그 파일이 아직 없습니다: ${file}`);
    console.log(
      "데몬이 한 번도 가동되지 않았거나 날짜가 바뀌었을 수 있어요. " +
        "npm run daemon:status 로 가동 여부를 확인하세요.",
    );
    return;
  }

  /**
   * @param {number} start
   * @returns {number}
   */
  const readFrom = (start) => {
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

/** @typedef {"install" | "uninstall" | "restart" | "stop" | "start" | "status" | "logs" | "print" | "update"} Cmd */

/**
 * @type {Record<string, Record<string, (c: Ctx) => void> | undefined>}
 */
const handlers = {
  darwin: {
    install: darwinInstall,
    uninstall: darwinUninstall,
    restart: darwinRestart,
    stop: darwinStop,
    start: darwinStart,
    status: darwinStatus,
    print: darwinPrint,
  },
  linux: {
    install: linuxInstall,
    uninstall: linuxUninstall,
    restart: linuxRestart,
    stop: linuxStop,
    start: linuxStart,
    status: linuxStatus,
    print: linuxPrint,
  },
  win32: {
    install: winInstall,
    uninstall: winUninstall,
    restart: winRestart,
    stop: winStop,
    start: winStart,
    status: winStatus,
    print: winPrint,
  },
  default: undefined,
};

// install 이 실행 중 데몬을 감지하면 EPERM(네이티브 모듈 락) 복구 순서를 안내한다(ADR
//   2026-07-15 D5, 소프트 강제 — 자동 stop/npm 실행은 하지 않는다). best-effort: 감지 실패는
//   조용히 무시(install 을 절대 막지 않음).
/**
 * @param {Ctx} c
 * @returns {boolean}
 */
const isDaemonRunning = (c) => {
  try {
    if (process.platform === "darwin") {
      const r = spawnSync(
        "launchctl",
        ["print", `${launchdDomain()}/${c.label}`],
        { encoding: "utf8" },
      );
      return r.status === 0 && /\bpid\s*=/.test(r.stdout ?? "");
    }
    if (process.platform === "linux") {
      const r = spawnSync("systemctl", ["--user", "is-active", c.label], {
        encoding: "utf8",
      });
      return (r.stdout ?? "").trim() === "active";
    }
    if (process.platform === "win32") {
      return winListeningPids(c).length > 0;
    }
  } catch {
    /* 감지 실패 — 무시 */
  }
  return false;
};

/**
 * 등록(자동가동 설정 파일 존재) 여부 — 실행과 무관(D3). update 후 미가동일 때 install 안내용.
 * @param {Ctx} c
 * @returns {boolean}
 */
const isRegistered = (c) => {
  try {
    if (process.platform === "darwin") return existsSync(launchdPlistPath(c));
    if (process.platform === "linux") return existsSync(systemdUnitPath(c));
    if (process.platform === "win32") return existsSync(winVbsPath(c));
  } catch {
    /* 감지 실패 — 무시 */
  }
  return false;
};

// ───────────────────────────── update (dep-free 자가 갱신) ──────────────────
// `tiguclaw update` — 터미널에서 직접 실행하는 dep-free 자가 갱신(채팅 /update=runSelfUpdate
//   와 별개). 목적: 깨진 node_modules/tsx/typescript 에서도 `npm ci` 로 스스로 복구한다.
//   따라서 node 빌트인만 쓴다(tsx·src/cli.ts·앱 코드 import 0 — daemon.mjs 철학 정합).
// 사용자 확정 순서(회사 인스턴스 EPERM 실사고 대응): 돌고 있는 데몬이 있으면 먼저 stop →
//   npm ci → build → start. 안 그러면 Windows 에서 실행 중 데몬이 better_sqlite3.node 를
//   잠가 npm ci 가 EPERM 으로 또 실패한다. runSelfUpdate(src/core/self-update.ts) 정신 + stop-first.
/** @param {Ctx} c */
const runUpdate = (c) => {
  const isWin = process.platform === "win32";

  // ── A(관측): 위임 실행(telegram /update)은 detached·stdio "ignore" 라 실패 원인이 어디에도
  //   안 남았다(윈도우 "빌드 실패"를 로그로 못 봄). delegated(=notify env 존재)면 이 CLI 의
  //   콘솔 + 모든 하위프로세스(git/npm/tsc) 출력을 <home>/logs/update-<stamp>.log 로 캡처한다.
  //   터미널 직접 실행(env 없음)은 종전대로 stdio 상속(라이브 출력)이라 회귀 0.
  const delegated = !!process.env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL;
  /** @type {number | null} */
  let logFd = null;
  /** @type {string | null} */
  let updateLogPath = null;
  if (delegated) {
    try {
      const logsDir = path.join(c.homeAbs, "logs");
      mkdirSync(logsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      updateLogPath = path.join(logsDir, `update-${stamp}.log`);
      logFd = openSync(updateLogPath, "a");
      /** @type {(orig: (...args: unknown[]) => void, level: string) => (...a: unknown[]) => void} */
      const tee = (orig, level) => (...a) => {
        try {
          writeSync(logFd ?? 2, `[${new Date().toISOString()}] [${level}] ${a.join(" ")}\n`);
        } catch {
          /* 파일 기록 실패해도 콘솔은 낸다 */
        }
        orig(...a);
      };
      console.log = tee(console.log.bind(console), "log");
      console.error = tee(console.error.bind(console), "err");
    } catch {
      logFd = null; /* 로그 셋업 실패해도 업데이트는 계속 */
    }
  }

  // 실패 마커 — 롤백 전에 써서, 재가동한 데몬이 부팅 시 소비해 요청자에게 "❌ 실패" 통지.
  //   notify env 없으면(터미널 직접) 안 씀(오탐 0). UPDATE_FAILED_MARKER=".update-failed" 리터럴
  //   (dep-free 라 import 불가 — self-update.ts 상수와 동기).
  /** @type {(stage: string, detail: string) => void} */
  const writeFailedMarker = (stage, detail) => {
    if (!delegated) return;
    try {
      writeFileSync(
        path.join(c.homeAbs, ".update-failed"),
        `${JSON.stringify(
          {
            stage,
            detail: String(detail ?? "").slice(0, 500),
            logPath: updateLogPath,
            from: prevSha?.slice(0, 7) ?? null,
            ts: Date.now(),
            notify: {
              channel: process.env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL,
              target: process.env.TIGUCLAW_UPDATE_NOTIFY_TARGET || null,
            },
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* 마커 best-effort */
    }
  };

  // spawnSync 래퍼 — 터미널 직접 실행은 stdio 상속(라이브 출력), 위임 실행은 logFd 로 리다이렉트
  //   (하위프로세스 출력까지 로그 파일에). cwd=repoRoot. npm 은 Windows 에서 npm.cmd(배치)라
  //   shell 경유 필요; 인자는 전부 고정 상수라 인젝션 0(동적값은 rollback 의 git reset prevSha
  //   뿐 — git 은 git.exe 라 무shell). exit≠0 = 실패로 판정(self-update.ts:138-143 과 동일 근거).
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{shell?: boolean}} [opts]
   * @returns {number}
   */
  const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      cwd: c.repoRoot,
      stdio: logFd !== null ? ["ignore", logFd, logFd] : "inherit",
      shell: opts.shell ?? false,
    });
    return r.status ?? 1;
  };

  // ── 단계 1: 배너 ────────────────────────────────────────────────────────────
  console.log("── tiguclaw update (dep-free) ──");
  console.log(`   runtime=${c.runtime} · home=${c.homeRaw} · label=${c.label}`);
  console.log(
    "   힌트: 설치 때와 같은 env(TIGUCLAW_HOME/TIGUCLAW_RUNTIME/TIGUCLAW_SERVICE_LABEL)로",
  );
  console.log("         실행해야 올바른 인스턴스를 갱신합니다.");

  // ── 단계 2: prevSha capture (롤백 앵커) ──────────────────────────────────────
  const prev = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: c.repoRoot,
    encoding: "utf8",
  });
  if (prev.status !== 0 || !(prev.stdout ?? "").trim()) {
    console.error("update: git 저장소가 아니거나 git 이 없습니다 — 갱신 불가.");
    process.exitCode = 1;
    return;
  }
  const prevSha = prev.stdout.trim();

  // ── 단계 3: lock 드리프트 선폐기(생성물 한 파일만) ──────────────────────────
  // package-lock.json 은 npm 이 재생성하는 *생성물*이라 플랫폼·npm 버전차로 로컬이 쉽게
  //   더러워지고("local changes to package-lock.json would be overwritten by merge") 그게
  //   ff-only pull 을 막아 갱신이 영영 깨진다(Windows 실사고, self-update.ts:346-358 동일 근거).
  //   생성물 한 파일만 origin 기준으로 되돌리는 건 안전 — 사용자 의미 편집이 아니다.
  //   ★자동 폐기는 이 파일 하나뿐. 다른 트래킹 파일의 미커밋 변경은 절대 건드리지 않으므로
  //   여전히 ff-only 가 정직 실패한다(암묵 파괴 0 — §1·O1). best-effort: 없거나 clean 이면 무시.
  run("git", ["checkout", "--", "package-lock.json"]);

  // ── 단계 4: git pull --ff-only ──────────────────────────────────────────────
  if (run("git", ["pull", "--ff-only"]) !== 0) {
    // 실패(로컬 미커밋 진짜 변경·충돌·detached) → 정직 실패. pull 은 원자적이라 작업트리를
    //   보존(부분 적용 0) → 롤백 불요. 자동 stash/merge 는 파괴적·암묵이라 안 함(§1·O1).
    console.error(
      "update: 로컬 미커밋 변경/충돌로 pull 실패 — 수동 확인 필요 (git status).",
    );
    writeFailedMarker("git pull", "로컬 미커밋 변경/충돌로 pull 실패");
    process.exitCode = 1;
    return;
  }
  const next = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: c.repoRoot,
    encoding: "utf8",
  });
  const newSha = next.status === 0 ? (next.stdout ?? "").trim() : prevSha;
  if (newSha === prevSha) {
    // ★early-exit 안 함 — update 의 흔한 목적이 깨진 node_modules 복구라 코드가 안 바뀌어도
    //   npm ci·build 는 돌려야 한다.
    console.log("   코드 변경 없음 — 의존성·빌드만 갱신합니다.");
  }

  const table = handlers[process.platform];
  const wasRunning = isDaemonRunning(c);

  // rollback 헬퍼(self-update.ts:401-424 미러) — reset --hard prevSha → npm ci(best-effort)
  //   → (돌고 있었으면) start. 데몬은 반드시 원복 가동. 예외는 삼켜 데몬 생존.
  // ★§1 파괴 0 논증: 이 reset --hard 는 pull 성공(HEAD 이동) *이후*에만 도는데, pull 이
  //   성공했다는 건 그 시점 작업트리에 사용자 미커밋 변경이 없었다는 뜻이다(있었으면 위
  //   ff-only 가 실패했다 → 여기 도달 못 함). 따라서 prevSha 로 되돌려도 지울 사용자 편집이
  //   애초에 없다 = 파괴 0.
  const rollback = () => {
    try {
      run("git", ["reset", "--hard", prevSha]);
      run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { shell: isWin });
      if (wasRunning) table?.start?.(c);
    } catch {
      /* 롤백 자체 실패도 삼켜 데몬 생존(best-effort) */
    }
  };

  // ── 단계 5: (돌고 있으면) 데몬 정지 — npm ci 전에 네이티브 모듈 락 해제(EPERM 방지) ──
  if (wasRunning) {
    console.log("   npm ci 를 위해 데몬을 정지합니다 (짧은 다운타임).");
    table?.stop?.(c);
  }

  // ── 단계 6: npm ci ──────────────────────────────────────────────────────────
  // --include=dev 필수: built 인스턴스는 tsc(typescript, devDependency)로 재빌드하는데,
  //   데몬 env 에 NODE_ENV=production(init.ts 가 .env 에 기록) 이 실려 이 CLI 로 상속되면
  //   기본 npm ci 가 devDeps 를 스킵 → tsc 미설치 → build:prod 가 "'tsc' 없음"으로 실패한다
  //   (Windows /update 실사고). self-update.ts 롤백이 이미 쓰는 --include=dev 와 정합.
  if (run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { shell: isWin }) !== 0) {
    console.error("update: npm ci 실패 — 롤백합니다.");
    writeFailedMarker("npm ci", "npm ci 실패(의존성 설치)");
    rollback();
    console.error("update: 롤백 완료, 데몬 원복. exit 1.");
    process.exitCode = 1;
    return;
  }

  // ── 단계 7: 빌드(built 런타임만) ───────────────────────────────────────────
  if (c.runtime === "built") {
    if (
      run("npm", ["run", "build:prod"], { shell: isWin }) !== 0 ||
      !existsSync(c.distEntry)
    ) {
      console.error("update: 빌드 실패(진입점 미생성) — 롤백합니다.");
      writeFailedMarker("build", "build:prod 비정상 종료 또는 진입점(dist/src/index.js) 미생성");
      rollback();
      console.error("update: 롤백 완료, 데몬 원복. exit 1.");
      process.exitCode = 1;
      return;
    }
  } else {
    // source 런타임은 tsx 로 src 를 직접 구동 — dist 불요(daemon.mjs 철학 정합).
    console.log("   source 런타임 — 빌드 건너뜀 (tsx 로 src 직접 구동).");
  }

  // ── 단계 7b: 완료 통지 마커 (위임 경로) ─────────────────────────────────────
  // telegram /update 가 이 CLI 를 detached 로 띄웠을 때(Windows+built), 재시작 데몬이 부팅 시
  //   소비해 "✅ 업데이트 완료" 를 요청자에게 통지하도록 마커를 쓴다. notify 좌표는 데몬이
  //   env 2키로 전달. 파일명 ".update-complete" 는 self-update.ts:28 UPDATE_COMPLETE_MARKER 와
  //   동기(dep-free 라 import 불가 → 리터럴). build 성공 후·start 전에만 쓰므로 실패/rollback
  //   경로는 여기 도달 못 함 = 오탐 0. env 없으면(터미널 직접 실행) 안 씀.
  const notifyChannel = process.env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL;
  if (notifyChannel) {
    try {
      writeFileSync(
        path.join(c.homeAbs, ".update-complete"),
        `${JSON.stringify(
          {
            from: prevSha.slice(0, 7),
            to: newSha.slice(0, 7),
            changedFiles: 0,
            ts: Date.now(),
            notify: {
              channel: notifyChannel,
              target: process.env.TIGUCLAW_UPDATE_NOTIFY_TARGET || null,
            },
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* 통지 마커 best-effort — 업데이트는 계속 */
    }
  }

  // ── 단계 8: 재가동 ──────────────────────────────────────────────────────────
  if (wasRunning) {
    table?.start?.(c); // 5에서 stop 했으니 start(restart 아님).
  } else if (!isRegistered(c)) {
    console.log("   데몬 미등록 — 'tiguclaw install' 후 가동하세요.");
  } else {
    console.log("   데몬이 실행 중이 아니었습니다 — 'tiguclaw start' 로 가동하세요.");
  }

  // ── 단계 9: 성공 요약 ───────────────────────────────────────────────────────
  console.log(
    `✅ update 완료: ${prevSha.slice(0, 7)} → ${newSha.slice(0, 7)} ` +
      `(runtime=${c.runtime}). 가동 재개.`,
  );
};

/**
 * @param {Ctx} c
 * @param {string} cmd
 */
const unsupported = (c, cmd) => {
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

/**
 * @param {string} cmd
 */
export const runDaemonCommand = (cmd) => {
  const c = buildCtx();

  if (cmd === "logs") {
    tailLogs(c);
    return;
  }

  // update = dep-free 자가 갱신(stop→npm ci→build→start). known-check *앞*에 분기 — logs 처럼
  //   OS handlers 테이블과 무관한 자체 루틴이다.
  if (cmd === "update") {
    runUpdate(c);
    return;
  }

  /** @type {Cmd[]} */
  const known = [
    "install",
    "uninstall",
    "restart",
    "stop",
    "start",
    "status",
    "print",
  ];
  if (!known.includes(/** @type {Cmd} */ (cmd))) {
    console.error(
      `daemon: 알 수 없는 서브커맨드 '${cmd}'. ` +
        "사용: install | uninstall | restart | stop | start | status | logs | print | update",
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

  // EPERM 복구 안내(D5): install 중 데몬이 살아 있으면 네이티브 모듈(better_sqlite3.node)이
  //   락돼 `npm ci` 가 EPERM 날 수 있다. 자동 stop/npm 은 안 함 — 순서만 안내(소프트 강제).
  if (cmd === "install" && isDaemonRunning(c)) {
    console.warn(
      "# ⚠ 데몬이 실행 중입니다. 의존성 재설치(npm ci)가 필요하다면 EPERM(파일 락)을 피하기 위해",
    );
    console.warn(
      "#   먼저 `tiguclaw stop` (또는 npm run daemon:stop) → `npm ci` → `tiguclaw start`/install 순서를 권장합니다.",
    );
  }

  const table = handlers[process.platform];
  const fn = table?.[cmd];
  if (!fn) {
    unsupported(c, cmd);
    return;
  }
  try {
    fn(c);
  } catch (err) {
    console.error(`daemon ${cmd}: 실패 — ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
};

// 직접 실행 시 진입 (얇은 install-service 래퍼가 import 해도 자동 실행 X 하도록 가드).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith("daemon.mjs");
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(
      "사용: node bin/daemon.mjs <install|uninstall|restart|stop|start|status|logs|print|update>",
    );
    process.exitCode = 1;
  } else {
    runDaemonCommand(cmd);
  }
}
