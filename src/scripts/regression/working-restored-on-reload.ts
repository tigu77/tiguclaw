/**
 * 회귀: **새로고침해도 진행 중 턴이 보인다** — ★행동 게이트 (2026-08-09 사용자 신고).
 *
 * 신고: "새로고침하면 작업중 표시가 다 사라져. 세션탭에도 깜빡임배지 사라지네."
 *
 * 원인은 **소비처 부재**였다. 작업중 표시는 SSE `llm.turn_start` 로**만** 켜지는데,
 * `activeTurns` 는 브라우저 메모리(Map)라 새로고침하면 비고, **이미 시작된 턴의 turn_start 는
 * 다시 오지 않는다**(SSE 는 연결 이후만 흘린다). 그래서 새로고침 순간부터 그 턴은 화면상
 * 존재하지 않았고, 탭 진행 배지도 같은 Map 을 보므로 함께 사라졌다. 사용자는 비서가 놀고
 * 있는 줄 안다.
 *
 * ★서버는 원래부터 알고 있었다 — `/health` 가 `active_turn_threads`(`getInflightTurns().keys`)
 *  를 싣는다. 대시보드도 부팅 때 그 응답을 **이미 받고 있었다**(버전 표시용). 필드만 안 읽었다.
 *  부품이 다 있고 **배선 한 줄**이 없던 것이다. 바로 앞 사고(이력 상한이 진행 중 턴 활동을
 *  버려서 "재개 코드는 있는데 재료가 없던 것")와 **정확히 반대 짝**이다.
 *
 * ★등급: **행동 게이트**(판정을 뽑아 실행) + **배선 린트**(호출부·로드 순서).
 *  `null`(모름)과 `[]`(없음)의 구분이 판정의 핵심이다 — 서버는 미등록일 때 `null` 을 준다
 *  (0 과 구분하려고 일부러 그렇게 설계했다). 모를 때 켜면 가짜 "작업 중"이 영원히 남는다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ACTIVITY = "../../../packages/dashboard/js/activity.js";
const BRIDGE = "../../../plugins/http-bridge/index.ts";
const INDEX_HTML = "../../../packages/dashboard/index.html";
const TABS = "../../../packages/dashboard/js/tabs.js";
const AXIS = "../../../packages/dashboard/js/axis1-options.js";

export const check: RegressionCheck = {
  name: "working-restored-on-reload",
  guards:
    "새로고침 후 진행 중 턴의 작업중 표시·탭 배지가 복원된다 — 서버는 아는데 화면이 안 묻던 것",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(new URL(ACTIVITY, import.meta.url), "utf8");
    const bridge = await readFile(new URL(BRIDGE, import.meta.url), "utf8");
    const html = await readFile(new URL(INDEX_HTML, import.meta.url), "utf8");
    const tabs = await readFile(new URL(TABS, import.meta.url), "utf8");
    const axis = await readFile(new URL(AXIS, import.meta.url), "utf8");

    // 판정 함수를 뽑아 **실제로 실행**한다(문자열 검사 아님).
    const m = /const activeThreadsFromHealth = \(h\) => \{([\s\S]*?)\n {6}\};/.exec(src);
    const fn =
      m === null
        ? null
        : (new Function("h", m[1]!) as (h: unknown) => string[]);

    const okCase = fn?.({ active_turn_threads: ["dashboard:default", "dashboard:demo"] });
    const nullCase = fn?.({ active_turn_threads: null });
    const missingCase = fn?.({ version: "0.23.1" });
    const junkCase = fn?.({ active_turn_threads: ["", 7, null, "worker:x"] });

    // 배선 — 부팅에서 실제로 부르고, 그 결과가 markTurnActive 로 간다.
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // ★복원분은 `startUnknown: true` 로 넘겨야 한다 — 안 그러면 시작시각을 `Date.now()` 로
    //  지어내 10분째 도는 턴이 "0초" 부터 다시 센다(적대 검토 E). 바로 그 자리가 2026-08-06 에
    //  "모르는 값을 지어내지 않는다" 로 고쳐진 곳이다.
    const calls =
      /for \(const k of activeThreadsFromHealth\(h\)\) markTurnActive\(k, \{ startUnknown: true \}\)/.test(body);
    // ★선언이 아니라 **호출**을 본다. 종전 정규식은 `function restoreActiveTurns() {` 선언문
    //  자체에 매칭돼, 호출만 지워도 초록이었다(적대 검토 M1 — 이름 검사였지 배선 검사가
    //  아니었다). 줄 시작이 `function` 이 아닌 `restoreActiveTurns();` 만 센다.
    const onBoot = /(^|\n)\s*restoreActiveTurns\(\);/.test(body);
    // 서버가 그 필드를 실제로 싣는가(생산처 — 소비처만 보면 반쪽이다).
    const served = /active_turn_threads:\s*inflight === null \? null : inflight\.keys/.test(bridge);
    // 로드 순서 — `markTurnActive` 정의(axis1-options.js)가 activity.js 보다 먼저여야 한다.
    const order = [...html.matchAll(/src="\/js\/([\w-]+\.js)"/g)].map((x) => x[1]!);
    const orderOk =
      order.indexOf("axis1-options.js") !== -1 &&
      order.indexOf("axis1-options.js") < order.indexOf("activity.js");

    return [
      assert(
        "판정 함수를 실제로 뽑아 실행했다",
        fn !== null,
        fn === null ? "★추출 실패 — 이름/형태가 바뀌었나" : "추출·실행 OK",
      ),
      assert(
        "★진행 중 스레드를 그대로 돌려준다(이게 새로고침 후 복원의 재료)",
        Array.isArray(okCase) && okCase.length === 2 && okCase[0] === "dashboard:default",
        JSON.stringify(okCase),
      ),
      assert(
        "★`null`(서버가 모름)은 **켜지 않는다** — 모를 때 켜면 가짜 작업중이 영원히 남는다",
        Array.isArray(nullCase) && nullCase.length === 0,
        JSON.stringify(nullCase),
      ),
      assert(
        "필드가 아예 없어도 안전하다(옛 서버·부분 응답)",
        Array.isArray(missingCase) && missingCase.length === 0,
        JSON.stringify(missingCase),
      ),
      assert(
        "빈 문자열·비문자열은 거른다(빈 키로 표시가 켜지지 않게)",
        Array.isArray(junkCase) && junkCase.length === 1 && junkCase[0] === "worker:x",
        JSON.stringify(junkCase),
      ),
      assert(
        "★[배선] 부팅에서 부르고 결과가 markTurnActive 로 간다(판정만 맞고 호출부가 빠지는 것)",
        calls && onBoot,
        `호출=${String(calls)} · 부팅=${String(onBoot)}`,
      ),
      assert(
        "★[배선] 서버가 `active_turn_threads` 를 **실제로 싣는다**(생산처까지 본다)",
        served,
        served ? "/health 가 inflight.keys 제공" : "★서버가 안 싣는다",
      ),
      assert(
        "★탭 자동 개설은 **이름 붙인 세션만**(목록 가시성과 다른 질문 — 검증 흔적이 탭을 먹던 것)",
        /const shouldAutoOpenTab = \(s\) =>[\s\S]{0,200}typeof s\.name === "string" && s\.name\.trim\(\) !== ""/.test(src) &&
          /if \(!shouldAutoOpenTab\(s\) \|\| closed\.has\(tk\)\) continue;/.test(tabs),
        "이름 기준 + 호출부",
      ),
      assert(
        "★복원분은 **경과시간을 지어내지 않는다**(시작시각 null → 표시 없음, 스윕은 별도 시계)",
        /activeTurns\.set\(k, unknownStart \? null : Date\.now\(\)\)/.test(axis) &&
          /start === null \? \(restoredAt\.get\(k\) \|\| now\) : start/.test(axis),
        "null 시작 + 스윕 분리",
      ),
      assert(
        "★유령 진행표시 자동 해제 시계가 **사람이 기다릴 수 있는 범위**다(유일한 해제 장치)",
        (() => {
          const mm = /const STALE_TURN_MS = ([\d\s*]+);/.exec(axis);
          if (mm === null) return false;
          const ms = Function(`return ${mm[1]}`)() as number;
          return ms >= 5 * 60_000 && ms <= 60 * 60_000;
        })(),
        (/const STALE_TURN_MS = ([\d\s*]+);/.exec(axis) ?? [, "?"])[1] ?? "?",
      ),
      assert(
        "[배선] 로드 순서 — markTurnActive 정의가 사용처보다 먼저다",
        orderOk,
        `axis1-options(${order.indexOf("axis1-options.js")}) < activity(${order.indexOf("activity.js")})`,
      ),
    ];
  },
};
