/**
 * 회귀: **그릴 범위는 누가 스크롤했든 실제 위치를 따른다** (2026-09-26).
 *
 * ★사고(헤드리스 실측, 전체 검토 중 발견): 데스크톱 채팅을 맨 위까지 올리면 첫 메시지 위 약 378px 가
 *  빈 채로 멈췄다 — vt-window 가 translateY(378px) 로 남고, 1px 라도 다시 스크롤해야 채워졌다.
 *  과거 불러오기의 위치 보정(setScrollTop) 직후 160ms «잔향 창» 안에 온 사용자 스크롤을 onScroll 이
 *  **relayout 예약 전에** 돌려보냈기 때문이다. 창의 목적은 stick 판정 보호인데 마운트 범위까지 막았다.
 *
 * 지키는 것(떼어낸 실제 onScroll 을 스텁 위에서 실행):
 *  ① 잔향 창 안의 스크롤도 relayout 을 예약한다  ② 창 안에선 stick 해제 판정을 안 한다(창의 원래 목적)
 *  ③ 창 밖 위로 스크롤 = stick 해제 + relayout  ④ 모바일 페이지 스크롤은 스크롤마다 relayout 안 함(종전)
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "scroll-always-remounts",
  guards:
    "과거 불러오기 위치 보정 직후 잔향 창 안의 사용자 스크롤이 relayout 을 예약하지 못해, 맨 위에서 첫 항목들이 빈 채로 멈추던 것",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(new URL("../../../packages/dashboard/js/virtualization.js", import.meta.url), "utf8");
    const body = /const onScroll = \(\) => \{[\s\S]*?\n {6}\};/.exec(src)?.[0] ?? "";
    const run = (o: { st: number; last: number; inWindow: boolean; page?: boolean; stick?: boolean }) => {
      let relayouts = 0;
      const ctx = vm.createContext({
        getScrollTop: () => o.st, gapNow: () => 5000, NEAR_BOTTOM_PX: 80, MOVED_EPS_PX: 8,
        lastScrollTop: o.last, perfNow: () => 1000, userIntentUntil: 0,
        stickBottom: o.stick ?? true, vtProgrammatic: false, vtProgUntil: o.inWindow ? 1100 : 0,
        updateChatJump: () => {}, pageScroll: () => o.page === true,
        scheduleRelayout: () => { relayouts++; }, VT_BUFFER: 600, loadingOlder: false, reachedOldest: true,
        loadOlderHistory: async () => {},
      });
      if (body !== "") vm.runInContext(`${body}\nonScroll();`, ctx);
      return { relayouts, stick: (ctx as { stickBottom: boolean }).stickBottom };
    };
    // ⑤ setScrollTop — 제자리 이동이면 잔향 창을 열지 않는다(2026-09-26 싱크 레드팀 P4: 앵커 복원이 값은
    //  제자리인데 매번 창을 다시 열어, 연속 휠 제스처가 전부 흡수돼 과거 불러오기가 한 번도 안 돌았다).
    const setSrc = /const setScrollTop = \(v\) => \{[\s\S]*?\n {6}\};/.exec(src)?.[0] ?? "";
    const setRun = (cur: number, v: number) => {
      const el = { scrollTop: cur, scrollHeight: 5000, clientHeight: 900 };
      const ctx = vm.createContext({ scEl: () => el, perfNow: () => 1000, requestAnimationFrame: () => 0, vtProgrammatic: false, vtProgUntil: 0, lastScrollTop: -1 });
      if (setSrc !== "") vm.runInContext(`${setSrc}\nsetScrollTop(${v});`, ctx);
      const c = ctx as { vtProgUntil: number; lastScrollTop: number };
      return { windowOpened: c.vtProgUntil > 0, st: el.scrollTop, last: c.lastScrollTop };
    };
    const inPlace = setRun(378, 378);
    const clampedInPlace = setRun(4100, 9999); // 바닥에서 바닥으로(클램프 후 제자리)
    const moved = setRun(378, 0);
    const inWin = run({ st: 0, last: 378, inWindow: true });
    const outWin = run({ st: 100, last: 378, inWindow: false });
    const mobile = run({ st: 100, last: 378, inWindow: false, page: true });
    return [
      assert("onScroll 을 떼어냈다(없으면 아래는 공짜 초록)", body !== "", `${body.length}자`),
      assert("setScrollTop 을 떼어냈다", setSrc !== "", `${setSrc.length}자`),
      assert("★⑤ 제자리 이동(클램프 포함)이면 잔향 창을 열지 않는다(연속 휠이 흡수되지 않게)", !inPlace.windowOpened && !clampedInPlace.windowOpened && inPlace.last === 378, JSON.stringify({ inPlace, clampedInPlace })),
      assert("⑤ 실제 이동이면 종전대로 창을 연다(자기 스크롤 이벤트 흡수)", moved.windowOpened && moved.st === 0, JSON.stringify(moved)),
      assert("★① 잔향 창 안의 사용자 스크롤도 relayout 을 예약한다(맨 위 빈 영역 방지)", inWin.relayouts >= 1, JSON.stringify(inWin)),
      assert("② 창 안에선 stick 해제 판정을 안 한다(창의 원래 목적)", inWin.stick === true, JSON.stringify(inWin)),
      assert("③ 창 밖 위로 스크롤 = stick 해제 + relayout", outWin.stick === false && outWin.relayouts >= 1, JSON.stringify(outWin)),
      assert("④ 모바일 페이지 스크롤은 스크롤마다 relayout 안 함", mobile.relayouts === 0, JSON.stringify(mobile)),
    ];
  },
};
