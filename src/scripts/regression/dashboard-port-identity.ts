/**
 * 회귀: **포트를 물고 있는 게 우리 대시보드인지 확인한다** (2026-08-01, 실측으로 두 번 재현).
 *
 * 사고 형상: 중복기동 방지가 `fetch('/')` 가 응답하기만 하면 "우리 대시보드가 이미 떠 있다"
 * 고 단정했다. 그래서 **다른 앱**이 포트를 물고 있으면 대시보드는 안 뜨는데 로그는
 *   `dashboard: already up on http://127.0.0.1:3000 — spawn skipped`
 * 라고 말했다. 사용자는 그 주소를 열어 **남의 앱**을 본다. 3000 은 Next.js·Rails 의 기본값
 * 이라 흔한 상황이다. 실제로 이 기계에서 두 번 재현했다 — 우리 **브리지**(3000)와
 * 우리 **대시보드**(3101)를 각각 "대시보드가 이미 떠 있다" 로 셌다.
 *
 * ★두 갈래(살아있다/없다)로는 표현할 수 없는 상태였다. **셋**이어야 한다 —
 *  `free`(spawn 한다) · `ours`(건너뛴다) · `foreign`(**경고**하고 건너뛴다).
 *  foreign 을 free 로 접으면 spawn 했다가 EADDRINUSE 로 죽고, ours 로 접으면 지금 사고다.
 *
 * ★판정은 대시보드 **자신이** 답하는 것으로 한다. `/api/health` 는 bridge 로 프록시되므로
 *  브리지가 죽으면 우리 대시보드를 남의 것으로 오판한다(같은 병의 반대 방향).
 *
 * 이 검사는 **진짜 서버 셋**을 띄워 세 상태를 다 밟는다(문자열 확인 아님).
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 임시 HTTP 서버 — 임의 빈 포트에 띄우고 포트 번호를 돌려준다. */
const serve = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: string; close: () => Promise<void> }> => {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? String(addr.port) : "0";
  return {
    port,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
};

export const check: RegressionCheck = {
  name: "dashboard-port-identity",
  guards:
    "다른 앱이 포트를 물고 있어도 '대시보드가 이미 떠 있다' 고 로그하고 넘어가 대시보드가 조용히 안 뜨던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { probeLocalPort } = await import("../../core/local-port-probe.js");
    const plugin = readFileSync(path.join(REPO, "plugins/dashboard/index.ts"), "utf8");

    // ★① 마커가 실제로 **서빙되는 HTML** 에 있는가 — 어긋나면 우리 것을 남의 것으로
    //  오판해 경고를 띄우고 대시보드를 안 띄운다. 마커는 두 파일에 있으니(플러그인이 찾는
    //  문자열 · index.html 이 내보내는 문자열) 대조가 필요하다. `plugins/` 는 typecheck
    //  밖이라 컴파일러가 못 잡는 자리다.
    const mk = /const DASHBOARD_MARKER = "([^"]+)"/.exec(plugin);
    const html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const DASHBOARD_MARKER = mk?.[1] ?? "";
    out.push(
      assert(
        "★플러그인이 찾는 마커가 실제 서빙되는 index.html 에 있다",
        mk !== null && html.includes(DASHBOARD_MARKER),
        mk === null
          ? "★플러그인에서 마커를 못 찾음 — 검사 불가"
          : html.includes(DASHBOARD_MARKER)
            ? `"${DASHBOARD_MARKER}" 양쪽 일치`
            : `★index.html 에 "${DASHBOARD_MARKER}" 없음 — 우리 대시보드를 남의 것으로 오판한다`,
      ),
    );

    // ★② 우리 대시보드 — 마커가 든 HTML 을 주는 서버.
    const ours = await serve((_q, r) => {
      r.writeHead(200, { "content-type": "text/html" });
      r.end(`<!doctype html><title>${DASHBOARD_MARKER}</title><body>…`);
    });
    // ★③ 남의 앱 — 응답은 200 이지만 마커가 없다(Next.js 등이 이 자리에 있는 상황).
    const foreign = await serve((_q, r) => {
      r.writeHead(200, { "content-type": "text/html" });
      r.end("<!doctype html><title>My Next.js App</title><body>…");
    });
    // ★④ 본문을 못 주는 점유자 — 응답 헤더만 주고 끊는다. **free 로 내려가면 안 된다**
    //  (spawn 했다가 EADDRINUSE 로 죽는다).
    const halfDead = await serve((_q, r) => {
      // 헤더 + 본문 일부를 **실제로 흘린 뒤** 끊는다. 바로 destroy 하면 fetch 자체가 실패해
      // free 로 떨어져(= 다른 경로를 밟아) 이 케이스를 검사하지 못한다.
      r.writeHead(200, { "content-type": "text/html", "content-length": "999999" });
      r.write("<!doctype html><title>");
      setTimeout(() => r.destroy(), 20);
    });
    // ★⑤ 빈 포트 — 위 서버 하나를 닫아 **확실히 비어 있는** 포트를 얻는다(임의 번호 추측 금지).
    const spare = await serve((_q, r) => r.end("x"));
    const freePort = spare.port;
    await spare.close();

    try {
      const cases: Array<[string, string, string]> = [
        ["★우리 대시보드는 ours", "ours", await probeLocalPort(ours.port, DASHBOARD_MARKER, 800)],
        ["★남의 앱은 foreign — 우리 것으로 세지 않는다", "foreign", await probeLocalPort(foreign.port, DASHBOARD_MARKER, 800)],
        ["★본문을 못 읽어도 free 로 내려가지 않는다", "foreign", await probeLocalPort(halfDead.port, DASHBOARD_MARKER, 800)],
        ["빈 포트는 free", "free", await probeLocalPort(freePort, DASHBOARD_MARKER, 800)],
      ];
      const bad = cases.filter(([, want, got]) => want !== got);
      out.push(
        assert(
          `★포트 상태 판정 ${cases.length}종이 옳다(진짜 서버로 실측)`,
          bad.length === 0,
          bad.length === 0
            ? cases.map(([d, w]) => `${d.replace("★", "")}=${w}`).join(" / ")
            : bad.map(([d, w, g]) => `${d}: 기대 ${w} 실제 ${g}`).join(" / "),
        ),
      );
    } finally {
      await ours.close();
      await foreign.close();
      await halfDead.close();
    }

    // ★⑥ 배선 — 세 갈래를 **전부** 분기하는가. `foreign` 을 안 다루면 위 판정이 있어도
    //  호출부가 뭉개서 사고가 그대로 재현된다(판정과 사용은 다른 것이다).
    const src = plugin;
    const branches = ['=== "ours"', '=== "foreign"'].filter((b) => src.includes(b));
    out.push(
      assert(
        "★호출부가 ours·foreign 을 각각 분기한다",
        branches.length === 2,
        branches.length === 2 ? "두 갈래 모두 분기" : `★누락: ${branches.join(",") || "전부"}`,
      ),
    );
    // foreign 은 **경고**여야 한다 — 조용히 넘어가면 사고의 본질(안 뜬 걸 모른다)이 남는다.
    out.push(
      assert(
        "★남의 앱이 물고 있으면 경고로 남는다(조용한 skip 0)",
        /state === "foreign"[\s\S]{0,200}console\.warn/.test(src),
        /state === "foreign"[\s\S]{0,200}console\.warn/.test(src) ? "warn 확인" : "★조용히 넘어감",
      ),
    );
    // 진단 재료 — 어느 포트인지와 확인 명령이 로그에 있어야 원격에서도 잡는다.
    out.push(
      assert(
        "경고에 포트 번호와 확인 방법이 실려 있다(로그만으로 잡을 수 있게)",
        /lsof/.test(src) && /DASHBOARD_PORT/.test(src),
        `lsof=${/lsof/.test(src)} 조치안내=${/DASHBOARD_PORT/.test(src)}`,
      ),
    );
    return out;
  },
};
