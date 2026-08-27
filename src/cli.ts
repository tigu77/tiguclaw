// src/cli.ts
/**
 * tiguclaw CLI — 자가호스트 통합 진입점 (bin/tiguclaw.mjs 가 cwd=repo 로 호출).
 *
 *   tiguclaw onboard   # 원샷 설정: init → (구독)codex-auth|claude-auth → daemon 등록 → doctor
 *   tiguclaw status|restart|update|logs|uninstall|install|doctor|init|codex-auth|claude-auth
 *
 * 기존 npm 스크립트를 순서대로 위임(재사용) — 단일 진실 소스 유지.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexProviderFromEnvBody,
  claudeSubProviderFromEnvBody,
} from "./core/onboard-provider.js";
import process from "node:process";

// 설정(.env)은 런타임 홈에 있다(레포 무오염, 2026-07-09). 홈 = TIGUCLAW_HOME / 기본 ~/.tiguclaw.
const HOME_DIR =
  process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
const ENV_PATH = path.join(HOME_DIR, ".env");

/** npm 스크립트 위임 실행 (TTY 상속 — 대화형 마법사 그대로 동작). exit code 반환.
 *  shell:true — Windows 는 `npm` 이 `npm.cmd` 라 shell 없이는 ENOENT(크로스플랫폼 필수).
 *  script 는 하드코딩 리터럴만(주입 위험 0). */
const runNpm = (script: string): number => {
  const r = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    shell: true,
  });
  return r.status ?? 1;
};

/** 데몬 라이프사이클을 dep-free 매니저(bin/daemon.mjs)로 직접 위임(tsx·npm 우회, ADR
 *  2026-07-15 D2/U2). 전역 `tiguclaw` 는 bin/tiguclaw.mjs 에서 이미 단락되지만, 직접
 *  `tsx src/cli.ts <cmd>` 로 들어와도 동일하게 dep-free 경로로 일원화한다. */
const runDaemon = (cmd: string): number => {
  // bin/tiguclaw.mjs 가 cwd=repoRoot 로 호출 → process.cwd() = 레포 루트(runNpm 과 동일 전제).
  const daemonMjs = path.join(process.cwd(), "bin", "daemon.mjs");
  const r = spawnSync(process.execPath, [daemonMjs, cmd], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  return r.status ?? 1;
};

/**
 * codex OAuth 발급이 필요한 설치인가.
 *
 * ★진실 소스는 `TIGUCLAW_PROVIDER`(init 이 명시로 남긴다, 2026-08-13). 종전엔
 *  `REGION_A_MODELS` 접두로 **유추**했는데, 모델을 자동으로 두면(프로파일·env 를 일부러
 *  비우는 모드) 그 값이 비어 codex 를 골라도 인증 단계를 통째로 건너뛰었다 —
 *  무인증으로 데몬이 뜨고 자동 카탈로그도 codex 를 못 본다.
 * ★옛 설치 호환으로 REGION_A_MODELS 폴백은 남긴다(그때 쓴 .env 엔 새 키가 없다).
 */
// 판정은 리프(core/onboard-provider.ts) — 여기 두면 회귀가 실행할 수 없다(import 가 CLI 를 돈다).
const providerIsCodex = (): boolean =>
  existsSync(ENV_PATH) && codexProviderFromEnvBody(readFileSync(ENV_PATH, "utf8"));

/** claude 구독인가 — 같은 리프 판정(둘 다 온보드가 대신 발급한다). */
const providerIsClaudeSub = (): boolean =>
  existsSync(ENV_PATH) && claudeSubProviderFromEnvBody(readFileSync(ENV_PATH, "utf8"));

/** 전역 PATH 에서 명령 위치 해석 (unix: which / win: where). 없으면 null. */
const resolveCmd = (name: string): string | null => {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [name], { encoding: "utf8" });
  if ((r.status ?? 1) !== 0) return null;
  const first = (r.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return first ?? null;
};

/** 전역 npm 패키지 `tiguclaw` 가 *이* 설치본(cwd)을 가리키는지 (재링크는 무해, 타인 것은 보존). */
const globalTiguclawIsOurs = (): boolean => {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  if ((r.status ?? 1) !== 0) return false;
  const pkg = path.join((r.stdout ?? "").trim(), "tiguclaw");
  try {
    return (
      path.resolve(realpathSync(pkg)) ===
      path.resolve(realpathSync(process.cwd()))
    );
  } catch {
    return false;
  }
};

/** 원샷 설정 — 설치 후 이 명령 하나로 끝낸다. */
const onboard = (): number => {
  console.log("\n=== tiguclaw onboard — 원샷 설정 ===\n");

  console.log("[1/5] 설정 마법사 (.env 생성)…");
  if (runNpm("init") !== 0) {
    console.error("→ init 실패/중단. onboard 중단.");
    return 1;
  }
  if (!existsSync(ENV_PATH)) {
    console.error("\n→ .env 가 생성되지 않았습니다(마법사 중단). onboard 중단.");
    return 1;
  }

  // ★구독 provider 둘을 **같이** 처리한다 (2026-08-27). 종전엔 codex 만 대신 발급해주고
  //  claude 구독은 사용자에게 심부름을 시켰다 — "CLI 를 깔고, 토큰을 받아서, 붙여넣으세요".
  //  게다가 그 첫 걸음은 이미 `npm ci` 로 받아둔 259MB 를 **한 번 더** 받는 것이었다.
  //  같은 성격의 인증인데 한쪽만 자동인 건 비대칭이다.
  const authScript = providerIsCodex()
    ? "codex-auth"
    : providerIsClaudeSub()
      ? "claude-auth"
      : null;
  if (authScript !== null) {
    console.log(`\n[2/5] 구독 OAuth 발급 (${authScript})…`);
    if (runNpm(authScript) !== 0) {
      console.error(`→ ${authScript} 실패. onboard 중단.`);
      return 1;
    }
  } else {
    console.log("\n[2/5] 구독 provider 아님 — OAuth 단계 건너뜀.");
  }

  // 런타임 모드 (ADR 2026-07-14 D2/D4, Amendment 2026-07-14) — 명시 env 만 진실.
  // **기본 built**(뒤집힘: 설치=프로덕션). built 는 유닛 생성 *전에* dist 산출물이 있어야
  // 하므로 여기서 build:prod 를 먼저 돌린다. 이 env 는 runNpm(상속)으로 daemon:install 까지
  // 전달돼 built 유닛(node dist/src/index.js)이 생성되고, mode-persistence 로 유닛 env 에
  // TIGUCLAW_RUNTIME=built 가 새겨진다. dev/디버그는 TIGUCLAW_RUNTIME=source 로 opt-out(빌드 skip).
  const runtime =
    process.env.TIGUCLAW_RUNTIME?.trim() === "source" ? "source" : "built";
  if (runtime === "built") {
    console.log(
      "\n[빌드] runtime=built (기본) — 프로덕션 산출물 빌드 (npm run build:prod)…",
    );
    if (runNpm("build:prod") !== 0) {
      console.error(
        "→ build:prod 실패. onboard 중단 (built 유닛은 dist/src/index.js 가 필수).",
      );
      return 1;
    }
  } else {
    console.log("\n[빌드] TIGUCLAW_RUNTIME=source — 빌드 건너뜀(tsx 로 .ts 직접 구동).");
  }

  console.log(`\n[3/5] 데몬 등록 (supervisor, runtime=${runtime})…`);
  if (runNpm("daemon:install") !== 0) {
    console.error("→ daemon:install 실패. onboard 중단.");
    return 1;
  }

  console.log("\n[4/5] 전역 명령 설치 (npm link → 어디서나 `tiguclaw`)…");
  const existingTiguclaw = resolveCmd("tiguclaw");
  if (existingTiguclaw !== null && !globalTiguclawIsOurs()) {
    // 다른 tiguclaw 가 이미 전역에 있음 — 덮어쓰지 않고 보존(예: 레거시 설치본).
    console.warn(
      `   ⚠ 이미 다른 'tiguclaw' 전역 명령이 있습니다 (${existingTiguclaw}) — 덮어쓰지 않고 건너뜁니다.`,
    );
    console.warn(
      "     이 설치본을 전역 명령으로 쓰려면 직접 `npm link` 하세요(기존 것을 덮어씀).",
    );
  } else {
    const linked = spawnSync("npm", ["link"], { stdio: "inherit", shell: true });
    if ((linked.status ?? 1) === 0) {
      console.log(
        "   ✓ 이제 어느 폴더에서나: tiguclaw status | restart | logs | doctor",
      );
    } else {
      console.warn(
        "   ⚠ npm link 건너뜀(권한 등) — 수동으로 `npm link` 하면 전역 `tiguclaw` 명령이 생깁니다.",
      );
    }
  }

  console.log("\n[5/5] 설정 검증…");
  runNpm("doctor"); // 진단용 — 실패해도 onboard 는 완료로 본다.

  console.log("\n✅ onboard 완료!");
  console.log(
    "   텔레그램에서 봇에게 메시지를 보내 응답을 확인하세요 (소유자 ID만 허용).",
  );
  console.log("   관리: tiguclaw status / restart / logs / uninstall\n");
  return 0;
};

const USAGE = `tiguclaw — 자가호스트 AI 비서 CLI

  tiguclaw onboard      원샷 설정 (init → 구독 OAuth → 데몬 등록 → doctor)
  tiguclaw init         설정 마법사만 (.env 재생성)
  tiguclaw codex-auth   ChatGPT 구독 OAuth 토큰 발급
  tiguclaw claude-auth  Claude 구독 OAuth 토큰 발급
  tiguclaw doctor       설정 검증
  tiguclaw status       데몬 상태
  tiguclaw restart      데몬 재시작 (코드 변경 적용)
  tiguclaw update       dep-free 자가 갱신 (stop→git pull→npm ci→build→start, 롤백 안전)
  tiguclaw stop         데몬 실행 중지 (등록 유지 — EPERM/락 복구용)
  tiguclaw start        데몬 재실행 (등록 유지)
  tiguclaw logs         데몬 로그 tail
  tiguclaw install      데몬 supervisor 등록
  tiguclaw uninstall    데몬 등록 해제
  tiguclaw help         이 도움말

  깨진 node_modules/tsx 복구(ADR 2026-07-15): 라이프사이클 명령(install/uninstall/
    restart/stop/start/status/logs/print)은 dep-free 매니저(bin/daemon.mjs)로 직접
    돌아 tsx·node_modules 없이도 항상 동작. better_sqlite3 EPERM(실행 중 데몬이 네이티브
    모듈 락) 복구 순서: tiguclaw stop → npm ci → tiguclaw start(또는 install).
    ★tiguclaw update 가 이 순서(stop→pull→npm ci→build→start)를 자동화한다 — 깨진
    node_modules 도 npm ci 로 복구하고 실패 시 이전 커밋으로 롤백(데몬 원복 가동).

  런타임 모드 (ADR 2026-07-14, Amendment 2026-07-14): 기본 built(설치=프로덕션 빌드 산출물,
    node dist/src/index.js). onboard 가 build:prod 를 자동 선행하고, 설치 시 해석된 모드를
    유닛 env(TIGUCLAW_RUNTIME=built)에 새긴다(mode-persistence). dev/디버그로 tsx .ts 를
    직접 구동하려면 TIGUCLAW_RUNTIME=source 로 opt-out(빌드 skip, 유닛에 =source 새김).
    기존 install 은 유닛에 고정된 모드를 유지 — 기본값 변경에 자동 전환되지 않는다(명시 재설치로만).
    built 인스턴스의 self-update 는 재빌드 후 dist 를 원자 교체한다.
`;

const main = (): number => {
  const cmd = process.argv[2] ?? "help";
  switch (cmd) {
    case "onboard":
      return onboard();
    case "init":
      return runNpm("init");
    case "codex-auth":
      return runNpm("codex-auth");
    // ★claude 구독도 같은 자리 (2026-08-27) — 문서가 `tiguclaw claude-auth` 를 약속하는데
    //  디스패치에 없으면 그게 곧 "없는 명령을 시키는" 막다른 길이다(고치려던 그 부류).
    case "claude-auth":
      return runNpm("claude-auth");
    case "doctor":
      return runNpm("doctor");
    case "status":
      return runDaemon("status");
    case "restart":
      return runDaemon("restart");
    case "stop":
      return runDaemon("stop");
    case "start":
      return runDaemon("start");
    case "logs":
      return runDaemon("logs");
    case "install":
      return runDaemon("install");
    case "uninstall":
      return runDaemon("uninstall");
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`알 수 없는 명령: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
};

process.exit(main());
