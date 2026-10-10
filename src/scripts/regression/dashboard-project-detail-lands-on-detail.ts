/**
 * 회귀: **📁 «프로젝트 상세 보기» 는 모바일에서도 상세 화면에 착지한다** (2026-10-09 전체 적대 검토).
 *
 * 사고: 모바일(≤900px)은 마스터-디테일이다 — 목록 행을 누르면 mobile-nav 가 `body.m-detail` 을 켜고, 뷰가 바뀌면
 *  (data-view 관측) «새 뷰는 목록부터» 로 **마이크로태스크에서** 끈다. 📁 칩 메뉴의 «프로젝트 상세 보기» 는
 *  `applyView("projects")` 뒤 `openProjectDetail` 을 부르는데 행 클릭이 아니라서 아무도 m-detail 을 안 켰고,
 *  켰더라도 관측자가 뒤에서 껐다 — 결과는 **목록 화면**(상세는 그 밑에 숨어 있다).
 * 고침: 상세를 연 쪽이 켠다 — 관측자 콜백보다 **뒤**(마이크로태스크)에.
 *
 * ★순서 결함이라 소스 대조로는 안 잡힌다(켜는 줄이 있어도 앞에 있으면 꺼진다). 그래서 진짜 mobile-nav.js 의
 *  관측자와 진짜 session-projects.js 의 처리기를 **같은 vm 에서** 돌리고, 관측자 배달도 브라우저처럼
 *  마이크로태스크로 한다(_mini-dom MutationObserver).
 */
import { bootDashboard, dashSource, jsonResponse, makeClock } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const openDetailAt = async (width: number) => {
  const clock = makeClock();
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    width,
    ids: ["chat-projects", "projects-grid", "projects-search", "wb-detail-back"],
    fetch: async (url: string) =>
      url.startsWith("/api/projects/detail") ? jsonResponse({ error: "x" }, 404) : jsonResponse({}, 404),
    // 뒤 파일(activity.js·chat-core.js)의 대역 — 뷰 전환은 **진짜 showProjects**(setActiveNav → data-view)로 한다.
    stubs:
      "const setChatPanel = () => {};" +
      "const applyView = (v) => { if (v === \"projects\") showProjects(); return true; };",
  });
  dash.run(dashSource("session-projects.js"), "session-projects.js");
  dash.run(dashSource("mobile-nav.js"), "mobile-nav.js");
  dash.run('setActiveNav("chat")'); // 다른 화면(채팅)에서 시작한다(전환이 일어나야 관측자가 돈다)
  await clock.advance(10);
  dash.run('builtinHandlers.get("sessionProject.openDetail")({}, { path: "/p/alpha" })');
  await clock.advance(10);
  return {
    detail: dash.document.body.classList.contains("m-detail"),
    view: dash.document.body.dataset.view as string,
    errors: clock.errors,
  };
};

export const check: RegressionCheck = {
  name: "dashboard-project-detail-lands-on-detail",
  guards:
    "모바일에서 📁 «프로젝트 상세 보기» 가 상세가 아니라 프로젝트 목록 화면에 착지하던 것(m-detail 을 켜는 쪽이 없었고, 뷰 전환 관측자가 마이크로태스크에서 끄므로 켜더라도 앞에 있으면 꺼진다)",
  run: async (): Promise<Assertion[]> => {
    const phone = await openDetailAt(390);
    const desk = await openDetailAt(1400);
    return [
      assert(
        "★★390px 에서 «프로젝트 상세 보기» → 프로젝트 화면의 **상세**(m-detail)에 착지한다",
        phone.view === "projects" && phone.detail === true,
        `view=${phone.view} m-detail=${String(phone.detail)}`,
      ),
      assert(
        "데스크톱(1400px)엔 m-detail 을 켜지 않는다(모바일 전용 상태)",
        desk.view === "projects" && desk.detail === false,
        `view=${desk.view} m-detail=${String(desk.detail)}`,
      ),
      assert("그 과정에 던진 것이 없다", phone.errors.length + desk.errors.length === 0, [...phone.errors, ...desk.errors].join(" | ") || "예외 0"),
    ];
  },
};
