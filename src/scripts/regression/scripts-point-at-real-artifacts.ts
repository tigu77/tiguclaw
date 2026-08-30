/**
 * 회귀: **package.json 스크립트가 실제로 만들어지는 산출물을 가리킨다** (2026-08-30).
 *
 * 사고: `npm start` 가 `dist/index.js` 를 가리켰다. 그건 `npm run build`(순수 `tsc`,
 * `rootDir: src`)가 내는 **옛 배치**이고, 배포 런타임이 쓰는 진입점은
 * `dist/src/index.js`(`tsconfig.build.json`, `rootDir: "."`)다. 둘이 같은 `dist/` 에
 * 쌓여 **한 디렉터리에 코드베이스 두 벌**이 있었다.
 *
 * ★대가가 "안 됨" 이 아니라 **조용히 다르게 됨** 이라 나쁘다 — `dist/index.js` 로 띄우면
 *  `dist/plugins` 를 못 찾아 **플러그인 0개**로 뜬다(대시보드·텔레그램·스케줄러 전멸,
 *  2026-07-14 실사고와 같은 뿌리). 에러가 아니라 조용한 반쪽 기동이다.
 *
 * ★`code-map.md` 는 이미 *"`npm start` 는 죽은 스크립트다"* 라고 **알고 있었다.** 아는 것과
 *  막는 것은 다르다 — 문서에 적어두면 다음 사람이 그 줄을 읽어야 하고, 검사로 만들면 읽지
 *  않아도 걸린다([[feedback_gate_must_actually_run]]).
 *
 * 지키는 것 둘:
 *  ① 스크립트가 부르는 `dist/...` 경로가 **배포 빌드의 배치**와 맞는다.
 *     ★배치를 손으로 안 적는다 — `tsconfig.build.json` 의 `rootDir` 에서 **파생**한다
 *     ([[feedback_hand_maintained_lists]]). 거기가 `.` 이면 진입점은 `dist/src/…` 다.
 *  ② `build:prod` 만이 진짜 배포 빌드다 — 그게 `tsconfig.build.json` 을 쓰는지 확인한다.
 *     (`build` 는 빌드가 아니라 `rootDir` 경계 게이트다. 그 성질이 깨지면 ①의 근거가 없어진다.)
 *
 * 등급: 소스 대조 — 지키려는 성질이 **설정과 스크립트 문자열의 정합**이라 실행할 대상이 없다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const readJsonc = (rel: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(path.join(REPO, rel), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as Record<string, unknown>;

export const check: RegressionCheck = {
  name: "scripts-point-at-real-artifacts",
  guards:
    "package.json 스크립트가 배포 빌드가 만들지 않는 dist 경로를 가리켜, 띄우면 에러가 아니라 **플러그인 0개로 조용히 반쪽 기동**하던 것(`npm start` → `dist/index.js`, code-map 이 '죽은 스크립트' 라고 적어두고도 몇 달 살아남았다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const pkg = readJsonc("package.json");
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;

    // ── ② 진짜 배포 빌드가 무엇인지부터 ────────────────────────────────────
    const prod = scripts["build:prod"] ?? "";
    out.push(
      assert(
        "★`build:prod` 가 **배포 설정**(`tsconfig.build.json`)으로 빌드한다 — 이게 아니면 아래 배치 판정의 근거가 사라진다",
        prod.includes("tsconfig.build.json"),
        prod === "" ? "★build:prod 없음" : prod,
      ),
    );

    // ── ① 배치를 설정에서 **파생** ─────────────────────────────────────────
    const build = readJsonc("tsconfig.build.json");
    const co = (build.compilerOptions ?? {}) as Record<string, unknown>;
    const rootDir = typeof co.rootDir === "string" ? co.rootDir : ".";
    const outDir = typeof co.outDir === "string" ? co.outDir : "dist";

    /**
     * 산출물 경로 → **원본 소스 경로**로 되돌린다.
     *
     * ★접두 비교로는 부족하다(변이가 그걸 뚫었다) — `rootDir` 을 `src` 로 바꾸면 실제 배치가
     *  `dist/…` 로 올라가는데, `dist/src/…` 도 `dist/` 로 시작하므로 그냥 통과했다. 그래서
     *  **역매핑해서 그 자리에 진짜 소스가 있는지** 묻는다. 그러면 설정이 어떻게 바뀌든
     *  판정이 따라간다.
     */
    const backToSource = (dist: string): string => {
      const rel = dist.slice(`${outDir}/`.length).replace(/\.js$/, ".ts");
      return rootDir === "." || rootDir === "" ? rel : path.posix.join(rootDir, rel);
    };
    out.push(
      assert(
        `★산출물 경로를 **설정에서 역매핑**한다(손으로 배치를 적으면 rootDir 이 바뀔 때 갈린다) — rootDir=${JSON.stringify(rootDir)} · outDir=${JSON.stringify(outDir)}`,
        outDir !== "",
        `예: ${outDir}/src/index.js → ${backToSource(`${outDir}/src/index.js`)}`,
      ),
    );

    const bad: string[] = [];
    for (const [name, body] of Object.entries(scripts)) {
      for (const m of body.matchAll(/\bnode\s+(dist\/[A-Za-z0-9_./-]+\.(?:js|mjs))/g)) {
        const src = backToSource(m[1]!);
        if (!existsSync(path.join(REPO, src))) bad.push(`${name}: ${m[1]!} → ${src} 없음`);
      }
    }
    out.push(
      assert(
        "★★스크립트가 부르는 `dist/…` 진입점이 **실재하는 소스**로 되돌아간다 — 아니면 그 파일은 배포 빌드가 만들지 않는 자리이고, 띄웠을 때 에러가 아니라 플러그인 0개로 조용히 반쪽 기동한다",
        bad.length === 0,
        bad.length === 0
          ? `대상 스크립트 전부 실재 소스로 역매핑됨`
          : `★어긋남: ${bad.join(", ")}`,
      ),
    );

    return out;
  },
};
