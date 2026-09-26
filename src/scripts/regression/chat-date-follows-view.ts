/**
 * 회귀: **위로 스크롤하면 채팅 상단에 «보고 있는 곳의 날짜» 가 뜬다** (2026-09-25).
 *
 * ★요청(정태님): *"스크롤이 마지막이 아니고 위쪽일 때 바로 어느 날짜인지 알 수가 없어서"* —
 *  날짜 구분선은 그날 첫 메시지 위에 **한 번**만 있어, 하루 중간을 보면 화면에 없다.
 * ★첫 판은 화면을 찍어(`elementFromPoint`) 맨 위 항목을 찾았는데, 항목 사이 틈(`.vt-sizer`)에
 *  걸려 **첫 스크롤에 알약이 숨었다**(헤드리스 실측). 그래서 목록 모델의 자리(`it.top`)로 찾는다.
 *
 * 지키는 것:
 *  ① 날짜는 맨 위 항목에서 **거슬러 올라가 만나는 첫 구분선**의 글이다(아래쪽 날짜가 아니다).
 *  ② 항목 사이 틈에 뷰 윗변이 걸려도 그 **다음 항목**을 잡는다(못 찾음 = 숨김이 아니다).
 *  ③ 구분선이 없으면(날짜 미상) 아무것도 말하지 않는다.
 *  ④ 표시 조건은 «↓ 최신» 버튼과 같은 판정 하나 — 그 버튼을 갱신하는 자리가 알약도 갱신한다.
 *
 * 등급: ①~③ 동작(파일에서 떼어낸 실제 함수를 가짜 목록 위에서 실행) · ④ 소스 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/js");

interface Item { isDivider: boolean; top: number; h: number; node: { textContent: string } }

export const check: RegressionCheck = {
  name: "chat-date-follows-view",
  guards:
    "위로 스크롤해 하루 중간을 보면 날짜 구분선이 화면 밖이라 어느 날인지 알 수 없던 것 + 첫 판이 항목 사이 틈에 걸려 알약을 숨기던 것",
  run: async (): Promise<Assertion[]> => {
    const virt = readFileSync(path.join(DASH, "virtualization.js"), "utf8");
    const grab = (name: string) =>
      new RegExp(`const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n {6}\\};`).exec(virt)?.[0] ?? "";
    const dateAbove = grab("dateAbove");
    const topItemIndex = grab("topItemIndex");
    const GAP = 6;
    const items: Item[] = [];
    let top = 0;
    const push = (isDivider: boolean, h: number, text = "") => {
      items.push({ isDivider, top, h, node: { textContent: text } });
      top += h + GAP;
    };
    push(false, 50);                 // 0 날짜 미상(구분선 앞)
    push(true, 20, "2026-09-23 (화)"); // 1
    push(false, 100);                // 2
    push(false, 100);                // 3
    push(true, 20, "2026-09-24 (수)"); // 4
    push(false, 100);                // 5
    const ctx = vm.createContext({
      vtItems: items,
      vtSizer: { getBoundingClientRect: () => ({ top: 0 }) },
      slotH: (it: Item) => it.h + GAP,
    });
    if (dateAbove && topItemIndex) vm.runInContext(`${dateAbove}\n${topItemIndex}\nthis.dateAbove = dateAbove; this.topItemIndex = topItemIndex;`, ctx);
    const f = ctx as { dateAbove?: (a: Item[], i: number) => string; topItemIndex?: (y: number) => number };
    const at = (y: number) => (f.dateAbove && f.topItemIndex ? f.dateAbove(items, f.topItemIndex(y)) : "★함수 없음");

    const midDay23 = items[3]!.top + 10;          // 23일 두 번째 메시지 한가운데 — 아래엔 24일이 있다
    const inGap = items[2]!.top + items[2]!.h + 2; // 2번과 3번 사이 틈
    const day24 = items[5]!.top + 5;
    const beforeAny = 5;

    // ⑤⑥ 숨김 조건·보이는 윗변 — 떼어낸 실제 함수를 돌린다(2026-09-26 적대 검토 M8·M9·M10: 소스 대조
    //  «const off = stickBottom» 하나뿐이라 기록 보기·숨은 채팅·모바일 탭 기준을 지워도 초록이었다).
    const grabExpr = (name: string) =>
      new RegExp(`const ${name} = \\([^)]*\\) =>[\\s\\S]*?;\\n`).exec(virt)?.[0] ?? "";
    const offSrc = grabExpr("chatDateOff");
    const topSrc = grabExpr("chatViewTop");
    const ctx2 = vm.createContext({});
    if (offSrc && topSrc) vm.runInContext(`${offSrc}\n${topSrc}\nthis.off = chatDateOff; this.top = chatViewTop;`, ctx2);
    const g = ctx2 as { off?: (v: object) => boolean; top?: (a: number, b: number | null) => number };
    const shown = { stickBottom: false, height: 500, attached: true, panel: "chat" };
    const offCases = g.off
      ? {
          scrolledUp: g.off(shown),
          atBottom: g.off({ ...shown, stickBottom: true }),
          logPanel: g.off({ ...shown, panel: "log" }),
          detached: g.off({ ...shown, attached: false }),
          zeroHeight: g.off({ ...shown, height: 0 }),
        }
      : null;
    const tops = g.top ? { mobile: g.top(-12000, 98), desktop: g.top(199, 150), noTabs: g.top(199, null) } : null;
    // 주석을 벗기고 잰다 — 연결을 주석 처리해도 초록이던 변이(M3).
    const updater = (/const updateChatJump = \(\) => \{[\s\S]*?\n {6}\};/.exec(virt)?.[0] ?? "").replace(/^\s*\/\/.*$/gm, "");
    const offRule = /const off = chatDateOff\(\{/.test(virt);

    return [
      assert("판정 함수를 떼어냈다(없으면 아래는 공짜 초록)", dateAbove !== "" && topItemIndex !== "", `dateAbove ${dateAbove.length}자 · topItemIndex ${topItemIndex.length}자`),
      assert("★① 하루 중간을 보면 그날 구분선의 날짜(아래쪽 다음 날이 아니다)", at(midDay23) === "2026-09-23 (화)", at(midDay23)),
      assert("① 다음 날 구간이면 그날", at(day24) === "2026-09-24 (수)", at(day24)),
      assert("★② 뷰 윗변이 항목 사이 틈에 걸려도 다음 항목의 날짜(숨기지 않는다)", at(inGap) === "2026-09-23 (화)", at(inGap)),
      assert("③ 구분선 앞(날짜 미상)이면 말하지 않는다", at(beforeAny) === "", JSON.stringify(at(beforeAny))),
      assert(
        "★⑤ 위로 스크롤한 동안만 뜬다 — 바닥·기록 보기·숨은 채팅·높이 0 이면 숨긴다",
        offCases !== null && !offCases.scrolledUp && offCases.atBottom && offCases.logPanel && offCases.detached && offCases.zeroHeight,
        JSON.stringify(offCases),
      ),
      assert(
        "★⑥ 보이는 윗변 — 모바일(문서 스크롤)은 고정된 탭 아래, 데스크톱은 채팅 윗변",
        tops !== null && tops.mobile === 98 && tops.desktop === 199 && tops.noTabs === 199,
        JSON.stringify(tops),
      ),
      assert(
        "④ «↓ 최신» 버튼을 갱신하는 자리가 알약도 갱신하고, 숨김은 그 판정 함수를 지난다",
        /scheduleChatDate\(\)/.test(updater) && offRule,
        `갱신 연결=${/scheduleChatDate\(\)/.test(updater)} 숨김조건=${offRule}`,
      ),
    ];
  },
};
