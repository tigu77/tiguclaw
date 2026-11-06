/**
 * 회귀: **파일 symlink 생성이 거부되는 환경에서도 링크 4검사가 끝까지 돈다** (2026-11-05 — 설계
 * docs/decisions/2026-11-05-v082-windows-secret-acl-and-link-tests.md ③·R2 #3).
 *
 * 사고(v7 Windows 무권한 계정): 네 검사가 fixture 의 **파일** symlink 에서 EPERM 으로 던져, 그 뒤 단언이 통째로 미검증이었다.
 * 고친 뒤의 계약 — 거부되면 그 링크에 기대는 단언만 `skip`(통과로 세지 않음), 나머지와 무권한 대체 단언은 끝까지 실행.
 *
 * 맥에선 파일 symlink 가 늘 되므로 거부 분기를 **주입**으로만 돌린다: `_test-links.mjs` 의 시험 전용 환경으로 `linkFile` 이
 * Windows 거부를 흉내 낸다(경합 자식은 환경을 물려받는다). 같은 프로세스에서 네 검사의 `run()` 을 직접 부른다.
 * 기대하는 미실행 이름은 각 검사가 내보내는 `FILE_LINK_ASSERTIONS` 에서 가져온다(여기서 이름을 다시 적지 않는다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, skip, type Assertion, type RegressionCheck } from "./_framework.js";
import { spawnProbe } from "./_probe-helpers.js";
import * as fileEdit from "./file-edit-concurrency.js";
import * as mcpConfig from "./mcp-config-concurrent-writes.js";
import * as fileView from "./file-view-current-file.js";
import * as savedScreen from "./saved-screen-recovery.js";

/** `./_test-links.mjs`(배포되는 회귀 쪽 원천 — `bench/isolation/test-links.mjs` 는 이것을 다시 내보낼 뿐)에서 회귀가 쓰는 모양. */
export type TestLinks = {
  WINDOWS_FILE_LINK_SKIP: string;
  FILE_LINK_NOT_RUN: string;
  SIMULATE_FILE_LINK_REFUSAL_ENV: string;
  linkDir: (target: string, at: string) => void;
  /** 만들었으면 `true`, 이 환경이 파일 symlink 를 거부하면 사유 문자열. 그 밖 예외는 던진다. */
  linkFile: (target: string, at: string) => true | string;
};

type LinkCheck = { check: RegressionCheck; FILE_LINK_ASSERTIONS: readonly string[]; LINK_FREE_COVERAGE: readonly string[] };
const TARGETS: readonly LinkCheck[] = [fileEdit, mcpConfig, fileView, savedScreen];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "file-link-refusal-continues",
  guards: "무권한 Windows 에서 파일 symlink 생성이 EPERM 이라 링크 4검사가 통째로 예외로 끝나 뒤 단언이 미검증이던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const links = await loadPluginModule<TestLinks>("./_test-links.mjs");
    const key = links.SIMULATE_FILE_LINK_REFUSAL_ENV;
    const prev = process.env[key];
    const out: Assertion[] = [];
    // 주입 없이(이 환경 그대로) 한 번 — 단언 이름 집합의 기준. 검사가 기대 목록과 단언을 **함께** 지우면 거부 실행만 봐선 모른다.
    //  ★기준은 파일 링크를 **실제로 만든** 실행이어야 한다 — 이 환경도 거부하면(무권한 Windows) 기준과 주입이 같은 분기라 비교가
    //   무의미하니 그 비교는 «미측정» 으로 남긴다(통과로 세지 않는다). 물려받은 주입 값도 기준 실행 전에 걷는다.
    const normal = new Map<string, { names: string[]; refused: boolean }>();
    try {
      delete process.env[key];
      for (const t of TARGETS) {
        const r = await t.check.run();
        normal.set(t.check.name, { names: r.map((x) => x.name).sort(), refused: r.some((x) => x.skip !== undefined) });
      }
      process.env[key] = "1";
      for (const t of TARGETS) {
        const name = t.check.name;
        let results: Assertion[];
        try {
          results = await t.check.run();
        } catch (e) {
          out.push(assert(`${name}: 파일 symlink 거부에서도 검사가 예외 없이 끝까지 돈다`, false, e instanceof Error ? e.message : String(e)));
          continue;
        }
        const skips = results.filter((r) => r.skip !== undefined);
        const base = normal.get(name)!;
        const sameNamesLabel = `${name}: 거부 실행의 단언 이름 집합이 링크를 만든 실행과 같다(미실행도 사라지지 않고 이름으로 남는다)`;
        out.push(
          base.refused
            ? skip(sameNamesLabel, `${links.WINDOWS_FILE_LINK_SKIP}: 이 환경은 기준 실행도 파일 symlink 가 거부돼 이름 집합을 비교할 수 없다 — 미측정`)
            : assert(sameNamesLabel, JSON.stringify(results.map((r) => r.name).sort()) === JSON.stringify(base.names), { refused: results.map((r) => r.name).sort(), normal: base.names }),
        );
        const skipNames = skips.map((r) => r.name).sort();
        const expected = [...t.FILE_LINK_ASSERTIONS].sort();
        out.push(
          assert(
            `${name}: 미실행은 파일 symlink 고유 단언과 정확히 같다(${expected.length}건) · 사유에 거부 표식`,
            expected.length > 0 && JSON.stringify(skipNames) === JSON.stringify(expected) &&
              skips.every((r) => r.skip!.includes(links.WINDOWS_FILE_LINK_SKIP) && r.skip!.includes(links.FILE_LINK_NOT_RUN)),
            { skipped: skips.map((r) => ({ name: r.name, reason: r.skip })), expected },
          ),
        );
        const bad = results.filter((r) => r.skip === undefined && !r.ok);
        out.push(
          assert(
            `${name}: 파일 symlink 거부에서도 나머지 단언은 전부 실행·통과`,
            bad.length === 0 && results.length > skips.length,
            { ran: results.length - skips.length, failed: bad.map((r) => ({ name: r.name, got: r.got.slice(0, 300) })) },
          ),
        );
        const missing = t.LINK_FREE_COVERAGE.filter((n) => !results.some((r) => r.name === n && r.skip === undefined && r.ok));
        out.push(
          assert(
            `${name}: 파일 링크 없이 도는 대체·유지 단언(${t.LINK_FREE_COVERAGE.length}건)이 실행·통과`,
            t.LINK_FREE_COVERAGE.length > 0 && missing.length === 0,
            { expected: t.LINK_FREE_COVERAGE, missing },
          ),
        );
      }
      // ── 실제 러너가 미실행을 어떻게 세나(자식으로 러너를 돌린다 — `regression-runner-partial-is-not-green` 과 같은 방식) ──
      //  미실행은 통과 수에서 빠지고 · 실패로 세지 않고(exit 0) · 검사 줄은 ⏭️ · 요약에 비대상으로 남아야 한다. 이걸 지키는 단언이 없었다
      //  (독립 변이 사냥 11-05: 러너의 집계 줄 셋을 바꿔도 스위트가 초록).
      const probe = savedScreen.check.name;
      const inProc = await savedScreen.check.run();
      const expectSkips = inProc.filter((r) => r.skip !== undefined).length;
      const expectMeasured = inProc.length - expectSkips;
      const r = spawnProbe(REPO, ["src/scripts/regression/run.ts", probe], { cwd: REPO, env: { ...process.env }, encoding: "utf8", timeout: 180_000 });
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const lineOf = (re: RegExp) => text.split("\n").map((l) => l.trim()).find((l) => re.test(l)) ?? "";
      const checkLine = lineOf(new RegExp(`^\\S+ ${probe} \\(`));
      const verdict = lineOf(/^(⚠️ 부분 실행|🔴 부분 실행)/);
      const summary = lineOf(/^⏭️ 명시적 비대상/);
      const skipLines = text.split("\n").filter((l) => l.includes("⏭️ SKIP") && l.includes(links.WINDOWS_FILE_LINK_SKIP)).length;
      out.push(
        assert(
          "★러너: 파일 링크 미실행은 통과 수에서 빠지고 실패로 세지 않으며(exit 0) 검사 줄은 ⏭️ · 요약에 «명시적 비대상» 으로 남는다",
          expectSkips > 0 && r.status === 0 && checkLine.startsWith(`⏭️ ${probe} (${expectMeasured}건`) &&
            verdict.startsWith(`⚠️ 부분 실행 — ${expectMeasured}건 이상 없음`) && summary.startsWith(`⏭️ 명시적 비대상 ${expectSkips}건`) &&
            skipLines === expectSkips,
          { status: r.status, expectMeasured, expectSkips, checkLine: checkLine.slice(0, 120), verdict: verdict.slice(0, 120), summary, skipLines, error: r.error?.message },
        ),
      );
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    return out;
  },
};
