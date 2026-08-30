/**
 * 회귀: **브리지 라우트가 실제로 응답한다** (2026-08-30).
 *
 * ★사고 — 오늘 실제로 냈다. `http-bridge/index.ts`(3,914줄)를 관심사별로 쪼개면서 라우트
 *  **본문**을 함수로 옮겼는데, 본문 끝의 `return;` 이 그 함수 안으로 들어가버렸다. 호출부에
 *  `return;` 을 안 남겼으니 `handleRequest` 가 계속 흘러 **404 폴백까지 가서 헤더를 두 번**
 *  썼다 → `ERR_HTTP_HEADERS_SENT` → `unhandledRejection` → **데몬 crash-fast.**
 *
 *  실측: `/health`(인증 게이트 **앞**)만 200이고 **그 뒤 21개 라우트가 전부 000**,
 *  프로세스는 첫 요청에 죽었다.
 *
 * ★**그런데 소스 검사는 전부 초록이었다.** 그날 만든 `bridge-serves-what-dashboard-calls`
 *  (화면이 부르는 라우트를 서버가 내는가)도, 회귀 2,330건도 통과했다 — 라우트 **조건**은
 *  멀쩡히 그 자리에 있었기 때문이다. 소스는 *"등록돼 있는가"* 만 볼 수 있고 *"응답하는가"*
 *  는 못 본다([[feedback_gate_must_actually_run]]).
 *
 *  잡은 건 데몬을 띄우는 검사 하나(`ephemeral-wiring`)뿐이었고, 그마저 증상이
 *  *"SSE 구독 실패 — 환경"* 으로 보여 **환경 탓으로 넘길 뻔했다.** 그래서 이 검사를 만든다:
 *  증상이 아니라 **라우트별 상태 코드**를 낸다.
 *
 * 지키는 것 셋:
 *  ① 데몬이 뜨고 **첫 요청 뒤에도 살아 있다**(헤더 이중 쓰기는 프로세스를 죽인다).
 *  ② 인증 뒤 GET 라우트가 **전부 응답한다**(0 = 연결 끊김 = 이 사고의 지문).
 *  ③ ★**목록을 손으로 안 적는다** — 소스에서 GET 라우트를 뽑는다. 새 라우트가 생기면
 *     검사를 안 고쳐도 대상에 들어온다([[feedback_hand_maintained_lists]]).
 *
 * ★값이 맞는지는 **안 본다** — 그건 각 기능의 회귀 몫이다. 여기는 *"살아 있는가"* 한 축이다.
 * 등급: **실행**(데몬 부팅 + 실제 HTTP).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "_bridge-routes-child.js",
);

interface Probe {
  boot?: boolean;
  why?: string;
  rows?: Array<{ path: string; status: number }>;
  alive?: boolean;
  tail?: string;
}

export const check: RegressionCheck = {
  name: "bridge-routes-answer",
  guards:
    "라우트 본문을 모듈로 옮기면서 호출부의 `return;` 을 빠뜨려 handleRequest 가 404 폴백까지 흘러 **헤더를 두 번 쓰고 데몬이 죽던 것**(2026-08-30 실사고: /health 만 200, 그 뒤 21개 전부 000) — 소스 검사는 라우트 **조건**이 제자리에 있어서 2,330건이 전부 초록이었다. '등록돼 있는가' 와 '응답하는가' 는 다르다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = mkdtempSync(path.join(tmpdir(), "br-routes-"));
    let got: Probe = {};
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
        encoding: "utf8",
        timeout: 90_000,
        env: { ...process.env, PROBE_HOME: home },
      });
      try {
        got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Probe;
      } catch {
        got = {};
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    const rows = got.rows ?? [];
    out.push(
      assert(
        "프로브 데몬이 떴다(안 뜨면 아래 판정은 무의미하다)",
        got.boot === true,
        got.why ?? `★프로브 무응답 · ${got.tail ?? ""}`,
      ),
    );
    if (got.boot !== true) return out;

    out.push(
      assert(
        `인증 뒤 GET 라우트를 소스에서 뽑는다(손 목록 없음) — ${String(rows.length)}개`,
        rows.length >= 15,
        rows.map((r) => r.path).join(", ").slice(0, 200),
      ),
    );

    // ★`0` 은 **연결이 끊겼다**는 뜻 — 이 사고의 지문이다. 4xx 는 정상(인자 부족 등).
    const dead = rows.filter((r) => r.status === 0);
    out.push(
      assert(
        "★★모든 라우트가 **응답한다** — 상태 코드 0(연결 끊김)이 하나도 없다. 0 이 나오면 핸들러가 던졌거나 헤더를 두 번 썼다는 뜻이고, 그건 데몬을 죽인다",
        dead.length === 0,
        dead.length === 0
          ? `${String(rows.length)}개 전부 응답(2xx ${String(rows.filter((r) => r.status < 300).length)} · 4xx ${String(rows.filter((r) => r.status >= 400 && r.status < 500).length)})`
          : `★무응답: ${dead.map((r) => r.path).join(", ")}`,
      ),
    );

    out.push(
      assert(
        "★★데몬이 **요청을 다 받고도 살아 있다** — 헤더 이중 쓰기는 unhandledRejection 으로 crash-fast 를 부른다(실사고에서 첫 요청에 죽었다)",
        got.alive === true,
        got.alive === true ? "생존" : `★죽었다 · ${got.tail ?? ""}`,
      ),
    );

    const server5xx = rows.filter((r) => r.status >= 500);
    out.push(
      assert(
        "5xx 가 없다(있으면 그 라우트 안에서 던진 것)",
        server5xx.length === 0,
        server5xx.length === 0 ? "5xx 0건" : `★${server5xx.map((r) => `${r.path}:${String(r.status)}`).join(", ")}`,
      ),
    );

    return out;
  },
};
