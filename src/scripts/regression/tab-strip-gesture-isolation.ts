/**
 * 회귀: **세션탭 스트립 위의 세로 제스처는 거기서 끝난다.**
 *
 * 사용자 지시 (2026-08-11): "세션탭쪽에서 스크롤로 새로고침 하지말고 / 세션탭쪽에서는
 *  채팅 스크롤이 안먹히게". 탭을 훑으려고 스트립을 만질 때마다 대화가 딸려 스크롤되거나
 *  새로고침이 걸렸다.
 *
 * ★뿌리는 "제스처가 과했다" 가 아니라 **같은 성질을 두 곳이 정한 것**이다.
 *  CSS 는 `touch-action:pan-x` 로 *"여기서 세로 제스처는 없다"* 고 선언하는데,
 *  `mobile-nav.js` 의 커스텀 pull-to-refresh 핸들러(2026-07-19)가 세로 당김을 잡아
 *  **그 선언을 뒤집었다.** 게다가 CSS 선언은 모바일 미디어쿼리 안에만 있어 데스크탑엔
 *  아무 규칙도 없었다. 고침은 핸들러 제거 + 성질을 **기본 규칙 한 곳**으로 올리기.
 *
 * ★휠은 CSS 로 막을 수 없다 — `touch-action` 은 터치 전용이다. 그래서 `tabs.js` 에
 *  한 줄이 남는다. 그건 중복이 아니라 **같은 성질의 플랫폼 보충**이고, 양쪽 주석이
 *  서로를 가리켜 판단이 갈리지 않게 묶어 뒀다.
 *
 * ★검사 등급 — **소스 판정**이다(브라우저 CSS/제스처). 진짜 검증은 헤드리스 실측이었고
 *  그 수치를 남긴다: 스트립 위 세로휠 `scrollY 7629 → 7629`(막힘) / 대화 영역 위 같은 휠
 *  `7629 → 6629`(정상 이동 — 비교군이 움직여야 이 판정이 의미가 있다).
 *  재현: `_workspace/tabstrip_scroll_probe.mjs`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const at = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
/** 주석은 검사 대상이 아니다 — 결함을 설명한 글을 코드로 세면 상시 실패한다. */
const codeOf = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const css = at("packages/dashboard/app.css");
  const mobile = codeOf(at("packages/dashboard/js/mobile-nav.js"));
  const tabs = codeOf(at("packages/dashboard/js/tabs.js"));

  // ── ① 커스텀 pull-to-refresh 가 없다(선언을 뒤집던 두 번째 결정자) ───────
  {
    const revived = /ptrTabs|ptrPill|PTR_THRESH/.test(mobile);
    out.push({
      name: "★세션탭 pull-to-refresh 핸들러가 없다(CSS 선언을 뒤집던 자리)",
      ok: !revived,
      got: revived ? "🔴 PTR 핸들러가 되살아났다" : "핸들러 없음",
    });
    out.push({
      name: "그 인디케이터 스타일도 같이 사라졌다(고아 CSS 0)",
      ok: !/\.ptr-pill/.test(css),
      got: /\.ptr-pill/.test(css) ? "🔴 .ptr-pill 잔존(아무도 안 붙임)" : "고아 스타일 없음",
    });
  }

  // ── ② 성질은 **기본 규칙 한 곳**에 있다 ─────────────────────────────────
  {
    const base = /\.session-tabs \{[^}]*\}/.exec(css)?.[0] ?? "";
    out.push({
      name: "★.session-tabs 기본 규칙이 세로 제스처를 막는다(데스크탑·모바일 공통)",
      ok: /touch-action:\s*pan-x/.test(base) && /overscroll-behavior:\s*contain/.test(base),
      got: base === "" ? "🔴 규칙 없음" : base.slice(0, 130),
    });
    // 같은 성질이 미디어쿼리 안에 또 있으면 갈린다 — 종전엔 거기만 있었다.
    const dupes = (css.match(/#session-tabs\s*\{[^}]*touch-action/g) ?? []).length;
    out.push({
      name: "같은 성질을 미디어쿼리에서 다시 정하지 않는다(정하는 곳 하나)",
      ok: dupes === 0,
      got: dupes === 0 ? "중복 선언 0" : `🔴 #session-tabs touch-action 재선언 ${dupes}건`,
    });
  }

  // ── ③ 휠(데스크탑) 보충 — 세로만 막고 가로는 살린다 ─────────────────────
  {
    const hasWheel = /addEventListener\(\s*\n?\s*"wheel"/.test(tabs);
    const verticalOnly = /Math\.abs\(e\.deltaY\) > Math\.abs\(e\.deltaX\)/.test(tabs);
    const nonPassive = /passive:\s*false/.test(tabs);
    out.push({
      name: "★휠도 스트립에서 끝난다(touch-action 은 터치 전용이라 CSS 로 못 막는다)",
      ok: hasWheel && nonPassive,
      got: `wheel 리스너=${hasWheel} non-passive=${nonPassive} (passive 면 preventDefault 가 무시된다)`,
    });
    out.push({
      name: "★가로 휠은 건드리지 않는다(트랙패드 가로 스와이프 = 탭 넘기기)",
      ok: verticalOnly,
      got: verticalOnly ? "세로 우세일 때만 차단" : "🔴 가로까지 막으면 탭 이동이 죽는다",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "tab-strip-gesture-isolation",
  guards:
    "세션탭 스트립을 훑을 때 대화가 딸려 스크롤되거나 커스텀 pull-to-refresh 로 새로고침이 걸리던 것 — CSS 가 touch-action:pan-x 로 선언한 성질을 JS 핸들러가 뒤집고 있었고, 그 선언마저 모바일 미디어쿼리 안에만 있었다",
  run,
};
