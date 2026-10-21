/**
 * 회귀: **홈은 이벤트마다 위젯을 다시 붙이지 않는다** + **부팅 앞부분의 «다시 그려라» 가 아직 안 온 파일을 부르지 않는다**
 * (2026-10-09 전체 적대 검토).
 *
 * ── ① 홈 전체 재구성 ──────────────────────────────────────────────────────
 *  홈을 «다시 그려라» 하는 자리가 열세 곳이다(sse·token-delta·channel-hints 등 —
 *  `if (currentView === "overview") setTimeout(showOverview, 0)`). 종전 `showOverview` 는 매번
 *  `root.innerHTML` 을 갈고 **위젯을 떼었다 다시 마운트하고 `/api/plugin-data` 를 다시 부르고 타이머를
 *  새로 걸었다** — 스트리밍 중엔 초당 수십 번이다(검토자가 실행으로 확인).
 *  고침: 이미 홈이면 그 호출은 갱신이다 → 짧은 창으로 합치고 숫자 부분만 바꾼다. 위젯은 배치가 바뀔 때만.
 *
 * ── ② 부팅 경합 (cbbb5de1) ────────────────────────────────────────────────
 *  `currentView` 가 "overview" 로 시작하면 update-chip 의 판정 응답이 홈을 예약하고, chat-core.js 가 아직
 *  안 왔으면 ReferenceError 였다(chat-core.js 를 10초 늦추면 매번 재현). 그물이 0이었다.
 *
 * 등급: **동작** — 실제 대시보드 파일을 `_manifest.json` 순서대로 vm 에 싣고(chat-core.js 앞까지)
 * 시계를 손으로 돌린다. 뒤 파일이 줄 전역(evCount·setChatPanel·widgetHost)만 대역이다.
 */
import { bootDashboard, dashSource, jsonResponse, makeClock } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const REFRESH_CALL = 'if (currentView === "overview") setTimeout(showOverview, 0);';

export const check: RegressionCheck = {
  name: "dashboard-home-refresh-keeps-widgets",
  guards:
    "홈이 SSE 이벤트마다 통째로 다시 그려져 위젯을 떼었다 붙이고 /api/plugin-data 를 다시 부르고 타이머를 새로 걸던 것(스트리밍 중 초당 수십 번) + 부팅 앞부분에 도착한 업데이트 판정이 아직 안 실린 chat-core.js 의 함수를 불러 ReferenceError 가 나던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── 전제: 부르는 쪽의 모양 — 이 검사는 그 모양으로 부른다 ─────────────────
    const files = ["sse.js", "token-delta.js", "channel-hints.js", "history-render.js", "prompt-options.js", "tabs.js", "activity.js", "view-overview.js"];
    const sites = files.reduce((n, f) => n + dashSource(f).split(REFRESH_CALL).length - 1, 0);
    out.push(assert("전제 — 홈 갱신 요청은 여러 파일이 같은 모양으로 보낸다(이 검사가 그 모양을 그대로 부른다)", sites >= 5, `호출 자리 ${sites}곳`));

    // ── ① 홈 갱신 ────────────────────────────────────────────────────────
    // ★2026-10-20: 홈의 위젯 영역은 없어졌다(위젯 패널로) — 위젯 마운트·조회의 수명은 `widget-panel-lifecycle` 이 본다.
    //  여기 남는 성질: 이벤트마다 오는 «다시 그려라» 를 합치고, 그래도 숫자는 최신이며, 홈이 위젯을 그리지 않는다.
    const clock = makeClock();
    let dataCalls = 0;
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      fetch: async (url: string) => {
        if (url.startsWith("/api/home-widgets")) return jsonResponse({ widgets: [{ id: "w1", type: "weather/forecast", size: "small" }], dataRoutes: ["weather/forecast"] });
        if (url.startsWith("/api/plugin-data/")) {
          dataCalls += 1;
          return jsonResponse({ data: { t: dataCalls } });
        }
        if (url.startsWith("/api/update-availability")) return jsonResponse({ state: "up-to-date" });
        return jsonResponse({}, 404);
      },
      stubs:
        "let evCount = 0; let localChatCount = 0; const setChatPanel = () => {}; let __mounts = 0;" +
        "const widgetHost = { mount: async () => { __mounts += 1; return true; } };",
    });
    const root = dash.document.getElementById("detail-panel");
    dash.run("showOverview()");
    await clock.advance(1_000);
    const intervals0 = clock.intervals();
    const grids = new Set<unknown>();
    for (let i = 0; i < 40; i += 1) {
      if (i === 20) dash.run("evCount = 77");
      dash.run(REFRESH_CALL);
      await clock.advance(25);
      grids.add(root?.querySelector(".quick-grid"));
    }
    await clock.advance(31_000);
    const values = (root?.querySelectorAll(".quick-value") ?? []).map((e) => e.textContent);
    out.push(
      assert(
        "★★홈은 위젯을 그리지도 조회하지도 않는다(위젯은 패널 몫) — 이벤트 40번·30초가 지나도 마운트 0 · 조회 0 · 반복 타이머 불변",
        (dash.run("__mounts") as number) === 0 && dataCalls === 0 && clock.intervals() === intervals0 && !root?.querySelector(".home-widget, .wg-item"),
        `마운트 ${String(dash.run("__mounts"))} · 조회 ${dataCalls} · 반복 타이머 ${intervals0}→${clock.intervals()}`,
      ),
    );
    out.push(
      assert(
        "★요청은 합쳐진다 — 40번이 몇 번의 그리기가 된다(창 250ms)",
        grids.size >= 2 && grids.size <= 8,
        `요약 칸이 바뀐 횟수 ${grids.size}회 / 요청 40회`,
      ),
    );
    out.push(
      assert(
        "★★그래도 **갱신은 된다** — 숫자(이벤트 수)는 최신 값이다(갱신을 통째로 끄면 위 둘은 초록이다)",
        values.includes("77"),
        `요약 값 ${JSON.stringify(values)}`,
      ),
    );
    out.push(assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));

    // ── ② 부팅 경합 — chat-core.js 가 아직 안 온 상태에서 판정이 도착한다 ──────
    const bootClock = makeClock();
    const boot = bootDashboard({
      clock: bootClock,
      i18n: i18nForContext,
      fetch: async (url: string) =>
        url.startsWith("/api/update-availability") ? jsonResponse({ state: "available" }) : jsonResponse({}, 404),
    });
    const initial = boot.run("currentView") as string;
    await bootClock.advance(2_000);
    const chip = boot.document.getElementById("update-chip");
    out.push(
      assert(
        "전제 — 판정이 실제로 도착해 칩이 켜졌다(구독자에게 알림이 갔다)",
        chip !== null && chip.hidden === false,
        `칩 hidden=${String(chip?.hidden)} class="${chip?.className ?? ""}"`,
      ),
    );
    out.push(
      assert(
        "★★부팅 앞부분(chat-core.js 전)에 도착한 판정이 **예외를 내지 않는다** — `currentView` 가 화면 없이 시작한다",
        bootClock.errors.length === 0 && initial === "",
        `초기 currentView=${JSON.stringify(initial)} · 타이머 예외 ${bootClock.errors.length}건 ${bootClock.errors.join(" | ")}`,
      ),
    );
    return out;
  },
};
