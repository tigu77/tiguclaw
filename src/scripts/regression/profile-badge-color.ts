/**
 * 회귀: **프로파일 배지 색** — 형식 고정 · 손목록 제거 (2026-08-24 사용자 요청).
 *
 * 종전엔 배지 색이 CSS 에 `[data-tier="low"|"mid"|"high"]` **세 이름만** 박혀 있었다.
 * 그래서 사용자가 만든 프로파일(`gpt-high` 등)은 전부 회색으로 떨어졌다 —
 * [[feedback_hand_maintained_lists]] 의 전형: 목록은 그대로인데 지나가는 것이 바뀌었다.
 * 이제 색은 **프로파일이 자기가 들고 온다**(`models.profiles.<name>.color`).
 *
 * ★이 검사의 무게중심은 미관이 아니라 **주입**이다. 이 값은 대시보드에서
 *  `el.style.color` 로 나간다 — 임의 문자열을 통과시키면 스타일 주입이다. 그래서
 *  경계(`isBadgeColor`)가 `#rrggbb` 만 통과시키고, **화면도 같은 형식을 다시 확인**한다.
 *  두 곳이 갈리면 한쪽이 뚫린다 → 그 정합까지 여기서 본다.
 *
 * ★등급: **행동 게이트**(판정 함수를 실행) + 화면 미러는 소스 대조. 화면 쪽 판정은 DOM 이
 *  아니라 **정규식 상수**라 소스 대조로도 실제 값을 비교할 수 있다(문자열 존재 확인이 아님).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBadgeColor, loadModelProfiles } from "../../core/settings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 경계: `#rrggbb` 만 ─────────────────────────────────────────────────
  const good = ["#a78bfa", "#000000", "#FFFFFF", "  #7dd3fc  "];
  const bad = [
    "red", // 이름 색 — 통과시키면 형식이 무너진다
    "#abc", // 3자리 축약
    "#a78bf", // 5자리
    "#a78bfaa", // 7자리
    "#a78bfa; background:url(javascript:alert(1))", // ★주입 시도
    "rgba(0,0,0,.5)",
    "", 42, null, undefined, {},
  ];
  const goodOk = good.every((v) => isBadgeColor(v));
  const badOk = bad.every((v) => !isBadgeColor(v));
  out.push(
    assert(
      "★`#rrggbb` 만 통과한다(이름 색·축약·세미콜론 주입 전부 거부)",
      goodOk && badOk,
      goodOk && badOk
        ? `통과 ${good.length}종 · 거부 ${bad.length}종`
        : `★good=${goodOk} bad=${badOk}`,
    ),
  );

  // ── ② 파싱: 잘못된 색은 프로파일에 **안 실린다**(조용히 통과 금지) ────────
  const dir = mkdtempSync(path.join(tmpdir(), "profile-color-"));
  mkdirSync(path.join(dir, ".tiguclaw"), { recursive: true });
  writeFileSync(
    path.join(dir, ".tiguclaw", "settings.json"),
    JSON.stringify({
      models: {
        profiles: {
          okc: { pool: ["codex:gpt-5.6-sol"], color: "#A78BFA" },
          badc: { pool: ["codex:gpt-5.6-sol"], color: "red; content:'x'" },
          nonec: { pool: ["codex:gpt-5.6-sol"] },
        },
      },
    }) + "\n",
    "utf8",
  );
  const profs = loadModelProfiles(dir);
  out.push(
    assert(
      "유효한 색은 실리고 **소문자로 정규화**된다",
      profs.okc?.color === "#a78bfa",
      `okc.color=${String(profs.okc?.color)}`,
    ),
    assert(
      "★잘못된 색은 프로파일에 안 실린다(주입 문자열이 화면까지 못 간다)",
      profs.badc !== undefined && profs.badc.color === undefined,
      `badc=${JSON.stringify(profs.badc)}`,
    ),
    assert(
      "색이 없어도 프로파일은 멀쩡하다(색은 선택)",
      profs.nonec !== undefined && profs.nonec.color === undefined,
      `nonec=${JSON.stringify(profs.nonec)}`,
    ),
  );

  // ── ③ 화면 미러가 **같은 형식**을 본다 ────────────────────────────────────
  const dash = readFileSync(
    new URL("../../../packages/dashboard/js/view-models.js", import.meta.url),
    "utf8",
  );
  const m = /const HEX6 = (\/\^#\[0-9a-fA-F\]\{6\}\$\/)/.exec(dash);
  out.push(
    assert(
      "★대시보드가 서버와 **같은 형식**을 다시 확인한다(두 곳이 갈리면 한쪽이 뚫린다)",
      m !== null,
      m !== null ? `미러 ${m[1]}` : "★화면 쪽 형식 검증(HEX6)이 없거나 달라졌다",
    ),
    // 죽은 코드가 되살아나지 않게 — 옛 티어 클래스 유추는 **한 번도 안 걸렸다**(실측 0/6).
    assert(
      "옛 `specTierClass`(항상 무색이던 죽은 판정)가 되살아나지 않았다",
      !/specTierClass/.test(dash),
      /specTierClass/.test(dash) ? "★되살아남" : "제거 확인",
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "profile-badge-color",
  guards:
    "프로파일 배지 색 — CSS 에 이름 3개만 박혀 사용자 프로파일이 전부 회색이던 것 + 색 문자열이 검증 없이 style 로 나가는 주입 경로",
  run,
};
export default check;
