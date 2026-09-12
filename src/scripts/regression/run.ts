/**
 * 회귀 스위트 러너 — `npm run test:regression`.
 *
 * ★이름이 `verify:` 가 아닌 이유: 배포본 스크럽이 `verify:`/`e2e:`/`probe:` 접두 스크립트를
 *  지운다(그 대상 파일들이 dev 전용이라). 이 스위트는 **공개 배포본에서도 CI 가 돌려야**
 *  하므로 그 접두를 피한다.
 *
 * 격리: 시작 시 TIGUCLAW_HOME 을 임시 디렉터리로 강제한다 — 실행 중인 데몬·실제 홈·실제
 * DB 를 절대 건드리지 않는다. 끝나면 지운다.
 *
 * ── 부분 실행 (2026-09-11) ────────────────────────────────────────────────────────
 *
 *   npm run test:regression -- fast-mode          # 이름에 그 조각이 든 검사만
 *   npm run test:regression -- fast-mode speed-   # 여럿 (OR)
 *
 * 왜 넣었나: **변이 하나 확인하는 데 3,200건을 통째로 돌리고 있었다**(하루 약 25회 실측).
 * 변이 검증은 «이 검사가 이 변이에 빨개지나» 를 묻는 것이라 나머지는 답에 기여하지 않는다.
 *
 * ★**그런데 이 편의가 곧 위험이다.** 부분 실행이 «✅ 회귀 스위트 통과» 로 보이면, 이 레포가
 *  가장 싫어하는 실패 모양 — «아무것도 안 봤는데 초록» — 이 된다(러너 자신이 `checks.length
 *  === 0` 을 못박은 것과 같은 사고). 그래서 셋을 지킨다:
 *
 *   1. 필터를 쓰면 최종 줄이 **다른 문장**이다 — «부분 실행» 이라고 말하고 전체 대비 몇 개를
 *      돌렸는지 적는다. 초록이어도 «통과» 라고 하지 않는다.
 *   2. 필터가 **하나도 못 맞히면 실패**(exit 1). 오타 하나로 «0건 초록» 이 나오면 안 된다.
 *   3. exit code 규칙은 그대로 — 부분 실행도 실패가 있으면 1 이다.
 *
 *  이 셋은 `regression-runner-partial-is-not-green` 이 **러너를 실제로 돌려서** 지킨다.
 */
// ★**가장 먼저** — `<home>/.env`(레포 폴백) 를 여기서 태워 버린다 (2026-09-11 G5).
//  아래의 `delete process.env.DATA_DIR` 과 튜닝 env 봉인이 «마지막» 이 되려면 `.env` 로드가
//  그보다 **앞서** 끝나야 한다. 종전엔 이 import 가 없어서, 봉인 뒤에 동적 import 체인이
//  `load-env` 를 태우며 지워 둔 키를 다시 채웠다(`loadEnvFile` 은 빈 키를 채운다).
import "../../core/load-env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RegressionCheck } from "./_framework.js";

const home = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-"));
process.env.TIGUCLAW_HOME = home;
// ★DATA_DIR 은 TIGUCLAW_HOME 보다 우선이다(store/sessions.ts resolveDataDir) — 안 막으면
//  그 환경에서 검사가 **라이브 DB** 를 친다(실제로 삭제 문을 쓰는 검사가 있다). 격리는
//  "홈만 바꿨다" 로는 부족하다.
//
// ★**이 `delete` 가 «마지막» 이 되게 위에서 `load-env` 를 먼저 태운다** (2026-09-11 G5).
//  종전엔 이 줄이 먼저였고, `load-env.ts` 의 1회 로드가 **나중**이었다(러너는 대부분을 동적
//  import 하고 그 체인 어딘가가 `load-env` 를 탄다 — 실행 로그에 `[env] loaded …` 가 찍힌다).
//  `process.loadEnvFile` 은 **비어 있는 키를 채우므로** 지워 둔 자리에 `.env` 의 `DATA_DIR` 이
//  그대로 들어왔다. 실측: `delete` 직후 `undefined` → `load-env` 를 타는 모듈 import 후
//  `"…/LIVE_DATA"` → `resolveDataDir()` 이 그 경로를 반환.
//  ★오늘 레포 `.env` 에 `DATA_DIR` 이 없어서 안 터졌고, 터져도 `assertIsolated()` 가 **요란하게
//   던진다**(조용한 오염은 아니다). 그래도 고치는 이유: 그 가드를 **안 부르는 검사**는 그대로
//   그 경로를 쓰고, 무엇보다 «지웠는데 되살아난다» 는 순서 결함 자체가 다음 사람을 속인다.
//  ★**봉인 값을 넣는 방식은 틀렸다** — `""` 도 `path.join(home,"data")` 도 시도했다가 전체
//   스위트가 무너졌다(각각 35·37건 실패). 전자는 `assertIsolated()` 가 «설정됨» 으로 보고
//   던지고, 후자는 자식이 그 값을 **상속**받아 전부 같은 DB 를 친다. 계약은 «지운다» 가 맞고,
//   고쳐야 할 것은 **순서**였다.
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
    /^STEERING_/.test(k) ||
    // ★**모델 선택 env** 도 봉인한다 (2026-08-15 2차, 적대 검토 [10]). 이게 빠져 있어서
    //  dev `.env` 의 `MODEL_TIER_NANO=ollama:…` 로 **내부 단발 호출이 실제로 성공**했고,
    //  같은 변이가 이 기계에선 빨강 / CI(모델 0)에선 **초록**이었다(실증). 검사의 초록이
    //  기계에 달려 있으면 그건 검사가 아니다 — 봉인 취지("검사가 읽는 상수는 전부
    //  기본값으로 고정")대로면 모델 선택이야말로 1순위다.
    /^MODEL_TIER_/.test(k) ||
    /^MODELS_/.test(k) ||
    /^OLLAMA_/.test(k) ||
    /^OPENAI_/.test(k) ||
    /^ANTHROPIC_/.test(k)
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
  // ★하한 — **그물이 통째로 사라져도 초록이던 것**(2026-07-31 검토 지적).
  //  glob 은 `*.ts` 를 찾는데 `dist/` 엔 `.js` 만 있다 → 배포본에서 돌리면 검사 0개로
  //  `✅ 통과 — 0건`, exit 0. "CI 가 돈다" 는 말이 "아무것도 안 본다" 와 구분이 안 됐다.
  //  개수를 손으로 적으면 그게 또 드리프트하므로 **"0 이면 안 된다"** 만 못박는다.
  if (checks.length === 0) {
    console.error(
      "🔴 검사 파일을 하나도 못 찾았다 — 스위트가 안 돈 것이지 통과한 게 아니다.\n" +
        `   (탐색 위치: ${dir.pathname})  ★소스에서 실행하세요: npm run test:regression`,
    );
    process.exitCode = 1;
    return;
  }



  // ── 부분 실행 필터 — 자세한 규칙과 «왜 위험한가» 는 파일 헤더 ──────────────────────
  //  `--` 로 시작하는 인자는 플래그 자리로 비워 둔다(지금은 쓰는 게 없다 — 미리 만들지 않음).
  const only = process.argv.slice(2).filter((a) => a !== "" && !a.startsWith("-"));
  const selected =
    only.length === 0 ? checks : checks.filter((c) => only.some((p) => c.name.includes(p)));
  if (only.length > 0 && selected.length === 0) {
    // ★오타 하나로 «0건 초록» 이 나오면 안 된다 — 위 `checks.length === 0` 과 같은 사고.
    console.error(
      `🔴 필터 [${only.join(", ")}] 에 맞는 검사가 없다 — 아무것도 안 돈 것이지 통과가 아니다.\n` +
        `   (검사 ${checks.length}개 중 0개 선택)`,
    );
    process.exitCode = 1;
    return;
  }
  if (only.length > 0) {
    console.log(`  (부분 실행 — 필터 [${only.join(", ")}] · ${selected.length}/${checks.length}개 선택)`);
  }

  let failed = 0;
  let total = 0;
  for (const c of selected) {
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
  // ★부분 실행은 **«통과» 라고 말하지 않는다** — 그 한 문장이 이 필터의 안전장치 전부다.
  //  초록이어도 «전체를 봤다» 가 아니므로, 복붙된 로그만 보고 판단하는 다음 사람을 위해
  //  무엇을 안 봤는지 줄 안에 적는다([[feedback_logs_must_stand_alone]]).
  console.log(
    only.length > 0
      ? failed === 0
        ? `\n⚠️ 부분 실행 — ${total}건 이상 없음 (검사 ${selected.length}/${checks.length}개, 필터 [${only.join(", ")}]). ` +
          `**전체 스위트가 아니다** — 커밋 전에 필터 없이 한 번 더 돌려라.`
        : `\n🔴 부분 실행 실패 — ${failed}/${total}건 (검사 ${selected.length}/${checks.length}개, 필터 [${only.join(", ")}])`
      : failed === 0
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
