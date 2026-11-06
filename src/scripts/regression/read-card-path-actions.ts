/**
 * 회귀: **Read 카드의 경로 동작** — 경로 클릭 복사 · ↗ 기본 앱으로 열기 · ⤢ 지금 파일 보기 (2026-11-05,
 * 설계 `docs/decisions/2026-11-05-read-card-path-actions.md` v2 · 아스트라 R1·R2).
 *
 * 정태님 *«Read도구 파일경로옆에 Write/Edit처럼 … 이것도 이번에 적용하자»* + *«경로 클릭하면 경로 복사도»*. 지키는 것:
 *  ① 관측 빌더(`buildActivityFile`): Read 만 · 그 턴의 cwd 로 푼 절대 경로 · 못 풀면 싣지 않음 · offset → 시작 줄
 *  ② 세 화면(라이브 `buildActivityLine` · 이력 `buildHistStepLine` · 잡 카드 `handleWorkerActivity`) 각각 — 경로 표시 · **경로 글자 클릭 = 그 글자
 *     복사 + 성공 안내** · 부모 토글·열기 요청 없음 · ↗ = 절대 경로 · ⤢ = 절대 경로로 지금 파일(조각 없음 · «읽은 당시 기록 아님»).
 *     출력이 오기 전 스텝과 출력이 온 뒤 스텝 둘 다.
 *  ③ Write/Edit 보존 — 같은 함수로 옮긴 뒤에도 복사 글자(`경로:줄`)·안내·접힘 요약(+N/-M)·↗ 대상·⤢ 조각 그대로
 *  ④ 이력 투영이 시작 스텝에 `file` 을 통과시킨다(손 목록 — 빠지면 새로고침에 사라진다)
 *  ⑤ 세 어댑터가 **그 Read 를 실제로 푼 기준**으로 싣는다(홈 턴 · 프로젝트 턴 — codex·openai 는 실제 읽은 내용으로 대조)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildActivityFile, buildActivityFileFromJson } from "../../core/llm-runtime/adapters/_activity-diff.js";
import { initStore } from "../../store/sessions.js";
import { insertEvent } from "../../store/events.js";
import { bootDashboard, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";
import { assert, assertIsolated, i18nForContext, loadPluginModule, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const J = (v: unknown): string => JSON.stringify(v);
/** 자식 출력의 마지막 JSON 배열 줄. */
const lastArray = (s: string): unknown[] | undefined => {
  for (const line of s.trim().split("\n").reverse()) {
    if (!line.startsWith("[")) continue;
    try { return JSON.parse(line) as unknown[]; } catch { /* 다음 줄 */ }
  }
  return undefined;
};

export const check: RegressionCheck = {
  name: "read-card-path-actions",
  guards: "Read 카드에 경로 복사·기본 앱 열기·지금 파일 보기가 없던 것 — 붙이되 읽기를 쓰기처럼 보이게 하거나, 상대 경로를 엉뚱한 기준으로 열거나, 지금 디스크를 읽은 당시 기록처럼 보이게 하지 않게",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];

    // ── ① 관측 빌더 ─────────────────────────────────────────────────────────
    const rel = buildActivityFile("Read", { file_path: "src/a.ts", offset: 880 }, "/proj");
    const relPath = buildActivityFile("Read", { path: "src/a.ts" }, "/proj");
    const abs = buildActivityFile("Read", { path: "/abs/b.ts" });
    const noCwd = buildActivityFile("Read", { path: "src/a.ts" });
    const badOff = [0, -3, 1.5, "7"].map((o) => buildActivityFile("Read", { path: "/abs/b.ts", offset: o })?.startLine);
    const notRead = ["Write", "Edit", "Grep", "Bash"].map((t) => buildActivityFile(t, { path: "/abs/b.ts", file_path: "/abs/b.ts" }, "/proj"));
    const fromJson = buildActivityFileFromJson("Read", J({ path: "src/a.ts", offset: 2 }), "/proj");
    const partial = buildActivityFileFromJson("Read", '{"path":"src/a', "/proj");
    out.push(
      assert(
        "관측: Read 만 · 상대 경로는 **그 턴의 cwd** 로 푼 절대 경로 · 절대 경로는 그대로 · cwd 가 없으면 **싣지 않는다** · offset(양의 정수) → 시작 줄 · 내용은 안 싣는다",
        rel?.absPath === path.resolve("/proj", "src/a.ts") && rel.path === "src/a.ts" && rel.startLine === 880 &&
          relPath?.absPath === path.resolve("/proj", "src/a.ts") && relPath.startLine === undefined &&
          abs?.absPath === "/abs/b.ts" && noCwd === undefined && badOff.every((s) => s === undefined) &&
          notRead.every((x) => x === undefined) && fromJson?.startLine === 2 && fromJson.absPath === path.resolve("/proj", "src/a.ts") &&
          partial === undefined && Object.keys(rel ?? {}).sort().join(",") === "absPath,path,startLine",
        J({ rel, relPath, abs, noCwd, badOff, notRead, fromJson, partial }),
      ),
    );

    // ── ② 세 화면 — 진짜 대시보드 스크립트(background-drawer·virtualization·file-view·history-render) ─────────
    const clock = makeClock();
    const copies: string[] = [];
    const opened: string[] = [];
    const viewed: string[] = [];
    let failMode: "reject" | "network" | null = null;
    const dash = bootDashboard({
      html: bgPanelHtml(), clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true,
      extra: { navigator: { clipboard: { writeText: async (t: string) => { copies.push(t); } } } },
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === "/api/open-path") { opened.push(String(JSON.parse(String(init?.body ?? "{}")).path)); return jsonResponse({ ok: true }); }
        if (url.startsWith("/api/file-view")) {
          viewed.push(url);
          if (failMode === "reject") return jsonResponse({ error: "파일이 없습니다(합성)" }, 404);
          if (failMode === "network") throw new Error("합성 네트워크 실패");
          return jsonResponse({ content: "NOW-1\nNOW-2\n" });
        }
        return jsonResponse({}, 404);
      },
    });
    const doc = dash.document;
    const toast = () => doc.getElementById("toast")?.textContent ?? "";
    const resetToast = () => dash.run(`(() => { const t = document.getElementById("toast"); if (t) t.textContent = ""; })()`);
    const FILE = { path: "src/a.ts", absPath: "/proj/src/a.ts", startLine: 880 };
    const settle = async () => { await clock.advance(20); await sleep(5); };
    /** 한 스텝 줄의 경로 동작을 실제 클릭으로 다 눌러 본다 — 부모 토글이 안 일어나는지, 무엇을 복사·요청했는지. */
    const exercise = async (line: any, expandedOf: () => boolean) => {
      copies.length = 0; opened.length = 0; viewed.length = 0; resetToast();
      const ref = line.querySelectorAll(".act-file-ref")[0];
      const pathEl = ref?.querySelectorAll(".act-diff-path")[0];
      const before = expandedOf();
      if (pathEl) dispatch(pathEl, makeEvent("click", { bubbles: true, detail: 1 }));
      await settle();
      const afterCopy = { copies: [...copies], toast: toast(), toggled: expandedOf() !== before, requests: opened.length + viewed.length };
      const btns = ref ? ref.querySelectorAll("button") : [];
      const openBtn = btns.find((b: { className: string }) => !b.className.includes("act-diff-fileview"));
      const fvBtn = btns.find((b: { className: string }) => b.className.includes("act-diff-fileview"));
      if (openBtn) dispatch(openBtn, makeEvent("click", { bubbles: true, detail: 1 }));
      await settle();
      if (fvBtn) dispatch(fvBtn, makeEvent("click", { bubbles: true, detail: 1 }));
      await settle();
      const modal = {
        frag: doc.querySelectorAll(".fv-back .fv-frag").length,
        change: doc.querySelectorAll(".fv-back .fv-change").length,
        note: doc.querySelectorAll(".fv-note")[0]?.textContent ?? "",
        gutters: doc.querySelectorAll(".fv-seg .fv-gutter").map((g: { textContent: string }) => g.textContent),
        jumpHidden: doc.querySelectorAll(".fv-jump")[0]?.hidden ?? null,
      };
      dispatch(doc, makeEvent("keydown", { key: "Escape" }));
      return {
        shown: pathEl?.textContent ?? null, detail: line.querySelectorAll(".act-detail, .hist-tool-detail, .bg-step-detail").length,
        ...afterCopy, toggledAny: expandedOf() !== before, opened: [...opened], viewed: [...viewed], modal,
      };
    };
    const okSurface = (r: Awaited<ReturnType<typeof exercise>>): boolean =>
      r.shown === "src/a.ts:880" && r.detail === 0 &&
      J(r.copies) === J(["src/a.ts:880"]) && r.toast === "경로를 복사했습니다" && !r.toggled && r.requests === 0 &&
      !r.toggledAny && J(r.opened) === J(["/proj/src/a.ts"]) && J(r.viewed) === J(["/api/file-view?path=" + encodeURIComponent("/proj/src/a.ts")]) &&
      r.modal.frag === 0 && r.modal.change === 0 && r.modal.note === "아래는 지금 디스크의 내용입니다 — 읽은 당시의 기록이 아니며, 그 뒤 바뀌었을 수 있습니다" &&
      J(r.modal.gutters) === J(["1\n2"]) && r.modal.jumpHidden === true;

    // 라이브 — 출력 전(detail 만 있는 스텝: 클릭이 버블되면 상세 블록을 지어 펼친다) · 출력 뒤(annotateToolDuration 이 출력 블록을 붙인다)
    const P = { threadKey: "dashboard:default", seq: 7, kind: "tool", label: "Read", detail: "file_path=src/a.ts, offset=880", file: FILE };
    const liveLine = dash.run(`(() => { const l = buildActivityLine(${J(P)}); document.getElementById("stream").appendChild(l); return l; })()`);
    const liveExp = () => liveLine.classList.contains("expanded");
    const liveBefore = await exercise(liveLine, liveExp);
    dash.run(`annotateToolDuration(${J({ threadKey: P.threadKey, seq: P.seq, phase: "end", durationMs: 4, output: { text: "READ-TIME-880" } })})`);
    const liveHasOut = liveLine.querySelectorAll(":scope > .act-output").length;
    const liveAfter = await exercise(liveLine, liveExp);
    out.push(
      assert(
        "★★라이브 Read 스텝: `경로:줄` 표시(detail 대신) · **경로 글자 클릭 = 그 글자 복사 + «경로를 복사했습니다»** · 스텝 안 펼침·요청 0 · ↗ 절대 경로 · ⤢ 절대 경로로 지금 파일만(조각·강조 없음 · «읽은 당시의 기록이 아님») — 출력 전·출력 뒤 둘 다",
        okSurface(liveBefore) && liveHasOut === 1 && okSurface(liveAfter),
        J({ liveBefore, liveHasOut, liveAfter }),
      ),
    );

    // 이력 — 출력 없는 스텝 · 출력 있는 스텝(이 줄은 클릭으로 펼친다)
    const histNo = dash.run(`(() => { const l = buildHistStepLine(${J({ ...P, ts: 1 })}); document.body.appendChild(l); return l; })()`);
    const histOut = dash.run(`(() => { const l = buildHistStepLine(${J({ ...P, ts: 2, output: { text: "READ-TIME-880" } })}); document.body.appendChild(l); return l; })()`);
    const hNo = await exercise(histNo, () => histNo.classList.contains("expanded"));
    const hOut = await exercise(histOut, () => histOut.classList.contains("expanded"));
    // 양성 대조 — 줄 자체를 누르면 펼쳐진다(위 «토글 없음» 이 토글이 원래 안 되는 줄이라서가 아님을 보인다).
    dispatch(histOut, makeEvent("click", { bubbles: true, detail: 1 }));
    const histLineToggles = histOut.classList.contains("expanded");
    out.push(
      assert(
        "★★이력 Read 스텝(새로고침 뒤): 라이브와 같은 경로 동작 — 출력 없는 스텝·출력 있는 스텝 모두 · 경로 클릭은 펼치지 않는다(줄 클릭은 펼친다)",
        okSurface(hNo) && okSurface(hOut) && histLineToggles,
        J({ hNo, hOut, histLineToggles }),
      ),
    );

    // 잡 카드 — 매니저 스텝(시작) → 끝(출력 보관 + 펼침 배선)
    dash.run(`handleWorkerActivity(${J({ ...P, threadKey: "worker:J1", seq: 1 })}, 1)`);
    const jobStep = () => dash.run(`jobCards.get("J1").stepsEl.querySelector('.bg-step[data-seq="1"]')`);
    const jStep = jobStep();
    const jExp = () => jStep.classList.contains("expanded");
    const jBefore = jStep ? await exercise(jStep, jExp) : null;
    dash.run(`annotateToolDuration(${J({ threadKey: "worker:J1", seq: 1, phase: "end", durationMs: 4, output: { text: "READ-TIME-880" } })})`);
    const jAfter = jStep ? await exercise(jStep, jExp) : null;
    if (jStep) dispatch(jStep, makeEvent("click", { bubbles: true, detail: 1 }));
    const jobStepToggles = jStep ? jExp() : false;
    out.push(
      assert(
        "★★잡 카드 Read 스텝: 같은 경로 동작 — 출력 전·출력 뒤 · 경로 클릭은 스텝을 펼치지 않는다(스텝 클릭은 펼친다)",
        jBefore !== null && jAfter !== null && okSurface(jBefore) && okSurface(jAfter) && jobStepToggles,
        J({ jBefore, jAfter, jobStepToggles }),
      ),
    );

    // ⤢ 실패 — 서버가 거절(이유를 말한다) · 요청 자체가 실패. Read 보기엔 «위 조각» 이 없으니 그 문구를 쓰지 않는다(아스트라 11-05 구현 R1).
    const failView = async (mode: "reject" | "network") => {
      failMode = mode;
      dash.run(`openFileView(${J({ path: FILE.path, absPath: FILE.absPath })})`);
      await settle();
      const r = {
        note: doc.querySelectorAll(".fv-note")[0]?.textContent ?? "",
        fileHidden: doc.querySelectorAll(".fv-file")[0]?.hidden ?? null,
        frag: doc.querySelectorAll(".fv-back .fv-frag").length,
        code: doc.querySelectorAll(".fv-back .fv-code").length,
      };
      dispatch(doc, makeEvent("keydown", { key: "Escape" }));
      failMode = null;
      return r;
    };
    const rej = await failView("reject");
    const net = await failView("network");
    out.push(
      assert(
        "★Read ⤢ 가 실패하면 이유를 말하고 파일 칸을 숨긴다 — 서버 거절 이유 그대로 · 요청 실패는 «파일을 읽지 못했습니다» · **«위 조각» 문구 없음** · 조각·본문 없음",
        rej.note === "지금 파일은 보여 주지 않습니다 — 파일이 없습니다(합성)" && net.note === "지금 파일은 보여 주지 않습니다 — 파일을 읽지 못했습니다" &&
          [rej, net].every((x) => x.fileHidden === true && x.frag === 0 && x.code === 0 && !x.note.includes("조각")),
        J({ rej, net }),
      ),
    );

    // 참조가 없거나 모양이 틀리면(옛 이벤트 · 절대 경로 없음) 지금처럼 detail 한 줄 — 지어낸 경로로 열 수단을 만들지 않는다
    const plainLive = dash.run(`buildActivityLine(${J({ ...P, file: undefined })})`);
    const relOnly = dash.run(`buildHistStepLine(${J({ ...P, ts: 3, file: { path: "src/a.ts" } })})`);
    out.push(
      assert(
        "참조가 없거나 절대 경로가 없으면 경로 동작을 달지 않고 detail 한 줄 그대로",
        plainLive.querySelectorAll(".act-file-ref").length === 0 && plainLive.querySelectorAll(".act-detail")[0]?.textContent === P.detail &&
          relOnly.querySelectorAll(".act-file-ref").length === 0 && relOnly.querySelectorAll(".hist-tool-detail")[0]?.textContent === P.detail,
        J({ live: plainLive.querySelectorAll(".act-file-ref").length, hist: relOnly.querySelectorAll(".act-file-ref").length }),
      ),
    );

    // ── ③ Write/Edit 보존 — 같은 함수로 옮긴 뒤에도 그대로 ─────────────────────────
    copies.length = 0; opened.length = 0; viewed.length = 0; resetToast();
    const EDIT = { path: "src/b.ts", absPath: "/proj/src/b.ts", startLine: 3, added: 1, removed: 1, lines: [{ op: "-", text: "x" }, { op: "+", text: "y" }] };
    const editLine = dash.run(`(() => { const l = buildActivityLine(${J({ ...P, seq: 9, label: "Edit", detail: "file_path=src/b.ts", file: undefined, diff: EDIT })}); document.body.appendChild(l); return l; })()`);
    const head = editLine.querySelectorAll(".act-diff-head")[0];
    const ePath = head?.querySelectorAll(".act-diff-path")[0];
    const eBefore = editLine.classList.contains("expanded");
    if (ePath) dispatch(ePath, makeEvent("click", { bubbles: true, detail: 1 }));
    await settle();
    const eCopy = { copies: [...copies], toast: toast(), toggled: editLine.classList.contains("expanded") !== eBefore };
    const eBtns = head ? head.querySelectorAll("button") : [];
    const eOpen = eBtns.find((b: { className: string }) => !b.className.includes("act-diff-fileview"));
    if (eOpen) dispatch(eOpen, makeEvent("click", { bubbles: true, detail: 1 }));
    await settle();
    const relEditLine = dash.run(`buildActivityLine(${J({ ...P, seq: 10, label: "Write", file: undefined, diff: { path: "rel/c.ts", startLine: 1, added: 1, removed: 0, lines: [{ op: "+", text: "z" }] } })})`);
    const relOpen = relEditLine.querySelectorAll(".act-diff-head button")[0];
    if (relOpen) dispatch(relOpen, makeEvent("click", { bubbles: true, detail: 1 }));
    await settle();
    const eSummary = head?.querySelectorAll(".act-diff-stat")[0]?.textContent ?? "";
    const eOrder = head ? head.children.map((c: { className: string }) => c.className) : [];
    out.push(
      assert(
        "★Write/Edit 보존: 경로 클릭 = `경로:줄` 복사 + 같은 안내 · 펼치지 않음 · ↗ 는 `absPath`(없으면 종전대로 `path`) · 접힘 요약 `+1 -1` · 머리 순서(캐럿·경로·↗·⤢·요약) · Read 경로 동작은 안 붙음",
        J(eCopy.copies) === J(["src/b.ts:3"]) && eCopy.toast === "경로를 복사했습니다" && !eCopy.toggled &&
          J(opened) === J(["/proj/src/b.ts", "rel/c.ts"]) && eSummary === "+1 -1" &&
          J(eOrder) === J(["act-diff-caret", "act-diff-path act-diff-path-copy", "act-diff-open", "act-diff-open act-diff-fileview", "act-diff-stat"]) &&
          editLine.querySelectorAll(".act-file-ref").length === 0 && editLine.querySelectorAll(".act-detail").length === 0,
        J({ eCopy, opened, eSummary, eOrder }),
      ),
    );

    // ── ④ 이력 투영 — 시작 스텝에 `file` 통과 ───────────────────────────────────
    const hist = await loadPluginModule<{ historyActivities: (e: Array<{ ts: number }>, k?: string) => Array<Record<string, unknown>> }>("../../../plugins/http-bridge/history-activities.js");
    const T0 = Date.now() - 60_000;
    const HK = "dashboard:regr-read-ref-hist";
    insertEvent(T0 + 1, "llm.activity", J({ ...P, threadKey: HK, adapter: "codex", seq: 0 }));
    insertEvent(T0 + 2, "llm.activity", J({ threadKey: HK, adapter: "codex", seq: 0, kind: "tool", label: "Read", phase: "end", output: { text: "READ-TIME" } }));
    const acts = hist.historyActivities([{ ts: T0 }], HK).filter((a) => a.label === "Read");
    out.push(
      assert(
        "이력 투영: Read 시작 스텝이 `file` 을 그대로 싣고, 끝 이벤트의 출력도 같은 스텝에 붙는다(새 스텝 아님)",
        acts.length === 1 && J(acts[0]!.file) === J(FILE) && (acts[0]!.output as { text?: string } | undefined)?.text === "READ-TIME",
        J(acts),
      ),
    );

    // ── ⑤ 세 어댑터 — 그 Read 를 실제로 푼 기준(홈 턴 · 프로젝트 턴) ──────────────────
    type R = { scenario: string; file: { path?: string; absPath?: string; startLine?: number } | null; outText: string; base: string; err?: string };
    for (const ad of ["claude", "codex", "openai"] as const) {
      const rr = await spawnWithin(120_000, `read-ref-${ad}`, ["--import", "tsx", path.join(HERE, "_read-file-ref-adapters-child.ts"), ad], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
      });
      const rs = (lastArray(rr.out) as R[] | undefined) ?? (rr.timedOut ? "timeout" : rr.err.slice(-400));
      if (!Array.isArray(rs)) { out.push(assert(`⑤ ${ad} 자식이 결과를 낸다`, false, rs)); continue; }
      const ok = (s: R | undefined, mark: string): boolean =>
        s !== undefined && s.err === undefined && s.file !== null && s.file.path === "notes/a.txt" && s.file.startLine === 2 &&
        s.file.absPath === path.join(s.base, "notes", "a.txt") && (ad === "claude" || s.outText.includes(mark));
      const home = rs.find((x) => x.scenario === "home"), proj = rs.find((x) => x.scenario === "proj");
      out.push(
        assert(
          `★★⑤ ${ad}: 상대 경로 Read 의 \`file.absPath\` = 그 Read 를 푼 기준 — 홈 턴(input.cwd 없음)은 홈 · 프로젝트 턴은 프로젝트${ad === "claude" ? "(SDK 와 같은 cwd)" : " · **실제 읽은 내용이 그 파일**"}`,
          ok(home, "HOME-MARK-2") && ok(proj, "PROJ-MARK-2"),
          J(rs),
        ),
      );
    }
    return out;
  },
};
