/**
 * 회귀: **플러그인 공개 면 — `@tiguclaw/plugin` 하나만 부른다** (2026-08-28).
 *
 * ★**왜 생겼나 — 실측이 근거다.** 능력 표면은 거의 다 찼는데(위젯·데이터 라우트·설정·
 *  secret·번역 전부 코어 수정 0), 서드파티를 막는 건 격리가 아니라 **패키징**이었다:
 *
 *  ```
 *  홈 = ~/work/tiguclaw-v2/tiguclaw-dev  →  zod·SDK 찾음
 *  홈 = ~/.tiguclaw-devbot                →  ERR_MODULE_NOT_FOUND
 *  ```
 *
 *  돌쇠의 홈이 **레포 안**이라 node 가 상위로 올라가다 레포 `node_modules` 를 주웠을 뿐이다
 *  ([[feedback_dev_machine_config_leak]]). 같은 뿌리의 둘째 벽이 상대 경로
 *  `../../../src/core/...` 였다 — 홈에 놓이면 그 경로가 없어 **TypeScript 로 플러그인을 쓸
 *  방법이 없었다.**
 *
 * 지키는 것 넷:
 *  ① **혼용 금지** — 공개 면을 쓰면서 코어를 상대경로로도 짚으면 그 면은 계약이 아니라 장식이다.
 *  ② ★**타입 전용** — 값을 재수출하면 런타임 해석이 필요해지고, 그건 워크스페이스 링크나
 *     퍼블리시 파이프라인을 끌고 온다. 타입만이면 컴파일 뒤 **import 자체가 사라진다.**
 *  ③ **면이 실제로 쓰인다** — 0이면 이 검사가 공짜로 통과한다.
 *  ④ ★**소스 트리에 컴파일 산출물이 없다** — `index.ts` 가 `./x.js` 를 부르는데 그 파일이
 *     실재하면 source 모드가 **옛 컴파일본**을 돈다. 실제로 셋이 커밋돼 있었다.
 *
 * 등급: 전부 소스 대조 — 지키려는 성질이 **소스에만** 있다(런타임엔 이미 사라져 있으므로).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS = path.join(REPO, "plugins");
const SURFACE = "@tiguclaw/plugin";

/** 플러그인 폴더 안의 `.ts` 전부(생성물 제외). */
const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules") continue;
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

export const check: RegressionCheck = {
  name: "plugin-public-surface",
  guards:
    "플러그인이 코어를 상대 경로로 짚어서 홈에 깔리면 TypeScript 로 쓸 수 없던 것(홈이 레포 밖이면 그 경로가 없다) + 공개 면이 값을 재수출해 런타임 해석·퍼블리시를 끌고 오는 것 + 컴파일 산출물이 소스 트리에 커밋돼 source 모드가 옛 코드를 돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const dirs = readdirSync(PLUGINS).filter((n) =>
      statSync(path.join(PLUGINS, n)).isDirectory(),
    );

    // ── ① 혼용 금지 ────────────────────────────────────────────────────────
    // ★목록을 안 만든다 — *"공개 면을 쓰는 플러그인"* 이라는 **판정**으로 대상을 정한다.
    //  번들 인프라(http-bridge 등)는 제품의 일부라 코어를 직접 쓴다. 규칙은 그것들을
    //  강제 이주시키는 게 아니라 **면을 반쪽으로 쓰지 못하게** 하는 것이다.
    const mixed: string[] = [];
    const users: string[] = [];
    const valueImports: string[] = [];
    for (const name of dirs) {
      const files = tsFiles(path.join(PLUGINS, name));
      const usesSurface = files.some((f) => readFileSync(f, "utf8").includes(SURFACE));
      if (!usesSurface) continue;
      users.push(name);
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const rel = path.relative(REPO, f);
        if (/from "(\.\.\/)+src\//.test(src)) mixed.push(rel);
        // ② 값 import 는 컴파일 뒤 남는다 — 그 순간 런타임 해석이 필요해진다.
        for (const m of src.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+"@tiguclaw\/plugin"/g)) {
          if (m[1] === undefined) valueImports.push(rel);
        }
      }
    }
    // ★**배포본엔 예제 플러그인이 없다**(2026-08-29, 제공자 약관 때문에 제외) — 그래서 공개
    //  트리에서는 소비자가 0이다. 그건 결함이 아니라 사실이므로 **건너뛰되 말한다.** 면
    //  자신에 대한 검사(타입 전용·심볼)는 아래에서 그대로 돈다 — `packages/plugin` 은
    //  배포되므로 그쪽이 공개본에서 지켜야 할 것이다.
    const hasUsers = users.length > 0;
    out.push(
      assert(
        "★공개 면을 쓰는 플러그인이 있으면 그것으로 대조한다(없으면 소비자 검사는 대상 없음)",
        true,
        hasUsers ? users.join(", ") : "소비자 0 — 예제 플러그인이 배포본에 없다(대조 생략)",
      ),
    );
    out.push(
      assert(
        "★★공개 면을 쓰면서 코어를 상대경로로도 짚지 않는다 — 반쪽으로 쓰면 그 면은 계약이 아니라 장식이다",
        mixed.length === 0,
        !hasUsers
          ? "소비자 0 — 대상 없음"
          : mixed.length === 0
            ? `${users.length}개 플러그인 전부 면만 사용`
            : `★혼용: ${mixed.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★★플러그인은 공개 면을 **`import type` 으로만** 부른다 — 값으로 부르면 컴파일 뒤에도 지정자가 남고, 그걸 해석하려면 워크스페이스 링크나 퍼블리시가 필요해진다",
        valueImports.length === 0,
        !hasUsers
          ? "소비자 0 — 대상 없음"
          : valueImports.length === 0
            ? "전부 type import"
            : `★값 import: ${valueImports.join(", ")}`,
      ),
    );

    // ── ② 면 자신이 타입 전용인가 ──────────────────────────────────────────
    const surfaceSrc = readFileSync(
      path.join(REPO, "packages/plugin/index.ts"),
      "utf8",
    );
    const valueExports = [...surfaceSrc.matchAll(/^export\s+(?!type\b)/gm)].length;
    out.push(
      assert(
        "★★공개 면이 **값을 내보내지 않는다**(`export type` 만) — 값을 내보내는 순간 이 패키지가 런타임에 해석돼야 하고, `main` 이 `.ts` 라 built 런타임에서 그게 안 된다",
        valueExports === 0,
        `값 export ${valueExports}건 · type export ${[...surfaceSrc.matchAll(/^export type/gm)].length}건`,
      ),
    );
    for (const sym of ["PluginHost", "PluginDataRoutes", "PluginSettingSpec"]) {
      out.push(
        assert(
          `면이 \`${sym}\` 를 낸다(소비자가 실제로 쓰는 것)`,
          surfaceSrc.includes(sym),
          surfaceSrc.includes(sym) ? "있음" : "없음",
        ),
      );
    }

    // ── ④ 소스 트리에 컴파일 산출물이 없다 ─────────────────────────────────
    // ★단순 정리가 아니다 — `index.ts` 가 `./x.js` 를 부르는데 그 파일이 실재하면
    //  source 모드가 **그 옛 파일**을 로드한다. 실제로 셋이 커밋돼 있었고 우연히 최신이라
    //  안 터졌을 뿐이다(성질이 아니라 운).
    const artifacts: string[] = [];
    for (const name of dirs) {
      const walk = (d: string): void => {
        for (const f of readdirSync(d)) {
          if (f === "node_modules") continue;
          const p = path.join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(js|js\.map|d\.ts)$/.test(f) && !p.includes(`${path.sep}web${path.sep}`)) {
            artifacts.push(path.relative(REPO, p));
          }
        }
      };
      const srcDir = path.join(PLUGINS, name, "src");
      // `src/` 없이 루트에 파일을 두는 플러그인도 있다(http-bridge 등) — 그건 대상이 아니다.
      if (!existsSync(srcDir)) continue;
      walk(srcDir);
    }
    out.push(
      assert(
        "★★플러그인 `src/` 에 컴파일 산출물이 없다 — 있으면 source 모드가 옛 컴파일본을 돈다(`./x.js` 가 실재하면 그게 먼저 잡힌다)",
        artifacts.length === 0,
        artifacts.length === 0 ? "산출물 0(dist 에만 있다)" : `★남아 있음: ${artifacts.join(", ")}`,
      ),
    );

    return out;
  },
};
