/**
 * 회귀: **컨텍스트 메뉴는 길어도 끝까지 닿고, 위험한 항목은 묻고, 밖에서 온 항목은 코어 동작을 못 부른다**
 * (2026-10-09 전체 적대 검토).
 *
 * ── ① 높이 상한 ─────────────────────────────────────────────────────────
 *  📁 칩 메뉴에 커맨드 30개면 1220px(창 863px) — 아래 항목(«프로젝트 상세 보기»·«연결 해제»)이 창 밖에
 *  있었고 스크롤도 안 됐다. 고침: `.ctx-menu` 를 창 높이로 묶고 안에서 스크롤. 그런데 종전 닫기 규칙이
 *  «스크롤 = 닫기»(캡처)라서 **메뉴 안 스크롤도 메뉴를 닫았다** — 상한만 넣으면 여전히 못 닿는다.
 *  그래서 둘을 같이 본다: CSS 상한 + 안쪽 스크롤은 안 닫힘 + 바깥 스크롤은 여전히 닫힘.
 *
 * ── ② 그물이 0이던 것 ──────────────────────────────────────────────────
 *  danger 확인(취소하면 실행 안 됨) · 외부 기여 항목의 builtin/endpoint 차단 · 하위 메뉴(펼치고 실행).
 *
 * 등급: ①의 기하(실제로 창 안에 들어오나)는 헤드리스 실측(이 수정 때 1400·390 폭)이고, 여기선 **CSS 선언 +
 * 동작**(vm 에서 context-menu.js 를 그대로 싣고 이벤트를 보낸다)을 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootDashboard, DASH_JS, dispatch, jsonResponse, makeClock, makeEvent, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-context-menu-reachable",
  guards:
    "컨텍스트 메뉴에 높이 상한이 없어 항목이 많으면 아래 항목(연결 해제 등)이 창 밖에 남던 것 + 메뉴 안 스크롤도 «바깥 스크롤» 로 보고 닫던 것 + danger 확인·외부 기여 차단·하위 메뉴에 그물이 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① CSS 선언 ─────────────────────────────────────────────────────
    const css = readFileSync(path.join(DASH_JS, "..", "app.css"), "utf8");
    const rules = [...css.matchAll(/(^|\n)\s*\.ctx-menu\s*\{([^}]*)\}/g)].map((m) => m[2] ?? "").join(";");
    const capped = /max-height:\s*calc\(100dvh\s*-\s*\d+px\)/.test(rules);
    const scrolls = /overflow-y:\s*auto/.test(rules);
    const contained = /overscroll-behavior:\s*contain/.test(rules);
    out.push(
      assert(
        "★★`.ctx-menu` 가 창 높이로 묶이고 안에서 스크롤한다 — 끝에서 페이지로 번지지 않는다(번지면 «바깥 스크롤 = 닫기» 에 걸린다)",
        capped && scrolls && contained,
        `max-height(dvh)=${capped} overflow-y:auto=${scrolls} overscroll:contain=${contained}`,
      ),
    );

    // ── ② 동작 — 진짜 context-menu.js ───────────────────────────────────
    const clock = makeClock();
    const posted: string[] = [];
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      fetch: async (url: string, init?: { method?: string }) => {
        if (init && init.method === "POST") posted.push(url);
        if (url === "/api/context-menu-items")
          return jsonResponse({
            items: [
              { id: "x1", type: "probe", label: "ext-builtin", action: { kind: "builtin", handler: "probe.ok" } },
              { id: "x2", type: "probe", label: "ext-endpoint", action: { kind: "endpoint", method: "POST", path: "/api/evil" } },
            ],
          });
        return jsonResponse({}, 404);
      },
      stubs:
        "const __calls = [];" +
        'registerBuiltinHandler("probe.ok", () => { __calls.push("ok"); });' +
        'registerBuiltinHandler("probe.danger", () => { __calls.push("danger"); });' +
        'registerBuiltinHandler("probe.sub", () => { __calls.push("sub"); });' +
        'registerMenuItems("probe", () => [' +
        ' { id: "a", label: "plain", action: { kind: "builtin", handler: "probe.ok" } },' +
        ' { id: "s", label: "folder", children: [{ id: "c", label: "child", action: { kind: "builtin", handler: "probe.sub" } }] },' +
        ' { id: "d", label: "unlink", danger: true, action: { kind: "builtin", handler: "probe.danger" } },' +
        "]);",
    });
    await clock.advance(10); // 외부 기여 목록 도착
    const doc = dash.document;
    const open = (): MElement => {
      dash.run('openMenu("probe", {}, { pos: { x: 20, y: 20 } })');
      return doc.querySelector(".ctx-menu") as MElement;
    };
    const row = (menu: MElement, label: string): MElement | undefined =>
      menu.querySelectorAll(".cm-item").find((r) => r.querySelector(".cm-label")?.textContent === label);
    const calls = (): string[] => [...(dash.run("__calls") as string[])];

    // 안쪽 스크롤 · 바깥 스크롤
    let menu = open();
    dispatch(menu, makeEvent("scroll"));
    const afterInner = menu.isConnected;
    dispatch(doc, makeEvent("scroll"));
    const afterOuter = menu.isConnected;
    out.push(
      assert(
        "★★메뉴 **안** 스크롤은 메뉴를 닫지 않는다 — 닫으면 상한을 넣어도 아래 항목에 영영 못 닿는다",
        afterInner === true,
        `안쪽 스크롤 뒤 열림=${String(afterInner)}`,
      ),
    );
    out.push(
      assert("★바깥(페이지) 스크롤은 여전히 닫는다(위치가 어긋난 메뉴를 남기지 않는다)", afterOuter === false, `바깥 스크롤 뒤 열림=${String(afterOuter)}`),
    );

    // 하위 메뉴 — 펼치고, 부모가 스크롤하면 접히고(줄을 못 따라간다), 자식 실행
    menu = open();
    row(menu, "folder")?.click();
    const sub1 = menu.querySelector(".cm-sub");
    dispatch(menu, makeEvent("scroll"));
    const subAfterScroll = menu.querySelector(".cm-sub");
    const openAfterSubScroll = menu.isConnected;
    row(menu, "folder")?.click();
    const sub2 = menu.querySelector(".cm-sub") as MElement | null;
    const child = sub2 ? row(sub2, "child") : undefined;
    child?.click();
    out.push(
      assert(
        "하위 메뉴가 펼쳐지고, 부모 메뉴가 스크롤하면 접힌다(고정 위치라 줄을 못 따라간다) — 메뉴 자체는 열린 채",
        sub1 !== null && subAfterScroll === null && openAfterSubScroll && calls().includes("sub"),
        `펼침=${String(sub1 !== null)} 스크롤 뒤 하위=${String(subAfterScroll !== null)} 메뉴=${String(openAfterSubScroll)} 자식 실행=${String(calls().includes("sub"))}`,
      ),
    );

    // danger — 취소하면 실행 안 됨, 확인하면 실행
    menu = open();
    dash.window.confirm = () => false;
    row(menu, "unlink")?.click();
    await clock.advance(5);
    const cancelled = !calls().includes("danger");
    const stillOpen = menu.isConnected;
    dash.window.confirm = () => true;
    row(menu, "unlink")?.click();
    await clock.advance(5);
    out.push(
      assert(
        "★danger 항목은 **묻고**, 취소하면 실행하지 않는다(확인하면 실행)",
        cancelled && stillOpen && calls().includes("danger"),
        `취소→실행=${String(!cancelled)} 메뉴 유지=${String(stillOpen)} · 확인→실행=${String(calls().includes("danger"))}`,
      ),
    );

    // 외부 기여 — builtin·endpoint 금지
    const before = calls().filter((c) => c === "ok").length;
    menu = open();
    const ext = row(menu, "ext-builtin");
    ext?.click();
    await clock.advance(5);
    menu = open();
    row(menu, "ext-endpoint")?.click();
    await clock.advance(5);
    const afterExt = calls().filter((c) => c === "ok").length;
    out.push(
      assert(
        "★★밖에서 기여한 항목은 builtin·endpoint 를 **못 부른다**(백엔드가 거르지만 화면도 한 번 더 막는다)",
        ext !== undefined && afterExt === before && !posted.includes("/api/evil"),
        `기여 항목 보임=${String(ext !== undefined)} · builtin 실행 ${afterExt - before}회 · POST ${JSON.stringify(posted)}`,
      ),
    );
    out.push(assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));
    return out;
  },
};
