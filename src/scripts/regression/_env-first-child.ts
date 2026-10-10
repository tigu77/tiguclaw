/**
 * `env-loads-before-any-read` 의 자식 — **진입점의 import 순서 그대로** 모듈을 올리며, `.env` 로드보다 먼저
 * 읽힌 env 키를 센다.
 *
 * ★순서를 손으로 적지 않는다 — `src/index.ts` 의 정적 import 를 **소스 순서대로** 뽑아 load-env 까지만 올린다
 *  (ESM 은 앞선 import 를 의존성째 먼저 평가한다 = 이 순서가 곧 실제 평가 순서다). load-env 를 뒤로 옮기면
 *  앞에 선 모듈들이 끌고 오는 상단 env 읽기가 그대로 잡힌다.
 * ★«로드됐다» 의 경계 = load-env.ts 가 처음 env 를 읽는 순간(`TIGUCLAW_DISABLE_ENV_FILE` 확인). 러너가 켠 차단
 *  스위치와 무관하게 성립한다 — 파일을 실제로 읽느냐가 아니라 **로더가 돌기 전이냐**를 본다.
 *
 * 마지막 줄 JSON: `{ boundarySeen, imported, early: [[key, frame]] }`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = path.join(REPO, "src/index.ts");

const real = process.env;
let boundarySeen = false;
const early = new Map<string, string>();
const frameOf = (): string | undefined =>
  (new Error().stack ?? "").split("\n").slice(2).find((l) => l.includes(`${path.sep}src${path.sep}`) && !l.includes("_env-first-child"));
(process as unknown as { env: NodeJS.ProcessEnv }).env = new Proxy(real, {
  get(t, k) {
    if (typeof k === "string" && /^[A-Z_0-9]+$/.test(k) && !boundarySeen) {
      const f = frameOf();
      if (f !== undefined) {
        if (f.includes("load-env.ts")) boundarySeen = true;
        else if (!early.has(k)) early.set(k, f.trim());
      }
    }
    return Reflect.get(t, k);
  },
  // 쓰기는 진짜 env 로 그대로 — 모듈이 `Object.defineProperty(process.env, …)` 로 쓰면 Node 가 서술자 모양을 따진다.
  set(t, k, v) {
    (t as Record<string | symbol, unknown>)[k] = v;
    return true;
  },
  defineProperty(t, k, d) {
    (t as Record<string | symbol, unknown>)[k] = d.value;
    return true;
  },
});

// 정적 import 지정자 — 소스 순서. `import x from "…"`(여러 줄 포함)·`import "…"` 둘 다. 상대 경로만(제품 모듈).
const src = readFileSync(ENTRY, "utf8");
const specs: string[] = [];
for (const m of src.matchAll(/^import\s+(?:[^;]*?\sfrom\s+)?"(\.[^"]+)";/gms)) specs.push(m[1]!);
const upto = specs.findIndex((s) => s.endsWith("/load-env.js"));
const imported: string[] = [];
for (const s of upto === -1 ? specs : specs.slice(0, upto + 1)) {
  const file = path.join(path.dirname(ENTRY), s.replace(/\.js$/, ".ts"));
  imported.push(path.relative(REPO, file));
  await import(pathToFileURL(file).href);
}
console.log(JSON.stringify({ boundarySeen, imported, early: [...early.entries()] }));
process.exit(0);
