/**
 * 회귀: **테마 토큰 층이 새지 않는다** (2026-08-24, Appearance Phase 1).
 *
 * 대시보드 색·폰트를 사용자가 고를 수 있게 하려면 값이 **한 곳(`:root`)에서** 나와야 한다.
 * 그런데 실측해보니 토큰 21개·`var()` 686회가 이미 있는데도 **하드코딩이 340곳**(hex 83 +
 * rgba 257) 있었다. 그 상태에서 테마를 붙이면 "바꿨는데 여기저기 옛 색이 남는" 반쪽이 된다.
 *
 * ★그리고 **`px` 폰트 크기 위에서는 Font Scale 이 원리적으로 안 움직인다.** 286곳이 전부
 *  `px` 였고 `rem` 은 0이었다. `html { font-size: calc(16px * var(--font-scale)) }` 를 세우고
 *  `rem` 으로 옮겼다 — 19종이 전부 16으로 나누어떨어져 배율 1에서 오차가 **0**이다.
 *
 * ★이 검사가 지키는 것은 미관이 아니라 **기능의 도달 범위**다. 리터럴이 하나 늘면 그 자리는
 *  테마·폰트 설정이 **영영 안 닿는 자리**가 되고, 그건 화면을 봐야만 드러난다(그래서 조용하다).
 *
 * ★등급: **값 검사**(소스 파싱). 문자열 존재가 아니라 CSS 값을 뽑아 세므로 동의어로 못
 *  피한다 — `#f87171` 를 `rgb(248,113,113)` 로 써도 똑같이 걸린다. 다만 **캐스케이드는 못
 *  본다**(어느 규칙이 이기는지). 그 축은 헤드리스 프로브가 본다
 *  (`_workspace/_theme_token_equiv_cdp.mjs` — before/after 계산값 전수 대조).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** JS 가 `setProperty` 로 넣는 레이아웃 변수 — `:root` 에 없는 게 정상이다. */
const JS_SET = new Set(["bg-panel-w", "chat-inset"]);

const run = async (): Promise<Assertion[]> => {
  let css: string;
  try {
    css = await readFile(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
  } catch {
    return [assert("app.css 없음(배포 레포 아님)", true, "건너뜀")];
  }
  const out: Assertion[] = [];
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css);
  if (rootBlock === null) {
    return [assert("★`:root` 토큰 블록이 있다", false, "사라졌다 — 테마 축 자체가 없다")];
  }
  // ★토큰 **정의 블록**은 이제 둘이다 — 다크 `:root` 와 라이트 `:root[data-theme="light"]`
  //  (2026-08-26 라이트 스킴). 정의는 리터럴이어야 하므로 둘 다 누수 계산에서 뺀다.
  //  ★"밖" 의 뜻은 *어느 팔레트 블록에도 안 속한 자리* 다 — 라이트를 빼먹으면 라이트 블록의
  //  45개 리터럴이 전부 "누수" 로 잡혀 검사가 거짓 빨간불이 된다(실제로 그렇게 걸렸다).
  const lightBlock = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css);
  const cut = [rootBlock, lightBlock]
    .filter((b): b is RegExpExecArray => b !== null)
    .sort((a, b) => b.index - a.index);
  let body = css;
  for (const b of cut) body = body.slice(0, b.index) + body.slice(b.index + b[0].length);

  // ── ① 색 리터럴 0 ─────────────────────────────────────────────────────────
  const hexes = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const rgbs = (body.match(/rgba?\([^)]*\)/g) ?? []).filter((v) => !v.includes("var("));
  out.push(
    assert(
      "★`:root` 밖에 색 리터럴이 없다(테마를 바꿔도 안 바뀌는 자리가 생기지 않게)",
      hexes.length === 0 && rgbs.length === 0,
      hexes.length === 0 && rgbs.length === 0
        ? "hex 0 · rgb 0"
        : `★hex ${hexes.length}(${[...new Set(hexes)].slice(0, 5).join(",")}) · rgb ${rgbs.length}(${[...new Set(rgbs)].slice(0, 3).join(",")})`,
    ),
  );

  // ── ② 폰트 축 ─────────────────────────────────────────────────────────────
  const pxFont = body.match(/font-size\s*:\s*[0-9.]+px/g) ?? [];
  const litFam = (body.match(/font-family\s*:\s*([^;}]+)/g) ?? []).filter(
    (v) => !v.includes("var(") && !/:\s*inherit\s*$/.test(v),
  );
  out.push(
    assert(
      "★폰트 크기가 `px` 가 아니다(배율이 안 먹는 자리를 만들지 않게)",
      pxFont.length === 0,
      pxFont.length === 0 ? "px 0" : `★${pxFont.length}곳: ${pxFont.slice(0, 4).join(", ")}`,
    ),
    assert(
      "★`font-family` 리터럴이 없다(UI/Mono 폰트 교체가 안 닿는 자리를 만들지 않게)",
      litFam.length === 0,
      litFam.length === 0 ? "리터럴 0" : `★${litFam.length}곳: ${litFam.slice(0, 2).join(" | ")}`,
    ),
    assert(
      "★배율 축이 실제로 서 있다(`html` 이 `--font-scale` 을 쓴다)",
      /html\s*\{[^}]*font-size\s*:\s*calc\([^)]*--font-scale/.test(css),
      /--font-scale/.test(rootBlock[1] ?? "") ? "html + :root 확인" : "★축이 없다",
    ),
  );

  // ── ③ 모든 `var()` 가 실제로 정의돼 있다 ──────────────────────────────────
  //  ★죽은 참조는 **선언을 통째로 무효**로 만드는데 화면엔 조용히 상속으로 나온다.
  //   실제로 `var(--font)`·`var(--muted)` 둘이 그렇게 살아 있었다(2026-08-24 발견).
  const defined = new Set([...(rootBlock[1] ?? "").matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const used = new Set([...css.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]!));
  const dead = [...used].filter((v) => !defined.has(v) && !JS_SET.has(v));
  out.push(
    assert(
      "★죽은 `var()` 참조가 없다(폴백 없는 미정의 = 그 선언이 통째로 무시된다)",
      dead.length === 0,
      dead.length === 0 ? `정의 ${defined.size} · 사용 ${used.size}` : `★미정의: ${dead.join(", ")}`,
    ),
  );

  // ── ④ 토큰이 실제로 쓰인다(가짜 통과 방지) ────────────────────────────────
  const varUses = (css.match(/var\(--/g) ?? []).length;
  out.push(
    assert(
      "토큰 층이 실제로 쓰인다(리터럴 0 이 '규칙이 없어서' 인 상태를 배제)",
      defined.size >= 40 && varUses >= 500,
      `토큰 ${defined.size}개 · var() ${varUses}회`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "dashboard-theme-tokens",
  guards:
    "테마·폰트 설정이 안 닿는 자리가 생기던 것 — 색 리터럴 340곳·px 폰트 286곳이 토큰 층을 우회했고, 그 상태에선 Font Scale 이 원리적으로 안 움직인다",
  run,
};
export default check;
