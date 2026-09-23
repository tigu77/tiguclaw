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
 * `"…/LIVE_DATA"` → `resolveDataDir()` 이 그 경로를 반환.
 *
 * ★계약은 «지운다» 다 — 봉인 **값**(`""`·임시 경로)을 넣는 방식은 둘 다 실측으로 무너졌다
 *  (`""` 는 `assertIsolated()` 가 «설정됨» 으로 던지고, 임시 경로는 자식이 상속해 전부 같은 DB 를
 *  쳤다 — 35·37건 실패). 그래서 «지운 자리를 나중 로드가 다시 채우지 못하게» 가 과제다.
 *
 * ★★**회귀 러너는 이 검사 대상이 아니다** (2026-09-23). 러너는 2026-09-11 에 «`load-env` 를
 *  먼저 태운다» 로 풀었는데, 그 정적 import 가 임시 홈 확정 **전에** 운영 홈·cwd `.env` 를 읽는
 *  결함이었다(종전 ②는 그 순서를 **소스 문자열로** 강제하고 있었다 — 결함을 계약으로 굳힌 셈).
 *  이제 러너는 `.env` 를 **아예 읽지 않고**(`TIGUCLAW_DISABLE_ENV_FILE=1`), 그것은
 *  `regression-runner-env-isolation` 이 러너 사본을 **실제로 돌려** 잰다.
 *
 * 남은 것:
 *  ① Node 기제 — `loadEnvFile` 은 빈 키를 채우고, 있는 키는 안 덮는다. `e2e-openrouter` 의
 *    «먼저 로드 → 나중에 지움» 계약과 제품의 «홈이 이김» 이 둘 다 이 성질 위에 있다.
 *  ② `e2e-openrouter` — **실제 인증이 필요한 E2E** 라 `.env` 를 읽는 것이 목적이다(오프라인
 *    회귀처럼 차단하면 목적이 깨진다). 그래서 그쪽 계약은 그대로 «로드가 `delete` 보다 먼저».
 *    프로세스 시작 시점이라 돌려서 잴 수 없어 소스 순서로 본다(정직하게 밝힌다).
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
    "e2e 가 `delete process.env.DATA_DIR` 로 격리해서, `.env` 로드가 그 자리를 다시 " +
    "채우면 **라이브 데이터 디렉터리**를 치던 것 (회귀 러너 쪽은 regression-runner-env-isolation)",
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

    // ── ② `e2e-openrouter` 가 `.env` 로드를 `delete` 보다 **먼저** 끝내는가 ─────────────
    // ★회귀 러너는 여기서 뺐다 — 러너는 `.env` 를 읽지 않는 것이 계약이고(헤더), 그 행동은
    //  `regression-runner-env-isolation` 이 실행으로 잰다. 러너에 이 순서를 강제하면 운영
    //  `.env` 를 먼저 읽으라는 요구가 된다.
    // ★프로세스 시작 시점이라 돌려서 잴 수 없는 자리다 — 소스 순서로 본다(정직하게 밝힌다).
    // ★배포 레포엔 `e2e-*` 가 **없다**(manifest 가 `^src/scripts/(e2e-|verify-|probe-)` 를
    //  제외한다). 종전엔 그냥 읽어서 배포 트리 회귀가 **ENOENT 로 던졌다**(실측 2026-09-12
    //  dev 싱크). 없는 대상을 조용히 통과시키지 않고 **없다고 말하고** 넘긴다 — 있는데
    //  순서가 틀린 것과 애초에 대상이 아닌 것은 다른 사실이다(sync-public §8 의 규칙).
    for (const rel of ["src/scripts/e2e-openrouter.ts"]) {
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
