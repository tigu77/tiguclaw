/**
 * 회귀: **공개 문서의 언어 배치** — README 는 영어 랜딩, 하위 문서는 한국어 기본.
 *
 * ★2026-08-24 사용자 결정으로 **README 축이 뒤집혔다**: *"작업은 한국어로 다 하고 영어로
 *  번역이 맞는데, 깃헙 메인 노출은 영어."* 그 전(2026-08-07)엔 README 도 한국어가 기본이었고
 *  이 검사가 그걸 지키고 있었다 — 뒤집은 건 **사용자**이고, 그래서 검사도 같이 뒤집는다.
 *  (게이트를 지우거나 느슨하게 푸는 게 아니라, 지키는 대상을 새 결정으로 바꾼다.)
 *
 * ★`README.md` 는 **GitHub 랜딩 페이지**다 — 파일 이름이 곧 기본 언어다. 발견 표면
 *  (description·topics)이 영어라 랜딩만 한국어면 입구와 내용이 갈린다.
 * ★하위 문서(`docs/`)는 **한국어가 기본**이다(작업 언어). 영어는 `X.en.md` 로 함께 간다.
 *
 * 검사하는 것:
 *  ①`README.md`(랜딩)가 **영어**다 — 한글 문서가 아니다. (파일 존재만 보면 내용이 바뀌어도 초록이다.)
 *  ②한국어판이 `README.ko.md` 로 함께 있다(양문 유지 — 한국어를 버리자는 게 아니다).
 *  ③`docs/security.ko.md` 는 **한국어**이고 `docs/security.en.md` 가 함께 있다(하위 문서 축은 불변).
 *  ★⑦**이름이 언어를 말한다** (2026-09-02 정태님: *"언어 관련 문서들 전부 코드를 붙이는게
 *   좋겠어"*). 종전엔 코드 없는 이름의 언어가 **파일마다 달랐다** — `CHANGELOG.md`=영어인데
 *   `docs/security.md`=한국어. 이름만 보고는 알 수 없었고, 실제로 그 혼란에 걸렸다.
 *   이제 언어판은 **전부 코드**를 단다. 예외는 `README.md` 하나 — GitHub 이 그 이름을
 *   소유한다(다른 이름으로 두면 첫 화면이 빈다). 예외를 **하나로 못박는 것**이 이 단언이다.
 *  ④상호 링크가 **양방향**이다(한쪽만 걸리면 다른 쪽에서 못 돌아온다).
 *  ⑤각 언어판이 **같은 언어의 하위 문서**를 가리킨다 — 한국어 README 가 영어 security 를
 *   링크하던 옛 불일치가 이 규칙의 출발점이었다.
 *  ⑥`README.en.md`(옛 이름)가 되살아나지 않는다 — 두 벌이 되면 한쪽이 늙는다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const OVERLAY = "../../../_workspace/public-overlay/";
const DOCS = "../../../docs/";

/** 한글 음절이 충분히 있으면 한국어 문서로 본다(제목 한두 개로는 안 된다). */
const isKorean = (body: string): boolean =>
  (body.match(/[가-힣]/g) ?? []).length > 200;

export const check: RegressionCheck = {
  name: "public-docs-language-layout",
  guards:
    "공개 문서 언어 배치가 사용자가 정한 것과 갈리던 것 — 랜딩(README.md)은 영어, 하위 문서는 한국어 기본, 양쪽 다 짝이 있고 서로 링크된다",
  run: async (): Promise<Assertion[]> => {
    const { readFile } = await import("node:fs/promises");
    const read = async (rel: string): Promise<string | null> => {
      try {
        return await readFile(new URL(rel, import.meta.url), "utf8");
      } catch {
        return null;
      }
    };

    const out: Assertion[] = [];

    // ⑦ ★코드 없는 언어판이 **남아 있지 않다.** 이름을 열거하지 않는다 — `X.en.md` 가
    //   있는데 `X.md` 도 있으면 그 `X.md` 는 «코드 없는 언어판» 이다(예외는 README 뿐).
    {
      const { readdir } = await import("node:fs/promises");
      const scan = async (relDir: string): Promise<string[]> => {
        try {
          return await readdir(new URL(relDir, import.meta.url));
        } catch {
          return [];
        }
      };
      const offenders: string[] = [];
      for (const [dir, label] of [
        [DOCS, "docs/"],
        [OVERLAY, ""],
      ] as const) {
        const files = await scan(dir);
        for (const f of files) {
          const m = /^(.+)\.en\.md$/.exec(f);
          if (m === null) continue;
          const stem = m[1]!;
          if (stem === "README") continue; // ★유일한 예외 — GitHub 이 이 이름을 소유한다.
          if (files.includes(`${stem}.md`)) offenders.push(`${label}${stem}.md`);
        }
      }
      out.push(
        assert(
          "★★코드 없는 언어판이 없다 — 이름이 언어를 말한다(예외는 README.md 하나, GitHub 이 그 이름을 소유한다)",
          offenders.length === 0,
          offenders.length === 0
            ? "코드 없는 언어판 0"
            : `★코드가 빠진 것: ${offenders.join(", ")}`,
        ),
      );
    }
    const koReadme = await read(`${OVERLAY}README.ko.md`);
    const enReadme = await read(`${OVERLAY}README.md`);
    const koSec = await read(`${DOCS}security.ko.md`);
    const enSec = await read(`${DOCS}security.en.md`);

    // ★배포 레포엔 `_workspace/` 가 없다(매니페스트 EXCLUDE) — 거기선 README 축이 대상
    //  아님. 조용한 통과 금지: 무엇을 못 봤는지 detail 에 남긴다.
    if (enReadme === null && koReadme === null) {
      out.push(assert("README 언어 배치", true, "배포 레포 — 오버레이 없음(대상 아님)"));
    } else {
      out.push(
        assert(
          "★README.md(랜딩)가 **영어**다 — 이 파일이 곧 GitHub 첫 화면이다",
          enReadme !== null && !isKorean(enReadme),
          enReadme === null ? "파일 없음" : `한글 ${(enReadme.match(/[가-힣]/g) ?? []).length}자`,
        ),
        assert(
          "README.ko.md(한국어)도 함께 있다(양문 유지)",
          koReadme !== null && isKorean(koReadme),
          koReadme === null ? "한국어판 없음" : "한국어판 확인",
        ),
        assert(
          "README: 언어 링크가 양방향이다",
          enReadme !== null && koReadme !== null &&
            enReadme.includes("README.ko.md") && koReadme.includes("README.md"),
          enReadme === null || koReadme === null ? "쌍 불완전" : "상호 링크 확인",
        ),
        assert(
          "★옛 이름 `README.en.md` 가 되살아나지 않는다(두 벌이면 한쪽이 늙는다)",
          (await read(`${OVERLAY}README.en.md`)) === null &&
            !(enReadme ?? "").includes("README.en.md") &&
            !(koReadme ?? "").includes("README.en.md"),
          "옛 이름 0",
        ),
        assert(
          "★각 언어판이 같은 언어의 하위 문서를 가리킨다(옛 불일치가 이 규칙의 출발점)",
          (enReadme ?? "").includes("docs/security.en.md") &&
            (koReadme ?? "").includes("docs/security.ko.md") &&
            !(koReadme ?? "").includes("docs/security.en.md"),
          `영→${(enReadme ?? "").includes("docs/security.en.md") ? "en" : "?"} · 한→${(koReadme ?? "").includes("docs/security.ko.md") ? "ko" : "?"}`,
        ),
      );
    }

    // ★하위 문서 축은 **안 뒤집혔다** — 작업 언어가 한국어이므로 `docs/X.md` 가 한국어다.
    out.push(
      assert(
        "docs/security.ko.md(기본)가 한국어다 — 하위 문서는 작업 언어가 기본",
        koSec !== null && isKorean(koSec),
        koSec === null ? "파일 없음" : `한글 ${(koSec.match(/[가-힣]/g) ?? []).length}자`,
      ),
      assert(
        "docs/security.en.md(영어)도 함께 있다",
        enSec !== null && !isKorean(enSec),
        enSec === null ? "영어판 없음" : "영어판 확인",
      ),
    );
    return out;
  },
};
