/**
 * 회귀: **잡 ⏹ 중지·셸 ⏹ 강제 종료는 먼저 묻는다 — 그리고 두 번 묻지 않는다** (2026-10-09 전체 적대 검토).
 *
 * 사고: 같은 일을 하는 문이 둘인데 확인이 한쪽에만 있었다. 잡 ⋯ 메뉴의 «중지»(danger)는 묻는데 카드의 ⏹ 는
 *  한 번에 실행됐고, 셸 카드의 ⏹ 강제 종료도 한 번에 실행됐다.
 * ★반대 방향 함정: 확인을 `requestCancelJob` 안에 넣으면 메뉴 경로가 **두 번** 묻는다(메뉴 프리미티브가 danger 를
 *  이미 묻는다). 그래서 잡은 버튼에서, 셸은 죽이는 함수에서(셸엔 메뉴 경로가 없고 카드·채팅 칩이 둘 다 그 함수로 온다).
 *  이 검사는 «묻는다» 와 «메뉴는 한 번만» 을 같이 본다.
 *
 * 등급: **동작** — 진짜 background-drawer.js·view-shells.js·context-menu.js 를 부팅 순서대로 싣고(chat-core.js 포함)
 * 버튼을 누른다.
 */
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-stop-asks-first",
  guards:
    "잡 카드 ⏹ 중지·셸 카드 ⏹ 강제 종료가 확인 없이 한 번에 실행되던 것(같은 일을 하는 ⋯ 메뉴 «중지» 는 묻는데) + 그 확인을 넣으며 메뉴 경로가 두 번 묻게 되는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const clock = makeClock();
    const posts: string[] = [];
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      upTo: "virtualization.js",
      allIds: true,
      fetch: async (url: string, init?: { method?: string }) => {
        if (init && init.method === "POST") posts.push(url);
        return jsonResponse({}, 404);
      },
    });
    let asked = 0;
    let answer = false;
    const prompts: string[] = [];
    dash.window.confirm = (msg: string) => {
      asked += 1;
      prompts.push(msg);
      return answer;
    };
    const count = (u: string): number => posts.filter((p) => p === u).length;

    // ── 잡 카드 ⏹ ─────────────────────────────────────────────────────
    dash.run('ensureJobCard("j1", { threadKey: "dashboard:default" })');
    const stop = dash.run('jobCards.get("j1").stopBtnEl') as MElement;
    stop.click();
    await clock.advance(5);
    const jobAskedNo = asked;
    const jobPostsNo = count("/api/cancel-worker");
    answer = true;
    stop.click();
    await clock.advance(5);
    out.push(
      assert(
        "★★잡 카드 ⏹ 는 **묻고**, 취소하면 중지 요청이 안 나간다(확인하면 나간다)",
        jobAskedNo === 1 && jobPostsNo === 0 && asked === 2 && count("/api/cancel-worker") === 1,
        `취소: 물음 ${jobAskedNo} · 요청 ${jobPostsNo} → 확인: 물음 ${asked} · 요청 ${count("/api/cancel-worker")}`,
      ),
    );
    out.push(
      assert(
        "버튼과 ⋯ 메뉴가 **같은 문장**으로 묻는다(«중지 — 계속할까요?»)",
        prompts[0] === dash.run('i18n("ctx.confirm", { what: i18n("bg.stopShort") })'),
        `«${prompts[0] ?? ""}»`,
      ),
    );

    // ── ⋯ 메뉴 «중지» — 한 번만 묻는다 ─────────────────────────────────────
    await clock.advance(5); // 404 → 낙관 표시 되돌림(다시 누를 수 있다)
    const askedBefore = asked;
    const postsBefore = count("/api/cancel-worker");
    dash.run('openMenu("job", { type: "job", targetId: "j1" }, { pos: { x: 10, y: 10 } })');
    const menu = dash.document.querySelector(".ctx-menu");
    const row = menu?.querySelectorAll(".cm-item").find((r) => r.classList.contains("cm-danger"));
    row?.click();
    await clock.advance(5);
    out.push(
      assert(
        "★★⋯ 메뉴 «중지» 는 **한 번만** 묻는다(확인을 requestCancelJob 안에 넣으면 두 번이 된다)",
        row !== undefined && asked - askedBefore === 1 && count("/api/cancel-worker") - postsBefore === 1,
        `메뉴 항목=${String(row !== undefined)} 물음 ${asked - askedBefore}회 · 요청 ${count("/api/cancel-worker") - postsBefore}회`,
      ),
    );

    // ── 셸 ⏹ 강제 종료 ───────────────────────────────────────────────────
    dash.run('shellRegistry.set("s1", { shellId: "s1", status: "running", killable: true, killRequested: false, command: "sleep 9", owner: "bridge" })');
    answer = false;
    const a0 = asked;
    const card = dash.run('buildShellCard(shellRegistry.get("s1"), Date.now())') as MElement;
    card.querySelector(".shell-card-kill")?.click();
    await clock.advance(5);
    const shellAskedNo = asked - a0;
    const shellPostsNo = count("/api/kill-shell");
    answer = true;
    dash.run('requestKillShell("s1")'); // 채팅 칩도 이 함수로 온다
    await clock.advance(5);
    out.push(
      assert(
        "★★셸 ⏹ 강제 종료는 **묻고**, 취소하면 요청이 안 나간다(카드·채팅 칩 모두 같은 함수)",
        shellAskedNo === 1 && shellPostsNo === 0 && asked - a0 === 2 && count("/api/kill-shell") === 1,
        `카드 취소: 물음 ${shellAskedNo} · 요청 ${shellPostsNo} → 확인: 물음 ${asked - a0} · 요청 ${count("/api/kill-shell")}`,
      ),
    );
    out.push(assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));
    return out;
  },
};
