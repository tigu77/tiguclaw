/**
 * 회귀: **대시보드 «여기서 갈라내기» 는 성공할 때까지 같은 가지 키로 재시도한다** (2026-10-15 적대 검토 P3 · 아스트라 회신).
 *
 * 사고: 응답을 못 받으면(5분 넘는 대기 → 502, 연결 끊김) 화면은 실패를 띄우는데 서버는 줄에서 나중에 갈랐다. 다시 누르면 **새 키**로
 *  요청해 서버의 같은 키 중복 방지에 안 걸리고 가지가 둘 생겼다. 서버에 같은 키를 두 번 넘기는 검사로는 이 화면 결함이 안 보인다 —
 *  그래서 **실제 화면 함수**(`tabs.js` 의 `forkSession` 블록)를 떼어 대역(fetch·토스트·탭 열기)과 함께 실행한다.
 * 범위: 페이지 메모리(Map)다 — 새로고침 뒤 재시도까지 보장하지 않는다(아스트라: 그 범위를 해결했다고 쓰지 말 것).
 *
 * 등급: **실행**(화면 코드 블록을 그대로 실행).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };

export const check: RegressionCheck = {
  name: "dashboard-fork-retry-key",
  guards: "갈라내기 응답을 못 받은 뒤 다시 누르면 새 키로 요청해 가지가 두 개 생기던 것 + 연타 · 파싱 실패 · 성공 뒤 새 의도",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/js/tabs.js"), "utf8");
    const start = src.indexOf("const FORK_RETRY_MS");
    const endMarker = "          forkInFlight.delete(tk);\n        }\n      };";
    const end = src.indexOf(endMarker, start);
    if (start < 0 || end < 0) return [assert("tabs.js 에서 forkSession 블록을 찾는다", false, { start, end })];
    const block = src.slice(start, end + endMarker.length);

    const requests: string[] = [];
    const opened: string[] = [];
    const toasts: string[] = [];
    let uuid = 0;
    let clock = 1_000_000;
    let next: (body: { childKey: string }) => Promise<Resp> = async () => { throw new Error("unset"); };
    // 화면 상태는 함수가 만들어질 때 묶인다 — 시나리오마다 «지금 보고 있는 탭» 을 정해 새로 만든다.
    const make = (active: string): ((tk: string) => Promise<void>) => {
    const env = {
      activeThreadKey: active,
      Date: { now: () => clock },
      activeTurns: new Map<string, number>(),
      forkParents: new Map<string, string>(),
      showToast: (m: string) => { toasts.push(m); },
      i18n: (k: string) => k,
      registerBuiltinHandler: () => {},
      self: { crypto: { randomUUID: () => `test-${++uuid}` } },
      window: { openSessionByKey: (k: string) => { opened.push(k); return true; } },
      console: { warn: () => {} },
      fetch: async (_u: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { childKey: string };
        requests.push(body.childKey);
        return next(body);
      },
    };
    return new Function(...Object.keys(env), `${block}\nreturn forkSession;`)(...Object.values(env)) as (tk: string) => Promise<void>;
    };
    let forkSession = make("dashboard:P");
    const ok = (b: { childKey: string }): Promise<Resp> => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, childKey: b.childKey, name: "x (2)" }) });

    next = async () => { throw new Error("bridge unreachable"); }; // 서버는 갈랐는데 응답만 잃었다
    await forkSession("dashboard:P");
    next = ok;
    await forkSession("dashboard:P"); // 재시도
    await forkSession("dashboard:P"); // 성공 뒤 새 의도
    out.push(assert("★★응답을 잃은 뒤 다시 누르면 **같은 키**(서버가 그 가지를 돌려준다) · 성공 뒤 다시 누르면 새 키",
      requests.length === 3 && requests[0] === requests[1] && requests[2] !== requests[1] && opened[0] === requests[1],
      { requests, opened }));

    // 한참 뒤 다시 누르면 «지금 시점에서 새로» — 옛 키를 쓰면 서버가 옛 시점의 가지를 돌려준다(재검토 P2).
    requests.length = 0;
    next = async () => { throw new Error("bridge unreachable"); };
    await forkSession("dashboard:P");
    clock += 121_000;
    next = ok;
    await forkSession("dashboard:P");
    out.push(assert("★실패 뒤 **2분 넘어** 다시 누르면 새 키(옛 시점의 가지를 열지 않는다)", requests.length === 2 && requests[0] !== requests[1], requests));

    // 기다리는 사이 다른 탭으로 갔으면 끌고 가지 않는다 — 새 탭은 알림만.
    forkSession = make("dashboard:다른탭");
    opened.length = 0; toasts.length = 0; requests.length = 0;
    next = ok;
    await forkSession("dashboard:P");
    out.push(assert("기다리는 사이 다른 탭에 있으면 활성 탭을 옮기지 않고 알림만", requests.length === 1 && opened.length === 0 && toasts.includes("tab.forkReady"), { opened, toasts }));
    forkSession = make("dashboard:Q");

    requests.length = 0;
    next = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("not json"); } });
    await forkSession("dashboard:Q");
    next = ok;
    await forkSession("dashboard:Q");
    out.push(assert("응답을 못 읽은 실패(파싱 실패)에서도 키를 유지한다", requests.length === 2 && requests[0] === requests[1], requests));

    requests.length = 0;
    // 걸린 요청을 **전부** 풀 수 있게 모은다 — 가드가 빠져 두 번째 요청이 나가도 검사가 매달리지 않고 빨강으로 끝난다.
    const releases: (() => void)[] = [];
    next = (b) => new Promise<Resp>((res) => { releases.push(() => res({ ok: true, status: 200, json: async () => ({ ok: true, childKey: b.childKey, name: "y" }) })); });
    forkSession = make("dashboard:R");
    const first = forkSession("dashboard:R");
    const second = forkSession("dashboard:R"); // 요청 중 연타
    await new Promise((res) => setTimeout(res, 10));
    for (const r of releases) r();
    await Promise.all([first, second]);
    out.push(assert("요청 중 연타는 막는다(요청 하나)", requests.length === 1, requests));

    requests.length = 0;
    forkSession = make("dashboard:S");
    next = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, reason: "empty" }) });
    await forkSession("dashboard:S");
    next = ok;
    await forkSession("dashboard:S");
    out.push(assert("«갈라낼 게 없다» 는 확정 실패 — 다음 시도는 새 키", requests.length === 2 && requests[0] !== requests[1], requests));
    return out;
  },
};
