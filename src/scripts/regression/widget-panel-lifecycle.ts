/**
 * 회귀: **위젯 패널의 수명·순서·자리** (2026-10-20, [설계](../../../docs/decisions/2026-10-20-widget-panel-design.md) §2·§5).
 *
 * 홈의 위젯 영역이 어디서나 열리는 오른쪽 패널로 옮겨오면서 열린 시간이 «홈에 있는 동안» 에서 «패널을 연 동안» 으로 길어졌다.
 * 그래서 지킬 것이 늘었다(아스트라 10-20 회신):
 *  ① 열면 붙이고 닫으면 뗀다(타이머·마운트 누적 없음) · 화면 이동은 다시 마운트하지 않는다
 *  ② 닫은 뒤·다시 연 뒤 도착한 **옛 응답**이 그리지 않는다
 *  ③ 숨은 탭에선 쉬고, 다시 보이면 한 번만 받는다
 *  ④ 끌어서(키보드로) 순서 바꾸기 — 서버가 순열만 받고, 그새 바뀌었으면 최신으로 돌아간다
 *  ⑤ 공간 판정(순수 함수) — 둘 다 열 자리가 없으면 방금 쓴 쪽을 남긴다 · 좁은 화면은 하나만
 *  ⑥ 서버 순서 쓰기 — 순열만 · 안 보이는 항목은 제자리 · 다른 키는 그대로
 *
 * 등급: **동작** — ①~④ 는 실제 대시보드 파일을 `_manifest.json` 순서대로 vm 에 싣고 시계를 손으로 돌린다(`_mini-dom`).
 *  ⑥ 은 진짜 코어 함수로 격리 홈의 설정 파일을 쓴다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bootDashboard, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { reorderHomeWidgets, readHomeWidgets } from "../../core/home-widgets.js";
import { getPaths } from "../../core/paths.js";

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
const deferred = (): Deferred => {
  let resolve: (v: unknown) => void = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

export const check: RegressionCheck = {
  name: "widget-panel-lifecycle",
  guards:
    "위젯 패널: 닫아도 위젯 타이머·구독이 남거나 열 때마다 쌓이는 것 · 닫은 뒤 도착한 옛 응답이 다시 그리는 것 · 숨은 탭에서 계속 조회하는 것 · 끌어 놓은 순서가 비서의 동시 변경을 덮는 것 · 두 패널이 본문을 최소폭 아래로 누르는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const clock = makeClock();
    let layout = {
      widgets: [
        { id: "w1", type: "weather/forecast", size: "small", config: { place: "A" } },
        { id: "w2", type: "running-work/live", size: "wide", config: {} },
        { id: "w3", type: "weather/forecast", size: "small", config: { place: "B" } },
      ],
      dataRoutes: ["weather/forecast"],
    };
    let dataCalls = 0;
    let hold: Deferred | null = null; // 데이터 응답을 붙잡아 «늦은 응답» 을 만든다
    const posts: unknown[] = [];
    let orderStatus = 200;
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      ids: ["widget-panel", "wg-list", "wg-toggle", "wg-close", "wg-backdrop", "sidebar", "toast"],
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === "/api/home-widgets/order") {
          posts.push(JSON.parse(String(init?.body ?? "{}")));
          return jsonResponse(orderStatus === 200 ? { ok: true, changed: true } : { ok: false, conflict: true }, orderStatus);
        }
        if (url.startsWith("/api/home-widgets")) return jsonResponse(layout);
        if (url.startsWith("/api/plugin-data/")) {
          dataCalls += 1;
          const n = dataCalls;
          if (hold !== null) await hold.promise;
          return jsonResponse({ data: { n } });
        }
        if (url.startsWith("/api/update-availability")) return jsonResponse({ state: "up-to-date" });
        return jsonResponse({}, 404);
      },
      stubs:
        "let evCount = 0; let localChatCount = 0; const setChatPanel = () => {}; let __mounts = [];" +
        "const widgetHost = { mount: async (el, att) => { __mounts.push(att.widget + ':' + JSON.stringify(att.data)); return true; } };",
    });
    const doc = dash.document;
    const list = doc.getElementById("wg-list");
    const mounts = (): string[] => dash.run("__mounts") as string[];
    const items = (): string[] => (list?.querySelectorAll(".wg-item") ?? []).map((e) => e.dataset.id as string);
    const base = clock.intervals();

    // ── ① 열기 → 마운트 · 화면 이동 → 그대로 · 닫기 → 회수 ─────────────────────
    dash.run("widgetPanel.open()");
    await clock.advance(1_000);
    const afterOpen = mounts().length;
    const openTimers = clock.intervals() - base;
    dash.run('setActiveNav("chat"); setActiveNav("settings"); setActiveNav("overview")');
    await clock.advance(1_000);
    out.push(
      assert(
        "★열면 위젯이 붙고(값 받는 위젯은 값을 받은 뒤) 조회 타이머가 한 벌 걸린다 — 값 위젯 2 + 배치 1",
        afterOpen === 3 && openTimers === 3 && items().join() === "w1,w2,w3",
        `마운트 ${afterOpen} · 타이머 ${openTimers} · 목록 ${items().join()}`,
      ),
    );
    out.push(
      assert(
        "★★화면을 옮겨도(채팅·설정·홈) 다시 마운트하지 않는다 — 패널은 셸에 있다",
        mounts().length === afterOpen,
        `마운트 ${afterOpen}→${mounts().length}`,
      ),
    );
    dash.run("widgetPanel.close()");
    await clock.advance(100);
    out.push(
      assert(
        "★닫으면 목록을 DOM 에서 떼고(→ 호스트가 위젯 회수) 타이머를 전부 푼다",
        items().length === 0 && clock.intervals() === base,
        `남은 위젯 ${items().length} · 타이머 ${clock.intervals() - base}`,
      ),
    );
    for (let i = 0; i < 3; i += 1) { dash.run("widgetPanel.open()"); await clock.advance(200); dash.run("widgetPanel.close()"); await clock.advance(200); }
    dash.run("widgetPanel.open()");
    await clock.advance(1_000);
    out.push(
      assert(
        "★열고 닫기를 반복해도 타이머는 **한 벌** — 쌓이지 않는다",
        clock.intervals() - base === 3,
        `타이머 ${clock.intervals() - base}`,
      ),
    );

    // ── ② 늦은 응답 ───────────────────────────────────────────────────────
    dash.run("widgetPanel.close()");
    hold = deferred();
    const callsBefore = dataCalls;
    dash.run("widgetPanel.open()"); // 값 요청 둘이 떠난다(붙잡힘)
    await clock.advance(50);
    dash.run("widgetPanel.close()");
    const m0 = mounts().length;
    hold.resolve(null);
    await clock.advance(200);
    out.push(
      assert(
        "★★닫은 뒤 도착한 응답은 그리지 않는다 — 닫힌 패널에 위젯이 다시 붙지 않는다",
        dataCalls > callsBefore && mounts().length === m0 && items().length === 0,
        `요청 ${dataCalls - callsBefore} · 마운트 ${m0}→${mounts().length} · 목록 ${items().length}`,
      ),
    );
    hold = deferred();
    dash.run("widgetPanel.open()");
    await clock.advance(50);
    const oldHold = hold;
    dash.run("widgetPanel.close()");
    hold = null;
    dash.run("widgetPanel.open()"); // 새 세대 — 바로 응답
    await clock.advance(500);
    const fresh = mounts().slice(m0);
    oldHold.resolve(null); // 옛 세대 응답이 이제 도착
    await clock.advance(500);
    const afterOld = mounts().slice(m0);
    out.push(
      assert(
        "★★닫기→다시 열기 뒤 도착한 **옛 응답**이 새 인스턴스를 덮지 않는다(세대 판정)",
        afterOld.length === fresh.length,
        `새 세대 마운트 ${fresh.length} → 옛 응답 도착 뒤 ${afterOld.length}`,
      ),
    );

    // ── ③ 숨은 탭 ─────────────────────────────────────────────────────────
    (doc as unknown as { hidden: boolean }).hidden = true;
    dispatch(doc, makeEvent("visibilitychange"));
    const hiddenCalls = dataCalls;
    await clock.advance(16 * 60 * 1000); // 5분 주기 세 번 넘게
    const timersHidden = clock.intervals() - base;
    out.push(
      assert(
        "★숨은 탭에선 조회를 쉰다 — 16분 동안 데이터 요청 0 · 타이머 0",
        dataCalls === hiddenCalls && timersHidden === 0,
        `요청 ${dataCalls - hiddenCalls} · 타이머 ${timersHidden}`,
      ),
    );
    (doc as unknown as { hidden: boolean }).hidden = false;
    dispatch(doc, makeEvent("visibilitychange"));
    await clock.advance(500);
    out.push(
      assert(
        "★다시 보이면 **한 번** 받는다 — 놓친 주기를 몰아서 돌리지 않는다(값 위젯 2개 = 2번) · 타이머 한 벌로 복귀",
        dataCalls - hiddenCalls === 2 && clock.intervals() - base === 3,
        `요청 ${dataCalls - hiddenCalls} · 타이머 ${clock.intervals() - base}`,
      ),
    );

    // ── ④ 순서 바꾸기(키보드 ↓ — 끌기와 같은 저장 경로) ─────────────────────────
    const press = (id: string, key: string): void => {
      const h = list?.querySelector('.wg-item[data-id="' + id + '"] .wg-handle');
      h?.dispatchEvent(makeEvent("keydown", { key, bubbles: true, target: h }));
    };
    const mPress = mounts().length;
    press("w1", "ArrowDown");
    await clock.advance(500);
    out.push(
      assert(
        "★손잡이 ↓ 로 옮기면 화면이 바뀌고 **id 순서**를 서버에 보낸다 · 저장 성공에 목록을 다시 그리지 않는다(재마운트 0)",
        items().join() === "w2,w1,w3" && JSON.stringify(posts.at(-1)) === JSON.stringify({ order: ["w2", "w1", "w3"] }) && mounts().length === mPress,
        `화면 ${items().join()} · 보냄 ${JSON.stringify(posts.at(-1))} · 마운트 ${mPress}→${mounts().length}`,
      ),
    );
    layout = { ...layout, widgets: [layout.widgets[1]!, layout.widgets[0]!, layout.widgets[2]!] }; // 서버가 받아 쓴 순서
    const m1 = mounts().length;
    await clock.advance(62_000); // 배치 조회 두 번 — 서버도 같은 순서라고 답한다
    out.push(
      assert(
        "저장에 성공한 순서는 다시 그리지 않는다(서버가 같은 순서를 돌려줘도 재마운트 0)",
        mounts().length === m1 && items().join() === "w2,w1,w3",
        `마운트 ${m1}→${mounts().length} · 화면 ${items().join()}`,
      ),
    );
    orderStatus = 409; // 그새 비서가 바꿨다 — 서버는 거절하고 지금 순서는 w2,w1,w3
    press("w3", "ArrowUp");
    await clock.advance(500);
    out.push(
      assert(
        "★★그새 목록이 바뀌었으면(409) 덮어쓰지 않고 **서버 목록으로** 돌아간다 + 알린다",
        items().join() === "w2,w1,w3" && (doc.getElementById("toast")?.textContent ?? "") === i18nForContext("wg.reorderConflict"),
        `화면 ${items().join()} · 알림 «${doc.getElementById("toast")?.textContent ?? ""}»`,
      ),
    );
    // ★끄는 사이 목록이 다시 그려지면(배치 조회) 잡고 있던 노드는 떨어져 있다 — 그 끌기는 버린다(레드팀 10-20: 같은 위젯이 둘·id 두 번).
    orderStatus = 200;
    const postsBefore = posts.length;
    const grab = list?.querySelector('.wg-item[data-id="w3"] .wg-handle');
    grab?.dispatchEvent(makeEvent("pointerdown", { bubbles: true, target: grab, pointerId: 1, clientY: 0 }));
    layout = { ...layout, widgets: [...layout.widgets].reverse() }; // 비서가 그새 순서를 바꿨다
    await clock.advance(31_000); // 배치 조회 → 다시 그림(잡은 노드는 떨어짐)
    list?.dispatchEvent(makeEvent("pointermove", { bubbles: true, clientY: -1 })); // 맨 앞 «앞에» — 떨어진 노드가 새 목록에 끼어드는 쪽
    list?.dispatchEvent(makeEvent("pointerup", { bubbles: true }));
    await clock.advance(500);
    const ids = items();
    out.push(
      assert(
        "★끌기 도중 목록이 다시 그려지면 그 끌기는 버린다 — 저장 요청 0 · 같은 위젯이 둘로 늘지 않는다",
        posts.length === postsBefore && new Set(ids).size === ids.length && ids.length === 3,
        `저장 ${posts.length - postsBefore} · 화면 ${ids.join()}`,
      ),
    );
    out.push(assert("그 과정에 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));

    // ★자리가 모자라 닫힌 것은 사용자가 닫은 게 아니다 — «열려 있었다» 기억을 지우지 않는다(레드팀 10-20: 부팅 때 저장값이 0 으로).
    dash.window.innerWidth = 800; // 좁은 화면 = 서랍 하나
    dash.run(`sidePanels.register("bg", { el: document.getElementById("sidebar"), cls: "bg-open", close: () => document.body.classList.remove("bg-open") }); document.body.classList.add("bg-open"); sidePanels.used("bg"); 1`);
    const wgAfterSpace = { open: dash.run("widgetPanel.isOpen()") as boolean, remembered: dash.run('localStorage.getItem("dash.wgOpen.v1")') as string };
    dash.run("widgetPanel.open(); widgetPanel.close()");
    const wgAfterUser = dash.run('localStorage.getItem("dash.wgOpen.v1")') as string;
    dash.window.innerWidth = 1280;
    out.push(
      assert(
        "★자리 때문에 닫히면 기억은 «열림» 그대로 — 사용자가 직접 닫으면 «닫힘» 으로",
        wgAfterSpace.open === false && wgAfterSpace.remembered === "1" && wgAfterUser === "0",
        JSON.stringify({ wgAfterSpace, wgAfterUser }),
      ),
    );

    // ── ⑤ 공간 판정(순수) ───────────────────────────────────────────────────
    const close = (o: Record<string, unknown>): unknown => dash.run(`sidePanelToClose(${JSON.stringify(o)})`);
    const both = (vw: number, last: string, narrow = false) =>
      close({ narrow, viewport: vw, sidebar: 240, bg: { open: true, w: 380 }, wg: { open: true, w: 340 }, last });
    const cases = {
      roomy: both(1600, "wg"), // 1600-240-720 = 640 ≥ 560
      tightKeepWg: both(1300, "wg"), // 340 < 560 → bg 닫음
      tightKeepBg: both(1300, "bg"),
      narrow: close({ narrow: true, viewport: 900, sidebar: 0, bg: { open: true, w: 100 }, wg: { open: true, w: 100 }, last: "bg" }), // 폭이 남아도 서랍은 하나
      oneOpen: close({ narrow: false, viewport: 900, sidebar: 240, bg: { open: true, w: 380 }, wg: { open: false, w: 340 }, last: "bg" }),
      edge: both(240 + 720 + 560, "wg"), // 딱 최소폭 = 남긴다
    };
    out.push(
      assert(
        "★공간 판정: 자리가 있으면 둘 다 · 모자라면 **방금 쓴 쪽을 남기고** 다른 쪽을 닫는다 · 좁은 화면은 하나만 · 하나만 열렸으면 손대지 않는다",
        cases.roomy === null && cases.tightKeepWg === "bg" && cases.tightKeepBg === "wg" && cases.narrow === "wg" && cases.oneOpen === null && cases.edge === null,
        JSON.stringify(cases),
      ),
    );

    // ── ⑥ 서버 순서 쓰기(진짜 코어 함수) ────────────────────────────────────
    const settings = getPaths().settings;
    const saved = existsSync(settings) ? readFileSync(settings, "utf8") : null;
    try {
      const KNOWN = new Set(["weather", "running-work"]);
      const raw = [
        { id: "a", type: "weather/forecast" },
        { id: "z", type: "gone/thing" }, // 꺼진 플러그인 — 안 보임
        { id: "b", type: "running-work/live" },
        { id: "c", type: "weather/forecast", config: { place: "B" } },
      ];
      const put = (): void => writeFileSync(settings, JSON.stringify({ theme: "dusk", dashboard: { home: { widgets: raw, seeded: ["running-work/live"] } } }, null, 2), "utf8");
      put();
      const ok = reorderHomeWidgets(["c", "a", "b"], KNOWN);
      const file = JSON.parse(readFileSync(settings, "utf8")) as { theme: string; dashboard: { home: { widgets: Array<{ id: string; config?: unknown }>; seeded: string[] } } };
      out.push(
        assert(
          "★★순열이면 쓴다 — 보이는 것들만 새 순서로, 안 보이는 항목(꺼진 플러그인)은 **제자리** · config·seeded·다른 키 그대로",
          ok.ok === true &&
            file.dashboard.home.widgets.map((w) => w.id).join() === "c,z,a,b" &&
            JSON.stringify(file.dashboard.home.widgets[0]?.config) === JSON.stringify({ place: "B" }) &&
            file.dashboard.home.seeded.join() === "running-work/live" &&
            file.theme === "dusk" &&
            readHomeWidgets(KNOWN).widgets.map((w) => w.id).join() === "c,a,b",
          JSON.stringify({ ok, ids: file.dashboard.home.widgets.map((w) => w.id), theme: file.theme }),
        ),
      );
      put();
      const missing = reorderHomeWidgets(["c", "a"], KNOWN);
      const extra = reorderHomeWidgets(["c", "a", "b", "x"], KNOWN);
      const dup = reorderHomeWidgets(["c", "c", "a"], KNOWN);
      const hidden = reorderHomeWidgets(["z", "a", "b"], KNOWN); // 안 보이는 id 로 바꿔치기
      const untouched = JSON.parse(readFileSync(settings, "utf8")).dashboard.home.widgets.map((w: { id: string }) => w.id).join();
      out.push(
        assert(
          "★순열이 아니면 안 쓴다 — 빠짐·남음·안 보이는 id 는 «그새 바뀜»(409), 중복은 잘못된 요청(400) · 파일 그대로",
          missing.ok === false && missing.conflict === true &&
            extra.ok === false && extra.conflict === true &&
            hidden.ok === false && hidden.conflict === true &&
            dup.ok === false && dup.conflict === false &&
            untouched === "a,z,b,c",
          JSON.stringify({ missing, extra, dup, hidden, untouched }),
        ),
      );
      // ★같은 id 의 **무효** 항목이 앞에 있어도 정규화가 고른 그 항목의 자리를 바꾼다(레드팀 10-20 P4 — 종전엔 «성공·변경 없음» 인데 그대로).
      writeFileSync(settings, JSON.stringify({ dashboard: { home: { widgets: [{ id: "a", type: "weather/forecast", size: "huge" }, { id: "b", type: "running-work/live" }, { id: "a", type: "weather/forecast" }] } } }), "utf8");
      const dupInvalid = reorderHomeWidgets(["a", "b"], KNOWN);
      const dupOrder = readHomeWidgets(KNOWN).widgets.map((w) => w.id).join();
      // ★거절·변경 없음이면 파일을 다시 쓰지 않는다(레드팀 P5 — 서식·mtime 이 바뀌었다).
      const compact = JSON.stringify({ theme: "dusk", dashboard: { home: { widgets: [{ id: "a", type: "weather/forecast" }, { id: "b", type: "running-work/live" }] } } });
      writeFileSync(settings, compact, "utf8");
      const refused = reorderHomeWidgets(["a"], KNOWN);
      const same = reorderHomeWidgets(["a", "b"], KNOWN);
      const untouchedBytes = readFileSync(settings, "utf8") === compact;
      out.push(
        assert(
          "★정규화가 고른 항목의 자리로 바꾼다(앞의 무효 동명 항목에 속지 않는다) · 거절·변경 없음은 파일을 안 건드린다",
          dupInvalid.ok === true && dupInvalid.changed === true && dupOrder === "a,b" &&
            refused.ok === false && same.ok === true && same.changed === false && untouchedBytes,
          JSON.stringify({ dupInvalid, dupOrder, refused, same, untouchedBytes }),
        ),
      );
    } finally {
      if (saved === null) writeFileSync(settings, "{}\n", "utf8");
      else writeFileSync(settings, saved, "utf8");
    }
    return out;
  },
};
