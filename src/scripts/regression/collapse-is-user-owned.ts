/**
 * 회귀: **접기는 사용자가 정한다 — 그리고 텍스트 드래그는 접기가 아니다** (2026-09-10 정태님).
 *
 * 세 가지가 한 묶음이다:
 *
 * ① **텍스트 드래그로 접히지 않는다.** 활동 줄·스텝 줄은 본문이 **선택 가능한 텍스트**인데
 *    클릭이 곧 토글이라, 로그를 복사하려고 끌면 끝나는 순간 줄이 접혔다. 판정은 **한 곳**
 *    (`onToggleClick`)에 둔다 — 사이트마다 쓰면 임계가 갈린다.
 * ② **접기는 턴 전체를 줄인다.** 종전엔 `.turn-card.collapsed` 가 `.turn-body`(도구 스텝)만
 *    숨겼고 답변 버블은 `.turn-group` 의 **형제**라 그대로 남았다 — 사용자 보고:
 *    *"채팅카드 안 접히는데?"* 눈에 보이는 큰 덩어리가 안 사라지면 접힌 게 아니다.
 * ③ **기본은 펼침.** 자동 접힘은 «사용자가 안 시킨 숨김» 이다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const js = (f: string): string => stripComments(readSourceSync(`packages/dashboard/js/${f}`));

export const check: RegressionCheck = {
  name: "collapse-is-user-owned",
  guards:
    "텍스트를 끌어 고르면 줄이 접히던 것 · 접기가 도구 스텝만 숨기고 답변은 남겨 «안 접힌다» 로 " +
    "보이던 것 · 사용자가 안 시켰는데 직전 턴이 자동으로 접히던 것 · **카드 아무 데나 눌러도 " +
    "접혀** 어디가 손잡이인지 알 수 없던 것(2026-09-14, 우클릭 메뉴가 그 몫을 받는다)",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const util = js("util.js");

    // ① 판정이 한 곳에 있고, 토글 자리가 전부 그걸 쓴다.
    out.push(
      assert(
        "★드래그 판정이 **한 곳**에 있다(`onToggleClick`) — 사이트마다 다시 쓰면 임계가 갈린다",
        /const onToggleClick = \(/.test(util) && /const isTextDragClick = \(/.test(util),
        `정의=${/const onToggleClick = \(/.test(util)}`,
      ),
      assert(
        "★**이 요소 안의 선택만** 본다 — 다른 데 골라 둔 게 남아 클릭이 죽으면 «왜 안 접히지» 가 된다",
        /el === node \|\| el\.contains\(node\)/.test(util),
        `범위 제한=${/el\.contains\(node\)/.test(util)}`,
      ),
    );

    // ★★**식을 떼어 실제로 돌린다** (2026-09-10). 첫 판은 «`onToggleClick` 이 정의돼 있나 ·
    //  사이트가 쓰나» 만 봤는데, 변이로 **가드 본문(`if (isTextDragClick(el)) return;`)을
    //  통째로 지워도 초록**이었다 — 래퍼 껍데기만 남으면 판정이 사라지는데 검사는 모른다.
    //  이 레포가 반복해서 데인 자리다: 게이트는 «있다» 가 아니라 «도는가»
    //  ([[feedback_gate_must_actually_run]]).
    {
      const m = /const isTextDragClick = \(el\) => \{([\s\S]*?)\n      \};/.exec(util);
      out.push(
        assert(
          "★판정 함수를 떼어낼 수 있다(없으면 아래는 공짜 초록)",
          m !== null,
          m === null ? "★못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라" : `${m[1]?.length ?? 0}자`,
        ),
      );
      if (m !== null) {
        const fn = new Function(
          "window",
          `const isTextDragClick = (el) => {${m[1] ?? ""}
}; return isTextDragClick;`,
        ) as (w: unknown) => (el: unknown) => boolean;
        /** 최소 DOM 흉내 — 선택 영역과 «이 안에 있나» 만 있으면 판정이 돈다. */
        const mkWin = (text: string, collapsed: boolean, inside: boolean, throws = false) => ({
          getSelection: () => {
            if (throws) throw new Error("보안 정책");
            return {
              isCollapsed: collapsed,
              rangeCount: 1,
              getRangeAt: () => ({ commonAncestorContainer: { __in: inside } }),
              toString: () => text,
            };
          },
        });
        const el = { contains: (n: { __in?: boolean }) => n.__in === true };
        const run = (w: unknown): boolean => fn(w)(el);
        const cases: Array<[string, unknown, boolean]> = [
          ["이 줄 안에서 끌어 골랐다", mkWin("고른 글자", false, true), true],
          ["그냥 클릭(선택 없음)", mkWin("", true, true), false],
          ["공백만 골렸다", mkWin("   ", false, true), false],
          ["다른 데 골라둔 게 남아 있다", mkWin("남의 선택", false, false), false],
          ["선택 API 가 던진다", mkWin("", false, true, true), false],
        ];
        const wrong = cases.filter(([, w, want]) => run(w) !== want);
        out.push(
          assert(
            "★★가드가 **실제로 판정한다** — 끌어 고른 뒤의 클릭만 막고, 평범한 클릭·남의 선택·API 예외엔 안 막는다",
            wrong.length === 0,
            cases.map(([l, w, want]) => `${l}=${String(run(w))}(기대 ${String(want)})`).join(" · "),
          ),
        );
      }
    }

    // ★토글 자리를 **손으로 세지 않는다** — 남은 raw 핸들러가 0인지 본다.
    // ★**파일도 패턴도 손으로 적지 않는다** (2026-09-10 적대 검토 P-4). 첫 판은 파일 셋을
    //  나열하고 `toggle("expanded")` 만 찾았다 — 그래서 `background-drawer.js` 의 토글 두 곳
    //  (`setJobOpen` · `toggleWorkerStepRich`)을 **통째로 못 봤다.** 정작 거기가 제일 아팠다:
    //  스텝 줄은 diff·출력이 붙는 자리라 «정확히 복사하고 싶은 텍스트» 다.
    //  ★목록을 없앤다 — 대시보드 js **전부**를 훑고, «접기/펼치기로 보이는 호출» 을 넓게 센다
    //  ([[feedback_hand_maintained_lists]]).
    const { readdirSync } = await import("node:fs");
    const FILES = readdirSync(new URL("../../../packages/dashboard/js/", import.meta.url))
      .filter((f) => f.endsWith(".js"));
    const TOGGLEY = /toggle\("(expanded|open|collapsed)"\)|toggleWorkerStepRich\(|setJobOpen\(/;
    const raw: string[] = [];
    for (const f of FILES) {
      const src = js(f);
      for (const m of src.matchAll(/addEventListener\("click",[\s\S]{0,200}?\)\s*;/g)) {
        if (!TOGGLEY.test(m[0])) continue;
        raw.push(`${f}:${src.slice(0, m.index ?? 0).split("\n").length}`);
      }
    }
    out.push(
      assert(
        "★★가드를 **안 거치는** 토글이 남아 있지 않다 — 한 곳만 빠져도 거기서만 드래그가 접기가 된다",
        raw.length === 0,
        raw.length === 0 ? "raw 토글 0곳" : `남음: ${raw.join(" · ")}`,
      ),
    );

    // ② ★**접기 규칙이 하나다** (2026-09-10 정태님: *"한 군데서 하는 게 아닌 건가?"*).
    //  종전엔 기제 셋 · 상태 클래스 셋(`turn-collapsed`·`bubble-collapsed`·`expanded`)이었고
    //  그중 하나는 **의미가 뒤집혀** 있었다. 그래서 접기를 고칠 때마다 한 곳만 고쳐졌다.
    const vt = js("virtualization.js");
    const css = readSourceSync("packages/dashboard/app.css");
    out.push(
      assert(
        "★★접기 클릭이 **한 곳**에서만 등록된다 — 머리줄 종류가 늘어도 셀렉터 한 줄이지 리스너가 늘지 않는다",
        /const HEADS = "\.bubble-meta, \.turn-head, \.hist-turn-head"/.test(vt) &&
          /streamRoot\.addEventListener\("click"/.test(vt),
        `HEADS=${/const HEADS = /.test(vt)} · 위임=${/streamRoot\.addEventListener/.test(vt)}`,
      ),
      assert(
        "★★상태 클래스가 **하나**다(`is-collapsed`) — 옛 세 벌이 남으면 한쪽만 고쳐진다",
        // ★**주석을 벗기고 센다** — 옛 이름은 «왜 합쳤나» 를 설명하는 글에 남아야 한다.
        //  검사 대상은 마크업이지 그걸 설명하는 글이 아니다(오늘 두 번째, 적대 검토 G-1).
        (() => {
          const cssCode = stripComments(css);
          return (
            !/turn-collapsed|bubble-collapsed/.test(vt) &&
            !/turn-collapsed|bubble-collapsed/.test(cssCode) &&
            !/\.hist-turn\.expanded/.test(cssCode)
          );
        })(),
        `js=${/turn-collapsed|bubble-collapsed/.test(vt)} · css(주석 제외)=${/turn-collapsed|bubble-collapsed|\.hist-turn\.expanded/.test(stripComments(css))}`,
      ),
      assert(
        "★★컨테이너가 `#stream` 이다 — `#chat` 은 **형제**(입력창·점프버튼)라 거기 걸면 한 번도 안 걸린다(실제로 그랬다)",
        /getElementById\("stream"\)/.test(vt) && /#stream \.is-collapsed/.test(css),
        `js=${/getElementById\("stream"\)/.test(vt)} · css=${/#stream \.is-collapsed/.test(css)}`,
      ),
      // ★**뒤집힌 판** (2026-09-14 정태님). 2026-09-10 엔 *"중간을 눌러도 접혔으면"* 이라
      //  본문 클릭도 접게 했는데, 그러면 **카드 전체가 버튼처럼** 굴어 어디를 눌러야 무엇이
      //  되는지가 사라진다(도구 카드는 머리줄만이라 둘이 서로 다르게 굴기까지 했다).
      //  그때의 필요(긴 답변은 머리줄이 화면 밖)는 **우클릭 메뉴**가 받는다 — 아래 ④.
      assert(
        "★★**머리줄에서만 접힌다** — 본문 클릭 경로가 남아 있으면 카드 전체가 버튼처럼 군다",
        !/tgt\.closest\("\.ev\.local"\)/.test(vt),
        `본문 경로=${/tgt\.closest\("\.ev\.local"\)/.test(vt) ? "남음" : "없음"}`,
      ),
      assert(
        "★★접어도 **세 줄은 남긴다** — 통째로 숨기면 «무엇이 접혔는지» 를 알 수 없어 하나씩 펴 보게 된다",
        /--collapse-lines: 3/.test(css) &&
          /max-height: calc\(1\.55em \* var\(--collapse-lines\)\)/.test(css) &&
          !/is-collapsed[^{]*\{[^}]*display:none/.test(stripComments(css)),
        `줄 수 변수=${/--collapse-lines/.test(css)} · 높이 제한=${/max-height: calc\(1\.55em/.test(css)}`,
      ),
      assert(
        "★잘린 자리가 **흐려진다** — 글자가 뚝 끊기면 «다 본 것» 처럼 읽힌다",
        /mask-image: linear-gradient\(to bottom/.test(css),
        `페이드=${/mask-image: linear-gradient/.test(css)}`,
      ),
      assert(
        "★★머리줄이 **눌러 보인다** — 누를 수 있는 자리가 거기뿐이니 셋(버블·도구·이력)이 같은 hover 를 준다",
        /#stream \.bubble-meta:hover, #stream \.turn-head:hover, #stream \.hist-turn-head:hover/.test(
          stripComments(css),
        ),
        `hover 규칙=${/\.bubble-meta:hover, #stream \.turn-head:hover/.test(stripComments(css))}`,
      ),
      assert(
        "★머리줄은 남긴다 — 다시 펼칠 손잡이가 사라지면 되돌릴 수 없다",
        /:not\(\.bubble-meta\):not\(\.turn-head\):not\(\.hist-turn-head\)/.test(css),
        `예외 규칙=${/:not\(\.bubble-meta\)/.test(css)}`,
      ),
    );

    // ★★**리스너를 떼어 실제로 돌린다** — 위 정규식은 «그 문자열이 없다» 만 본다. 본문
    //  클릭 경로를 **다른 이름으로** 되살리는 변이는 그걸 통과한다.
    {
      const from = vt.indexOf('streamRoot.addEventListener("click"');
      const open = vt.indexOf("{", vt.indexOf("(e) =>", from));
      let depth = 0, end = -1;
      for (let i = open; i < vt.length && open > 0; i++) {
        if (vt[i] === "{") depth += 1;
        else if (vt[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      const body = end > 0 ? vt.slice(open + 1, end) : "";
      out.push(
        assert(
          "★클릭 처리기를 떼어낼 수 있다(없으면 아래는 공짜 초록)",
          body.length > 0,
          body.length > 0 ? `${body.length}자` : "★못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라",
        ),
      );
      if (body.length > 0) {
        const fn = new Function(
          "HEADS", "cardRootFromHead", "isTextDragClick", "toggleCardCollapsed", "e", body,
        ) as (...a: unknown[]) => void;
        const HEADS = ".bubble-meta, .turn-head, .hist-turn-head";
        /** 최소 DOM — `closest(sel)` 가 무엇을 돌려주냐로 «어디를 눌렀나» 를 흉내 낸다.
         *  ★기본값이 **«조상이 있다»** 다(빈 객체). 그래야 본문 클릭 경로를 **다른 셀렉터로**
         *   되살리는 변이도 잡힌다 — 기본을 null 로 두면 무엇을 찾든 못 찾아 조용히 통과한다. */
        const node = (hits: Record<string, unknown>) => ({
          closest: (sel: string) => (sel in hits ? hits[sel] : {}),
        });
        const head = { __head: true };
        const root = { __root: true };
        const run = (tgt: unknown): boolean => {
          let toggled = false;
          fn(
            HEADS,
            () => root,
            () => false,
            () => { toggled = true; return true; },
            { target: tgt },
          );
          return toggled;
        };
        const cases: Array<[string, unknown, boolean]> = [
          ["머리줄을 눌렀다", node({ [HEADS]: head, "button, a, input, select, textarea": null }), true],
          // ★«머리줄만 아니면 전부 조상이 있다» — 어떤 셀렉터로 되살려도 여기서 걸린다.
          ["본문 한가운데를 눌렀다", node({ [HEADS]: null, "button, a, input, select, textarea": null }), false],
          ["도구 스텝 줄을 눌렀다", node({ [HEADS]: null, "button, a, input, select, textarea": null }), false],
          ["머리줄 안의 버튼을 눌렀다", node({ [HEADS]: head }), false],
        ];
        const wrong = cases.filter(([, tgt, want]) => run(tgt) !== want);
        out.push(
          assert(
            "★★처리기가 **실제로 머리줄만** 접는다 — 본문·스텝·버튼 클릭은 아무 일도 하지 않는다",
            wrong.length === 0,
            cases.map(([l, t, w]) => `${l}=${String(run(t))}(기대 ${String(w)})`).join(" · "),
          ),
        );
      }
    }

    // ④ ★**우클릭 메뉴가 접기/펴기를 준다** (2026-09-14) — 머리줄만 누르게 바꾸면서 «긴
    //  답변은 머리줄이 화면 밖» 이 다시 문제가 되는데, 그 필요를 여기가 받는다.
    {
      const reply = js("reply.js");
      out.push(
        assert(
          "★접기 판정이 **한 곳**으로 간다 — 메뉴가 classList 를 직접 만지면 기제가 두 벌이 된다",
          /toggleCardCollapsed\(ctx\.el\)/.test(reply) &&
            !/is-collapsed/.test(reply),
          `위임=${/toggleCardCollapsed\(/.test(reply)} · 직접조작=${/is-collapsed/.test(reply)}`,
        ),
        assert(
          "★메뉴가 겨눌 **카드 뿌리**를 ctx 에 싣는다 — 없으면 무엇을 접을지 알 수 없다",
          /el: host,/.test(reply),
          `ctx.el=${/el: host,/.test(reply)}`,
        ),
      );
      const from = reply.indexOf('registerMenuItems("message"');
      const open = reply.indexOf("{", reply.indexOf("(ctx) =>", from));
      let depth = 0, end = -1;
      for (let i = open; i < reply.length && open > 0; i++) {
        if (reply[i] === "{") depth += 1;
        else if (reply[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      const body = end > 0 ? reply.slice(open + 1, end) : "";
      out.push(
        assert(
          "★메뉴 provider 를 떼어낼 수 있다(없으면 아래는 공짜 초록)",
          body.length > 0,
          body.length > 0 ? `${body.length}자` : "★못 찾음",
        ),
      );
      if (body.length > 0) {
        const fn = new Function("i18n", "cardCollapseHead", "isCardCollapsed", "ctx", body) as (
          ...a: unknown[]
        ) => Array<{ id: string; label: string }>;
        const i18n = (k: string): string => k;
        const items = (hasHead: boolean, collapsed: boolean) =>
          fn(i18n, () => (hasHead ? {} : null), () => collapsed, { el: {} });
        const opened = items(true, false);
        const closed = items(true, true);
        const noHead = items(false, false);
        out.push(
          assert(
            "★★펼쳐져 있으면 «접기», 접혀 있으면 «펴기» — 라벨이 상태를 따라간다",
            opened.some((i) => i.id === "collapse" && i.label === "ctx.collapse") &&
              closed.some((i) => i.id === "collapse" && i.label === "ctx.expand"),
            `펼침=${opened.find((i) => i.id === "collapse")?.label ?? "없음"} · 접힘=${closed.find((i) => i.id === "collapse")?.label ?? "없음"}`,
          ),
          assert(
            "★머리줄이 없는 카드엔 **항목을 안 낸다** — 접으면 되돌릴 손잡이가 없다",
            !noHead.some((i) => i.id === "collapse"),
            `항목 ${noHead.length}개`,
          ),
        );
      }
    }

    // ③ 기본 펼침 — 자동 접힘 0
    out.push(
      assert(
        "★★직전 턴을 **자동으로 접지 않는다** — 사용자가 안 시킨 숨김이다",
        !/classList\.add\("done-collapsed"\)/.test(js("token-delta.js")),
        `자동접힘 호출=${(js("token-delta.js").match(/done-collapsed/g) ?? []).length}건`,
      ),
      assert(
        "★새로고침 후 이력 턴도 **펼친 채** 시작한다 — 이제 «보임» 이 기본이고 숨김만 클래스로 한다(옛 `.expanded` 는 반대였다)",
        !/classList\.add\("expanded"\)/.test(js("history-render.js")) &&
          /\.hist-turn-body \{ padding/.test(readSourceSync("packages/dashboard/app.css")),
        `opt-in 숨김=${!/classList\.add\("expanded"\)/.test(js("history-render.js"))}`,
      ),
    );

    return out;
  },
};
