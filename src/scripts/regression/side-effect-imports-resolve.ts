/**
 * 회귀: **부작용 import 도 실제로 존재하는 파일을 가리킨다** (2026-09-01).
 *
 * ★사고: 구독 인증을 플러그인으로 빼면서 `src/core/llm-runtime/auth-providers.ts` 를
 *  지웠는데, 두 곳이 그걸 계속 `import "…/auth-providers.js"` 하고 있었다
 *  (`codex-weight-probe.ts` — **데몬의 `/diagnose` 가 부른다** · `diagnose-codex.ts` —
 *  **public 에 배포되는 CLI**). 깨끗한 설치에선 그 모듈을 부르는 순간 ERR_MODULE_NOT_FOUND 다.
 *
 * ★**왜 아무도 못 잡았나** — 두 겹이 동시에 가렸다:
 *  ① `tsc` 는 **부작용 import 를 검사하지 않는다.** 실측: `import "./gone.js"` → exit 0,
 *    `import { y } from "./gone.js"` → TS2307. 값이 안 들어오면 해석을 요구하지 않는다.
 *    그런데 이 레포는 **등록 배선에 정확히 그 패턴**을 쓴다 — 즉 «지워지기 가장 쉬운 것» 이
 *    «가장 안 보이는 것» 이었다.
 *  ② `npm run build` 는 **dist 를 치우지 않는다.** 지운 소스의 낡은 `.js` 가 남아 dev
 *    기계에서만 import 가 성공했다(실측: 그 파일만 하루 전 타임스탬프).
 *  그래서 타입체크·빌드·회귀 2,505건이 **전부 초록인 채로** 배포 직전까지 갔다.
 *
 * ★검사 대상은 **상대 경로**만이다. 패키지 import 는 `node_modules` 해석이라 여기서
 *  흉내내면 거짓 빨강이 난다(그건 설치가 답할 문제고, 값 import 면 tsc 가 이미 잡는다).
 *
 * 등급: **동작** — 디스크에서 실제로 해석해 본다. 이름 목록 0(디렉터리를 훑는다).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** 훑을 뿌리 — 배포되거나 데몬이 부르는 코드 전부. */
const ROOTS = ["src", "plugins", "packages"];
/** 부작용 import 한 줄: `import "…";` — 중괄호·from 이 없는 형태만. */
const SIDE_EFFECT = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm;

const walk = async (dir: string, out: string[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.(ts|mts|mjs|js)$/.test(e.name)) out.push(full);
  }
};

/** `./x.js` → 실제 파일이 있나(.ts/.mts/.mjs/.js, 디렉터리 index 포함). */
const resolves = async (fromFile: string, spec: string): Promise<boolean> => {
  const base = path.resolve(path.dirname(fromFile), spec);
  const stripped = base.replace(/\.js$/, "");
  const candidates = [
    base,
    `${stripped}.ts`,
    `${stripped}.mts`,
    `${stripped}.mjs`,
    `${stripped}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return true;
    } catch {
      /* 다음 후보 */
    }
  }
  return false;
};

export const check: RegressionCheck = {
  name: "side-effect-imports-resolve",
  guards:
    "지운 파일을 부작용 import(`import \"./x.js\"`) 로 계속 부르던 것 — tsc 는 값이 안 들어오면 해석을 요구하지 않아 exit 0 이고(실측), 낡은 dist 가 dev 기계에서만 가려준다. 깨끗한 설치에선 ERR_MODULE_NOT_FOUND 이고, 실제로 데몬 /diagnose 와 배포되는 CLI 둘이 그 상태로 배포 직전까지 갔다",
  run: async (): Promise<Assertion[]> => {
    const files: string[] = [];
    for (const r of ROOTS) await walk(path.join(REPO, r), files);

    const broken: string[] = [];
    let total = 0;
    for (const f of files) {
      const src = await readFile(f, "utf8");
      for (const m of src.matchAll(SIDE_EFFECT)) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".")) continue; // 패키지는 설치가 답한다.
        total += 1;
        if (!(await resolves(f, spec))) {
          broken.push(`${path.relative(REPO, f)} → ${spec}`);
        }
      }
    }

    return [
      assert(
        "★훑을 파일이 실제로 있었다(0이면 아래는 공짜 초록이다)",
        files.length > 100,
        `${files.length}개 파일 · 상대 부작용 import ${total}건`,
      ),
      assert(
        "★★부작용 import 가 전부 **실제 파일**을 가리킨다 — tsc 는 이걸 안 본다(값 import 만 TS2307). 깨진 채로 두면 깨끗한 설치에서 ERR_MODULE_NOT_FOUND 다",
        broken.length === 0,
        broken.length === 0
          ? `${total}건 전부 해석됨`
          : `★깨짐 ${broken.length}건: ${broken.slice(0, 4).join(" · ")}`,
      ),
    ];
  },
};
