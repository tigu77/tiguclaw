import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { assert, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-message-wait",
  guards: "대시보드 POST /messages가 fetch 기본 헤더 대기 제한으로 작업 완료 전에 502가 되던 문제",
  run: async () => {
    // packages는 src 전용 빌드의 rootDir 밖이므로 실제 소스를 URL로 로드한다.
    const { requestBridgeMessage } = await import(
      new URL("../../../packages/dashboard/bridge-message-request.ts", import.meta.url).href
    ) as { requestBridgeMessage: (downstream: http.ServerResponse, url: string, token: string, body: string) => Promise<{ status: number; contentType: string; text: string }> };
    const out = [];
    const execute = async (mode: string) => {
      let calls = 0, closed = false, auth = "", body = "";
      const downstream = new EventEmitter() as http.ServerResponse;
      Object.assign(downstream, { destroyed: false });
      const server = http.createServer((req, res) => {
        calls++; auth = req.headers.authorization ?? "";
        req.on("data", chunk => { body += String(chunk); });
        res.on("close", () => { closed = true; });
        req.on("end", () => {
          if (mode === "disconnect" || mode === "disconnect-body") {
            if (mode === "disconnect-body") { res.writeHead(200); res.write("partial"); }
            setTimeout(() => downstream.emit("close"), 20);
          } else if (mode === "truncated") {
            res.writeHead(200); res.write("partial");
            setTimeout(() => res.destroy(), 20);
          } else if (mode === "reset") res.destroy();
          else setTimeout(() => {
            res.writeHead(mode === "reject" ? 413 : 200, { "Content-Type": "application/json" });
            res.end(mode === "reject" ? '{"error":"too big"}' : '{"replyText":"done"}');
          }, 40);
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as import("node:net").AddressInfo;
      if (mode === "refused") await new Promise<void>(resolve => server.close(() => resolve()));
      let value: Awaited<ReturnType<typeof requestBridgeMessage>> | undefined, error = "";
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        value = await Promise.race([
          requestBridgeMessage(downstream, `http://127.0.0.1:${address.port}/messages`, "synthetic", '{"text":"한글"}'),
          new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("watchdog")), 2000); }),
        ]);
        await new Promise(resolve => setTimeout(resolve, 30));
      } catch (e) {
        error = String(e);
        await new Promise(resolve => setTimeout(resolve, 30));
      } finally {
        clearTimeout(watchdog);
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      }
      return { value, error, calls, closed, auth, body, listeners: downstream.listenerCount("close") };
    };
    for (const mode of ["success", "reject", "refused", "reset", "truncated", "disconnect", "disconnect-body"]) {
      const got = await execute(mode);
      const ok = mode === "success" ? got.value?.status === 200 && got.value.text === '{"replyText":"done"}' && got.body === '{"text":"한글"}' && got.auth === "Bearer synthetic"
        : mode === "reject" ? got.value?.status === 413 && got.value.text === '{"error":"too big"}'
        : got.value === undefined && got.error !== "" && !got.error.includes("watchdog") && (mode === "refused" || got.closed);
      out.push(assert(`실제 HTTP ${mode}: 응답·오류·정리, 자동 재전송 없음`, ok && got.calls === (mode === "refused" ? 0 : 1) && got.listeners === 0, got));
    }
    const source = readFileSync(new URL("../../../packages/dashboard/index.ts", import.meta.url), "utf8");
    out.push(assert("실제 /messages 프록시가 긴 대기 전송에 연결됨", /bridgePath === "\/messages"[\s\S]*?await requestBridgeMessage\(res, bridgeUrl\(bridgePath\), TOKEN/.test(source), source.match(/if \(bridgePath === "\/messages"\)[\s\S]*?return;\n    }/)?.[0]));
    return out;
  },
};
