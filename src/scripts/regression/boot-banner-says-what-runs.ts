/**
 * 회귀: **부팅 첫 줄이 «무엇이 어디서 도는가» 를 말한다** (2026-09-06 정태님 지적).
 *
 * 배경: 이 레포의 **1차 진단면은 로그**다 — 회사돌쇠·회사 PC 는 원격 접속이 안 되고,
 * 윈도우는 붙어도 결국 로그를 본다([[feedback_logs_must_stand_alone]]). 그런데 부팅
 * 로그에 **버전이 없었다**(`tiguclaw daemon: starting` 한 마디). 그래서 «지금 저기서
 * 어느 버전이 도는가» 를 로그만으로는 답할 수 없었다. 릴리스 뒤 확인을 원격에서 하려면
 * 이게 선행 조건이다.
 *
 * ★런타임은 **선언(env)이 아니라 실물 경로에서 파생**한다. `TIGUCLAW_RUNTIME` 은 실행기가
 *  적어주는 값이라 실제와 갈릴 수 있고, 이 레포는 «선언과 실물이 갈려» 데인 전례가 있다.
 *  `dist/` 에서 돌고 있으면 built 다 — 누가 뭐라고 적었든.
 *
 * ★그리고 **진단이 진단 대상을 죽이면 안 된다.** `appBuildId()` 는 `git` 을 실행하고
 *  `import.meta.url` 은 문맥에 따라 없을 수 있다(`tsx -e` 에서 실제로 undefined 였다).
 *  배너를 못 찍는 것과 데몬이 안 뜨는 것은 격이 다르므로, 실패하면 옛 한 줄로 물러난다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "boot-banner-says-what-runs",
  guards:
    "부팅 로그에 버전이 없어 원격 인스턴스(붙을 수 없는 곳)에서 «어느 버전이 도는가» 를 로그만으로 답할 수 없던 것 + 그 진단 한 줄이 부팅을 죽일 수 있는 구조",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readFileSync(path.join(REPO, "src/index.ts"), "utf8");
    const m = /console\.log\(\s*`tiguclaw daemon: starting[^`]*`/.exec(src);
    const banner = m?.[0] ?? "";
    out.push(
      assert(
        "부팅 첫 줄에 배너가 있다",
        banner !== "",
        banner === "" ? "★`daemon: starting` 배너를 못 찾음" : `${banner.length}자`,
      ),
    );
    if (banner === "") return out;

    const carries = [
      ["버전", /appVersion\(\)/],
      ["런타임", /runtimeKind/],
      ["빌드 id", /appBuildId\(\)/],
      ["node", /process\.version/],
      ["pid", /process\.pid/],
    ] as const;
    const missing = carries.filter(([, re]) => !re.test(banner)).map(([n]) => n);
    out.push(
      assert(
        "★★배너가 «무엇이 어디서 도는가» 를 싣는다 — 버전 없는 로그로는 원격에서 아무것도 판정 못 한다",
        missing.length === 0,
        missing.length === 0
          ? `싣는 것: ${carries.map(([n]) => n).join(" · ")}`
          : `★빠진 것: ${missing.join(", ")}`,
      ),
    );

    // ★런타임 판정이 **파생**이다 — env 선언을 읽으면 실물과 갈릴 수 있다.
    const derived = /const runtimeKind = \(import\.meta\.url \?\? ""\)\.includes\("\/dist\/"\)/.test(src);
    out.push(
      assert(
        "런타임을 실물 경로에서 파생한다(선언 env 를 믿지 않는다)",
        derived,
        derived ? "import.meta.url 에 /dist/ 가 있나" : "★TIGUCLAW_RUNTIME 선언을 읽는다면 실물과 갈릴 수 있다",
      ),
    );

    // ★진단이 부팅을 죽이지 않는다 — 배너 전체가 try 안에 있고 폴백이 있다.
    const guarded =
      /try \{[\s\S]{0,600}?tiguclaw daemon: starting[\s\S]{0,400}?\} catch \{[\s\S]{0,200}?tiguclaw daemon: starting/.test(
        src,
      );
    out.push(
      assert(
        "★배너 실패가 부팅을 막지 않는다(try + 옛 한 줄 폴백) — `appBuildId()` 는 git 을 실행한다",
        guarded,
        guarded ? "try/catch + 폴백 확인" : "★감싸지 않았다 — 진단 한 줄이 데몬을 죽일 수 있다",
      ),
    );
    return out;
  },
};
export default check;
