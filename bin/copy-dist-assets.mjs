#!/usr/bin/env node
// build:prod copy 단계 (ADR 2026-07-14 D1 / item 3) — tsc 가 emit 하지 않는 비-.ts
// 앱 아티팩트를 dist/ 로 복사해 built 부팅이 self-contained 하게 만든다.
//
// 왜 필요한가:
//  - appRoot()(marker walk-up) 가 built 에서 dist/ 를 앱 루트로 잡는다(dist/plugins 마커).
//    따라서 appRoot()-상대 자산(SYSTEM.md·skills·agents)이 dist/ 에 실재해야 부팅·헌법
//    sync·빌트인 스킬/에이전트 발견이 성립한다.
//  - ★플러그인 로더는 <pluginDir>/package.json 의 tiguclaw 마커로 발견한다. tsc 는
//    package.json 을 안 옮기므로, 복사 없이는 dist/plugins/*/package.json 부재 → 플러그인
//    0개 로드(맥락 §2 블로커). 플러그인 트리의 비-.ts 파일 전부(package.json·README 등)를
//    dist/plugins 로 미러한다(.ts 는 tsc 가 이미 .js 로 emit).
//
// 순수 node(no tsx) — build:prod 파이프라인의 마지막 단계. node>=20 의 fs.cp 사용.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 대상 dist 는 기본 <repo>/dist 이나, self-update(built) 의 스테이징 빌드(원자 교체용)를
// 위해 argv[2] 로 오버라이드 가능(ADR 2026-07-14 D3). 절대/상대 모두 repoRoot 기준 해석.
const dist = process.argv[2]
  ? path.resolve(repoRoot, process.argv[2])
  : path.join(repoRoot, "dist");

const log = (msg) => console.log(`[copy-dist-assets] ${msg}`);

/** 파일 1개 복사(부모 디렉터리 보장). */
/** src→dest 이름이 다른 복사(오버레이 → 배포 루트 위치). 이미 있으면 덮지 않는다. */
const copyFileAs = async (relSrc, relDest) => {
  const src = path.join(repoRoot, relSrc);
  const dest = path.join(dist, relDest);
  try {
    await fs.access(dest);
    return; // 루트 실물이 이미 복사됐다(배포본) — 그쪽이 정본.
  } catch { /* 없으면 오버레이에서 */ }
  try {
    await fs.access(src);
  } catch {
    log(`skip (absent): ${relSrc}`);
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: false });
  log(`file: ${relDest} (from ${relSrc})`);
};

const copyFile = async (rel) => {
  const src = path.join(repoRoot, rel);
  const dest = path.join(dist, rel);
  try {
    await fs.access(src);
  } catch {
    log(`skip (absent): ${rel}`);
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: false });
  log(`file: ${rel}`);
};

/** 디렉터리 트리 복사. filter 로 .ts 제외 가능. */
const copyTree = async (rel, { excludeTs = false } = {}) => {
  const src = path.join(repoRoot, rel);
  const dest = path.join(dist, rel);
  try {
    await fs.access(src);
  } catch {
    log(`skip (absent): ${rel}/`);
    return;
  }
  await fs.cp(src, dest, {
    recursive: true,
    // 디렉터리는 이름이 .ts 로 안 끝나므로 통과 → 재귀 유지. .ts 파일만 제외.
    filter: excludeTs ? (s) => !s.endsWith(".ts") : undefined,
  });
  log(`tree: ${rel}/${excludeTs ? " (non-.ts)" : ""}`);
};

const main = async () => {
  // dist/ 가 없으면 tsc 빌드가 선행되지 않은 것 — 방어.
  try {
    await fs.access(dist);
  } catch {
    console.error("[copy-dist-assets] dist/ not found — run tsc build first.");
    process.exit(1);
  }

  // 1) appRoot()-상대 헌법/빌트인 자산 → dist/ (marker walk-up 이 dist 를 appRoot 로 잡음).
  await copyFile("SYSTEM.md");
  // ★CHANGELOG 도 appRoot()-상대 앱 자산이다 (2026-08-24 — 대시보드 「설정 → 변경 이력」).
  //  배포본은 루트에 실물이 있고, **개발 레포는 오버레이가 정본**이라(manifest 가 루트로
  //  복사한다) 여기서 그 차이를 흡수한다 — 이 스크립트의 일이 "dist 를 설치본처럼 보이게"
  //  하는 것이므로, 제품 코드에 dev 사정을 넣는 대신 여기서 맞춘다(오염 0).
  await copyFile("CHANGELOG.md");
  await copyFileAs("_workspace/public-overlay/CHANGELOG.md", "CHANGELOG.md");
  await copyTree("skills");
  await copyTree("agents");
  // ★언어 카탈로그 (2026-08-25) — appRoot()-상대 자산이라 dist 에 실재해야 배포본에서
  //  기본 문구가 나온다. 빠지면 카탈로그가 비어 화면이 키(nav.settings)로 뜬다.
  await copyTree("locales");

  // 2) 플러그인 트리의 비-.ts 자산 → dist/plugins (특히 로더 발견의 근거인 package.json).
  //    .ts 는 tsc 가 dist/plugins/**/*.js 로 이미 emit — 여기선 제외하고 나머지만 미러.
  await copyTree("plugins", { excludeTs: true });

  // 3) packages 트리의 비-.ts 정적 자산 → dist/packages (2026-07-14 dashboard built fix).
  //    tsc 가 dist/packages/dashboard/index.js 로 emit 하지만 그 __dirname 기준으로 서빙하는
  //    index.html·marked.min.js·highlight.min.js·package.json·README.md 는 안 옮긴다 → 옆에 복사.
  //    없으면 built 대시보드가 정적파일 로드 실패(HTML 0 bytes). .ts 는 이미 .js 로 emit.
  await copyTree("packages", { excludeTs: true });

  log("done.");
};

main().catch((err) => {
  console.error(`[copy-dist-assets] failed: ${String(err)}`);
  process.exit(1);
});
