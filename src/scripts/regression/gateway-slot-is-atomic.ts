/**
 * 회귀: **게이트웨이 동시 실행 상한이 실제로 지켜진다** (2026-09-14)
 *
 * 잡는 결함(외부 검토): 상한 검사와 실행 수 증가 **사이에 `await` 가 있었다** — 본문 수신과
 * 첨부 ingest 가 그 사이였다. 동시에 온 요청들이 **모두 «자리 있다» 를 통과한 뒤** 차례로
 * 증가하므로, 상한이 1이어도 동시 실행이 여럿이 된다.
 *
 * ★자바스크립트는 단일 스레드라 «검사 → 증가» 를 **동기로 붙이면** 그 구간이 원자적이다.
 *  고칠 것은 잠금 장치가 아니라 **두 줄의 거리**였다.
 *
 * ★**소스로는 판정할 수 없다** — `await` 하나가 사이에 끼는 것을 정규식으로 지키는 건
 *  약하고(이름만 바꿔도 통과), 실제로 겹치는지는 소켓을 둘 열어야 보인다. 그래서 여기서는
 *  **본문을 천천히 보내는 요청**으로 그 창을 실제로 벌린 뒤 두 번째 요청을 던진다.
 *
 * 등급: **동작 검사** — 실제 `serveGatewayChat` 을 로컬 소켓 둘로 친다. 모델 호출 0.
 */
import http from "node:http";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

interface GatewayMod {
  serveGatewayChat: (ctx: unknown) => Promise<void>;
}

/** 헤더만 먼저 보내고 본문을 **나눠서 늦게** 보낸다 — 상한 검사 이후의 창을 실제로 연다. */
const slowPost = (
  port: number,
  token: string,
  holdMs: number,
): { done: Promise<number | undefined>; release: () => void } => {
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const done = new Promise<number | undefined>((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", () => resolve(undefined));
    req.write('{"messages":');
    void gate.then(() => { req.end('[]}'); });
    setTimeout(() => { release(); }, holdMs); // 안전망 — 시험이 매달리지 않는다.
  });
  return { done, release };
};

const post = (port: number, token: string): Promise<number | undefined> =>
  new Promise((resolve) => {
    const body = JSON.stringify({ messages: [] });
    const req = http.request(
      {
        host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
    );
    req.on("error", () => resolve(undefined));
    req.end(body);
  });

export const check: RegressionCheck = {
  name: "gateway-slot-is-atomic",
  guards:
    "게이트웨이 동시 실행 상한 검사와 증가 사이에 본문 수신·첨부 ingest 의 await 가 있어, 동시 요청이 모두 검사를 통과해 상한을 넘던 것 (2026-09-14 외부 검토)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const TOKEN = "regr-gateway-token";
    process.env.LLM_GATEWAY_TOKEN = TOKEN;
    process.env.LLM_GATEWAY_MAX_CONCURRENCY = "1";
    const mod = (await import(
      new URL("../../../plugins/http-bridge/routes-gateway.ts", import.meta.url).href
    )) as GatewayMod;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void mod
        .serveGatewayChat({
          req, res, url, pathname: url.pathname, channelName: "http-bridge",
        })
        .catch(() => { if (!res.writableEnded) res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // A: 본문을 붙들어 «검사 이후» 창을 연다. B: 그 사이에 들어온다.
      const a = slowPost(port, TOKEN, 3000);
      await new Promise((r) => setTimeout(r, 120)); // A 가 헤더까지 도달할 시간.
      const bStatus = await post(port, TOKEN);
      a.release();
      const aStatus = await a.done;
      out.push(
        assert(
          "★★상한이 1이면 **두 번째 요청은 429** 다 — 첫 요청이 본문을 받는 동안에도 자리는 이미 잡혀 있다",
          bStatus === 429,
          `두 번째 ${bStatus ?? "reset"} · 첫 번째 ${aStatus ?? "reset"}`,
        ),
      );

      // 반납이 **정확히 한 번**인지 — 앞 요청이 끝난 뒤엔 다시 들어갈 수 있어야 한다.
      // (두 번 빼면 카운터가 음수로 내려가 상한이 영영 안 걸리고, 안 빼면 영영 429 다.)
      const after1 = await post(port, TOKEN);
      const after2 = await post(port, TOKEN);
      out.push(
        assert(
          "★슬롯이 **정확히 한 번** 반납된다 — 앞 요청이 끝나면 다음이 들어가고, 계속 들어갈 수 있다",
          after1 !== 429 && after2 !== 429,
          `연속 요청 ${after1 ?? "reset"} · ${after2 ?? "reset"}`,
        ),
      );

      // 인증 실패는 슬롯을 **쓰지 않는다**(검사 앞이라 반납 짝이 없다).
      const unauth = await post(port, "wrong-token");
      const stillOk = await post(port, TOKEN);
      out.push(
        assert(
          "인증 실패는 슬롯을 잡지도 반납하지도 않는다 — 잘못 세면 상한이 조용히 닫힌다",
          unauth === 401 && stillOk !== 429,
          `인증실패 ${unauth ?? "reset"} · 이후 ${stillOk ?? "reset"}`,
        ),
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      delete process.env.LLM_GATEWAY_TOKEN;
      delete process.env.LLM_GATEWAY_MAX_CONCURRENCY;
    }
    return out;
  },
};
