// src/cli.ts
/**
 * tiguclaw CLI — 자가호스트 통합 진입점 (bin/tiguclaw.mjs 가 cwd=repo 로 호출).
 *
 *   tiguclaw onboard   # 원샷 설정: init → (codex)codex-auth → daemon 등록 → doctor
 *   tiguclaw status|restart|logs|uninstall|install|doctor|init|codex-auth
 *
 * 기존 npm 스크립트를 순서대로 위임(재사용) — 단일 진실 소스 유지.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

/** .env 의 REGION_A_MODELS 가 codex 로 시작하면 OAuth 발급이 필요. */
const providerIsCodex = (): boolean => {
  if (!existsSync(ENV_PATH)) return false;
  const m = readFileSync(ENV_PATH, "utf8").match(/^REGION_A_MODELS=(.*)$/m);
  return m !== null && m[1]!.trim().startsWith("codex");
};

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

  if (providerIsCodex()) {
    console.log("\n[2/5] codex provider — ChatGPT OAuth 발급…");
    if (runNpm("codex-auth") !== 0) {
      console.error("→ codex-auth 실패. onboard 중단.");
      return 1;
    }
  } else {
    console.log("\n[2/5] codex 아님 — OAuth 단계 건너뜀.");
  }

  // 런타임 모드 (ADR 2026-07-14 D2/D4) — 명시 env 만 진실. 기본 source(현행 불변, 자동
  // 플립 0). built 는 프로덕션 명시 opt-in: 유닛 생성 *전에* dist 산출물이 있어야 하므로
  // 여기서 build:prod 를 먼저 돌린다. 이 env 는 runNpm(상속)으로 daemon:install 까지 전달돼
  // built 유닛(node dist/src/index.js)이 생성된다.
  const runtime =
    process.env.TIGUCLAW_RUNTIME?.trim() === "built" ? "built" : "source";
  if (runtime === "built") {
    console.log(
      "\n[빌드] TIGUCLAW_RUNTIME=built — 프로덕션 산출물 빌드 (npm run build:prod)…",
    );
    if (runNpm("build:prod") !== 0) {
      console.error(
        "→ build:prod 실패. onboard 중단 (built 유닛은 dist/src/index.js 가 필수).",
      );
      return 1;
    }
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

  tiguclaw onboard      원샷 설정 (init → codex-auth → 데몬 등록 → doctor)
  tiguclaw init         설정 마법사만 (.env 재생성)
  tiguclaw codex-auth   ChatGPT OAuth 토큰 발급
  tiguclaw doctor       설정 검증
  tiguclaw status       데몬 상태
  tiguclaw restart      데몬 재시작 (코드 변경 적용)
  tiguclaw logs         데몬 로그 tail
  tiguclaw install      데몬 supervisor 등록
  tiguclaw uninstall    데몬 등록 해제
  tiguclaw help         이 도움말

  런타임 모드 (ADR 2026-07-14): 기본 source(tsx 로 .ts 구동, dev·현행 불변).
    프로덕션 빌드 산출물로 구동하려면 TIGUCLAW_RUNTIME=built 를 설정한 채로
    onboard(자동 build:prod 선행) 하거나, 수동: npm ci → npm run build:prod →
    TIGUCLAW_RUNTIME=built tiguclaw install. 기존 install 은 자동 전환되지 않는다
    (명시 재설치로만). built 인스턴스의 self-update 는 재빌드 후 dist 를 원자 교체한다.
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
    case "doctor":
      return runNpm("doctor");
    case "status":
      return runNpm("daemon:status");
    case "restart":
      return runNpm("daemon:restart");
    case "logs":
      return runNpm("daemon:logs");
    case "install":
      return runNpm("daemon:install");
    case "uninstall":
      return runNpm("daemon:uninstall");
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
