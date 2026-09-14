/**
 * 회귀: **요청 본문에 상한이 있다 — 그리고 초과가 413 으로 닫힌다** (2026-09-14)
 *
 * 잡는 것: `readJsonBody`·`readRawBody` 가 chunk 를 **무제한으로** 모았다. 파일 머리말은
 * *"상한을 넘기면 거절한다"* 고 적혀 있었는데 코드엔 상한이 없었다(글이 코드보다 세게 말함).
 *
 * ★상한은 **손으로 고른 수가 아니라 파생값**이다 — base64 를 받는 경로 셋이 이미 디코드
 *  기준 상한을 집행하므로, HTTP 상한은 그 값의 base64 표현 + 프레이밍 여유다. 첨부 계약이
 *  바뀌면 여기가 저절로 따라온다([[feedback_hand_maintained_lists]]).
 *
 * ★**실제 소켓으로 잰다.** `Content-Length` 조기 거절·수신 바이트 누적·chunked(헤더 없음)·
 *  헤더가 실제와 다른 경우는 함수만 봐서는 판정이 안 된다. 특히 *"소켓을 끊어서 413 대신
 *  connection reset 만 나는가"* 는 서버를 띄워야 보인다.
 *
 * ★**알려진 한계 — 초과 요청이 드물게 413 대신 연결 오류로 끝난다** (2026-09-14).
 *  상한을 넘으면 우리는 **본문을 안 읽고** 거절한다 — 그게 상한의 목적이다. 그래서 아직
 *  업로드 중인 클라이언트는 남은 쓰기에서 EPIPE/ECONNRESET 을 보고, **응답을 읽기 전에**
 *  끝나는 경우가 생긴다.
 *
 *  독립 재검증(450건 반복): **413 수신 447 · 응답 전 연결 오류 3(0.67%)**. 서버 종료 0 ·
 *  미처리 예외 0 · 직후 정상 요청 450/450 · 게이트웨이 슬롯 반환 정상(60건 전부 413).
 *
 *  ★**«큰 요청에서만» 이 아니다** — 실패한 것 중 하나는 **1 MiB 상한을 14바이트 넘긴**
 *   요청이었다. 크기가 아니라 **타이밍 경쟁**이고, 본문이 소켓 버퍼를 넘기면 언제든 걸린다.
 *   ★내가 먼저 «실사용 크기는 100% 전달» 이라고 적었는데 **표본 8건으로 내린 말이라 틀렸다**
 *    (8건으로는 100% 와 99.3% 를 못 가른다). 재지 않은 단언이 아니라 **모자란 표본**으로
 *    단언한 경우다 — 같은 부류로 남긴다([[feedback_verify_before_asserting]]).
 *
 *  ★**고치지 않는다.** 413 을 100% 보장하려면 본문을 끝까지 받아야 하고(실측: 전량 drain
 *   20/20 전달), 그건 상한이 막으려던 바로 그 비용이다. 경계 있는 버림도 재봤지만 효과가
 *   없었다(극단 초과 1/15). 안전한 거절과 서버 지속 동작은 지켜지므로 **알려진 한계**로 둔다.
 *  ★작은 본문만 재는 이 검사는 그 축을 **원리적으로 못 본다**(버퍼에 다 들어가 경쟁이 안
 *   열린다). 다시 재려면 실제 상한 · 대량 반복이 필요하다 — 스위트에 넣기엔 비싸다.
 *
 * 등급: **동작 검사** — 로컬 http 서버를 띄워 실제 요청을 보낸다. 외부 네트워크 0.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { writeJson } from "../../core/net/write-json.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

interface BodyMod {
  readJsonBody: (req: http.IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  readRawBody: (req: http.IncomingMessage, limit?: number) => Promise<string>;
  bodyErrorStatus: (e: unknown) => 400 | 413;
  respondToRequestFailure: (res: http.ServerResponse, e: unknown) => { status: number; wrote: boolean };
  BODY_LIMIT_DEFAULT: number;
  BODY_LIMIT_ATTACHMENTS: number;
  BODY_LIMIT_AUDIO: number;
}

/** 응답과 «끊겼는가» 를 함께 돌려준다 — reset 은 상태 코드가 없다. */
const post = (
  port: number,
  body: string | Buffer,
  opts?: { chunked?: boolean; lieContentLength?: number },
): Promise<{ status?: number; text: string; reset: boolean }> =>
  new Promise((resolve) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts?.lieContentLength !== undefined) {
      headers["content-length"] = String(opts.lieContentLength);
    } else if (opts?.chunked === true) {
      headers["transfer-encoding"] = "chunked";
    } else {
      headers["content-length"] = String(buf.length);
    }
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, text, reset: false }));
    });
    req.on("error", () => resolve({ text: "", reset: true }));
    req.end(buf);
  });

export const check: RegressionCheck = {
  name: "http-body-is-bounded",
  guards:
    "요청 본문을 무제한으로 모으던 것 — 파일 머리말은 «상한을 넘기면 거절한다» 고 적혀 있었는데 상한이 없었다 (2026-09-14 외부 검토)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const mod = (await import(
      new URL("../../../plugins/http-bridge/http-body.ts", import.meta.url).href
    )) as BodyMod;

    // ① 상한이 **파생값**이다 — 첨부 **계약 상수에서** 계산된 값과 일치한다.
    //  ★기대값에 숫자를 박지 않는다 (2026-09-15). 첫 판은 `25 * MiB` 를 적어뒀는데, 계약이
    //   바뀌자 **제품이 옳은데 검사가 빨개졌다** — 그건 드리프트를 막는 게 아니라 만드는
    //   것이다([[feedback_hand_maintained_lists]]). 재야 할 것은 수가 아니라 **관계**다.
    const MiB = 1024 * 1024;
    const wire = (d: number): number => Math.ceil(d / 3) * 4;
    const att = (await import(
      new URL("../../../plugins/http-bridge/attachments.ts", import.meta.url).href
    )) as { ATTACH_MAX_FILE_BYTES: number; ATTACH_MAX_TOTAL_BYTES: number };
    out.push(
      assert(
        "★상한이 첨부 계약에서 **유도된다** — 계약이 바뀌면 따라온다(손으로 적은 수가 아니다)",
        mod.BODY_LIMIT_ATTACHMENTS === wire(att.ATTACH_MAX_TOTAL_BYTES) + MiB &&
          mod.BODY_LIMIT_AUDIO === wire(att.ATTACH_MAX_FILE_BYTES) + 256 * 1024 &&
          mod.BODY_LIMIT_DEFAULT === MiB,
        `합계 ${(att.ATTACH_MAX_TOTAL_BYTES / MiB).toFixed(0)}MiB → 첨부 ${(mod.BODY_LIMIT_ATTACHMENTS / MiB).toFixed(2)}MiB · 파일당 ${(att.ATTACH_MAX_FILE_BYTES / MiB).toFixed(0)}MiB → 오디오 ${(mod.BODY_LIMIT_AUDIO / MiB).toFixed(2)}MiB`,
      ),
      // ★★**채널이 능력을 가르면 안 된다** (2026-09-15 정태님). 텔레그램은 Bot API 한도까지
      //  받아 `fs.writeFile` 로 바로 저장하므로 `ingestAttachments` 캡을 **안 지난다**. 그래서
      //  두 상수가 갈리면 같은 파일이 한 채널에선 되고 다른 채널에선 거절된다 — 실제로
      //  10MiB vs 20MB 로 갈려 있었다. 숫자를 여기 적지 않고 **양쪽 소스에서 읽어** 비교한다.
      (() => {
        const tg = readFileSync(
          new URL("../../../plugins/telegram-channel/index.ts", import.meta.url),
          "utf8",
        );
        const m = /const ATTACHMENT_MAX_BYTES = ([0-9 *]+);/.exec(tg);
        const tgBytes = m === null ? NaN : Number(eval(m[1] as string));
        return assert(
          "★★파일당 상한이 **두 채널에서 같다** — 갈리면 같은 파일이 채널에 따라 되고 안 된다",
          Number.isFinite(tgBytes) && tgBytes === att.ATTACH_MAX_FILE_BYTES,
          `텔레그램 ${Number.isFinite(tgBytes) ? (tgBytes / MiB).toFixed(0) : "★못 찾음"}MiB · 대시보드 ${(att.ATTACH_MAX_FILE_BYTES / MiB).toFixed(0)}MiB`,
        );
      })(),
    );

    // ② 실제 소켓 — 작은 상한(4KiB)을 준 서버를 띄운다.
    const LIMIT = 4096;
    const server = http.createServer((req, res) => {
      void (async () => {
        // ★**제품 응답 헬퍼를 쓴다** — 413 에 `Connection: close` 를 붙이는 규칙이 거기
        //  있으므로, 직접 헤더를 쓰면 이 검사가 제품이 아닌 내 흉내를 재게 된다.
        try {
          const b = await mod.readJsonBody(req, LIMIT);
          writeJson(res, 200, { ok: true, keys: Object.keys(b).length });
        } catch (e) {
          writeJson(res, mod.bodyErrorStatus(e), {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const json = (n: number): string => JSON.stringify({ pad: "x".repeat(n) });
      const under = await post(port, json(LIMIT - 200));
      const exact = await post(port, Buffer.concat([Buffer.from('{"pad":"'), Buffer.alloc(LIMIT - 11, 0x78), Buffer.from('"}')]));
      const over = await post(port, json(LIMIT * 3));
      const chunked = await post(port, json(LIMIT * 3), { chunked: true });
      // 헤더 거짓말 두 방향 — **작게** 신고하면 node 파서가 선언한 만큼만 넘겨주므로 우리
      // 눈엔 과대 본문이 아니라 형식 오류다(상한을 우회하지 못한다는 것이 요점).
      // **크게** 신고하면 한 바이트도 안 받고 조기 거절한다.
      const lyingSmall = await post(port, json(LIMIT * 3), { lieContentLength: 10 });
      const lyingBig = await post(port, json(10), { lieContentLength: LIMIT * 3 });
      const bad = await post(port, "{not json");

      out.push(
        assert(
          "상한 아래는 정상 통과한다(정상 사용을 막지 않는다)",
          under.status === 200,
          `${under.status ?? "reset"}`,
        ),
        assert(
          "정확히 상한이면 통과한다(경계에서 한 바이트 차이로 안 막힌다)",
          exact.status === 200,
          `${exact.status ?? "reset"} · ${LIMIT}B`,
        ),
        assert(
          "★★초과는 **413** 이다 — 연결만 끊기면 클라이언트는 원인을 모른다",
          over.status === 413 && !over.reset,
          `${over.status ?? "reset"} · ${over.text.slice(0, 60)}`,
        ),
        assert(
          "★★**chunked**(Content-Length 없음)도 막힌다 — 헤더만 믿으면 그냥 통과한다",
          chunked.status === 413 && !chunked.reset,
          `${chunked.status ?? "reset"}`,
        ),
        assert(
          "★헤더를 **작게** 신고해도 상한을 우회하지 못한다 — 파서가 선언한 만큼만 준다(형식 오류로 닫힘)",
          lyingSmall.status === 400 && !lyingSmall.reset,
          `${lyingSmall.status ?? "reset"}`,
        ),
        assert(
          "★★헤더를 **크게** 신고하면 한 바이트도 안 받고 413 — 조기 거절이 메모리를 지킨다",
          lyingBig.status === 413 && !lyingBig.reset,
          `${lyingBig.status ?? "reset"}`,
        ),
        assert(
          "형식 오류는 **400 그대로**다 — 크기와 형식을 섞지 않는다",
          bad.status === 400,
          `${bad.status ?? "reset"} · ${bad.text.slice(0, 40)}`,
        ),
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // ── ③ ★**호출부에 catch 가 없어도 413 이 나가고 서버가 산다** (2026-09-14, 외부 검토 P1)
    //  실측으로 네 곳(로그인 begin/finish·plugin action·커스텀 엔드포인트 raw)이
    //  `readJsonBody` 를 try 없이 불렀다. 그러면 rejection 이 최상위로 새고, 전역 정책이
    //  `exit(1)` 이라 **요청 하나가 데몬을 죽인다.** 고침은 라우트마다 catch 를 다는 게
    //  아니라 **요청 처리 경계 한 곳**에서 닫는 것이다.
    {
      const LIMIT2 = 2048;
      // 라우트가 `try` 없이 본문을 읽는 상황을 그대로 흉내 낸다(그게 그 네 곳의 모양이다).
      const naked = http.createServer((req, res) => {
        void (async () => {
          const b = await mod.readJsonBody(req, LIMIT2); // catch 없음 — 의도적.
          writeJson(res, 200, { ok: true, keys: Object.keys(b).length });
        })().catch((e: unknown) => {
          // ★★**제품과 같은 함수를 지난다** — 규칙을 여기 다시 쓰면 그 순간 이 검사는
          //  제품이 아니라 내 흉내를 재게 된다(오늘 한 번 그랬다).
          mod.respondToRequestFailure(res, e);
        });
      });
      await new Promise<void>((r) => naked.listen(0, "127.0.0.1", r));
      const port2 = (naked.address() as { port: number }).port;
      try {
        const over = await post(port2, JSON.stringify({ pad: "x".repeat(LIMIT2 * 3) }));
        const chunkedOver = await post(port2, JSON.stringify({ pad: "x".repeat(LIMIT2 * 3) }), { chunked: true });
        const bad = await post(port2, "{nope");
        const after = await post(port2, JSON.stringify({ ok: 1 }));
        out.push(
          assert(
            "★★catch 없는 호출부의 초과도 **413** 으로 닫힌다 — rejection 이 새면 데몬이 죽는다",
            over.status === 413 && chunkedOver.status === 413,
            `직접 ${over.status ?? "reset"} · chunked ${chunkedOver.status ?? "reset"}`,
          ),
          assert(
            "★형식 오류는 그대로 500 계열로 닫히고(413 으로 뭉개지 않는다) 유출이 없다",
            bad.status === 500 && !bad.reset,
            `${bad.status ?? "reset"}`,
          ),
          assert(
            "★★초과 요청 **직후에도 서버가 살아** 다음 정상 요청을 처리한다",
            after.status === 200,
            `${after.status ?? "reset"} · ${after.text.slice(0, 40)}`,
          ),
        );
      } finally {
        await new Promise<void>((r) => naked.close(() => r()));
      }
    }

    // ③-b ★**이미 응답한 뒤 던지면 아무것도 더 쓰지 않는다** — 이중 응답은
    //  `ERR_HTTP_HEADERS_SENT` 로 다시 던져 «요청 하나가 데몬을 죽인다» 를 재발시킨다
    //  (이 레포가 `write-json-serializes-first` 로 지키는 그 사고).
    {
      const late = http.createServer((req, res) => {
        void (async () => {
          req.resume();
          writeJson(res, 200, { ok: true }); // 먼저 응답하고,
          throw new Error("응답 뒤에 터졌다"); // 그 뒤에 던진다.
        })().catch((e: unknown) => {
          const r = mod.respondToRequestFailure(res, e);
          if (r.wrote) res.setHeader("x-double-write", "yes"); // 도달하면 이미 늦다.
        });
      });
      await new Promise<void>((r) => late.listen(0, "127.0.0.1", r));
      const portL = (late.address() as { port: number }).port;
      try {
        const r = await post(portL, JSON.stringify({ a: 1 }));
        out.push(
          assert(
            "★이미 응답한 뒤 던져도 **덧쓰지 않는다**(200 유지 · 이중 응답 0)",
            r.status === 200 && !r.reset && r.text.includes('"ok":true'),
            `${r.status ?? "reset"} · ${r.text.slice(0, 30)}`,
          ),
          // ★★**여기가 하중을 받는 곳이다.** 이 함수는 최상위 `catch` **안**에서 불린다 —
          //  여기서 던지면 그 throw 가 곧 `unhandledRejection` 이고, 전역 정책이 `exit(1)`
          //  이다. 즉 «응답 못 쓰는 것» 이 아니라 «여기서 던지는 것» 이 데몬을 죽인다.
          //  (`headersSent` 가드만 재면 안 보인다 — 안쪽 try/catch 가 이미 삼키기 때문에
          //   클라이언트 눈엔 똑같다. 변이가 그걸 알려줬다.)
          (() => {
            const fake = {
              headersSent: false,
              writableEnded: false,
              writeHead: () => { throw new Error("헤더를 못 쓴다"); },
              end: () => { throw new Error("소켓이 죽었다"); },
              setHeader: () => {},
            } as unknown as http.ServerResponse;
            let threw = "";
            let wrote: boolean | undefined;
            try {
              wrote = mod.respondToRequestFailure(fake, new Error("아무 오류")).wrote;
            } catch (err) {
              threw = err instanceof Error ? err.message : String(err);
            }
            return assert(
              "★★실패 응답 함수는 **어떤 경우에도 던지지 않는다** — 최상위 catch 안이라 던지면 데몬이 죽는다",
              threw === "" && wrote === false,
              `헤더·소켓 둘 다 던지는 상황 → ${threw === "" ? `안 던짐(wrote=${String(wrote)})` : `★던짐: ${threw}`}`,
            );
          })(),
        );
      } finally {
        await new Promise<void>((r) => late.close(() => r()));
      }
    }

    // ④ 제품의 **최상위 경계가 실제로 배선돼 있나** — 위 검사는 판정 함수를 지나지만,
    //  그 함수를 아무도 안 부르면 유출은 그대로다(«검사는 있는데 안 도는» 그 모양).
    {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(
        new URL("../../../plugins/http-bridge/index.ts", import.meta.url),
        "utf8",
      );
      out.push(
        assert(
          "★요청 처리의 rejection 이 **최상위에서 닫힌다**(`handleRequest(...).catch` + 공통 판정)",
          /handleRequest\(req, res\)\s*\.catch\(/.test(src) &&
            /respondToRequestFailure\(res, e\)/.test(src),
          `catch 배선=${/handleRequest\(req, res\)\s*\.catch\(/.test(src)} · 공통 판정=${/respondToRequestFailure/.test(src)}`,
        ),
      );
    }

    return out;
  },
};
