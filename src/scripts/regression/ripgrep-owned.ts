/**
 * 회귀: **검색 도구의 의존성은 우리가 소유한다** (2026-08-09 사용자 결정).
 *
 * `Grep`/`Glob` 은 ripgrep 위에 선다. 그런데 "사용자 기계에 우연히 있으면 동작" 이었다.
 * 실측:
 *  - mac(brew 설치됨) — codex Grep 72회·Glob 54회, **에러 0**. 잘 돌고 있었다.
 *  - **윈도우 — PATH 에도 SDK 동봉에도 rg 가 없다.** codex 검색이 전부 실패했고 사용자는
 *    "왜 못 찾지" 만 겪었다. claude 는 SDK 가 자기 바이너리(259MB) *안에* rg 를 넣고 다녀
 *    혼자 멀쩡했다 — 같은 질문에 어댑터마다 다른 답이 나오는 상태였다.
 *
 * ★그리고 종전 해소 코드는 **한 번도 동작한 적이 없었다**: `require.resolve(
 *  "@anthropic-ai/claude-agent-sdk/package.json")` 이 패키지 `exports` 때문에 항상 throw 해
 *  catch → PATH 폴백으로 떨어졌다. 근거로 삼은 주석("npm tarball 동봉")도 낡았다.
 *
 * 그래서 **온보드·닥터에서 없으면 받아 `<home>/bin` 에 둔다**. `npm install` 시점이 아니다 —
 * postinstall 다운로드는 CI·오프라인·사내 프록시에서 `npm ci` 를 통째로 깨뜨린다.
 *
 * ★등급: **행동 게이트**(해소 순서를 실행) + **배선 린트**(닥터가 실제로 부르는가).
 *  윈도우 실측: 다운로드 2,011KB → 해제 → `<home>\\bin\\rg.exe` → `ripgrep 14.1.1` 실행 확인.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DOCTOR = "../../../src/scripts/doctor.ts";
const FILEOPS = "../../../src/core/llm-runtime/capabilities/file-ops-mcp.ts";

export const check: RegressionCheck = {
  name: "ripgrep-owned",
  guards:
    "Grep/Glob 의 ripgrep 의존성 — 없는 기계에서 codex 검색이 통째로 죽던 것(윈도우 실측)",
  run: async (): Promise<Assertion[]> => {
    const { findRipgrep, managedRgPath, rgBinName, ensureRipgrep } = await import(
      "../../core/ripgrep.js"
    );
    const doctor = await readFile(new URL(DOCTOR, import.meta.url), "utf8");
    const fileops = await readFile(new URL(FILEOPS, import.meta.url), "utf8");

    // ── 판정을 실제로 실행한다 ──
    const bin = rgBinName();
    const managed = managedRgPath("/tmp/regr-home");
    // 우리가 받아두는 자리는 **홈 아래**여야 한다 — 레포/node_modules 는 /update·npm ci 로 날아간다.
    const managedUnderHome =
      managed.startsWith(path.join("/tmp/regr-home", "bin")) && managed.endsWith(bin);
    // 없는 홈을 줘도 터지지 않고, 시스템에 있으면 그걸 찾는다(이 기계엔 있다).
    const found = findRipgrep("/tmp/regr-home-없음");
    // ★다운로드를 끄면 **네트워크를 안 탄다**(회귀가 외부에 의존하면 안 된다).
    const offline = await ensureRipgrep("/tmp/regr-home-없음", { download: false });

    // ── 배선 ──
    const body = doctor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const doctorChecks = /await ensureRipgrep\(getPaths\(\)\.home\)/.test(body);
    const doctorReports = /issues\.push\("ripgrep 없음/.test(body);
    // 런타임이 **같은 판정**을 쓴다 — 여기서 또 뒤지면 "닥터는 찾았다는데 데몬은 못 찾는" 상태가 된다.
    const runtimeShares =
      /findRipgrep\(getPaths\(\)\.home\)/.test(fileops) &&
      !/require\.resolve\([\s\S]{0,80}package\.json/.test(fileops);

    return [
      assert(
        "★받아두는 자리가 **홈 아래**다(레포·node_modules 는 update·npm ci 로 날아간다)",
        managedUnderHome,
        managed,
      ),
      assert(
        "해소가 시스템 설치본도 찾는다(사용자가 직접 깐 것을 무시하지 않는다)",
        found !== null && found.endsWith(bin),
        found ?? "★못 찾음(이 기계엔 rg 가 있어야 한다)",
      ),
      assert(
        "★`download:false` 면 네트워크를 안 탄다(회귀가 외부에 의존하지 않게)",
        offline.installed === false,
        `installed=${String(offline.installed)} ok=${String(offline.ok)}`,
      ),
      assert(
        "★닥터가 확보를 **실제로 호출**한다(없으면 사용자가 원인을 영영 모른다)",
        doctorChecks && doctorReports,
        `호출=${String(doctorChecks)} · 보고=${String(doctorReports)}`,
      ),
      assert(
        "★런타임이 닥터와 **같은 해소**를 쓴다(두 곳이 갈리면 진단이 거짓이 된다)",
        runtimeShares,
        runtimeShares ? "findRipgrep 공유 · 옛 resolve 제거" : "★해소가 두 벌",
      ),
    ];
  },
};
