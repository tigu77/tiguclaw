/**
 * 회귀: **검색 세션 좁히기가 두 자리에서 갈리지 않는다** (2026-08-26).
 *
 * 이 기능의 조용한 실패는 "안 된다" 가 아니라 **"반만 된다"** 다. 셋 다 화면은 멀쩡하고
 * 에러가 0이라 눈으로만 보인다:
 *
 *  ① **더보기에 필터가 안 실린다** — 첫 질의와 커서 질의가 URL 을 각자 조립하면 한쪽만
 *     좁혀져서, 좁혀놓고 스크롤하면 **전 세션 결과가 섞여 들어온다.**
 *  ② **입구가 둘인데 상태가 둘이 된다** — 토글과 결과 라벨 클릭이 각자 값을 들면 칩과
 *     토글이 서로 다른 말을 한다.
 *  ③ **클라에서 거른다** — 전체 결과가 50건 상한이라 거르면 그 세션 것이 상한 밖으로 밀려
 *     **"있는데 안 나오는"** 상태가 된다. 반드시 **다시 던져야** 한다.
 *
 * 등급: 소스 대조 + i18n 규약. ★실제 동작은 헤드리스로 따로 실증했다 —
 * 토글 → `threadKey=dashboard:default` 가 실리고, 칩 ✕ → 필터 없는 질의로 재실행,
 * 결과의 세션 라벨 클릭 → 같은 상태로 좁혀지고 **행 점프는 안 일어난다**(전파 차단).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "search-session-scope",
  guards:
    "검색 세션 좁히기가 첫 질의에만 실리고 더보기(커서)엔 안 실려 좁혀놓고 스크롤하면 전 세션이 섞이던 부류 + 입구 둘이 각자 상태를 들어 토글과 칩이 다른 말을 하는 것 + 50건 상한 아래서 클라 필터링이 '있는데 안 나오는' 결과를 만드는 것",
  run: async (): Promise<Assertion[]> => {
    const js = readFileSync(
      path.join(REPO, "packages/dashboard/js/chat-search.js"),
      "utf8",
    );
    const html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const ko = JSON.parse(
      readFileSync(path.join(REPO, "locales/ko.json"), "utf8"),
    ) as Record<string, string>;

    // ★검색 질의를 만드는 자리가 **하나**인가. 둘이면 한쪽에만 필터가 실린다.
    const rawUrls = [...js.matchAll(/\/api\/chat-search\?/g)].length;
    const viaHelper = [...js.matchAll(/searchUrl\(/g)].length;

    return [
      assert(
        "★검색 URL 조립이 한 곳이다(둘이면 더보기에 필터가 안 실린다)",
        // ★실측으로 맞췄다(짐작 금지): 직접 조립 1(=`searchUrl` 정의 안) · 사용 2(첫 질의·더보기).
        rawUrls === 1 && viaHelper === 2,
        `직접 조립 ${rawUrls}곳(기대 1 — searchUrl 정의 안) · searchUrl 사용 ${viaHelper}회(기대 2)`,
      ),
      assert(
        "★더보기(커서)도 같은 조립기를 쓴다",
        /searchUrl\(\s*q0,/.test(js) && /beforeTs=\$\{cursorTs\}/.test(js),
        /searchUrl\(\s*q0,/.test(js) ? "커서 질의도 searchUrl 경유" : "★커서 질의가 따로 조립한다",
      ),
      assert(
        "★좁히기 상태가 하나다(입구 둘이 같은 세터로 모인다)",
        // ★`scopeKey\s*=` 는 `===` 비교까지 먹는다(첫 판이 4로 세어 빨간불) — 순수 대입만 센다.
        (js.match(/scopeKey\s*=[^=]/g) ?? []).length === 2 &&
          (js.match(/setScope\(/g) ?? []).length === 3,
        `순수 대입 ${(js.match(/scopeKey\s*=[^=]/g) ?? []).length}곳(기대 2: 초기화·세터) · setScope 호출 ${(js.match(/setScope\(/g) ?? []).length}회(기대 3: 토글·칩·라벨)`,
      ),
      assert(
        "★거르지 않고 다시 던진다(50건 상한 아래서 클라 필터는 '있는데 안 나오는' 을 만든다)",
        /if \(curQuery !== ""\) run\(curQuery\);/.test(js) &&
          !/hits\.filter\([^)]*threadKey/.test(js),
        /if \(curQuery !== ""\) run\(curQuery\);/.test(js) ? "재질의" : "★재질의가 없다",
      ),
      assert(
        "★결과의 세션 라벨이 입구다 + 행 점프로 새지 않는다(전파 차단)",
        /sess\.addEventListener\("click"/.test(js) && /ev\.stopPropagation\(\)/.test(js),
        /ev\.stopPropagation\(\)/.test(js) ? "전파 차단 있음" : "★라벨을 누르면 대화로 점프한다",
      ),
      assert(
        "마크업에 토글·칩이 있다(스크립트만 있고 자리가 없으면 아무 일도 안 난다)",
        html.includes('id="chat-search-mine"') &&
          html.includes('id="chat-search-scope-chip"'),
        `토글=${html.includes('id="chat-search-mine"')} 칩=${html.includes('id="chat-search-scope-chip"')}`,
      ),
      // ★세션 이름은 **사용자 콘텐츠**라 뒤에 조사를 붙이면 안 된다("공통 으로" 가 그랬다).
      //  어떤 글자로 끝날지 모르므로 이름을 문장 **끝**이나 콜론 뒤에 둔다.
      assert(
        "★칩 문구가 세션 이름 뒤에 한국어 조사를 붙이지 않는다(이름은 사용자 콘텐츠다)",
        !/\{name\}\s*(으로|로|이|가|은|는|을|를)\b/.test(ko["search.scope.chip"] ?? ""),
        JSON.stringify(ko["search.scope.chip"]),
      ),
      assert(
        "좁혀서 0건이면 빠져나갈 길을 함께 말한다",
        typeof ko["search.scope.emptyHere"] === "string" &&
          /search\.scope\.emptyHere/.test(js),
        JSON.stringify(ko["search.scope.emptyHere"]),
      ),
    ];
  },
};
