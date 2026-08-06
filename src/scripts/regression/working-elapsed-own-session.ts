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
    ];
  },
};
