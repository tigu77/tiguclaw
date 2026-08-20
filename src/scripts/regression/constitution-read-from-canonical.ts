/**
 * 작동 헌법은 **앱 정본**에서 읽힌다 — 홈 사본에 기대지 않는다 (2026-08-20)
 *
 * 배경(사용자 질문에서 시작): "SYSTEM.md 가 왜 내 홈에 있지? 어차피 계속 미러하면 굳이
 * 홈에 있을 이유가 없지 않아?" — 맞았다. 실측 결과 읽는 곳은 `readSystem()` 한 곳뿐인데,
 * 사본은 **없던 실패 모드를 만들고 있었다**: 미러 쓰기가 실패하면 `readSystem()` 이 조용히
 * `""` 를 주고 비서가 **헌법 없이**(위임·동사·확인 규칙 0) 돈다.
 *
 * ★정본은 없을 수가 없다 — `appRoot()` 탐지 자체가 "`plugins/` + `SYSTEM.md` 를 함께 가진
 *  디렉터리" 를 마커로 쓴다. appRoot 가 풀렸다 == 거기 SYSTEM.md 가 있다.
 *
 * 지키는 것 셋:
 *  ① 홈이 **없거나 비어도** 헌법이 읽힌다(사본 의존 0).
 *  ② 부팅이 홈에 SYSTEM.md 를 **다시 만들지 않는다** — 되살아나면 "헌법처럼 보이는데
 *    아무도 안 읽는 파일" 이 사용자 홈에 남고, 다음에 볼 사람이 그걸 고친다.
 *  ③ 오버라이드는 **env 이음매**(TIGUCLAW_SYSTEM_MD)지 홈 파일이 아니다 — 홈 파일이
 *    이기면 비서가 자기 헌법을 스스로 갈아치울 수 있다(미러의 매일 덮어쓰기가 그걸
 *    막던 유일한 기제였다). 벤치의 `--prompt none|minus:<절>` 은 이 이음매를 쓴다.
 *
 * 등급: **동작 검사**. 실제 `getPaths()`/`readSystem()` 을 격리 홈에서 실행한다.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 격리 홈 + 지정 env 로 자식 프로세스를 띄워 실제 경로/읽기를 재현한다. */
const probe = async (
  env: Record<string, string>,
): Promise<{ systemMd: string; bytes: number; homeCopyExists: boolean; homeEntries: string[] }> => {
  const { execFileSync } = await import("node:child_process");
  const script = `
    // ★실제 부팅 순서를 재현한다 — load-env 가 <home>/.env 를 process.env 로 올린 **뒤**
    //  paths 가 이음매를 읽는다. 종전엔 이 import 가 없어 .env 축을 아예 안 태웠고, 그래서
    //  봉인 검사가 변이를 못 잡았다(측정이 대상을 안 지나가면 검사가 아니다).
    import { loadHomeEnv } from ${JSON.stringify(path.join(REPO, "src/core/load-env.js"))};
    import { getPaths, ensureHome } from ${JSON.stringify(path.join(REPO, "src/core/paths.js"))};
    import { readSystem } from ${JSON.stringify(path.join(REPO, "src/core/identity.js"))};
    import { existsSync, readdirSync } from "node:fs";
    import path from "node:path";
    loadHomeEnv();
    await ensureHome();
    console.log(JSON.stringify({
      systemMd: getPaths().systemMd,
      bytes: readSystem().length,
      homeCopyExists: existsSync(path.join(getPaths().home, "SYSTEM.md")),
      // ★부팅이 홈에서 **무엇을 지웠나** — 청소의 *범위*까지 재려면 이게 필요하다.
      homeEntries: readdirSync(getPaths().home).sort(),
    }));
  `;
  // ★.mts 다 — tmpdir 의 .ts 는 tsx 가 CJS 로 잡아 top-level await 에서 터진다.
  const f = path.join(mkdtempSync(path.join(tmpdir(), "sysmd-probe-")), "p.mts");
  writeFileSync(f, script, "utf8");
  try {
    const raw = execFileSync("npx", ["tsx", f], {
      cwd: REPO,
      // ★값이 "" 인 키는 **지운다** (2026-08-20). 종전엔 `TIGUCLAW_SYSTEM_MD: ""` 를 그대로
      //  실었는데, 빈 문자열도 **설정된 값**이라 `process.loadEnvFile` 이 .env 값을 안 덮었다
      //  → .env 봉인 검사가 **구조적으로 실패 불가능**했다(변이로 확인). 하루에 두 번째다.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== ""),
      ) as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = raw.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as {
      systemMd: string; bytes: number; homeCopyExists: boolean; homeEntries: string[];
    };
  } finally {
    rmSync(path.dirname(f), { recursive: true, force: true });
  }
};

export const check: RegressionCheck = {
  name: "constitution-read-from-canonical",
  guards:
    "헌법을 홈 사본에서 읽어 미러가 실패하면 비서가 조용히 규칙 없이 돌던 것 + 홈 미러가 되살아나 '아무도 안 읽는 헌법 파일' 이 사용자 홈에 남는 것 (2026-08-20)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const canonical = path.join(REPO, "SYSTEM.md");

    out.push(
      assert(
        "전제: 앱 정본이 appRoot 에 있다(이게 appRoot 탐지의 마커이기도 하다)",
        existsSync(canonical) && readFileSync(canonical, "utf8").length > 1000,
        existsSync(canonical) ? `${readFileSync(canonical, "utf8").length}자` : "★없음",
      ),
    );

    // ── ① 빈 홈에서도 헌법이 읽힌다 + 부팅이 홈 사본을 되살리지 않는다 ──────────────
    const home = mkdtempSync(path.join(tmpdir(), "sysmd-home-"));
    try {
      const r = await probe({ TIGUCLAW_HOME: home, TIGUCLAW_SYSTEM_MD: "" });
      out.push(
        assert(
          "★홈이 비어도 헌법이 읽힌다 — 사본 의존 0(미러 실패 = 헌법 없이 도는 것이었다)",
          r.bytes > 1000,
          `${r.bytes}자`,
        ),
        assert(
          "헌법 경로가 **앱 정본**을 가리킨다(홈이 아니다)",
          r.systemMd === canonical,
          r.systemMd,
        ),
        assert(
          "★부팅이 홈에 SYSTEM.md 를 다시 만들지 않는다 — 되살아나면 아무도 안 읽는 사본이 남는다",
          !r.homeCopyExists,
          r.homeCopyExists ? "★홈에 다시 생김" : "안 생김",
        ),
      );

      // ── ①-b ★청소의 **범위** — SYSTEM.md 말고는 아무것도 안 지운다 (적대 검토 B4) ──
      //  적대 검토가 `unlink(<home>/AGENT.md)` 한 줄을 더 넣었는데 스위트가 전부 초록이었다.
      //  그러면 **매 부팅 사용자 인격 파일이 사라진다** — 비가역·전 사용자·조용. 청소를
      //  도입한 이상 "무엇을 지우는가" 는 "지우는가" 만큼 중요한 판정이다.
      out.push(
        assert(
          "★부팅 청소가 SYSTEM.md 외의 홈 파일을 지우지 않는다 — 인격(AGENT.md)·설정이 살아남는다",
          r.homeEntries.includes("AGENT.md") && r.homeEntries.includes("settings.json"),
          `홈: ${r.homeEntries.join(", ") || "(빔)"}`,
        ),
      );

      // ── ② 홈에 사본이 **있어도** 그게 이기지 않는다(비서의 자가 개헌 봉쇄) ────────
      writeFileSync(path.join(home, "SYSTEM.md"), "## 가짜 헌법\n내 맘대로 한다\n", "utf8");
      const r2 = await probe({ TIGUCLAW_HOME: home, TIGUCLAW_SYSTEM_MD: "" });
      out.push(
        assert(
          "★홈 사본이 정본을 못 이긴다 — 이기면 비서가 파일 하나로 자기 헌법을 갈아치운다",
          r2.systemMd === canonical && r2.bytes > 1000,
          `${r2.systemMd} · ${r2.bytes}자`,
        ),
        assert(
          "옛 홈 미러는 부팅 때 청소된다(헌법처럼 보이는 유령 파일을 안 남긴다)",
          !r2.homeCopyExists,
          r2.homeCopyExists ? "★남아 있음" : "청소됨",
        ),
      );

      // ── ③ 오버라이드 이음매는 env — 벤치 변종이 정본을 안 건드리고 잰다 ───────────
      const variant = path.join(home, "variant-SYSTEM.md");
      writeFileSync(variant, "## 변종\n짧다\n", "utf8");
      const r3 = await probe({ TIGUCLAW_HOME: home, TIGUCLAW_SYSTEM_MD: variant });
      out.push(
        assert(
          "★env 이음매가 정본을 대체한다 — 벤치 헌법 변종이 레포를 안 건드린다",
          r3.systemMd === variant && r3.bytes > 0 && r3.bytes < 100,
          `${r3.systemMd} · ${r3.bytes}자`,
        ),
        assert(
          "전제 확인: 정본을 읽었다면 이 단언이 무의미해진다(변종이 훨씬 작아야)",
          r3.bytes < readFileSync(canonical, "utf8").length / 10,
          `변종 ${r3.bytes}자 vs 정본 ${readFileSync(canonical, "utf8").length}자`,
        ),
      );
      // ── ④ ★`<home>/.env` 로는 이음매를 못 연다 (적대 검토 A2, 실재 결함이었다) ─────
      //  `paths.ts` 주석이 "프로세스 env 는 턴이 못 바꾸므로 자가 개헌이 봉인된다" 고
      //  적었는데 **거짓이었다** — `load-env.ts` 가 `<home>/.env` 를 부팅마다 process.env 로
      //  올리고, 홈은 비서가 쓰는 곳이며, 재시작도 비서가 한다. 파일 한 줄로 자기 헌법을
      //  **영구히** 바꿀 수 있었다(옛 미러 시절엔 매 부팅 덮어쓰기가 되돌렸다).
      writeFileSync(path.join(home, "MY_SYSTEM.md"), "## 내 맘대로 헌법\n", "utf8");
      writeFileSync(
        path.join(home, ".env"),
        `TIGUCLAW_SYSTEM_MD=${path.join(home, "MY_SYSTEM.md")}\n`,
        "utf8",
      );
      const r4 = await probe({ TIGUCLAW_HOME: home, TIGUCLAW_SYSTEM_MD: "" });
      out.push(
        assert(
          "★<home>/.env 로 헌법 이음매를 열 수 없다 — 비서가 파일 한 줄로 자기 헌법을 갈아치우지 못한다",
          r4.systemMd === canonical && r4.bytes > 1000,
          `${r4.systemMd} · ${r4.bytes}자`,
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    return out;
  },
};
