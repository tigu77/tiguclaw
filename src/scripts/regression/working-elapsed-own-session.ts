/**
 * 회귀: **입력창 위 경과시간은 이 대화의 것만** (2026-08-06 사용자 지적에서 출발한 실측).
 *
 * 종전 `earliestStart()` 는 내 세션에 진행 턴이 없으면 **가장 이른 턴**으로 폴백했다. 그래서
 * 내 대화는 놀고 있는데 다른 세션(또는 텔레그램·CLI)의 턴이 돌면 **남의 경과시간이 내 화면
 * 입력창 바로 위에 떴다.** 그 자리는 누구나 "내 요청이 N분째" 로 읽는 자리다.
 *
 * ★부류: **모르는 값을 그럴듯한 값으로 메운 것**. 이 레포에서 반복된 병이다(없는 채널 배지를
 *  지어내던 것과 같다 — 25e461d). 다른 세션이 도는 사실은 그 세션 탭의 진행 점이 이미
 *  알려주므로, 여기서 숫자를 지어낼 이유가 없다.
 *
 * ★검사는 **실물 `paintWorking` 을 vm 에 올려** 돌린다. 문자열 grep 이면 폴백을 되살려도
 *  초록일 수 있다(이 파일이 막으려는 것이 바로 그 폴백이다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 실물 paintWorking 을 꺼내 한 번 그린다 → 화면에 나갈 라벨·경과 텍스트를 돌려준다. */
const paint = (
  turns: Array<[string, number]>,
  activeThreadKey: string,
  reasons: Array<[string, string]> = [],
): { label: string; elapsed: string } => {
  const src = readFileSync(
    path.join(REPO, "packages/dashboard/js/axis1-options.js"),
    "utf8",
  );
  const m = /const paintWorking = \(s\) => \{[\s\S]*?\n {6}\};/.exec(src);
  if (m === null) throw new Error("paintWorking 을 못 찾음");
  const out: Record<string, string> = { label: "", elapsed: "" };
  const ctx: Record<string, unknown> = {
    activeTurns: new Map(turns),
    // ★사유 맵 (2026-08-13) — 내가 안 시킨 턴(워커·에이전트 정리)에만 "왜 도는지" 가 붙는다.
    turnReason: new Map(reasons),
    activeThreadKey,
    assistantName: "돌쇠",
    fmtElapsed: (ms: number) => `${Math.round(ms / 1000)}초`,
  };
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\nthis.__paint = paintWorking;`, ctx);
  (ctx.__paint as (s: unknown) => void)({
    querySelector: (sel: string) => ({
      set textContent(v: string) {
        out[sel === ".chat-work-label" ? "label" : "elapsed"] = v;
      },
    }),
  });
  return { label: out.label ?? "", elapsed: out.elapsed ?? "" };
};

export const check: RegressionCheck = {
  name: "working-elapsed-own-session",
  guards:
    "내 대화가 놀고 있는데 다른 세션의 경과시간이 내 입력창 위에 뜨던 것(모르는 값을 지어냄)",
  run: async (): Promise<Assertion[]> => {
    const now = Date.now();
    const MINE = "dashboard:mine";
    const OTHER = "dashboard:other";

    // ①내 세션만 돈다 → 내 경과가 뜬다.
    const a = paint([[MINE, now - 30_000]], MINE);
    // ②★남의 세션만 돈다 → **경과는 비어야** 한다(종전엔 남의 시간이 떴다).
    const b = paint([[OTHER, now - 600_000]], MINE);
    // ③둘 다 돈다 → 내 것을 판다(남의 것이 더 이르더라도).
    const c = paint(
      [
        [OTHER, now - 600_000],
        [MINE, now - 5_000],
      ],
      MINE,
    );

    return [
      assert(
        "내 세션이 돌면 내 경과시간이 뜬다",
        a.elapsed === "30초",
        `elapsed=${JSON.stringify(a.elapsed)}`,
      ),
      assert(
        "★남의 세션만 돌면 경과시간을 안 쓴다(모르는 값을 지어내지 않는다)",
        b.elapsed === "",
        `elapsed=${JSON.stringify(b.elapsed)} label=${JSON.stringify(b.label)}`,
      ),
      assert(
        "★둘 다 돌면 **내 것**을 판다(가장 이른 턴 폴백 금지)",
        c.elapsed === "5초",
        `elapsed=${JSON.stringify(c.elapsed)}`,
      ),
      assert(
        "다른 세션이 도는 사실은 (+N) 으로 남는다(정보 손실 0)",
        c.label.includes("(+1)") && c.label.includes("작업 중"),
        `label=${JSON.stringify(c.label)}`,
      ),
      // ── ★내가 안 시킨 턴은 "왜 도는지" 를 말한다 (2026-08-13) ──
      // 사용자: "매니저나 에이전트가 일을 끝내고 메인비서가 정리하는 시점에 뭘 하는지
      //  알기가 어렵다 · 작업중도 안 뜬다 · 딱 빈공간인 느낌".
      // ★그 구간은 종전에 **아무 표시도 없었다**: 워커 완료 재주입이 `channel.message.in`
      //  발행을 통째로 스킵했고(스캐폴딩이 "나" 버블로 새는 걸 막으려고), 대시보드의
      //  작업중은 오직 그 이벤트로만 켜졌다 — 한 이벤트가 ①버블 그리기 ②표시 켜기
      //  두 일을 하고 있어서, 버블을 막으니 표시까지 같이 꺼졌다.
      assert(
        "★내가 안 시킨 턴은 사유를 같이 보여준다",
        paint([[MINE, now - 30_000]], MINE, [[MINE, "매니저·에이전트 결과 정리"]])
          .label.includes("매니저·에이전트 결과 정리"),
        paint([[MINE, now - 30_000]], MINE, [[MINE, "매니저·에이전트 결과 정리"]]).label,
      ),
      // 사용자가 직접 친 턴엔 안 붙는다 — 자기가 뭘 시켰는지 아는 사람에겐 군더더기다.
      assert(
        "사유가 없으면 라벨은 종전 그대로",
        paint([[MINE, now - 30_000]], MINE).label.startsWith("돌쇠 작업 중 ·"),
        paint([[MINE, now - 30_000]], MINE).label,
      ),
      // ★코어가 그 신호를 **내는가** — 위 두 검사는 화면 쪽이라, 코어가 종전처럼 발행을
      //  통째로 스킵해도 초록이다(변이로 확인했다: 실제로 안 걸렸다). 두 짝을 다 봐야 한다.
      //  ★등급: 배선 린트. index.ts 는 import 만으로 데몬이 뜨므로 실행할 수 없다.
      //   그래서 **구조**를 본다 — 합성 분기 안에서 `return` **앞에** publish 가 있는가
      //   (`if (…synthetic…) return;` 로 되돌리면 즉시 걸린다).
      (() => {
        const src = readFileSync(path.join(REPO, "src/index.ts"), "utf8");
        const i = src.indexOf("if (msg.synthetic === true) {");
        const block = i < 0 ? "" : src.slice(i, i + 700);
        const pubAt = block.indexOf("bus.publish");
        const retAt = block.indexOf("return;");
        const ok =
          i >= 0 &&
          pubAt >= 0 &&
          retAt > pubAt &&
          /synthetic: true,/.test(block) &&
          !/\btext:/.test(block.slice(0, retAt)); // 스캐폴딩 텍스트는 실으면 안 된다.
        return assert(
          "★코어가 합성 턴에도 진행 신호를 낸다(텍스트 없이)",
          ok,
          ok
            ? "publish → return · text 없음"
            : "★발행을 스킵했거나 텍스트를 실었다 — 빈 공간이 돌아온다",
        );
      })(),
    ];
  },
};
