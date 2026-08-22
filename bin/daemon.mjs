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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
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
  // ★**bootout 이 끝나기를 기다린다** (2026-08-22, install 검증을 붙이자마자 첫 실행에 잡힘).
  //  `bootout` 은 비동기다 — 곧바로 `bootstrap` 하면 옛 서비스가 아직 정리 중이라
  //  `Bootstrap failed: 5: Input/output error` 가 나고, 레거시 `load -w` 폴백도 같은 이유로
  //  실패한다. 결과는 **부팅되지 않은 채 등록도 사라진 상태**인데, 종전엔 그 위에
  //  `✅ launchd 등록 완료` 를 찍었다(install 이 확인을 안 했으므로). 실측: 즉시 bootstrap =
  //  실패, ~1분 뒤 같은 명령 = 성공. 고정 sleep 이 아니라 **사라졌는지 물어서** 기다린다.
  {
    const until = Date.now() + 10_000;
    for (;;) {
      const still = spawnSync("launchctl", ["print", `${domain}/${c.label}`], {
        stdio: "ignore",
      });
      if (still.status !== 0) break; // 정리 완료.
      if (Date.now() >= until) {
        console.warn(
          `# ⚠ bootout 이 10초 안에 안 끝났습니다 (${domain}/${c.label}) — 그대로 bootstrap 을 시도합니다.`,
        );
        break;
      }
      sleepSync(300);
    }
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain, plistPath], {
      stdio: "inherit",
    });
  } catch {
    // 일부 macOS/세션에서 bootstrap 실패 시 레거시 load 폴백.
    execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  }
  console.log(`launchd 등록 (KeepAlive). TIGUCLAW_HOME=${c.homeRaw}`);
  // ★install 도 **확인 후** 말한다 (2026-08-22). 종전엔 등록만 하고 `✅ 등록 완료` 를
  //  찍어, 데몬이 안 떠도 설치가 성공으로 보였다 — start/restart 에서 93분 먹통을 만든
  //  바로 그 거짓 성공이 install 에는 그대로 남아 있었다(세 플랫폼 전부).
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  확인: launchctl print ${domain}/${c.label}\n` +
      `  로그: ${path.join(c.logsDir, "daemon-<날짜>.log")}`,
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
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge, 20000, 1500),
    "restarted",
    `  확인: launchctl print ${domain}/${c.label}\n  로그: ${path.join(c.homeAbs, "logs")}`,
  );
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
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "started",
    `  확인: launchctl print ${launchdDomain()}/${c.label}\n  로그: ${path.join(c.homeAbs, "logs")}`,
  );
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
  console.log(`systemd user 서비스 등록 (Restart=always). TIGUCLAW_HOME=${c.homeRaw}`);
  const user = os.userInfo().username;
  console.log(
    `   로그인 없이 부팅 가동하려면: loginctl enable-linger ${user}`,
  );
  // ★install 도 확인 후 말한다 (2026-08-22) — darwinInstall 주석 참조.
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  확인: systemctl --user status ${c.label}\n` +
      `  로그: npm run daemon:logs (journalctl --user -u ${c.label} -f)`,
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
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge, 20000, 1500),
    "restarted",
    `  확인: systemctl --user status ${c.label}\n  로그: ${path.join(c.homeAbs, "logs")}`,
  );
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
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "started",
    `  확인: systemctl --user status ${c.label}\n  로그: ${path.join(c.homeAbs, "logs")}`,
  );
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
 * ★"떴다" 의 **증거는 브리지 포트가 LISTEN 하는 것**이다 (2026-08-15).
 *
 * 사고: 윈도우 돌쇠가 `tiguclaw update` 후 **93분간 죽어 있었다**. 그런데 CLI 는
 * `✅ started` 를 찍었다 — `winStart` 가 `wscript` 로 VBS 를 쏘고 **결과를 안 봤기**
 * 때문이다(`spawnSync(..., {stdio:"ignore"})` 라 실패도 조용하다).
 *
 * ★증거의 등급: `wscript` 실행 성공 = 런처를 **쏜 것**뿐 · PID 존재 = 떴다가 죽는 중일 수
 *  있음 · **포트 LISTEN = 실제로 서비스 중**. 그래서 포트로 판정한다.
 *
 * ★윈도우에서 특히 치명적인 이유: 등록이 `HKCU Run`(로그온 시 1회)이라 **supervisor 가
 *  없다.** 맥 launchd `KeepAlive`·리눅스 systemd `Restart=` 는 죽으면 되살리지만 윈도우는
 *  한 번 죽으면 그대로다 — 거짓 성공이 곧 무기한 먹통이 된다(회사 인스턴스는 원격 확인도
 *  안 된다).
 *
 * 동기 스크립트라 `net` 비동기를 못 쓴다. dep-free 원칙(깨진 node_modules 에서도 도는 것)
 * 도 지켜야 하므로 **빌트인만** 쓴다: `Atomics.wait` 로 자고, 플랫폼 명령으로 포트를 본다.
 * @param {number} ms
 */
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer 불가 환경 — 확인만 못 할 뿐 기동은 영향 없음 */
  }
};

/**
 * 포트가 LISTEN 할 때까지 기다린다. 뜨면 PID 목록, 시한 내 못 뜨면 빈 배열.
 * @param {Ctx} c
 * @param {(c: Ctx) => string[]} probe
 * @param {number} timeoutMs
 * @returns {string[]}
 */
/**
 * 포트를 잡은 게 **우리 데몬인지** 확인한다 — `/health` 는 인증 밖이라 빌트인 http 로 물어본다.
 *
 * ★적대 검토 P7: 포트 LISTEN 만으로는 "우리 데몬" 이 아니다. 실증 — 아무 http 서버가 그
 *  포트를 잡아도 `waitForListening` 이 성공으로 읽었다(mac/linux 는 `netstat -an` 이라 PID 도
 *  없다). 증거 등급을 정해 둔 주석이 정작 mac/linux 에선 성립하지 않았다.
 * ★한계는 정직하게 적는다: **옛 데몬도 `/health` 에 답한다.** 그래서 이건 "엉뚱한 프로세스"
 *  만 걸러내고, 재시작의 "죽어가는 소켓" 은 아래 `settleMs` 가 맡는다.
 * @param {Ctx} c
 * @returns {boolean}
 */
const healthSaysOurs = (c) => {
  const port = winPort(c);
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `const http=require("http");const q=http.get({host:"127.0.0.1",port:${port},path:"/health",timeout:1500},(s)=>{let b="";s.on("data",(d)=>{b+=d});s.on("end",()=>{process.stdout.write(b.slice(0,200))})});q.on("error",()=>process.exit(1));q.on("timeout",()=>{q.destroy();process.exit(1)});`,
    ],
    { encoding: "utf8" },
  );
  return r.status === 0 && /"ok"\s*:\s*true/.test(r.stdout ?? "");
};

/**
 * @param {Ctx} c
 * @param {(c: Ctx) => string[]} probe
 * @param {number} [timeoutMs]
 * @param {number} [settleMs] 첫 프로브 전 대기 — **재시작 전용**. 옛 데몬이 graceful 종료
 *  중 수백 ms 동안 포트를 물고 있으면 그 소켓으로 ✅ 가 찍힌다(적대 검토 P7). 기동(start)은
 *  옛 프로세스가 없으므로 0.
 */
const waitForListening = (c, probe, timeoutMs = 20000, settleMs = 0) => {
  if (settleMs > 0) sleepSync(settleMs);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const pids = probe(c);
    // 포트가 잡혔으면 **우리 것인지** 한 번 더 묻는다(엉뚱한 프로세스 배제).
    if (pids.length > 0 && healthSaysOurs(c)) return pids;
    if (Date.now() >= until) return [];
    sleepSync(700);
  }
};

/**
 * 기동 결과를 **정직하게** 보고한다. 못 떴으면 ✅ 를 찍지 않고 exit 1.
 * @param {Ctx} c
 * @param {string[]} pids
 * @param {string} verb
 * @param {string} hint
 */
const reportLaunch = (c, pids, verb, hint) => {
  if (pids.length > 0) {
    console.log(pids[0] === "listening" ? `✅ ${verb}` : `✅ ${verb} (pid ${pids.join(", ")})`);
    return;
  }
  console.error(
    `🔴 ${verb} 실패 — 기동 명령은 보냈지만 브리지 포트가 안 열렸습니다. ` +
      `데몬이 안 떴거나 뜨자마자 죽었습니다.\n${hint}`,
  );
  process.exitCode = 1;
};

/**
 * @param {Ctx} c
 * @returns {string}
 */
const winVbsPath = (c) => path.join(c.homeAbs, "win-launch.vbs");

/**
 * 브리지 포트를 LISTEN 하는 PID(윈도우) 또는 표식(맥·리눅스).
 * ★`netstat` 는 세 OS 에 다 있고 dep-free 다. 맥·리눅스는 PID 를 안 주는 형식이라
 *  "떴다" 표식(`listening`)만 돌려준다 — 판정에 필요한 건 그것뿐이다.
 * @param {Ctx} c
 * @returns {string[]}
 */
const listeningOnBridge = (c) => {
  const port = winPort(c); // .env 우선 — 플랫폼 무관 동일 규칙.
  const r = spawnSync("netstat", process.platform === "win32" ? ["-ano"] : ["-an"], {
    encoding: "utf8",
  });
  const out = r.stdout ?? "";
  /** @type {Set<string>} */
  const pids = new Set();
  // ★주소 구분자가 OS 마다 다르다 — macOS/BSD 는 `127.0.0.1.<포트>`(점), 리눅스·윈도우는
  //  `127.0.0.1:<포트>`(콜론). 콜론만 보다가 맥에서 **살아 있는 데몬을 못 찾아** 거짓 실패를
  //  냈다(이 헬퍼를 넣자마자 첫 시험에서 걸렸다). 뒤 경계도 본다 — 짧은 포트가 긴 포트를
  //  맞히면 안 된다.
  const portRe = new RegExp(`[.:]${port}(?:\\s|$)`);
  for (const l of out.split(/\r?\n/)) {
    if (!portRe.test(l)) continue;
    if (!/LISTEN/i.test(l)) continue;
    if (process.platform === "win32") {
      const pid = l.trim().split(/\s+/).pop();
      if (pid !== undefined && pid !== "0") pids.add(pid);
    } else {
      pids.add("listening");
    }
  }
  return [...pids];
};


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

// ★숨김 VBS 런처(`buildWinVbs`)와 그 실행기(`winLaunch`)는 **삭제됐다** (2026-08-22).
//  존재 이유가 둘이었는데 둘 다 사라졌다: (1) 콘솔 창 숨김 — 예약작업이 `node` 를 직접
//  띄우면 창이 안 뜬다(그 기계에서 최상위 창 전수 열거 0개로 확인). (2) 환경변수 주입 —
//  이제 `supervise --home/--runtime` 인자로 넘긴다. 남은 `winVbsPath` 는 옛 설치의
//  잔재를 지우는 데만 쓴다(마이그레이션).

/** @param {string[]} args */
const winReg = (args) =>
  spawnSync("reg", args, { stdio: "pipe", encoding: "utf8" });

/**
 * KeepAlive 예약작업명 — 인스턴스 라벨에서 파생(한 기계의 여러 인스턴스가 안 겹친다).
 * @param {Ctx} c
 * @returns {string}
 */
const winTaskName = (c) => c.label;

/**
 * PowerShell 스크립트를 **인용 지옥 없이** 실행한다 — `-EncodedCommand`(UTF-16LE base64).
 * ★셸을 안 거치므로 경로의 공백·따옴표·`&` 가 인자를 깨뜨리지 않는다. 종전 윈도우 코드가
 *  겪은 사고 다수가 이 계열이었다(액션 문자열의 `&`·중첩 따옴표).
 * @param {string} script
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
const winPs = (script) => {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8" },
  );
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
};

/** PowerShell 작은따옴표 문자열 리터럴로 안전하게 감싼다(내부 `'` 는 `''`). */
const psq = (/** @type {string} */ s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * KeepAlive 예약작업 등록 스크립트.
 *
 * ★설계 근거 — 전부 그 기계에서 **실행으로 확인**했다(2026-08-22):
 *  - 사용자 수준 등록이 관리자 권한 없이 된다(`RunLevel=Limited`). 종전 주석은
 *    "schtasks 는 Access denied 가 난다" 며 HKCU Run 을 골랐는데, 그 전제가 틀렸다.
 *  - 1분 반복 트리거가 무기한 유지된다(`Interval=PT1M`, Duration 무제한).
 *  - `MultipleInstances=IgnoreNew` 가 중복 기동을 막는다 — 작업 인스턴스가 감독자
 *    프로세스만큼 살기 때문이다(2분간 반복 발화, 기동 1회).
 *  - ★**콘솔 창은 `-LogonType S4U` 로 없앤다** (2026-08-22, 사용자 신고로 정정).
 *    처음엔 `Interactive` 로 두고 "액션이 node 직접 실행이면 창이 안 뜬다(최상위 창 전수
 *    열거 0개)" 고 적었는데 **거짓이었다.** SSH 세션에서 `EnumWindows` 를 돌려 확인했는데,
 *    그 자리에선 사용자 데스크톱의 창을 **원리적으로 볼 수 없다**(윈도우 스테이션이 다르다).
 *    실제로는 검은 터미널이 계속 떠 있었고 사용자가 보고 알려줬다.
 *    S4U = 대화형 로그온 없이(암호 불요) 실행 → **세션 0** 이라 창 자체가 생기지 않는다.
 *    ★판정은 `Win32_Process.SessionId` 로 한다 — SSH 에서도 보이고 거짓말하지 않는다
 *    (Interactive = 사용자 세션 번호 · S4U = 0). "안 보인다" 를 "없다" 로 읽지 마라.
 *  - Defender 가 이 등록을 막지 않는다. 오탐의 원인은 예약작업 자체가 아니라
 *    **런타임 생성 + `ping` 지연 + 숨김 스크립트** 조합이었다.
 *
 * 로그온 트리거 + 반복 트리거 둘 다 단다: 로그온하면 뜨고, 감독자까지 죽어도 1분 안에
 *  잡힌다. `-ExecutionTimeLimit 0` 이 없으면 기본 3일 후 작업이 강제 종료된다.
 * @param {Ctx} c
 * @returns {string}
 */
const buildWinTaskScript = (c) => {
  const args = [
    path.join(c.repoRoot, "bin", "daemon.mjs"),
    "supervise",
    "--home",
    c.homeRaw,
    "--runtime",
    c.runtime,
  ]
    // 작업 액션의 인자 문자열 — 공백 있는 경로를 위해 각 인자를 큰따옴표로 감싼다.
    .map((a) => `"${a}"`)
    .join(" ");
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$action = New-ScheduledTaskAction -Execute ${psq(c.nodePath)} -Argument ${psq(args)} -WorkingDirectory ${psq(c.repoRoot)}`,
    `$atLogon = New-ScheduledTaskTrigger -AtLogOn -User ${psq(process.env.USERNAME ?? os.userInfo().username)}`,
    // 반복 트리거 = 바닥 그물. StartBoundary 를 과거로 둬서 등록 즉시 유효해진다.
    `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes 1)`,
    `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    // ★S4U — 창 없이 세션 0 에서 돈다(위 주석). `Interactive` 면 검은 터미널이 떠 있는다.
    `$principal = New-ScheduledTaskPrincipal -UserId ${psq(process.env.USERNAME ?? os.userInfo().username)} -LogonType S4U -RunLevel Limited`,
    `Register-ScheduledTask -TaskName ${psq(winTaskName(c))} -Action $action -Trigger $atLogon,$repeat -Settings $settings -Principal $principal -Force | Out-Null`,
    `'TASK_REGISTERED'`,
  ].join("\n");
};

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

/**
 * 명령줄로 이 인스턴스의 데몬 PID 를 찾는다 — **포트 탐지의 보완**.
 *
 * ★왜 필요한가 (2026-08-06, 두 기계에서 각각 실측): 포트로만 찾으면 (a) 다른 앱이 그 포트를
 *  선점했거나(실제로 Steam 이 3000 을 가져갔다) (b) 데몬이 반쯤 죽어 LISTEN 을 놓았을 때
 *  **살아 있는 프로세스를 못 찾는다**. 그런데도 stop/restart 는 `✅` 를 찍었다 — 회사 PC 에선
 *  좀비 3개가 남아 `npm ci` 가 EPERM 으로 계속 실패했고, 집 PC 에선 restart 가 아무것도 안 한
 *  채 성공을 보고했다. 포트는 데몬의 *증상*이지 정체가 아니다.
 *
 * TIGUCLAW_HOME 으로 인스턴스를 가른다 — 한 기계에 여러 인스턴스가 있어도 남의 것을 안 죽인다.
 * @param {Ctx} c
 * @returns {string[]}
 */
const winDaemonPids = (c) => {
  const q = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation",
    ],
    { encoding: "utf8" },
  );
  /** @type {Set<string>} */
  const pids = new Set();
  const home = String(c.homeRaw ?? "").toLowerCase();
  for (const l of (q.stdout ?? "").split(/\r?\n/)) {
    const low = l.toLowerCase();
    if (!low.includes("index.js")) continue;
    // 이 인스턴스인지 — 홈 경로가 명령줄(VBS 가 set 으로 박는다)에 있는지로 가른다.
    if (home !== "" && !low.includes(home)) continue;
    const m = /^"?(\d+)"?,/.exec(l.trim());
    if (m) pids.add(m[1]);
  }
  return [...pids];
};

/**
 * 실행 중 데몬 종료 — 포트 PID + 명령줄 PID **합집합**. 반환값 = 죽인 뒤에도 남은 PID.
 * ★호출부는 이 반환을 보고 보고해야 한다(빈 배열이어야 `✅`). 종전엔 결과를 안 보고
 *  무조건 성공을 찍었다.
 * @param {Ctx} c
 * @returns {string[]}
 */
const winKillRunning = (c) => {
  const targets = new Set([...winListeningPids(c), ...winDaemonPids(c)]);
  for (const pid of targets)
    spawnSync("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore" });
  if (targets.size === 0) return [];
  // 종료는 비동기다 — 잠깐 기다렸다가 실제로 사라졌는지 다시 센다(거짓 성공 차단).
  spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 900"], {
    stdio: "ignore",
  });
  const still = new Set([...winListeningPids(c), ...winDaemonPids(c)]);
  return [...still].filter((p) => targets.has(p));
};

/**
 * 옛 방식(HKCU Run + 숨김 VBS) 잔재 제거 — **멱등**.
 * ★install 이 반드시 먼저 불러야 한다: 안 지우면 로그온 시 Run 키와 예약작업이 **둘 다**
 *  데몬을 띄워 인스턴스가 두 개 뜬다(같은 SQLite·같은 포트 = 즉시 사고). 마이그레이션에서
 *  가장 위험한 지점이라 조용히 처리하지 않고 무엇을 지웠는지 찍는다.
 * @param {Ctx} c
 */
const winRemoveLegacyAutostart = (c) => {
  const q = winReg(["query", RUN_KEY, "/v", c.label]);
  if (q.status === 0) {
    winReg(["delete", RUN_KEY, "/v", c.label, "/f"]);
    console.log(`   옛 자동시작 제거 — HKCU Run\\${c.label} (예약작업으로 대체)`);
  }
  if (existsSync(winVbsPath(c))) {
    rmSync(winVbsPath(c), { force: true });
    console.log(`   옛 런처 제거 — ${winVbsPath(c)} (창 숨김이 더는 필요 없습니다)`);
  }
  // 옛 self-restart 1회성 작업(Defender 가 악성으로 본 그것)도 남아 있으면 정리.
  spawnSync("schtasks", ["/delete", "/tn", `${c.label}-selfrestart`, "/f"], {
    stdio: "ignore",
  });
};

/**
 * 예약작업 등록을 **코드가 말하는 모양으로 수렴**시킨다 — 멱등(`-Force`).
 *
 * ★왜 "없으면 만든다" 로는 부족한가 (2026-08-22, 두 번째 같은 실수): 등록 내용은 Task
 *  Scheduler 에 저장돼 있어서 **코드를 고쳐도 안 바뀐다.** `/update` 는 install 을 다시
 *  돌리지 않고(stop→ci→build→start), start 가 *부재*만 고치면 **낡은 등록은 영원히 남는다.**
 *  실제로 그래서 터미널이 계속 떴다 — 부재는 고쳤는데 **낡음**은 안 봤다.
 *  ★설정을 하나씩 비교하지 않는다(그건 손으로 관리하는 목록이라 반드시 늙는다). 그냥 매번
 *   다시 등록해 **정의점 하나**로 수렴시킨다.
 *
 * 견고성: 재등록이 실패해도 **기존 등록이 있으면 진행**한다(경고만). 일시 실패로 이미 되던
 *  기동을 막지 않는다 — 견고함 > 단순함.
 * @param {Ctx} c
 * @returns {boolean} 진행해도 되는가
 */
const winEnsureTask = (c) => {
  winRemoveLegacyAutostart(c);
  const r = winPs(buildWinTaskScript(c));
  if (r.status === 0 && r.stdout.includes("TASK_REGISTERED")) return true;
  const exists =
    spawnSync("schtasks", ["/query", "/tn", winTaskName(c)], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0;
  if (exists) {
    console.warn(
      `   ⚠ 예약작업 재등록 실패 — 기존 등록으로 진행합니다 (${r.stderr || r.stdout || "출력 없음"}).`,
    );
    return true;
  }
  return false;
};

/** @param {Ctx} c */
const winInstall = (c) => {
  mkdirSync(c.logsDir, { recursive: true });
  if (!winEnsureTask(c)) {
    console.error(`🔴 예약작업 등록 실패 (${winTaskName(c)}).`);
    console.error(
      "   그룹정책으로 예약작업 생성이 막힌 환경일 수 있습니다 — 관리자에게 확인하거나 WSL2 를 쓰세요.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `예약작업 KeepAlive 등록 (관리자 권한 불요). TIGUCLAW_HOME=${c.homeRaw}`,
  );
  console.log(
    "   죽으면 감독자가 즉시 되살리고, 감독자까지 죽으면 1분 반복 트리거가 잡습니다(2중).",
  );
  const run = winPs(
    `Start-ScheduledTask -TaskName ${psq(winTaskName(c))}; 'STARTED'`,
  );
  if (run.status !== 0) {
    console.error(`   ⚠ 즉시 가동 실패 — ${run.stderr || run.stdout}`);
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  작업 확인: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  로그: ${path.join(c.homeAbs, "logs")}`,
  );
};

/** @param {Ctx} c */
const winUninstall = (c) => {
  winPs(
    `Stop-ScheduledTask -TaskName ${psq(winTaskName(c))} -ErrorAction SilentlyContinue; ` +
      `Unregister-ScheduledTask -TaskName ${psq(winTaskName(c))} -Confirm:$false -ErrorAction SilentlyContinue`,
  );
  winKillRunning(c);
  winRemoveLegacyAutostart(c);
  console.log(`✅ 등록 해제 (예약작업 제거, ${c.label}).`);
};

/**
 * 작업 인스턴스를 멈춘다 = 감독자와 그 자식(데몬)을 함께 끝낸다.
 * ★감독자가 생긴 뒤로는 **데몬만 죽이면 안 된다** — 감독자가 곧바로 되살려서 stop/restart
 *  가 "안 먹는" 것처럼 보인다. launchd 에서 `launchctl bootout` 을 쓰지 프로세스를 kill
 *  하지 않는 것과 같은 이유다. 남은 좀비는 그 뒤에 정리한다(포트+명령줄 합집합).
 * @param {Ctx} c
 * @returns {string[]} 종료 후에도 살아남은 PID
 */
const winStopTask = (c) => {
  // ★**멈추려면 비활성화까지 해야 한다** (2026-08-22, 그 기계에서 실측으로 잡음).
  //  `Stop-ScheduledTask` 는 *지금 도는 인스턴스*만 끝낸다 — 1분 반복 트리거는 그대로라
  //  90초 안에 데몬이 되살아났다. 즉 `stop` 이 안 먹었다. mac 은 `launchctl bootout`,
  //  리눅스는 `systemctl stop` 이라 `start` 전까진 안 돌아오는데 윈도우만 달랐다.
  //  계약(= "실행만 중지, 등록은 유지")을 지키려면 Disable 이 짝이다 — 등록은 남고
  //  트리거만 멎는다. `winStart` 의 Enable 과 쌍으로 읽어라.
  winPs(
    `Disable-ScheduledTask -TaskName ${psq(winTaskName(c))} -ErrorAction SilentlyContinue | Out-Null; ` +
      `Stop-ScheduledTask -TaskName ${psq(winTaskName(c))} -ErrorAction SilentlyContinue`,
  );
  return winKillRunning(c);
};

/** @param {Ctx} c */
const winRestart = (c) => {
  const survived = winStopTask(c);
  if (survived.length > 0) {
    console.error(
      `🔴 restart 실패 — 기존 데몬이 안 죽었습니다 (PID ${survived.join(", ")}). ` +
        `새로 띄우지 않습니다(중복 기동 방지). 작업 관리자에서 그 PID 를 종료하거나 재부팅 후 다시 시도하세요.`,
    );
    process.exitCode = 1;
    return;
  }
  // Enable 이 먼저다 — winStopTask 가 비활성화했으므로 그대로 Start 하면 안 뜬다.
  const r = winPs(
    `Enable-ScheduledTask -TaskName ${psq(winTaskName(c))} | Out-Null; ` +
      `Start-ScheduledTask -TaskName ${psq(winTaskName(c))}; 'OK'`,
  );
  if (r.status !== 0) {
    console.error(
      `🔴 restart 실패 — 예약작업 시작 실패: ${r.stderr || r.stdout}. ` +
        `등록이 살아 있는지 확인: schtasks /query /tn "${winTaskName(c)}"`,
    );
    process.exitCode = 1;
    return;
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge, 20000, 1500),
    "restarted",
    `  작업 확인: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  로그: ${path.join(c.homeAbs, "logs")}`,
  );
};

// stop = 실행만 중지(bridge 포트 PID kill), Run 키·VBS(등록) 유지 (D3).
// 포트 미LISTEN 시 대상 못 찾을 수 있음(기존 status/restart 와 동일 한계 — ADR U3).
/** @param {Ctx} c */
const winStop = (c) => {
  const survived = winStopTask(c);
  if (survived.length > 0) {
    console.error(
      `🔴 stop 실패 — 아직 살아 있습니다 (PID ${survived.join(", ")}). ` +
        `이 상태로 npm ci·업데이트를 돌리면 파일 잠금(EPERM)으로 실패합니다.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✅ stopped (등록 유지 — 재개: npm run daemon:start). ${c.label}`);
};

// start = 재실행(숨김 VBS). Run 키·VBS 는 이미 있어야 한다.
/** @param {Ctx} c */
const winStart = (c) => {
  // ★**start 가 등록을 수렴시킨다** (2026-08-22). `runUpdate` 는 install 을 다시 돌리지
  //  않고 stop→ci→build→**start** 만 한다. 그래서 기존 사용자에게 등록 변경을 배달하는
  //  **유일한 길이 여기**다. 두 부류를 다 고쳐야 한다:
  //   ① 부재 — 옛 HKCU Run 설치는 예약작업이 아예 없다("업데이트했더니 비서가 사라졌다")
  //   ② 낡음 — 등록 내용은 Task Scheduler 에 있어 코드를 고쳐도 안 바뀐다(창이 계속 떴다)
  //  ①만 고치고 ②를 안 봐서 같은 실수를 두 번 했다. `winEnsureTask` 는 매번 `-Force` 로
  //  다시 등록해 **정의점 하나**로 수렴시킨다(설정을 하나씩 비교하지 않는다 — 그건 손으로
  //  관리하는 목록이라 반드시 늙는다).
  if (!winEnsureTask(c)) {
    console.error(
      `daemon start: 예약작업 등록 실패 (${winTaskName(c)}) — \`tiguclaw install\` 로 복구하세요.`,
    );
    process.exitCode = 1;
    return;
  }
  // Enable 이 먼저다 — `stop` 이 비활성화해 뒀다(winStopTask 주석 참조).
  const r = winPs(
    `Enable-ScheduledTask -TaskName ${psq(winTaskName(c))} | Out-Null; ` +
      `Start-ScheduledTask -TaskName ${psq(winTaskName(c))}; 'OK'`,
  );
  if (r.status !== 0) {
    console.error(`daemon start: 예약작업 시작 실패 — ${r.stderr || r.stdout}`);
    process.exitCode = 1;
    return;
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "started",
    `  작업 확인: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  로그: ${path.join(c.homeAbs, "logs")}`,
  );
};

/** @param {Ctx} c */
const winStatus = (c) => {
  const t = winPs(
    `$t = Get-ScheduledTask -TaskName ${psq(winTaskName(c))} -ErrorAction SilentlyContinue; ` +
      `if ($t) { 'task=' + $t.State } else { 'task=none' }`,
  );
  console.log(`registered (예약작업 ${winTaskName(c)}): ${t.stdout || "unknown"}`);
  // 마이그레이션 잔재가 남아 있으면 **중복 기동 위험**이라 눈에 띄게 알린다.
  if (winReg(["query", RUN_KEY, "/v", c.label]).status === 0) {
    console.log(
      `⚠ 옛 HKCU Run 등록이 남아 있습니다 — 로그온 시 데몬이 두 개 뜹니다. 'install' 을 다시 돌리면 정리됩니다.`,
    );
  }
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
    "# Windows: 예약작업 KeepAlive (관리자 권한 불요) — 로그온 트리거 + 1분 반복(바닥 그물)",
  );
  console.log(`# 작업명: ${winTaskName(c)}`);
  console.log(
    `#   액션 = "${c.nodePath}" "${path.join(c.repoRoot, "bin", "daemon.mjs")}" supervise --home "${c.homeRaw}" --runtime ${c.runtime}`,
  );
  console.log(`#   감독자가 데몬을 띄우고 죽으면 되살립니다(launchd KeepAlive 동형).`);
  console.log("# --- 등록 스크립트 ---");
  console.log(buildWinTaskScript(c));
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

// ───────────────────────────── supervise (윈도우 KeepAlive) ─────────────────
/**
 * 데몬을 띄우고 **죽으면 다시 띄운다** — mac launchd `KeepAlive`, 리눅스 systemd
 * `Restart=always` 가 해주는 그 일을 윈도우에서 우리가 한다.
 *
 * ★왜 이게 필요한가 (2026-08-22): 윈도우만 **데몬이 자기 부활을 스스로 책임졌다.**
 *  종료 직전에 `schtasks` 로 1회성 예약작업을 만들어 자기를 다시 띄우는 구조였는데,
 *  같은 자리가 세 번 다른 이유로 터졌다 — 헬퍼가 job object 에 휩쓸려 죽고(#2·#3),
 *  런처 VBS 가 없는데 성공을 보고하고, 끝내 Defender 가 그 패턴을 악성으로 보고
 *  `schtasks` 생성을 EPERM 으로 막았다(`ping` 지연 + 숨김 스크립트 = 드로퍼 수법과
 *  구분 불가). 매번 "그 하나가 막히면 무기한 먹통" 이었다.
 *
 * ★그래서 고친 건 호출 방식이 아니라 **책임의 위치**다. 재기동은 죽는 쪽이 아니라
 *  **살아 있는 쪽**이 한다. 데몬은 mac 과 똑같이 그냥 종료하고, 감독자가 되살린다.
 *  예약작업은 설치 때 한 번 등록되고(런타임 생성 0), 그 작업이 실행하는 게 이 함수다.
 *
 * 2중 안전망: 감독자 자신이 죽으면 예약작업의 **1분 반복 트리거**가 다시 띄운다
 *  (`MultipleInstances=IgnoreNew` 라 살아 있는 동안의 반복 발화는 무시된다 — 실측
 *  확인). 단일 실패점이 없다는 게 이 설계의 핵심이다.
 *
 * 스로틀: 자식이 `MIN_UPTIME_MS` 안에 죽으면 크래시 루프로 보고 대기 후 재기동한다
 *  (launchd 가 10초 스로틀을 두는 것과 같은 이유 — 즉시 재기동은 CPU 만 태운다).
 * @param {Ctx} c
 */
const runSupervise = (c) => {
  const MIN_UPTIME_MS = 10_000; // 이보다 빨리 죽으면 크래시로 본다(launchd 스로틀 동형).
  const THROTTLE_MS = 10_000;
  mkdirSync(c.logsDir, { recursive: true });
  const [exe, ...rest] = execStrings(c);
  let consecutiveCrashes = 0;
  let stopping = false;

  /** 감독자 자신이 받은 종료 신호 = 사용자가 멈춘 것 → 되살리지 않는다. */
  const onSignal = () => {
    stopping = true;
    if (child !== null) child.kill();
  };
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // ★감독자 로그는 **파일로** 남긴다 (2026-08-22). 예약작업에는 콘솔이 없어서
  //  `console.log` 는 어디에도 안 남는다 — 크래시 루프 판정(몇 초 살았나·연속 몇 회)이
  //  통째로 사라지는 자리다. 윈도우는 원격 접속이 늘 되는 게 아니라 **로그가 1차 진단면**
  //  이므로, 데몬과 **같은 파일**에 써서 하나의 시간축으로 읽히게 한다(둘 다 append).
  /** @param {string} msg */
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [supervise] ${msg}\n`;
    try {
      const d = new Date();
      const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
      appendFileSync(
        path.join(
          c.logsDir,
          `daemon-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`,
        ),
        line,
      );
    } catch {
      /* 파일 기록 실패해도 감독은 계속한다 */
    }
    process.stdout.write(line); // 포그라운드로 직접 돌릴 때를 위해.
  };

  const spawnOnce = () => {
    const startedAt = Date.now();
    child = spawn(exe, rest, {
      cwd: c.repoRoot,
      env: {
        ...process.env,
        TIGUCLAW_HOME: c.homeRaw,
        TIGUCLAW_RUNTIME: c.runtime,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    log(`데몬 기동 pid=${child.pid} runtime=${c.runtime} home=${c.homeRaw}`);
    child.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      child = null;
      if (stopping) {
        log(`감독자 종료 요청 — 재기동하지 않습니다 (code=${code} signal=${signal})`);
        process.exit(0);
      }
      // ★수치를 싣는다 — 로그가 1차 진단면이라 "얼마나 살았나" 가 크래시루프 판정의
      //  근거다. 증상만 적으면 원격 기계(회사 PC·윈도우)에서 추론에 의존하게 된다.
      if (uptimeMs < MIN_UPTIME_MS) {
        consecutiveCrashes += 1;
        log(
          `데몬이 ${Math.round(uptimeMs / 1000)}초 만에 종료 (code=${code} signal=${signal}) — ` +
            `연속 ${consecutiveCrashes}회 · ${THROTTLE_MS / 1000}초 후 재기동(스로틀)`,
        );
        setTimeout(spawnOnce, THROTTLE_MS);
        return;
      }
      consecutiveCrashes = 0;
      log(
        `데몬 종료 (code=${code} signal=${signal}, ${Math.round(uptimeMs / 1000)}초 가동) — 즉시 재기동`,
      );
      spawnOnce();
    });
  };

  log(`감독 시작 — label=${c.label}`);
  spawnOnce();
};

// ───────────────────────────── dispatch ─────────────────────────────────────

/** @typedef {"install" | "uninstall" | "restart" | "stop" | "start" | "status" | "logs" | "print" | "update" | "supervise"} Cmd */

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
    // ★윈도우는 **예약작업 존재**로 판정한다 (2026-08-22). 종전엔 `win-launch.vbs` 파일을
    //  봤는데, 감독자 방식으로 옮기며 그 VBS 를 지우므로 그대로 뒀다면 설치된 기계가
    //  전부 "미설치" 로 보여 update 가 매번 install 을 안내했을 것이다.
    if (process.platform === "win32") {
      return (
        spawnSync("schtasks", ["/query", "/tn", winTaskName(c)], {
          stdio: "ignore",
          windowsHide: true,
        }).status === 0
      );
    }
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
  // ★**위임된 경우 앵커는 호출자가 준다** (2026-08-22).
  //  윈도우+built 의 `/update` 는 `self-update.ts` 가 **먼저 pull 한 뒤** 이 CLI 로 위임한다
  //  (dist 를 실행 중 데몬이 잠가 in-process 교체가 EBUSY 라서). 그러면 여기서 읽는 HEAD 는
  //  **이미 갱신된 SHA** 라, 롤백이 `git reset --hard <새 SHA>` = **아무것도 안 되돌린다.**
  //  빌드가 깨졌을 때 되돌아갈 곳이 사라지는 건데, 롤백은 그때만 쓰이므로 **조용히** 죽어
  //  있었다(실측: 로그가 `2af6ee0 → 2af6ee0 · 코드 변경 없음` 인데 HEAD 는 옮겨져 있었다).
  //  → 호출자가 pull *이전* SHA 를 넘기면 그걸 앵커로 쓴다. 없으면 종전대로 HEAD.
  const handoffSha = process.env.TIGUCLAW_UPDATE_PREV_SHA?.trim();
  const prevSha =
    handoffSha !== undefined && /^[0-9a-f]{7,40}$/i.test(handoffSha)
      ? handoffSha
      : prev.stdout.trim();

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
      run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev", "--ignore-scripts=false"], { shell: isWin });
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
  // ★`--ignore-scripts=false` 를 **명시**한다 (2026-08-19 실사고). 사내 정책으로 npm 설정에
  //  `ignore-scripts=true` 가 켜진 머신에서는 `npm ci` 가 **성공하는데** 네이티브 빌드
  //  스크립트가 아예 안 돌아 `better_sqlite3.node` 가 안 생긴다 → 데몬이 부팅마다 죽는다
  //  (실측 6회 연속). 종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다.
  //  ★전역 정책은 안 건드린다 — 이 한 번의 호출에만 붙는 플래그다. 사용자가 `tiguclaw
  //   update` 를 직접 부른 것이고, 이 제품은 네이티브 모듈 없이는 아예 못 뜬다.
  if (run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev", "--ignore-scripts=false"], { shell: isWin }) !== 0) {
    console.error("update: npm ci 실패 — 롤백합니다.");
    writeFailedMarker("npm ci", "npm ci 실패(의존성 설치)");
    rollback();
    console.error("update: 롤백 완료, 데몬 원복. exit 1.");
    process.exitCode = 1;
    return;
  }

  // ── 단계 6b: ★네이티브 모듈이 **실제로 열리는지** ──────────────────────────
  //  npm ci 종료코드 0 이어도 못 쓰는 경우가 있다(위 ignore-scripts). 여기서 열어보고,
  //  안 되면 **한 번은 스스로 고쳐본다** — 사용자가 명령 세 줄을 외우게 하지 않는다.
  //  ★자동 조치의 기준(되돌릴 수 있나 · 최악이 사소한가)을 통과한다: `npm rebuild` 는
  //   그 폴더의 네이티브 모듈만 다시 만들고, 실패해도 아래 롤백이 그대로 돈다.
  const nativeOk = () =>
    run(process.execPath, ["-e", "require('better-sqlite3')"]) === 0;
  if (!nativeOk()) {
    console.log("   네이티브 모듈이 안 열립니다 — 다시 빌드합니다(npm rebuild).");
    run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], { shell: isWin });
    if (!nativeOk()) {
      console.error(
        [
          "update: SQLite 네이티브 모듈을 열 수 없어 롤백합니다.",
          "   이 상태로 두면 데몬이 부팅마다 죽습니다.",
          "   빌드 도구가 필요할 수 있습니다 — 윈도우: Visual Studio Build Tools(C++ 워크로드),",
          "   리눅스: build-essential + python3, macOS: xcode-select --install",
        ].join("\n"),
      );
      writeFailedMarker("native", "better-sqlite3 네이티브 모듈 적재 실패");
      rollback();
      console.error("update: 롤백 완료, 데몬 원복. exit 1.");
      process.exitCode = 1;
      return;
    }
    console.log("   네이티브 모듈 복구 완료.");
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

  // ── 단계 9: 결과 요약 ───────────────────────────────────────────────────────
  // ★기동 실패를 받고도 ✅ 를 찍지 않는다 (2026-08-15 2차, 적대 검토 P11). `reportLaunch`
  //  를 정직하게 만든 커밋의 이득이 **바로 이 호출부에서 상쇄되고 있었다** — 화면 마지막
  //  줄이 "가동 재개" 라 그게 결론으로 읽힌다. 윈도우 93분 사망 사고의 사용자 체감이
  //  (성공 메시지 + 죽은 데몬) 문자 그대로 재현 가능했다. `start` 가 exitCode 1 을 세웠으면
  //  코드는 적용됐어도 **재가동은 실패**라고 말한다.
  if (process.exitCode === 1) {
    console.error(
      `🔴 update 는 적용됐지만 **재가동에 실패**했습니다: ` +
        `${prevSha.slice(0, 7)} → ${newSha.slice(0, 7)} (runtime=${c.runtime}).\n` +
        `   위 실패 원인을 보고 수동으로 기동하세요 — 자동으로 다시 뜨지 않습니다.`,
    );
    return;
  }
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

  // supervise = 이 프로세스가 **감독자**가 되어 데몬을 띄우고, 죽으면 다시 띄운다.
  //   launchd `KeepAlive` · systemd `Restart=always` 와 같은 역할이고, 그 두 OS 에선
  //   OS 가 해주므로 **윈도우 전용 진입점**이다(다른 OS 에서 부를 일은 없지만 막지도
  //   않는다 — 플랫폼 분기를 늘리지 않는다). handlers 테이블 밖 = logs·update 와 동형.
  if (cmd === "supervise") {
    runSupervise(c);
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
  // ★`--home`/`--runtime` 플래그 → env (2026-08-22). 윈도우 예약작업의 액션은 **환경변수를
  //  실을 수 없다** — 종전 VBS 는 `cmd /c set VAR=... && ...` 체인으로 넣었는데, 그 체인
  //  모양이 Defender 오탐의 재료였다. 인자로 받아 여기서 env 로 올리면 buildCtx 아래는
  //  전부 종전과 같은 경로로 돈다(분기 0). 셸을 안 거치므로 인용 문제도 없다.
  for (let i = 3; i < process.argv.length - 1; i += 1) {
    const v = process.argv[i + 1];
    if (process.argv[i] === "--home" && v) process.env.TIGUCLAW_HOME = v;
    if (process.argv[i] === "--runtime" && v) process.env.TIGUCLAW_RUNTIME = v;
  }
  if (!cmd) {
    console.error(
      "사용: node bin/daemon.mjs <install|uninstall|restart|stop|start|status|logs|print|update|supervise>",
    );
    process.exitCode = 1;
  } else {
    runDaemonCommand(cmd);
  }
}
