/**
 * **변경 내역 파일을 고른다** — 화면 언어를 따라서.
 *
 * ★왜 생겼나 (2026-09-02 정태님: *"대시보드에서 변경내역이나 업데이트 내역도 언어에 따라
 *  연결되면 어떨까"*). v0.46.0 에서 `CHANGELOG.md` 를 영어로, `CHANGELOG.ko.md` 를
 *  한국어로 갈랐다. 그런데 `/changelog`·`/update-changelog` 는 **`CHANGELOG.md` 한 이름만**
 *  읽는다 — 그래서 한국어 화면에서도 영어가 나왔다. 문서를 나누며 소비처를 안 본 것이다
 *  ([[feedback_scope_of_a_fix]] 「계약변경→호출부」).
 *  같은 부류를 대시보드가 이미 한 번 겪었다: 고정 `"ko-KR"` 날짜 표기가 영어 화면에서도
 *  한국식이었다(`sse.js:29` — *"날짜·시각 표기는 화면 언어를 따른다"*).
 *
 * ★**이름 규약이 곧 판정이다** — `CHANGELOG.<locale>.md`, 없으면 `CHANGELOG.md`(영어 기본,
 *  오버레이 규약과 같다). 언어를 늘리는 사람은 **파일을 놓기만** 하면 된다. 코드에 언어
 *  목록을 두지 않는다([[feedback_hand_maintained_lists]]) — 유일성은 파일시스템이 이미 준다.
 *
 * ★판정이 **여기 하나**인 이유: 소비처가 둘이다(설치본 로컬 읽기 / 원격 git show). 각자
 *  이름을 조립하면 곧 두 벌이 되고, 한쪽만 언어를 타는 상태가 조용히 생긴다.
 */
import path from "node:path";

/**
 * 언어를 모를 때 쓰는 파일 — 영어판.
 *
 * ★**이름이 언어를 말한다** (2026-09-02 정태님: *"언어 관련 문서들 전부 코드를 붙이는게
 *  좋겠어"*). 종전엔 코드 없는 `CHANGELOG.md` 가 영어였는데, `docs/security.md` 는 반대로
 *  한국어였다 — **기준 언어가 파일마다 달라** 이름만 보고는 알 수 없었다. 오늘 내가 직접
 *  그 혼란에 걸렸다. 이제 언어판은 전부 코드를 단다(README 만 예외 — GitHub 이 그 이름을
 *  소유한다).
 * ★옛 이름(`CHANGELOG.md`)도 **마지막 후보로 남긴다**: 0.46.0 이하 설치본에서 올라오는
 *  경로가 원격의 옛 이름을 찾을 수 있어야 하고, 남겨도 비용이 0이다(없으면 그냥 건너뛴다).
 */
const BASE = "CHANGELOG.en.md";
/** 코드가 없던 시절의 이름 — 읽기 전용 폴백(새로 만들지 않는다). */
const LEGACY = "CHANGELOG.md";

/**
 * 쿼리로 온 언어 코드를 **파일 이름에 쓸 수 있는 값**으로만 통과시킨다.
 *
 * ★이 값은 경로에 들어간다. 검증 없이 이으면 `?lang=../../etc/passwd` 가 파일 읽기가 된다
 *  — 대시보드는 같은 오리진에 `/api/messages`(=비서에게 임의 지시)를 두고 있어 대가가 크다.
 *  화이트리스트가 아니라 **모양**으로 판정한다(언어가 늘어도 코드를 안 고친다).
 * 모양에 안 맞으면 `undefined` — 호출부는 기본(영어)으로 간다. 던지지 않는다:
 * 변경 내역을 못 보는 것보다 영어로라도 보이는 게 낫다.
 */
export const localeFromQuery = (raw: string | null | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(v) ? v : undefined;
};

/**
 * 이 언어로 시도할 파일 이름 — **선호 순서**대로.
 * `ko` → `["CHANGELOG.ko.md", "CHANGELOG.en.md", "CHANGELOG.md"]`.
 * 마지막은 코드가 없던 시절의 이름이다 — 옛 설치본·옛 원격에서만 걸린다.
 *
 * ★`en` 은 `CHANGELOG.en.md` 로 곧장 간다(그게 실물이다). 새 언어를 넣는 사람도
 *  **파일만 놓으면** 된다 — 코드에 언어 목록이 없다.
 */
export const changelogCandidates = (locale?: string): string[] => {
  const loc = localeFromQuery(locale);
  return loc === undefined
    ? [BASE, LEGACY]
    : [`CHANGELOG.${loc}.md`, BASE, LEGACY];
};

/**
 * 설치본에 깔린 변경 내역을 읽는다. 없으면 **빈 문자열** — 화면이 "찾지 못했습니다" 를
 * 띄운다(빈 화면 금지). 던지지 않는다.
 *
 * `root` 를 인자로 받는 이유: `appRoot()` 를 여기서 부르면 이 함수를 **실제 파일로 검사할
 * 수 없다**. 자리를 정하는 건 호출부(라우트)의 일이고, 고르고 읽는 건 여기 일이다
 * ([[feedback_simple_composable_no_duplication]] 「검사가 껄끄러우면 코드가 잘못 놓인 것」).
 */
export const readInstalledChangelog = async (
  root: string,
  locale?: string,
): Promise<string> => {
  const fs = await import("node:fs/promises");
  for (const name of changelogCandidates(locale)) {
    try {
      const md = await fs.readFile(path.join(root, name), "utf8");
      if (md.trim() !== "") return md;
    } catch {
      /* 다음 후보로 */
    }
  }
  return "";
};
