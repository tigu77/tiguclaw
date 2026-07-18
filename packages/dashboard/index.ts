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
 *  - GET  /api/channels  → bridge GET  /channels        (JSON pass, 라이브 채널 presence 읽기전용)
 *  - GET  /api/context-menu-items → bridge GET /context-menu-items (JSON pass, 컨텍스트메뉴 외부 기여)
 *  - GET  /api/providers → bridge GET  /providers       (JSON pass)
 *  - GET  /api/model-profiles → bridge GET /model-profiles (JSON pass, 모델 프로파일 표시)
 *  - POST /api/set-default-profile → bridge POST /set-default-profile (write, 기본 프로파일 포인터 설정)
 *  - POST /api/set-module-enabled → bridge POST /set-module-enabled (write, 모듈 활성/비활성 — P4a-2)
 *  - GET  /api/health    → bridge GET  /health          (JSON pass)
 *  - GET  /api/chat-history → bridge GET /chat-history  (JSON pass, 대화 이력 복원; threadKey qs 통과)
 *  - GET  /api/all-activity → bridge GET /all-activity  (JSON pass, 전체활동 크로스세션 타임라인)
 *  - GET  /api/sessions  → bridge GET  /sessions        (JSON pass, 멀티세션 탭 목록+프리뷰)
 *  - GET  /api/projects  → bridge GET  /projects        (JSON pass, 프로젝트 목록)
 *  - GET  /api/projects/detail → bridge GET /projects/detail (JSON pass, 프로젝트 상세)
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

const BRIDGE_PORT = parseInt(process.env.HTTP_BRIDGE_PORT ?? "3001", 10);
const BRIDGE_HOST = process.env.HTTP_BRIDGE_HOST ?? "localhost";
const BRIDGE_TOKEN = process.env.HTTP_BRIDGE_TOKEN;
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "3101", 10);

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
    // 라이브 채널 presence — bridge GET /channels (read 토큰 server-side 주입). 채널 1급
    // 읽기전용 뷰(ADR 2026-07-16 §D4 Phase A). /api/inventory 와 동형 패턴.
    if (pathname === "/api/channels" && method === "GET") {
      await proxyJson(res, "/channels");
      return;
    }
    // 실행 중 백그라운드 잡 하이드레이션(대시보드 부팅 시 라벨 복원 — worker.started SSE 놓친 경우).
    if (pathname === "/api/worker-jobs" && method === "GET") {
      await proxyJson(res, "/worker-jobs");
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

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
});

server.listen(DASHBOARD_PORT, () => {
  console.log(
    `tiguclaw-dashboard listening on http://localhost:${DASHBOARD_PORT}`,
  );
  console.log(`  bridge: http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
