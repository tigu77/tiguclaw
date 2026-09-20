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
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RegressionCheck } from "./_framework.js";

/**
 * **지난 실행이 남긴 임시 홈을 쓸어낸다** — 하루보다 오래된 것만.
 *
 * ★★**실측으로 드러났다**(2026-09-19): 맥에 `tiguclaw-regression-*` 이 **1,308개**(9/10~9/19)
 *  남아 있었다. 전부 **빈 폴더**다 — 내용은 지워졌는데 디렉터리가 남은 것이 아니라, 대개는
 *  그 실행이 **시그널로 죽어 `finally` 를 못 지난** 것이다(필터 실행을 `| head` 로 받으면
 *  SIGPIPE 가 난다 — 오늘 내가 수십 번 그렇게 돌렸다).
 * ★`finally` 를 아무리 잘 써도 **죽임당한 프로세스는 아무것도 못 한다.** 그러니 «나갈 때
 *  치운다» 옆에 **«들어올 때 치운다»** 를 둔다 — 시작은 언제나 도달한다.
 * ★하루 상한을 두는 이유: **도는 중인 다른 실행**의 홈을 지우면 안 된다(CI 가 병렬로 돈다).
 */
const sweepStaleHomes = (): number => {
  const cut = Date.now() - 24 * 60 * 60 * 1000;
  let swept = 0;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("tiguclaw-regression-")) continue;
      const full = path.join(tmpdir(), name);
      try {
        if (statSync(full).mtimeMs > cut) continue;
        rmSync(full, { recursive: true, force: true });
        swept += 1;
      } catch {
        /* 남의 것이거나 지금 쓰는 중 — 넘어간다 */
      }
    }
  } catch {
    /* tmpdir 을 못 읽으면 쓸어낼 것도 없다 */
  }
  return swept;
};

/**
 * **끝나고 남은 임시 폴더를 센다** — 내 것 말고 (2026-09-20).
 *
 * ★★**67개가 쌓여 있었는데 아무도 몰랐다.** 위 스위퍼는 «하루 넘은 것» 만 쓸어서, 오늘
 *  생긴 것은 **원리적으로 한 번도 안 보인다.** 뿌리는 `skill-index-role-scope` 가
 *  `mkdtempSync` 를 둘 부르고 치우지 않은 것이었고, 그건 고쳤다 — 그런데 **고친 것보다
 *  중요한 건 «세는 자리가 없었다» 는 사실**이다. 다음에 다른 검사가 같은 짓을 하면
 *  또 하루가 지나야, 그것도 조용히 사라진다.
 * ★맥에선 더 안 보인다 — POSIX 라 지우기가 늘 성공해서 `⚠️` 줄조차 안 뜬다. Windows
 *  검증대의 «임시 홈 7개» 보고가 없었으면 여전히 몰랐을 것이다.
 * ★**판정이 아니라 위생**이다. 빨갛게 만들지 않는다(단언 결과를 덮으면 안 된다) — 대신
 *  **말은 한다.** [[feedback_logs_must_stand_alone]]
 */
const countLeftoverHomes = (mine: string, mineRemoved: boolean): string[] => {
  try {
    return readdirSync(tmpdir())
      .filter((n) => {
        if (!n.startsWith("tiguclaw-regression-")) return false;
        // ★★**내 홈을 무조건 빼면, 하필 내 홈이 안 지워진 경우를 못 본다** (2026-09-20,
        //  Windows 검증대가 첫 실행에서 바로 잡았다). 남은 폴더가 **정확히 내 홈 하나**
        //  였는데 이 줄이 그걸 걸러내 `🧹` 가 한 줄도 안 떴다 — 세라고 만든 눈이
        //  **가장 흔한 실패 자리**를 못 보고 있었다.
        //  ★그래서 「지웠는가」로 가른다: 지웠으면 셀 것이 없고(존재하지 않는다), 못
        //  지웠으면 **그것이야말로 남은 폴더**다. `⚠️` 가 사유를 말하고 이 줄이 수를 맞춘다.
        if (mineRemoved && path.join(tmpdir(), n) === mine) return false;
        return true;
      })
      .sort();
  } catch {
    return [];
  }
};

const sweptAtStart = sweepStaleHomes();

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
  let discoveryFailures = 0;
  for (const f of files) {
    const mod = (await import(`./${f.replace(/\.ts$/, ".js")}`)) as {
      check?: RegressionCheck;
    };
    if (mod.check === undefined) {
      console.error(`🔴 ${f} 에 export const check 가 없다 — 회귀 파일 규약 위반.`);
      discoveryFailures += 1;
      continue;
    }
    checks.push(mod.check);
  }
  // 부분 실행도 발견된 검사 파일의 규약 오류를 숨기지 않는다.
  // 검사 실행 전에 반환해야 마지막 성공 판정이 발견 실패를 덮어쓰지 않는다.
  if (discoveryFailures > 0) {
    console.error(`🔴 회귀 스위트 준비 실패 — 검사 파일 규약 위반 ${discoveryFailures}개. 검사를 실행하지 않았습니다.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  (검사 파일 ${checks.length}개 자동 발견)`);
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

/**
 * 임시 홈을 지운다 — **몇 번 다시 해본다**. 못 지우면 사유를 돌려준다.
 *
 * ★★**Windows 에서 이게 스위트를 상시 빨갛게 만들고 있었다** (2026-09-19, 아스트라 3차 §7).
 *  단언 190건이 전부 통과한 **뒤에** 이 줄이 `EPERM` 으로 던져서, 프로세스 종료 코드가
 *  1이 됐다 — 「검사는 통과했는데 명령은 실패」다. 상시 빨간 게이트는 아무도 안 본다.
 * ★뿌리는 **핸들 해제 지연**이다: DB 를 여는 검사들은 자식 프로세스이고, 그 자식이 끝난
 *  직후 Windows 가 파일을 아직 놓지 않았을 수 있다(백신 스캔도 같은 모양을 만든다).
 *  그래서 **잠깐 기다렸다 다시** 하면 대개 지워진다.
 * ★★**그래도 삼키지는 않는다.** 못 지웠으면 **따로 보고**한다 — 판정을 덮지도, 조용히
 *  넘기지도 않는다. 임시 폴더가 쌓이는 것은 그 자체로 알아야 할 사실이다.
 */
/**
 * **러너가 연 저장소를 닫는다** — 삭제보다 **먼저** (2026-09-19, 아스트라 4차 §2).
 *
 * ★★내가 앞서 «자식 핸들 지연» 으로 짚고 **재시도**를 처방한 것은 **오진이었다.** 러너
 *  자신이 `initStore()` 로 DB 를 열고 닫지 않는다 — **우리가 쥔 핸들**이라 기다려도 안 놓는다.
 *  맥에선 열린 파일도 지워져서(POSIX) 안 보였고, Windows 에서만 드러났다.
 */
const closeOwnStore = async (): Promise<void> => {
  try {
    const { closeStore } = await import("../../store/sessions.js");
    closeStore();
  } catch {
    /* 저장소를 안 열었으면 닫을 것도 없다 */
  }
};

const removeHome = (dir: string): string | null => {
  const wait = (ms: number): void => {
    // `finally` 안이라 `await` 를 못 쓴다 — 동기 대기가 필요하다.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return null;
    } catch (e) {
      if (i === 4) return e instanceof Error ? e.message : String(e);
      wait(100 * (i + 1));
    }
  }
  return null;
};

try {
  await main();
} finally {
  // ★**닫고 나서 지운다** — 순서가 계약이다.
  await closeOwnStore();
  const why = removeHome(home);
  if (sweptAtStart > 0) {
    console.log(`\n🧹 지난 실행이 남긴 임시 홈 ${sweptAtStart}개를 시작할 때 쓸어냈다(하루 넘은 것만).`);
  }
  const leftover = countLeftoverHomes(home, why === null);
  if (leftover.length > 0) {
    console.log(
      `\n🧹 남은 임시 폴더 ${String(leftover.length)}개 — 검사가 만들고 안 치운 것이다` +
        `${why === null ? "(내 홈은 지웠으니 뺐다)" : "(★못 지운 내 홈도 센다 — 아래 사유 참조)"}.`,
    );
    console.log(`   ${leftover.slice(0, 8).join(" · ")}${leftover.length > 8 ? " …" : ""}`);
    console.log("   ★판정과 무관하다. 스위퍼는 **하루 넘은 것만** 쓸어서 오늘 것은 여기 아니면 안 보인다.");
  }
  if (why !== null) {
    // ★**판정과 별개의 줄**이다 — 위의 «통과/실패» 가 단언의 정본이고, 이것은 위생 문제다.
    console.log(`\n⚠️ 임시 홈 정리 실패(5회 시도) — ${why}`);
    console.log(`   경로: ${home}`);
    console.log("   ★단언 결과는 위가 정본이다. 이 줄은 **판정을 덮지 않고**, 대신 쌓이는 폴더를 알린다.");
  }
}
