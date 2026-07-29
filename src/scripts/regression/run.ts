/**
 * 회귀 스위트 러너 — `npm run test:regression`.
 *
 * ★이름이 `verify:` 가 아닌 이유: 배포본 스크럽이 `verify:`/`e2e:`/`probe:` 접두 스크립트를
 *  지운다(그 대상 파일들이 dev 전용이라). 이 스위트는 **공개 배포본에서도 CI 가 돌려야**
 *  하므로 그 접두를 피한다.
 *
 * 격리: 시작 시 TIGUCLAW_HOME 을 임시 디렉터리로 강제한다 — 실행 중인 데몬·실제 홈·실제
 * DB 를 절대 건드리지 않는다. 끝나면 지운다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RegressionCheck } from "./_framework.js";

const home = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-"));
process.env.TIGUCLAW_HOME = home;
// ★DATA_DIR 은 TIGUCLAW_HOME 보다 우선이다(store/sessions.ts resolveDataDir) — 안 지우면
//  그 환경에서 검사가 **라이브 DB** 를 친다(실제로 삭제 문을 쓰는 검사가 있다). 격리는
//  "홈만 바꿨다" 로는 부족하다.
delete process.env.DATA_DIR;
// ★튜닝 env 봉인 (2026-07-30 감사 지적) — `load-env.ts` 가 **레포 `.env` 를 폴백 로드**해서
//  dev `.env` 의 값이 스위트 판정에 들어갔다. 실측: `CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS=200000`
//  이면 history-compaction-budget 2건이, `WORKER_TIMEOUT_MS=1000` 이면 timeout-layering 1건이
//  **코드 무수정으로 빨간불**이 됐다. public 트리는 `.env` 가 없어 이 결합이 안 보였다 —
//  "내 머신에선 빨간불"의 정석적 원인이라 검사가 읽는 상수는 전부 기본값으로 고정한다.
for (const k of Object.keys(process.env)) {
  if (
    /^CODEX_/.test(k) ||
    /^WORKER_/.test(k) ||
    /^SUBAGENT_/.test(k) ||
    /^MCP_/.test(k) ||
    /^LLM_/.test(k) ||
    /^REGION_A_/.test(k) ||
    /^STEERING_/.test(k)
  ) {
    delete process.env[k];
  }
}
// 실수로 라이브 채널이 뜨지 않게(부팅 경로를 안 타지만 방어).
process.env.TELEGRAM_BOT_TOKEN = "";

const main = async (): Promise<void> => {
  // store 를 쓰는 검사가 있으므로 홈 확정 후 초기화(import 순서 의존 — 동적 import 유지).
  const { initStore } = await import("../../store/sessions.js");
  initStore();

  // ★디렉터리 스캔 — 손으로 관리하는 명시 목록이었다 (2026-07-30 원칙 검토 지적).
  //  회귀 파일을 추가하고 등록을 잊으면 **그물이 조용히 없다.** 오늘 그 구멍의 실증이 나왔다:
  //  `context-windows.ts` 주석이 "회귀 context-window-coverage 가 지킨다"고 적었는데 그 파일이
  //  아예 없었다(주석만 있고 그물은 없음). 오늘 내내 고친 "사람이 손으로 관리하던 이름 목록"
  //  부류가 회귀 러너 자신에 남아 있던 것이라 구조적으로 닫는다.
  //  `_` 접두(프레임워크·헬퍼)와 `run.ts` 는 제외. 파일명 순으로 결정적 실행.
  const dir = new URL("./", import.meta.url);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "run.ts")
    .sort();
  const checks: RegressionCheck[] = [];
  for (const f of files) {
    const mod = (await import(`./${f.replace(/\.ts$/, ".js")}`)) as {
      check?: RegressionCheck;
    };
    if (mod.check === undefined) {
      console.error(`🔴 ${f} 에 export const check 가 없다 — 회귀 파일 규약 위반.`);
      process.exitCode = 1;
      continue;
    }
    checks.push(mod.check);
  }
  console.log(`  (검사 파일 ${checks.length}개 자동 발견 — 등록 누락 구조적 불가)`);



  let failed = 0;
  let total = 0;
  for (const c of checks) {
    const started = Date.now();
    let results;
    try {
      results = await c.run();
    } catch (e) {
      failed += 1;
      console.log(`🔴 ${c.name} — 검사 자체가 던졌다: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const bad = results.filter((r) => !r.ok);
    total += results.length;
    failed += bad.length;
    const ms = Date.now() - started;
    console.log(`${bad.length === 0 ? "✅" : "🔴"} ${c.name} (${results.length}건, ${ms}ms) — ${c.guards}`);
    for (const r of results) {
      if (!r.ok) console.log(`     🔴 ${r.name} — 실제: ${r.got}`);
    }
  }
  console.log(
    failed === 0
      ? `\n✅ 회귀 스위트 통과 — ${total}건`
      : `\n🔴 회귀 스위트 실패 — ${failed}/${total}건`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
};

try {
  await main();
} finally {
  rmSync(home, { recursive: true, force: true });
}
