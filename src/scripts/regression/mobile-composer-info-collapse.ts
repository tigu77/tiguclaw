/**
 * 회귀: **입력창 위 정보를 한 번에 접는다 — 숨기기만 한다** (2026-10-24 사용자: «하단입력 필드 위 정보들을
 * 한번에 접었다 폈다 할 수 있으면 어떨까?» → 구현 승인 «어 그대로 진행하면 되겠어» · 갱신 3 «데스크탑이든 어디든 다같이»). 설계·결정은
 * `docs/decisions/2026-10-24-mobile-composer-info-collapse.md`.
 *
 * 지키는 것 — 진짜 대시보드 파일(index.html 의 `#chat` 마크업 그대로 · reply.js · session-projects.js · chat-send.js ·
 * view-projects.js · background-drawer.js · axis1-options.js · mobile-nav.js)을 미니 DOM 에 올리고 **토글 버튼을 누른다**:
 *  ① 처음 = 펼침(저장값 없음) · 누르면 `#chat.info-collapsed`·`aria-expanded`·저장값이 같이 바뀐다 · 재로드 시 복원 ·
 *     저장소가 던지면 펼침
 *  ② 상태 보존 — 답글·첨부 2·입력창 `#태그` 글자·연결 프로젝트가 있는 채 접고 펴도 요청 0 · 입력창 값 불변 ·
 *     **보내는 payload 가 접기 전과 같다**
 *  ③ 접힌 동안의 변화가 배지로 따라온다(펼치지 않는다) — 답글 취소·첨부 제거·알약 켜짐/꺼짐
 *  ④ 펼친 뒤 기존 조작 — 답글 ✕ · 첨부 ✕ · 태그 칩(입력창 삽입) · 태그 줄 자체 토글(`tgctx_expanded` 는 따로 산다)
 *  ⑤ 1초 진행 tick·셸 알약 주기 재대입으로 배지를 **다시 쓰지 않는다** · 진행 표시 판정은 접힘을 바꾸지 않는다
 *  ⑥ 숨김 CSS 묶음 == 토글 `aria-controls` == 숨기는 줄이 실제 `#chat` 의 직계 자식(두 곳에 적힐 수밖에 없어 검사로 묶는다) ·
 *     (갱신 3) 줄 순서 — 답글 줄은 입력폼 바로 앞, 작업 알약 둘은 `#chat-work` 한 줄 묶음
 *  ⑦ 입력창 높이가 바뀌면(모바일) 바닥을 따라가던 중일 때만 바닥을 다시 잡는다 — 헤드리스 실측: 펼치기 +64px 에 마지막
 *     메시지 28px 가림(그동안 알약·답글은 메시지 아래 여백 36px 가 가려 줬다). (갱신 3) **여러 차례** 바뀌어도 매번
 *     (관측자 대역이 끊긴 관측자엔 통지 안 함 — 독립 사냥 N1) · 폭은 그때그때 판정(데스크톱→모바일 전환 — 독립 사냥 M1)
 *  ⑧ 진행 표시(`#chat-status`)는 요약 상자 맨 앞 — 데스크톱은 그 상자가 `display:contents` 라 폼 아래 그대로, 모바일은 맨 위
 *  ⑨ 펼침이면 토글은 패널 우상단, 데스크톱 접힘은 토글 자신이 맨 위 한 줄 — **모든 폭**
 *     (사용자 «데스크탑이든 어디든 다같이»). 진행 표시 자리만 폭별(모바일 맨 위 · 데스크톱 폼 아래). 토글은 큰 ▾ 하나
 *     (접히면 180° 회전, 낱말 없음 — 사용자 «큰 화살표를 아래로 · 입력 정보 화살표보다 큰 윗화살표»)
 *  ⑩ (결정 문서 §13) 데스크톱(>900)에서 접힌 채 사용자가 **새로** 답글 대상을 지정하거나 첨부를 붙이면 화면을 펼친다 —
 *     첫 렌더·초안 복원·제거·읽기 실패는 펴지 않고, 저장값은 바꾸지 않으며(사용자 탭만), 모바일(≤900)은 종전대로 배지만
 *
 * 등급: **동작**(①~⑤·⑦) + 배선(⑥·⑧·⑨, 마크업·CSS 대조). ★레이아웃(실제 좌표 순서·겹침·말줄임·폭 경계·포커스)은 미니 DOM 에
 * 없다 — 이 스위트로는 못 잡는다(예: `row-reverse` 로 진행 표시와 토글 좌우가 뒤집혀도 DOM 순서는 같다, 독립 사냥 N2).
 * 그 판정은 헤드리스 프로브(뷰포트 에뮬레이션, 실기 아님)가 한다 — 갱신 3 은 `_workspace/mobile-composer-collapse/v3/verify_v3.mjs`
 * (전 폭 좌표: 줄 순서·답글↔폼 사이·알약 같은 행·진행 표시 ↔ 토글·화살표 크기/회전·폭 전환·바닥 고정·입력 3단 확대) ·
 * `v3/compare_v3.mjs`(HEAD 대조). 갱신 1·2 는 `verify_impl.mjs`·`verify_v2.mjs`·`compare_v2.mjs`.
 */
import { readFileSync } from "node:fs";
import { bootDashboard, dashSource, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);
const HTML = readFileSync(new URL("packages/dashboard/index.html", REPO), "utf8");
const CSS = readFileSync(new URL("packages/dashboard/app.css", REPO), "utf8");
/** 주석을 뺀 CSS — 주석 안의 `@media`·선택자 글자를 규칙으로 세지 않는다. */
const CSS_NC = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
/** index.html 의 `#chat` 상자 — 고치지 않고 그대로 싣는다(자식 순서·버튼 안 구조가 검사 대상이다). */
const CHAT_HTML = (() => {
  const a = HTML.indexOf('<div id="chat">');
  const b = HTML.indexOf("</section>", a);
  return HTML.slice(a, b);
})();

/** `re` 에 맞는 `@media` 블록 본문 전부(여러 벌이다 — 짝 맞는 `}` 까지). 범위도 돌려준다. */
const mediaBlocks = (re: RegExp): Array<{ a: number; b: number; text: string }> => {
  const found: Array<{ a: number; b: number; text: string }> = [];
  for (const m of CSS_NC.matchAll(re)) {
    let depth = 0;
    for (let k = CSS_NC.indexOf("{", m.index); k < CSS_NC.length; k += 1) {
      if (CSS_NC[k] === "{") depth += 1;
      else if (CSS_NC[k] === "}") { depth -= 1; if (depth === 0) { found.push({ a: m.index, b: k + 1, text: CSS_NC.slice(m.index, k) }); break; } }
    }
  }
  return found;
};
const mobileBlocks = (): string => mediaBlocks(/@media \(max-width:\s*900px\)/g).map((x) => x.text).join("\n");
const desktopBlocks = (): string => mediaBlocks(/@media \(min-width:\s*901px\)/g).map((x) => x.text).join("\n");
/** 어떤 `@media` 에도 들지 않은 규칙만(= 모든 폭). */
const topLevelCss = (): string => {
  const all = mediaBlocks(/@media [^{]+/g);
  let out = ""; let at = 0;
  for (const x of all) { if (x.a < at) continue; out += CSS_NC.slice(at, x.a); at = x.b; }
  return out + CSS_NC.slice(at);
};

type Store = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void };
const memStore = (init: Record<string, string> = {}): Store => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

/** 진짜 파일들을 싣는다. `ro` 는 손으로 울리는 ResizeObserver(⑦). `width` = 처음 창 폭(⑦ M1 은 데스크톱에서 시작한다). */
const boot = (store: Store, width = 390) => {
  const clock = makeClock();
  const requests: { url: string; method: string; body: string }[] = [];
  /** 서버가 주는 «이 대화에 연결된 프로젝트» — 검사가 도중에 바꾼다(③ 접힌 채 연결이 늘 때). */
  /** 서버 쪽 손잡이 — ⑩ 이 전송 거절(413)·첨부 상한을 시험한다. 상한은 실제 /api/health 모양으로 준다. */
  const server = { messagesStatus: 200 };
  const linked: Array<Record<string, unknown>> = [{ name: "alpha", path: "/p/alpha", exists: true, registered: true, commands: [] }];
  /** 관측 대상별 ResizeObserver 콜백 — ⑦ 은 `#chat` 을 보는 것만 울린다(가상화의 `#stream` 관측이 대신 잡아 주면 그물이 거짓이 된다). */
  const roCbs: Array<{ cb: (entries: unknown[]) => void; targets: unknown[] }> = [];
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    upTo: "tabs.js",
    html: CHAT_HTML,
    allIds: true,
    width,
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url.startsWith("/api/session-projects"))
        return jsonResponse({ linked: linked.slice(), available: [] });
      if (url === "/api/messages") return server.messagesStatus === 200 ? jsonResponse({ ok: true }) : jsonResponse({ error: "rejected" }, server.messagesStatus);
      if (url === "/api/health") return jsonResponse({ ok: true, limits: { attachment_count: 10, attachment_bytes: 100, attachment_total_bytes: 150 } });
      return jsonResponse({}, 404);
    },
    extra: {
      localStorage: store,
      // 첨부 추가(chat-send.js `addFiles`)가 쓰는 파일 읽기 대역(⑩) — 이름이 «unreadable» 로 시작하면 읽기 실패.
      FileReader: class {
        result: string | null = null; error: Error | null = null;
        onload: (() => void) | null = null; onerror: (() => void) | null = null;
        readAsDataURL(f: { name?: string }) {
          void Promise.resolve().then(() => {
            if (String(f.name ?? "").startsWith("unreadable")) { this.error = new Error("read failed"); this.onerror?.(); return; }
            this.result = "data:text/plain;base64,QQ=="; this.onload?.();
          });
        }
      },
      ResizeObserver: class {
        r: { cb: (entries: unknown[]) => void; targets: unknown[] };
        constructor(cb: (entries: unknown[]) => void) { this.r = { cb, targets: [] }; roCbs.push(this.r); }
        observe(t: unknown) { this.r.targets.push(t); }
        // ★끊긴 관측자엔 통지하지 않는다(브라우저와 같게) — 안 그러면 «첫 통지 뒤 끊기» 변이가 초록이다(독립 사냥 N1).
        unobserve(t: unknown) { this.r.targets = this.r.targets.filter((x) => x !== t); }
        disconnect() { this.r.targets = []; }
      },
    },
    // tabs.js(실지 않음)가 주는 것만 — 컴포저 핸들(chat-send.js 가 잡는다).
    stubs: [
      'const form = document.getElementById("chat-form");',
      'const input = document.getElementById("chat-input");',
      'const sendBtn = document.getElementById("chat-send");',
      'const growWrap = document.querySelector("#chat-form .grow-wrap");',
    ].join("\n"),
  });
  for (const f of ["session-projects.js", "chat-send.js", "mobile-nav.js"]) dash.run(dashSource(f), f);
  // 태그 칩 삽입(view-projects.js insertContextTag)이 쓰는 것 — 미니 DOM 에 없는 두 가지만 대역.
  dash.run("globalThis.Event = CustomEvent;");
  (dash.document.getElementById("chat-input") as MElement).setSelectionRange = () => {};
  return { dash, clock, requests, roCbs, linked, server };
};

export const check: RegressionCheck = {
  name: "mobile-composer-info-collapse",
  guards:
    "입력창 위 정보(태그·프로젝트·답글·첨부·백그라운드/셸 알약) 한 번에 접기(모든 폭)가 상태·전송 내용을 바꾸거나, 갱신이 접힘을 되살리거나, 배지가 숨은 것을 못 따라가거나, 펼칠 때 마지막 메시지가 입력창 밑에 가리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // 입력창의 `#code-review` 가 **활성 칩**이 되게 배운 태그로 둔다 — 그래야 «태그는 세지 않는다» 가 실제로 시험된다.
    const store = memStore({ tgctx_recent: JSON.stringify(["code-review"]) });
    const { dash, clock, requests, roCbs, linked } = boot(store);
    await clock.advance(20);
    const $ = (id: string): MElement => dash.document.getElementById(id) as MElement;
    const chat = $("chat");
    const toggle = $("chat-info-toggle");
    const badges = (): string[] => toggle.querySelectorAll(".cit-badge").map((b) => b.textContent);
    const collapsed = (): boolean => chat.classList.contains("info-collapsed");

    // ── ① 처음·토글·기억 ─────────────────────────────────────────────
    out.push(
      assert(
        "① 처음 상태 = 펼침(저장값 없음) · aria-expanded=true · 배지 없음",
        !collapsed() && toggle.getAttribute("aria-expanded") === "true" && badges().length === 0 && store.getItem("tgchat_info_collapsed") === null,
        { collapsed: collapsed(), aria: toggle.getAttribute("aria-expanded"), badges: badges() },
      ),
    );

    // 상태를 채운다 — 진짜 모듈 경로로.
    dash.run('startReply("원문 앞부분", "예시", "row-7")');
    dash.run('pendingAttachments.push({filename:"a.pdf",mimeType:"application/pdf",dataBase64:"QQ==",bytes:1},{filename:"b.txt",mimeType:"text/plain",dataBase64:"Qg==",bytes:1}); renderAttachChips();');
    $("chat-input").value = "초안 #code-review 그대로";
    dash.run("renderContextTags(); updateActiveChips();");
    await clock.advance(5);
    const activeTagChips = $("chat-context").querySelectorAll(".ctx-chip.active").length;
    const linkedNow = $("chat-projects").querySelectorAll(".ctx-linked").length;
    const payloadOf = async (): Promise<string> => {
      const before = requests.length;
      await dash.run('sendChatMessage(document.getElementById("chat-input").value, pendingAttachments, replyingTo ? { ...replyingTo } : undefined)');
      await clock.advance(5);
      const sent = requests.slice(before).find((r) => r.url === "/api/messages");
      if (!sent) return "(요청 없음)";
      // 보낼 때마다 새로 짓는 상관 id 만 뺀다 — 나머지(글·답글 대상·첨부·방)는 그대로 비교한다.
      const body = JSON.parse(sent.body) as Record<string, unknown>;
      delete body["correlationId"];
      return JSON.stringify(body);
    };
    const payloadBefore = await payloadOf();

    const reqBefore = requests.length;
    toggle.click();
    await clock.advance(5);
    out.push(
      assert(
        "★① 누르면 접힘 · aria-expanded=false · 저장값 \"1\"",
        collapsed() && toggle.getAttribute("aria-expanded") === "false" && store.getItem("tgchat_info_collapsed") === "1",
        { collapsed: collapsed(), aria: toggle.getAttribute("aria-expanded"), ls: store.getItem("tgchat_info_collapsed") },
      ),
    );
    out.push(
      assert(
        "★③ 접힌 배지 = 숨은 것의 요약(📁·↩·📎 2) — 태그는 세지 않는다",
        JSON.stringify(badges()) === JSON.stringify(["📁 " + String(linkedNow), "↩", "📎 2"]) && linkedNow === 1 && activeTagChips === 1,
        { 배지: badges(), 활성태그칩: activeTagChips },
      ),
    );
    const label = String(toggle.getAttribute("aria-label"));
    out.push(
      assert(
        "① 토글의 읽어 줄 글 = «펼치기» + 숨은 것 설명(카탈로그 문구)",
        label.startsWith(i18nForContext("chat.info.expand")) && label.includes(i18nForContext("chat.info.badge.attach", { n: 2 })) && label.includes(i18nForContext("chat.info.badge.reply")),
        label,
      ),
    );

    // ── ② 상태 보존 ──────────────────────────────────────────────────
    const replyHidden = $("chat-reply").hidden;
    out.push(
      assert(
        "★② 접기는 요청을 보내지 않고 답글·첨부·입력창 글자를 건드리지 않는다",
        requests.length === reqBefore && replyHidden === false && (dash.run("pendingAttachments.length") as number) === 2 && $("chat-input").value === "초안 #code-review 그대로",
        { 요청: requests.length - reqBefore, 답글숨김: replyHidden, 첨부: dash.run("pendingAttachments.length"), 입력: $("chat-input").value },
      ),
    );
    const payloadCollapsed = await payloadOf();
    out.push(
      assert(
        "★★② 접힌 채 보내는 payload 가 접기 전과 같다(답글 대상·첨부·글자)",
        payloadBefore !== "(요청 없음)" && payloadCollapsed === payloadBefore && /"replyToText":"원문 앞부분"/.test(payloadBefore) && /a\.pdf/.test(payloadBefore),
        { 같음: payloadCollapsed === payloadBefore, 전: payloadBefore.slice(0, 160) },
      ),
    );

    // ── ⑤ 진행 tick·셸 재대입은 배지를 다시 쓰지 않는다 ─────────────────────
    let writes = 0;
    const mo = new (dash.ctx["MutationObserver"] as new (cb: (r: unknown[]) => void) => { observe: (t: unknown, o: unknown) => void; disconnect: () => void })((r) => { writes += r.length; });
    mo.observe(toggle, { childList: true, subtree: true, attributes: true });
    // 배지 관측자 = 묶음 줄을 보는 관측자(mobile-nav.js). 그것을 **깨운 기록**을 본다 — 콜백이 같은 글이면 안 쓰므로
    //  쓰기 횟수만으로는 «진행 표시가 매초 깨운다»(관측 범위가 넓어진 것)를 못 본다(구현 검토 R1).
    type Reg = { target: unknown; mo: { delivered: Array<{ target: MElement }> } };
    const OBSERVED = ["chat-projects", "chat-attach", "chat-reply", "chat-bg-active", "chat-shell-active"];
    const infoMo = ((dash.document as unknown as { _moRegs: Reg[] })._moRegs.find((r) => r.target === $("chat-attach")) as Reg).mo;
    const woke0 = infoMo.delivered.length;
    dash.run("markTurnActive(activeThreadKey)");
    const statusText0 = $("chat-status").textContent;
    await clock.advance(3200); // 진행 표시 1초 tick 3번 + 셸 알약 1초 폴(hidden=true 재대입) 3번
    const wokeBy = infoMo.delivered.slice(woke0).map((r) => r.target.id || r.target.className || r.target.tagName);
    out.push(
      assert(
        "★⑤ 배지 관측자를 깨운 것은 묶음 줄뿐이다 — 진행 표시(1초 tick)·토글 자신은 깨우지 않는다(셸 알약의 같은 값 재대입만 깨운다)",
        wokeBy.length > 0 && wokeBy.every((t) => OBSERVED.includes(t)) && wokeBy.includes("chat-shell-active"),
        { 깨운것: [...new Set(wokeBy)], 횟수: wokeBy.length },
      ),
    );
    out.push(
      assert(
        "★⑤ 3초 동안(진행 tick·셸 알약 재대입) 토글 쓰기 0 · 접힘 유지 · 진행 표시는 계속 갱신",
        writes === 0 && collapsed() && /working/.test($("chat-status").className) && statusText0 !== "",
        { 쓰기: writes, 접힘: collapsed(), 진행: $("chat-status").textContent },
      ),
    );
    dash.run("markTurnDone(activeThreadKey)");
    await clock.advance(5);
    out.push(assert("⑤ 턴이 끝나도 접힘은 그대로(진행 판정이 접힘을 바꾸지 않는다)", collapsed() && writes === 0, { 접힘: collapsed(), 쓰기: writes }));
    mo.disconnect();

    // ── ③ 접힌 동안의 변화 ──────────────────────────────────────────────
    dash.run("clearReply()");
    dash.run("pendingAttachments.splice(0, 1); renderAttachChips();");
    dash.run('chatBgActiveEl.textContent = "x"; chatBgActiveEl.hidden = false;');
    await clock.advance(5);
    const b1 = badges();
    dash.run("chatBgActiveEl.hidden = true;");
    await clock.advance(5);
    out.push(
      assert(
        "★③ 접힌 채 답글 취소·첨부 1개 제거·알약 켜짐 → 배지가 따라온다(펼치지 않는다), 알약 꺼짐도",
        collapsed() && JSON.stringify(b1) === JSON.stringify(["📁 1", "📎 1", "🔄"]) && JSON.stringify(badges()) === JSON.stringify(["📁 1", "📎 1"]),
        { 켜짐: b1, 꺼짐: badges() },
      ),
    );

    // 접힌 채 이 대화에 프로젝트가 하나 더 연결된다(다른 채널·SSE → 진짜 refreshSessionProjects 경로) → 배지만 바뀐다.
    linked.push({ name: "beta", path: "/p/beta", exists: true, registered: true, commands: [] });
    await dash.run("window.refreshSessionProjects()");
    await clock.advance(5);
    out.push(
      assert(
        "★③ 접힌 채 프로젝트 연결이 늘면(실제 새로고침 경로) 배지만 📁 2 로 바뀐다 · 접힘 유지",
        collapsed() && JSON.stringify(badges()) === JSON.stringify(["📁 2", "📎 1"]),
        { 접힘: collapsed(), 배지: badges() },
      ),
    );

    // ── ④ 펼친 뒤 기존 조작 ──────────────────────────────────────────────
    toggle.click();
    await clock.advance(5);
    out.push(
      assert(
        "① 다시 누르면 펼침 · 저장값 \"0\" · 배지 지움",
        !collapsed() && store.getItem("tgchat_info_collapsed") === "0" && badges().length === 0 && toggle.getAttribute("aria-expanded") === "true",
        { ls: store.getItem("tgchat_info_collapsed"), badges: badges() },
      ),
    );
    ($("chat-attach").querySelector(".att-x") as MElement).click();
    dash.run('startReply("다시", "예시")');
    ($("chat-reply").querySelector(".cr-x") as MElement).click();
    await clock.advance(5);
    store.setItem("tgctx_recent", JSON.stringify(["디자인"]));
    dash.run("renderContextTags()");
    const chip = $("chat-context").querySelectorAll(".ctx-chip").find((c) => c.dataset.tag === "디자인");
    $("chat-input").value = "";
    chip?.click();
    const ctxToggle = $("chat-context").querySelector(".ctx-toggle");
    ctxToggle?.click();
    ($("chat-projects").querySelector(".ctx-linked") as MElement).click();
    await clock.advance(5);
    const menuOpen = dash.document.querySelector(".ctx-menu") !== null;
    out.push(
      assert(
        "★④ 펼친 뒤 첨부 ✕ · 답글 ✕ · 태그 칩 삽입 · 태그 줄 자체 토글 · 프로젝트 칩 메뉴가 그대로 — `tgctx_expanded` 는 새 키와 따로 산다",
        (dash.run("pendingAttachments.length") as number) === 0 && $("chat-reply").hidden === true && /#디자인/.test($("chat-input").value) &&
          store.getItem("tgctx_expanded") === "1" && store.getItem("tgchat_info_collapsed") === "0" && menuOpen,
        { 첨부: dash.run("pendingAttachments.length"), 답글숨김: $("chat-reply").hidden, 입력: $("chat-input").value, tgctx: store.getItem("tgctx_expanded"), 칩: chip !== undefined, 프로젝트메뉴: menuOpen },
      ),
    );

    // ── ⑦ 높이 변화 → 바닥 재고정 ─────────────────────────────────────────
    const fireInset = (h: number): void => {
      (chat as unknown as { offsetHeight: number }).offsetHeight = h;
      for (const r of roCbs) if (r.targets.includes(chat)) r.cb([]);
    };
    // 판정(«따라가는 중인가») 은 virtualization.js 의 진짜 pinsBottom 이 한다 — 여기선 결과(문서 scrollTop)만 본다.
    dash.document.body.setAttribute("data-tab", "chat");
    const se = dash.document.documentElement as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
    dash.window.innerWidth = 390;
    dash.run("stickBottom = true; userIntentUntil = 0;");
    const insetNow = (d = dash): unknown => d.run('document.documentElement.style.getPropertyValue("--chat-inset")');
    fireInset(190); // 첫 측정
    // ★여러 차례 — 매번 inset 이 새 높이를 따라가고 바닥을 다시 잡는다(독립 사냥 N1: 관측자를 첫 통지 뒤 끊어도 한 번만 보면 초록이었다).
    const steps: Array<{ h: number; inset: unknown; top: number }> = [];
    for (const [h, sh] of [[254, 900], [300, 960], [346, 1020]] as const) {
      se.scrollTop = 100;
      se.scrollHeight = sh;
      fireInset(h);
      steps.push({ h, inset: insetNow(), top: se.scrollTop });
    }
    dash.run("stickBottom = false;");
    se.scrollTop = 100;
    fireInset(190);
    const freeTop = se.scrollTop;
    out.push(
      assert(
        "★⑦ 모바일에서 입력창 높이가 (여러 차례) 바뀌면 매번 --chat-inset 이 따라가고, 바닥을 따라가던 중일 때만 바닥을 다시 잡는다(위로 올려 읽는 중이면 그대로)",
        steps.every((x, i) => x.inset === `${x.h + 8}px` && x.top === [900, 960, 1020][i]) && freeTop === 100 && insetNow() === "198px",
        { 단계: steps, 읽는중: freeTop, inset: insetNow() },
      ),
    );
    // ★폭은 읽을 때 판정한다 — 데스크톱 폭(문서가 아니라 #stream 이 스크롤 상자)에선 문서 바닥을 건드리지 않고, 그 탭이 모바일 폭으로
    //  좁아진 뒤엔 다시 잡는다(독립 사냥 M1: 처음 판정을 굳히면 데스크톱→모바일 전환 뒤 마지막 메시지가 가렸다).
    const wide = boot(memStore(), 1280);
    await wide.clock.advance(20);
    const wChat = wide.dash.document.getElementById("chat") as MElement;
    const wFire = (h: number): void => {
      (wChat as unknown as { offsetHeight: number }).offsetHeight = h;
      for (const r of wide.roCbs) if (r.targets.includes(wChat)) r.cb([]);
    };
    const wse = wide.dash.document.documentElement as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
    wide.dash.document.body.setAttribute("data-tab", "chat");
    wide.dash.run("stickBottom = true; userIntentUntil = 0;");
    wFire(190);
    wse.scrollTop = 100;
    wse.scrollHeight = 900;
    wFire(254);
    const deskTop = wse.scrollTop;
    wide.dash.window.innerWidth = 390;
    wse.scrollTop = 100;
    wFire(300);
    const narrowTop = wse.scrollTop;
    out.push(
      assert(
        "★⑦ 폭 판정은 그때그때 — 데스크톱 폭에선 문서 바닥을 안 건드리고(inset 은 따라감), 모바일 폭으로 좁아진 뒤 높이가 바뀌면 바닥을 다시 잡는다",
        deskTop === 100 && narrowTop === 900 && insetNow(wide.dash) === "308px",
        { 데스크톱: deskTop, 좁힌뒤: narrowTop, inset: insetNow(wide.dash) },
      ),
    );

    // ── ① 재로드 복원 · 저장소가 던지면 펼침 ─────────────────────────────────
    const again = boot(memStore({ tgchat_info_collapsed: "1" }));
    await again.clock.advance(20);
    const chat2 = again.dash.document.getElementById("chat") as MElement;
    const tg2 = again.dash.document.getElementById("chat-info-toggle") as MElement;
    const throwing: Store = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    const broken = boot(throwing);
    await broken.clock.advance(20);
    const chat3 = broken.dash.document.getElementById("chat") as MElement;
    (broken.dash.document.getElementById("chat-info-toggle") as MElement).click();
    out.push(
      assert(
        "① 재로드 시 저장값 «접힘» 복원(aria 포함) · 저장소가 던지면 펼침으로 시작하고 눌러도 화면은 접힌다(저장만 실패)",
        chat2.classList.contains("info-collapsed") && tg2.getAttribute("aria-expanded") === "false" && chat3.classList.contains("info-collapsed"),
        { 복원: chat2.classList.contains("info-collapsed"), aria: tg2.getAttribute("aria-expanded"), 던짐후탭: chat3.classList.contains("info-collapsed") },
      ),
    );

    // ── ⑩ 사용자가 새로 지정한 답글·붙인 첨부 → 데스크톱만 화면을 펼친다(결정 문서 §13) ─────────────
    // 저장된 접힘으로 시작한 데스크톱에서 답글·첨부가 배지만 남기면 모르는 채 실려 나갔다. 새 사용자 선택만 펼친다 —
    //  첫 렌더·복원(탭 전환 초안)·제거·읽기 실패는 펴지 않는다. 저장값은 사용자 탭만 바꾼다. 모바일은 종전대로(배지).
    const added = async (width: number) => {
      const s = memStore({ tgchat_info_collapsed: "1" });
      const b = boot(s, width);
      await b.clock.advance(20);
      const c = b.dash.document.getElementById("chat") as MElement;
      const t = b.dash.document.getElementById("chat-info-toggle") as MElement;
      const st = () => ({
        접힘: c.classList.contains("info-collapsed"), 저장: s.getItem("tgchat_info_collapsed"), aria: t.getAttribute("aria-expanded"),
        배지: t.querySelectorAll(".cit-badge").map((x) => x.textContent),
      });
      const addFile = async (name: string, size = 1) => { await b.dash.run(`addFiles([{ name: ${JSON.stringify(name)}, type: "text/plain", size: ${size} }])`); await b.clock.advance(5); };
      return { b, s, c, t, st, addFile };
    };
    const d = await added(1280);
    const dBoot = d.st();
    d.b.dash.run('chatDrafts.set("regr-tab", { text: "", attachments: [{ filename: "d.txt", mimeType: "text/plain", dataBase64: "QQ==", bytes: 1 }] }); window.restoreChatDraft("regr-tab");');
    await d.b.clock.advance(5);
    const dRestore = d.st();
    (d.b.dash.document.querySelector("#chat-attach .att-x") as MElement).click();
    await d.addFile("unreadable.txt"); // 읽기 실패 = 새로 붙은 것 0
    const dNoAdd = d.st();
    d.b.dash.run('startReply("원문", "예시", "row-9")');
    await d.b.clock.advance(5);
    const dReply = d.st();
    d.t.click(); // 사용자가 다시 접는다 — 그대로 접힌다
    await d.b.clock.advance(5);
    const dRefold = d.st();
    await d.addFile("c.txt");
    const dAttach = d.st();
    d.t.click();
    d.b.dash.run('startReply("다른 원문", "예시", "row-10")'); // 답글 대상을 새로 바꾸는 것도 새 지정이다
    await d.b.clock.advance(5);
    const dReplace = d.st();
    out.push(
      assert(
        "★⑩ 데스크톱: 저장된 접힘으로 시작 → 첫 렌더·초안 복원·첨부 제거·읽기 실패는 접힌 채(배지) · 새 답글 지정·새 첨부·답글 대상 바꾸기는 화면을 펼친다",
        dBoot.접힘 && dRestore.접힘 && JSON.stringify(dRestore.배지) === JSON.stringify(["📁 1", "📎 1"]) && dNoAdd.접힘 && JSON.stringify(dNoAdd.배지) === JSON.stringify(["📁 1"]) &&
          !dReply.접힘 && dReply.aria === "true" && dReply.배지.length === 0 && dRefold.접힘 && !dAttach.접힘 && dAttach.aria === "true" && !dReplace.접힘 && dReplace.aria === "true" && dReplace.배지.length === 0,
        { 첫렌더: dBoot, 복원: dRestore, 추가없음: dNoAdd, 답글: dReply, 다시접음: dRefold, 첨부: dAttach, 대상바꿈: dReplace },
      ),
    );
    out.push(
      assert(
        "★⑩ 자동 펼침은 화면만 — 저장값은 사용자가 접어 둔 «1» 그대로(새로 고치면 접힌 채 시작) · 답글·첨부는 그대로 실려 있다",
        [dReply, dRefold, dAttach, dReplace].every((x) => x.저장 === "1") &&
          (d.b.dash.run("pendingAttachments.length") as number) === 1 && (d.b.dash.run("replyingTo && replyingTo.ref") as string) === "row-10",
        { 저장: [dReply.저장, dRefold.저장, dAttach.저장, dReplace.저장], 첨부: d.b.dash.run("pendingAttachments.length") },
      ),
    );
    // 추가 실패의 나머지 갈래 — 서버 상한(개수·파일 크기·총량)에 걸려 하나도 안 붙는 것도 «새로 붙인 것 0» 이다(GPT 검토 R1).
    d.t.click(); // 사용자가 다시 접는다
    await d.b.clock.advance(5);
    const fill = (n: number, bytes: number) =>
      d.b.dash.run(`pendingAttachments.length = 0; for (let i = 0; i < ${n}; i += 1) pendingAttachments.push({ filename: "q" + i + ".txt", mimeType: "text/plain", dataBase64: "QQ==", bytes: ${bytes} }); renderAttachChips();`);
    fill(10, 1);
    await d.addFile("count.txt"); // 개수 상한 10
    const dCount = { ...d.st(), n: d.b.dash.run("pendingAttachments.length") as number };
    fill(0, 1);
    await d.addFile("big.txt", 200); // 파일당 상한 100
    const dSize = { ...d.st(), n: d.b.dash.run("pendingAttachments.length") as number };
    fill(1, 140);
    await d.addFile("total.txt", 20); // 총량 상한 150
    const dTotal = { ...d.st(), n: d.b.dash.run("pendingAttachments.length") as number };
    // 전송 실패 복원 — 진짜 폼 제출 처리기 → 서버의 명시적 거절(413) → `restoreAttachments` 로 칩이 돌아온다. 새 사용자 선택이 아니다.
    d.b.server.messagesStatus = 413;
    (d.b.dash.document.getElementById("chat-input") as MElement).value = "보낼 글";
    d.b.dash.run('if (typeof slashClose === "undefined") globalThis.slashClose = () => {};');
    const sentBefore = d.b.requests.filter((r) => r.url === "/api/messages").length;
    d.b.dash.run('document.getElementById("chat-form").dispatchEvent(new CustomEvent("submit", { bubbles: true, cancelable: true }))');
    await d.b.clock.advance(50);
    const dRestoreSend = {
      ...d.st(), n: d.b.dash.run("pendingAttachments.length") as number,
      보냄: d.b.requests.filter((r) => r.url === "/api/messages").length - sentBefore, 입력: (d.b.dash.document.getElementById("chat-input") as MElement).value,
    };
    d.b.server.messagesStatus = 200;
    out.push(
      assert(
        "★⑩ 데스크톱: 상한(개수·파일 크기·총량)에 걸려 하나도 안 붙으면 접힌 채 · 전송이 거절돼(413) 첨부가 되돌아와도 접힌 채 — 둘 다 저장값 «1»",
        dCount.접힘 && dCount.n === 10 && dSize.접힘 && dSize.n === 0 && dTotal.접힘 && dTotal.n === 1 &&
          dRestoreSend.보냄 === 1 && dRestoreSend.n === 1 && dRestoreSend.입력 === "보낼 글" && dRestoreSend.접힘 &&
          [dCount, dSize, dTotal, dRestoreSend].every((x) => x.저장 === "1"),
        { 개수: dCount, 크기: dSize, 총량: dTotal, 전송실패복원: dRestoreSend },
      ),
    );
    // 모바일(≤900)은 종전대로 펼치지 않는다 — 900 은 모바일, 901 은 데스크톱(CSS 블록과 같은 경계). 폭은 그때그때 판정한다.
    const m = await added(900);
    m.b.dash.run('startReply("원문", "예시")');
    await m.addFile("m.txt");
    const mAfter = m.st();
    m.b.dash.window.innerWidth = 901;
    await m.addFile("w.txt");
    const mWide = m.st();
    const w = await added(901);
    w.b.dash.window.innerWidth = 390;
    w.b.dash.run('startReply("원문", "예시")');
    await w.b.clock.advance(5);
    const wNarrow = w.st();
    out.push(
      assert(
        "★⑩ 모바일 폭(900)은 새 답글·첨부에도 접힌 채 배지만(↩·📎) · 같은 탭이 901 로 넓어진 뒤 새 첨부는 펼친다 · 901 로 시작해 좁아진 뒤엔 펴지 않는다",
        mAfter.접힘 && JSON.stringify(mAfter.배지) === JSON.stringify(["📁 1", "↩", "📎 1"]) && !mWide.접힘 && wNarrow.접힘 && mWide.저장 === "1",
        { 모바일: mAfter, 넓힌뒤: mWide, 좁힌뒤: wNarrow },
      ),
    );

    // ── ⑥ 묶음 한 곳 · 줄 자리(갱신 3, 결정 문서 §12) ─────────────────────────
    const controls = (/id="chat-info-toggle"[^>]*aria-controls="([^"]+)"/.exec(HTML)?.[1] ?? "").split(/\s+/).filter(Boolean).sort();
    const top = topLevelCss();
    const hideRule = /#chat\.info-collapsed\s*>\s*:is\(([^)]*)\)\s*\{\s*display:\s*none/.exec(top);
    const hidden = (hideRule?.[1] ?? "").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean).sort();
    const direct = controls.filter((id) => (dash.document.getElementById(id) as MElement | null)?.parentNode === chat);
    const noMediaHide = !/#chat\.info-collapsed\s*>\s*:is\(/.test(mobileBlocks()) && !/#chat\.info-collapsed\s*>\s*:is\(/.test(desktopBlocks());
    out.push(
      assert(
        "★⑥ 숨김 CSS 묶음 == 토글 aria-controls == `#chat` 직계 자식 5줄(태그·프로젝트·작업 알약 묶음·첨부·답글) · 숨김 규칙은 **모든 폭**(미디어 블록 밖)",
        controls.length === 5 && JSON.stringify(controls) === JSON.stringify(["chat-attach", "chat-context", "chat-projects", "chat-reply", "chat-work"]) &&
          JSON.stringify(controls) === JSON.stringify(hidden) && direct.length === 5 && noMediaHide,
        { controls, hidden, direct: direct.length, 미디어밖: hideRule !== null && noMediaHide },
      ),
    );
    // 사용자 «답글 라인도 채팅입력 필드 바로 위로» — 답글 줄은 폼 바로 앞 형제(DOM = 화면·읽기·Tab 순서), 작업 알약 둘은 한 줄 묶음 안.
    const rows = chat.children.map((c) => c.id).filter((id) => id !== "" && id !== "chat-jump" && id !== "chat-slash");
    const order = ["chat-context", "chat-projects", "chat-work", "chat-histind", "chat-attach", "chat-reply", "chat-form", "chat-summary"];
    out.push(
      assert(
        "★⑥ 줄 순서: 태그 → 프로젝트 → 작업 알약(백그라운드·셸 한 묶음) → 입력기록 → 첨부 → 답글 → 입력폼 → 요약 상자 · 답글은 폼 바로 앞",
        JSON.stringify(rows) === JSON.stringify(order) && $("chat-form").previousElementSibling?.id === "chat-reply" &&
          $("chat-bg-active").parentNode === $("chat-work") && $("chat-shell-active").parentNode === $("chat-work") && $("chat-work").children.length === 2,
        { rows, 폼앞: $("chat-form").previousElementSibling?.id, 알약부모: [$("chat-bg-active").parentNode?.id, $("chat-shell-active").parentNode?.id] },
      ),
    );
    // ── ⑧ 진행 표시 자리 — 모바일은 요약 줄 맨 왼쪽, 데스크톱은 그 상자가 없는 것처럼(폼 아래 그대로) ─────────────
    const summary = $("chat-summary");
    const kids = summary.children.map((c) => c.id);
    const desktopContents = /(^|\n)\s*\.chat-summary\s*\{\s*display:\s*contents;\s*\}/.test(top) && !mobileBlocks().includes(".chat-summary { display:contents");
    const mobileTop = /#chat-summary\s*\{[^}]*order:\s*-1/.test(mobileBlocks()) && !/#chat-summary\s*\{[^}]*order:\s*-1/.test(top);
    out.push(
      assert(
        "★⑧ `#chat-status` 는 요약 상자 맨 앞(폼 뒤 같은 자리) · 데스크톱은 그 상자가 `display:contents`(진행 표시가 폼 아래 그대로) · 모바일만 `order:-1` 로 맨 위",
        kids[0] === "chat-status" && kids[1] === "chat-info-toggle" && summary.previousElementSibling?.id === "chat-form" && desktopContents && mobileTop,
        { 자식: kids, 앞형제: summary.previousElementSibling?.id, 데스크톱contents: desktopContents, 모바일맨위: mobileTop },
      ),
    );
    // ── ⑨ 배치 배선 — 격자·토글·펼침/접힘은 모든 폭(갱신 3), 진행 표시 자리만 폭별 ─────────────
    //  ★풀린 상자의 진행 표시는 칸을 명시하고, 펼침 토글은 #chat 기준 우상단에 고정한다 ·
    //  진행 표시는 (모바일) 작업 중일 때만 맨 위 · 태그 줄 첫 렌더 전엔 토글 숨김(R1 D2) · 데스크톱 접힘은 토글 자신이 맨 위 한 줄.
    const flat = (t: string): string => t.replace(/\s+/g, " ");
    const hasIn = (css: string, sel: RegExp, decl: RegExp): boolean => {
      for (const m of flat(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (sel.test(m[1].trim()) && decl.test(m[2])) return true;
      return false;
    };
    const mob = mobileBlocks();
    const deskOnly = desktopBlocks();
    const ex = "#chat:not\\(\\.info-collapsed\\)";
    const caretSize = /\.cit-caret\s*\{[^}]*font-size:\s*([\d.]+)rem/.exec(flat(top))?.[1];
    const wiring = {
      격자: hasIn(top, /^#chat$/, /display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/) && hasIn(top, /^#chat > \*$/, /grid-column:\s*span 2/),
      입력기록폭: hasIn(top, /^#chat > \.chat-histind$/, /justify-self:\s*start/),
      알약한줄: hasIn(top, /^\.chat-work$/, /display:\s*flex;\s*flex-wrap:\s*wrap/),
      진행표시칸: hasIn(top, /^#chat-status$/, /grid-column:\s*span 2/),
      패널기준: hasIn(top, /^#chat$/, /position:\s*relative/),
      태그버튼여백: hasIn(top, new RegExp(`^${ex} > #chat-context$`), /grid-column:\s*span 2;\s*order:\s*-2;\s*margin-right:\s*40px/),
      펼침우상단: hasIn(top, new RegExp(`^${ex} #chat-info-toggle$`), /position:\s*absolute;\s*top:\s*12px;\s*right:\s*12px/),
      접힘흐름유지: !hasIn(top + mob + deskOnly, /^\.chat-info-toggle$|^#chat\.info-collapsed #chat-info-toggle$/, /position:\s*absolute/),
      짧은태그행겹침방지: hasIn(top, new RegExp(`^${ex} #chat-info-toggle$`), /min-height:\s*0;/),
      빈태그숨김: hasIn(top, new RegExp(`^${ex} > #chat-context:empty ~ #chat-summary > #chat-info-toggle$`), /display:\s*none/),
      데스크톱접힘줄: hasIn(deskOnly, /^#chat\.info-collapsed #chat-info-toggle$/, /grid-column:\s*span 2;\s*order:\s*-1/),
      모바일상자풀기: hasIn(mob, new RegExp(`^${ex} > #chat-summary$`), /display:\s*contents/),
      모바일진행전폭: hasIn(mob, new RegExp(`^${ex} #chat-status$`), /grid-column:\s*span 2;\s*order:\s*-3;\s*margin:\s*0 40px 4px 0/),
      모바일대기숨김: hasIn(mob, new RegExp(`^${ex} #chat-status:not\\(\\.working\\)$`), /display:\s*none/),
      // 진행 표시 맨 위·대기 숨김은 모바일만(밖에 새면 데스크톱 진행 표시가 폼 아래에서 사라지거나 위로 간다)
      진행규칙모바일만: !flat(top).includes(`#chat:not(.info-collapsed) #chat-status`) && !flat(deskOnly).includes("#chat-status"),
    };
    const ko = readFileSync(new URL("locales/ko.json", REPO), "utf8");
    const en = readFileSync(new URL("locales/en.json", REPO), "utf8");
    const toggleEl = $("chat-info-toggle");
    // 사용자 «큰 화살표를 아래로 · 접은 다음에는 입력 정보 화살표보다 큰 윗화살표» — 화면엔 화살표 하나(낱말 없음), 같은 글자를 접히면 뒤집는다.
    const arrow = {
      글자: hasIn(top, /^\.cit-caret::before$/, /content:\s*"▾"/),
      접히면뒤집기: hasIn(top, /^#chat\.info-collapsed \.cit-caret$/, /transform:\s*rotate\(180deg\)/),
      크기: caretSize !== undefined && Number(caretSize) >= 1.5,
      // 두 상태 **같은 크기**(회전만 다름, 설계 §12-1) — 화살표 크기를 정하는 규칙은 `.cit-caret` 하나뿐이어야 한다(접힘·폭별 덮어쓰기 금지).
      같은크기: [...CSS_NC.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.cit-caret/.test(m[1]) && /font-size|zoom|scale/.test(m[2])).map((m) => m[1].trim()).join("|") === ".cit-caret",
      낱말없음: toggleEl.children.map((c) => c.className).join(" ") === "cit-badges cit-caret" && !/cit-word|cit-hide/.test(CSS_NC) &&
        !/"chat\.info\.(word|hide)"/.test(ko + en),
      버튼하나: HTML.split('id="chat-info-toggle"').length === 2,
    };
    out.push(
      assert(
        "★⑨ 배치: 격자·토글(펼침 패널 우상단 / 접힘 기존 흐름)·버튼 여백·빈 태그 줄 숨김은 모든 폭 · 진행 표시 맨 위 전폭·대기 숨김은 모바일만 · 작업 알약 한 줄",
        Object.values(wiring).every(Boolean),
        wiring,
      ),
      assert(
        "★⑨ 토글은 큰 화살표 하나(▾ ≥ 1.5rem, 접히면 180° 회전 — 크기는 두 상태 같음) · 낱말 칸·문구 키 없음 · 버튼은 하나",
        Object.values(arrow).every(Boolean),
        { ...arrow, caretSize },
      ),
    );
    out.push(
      assert(
        "그 과정에 던진 것이 없다",
        clock.errors.length + again.clock.errors.length + broken.clock.errors.length + wide.clock.errors.length === 0,
        [...clock.errors, ...again.clock.errors, ...broken.clock.errors, ...wide.clock.errors].join(" | ") || "예외 0",
      ),
    );
    return out;
  },
};

export default check;
