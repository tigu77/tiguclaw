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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ENV_PATH = path.resolve(process.cwd(), ".env");

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

  console.log("\n[3/5] 데몬 등록 (supervisor)…");
  if (runNpm("daemon:install") !== 0) {
    console.error("→ daemon:install 실패. onboard 중단.");
    return 1;
  }

  console.log("\n[4/5] 전역 명령 설치 (npm link → 어디서나 `tiguclaw`)…");
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
