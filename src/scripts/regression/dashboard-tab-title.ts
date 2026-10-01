/**
 * 회귀: **탭 제목을 사용자가 실제로 쓰는 길로 바꾼다** (2026-10-01 정태님 «티구클로 대시보드 를 다른 걸로» · 적대 검토 F2~F6).
 *
 * 지키는 것:
 *  ① 화면 → HTTP 저장(`/set-theme` 의 dashboardTitle) → settings.json 왕복 — 저장했다고 답한 값이 실제로 남는다(F3: 저장하는 척 변이가 살았다)
 *  ② 설정 칸(실제 소스를 떼어 가짜 DOM 에서): 보내는 키 · 저장 뒤 탭 즉시 갱신 · **사용자 제목이 있던 상태에서 비우면 원본 제목으로**(F2)
 *  ③ 비서 도구 set_appearance: 빈 값은 «변경 없음», 해제는 `none` 만(F4) · 틀린 테마는 제목을 건드리지 않고 거절(F5)
 *  ④ 글자 단위로 자른다 — 이모지 반쪽이 남지 않는다 · 읽기에도 같은 상한(F6)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const read = (file: string): string => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const fn = (source: string, name: string): string => {
  const start = source.indexOf(`      const ${name} =`);
  const end = source.indexOf("\n      };", start);
  if (start < 0 || end < 0) throw Error(`missing function ${name}`);
  return source.slice(start, end + "\n      };".length);
};

export const check: RegressionCheck = {
  name: "dashboard-tab-title",
  guards: "탭 제목 저장이 화면·HTTP 길에서 그물 없이 깨질 수 있던 것 · 사용자 제목이 있던 상태에서 비워도 탭이 안 돌아가던 것 · 도구의 빈 값이 제목을 지우던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const S = await import("../../core/settings.js");

    // ① HTTP 왕복 — 실제 http 서버에 브리지 핸들러를 꽂는다.
    const routes = await loadPluginModule<{ handleSetTheme: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-settings.js");
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes.handleSetTheme({ req, res, url, pathname: url.pathname, channelName: "http-bridge", bus: null });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`http://127.0.0.1:${port}/set-theme`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    let http1: unknown, httpRead = "", httpCleared = "x";
    try {
      const r = await post({ dashboardTitle: "  HTTP 제목  " });
      http1 = r;
      httpRead = S.readDashboardTitle();
      await post({ dashboardTitle: "" });
      httpCleared = S.readDashboardTitle();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    out.push(assert("★① 화면→HTTP 저장→settings.json 왕복: 답한 값이 실제로 남고 · 빈 값이면 기본으로",
      (http1 as { status: number; json: { dashboardTitle?: string } }).status === 200 && (http1 as { json: { dashboardTitle?: string } }).json.dashboardTitle === "HTTP 제목" &&
        httpRead === "HTTP 제목" && httpCleared === "", { http1, httpRead, httpCleared }));

    // ② 설정 칸 — 실제 소스 함수(postTheme·buildTitleRow)를 가짜 DOM·fetch 로 돌린다.
    const src = read("packages/dashboard/js/view-models.js");
    class El {
      children: El[] = []; className = ""; title = ""; textContent = ""; type = ""; value = ""; placeholder = ""; maxLength = 0; disabled = false;
      private h: Record<string, Array<(e: unknown) => unknown>> = {};
      appendChild(c: El): El { this.children.push(c); return c; }
      addEventListener(t: string, f: (e: unknown) => unknown): void { (this.h[t] ??= []).push(f); }
      fire(t: string): unknown[] { return (this.h[t] ?? []).map((f) => f({ key: "" })); }
      blur(): void {}
    }
    const sent: Array<Record<string, unknown>> = [];
    const doc = { title: "회사", createElement: () => new El() };
    const ctx = vm.createContext({
      window: { __TIGU_THEME__: { title: "회사", defaultTitle: "티구클로 대시보드" } },
      document: doc, i18n: (k: string) => k, showToast: () => {}, JSON, Promise,
      fetch: async (_u: string, init: { body: string }) => {
        const b = JSON.parse(init.body) as Record<string, unknown>; sent.push(b);
        return { ok: true, json: async () => ({ ok: true, dashboardTitle: String(b.dashboardTitle ?? "").trim() }) };
      },
    });
    vm.runInContext([fn(src, "postTheme"), fn(src, "buildTitleRow"), "globalThis.build = buildTitleRow;"].join("\n"), ctx);
    const row = (ctx as unknown as { build: () => El }).build();
    const inp = row.children[1]!;
    const placeholder = inp.placeholder;
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20)); // 칸 핸들러는 `void save()` — 끝을 기다린다
    inp.value = "";
    inp.fire("change"); await settle();
    const afterClear = doc.title;
    inp.value = "다른";
    inp.fire("change"); await settle();
    const afterSet = doc.title;
    out.push(assert("★② 설정 칸: dashboardTitle 키로 보내고 · 저장 뒤 탭이 바로 바뀌고 · 사용자 제목이 있던 상태에서 비우면 원본 제목으로",
      inp.value === "다른" && placeholder === "티구클로 대시보드" && afterClear === "티구클로 대시보드" && afterSet === "다른" &&
        sent.length === 2 && "dashboardTitle" in sent[0]! && sent[0]!.dashboardTitle === "" && sent[1]!.dashboardTitle === "다른",
      { placeholder, afterClear, afterSet, sent }));
    const placed = /page\.appendChild\(buildTitleRow\(\)\);/.exec(src)?.[0] ?? "(설정 화면에 배치 없음)";
    out.push(assert("② 설정 화면에 그 칸이 실제로 붙는다", placed.startsWith("page.appendChild"), placed));

    // ③ 비서 도구 — 등록된 핸들러를 그대로.
    const { createModelSettingsMcpServer } = await import("../../core/llm-runtime/capabilities/model-settings-mcp.js");
    const reg = (createModelSettingsMcpServer(process.cwd()) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean }> }> } }).instance._registeredTools;
    S.setDashboardTitle("유지될 제목");
    await reg["set_appearance"]!.handler({ name: "", title: "" }, {});
    const keptOnEmpty = S.readDashboardTitle();
    const bogus = await reg["set_appearance"]!.handler({ name: "없는-테마-xyz", title: "바뀌면 안 됨" }, {});
    const keptOnBogus = S.readDashboardTitle();
    S.setDashboardTitle("");
    out.push(assert("③ 도구: 빈 값은 변경 없음(제목 유지) · 틀린 테마는 거절하면서 제목도 안 바꾼다",
      keptOnEmpty === "유지될 제목" && bogus.isError === true && keptOnBogus === "유지될 제목", { keptOnEmpty, bogus: bogus.isError, keptOnBogus }));

    // ④ 글자 단위 자르기
    const saved = S.setDashboardTitle("가".repeat(59) + "😀더");
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(saved);
    S.setDashboardTitle("");
    out.push(assert("④ 글자 단위로 60자 — 이모지가 반쪽으로 잘리지 않는다", !lone && Array.from(saved).length === 60 && saved.endsWith("😀"), { len: Array.from(saved).length, lone }));
    return out;
  },
};
