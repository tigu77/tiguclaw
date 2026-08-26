/**
 * 테마 프리셋 — **파일이 곧 목록**이다.
 *
 * ★언어(`core/i18n.ts`)와 **같은 모양**으로 둔다. 거기서 이미 검증된 규약이고, 새 개념을
 *  만들지 않는 게 이 파일의 요점이다:
 *
 *      locales/<lang>.json  +  settings.json `locale`      ← 언어
 *      themes/<name>.css    +  settings.json `theme`       ← 테마 (여기)
 *
 * 대시보드는 세 겹으로 쌓는다:
 *
 *      app.css              제품 기본 팔레트(다크 + `[data-theme="light"]`)
 *      /theme-preset.css    **선택된 프리셋** — 서버가 settings 를 보고 고른다
 *      /theme.css           개인 오버라이드 — 항상 마지막
 *
 * ★URL 에 이름이 안 실린다(`/theme-preset.css` 고정). 이름은 settings 에서만 오므로
 *  주소창으로 경로를 탈출할 여지가 없다. 그래도 아래에서 이름 모양을 한 번 더 막는다 —
 *  settings 는 사람이 손으로도 고치는 파일이다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appRoot, getPaths } from "./paths.js";
import { loadSettingsLayers } from "./settings.js";

/** 프리셋이 사는 곳 — 배포본 번들 + 사용자 홈(홈이 이긴다). */
const themeDirs = (): string[] => [
  path.join(appRoot(), "themes"),
  path.join(getPaths().home, "themes"),
];

/**
 * 이름으로 쓸 수 있는 모양인가. 경로 구분자·상위 이동·확장자를 전부 막는다.
 * ★파일명이 곧 이름이므로 여기서 막으면 아래 어디서도 다시 검사할 필요가 없다.
 */
const isSafeName = (name: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);

/**
 * 설치된 테마 목록 — `themes/*.css` 파일명. **손으로 관리하는 목록이 없다**
 * ([[feedback_hand_maintained_lists]]). 홈에 `nord.css` 를 놓으면 그게 곧 선택지다.
 */
export const availableThemes = (): string[] => {
  const out = new Set<string>();
  for (const dir of themeDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".css")) continue;
        const name = f.slice(0, -4);
        if (isSafeName(name)) out.add(name);
      }
    } catch {
      /* 폴더 없음 = 없는 것 */
    }
  }
  return [...out].sort();
};

/**
 * `settings.json` 의 `theme`. 없거나 설치 안 된 이름이면 **빈 문자열**(=프리셋 없음).
 * ★언어와 다르게 기본값이 없다 — 프리셋을 안 고른 상태가 정상이기 때문이다(그때는
 *  `app.css` 의 기본 팔레트가 그대로 쓰인다).
 */
export const readTheme = (cwd: string = process.cwd()): string => {
  let picked = "";
  for (const layer of loadSettingsLayers(cwd)) {
    const v = (layer as { theme?: unknown }).theme;
    if (typeof v === "string" && v.trim() !== "") picked = v.trim();
  }
  return picked !== "" && availableThemes().includes(picked) ? picked : "";
};

/**
 * 선택된 프리셋의 CSS. 고른 게 없거나 읽기에 실패하면 **빈 문자열**이다 —
 * 호출자(서버)는 그걸 빈 200 으로 내보낸다. 404 면 콘솔에 매번 에러가 찍혀 진짜 문제를 덮는다.
 */
export const readThemeCss = (cwd: string = process.cwd()): string => {
  const name = readTheme(cwd);
  if (name === "") return "";
  // 홈이 번들을 이긴다(같은 이름이면 사용자 것).
  for (const dir of [...themeDirs()].reverse()) {
    try {
      return readFileSync(path.join(dir, `${name}.css`), "utf8");
    } catch {
      /* 다음 후보 */
    }
  }
  return "";
};

/**
 * 테마 CSS 를 **캐스케이드 레이어**로 감싼다 (2026-08-26).
 *
 * ★왜 필요했나 — 실사고. 사용자 오버라이드가 **라이트 모드에서만 조용히 무시**됐다.
 *  순서 문제가 아니라 **특이도** 문제다: 기본 팔레트의 라이트 블록은
 *  `:root[data-theme="light"]`(0,2,0)이고 오버라이드는 보통 `:root`(0,1,0)이라, 뒤에
 *  얹혀도 진다. 실측: 다크에선 `#ff00aa` 가 먹고 라이트에선 `#0284c7`(기본값)이 남았다.
 *
 * ★레이어는 **특이도를 이긴다.** 순서를 `base < preset < user` 로 못박으면 오버라이드가
 *  어느 모드에서든 이긴다 — 사용자가 선택자 특이도를 알 필요가 없다.
 * ★감싸는 자리를 **서버 한 곳**으로 둔 이유: `app.css` 1,679줄을 통째로 들여쓰지 않아도
 *  되고, 세 겹이 같은 규칙을 쓴다는 사실이 한눈에 보인다.
 * ★프리셋 저작자 주의 — 레이어가 특이도를 이기므로 프리셋이 `:root` 만 정의하면 그 값이
 *  **라이트 모드까지** 넘어간다. 그래서 프리셋은 두 블록을 다 둔다(회귀가 지킨다).
 *
 * @param first 레이어 **순서 선언**을 함께 낸다(가장 먼저 파싱되는 시트에서 한 번).
 */
export const withLayer = (layer: string, css: string, first = false): string => {
  if (css.trim() === "") return "";
  const order = first ? "@layer tigu-base, tigu-preset, tigu-user;\n" : "";
  return `${order}@layer ${layer} {\n${css}\n}\n`;
};
