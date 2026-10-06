/**
 * 회귀: **어떤 패키지가 «선택» 의존성을 모듈 로드 때 정적으로 import 하면, 그건 선택이 아니다 — 우리 직접 의존성이어야 한다** (2026-10-06).
 *
 * 사고(`@openai/agents` 0.19.0): `agents-core` 가 `@modelcontextprotocol/client` 를 optionalDependencies 로 선언해 놓고
 * `dist/shims/mcp-server/node.mjs` 첫 줄에서 정적으로 import 한다(같은 파일의 나머지는 실패를 잡는 지연 import — 상류 실수로 보인다).
 * 첫 `npm install` 이 그 선택 의존성을 실제로 빠뜨렸고, 그러면 `@openai/agents` 를 부르는 순간 `ERR_MODULE_NOT_FOUND` 다 — 우리는
 * openai 어댑터를 정적으로 부르므로 **openai 를 안 쓰는 사용자까지 데몬 부팅이 깨진다**(임시 폴더 `--omit=optional` 설치로 재현).
 * 고침: 그 패키지를 직접 의존성으로 올려 설치를 보증한다.
 *
 * ★이름 목록이 아니라 **판정 기준**이다([[feedback_hand_maintained_lists]]) — 설치된 패키지 중 optionalDependencies 를 가진 것의
 *  ESM 파일에서 맨 위 `import … from '<선택 의존성>'` 을 찾는다. 다음 업그레이드에서 다른 패키지가 같은 실수를 해도 저절로 걸린다.
 * ★CJS 의 `require` 는 보지 않는다 — 선택 의존성은 대개 `try { require() }` 로 감싸 쓰고, 우리는 ESM 으로 부른다.
 *
 * 등급: **정적**(설치된 의존성 트리 직독, 실행 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STATIC_IMPORT = /^import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const packageName = (spec: string): string =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);

const installedPackages = (nm: string): string[] => {
  const out: string[] = [];
  for (const d of readdirSync(nm)) {
    if (d.startsWith(".")) continue;
    if (d.startsWith("@")) for (const e of readdirSync(path.join(nm, d))) out.push(path.join(nm, d, e));
    else out.push(path.join(nm, d));
  }
  return out;
};

const esmFiles = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) esmFiles(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};

/** `{ 선언한 패키지, 선택 의존성, 파일 }` — 로드 때 정적으로 부르는 선택 의존성. */
export const optionalImportsAtLoad = (nm: string): { owner: string; dep: string; file: string }[] => {
  const found: { owner: string; dep: string; file: string }[] = [];
  for (const dir of installedPackages(nm)) {
    let pj: { name?: string; optionalDependencies?: Record<string, string> };
    try {
      pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof pj;
    } catch {
      continue;
    }
    const optional = Object.keys(pj.optionalDependencies ?? {});
    if (optional.length === 0) continue;
    for (const f of esmFiles(dir)) {
      for (const m of readFileSync(f, "utf8").matchAll(STATIC_IMPORT)) {
        const dep = packageName(m[1]!);
        if (optional.includes(dep)) found.push({ owner: pj.name ?? path.basename(dir), dep, file: path.relative(dir, f) });
      }
    }
  }
  return found;
};

export const check: RegressionCheck = {
  name: "optional-dependency-imported-at-load",
  guards:
    "의존성이 «선택» 이라 선언하고 로드 때 정적으로 import 하는 패키지가 설치에서 빠져, openai 를 안 쓰는 사용자까지 데몬 부팅이 깨질 수 있던 것(@openai/agents 0.19)",
  run: async (): Promise<Assertion[]> => {
    const ours = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const direct = new Set(Object.keys(ours.dependencies ?? {}));
    const found = optionalImportsAtLoad(path.join(REPO, "node_modules"));
    const unguaranteed = found.filter((f) => !direct.has(f.dep));
    return [
      assert(
        "★로드 때 정적으로 부르는 «선택» 의존성은 전부 우리 직접 의존성이다(설치가 빠뜨려도 부팅이 안 깨지게)",
        unguaranteed.length === 0,
        unguaranteed.length === 0
          ? `보증됨 ${found.length}건: ${[...new Set(found.map((f) => `${f.owner}→${f.dep}`))].join(", ") || "(없음)"}`
          : unguaranteed.map((f) => `${f.owner} → ${f.dep} (${f.file})`).join(" · "),
      ),
    ];
  },
};
