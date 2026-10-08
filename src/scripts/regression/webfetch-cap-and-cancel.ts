/**
 * 회귀: **WebFetch 는 상한에서 수신을 끊고, 도구 취소를 요청에 건다** (2026-10-08 외부 검토 F6·F7).
 *
 * 사고(검토 재현): ① 5MB 상한이 «받은 뒤 자르기» 라 12MB 응답을 끝까지 다 받았다(stream cancel 0).
 *  ② 도구 취소 신호(`/stop`)를 fetch 에 안 넘겨, 미리 취소된 도구도 요청을 보내고 본문을 끝까지 읽었다.
 *
 * 등급: **동작** — 실제 MCP 도구를 로컬 HTTP 서버에 돌리고, 서버 쪽에서 실제로 보낸 양·받은 요청 수를 잰다.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFileOpsMcpServer, readBodyCapped } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const MB = 1024 * 1024;

export const check: RegressionCheck = {
  name: "webfetch-cap-and-cancel",
  guards: "WebFetch 가 5MB 상한을 넘겨서도 응답을 끝까지 받고, /stop 으로 취소된 도구도 요청·수신을 계속하던 것",
  run: async (): Promise<Assertion[]> => {
    let requests = 0;
    let slow = false;
    // 요청마다 따로 센다 — 앞 요청이 아직 보내는 중이면 카운터를 같이 쓰다 뒤 요청이 곧바로 끝났다(검사 첫 판의 결함).
    const reqs: { sent: number; closedEarly: boolean }[] = [];
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const srv = createServer((_req, res: ServerResponse) => {
      requests++;
      const me = { sent: 0, closedEarly: false };
      reqs.push(me);
      // 연결을 재사용하지 않는다 — 앞 요청을 끊은 소켓을 다음 요청이 이어받으면 판정이 섞인다.
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.on("close", () => { if (!res.writableEnded) me.closedEarly = true; });
      // 느린 모드: 64KB 를 100ms 마다 — 상한(5MB)까지 8초가 걸린다. 취소가 안 먹으면 «바로 멈춘다» 를 통과할 수 없다.
      const piece = slow ? chunk.subarray(0, 64 * 1024) : chunk;
      const pump = (): void => {
        if (res.destroyed) return;
        while (me.sent < 12 * MB) {
          me.sent += piece.length;
          const ok = res.write(piece);
          // 느린 모드는 쓰기 결과와 상관없이 쉰다 — 64KB 는 버퍼 한도(16KB)보다 커서 write 가 늘 false 라, drain 만 기다리면
          //  지연이 한 번도 안 걸렸다(검사 둘째 판의 결함 — 취소가 안 먹어도 30ms 에 끝났다).
          if (slow) { setTimeout(pump, 100); return; }
          if (!ok) { res.once("drain", pump); return; }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    const text = (r: unknown): string => (typeof r === "string" ? r : JSON.stringify(r));
    try {
      // ① 상한
      const mcp = await adaptClaudeMcpServer(createFileOpsMcpServer(process.cwd()), "file-ops");
      const r1 = text(await mcp.callTool("WebFetch", { url }));
      await new Promise((res) => setTimeout(res, 200));
      const capSent = reqs.at(-1)?.sent ?? -1;
      const capClosed = reqs.at(-1)?.closedEarly === true;

      // ② 미리 취소된 도구 — 요청 자체를 안 보낸다
      const pre = new AbortController();
      pre.abort(new Error("stop"));
      const before = requests;
      const mcpPre = await adaptClaudeMcpServer(createFileOpsMcpServer(process.cwd(), undefined, { abortSignal: pre.signal }), "file-ops");
      const r2 = text(await mcpPre.callTool("WebFetch", { url }));
      const preRequests = requests - before;

      // ③ 받는 도중 취소 — 바로 멈춘다
      slow = true;
      const mid = new AbortController();
      const mcpMid = await adaptClaudeMcpServer(createFileOpsMcpServer(process.cwd(), undefined, { abortSignal: mid.signal }), "file-ops");
      const t0 = Date.now();
      setTimeout(() => mid.abort(new Error("stop")), 200);
      const r3 = text(await mcpMid.callTool("WebFetch", { url, timeout: 30 }));
      const midMs = Date.now() - t0;
      await new Promise((res) => setTimeout(res, 200));
      const midClosed = reqs.at(-1)?.closedEarly === true;

      // ④ 상한이 한글 한 글자 가운데를 자른다(3바이트 중 1바이트만 남음) — 깨진 글자를 만들지 않는다
      const ko = Buffer.from("가나다", "utf8"); // 9 bytes
      const cut = await readBodyCapped(new Response(ko).body, 7);
      return [
        assert(
          "★5MB 상한에서 수신을 끊는다 — 서버가 12MB 를 다 보내기 전에 연결이 닫히고 잘림 표식이 붙는다",
          capClosed && capSent < 12 * MB && r1.includes("truncated at 5MB"),
          `서버 송신 ${(capSent / MB).toFixed(1)}MB · 조기 종료=${capClosed} · 표식=${r1.includes("truncated at 5MB")}`,
        ),
        assert("★미리 취소된 도구는 요청을 보내지 않는다", preRequests === 0 && /cancel/i.test(r2), `요청 ${preRequests} · ${r2.slice(0, 80)}`),
        assert("★받는 도중 취소하면 바로 멈춘다(상한·30초 시한을 기다리지 않는다)", midMs < 2_000 && midClosed, `${midMs}ms · 연결 종료=${midClosed} · ${r3.slice(0, 60)}`),
        assert("상한이 글자 가운데를 자르면 그 반쪽은 버린다(깨진 글자 없음)", cut.body === "가나" && cut.truncated && !cut.body.includes("�"), JSON.stringify(cut)),
      ];
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  },
};
