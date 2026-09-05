/**
 * 회귀: **작업 중엔 전송 버튼이 정지가 된다 — 단, 칠 말이 없을 때만** (2026-09-05 사용자 요청).
 *
 * 배경: 턴을 끊는 능력은 진작 있었다(`/stop` — 그 스레드의 진행 중 턴을 프로세스 안 죽이고
 * abort, 세 어댑터에 `abortSignal` 관통). 없던 건 **손잡이**다. 잡 카드엔 중지 버튼이
 * 있었는데 정작 «내가 보고 있는 턴» 에만 없어서, 끊으려면 턴이 도는 중에 슬래시를 타이핑해야
 * 했다(모바일에선 가장 어려운 순간).
 *
 * ★이 검사가 진짜로 지키는 것은 **정지가 전송을 잡아먹지 않는 것**이다. 이 대시보드는 턴이
 *  도는 중에도 전송이 열려 있고(돌고 있는 턴에 말을 얹는 mid-turn steering), «작업 중이면
 *  정지» 로 만들면 그 기능이 버튼에서 **조용히 사라진다.** 그래서 판정은 «작업 중 + 칠 말
 *  없음» 이고, 아래 ④가 그 변이를 잡는다.
 *
 * ★그리고 **이름이 갈리는 것**을 잡는다: 버튼이 보내는 문자열과 데몬이 아웃오브밴드로 알아듣는
 *  문자열은 같아야 한다. `/stop` 이 `/cancel` 로 바뀌면 버튼은 멀쩡히 눌리는데 아무 일도 안
 *  일어난다(그리고 «중지 요청…» 이 영영 안 풀린다). 두 파일에 나뉜 계약이라 여기서 잇는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

/** `const <name> = (` 부터 짝 맞는 `)` 로 끝나는 한 줄 화살표 함수까지. */
const sliceArrow = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  const end = src.indexOf(";\n", start);
  return end < 0 ? null : `${src.slice(start, end + 1)}`;
};

export const check: RegressionCheck = {
  name: "composer-stop-button",
  guards:
    "진행 중 턴을 끊으려면 `/stop` 을 타이핑해야만 하던 것 + 그 버튼을 다는 순간 턴 중에 말 거는 기능(steering)이 버튼에서 사라지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let axis: string;
    let send: string;
    let index: string;
    try {
      axis = read("packages/dashboard/js/axis1-options.js");
      send = read("packages/dashboard/js/chat-send.js");
      index = read("src/index.ts");
    } catch {
      return [assert("대시보드 소스 없음(배포 레포 아님)", true, "건너뜀")];
    }

    // ── ① 판정이 순수 함수다(렌더 안이면 브라우저를 띄워야만 확인된다) ─────────
    const fn = sliceArrow(axis, "composerAction");
    out.push(
      assert(
        "★버튼 모드 판정이 순수 함수다(composerAction)",
        fn !== null,
        fn === null ? "★composerAction 없음" : `${fn.length}자`,
      ),
    );
    if (fn === null) return out;
    const action = new Function(`${fn}return composerAction;`)() as (
      v: { mineActive?: boolean; hasDraft?: boolean },
    ) => string;

    // ── ②③④ 진리표 ────────────────────────────────────────────────────────
    out.push(
      assert(
        "놀고 있으면 전송이다(칠 말이 있든 없든)",
        action({ mineActive: false, hasDraft: false }) === "send" &&
          action({ mineActive: false, hasDraft: true }) === "send",
        `빈입력=${action({ mineActive: false, hasDraft: false })} · 입력있음=${action({ mineActive: false, hasDraft: true })}`,
      ),
    );
    out.push(
      assert(
        "★내 턴이 돌고 입력창이 비어 있으면 정지다 — 이게 없던 손잡이다",
        action({ mineActive: true, hasDraft: false }) === "stop",
        `${action({ mineActive: true, hasDraft: false })}`,
      ),
    );
    out.push(
      assert(
        "★★턴이 도는 중에도 **칠 말이 있으면 전송**이다 — 정지가 steering 을 잡아먹지 않는다",
        action({ mineActive: true, hasDraft: true }) === "send",
        action({ mineActive: true, hasDraft: true }) === "send"
          ? "send(=돌고 있는 턴에 말을 얹는 길이 살아 있다)"
          : "★stop — 작업 중엔 말을 못 걸게 됐다(기능이 버튼에서 사라졌다)",
      ),
    );

    // ── ⑤ 배선: 버튼이 보내는 문자열 == 데몬이 알아듣는 문자열 ─────────────────
    const sendsStop = /sendChatMessage\(\s*"\/stop"/.test(send);
    const daemonKnows = /msg\.text\.trim\(\)\s*===\s*"\/stop"/.test(index);
    out.push(
      assert(
        "★버튼이 보내는 `/stop` 을 데몬이 아웃오브밴드로 알아듣는다(두 파일에 나뉜 계약)",
        sendsStop && daemonKnows,
        `버튼=${sendsStop ? "/stop 전송" : "★안 보냄"} · 데몬=${daemonKnows ? "/stop 처리" : "★이름 갈림"}`,
      ),
    );

    // ── ⑥ 배선: 누르는 쪽은 **칠해진 모드**를 읽는다(보이는 것과 하는 것이 같다) ─
    out.push(
      assert(
        "정지 분기가 버튼에 칠해진 모드(dataset.mode)를 근거로 갈린다 — 판정이 두 벌이 되지 않게",
        /sendBtn\.dataset\.mode === "stop"/.test(send),
        /sendBtn\.dataset\.mode === "stop"/.test(send) ? "dataset.mode 기준" : "★별도 조건으로 갈림",
      ),
    );

    // ── ⑦ 배선: 진행 상태가 바뀌면 버튼도 다시 칠해진다 ────────────────────────
    const refresh = axis.slice(axis.indexOf("const refreshWorking = ("));
    out.push(
      assert(
        "진행 표시 갱신이 버튼도 같이 칠한다(배너와 버튼이 같은 사실을 읽는다)",
        /paintComposerButton\(\)/.test(refresh.slice(0, 400)),
        /paintComposerButton\(\)/.test(refresh.slice(0, 400)) ? "refreshWorking 안에서 호출" : "★턴이 끝나도 버튼이 정지로 남는다",
      ),
    );

    // ── ⑧ ★버튼이 아랫줄로 내려가지 않는다 (2026-09-05 사용자 신고) ───────────
    //  실측 375px: 44+44+44+112(모델선택)+75(버튼)+간격32 = **351 = 폼 폭과 정확히 같다.**
    //  여유가 0이라 라벨이 몇 px만 넓어지면(실기기 이모지 폭·긴 프로파일 이름·큰 글꼴)
    //  버튼이 감긴다 — 정지 라벨이 전송보다 넓어서 그 순간 드러났다.
    //  ★고침은 버튼을 좁히는 게 아니다(다음 라벨에서 또 넘친다). **줄어드는 칸을 하나**
    //   두는 것이고, 그 기준 폭은 **0** 이어야 한다 — 줄바꿈은 «줄이기 전에» 결정되므로
    //   기준이 72px 만 돼도 320px 화면에서 다시 감겼다(그 변이를 실제로 봤다).
    const css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const flexible = /#chat-form \.chat-model-select \{[^}]*flex:\s*1 1 0[^}]*min-width:\s*0/.test(css);
    out.push(
      assert(
        "★컴포저 한 줄에 **줄어드는 칸**이 있다(모델 선택, 기준 폭 0)",
        flexible,
        flexible ? "flex:1 1 0 · min-width:0" : "★없음 — 라벨이 조금만 넓어지면 버튼이 아랫줄로 간다",
      ),
    );
    const fixedBtn = /#chat-form #chat-send \{[^}]*flex:\s*none/.test(css);
    out.push(
      assert(
        "전송·정지 버튼은 안 줄어든다(줄어들면 «정 지» 처럼 접힌다)",
        fixedBtn,
        fixedBtn ? "flex:none" : "★버튼이 줄어들 수 있다",
      ),
    );

    // ── ⑨ 정지는 **아이콘 하나** — 폭이 고정이라 어느 화면에서도 옆 칸을 안 민다 ──
    //  처음엔 «좁은 화면에서만 낱말을 접는» 분기를 뒀다가, 기본을 작게 두어 분기를 없앴다
    //  (사용자 지정). 라벨이 없으면 폭이 변하지 않고, 폭이 안 변하면 오늘 고친 그 병
    //  (라벨이 넓어져 버튼이 아랫줄로 감김)이 **원리적으로** 안 생긴다.
    out.push(
      assert(
        "★정지 버튼은 아이콘만 그린다(라벨 폭이 변하면 옆 칸이 다시 밀린다)",
        /icon\.className = "cb-icon"/.test(axis) && !/cb-word/.test(axis),
        /cb-word/.test(axis) ? "★낱말 조각이 남아 있다" : "아이콘 1개",
      ),
    );
    out.push(
      assert(
        "★뜻은 title·aria-label 이 지킨다(모양만 줄이고 의미는 안 줄인다)",
        /btn\.title = label/.test(axis) && /setAttribute\("aria-label", label\)/.test(axis),
        `title=${/btn\.title = label/.test(axis)} · aria-label=${/setAttribute\("aria-label", label\)/.test(axis)}`,
      ),
    );
    out.push(
      assert(
        "«중지 요청» 은 글자가 아니라 흐림으로 말한다(라벨이 바뀌면 폭이 바뀐다)",
        /#chat-send\.stop\[data-stopping="1"\] \{ opacity/.test(css),
        /data-stopping="1"\] \{ opacity/.test(css) ? "흐림 처리" : "★라벨 교체(폭 변동)",
      ),
    );

    return out;
  },
};
export default check;
