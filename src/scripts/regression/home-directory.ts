import { EventEmitter } from "node:events";
import { spawnSync, type execFile } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";

export const check: RegressionCheck = {
  name: "home-directory",
  guards: "설정에서 홈을 찾지 못한 불편, 임의 경로 실행·거짓 성공·재렌더 중 중복 실행 방지",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { openHomeDirectory } = await import("../../core/open-home-directory.js");
    const { getPaths, __resetPathsCache } = await import("../../core/paths.js");
    const home = getPaths().home;
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const fake = (mode = "ok") => ((cmd: string, args: string[], opts: unknown, done: (e: Error | null) => void) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (mode === "error") child.emit("error", new Error("ENOENT"));
        else {
          child.emit("spawn");
          if (mode === "late-error") child.emit("error", new Error("late"));
          done(mode === "exit-error" ? new Error("nonzero/timeout") : null);
        }
      });
      return child;
    }) as unknown as typeof execFile;
    const rejected = async (f: () => Promise<void>) => { try { await f(); return false; } catch { return true; } };
    await openHomeDirectory("darwin", {}, fake());
    await openHomeDirectory("win32", {}, fake("exit-error"));
    await openHomeDirectory("win32", {}, fake("late-error"));
    await openHomeDirectory("linux", { DISPLAY: ":synthetic" }, fake());
    await openHomeDirectory("linux", { WAYLAND_DISPLAY: "synthetic" }, fake());
    out.push(assert("OS별 고정 홈과 인자·실행 시한·셸 미사용", calls[0]?.cmd === "open" && JSON.stringify(calls[0]?.args) === JSON.stringify(["-a", "Finder", home]) && calls[1]?.cmd === "explorer" && calls[3]?.cmd === "xdg-open" && calls.every((c) => c.args.at(-1) === home && c.opts.timeout === 5000 && !c.opts.shell), calls));
    const before = calls.length;
    const headless = await rejected(() => openHomeDirectory("linux", {}, fake()));
    out.push(assert("headless는 실행 전 실패", headless && calls.length === before, { headless, count: calls.length }));
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const launchFailure = await rejected(() => openHomeDirectory(platform, { DISPLAY: ":synthetic" }, fake("error")));
      out.push(assert(platform + " 실행 전 오류는 실패", launchFailure, launchFailure));
    }
    for (const platform of ["darwin", "linux"] as const) {
      const exitFailure = await rejected(() => openHomeDirectory(platform, { DISPLAY: ":synthetic" }, fake("exit-error")));
      out.push(assert(platform + " 비영종료/시한은 실패", exitFailure, exitFailure));
    }
    const oldHome = process.env.TIGUCLAW_HOME;
    try {
      for (const kind of ["missing", "file"]) {
        const target = path.join(home, "home-directory-" + kind);
        if (kind === "file") writeFileSync(target, "synthetic");
        process.env.TIGUCLAW_HOME = target;
        __resetPathsCache();
        const before = calls.length;
        const fails = await rejected(() => openHomeDirectory("darwin", {}, fake()));
        out.push(assert(kind + " 홈은 탐색기 실행 전에 실패", fails && calls.length === before, fails));
      }
    } finally {
      process.env.TIGUCLAW_HOME = oldHome;
      __resetPathsCache();
    }

    // Real bridge auth/roles and dashboard Host/CSRF/proxy, with OS execution replaced in child only.
    const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./_home-directory-child.ts", import.meta.url))], { env: process.env, encoding: "utf8", timeout: 25000 });
    let data: any = {};
    try { data = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"); } catch { /* assertion includes exit/error */ }
    out.push(assert("API 합성 표시 환경은 호스트 데스크톱과 독립", data.syntheticDisplay === ":synthetic-home-test", data.syntheticDisplay));
    out.push(assert("실제 API 고정 홈·인증·read/write와 실패 전달", r.status === 0 && [401, 403].includes(data.noAuth?.status) && data.get?.body.path === data.home && data.denied?.status === 403 && data.deniedCalls === 0 && data.opened?.status === 200 && data.failed?.status === 500 && data.calls?.every((c: any) => c.args.at(-1) === data.home), { exit: r.status, data, err: r.stderr.slice(-500) }));
    out.push(assert("실제 대시보드 프록시·Host/CSRF 차단은 opener에 도달하지 않음", data.proxyGet?.status === 200 && data.proxyGet?.body.path === data.home && data.csrf?.status === 403 && data.host?.status === 403 && data.csrfCalls === 0 && data.proxyOpen?.status === 200, data));

    // Actual settings script and mini DOM. No clipboard/desktop side effects.
    const boot = (clipboard = true, copyFails = false) => {
      const clock = makeClock();
      const gates: Array<{ url: string; init: any; answer: (data: unknown, status?: number) => void }> = [];
      const copied: string[] = [];
      const dash = bootDashboard({ clock, i18n: i18nForContext, width: 320,
        extra: { navigator: clipboard ? { clipboard: { writeText: async (s: string) => { if (copyFails) throw Error("denied"); copied.push(s); } } } : {} },
        stubs: "const setChatPanel = () => {};",
        fetch: (url: string, init?: any) => {
          if (url === "/api/home-directory" || url === "/api/open-home") return new Promise((resolve) => gates.push({ url, init, answer: (d, s = 200) => resolve(jsonResponse(d, s)) }));
          if (url === "/api/suggestion") return Promise.resolve(jsonResponse({ enabled: true }));
          if (url === "/api/set-suggestion") return Promise.resolve(jsonResponse({ ok: true, enabled: false }));
          return Promise.resolve(jsonResponse({}, 404));
        },
      });
      const row = () => dash.document.querySelector('[data-settings-row="home-directory"]') as MElement;
      const copy = () => row().querySelectorAll("button")[0] as MElement;
      const open = () => row().querySelectorAll("button")[1] as MElement;
      const answer = (url: string, d: unknown, s = 200) => { const i = gates.findIndex((g) => g.url === url); const g = gates.splice(i, 1)[0]; if (!g) throw Error("missing request " + url); g.answer(d, s); return g; };
      const settle = () => clock.advance(5);
      dash.run("showSettings()");
      return { dash, row, copy, open, answer, gates, copied, settle, clock };
    };
    const long = "/synthetic/" + "긴 경로 & <script> ; $(x) ".repeat(30);
    {
      const b = boot(); await b.settle();
      const loading = b.copy().disabled && b.open().disabled;
      b.answer("/api/home-directory", { path: long }); await b.settle();
      b.copy().click(); await b.settle();
      out.push(assert("긴 경로는 HTML 없이 표시·복사되고 원격 실행 안내가 보임", loading && b.row().querySelector("code")?.textContent === long && !b.row().querySelector("script") && b.copied[0] === long && b.row().textContent.includes("비서가 실행 중인 컴퓨터에서 열립니다."), b.row().textContent));
      b.open().click(); b.open().click(); await b.settle();
      const first = b.gates.filter((g) => g.url === "/api/open-home");
      const root = b.dash.document.getElementById("detail-panel")!;
      (root.querySelector(".settings-row:not(.settings-home-row) button") as MElement)?.click();
      await b.settle();
      b.answer("/api/home-directory", { path: long }); await b.settle();
      b.open().click(); await b.settle();
      const locked = b.open().disabled && b.gates.filter((g) => g.url === "/api/open-home").length === 1;
      const req = b.answer("/api/open-home", { ok: true }); await b.settle();
      out.push(assert("중복 클릭·설정 재렌더 중 잠금, POST 경로 입력 없음·성공은 창 확인 아님", first.length === 1 && locked && req.init.method === "POST" && req.init.body === undefined && !b.open().disabled && b.row().textContent.includes("창 표시는 확인하지 않았습니다."), { locked, req, text: b.row().textContent }));
      b.open().click(); await b.settle(); b.answer("/api/open-home", { error: "synthetic" }, 500); await b.settle();
      out.push(assert("열기 실패가 보이고 재시도 가능", !b.open().disabled && b.row().textContent.includes("열기 요청에 실패"), b.row().textContent));
      out.push(assert("UI 비동기 미처리 오류 없음", b.clock.errors.length === 0, b.clock.errors));
    }
    for (const opts of [[false, false], [true, true]]) {
      const b = boot(opts[0], opts[1]); await b.settle(); b.answer("/api/home-directory", { path: long }); await b.settle(); b.copy().click(); await b.settle();
      out.push(assert("클립보드 부재/거절은 실패 표시", b.copied.length === 0 && b.row().textContent.includes("복사하지 못했습니다."), b.row().textContent));
    }
    for (const response of [{ error: "no home" }, { path: "" }]) {
      const b = boot(); await b.settle(); b.answer("/api/home-directory", response, "error" in response ? 500 : 200); await b.settle(); b.copy().click(); b.open().click(); await b.settle();
      out.push(assert("조회 실패/무효 응답은 조작 불가·명시 오류", b.copy().disabled && b.open().disabled && b.gates.length === 0 && b.row().textContent.includes("홈 경로를 불러오지 못했습니다."), b.row().textContent));
    }
    const css = readFileSync(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
    const pathRule = css.match(/\.settings-home-path\s*\{[^}]*\}/)?.[0] ?? "";
    const actionsRule = css.match(/\.settings-home-actions\s*\{[^}]*\}/)?.[0] ?? "";
    out.push(assert("장경로·모바일 줄바꿈 배선", pathRule.includes("overflow-wrap:anywhere") && actionsRule.includes("flex-wrap:wrap"), { pathRule, actionsRule, pixelLayoutMeasured: false }));
    return out;
  },
};
