/**
 * 회귀: **대화 검색 UI 가 실제로 배선돼 있다** (2026-08-23).
 *
 * 배경: 채팅 검색은 백엔드(코어·스토어·엔드포인트)만 있고 **프런트가 없어서**, 완성으로
 * 보고됐는데 사용자가 닿을 길이 0이었다. 게다가 그 엔드포인트는 조인 컬럼이 틀려 라이브에서
 * 항상 500 이었고, 그걸 지키던 회귀는 SQL 을 **문자열로 대조**해 버그를 박제하고 있었다.
 *
 * ★대시보드 JS 는 **매니페스트에 등록해야 로드된다**. 파일만 두면 죽은 코드다 — 그리고
 *  그 실패는 조용하다(버튼이 안 눌릴 뿐 에러가 없다). 실제 클릭·질의·점프는 헤드리스
 *  (`_workspace/verify_chat_search.mjs`, 10/10)가 보지만 그건 Chrome+라이브 데몬이 필요해
 *  매 회귀에 못 넣는다. 여기서는 **매번 싸게** 배선을 지킨다 — 파일·매니페스트·스크립트
 *  태그·DOM 계약·서버 점프 진입점이 서로 맞물려 있는가.
 *
 * ★DOM id 를 여기 열거하는 것은 "손으로 관리하는 목록" 이지만, 이건 **계약**이다 —
 *  HTML 과 JS 두 파일이 같은 문자열로 만나는 지점이고, 한쪽만 바뀌면 조용히 죽는다.
 *  그래서 양쪽에 **둘 다** 있는지를 본다(한쪽만 검사하면 드리프트를 못 본다).
 */
import { readFile } from "node:fs/promises";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages", "dashboard");

const read = async (rel: string): Promise<string | null> => {
  try {
    return await readFile(path.join(DASH, rel), "utf8");
  } catch {
    return null;
  }
};

/** HTML·JS 가 같은 문자열로 만나야 하는 지점. 한쪽만 바뀌면 버튼이 조용히 죽는다. */
const CONTRACT_IDS = [
  "chat-search-btn",
  "cs-panel",
  "cs-backdrop",
  "chat-search-input",
  "chat-search-results",
  "chat-search-count",
  "chat-search-prev",
  "chat-search-next",
];

export const check: RegressionCheck = {
  name: "chat-search-ui-wired",
  guards:
    "채팅 검색이 백엔드만 있고 프런트가 없어 사용자가 닿을 길이 0이던 것 + 대시보드 JS 를 매니페스트에 등록 안 해 파일만 두고 죽은 코드가 되던 것(실패가 조용하다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const js = await read("js/chat-search.js");
    // 화면 문구는 카탈로그에 산다 — 단언이 그 값을 직접 본다.
    const koCat = JSON.parse(
      await readFile(path.join(REPO, "locales", "ko.json"), "utf8"),
    ) as Record<string, string>;
    const searchPartial = koCat["search.partial"] ?? "";
    const html = await read("index.html");
    const manifestRaw = await read("js/_manifest.json");
    const tabs = await read("js/tabs.js");
    const css = (await read("app.css")) ?? "";
    const vt = (await read("js/virtualization.js")) ?? "";
    const store = (await readFile(path.join(REPO, "src", "store", "chat-log.ts"), "utf8").catch(() => "")) as string;
    const bridge = readSourceSync("plugins/http-bridge");
    const consts = (await read("js/constants.js")) ?? "";
    const bg = (await read("js/background-drawer.js")) ?? "";
    const md = (await read("js/markdown.js")) ?? "";
    const act = (await read("js/activity.js")) ?? "";
    const hist = (await read("js/history-render.js")) ?? "";

    if (js === null || html === null || manifestRaw === null || tabs === null) {
      return [
        assert(
          "대시보드 소스 부재 시 통과(배포본 — 오탐 0)",
          true,
          "★확인 못 함 — '이상 없음' 아님",
        ),
      ];
    }

    let manifest: string[] = [];
    try {
      manifest = JSON.parse(manifestRaw) as string[];
    } catch {
      manifest = [];
    }

    out.push(
      assert(
        "★모듈이 매니페스트에 등록돼 있다(파일만 두면 로드 안 된다)",
        manifest.includes("chat-search.js"),
        manifest.includes("chat-search.js") ? "등록됨" : "★매니페스트 누락 — 죽은 파일",
      ),
      assert(
        "index.html 이 그 스크립트를 싣는다",
        html.includes('src="/js/chat-search.js"'),
        html.includes('src="/js/chat-search.js"') ? "확인" : "★script 태그 누락",
      ),
      assert(
        // 순서가 뒤집히면 `window.openSessionByKey` 가 아직 없어 점프가 죽는다.
        "★tabs.js 뒤에 실린다(점프 진입점이 먼저 정의돼야 한다)",
        html.indexOf('src="/js/tabs.js"') >= 0 &&
          html.indexOf('src="/js/tabs.js"') < html.indexOf('src="/js/chat-search.js"'),
        `tabs=${html.indexOf('src="/js/tabs.js"')} search=${html.indexOf('src="/js/chat-search.js"')}`,
      ),
    );

    const missing = CONTRACT_IDS.filter((id) => !html.includes(`id="${id}"`) || !js.includes(id));
    out.push(
      assert(
        "★HTML 과 JS 가 같은 DOM 계약을 쓴다(한쪽만 바뀌면 버튼이 조용히 죽는다)",
        missing.length === 0,
        missing.length === 0 ? `${CONTRACT_IDS.length}개 일치` : `★불일치 ${missing.join(" ")}`,
      ),
      assert(
        "★세션 점프는 tabs.js 의 단일 진입점으로 간다(탭 생성 규칙 두 벌 금지)",
        tabs.includes("window.openSessionByKey") && js.includes("window.openSessionByKey"),
        `tabs=${tabs.includes("window.openSessionByKey")} search=${js.includes("window.openSessionByKey")}`,
      ),
      assert(
        // 스니펫 범위·세션 표시명은 서버 판정. (강조 위치만 클라가 다시 찾는다 —
        // 마크다운 기호를 걷어내면 서버 offset 이 그만큼 어긋나기 때문. 아래 참조.)
        "판단은 서버 것을 쓴다(스니펫·세션 표시명을 클라가 만들지 않는다)",
        js.includes("hit.snippet") && js.includes("hit.sessionLabel"),
        "서버 판정 소비 확인",
      ),
      assert(
        // ★카드에서 마크다운 기호를 **걷어낸다**(렌더하지 않는다). 120자 조각이라 여는
        //  기호가 잘리면 짝이 어긋나 **엉뚱한 구간이 굵어진다**(실측 2회) — 틀린 강조는
        //  안 한 것보다 나쁘다. 되살리려는 사람이 이 판단을 다시 밟지 않게 박아 둔다.
        "★스니펫은 마크다운을 걷어내고 보여준다(조각 오강조 방지)",
        // ★**호출부**를 본다. 함수 정의만 찾으면 호출을 지워도 통과한다(변이 실측) —
        //  오늘 같은 부류를 세 번 겪었다: 검사 문자열은 *지우려는 그 줄*에 고유해야 한다.
        js.includes("stripMarkdown(hit.snippet)") &&
          !js.includes('tag: "strong"') &&
          // ★규칙은 `markdown.js` 한 곳 — 전체 활동의 한 줄 프리뷰도 같은 것을 쓴다.
          //  각자 두면 같은 글이 화면마다 다르게 보인다(실제로 활동 뷰는 `**` 를 노출했다).
          md.includes("const stripMarkdownText") &&
          // ★프리뷰 **그 줄**을 본다. 파일에 이름만 있으면 되는 게 아니다 —
          //  `activityPlainPreview` 에도 같은 호출이 있어서, 프리뷰에서 빼도 통과했다
          //  (변이 실측, 오늘 세 번째 같은 부류).
          act.includes("stripMarkdownText(full)"),
        js.includes("stripMarkdown(hit.snippet)") ? "스트립 확인(규칙 공유)" : "★스니펫에 스트립 미적용",
      ),
      assert(
        // ★드로어는 `body.cs-open` 으로 열린다 — CSS 와 JS 가 **같은 클래스**로 만나는
        //  지점이라 한쪽만 바뀌면 버튼을 눌러도 아무 일도 안 일어난다(에러도 없다).
        "★드로어 열림 상태를 CSS·JS 가 같은 클래스로 쓴다(body.cs-open)",
        js.includes("cs-open") && css.includes("body.cs-open #cs-panel"),
        `js=${js.includes("cs-open")} css=${css.includes("body.cs-open #cs-panel")}`,
      ),
      assert(
        // ★Ctrl/⌘+F 를 **채팅 화면에서만** 가로챈다. 이 가드가 빠지면 대시보드 어느
        //  화면에서든 브라우저 기본 찾기를 뺏는데, 우리가 대신 줄 게 없는 자리에서
        //  남의 기능을 뺏는 것이라 사용자는 "찾기가 고장났다" 고 읽는다.
        "★Ctrl/⌘+F 가로채기는 채팅 화면으로 한정된다",
        js.includes('dataset.view !== "chat"') && js.includes("preventDefault"),
        `scope=${js.includes('dataset.view !== "chat"')} prevent=${js.includes("preventDefault")}`,
      ),
      assert(
        // ★결과 클릭 → **그 메시지 위치까지** 스크롤. 셋이 사슬로 물려 있어 하나만 끊겨도
        //  세션만 열리고 조용히 끝난다: 검색이 `jumpTs` 를 넘기고 → tabs 가 이력 로드를
        //  기다렸다 부르고 → 가상화가 그 자리로 스크롤한다.
        "★결과 클릭이 메시지 위치까지 간다(jumpTs → jumpToMessageTs → vtScrollToTs)",
        js.includes("jumpTs") &&
          tabs.includes("jumpTs") &&
          tabs.includes("window.jumpToMessageTs") &&
          hist.includes("window.jumpToMessageTs") &&
          hist.includes("window.vtScrollToTs") &&
          vt.includes("window.vtScrollToTs"),
        `search=${js.includes("jumpTs")} tabs=${tabs.includes("window.jumpToMessageTs")} hist=${hist.includes("window.vtScrollToTs")} vt=${vt.includes("window.vtScrollToTs")}`,
      ),
      assert(
        // ★못 닿으면 **말한다**. 조용히 세션만 열리면 사용자는 클릭이 씹혔다고 읽는다.
        "★점프 실패를 사용자에게 알린다(조용한 실패 0)",
        tabs.includes("notifyJumpMiss") && js.includes("notifyJumpMiss"),
        `tabs=${tabs.includes("notifyJumpMiss")} search=${js.includes("notifyJumpMiss")}`,
      ),
      assert(
        // ★결과를 눌러도 **안 닫힌다**. 브라우저 찾기처럼 "3/5" 를 보며 오가는 게 요구였고,
        //  닫아 버리면 다음 결과로 가려고 매번 다시 검색해야 한다.
        "★결과 클릭이 드로어를 닫지 않는다(커서만 옮긴다)",
        !/row\.addEventListener\("click",[\s\S]{0,400}?close\(\)/.test(js) &&
          js.includes("goTo(myIndex)"),
        js.includes("goTo(myIndex)") ? "커서 이동" : "★클릭이 닫는다",
      ),
      assert(
        // ★↑/↓ = 이전/다음, Enter = 검색 (사용자 확정). Enter 를 "다음" 에 걸면 타이핑을
        //  끝내고 누르는 Enter 가 엉뚱하게 커서를 옮긴다.
        "★↑/↓ 로 결과를 오가고 Enter 는 검색이다",
        js.includes("goTo(cursor - 1)") &&
          js.includes("goTo(cursor + 1)") &&
          // ★가드 문장을 통째로 본다. `e.key === "ArrowDown"` 만 찾으면 안쪽
          //  삼항(`e.key === "ArrowDown" ? … : …`)에도 있어서 **가드를 지워도 통과**했다
          //  (변이 실측). 검사 문자열은 지우려는 그 줄에 고유해야 한다.
          js.includes('e.key === "ArrowDown" || e.key === "ArrowUp"') &&
          /e\.key === "Enter"[\s\S]{0,200}?run\(input\.value\)/.test(js),
        "키 배정 확인",
      ),
      assert(
        // ★상한이 있는 자리에서 **잘렸다고 말한다**. 없을 때 화면은 "'는' — 50건" 이라고
        //  했는데 실제로는 1,438건이었다(실측) — 캡의 침묵은 사용자에게 거짓이 된다
        //  ([[project_hotpath_bound_preserve_record]] · [[feedback_pruned_table_absence]]).
        "★검색 결과가 잘리면 총 건수와 함께 알린다(조용한 절삭 0)",
        // ★문구는 카탈로그에 산다 — 키를 부르는지와, 그 문구가 **총 건수와 표시 건수를 둘 다**
        //  담는지(자리표시자 두 개)를 본다. 원문 grep 은 번역 가능한 문장마다 낡는다.
        js.includes('i18n("search.partial"') &&
          js.includes("data.total") &&
          /\{total\}/.test(searchPartial) &&
          /\{shown\}/.test(searchPartial),
        `total=${js.includes("data.total")} 키=${js.includes('i18n("search.partial"')} 문구=${JSON.stringify(searchPartial)}`,
      ),
      assert(
        // 목록과 개수가 **같은 조건**을 써야 "N건 중 M건" 이 참이 된다.
        "★총 건수와 목록이 같은 조건을 쓴다(searchWhere 단일 조립)",
        store.includes("const searchWhere = (") &&
          store.includes("countChatLogMatches") &&
          // 호출 2회(목록 + 개수) — 정의는 `searchWhere = (` 라 이 패턴에 안 걸린다.
          (store.match(/searchWhere\(/g) ?? []).length >= 2,
        `조립 호출 ${(store.match(/searchWhere\(/g) ?? []).length}회(목록·개수)`,
      ),
      assert(
        // ★50건 상한에서 멈추지 않는다 — 바닥에 닿으면 커서로 이어 받는다(사용자 요청).
        //  OFFSET 이 아니라 `beforeTs` 커서다: 그 사이 새 메시지가 오면 OFFSET 은 건너뛰거나
        //  두 번 보여준다.
        "★50건 너머를 이어 받는다(beforeTs 커서 + 바닥 스크롤)",
        // ★**배선**을 본다(정의 이름이 아니라). `loadMore` 만 찾으면 `loadMoreDISABLED`
        //  로 바꿔도 통과한다 — 부분 문자열이라(변이 실측, 오늘 두 번째).
        js.includes('resultsEl.addEventListener("scroll"') &&
          js.includes("void loadMore();") &&
          js.includes("beforeTs=") &&
          store.includes("opts?.beforeTs !== undefined") &&
          bridge.includes("beforeTs"),
        `client=${js.includes("void loadMore();")} store=${store.includes("opts?.beforeTs !== undefined")} bridge=${bridge.includes("beforeTs")}`,
      ),
      assert(
        // ★두 드로어가 같은 자리에 같은 몸짓으로 뜨는데 폭 한계가 다르면 번갈아 열 때
        //  들쭉날쭉하다. 값을 각자 적으면 한쪽만 늙는다(사용자 확정: 같게).
        "★검색·백그라운드 드로어가 같은 폭 한계를 쓴다(clampDrawerWidth 공유)",
        consts.includes("const clampDrawerWidth") &&
          js.includes("clampDrawerWidth") &&
          bg.includes("clampDrawerWidth") &&
          !/Math\.min\(760/.test(bg),
        `consts=${consts.includes("const clampDrawerWidth")} search=${js.includes("clampDrawerWidth")} bg=${bg.includes("clampDrawerWidth")}`,
      ),
      assert(
        // 폭 조절은 **저장돼야** 의미가 있다 — 열 때마다 되돌아가면 매번 다시 끌어야 한다.
        "★검색 패널 폭을 드래그로 바꾸고 저장한다",
        js.includes("cs-resize") &&
          js.includes("tc:csPanelWidth") &&
          js.includes("localStorage.setItem") &&
          css.includes(".cs-resize"),
        `핸들=${js.includes("cs-resize")} 저장=${js.includes("localStorage.setItem")} css=${css.includes(".cs-resize")}`,
      ),
      assert(
        // ★인라인 패널로 되돌아가면 채팅 공간을 다시 먹는다(사용자가 그래서 옮기라고 했다).
        "★채팅 영역 안에 인라인 검색 패널이 없다(대화를 밀지 않는다)",
        !html.includes('id="chat-search-panel"'),
        html.includes('id="chat-search-panel"') ? "★인라인 패널 부활" : "드로어 유지",
      ),
    );
    return out;
  },
};
