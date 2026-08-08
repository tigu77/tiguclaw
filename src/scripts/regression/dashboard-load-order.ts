/**
 * 회귀: **정의보다 먼저 로드되는 파일이 그 심볼을 쓰면 가드가 있어야 한다** (2026-08-08).
 *
 * 대시보드 js 는 여러 `<script>` 로 나뉘어 **전역 스코프를 공유**한다. 그래서 파일 간 함수
 * 재사용이 관례인데(`channel-hints.js` 주석이 그렇게 적어 뒀다), **로드 순서**가 맞아야 한다.
 *
 * 실측(헤드리스 Chrome + CDP): 페이지 로드 중 콘솔에
 *   `ReferenceError: fmtElapsed is not defined  at buildShellCard (view-shells.js:280)`
 * 가 **2건** 찍혔다. `fmtElapsed` 는 `background-drawer.js`(로드 13번)에 있는데
 * `view-shells.js` 는 **7번**이다 — 그 사이에 셸 이벤트가 도착하면 렌더가 통째로 죽는다.
 * 로드가 끝난 뒤엔 `typeof fmtElapsed === "function"` 이라 **조용히 지나간다**(재현이 어렵다).
 *
 * ★등급: **배선 린트**. 심볼 하나를 이름으로 본다 — 파일 간 공유가 늘면 이 검사도 늘어야
 *  한다(그 자체가 손 관리 목록이다). 그래도 두는 이유는 이 부류가 **콘솔에만 남고 화면엔
 *  "그냥 안 그려짐" 으로 보여** 사람이 원인을 못 찾기 때문이다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 파일 간 공유 심볼 — 정의처와 사용처의 로드 순서가 어긋날 수 있는 것. */
const SHARED = "fmtElapsed";

export const check: RegressionCheck = {
  name: "dashboard-load-order",
  guards:
    "대시보드 js 파일 간 공유 심볼 — 정의보다 먼저 로드되는 사용처는 typeof 가드를 갖는다",
  run: async (): Promise<Assertion[]> => {
    const root = new URL("../../../packages/dashboard/", import.meta.url);
    const html = await readFile(new URL("index.html", root), "utf8");
    // 로드 순서는 index.html 이 정본이다(손으로 적지 않는다).
    const order = [...html.matchAll(/src="\/js\/([\w-]+\.js)"/g)].map((m) => m[1]!);

    const defs: string[] = [];
    const uses: string[] = [];
    for (const f of order) {
      let src: string;
      try {
        src = await readFile(new URL(`js/${f}`, root), "utf8");
      } catch {
        continue;
      }
      const body = src.replace(/\/\/[^\n]*/g, "");
      if (new RegExp(`(?:const|let|var|function)\\s+${SHARED}\\b`).test(body)) defs.push(f);
      else if (new RegExp(`\\b${SHARED}\\s*\\(`).test(body)) uses.push(f);
    }
    const defIdx = defs.length > 0 ? order.indexOf(defs[0]!) : -1;
    // 정의보다 **먼저** 로드되는 사용처만 위험하다.
    const early = uses.filter((f) => order.indexOf(f) < defIdx);

    const unguarded: string[] = [];
    for (const f of early) {
      const body = (await readFile(new URL(`js/${f}`, root), "utf8")).replace(/\/\/[^\n]*/g, "");
      // 가드 = 호출 전에 `typeof <심볼> === "function"` 을 본다.
      if (!new RegExp(`typeof\\s+${SHARED}\\s*===\\s*["']function["']`).test(body)) {
        unguarded.push(f);
      }
    }

    return [
      assert(
        "로드 순서를 index.html 에서 읽었다(손 목록 아님)",
        order.length >= 10 && defIdx !== -1,
        `${order.length}개 · 정의=${defs[0] ?? "없음"}(${defIdx})`,
      ),
      assert(
        `★정의(${defs[0] ?? "?"})보다 먼저 로드되는 사용처는 typeof 가드를 갖는다`,
        unguarded.length === 0,
        early.length === 0
          ? "앞선 사용처 없음"
          : unguarded.length === 0
            ? `앞선 사용처 ${early.join(",")} — 전부 가드`
            : `★가드 없음: ${unguarded.join(",")}`,
      ),
    ];
  },
};
