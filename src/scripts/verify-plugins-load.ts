/**
 * verify-plugins-load — 플러그인 엔트리포인트가 파싱·로드되는지 검사하는 릴리스 게이트.
 *
 * 왜: 데몬은 plugins/ 를 tsx 로 *런타임* 로드한다(빌드 없음). 그런데 tsconfig 의
 * `include` 는 `src/**\/*` 뿐이라 `npm run typecheck` 는 plugins 를 검사하지 않는다.
 * 그래서 plugins 의 *구문 오류*(예: 문자열 안 escape 안 된 따옴표)가 typecheck 과
 * 릴리스 빌드 게이트를 모두 통과해 배포되고, 부팅 시에야 "플러그인 로드 실패"로 조용히
 * 죽는다(cron·reboot 전부 미발화). 실제로 v0.3.1 에서 이 일이 났다.
 *
 * 이 스크립트는 각 플러그인 엔트리포인트를 dynamic import 해 *파싱+모듈 평가*를 강제한다.
 * 하나라도 throw 하면 non-zero 로 종료 → 릴리스 게이트가 막는다. (타입 오류까지 잡진
 * 않지만, 부팅을 통째로 죽이는 로드 실패 부류는 확실히 잡는다.)
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 기본은 <cwd>/plugins(.ts, tsx 로 실행). argv[2] 로 컴파일된 트리(dist/plugins)를 넘기면
// .js 엔트리를 순수 node 로 import 검증한다(ADR 2026-07-14 D5 — built 경로 로드 실패를
// 상류에서 잡는 변형). 각 플러그인에서 .ts 를 먼저, 없으면 .js 형제를 시도(둘 다 커버).
const pluginsDir = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(process.cwd(), "plugins");

// ★**매니페스트를 읽는다 — 파일명을 추측하지 않는다** (2026-08-17, 전체검토 D).
//  종전엔 `src/index`·`src/mcp` 두 이름만 찾아서, 루트 `./index.ts` 를 엔트리로 쓰는
//  **telegram·dashboard·http-bridge·cli 4개를 한 번도 로드하지 않았다.** 그런데 메시지는
//  "플러그인 5개 전부 로드 OK" 였다 — 3개 플러그인의 파일 5개를 그렇게 말한 것이고,
//  **거짓 안심**이다(그 4개에 모듈 스코프 초기화 실패를 넣어도 초록이었다).
//  ★로더(`src/core/plugins/loader.ts`)와 **같은 판정**을 쓴다: `package.json` 의
//   `tiguclaw.entry`. 그러면 새 플러그인이 어떤 파일명을 쓰든 자동으로 대상이 된다
//   (파일명 추측 = 손으로 관리하는 목록).
interface Manifest {
  entry?: unknown;
  mcp?: unknown;
}
const plugins: { name: string; entries: string[] }[] = [];
let missingEntries = 0;
for (const name of readdirSync(pluginsDir)) {
  const pkgPath = join(pluginsDir, name, "package.json");
  if (!existsSync(pkgPath)) continue; // 마커 없는 남의 폴더 — 로더도 조용히 건너뛴다.
  let marker: Manifest | undefined;
  try {
    marker = (JSON.parse(readFileSync(pkgPath, "utf8")) as { tiguclaw?: Manifest }).tiguclaw;
  } catch {
    console.error(`  🔴 ${name}: package.json 파싱 실패 — 로더도 이 플러그인을 못 읽는다`);
    plugins.push({ name, entries: [] });
    continue;
  }
  if (marker === undefined) continue;
  const cands = [marker.entry, marker.mcp].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (cands.length === 0) {
    console.error(`  🔴 ${name}: 매니페스트에 entry 가 없다 — 로더가 조용히 건너뛴다`);
    plugins.push({ name, entries: [] });
    continue;
  }
  // .ts 우선(source·tsx), 부재 시 .js(built·node) — 로더 resolveEntry 와 같은 규칙.
  const entries: string[] = [];
  for (const rel of cands) {
    const abs = join(pluginsDir, name, rel);
    const js = abs.endsWith(".ts") ? `${abs.slice(0, -3)}.js` : abs;
    if (existsSync(abs)) entries.push(abs);
    else if (existsSync(js)) entries.push(js);
    else {
      console.error(`  🔴 ${name}: 엔트리 없음 ${rel} (그리고 .js 형제도 없음)`);
      missingEntries++;
    }
  }
  plugins.push({ name, entries });
}
const entrypoints: string[] = plugins.flatMap((p) => p.entries);
// ★엔트리를 하나도 못 찾은 플러그인이 있으면 그 자체가 실패다(조용한 0 금지).
const emptyPlugins = plugins.filter((p) => p.entries.length === 0).map((p) => p.name);

let failed = emptyPlugins.length + missingEntries;
if (plugins.length === 0) {
  console.error("🔴 검증할 플러그인이 없음");
  failed++;
}
for (const p of entrypoints) {
  try {
    const mod = (await import(pathToFileURL(p).href)) as { default?: unknown };
    // ★**인스턴스화까지 한다** (2026-08-28). 종전엔 import 만 해서, 로더가 요구하는
    //  `export default class` 를 안 지켜도 **8/8 초록**이었다. 실제로 `weather` 가 객체를
    //  내보내 로더가 통째로 건너뛰었는데 이 게이트는 통과시켰다 — 그날 도구가 아예 없었고
    //  모델은 자기 지식으로 답했다. "로드 OK" 가 "등록 OK" 를 뜻하지 않았던 것이다.
    //  ★생성자는 부작용이 없어야 한다는 게 이 플러그인 계약이다(일은 `start*` 가 한다) —
    //   그래서 여기서 만들어 보는 게 안전하고, 안전하지 않다면 그 자체가 결함이다.
    if (typeof mod.default !== "function") {
      throw new Error(
        "default export 가 class 가 아닙니다 — 로더는 `new Ctor()` 를 부릅니다(객체 리터럴은 조용히 건너뜁니다).",
      );
    }
    new (mod.default as new () => unknown)();
    console.log(`  ok   ${p.replace(process.cwd() + "/", "")}`);
  } catch (e) {
    failed += 1;
    console.error(
      `  FAIL ${p.replace(process.cwd() + "/", "")}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

if (failed > 0) {
  if (emptyPlugins.length > 0) {
    console.error(
      `\n🔴 엔트리를 못 찾은 플러그인: ${emptyPlugins.join(", ")} — 로더도 조용히 건너뛴다.`,
    );
  }
  console.error(`\n🔴 플러그인 로드 실패 ${failed}건 — 릴리스 중단.`);
  process.exit(1);
}
// ★"플러그인 N개" 와 "엔트리 M개" 를 **구분해서** 말한다 — 종전엔 파일 수를 플러그인
//  수로 말해서 3개만 보면서 "5개 전부" 라고 했다. 숫자가 거짓이면 게이트도 거짓이다.
console.log(
  `\n✅ 플러그인 ${plugins.length}개 / 엔트리 ${entrypoints.length}개 전부 로드 OK.`,
);
