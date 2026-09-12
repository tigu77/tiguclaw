/**
 * 회귀: **격리용 `DATA_DIR` 봉인이 `.env` 로드에 되살아나지 않는다** (2026-09-11 G5).
 *
 * 사고 전 상태: 회귀 러너와 `e2e-openrouter` 가 `delete process.env.DATA_DIR` 로 격리했다.
 * 그런데 그건 **되살아난다** —
 *
 *  1. `load-env.ts` 는 부팅 1회 멱등이지만 그 1회가 `delete` 보다 **나중**이다(두 스크립트
 *     모두 대부분을 동적 import 하고, 그 체인 어딘가가 `load-env` 를 탄다 — 러너 실행 로그에
 *     `[env] loaded …` 가 실제로 찍힌다).
 *  2. `process.loadEnvFile` 은 **비어 있는 키를 채운다.** 그래서 지워 둔 `DATA_DIR` 자리에
 *     `.env` 값이 그대로 들어온다.
 *  3. `resolveDataDir()`(`store/sessions.ts`)은 `DATA_DIR` 을 **`TIGUCLAW_HOME` 보다 우선**해서
 *     본다 → 그 시점부터 검사들이 **그 경로**를 친다. 러너 주석이 적었듯 **삭제 문을 쓰는
 *     검사가 있다.**
 *
 * 실측(격리 프로브): `delete` 직후 `undefined` → `load-env` 를 타는 모듈 import 후
 * `"…/LIVE_DATA"` → `resolveDataDir()` 이 그 경로를 반환. 오늘 레포 `.env` 에 `DATA_DIR` 이
 * **없어서** 안 터졌을 뿐이고, 한 줄 추가되는 날 터진다.
 *
 * ★고침: 지우지 말고 **빈 문자열로 못박는다.** `loadEnvFile` 은 **키가 있으면 안 덮으므로**
 *  그게 봉인이 되고, `resolveDataDir()` 은 빈 값을 «미설정» 으로 봐 **홈 기준**으로 간다.
 *
 * ★**임시 경로로 못박는 것은 틀렸다** — 처음에 그렇게 고쳤다가 전체 스위트가 **37건 실패 ·
 *  총 건수 3,247 → 2,894** 로 무너졌다. 자식 프로세스를 띄우는 검사들이 그 값을 **상속**받아
 *  전부 **같은 DB** 를 쳤기 때문이다(종전 `delete` 에는 «자식이 각자 자기 홈을 잡는다» 는
 *  숨은 효과가 있었다). 빈 문자열만이 둘을 다 만족한다 — 그래서 ①이 «어떤 값인가» 가 아니라
 *  «빈 값이 봉인으로 작동하는가» 를 재고, ②가 대조군으로 «지우면 뚫린다» 를 재며, 자식 상속
 *  축은 스위트 전체가 매일 증명한다(지금 이 줄이 그 안에서 돌고 있다).
 *
 * ★이 검사는 **돌려서** 잰다 — 소스에 `delete` 가 없는지만 보면 «왜 안 되는지» 를 못 잰다.
 *  그리고 **대조군**(`delete` 방식이면 실제로 뚫린다)을 같이 돌린다: 그게 없으면 이 검사가
 *  무엇을 막는지 다음 사람이 알 수 없고, Node 가 `loadEnvFile` 의 «안 덮는다» 성질을 바꾸는
 *  날 이 봉인이 조용히 무의미해진 것도 못 본다.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 격리된 자식에서 `loadEnvFile` 뒤의 `DATA_DIR` 을 찍어 본다. */
const probe = (mode: "seal" | "delete", envPath: string, sealed: string): string => {
  const script =
    mode === "seal"
      ? `process.env.DATA_DIR=${JSON.stringify(sealed)};`
      : `delete process.env.DATA_DIR;`;
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `${script}process.loadEnvFile(${JSON.stringify(envPath)});` +
        `console.log("__R__"+String(process.env.DATA_DIR));`,
    ],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, DATA_DIR: "" } },
  );
  const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__R__"));
  return line === undefined ? `★프로브 실패: ${(r.stderr ?? "").slice(-160)}` : line.slice(5);
};

export const check: RegressionCheck = {
  name: "data-dir-seal-survives-env-load",
  guards:
    "회귀 러너·e2e 가 `delete process.env.DATA_DIR` 로 격리해서, `.env` 로드가 그 자리를 다시 " +
    "채우면 검사들이 **라이브 데이터 디렉터리**를 치던 것(삭제 문을 쓰는 검사가 있다)",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const tmp = mkdtempSync(path.join(tmpdir(), "datadir-seal-"));
    const envPath = path.join(tmp, ".env");
    const trap = path.join(tmp, "TRAP_LIVE_DATA");
    // ★봉인값은 **빈 문자열**이다(임시 경로가 아니다 — 헤더의 «37건 실패» 참조).
    const sealed = "";
    writeFileSync(envPath, `DATA_DIR=${trap}\n`, "utf8");

    // ── ① 기제 — `loadEnvFile` 은 **빈 키를 채운다** ──────────────────────────────
    // ★이게 결함의 엔진이다. 지워 둔 자리는 «없는 키» 라서 그대로 채워진다. 그러니 `delete`
    //  가 **나중**이 아니면 격리가 성립하지 않는다.
    const afterDelete = probe("delete", envPath, sealed);
    out.push(
      assert(
        "★★지운 뒤 `.env` 를 로드하면 `DATA_DIR` 이 **되살아난다** — 지운 자리는 «없는 키» 라 `loadEnvFile` 이 채운다(그 상태로 `resolveDataDir()` 은 그 경로를 반환한다)",
        afterDelete === trap,
        `로드 후 = ${afterDelete}`,
      ),
      assert(
        "★반대로 **값이 있으면 안 덮는다** — 두 성질이 짝이라, 이게 깨지면 순서를 고쳐도 소용없어진다(Node 동작 변화 감시)",
        probe("seal", envPath, sealed) === sealed,
        `로드 후 = ${JSON.stringify(probe("seal", envPath, sealed))}`,
      ),
    );

    // ── ② 그래서 두 격리 지점이 `.env` 로드를 **먼저** 끝내는가 ────────────────────
    // ★봉인 «값» 을 넣는 쪽으로 고치면 안 된다 — 실측으로 둘 다 무너졌다: 임시 경로는 자식이
    //  **상속**받아 전부 같은 DB 를 치고(37건 실패), 빈 문자열은 `_framework.ts` 의
    //  `assertIsolated()` 가 «설정됨» 으로 보고 던진다(35건 실패). 이 레포의 계약은 «지운다»
    //  이고, 고칠 것은 **순서**였다. 그래서 여기서 재는 것도 «무엇으로 지우나» 가 아니라
    //  «`.env` 로드가 그 지움보다 앞서 끝나나» 다.
    // ★프로세스 시작 시점이라 돌려서 잴 수 없는 자리다 — 소스 순서로 본다(정직하게 밝힌다).
    // ★배포 레포엔 `e2e-*` 가 **없다**(manifest 가 `^src/scripts/(e2e-|verify-|probe-)` 를
    //  제외한다). 종전엔 그냥 읽어서 배포 트리 회귀가 **ENOENT 로 던졌다**(실측 2026-09-12
    //  dev 싱크). 없는 대상을 조용히 통과시키지 않고 **없다고 말하고** 넘긴다 — 있는데
    //  순서가 틀린 것과 애초에 대상이 아닌 것은 다른 사실이다(sync-public §8 의 규칙).
    for (const rel of ["src/scripts/regression/run.ts", "src/scripts/e2e-openrouter.ts"]) {
      const abs = path.join(REPO, rel);
      if (!existsSync(abs)) {
        out.push(
          assert(
            `★${rel} 은 이 트리에 **없다** — 배포 레포는 dev 전용 스크립트를 안 싣는다(대상 아님)`,
            true,
            "배포 트리: 대상 없음(조용한 통과가 아니라 명시)",
          ),
        );
        continue;
      }
      const src = readFileSync(abs, "utf8");
      const envAt = src.search(/^import\s+"[^"]*load-env\.js";/m);
      const delAt = src.search(/^\s*delete\s+process\.env\.DATA_DIR\s*;/m);
      out.push(
        assert(
          `★★${rel} 이 \`load-env\` 를 **\`delete\` 보다 먼저** 태운다 — 그래야 그 지움이 «마지막» 이 된다`,
          envAt >= 0 && delAt >= 0 && envAt < delAt,
          envAt < 0
            ? "★`load-env` import 가 없다 — 로드가 나중에 일어나 지운 키가 되살아난다"
            : delAt < 0
              ? "★`delete process.env.DATA_DIR` 이 없다 — 격리가 아예 없다"
              : envAt < delAt
                ? `import(${envAt}) < delete(${delAt})`
                : `★순서가 뒤집혔다 — import(${envAt}) > delete(${delAt})`,
        ),
      );
    }

    return out;
  },
};
