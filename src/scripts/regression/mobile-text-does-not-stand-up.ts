/**
 * 회귀: **좁은 화면에서 글자가 세로로 서지 않는다** (2026-09-05 정태님: *"글자가 세로로
 * 나열되는 건 다 문제야"*).
 *
 * 한국어는 글자마다 줄바꿈 기회가 있어 **min-content 가 한 글자**다. 그래서 `flex:1`(=`1 1 0`)
 * + `min-width:0` 인 칸은 옆칸이 넓으면 «한 글자 폭»까지 줄어들고, 설명 한 줄이 세로 기둥이
 * 된다. 실측(390 화면, 배포본): 플러그인 상세의 이름·설명·사실표가 폭 10~32px · 최대 34줄.
 *
 * ★고침은 «덜 줄여라»가 아니라 **«한 줄에 안 들어가면 줄을 바꿔라»** 다(`flex-wrap` + 기준
 *  폭). 그래서 이 검사는 그 규칙이 **`.settings-row` 정의보다 뒤에** 있는지까지 본다 —
 *  처음엔 위쪽 모바일 블록에 적었다가 파일 순서상 기본 규칙이 나중이라 **그대로 덮였다**
 *  (같은 특이성이면 뒤가 이긴다). 초록으로 보이는데 화면은 안 고쳐진 상태였다.
 *
 * ★같이 지키는 것: **모바일 마스터-디테일이 뷰 이름을 열거하지 않는다.** 이름 셋이 아홉
 *  줄에 박혀 있었고, 2026-09-02 에 생긴 플러그인 뷰가 그 목록에서 빠져 **폰에서 플러그인
 *  상세가 목록 열두 개 아래에 깔렸다**(거기 인증 버튼이 있다). `show-*` 표식으로 판정한다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★렌더 판정은 헤드리스로 했다(«텍스트 요소의 폭 < 40px 이고 줄 수 ≥ 3» 를 전 뷰에서 스캔,
 *  390·320 둘 다 0건). 여기서는 그 결과를 만든 **규칙이 제자리에 있는지**를 지킨다 — 브라우저
 *  없이 확인할 수 있는 것과 없는 것을 섞지 않는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "mobile-text-does-not-stand-up",
  guards:
    "좁은 화면에서 flex 칸이 한 글자 폭까지 눌려 설명이 세로 기둥이 되던 것 + 그 고침이 파일 순서 때문에 조용히 덮이던 것 + 모바일 마스터-디테일이 뷰 이름을 열거해 새 뷰가 빠지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let css: string;
    let nav: string;
    try {
      css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8");
      nav = readFileSync(path.join(REPO, "packages/dashboard/js/mobile-nav.js"), "utf8");
    } catch {
      return [assert("대시보드 소스 없음(배포 레포 아님)", true, "건너뜀")];
    }
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 주석 안의 예시를 규칙으로 세지 않는다.

    // ── ① 줄을 바꾼다 + ② 그 규칙이 기본 규칙보다 **뒤**에 있다 ────────────────
    const baseAt = bare.indexOf(".settings-meta { flex:");
    const wrapAt = bare.indexOf(".settings-row { flex-wrap:wrap; }");
    const basis = /\.settings-meta \{ flex:1 1 (\d+)px; \}/.exec(bare);
    out.push(
      assert(
        "★좁은 화면에선 설정 행이 **줄을 바꾼다**(칸을 한 글자 폭까지 줄이지 않는다)",
        wrapAt >= 0 && basis !== null,
        `flex-wrap=${wrapAt >= 0 ? "있음" : "★없음"} · 기준폭=${basis?.[1] ?? "★없음"}px`,
      ),
    );
    out.push(
      assert(
        "★★그 규칙이 기본 `.settings-meta` 정의보다 **뒤**에 있다 — 앞에 적으면 조용히 덮인다",
        baseAt >= 0 && wrapAt > baseAt,
        `기본=${baseAt} 모바일=${wrapAt}` + (wrapAt > baseAt ? " (뒤)" : " ★앞이라 무효"),
      ),
    );

    // ── ③ 마스터-디테일이 이름을 열거하지 않는다 ──────────────────────────────
    const mdetail = bare.match(/body(?::not)?\(?\.?m-detail\)?[^;{]*#detail-panel[^;]*;/g) ?? [];
    const named = mdetail.filter((r) => /show-(providers|capabilities|projects|plugins)/.test(r));
    out.push(
      assert(
        "★모바일 마스터-디테일 규칙이 뷰 이름을 열거하지 않는다(새 뷰가 조용히 빠진다)",
        named.length === 0 && /#workbench\[class\*="show-"\]/.test(bare),
        named.length > 0
          ? `★이름이 박힌 규칙 ${named.length}건: ${named[0]?.slice(0, 60) ?? ""}`
          : `show-* 표식으로 판정(규칙 ${mdetail.length}건)`,
      ),
    );
    out.push(
      assert(
        "리스트 서브패널 모바일 보정도 이름을 안 적는다(`#plugins-panel` 이 실제로 빠져 있었다)",
        /#workbench > section\[id\$="-panel"\]:not\(#detail-panel\)/.test(bare),
        /#workbench > section\[id\$="-panel"\]/.test(bare) ? "패널 셀렉터로 파생" : "★이름 열거",
      ),
    );

    // ── ④ 상세 전환 트리거도 행 클래스를 열거하지 않는다 ──────────────────────
    const navBare = nav.replace(/^\s*\/\/.*$/gm, "");
    out.push(
      assert(
        "상세 전환이 `[class*=\"-item\"]` 로 판정한다(.provider-item 만 보던 탓에 플러그인 뷰가 빠졌다)",
        /closest\('\[class\*="-item"\]'\)/.test(navBare) && !/closest\("\.provider-item"\)/.test(navBare),
        /closest\('\[class\*="-item"\]'\)/.test(navBare) ? "행 클래스 패턴" : "★이름 고정",
      ),
    );

    // ── ⑤ ★헤더도 한 줄이다 (2026-09-05 정태님: «티구클로 타이틀이 세로로 나온다») ──
    //  같은 병이 헤더에 남아 있었다. `.brand`·`.live` 가 `flex-shrink:1` 이라 칸이 모자라면
    //  거기서 압력을 받아 min-content(=한국어 한 글자)로 찌그러진다.
    //  실측(375px, 업데이트 칩이 뜬 상태): brand 82×49 · live 46×39 — 둘 다 세로.
    //  ★평소엔 안 보였다 — **업데이트 칩이 뜬 화면에서만** 폭이 모자랐다. 그래서 로컬
    //   재현이 안 됐고, 칩을 강제로 띄워서야 잡혔다. «안 보인다≠없다».
    //  ★그리고 고칠 때 **가로 스크롤로 바꿔치기하지 않았는지**를 같이 못 박는다 —
    //   nowrap 만 걸었더니 375px 에서 384px 가 필요해 페이지가 가로로 스크롤됐다.
    //   그래서 낱말 접기(뜻은 aria-label·title)와 모바일 gap 축소가 짝으로 들어갔다.
    const mob = css.slice(css.indexOf("@media (max-width: 900px)"));
    const onlySpacerShrinks = /header > \*:not\(\.spacer\) \{[^}]*flex:\s*none/.test(mob);
    out.push(
      assert(
        "★헤더에서 줄어드는 칸은 `.spacer` 하나뿐이다 — 아니면 브랜드가 압력을 받아 한 글자씩 선다",
        onlySpacerShrinks,
        onlySpacerShrinks ? "header > *:not(.spacer) { flex:none }" : "★없음 — 텍스트 칸이 min-content 로 찌그러진다",
      ),
    );
    const brandNowrap = /header \.brand,\s*header \.live \{[^}]*white-space:\s*nowrap/.test(mob);
    out.push(
      assert(
        "브랜드·상태 글자가 줄바꿈하지 않는다",
        brandNowrap,
        brandNowrap ? "white-space:nowrap" : "★없음",
      ),
    );
    // ★자리를 낸 쪽 — 이게 없으면 위 두 규칙이 가로 스크롤을 만든다(실측 384 > 375).
    const roomMade =
      /header #bg-toggle \.bg-word \{\s*display:none/.test(mob) &&
      /header \{[^}]*gap:8px/.test(mob);
    out.push(
      assert(
        "★★자리를 내주는 쪽이 같이 있다 — 없으면 세로 글자를 **가로 스크롤로 바꿔치기**한다",
        roomMade,
        roomMade ? "낱말 접기 + gap 8px" : "★없음 — nowrap 만 걸면 375px 에서 384px 가 필요하다",
      ),
    );
    // 접은 낱말의 뜻이 살아 있나(모양만 줄이고 의미는 안 줄인다).
    const indexHtml = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const bgAria =
      /id="bg-toggle"[^>]*aria-label="[^"]+"/.test(indexHtml) &&
      /id="bg-toggle"[^>]*title="[^"]+"/.test(indexHtml);
    out.push(
      assert(
        "접은 낱말의 뜻이 aria-label·title 에 남아 있다",
        bgAria,
        bgAria ? "aria-label·title 유지" : "★뜻이 사라졌다",
      ),
    );
    // 연결 상태 글자는 **지우지 않고** 화면에서만 감춘다(스크린리더는 읽는다).
    const srOnly = /header \.live #conn-text \{[^}]*clip-path:\s*inset\(50%\)/.test(mob);
    out.push(
      assert(
        "연결 상태 글자는 display:none 이 아니라 화면에서만 감춘다 — 뜻을 지우지 않는다",
        srOnly,
        srOnly ? "clip-path 로 시각적 숨김" : "★display:none 이면 스크린리더도 못 읽는다",
      ),
    );

    return out;
  },
};
export default check;
