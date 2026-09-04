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
/**
 * 변경 내역 — **있는 언어를 전부** 옮긴다. 자리는 둘 중 하나다: 배포본은 루트에 실물이
 * 있고, 개발 레포는 `_workspace/public-overlay/` 가 정본이다(manifest 가 루트로 옮긴다).
 *
 * ★언어를 **열거하지 않는다** (2026-09-02). `CHANGELOG.md` 만 적어 뒀더니 그날 만든
 *  `CHANGELOG.ko.md` 가 **dist 에 안 실려**, 화면 언어를 따르는 기능이 배포본에서 통째로
 *  죽어 있었다(= 실제 사용자에겐 영어만). 손목록은 조용히 낡는다
 *  ([[feedback_hand_maintained_lists]]) — 규약(`CHANGELOG*.md`)이 판정한다.
 * ★그리고 **언제나 덮어쓴다.** 종전 `copyFileAs` 는 «목적지가 이미 있으면 건너뛴다» 였는데,
 *  dist 는 빌드마다 지워지지 않아 그 조건이 항상 참이었다 — 실측: 돌쇠의 「변경 이력」이
 *  **8월 24일자**로 굳어 9일을 그렇게 보여줬다. 조용한 정지라 아무도 못 봤다.
 */
const copyChangelogs = async () => {
  const pick = async (dir) => {
    try {
      return (await fs.readdir(dir))
        .filter((f) => /^CHANGELOG(\.[A-Za-z-]+)?\.md$/.test(f))
        .sort();
    } catch {
      return [];
    }
  };
  const overlay = path.join(repoRoot, "_workspace", "public-overlay");
  // 루트에 하나라도 있으면 **거기가 정본**이다(배포본). 없을 때만 오버레이를 본다.
  let from = repoRoot;
  let names = await pick(repoRoot);
  if (names.length === 0) {
    from = overlay;
    names = await pick(overlay);
  }
  if (names.length === 0) {
    log("skip (absent): CHANGELOG*.md");
    return;
  }
  for (const n of names) {
    await fs.cp(path.join(from, n), path.join(dist, n), { recursive: false });
  }
  // ★원본에서 사라진 이름은 dist 에서도 지운다 — `fs.cp` 는 덮어쓰기만 하고 남은 것을
  //  건드리지 않는다. 실측: 코드 없는 `CHANGELOG.md` 를 `.en.md` 로 옮겼는데 옛 파일이
  //  dist 에 그대로 살아남았다(`themes/nord.css` 와 같은 부류 — 산출물이 원본을 거짓으로
  //  말한다). 여기선 마지막 폴백이라 조용하지만, 조용한 게 이 부류의 성질이다.
  const stale = (await pick(dist)).filter((f) => !names.includes(f));
  for (const f of stale) await fs.rm(path.join(dist, f), { force: true });
  log(
    `CHANGELOG: ${names.join(" · ")} (from ${from === repoRoot ? "루트" : "오버레이"})` +
      (stale.length > 0 ? ` · prune ${stale.join(" · ")}` : ""),
  );
};

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

/**
 * 디렉터리 트리 복사. filter 로 .ts 제외 가능.
 *
 * ★`prune` 이면 **먼저 지우고 복사한다**(2026-08-26). `fs.cp` 는 덮어쓰기만 하고 **원본에서
 *  사라진 파일은 dist 에 남긴다.** 실사고: `themes/nord.css` 를 지우고 배포했는데 배포본엔
 *  그대로 남아 테마 목록에 계속 떴다 — 목록의 정본이 "파일" 인 구조라 **지운 것이 안 지워지면
 *  그 자체가 거짓말**이 된다. 목록을 파일로 정하는 트리(`themes`·`locales`)엔 필수다.
 *  ★`plugins`·`packages` 엔 tsc 산출물(`.js`)이 **먼저** 들어와 있으므로 지우면 안 된다.
 */
const copyTree = async (rel, { excludeTs = false, prune = false } = {}) => {
  const src = path.join(repoRoot, rel);
  const dest = path.join(dist, rel);
  try {
    await fs.access(src);
  } catch {
    log(`skip (absent): ${rel}/`);
    return;
  }
  if (prune) await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, {
    recursive: true,
    // 디렉터리는 이름이 .ts 로 안 끝나므로 통과 → 재귀 유지. .ts 파일만 제외.
    filter: excludeTs ? (s) => !s.endsWith(".ts") : undefined,
  });
  log(`tree: ${rel}/${excludeTs ? " (non-.ts)" : ""}${prune ? " [prune]" : ""}`);
};

/**
 * `dist/<rel>` 아래에서 **소스에 없는 디렉터리**를 지운다.
 *
 * ★트리 통째 prune 과 다르다: 살아 있는 항목의 tsc 산출물(.js)은 그대로 두고 **없어진 것만**
 *  치운다. 미러가 삭제를 반영하지 않으면 **지운 것이 계속 돈다** — 실제로 시험용 `_probe` 를
 *  소스에서 지웠는데 매 부팅마다 로드되고 실패로 찍히고 있었다. 사용자 쪽도 같다:
 *  플러그인을 지워도 빌드본에선 안 사라진다.
 */
const pruneOrphanDirs = async (rel) => {
  const srcDir = path.join(repoRoot, rel);
  const dstDir = path.join(dist, rel);
  let live;
  try {
    live = new Set(
      (await fs.readdir(srcDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return; // 소스 트리가 없으면 판단 근거가 없다 — 아무것도 안 지운다(보수적).
  }
  let there;
  try {
    there = (await fs.readdir(dstDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const d of there) {
    if (live.has(d.name)) continue;
    await fs.rm(path.join(dstDir, d.name), { recursive: true, force: true });
    log(`prune-orphan: ${rel}/${d.name}`);
  }
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
  await copyChangelogs();
  // ★`prune` 이다 — 소스에서 **지운 스킬·에이전트가 빌드본에 남으면 계속 돈다.**
  //  2026-09-04 실사고: `schedule-safety-check` 를 걷고 배포했는데 `dist/skills/` 에 그대로
  //  남아 자식 인덱스에 다시 실렸다(그 파일엔 `reach:` 가 없으니 **전 칸 기본값**으로 들어간다
  //  — 그날 한 최적화가 배포본에서만 반쪽이 됐다).
  //  ★같은 부류를 2026-08-26 에 `plugins` 에서 이미 겪고 `pruneOrphanDirs` 를 만들었는데
  //   **옆 레인(skills·agents)엔 안 붙였다.** 여기는 tsc 산출물이 섞이지 않으므로
  //   `plugins` 와 달리 **트리 통째 prune 이 안전하다**(locales·themes 와 같은 처리).
  await copyTree("skills", { prune: true });
  await copyTree("agents", { prune: true });
  // ★언어 카탈로그 (2026-08-25) — appRoot()-상대 자산이라 dist 에 실재해야 배포본에서
  //  기본 문구가 나온다. 빠지면 카탈로그가 비어 화면이 키(nav.settings)로 뜬다.
  await copyTree("locales", { prune: true });
  // ★테마 프리셋 (2026-08-26) — 언어 카탈로그와 같은 이유다. appRoot()-상대 자산이라
  //  dist 에 실재해야 배포본에서 프리셋 목록이 보인다. 빠지면 고른 테마가 조용히 무시된다
  //  (`readTheme` 이 "설치 안 된 이름" 으로 보고 빈 문자열을 준다).
  await copyTree("themes", { prune: true });

  // 2) 플러그인 트리의 비-.ts 자산 → dist/plugins (특히 로더 발견의 근거인 package.json).
  //    .ts 는 tsc 가 dist/plugins/**/*.js 로 이미 emit — 여기선 제외하고 나머지만 미러.
  await copyTree("plugins", { excludeTs: true });
  // ★**소스에서 사라진 플러그인은 dist 에서도 지운다** (2026-08-28).
  //  `fs.cp` 는 덮어쓰기만 하고 **삭제를 반영하지 않는다** — 그래서 지운 플러그인이 빌드본에서
  //  계속 로드된다. 실제로 시험용 `_probe` 를 소스에서 지웠는데 매 부팅마다 뜨고 있었고,
  //  로더가 그걸 실패로 찍고 있었다. 사용자 쪽에서도 같다: 플러그인을 지워도 안 사라진다.
  //  ★`plugins` 트리 전체를 prune 할 수는 없다 — tsc 산출물(.js)이 **먼저** 들어와 있다.
  //   그래서 **고아 디렉터리만** 골라 지운다(살아 있는 플러그인의 .js 는 안 건드린다).
  await pruneOrphanDirs("plugins");

  // 3) packages 트리의 비-.ts 정적 자산 → dist/packages (2026-07-14 dashboard built fix).
  //    tsc 가 dist/packages/dashboard/index.js 로 emit 하지만 그 __dirname 기준으로 서빙하는
  //    index.html·marked.min.js·highlight.min.js·package.json·README.md 는 안 옮긴다 → 옆에 복사.
  //    없으면 built 대시보드가 정적파일 로드 실패(HTML 0 bytes). .ts 는 이미 .js 로 emit.
  await copyTree("packages", { excludeTs: true });
  // ★**여기도 고아를 지운다** (2026-09-04 3R). `plugins` 와 **같은 모양**인데 한 줄이
  //  빠져 있었다 — 08-26 사고를 고치며 옆 레인을 안 본 것이 이걸로 세 번째다(그때 `plugins`
  //  만, 09-04 에 `skills`·`agents` 를, 이제 `packages`). 패키지를 지우거나 이름을 바꾸면
  //  `dist/packages/` 에 옛 트리가 남는다. 로더가 훑지 않아 «계속 돈다» 는 아니지만,
  //  `dist` 는 배포·설치가 통째로 실어 나르는 트리다.
  await pruneOrphanDirs("packages");

  log("done.");
};

main().catch((err) => {
  console.error(`[copy-dist-assets] failed: ${String(err)}`);
  process.exit(1);
});
