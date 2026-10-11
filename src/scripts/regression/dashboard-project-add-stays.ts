/**
 * 회귀: **대화의 [+ 프로젝트] 버튼은 늘 보인다 — 등록된 프로젝트를 전부 연결한 뒤에도** (2026-10-11 정태님: «한 대화에 프로젝트
 * 연결하면 +프로젝트 버튼이 사라지네?» → «그냥 계속 나와도 될 거 같은데»).
 *
 * 사고: 버튼을 «연결할 게 더 없으면» 숨겼다. 등록된 프로젝트가 하나뿐이면 그걸 연결하는 순간 버튼이 사라져, 더 연결하거나 새로
 *  등록하는 길이 화면에서 안 보였다. 텔레그램 `/project link` 는 같은 경우 숨기지 않고 «연결할 프로젝트가 없다» 고 답한다.
 *
 * 지키는 것(진짜 session-projects.js 를 미니 DOM 에서):
 *  ① 전부 연결된 상태(available 0 · linked 1)에도 버튼이 있다
 *  ② 그 버튼의 목록은 «모두 연결됨» + 등록하는 법(«등록된 프로젝트가 없습니다» 가 아니다)
 *  ③ 아무것도 등록 안 된 상태는 종전대로 «등록된 프로젝트가 없습니다» + 등록하는 법
 *
 * 등급: **동작**.
 */
import { bootDashboard, dashSource, jsonResponse, makeClock } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const rowAndMenu = async (body: { linked: unknown[]; available: unknown[] }) => {
  const clock = makeClock();
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    ids: ["chat-projects"],
    fetch: async (url: string) => (url.startsWith("/api/session-projects") ? jsonResponse(body) : jsonResponse({}, 404)),
    stubs: 'activeThreadKey = "dashboard:default";',
  });
  dash.run(dashSource("session-projects.js"), "session-projects.js");
  await clock.advance(10);
  const row = dash.document.getElementById("chat-projects");
  const buttons = (row?.children ?? []).map((c: { textContent?: string }) => String(c.textContent));
  const labels = [...(dash.run('menuProviders.get("sessionProjectPick")') as Set<() => { label: string }[]>)]
    .flatMap((f) => f())
    .map((it) => it.label);
  return { buttons, labels, errors: clock.errors };
};

export const check: RegressionCheck = {
  name: "dashboard-project-add-stays",
  guards: "하나뿐인 등록 프로젝트를 대화에 연결하면 [+ 프로젝트] 버튼이 사라져, 더 연결하거나 새로 등록하는 길이 화면에서 안 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const all = await rowAndMenu({
      linked: [{ name: "alpha", path: "/p/alpha", exists: true, registered: true, commands: [] }],
      available: [],
    });
    const none = await rowAndMenu({ linked: [], available: [] });
    // 연결만 남고 등록이 해제됐다 — 등록된 게 0개인데 «모두 연결됨» 이라 하면 거짓이다(릴리스 검토 #9)
    const orphan = await rowAndMenu({ linked: [{ name: "beta", path: "/p/beta", exists: true, registered: false, commands: [] }], available: [] });
    const addLabel = i18nForContext("sproj.add");
    return [
      assert("★① 등록된 프로젝트를 전부 연결해도 [+ 프로젝트] 버튼이 남는다", all.buttons.includes(addLabel) && all.buttons.length === 2, all.buttons),
      assert(
        "★② 그 목록은 «모두 연결됨» + 등록하는 법이다(«등록된 프로젝트가 없습니다» 가 아니다)",
        all.labels.includes(i18nForContext("sproj.allLinked")) && !all.labels.includes(i18nForContext("proj.empty.title")) && all.labels.some((l) => l.includes("프로젝트로 등록해줘")),
        all.labels,
      ),
      assert(
        "③ 아무것도 등록 안 됐으면 종전대로 «등록된 프로젝트가 없습니다» + 등록하는 법",
        none.buttons.includes(addLabel) && none.labels.includes(i18nForContext("proj.empty.title")) && !none.labels.includes(i18nForContext("sproj.allLinked")),
        { 버튼: none.buttons, 목록: none.labels },
      ),
      assert(
        "③ 연결만 남고 등록이 해제됐으면 «모두 연결됨» 이 아니라 «등록된 프로젝트가 없습니다» + 등록하는 법",
        orphan.labels.includes(i18nForContext("proj.empty.title")) && !orphan.labels.includes(i18nForContext("sproj.allLinked")),
        orphan.labels,
      ),
      assert("그 과정에 던진 것이 없다", all.errors.length + none.errors.length + orphan.errors.length === 0, [...all.errors, ...none.errors, ...orphan.errors].join(" | ") || "예외 0"),
    ];
  },
};

export default check;
