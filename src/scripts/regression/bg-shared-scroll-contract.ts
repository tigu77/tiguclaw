/** R3: 공통 바깥 viewport의 실제 입력→위치 변화→래치 전이. CSS/레이아웃은 브라우저 검증 별도. */
import { assert as baseAssert, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootBgPanel, jobGeometry } from "./_bg-panel-fixture.js";
const assert = (name: string, ok: boolean, detail: unknown = ""): Assertion => baseAssert(name, ok, detail);

export const check: RegressionCheck = {
  name: "bg-shared-scroll-contract",
  guards: "셸 바닥을 최신으로 오인하거나 내부 입력/프로그램 스크롤/오래된 입력후보로 reveal hold가 풀리는 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { R, clock, callbacks } = bootBgPanel();
    R(`handleWorkerEvent({jobId:"last", status:"running", ownerThreadKey:"dashboard:default", task:"내용"}, "");
      const innerInput = document.createElement("textarea"); innerInput.id = "inner-input"; jobCards.get("last").el.appendChild(innerInput);`);
    jobGeometry(R, "last", 1000);
    const reset = () => R(`bgGeometryChanged(); bgStick = false; bgRevealHold = true; bgScroll.scrollTop = 200; updateBgJump()`);
    const move = (top = 700) => R(`bgScroll.scrollTop = ${top}; bgScroll.dispatchEvent(window.EV("scroll"))`);
    const held = () => R(`!bgStick && bgRevealHold`);
    out.push(assert("★실제 마크업에서 잡/셸 두 목록의 공통 조상은 #bg-scroll, 최신버튼은 그 밖",
      R(`bgScroll.contains(bgList) && bgScroll.contains(document.getElementById("bg-shells-list")) && !bgScroll.contains(bgJump)`)));
    R(`bgJump.click()`);
    out.push(assert("★★최신은 셸 바닥 3700 아닌 마지막 보이는 잡 bottom−높이=700", R(`bgScroll.scrollTop`) === 700, R(`bgScroll.scrollTop`)));
    jobGeometry(R, "last", 100);
    R(`bgJump.click()`);
    out.push(assert("★목표는 0 아래로 내려가지 않는다", R(`bgScroll.scrollTop`) === 0));
    jobGeometry(R, "last", 8000);
    R(`bgJump.click()`);
    out.push(assert("★목표는 전체 scrollHeight−clientHeight에서 clamp", R(`bgScroll.scrollTop`) === 3700));
    jobGeometry(R, "last", 1000);
    for (const type of ["wheel", "touchmove"]) {
      reset();
      R(`jobCards.get("last").stepsEl.dispatchEvent(window.EV(${JSON.stringify(type)})); bgScroll.dispatchEvent(window.EV("scroll"))`);
      out.push(assert(`★★${type} 내부 입력만/outer 위치 동일이면 hold 유지`, held()));
      move();
      out.push(assert(`★★${type} 체인으로 실제 outer가 T near까지 움직이면 hold 해제/on`, R(`bgStick && !bgRevealHold`)));
    }
    R(`const innerOutput = document.createElement("pre"); innerOutput.className = "shell-card-output";
      document.getElementById("bg-shells-list").appendChild(innerOutput);`);
    for (const type of ["wheel", "touchmove"]) {
      reset();
      R(`document.querySelector(".shell-card-output").dispatchEvent(window.EV(${JSON.stringify(type)})); bgScroll.dispatchEvent(window.EV("scroll"))`);
      out.push(assert(`★★셸 출력 ${type}가 내부만 움직이면 hold 유지`, held()));
      move();
      out.push(assert(`★★셸 출력 ${type}가 바깥 실제 near 이동으로 체인되면 follow 재개`, R(`bgStick && !bgRevealHold && bgScroll.scrollTop === 700`)));
    }
    for (const key of ["ArrowDown", "PageDown", "Home", "End", " "]) {
      reset(); R(`bgScroll.dispatchEvent(window.EV("keydown", {key:${JSON.stringify(key)}}))`); move();
      out.push(assert(`★스크롤키 ${JSON.stringify(key)}+실제 outer 변화만 on`, R(`bgStick && !bgRevealHold`)));
    }
    for (const key of ["ArrowDown", "PageDown", "Home", "End"]) {
      reset(); R(`jobCards.get("last").el.querySelector("button").dispatchEvent(window.EV("keydown", {key:${JSON.stringify(key)}}))`); move();
      out.push(assert(`★★버튼 포커스 ${key}는 실제 outer 이동시 손 입력 인정`, R(`bgStick && !bgRevealHold`)));
    }
    reset(); R(`jobCards.get("last").el.querySelector("button").dispatchEvent(window.EV("keydown", {key:" "}))`); move();
    out.push(assert("★버튼 Space는 활성화 키이므로 후보 제외", held()));
    reset();
    R(`document.getElementById("inner-input").dispatchEvent(window.EV("keydown", {key:"ArrowDown"}))`); move();
    out.push(assert("★textarea 편집키는 프로그램 outer 이동을 손으로 오인 안 함", held()));
    reset(); R(`bgScroll.dispatchEvent(window.EV("keydown", {key:"ArrowDown",ctrlKey:true}))`); move();
    out.push(assert("★수식키 조합은 후보 아님", held()));
    reset(); R(`bgScroll.dispatchEvent(window.EV("pointerdown", {clientX:399})); bgScroll.dispatchEvent(window.EV("scroll"))`);
    out.push(assert("★스크롤바 누름만으로 hold 유지", held()));
    move();
    out.push(assert("★★스크롤바 드래그+실제 outer 변화는 on", R(`bgStick && !bgRevealHold`)));
    R(`window.dispatchEvent(window.EV("pointerup"))`);
    reset(); R(`jobCards.get("last").el.dispatchEvent(window.EV("pointerdown", {clientX:399}))`); move();
    out.push(assert("★카드 선택/포커스는 스크롤바 후보 아님", held()));
    reset(); move();
    out.push(assert("★★프로그램 scroll near여도 hold 유지", held()));
    reset(); R(`bgScroll.dispatchEvent(window.EV("wheel"))`); await clock.advance(181); move();
    out.push(assert("★★idle 뒤 늦은 scroll은 사용자 입력 아님", held()));
    for (const boundary of ["scrollend", "touchend", "touchcancel"]) {
      reset(); R(`bgScroll.dispatchEvent(window.EV("touchmove")); bgScroll.dispatchEvent(window.EV(${JSON.stringify(boundary)}))`); move();
      out.push(assert(`★${boundary}에서 후보 폐기`, held()));
    }
    for (const action of [`setBgFilter("done")`, `setBgSessionScope("all")`, `document.getElementById("bg-jobs-head").click()`, `bgSetScrollTop(250)`]) {
      reset(); R(`bgScroll.dispatchEvent(window.EV("wheel")); ${action}`); move();
      out.push(assert(`★★기하변경 ${action} 뒤 지연 scroll로 hold 해제 안 함`, held()));
    }
    // ResizeObserver도 사용자 입력을 만들지 않음.
    reset(); R(`bgScroll.dispatchEvent(window.EV("wheel"))`); for (const cb of callbacks) cb(); move();
    out.push(assert("★RO/viewport 높이 변화 뒤 scroll은 hold 유지", held()));
    // 목표 없는 상태에서 손이 움직인 것은 off. 잡이 나중에 보여도 자동 on 금지.
    reset(); jobGeometry(R, "last", 1000, 0);
    R(`bgScroll.dispatchEvent(window.EV("wheel"))`); move(500);
    out.push(assert("★★보이는 잡 없음+실제 셸 스크롤은 off/hold 해제", R(`!bgStick && !bgRevealHold`)));
    jobGeometry(R, "last", 1000); for (const cb of callbacks) cb();
    out.push(assert("★★잡 재출현/RO는 off를 자동 on으로 바꾸지 않음", R(`!bgStick && bgScroll.scrollTop === 500`)));
    reset(); jobGeometry(R, "last", 1000, 0); R(`bgJump.click()`);
    out.push(assert("★목표없음 최신 클릭은 on 의도만 기록/위치 안 만짐", R(`bgStick && !bgRevealHold && bgScroll.scrollTop === 200`)));
    return out;
  },
};
