/**
 * 회귀: **마크다운이 지원한다고 한 것을 실제로 그린다** (2026-08-27).
 *
 * ★사용자 요청에서 시작했다 — *"머메이드를 그래프로 잘 보여주고 있나?"* 아니었다. 그리고
 *  그 김에 재보니 **넷이 더 있었다**: 체크박스·접기·표 정렬·kbd. 넷 다 `marked` 는 이미
 *  만들거나 통과시키는데 **우리 sanitize 에서만 죽고 있었다**(실측). 값은 있는데 도달
 *  경로가 0이던 부류다.
 *
 * ★고친 방식이 중요하다 — 종전엔 *"모든 속성 제거 후 `a.href`·`code.class` 만 if 두 개로
 *  복원"* 이었다. 태그가 늘 때마다 분기가 붙는 모양이라 그 자체가 다음 실수의 자리다.
 *  **태그별 속성 정책 테이블**로 바꿨다(allowlist, 값까지 검사).
 *
 * ★mermaid 는 **sanitize 를 건드리지 않는다.** 화이트리스트에 `svg` 를 여는 쪽이 훨씬
 *  위험하다(`foreignObject`·이벤트 핸들러). 대신 이미 정화된 코드 블록의 **텍스트**를
 *  mermaid(`securityLevel:"strict"`)가 SVG 로 만들고 우리 컨테이너에 넣는다.
 *
 * 등급: **소스 대조 + 정책 실행**. 실제 렌더(DOM)는 헤드리스로 따로 실증했다 —
 * `_workspace/md_live_cdp.mjs`: 체크박스 2·비활성 2·접기 1·kbd 2·표정렬 left·
 * mermaid SVG 1·`<script>` 0 · **로드 직후 mermaid 요청 0건 → 블록 만난 뒤 1건**(지연 로드).
 */
import { readFileSync, statSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

/** 정책 테이블만 떼어 vm 에서 **실제로 부른다**(대시보드 JS 는 import 불가). */
const slicePolicy = (src: string): string => {
  const from = src.indexOf("      const MD_SAFE_HREF");
  const end = src.indexOf("\n      };", src.indexOf("      const MD_ATTR_POLICY"));
  if (from < 0 || end < 0) throw new Error("MD_ATTR_POLICY 를 못 찾음 — 구조가 바뀌었나");
  return src.slice(from, end + "\n      };".length).replace(/^\s{6}const /gm, "var ");
};

export const check: RegressionCheck = {
  name: "markdown-features",
  guards:
    "marked 가 만들어주는 체크박스·표 정렬과 통과시키는 details/kbd 가 우리 sanitize 에서만 죽어 화면에 안 보이던 것 + mermaid 블록이 그래프가 아니라 코드 상자로 뜨던 것 + 그 3.4MB 를 안 쓰는 사용자도 받게 되는 것",
  run: async (): Promise<Assertion[]> => {
    const md = read("packages/dashboard/js/markdown.js");
    const server = read("packages/dashboard/index.ts");
    const html = read("packages/dashboard/index.html");

    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(`${slicePolicy(md)}\nthis.__p = MD_ATTR_POLICY;`, ctx);
    const P = ctx.__p as Record<string, Record<string, (v: string) => string | null>>;

    const tags = /const MD_ALLOWED_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(md)?.[1] ?? "";
    const has = (t: string): boolean => new RegExp(`"${t}"`).test(tags);

    let mermaidBytes = 0;
    try {
      mermaidBytes = statSync(path.join(REPO, "packages/dashboard/mermaid.min.js")).size;
    } catch {
      /* 없으면 아래 단언이 잡는다 */
    }

    return [
      // ── A: 화이트리스트만 넓히면 되던 것들 ──
      assert(
        "★체크박스·접기·kbd 태그가 허용된다(marked 는 이미 만들고 있었다)",
        has("input") && has("details") && has("summary") && has("kbd"),
        `input=${has("input")} details=${has("details")} summary=${has("summary")} kbd=${has("kbd")}`,
      ),
      assert(
        "★표 정렬이 살아남는다(marked 가 align 을 주는데 우리가 지우고 있었다)",
        P.th?.align?.("center") === "center" && P.td?.align?.("right") === "right",
        `th=${String(P.th?.align?.("center"))} td=${String(P.td?.align?.("right"))}`,
      ),
      // ── 값 검사 — 이름만 보면 위험한 값이 통과한다 ──
      assert(
        "★align 은 값까지 본다(CSS 표현식 주입 차단)",
        P.td?.align?.("expression(alert(1))") === null && P.th?.align?.("javascript:x") === null,
        `expression→${String(P.td?.align?.("expression(alert(1))"))} · javascript→${String(P.th?.align?.("javascript:x"))} (둘 다 null 이어야)`,
      ),
      assert(
        "★input 은 checkbox 만(type=image 등은 탈락 → 호출부가 요소를 버린다)",
        P.input?.type?.("checkbox") === "checkbox" &&
          P.input?.type?.("image") === null &&
          P.input?.type?.("password") === null,
        `checkbox=${String(P.input?.type?.("checkbox"))} image=${String(P.input?.type?.("image"))}`,
      ),
      assert(
        "★체크박스는 **항상** 비활성이다(marked 를 믿지 않고 우리가 강제한다)",
        /if \(tag === "input"\)[\s\S]{0,400}?setAttribute\("disabled", ""\)/.test(md) &&
          /getAttribute\("type"\) !== "checkbox"[\s\S]{0,120}?removeChild\(child\)/.test(md),
        /setAttribute\("disabled", ""\)/.test(md) ? "강제 있음" : "★marked 가 빼먹으면 눌린다",
      ),
      assert(
        "★href 는 여전히 스킴을 본다(정책 테이블로 옮기며 잃지 않았다)",
        P.a?.href?.("https://x.test/a") === "https://x.test/a" &&
          P.a?.href?.("javascript:alert(1)") === null,
        `js=${String(P.a?.href?.("javascript:alert(1)"))}`,
      ),
      assert(
        "★코드 언어 클래스도 그대로(하이라이터가 쓴다)",
        P.code?.class?.("language-csharp") === "language-csharp" &&
          P.code?.class?.("evil klass") === null,
        `ok=${String(P.code?.class?.("language-csharp"))} bad=${String(P.code?.class?.("evil klass"))}`,
      ),
      // ── B: mermaid ──
      assert(
        "★mermaid 를 vendored 로 들고 있다(CDN 0 — 오프라인·사내망에서도 돈다)",
        mermaidBytes > 1_000_000 && /pathname === "\/mermaid\.min\.js"/.test(server),
        `${(mermaidBytes / 1024 / 1024).toFixed(1)}MB · 라우트=${/pathname === "\/mermaid\.min\.js"/.test(server)}`,
      ),
      assert(
        "★**안 쓰면 안 받는다** — index.html 이 미리 걸지 않는다(3.4MB)",
        !/mermaid/.test(html) && /el\.src = "\/mermaid\.min\.js"/.test(md),
        `index.html 참조=${/mermaid/.test(html) ? "★있다" : "0건"} · 지연 로드=${/el\.src = "\/mermaid\.min\.js"/.test(md)}`,
      ),
      assert(
        "★블록이 있을 때만 로드한다(빈손이면 즉시 반환)",
        /if \(blocks\.length === 0\) return;/.test(md),
        /blocks\.length === 0/.test(md) ? "가드 있음" : "★블록이 없어도 받는다",
      ),
      // ★A조 G2: `securityLevel:"strict"` **문자열이 있는지**만 보면, strict 인 채로 새는
      //  것(라벨 안 `<img>` 가 외부 요청을 내는 것)을 못 잡는다. 아래 셋이 그 축이다.
      assert(
        "★★라벨을 HTML 로 그리지 않는다(htmlLabels:false — 라벨 안 <img> 가 외부로 요청을 냈다)",
        /htmlLabels: false/.test(md) && /flowchart: \{ htmlLabels: false \}/.test(md),
        `전역=${/htmlLabels: false/.test(md)} · flowchart=${/flowchart: \{ htmlLabels: false \}/.test(md)}` +
          " — 기본값(true)이면 렌더되는 순간 임의 호스트로 요청이 나간다(실측 2건)",
      ),
      assert(
        "★★산출 SVG 를 **우리 정책에 한 번 더** 통과시킨다(설정 하나에 기대지 않는다)",
        /const hardenMermaidSvg/.test(md) &&
          /hardenMermaidSvg\(box\)/.test(md) &&
          /querySelectorAll\("img, image, iframe, foreignObject, script"\)/.test(md),
        `정의=${/const hardenMermaidSvg/.test(md)} · 호출=${/hardenMermaidSvg\(box\)/.test(md)}`,
      ),
      assert(
        "★mermaid 링크가 우리 스킴 검사를 탄다(javascript: 등)",
        /MD_ATTR_POLICY\.a\.href\(raw\)/.test(md),
        `스킴 검사=${/MD_ATTR_POLICY\.a\.href\(raw\)/.test(md)}`,
      ),
      // ★셋을 **따로** 본다 — 하나로 묶으면 `rel` 만 지우는 변이가 통과한다(실측).
      //  같은 화면에서 링크 정책이 둘이 되면 클릭 시 대시보드 탭 자체가 남의 URL 로 간다.
      assert(
        "★mermaid 링크도 새 탭 + noopener 로 연다(우리 마크다운 링크와 같은 규칙)",
        /a\.setAttribute\("target", "_blank"\)/.test(md) &&
          /a\.setAttribute\("rel", "noopener noreferrer"\)/.test(md),
        `target=${/a\.setAttribute\("target", "_blank"\)/.test(md)} · ` +
          `rel=${/a\.setAttribute\("rel", "noopener noreferrer"\)/.test(md)}`,
      ),
      assert(
        "★옛 `xlink:href` 는 제거한다(남으면 정책 밖 링크가 그대로 산다)",
        /a\.removeAttribute\("xlink:href"\)/.test(md),
        /removeAttribute\("xlink:href"\)/.test(md) ? "제거함" : "★mermaid 는 xlink:href 로 쓴다",
      ),
      assert(
        "★렌더용 임시 노드를 치운다(실패가 쌓이면 상시 화면이라 단조 증가한다)",
        /finally \{[\s\S]{0,320}?getElementById\(id\)[\s\S]{0,120}?remove\(\)/.test(md),
        /finally \{/.test(md) ? "정리 있음" : "★실패 20회에 21개가 남았다(실측)",
      ),
      assert(
        "★테마를 **매 렌더** 다시 읽는다(전환 후 새 다이어그램이 옛 테마로 그려지던 것)",
        /initMermaid\(m\); \/\/ ★테마는 매 렌더/.test(md) ||
          /initMermaid\(m\);[\s\S]{0,80}?m\.render/.test(md),
        /initMermaid\(m\);[\s\S]{0,80}?m\.render/.test(md)
          ? "렌더 직전 재초기화"
          : "★최초 1회만 초기화하면 테마 전환이 안 따라온다",
      ),
      assert(
        "★모델 출력은 신뢰 입력이 아니다 — securityLevel strict",
        /securityLevel: "strict"/.test(md),
        /securityLevel: "(\w+)"/.exec(md)?.[1] ?? "★securityLevel 지정이 없다(기본 loose)",
      ),
      assert(
        "★실패하면 원문이 남는다(문법 오류로 내용이 사라지지 않는다)",
        /catch \{[\s\S]{0,200}?mermaidDone = "";/.test(md),
        /pre\.replaceWith\(box\)/.test(md) ? "성공했을 때만 교체" : "★먼저 지우고 그린다",
      ),
      assert(
        "★다이어그램 테마를 **화면에서 읽는다**(테마 이름 열거 0)",
        /getPropertyValue\("--bg"\)/.test(md) && !/theme: "dark" \}/.test(md),
        `--bg 읽음=${/getPropertyValue\("--bg"\)/.test(md)} · 못박은 theme 리터럴=${/theme: "dark" \}/.test(md)}`,
      ),
    ];
  },
};
