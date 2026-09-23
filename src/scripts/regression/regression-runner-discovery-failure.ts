/**
 * 실제 러너 사본의 발견 실패/정상/부분 실행 판정. DB 만 무동작 fixture로 대체한다.
 * (러너는 제품 모듈을 정적 import 하지 않으므로 환경 로더 대역은 필요 없다 — 2026-09-23.
 *  러너의 `.env` 미접근은 `regression-runner-env-isolation` 이 잰다.)
 * ★임시 폴더 변수(TMPDIR·TEMP·TMP)를 전부 fixture 루트로 준다 — 러너 사본의 «지난 임시 홈
 *  쓸기» 가 Windows 에선 `TEMP`/`TMP` 를 보므로, `TMPDIR` 만 주면 **실제 임시 폴더**를 훑는다.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "regression-runner-discovery-failure",
  guards: "검사 파일 규약 오류를 마지막 성공 판정이 덮어쓰고 전체/부분 실행을 정상으로 보고하던 것",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const assertions: Assertion[] = [];
    const runner = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    for (const scenario of ["valid", "partial", "missing", "missing-partial", "all-missing", "assertion-failed", "filter-miss"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-discovery-"));
      try {
        const dir = path.join(root, "src/scripts/regression");
        mkdirSync(dir, { recursive: true });
        mkdirSync(path.join(root, "src/core"), { recursive: true });
        mkdirSync(path.join(root, "src/store"), { recursive: true });
        writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
        writeFileSync(path.join(root, "src/store/sessions.ts"), "export const initStore = () => {};\n");
        writeFileSync(path.join(dir, "run.ts"), runner);
        writeFileSync(path.join(dir, "_runtime-preflight.ts"), readFileSync(new URL("./_runtime-preflight.ts", import.meta.url), "utf8"));
        const broken = ["missing", "missing-partial", "all-missing"].includes(scenario);
        if (broken) writeFileSync(path.join(dir, "broken.ts"), "export const wrong = true;\n");
        if (scenario !== "all-missing") writeFileSync(path.join(dir, "valid.ts"),
          `export const check = { name: "fixture", guards: "fixture", run: async () => { console.log("FIXTURE_EXECUTED"); return [{ name: "fixture", ok: ${scenario !== "assertion-failed"}, got: "fixture" }]; } };`);
        const args = scenario === "filter-miss" ? ["absent"] : scenario.includes("partial") ? ["fixture"] : [];
        const result = spawnSync(process.execPath,
          ["--import", pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href, path.join(dir, "run.ts"), ...args],
          { cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root }, encoding: "utf8", timeout: 20_000 });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        const success = scenario === "valid" || scenario === "partial";
        assertions.push(assert(`${scenario}: 실제 종료 코드`, !result.error && result.status === (success ? 0 : 1), { code: result.status, error: result.error?.message, output }));
        if (broken) {
          assertions.push(assert(`${scenario}: 준비 실패를 최종 판정으로 보고`, /^🔴 회귀 스위트 준비 실패/m.test(output) && !/^✅ 회귀 스위트 통과|^⚠️ 부분 실행/m.test(output), output));
          assertions.push(assert(`${scenario}: 발견 오류가 있으면 검사 본문 미실행`, !output.includes("FIXTURE_EXECUTED"), output));
        } else if (scenario === "valid" || scenario === "partial") {
          assertions.push(assert(`${scenario}: 정상 검사를 실제 실행하고 전체/부분을 구분`, output.includes("FIXTURE_EXECUTED") && (scenario === "valid" ? /^✅ 회귀 스위트 통과/m.test(output) : /^⚠️ 부분 실행/m.test(output) && !/^✅ 회귀 스위트 통과/m.test(output)), output));
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    return assertions;
  },
};
