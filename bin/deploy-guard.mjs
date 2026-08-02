#!/usr/bin/env node
/**
 * 배포 가드 — **진행 중 턴이 있으면 재시작을 막는다** (2026-08-02, 같은 사고 2회).
 *
 * 사고: 배포하며 데몬을 재시작했는데 그 순간 사용자 턴이 돌고 있었다. 두 번 다
 * `/health` 의 `active_turns` 를 **확인은 했다** — 그런데 셸에서 값을 *출력만* 하고
 * `&&` 뒤가 그대로 돌았다(`grep` 의 종료코드는 "찾았다"지 "0건이다" 가 아니다).
 * **확인과 차단은 다른 일**이다. 사람 규율 대신 종료코드로 강제한다.
 *
 * 사용: `npm run deploy` (build:prod → 이 가드 → daemon:restart)
 *   - 진행 중 턴 0 → exit 0
 *   - 1건 이상 → 좌표를 찍고 **exit 1**(재시작 안 함)
 *   - 데몬이 안 떠 있음/조회 실패 → exit 0 (재시작이 곧 복구다 — 막을 이유 없음)
 *   - `--force` → 경고만 하고 통과(급할 때 의식적으로)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const force = process.argv.includes("--force");

/**
 * 포트 해석 — **데몬과 같은 자리를 본다**(bin/daemon.mjs winPort 동형).
 * ★첫 판에서 이걸 빼먹어 `.env` 의 포트를 못 찾고 "미응답 → 통과" 로 새어나갔다.
 *  가드가 자기 주석("모름을 안전으로 읽지 않는다")을 스스로 어긴 것이다.
 */
const resolvePort = () => {
  const fromEnv = process.env.HTTP_BRIDGE_PORT?.trim();
  if (fromEnv) return fromEnv;
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const f of [path.join(repo, ".env"), path.join(repo, "tiguclaw-dev", ".env")]) {
    try {
      const m = readFileSync(f, "utf8").match(/^HTTP_BRIDGE_PORT\s*=\s*(\d+)/m);
      if (m) return m[1];
    } catch {
      /* 다음 후보 */
    }
  }
  return "7011"; // 코드 기본값(default-port-truth 가 지킨다).
};
const port = resolvePort();

const read = async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  return await res.json();
};

let health;
try {
  health = await read();
} catch {
  console.log(`deploy-guard: 데몬 미응답(:${port}) — 진행 중 턴 없음으로 보고 통과합니다.`);
  process.exit(0);
}

const n = health?.active_turns;
if (typeof n !== "number") {
  // ★"모름" 을 0으로 읽지 않는다 — 그게 이 사고의 형상이다.
  console.error(
    "deploy-guard: /health 가 active_turns 를 안 줍니다(구버전?). 모름을 안전으로 읽지 않고 막습니다. --force 로 통과.",
  );
  process.exit(force ? 0 : 1);
}
if (n === 0) {
  console.log("deploy-guard: 진행 중 턴 0건 — 재시작 안전.");
  process.exit(0);
}
const keys = Array.isArray(health.active_turn_threads) ? health.active_turn_threads : [];
console.error(
  `deploy-guard: ★진행 중 턴 ${n}건 — 재시작하면 그 답변이 사라집니다.\n` +
    (keys.length > 0 ? `  좌표: ${keys.join(", ")}\n` : "") +
    "  끝날 때까지 기다렸다가 다시 실행하세요. 정말 지금 해야 하면 --force.",
);
process.exit(force ? 0 : 1);
