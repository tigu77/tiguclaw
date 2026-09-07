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
    // ★★**주석을 걷은 본문을 본다** (2026-09-06 적대 검토 G1). 이 파일의 ①~④는 `bare`
    //  (주석 제거본)를 쓰는데 여기만 원본 `css` 를 봤다. 그래서 **네 규칙을 전부 CSS
    //  주석으로 감싸도 10/10 초록**이었다 — 그 상태에서 CDP 로 재면 브랜드가 48×87 로
    //  다시 서고 가로 스크롤(419 > 375)까지 난다. 정태님이 신고한 그 화면이 그대로
    //  재현되는데 게이트는 만점이었다. [[feedback_gate_must_actually_run]] 와 같은 기제,
    //  반대 방향(그때는 주석 안의 태그를 세서 상시 빨강이었다).
    // ★★`mob` 은 **그 블록**이어야 한다 — 파일의 뒤쪽 전부가 아니다 (2026-09-07 적대 검토 P6).
    //  종전엔 `slice(indexOf(...))` 라 첫 900px 마커부터 **파일 끝까지**였다(실측: 마커가
    //  560행이라 파일의 72%). 그래서 모바일 규칙 다섯을 통째로 `@media (min-width: 1400px)`
    //  로 **옮겨도 만점**이었다 — 폰에선 세로 글자·가로 스크롤·빈 상자가 전부 되살아나는데.
    //  ★부정 단언(«이게 없다»)은 범위가 넓을수록 공짜 초록이 된다. 그래서 범위를 닫는다:
    //   다음 최상위 `@media` 가 시작하는 자리에서 끊는다.
    //  ★모바일 블록은 **여러 개**다(실측: `max-width:900px` 만 여섯, 그 밖에 640·760·430).
    //   그래서 «첫 마커부터 끝까지» 도, «한 블록» 도 아니다 — **좁은 폭 블록 전부**를 모은다.
    //   판정 기준은 폭이다: `max-width: N` 에서 N ≤ 900 인 블록만. `min-width` 블록은
    //   정의상 빠지므로 P6 의 «데스크톱 전용 블록으로 옮기기» 가 통한다.
    const mobileBlocks = ((): string => {
      const parts: string[] = [];
      const re = /@media\s*\(max-width\s*:\s*(\d+)px\)\s*\{/g;
      for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
        if (Number(m[1]) > 900) continue;
        // 여는 중괄호부터 짝이 맞는 닫는 중괄호까지.
        let depth = 0;
        let i = m.index + m[0].length - 1;
        const from = i;
        for (; i < bare.length; i += 1) {
          if (bare[i] === "{") depth += 1;
          else if (bare[i] === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        parts.push(bare.slice(from, i + 1));
      }
      return parts.join("\n");
    })();
    const mob = mobileBlocks;
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
    // ── ★그런데 **보이는 것도 남아야 한다** (2026-09-07 정태님 신고) ─────────────
    //  위 검사는 «뜻이 살아 있나»만 봤다. 그래서 낱말을 접었을 때 **화면에 아무것도 안
    //  남는 것**을 못 봤다 — 배지(`.bg-badge`)는 잡이 0이면 `display:none` 이라 평소엔
    //  안 뜨고, 낱말까지 접히면 버튼이 **빈 상자**가 된다. 사용자가 그걸 보고 물었다.
    //  ★접는 것은 «모양» 이지 «존재» 가 아니다. 항상 보이는 조각이 하나는 있어야 한다.
    // ★«태그가 있나» 가 아니라 «**글자가 있나**» 를 본다 — 빈 껍데기(<span …></span>)는
    //  화면에서 여전히 빈 상자다. 첫 판이 `\S` 로 재서 그 변이가 그냥 통과했다(실측):
    //  닫는 `<` 도 `\S` 라서, 검사가 «아무것도 안 보임» 을 «보인다» 로 읽었다.
    //  ★그리고 «글자» 는 **보이는 글자**여야 한다 (2026-09-07 적대 검토 P4). `[^<\s]` 로
    //   좁힌 판은 «문자 그대로 빈 껍데기» 하나만 닫았다 — `&nbsp;` · `&#8203;` · ZWSP 리터럴이
    //   전부 통과했고, 사용자 눈엔 여전히 빈 상자다. 그리고 300자 창이라 아이콘 `<span>` 을
    //   **버튼 밖으로 빼도** 매칭됐다.
    //  ★그래서 둘 다 좁힌다: 버튼 **안**을 잘라내고, 그 안의 아이콘 내용에서 «안 보이는 것»
    //   (공백류·zero-width·HTML 공백 엔티티)을 걷어낸 뒤 남는 게 있는지 본다.
    const btnInner =
      /<button[^>]*id="bg-toggle"[\s\S]*?<\/button>/.exec(indexHtml)?.[0] ?? "";
    const iconInner = /class="bg-icon"[^>]*>([\s\S]*?)<\/span>/.exec(btnInner)?.[1] ?? "";
    //  ★엔티티 **목록을 적지 않는다** — 첫 판이 16진(`&#x200b;`)만 보고 **십진(`&#8203;`)을
    //   놓쳤다**(변이가 통과했다). 목록은 늘 한 칸 모자란다([[feedback_hand_maintained_lists]]).
    //   대신 **디코드하고 나서 «보이나» 로 판정**한다: 숫자 엔티티는 코드포인트로 바꾸고,
    //   이름 엔티티는 공백류만 풀면 된다(나머지는 어차피 보이는 글자다).
    const decoded = iconInner
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&nbsp;/gi, "\u00a0");
    const visibleIcon = decoded.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/g, "");
    const hasIcon = visibleIcon !== "";
    // ★«숨겼나» 를 **한 철자**로 재던 것 (2026-09-07 적대 검토 P5). `display:none` 만
    //  부정했더니 `visibility:hidden`·`opacity:0`·`font-size:0`·`width:0` 이 전부 통과했다 —
    //  사용자 눈에는 다 같은 «안 보임» 이다. 숨기는 방법을 열거하는 대신 **그 규칙 블록에
    //  숨김류 선언이 하나도 없어야 한다**로 쓴다.
    const iconRule = /header #bg-toggle \.bg-icon \{([^}]*)\}/.exec(mob)?.[1] ?? "";
    const hidesIcon =
      /display\s*:\s*none/.test(iconRule) ||
      /visibility\s*:\s*hidden/.test(iconRule) ||
      /opacity\s*:\s*0(?![.\d])/.test(iconRule) ||
      /font-size\s*:\s*0(?![.\d])/.test(iconRule) ||
      /(?:^|;)\s*width\s*:\s*0(?![.\d])/.test(iconRule);
    const iconStays = iconRule !== "" && !hidesIcon;
    const badgeIsConditional = /#bg-toggle \.bg-badge \{[^}]*display:\s*none/.test(bare);
    out.push(
      assert(
        "★★낱말을 접어도 **보이는 조각**이 남는다 — 배지는 잡이 0이면 안 뜨므로 아이콘이 없으면 빈 상자가 된다",
        hasIcon && iconStays,
        `아이콘=${hasIcon} · 모바일에서 유지=${iconStays} · 배지는 조건부=${badgeIsConditional}`,
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
