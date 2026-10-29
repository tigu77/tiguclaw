/**
 * 회귀: **프로젝트 화면에서 잡 카드로 이동(`focusBgJob`)하면 따라가기가 꺼진다** — 안 끄면 펼침이 일으킨 카드 크기 변화에
 * 핀이 맨 아래(최신)로 되돌려 목표 카드가 화면 밖에 남았다(2026-10-12 v0.70.0 릴리스 재검토, 0.69.1 부터 있던 것 ·
 * 헤드리스 3/3 재현 → 고친 뒤 3/3 보임).
 *
 * 지키는 것: `focusBgJob(id)` 뒤 래치(`bgStick`)가 꺼지고 «↓ 최신» 이 보인다(펼침은 헤드리스로 확인 — 미니 DOM 의 setJobOpen 은 상세 조회를 기다린다).
 * 미니 DOM 은 레이아웃이 없어 «화면에 보이나» 는 못 잰다 — 그건 헤드리스(focusjob 재현)로 확인했다. 여기선 그 결과를
 * 만드는 상태(래치 꺼짐)를 잰다: 래치가 켜져 있으면 다음 크기 변화의 핀이 반드시 맨 아래로 되돌린다.
 *
 * 등급: **동작**(미니 DOM).
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";

export const check: RegressionCheck = {
  name: "bg-focus-job-stops-follow",
  guards: "프로젝트 화면의 잡 카드를 눌러 백그라운드 패널의 그 잡으로 가도, 따라가기가 맨 아래로 되돌려 목표 카드가 화면 밖에 남던 것",
  run: async (): Promise<Assertion[]> => {
    const clock = makeClock();
    const dash = bootDashboard({ html: bgPanelHtml(), clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    for (let i = 0; i < 5; i++) {
      dash.run(`ensureJobCard(${JSON.stringify("f" + i)}, ${JSON.stringify({ threadKey: "dashboard:default", kind: "worker", label: "카드 " + i })})`);
    }
    const before = dash.run(`bgStick`) as boolean;
    dash.run(`window.focusBgJob("f1")`);
    await clock.advance(50);
    const after = dash.run(`bgStick`) as boolean;
    const jumpHidden = dash.run(`document.getElementById("bg-jump").hidden`) as boolean;
    return [
      assert(
        "★focusBgJob 뒤 따라가기가 꺼진다 · «↓ 최신» 이 보인다 — 켜진 채면 펼침의 크기 변화에 핀이 맨 아래로 되돌린다",
        before === true && after === false && jumpHidden === false,
        { 전: before, 후: after, 점프숨김: jumpHidden },
      ),
    ];
  },
};

export default check;
