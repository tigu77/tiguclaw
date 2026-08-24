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
 * ★등급: **배선 린트**(소스 스캔). 실제 레이아웃을 재지 않으므로 나중에 붙은 더 구체적인
 *  선택자가 `.md` 를 덮으면 못 잡는다 — 그래서 "덮는 규칙이 있나" 까지 같이 본다.
 *  행동으로 재려면 브라우저가 필요한데 스위트는 노드 전용이다(그 한계를 여기 적어 둔다).
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

    const mdBlock = /(^|[\s,}])\.md\s*\{([^}]*)\}/m.exec(rules);
    out.push(
      assert(
        "app.css 에 `.md` 규칙이 있다",
        mdBlock !== null,
        mdBlock !== null ? "찾음" : "★`.md` 규칙 자체가 없다 — 선택자가 바뀌었나",
      ),
    );
    if (mdBlock === null) return out;

    const wrap = /overflow-wrap\s*:\s*([a-z-]+)/.exec(mdBlock[2] ?? "");
    out.push(
      assert(
        "★`.md` 가 `overflow-wrap: anywhere` 다",
        wrap?.[1] === "anywhere",
        wrap == null
          ? "★규칙 없음(=normal) — 긴 URL 한 토큰이 모바일에서 문서를 458 로 민다"
          : wrap[1] === "anywhere"
            ? "anywhere"
            : `★'${wrap[1]}' — grid/flex 안의 .md 는 트랙이 벌어져 형제까지 끌고 나간다`,
      ),
    );

    // `.md` 를 덮어쓰는 다른 규칙이 없어야 한다(더 구체적인 선택자 + overflow-wrap).
    const overriders = [...rules.matchAll(/([^{}]*\.md[^{}]*)\{([^}]*)\}/g)]
      .filter((m) => /overflow-wrap/.test(m[2] ?? ""))
      .map((m) => (m[1] ?? "").trim())
      .filter((sel) => sel !== ".md");
    out.push(
      assert(
        "다른 규칙이 `.md` 의 줄바꿈을 덮지 않는다",
        overriders.length === 0,
        overriders.length === 0 ? "덮는 규칙 없음" : `★덮는 규칙: ${overriders.join(" / ")}`,
      ),
    );
    return out;
  },
};
export default check;
