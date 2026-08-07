/**
 * 회귀: **공개 문서의 기본 언어는 한국어다** (2026-08-07 사용자 지정).
 *
 * "배포본에 기본을 한국어로 가자 … 무조건 한국어를 기준으로, 한국어가 자연스러워야 하고
 * 바탕으로 영어를 지원" — 그 전까지는 영문이 기본(`X.md`)이고 한국어가 보조(`X.ko.md`)였다.
 *
 * ★`README.md` 는 **GitHub 랜딩 페이지**다 — 파일 이름이 곧 기본 언어다. 그래서 이건
 *  취향이 아니라 배포 산출물의 성질이고, 되돌아가면 사용자가 원한 것과 반대가 된다.
 *
 * 검사하는 것:
 *  ①기본 파일(`README.md`·`docs/security.md`)이 **한국어**다 — 한글이 실제로 들어 있고,
 *   영어 문서의 표식이 아니다. (파일 존재만 보면 내용이 바뀌어도 초록이다.)
 *  ②영어판이 `X.en.md` 로 함께 있다(양문 유지 — 영어를 버리자는 게 아니다).
 *  ③상호 링크가 **양방향**으로 걸려 있다(한쪽만 걸리면 다른 쪽에서 못 돌아온다).
 *  ④각 언어판이 **같은 언어의 하위 문서**를 가리킨다 — 한국어 README 가 영어 security 를
 *   링크하던 옛 불일치가 이 규칙의 출발점이었다.
 *  ⑤옛 이름(`README.ko.md`)이 되살아나지 않는다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const OVERLAY = "../../../_workspace/public-overlay/";
const DOCS = "../../../docs/";

/** 한글 음절이 충분히 있으면 한국어 문서로 본다(제목 한두 개로는 안 된다). */
const isKorean = (body: string): boolean =>
  (body.match(/[가-힣]/g) ?? []).length > 200;

export const check: RegressionCheck = {
  name: "korean-first-public-docs",
  guards:
    "공개 문서 기본 언어가 영문으로 되돌아가 GitHub 랜딩이 사용자가 정한 것과 반대가 되던 것",
  run: async (): Promise<Assertion[]> => {
    const { readFile } = await import("node:fs/promises");
    const read = async (rel: string): Promise<string | null> => {
      try {
        return await readFile(new URL(rel, import.meta.url), "utf8");
      } catch {
        return null;
      }
    };

    const pairs = [
      { ko: `${OVERLAY}README.md`, en: `${OVERLAY}README.en.md`, name: "README" },
      { ko: `${DOCS}security.md`, en: `${DOCS}security.en.md`, name: "docs/security" },
    ];
    const out: Assertion[] = [];

    for (const p of pairs) {
      const ko = await read(p.ko);
      const en = await read(p.en);
      // ★배포 레포엔 `_workspace/` 가 없다(매니페스트 EXCLUDE) — 거기선 README 축이 대상
      //  아님. 조용한 통과 금지: 무엇을 못 봤는지 detail 에 남긴다.
      if (ko === null && p.ko.includes("public-overlay")) {
        out.push(
          assert(`${p.name}: 기본이 한국어다`, true, "배포 레포 — 오버레이 없음(대상 아님)"),
        );
        continue;
      }
      out.push(
        assert(
          `★${p.name}.md(기본)가 한국어다 — 이 파일이 곧 랜딩 페이지다`,
          ko !== null && isKorean(ko),
          ko === null ? "파일 없음" : `한글 ${(ko.match(/[가-힣]/g) ?? []).length}자`,
        ),
      );
      out.push(
        assert(
          `${p.name}.en.md(영어)도 함께 있다(양문 유지)`,
          en !== null && !isKorean(en),
          en === null ? "영어판 없음" : "영어판 확인",
        ),
      );
      out.push(
        assert(
          `${p.name}: 언어 링크가 양방향이다`,
          ko !== null &&
            en !== null &&
            ko.includes(`${p.name.split("/").pop()}.en.md`) &&
            en.includes(`${p.name.split("/").pop()}.md`),
          ko === null || en === null ? "쌍 불완전" : "상호 링크 확인",
        ),
      );
    }

    // ④ 같은 언어끼리 링크 — 한국어 README 는 한국어 security 를 가리킨다.
    const koReadme = await read(`${OVERLAY}README.md`);
    const enReadme = await read(`${OVERLAY}README.en.md`);
    if (koReadme !== null && enReadme !== null) {
      out.push(
        assert(
          "★각 언어판이 같은 언어의 하위 문서를 가리킨다(옛 불일치가 이 규칙의 출발점)",
          koReadme.includes("docs/security.md") &&
            !koReadme.includes("docs/security.en.md") &&
            enReadme.includes("docs/security.en.md"),
          `한→${koReadme.includes("docs/security.md") ? "ko" : "?"} · 영→${enReadme.includes("docs/security.en.md") ? "en" : "?"}`,
        ),
      );
      // ⑤ 옛 이름 부활 금지.
      out.push(
        assert(
          "옛 이름(README.ko.md·security.ko.md)이 되살아나지 않는다",
          !koReadme.includes("README.ko.md") &&
            !enReadme.includes("README.ko.md") &&
            !koReadme.includes("security.ko.md"),
          "옛 이름 0",
        ),
      );
    }
    return out;
  },
};
