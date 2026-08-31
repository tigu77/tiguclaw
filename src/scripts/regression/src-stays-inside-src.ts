/**
 * 회귀: **`src/` 는 `src/` 밖을 리터럴로 짚지 않는다** (2026-09-01).
 *
 * 사고: 회귀 둘이 `plugins/self-growth/src/*` 를 리터럴로 불러 `npm run build` 가
 * `TS6059` 로 죽었다(DEV·배포 트리 양쪽 rc=2). `build` 는 `tsconfig.json`(rootDir=`src`,
 * include=`src`)을 쓰는데 그 프로그램에 rootDir 밖 파일이 끌려 들어온 것이다.
 *
 * ★**그런데 아무도 안 잡았다.** `npm run typecheck` 는 `tsconfig.check.json`(rootDir=`.`)
 *  이라 통과하고, 회귀 스위트도 2,461건 전부 초록이었다 — CLAUDE.md 가 지시하는 두 명령이
 *  둘 다 초록인데 빌드는 빨강이었다. 잡은 건 릴리스의 §5b 업데이트 경로 게이트 하나뿐이고,
 *  거기는 `npm ci`·빌드를 네 번 도는 비싼 자리다. **v0.40.0 에도 같은 부류가 한 번 났다.**
 *  [[feedback_gate_must_actually_run]] 의 처방 — *"수동 게이트는 자동으로 도는 자리로
 *  옮겨라"* — 를 여기서 이행한다. 1ms, 데몬·네트워크 0.
 *
 * ★재는 것은 **리터럴 지정자**뿐이다. `new URL(rel, import.meta.url)` 로 계산해 부르는 것은
 *  tsc 가 못 따라가므로 프로그램에 안 들어온다 — 그게 `_framework.ts` 의 `loadPluginModule`
 *  이 존재하는 이유다. 소스를 *문자열로 읽는* 것(`readFile(new URL(...))`)도 대상이 아니다.
 *
 * 등급: **정적** — 소스 문자열을 본다. 빌드를 실제로 돌리는 것과 같지 않다(그건 §5·CI 가
 * 한다). 여기가 잡는 것은 «리터럴로 밖을 짚는 새 import 가 들어왔다» 하나다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** `import … from "…"` 과 **리터럴** `import("…")` 둘 다. tsc 는 둘을 똑같이 따라간다. */
const SPECIFIER = /(?:from\s*|import\s*\(\s*)["'](\.[^"']*)["']/g;

export const check: RegressionCheck = {
  name: "src-stays-inside-src",
  guards:
    "회귀가 plugins/ 를 리터럴로 import 해 `npm run build` 가 TS6059 로 죽던 것 — typecheck 도 회귀 스위트도 초록이라 릴리스 게이트(§5b)까지 가서야 보였다",
  run: async (): Promise<Assertion[]> => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const srcRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
    /** `src/` 아래 `.ts` 전부 — 디렉터리를 손으로 열거하지 않는다(목록은 낡는다). */
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };

    const files = await walk(srcRoot);
    const offenders: string[] = [];
    for (const f of files) {
      const body = await readFile(f, "utf8");
      // 주석 안의 설명은 대상이 아니다 — 판정 대상은 코드다.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(SPECIFIER)) {
        const spec = m[1];
        if (spec === undefined) continue;
        // ★**이름이 아니라 경로를 푼다.** 첫 판은 `(\.\./)+plugins/` 를 이름으로 막았고,
        //  `src/core/llm-runtime/capabilities/` 에서 본 `../../plugins/` = `src/core/plugins/`
        //  (**src 안**)를 위반으로 셌다(오탐 2건, 첫 실행에서 바로 나왔다). rootDir 이 재는
        //  것은 «해석된 자리가 src 밖인가» 이지 «이름에 plugins 가 있나» 가 아니다.
        const resolved = path.resolve(path.dirname(f), spec);
        if (resolved === srcRoot || resolved.startsWith(srcRoot + path.sep)) continue;
        offenders.push(`${path.relative(srcRoot, f)} → ${spec}`);
      }
    }

    return [
      assert(
        `★src/ 의 .ts 가 plugins/·packages/ 를 **리터럴 지정자로** import 하지 않는다 — 하면 \`npm run build\`(rootDir=src)가 TS6059 로 죽고, typecheck·스위트는 통과해서 안 보인다`,
        offenders.length === 0,
        offenders.length === 0
          ? `${files.length}개 파일 검사 · 위반 0`
          : `★위반 ${offenders.length}건: ${offenders.slice(0, 5).join(" · ")}`,
      ),
      assert(
        "검사가 실제로 파일을 읽었다 — 0개를 훑고 «위반 없음» 이라고 하면 안 된다",
        files.length > 50,
        `${files.length}개`,
      ),
    ];
  },
};
