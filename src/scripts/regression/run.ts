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
// 실수로 라이브 채널이 뜨지 않게(부팅 경로를 안 타지만 방어).
process.env.TELEGRAM_BOT_TOKEN = "";

const main = async (): Promise<void> => {
  // store 를 쓰는 검사가 있으므로 홈 확정 후 초기화(import 순서 의존 — 동적 import 유지).
  const { initStore } = await import("../../store/sessions.js");
  initStore();

  const checks: RegressionCheck[] = [
    (await import("./owner-thread-key.js")).check,
    (await import("./fts-reindex.js")).check,
    (await import("./bash-foreground.js")).check,
    (await import("./tool-watchdog-parity.js")).check,
    (await import("./live-child-job.js")).check,
    (await import("./timeout-layering.js")).check,
    (await import("./mcp-tool-listing.js")).check,
    (await import("./codex-early-stop.js")).check,
    (await import("./job-session-scope.js")).check,
    (await import("./job-interrupt-event.js")).check,
    (await import("./tool-output-coverage.js")).check,
    (await import("./worker-steering.js")).check,
    (await import("./channel-session-binding.js")).check,
    (await import("./cooldown-probe.js")).check,
    (await import("./live-jobs-context.js")).check,
  ];

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
