/**
 * 회귀: **대시보드 프록시가 브리지의 안전장치를 떨어뜨리지 않는다** (2026-10-09 적대 검토).
 *
 *  ① 바이트 프록시(`/api/attachments/*`·`/api/plugin-data/*`)가 타입·캐시 두 헤더만 옮겨서, 브리지가 첨부에
 *     붙인 nosniff·CSP sandbox·`Content-Disposition: attachment` 가 대시보드 오리진에서 빠졌다 —
 *     첨부 파일을 `<script src=/api/attachments/..>` 로 부르면 **같은 오리진 스크립트**로 실행됐다(실측).
 *  ② SSE 프록시가 브라우저 끊김 리스너를 `await fetch` **뒤에** 달아, 브리지 응답을 기다리는 사이 떠난
 *     클라이언트의 브리지 연결이 **영구히** 남았다(재연결이 잦을수록 쌓인다).
 *
 * 등급: **동작**. 진짜 대시보드 프로세스를 띄우고, 브리지 자리에 가짜 서버를 세워 오가는 것을 잰다.
 * 격리: 임시 홈·빈 포트·합성 토큰. 라이브 데몬·실제 브리지에 닿지 않는다.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxCli = (): string =>
  path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/cli.mjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 브리지 첨부 라우트가 붙이는 그대로(plugins/http-bridge/routes-files.ts). */
const SAFETY = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:",
  "content-disposition": 'attachment; filename="evil.js"',
} as const;

export const check: RegressionCheck = {
  name: "dashboard-proxy-keeps-bridge-guards",
  guards:
    "첨부 프록시가 브리지의 nosniff·CSP sandbox·attachment 를 떨어뜨려 첨부가 대시보드 오리진 스크립트로 실행되던 것 · SSE 프록시가 브리지 응답 대기 중 떠난 클라이언트의 브리지 연결을 영구히 남기던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // ── 가짜 브리지 ──
    const events = { opened: 0, closed: 0 };
    const bridge = http.createServer((req, res) => {
      const u = req.url ?? "";
      if (u.startsWith("/attachments/") || u.startsWith("/plugin-data/")) {
        res.writeHead(200, { "Content-Type": "application/octet-stream", ...SAFETY });
        res.end("alert(document.cookie)");
        return;
      }
      if (u === "/events") {
        events.opened += 1;
        let timer: NodeJS.Timeout | undefined;
        res.on("close", () => { events.closed += 1; if (timer) clearInterval(timer); });
        // 헤더를 늦게 준다 — 그 사이 브라우저가 떠나는 창을 만든다.
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          timer = setInterval(() => { if (!res.destroyed) res.write("data: {}\n\n"); }, 100);
        }, 600);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const bridgePort = (bridge.address() as { port: number }).port;
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const dashPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const home = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-dashproxy-"));
    const child = spawn(process.execPath, [tsxCli(), path.join(REPO, "packages/dashboard/index.ts")], {
      cwd: home,
      env: {
        ...process.env,
        TIGUCLAW_HOME: home,
        DASHBOARD_PORT: String(dashPort),
        DASHBOARD_HOST: "127.0.0.1",
        HTTP_BRIDGE_HOST: "127.0.0.1",
        HTTP_BRIDGE_PORT: String(bridgePort),
        HTTP_BRIDGE_TOKEN: "regression-proxy-guards", // 합성 — 가짜 브리지만 받는다.
      },
      stdio: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 80 && !up; i += 1) {
        await sleep(100);
        try { await fetch(`http://127.0.0.1:${dashPort}/`, { signal: AbortSignal.timeout(300) }); up = true; } catch { /* 아직 */ }
      }
      out.push(assert("대시보드 프로세스가 실제로 뜬다(검사 전제)", up, up ? `127.0.0.1:${dashPort}` : "★기동 실패"));
      if (!up) return out;

      // ① 바이트 프록시 두 길.
      const got: Record<string, Record<string, string | null>> = {};
      for (const p of ["/api/attachments/x/evil.js", "/api/plugin-data/demo/tile?z=1"]) {
        const r = await fetch(`http://127.0.0.1:${dashPort}${p}`, { signal: AbortSignal.timeout(3000) });
        await r.arrayBuffer();
        got[p] = Object.fromEntries(Object.keys(SAFETY).map((h) => [h, r.headers.get(h)]));
      }
      const kept = Object.values(got).every((hs) =>
        Object.entries(SAFETY).every(([h, v]) => hs[h] === v));
      out.push(assert(
        "★첨부·플러그인 데이터 프록시가 브리지의 nosniff·CSP sandbox·attachment 를 그대로 옮긴다(같은 오리진 실행 차단)",
        kept,
        got,
      ));

      // ② 브리지 헤더를 기다리는 중에 브라우저가 떠난다.
      const ac = new AbortController();
      const pendingReq = fetch(`http://127.0.0.1:${dashPort}/api/events`, { signal: ac.signal }).catch(() => null);
      for (let i = 0; i < 50 && events.opened === 0; i += 1) await sleep(20);
      ac.abort();
      await pendingReq;
      // 브리지는 600ms 뒤 헤더를 준다 — 그 뒤 넉넉히 기다려 연결이 닫혔는지 본다.
      for (let i = 0; i < 40 && events.closed < events.opened; i += 1) await sleep(50);
      out.push(assert(
        "★브리지 응답을 기다리는 사이 떠난 클라이언트의 브리지 SSE 연결이 닫힌다(남아 쌓이지 않는다)",
        events.opened === 1 && events.closed === 1,
        { 열림: events.opened, 닫힘: events.closed },
      ));
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => bridge.close(() => r()));
      bridge.closeAllConnections?.();
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};
