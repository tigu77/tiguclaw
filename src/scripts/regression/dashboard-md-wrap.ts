/**
 * 회귀: **렌더된 마크다운의 긴 토큰이 끊긴다** (2026-08-24).
 *
 * `.md` 에 `overflow-wrap` 규칙이 **없으면**(=초기값 `normal`) URL·경로처럼 공백 없는 긴
 * 토큰이 안 끊긴다. 실측(헤드리스, 변경 이력 펼침): 뷰포트 390 에서 문서가 **458**, 320 에서
 * **459** 로 밀렸다 — 넘친 건 토큰 하나인데 화면 전체가 옆으로 튀어나간다.
 *
 * ★**데스크톱에선 안 보인다.** 폭이 넉넉해 같은 문서가 멀쩡히 그려지므로, 개발 중엔 영영
 *  안 드러나고 모바일 사용자만 겪는다 — 이 레포가 반복해서 당한 "조용한" 부류다.
 *
 * ★`break-word` 로 바꿔도 이 검사가 걸려야 한다. 블록 안에선 둘이 같지만 **min-content 폭에
 *  반영되는 건 `anywhere` 뿐**이라, `.md` 가 grid/flex 안에 놓이면(`.detail-card{display:grid}`)
 *  `break-word` 는 트랙을 벌려 **형제까지 끌고 나간다**(그 배치에서 427 로 늘어난 걸 봤다).
 *
 * ★등급: **배선 린트**(소스 스캔) — 그리고 **한계를 정직하게 적는다.** CSS 캐스케이드는
 *  노드에서 계산할 수 없다(그건 브라우저를 만드는 일이다). 그래서 이 검사가 보는 것은
 *  **`.md` 자기 선택자의 마지막 선언**뿐이다.
 *
 * ★2026-08-24 적대 검토가 이 검사를 **세 방향으로 뚫었다**(전부 실측 513px 재현):
 *   ①뒤쪽에 `.md{overflow-wrap:normal}` 한 줄 추가 ②`@media(min-width:901px){.md{…}}`
 *   ③`.changelog-body > div{overflow-wrap:normal}`. ①②는 이제 잡는다(마지막 선언을 본다).
 *   ③처럼 **다른 선택자**가 덮는 것은 원리적으로 못 잡는다 — 그건 캐스케이드다.
 *
 * ★그리고 종전 "덮는 규칙이 있나" 단언은 **방향이 거꾸로였다**: `.md pre code
 *  {overflow-wrap:normal}` 같은 **올바른 예외**에 빨강을 냈고(옆 레인 `.aav-md` 엔 이미 있는
 *  정당한 규칙이다), 정작 진짜 회귀(①②③)엔 초록이었다. 지키지도 못하면서 지킨다고 적힌
 *  검사가 가장 나쁘다 — 그래서 **뺐다.** 진짜 판정은 헤드리스 프로브
 *  (`_workspace/_md_wrap_modes_cdp.mjs`)가 한다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-md-wrap",
  guards:
    "렌더된 마크다운의 긴 URL·경로가 안 끊겨 모바일에서 화면 전체가 가로로 튀어나가던 것 — 데스크톱에선 안 보인다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let css: string;
    try {
      css = await readFile(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
    } catch {
      return [assert("app.css 없음(배포 레포 아님)", true, "건너뜀")];
    }

    // 주석을 걷고 본다 — 주석 안의 예시를 규칙으로 세면 항상 초록이 된다
    // ([[feedback_gate_must_actually_run]]: 같은 오탐으로 게이트 하나가 죽어 있었다).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

    // ★`.md` 선택자의 **모든** 선언을 순서대로 모아 **마지막**을 본다 — CSS 는 뒤가 이긴다.
    //  미디어쿼리 안의 `.md` 도 같은 선택자다(적대 검토 ②가 그 구멍으로 들어왔다).
    const mdRules = [...rules.matchAll(/(^|[\s,{}])\.md\s*\{([^}]*)\}/g)].map((m) => m[2] ?? "");
    out.push(
      assert(
        "app.css 에 `.md` 규칙이 있다",
        mdRules.length > 0,
        mdRules.length > 0 ? `${mdRules.length}개 블록` : "★`.md` 규칙 자체가 없다 — 선택자가 바뀌었나",
      ),
    );
    if (mdRules.length === 0) return out;

    const decls = mdRules
      .map((body) => /overflow-wrap\s*:\s*([a-z-]+)/.exec(body)?.[1])
      .filter((v): v is string => v !== undefined);
    const last = decls[decls.length - 1];
    out.push(
      assert(
        "★`.md` 의 **마지막** `overflow-wrap` 선언이 `anywhere` 다(뒤에 덮어써도 잡힌다)",
        last === "anywhere",
        decls.length === 0
          ? "★선언 없음(=normal) — 긴 URL 한 토큰이 모바일에서 문서를 458 로 민다"
          : last === "anywhere"
            ? `선언 ${decls.length}개 · 마지막 anywhere`
            : `★마지막이 '${last}' — grid/flex 안의 .md 는 트랙이 벌어져 형제까지 끌고 나간다`,
      ),
    );

    return out;
  },
};
export default check;
