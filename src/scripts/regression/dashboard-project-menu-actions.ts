/**
 * 회귀: **대시보드 📁 메뉴가 서버의 메뉴 목록을 그린다** — 자기 커맨드 → «공통» 구획 → 빌트인 동작(서버 표 순서), 동작은 전용 처리기 또는
 * 서버 슬래시로(2026-11-03 설계 §2.3·§7-⑤·§7-⑧ 두 채널 표현).
 *
 * 지키는 것: detail·folder·unlink 가 각 전용 처리기로(지금 동작 그대로 — folder 는 `/api/open-path` 1회, 확인 없음) · `danger` 는 `window.confirm`
 *  을 먼저(취소면 요청 0) · 전용 처리기 없는 동작 id 는 서버가 준 슬래시를 `/api/messages` 로 1회 · 공통·플러그인 커맨드 클릭은 `/project run` 1회.
 * ★처리기가 붙인 위젯 카드가 채팅에 그려지는 것은 기존 `widget-host-mounts-and-cleans` 가 지킨다(같은 `postCard` 첨부 경로) — 여기선 메뉴까지.
 *
 * 등급: **동작** — 진짜 context-menu.js·view-projects.js·session-projects.js 를 vm 에서(_mini-dom).
 */
import { bootDashboard, dashSource, jsonResponse, makeClock } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const PROJECT = {
  name: "pa",
  path: "/p/pa",
  exists: true,
  registered: true,
  description: null,
  commands: [
    { name: "own1", description: "", run: false, common: false, source: "project" },
    { name: "cm1", description: "공통 실행", run: true, common: true, source: "user" },
    { name: "pa1", description: "보드", run: true, common: true, source: "plugin", pluginId: "px" },
  ],
  actions: [
    { id: "detail", icon: "📄", labelKey: "sproj.openDetail", value: "/project show pa" },
    { id: "folder", icon: "📂", labelKey: "proj.folder.open", value: "/project folder pa" },
    { id: "unlink", icon: "⛓", labelKey: "sproj.unlink", value: "/project unlink pa", danger: true, confirmKey: "sproj.unlinkConfirm" },
    { id: "zzz", icon: "🧪", labelKey: "sproj.openDetail", value: "/project zzz pa" },
  ],
};

export const check: RegressionCheck = {
  name: "dashboard-project-menu-actions",
  guards:
    "📁 메뉴의 빌트인 항목을 대시보드가 손으로 적어 텔레그램과 목록이 갈리던 것 — 그리고 서버 목록으로 바꾸며 폴더 열기·연결 해제가 전용 처리기(즉시·확인)를 잃거나, 처리기 없는 새 동작이 아무 일도 안 하는 것",
  run: async (): Promise<Assertion[]> => {
    const clock = makeClock();
    const reqs: Array<{ url: string; body: unknown }> = [];
    const confirms: string[] = [];
    let confirmAnswer = false;
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      width: 1400,
      ids: ["chat-projects", "projects-grid", "projects-search", "wb-detail-back"],
      fetch: async (url: string, init?: { body?: string }) => {
        reqs.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
        if (url.startsWith("/api/session-projects?")) return jsonResponse({ linked: [PROJECT], available: [] });
        return jsonResponse({ ok: true });
      },
      stubs:
        "const setChatPanel = () => {};" +
        "const applyView = () => true;",
    });
    (dash.window as { confirm?: (m: string) => boolean }).confirm = (m: string) => { confirms.push(m); return confirmAnswer; };
    dash.run(dashSource("session-projects.js"), "session-projects.js");
    await clock.advance(10);
    const ctx = { label: "pa", targetId: "/p/pa", project: PROJECT, path: "/p/pa" };
    (dash.ctx as { __ctx?: unknown }).__ctx = ctx;
    const items = dash.run('[...menuProviders.get("sessionProject")].flatMap((f) => f(__ctx))') as Array<{
      id: string; label: string; icon?: string; header?: boolean; danger?: boolean; confirm?: string; children?: unknown[];
    }>;
    const ids = items.map((i) => i.id);
    const click = async (id: string): Promise<Array<{ url: string; body: unknown }>> => {
      reqs.length = 0;
      (dash.ctx as { __item?: unknown }).__item = items.find((i) => i.id === id);
      await dash.run("runMenuItem(__item, __ctx)");
      await clock.advance(10);
      return reqs.filter((r) => !r.url.startsWith("/api/session-projects?") && !r.url.startsWith("/api/projects"));
    };
    const posted = (rs: Array<{ url: string; body: unknown }>, url: string) => rs.filter((r) => r.url === url);

    const folder = await click("act:folder");
    const folderConfirms = confirms.length;
    confirmAnswer = false;
    const unlinkCancel = await click("act:unlink");
    const cancelConfirm = confirms.at(-1) ?? "";
    confirmAnswer = true;
    const unlinkOk = await click("act:unlink");
    const zzz = await click("act:zzz");
    const plugCmd = await click("ccmd:pa1");
    reqs.length = 0;
    (dash.ctx as { __item?: unknown }).__item = items.find((i) => i.id === "act:detail");
    await dash.run("runMenuItem(__item, __ctx)");
    await clock.advance(10);
    const detailFetched = reqs.some((r) => r.url.startsWith("/api/projects/detail"));
    const plugLabel = items.find((i) => i.id === "ccmd:pa1");

    return [
      assert(
        "★메뉴 순서: 자기 커맨드 → «공통» 머리 → 공통 커맨드 → 서버 동작(detail·folder·unlink·zzz 순)",
        JSON.stringify(ids) === JSON.stringify(["cmd:own1", "common-head", "ccmd:cm1", "ccmd:pa1", "act:detail", "act:folder", "act:unlink", "act:zzz"]),
        ids,
      ),
      assert("플러그인 공통은 ▶·«🧩px» 꼬리(비서 없이 돈다 = 서버 run 플래그)", plugLabel?.icon === "▶" && plugLabel.label === "/pa1 · 🧩px", plugLabel),
      assert(
        "★folder → 전용 처리기(/api/open-path, 그 경로) 정확히 1회 · 확인 없음",
        posted(folder, "/api/open-path").length === 1 && JSON.stringify(posted(folder, "/api/open-path")[0]!.body) === JSON.stringify({ path: "/p/pa" }) &&
          folder.length === 1 && folderConfirms === 0,
        { folder, folderConfirms },
      ),
      assert(
        "★unlink(danger) → window.confirm 먼저(문구 = sproj.unlinkConfirm) · 취소면 요청 0 · 확인이면 전용 처리기 POST 1회",
        unlinkCancel.length === 0 && cancelConfirm === i18nForContext("sproj.unlinkConfirm", { name: "pa" }) &&
          posted(unlinkOk, "/api/session-projects").length === 1 && (posted(unlinkOk, "/api/session-projects")[0]!.body as { action?: string }).action === "unlink",
        { unlinkCancel, cancelConfirm, unlinkOk },
      ),
      assert(
        "★전용 처리기 없는 동작 id → 서버가 준 슬래시(value)를 /api/messages 로 1회",
        zzz.length === 1 && zzz[0]!.url === "/api/messages" && (zzz[0]!.body as { text?: string }).text === "/project zzz pa",
        zzz,
      ),
      assert(
        "⑧ 플러그인 공통 커맨드 클릭 → /api/messages 에 /project run pa pa1 1회",
        plugCmd.length === 1 && (plugCmd[0]!.body as { text?: string }).text === "/project run pa pa1",
        plugCmd,
      ),
      assert("detail → 전용 처리기(프로젝트 화면 상세 요청)", detailFetched, reqs.map((r) => r.url)),
      assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"),
    ];
  },
};
