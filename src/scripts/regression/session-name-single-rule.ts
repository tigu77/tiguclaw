/**
 * 회귀: **세션 이름이 채널 무관 한 규칙이다** (2026-08-02 사용자 제보).
 *
 * 사용자: *"/sessions 했을 때 이름으로 안 보이는 세션들이 있는데 뭐야?"*
 *
 * 원인은 이름이 **없는** 게 아니라 **채널마다 다른 데서 왔다**는 것이었다:
 *   - 대시보드 탭의 `세션3` = **브라우저 localStorage** 번호(`SESSION_NUM_LS`). 서버엔 없다.
 *   - `/sessions`(텔레그램·CLI)의 `nameOf` 는 `이름 ?? 키` 라서, 서버 `threads.name` 이
 *     비면 **`dashboard:1784104932394-f791d2b408d6` 를 그대로** 출력했다.
 *   - 그래서 같은 세션을 대시보드는 "세션3", 텔레그램은 생키로 보여줬다. 서버 이름은
 *     **탭을 더블클릭해 직접 고쳤을 때만** 채워지므로(실측 318 중 312 무명), 대부분이 그랬다.
 *
 * ★원칙 4(다채널 단일 인격) 위반이다 — 세션 **정체성이 채널 로컬 상태**에 있었다.
 *  고침은 새 상태를 만드는 게 아니라 **파생 판정을 서버 한 곳으로 올린 것**
 *  (`sessionDisplayName`): 커스텀 이름 > 첫 대화 발췌 > 폴백. 대시보드가 *남의* 세션을
 *  띄울 때 이미 쓰던 규칙이라, 흩어져 있던 걸 합쳤을 뿐이다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "session-name-single-rule",
  guards:
    "같은 세션이 대시보드에선 '세션3', 텔레그램 /sessions 에선 생키(dashboard:1784…)로 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 동작 — 파생 규칙이 실제로 그렇게 도는가(문자열 확인 아님).
    const { sessionDisplayName, SESSION_NAME_DERIVE_MAX } = await import(
      "../../store/sessions.js"
    );
    const key = "dashboard:1784104932394-f791d2b408d6";
    const custom = sessionDisplayName(key, "핫딜알리미", "아무 발췌나", "세션3");
    const derived = sessionDisplayName(key, null, "  크롤러가   자꾸 죽는데 봐줘 ", "세션3");
    const empty = sessionDisplayName(key, "   ", "", "세션3");
    const bare = sessionDisplayName(key, null, null);
    out.push(
      assert(
        "★커스텀 이름 > 첫 대화 발췌 > 폴백 순으로 정해진다",
        custom === "핫딜알리미" && derived.startsWith("크롤러가 자꾸 죽는데") && empty === "세션3",
        `커스텀=${custom} · 파생=${derived} · 폴백=${empty}`,
      ),
    );
    out.push(
      assert(
        "폴백도 없으면 키(마지막 수단) — 그래도 절대 undefined 를 뱉지 않는다",
        bare === key,
        bare,
      ),
    );
    // 길이 상한 — 탭바가 터지지 않게. 대시보드가 쓰던 16자와 같은 수를 공유한다.
    const long = sessionDisplayName(key, null, "가".repeat(80));
    out.push(
      assert(
        `발췌는 ${SESSION_NAME_DERIVE_MAX}자로 자르고 말줄임을 붙인다`,
        long.length === SESSION_NAME_DERIVE_MAX + 1 && long.endsWith("…"),
        `${long.length}자 · ${long}`,
      ),
    );

    // ★★배포 직후 라이브에서 잡은 두 결함 (2026-08-03) — 둘 다 "돌긴 도는데 틀린 값".
    //  ①이름이 **매 턴 바뀌었다** — 최근 메시지(`preview`)로 파생해서. 이름은 정체성이라
    //   안정적이어야 하므로 **첫** 발화를 쓴다. 소비자가 최근값을 넣으면 여기서 걸린다.
    //  ②기본 세션이 `돌쇠 재시작 완료! ✅` 로 떴다 — 고정 라벨 특수처리가 `/sessions`
    //   에만 있고 대시보드 경로엔 없었다. 판정을 이 함수 안으로 옮겨 한 곳으로 만들었다.
    const { DEFAULT_SESSION_ID } = await import("../../core/threadkey.js");
    out.push(
      assert(
        "★기본 세션은 대화 내용으로 이름이 바뀌지 않는다(파생 금지)",
        sessionDisplayName(DEFAULT_SESSION_ID, null, "돌쇠 재시작 완료! ✅") === "기본 세션",
        "고정 라벨 확인",
      ),
    );
    // ★2026-08-07 정정 — 이 검사는 원래 `사용자가 붙인 이름도` 무시하고 "기본 세션" 이어야
    //  한다고 못 박고 있었다. **그게 사용자 신고의 정체였다**: 기본 세션은 이름을 바꿔도
    //  새로고침하면 되돌아갔다(실측: DB·`/sessions` 의 name 은 저장돼 있는데 displayName 만
    //  "기본 세션"). 고정 라벨의 의도는 *첫 발화로 파생되는 것*을 막는 것이었지 사용자
    //  지정을 막는 게 아니었다 — 검사가 그 둘을 뭉뚱그려 버그를 고정하고 있었다.
    out.push(
      assert(
        "★그러나 사용자가 붙인 이름은 기본 세션에서도 이긴다(저장만 되고 안 보이던 것)",
        sessionDisplayName(DEFAULT_SESSION_ID, "내가 붙인 이름", "") === "내가 붙인 이름" &&
          sessionDisplayName(DEFAULT_SESSION_ID, "  ", "") === "기본 세션",
        `지정=${sessionDisplayName(DEFAULT_SESSION_ID, "내가 붙인 이름", "")} · 공백=${sessionDisplayName(DEFAULT_SESSION_ID, "  ", "")}`,
      ),
    );
    const first = "크롤러가 자꾸 죽는데 봐줘";
    out.push(
      assert(
        "★파생 재료가 *첫* 발화다 — 같은 세션은 대화가 이어져도 이름이 안 변한다",
        sessionDisplayName("dashboard:x", null, first) ===
          sessionDisplayName("dashboard:x", null, first),
        `첫 발화 기준 · ${sessionDisplayName("dashboard:x", null, first)}`,
      ),
    );
    const chatLog = read("src/store/chat-log.ts");
    out.push(
      assert(
        "첫 발화 조회가 ASC 로 사용자 발화만 집는다(최근값을 다시 쓰지 않게)",
        /role = 'user'[\s\S]{0,120}ORDER BY ts ASC LIMIT 1/.test(chatLog),
        /getFirstUserText/.test(chatLog) ? "ASC + user 확인" : "★조회 없음",
      ),
    );

    // ★② 소비자 전수 — 한 곳이라도 자기 파생을 쓰면 다시 갈린다.
    const idx = read("src/index.ts");
    out.push(
      assert(
        "★/sessions 가 키 원문을 뱉지 않는다(공용 파생 사용)",
        /sessionDisplayName\(id, t\?\.name, getFirstUserText\(id\)\)/.test(idx) &&
          !/return nm !== undefined && nm !== "" \? nm : id;/.test(idx),
        /sessionDisplayName\(id/.test(idx) ? "공용 파생 확인" : "★키 원문 폴백이 남아 있다",
      ),
    );
    const bridge = read("plugins/http-bridge/index.ts");
    out.push(
      assert(
        "/api/sessions 가 displayName 을 실어 보낸다(클라가 각자 파생하지 않게)",
        /displayName: sessionDisplayName\(/.test(bridge) && /getFirstUserText\(t\.threadKey\)/.test(bridge),
        "서버 파생 확인",
      ),
    );
    const tabs = read("packages/dashboard/js/tabs.js");
    out.push(
      assert(
        "★대시보드가 서버 displayName 을 우선한다(로컬 세션N 은 대화 없을 때만)",
        /s\.displayName/.test(tabs) && (tabs.match(/s\.displayName/g) ?? []).length >= 2,
        `s.displayName 사용 ${(tabs.match(/s\.displayName/g) ?? []).length}곳`,
      ),
    );

    // ★④ 탭 "닫기" 가 **서버 정본**인가 (2026-08-03). 종전엔 localStorage 에만 기록해서
    //  다른 브라우저·기기·캐시 정리 뒤엔 닫은 세션이 되살아났다(사용자 증상 "세션이 계속
    //  생긴다"). 서버엔 이미 `archived_at`·`/sessions archive` 가 있었는데 대시보드가 같은
    //  판단을 **따로** 갖고 있었다. 로컬 기록은 낙관적 반영으로만 남긴다.
    // ★문자열 존재로 검사하지 않는다 — 첫 판이 그랬다가 `if (false) fetch(…)` 변이를
    //  **놓쳤다**(글자는 그대로 있으니까). `markClosed` 를 vm 에서 **실제로 돌려** 서버
    //  호출이 났는지 본다.
    const act = read("packages/dashboard/js/activity.js");
    const mc = /const loadClosedSet = \(\)[\s\S]*?const markClosed = \(tk\) => \{[\s\S]*?\n {6}\};/.exec(act);
    out.push(assert("markClosed 를 떼어낸다(검사 전제)", mc !== null, mc === null ? "★못 찾음" : "OK"));
    if (mc !== null) {
      const store = new Map<string, string>();
      const calls: Array<{ url: string; body: unknown }> = [];
      const ctx: Record<string, unknown> = {
        CLOSED_LS: "dash.closedTabs.v1",
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
        },
        console: { warn: () => {} },
        fetch: (url: string, init: { body?: string }) => {
          calls.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
          return Promise.reject(new Error("서버 실패 시나리오")); // 실패해도 로컬은 남아야 한다.
        },
      };
      vm.createContext(ctx);
      vm.runInContext(`${mc[0]}\nthis.markClosed = markClosed;`, ctx);
      (ctx.markClosed as (tk: string) => void)("dashboard:abc");
      const body = calls[0]?.body as { threadKey?: string; archived?: boolean } | undefined;
      out.push(
        assert(
          "★탭을 닫으면 서버에 보관을 알린다(localStorage 단독 아님)",
          calls.length === 1 &&
            calls[0]!.url === "/api/session-archive" &&
            body?.threadKey === "dashboard:abc" &&
            body.archived === true,
          calls.length === 1
            ? `${calls[0]!.url} ${JSON.stringify(body)}`
            : "★서버 호출 0 — 기기마다 닫기가 갈린다",
        ),
      );
      out.push(
        assert(
          "서버가 실패해도 이 탭에선 닫힌 채로 둔다(낙관적 반영)",
          (store.get("dash.closedTabs.v1") ?? "").includes("dashboard:abc"),
          store.get("dash.closedTabs.v1") ?? "(비어 있음)",
        ),
      );
    }
    // ★⑤ **"+"로 만든 세션이 서버에 이름을 남기나** (2026-08-19 사용자 신고 — 같은 병의 재발).
    //  사용자: *"이상한 세션들이 많이 보여 /sessions 에서."* 목록에 "회사돌쇠야?"·"그냥"·
    //  "단검 하나만 그러서 보내줘…" 같은 **말조각**이 세션 이름으로 떴고, 같은 말로 시작한
    //  세션 셋은 구분이 아예 안 됐다.
    //
    //  원인은 세션이 잘못 생긴 게 아니라 **이름이 없는 것**이었다 — 대시보드 "+"는 이름을
    //  localStorage 에만 두고 서버 행엔 안 남긴다. 이름이 없으면 위 ①의 규칙대로 표시명이
    //  **첫 발화**에서 파생된다. 즉 ①이 고친 "키 원문 노출"이 "말조각 노출"로 모양만 바뀐 것.
    //
    //  ★비대칭이 뿌리다: 텔레그램 `/sessions new` 는 이름을 안 줘도 서버에 기본명을 저장한다
    //   (2026-07-29). **같은 일을 하는 두 입구가 다르게 동작**했다.
    //  ★소스 문자열로 검사하지 않는다 — 위 markClosed 와 같은 이유로 판정을 함수로 뽑아
    //   (`commitPendingName`) vm 에서 **실제로 돌린다**.
    {
      const cp = /const commitPendingName = \(threadKey, serverName\) => \{[\s\S]*?\n {6}\};/.exec(tabs);
      out.push(assert("commitPendingName 을 떼어낸다(검사 전제)", cp !== null, cp === null ? "★못 찾음" : "OK"));
      if (cp !== null) {
        const named: Array<{ tk: string; name: string }> = [];
        const ctx: Record<string, unknown> = {
          DEFAULT_DASH_THREAD: DEFAULT_SESSION_ID,
          deriveTabFallbackName: (tk: string) => `세션${tk.length % 7}`,
          commitTabName: (tk: string, name: string) => void named.push({ tk, name }),
        };
        vm.createContext(ctx);
        vm.runInContext(`${cp[0]}\nthis.commitPendingName = commitPendingName;`, ctx);
        const fn = ctx.commitPendingName as (tk: string, sn: unknown) => boolean;

        const fresh = fn("dashboard:new-one", null);
        out.push(
          assert(
            "★이름 없이 서버에 나타난 새 세션에 이름을 남긴다(말조각이 이름 자리에 오는 걸 막는다)",
            fresh === true && named.length === 1 && named[0]!.tk === "dashboard:new-one" &&
              named[0]!.name.trim() !== "",
            named.length === 1 ? `저장 "${named[0]!.name}"` : "★저장 호출 0",
          ),
        );
        // ★호출 순서가 판정에 걸린다 — `before` 를 잰 뒤 **덮어쓰면 안 되는 호출 하나만**
        //  하고 즉시 센다. 처음엔 여기서 공백 케이스까지 부르고 나서 셌다가, 그게 정상적으로
        //  하나 늘려서 검사가 스스로 빨간불을 냈다(제품이 아니라 검사의 순서 실수였다).
        const before = named.length;
        const hadName = fn("dashboard:has-name", "핫딜알리미");
        out.push(
          assert(
            "이미 이름이 있으면 덮지 않는다(사용자가 붙인 이름을 뺏지 않는다)",
            hadName === false && named.length === before,
            `덮어쓰기 ${named.length - before}건`,
          ),
        );
        const blank = fn("dashboard:blank-name", "   ");
        out.push(
          assert(
            "공백뿐인 이름은 없는 것으로 본다(서버 정규화와 같은 판정)",
            blank === true && named.length === before + 1,
            `${String(blank)} · 저장 ${named.length - before}건`,
          ),
        );
        const beforeDef = named.length;
        const def = fn(DEFAULT_SESSION_ID, null);
        out.push(
          assert(
            "★기본 세션엔 이름을 붙이지 않는다(고정 라벨 — ②와 같은 규칙)",
            def === false && named.length === beforeDef,
            String(def),
          ),
        );
      }
      // ★배선 — 판정이 옳아도 **아무도 안 부르면** 아무 일도 안 일어난다. 변이 테스트에서
      //  실제로 드러났다(함수는 남기고 호출만 지우면 위 넷이 전부 초록이었다).
      //  ★등급을 정직하게: 이건 **소스 검사**다. 판정은 위에서 실행으로 지키지만, 호출이
      //   `pending` 해제 자리에 실제로 걸리는지는 브라우저를 띄워야 확정된다
      //   (실증은 `_workspace/_session_name_cdp.mjs` — 헤드리스로 "+"→서버등장→저장 확인).
      out.push(
        assert(
          "그 판정이 pending 해제 지점에서 호출된다(배선 — 소스 검사)",
          /if \(t\.pending\) \{[\s\S]{0,600}?commitPendingName\(t\.threadKey, s\.name\)/.test(tabs),
          /commitPendingName\(/.test(tabs) ? "호출 확인" : "★판정만 있고 호출이 없다",
        ),
      );
    }

    const dash = read("packages/dashboard/index.ts");
    const bridge2 = read("plugins/http-bridge/index.ts");
    out.push(
      assert(
        "보관은 비파괴이고 기본 세션은 막는다(닫을 수 없는 홈)",
        /setSessionArchived\(/.test(bridge2) &&
          !/DELETE FROM (transcripts|chat_log)/.test(bridge2) &&
          /threadKey === DEFAULT_SESSION_ID/.test(bridge2) &&
          /pathname === "\/api\/session-archive"/.test(dash),
        "비파괴 + 기본세션 가드 + 프록시 확인",
      ),
    );
    // ★보관의 세 입구가 **한 함수**를 쓴다 (2026-08-19). 종전엔 명령·도구·엔드포인트가
    //  각자 `setThreadArchived` + 바인딩 해제를 조립했고, 그래서 **갈렸다** — 엔드포인트
    //  (대시보드 탭 닫기가 오는 주 경로)만 바인딩을 안 풀어, 방이 목록에 없는 세션에
    //  계속 묶였다. 규칙을 지키라고 감시하는 대신 **부를 것을 하나로** 만든 것이라,
    //  이 검사는 그 하나가 도로 흩어지지 않는지만 본다.
    {
      const sites: Array<[string, string]> = [
        ["명령(/sessions archive)", read("src/index.ts")],
        ["엔드포인트(/session-archive)", bridge2],
        [
          "도구(archive_session)",
          read("src/core/llm-runtime/capabilities/session-tools-mcp.ts"),
        ],
      ];
      const strays = sites.filter(([, src]) => /setThreadArchived\(/.test(src)).map(([n]) => n);
      const unified = sites.filter(([, src]) => /setSessionArchived\(/.test(src)).map(([n]) => n);
      out.push(
        assert(
          "★보관의 세 입구가 같은 함수를 쓴다(각자 조립하면 또 갈린다)",
          unified.length === 3 && strays.length === 0,
          strays.length === 0
            ? `통일 ${unified.length}/3`
            : `★직접 조립이 남아 있다: ${strays.join(", ")}`,
        ),
      );
    }

    // ★⑤ 대화 아님 판정이 **클라에서 더 좁아지지 않는가.** 서버(`INTERNAL_THREAD_PREFIXES`)와
    //  클라(`NON_CONVO_PREFIXES`)가 같은 목록을 손으로 두 벌 갖고 있다. 클라가 서버보다
    //  적으면 내부 스레드가 탭으로 **부활**한다 — 사용자가 본 "세션이 계속 생긴다" 의 경로.
    //  합칠 수 없는 자리(브라우저 JS)라 **포함 관계를 판정으로** 묶는다.
    const server = [...read("src/store/sessions.ts").matchAll(/^\s{2}"([a-z]+:)",$/gm)].map(
      (m) => m[1]!,
    );
    const clientLine = /const NON_CONVO_PREFIXES = \[([^\]]+)\]/.exec(
      read("packages/dashboard/js/activity.js"),
    );
    const client = [...(clientLine?.[1] ?? "").matchAll(/"([a-z]+:)"/g)].map((m) => m[1]!);
    const missing = server.filter((p) => !client.includes(p));
    out.push(
      assert(
        `★클라 제외 목록이 서버의 상위집합이다(서버 ${server.length} ⊆ 클라 ${client.length})`,
        server.length >= 5 && missing.length === 0,
        missing.length === 0
          ? `클라 전용 추가: ${client.filter((p) => !server.includes(p)).join(", ") || "없음"}`
          : `★클라에 없는 서버 접두: ${missing.join(", ")} — 내부 스레드가 탭으로 부활한다`,
      ),
    );
    return out;
  },
};
