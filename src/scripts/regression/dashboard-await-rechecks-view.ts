/**
 * 회귀: **기다린 뒤에는 «아직 그 화면인가» 부터 본다** (2026-10-09 전체 적대 검토).
 *
 * 사고: `#detail-panel` 은 모든 뷰가 같이 쓴다. 그런데 기다렸다 그리는 자리 몇 곳이 돌아와서 확인을 안 했다 —
 *  · `showSettings` — `/api/suggestion` 을 기다린 뒤 그대로 그렸다. 실측: 설정을 누르고 0.3초 뒤 모델로 가면
 *    nav 는 모델인데 화면은 설정.
 *  · 설정 토글 — 저장을 기다린 뒤 설정 행을 다시 그렸다(그 사이 옮겼으면 그 화면을 덮는다).
 *  · `openProjectDetail` — 성공 경로만 선택을 확인했고 **오류 경로는 아무것도 안 봐서**, 다른 프로젝트를
 *    골랐거나 다른 화면으로 갔어도 오류 문구가 덮었다.
 *  `renderPluginsView` 는 이미 `currentView` 를 본다 — 같은 규칙을 맞췄다.
 *
 * 등급: **동작** — 진짜 view-models.js·view-projects.js 를 부팅 순서대로 싣고, 응답을 손으로 늦게 돌려준다.
 */
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

type Gate = { url: string; open: (body: unknown, status?: number) => void };

const boot = () => {
  const clock = makeClock();
  const gates: Gate[] = [];
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    ids: ["projects-grid", "projects-search"],
    fetch: (url: string) =>
      new Promise((resolve) => {
        gates.push({ url, open: (body, status = 200) => resolve(jsonResponse(body, status)) });
      }),
    stubs: "const setChatPanel = () => {};",
  });
  /** 그 URL 로 나간 요청 중 **가장 오래된 것**에 답한다. */
  const answer = (prefix: string, body: unknown, status = 200): boolean => {
    const i = gates.findIndex((g) => g.url.startsWith(prefix));
    if (i < 0) return false;
    const [g] = gates.splice(i, 1);
    g?.open(body, status);
    return true;
  };
  const root = dash.document.getElementById("detail-panel") as MElement;
  return { clock, dash, answer, root };
};

export const check: RegressionCheck = {
  name: "dashboard-await-rechecks-view",
  guards:
    "설정·프로젝트 상세가 응답을 기다린 뒤 «아직 그 화면인가» 를 안 봐서, 그 사이 옮긴 화면(모델 등)을 덮던 것 — 설정을 누르고 0.3초 뒤 모델로 가면 nav 는 모델인데 화면은 설정이었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── 설정 → (기다리는 중) → 모델 ───────────────────────────────────────
    {
      const { clock, dash, answer, root } = boot();
      dash.run("showSettings()");
      await clock.advance(5);
      dash.run("showModels()");
      const answered = answer("/api/suggestion", { enabled: true });
      await clock.advance(5);
      const view = dash.run("currentView") as string;
      const models = root.querySelector(".models-shell") !== null;
      const settingsRows = root.querySelectorAll(".settings-row").length;
      out.push(
        assert(
          "★★설정을 누르고 응답 전에 모델로 가면, 늦은 응답이 모델 화면을 **덮지 않는다**",
          answered && view === "models" && models && settingsRows === 0,
          `currentView=${view} 모델 화면=${String(models)} 설정 행 ${settingsRows}개`,
        ),
      );
    }

    // ── 설정을 두 번 — 늦게 온 첫 응답이 새 그림을 덮지 않는다 ─────────────────
    {
      const clock = makeClock();
      const gates: Array<(b: unknown) => void> = [];
      const dash = bootDashboard({
        clock,
        i18n: i18nForContext,
        fetch: (url: string) =>
          url.startsWith("/api/suggestion")
            ? new Promise((resolve) => gates.push((b) => resolve(jsonResponse(b))))
            : Promise.resolve(jsonResponse({}, 404)),
        stubs: "const setChatPanel = () => {};",
      });
      const root = dash.document.getElementById("detail-panel") as MElement;
      dash.run("showSettings()");
      await clock.advance(5);
      dash.run("showSettings()");
      await clock.advance(5);
      gates[1]?.({ enabled: false }); // 새 요청: 꺼짐
      await clock.advance(5);
      gates[0]?.({ enabled: true }); // 옛 요청: 켜짐(늦게 도착)
      await clock.advance(5);
      const toggle = root.querySelector(".settings-row .settings-toggle");
      const on = toggle?.classList.contains("on") ?? null;
      out.push(
        assert(
          "★설정을 두 번 눌렀을 때 **늦게 온 옛 응답**이 새 그림을 덮지 않는다(요청 번호)",
          gates.length === 2 && on === false,
          `요청 ${gates.length}개 · 최종 토글 on=${String(on)} (새 응답=꺼짐)`,
        ),
      );
    }

    // ── 설정 토글 저장 → (기다리는 중) → 모델 ───────────────────────────────
    {
      const { clock, dash, answer, root } = boot();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/suggestion", { enabled: true });
      await clock.advance(5);
      root.querySelector(".settings-row .settings-toggle")?.click();
      await clock.advance(5);
      dash.run("showModels()");
      const answered = answer("/api/set-suggestion", { ok: true });
      await clock.advance(5);
      const models = root.querySelector(".models-shell") !== null;
      out.push(
        assert(
          "★설정 토글 저장을 기다리는 사이 모델로 가면, 저장 응답이 설정 행을 다시 그려 덮지 않는다",
          answered && models && root.querySelectorAll(".settings-row").length === 0,
          `저장 응답=${String(answered)} 모델 화면=${String(models)} 설정 행 ${root.querySelectorAll(".settings-row").length}개`,
        ),
      );
    }

    // ── 프로젝트 상세 오류 경로 ────────────────────────────────────────────
    {
      const { clock, dash, answer, root } = boot();
      dash.run("showProjects()");
      await clock.advance(5);
      dash.run('openProjectDetail("/p/a")');
      await clock.advance(5);
      dash.run("showModels()");
      const answered = answer("/api/projects/detail", { error: "boom" }, 500);
      await clock.advance(5);
      const text = root.textContent;
      out.push(
        assert(
          "★★상세를 기다리는 사이 다른 화면으로 가면, **오류 응답**이 그 화면을 덮지 않는다(종전엔 오류 경로가 아무것도 안 봤다)",
          answered && root.querySelector(".models-shell") !== null && !text.includes("boom"),
          `모델 화면=${String(root.querySelector(".models-shell") !== null)} 오류 문구 섞임=${String(text.includes("boom"))}`,
        ),
      );
    }
    {
      const { clock, dash, answer, root } = boot();
      dash.run("showProjects()");
      await clock.advance(5);
      dash.run('openProjectDetail("/p/a")');
      await clock.advance(5);
      dash.run('openProjectDetail("/p/b")');
      await clock.advance(5);
      // b 가 먼저 «없음», 그다음 a 의 늦은 실패.
      const gb = answer("/api/projects/detail?path=%2Fp%2Fb", { error: "missing-b" }, 404);
      await clock.advance(5);
      const ga = answer("/api/projects/detail?path=%2Fp%2Fa", { error: "late-a" }, 500);
      await clock.advance(5);
      const text = root.textContent;
      out.push(
        assert(
          "★다른 프로젝트를 고른 뒤 **이전 프로젝트의 늦은 실패**가 지금 상세를 덮지 않는다",
          gb && ga && !text.includes("late-a"),
          `지금 패널 «${text.slice(0, 80)}»`,
        ),
      );
    }
    return out;
  },
};
