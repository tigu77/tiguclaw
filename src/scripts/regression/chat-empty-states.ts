/**
 * 회귀: **빈 채팅 자리가 모르는 것을 단언하지 않는다** (2026-08-21, 사용자 신고).
 *
 * 사고: `#chat-empty` 는 HTML 에 **처음부터 보이는 상태**로 박혀 있고 이력 로드는
 * 비동기다. 그래서 fetch 가 도는 동안 화면이 **"아직 대화가 없습니다"** 를 띄웠다 —
 * 아직 받아보지 않았을 뿐인데 "없다"고 단언한 것이고, 대화가 많은 세션일수록 그
 * 거짓말이 오래 보였다. 로드 **실패**(`!r.ok`)도 같은 문구로 삼켜졌다.
 *
 * ★이 레포가 오늘만 세 번 고친 형상이다 — 화면·검사·로그가 *모르는 것을 아는 척*하는 자리.
 *
 * 지키는 것:
 *  ①로딩 중엔 "없다"고 말하지 않는다
 *  ②실패는 빈 대화와 **다른 문구**다(실패를 성공처럼 말하지 않는다)
 *  ③내용이 있으면 어떤 상태에서도 안 뜬다
 *  ④로드 경로 **둘 다**(첫 진입·탭 전환) 상태를 올리고, `finally` 로 닫는다
 *    — "loading" 으로 굳는 경로가 없어야 한다
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck, JS_I18N_STUB } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JS = (n: string): string =>
  readFileSync(path.join(REPO, "packages/dashboard/js", n), "utf8");

/** `const <name> = (` 부터 짝 맞는 `}` 까지(중괄호 깊이). */
const sliceFn = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return `${src.slice(start, i + 1)};`;
    }
  }
  return null;
};

/** `{` 위치부터 짝 맞는 `}` 까지. 거리 창 대신 구조로 뜬다. */
const sliceBlock = (src: string, open: number): string => {
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
};

/**
 * 파일 안 **모든** `finally { … }` 블록.
 *
 * ★첫 번째만 뜨면 안 된다 — 한 파일에 로드 경로가 여럿이면(history-render 가 그렇다)
 *  엉뚱한 블록을 보고 "안 닫는다"고 오판한다. 있는 것 전부를 주고, 판정은 호출부가 한다.
 */
const finallyBlocks = (src: string): string[] => {
  const out: string[] = [];
  for (let i = src.indexOf("finally"); i >= 0; i = src.indexOf("finally", i + 7)) {
    const open = src.indexOf("{", i);
    if (open >= 0) out.push(sliceBlock(src, open));
  }
  return out;
};

export const check: RegressionCheck = {
  name: "chat-empty-states",
  guards:
    "이력을 불러오는 중인데 화면이 '아직 대화가 없습니다'라고 단언하던 것 + 로드 실패가 빈 대화로 삼켜지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const core = JS("chat-core.js");

    const src = sliceFn(core, "chatEmptyView");
    out.push(
      assert(
        "★빈 채팅 판정이 순수 함수로 나와 있다(렌더 안이면 실행 검사가 불가하다)",
        src !== null,
        src === null ? "★chatEmptyView 없음" : `${src.length}자`,
      ),
    );
    if (src === null) return out;

    const view = new Function(`${JS_I18N_STUB}${src}return chatEmptyView;`)() as (
      s: string,
      n: number,
    ) => { show: boolean; title: string; body: string };

    // ① 로딩 중엔 "없다"고 말하지 않는다.
    const loading = view("loading", 0);
    out.push(
      assert(
        "★로딩 중엔 '없다'고 단언하지 않는다",
        loading.show === true && !loading.title.includes("없습니다"),
        `title="${loading.title}"`,
      ),
    );

    // ② 실패는 빈 대화와 다른 문구다.
    const err = view("error", 0);
    const ready = view("ready", 0);
    out.push(
      assert(
        "★로드 실패와 빈 대화가 다른 문구다(실패를 성공처럼 말하지 않는다)",
        err.show === true && ready.show === true && err.title !== ready.title,
        `error="${err.title}" / ready="${ready.title}"`,
      ),
    );
    out.push(
      assert(
        "빈 대화 문구는 종전 그대로다(첫 사용자 안내 유지)",
        ready.title.includes("아직 대화가 없습니다") && ready.body !== "",
        `"${ready.title}"`,
      ),
    );

    // ③ 내용이 있으면 어떤 상태에서도 안 뜬다.
    const shown = ["loading", "ready", "error"].filter((s) => view(s, 3).show);
    out.push(
      assert(
        "★내용이 있으면 어떤 상태에서도 빈 안내가 안 뜬다",
        shown.length === 0,
        shown.length === 0 ? "3상태 전부 숨김" : `★뜸: ${shown.join(",")}`,
      ),
    );

    // ④ 로드 경로 둘 다 상태를 올리고 finally 로 닫는다.
    for (const [file, label] of [
      ["history-render.js", "첫 진입"],
      ["tabs.js", "탭 전환"],
    ] as const) {
      const s = JS(file);
      const setsLoading = s.includes('setHistoryLoadState("loading")');
      const setsError = s.includes('setHistoryLoadState("error")');
      // ★`finally` **블록을 중괄호로 떠서** 본다 — 종전엔 `finally {` 부터 400자 창이었는데,
      //  그 사이에 주석 몇 줄만 들어와도 단언이 조용히 거짓이 됐다(2026-08-21 실제로 그렇게
      //  빨간불이 났다). 거리는 코드의 성질이 아니다.
      const closes = finallyBlocks(s).some(
        (b) =>
          b.includes('historyLoadState === "loading"') &&
          b.includes('setHistoryLoadState("ready")'),
      );
      out.push(
        assert(
          `★${label} 경로가 loading 을 올리고 finally 로 닫는다("loading" 으로 굳지 않는다)`,
          setsLoading && setsError && closes,
          `loading=${setsLoading} error=${setsError} finally닫음=${closes}`,
        ),
      );
    }

    // ★버려진 배치가 **살아 있는 배치의 상태를 닫지 않는다** (2026-08-21 적대 검토 F3).
    //  탭을 A→B 로 빠르게 누르면 A 의 fetch 가 `myToken !== switchToken` 으로 조기 return
    //  하는데, 그래도 finally 는 돌아 아직 로딩 중인 B 를 "ready" 로 닫았다 — 그 순간 B 의
    //  리스트는 비어 있으므로 화면이 다시 "아직 대화가 없습니다" 라고 단언했다. 이 배치가
    //  없애려던 바로 그 문장이다.
    {
      const closers = finallyBlocks(JS("tabs.js")).filter((b) =>
        b.includes('setHistoryLoadState("ready")'),
      );
      const guarded = closers.filter((b) => b.includes("myToken === switchToken"));
      out.push(
        assert(
          "★탭 전환 finally 는 **자기 배치일 때만** 닫는다(버려진 배치가 남의 로딩을 끝내지 않는다)",
          closers.length > 0 && guarded.length === closers.length,
          `닫는 finally ${closers.length}개 중 토큰 가드 ${guarded.length}개`,
        ),
      );
    }

    // ★첫 페인트가 **모르는 것을 단언하지 않는다** — 정적 마크업도 같은 규칙을 받는다.
    //  `#chat-empty` 는 HTML 에 보이는 상태로 박혀 있어 JS 가 돌기 전까지 그 문구가 그대로
    //  보인다. 종전엔 거기에 "아직 대화가 없습니다" 가 적혀 있어서, 느린 로드일수록 거짓말이
    //  오래 보였다(적대 검토 F2 실측: t+109ms 에 이미 단언, t+1656ms 에야 정정).
    //  ★문구를 여기 다시 적지 않고 **판정 함수에서 파생**한다 — 두 벌이면 갈린다.
    {
      const html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
      const m = /id="chat-empty"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      const initial = (m?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
      const loadingTitle = view("loading", 0).title;
      out.push(
        assert(
          "★첫 페인트(정적 마크업)가 로딩 문구다 — JS 가 돌기 전에 '없다'고 단언하지 않는다",
          initial === loadingTitle,
          `마크업="${initial}" vs 판정="${loadingTitle}"`,
        ),
      );
    }

    // 더보기(과거 페이지) 실패는 **전체 상태를 안 바꾼다** — 이미 내용이 있다.
    const hist = JS("history-render.js");
    const olderIdx = hist.indexOf("const loadOlderHistory");
    const initIdx = hist.indexOf("const loadChatHistory");
    const olderBlock = hist.slice(olderIdx, initIdx > olderIdx ? initIdx : undefined);
    out.push(
      assert(
        "★더보기(과거 페이지) 실패가 전체를 '못 불러왔다'로 만들지 않는다",
        !olderBlock.includes("setHistoryLoadState"),
        olderBlock.includes("setHistoryLoadState")
          ? "★더보기 경로가 전체 상태를 건드린다"
          : "더보기는 전체 상태 무관",
      ),
    );
    return out;
  },
};
