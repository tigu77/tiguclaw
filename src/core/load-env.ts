// src/core/load-env.ts
/**
 * 설정(.env) 로더 — `<home>/.env` 우선, 없으면 `<cwd>/.env`(레포) 폴백.
 *
 * ★목적(2026-07-09): 설정을 **런타임 홈**에서 읽어 **공개 레포 checkout 을 안 건드림**.
 * 공개 레포를 clone 해 쓰되 `~/.tiguclaw/.env`(홈)에 설정 → `git pull` 깔끔, 레포 날려도
 * 설정 생존. 기존 설치(레포 루트 `.env`)는 폴백으로 그대로 동작(무중단 마이그레이션).
 *
 * 동작:
 *  - 홈 = `TIGUCLAW_HOME` env(있으면) / 없으면 `~/.tiguclaw` — daemon.ts·paths.ts 와 동일 규칙.
 *    (홈은 .env *전에* 알아야 하므로 환경변수/기본값에서만 온다. launchd 유닛이 TIGUCLAW_HOME 을
 *     EnvironmentVariables 로 주입하므로 데몬은 홈을 이미 안다.)
 *  - `<home>/.env` → `<cwd>/.env` 순서로 `process.loadEnvFile`. loadEnvFile 은 **이미 있는
 *    env 를 안 덮으므로**(측정 확인) 홈이 이김·레포는 홈이 안 채운 키만 보완·환경변수는 최우선.
 *  - 파일 부재/손상은 무시(never-throw) — 전부 환경변수로만 설정한 경우도 정상.
 *
 * 진입점은 이 모듈을 **가장 먼저** import 해야 한다(다른 모듈이 env 를 읽기 전에 로드).
 * `--env-file` 플래그 대신 이 프로그램적 로더를 쓴다(정적 플래그론 홈 경로 보간 불가·부재 시
 * Node --env-file 이 throw 하는 문제 회피).
 */
import os from "node:os";
import path from "node:path";

let loaded = false;

/** 홈 우선(레포 폴백)으로 .env 로드. 멱등 — 첫 호출만 실제 로드. */
export const loadHomeEnv = (): void => {
  if (loaded) return;
  loaded = true;

  const home =
    process.env.TIGUCLAW_HOME?.trim() || path.join(os.homedir(), ".tiguclaw");
  const homeEnv = path.join(home, ".env");
  const repoEnv = path.resolve(process.cwd(), ".env");

  const tryLoad = (file: string): boolean => {
    try {
      // Node 20.12+/22 — 이미 있는 env 는 안 덮음(환경변수·앞서 로드한 홈이 우선).
      (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(
        file,
      );
      return true;
    } catch {
      return false; // ENOENT·손상 — 무시.
    }
  };

  const home_ok = tryLoad(homeEnv); // 홈 우선.
  const repo_ok = homeEnv !== repoEnv ? tryLoad(repoEnv) : false; // 레포 폴백/보완.

  const parts: string[] = [];
  if (home_ok) parts.push(`home(${homeEnv})`);
  if (repo_ok) parts.push(`repo-fallback(${repoEnv})`);
  console.log(
    parts.length > 0
      ? `[env] loaded ${parts.join(" + ")}`
      : `[env] no .env (${homeEnv} / ${repoEnv}) — using process environment only`,
  );
};

// 부작용 실행 — 진입점이 `import "./core/load-env.js"` 를 **가장 먼저** 두면 이 시점에 로드된다
// (dotenv/config 패턴). 멱등이라 여러 번 import 돼도 1회만.
loadHomeEnv();
