/**
 * 회귀: **light 프리셋이 기본(다크)의 색을 빠짐없이 덮는다** (2026-08-26).
 *
 * ★이 기능의 조용한 실패는 "안 뜬다" 가 아니라 **"한 군데만 안 바뀐다"** 다.
 *  `app.css` 의 `:root` 에 색 토큰을 새로 추가하면서 `themes/light.css` 에 안 적으면,
 *  라이트를 골랐을 때 그 토큰만 **다크 값이 남아** 흰 배경 위에 밝은 회색 글씨가 된다 —
 *  화면은 멀쩡히 뜨고 아무 에러도 안 난다. 76개짜리 팔레트라 눈으로 세는 건 곧 포기한다.
 *
 * ★색이 아닌 것은 덮을 이유가 없다(`--font-*` · `--radius` · `--font-scale` 은 테마와 무관).
 *  그래서 **색 토큰만** 판정 대상으로 고른다 — 기준을 손 목록이 아니라 **값의 모양**으로 둔다.
 *
 * ★밝기를 별도 축으로 두지 않기로 했으므로(2026-08-26) 라이트는 `data-theme` 속성이 아니라
 *  **그냥 프리셋 하나**다. 고를 것은 `다크(기본)` · `light` 둘뿐이고, 나머지는 사용자가
 *  `<home>/themes/` 에 놓는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const declarations = (block: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
};

/** 값이 색인가 — 손 목록이 아니라 모양으로 판정한다. */
const isColor = (v: string): boolean =>
  /#[0-9a-fA-F]{3,8}\b/.test(v) ||
  /\brgba?\(/.test(v) ||
  /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(v);

export const check: RegressionCheck = {
  name: "theme-light-covers-dark",
  guards:
    "light 프리셋에 색 토큰을 빠뜨리면 그 한 군데만 다크 값이 남아 흰 배경에 밝은 글씨가 되는데, 화면은 멀쩡히 뜨고 에러도 없어 아무도 모르던 것",
  run: async (): Promise<Assertion[]> => {
    const css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8");
    const light = readFileSync(path.join(REPO, "themes/light.css"), "utf8");
    const base = declarations(/:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "");
    const over = declarations(/:root\s*\{([^}]*)\}/.exec(light)?.[1] ?? "");
    const out: Assertion[] = [];

    out.push(
      assert(
        "두 팔레트를 모두 읽어냈다(빈손 통과 금지)",
        base.size >= 60 && over.size >= 40,
        `기본=${base.size} light=${over.size}`,
      ),
    );
    if (base.size === 0 || over.size === 0) return out;

    const colors = [...base].filter(([, v]) => isColor(v)).map(([k]) => k);
    const missing = colors.filter((k) => !over.has(k));
    out.push(
      assert(
        "★light 가 기본의 색 토큰을 빠짐없이 덮는다",
        missing.length === 0,
        missing.length === 0
          ? `색 토큰 ${colors.length}개 전부 덮음`
          : `★안 덮은 것 ${missing.length}개: ${missing.join(", ")} — 라이트에서 이것만 다크 값이 남는다`,
      ),
    );

    const extra = [...over.keys()].filter((k) => !base.has(k));
    out.push(
      assert(
        "light 에만 있는 토큰이 없다(기본에서 undefined 가 된다)",
        extra.length === 0,
        extra.length === 0 ? "고아 0" : `고아: ${extra.join(", ")}`,
      ),
    );

    const nonColor = [...over.keys()].filter(
      (k) => base.has(k) && !isColor(base.get(k) as string),
    );
    out.push(
      assert(
        "색이 아닌 값(폰트·반경·배율)은 프리셋이 복사하지 않는다",
        nonColor.length === 0,
        nonColor.length === 0 ? "복사 0" : `불필요 복사: ${nonColor.join(", ")}`,
      ),
    );

    out.push(
      assert(
        "★번들 프리셋은 다크·라이트 둘뿐이다(나머지는 사용자가 홈에 놓는다)",
        light.includes("color-scheme: light"),
        light.includes("color-scheme: light")
          ? "light 가 폼·스크롤바까지 밝게 뒤집는다"
          : "color-scheme 누락 — 입력창·스크롤바가 다크로 남는다",
      ),
    );
    return out;
  },
};
