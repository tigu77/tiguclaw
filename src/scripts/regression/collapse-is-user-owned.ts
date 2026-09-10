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
    "보이던 것 · 사용자가 안 시켰는데 직전 턴이 자동으로 접히던 것",
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
    const FILES = ["activity.js", "history-render.js", "virtualization.js"];
    const raw: string[] = [];
    for (const f of FILES) {
      const src = js(f);
      // `classList.toggle("expanded")` 를 하는 raw click 리스너가 남아 있나.
      for (const m of src.matchAll(/addEventListener\("click",[\s\S]{0,160}?toggle\("expanded"\)/g)) {
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

    // ② 접기 범위 — 답변 버블까지
    const vt = js("virtualization.js");
    const css = readSourceSync("packages/dashboard/app.css");
    out.push(
      assert(
        "★★접기가 **턴 전체**를 줄인다 — 카드 밖 형제(답변 버블)도 숨긴다. 안 그러면 «접었는데 그대로» 다",
        /group\.classList\.toggle\("turn-collapsed", !open\)/.test(vt) &&
          /\.turn-group\.turn-collapsed > \*:not\(\.turn-card\)/.test(css),
        `JS=${/turn-collapsed/.test(vt)} · CSS=${/\.turn-group\.turn-collapsed/.test(css)}`,
      ),
      assert(
        "★헤더(`.turn-card`)는 남긴다 — 다시 펼칠 손잡이가 사라지면 되돌릴 수 없다",
        /:not\(\.turn-card\)/.test(css),
        `예외 규칙=${/:not\(\.turn-card\)/.test(css)}`,
      ),
    );

    // ③ 기본 펼침 — 자동 접힘 0
    out.push(
      assert(
        "★★직전 턴을 **자동으로 접지 않는다** — 사용자가 안 시킨 숨김이다",
        !/classList\.add\("done-collapsed"\)/.test(js("token-delta.js")),
        `자동접힘 호출=${(js("token-delta.js").match(/done-collapsed/g) ?? []).length}건`,
      ),
      assert(
        "★새로고침 후 이력 턴도 **펼친 채** 시작한다 — 접힌 채로 뜨면 «있던 게 사라진» 것처럼 보인다",
        /turn\.classList\.add\("expanded"\)/.test(js("history-render.js")),
        `기본 expanded=${/turn\.classList\.add\("expanded"\)/.test(js("history-render.js"))}`,
      ),
    );

    return out;
  },
};
