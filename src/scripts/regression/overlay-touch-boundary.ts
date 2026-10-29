/**
 * 짧은 모바일 overlay에서 세로 drag가 뒤 설정을 움직이던 Safari 결함.
 * 제품 side-panels.js 전체를 평가해 실제 등록 리스너에 입력한다(판정 함수를 복제하지 않는다).
 * 이 검사는 취소 여부/수명 계약만 잰다. 네이티브 스크롤과 visualViewport는 iOS 실측 별도.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { DASH_JS, dashSource, makeDomContext, makeEvent, type MElement } from "./_mini-dom.js";

export const check: RegressionCheck = {
  name: "overlay-touch-boundary",
  guards: "빈/짧은 모바일 패널의 세로 입력만 차단하고 내부·중첩·textarea 스크롤, 가로 메뉴 닫기, 선택, 핀치와 페이지 수명을 보존한다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { document, window, ctx } = makeDomContext({
      getComputedStyle: (el: MElement) => ({ overflowY: el.style.overflowY || "visible" }),
    });
    window.innerWidth = 402;
    window.innerHeight = 714;
    let selection: any = null;
    window.getSelection = () => selection;
    const html = readFileSync(path.join(DASH_JS, "../index.html"), "utf8");
    const panels: MElement[] = [];
    const registrations: { type: string; options: any }[] = [];
    for (const m of html.matchAll(/<([a-z]+)\b([^>]*\bclass="[^"]*\boverlay-panel\b[^"]*"[^>]*)>/g)) {
      const panel = document.createElement(m[1]!);
      panel.id = /\bid="([^"]+)"/.exec(m[2]!)![1]!;
      panel.className = /\bclass="([^"]+)"/.exec(m[2]!)![1]!;
      panel.rect = { left: 0, top: 0, right: 402, bottom: 714, width: 402, height: 714 };
      panel.style.overflowY = "auto";
      panel.scrollHeight = panel.clientHeight = 714;
      document.body.appendChild(panel);
      const add = panel.addEventListener.bind(panel);
      panel.addEventListener = (type: string, fn: any, options?: any) => {
        registrations.push({ type, options });
        add(type, fn, options);
      };
      panels.push(panel);
    }
    const bodyChild = document.createElement("div");
    document.body.appendChild(bodyChild);
    const context = vm.createContext(ctx);
    vm.runInContext(dashSource("side-panels.js"), context);
    const point = (x: number, y: number, id = 1) => ({ identifier: id, clientX: x, clientY: y });
    const send = (el: MElement, type: string, pts: any[], cancelable = true) => {
      let calls = 0;
      const ev = makeEvent(type, {
        bubbles: true, cancelable, touches: pts,
        preventDefault(this: any) { calls++; if (cancelable) this.defaultPrevented = true; },
      });
      el.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, calls };
    };
    const start = (el: MElement) => send(el, "touchstart", [point(150, 300)]);
    const move = (el: MElement, x = 150, y = 350, cancelable = true) => send(el, "touchmove", [point(x, y)], cancelable);
    const drag = (el: MElement, y: number) => { start(el); return move(el, 150, y).prevented; };
    const ok = (label: string, yes: boolean) => out.push(assert(label, yes, yes ? "확인" : "★계약 위반"));
    ok("마크업의 overlay 전부를 대상으로 한다(메뉴 포함)", panels.length >= 4);
    for (const panel of panels) {
      ok(`${panel.id}: 빈 영역 아래 drag 차단`, drag(panel, 360));
      ok(`${panel.id}: 빈 영역 위 drag 차단`, drag(panel, 240));
    }
    const panel = panels.find(p => p.id === "widget-panel")!;
    const owner = document.createElement("div");
    owner.style.overflowY = "auto";
    owner.clientHeight = 100; owner.scrollHeight = 500; owner.scrollTop = 200;
    const child = document.createElement("span");
    owner.appendChild(child); panel.appendChild(owner);
    ok("대상 자손에서 시작한 내부 중간 스크롤 양방향 보존", !drag(child, 350) && !drag(child, 250));
    owner.scrollTop = 0;
    ok("내부 top: 아래 drag 차단 / 위 drag 보존", drag(child, 350) && !drag(child, 250));
    owner.scrollTop = 400;
    ok("내부 bottom: 위 drag 차단 / 아래 drag 보존", drag(child, 250) && !drag(child, 350));
    owner.scrollTop = -5;
    ok("Safari 음수 bounce top에서도 아래 drag 차단", drag(child, 350));
    owner.scrollTop = 405;
    ok("Safari 초과 bounce bottom에서도 위 drag 차단", drag(child, 250));
    owner.style.overflowY = "hidden";
    ok("실제 overflow 숫자만 있고 hidden이면 소비할 스크롤러로 세지 않는다", drag(child, 250));
    owner.style.overflowY = "visible";
    ok("visible 비스크롤러의 높이를 근거로 누출을 허용하지 않는다", drag(child, 250));
    owner.style.overflowY = "auto"; owner.scrollTop = 0;
    panel.scrollHeight = 1000; panel.scrollTop = 100;
    ok("자식 끝이어도 패널 자체가 그 방향으로 소비 가능하면 보존", !drag(child, 350));
    panel.scrollTop = 0;
    ok("자식·패널 모두 top이면 차단", drag(child, 350));
    const nested = document.createElement("div");
    nested.style.overflowY = "scroll"; nested.clientHeight = 40; nested.scrollHeight = 160; nested.scrollTop = 50;
    child.appendChild(nested);
    ok("중첩 inner가 소비 가능하면 outer가 끝이어도 보존", !drag(nested, 350));
    nested.scrollTop = 0; owner.scrollTop = 50;
    ok("중첩 inner top이지만 outer 여유가 있으면 보존", !drag(nested, 350));
    owner.scrollTop = 0;
    ok("모든 중첩 조상 top이면 차단", drag(nested, 350));
    document.body.style.overflowY = "auto";
    document.body.scrollHeight = 2000; document.body.clientHeight = 714; document.body.scrollTop = 250;
    ok("패널 바깥 root/body는 소비 후보에 넣지 않는다", drag(nested, 350));
    panel.scrollHeight = panel.clientHeight;
    owner.scrollHeight = owner.clientHeight;
    ok("내용 교체로 짧아진 현재 높이를 다음 gesture에서 다시 잰다", drag(child, 250));
    start(child); owner.scrollHeight = 500;
    ok("같은 gesture 중 내용 증가도 다음 move에서 다시 잰다", !move(child, 150, 250).prevented);
    owner.scrollTop = 200;
    start(child); move(child, 150, 350); owner.scrollTop = 400;
    ok("같은 gesture의 방향 반전은 직전 y 기준으로 bottom 차단", move(child, 150, 330).prevented);
    owner.scrollHeight = owner.clientHeight;
    const input = document.createElement("input"); panel.appendChild(input);
    ok("input 탭은 취소하지 않는다", !start(input).prevented && !send(input, "touchend", []).prevented);
    ok("input 위 세로 drag도 소비 불가면 뒤로 넘기지 않는다", drag(input, 350));
    const textarea = document.createElement("textarea");
    textarea.style.overflowY = "auto"; textarea.clientHeight = 60; textarea.scrollHeight = 240; textarea.scrollTop = 90;
    panel.appendChild(textarea);
    ok("textarea 내부 중간 스크롤 보존", !drag(textarea, 350) && !drag(textarea, 250));
    textarea.scrollTop = 0;
    ok("textarea top에서 뒤로 새는 drag만 차단", drag(textarea, 350) && !drag(textarea, 250));
    const selectedRange = (anchorNode: any, top = 280) => ({
      isCollapsed: false, anchorNode, rangeCount: 1,
      getRangeAt: () => ({ getClientRects: () => [{ left: 100, right: 200, top, bottom: top + 30 }] }),
    });
    selection = selectedRange(child);
    ok("실제 선택 텍스트 위에서 시작한 drag를 취소하지 않는다", !drag(child, 350));
    const sibling = document.createElement("span"); panel.appendChild(sibling);
    selection = selectedRange(sibling, 380);
    ok("같은 패널 형제에 남은 선택은 빈 영역 drag의 경계를 끄지 않는다", drag(child, 350));
    selection = selectedRange(panel, 380);
    ok("선택과 같은 부모의 빈 영역도 선택 rect 밖이면 정상 차단", drag(panel, 350));
    selection = { isCollapsed: false, anchorNode: child, rangeCount: 0 };
    ok("실제 range가 없는 선택 상태도 정상 차단", drag(child, 350));
    selection = { isCollapsed: true, anchorNode: child };
    ok("접힌 selection은 정상 경계 차단", drag(child, 350));
    selection = selectedRange(bodyChild);
    ok("배경에 남은 선택은 패널 가드를 끄지 않는다", drag(child, 350));
    selection = null;
    ok("수평 가로 메뉴 제스처 보존", !dragHorizontal(panel));
    function dragHorizontal(el: MElement) { start(el); return move(el, 60, 305).prevented; }
    ok("세로 변위 없는 move 보존", !move(panel, 60, 305).prevented);
    start(panel);
    send(panel, "touchstart", [point(150, 300), point(180, 300, 2)]);
    ok("핀치·다중 touch 보존", !send(panel, "touchmove", [point(150, 350), point(190, 280, 2)]).prevented);
    ok("다중 touch가 한 손가락으로 줄어도 같은 gesture는 가로채지 않는다", !move(panel).prevented);
    start(panel); send(panel, "touchcancel", []);
    ok("touchcancel 후 이전 tracking 회수", !move(panel).prevented);
    start(panel); send(panel, "touchend", []);
    ok("touchend 후 이전 tracking 회수", !move(panel).prevented);
    ok("불취소 이벤트는 preventDefault 자체를 부르지 않는다", (start(panel), move(panel, 150, 350, false).calls) === 0);
    start(panel);
    ok("다른 identifier로 갈아탄 touch는 취소하지 않는다", !send(panel, "touchmove", [point(150, 350, 9)]).prevented);
    start(panel); panel.setAttribute("aria-hidden", "true");
    ok("열던 패널이 닫히면 추적 종료", !move(panel).prevented);
    panel.setAttribute("aria-hidden", "false");
    ok("재열기 새 start 없이 이전 gesture를 잇지 않는다", !move(panel).prevented);
    ok("재열기 새 gesture는 정상 차단", drag(panel, 350));
    panel.rect.left = -402; panel.rect.right = 0;
    ok("화면 밖 메뉴/닫힌 패널 추적 종료", (start(panel), !move(panel).prevented));
    panel.rect.left = 0; panel.rect.right = 402;
    window.innerWidth = 1200;
    ok("데스크톱 touch 기본 동작 보존", !drag(panel, 350));
    window.innerWidth = 900;
    ok("900px 모바일 경계 포함", drag(panel, 350));
    start(panel); window.innerWidth = 901;
    ok("gesture 중 데스크톱 전환시 추적 종료", !move(panel).prevented);
    window.innerWidth = 402;
    ok("모바일 재진입 새 gesture 정상", drag(panel, 350));
    ok("overlay 밖 입력은 전역 차단하지 않는다", !drag(bodyChild, 350));
    ok("resize/open/close가 리스너를 증식시키지 않는다", registrations.length === panels.length * 4);
    ok("touchmove는 실제 취소 가능한 nonpassive capture 등록", registrations.filter(r => r.type === "touchmove").every(r => r.options?.passive === false && r.options?.capture === true));
    ok("나머지 lifecycle touch 관측은 passive", registrations.filter(r => r.type !== "touchmove").every(r => r.options?.passive === true));
    return out;
  },
};
export default check;
