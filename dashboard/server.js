const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const httpProxy = require("http-proxy");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const tiguclawWsUrl = process.env.TIGUCLAW_WS_URL ?? "ws://localhost:3002";
const tiguclawApiUrl = process.env.TIGUCLAW_API_URL ?? "http://localhost:3002";

const app = next({ dev });
const handle = app.getRequestHandler();

// WebSocket proxy
const wsProxy = httpProxy.createProxyServer({ target: tiguclawWsUrl, ws: true });
wsProxy.on("error", (err) => console.error("[ws-proxy] error:", err.message));

// HTTP proxy (REST API)
const apiProxy = httpProxy.createProxyServer({ target: tiguclawApiUrl });
apiProxy.on("error", (err, req, res) => {
  console.error("[api-proxy] error:", err.message);
  res.writeHead(502);
  res.end("tiguclaw API unavailable");
});

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    // /dashboard-api/* → tiguclaw REST API (/api/*)
    if (parsedUrl.pathname?.startsWith("/dashboard-api/")) {
      req.url = req.url.replace("/dashboard-api", "/api");
      return apiProxy.web(req, res);
    }
    return handle(req, res, parsedUrl);
  });

  // WebSocket upgrade → tiguclaw /ws
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wsProxy.ws(req, socket, head);
    }
    // /_next/webpack-hmr 등 Next.js 내부 WS는 건드리지 않음 → Next.js가 처리
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`> tiguclaw dashboard ready on http://localhost:${port}`);
    console.log(`> WS proxy: /ws → ${tiguclawWsUrl}/ws`);
    console.log(`> API proxy: /dashboard-api/* → ${tiguclawApiUrl}/api/*`);
  });
});
