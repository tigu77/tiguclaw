/**
 * 회귀: **오버레이 패널 안에서 민 스크롤이 뒤 페이지로 새지 않는다** (2026-09-05 사용자 신고:
 * *"모바일에서 백그라운 패널에서 드래그하면 뒤에 홈이 스크롤 된다"*).
 *
 * 실측(390×620, 배포본): 백그라운드 패널을 열고 패널 **안에서** 세로로 밀었더니 뒤 홈이
 * **546px** 스크롤됐다(패널 목록은 `scrollTop 0` 그대로). 원인은 두 겹이다 —
 *  ①패널 자신이 스크롤 컨테이너가 아니라(`overflow:visible`) 터치가 그대로 문서로 갔고,
 *  ②안쪽 목록은 컨테이너지만 **스크롤할 게 없으면**(실측 `scrollHeight-clientHeight = 0`)
 *    브라우저가 뒤 스크롤러로 이어 넘긴다(scroll chaining).
 * 그래서 «컨테이너로 만들고» + «이어 넘기기를 막는다» 가 **둘 다** 필요하다.
 *
 * ★이 검사는 **이름을 열거하지 않는다.** CSS 에서 «화면에 붙어 미끄러져 들어오는 패널»
 *  (`position:fixed` + `top:0` + `bottom:0` + `transform:translateX`)을 뽑아, 그 요소가
 *  마크업에서 `overlay-panel` 표식을 달고 있는지 본다. 넷째 패널이 생기면 저절로 대상이
 *  된다([[feedback_hand_maintained_lists]]) — 이 레포는 같은 부류로 이미 당했다(플러그인
 *  뷰가 모바일 마스터-디테일 이름 목록에서 빠져 상세가 안 열렸다).
 *
 * ★표식이 **마크업에 사는 이유**: 어떤 패널이 오버레이인지는 그 패널 자리에서 선언하는 게
 *  맞다. CSS 한 곳에 이름을 모으면 새 패널이 조용히 빠진다(그게 지금 고친 그 병이다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "overlay-scroll-stays-inside",
  guards:
    "오버레이 패널(백그라운드·검색·메뉴) 안에서 민 스크롤이 뒤 페이지로 이어 넘어가 홈이 스크롤되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let css: string;
    let html: string;
    try {
      css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8");
      html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    } catch {
      return [assert("대시보드 소스 없음(배포 레포 아님)", true, "건너뜀")];
    }
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 주석 속 예시를 규칙으로 세지 않는다.

    // ── ① 규칙 자체 — 컨테이너로 만들고 + 이어 넘기기를 막는다 ────────────────
    const makesContainer = /\.overlay-panel \{[^}]*overflow-y\s*:\s*auto/.test(bare);
    const contains = /\.overlay-panel[^{]*\{[^}]*overscroll-behavior\s*:\s*contain/.test(bare);
    out.push(
      assert(
        "★오버레이는 스크롤 컨테이너다(아니면 터치가 그대로 문서로 간다)",
        makesContainer,
        makesContainer ? ".overlay-panel { overflow-y:auto }" : "★규칙 없음",
      ),
    );
    out.push(
      assert(
        "★스크롤이 뒤 페이지로 이어 넘어가지 않는다(overscroll-behavior:contain)",
        contains,
        contains ? "contain" : "★규칙 없음 — 목록 끝에서 뒤가 스크롤된다",
      ),
    );
    out.push(
      assert(
        "안쪽 스크롤러까지 덮는다(이름을 열거하지 않으려고 자손 전체에 건다 — 비컨테이너엔 무효)",
        /\.overlay-panel, \.overlay-panel \*/.test(bare),
        /\.overlay-panel \*/.test(bare) ? "자손 포함" : "★패널만 — 안쪽 목록 끝에서 샌다",
      ),
    );

    // ── ② 미끄러져 들어오는 고정 패널을 **CSS 에서 뽑아** 표식을 확인한다 ──────
    const overlays: string[] = [];
    for (const m of bare.matchAll(/(#[a-z-]+)\s*\{([^}]*)\}/g)) {
      const sel = m[1] ?? "";
      const body = m[2] ?? "";
      if (
        /position\s*:\s*fixed/.test(body) &&
        /top\s*:\s*0/.test(body) &&
        /bottom\s*:\s*0/.test(body) &&
        /transform\s*:\s*translateX/.test(body)
      ) {
        overlays.push(sel.slice(1));
      }
    }
    out.push(
      assert(
        "미끄러져 들어오는 고정 패널을 CSS 에서 찾는다(파싱이 죽으면 이 검사는 무의미하다)",
        overlays.length >= 2,
        `찾은 패널: ${overlays.join(", ") || "★0개"}`,
      ),
    );
    const missing = overlays.filter((id) => {
      const tag = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
      return !/class="[^"]*overlay-panel/.test(tag);
    });
    out.push(
      assert(
        "★모든 미끄럼 패널이 `overlay-panel` 표식을 단다(표식이 없으면 스크롤이 뒤로 샌다)",
        missing.length === 0,
        missing.length === 0
          ? `${overlays.length}개 전부 표식 있음`
          : `★표식 없는 패널: ${missing.join(", ")}`,
      ),
    );

    return out;
  },
};
export default check;
