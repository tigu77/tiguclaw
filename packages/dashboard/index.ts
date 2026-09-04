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
 *  - POST /api/set-profile-color → bridge POST /set-profile-color (write, 배지 색)
 *  - POST /api/set-default-profile → bridge POST /set-default-profile (write, 기본 프로파일 포인터 설정)
 *  - POST /api/set-suggestion → bridge POST /set-suggestion (write, 다음 메시지 제안 on/off)
 *  - GET  /api/suggestion → bridge GET /suggestion (read, 현재 값)
 *  - POST /api/set-memory-cap → bridge POST /set-memory-cap (write, 메모리 인덱스 캡)
 *  - GET  /api/memory-cap → bridge GET /memory-cap (read, 현재 값 + 허용 범위)
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
 *  - POST /api/cancel-worker → bridge POST /cancel-worker (write, 진행 중 백그라운드 매니저 취소)
 *  - GET  /api/shells    → bridge GET  /shells          (JSON pass, 백그라운드 셸 관측 레인 시드)
 *  - GET  /api/shell-output → bridge GET /shell-output  (JSON pass, ★비소비 tail 스냅샷 폴링)
 *  - POST /api/kill-shell → bridge POST /kill-shell     (write, 백그라운드 셸 강제 종료)
 *
 * 외부 의존 0 — node 표준 http/fs/path/url 만. Channel/Observer import 0 (외부 client).
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { assetFingerprintOf } from "../../src/core/asset-fingerprint.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAllowedHost,
  parseAllowedHosts,
  rebindRejectionMessage,
} from "../../src/core/net/host-guard.js";
import { appRoot, getPaths } from "../../src/core/paths.js";
import {
  PLUGIN_ASSET_PREFIX,
  resolvePluginAssetIn,
} from "../../src/core/plugin-assets.js";
import { readThemeCss, withLayer, layerImport } from "../../src/core/theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dashboard-split Phase2 (ADR 2026-07-16) — /js/<name>.js 화이트리스트. _manifest.json
// (로드순서 배열)을 기동 시 1회 읽어 Set 화 — 라우팅 데이터테이블. 매니페스트 없으면 빈
// 화이트리스트(그 phase 이전엔 /js/ 라우트 자체가 무의미 — 404 로 저절로 닫힘).
/**
 * 서빙하는 프런트 자산의 **내용 지문** — 배포마다 바뀌고, 안 바뀌면 그대로다.
 *
 * ★없어서 화면이 늙었다 (2026-08-28 실사용). 새로고침 판정이 **버전**만 봤는데, sync 배포는
 *  버전을 안 올린다 — 오늘 데몬을 28번 재시작하는 동안 브라우저는 **아침 JS 를 그대로**
 *  들고 있었고, 새로 만든 위젯 호스트가 그 화면엔 아예 없었다.
 * ★아이콘엔 이미 내용 해시를 쓰고 있었다(그 주석: *"손 번호를 쓰지 않는다 — 내용 해시는
 *  바뀔 때만 바뀌고 사람이 관리할 것이 없다"*). 같은 규칙을 JS·CSS 에도 적용한다.
 * ★프로세스가 뜰 때 한 번 잰다 — 배포는 프로세스를 갈아치우므로 그걸로 충분하다.
 */
let assetFingerprint = "";

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
// 지문은 매니페스트를 읽은 **직후 한 번** 잰다 — 배포가 프로세스를 갈아치우므로 그걸로 족하다.
// 못 재면 빈 값이고, 화면은 종전대로 버전만 비교한다(회귀 0).
try {
  assetFingerprint = assetFingerprintOf(
    ["index.html", "app.css", ...[...jsWhitelist].sort().map((n) => `js/${n}`)].map((f) =>
      fsSync.readFileSync(path.join(__dirname, f)),
    ),
  );
} catch {
  assetFingerprint = ""; // 못 재면 화면이 종전대로 버전만 비교한다(회귀 0).
}

const BRIDGE_PORT = parseInt(process.env.HTTP_BRIDGE_PORT ?? "7011", 10);
const BRIDGE_HOST = process.env.HTTP_BRIDGE_HOST ?? "localhost";
const BRIDGE_TOKEN = process.env.HTTP_BRIDGE_TOKEN;
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "7010", 10);
// loopback 바인딩 기본 — 원격 노출은 tailscale serve(→127.0.0.1:<port> 프록시)가 담당.
// 와일드카드(::)로 바인딩하면 tailscaled 가 잡은 tailnet-IP:<port> 와 EADDRINUSE 충돌 →
// 대시보드가 못 떠 tailscale 프록시가 502 를 낸다. LAN 직접노출 필요 시 env 로 override.
const DASHBOARD_HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
// DNS 리바인딩 방어 — 루프백은 항상 허용, 그 외는 여기에 적은 이름만(원격 접속용).
// 부팅 시 1회 파싱(요청마다 env 를 다시 읽을 이유가 없다 — 값이 바뀌면 재시작이 맞다).
const ALLOWED_HOSTS = parseAllowedHosts(process.env.DASHBOARD_ALLOWED_HOSTS);

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

    // ★DNS 리바인딩 방어 (2026-08-24) — **CSRF 가드보다 먼저**. 아래 same-origin 검사는
    //  리바인딩을 못 막는다(브라우저가 same-origin 이라고 믿는다). 다른 축이라 둘 다 있어야
    //  하고, 이게 먼저 서야 GET(읽기)도 덮인다 — 아래 가드는 쓰기 메서드만 본다.
    if (!isAllowedHost(req.headers.host, ALLOWED_HOSTS)) {
      console.warn(
        `[dashboard] Host 차단: '${String(req.headers.host ?? "")}' ${method} ${pathname} — DNS 리바인딩 방어`,
      );
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: rebindRejectionMessage(req.headers.host, "DASHBOARD_ALLOWED_HOSTS") }));
      return;
    }

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
        // ★아이콘 캐시 깨기 — **파일 내용 해시**로 (2026-08-27).
        //  아이콘은 `max-age=86400` 이라(내용이 고정인 자산이니 맞다) 파일을 바꿔도 브라우저가
        //  **하루 동안 옛 것을 계속 쓴다.** 파비콘은 특히 끈질기게 남는다 — 실제로 배경을
        //  뚫어 배포했는데도 화면엔 검은 사각형이 그대로였다.
        //  ★손 번호(`?v=2`)를 쓰지 않는다: 파일을 고치고 번호를 안 올리면 조용히 안 바뀌고,
        //   그 목록은 반드시 드리프트한다([[feedback_hand_maintained_lists]]).
        //   내용 해시는 **바뀔 때만** 바뀌고 사람이 관리할 것이 없다.
        //  실패해도 화면은 뜬다(해시 없이 나가면 종전 동작 = 캐시가 남을 뿐).
        let withHash = html;
        try {
          const stamp = async (file: string): Promise<string> =>
            createHash("sha1")
              .update(await fs.readFile(path.join(__dirname, file)))
              .digest("hex")
              .slice(0, 8);
          const [a, b] = await Promise.all([stamp("icon.png"), stamp("icon-solid.png")]);
          withHash = html
            .replace(/(["'])\/icon\.png\1/g, `$1/icon.png?v=${a}$1`)
            .replace(/(["'])\/icon-solid\.png\1/g, `$1/icon-solid.png?v=${b}$1`);
        } catch {
          /* 해시 실패 — 종전대로 나간다(화면은 정상, 캐시만 늦게 갱신) */
        }

        // ★테마 상태 주입 — 실패해도 화면은 뜬다(기본 자리표시자가 남는다).
        let withMode = withHash;
        try {
          const { readTheme, availableThemes } = await import(
            "../../src/core/theme.js"
          );
          // ★설정 화면이 쓸 목록·현재값. 조회 엔드포인트를 따로 만들면 "무슨 테마가 있나"
          //  의 정본이 둘이 된다(언어가 `__TIGU_I18N__.available` 로 이미 그렇게 한다).
          const payload = { theme: readTheme(), themes: availableThemes() };
          withMode = withHash.replace(
            /<script id="tigu-appearance">[\s\S]*?<\/script>/,
            () =>
              `<script id="tigu-appearance">window.__TIGU_THEME__ = ${JSON.stringify(
                payload,
              ).replace(/</g, "\\u003c")};</script>`,
          );
        } catch {
          /* 기본 자리표시자(system) 가 남는다 */
        }

        // ★언어 카탈로그 주입 (2026-08-25) — 첫 렌더 전에 있어야 화면이 안 깜빡인다.
        //  실패해도 화면은 뜬다(기본 자리표시자가 남고, 폴백이 키를 그대로 보여준다).
        let withI18n = withMode;
        try {
          const { catalogForClient } = await import("../../src/core/i18n.js");
          const cat = catalogForClient();
          const payload = `<script id="tigu-i18n">window.__TIGU_I18N__ = ${JSON.stringify(cat).replace(/</g, "\\u003c")};</script>`;
          // ★치환자를 **함수로** 넘긴다 (2026-08-25 적대 검토 F2). 문자열로 넘기면 카탈로그
          //  값 안의 `$&`·`` $` ``·`$'`·`$$` 가 `String.replace` 의 특수문자로 해석돼,
          //  `<` 이스케이프를 마친 **뒤에** 페이지 자신의 HTML(`</script>` 포함)이 스크립트
          //  한복판으로 도로 들어간다. 실측: 값 하나에 `` $` `` 만 있어도 DOM 이 +89% 로
          //  부풀고 `window.__TIGU_I18N__` 가 undefined 가 된다(= 화면 전체가 기본 언어).
          //  try/catch 는 안 걸린다 — replace 는 "성공" 하기 때문이다.
          withI18n = withMode.replace(/<script id="tigu-i18n">[\s\S]*?<\/script>/, () => payload);
        } catch {
          /* 카탈로그 실패가 대시보드를 막지 않는다 */
        }
        // no-store — HTML(대시보드 코드)은 매 로드 최신을 받아야 한다. 캐시 헤더 없으면 브라우저가
        // heuristic 캐싱으로 옛 index.html 을 써서 업데이트(버그 픽스)가 일반 새로고침에 반영 안 됨.
        // (vendored .js 는 내용 고정이라 max-age 캐시 유지 — 코드는 index.html 에만 있음.)
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(withI18n);
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
        res.end(withLayer("tigu-base", css, true));
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("app.css load failed");
      }
      return;
    }

    /**
     * 선택된 테마 프리셋 — `settings.json` 의 `theme` → `themes/<이름>.css` (2026-08-26).
     *
     * ★언어와 **같은 모양**이다(`locales/<lang>.json` + settings `locale`). 새 개념 0.
     * ★URL 에 이름이 안 실린다 — 이름은 settings 에서만 오므로 주소창으로 경로를 탈출할
     *  여지가 없다. 고른 게 없으면 빈 200(그때는 `app.css` 기본 팔레트가 그대로다).
     */
    if (pathname === "/theme-preset.css" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      });
      // ★감싸지 않고 **가져온다** — 프리셋의 중괄호 오타가 레이어를 탈출하지 못하게.
      //  이유는 `layerImport` 헤더에.
      res.end(layerImport("tigu-preset", "/theme-preset-raw.css"));
      return;
    }

    // 프리셋 원본 — 위 `@import` 의 대상. **감싸지 않는다**(레이어는 import 가 건다).
    if (pathname === "/theme-preset-raw.css" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(readThemeCss());
      return;
    }

    /**
     * 사용자 테마 오버라이드 — `<home>/theme.css` (2026-08-26).
     *
     * ★**설정 화면이 아니라 파일**인 이유는 둘이다:
     *  ① **오버라이드가 공짜다.** `:root` 변수 76개를 640곳이 읽고 있으므로, 이 파일이
     *     `app.css` **뒤에** 얹히면 캐스케이드가 병합을 대신한다 — 적은 것만 덮이고 나머지는
     *     기본값이다. 우리가 병합 로직을 만들 필요가 없다.
     *  ② ★**파일이면 비서가 고칠 수 있다.** *"테마 좀 더 어둡게 해줘"* 가 된다. 설정 UI 만
     *     있으면 비서는 못 만진다(로드맵 A3 — Layout 은 비서가 읽고 쓰는 데이터여야 한다).
     *
     * 없으면 **빈 200** 이다 — 404 면 콘솔에 매번 에러가 찍혀 진짜 문제를 덮는다.
     * `no-store` 라 새로고침만으로 바로 반영된다(화면은 창이 다시 활성화될 때도 다시 읽는다).
     */
    if (pathname === "/theme.css" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(layerImport("tigu-user", "/theme-raw.css"));
      return;
    }

    // 사용자 테마 원본 — 위 `@import` 의 대상. 없으면 **빈 200**(404 면 콘솔이 매번 운다).
    if (pathname === "/theme-raw.css" && method === "GET") {
      let css = "";
      try {
        css = await fs.readFile(path.join(getPaths().home, "theme.css"), "utf8");
      } catch {
        // 없으면 없는 것 — 기본 테마 그대로.
      }
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(css);
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
    // 브랜드 아이콘 — 내용이 고정이라 vendored 자산과 같은 캐시 정책(앱 CSS/JS 의
    // no-store 와 다르다 — 매 요청 재전송할 이유가 없다).
    //
    // ★**둘로 나뉜다** (2026-08-27 사용자 지적: "테마를 바꾸니 검은색 주변이 좀 그러네").
    //  - `icon.png`       배경을 뚫은 것 — 화면 안 브랜드·파비콘. 어느 테마에도 얹힌다.
    //  - `icon-solid.png` 배경이 있는 것 — **apple-touch 전용**. iOS 는 홈 화면 아이콘의
    //    투명을 **검게 합성**해서, 뚫은 걸 주면 지금과 똑같거나 더 나빠진다.
    //  ★뚫을 때 "어두운 픽셀 제거" 로 하면 **게 몸통의 긁힘 무늬까지 뚫린다**(실측
    //   `23,2,0`). 배경은 푸른 기(B>R)·게 그림자는 붉은 기(R>B)라 색상으로 갈랐다.
    //  ★★이름을 **열거하지 않는다** (2026-09-02). 종전엔 두 이름이 손으로 적혀 있었고,
    //   세 번째(`plugin-default.png`)를 넣는 순간 그 목록이 곧 드리프트가 된다
    //   ([[feedback_hand_maintained_lists]]). 규칙은 «대시보드 폴더의 png» 하나다 —
    //   모양으로 판정하므로 경로 탈출(`../`·하위 폴더)은 성립하지 않는다.
    if (/^\/[a-z0-9][a-z0-9-]*\.png$/.test(pathname) && method === "GET") {
      try {
        const buf = await fs.readFile(path.join(__dirname, path.basename(pathname)));
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("icon not found");
      }
      return;
    }

    /**
     * 플러그인 자산 — `/plugin-asset/<plugin>/<경로>` (2026-08-28, 위젯 플랫폼 §E.1).
     *
     * ★위젯의 **브라우저 코드**를 플러그인이 들고 올 수 있게 하는 유일한 길이다. 종전엔
     *  대시보드가 파일마다 라우트를 손으로 썼는데(marked·mermaid·highlight, 아래), 그건
     *  **대시보드 자기 자산**이라 이 라우트로 흡수하지 않는다 — 그 디렉터리엔 `index.js`
     *  소스가 같이 있어서 확장자 허용만으로는 샌다. 여기 base 는 `plugins/<name>/web/` 라
     *  **구조적으로** 브라우저용 파일만 들어 있다.
     *
     * ★**판정은 여기 없다** — `core/plugin-assets.ts` 의 순수 함수가 한다. 경로 트래버설은
     *  정규식으로 지킬 수 있는 종류가 아니라 회귀가 **실제로 뚫어봐야** 하고, 그러려면
     *  서버를 안 띄우고 부를 수 있어야 한다(principle-check Q7).
     *
     * ★캐시를 안 건다. 플러그인 자산은 `/update` 로 바뀌는데 버전 지문이 없다 —
     *  하루짜리 캐시를 걸면 **업데이트 후에도 옛 위젯이 뜬다**(그게 훨씬 나쁘다).
     *  필요해지면 그때 지문을 붙인다(지금 없는 문제를 위한 최적화 금지).
     */
    if (pathname.startsWith(PLUGIN_ASSET_PREFIX) && method === "GET") {
      // 번들이 앞, 홈이 뒤 — 로더와 **같은 우선순위**다(같은 이름이면 번들이 이긴다).
      const r = resolvePluginAssetIn(
        [path.join(appRoot(), "plugins"), getPaths().commonPlugins],
        pathname,
        existsSync,
      );
      // ★막힌 이유를 밖에 알려주지 않는다 — 그 자체가 탐색 도구가 된다. 전부 404.
      if (!r.ok) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      try {
        const buf = await fs.readFile(r.file);
        res.writeHead(200, { "Content-Type": r.contentType, "Cache-Control": "no-store" });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
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

    /**
     * 정적 vendored 다이어그램 렌더러 (mermaid v11, 단일파일·외부 의존 0·CDN 0).
     *
     * ★**3.4MB 다** — 나머지 자산을 다 합친 것보다 크다. 그래서 `index.html` 이 미리 걸지
     *  않는다: 화면이 `` ```mermaid `` 블록을 **실제로 만났을 때만** 이 URL 을 부른다
     *  (`markdown.js` 의 지연 로드). 다이어그램을 안 쓰는 사용자는 1바이트도 안 받는다.
     * ★로컬(127.0.0.1) 이라 첫 로드도 디스크 읽기 한 번이다 — CDN 을 안 쓰는 이유이기도 하다
     *  (오프라인·사내망에서 깨지면 안 되고, 외부로 요청이 나가서도 안 된다).
     */
    if (pathname === "/mermaid.min.js" && method === "GET") {
      try {
        const js = await fs.readFile(path.join(__dirname, "mermaid.min.js"), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(js);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("mermaid.min.js load failed");
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
      // ★쿼리를 **그대로 넘긴다**(`?lang=` — 2026-09-02). 종전엔 경로만 넘겨서, 화면이
      //  언어를 실어도 브리지엔 도착하지 않았다. 프록시가 사슬 가운데 토막이라 양끝만
      //  보면 안 보인다([[feedback_verify_before_asserting]] — 실제로 그렇게 놓쳤다).
      //  검증은 브리지가 한다(`localeFromQuery`) — 여기서 다시 판정하면 규칙이 두 벌이 된다.
      await proxyJson(res, "/changelog" + (url.search ?? ""));
      return;
    }
    // 플러그인 관리 — bridge GET /plugins (read) · POST /plugins/action (admin).
    // 홈 위젯 배치 — bridge GET /home-widgets (read). 홈 뷰가 부팅 때 한 번 읽는다.
    if (pathname === "/api/home-widgets" && method === "GET") {
      await proxyJson(res, "/home-widgets");
      return;
    }
    // 플러그인 데이터 라우트 (2026-08-28, 위젯 플랫폼 §E.2) — 홈 위젯이 값을 받는 길.
    // ★**프리픽스 하나**다. 플러그인마다 여기 한 줄씩 늘면 그게 곧 드리프트 자리다 —
    //  이 파일은 판정을 안 한다(모르는 플러그인·라우트는 bridge 가 404 로 답한다).
    // ★`proxyRaw` 다 — 이 라우트는 JSON 도 **바이트**도 낸다(지도 타일). `proxyJson` 은
    //  `text()` 로 읽어 바이너리를 깨뜨린다. raw 는 content-type·cache-control 을 그대로
    //  보존하므로 두 반환형이 **한 경로**로 지난다(분기 0).
    if (pathname.startsWith("/api/plugin-data/") && method === "GET") {
      const rest = pathname.slice("/api/plugin-data/".length);
      await proxyRaw(res, "/plugin-data/" + rest + (url.search ?? ""));
      return;
    }
    if (pathname === "/api/plugins" && method === "GET") {
      await proxyJson(res, "/plugins");
      return;
    }
    // 설치·제거·켜기·끄기 **+ 설정 한 칸 쓰기**(2026-08-28, §D). 액션이 늘어도 이 분기는
    // 안 는다 — 판정은 전부 bridge 뒤 코어에 있다(가장자리는 판단하지 않는다).
    if (pathname === "/api/plugins/action" && method === "POST") {
      await proxyJson(res, "/plugins/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await readBody(req),
      });
      return;
    }
    // 업데이트 내역 — bridge GET /update-changelog (read). 같은 `{ markdown }` 모양이라
    // 설정 뷰가 「변경 이력」과 **같은 행 컴포넌트**로 그린다.
    if (pathname === "/api/update-changelog" && method === "GET") {
      await proxyJson(res, "/update-changelog" + (url.search ?? ""));
      return;
    }
    // 전달(bridge 가 allowlist 검사 후 파일 재-Read). 능력 상세뷰 본문 섹션이 소비.
    // 플러그인 아이콘 — 바이너리라 raw 프록시(첨부와 동형). 없으면 브리지가 404 를 주고
    // 화면이 기본 아이콘으로 떨어진다. 쿼리를 그대로 넘긴다.
    if (pathname === "/api/plugin-icon" && method === "GET") {
      await proxyRaw(res, "/plugin-icon" + (url.search ?? ""));
      return;
    }
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
      // ★쿼리를 **통째로** 넘긴다 — `?jobId=` 단건 갈래(카드 펼침 시 지시문 원문)가 이 프록시를
      //  탄다. 안 넘기면 단건 요청이 조용히 «목록» 으로 떨어지고, 끝난 잡은 목록에 없으므로
      //  화면이 «원문이 사라졌다» 고 잘못 말한다.
      //  ★첫 판은 `jobId` **하나만 골라** 재조립했는데, 그건 손 목록이다 — 두 번째 파라미터가
      //   생기는 순간 조용히 버려진다. 바로 아래 `/endpoint-calls${url.search}` 를 포함해
      //   이 파일의 라우트 10곳이 이미 통째로 넘긴다([[feedback_hand_maintained_lists]]).
      await proxyJson(res, `/worker-jobs${url.search}`);
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
    // 프로파일 배지 색 — bridge POST /set-profile-color (write 토큰 server-side 주입).
    if (pathname === "/api/set-profile-color" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-profile-color", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
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
    // 메모리 인덱스 캡 — 설정 화면 슬라이더가 부른다. `0` 은 끄기.
    //  /set-suggestion 과 동형(write 토큰 server-side 주입, browser 미노출).
    if (pathname === "/api/set-memory-cap" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-memory-cap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    if (pathname === "/api/memory-cap" && method === "GET") {
      await proxyJson(res, "/memory-cap");
      return;
    }
    if (pathname === "/api/set-suggestion" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 화면 언어 — bridge (write 토큰 server-side 주입). /set-suggestion 과 동형.
    // ★읽기 엔드포인트는 **안 만든다** — 현재 언어와 설치 목록은 이미 index.html 에 주입되는
    //  카탈로그(`window.__TIGU_I18N__`)에 실려 있다. 새로 만들면 정본이 둘이 된다.
    if (pathname === "/api/set-locale" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return;
    }
    // 화면 밝기·테마 프리셋 — 설정 화면의 두 줄이 쓴다.
    // ★읽기 엔드포인트는 **안 만든다** — 현재값과 설치 목록은 이미 index.html 에 주입된다
    //  (`window.__TIGU_THEME__`). 언어와 같은 규약이다: 만들면 정본이 둘이 된다.
    if (pathname === "/api/set-theme" && method === "POST") {
      const body = await readBody(req);
      await proxyJson(res, "/set-theme", {
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
    // ★브리지 health 에 **자산 지문**을 얹는다 (2026-08-28). 화면이 "새 프런트가 나왔나" 를
    //  판단하는 재료인데, 종전엔 `version` 뿐이라 **sync 배포(버전 동일)에선 영영 안 바뀌었다**
    //  — 오늘 28번 재시작하는 동안 브라우저는 아침 JS 를 그대로 들고 있었다.
    //  브리지는 자기 자산을 모르므로 여기서 더한다(프록시 + 보강). 실패해도 종전 동작.
    if (pathname === "/api/health" && method === "GET") {
      try {
        const r = await fetch(bridgeUrl("/health"), {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        const body = (await r.json()) as Record<string, unknown>;
        res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...body, assets: assetFingerprint }));
      } catch {
        await proxyJson(res, "/health"); // 못 얹으면 그냥 넘긴다(화면은 버전만 본다).
      }
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
    // 진행 중 백그라운드 매니저 취소 — bridge POST /cancel-worker (write 토큰 server-side
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
