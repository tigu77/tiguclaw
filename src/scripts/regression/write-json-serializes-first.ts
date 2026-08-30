/**
 * 회귀: **JSON 응답이 실패해도 데몬이 죽지 않는다** (2026-08-27).
 *
 * 브리지의 모든 JSON 응답은 한 함수를 지난다. 그 함수가 **헤더를 먼저 쓰고 직렬화를 나중에**
 * 하면(v0.39.0 까지 그랬다) `JSON.stringify` 가 던질 때 이렇게 된다:
 *
 *   1. 헤더 200이 이미 나갔다 · 응답은 안 끝났다
 *   2. 예외를 받은 상위가 500을 쓰려 한다 → `ERR_HTTP_HEADERS_SENT` 로 **다시** 던진다
 *   3. `unhandledRejection` → **crash-fast** — 요청 하나가 프로세스를 죽인다
 *
 * 순서만 바꾸면 던져도 **헤더 미전송**이라 상위가 정상적으로 500을 쓸 수 있다. 던지는 것
 * 자체를 막지는 않는다 — 막으면 직렬화 불가를 200으로 덮게 되고 그건 조용한 오답이다.
 *
 * 등급: **동작 검사** — 진짜 `http.Server` 를 띄워 순환 참조 본문을 실제로 흘린다.
 * 소스 grep 은 이 축에 원리적으로 약하다(지키려는 게 두 줄의 **순서**다).
 * 격리: 포트를 커널에서 받고(`listen(0)`) 끝나면 닫는다 — 도는 데몬을 안 건드린다.
 */
import http from "node:http";
import { readSourceSync } from "./_wiring.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../core/net/write-json.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Probe {
  status: number;
  body: string;
  /** ★던진 시점에 헤더가 나가 있었나 — 여기가 crash-fast 의 분기점이다. */
  headersSentOnThrow: boolean | null;
  threw: boolean;
  /** 상위가 500을 쓰려다 또 던졌나(= 종전 동작). */
  secondWriteThrew: boolean;
}

/** 순환 참조 — `JSON.stringify` 가 확실히 던지는 값. */
const circular = (): unknown => {
  const o: Record<string, unknown> = { ok: true };
  o.self = o;
  return o;
};

const probe = async (): Promise<Probe> => {
  const out: Probe = {
    status: 0,
    body: "",
    headersSentOnThrow: null,
    threw: false,
    secondWriteThrew: false,
  };
  const server = http.createServer((_req, res) => {
    try {
      writeJson(res, 200, circular());
    } catch {
      out.threw = true;
      out.headersSentOnThrow = res.headersSent;
      // ★상위 에러 핸들러가 하는 일 그대로 — 이게 되면 사용자는 500을 받고 데몬은 산다.
      try {
        writeJson(res, 500, { error: { message: "serialize failed" } });
      } catch {
        out.secondWriteThrew = true;
        res.destroy();
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await new Promise<void>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        out.status = res.statusCode ?? 0;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          out.body += c;
        });
        res.on("end", resolve);
      });
      req.on("error", () => resolve()); // 연결이 끊기면(종전 동작) 그대로 판정한다.
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return out;
};

export const check: RegressionCheck = {
  name: "write-json-serializes-first",
  guards:
    "브리지 JSON 응답이 헤더를 먼저 쓰고 직렬화를 나중에 해서, stringify 가 던지면 상위의 500 쓰기가 ERR_HTTP_HEADERS_SENT 로 또 던져 unhandledRejection → 데몬 crash-fast 로 가던 것 — 요청 하나가 프로세스를 죽인다",
  run: async (): Promise<Assertion[]> => {
    const p = await probe();
    const src = readSourceSync("plugins/http-bridge");

    return [
      assert(
        "★직렬화가 실패하면 던진다(200으로 덮지 않는다 — 덮으면 조용한 오답)",
        p.threw,
        p.threw ? "던짐" : "★안 던졌다 — 직렬화 불가를 삼키고 있다",
      ),
      assert(
        "★던진 시점에 헤더가 아직 안 나갔다(여기가 crash-fast 의 분기점)",
        p.headersSentOnThrow === false,
        `headersSent=${String(p.headersSentOnThrow)} — true 면 상위가 500을 못 쓴다`,
      ),
      assert(
        "★상위가 500을 쓸 수 있다(두 번째 쓰기가 ERR_HTTP_HEADERS_SENT 로 또 던지지 않는다)",
        !p.secondWriteThrew,
        p.secondWriteThrew ? "★두 번째 쓰기도 던졌다 = unhandledRejection 경로" : "500 기록 성공",
      ),
      assert(
        "★클라이언트가 500과 본문을 실제로 받는다(연결이 끊기지 않는다)",
        p.status === 500 && p.body.includes("serialize failed"),
        `status=${p.status} body=${JSON.stringify(p.body.slice(0, 60))}`,
      ),
      // 함수만 고치고 브리지가 제 사본을 쓰면 규칙이 죽는다.
      assert(
        "★브리지가 이 함수를 쓴다(지역 사본으로 돌아가지 않았다)",
        /import \{ writeJson \} from "\.\.\/\.\.\/src\/core\/net\/write-json\.js";/.test(src) &&
          !/const writeJson\s*=/.test(src),
        /const writeJson\s*=/.test(src)
          ? "★index.ts 에 지역 정의가 다시 생겼다"
          : `import 있음 · 호출 ${(src.match(/writeJson\(/g) ?? []).length}곳`,
      ),
    ];
  },
};
