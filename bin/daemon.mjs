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
 *   - Windows→ 예약작업(로그온 + 1분 반복) + 숨김 VBS 감독자. 예약작업이 막힌 기계는 시작프로그램 폴더 폴백(감독자는 있고, 감독자가 죽으면 다음 로그온까지).
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
 * KeepAlive: macOS(launchd KeepAlive) · Linux(systemd Restart=always) · Windows(감독자 즉시 재기동 + 예약작업 1분
 *   반복이 감독자까지 되살림, 2026-08-22). 정책으로 막혀 시작프로그램 폴백이면 데몬은 감독자가 되살리지만 감독자는 아무도 안 되살린다.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  watchFile,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import * as nodeUtil from "node:util";
import path from "node:path";
import process from "node:process";

// 기본 라벨. 한 머신에서 2개 이상 인스턴스(예: prod + 검증용)를 상시 가동하려면
// TIGUCLAW_SERVICE_LABEL 로 고유 라벨을 지정한다 (홈·봇·포트도 함께 분리할 것).
const DEFAULT_LABEL = "com.tiguclaw.daemon";

/**
 * 홈 `.env` 의 한 키 — 없거나 비면 undefined. 포트·라벨이 같은 규칙(홈 `.env` 우선)을 쓰는 한 자리.
 * @param {string} homeAbs
 * @param {string} key
 * @returns {string | undefined}
 */
export const readHomeEnvValue = (homeAbs, key) => {
  let text;
  try {
    text = readFileSync(path.join(homeAbs, ".env"), "utf8");
  } catch {
    return undefined; // .env 없음
  }
  // ★데몬이 쓰는 **같은 파서**로 읽는다 (2026-10-03 적대 검토 P-1). 데몬은 `process.loadEnvFile`(= util.parseEnv)로 홈 .env 를
  //  읽는데 여기만 정규식이었다 — `KEY = 값`·`export KEY=…`·같은 키 두 번·줄 끝 주석에서 둘이 다른 라벨을 봐, 설치가 운영의
  //  예약작업을 덮어쓰는 원래 사고가 다시 났다. parseEnv 가 없는 Node(<20.12)는 데몬 자체가 못 뜨므로 옛 규칙으로만 버틴다.
  const parse = /** @type {((s: string) => Record<string, string>) | undefined} */ (nodeUtil.parseEnv);
  const v =
    typeof parse === "function"
      ? parse(text)[key] // 데몬과 같은 값 — 따옴표 안 공백까지 그대로(덧 trim 하면 갈린다, 재검토 6)
      // 따옴표는 `\x22`·`\x27` 로 적는다 — 회귀의 주석 제거기는 정규식 리터럴을 몰라, 맨 따옴표가 있으면 짝이 어긋나 아래 주석이 안 지워진다.
      : text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^[\x22\x27]|[\x22\x27]$/g, "");
  return v === undefined || v === "" ? undefined : v;
};

/** 기본 포트 이동 전의 값 — `src/core/legacy-ports.ts` 의 `LEGACY_PORTS` 와 같다(회귀 `legacy-ports-settled` 가 대조). */
const LEGACY_PORTS = [
  ["HTTP_BRIDGE_PORT", "7011"],
  ["DASHBOARD_PORT", "7010"],
];

/**
 * **기본 포트를 옮긴 뒤(17010·17011) 기존 설치는 쓰던 포트를 지킨다** (2026-10-08) — `src/core/legacy-ports.ts` 와 **같은 판단**.
 * ★여기에도 있어야 하는 이유: 윈도우는 이 스크립트가 옛 데몬을 **포트로** 찾아 멈춘다. 업데이트 직후 새 기본값으로 찾으면 옛 데몬
 *  (7011)을 못 찾아 «멈추지 못함» 으로 업데이트가 멈춘다. 의존성 없이 돌아야 해서 코드를 나눌 수 없고, 두 구현이 같은 결과를
 *  내는지는 회귀가 같은 입력으로 대조한다. 실패는 던지지 않는다.
 * @param {string} homeAbs
 * @param {string} repoEnvPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export const settleLegacyPorts = (homeAbs, repoEnvPath, env = process.env) => {
  try {
    const dataDir = path.join(homeAbs, "data");
    const marker = path.join(dataDir, "ports-settled");
    if (existsSync(marker)) return [];
    /** @type {string[]} */
    const wrote = [];
    if (existsSync(path.join(dataDir, "tiguclaw.db"))) {
      const envPath = path.join(homeAbs, ".env");
      let text = "";
      try {
        text = readFileSync(envPath, "utf8");
      } catch {
        /* .env 없음 — 새로 만든다 */
      }
      const parseFn = /** @type {((s: string) => Record<string, string>) | undefined} */ (nodeUtil.parseEnv);
      /** @param {string} t */
      const parse = (t) => (typeof parseFn === "function" ? parseFn(t) : {});
      const fromFile = parse(text);
      /** @type {Record<string, string>} */
      let fromRepo = {};
      try {
        if (path.resolve(repoEnvPath) !== path.resolve(envPath)) fromRepo = parse(readFileSync(repoEnvPath, "utf8"));
      } catch {
        /* 레포 .env 없음 */
      }
      /** @type {string[]} */
      const lines = [];
      for (const [key, port] of LEGACY_PORTS) {
        if ((fromFile[key] ?? "") !== "" || (fromRepo[key] ?? "") !== "" || (env[key]?.trim() ?? "") !== "") continue;
        lines.push(`${key}=${port}`);
        wrote.push(key);
      }
      if (lines.length > 0) {
        const nl = text.includes("\r\n") ? "\r\n" : "\n";
        const head = text === "" || text.endsWith("\n") ? "" : nl;
        appendFileSync(
          envPath,
          head +
            [
              "# The default ports moved to 17010 (dashboard) / 17011 (bridge) — 7010/7011 can fall into a Windows excluded port range.",
              "# This install keeps the ports it was already using. Delete these lines to switch to the new defaults.",
              ...lines,
            ].join(nl) +
            nl,
          "utf8",
        );
      }
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
    if (wrote.length > 0) console.log(`[ports] kept this install's ports in ${path.join(homeAbs, ".env")}: ${wrote.join(", ")}`);
    return wrote;
  } catch (e) {
    console.error(`[ports] could not settle the legacy ports: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

/**
 * 서비스 라벨 — **홈 `.env` → 환경변수 → 기본값** (2026-10-03). 포트(`winPort`)와 같은 순서다.
 * ★종전엔 환경변수만 봤다. 그래서 `--home` 만 주고 두 번째 인스턴스를 설치·재시작하면 라벨이 기본값이 되어
 *  **기존 인스턴스의 자동 시작(예약작업·plist·유닛)을 덮어쓰거나 겨눴다**. 개발 스크립트(`deploy-dev.sh`)는 홈 `.env`
 *  에서 손으로 읽어 넘기며 이 빈틈을 피하고 있었다. 홈 `.env` 를 먼저 보는 이유: 셸에 다른 인스턴스의 라벨이 남아
 *  있어도 그 홈 자신의 라벨이 이긴다(덮어쓰는 쪽 실패가 더 나쁘다).
 * @param {string} homeAbs
 * @returns {string}
 */
export const resolveLabel = (homeAbs) =>
  readHomeEnvValue(homeAbs, "TIGUCLAW_SERVICE_LABEL") ?? (process.env.TIGUCLAW_SERVICE_LABEL?.trim() || DEFAULT_LABEL);

/**
 * Windows 예약작업은 **설치를 부른 셸**의 환경을 다음 기동에 넘기지 않는다 — 셸에서만 준 인스턴스 설정(포트·프로필
 * 폴더·라벨)이 업데이트·재등록 뒤에 사라졌다. 그 값만 홈에 붙잡아 둔다(`win-service-env.json`).
 *
 * ★세 질문으로 자리를 정했다 (2026-10-05 적대 검토 — 첫 판은 모든 값을 «처음 본 값» 으로 영구 고정했다):
 *  - **OS 프로필 값(PATH·USERPROFILE·APPDATA·TEMP…)은 넣지 않는다.** 정하는 건 Windows 이고, 예약작업이 기동할
 *    때마다 사용자 프로필에서 새로 받는다. 붙잡으면 PATH 가 설치 순간에 굳어 그 뒤 깐 git·python 을 영영 못 찾았다.
 *  - **인스턴스 설정의 정본은 홈 `.env` 다.** `.env` 가 정한 키는 저장하지 않고, 기동 때마다 `.env` 가 이긴다
 *    (저장본이 `.env` 를 가리면 `.env` 를 고쳐도 `/restart` 가 옛 값으로 떴다 · 지운 `0.0.0.0` 바인드가 남았다).
 *  - 저장본은 **`.env` 에 없고 실행 환경에만 있던 값**뿐이다. 바꾸려면 `.env` 에 적으면 된다(그쪽이 이긴다).
 * 비밀값은 여기 저장하지 않는다 — 토큰은 홈 `.env` 가 소유하고 데몬이 로드한다.
 */
export const WIN_SERVICE_ENV_KEYS = [
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "npm_config_userconfig", "npm_config_globalconfig", "TIGUCLAW_SERVICE_LABEL",
  "HTTP_BRIDGE_HOST", "HTTP_BRIDGE_PORT", "DASHBOARD_HOST", "DASHBOARD_PORT", "TZ",
];

/**
 * 붙잡아 둔 값 — 파일 그대로(허용 키·문자열만). `.env` 와 합치지 않는다(합치면 `.env` 값이 실행 환경으로 새어
 * `.env` 를 고쳐도 안 바뀐다).
 * ★손상됐으면 던진다 — 빈 값으로 넘어가면 라벨·포트가 기본값이 되어 **다른 인스턴스를 겨눈다.**
 * @param {string} homeAbs @returns {Record<string, string>}
 */
export const readWinServiceEnv = (homeAbs) => {
  const file = path.join(homeAbs, "win-service-env.json");
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  /** @type {Record<string, string>} */
  const result = {};
  for (const key of WIN_SERVICE_ENV_KEYS) {
    const value = saved?.[key];
    if (typeof value === "string" && value !== "") result[key] = value;
  }
  return result;
};

/**
 * 기동 환경 = 실행 환경 + 붙잡아 둔 값 중 **`.env` 가 안 정했고 실행 환경에도 없는 것**. 순수 함수 — 감독자는 데몬을
 * 띄울 때마다 이걸 다시 계산한다(그래서 `.env` 를 고친 뒤 `/restart` 가 새 값으로 뜬다).
 * @param {NodeJS.ProcessEnv} baseEnv @param {string} homeAbs @returns {NodeJS.ProcessEnv}
 */
export const winLaunchEnv = (baseEnv, homeAbs) => {
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(readWinServiceEnv(homeAbs))) {
    if (readHomeEnvValue(homeAbs, key) !== undefined) continue; // .env 가 정본
    if (env[key] !== undefined && env[key] !== "") continue; // 지금 실행 환경이 준 값이 이긴다
    env[key] = value;
  }
  return env;
};

/** @param {string} homeAbs @param {NodeJS.ProcessEnv} [env] */
export const applyWinServiceEnv = (homeAbs, env = process.env) => {
  Object.assign(env, winLaunchEnv(env, homeAbs));
};

/** 실행 환경에만 있는 토큰은 재생성된 런처로 넘어가지 않는다 — **막지 않고 알린다.**
 * ★종전엔 여기서 던져 업데이트를 거절했다. 그런데 위임 `/update` 에선 이미 pull 한 뒤라 HEAD 만 새것이 되어 고착됐고,
 *  `setx` 로 사용자 환경에 둔 토큰은 예약작업이 기동마다 받으므로 **원래 잃지 않는다**(거절의 대부분이 오탐).
 * @param {Ctx} c
 */
const warnWinServiceToken = (c) => {
  const token = process.env.HTTP_BRIDGE_TOKEN;
  const persisted = readHomeEnvValue(c.homeAbs, "HTTP_BRIDGE_TOKEN") ?? readHomeEnvValue(c.repoRoot, "HTTP_BRIDGE_TOKEN");
  if (token && token !== persisted) {
    console.warn("note: HTTP_BRIDGE_TOKEN is not in the home .env. If it was set only in a custom launcher, save it to the home .env (the value is not shown in logs).");
  }
};

/**
 * 실행 환경에만 있던 인스턴스 값을 붙잡는다. `.env` 가 정한 키는 저장하지 않는다.
 * @param {Ctx} c @param {NodeJS.ProcessEnv} [env]
 */
export const saveWinServiceEnv = (c, env = process.env) => {
  /** @type {Record<string, string>} */
  const saved = {};
  for (const key of WIN_SERVICE_ENV_KEYS) {
    // 홈 `.env`·레포 `.env` 가 정한 키는 붙잡지 않는다 — 데몬이 그 파일을 직접 읽는다(붙잡으면 지워도 남는다).
    if (readHomeEnvValue(c.homeAbs, key) !== undefined || readHomeEnvValue(c.repoRoot, key) !== undefined) continue;
    const value = key === "TIGUCLAW_SERVICE_LABEL" ? c.label : env[key];
    if (value !== undefined && value !== "") saved[key] = value;
  }
  const file = path.join(c.homeAbs, "win-service-env.json");
  const text = JSON.stringify(saved, null, 2) + "\n";
  // 같은 내용이면 쓰지 않는다. 임시 파일을 같은 홈에 쓴 뒤 교체해 잘린 JSON을 피한다.
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  mkdirSync(c.homeAbs, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
};

/** 로그에는 환경의 비밀값·인증 헤더·URL 자격증명을 남기지 않는다.
 * @param {string} text @param {NodeJS.ProcessEnv} [env] @returns {string}
 */
export const redactUpdateLog = (text, env = process.env) => {
  let clean = text;
  for (const [key, value] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key) && value && value.length >= 8) {
      clean = clean.split(value).join("[REDACTED]");
    }
  }
  return clean
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]");
};

/**
 * 명령 뒤 인자를 env 로 올린다 — `--home X` · `--runtime X` 두 꼴만. 모르는 인자·빈 값이면 그 사유를 돌려준다
 * (호출자가 거절한다 — 조용히 무시하면 기본 홈으로 떨어진다).
 * ★`--home=X` 는 **받지 않는다** (2026-10-03 재검토 F-A). 셸이 `=` 뒤의 `~` 를 펼치지 않아, 받으면 `~/x` 가 그대로
 *  유닛에 박혀 데몬은 엉뚱한 홈(기본 포트)으로 뜨고 관리 명령은 다른 홈을 본다. 띄어 쓰면 셸이 펼친다.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
export const parseDaemonFlags = (args) => {
  /** @type {Record<string, string>} */
  const keys = { "--home": "TIGUCLAW_HOME", "--runtime": "TIGUCLAW_RUNTIME" };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const name = a.split("=")[0];
    if (name !== a && Object.hasOwn(keys, name)) return `'${a}' is not accepted (use a space: '${name} <value>')`;
    const env = Object.hasOwn(keys, a) ? keys[a] : undefined;
    if (env === undefined) return `unknown argument '${a}'`;
    const v = args[++i];
    if (v === undefined || v.trim() === "" || v.startsWith("--")) return `${a} needs a value`;
    process.env[env] = v;
  }
  return undefined;
};

/**
 * 프로세스 명령줄이 **이 홈**을 가리키는가 — 경로 경계까지 본다 (2026-10-03).
 * ★종전엔 `includes(home)` 였다. 홈 `C:\Users\A\.tiguclaw` 가 `C:\Users\A\.tiguclaw-inspection` 의 앞부분이라,
 *  운영 인스턴스를 멈추거나 재시작·업데이트하면 **다른 인스턴스의 감독자·데몬까지 같이 죽였다**(회사 PC 구성 그대로).
 *  앞은 줄 처음·따옴표·공백·`=`, 뒤는 줄 끝·따옴표·공백·경로 구분자여야 이 홈이다(그 홈 **아래**의 경로는 이 홈 것이다).
 * @param {string} cmdline
 * @param {string} home
 * @returns {boolean}
 */
export const cmdlineHasHome = (cmdline, home) => {
  const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/\//g, "\\");
  const h = norm(home).replace(/\\+$/, "");
  if (h === "") return false;
  const line = norm(cmdline);
  for (let i = line.indexOf(h); i !== -1; i = line.indexOf(h, i + 1)) {
    const before = i === 0 ? "" : line[i - 1];
    const after = line[i + h.length] ?? "";
    if ((before === "" || /["' =]/.test(before)) && (after === "" || /["' \\]/.test(after))) return true;
  }
  return false;
};

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
 * @property {NodeJS.ProcessEnv} [launchEnv] 붙잡은 Windows 값을 채우기 전의 실행 환경(감독자가 기동마다 다시 계산).
 * @property {string} [winEnvError] Windows 저장본을 못 읽은 사유 — 있으면 라벨·포트가 틀릴 수 있다.
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
  // 포트를 읽기 **전에** — 기존 설치는 옛 기본 포트를 홈 .env 에 고정한다(위 주석).
  settleLegacyPorts(homeAbs, path.join(repoRoot, ".env"));
  /** @type {string | undefined} */
  let winEnvError;
  if (process.platform === "win32") {
    process.env.PATH = path.dirname(nodePath) + path.delimiter + (process.env.PATH ?? "");
  }
  // 붙잡은 값을 채우기 **전**의 실행 환경 — 감독자는 데몬을 띄울 때마다 이것에서 다시 계산한다(`winLaunchEnv`).
  const launchEnv = { ...process.env };
  if (process.platform === "win32") {
    // ★손상된 저장본은 여기서 던지지 않는다 — 종전엔 이 throw 가 업데이트 로그를 열기 **전**이라 위임 `/update` 가
    //  로그도 마커도 없이 조용히 죽었다. 사유를 들고 가서 명령마다 판단한다(runDaemonCommand · runUpdate).
    try {
      applyWinServiceEnv(homeAbs);
    } catch (error) {
      winEnvError = `${path.join(homeAbs, "win-service-env.json")} is unreadable (${String(error)})`;
    }
  }
  const logsDir = path.join(homeAbs, "logs");
  return {
    launchEnv,
    winEnvError,
    repoRoot,
    nodePath,
    tsxCli,
    entry,
    distEntry,
    runtime: runtimeMode(),
    homeRaw,
    homeAbs,
    logsDir,
    label: resolveLabel(homeAbs),
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
    <!-- ★node 가 사는 폴더를 앞에 세운다 — **세 플랫폼 전부**에 있어야 한다 (2026-09-09,
         적대 검토 P4). 종전엔 이 plist 에만 있었고 systemd·윈도우엔 없었다. 그런데
         self-update 는 npm 을 **맨 이름**으로 부르고, 전용 Node 를 쓰는 설치본에서 npm 은
         설치폴더/.node/bin 에만 있다 — systemd 기본 PATH 에도 윈도우 사용자 PATH 에도
         없다. 그러면 의존성이 바뀐 릴리스에서 업데이트가 실패해 롤백한다. 종전엔 nvm
         사용자만 밟던 갈래인데, 전용 Node 를 도입하면서 **비개발자 리눅스·윈도우 설치
         전부**가 그 갈래가 됐다.
         ★백틱을 쓰지 마라 — 이 주석은 템플릿 리터럴 안이라 백틱 하나가 문자열을 끊는다
         (실제로 그렇게 한 번 깼다). -->
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
  console.log(`Created: ${plistPath}`);

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
          `# ⚠ bootout did not finish within 10 seconds (${domain}/${c.label}) — trying bootstrap anyway.`,
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
  console.log(`Registered with launchd (KeepAlive). TIGUCLAW_HOME=${c.homeRaw}`);
  // ★install 도 **확인 후** 말한다 (2026-08-22). 종전엔 등록만 하고 `✅ 등록 완료` 를
  //  찍어, 데몬이 안 떠도 설치가 성공으로 보였다 — start/restart 에서 93분 먹통을 만든
  //  바로 그 거짓 성공이 install 에는 그대로 남아 있었다(세 플랫폼 전부).
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  Check: launchctl print ${domain}/${c.label}\n` +
      `  Logs: ${path.join(c.logsDir, "daemon-<date>.log")}`,
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
  console.log(`✅ Unregistered from launchd and removed the plist (${c.label}).`);
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
    `  Check: launchctl print ${domain}/${c.label}\n  Logs: ${path.join(c.homeAbs, "logs")}`,
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
  console.log(`✅ stopped (still registered — resume with: npm run daemon:start). ${c.label}`);
  return true;
};

// start = plist 재작성 없이 재적재(재실행). 등록 파일은 이미 디스크에 있어야 한다.
/** @param {Ctx} c */
const darwinStart = (c) => {
  const domain = launchdDomain();
  const plistPath = launchdPlistPath(c);
  if (!existsSync(plistPath)) {
    console.error(
      `daemon start: no registered plist found (${plistPath}). Run install first.`,
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
    `  Check: launchctl print ${launchdDomain()}/${c.label}\n  Logs: ${path.join(c.homeAbs, "logs")}`,
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
  console.log(`# Register: launchctl bootstrap ${launchdDomain()} <plist>`);
  console.log(`# Restart:  launchctl kickstart -k ${launchdDomain()}/${c.label}`);
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
Environment="PATH=${path.dirname(c.nodePath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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
  console.log(`Created: ${unitPath}`);

  systemctlUser(["daemon-reload"]);
  systemctlUser(["enable", "--now", c.label]);
  console.log(`Registered the systemd user service (Restart=always). TIGUCLAW_HOME=${c.homeRaw}`);
  const user = os.userInfo().username;
  console.log(
    `   To start at boot without logging in: loginctl enable-linger ${user}`,
  );
  // ★install 도 확인 후 말한다 (2026-08-22) — darwinInstall 주석 참조.
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  Check: systemctl --user status ${c.label}\n` +
      `  Logs: npm run daemon:logs (journalctl --user -u ${c.label} -f)`,
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
  console.log(`✅ Unregistered the systemd user service and removed the unit (${c.label}).`);
};

/** @param {Ctx} c */
const linuxRestart = (c) => {
  systemctlUser(["restart", c.label]);
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge, 20000, 1500),
    "restarted",
    `  Check: systemctl --user status ${c.label}\n  Logs: ${path.join(c.homeAbs, "logs")}`,
  );
};

// stop = 실행만 중지, 유닛 enable(등록) 유지 (D3).
/** @param {Ctx} c */
const linuxStop = (c) => {
  try {
    systemctlUser(["stop", c.label]);
  } catch (e) {
    console.error(`🔴 stop failed — systemctl --user stop ${c.label}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`✅ stopped (still registered — resume with: npm run daemon:start). ${c.label}`);
  return true;
};

// start = 재실행. 유닛은 이미 디스크에 있어야 한다.
/** @param {Ctx} c */
const linuxStart = (c) => {
  systemctlUser(["start", c.label]);
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "started",
    `  Check: systemctl --user status ${c.label}\n  Logs: ${path.join(c.homeAbs, "logs")}`,
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
  console.log("# Register: systemctl --user daemon-reload && systemctl --user enable --now " + c.label);
  console.log(`# Restart:  systemctl --user restart ${c.label}`);
  console.log(`# Start at boot: loginctl enable-linger ${os.userInfo().username}`);
};

// ───────────────────────────── Windows (예약작업 + 숨김 VBS 감독자) ──────────
// 2026-08-22 부터 예약작업(로그온 + 1분 반복, 관리자 권한 불요)이 감독자를 띄운다 — 아래 winEnsureTask.
// 예약작업 생성이 정책으로 막힌 기계는 시작프로그램 폴더 폴백(로그온 자동시작만). 옛 HKCU Run 키는
// 이제 **걷어내는 대상**이다(winRemoveLegacyAutostart — 남아 있으면 로그온 때 두 개 뜬다).

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
    // ★«Not installed» 라고 하지 않는다 — install 이면 등록은 됐고 데몬만 안 뜬 것이다(동사를 명사로: installed→install).
    `🔴 Daemon not running after ${verb.replace(/ed$/, "")} — the start command was sent, but the bridge port never opened. ` +
      `The daemon either didn't start or exited right away.\n${hint}`,
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
const winPort = (c) =>
  readHomeEnvValue(c.homeAbs, "HTTP_BRIDGE_PORT") ?? (process.env.HTTP_BRIDGE_PORT?.trim() || "17011");

/**
 * VBS 파일 내용(바이트) — **UTF-16LE + BOM** (2026-10-03 적대 검토 C, 집 윈도우 실측). WSH 는 BOM 없는 파일을
 * 시스템 ANSI(한국어 윈도우 = CP949)로 읽는다. UTF-8 로 쓰면 `C:\Users\홍길동\…` 이 `C:\Users\?띻만??…` 로 깨져
 * 감독자가 엉뚱한 홈으로 떴다(한글 계정명이면 기본 홈 경로가 한글이다). BOM 이 있으면 WSH 가 유니코드로 읽는다.
 * @param {string} text
 * @returns {Buffer}
 */
export const vbsBytes = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

/** VBS 를 쓰는 **유일한** 자리 — 두 VBS(런처·시작프로그램 폴백)가 이걸 지난다. @param {string} p @param {string} text */
export const writeVbs = (p, text) => writeFileSync(p, vbsBytes(text));

/**
 * PowerShell 출력을 UTF-8 로 내게 하는 머리 한 줄 — 우리는 출력을 utf8 로 읽는다. 기본(콘솔 코드페이지 CP949)이면
 * 한글 경로가 깨져 명령줄에서 이 홈의 감독자를 못 찾고(stop·restart·uninstall 이 못 죽인다), 오류 문구도 깨진다
 * (2026-10-03 적대 검토 C, 집 윈도우 실측).
 */
export const PS_UTF8_OUTPUT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ";

/**
 * 윈도우 명령줄 인자 하나를 따옴표로 감싼다 — 프로그램(node)이 읽는 규칙(CommandLineToArgvW)대로.
 * ★끝의 역슬래시는 **두 배로** 적는다 (2026-10-03 재검토 F-C). `"C:\x\"` 는 끝의 `\"` 가 «따옴표 문자» 로 읽혀
 *  인자가 닫히지 않고 뒤의 `--runtime built` 까지 홈 값에 붙는다 — 홈을 `C:\x\` 처럼 끝 구분자와 함께 적으면 감독자가 엉뚱한 홈으로 뜬다
 *  (코드로 추적한 결함, 회귀는 아래 규칙을 구현한 파서로 왕복한다).
 *  경로엔 `"` 가 올 수 없으므로 다른 자리는 손대지 않는다.
 * @param {string} s
 * @returns {string}
 */
export const winQuoteArg = (s) => `"${s.replace(/(\\+)$/, "$1$1")}"`;

/**
 * 예약작업이 실행할 감독자 명령줄 — `parseDaemonFlags` 가 그대로 받아야 한다(회귀가 왕복으로 고정한다).
 * @param {Pick<Ctx, "nodePath" | "repoRoot" | "homeRaw" | "runtime">} c
 * @returns {string[]}
 */
export const winSuperviseArgv = (c) => [
  c.nodePath,
  path.join(c.repoRoot, "bin", "daemon.mjs"),
  "supervise",
  "--home",
  c.homeRaw,
  "--runtime",
  c.runtime,
];

/**
 * 숨김 런처 VBS — 예약작업이 이걸 실행하고, 이게 **감독자**를 창 없이 띄운다.
 *
 * ★두 인자가 핵심이다: `sh.Run(cmd, 0, True)`
 *   - `0` = 창 숨김. 예약작업이 `node` 를 직접 띄우면 콘솔 창이 뜬다(사용자 화면으로 확인).
 *   - `True` = **기다린다**. 안 기다리면 wscript 가 즉시 끝나 작업 인스턴스도 끝나고,
 *     그러면 `IgnoreNew` 가 무효가 돼 **1분마다 감독자가 하나씩 더 뜬다**. 기다리면
 *     wscript 가 감독자만큼 살아 중복 방지가 그대로 성립한다 — 감독자에 별도 중복 가드를
 *     만들지 않아도 되는 이유다(부품을 안 늘린다).
 *
 * ★환경변수는 안 심는다 — `supervise --home/--runtime` **인자**로 넘기고, 셸에서만 준 인스턴스 값은 감독자가
 *  홈의 `win-service-env.json` 에서 **기동마다** 다시 읽는다(`winLaunchEnv`). 종전 VBS 는 `cmd /c set …` 체인을
 *  썼는데 그 모양이 Defender 오탐의 재료였다. ★2026-10-05 에 한 번 VBS 에 값을 심었다가 걷어냈다 — VBS 가 준 값은
 *  «실행 환경» 이 되어 홈 `.env` 를 고쳐도 이겼다.
 * @param {Ctx} c
 * @returns {string}
 */
export const buildWinVbs = (c) => {
  const cmd = winSuperviseArgv(c)
    .map(winQuoteArg)
    .join(" ");
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${c.repoRoot.replace(/"/g, '""')}"`,
    // ★node 가 사는 폴더를 PATH 앞에 세운다 — plist·systemd 와 **같은 판단**이다.
    `sh.Environment("PROCESS")("PATH") = "${path.dirname(c.nodePath).replace(/"/g, '""')};" & sh.ExpandEnvironmentStrings("%PATH%")`,
    // 0 = 숨김, True = 감독자가 끝날 때까지 대기(작업 인스턴스 유지 → IgnoreNew 성립).
    `sh.Run "${cmd.replace(/"/g, '""')}", 0, True`,
    "",
  ].join("\r\n");
};

/**
 * 윈도우 외부 명령(PowerShell·schtasks) 상한 — 먹통이면 매달리지 말고 포기한다.
 * ★실패보다 **조용한 무한 대기**가 나쁘다: 설치가 안 끝나면 사용자는 뭘 기다리는지도 모른다.
 */
const WIN_PS_TIMEOUT_MS = 30_000;

/** @param {string[]} args */
const winReg = (args) =>
  spawnSync("reg", args, { stdio: "pipe", encoding: "utf8" });

/**
 * KeepAlive 예약작업명 — 인스턴스 라벨에서 파생(한 기계의 여러 인스턴스가 안 겹친다).
 * @param {Pick<Ctx, "label">} c
 * @returns {string}
 */
const winTaskName = (c) => c.label;

/**
 * 예약작업을 **켜고 나서** 띄운다 — install·start·restart 가 같이 쓴다(세 벌이던 것을 하나로, 2026-10-03 재검토).
 * Enable 이 먼저다: stop 이 비활성화해 두고, install 은 재등록이 실패하면 winEnsureTask 가 건 Disable 이 남는다.
 * @param {Pick<Ctx, "label">} c
 * @returns {string}
 */
export const winEnableStartScript = (c) =>
  `Enable-ScheduledTask -TaskName ${psq(winTaskName(c))} | Out-Null; Start-ScheduledTask -TaskName ${psq(winTaskName(c))}; 'OK'`;

/**
 * PowerShell 스크립트를 **인용 지옥 없이** 실행한다 — `-EncodedCommand`(UTF-16LE base64).
 * ★셸을 안 거치므로 경로의 공백·따옴표·`&` 가 인자를 깨뜨리지 않는다. 종전 윈도우 코드가
 *  겪은 사고 다수가 이 계열이었다(액션 문자열의 `&`·중첩 따옴표).
 * @param {string} script
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
/**
 * winPs 가 넘기는 인자 — 출력 인코딩 머리를 **반드시** 앞에 붙인다(회귀가 base64 를 풀어 확인한다).
 * @param {string} script
 * @returns {string[]}
 */
export const winPsArgs = (script) => [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(PS_UTF8_OUTPUT + script, "utf16le").toString("base64"),
];

/** @param {string} script */
const winPs = (script) => {
  const r = spawnSync(
    "powershell",
    winPsArgs(script),
    // ★**타임아웃을 건다** (2026-08-22, OpenClaw 참고). 종전엔 무제한이라 `schtasks`/
    //  PowerShell 이 먹통이 되면 **설치가 영원히 매달린다**. OpenClaw 가 그걸 겪고 조기
    //  포기 + 폴백을 넣었다("if schtasks itself wedges … aborts that path quickly").
    //  우리도 같은 부류를 오늘만 여러 번 봤다 — 실패보다 **조용한 무한 대기**가 나쁘다.
    { encoding: "utf8", timeout: WIN_PS_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  // 타임아웃이면 status 가 null 이라 성공 판정(=== 0)에 안 걸리지만, 이유가 안 보이면
  // 위쪽에서 "출력 없음" 으로만 남는다. 여기서 평문으로 만들어 준다.
  const timedOut = r.error !== undefined && /ETIMEDOUT|timed? ?out/i.test(String(r.error.message));
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: timedOut
      ? `PowerShell did not respond — gave up after ${WIN_PS_TIMEOUT_MS / 1000}s`
      : (r.stderr ?? "").trim() || (r.error === undefined ? "" : r.error.message),
  };
};

/**
 * 시작프로그램 폴더 폴백 경로 — 예약작업 생성이 **막힌 환경**(그룹정책)에서 쓴다.
 *
 * ★왜 필요한가 (2026-08-22, OpenClaw 참고): 회사 PC 처럼 예약작업 생성이 정책으로 막힌
 *  기계가 있다. 종전엔 거기서 install 이 실패하고 끝났다 — 자동시작이 **아예 없는** 상태.
 *  OpenClaw 는 같은 상황에서 시작프로그램 폴더로 폴백한다. 런처가 감독자를 띄우므로 죽은 데몬은
 *  되살아나지만, 감독자까지 죽으면 1분 반복이 없어 다음 로그온까지 안 뜬다 — 없는 것보다 훨씬 낫다.
 *
 * ★`.vbs` 를 둔다(`.cmd` 아님): 시작프로그램의 `.cmd` 는 콘솔 창을 띄운다. `.vbs` 는
 *  wscript 가 조용히 실행하고, 내용은 **정본 런처를 가리키기만** 한다(정의점 하나).
 * @param {Ctx} c
 * @returns {string | null} APPDATA 를 못 찾으면 null
 */
const winStartupVbsPath = (c) => {
  const appData = process.env.APPDATA?.trim();
  if (!appData) return null;
  return path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${c.label}.vbs`,
  );
};

/** 폴백 설치(멱등). 성공하면 경로, 실패하면 null. @param {Ctx} c */
const winWriteStartupFallback = (c) => {
  const p = winStartupVbsPath(c);
  if (p === null) return null;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    // 정본 런처(win-launch.vbs)를 그대로 부른다 — 내용 복제 금지(두 벌은 반드시 갈린다).
    writeVbs(
      p,
      [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Run "wscript.exe //B //Nologo ""${winVbsPath(c).replace(/"/g, '""')}""", 0, True`,
        "",
      ].join("\r\n"),
    );
    return p;
  } catch {
    return null;
  }
};

/**
 * 런처를 직접 띄운다 — 폴백 모드(예약작업 없음)에서 "지금 가동" 에 쓴다.
 * 숨김은 런처(VBS) 안의 windowStyle 0 이 책임진다.
 * @param {Ctx} c
 */
const winLaunchVbs = (c) =>
  spawnSync("wscript", ["//B", "//Nologo", winVbsPath(c)], {
    stdio: "ignore",
    windowsHide: true,
  });

/** 폴백 제거(멱등) — 예약작업이 살아나면 **반드시** 지운다(둘 다 있으면 두 개 뜬다). @param {Ctx} c */
const winRemoveStartupFallback = (c) => {
  const p = winStartupVbsPath(c);
  if (p === null || !existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
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
 *  - ★**콘솔 창은 숨김 런처(VBS)로 없앤다** (2026-08-22, 사용자 신고 → S4U 시도 → 철회).
 *    경위를 남긴다. 처음엔 액션을 `node` 직접 실행으로 두고 "창이 안 뜬다(최상위 창 전수
 *    열거 0개)" 고 적었는데 **거짓이었다** — SSH 세션에서 `EnumWindows` 를 돌렸고, 그
 *    자리에선 사용자 데스크톱의 창을 **원리적으로 볼 수 없다**(윈도우 스테이션이 다르다).
 *    실제로는 검은 터미널이 계속 떠 있었다.
 *    다음으로 `-LogonType S4U`(세션 0 → 창 없음)로 바꿨고 내 SSH 에선 잘 됐다. 그런데
 *    **실사용 경로에서 `액세스가 거부되었습니다`** 로 실패했다. 이분으로 원인을 좁혔다:
 *    인자 조합 7종 전부 제한 토큰에서 OK · 실제 작업 이름도 OK · 그런데 `daemon.mjs` 가
 *    중첩 spawn(task→powershell→node→powershell)으로 부르면 거부. 내 SSH 는 **관리자
 *    토큰**이라 계속 성공해서, 검증 환경이 실사용자보다 권한이 높다는 걸 늦게 알았다.
 *    → S4U 는 우리 호출 경로에서 신뢰할 수 없으므로 접는다.
 *  - ★그래서 `Interactive`(어디서나 성공·관리자 불요) + **`wscript` 숨김 런처**다.
 *    ★런처는 `sh.Run(cmd, 0, True)` 로 **기다린다** — 이게 핵심이다. 안 기다리면 wscript 가
 *    즉시 끝나 작업 인스턴스도 끝나고, 그러면 `IgnoreNew` 가 무효가 돼 1분마다 감독자가
 *    하나씩 더 뜬다. 기다리면 wscript 가 감독자만큼 살아 중복 방지가 그대로 성립한다.
 *  - Defender 가 이 등록을 막지 않는다. 오탐의 원인은 VBS 자체가 아니라 **런타임 작업
 *    생성 + `ping` 지연** 조합이었다(그건 이미 없앴다).
 *
 * 로그온 트리거 + 반복 트리거 둘 다 단다: 로그온하면 뜨고, 감독자까지 죽어도 1분 안에
 *  잡힌다. `-ExecutionTimeLimit 0` 이 없으면 기본 3일 후 작업이 강제 종료된다.
 * @param {Ctx} c
 * @returns {string}
 */
const buildWinTaskScript = (c) => {
  // 액션 = `wscript //B //Nologo <vbs>` — VBS 가 감독자를 **숨김으로** 띄우고 기다린다.
  //  `//B`(batch) = 스크립트 오류 대화상자 억제. 창은 VBS 안의 windowStyle 0 이 없앤다.
  const args = [`"${winVbsPath(c)}"`].join(" ");
  // ★실패 이유를 **stdout 으로** 낸다 (2026-08-22). `$ErrorActionPreference='Stop'` 만 두면
  //  예외가 stderr 로 가는데, powershell.exe 는 stderr 가 리다이렉트되면 오류를 **CLIXML 로
  //  직렬화**한다 — 실측 로그에 `(#< CLIXML` 만 남아 왜 실패했는지 알 수 없었다. 진단면이
  //  반쯤 막혀 있으면 없는 것과 같다. try/catch 로 잡아 한 줄 평문으로 내보낸다.
  return [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(`//B //Nologo ${args}`)} -WorkingDirectory ${psq(c.repoRoot)}`,
    `$atLogon = New-ScheduledTaskTrigger -AtLogOn -User ${psq(process.env.USERNAME ?? os.userInfo().username)}`,
    // 반복 트리거 = 바닥 그물. StartBoundary 를 과거로 둬서 등록 즉시 유효해진다.
    `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes 1)`,
    `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    // ★`Interactive` — 어디서나 등록되고 관리자 권한이 필요 없다(위 주석). 창은 principal 이
    //  아니라 **VBS 런처**가 없앤다. S4U 는 우리 호출 경로에서 거부돼 철회했다.
    `$principal = New-ScheduledTaskPrincipal -UserId ${psq(process.env.USERNAME ?? os.userInfo().username)} -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName ${psq(winTaskName(c))} -Action $action -Trigger $atLogon,$repeat -Settings $settings -Principal $principal -Force | Out-Null`,
    `'TASK_REGISTERED'`,
    `} catch { 'TASK_ERR: ' + $_.Exception.Message }`,
  ].join("\n");
};

/**
 * `netstat -ano` 출력에서 **정확히 이 포트**를 LISTEN 중인 PID (2026-10-08 외부 검토 F1).
 * ★종전엔 `l.includes(":3000")` 이라 `:30000` 도 걸렸다. 로컬 주소 칸(`0.0.0.0:3000`·`[::]:3000`)의 **마지막 `:` 뒤**를 비교한다.
 * @param {string} stdout
 * @param {number | string} port
 * @returns {string[]}
 */
export const parseNetstatListenerPids = (stdout, port) => {
  /** @type {Set<string>} */
  const pids = new Set();
  for (const l of String(stdout ?? "").split(/\r?\n/)) {
    const cols = l.trim().split(/\s+/);
    // TCP  <로컬>  <원격>  LISTENING  <PID>
    if (cols.length < 5 || !/^TCP/i.test(cols[0] ?? "") || !/^LISTENING$/i.test(cols[3] ?? "")) continue;
    const local = cols[1] ?? "";
    if (local.slice(local.lastIndexOf(":") + 1) !== String(port)) continue;
    const pid = cols[4] ?? "";
    if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
  }
  return [...pids];
};

/** bridge 포트를 정확히 LISTEN 중인 PID — **상태 표시·실행 여부 판정용**(종료 대상은 `selectWinKillTargets` 가 소유까지 본다). @param {Ctx} c */
const winListeningPids = (c) =>
  parseNetstatListenerPids(spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "", winPort(c));

/**
 * `Get-CimInstance Win32_Process … | ConvertTo-Csv` 출력 → `{ pid, cmd }`.
 * @param {string} csv
 * @returns {{ pid: string, cmd: string }[]}
 */
export const parseWinProcCsv = (csv) => {
  /** @type {{ pid: string, cmd: string }[]} */
  const out = [];
  for (const l of String(csv ?? "").split(/\r?\n/)) {
    const m = /^"?(\d+)"?,(.*)$/.exec(l.trim());
    if (m) out.push({ pid: m[1] ?? "", cmd: m[2] ?? "" });
  }
  return out;
};

/**
 * 멈출 PID — **이 인스턴스 것이라고 확인된 node 프로세스만** (2026-10-08 외부 검토 F1).
 *  ① 명령줄에 이 홈이 있는 데몬·감독자(`index.js`·`supervise`) — 한 기계의 여러 인스턴스를 가른다.
 *  ② bridge 포트를 정확히 LISTEN 중인 PID 중 **이 레포의 데몬 진입점을 실행하는 node** — 데몬 명령줄엔 홈이 없어(감독자가 env 로 넘긴다)
 *     포트로 찾는데, ★종전엔 포트만 보고 소유를 확인하지 않아 그 포트를 잡은 **다른 앱**(실측: Steam 이 3000)까지 `taskkill /F /T` 했다.
 * @param {{ netstat: string, procsCsv: string, port: number | string, home: string, repoRoot: string }} input
 * @returns {string[]}
 */
export const selectWinKillTargets = ({ netstat, procsCsv, port, home, repoRoot }) => {
  const procs = parseWinProcCsv(procsCsv);
  /** @type {Set<string>} */
  const out = new Set();
  const h = String(home ?? "").toLowerCase();
  for (const p of procs) {
    const low = p.cmd.toLowerCase();
    // ★**감독자도 센다** (2026-08-22). 종전엔 `index.js`(데몬)만 봐서 감독자가 살아남았고, 그게 곧바로 데몬을 되살려
    //  `npm ci` 가 네이티브 모듈을 못 지웠다(`EPERM: unlink better_sqlite3.node`). 멈춘다는 건 **되살릴 것까지 멈추는 것**이다.
    if (!low.includes("index.js") && !low.includes("supervise")) continue;
    if (h !== "" && !cmdlineHasHome(p.cmd, h)) continue;
    out.add(p.pid);
  }
  const ours = new Map(procs.map((p) => [p.pid, p.cmd]));
  for (const pid of parseNetstatListenerPids(netstat, port)) {
    const cmd = ours.get(pid);
    if (cmd === undefined) continue; // node 가 아니다 — 다른 앱
    if (!/index\.(js|ts)\b/i.test(cmd) || !cmdlineHasHome(cmd, repoRoot)) continue; // 이 레포의 데몬이 아니다
    out.add(pid);
  }
  return [...out];
};

/** 실행 중 node 프로세스 명령줄 조회 인자 — 출력 인코딩 머리가 앞에 붙는다(회귀가 확인한다). @returns {string[]} */
export const winProcQueryArgs = () => [
  "-NoProfile",
  "-Command",
  PS_UTF8_OUTPUT +
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation",
];

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
/**
 * bridge 포트를 쥔 **node 데몬**(진입점 `index.js`/`index.ts`) — 경로가 이 레포 것인지 **모르는 것까지**.
 * ★종료 대상이 아니라 «아직 남았나» 판정용이다 (2026-10-08 적대 검토 P3). 상대경로로 띄운 데몬(`npm start`)·8.3 짧은 이름은
 *  소유를 확인 못 해 안 죽이는데, 그때 «✅ stopped» 라고 하면 거짓이다 — 업데이트가 npm ci 로 가서 잠금에 부딪힌다.
 * @param {{ netstat: string, procsCsv: string, port: number | string }} input
 * @returns {string[]}
 */
export const winPortDaemonPids = ({ netstat, procsCsv, port }) => {
  const procs = new Map(parseWinProcCsv(procsCsv).map((p) => [p.pid, p.cmd]));
  return parseNetstatListenerPids(netstat, port).filter((pid) => /index\.(js|ts)\b/i.test(procs.get(pid) ?? ""));
};

/** @param {Ctx} c */
const winScan = (c) => {
  const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "";
  const procsCsv = spawnSync("powershell", winProcQueryArgs(), { encoding: "utf8" }).stdout ?? "";
  const port = winPort(c);
  return {
    targets: selectWinKillTargets({ netstat, procsCsv, port, home: String(c.homeRaw ?? ""), repoRoot: c.repoRoot }),
    portDaemons: winPortDaemonPids({ netstat, procsCsv, port }),
  };
};

/**
 * 실행 중 데몬 종료 — 포트 PID + 명령줄 PID **합집합**. 반환값 = 죽인 뒤에도 남은 PID.
 * ★호출부는 이 반환을 보고 보고해야 한다(빈 배열이어야 `✅`). 종전엔 결과를 안 보고
 *  무조건 성공을 찍었다.
 * @param {Ctx} c
 * @returns {string[]}
 */
const winKillRunning = (c) => {
  const first = winScan(c);
  const targets = new Set(first.targets);
  for (const pid of targets)
    spawnSync("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore" });
  // ★남은 것 = 죽이려던 것 중 아직 사는 것 + 포트를 아직 쥔 node 데몬(소유를 확인 못 해 안 죽인 것 포함 — 거짓 «✅» 금지).
  //  종료는 비동기다 — **몇 번** 다시 센다(2026-10-08 적대 검토 P1: 한 번만 보고 실패로 치면, 늦게 죽는 데몬이 «실패» 로 남는다).
  /** @param {{ targets: string[], portDaemons: string[] }} scan */
  const survivorsOf = (scan) => [...new Set([...scan.targets.filter((p) => targets.has(p)), ...scan.portDaemons])];
  let survivors = survivorsOf(first);
  if (targets.size === 0) return survivors;
  for (let i = 0; i < 6; i++) {
    spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 900"], { stdio: "ignore" });
    survivors = survivorsOf(winScan(c));
    if (survivors.length === 0) break;
  }
  return survivors;
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
    console.log(`   Removed the old autostart — HKCU Run\\${c.label} (replaced by a scheduled task)`);
  }
  // ★VBS 는 **지우지 않는다** — 예약작업의 액션이 이걸 실행한다(창 숨김). 한때 지웠는데
  //  (액션을 node 직접 실행으로 바꿨을 때) 그 구성은 콘솔 창이 떠서 철회했다. 내용은
  //  `winEnsureTask` 가 매번 다시 쓴다(경로·런타임이 바뀌어도 수렴).
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
 * @param {{ capture?: boolean }} [opts] capture = 셸에서만 준 인스턴스 값을 붙잡는다 — **`install` 만** 준다(아래 주석).
 * @returns {true | "fallback" | false} true=예약작업 정상 · "fallback"=시작프로그램(감독자만 — 1분 반복 없음) · false=둘 다 실패
 */
const winEnsureTask = (c, opts = {}) => {
  winRemoveLegacyAutostart(c);
  // ★런처를 **먼저** 쓴다 — 작업 액션이 이 파일을 가리키므로, 없으면 등록은 성공하고
  //  실행만 조용히 실패한다(2026-08-15 에 겪은 바로 그 형상: "런처가 없는데 성공 보고").
  //  매번 다시 써서 경로·런타임 변경에도 수렴시킨다.
  mkdirSync(c.homeAbs, { recursive: true });
  // ★셸 값은 **사람이 셸에서 설치할 때만** 붙잡는다 (2026-10-05 재검토 P1). start·update 는 저장하지 않는다 — 위임
  //  `/update`·재기동의 환경은 데몬이 부팅 때 `.env` 를 올려 둔 것이라, 그걸 저장하면 `.env` 에서 지운 값이 «셸에서
  //  준 값» 으로 둔갑해 영구히 되살아났다(실측: 지운 DASHBOARD_HOST=0.0.0.0 이 업데이트마다 다시 박힘). 저장본은
  //  이미 홈에 있고 감독자가 기동마다 읽으므로 다시 쓸 이유가 없다.
  if (opts.capture === true) {
    warnWinServiceToken(c);
    saveWinServiceEnv(c);
  }
  writeVbs(winVbsPath(c), buildWinVbs(c));
  // ★**돌고 있으면 먼저 멈춘다** (2026-08-22, /update 실측으로 잡음). 작업이 실행 중이면
  //  `Register-ScheduledTask -Force` 가 실패해 수렴이 조용히 건너뛰어진다. 실제로 갱신
  //  도중 **1분 반복 트리거가 데몬을 되살려** 작업이 돌고 있었고, 그래서 등록이 옛
  //  `Interactive` 그대로 남아 터미널이 계속 떴다(사용자 화면으로 확인).
  //  멈춤은 멱등이고, 호출부가 곧바로 Enable+Start 하므로 여기서 멈춰도 손해가 없다.
  winPs(
    `Disable-ScheduledTask -TaskName ${psq(winTaskName(c))} -EA SilentlyContinue | Out-Null; ` +
      `Stop-ScheduledTask -TaskName ${psq(winTaskName(c))} -EA SilentlyContinue`,
  );
  const r = winPs(buildWinTaskScript(c));
  if (r.status === 0 && r.stdout.includes("TASK_REGISTERED")) {
    // ★예약작업이 살아났으면 폴백은 **반드시 걷는다** — 둘 다 있으면 로그온 때 두 개 뜬다
    //  (HKCU Run 잔재와 같은 부류의 사고). 정상 경로가 복구되면 안전망은 치운다.
    if (winRemoveStartupFallback(c)) {
      console.log(`   Removed the Startup-folder fallback — the scheduled task works, so it is no longer needed.`);
    }
    return true;
  }
  const exists =
    spawnSync("schtasks", ["/query", "/tn", winTaskName(c)], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0;
  // ★이유는 **양쪽 갈래에서 다 찍는다** (2026-08-22). 종전엔 "기존 등록이 있을 때" 만
  //  찍어서, 작업이 아예 없는 첫 등록이 실패하면 `🔴 등록 실패` 만 남고 **왜인지가 사라졌다**
  //  (실측: 제한 토큰 install 이 그렇게 실패했고 이유를 못 봤다). 실패를 말하면서 원인을
  //  안 주는 로그는 진단면이 아니다. stdout 우선 — 스크립트가 `TASK_ERR: …` 평문을 낸다
  //  (stderr 는 powershell 이 CLIXML 로 감싼다).
  const why = r.stdout || r.stderr || "no output";
  if (exists) {
    console.warn(`   ⚠ Could not re-register the scheduled task — continuing with the existing registration (${why}).`);
    return true;
  }
  console.error(`   Scheduled task registration failed: ${why}`);
  // ★**폴백** — 예약작업이 막힌 환경(그룹정책)에서 자동시작까지 잃지 않는다.
  //  1분 반복(감독자 부활)은 포기하지만 로그온 자동시작과 감독자는 살아남는다. 그 대가를 **말한다** —
  //  조용히 열등한 모드로 돌면 사용자는 죽어도 모른다.
  const fb = winWriteStartupFallback(c);
  if (fb !== null) {
    console.warn(
      `   ↪ Falling back to the Startup folder — ${fb}\n` +
        `     It starts at logon, and the supervisor restarts the daemon if it dies — **but if the supervisor itself dies, nothing comes back until the next logon**\n` +
        `     (the scheduled task's 1-minute repeat can't be set up). Once the policy is lifted, run install again.`,
    );
    return "fallback";
  }
  return false;
};

/** @param {Ctx} c */
const winInstall = (c) => {
  mkdirSync(c.logsDir, { recursive: true });
  const mode = winEnsureTask(c, { capture: true });
  if (mode === false) {
    console.error(`🔴 Autostart registration failed (${winTaskName(c)}).`);
    console.error(
      "   Neither a scheduled task nor the Startup folder can be used — check with your administrator, or use WSL2.",
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "fallback") {
    console.log(`Registered autostart in the Startup folder (fallback). TIGUCLAW_HOME=${c.homeRaw}`);
    winLaunchVbs(c); // 예약작업이 없으니 런처를 직접 띄운다.
  } else {
    console.log(
      `Registered the KeepAlive scheduled task (no admin rights needed). TIGUCLAW_HOME=${c.homeRaw}`,
    );
    console.log(
      "   If the daemon dies, the supervisor restarts it immediately; if the supervisor dies too, the 1-minute repeat trigger brings it back (two layers).",
    );
    // Enable 이 먼저다 — 재등록이 실패해 기존 등록으로 진행하면 winEnsureTask 가 걸어 둔 Disable 이 남는다
    //  (2026-10-03 적대 검토 G — winStart 는 이미 그렇게 한다).
    const run = winPs(
      winEnableStartScript(c),
    );
    if (run.status !== 0) {
      console.error(`   ⚠ Could not start it right away — ${run.stderr || run.stdout}`);
    }
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "installed",
    `  Check task: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  Logs: ${path.join(c.homeAbs, "logs")}`,
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
  // 폴백도 함께 걷는다 — 안 지우면 uninstall 후에도 로그온마다 되살아난다.
  if (winRemoveStartupFallback(c)) console.log(`   Removed the Startup-folder fallback.`);
  rmSync(winVbsPath(c), { force: true });
  console.log(`✅ Unregistered (removed the scheduled task and launcher, ${c.label}).`);
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
      `🔴 restart failed — the running daemon did not stop (PID ${survived.join(", ")}). ` +
        `Not starting a new one (to avoid running two). End that PID in Task Manager, or reboot, then try again.`,
    );
    process.exitCode = 1;
    return;
  }
  // Enable 이 먼저다 — winStopTask 가 비활성화했으므로 그대로 Start 하면 안 뜬다.
  const r = winPs(
    winEnableStartScript(c),
  );
  if (r.status !== 0) {
    console.error(
      `🔴 restart failed — could not start the scheduled task: ${r.stderr || r.stdout}. ` +
        `Check that it is still registered: schtasks /query /tn "${winTaskName(c)}"`,
    );
    process.exitCode = 1;
    return;
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge, 20000, 1500),
    "restarted",
    `  Check task: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  Logs: ${path.join(c.homeAbs, "logs")}`,
  );
};

// stop = 실행만 중지(bridge 포트 PID kill), Run 키·VBS(등록) 유지 (D3).
// 포트 미LISTEN 시 대상 못 찾을 수 있음(기존 status/restart 와 동일 한계 — ADR U3).
/** @param {Ctx} c */
const winStop = (c) => {
  const survived = winStopTask(c);
  if (survived.length > 0) {
    console.error(
      `🔴 stop failed — still running (PID ${survived.join(", ")}). ` +
        `Running npm ci or an update now will fail on file locks (EPERM).`,
    );
    process.exitCode = 1;
    return false;
  }
  console.log(`✅ stopped (still registered — resume with: npm run daemon:start). ${c.label}`);
  return true;
};

/**
 * 예약작업을 다시 **켜기만** 한다(띄우지 않는다) — 업데이트가 중지 실패로 멈출 때. 남은 데몬이 포트를 쥔 동안 새 감독자는
 * 크래시 스로틀에 머물고, 그 데몬이 죽으면 1분 반복 트리거가 되살린다.
 * @param {Ctx} c
 */
const winReenable = (c) => {
  const r = winPs(`Enable-ScheduledTask -TaskName ${psq(winTaskName(c))} | Out-Null; 'OK'`);
  if (r.status !== 0 || !/OK/.test(r.stdout)) {
    console.error(`⚠ could not re-enable the scheduled task — run: schtasks /change /tn "${winTaskName(c)}" /enable`);
  }
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
  const mode = winEnsureTask(c);
  if (mode === false) {
    console.error(
      `daemon start: autostart registration failed (${winTaskName(c)}) — run \`tiguclaw install\` to repair it.`,
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "fallback") {
    winLaunchVbs(c); // 예약작업이 없는 환경 — 런처를 직접 띄운다.
  } else {
    // Enable 이 먼저다 — `stop` 이 비활성화해 뒀다(winStopTask 주석 참조).
    const r = winPs(
      winEnableStartScript(c),
    );
    if (r.status !== 0) {
      console.error(`daemon start: could not start the scheduled task — ${r.stderr || r.stdout}`);
      process.exitCode = 1;
      return;
    }
  }
  reportLaunch(
    c,
    waitForListening(c, listeningOnBridge),
    "started",
    `  Check task: schtasks /query /tn "${winTaskName(c)}"\n` +
      `  Logs: ${path.join(c.homeAbs, "logs")}`,
  );
};

/** @param {Ctx} c */
const winStatus = (c) => {
  const t = winPs(
    `$t = Get-ScheduledTask -TaskName ${psq(winTaskName(c))} -ErrorAction SilentlyContinue; ` +
      `if ($t) { 'task=' + $t.State } else { 'task=none' }`,
  );
  console.log(`registered (scheduled task ${winTaskName(c)}): ${t.stdout || "unknown"}`);
  // 마이그레이션 잔재가 남아 있으면 **중복 기동 위험**이라 눈에 띄게 알린다.
  if (winReg(["query", RUN_KEY, "/v", c.label]).status === 0) {
    console.log(
      `⚠ An old HKCU Run entry is still present — two daemons will start at logon. Run 'install' again to clean it up.`,
    );
  }
  const pids = winListeningPids(c);
  if (pids.length > 0) {
    console.log(`running: yes (pid ${pids.join(", ")}, port ${winPort(c)})`);
  } else {
    console.log(
      `running: unknown (port ${winPort(c)} not listening — look for node in Task Manager)`,
    );
  }
};

/** @param {Ctx} c */
const winPrint = (c) => {
  console.log(
    "# Windows: KeepAlive scheduled task (no admin rights needed) — logon trigger + 1-minute repeat (safety net)",
  );
  console.log(`# Task name: ${winTaskName(c)}`);
  console.log(`#   Action = wscript.exe //B //Nologo "${winVbsPath(c)}"`);
  console.log(`#   The launcher (VBS) starts the supervisor **without a window** and waits on it — waiting keeps`);
  console.log(`#   the task instance alive, which is what makes IgnoreNew (no duplicates) work.`);
  console.log(`#   The supervisor starts the daemon and restarts it when it dies (same as launchd KeepAlive).`);
  console.log("# --- Launcher VBS ---");
  console.log(buildWinVbs(c));
  console.log("# --- Registration script ---");
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
    console.log(`No log file yet: ${file}`);
    console.log(
      "The daemon may never have run, or the date may have rolled over. " +
        "Check whether it is running with npm run daemon:status.",
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

  console.log(`\n── follow: ${file} (Ctrl-C to quit) ──`);
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

  /**
   * 데몬 기동 환경 — **기동마다 다시 계산**한다(윈도우). 감독자 자신의 환경을 그대로 물려주면 감독자가 뜬 순간의 값이
   * 굳어, 홈 `.env` 를 고친 뒤 `/restart` 해도 옛 값으로 떴다. 붙잡은 값 중 무엇을 썼는지는 키 이름만 남긴다(원격 진단).
   * @returns {NodeJS.ProcessEnv}
   */
  const childEnv = () => {
    if (process.platform !== "win32" || c.launchEnv === undefined) return process.env;
    try {
      const env = winLaunchEnv(c.launchEnv, c.homeAbs);
      const applied = WIN_SERVICE_ENV_KEYS.filter((k) => env[k] !== c.launchEnv?.[k]);
      if (applied.length > 0) log(`start env from win-service-env.json: ${applied.join(", ")} (the home .env overrides these)`);
      return env;
    } catch (error) {
      log(`★win-service-env.json unreadable — starting without it (${String(error)})`);
      return c.launchEnv;
    }
  };

  const spawnOnce = () => {
    const startedAt = Date.now();
    child = spawn(exe, rest, {
      cwd: c.repoRoot,
      env: {
        ...childEnv(),
        TIGUCLAW_HOME: c.homeRaw,
        TIGUCLAW_RUNTIME: c.runtime,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    log(`daemon started pid=${child.pid} runtime=${c.runtime} home=${c.homeRaw}`);
    child.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      child = null;
      if (stopping) {
        log(`supervisor stop requested — not restarting (code=${code} signal=${signal})`);
        process.exit(0);
      }
      // ★수치를 싣는다 — 로그가 1차 진단면이라 "얼마나 살았나" 가 크래시루프 판정의
      //  근거다. 증상만 적으면 원격 기계(회사 PC·윈도우)에서 추론에 의존하게 된다.
      if (uptimeMs < MIN_UPTIME_MS) {
        consecutiveCrashes += 1;
        log(
          `daemon exited after ${Math.round(uptimeMs / 1000)}s (code=${code} signal=${signal}) — ` +
            `${consecutiveCrashes} in a row · restarting in ${THROTTLE_MS / 1000}s (throttled)`,
        );
        setTimeout(spawnOnce, THROTTLE_MS);
        return;
      }
      consecutiveCrashes = 0;
      log(
        `daemon exited (code=${code} signal=${signal}, up ${Math.round(uptimeMs / 1000)}s) — restarting now`,
      );
      spawnOnce();
    });
  };

  log(`supervisor started — label=${c.label}`);
  spawnOnce();
};

// ───────────────────────────── dispatch ─────────────────────────────────────

/** @typedef {"install" | "uninstall" | "restart" | "stop" | "start" | "status" | "logs" | "print" | "update" | "supervise"} Cmd */

/**
 * ★`stop` 은 **멈췄는지** 를 돌려준다(true/false) — 업데이트가 그걸 보고 설치 전에 멈춘다(2026-10-08 외부 검토 F2).
 * @type {Record<string, Record<string, (c: Ctx) => void | boolean> | undefined>}
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
    reenable: winReenable,
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

  // notify 없는 dashboard 위임도 stdio가 버려진다. 모든 실행에 진단 로그를 남긴다.
  // 자식 출력은 최대 32MB를 받아 비밀을 지운 뒤 저장한다. 터미널에는 단계 종료 때도 출력한다.
  // 로그를 열 수 없으면 변경 전에 실패한다. notify는 통지 마커만 결정한다.
  const delegated = !!process.env.TIGUCLAW_UPDATE_NOTIFY_CHANNEL;
  // 대시보드는 notify 없이 위임한다. 로그 수명은 알림 목적지와 무관하다.
  /** @type {number | null} */
  let logFd = null;
  /** @type {string | null} */
  let updateLogPath = null;
  {
    try {
      const logsDir = path.join(c.homeAbs, "logs");
      mkdirSync(logsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      updateLogPath = path.join(logsDir, `update-${stamp}.log`);
      logFd = openSync(updateLogPath, "a");
      /** @type {(orig: (...args: unknown[]) => void, level: string) => (...a: unknown[]) => void} */
      const tee = (orig, level) => (...a) => {
        try {
          writeSync(logFd ?? 2, `[${new Date().toISOString()}] [${level}] ${redactUpdateLog(a.join(" "))}\n`);
        } catch {
          /* 파일 기록 실패해도 콘솔은 낸다 */
        }
        orig(...a);
      };
      console.log = tee(console.log.bind(console), "log");
      console.error = tee(console.error.bind(console), "err");
      // ★`warn` 도 가로챈다 (2026-08-22). 종전엔 log·error 만 대고 warn 은 빠져 있었는데,
      //  위임 실행은 stdio 가 버려지므로 **경고가 통째로 증발**했다. 실제로 "예약작업
      //  재등록 실패 — 기존 등록으로 진행합니다" 가 어디에도 안 남아, 등록이 왜 안 바뀌는지
      //  로그만으로는 알 수 없었다. 진단면에 구멍이 있으면 그 경로는 없는 것과 같다.
      console.warn = tee(console.warn.bind(console), "warn");
    } catch (error) {
      console.error(`update: cannot open the diagnostic log, aborting — ${redactUpdateLog(String(error))}`);
      // 위임이면 호출자가 이미 pull 했다 — 코드만 새것인 채로 두면 다음 `/update` 가 «이미 최신» 으로 끝난다.
      const handoff = process.env.TIGUCLAW_UPDATE_PREV_SHA?.trim();
      if (handoff !== undefined && /^[0-9a-f]{7,40}$/i.test(handoff)) {
        spawnSync("git", ["reset", "--keep", handoff], { cwd: c.repoRoot, stdio: "ignore" });
      }
      process.exitCode = 1;
      return;
    }
  }

  // 실패 마커 — 롤백 전에 써서, 재가동한 데몬이 부팅 시 소비해 요청자에게 "❌ 실패" 통지.
  //   notify env 없으면(터미널 직접) 안 씀(오탐 0). UPDATE_FAILED_MARKER=".update-failed" 리터럴
  //   (dep-free 라 import 불가 — self-update.ts 상수와 동기).
  // ★`outcome` = 실제로 일어난 일 (2026-10-05 적대 검토). 통지가 늘 «이전 판으로 되돌리고 다시 띄웠다» 라고 말했는데,
  //  손대기 전에 멈춘 경로·롤백을 건너뛴 경로에선 거짓이었다. unchanged = 아무것도 안 바뀜(데몬은 그대로) ·
  //  rolled-back = 이전 판으로 되돌리고 다시 띄움 · needs-check = 되돌리기를 못 했거나 일부만 했다.
  /** @type {(stage: string, detail: string, outcome: "unchanged" | "rolled-back" | "needs-check") => void} */
  const writeFailedMarker = (stage, detail, outcome) => {
    if (!delegated) return;
    try {
      writeFileSync(
        path.join(c.homeAbs, ".update-failed"),
        `${JSON.stringify(
          {
            stage,
            outcome,
            detail: redactUpdateLog(String(detail ?? "")).slice(0, 500),
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

  // spawnSync 래퍼 — 자식 stdout/stderr를 비밀 제거 후 진단 로그에 보관한다.
  //   cwd=repoRoot. npm 은 Windows 에서 npm.cmd(배치)라
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
      stdio: logFd !== null ? "pipe" : "inherit",
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: opts.shell ?? false,
    });
    if (logFd !== null) {
      const output = redactUpdateLog([r.stdout, r.stderr, r.error?.message].filter(Boolean).join("\n"));
      writeSync(logFd, output + "\n");
      if (!delegated && output) process.stdout.write(output + "\n");
    }
    console.log(`   step: ${cmd} ${args.join(" ")} → exit ${r.status ?? 1}`);
    return r.status ?? 1;
  };

  // ── 단계 1: 배너 ────────────────────────────────────────────────────────────
  console.log("── tiguclaw update (dep-free) ──");
  console.log(`   runtime=${c.runtime} · home=${c.homeRaw} · label=${c.label}`);
  console.log(
    "   Hint: run with the same env as at install time (TIGUCLAW_HOME/TIGUCLAW_RUNTIME/TIGUCLAW_SERVICE_LABEL)",
  );
  console.log("         so the right instance gets updated.");

  // ── 단계 2: prevSha capture (롤백 앵커) ──────────────────────────────────────
  const prev = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: c.repoRoot,
    encoding: "utf8",
  });
  if (prev.status !== 0 || !(prev.stdout ?? "").trim()) {
    console.error("update: not a git repository, or git is not installed — cannot update.");
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
  const headAtStart = prev.stdout.trim();
  const prevSha =
    handoffSha !== undefined && /^[0-9a-f]{7,40}$/i.test(handoffSha)
      ? handoffSha
      : headAtStart;
  // 위임이면 호출자(데몬)가 **이미 pull 했다** — HEAD 는 새것인데 돌고 있는 빌드는 옛것이다.
  const pulledByCaller = !headAtStart.startsWith(prevSha) && !prevSha.startsWith(headAtStart);
  const table = handlers[process.platform];

  /**
   * 데몬을 멈추기 **전**에 그만둘 때. ★위임이면 HEAD 를 되돌린다 (2026-10-05 적대 검토) — 안 그러면 코드만 새것이고
   *  빌드는 옛것으로 굳고, 다음 `/update` 는 «이미 최신» 이라며 아무것도 안 해 **업데이트가 영영 안 됐다.**
   *  그리고 위임이면 데몬을 다시 띄운다 — 실패 통지는 부팅 때 마커를 읽어 나가므로, 안 띄우면 «업데이트 중» 뒤 침묵이다.
   * @param {string} stage @param {string} detail @param {{ restart?: boolean, revert?: boolean }} [opts] revert = 이 CLI 가 받은 새 코드도 되돌린다
   */
  const abortBeforeStop = (stage, detail, opts = {}) => {
    /** @type {"unchanged" | "needs-check"} */
    let outcome = "unchanged";
    // 코드가 이미 새 판이면(위임 업데이트가 먼저 pull 했거나, 이 CLI 가 pull 한 뒤 멈추는 경우) 돌고 있는 빌드로 되돌린다.
    if (pulledByCaller || opts.revert === true) {
      if (run("git", ["reset", "--keep", prevSha]) === 0) console.error(`update: returned the code to ${prevSha.slice(0, 7)} (the running build).`);
      else {
        outcome = "needs-check";
        console.error(`update: could not return the code to ${prevSha.slice(0, 7)} — run \`tiguclaw update\` in a terminal.`);
      }
    }
    writeFailedMarker(stage, detail, outcome);
    if (delegated && opts.restart !== false && isDaemonRunning(c)) table?.restart?.(c);
    process.exitCode = 1;
  };

  // 손상된 Windows 저장본 — 라벨·포트가 틀릴 수 있으니 **아무 인스턴스도 건드리지 않는다**(재가동도 안 한다).
  if (isWin && c.winEnvError !== undefined) {
    console.error(`update: ${c.winEnvError} — fix or delete it, then run this again.`);
    abortBeforeStop("startup environment", c.winEnvError, { restart: false });
    return;
  }

  // ── 단계 3: lock 드리프트 선폐기(생성물 한 파일만) ──────────────────────────
  // package-lock.json 은 npm 이 재생성하는 *생성물*이라 플랫폼·npm 버전차로 로컬이 쉽게 더러워지고, 그게 ff-only
  //   pull 을 막아 갱신이 영영 깨진다(Windows 실사고 `e7e8716a`, self-update.ts 동일 근거). ★2026-10-05 에 한 번
  //   «lock 도 사용자 편집일 수 있다» 며 지웠다가 되살렸다 — 우리 `npm install` 이 다시 쓴 lock 을 사용자 편집으로
  //   읽어 업데이트를 **영구히** 거절했다. 다른 추적 파일의 미커밋 변경은 아래에서 그대로 거절한다(암묵 파괴 0).
  run("git", ["checkout", "--", "package-lock.json"]);
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: c.repoRoot, encoding: "utf8",
  });
  if (dirty.status !== 0 || dirty.stdout.trim() !== "") {
    const files = (dirty.stdout ?? "").split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    const named = files.length > 0 ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3} more)` : ""}` : "";
    console.error(`update: uncommitted changes found${named}, or the status check failed — leaving your files untouched and stopping.`);
    abortBeforeStop("git status", `uncommitted changes${named}, or the status check failed`);
    return;
  }
  // ★시작 환경은 여기서 저장하지 않는다 — 셸 값은 `install` 때만 붙잡는다(winEnsureTask 주석). 위임 업데이트의 환경은
  //  데몬이 `.env` 를 올려 둔 것이라 저장하면 `.env` 에서 지운 값이 되살아난다.

  // ── 단계 4: git pull --ff-only ──────────────────────────────────────────────
  if (run("git", ["pull", "--ff-only"]) !== 0) {
    // 실패(로컬 미커밋 진짜 변경·충돌·detached) → 정직 실패. pull 은 원자적이라 작업트리를
    //   보존(부분 적용 0). 자동 stash/merge 는 파괴적·암묵이라 안 함(§1·O1).
    console.error(
      "update: pull failed because of local uncommitted changes or a conflict — check manually (git status).",
    );
    abortBeforeStop("git pull", "pull failed because of local uncommitted changes or a conflict");
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
    console.log("   No code changes — refreshing dependencies and build only.");
  }

  const wasRunning = isDaemonRunning(c);

  /**
   * 데몬을 멈춘 **뒤**의 실패 — 이전 판으로 되돌리고, 실제로 된 만큼을 마커에 적은 뒤 다시 띄운다.
   * ★마커를 재가동 **전**에 쓴다 — 다시 뜬 데몬이 부팅 때 읽어 통지한다.
   * ★되돌리기를 못 해도 데몬은 다시 띄운다 — 멈춘 채 두면 사용자에겐 «비서가 죽었다» 다(Windows 는 예약작업이
   *  1분마다 어차피 다시 띄운다). --keep 은 실행 전 변경을 확인한다 — 업데이트 중 생긴 작업을 지우지 않는다.
   * @param {string} stage @param {string} detail
   */
  const rollback = (stage, detail) => {
    run("git", ["checkout", "--", "package-lock.json"]); // 생성물 — npm 이 다시 썼을 수 있다(위 단계 3과 같은 근거).
    /** @type {"rolled-back" | "needs-check"} */
    let outcome = "needs-check";
    let startIt = wasRunning;
    const state = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: c.repoRoot, encoding: "utf8",
    });
    if (state.status !== 0 || state.stdout.trim() !== "") {
      console.error("update: rollback skipped — new uncommitted changes, or the status check failed. Please check manually.");
    } else if (run("git", ["reset", "--keep", prevSha]) !== 0) {
      console.error("update: rollback failed — your files were left as they are. Please check manually.");
    } else if (run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev", "--ignore-scripts=false"], { shell: isWin }) !== 0) {
      console.error("update: could not restore dependencies during rollback — not restarting the daemon.");
      startIt = false; // 의존성이 깨진 채 띄우면 부팅마다 죽는다.
    } else if (c.runtime === "built" && (run("npm", ["run", "build:prod"], { shell: isWin }) !== 0 || !existsSync(c.distEntry))) {
      // ★빌드도 이전 판으로 다시 한다 (2026-10-05 재검토 P2). 실패한 빌드가 새 코드의 `.js` 를 이미 dist 에 써 두었을 수
      //  있다(tsc 는 타입 오류에도 내보낸다) — 다시 안 만들면 «이전 판으로 되돌렸다» 가 거짓이고 옛 의존성과 새 dist 가 섞인다.
      console.error("update: could not rebuild the previous version during rollback — check manually.");
    } else {
      outcome = "rolled-back";
    }
    writeFailedMarker(stage, detail, outcome);
    if (startIt) table?.start?.(c);
  };

  // ── 단계 5: (돌고 있으면) 데몬 정지 — npm ci 전에 네이티브 모듈 락 해제(EPERM 방지) ──
  if (wasRunning) {
    console.log("   Stopping the daemon for npm ci (brief downtime).");
    // ★멈추지 못했으면 **설치 전에** 그만둔다 (2026-10-08 외부 검토 F2). 종전엔 반환을 안 봐서, Windows 에서 데몬이 살아 있는
    //  채로 `npm ci` 가 돌아 네이티브 모듈 잠금(EPERM)에 부딪혔다. 받은 코드는 돌고 있는 빌드로 되돌린다(데몬은 그대로 돈다).
    if (table?.stop?.(c) === false) {
      console.error("update: the running daemon did not stop — not installing (its files are still locked).");
      // ★stop 이 먼저 예약작업을 껐다 — 그대로 두면 남은 데몬이 나중에 죽거나 감독자만 죽었을 때 **다시 뜨지 않는다**
      //  (2026-10-08 적대 검토 P1: «업데이트 중» 뒤 조용히 비서를 잃는다). 다시 **켜기만** 한다 — 띄우면 남은 데몬과 둘이 된다.
      table?.reenable?.(c);
      abortBeforeStop("stop", "the running daemon did not stop", { restart: false, revert: true });
      return;
    }
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
    console.error("update: npm ci failed — rolling back.");
    rollback("npm ci", "npm ci failed (dependency install)");
    console.error("update: failed. See the log above for the rollback and restart results. exit 1.");
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
    console.log("   The native module won't load — rebuilding it (npm rebuild).");
    run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], { shell: isWin });
    if (!nativeOk()) {
      console.error(
        [
          "update: cannot load the SQLite native module — rolling back.",
          "   Left like this, the daemon would crash on every boot.",
          "   You may need build tools — Windows: Visual Studio Build Tools (C++ workload),",
          "   Linux: build-essential + python3, macOS: xcode-select --install",
        ].join("\n"),
      );
      rollback("native", "could not load the better-sqlite3 native module");
      console.error("update: failed. See the log above for the rollback and restart results. exit 1.");
      process.exitCode = 1;
      return;
    }
    console.log("   Native module repaired.");
  }

  // ── 단계 7: 빌드(built 런타임만) ───────────────────────────────────────────
  if (c.runtime === "built") {
    if (
      run("npm", ["run", "build:prod"], { shell: isWin }) !== 0 ||
      !existsSync(c.distEntry)
    ) {
      console.error("update: build failed (no entry point produced) — rolling back.");
      rollback("build", "build:prod failed or did not produce the entry point (dist/src/index.js)");
      console.error("update: failed. See the log above for the rollback and restart results. exit 1.");
      process.exitCode = 1;
      return;
    }
  } else {
    // source 런타임은 tsx 로 src 를 직접 구동 — dist 불요(daemon.mjs 철학 정합).
    console.log("   source runtime — skipping the build (src runs directly under tsx).");
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
    console.log("   The daemon is not registered — run 'tiguclaw install' to start it.");
  } else {
    console.log("   The daemon was not running — start it with 'tiguclaw start'.");
  }

  // ── 단계 9: 결과 요약 ───────────────────────────────────────────────────────
  // ★기동 실패를 받고도 ✅ 를 찍지 않는다 (2026-08-15 2차, 적대 검토 P11). `reportLaunch`
  //  를 정직하게 만든 커밋의 이득이 **바로 이 호출부에서 상쇄되고 있었다** — 화면 마지막
  //  줄이 "가동 재개" 라 그게 결론으로 읽힌다. 윈도우 93분 사망 사고의 사용자 체감이
  //  (성공 메시지 + 죽은 데몬) 문자 그대로 재현 가능했다. `start` 가 exitCode 1 을 세웠으면
  //  코드는 적용됐어도 **재가동은 실패**라고 말한다.
  if (process.exitCode === 1) {
    console.error(
      `🔴 The update was applied, but **the daemon failed to restart**: ` +
        `${prevSha.slice(0, 7)} → ${newSha.slice(0, 7)} (runtime=${c.runtime}).\n` +
        `   Check the error above and start it manually — it will not come back on its own.`,
    );
    return;
  }
  console.log(
    `✅ update complete: ${prevSha.slice(0, 7)} → ${newSha.slice(0, 7)} ` +
      `(runtime=${c.runtime}). Daemon resumed.`,
  );
};

/**
 * @param {Ctx} c
 * @param {string} cmd
 */
const unsupported = (c, cmd) => {
  console.log(
    `daemon: automatic ${cmd} is not supported on this OS (${process.platform}) — supported: darwin/linux/win32.`,
  );
  console.log(
    "Keep the following running under a process manager (pm2/systemd/nohup):",
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

  // 손상된 Windows 저장본 — 라벨·포트가 기본값으로 떨어져 **다른 인스턴스**를 설치·재시작할 수 있다. 멈추고 알린다.
  if (process.platform === "win32" && c.winEnvError !== undefined) {
    console.error(`daemon: ${c.winEnvError} — fix or delete it, then run this again.`);
    process.exitCode = 1;
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
      `daemon: unknown subcommand '${cmd}'. ` +
        "Usage: install | uninstall | restart | stop | start | status | logs | print | update",
    );
    process.exitCode = 1;
    return;
  }

  // 어떤 런타임 모드로 유닛을 생성/미리보기하는지 명시(D2 — 추론 아님, env 진실).
  if (cmd === "install" || cmd === "print") {
    console.log(
      `# TIGUCLAW_RUNTIME=${c.runtime} — runs: ${execStrings(c)
        .slice(1)
        .join(" ")} (WorkingDirectory=${c.repoRoot})`,
    );
    if (c.runtime === "built" && !existsSync(c.distEntry)) {
      console.warn(
        `# ⚠ Runtime is built, but ${c.distEntry} is missing — run 'npm run build:prod' first to create dist.`,
      );
    }
  }

  // EPERM 복구 안내(D5): install 중 데몬이 살아 있으면 네이티브 모듈(better_sqlite3.node)이
  //   락돼 `npm ci` 가 EPERM 날 수 있다. 자동 stop/npm 은 안 함 — 순서만 안내(소프트 강제).
  if (cmd === "install" && isDaemonRunning(c)) {
    console.warn(
      "# ⚠ The daemon is running. If you need to reinstall dependencies (npm ci), avoid EPERM (file locks)",
    );
    console.warn(
      "#   by going in this order: `tiguclaw stop` (or npm run daemon:stop) → `npm ci` → `tiguclaw start`/install.",
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
    console.error(`daemon ${cmd}: failed — ${/** @type {Error} */ (err).message}`);
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
  // ★모르는 인자는 **거절한다** (2026-10-03 적대 검토 F4). 종전엔 조용히 무시해서 `--home=X`·오타·값 빠뜨림이
  //  전부 기본 홈·기본 라벨로 떨어졌다 — 두 번째 클론에서 그러면 첫 인스턴스를 설치·제거·재시작한다.
  const flagError = parseDaemonFlags(process.argv.slice(3));
  if (flagError !== undefined) {
    console.error(`daemon: ${flagError} — only --home <home> and --runtime <source|built> are accepted.`);
    process.exit(1);
  }
  if (!cmd) {
    console.error(
      "Usage: node bin/daemon.mjs <install|uninstall|restart|stop|start|status|logs|print|update|supervise>",
    );
    process.exitCode = 1;
  } else {
    runDaemonCommand(cmd);
  }
}
