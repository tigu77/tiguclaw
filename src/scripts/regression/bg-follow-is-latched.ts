/** 공통 칸에서도 팔로우는 geometry에서 재유도하지 않는 래치다. 실제 제품 JS/RO 경로 실행. */
import { assert as baseAssert, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootBgPanel, jobGeometry } from "./_bg-panel-fixture.js";
const assert = (name: string, ok: boolean, detail: unknown = ""): Assertion => baseAssert(name, ok, detail);

export const check: RegressionCheck = {
  name: "bg-follow-is-latched",
  guards: "높이 0으로 도착한 잡의 지연 성장/하이드레이션 뒤 최신을 놓치거나, 셸 바닥으로 따라가거나, 손으로 읽던 자리를 뺏는 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { R, callbacks, observed, unobserved } = bootBgPanel();
    const grow = (count: number, base = 0): number => {
      let end = base;
      for (let i = 0; i < count; i++) {
        const id = `g${base}-${i}`;
        R(`handleWorkerEvent({jobId:${JSON.stringify(id)},status:"running",kind:"worker",label:"지연",ownerThreadKey:"dashboard:default"}, "")`);
        jobGeometry(R, id, end, 0);
        R(`bgPin()`);
        for (const h of [107, 167]) {
          jobGeometry(R, id, end + h, h);
          for (const cb of callbacks) cb();
        }
        end += 167;
      }
      return end;
    };
    const end = grow(12);
    (R(`(items) => { globalThis.__observed = items; }`) as (items: unknown[]) => void)(observed);
    out.push(assert("★★12개 잡의 0→107→167px 지연 성장: 마지막 잡 끝−viewport로 핀, 아래 긴 셸 바닥(3700) 아님",
      R(`document.getElementById("bg-scroll").scrollTop`) === end - 300 && R(`bgStick`) === true,
      { top: R(`document.getElementById("bg-scroll").scrollTop`), want: end - 300 }));
    out.push(assert("★각 잡과 공통 viewport를 ResizeObserver로 관찰", R(`Array.from(jobCards.values()).every(e => globalThis.__observed.includes(e.el)) && globalThis.__observed.includes(bgScroll)`), observed.length));
    R(`document.getElementById("bg-scroll").dispatchEvent(window.EV("wheel"));
      document.getElementById("bg-scroll").scrollTop = 100;
      document.getElementById("bg-scroll").dispatchEvent(window.EV("scroll"));`);
    grow(1, end);
    out.push(assert("★★손으로 과거 읽는 중 새 잡·지연 성장에서도 위치 유지/최신 버튼 표시",
      R(`document.getElementById("bg-scroll").scrollTop === 100 && !bgStick && !bgJump.hidden`), R(`({bgStick, top:bgScroll.scrollTop})`)));
    R(`bgJump.click()`);
    out.push(assert("★★최신 클릭은 hold를 풀고 래치 on/잡 끝으로 즉시 이동", R(`bgStick && !bgRevealHold && bgJump.hidden && bgScroll.scrollTop === ${end + 167 - 300}`)));

    const h = bootBgPanel();
    for (let i = 0; i < 40; i++) {
      h.R(`handleWorkerEvent({jobId:"h${i}",status:"running",ownerThreadKey:"dashboard:default"}, "")`);
      jobGeometry(h.R, `h${i}`, (i + 1) * 146, 146);
      h.R(`bgScroll.scrollHeight = 10000`);
      for (const cb of h.callbacks) cb();
    }
    out.push(assert("★★40개 hydration도 초기 래치 on으로 마지막 잡에 안착", h.R(`bgScroll.scrollTop`) === 40 * 146 - 300, h.R(`bgScroll.scrollTop`)));
    // 실제 상한 경로로 제거시 관찰 해제 (이름 존재/호출 문자열 검사가 아니다).
    R(`for (let i = 0; i < 60; i++) handleWorkerEvent({jobId:"cap"+i,status:"done",ownerThreadKey:"dashboard:default"}, "")`);
    out.push(assert("★상한으로 실제 제거된 카드의 RO도 해제", unobserved.length > 0 && R(`jobCards.size <= BG_MAX`), unobserved.length));
    return out;
  },
};
