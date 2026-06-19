/**
 * tiguclaw-dashboard — *외부* process dashboard (architect contract 2026-05-15).
 *
 * 데몬과 분리된 별도 process. http-bridge endpoint 만 통해 통신.
 *  - 정적 HTML serve (`/`, `/index.html`)
 *  - same-origin proxy (`/api/*`) — token server-side 주입, browser 미노출
 *
 * routes:
 *  - GET  /api/inventory → bridge GET  /inventory       (JSON pass)
 *  - GET  /api/providers → bridge GET  /providers       (JSON pass)
 *  - GET  /api/health    → bridge GET  /health          (JSON pass)
 *  - GET  /api/events    → bridge GET  /events          (SSE pipe)
 *  - POST /api/messages  → bridge POST /messages        (body forward)
 *  - POST /api/restart   → bridge POST /restart         (admin, 데몬 재시작)
 *
 * 외부 의존 0 — node 표준 http/fs/path/url 만. Channel/Observer import 0 (외부 client).
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("dashboard html load failed");
      }
      return;
    }

    // API proxy — token browser 미노출.
    if (pathname === "/api/inventory" && method === "GET") {
      await proxyJson(res, "/inventory");
      return;
    }
    if (pathname === "/api/providers" && method === "GET") {
      await proxyJson(res, "/providers");
      return;
    }
    if (pathname === "/api/health" && method === "GET") {
      await proxyJson(res, "/health");
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
    // 데몬 재시작 — bridge POST /restart (admin 토큰 server-side 주입, browser 미노출).
    if (pathname === "/api/restart" && method === "POST") {
      await proxyJson(res, "/restart", { method: "POST" });
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
