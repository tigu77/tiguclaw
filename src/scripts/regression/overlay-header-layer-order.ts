/**
 * 모바일 드로어의 닫기 버튼은 헤더 토글이 아니라 자기 패널이 받는다.
 * 2026-10-28: BG X 좌표를 헤더 위젯 토글이 받아 BG→위젯 전환이 됐다.
 * 값 자체가 아니라 본문 UI < header < 배경막 < 패널 관계를 지킨다.
 * 실제 hit-test/native tap 대조는 _workspace/hunt/panel-close-ownership/ 에 기록한다.
 */
import { readSourceSync, stripComments } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "overlay-header-layer-order",
  guards: "모바일 헤더가 전체화면 패널의 X를 가로채 위젯 토글을 누르던 레이어 역전",
  async run(): Promise<Assertion[]> {
    const css = stripComments(readSourceSync("packages/dashboard/app.css"));
    const html = stripComments(readSourceSync("packages/dashboard/index.html"));
    // 중첩 @media 안의 leaf 규칙도 읽는다. 각 selector의 모든 z 선언을 확인하므로
    // 뒤의 모바일/채팅 override로 순서를 뒤집는 것도 실패한다.
    const layers = new Map<string, number[]>();
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const values = [...rule[2].matchAll(/(?:^|;)\s*z-index\s*:\s*([^;]+)/g)].map(m => {
        const value = m[1].replace(/\s*!important\s*$/, "").trim();
        return /^-?\d+$/.test(value) ? Number(value) : NaN;
      });
      if (!values.length) continue;
      for (const s of rule[1].split(",").map(s => s.trim())) layers.set(s, [...(layers.get(s) ?? []), ...values]);
    }
    const targetLayers = (target: string) => [...layers]
      .filter(([s]) => new RegExp(String.raw`(?:^|[\s>+~])${target}(?:[.:\[][^\s>+~]*)?$`).test(s))
      .flatMap(([, values]) => values);
    const headers = targetLayers("header");
    // 배경막과 바로 이어지는 overlay-panel은 그 자리에서 짝을 선언한다.
    // 오른쪽 셋 + 왼쪽 메뉴의 서로 다른 마크업 위치도 같은 관계를 검사한다.
    const overlays = [...html.matchAll(/<(?:aside|section)\b[^>]*id="([^"]+)"[^>]*class="[^"]*\boverlay-panel\b[^>]*>/g)].map(m => m[1]);
    const pairs = overlays.map(id => ({
      panel: id,
      backdrop: id === "sidebar" ? "menu-backdrop" : id === "widget-panel" ? "wg-backdrop" : id.replace(/(?:-panel)?$/, "-backdrop"),
    }));
    const out: Assertion[] = [];
    out.push(assert("헤더의 레이어 선언을 찾았다(0개로 초록 금지)", headers.length > 0, JSON.stringify(headers)));
    out.push(assert("현재 overlay 표식 전체를 읽었다", pairs.length >= 4, JSON.stringify(pairs)));
    const contentLayers = ["#wb-detail-back", String.raw`\.session-tabs-bar`, "#chat"].map(targetLayers);
    const content = contentLayers.flat();
    out.push(assert("닫힌 상태에서도 헤더는 본문 고정 UI보다 위다", contentLayers.every(v => v.length > 0) && headers.length > 0 && Math.max(...content) < Math.min(...headers), JSON.stringify({ contentLayers, headers })));
    for (const p of pairs) {
      const panel = targetLayers("#" + p.panel), back = targetLayers("#" + p.backdrop);
      const declared = panel.length > 0 && back.length > 0;
      out.push(assert(`${p.panel}: header < 배경막 < 패널`, declared && headers.length > 0 && Math.max(...headers) < Math.min(...back) && Math.max(...back) < Math.min(...panel), JSON.stringify({ headers, back, panel })));
    }
    return out;
  },
};
export default check;
