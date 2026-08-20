/**
 * 배경 스폰 칩은 **라이브와 이력에서 똑같이** 보인다 (2026-08-20 사용자 신고)
 *
 * 신고: "런인백그라운드나 스폰에이전트 도구에서 누구를 소환했다 정보와 배지도 없어졌다."
 *
 * 원인: 도구 스텝 렌더러가 **두 벌**이었다 —
 *  - `virtualization.js:buildActivityLine` (라이브): 모델·시퀀스 메타 + `🤖 백그라운드 ↗` 칩 있음
 *  - `history-render.js:buildHistStepLine` (이력): **둘 다 없음**
 * 그런데 이력 쪽 주석은 *"라이브 buildActivityLine 과 **동형**"* 이라고 적혀 있었다.
 * 그래서 턴이 도는 동안엔 칩이 보이다가, **끝나서 이력으로 다시 그려지는 순간 사라졌다.**
 * (같은 판단이 두 곳 → 한쪽이 늙는다. 그리고 늙은 쪽이 "동형" 이라고 주장하고 있었다.)
 *
 * 고침: 판정을 `util.js:isSpawnStep` 한 곳으로 뽑고 **양쪽이 그걸 부른다**.
 *
 * ★이 검사는 문자열이 아니라 **판정을 실행**한다 — 두 렌더러가 같은 함수를 쓰는지는
 *  소스로 보되(그게 파리티의 정의다), 그 함수가 실제로 무엇을 참으로 보는지는 돌려서 본다.
 *  종전 조건(이름 5개 열거)이 어댑터를 넘나들며 두 번 늙었던 자리라 열거가 아니라 판정이다.
 *
 * 등급: **동작 검사**(판정) + **배선 검사**(두 렌더러가 같은 판정을 쓰는가).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS = path.join(REPO, "packages/dashboard/js");

export const check: RegressionCheck = {
  name: "spawn-badge-parity",
  guards:
    "배경 스폰 칩·메타가 라이브에만 있고 이력 렌더러엔 없어, 턴이 끝나 다시 그려지는 순간 조용히 사라지던 것 (2026-08-20 사용자 신고)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const util = readFileSync(path.join(JS, "util.js"), "utf8");
    const live = readFileSync(path.join(JS, "virtualization.js"), "utf8");
    const hist = readFileSync(path.join(JS, "history-render.js"), "utf8");

    // ── ① 판정을 **실행**한다 ────────────────────────────────────────────────────
    const m = /      const isSpawnStep = \([\s\S]*?\n      \};/.exec(util);
    if (m === null) {
      return [
        assert("util.js 에 isSpawnStep 이 있다(공용 판정)", false, "★못 찾음 — 시그니처가 바뀌었나"),
      ];
    }
    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(`${m[0]}\nthis.__f = isSpawnStep;`, ctx);
    const f = ctx.__f as (label: unknown, jobId?: unknown) => boolean;

    const cases: Array<[string, boolean, unknown, unknown]> = [
      ["codex/openai spawn_agent", true, "spawn_agent", undefined],
      ["codex/openai run_in_background", true, "run_in_background", undefined],
      ["claude native Task", true, "Task", undefined],
      ["claude native Agent (SDK 0.3 개명)", true, "Agent", undefined],
      ["claude MCP 라벨(접두사 흡수)", true, "mcp__agents__spawn_agent", undefined],
      ["claude MCP 워커 라벨", true, "mcp__workers__run_in_background", undefined],
      ["jobId 가 있으면 라벨 무관", true, "무엇이든", "job-1"],
      ["평범한 도구는 아니다", false, "Read", undefined],
      ["비슷하지만 다른 이름", false, "spawn_agent_list", undefined],
      ["라벨 없음", false, undefined, undefined],
    ];
    for (const [name, want, label, jobId] of cases) {
      const got = f(label, jobId);
      out.push(assert(`판정: ${name}`, got === want, `${String(got)} (기대 ${String(want)})`));
    }

    // ── ② 두 렌더러가 **같은 판정**을 쓴다 ───────────────────────────────────────
    //  파리티의 정의가 "같은 함수를 부른다" 이므로 이 축은 소스로 본다. 대신 조건을
    //  **재구현했는지**(이름 열거가 되살아났는지)까지 같이 본다 — 그게 늙는 방식이었다.
    out.push(
      assert(
        "★라이브 렌더러가 공용 판정을 쓴다",
        /isSpawnStep\(/.test(live),
        /isSpawnStep\(/.test(live) ? "사용" : "★자체 조건으로 되돌아감",
      ),
      assert(
        "★이력 렌더러가 **같은** 공용 판정을 쓴다 — 여기가 비어서 배지가 사라졌었다",
        /isSpawnStep\(/.test(hist),
        /isSpawnStep\(/.test(hist) ? "사용" : "★없음 — 이력에선 배지가 안 뜬다",
      ),
      assert(
        "★이력 렌더러가 배경 칩을 실제로 만든다(판정만 부르고 안 붙이면 소용없다)",
        /act-bg-link/.test(hist) && /백그라운드 ↗/.test(hist),
        /act-bg-link/.test(hist) ? "칩 생성" : "★칩 없음",
      ),
      assert(
        "이력 스텝도 모델·시퀀스 메타를 보여준다(라이브 파리티)",
        /hist-tool-meta/.test(hist),
        /hist-tool-meta/.test(hist) ? "있음" : "★없음",
      ),
      assert(
        "메타에 스타일이 있다 — 클래스만 붙이고 CSS 가 없으면 자리를 못 잡는다",
        readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8").includes(
          ".hist-tool-meta",
        ),
        "CSS 존재",
      ),
      assert(
        "★조건을 어느 쪽도 **재구현하지 않는다** — 이름 열거가 되살아나면 다시 갈린다",
        !/endsWith\("spawn_agent"\)/.test(live) && !/endsWith\("spawn_agent"\)/.test(hist),
        "열거 없음",
      ),
    );

    return out;
  },
};
