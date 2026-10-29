/** 실제 패널 마크업/제품 스크립트를 쓰고, 레이아웃만 명시적으로 주는 fixture. */
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";
import { i18nForContext } from "./_framework.js";
import { readSourceSync } from "./_wiring.js";

export const bgPanelHtml = (): string => {
  const html = readSourceSync("packages/dashboard/index.html");
  const start = html.indexOf('<aside id="bg-panel"');
  const end = html.indexOf("</aside>", start);
  if (start < 0 || end < 0) throw new Error("실제 백그라운드 패널 마크업 없음");
  return html.slice(start, end + 8);
};
export const bootBgPanel = (fetch?: (url: string, init?: any) => Promise<any>) => {
  const clock = makeClock();
  const callbacks: Array<() => void> = [];
  const observed: unknown[] = [], unobserved: unknown[] = [];
  class RO {
    constructor(cb: (entries: unknown[]) => void) { callbacks.push(() => cb([])); }
    observe(el: unknown): void { observed.push(el); }
    unobserve(el: unknown): void { unobserved.push(el); }
  }
  const dash = bootDashboard({ html: bgPanelHtml(), clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true,
    extra: { ResizeObserver: RO }, fetch: fetch ?? (async () => jsonResponse({}, 404)) });
  dash.run(`window.EV = (type, extra = {}) => ({ type, bubbles: true, _stopped: false, defaultPrevented: false,
    stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...extra });
    (() => { const s = document.getElementById("bg-scroll");
      s.clientHeight = 300; s.clientWidth = 400; s.scrollHeight = 4000;
      s.rect = { top: 100, bottom: 400, left: 0, right: 400, width: 400, height: 300 };
      let top = 0;
      Object.defineProperty(s, "scrollTop", { get: () => top, set: (v) => { top = Math.max(0, Math.min(v, Math.max(0, s.scrollHeight - s.clientHeight))); } });
    })()`);
  return { dash, clock, callbacks, observed, unobserved, R: (js: string): any => dash.run(js) };
};

/** DOM 위치를 대신하는 수치 입력일 뿐, target/near/latch/pin 등 제품 계산은 넣지 않는다. */
export const jobGeometry = (r: (js: string) => any, id: string, bottom: number, height = 100): void => {
  r(`jobCards.get(${JSON.stringify(id)}).el.getBoundingClientRect = () => {
    const s = document.getElementById("bg-scroll"), end = ${bottom};
    return { top: 100 + end - ${height} - s.scrollTop, bottom: 100 + end - s.scrollTop, height: ${height}, left: 0, right: 400, width: 400 };
  }`);
};
