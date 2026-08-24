/**
 * tiguclaw-dashboard — *외부* process dashboard (architect contract 2026-05-15).
 *
 * 데몬과 분리된 별도 process. http-bridge endpoint 만 통해 통신.
 *  - 정적 HTML serve (`/`, `/index.html`)
 *  - 정적 앱 CSS serve (`/app.css`, dashboard-split Phase1 — ADR 2026-07-16)
 *  - same-origin proxy (`/api/*`) — token server-side 주입, browser 미노출
 *
 * routes:
 *  - GET  /app.css       → 정적 파일 (index.html 과 동일 no-store, 코드는 캐시 안 함)
 *  - GET  /js/<name>.js  → 정적 파일 (dashboard-split Phase2a, js/_manifest.json 화이트리스트)
 *  - GET  /api/inventory → bridge GET  /inventory       (JSON pass)
 *  - GET  /api/inventory-item → bridge GET /inventory-item?source= (JSON pass, 능력 항목 정의 본문·allowlist)
 *  - GET  /api/channels  → bridge GET  /channels        (JSON pass, 라이브 채널 presence 읽기전용)
 *  - GET  /api/context-menu-items → bridge GET /context-menu-items (JSON pass, 컨텍스트메뉴 외부 기여)
 *  - GET  /api/providers → bridge GET  /providers       (JSON pass)
 *  - GET  /api/model-profiles → bridge GET /model-profiles (JSON pass, 모델 프로파일 표시)
 *  - POST /api/set-default-profile → bridge POST /set-default-profile (write, 기본 프로파일 포인터 설정)
 *  - POST /api/set-suggestion → bridge POST /set-suggestion (write, 다음 메시지 제안 on/off)
 *  - GET  /api/suggestion → bridge GET /suggestion (read, 현재 값)
 *  - POST /api/set-egress → bridge POST /set-egress (write, 함께 보낼 채널)
 *  - GET  /api/egress → bridge GET /egress (read, 현재 값 + 가능 채널)
 *  - POST /api/set-session-profile → bridge POST /set-session-profile (write, 이 세션(탭)만 sticky 프로파일)
 *  - POST /api/set-module-enabled → bridge POST /set-module-enabled (write, 모듈 활성/비활성 — P4a-2)
 *  - GET  /api/health    → bridge GET  /health          (JSON pass)
 *  - GET  /api/chat-history → bridge GET /chat-history  (JSON pass, 대화 이력 복원; threadKey qs 통과)
 *  - GET  /api/chat-search → bridge GET /chat-search    (JSON pass, 전 세션 가로질러 채팅 검색)
 *  - GET  /api/all-activity → bridge GET /all-activity  (JSON pass, 전체활동 크로스세션 타임라인)
 *  - GET  /api/sessions  → bridge GET  /sessions        (JSON pass, 멀티세션 탭 목록+프리뷰)
 *  - GET  /api/projects  → bridge GET  /projects        (JSON pass, 프로젝트 목록)
 *  - GET  /api/projects/detail → bridge GET /projects/detail (JSON pass, 프로젝트 상세)
 *  - GET  /api/projects/capability → bridge GET /projects/capability (JSON pass, 프로젝트 전용 스킬·에이전트 본문)
 *  - GET  /api/events    → bridge GET  /events          (SSE pipe)
 *  - POST /api/messages  → bridge POST /messages        (body forward)
 *  - POST /api/session-name → bridge POST /session-name (write, 세션 커스텀 이름 설정)
 *  - POST /api/restart   → bridge POST /restart         (admin, 데몬 재시작)
 *  - POST /api/cancel-queued → bridge POST /cancel-queued (admin, 대기 중 메시지 취소)
 *  - POST /api/cancel-worker → bridge POST /cancel-worker (write, 진행 중 백그라운드 워커 취소)
 *  - GET  /api/shells    → bridge GET  /shells          (JSON pass, 백그라운드 셸 관측 레인 시드)
 *  - GET  /api/shell-output → bridge GET /shell-output  (JSON pass, ★비소비 tail 스냅샷 폴링)
 *  - POST /api/kill-shell → bridge POST /kill-shell     (write, 백그라운드 셸 강제 종료)
 *
 * 외부 의존 0 — node 표준 http/fs/path/url 만. Channel/Observer import 0 (외부 client).
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dashboard-split Phase2 (ADR 2026-07-16) — /js/<name>.js 화이트리스트. _manifest.json
// (로드순서 배열)을 기동 시 1회 읽어 Set 화 — 라우팅 데이터테이블. 매니페스트 없으면 빈
// 화이트리스트(그 phase 이전엔 /js/ 라우트 자체가 무의미 — 404 로 저절로 닫힘).
const JS_MANIFEST_PATH = path.join(__dirname, "js", "_manifest.json");
let jsWhitelist: Set<string> = new Set();
try {
  const manifest: unknown = JSON.parse(
    fsSync.readFileSync(JS_MANIFEST_PATH, "utf8"),
  );
  if (Array.isArray(manifest)) {
    jsWhitelist = new Set(manifest.map((n) => path.basename(String(n))));
  }
} catch {
  jsWhitelist = new Set();
}

const BRIDGE_PORT = parseInt(process.env.HTTP_BRIDGE_PORT ?? "7011", 10);
const BRIDGE_HOST = process.env.HTTP_BRIDGE_HOST ?? "localhost";
const BRIDGE_TOKEN = process.env.HTTP_BRIDGE_TOKEN;
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "7010", 10);
// loopback 바인딩 기본 — 원격 노출은 tailscale serve(→127.0.0.1:<port> 프록시)가 담당.
// 와일드카드(::)로 바인딩하면 tailscaled 가 잡은 tailnet-IP:<port> 와 EADDRINUSE 충돌 →
// 대시보드가 못 떠 tailscale 프록시가 502 를 낸다. LAN 직접노출 필요 시 env 로 override.
const DASHBOARD_HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";

if (BRIDGE_TOKEN === undefined || BRIDGE_TOKEN.trim().length === 0) {
  console.error(
    "ERROR: HTTP_BRIDGE_TOKEN required. Same value as daemon. Put in .env to share.",
  );
  process.exit(1);
}

const TOKEN: string = BRIDGE_TOKEN.trim();

const bridgeUrl = (p: string): string =>
  `http://${BRIDGE_HOST}:${BRIDGE_PORT}${p}`;

const proxyJson = async (
  res: http.ServerResponse,
  bridgePath: string,
  init?: RequestInit,
): Promise<void> => {
  try {
    const r = await fetch(bridgeUrl(bridgePath), {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    const text = await r.text();
    res.writeHead(r.status, {
      "Content-Type":
        r.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    res.end(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `bridge unreachable: ${msg}` }));
  }
};

// 바이너리 프록시(첨부 파일) — 토큰 server-side 주입, bridge 의 content-type 보존. 첨부는
// 작아(이미지 수십KB~수MB) arrayBuffer 버퍼링으로 충분(스트리밍 불요).
const proxyRaw = async (
  res: http.ServerResponse,
  bridgePath: string,
): Promise<void> => {
  try {
    const r = await fetch(bridgeUrl(bridgePath), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": r.headers.get("cache-control") ?? "private, max-age=86400",
    });
    res.end(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `bridge unreachable: ${msg}` }));
  }
};

const proxySse = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  try {
    const r = await fetch(bridgeUrl("/events"), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok || r.body === null) {
      res.writeHead(r.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`bridge error ${r.status}`);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      reader.cancel().catch(() => {
        /* ignore */
      });
    };
    req.on("close", cancel);
    req.on("error", cancel);
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        res.write(decoder.decode(value, { stream: true }));
      } catch {
        cancel();
        break;
      }
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
  } catch (e) {
    if (!res.headersSent) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`bridge unreachable: ${msg}`);
    }
  }
};

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${DASHBOARD_PORT}`,
    );
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // ★CSRF 가드 (2026-08-02, 실증으로 확인된 결함) ─────────────────────────────
    //  이 프록시는 `/api/*` 요청에 **브리지 토큰을 서버 쪽에서 붙여** 대신 보낸다.
    //  토큰이 브라우저에 노출되지 않는 건 맞지만, **프록시가 대신 붙여주므로** 사용자가
    //  방문한 아무 웹페이지나 `127.0.0.1:<port>/api/...` 로 POST 하면 그 부작용이 그대로
    //  일어난다. `Content-Type: text/plain` 이면 CORS 프리플라이트도 안 걸린다(단순 요청) —
    //  응답을 못 읽을 뿐 **부작용은 이미 났다**. 실측: `Origin: https://evil.example` 로
    //  `/api/open-path` 를 쏘니 그대로 처리됐다(403 은 경로 화이트리스트 덕이지 CSRF 가 아님).
    //
    //  ★이름을 열거하지 않는다 — **부작용이 있는 메서드 전부**(GET·HEAD 외)를 same-origin
    //   으로 제한한다. 새 POST 엔드포인트가 생겨도 저절로 덮인다.
    //  판정: `Sec-Fetch-Site`(현대 브라우저가 항상 보냄) 우선, 없으면 `Origin` 을 본다.
    //   둘 다 없으면 브라우저가 아니다(curl·스크립트) → 통과시킨다. 로컬 셸에서 쓰는
    //   진단·자동화를 막을 이유가 없고, 막아도 CSRF 방어에 보탬이 안 된다(공격면은 브라우저다).
    if (method !== "GET" && method !== "HEAD") {
      const site = String(req.headers["sec-fetch-site"] ?? "");
      const origin = String(req.headers["origin"] ?? "");
      const sameOrigin =
        site === ""
          ? origin === "" || origin === `http://${req.headers.host ?? ""}`
          : site === "same-origin" || site === "none";
      if (!sameOrigin) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: "cross-site 요청 차단(CSRF) — 대시보드 화면에서만 호출할 수 있습니다.",
          }),
        );
        return;
      }
    }

    // 정적 HTML.
    if ((pathname === "/" || pathname === "/index.html") && method === "GET") {
      try {
        const html = await fs.readFile(
          path.join(__dirname, "index.html"),
          "utf8",
        );
        // no-store — HTML(대시보드 코드)은 매 로드 최신을 받아야 한다. 캐시 헤더 없으면 브라우저가
        // heuristic 캐싱으로 옛 index.html 을 써서 업데이트(버그 픽스)가 일반 새로고침에 반영 안 됨.
        // (vendored .js 는 내용 고정이라 max-age 캐시 유지 — 코드는 index.html 에만 있음.)
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(html);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("dashboard html load failed");
      }
      return;
    }

    // 앱 CSS (dashboard-split Phase1, ADR 2026-07-16) — index.html 의 <style> 이 그대로
    // 옮겨온 코드다. index.html 과 동일하게 no-store(옛 코드 잔존 방지, 코드는 캐시 안 함).
    if (pathname === "/app.css" && method === "GET") {
      try {
        const css = await fs.readFile(
          path.join(__dirname, "app.css"),
          "utf8",
        );
        res.writeHead(200, {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(css);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("app.css load failed");
      }
      return;
    }

    // 잎(leaf) JS 파일 (dashboard-split Phase2a, ADR 2026-07-16) — index.html 인라인에서
    // 옮겨온 코드다. 화이트리스트(_manifest.json 기반) + path.basename 강제로 경로 탈출 차단.
    // 데이터테이블 1개(jsWhitelist) — 이름별 분기 없음. index.html 과 동일 no-store(코드 캐시 안 함).
    if (pathname.startsWith("/js/") && method === "GET") {
      const base = path.basename(pathname.slice("/js/".length));
      if (!jsWhitelist.has(base)) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const js = await fs.readFile(path.join(__dirname, "js", base), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(js);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`js/${base} load failed`);
      }
      return;
    }

    // 정적 vendored 마크다운 파서 (marked, 단일파일·외부 의존 0).
    // 브랜드 아이콘 — favicon + apple-touch(폰 홈 화면). 내용이 고정이라 vendored 자산과
    // 같은 캐시 정책(앱 CSS/JS 의 no-store 와 다르다 — 매 요청 재전송할 이유가 없다).
    if (pathname === "/icon.png" && method === "GET") {
      try {
        const buf = await fs.readFile(path.join(__dirname, "icon.png"));
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("icon.png not found");
      }
      return;
    }

    if (pathname === "/marked.min.js" && method === "GET") {
      try {
        const js = await fs.readFile(
          path.join(__dirname, "marked.min.js"),
          "utf8",
        );
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(js);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("marked.min.js load failed");
      }
      return;
    }

    // 정적 vendored 코드 하이라이터 (highlight.js v11, 단일파일·외부 의존 0·CDN 0).
    if (pathname === "/highlight.min.js" && method === "GET") {
      try {
        const js = await fs.readFile(
          path.join(__dirname, "highlight.min.js"),
          "utf8",
        );
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(js);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("highlight.min.js load failed");
      }
      return;
    }

    // API proxy — token browser 미노출.
    if (pathname === "/api/inventory" && method === "GET") {
      await proxyJson(res, "/inventory");
      return;
    }
    // 오늘 로그 상태·비우기 — bridge GET /log-status(read) · POST /log-clear(admin).
    // 설정 뷰의 「로그」 항목이 소비. 비우기는 truncate 로만(지우기·옮기기 없음).
    if (pathname === "/api/log-status" && method === "GET") {
      await proxyJson(res, "/log-status");
      return;
    }
    if (pathname === "/api/log-clear" && method === "POST") {
      await proxyJson(res, "/log-clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return;
    }
    // 업데이트 가용성 — bridge GET /update-availability (read). 헤더 칩이 소비.
    // ★이 경로 목록은 화이트리스트가 맞다(드리프트 신호 아님) — 브라우저가 브리지의
    //  아무 엔드포인트나 부르지 못하게 막는 게 목적이라, 한 줄이 곧 한 번의 허용 결정이다.
    if (pathname === "/api/update-availability" && method === "GET") {
      await proxyJson(res, "/update-availability");
      return;
    }
    // 자가 업데이트 실행 — bridge POST /self-update (admin). 헤더 칩의 확인 팝업이 소비.
    if (pathname === "/api/self-update" && method === "POST") {
      await proxyJson(res, "/self-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return;
    }
    // 인벤토리 항목 정의 본문 — bridge GET /inventory-item?source= (read). source 쿼리 그대로
    // 변경 이력 — bridge GET /changelog (read). 설정 뷰가 마크다운으로 렌더한다.
    if (pathname === "/api/changelog" && method === "GET") {
      await proxyJson(res, "/changelog");
      return;
    }
    // 전달(bridge 가 allowlist 검사 후 파일 재-Read). 능력 상세뷰 본문 섹션이 소비.
    if (pathname === "/api/inventory-item" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/inventory-item" + qs);
      return;
    }
    // 라이브 채널 presence — bridge GET /channels (read 토큰 server-side 주입). 채널 1급
    // 읽기전용 뷰(ADR 2026-07-16 §D4 Phase A). /api/inventory 와 동형 패턴.
    if (pathname === "/api/channels" && method === "GET") {
      await proxyJson(res, "/channels");
      return;
    }
    // MCP 서버가 제공하는 도구 상세(설명·파라미터) — 능력 뷰에서 항목을 열 때만 요청된다.
    if (pathname === "/api/mcp-tools" && method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      await proxyJson(res, `/mcp-tools?name=${encodeURIComponent(name)}`);
      return;
    }
    // 실행 중 백그라운드 잡 하이드레이션(대시보드 부팅 시 라벨 복원 — worker.started SSE 놓친 경우).
    if (pathname === "/api/worker-jobs" && method === "GET") {
      await proxyJson(res, "/worker-jobs");
      return;
    }
    // 엔드포인트 호출 이력 (2026-08-01) — 뷰가 열릴 때 과거를 채운다. 종전엔 라이브 SSE
    // 로만 쌓아 새로고침·재시작이면 전멸했다. 쿼리(limit)를 그대로 넘긴다.
    if (pathname === "/api/endpoint-calls" && method === "GET") {
      await proxyJson(res, `/endpoint-calls${url.search}`);
      return;
    }
    // 컨텍스트메뉴 외부 기여 — bridge GET /context-menu-items (read 토큰 server-side 주입).
    // `_workspace/context-menu_architect_contract.md` §2.3. /api/inventory 와 동형 패턴.
    if (pathname === "/api/context-menu-items" && method === "GET") {
      await proxyJson(res, "/context-menu-items");
      return;
    }
    // 슬래시 명령 목록 — bridge GET /commands (read 토큰 server-side 주입). 대시보드 팝업.
    if (pathname === "/api/commands" && method === "GET") {
      await proxyJson(res, "/commands");
      return;
    }
    if (pathname === "/api/providers" && method === "GET") {
      await proxyJson(res, "/providers");
      return;
    }
    // 모델 프로파일 — bridge GET /model-profiles (read 토큰 server-side 주입). 대시보드 표시.
    if (pathname === "/api/model-profiles" && method === "GET") {
      await proxyJson(res, "/model-profiles");
      return;
    }
    // 기본 프로파일 포인터 설정 — bridge POST /set-default-profile (write 토큰 server-side
    // 주입, browser 미노출). body{name} 그대로 전달 — /api/session-name 과 동일 메커니즘.
    if (pathname === "/api/set-default-profile" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-default-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 다음 메시지 제안 on/off — bridge (write 토큰 server-side 주입, browser 미노출).
    // /set-default-profile 과 동형: 설정 화면 토글이 부르고, settings.json 한 키만 바뀐다.
    if (pathname === "/api/set-suggestion" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // egress 채널(전역) — 컴포저 셀렉터가 읽고 쓴다. write 토큰은 server-side 주입.
    if (pathname === "/api/set-egress" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-egress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    if (pathname === "/api/egress" && method === "GET") {
      await proxyJson(res, "/egress", { method: "GET" });
      return;
    }
    // 현재 값 조회 — 설정 화면 초기 렌더용(읽기).
    if (pathname === "/api/suggestion" && method === "GET") {
      await proxyJson(res, "/suggestion", { method: "GET" });
      return;
    }
    // 세션(탭) 모델 프로파일 설정 — bridge POST /set-session-profile (write 토큰 server-side
    // 주입, browser 미노출). body{threadKey,profile} 그대로 전달 — /set-default-profile 과 동형.
    // 전역 default 는 안 건드림(세션 스코프). ADR model-dropdown §3-b.
    if (pathname === "/api/set-session-profile" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-session-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 모듈 활성/비활성 — bridge POST /set-module-enabled (write 토큰 server-side 주입). P4a-2
    // 프런트(view-providers.js)가 body{name,enabled} 그대로 전달 — /set-default-profile 과 동형.
    if (pathname === "/api/set-module-enabled" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-module-enabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    if (pathname === "/api/health" && method === "GET") {
      await proxyJson(res, "/health");
      return;
    }
    // 대화 이력 — bridge GET /chat-history (read 토큰 server-side 주입). 대시보드가 SSE
    // 연결 전에 과거 채팅 버블을 복원하는 데 사용. limit 쿼리는 그대로 전달.
    if (pathname === "/api/chat-history" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/chat-history" + qs);
      return;
    }
    // 채팅 검색(전 세션 가로질러) — bridge GET /chat-search. q/limit/threadKey 그대로 전달.
    if (pathname === "/api/chat-search" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/chat-search" + qs);
      return;
    }
    // 전체활동(크로스세션) — bridge GET /all-activity (read 토큰 server-side 주입).
    // _workspace/all-activity_architect_contract.md §1.3. /api/chat-history 와 동일 메커니즘
    // (limit/beforeTs 쿼리 그대로 전달), threadKey 스코프 없음(전 스레드 병합이 본질).
    if (pathname === "/api/all-activity" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/all-activity" + qs);
      return;
    }
    // 세션 목록 — bridge GET /sessions (read 토큰 server-side 주입). 대시보드 멀티세션
    // 탭 picker(존재하는 dashboard: 세션 + 프리뷰). /api/providers 패턴 동형.
    if (pathname === "/api/sessions" && method === "GET") {
      await proxyJson(res, "/sessions");
      return;
    }
    // 프로젝트 목록 — bridge GET /projects (read 토큰 server-side 주입). 대시보드 그리드.
    if (pathname === "/api/projects" && method === "GET") {
      await proxyJson(res, "/projects");
      return;
    }
    // 프로젝트 전용 능력 본문 — bridge GET /projects/capability?path=&kind=&name= (read).
    // 프로젝트 상세에서 스킬·에이전트 행을 **누를 때만** 부른다(목록엔 본문을 안 싣는다).
    if (pathname === "/api/projects/capability" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/projects/capability" + qs);
      return;
    }
    // 프로젝트 상세 — bridge GET /projects/detail?path= (read). path 쿼리 그대로 전달.
    if (pathname === "/api/projects/detail" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/projects/detail" + qs);
      return;
    }
    // 첨부 파일 서빙 — bridge GET /attachments/<rel> (read 토큰 server-side 주입). 대시보드
    // 이력 이미지/파일 렌더용. rel 은 encoded 그대로 전달(bridge 가 decode + traversal 방어).
    if (pathname.startsWith("/api/attachments/") && method === "GET") {
      await proxyRaw(res, "/attachments/" + pathname.slice("/api/attachments/".length));
      return;
    }
    if (pathname === "/api/events" && method === "GET") {
      await proxySse(req, res);
      return;
    }
    if (pathname === "/api/messages" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 음성입력 전사(🎤, 2026-07-18) — bridge POST /transcribe (write 토큰 server-side 주입,
    // browser 미노출). /api/messages 동형 프록시. body{dataBase64,mimeType} 그대로 전달.
    if (pathname === "/api/transcribe" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 세션 커스텀 이름 설정 — bridge POST /session-name (write 토큰 server-side 주입,
    // browser 미노출). 계약 _workspace/session-tabs_architect_contract.md §3-3.
    // body{threadKey,name} 그대로 전달 — /api/messages 와 동일 메커니즘.
    if (pathname === "/api/session-name" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/session-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 세션 보관/복원 — bridge POST /session-archive. 탭 "닫기" 의 서버 정본(비파괴 — 대화
    // 기록은 그대로, 목록에서만 숨김). 로컬 localStorage 만 쓰던 종전엔 기기마다 갈렸다.
    if (pathname === "/api/session-archive" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/session-archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 데몬 재시작 — bridge POST /restart (admin 토큰 server-side 주입, browser 미노출).
    if (pathname === "/api/restart" && method === "POST") {
      await proxyJson(res, "/restart", { method: "POST" });
      return;
    }
    // 대기 중 메시지 취소 — bridge POST /cancel-queued (admin 토큰 server-side 주입,
    // browser 미노출). ADR 2026-07-15. body{threadKey,correlationId} 그대로 전달.
    if (pathname === "/api/cancel-queued" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/cancel-queued", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 진행 중 백그라운드 워커 취소 — bridge POST /cancel-worker (write 토큰 server-side
    // 주입, browser 미노출). 2026-07-16. body{jobId} 그대로 전달, /api/cancel-queued 와
    // 동일 프록시 메커니즘(POST /api/messages 동형).
    if (pathname === "/api/cancel-worker" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/cancel-worker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 백그라운드 셸 관측 레인(ADR 2026-07-17 Phase 3, 표면 C) — bridge GET /shells
    // (read 토큰 server-side 주입). 사이드바 "🖥️ 셸" 뷰 오픈 시 시드. /api/worker-jobs 동형.
    if (pathname === "/api/shells" && method === "GET") {
      await proxyJson(res, "/shells");
      return;
    }
    // 셸 라이브 tail(표면 D, ★비소비 스냅샷) — bridge GET /shell-output?id= (read). 대시보드
    // 전용 폴링, 모델 BashOutput offset 미소비(ADR §1 불변식). id 쿼리 그대로 전달.
    if (pathname === "/api/shell-output" && method === "GET") {
      const qs = url.search ?? "";
      await proxyJson(res, "/shell-output" + qs);
      return;
    }
    // 셸 강제 종료 — bridge POST /kill-shell (write 토큰 server-side 주입, browser 미노출).
    // body{shellId} 그대로 전달, /api/cancel-worker 와 동일 프록시 메커니즘.
    if (pathname === "/api/kill-shell" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/kill-shell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }

    // 프로젝트 폴더를 데몬 호스트 파일 탐색기로 열기(프로젝트 카드 ⋯ 메뉴). bridge 가 등록
    // 프로젝트 경로만 허용(검증). write 토큰.
    if (pathname === "/api/open-path" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }

    // 프로젝트 등록 해제(⋯ 메뉴 "제거") — bridge POST /project-forget (write 토큰 server-side
    // 주입). ★비파괴: 레지스트리 인덱스에서만 제거, 폴더/PROJECT.md 는 보존. body{path} 그대로 전달.
    if (pathname === "/api/project-forget" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/project-forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }

    // 프로젝트 표시명 수정(⋯ 메뉴 "이름 수정") — bridge POST /project-rename (write).
    // body{path,name} 그대로 전달. bridge 가 PROJECT.md frontmatter 갱신 + 레지스트리 캐시 갱신.
    if (pathname === "/api/project-rename" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/project-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
});

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(
    `tiguclaw-dashboard listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
  );
  console.log(`  bridge: http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ★부모(데몬) 사망 감지 — 고아 방지 (2026-07-27).
//  데몬 플러그인의 stop() 은 SIGTERM 을 보내지만 그건 데몬이 *정상 종료* 할 때만 돈다.
//  SIGKILL·크래시·하드킬이면 stop() 이 안 돌고 이 프로세스는 부모 없이 남아 포트를 계속 문다
//  (실측: 고아 대시보드 4개가 최장 6일 20시간 생존, 그중 3개는 이미 삭제된 임시 디렉터리에서).
//  부모가 *어떻게* 죽든 동작하려면 자식이 스스로 확인하는 수밖에 없다 — signal 0 은 프로세스를
//  건드리지 않고 존재만 묻는 표준 방법이다.
//  ★데몬이 띄운 경우에만 활성(env 부재 = 수동 실행 → 감시 안 함, 회귀 0).
const parentPid = Number(process.env.TIGUCLAW_PARENT_PID ?? "");
if (Number.isInteger(parentPid) && parentPid > 1) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0); // 존재 확인만(시그널 미전달).
    } catch {
      console.log(
        `tiguclaw-dashboard: 부모 데몬(pid ${parentPid}) 종료 감지 — 함께 내려갑니다(고아 방지).`,
      );
      clearInterval(timer);
      shutdown();
    }
  }, 15_000);
  timer.unref?.(); // 이 타이머 때문에 프로세스가 살아있지는 않게.
}
