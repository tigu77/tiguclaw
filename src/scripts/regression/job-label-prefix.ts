/**
 * 회귀: **잡 라벨 접두(`📦`/`🤖`)가 멱등이다** (2026-08-26).
 *
 * ★이 규칙엔 그물이 **하나도 없었다**(적대 검토 G축 ②). 접두가 두 번 붙거나(`📦 📦 작업`)
 *  에이전트로 승격됐는데 안 떨어져도 스위트는 초록이다 — **화면에서 눈으로만** 보인다.
 *  드로어에 워커와 서브에이전트가 섞여 있을 때 접두가 사실상 유일한 구분 단서라(모바일에선
 *  kind 배지가 다음 줄로 wrap 된다) 틀리면 바로 "이게 뭐였지" 가 된다.
 *
 * ★검사할 수 있게 하려고 판단을 **순수 함수로 뺐다**(`withKindPrefix`). 종전엔 갱신 루프
 *  한복판에 인라인이라 부를 수가 없었고, 그래서 소스 grep 말고는 방법이 없었다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 *
 * 등급: **행동 검사** — 브라우저 소스에서 정의를 떼어 vm 에서 **실제로 부른다**.
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = new URL("../../../packages/dashboard/js/background-drawer.js", import.meta.url);

/** 접두 상수 + 순수 함수 정의만 떼어낸다. */
const sliceDefs = (src: string): string => {
  const from = src.indexOf('      const WORKER_LABEL_PREFIX = ');
  const to = src.indexOf("      const withKindPrefix", from);
  const end = src.indexOf("      };", to);
  if (from < 0 || to < 0 || end < 0) {
    throw new Error("withKindPrefix 정의를 못 찾음 — 구조가 바뀌었나");
  }
  return src.slice(from, end + "      };".length);
};

export const check: RegressionCheck = {
  name: "job-label-prefix",
  guards:
    "워커/서브에이전트 라벨 접두(📦/🤖) 규칙에 그물이 0이라, 접두가 두 번 붙거나 에이전트 승격 때 안 떨어져도 스위트가 초록이던 것 — 드로어에서 둘을 가르는 사실상 유일한 단서다",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(SRC, "utf8");
    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(`${sliceDefs(src)}\nthis.__f = withKindPrefix;\nthis.__p = WORKER_LABEL_PREFIX;`, ctx);
    const f = ctx.__f as (kind: string, label: string) => string;
    const P = ctx.__p as string;

    const worker1 = f("worker", "정산");
    const worker2 = f("worker", worker1);
    const agent1 = f("agent", worker1);
    const agent2 = f("agent", agent1);

    return [
      assert(
        "접두 상수를 실제로 읽었다(빈손 통과 금지)",
        typeof P === "string" && P.length > 0 && typeof f === "function",
        `접두=${JSON.stringify(P)}`,
      ),
      assert(
        "★워커 라벨엔 접두가 붙는다",
        worker1 === `${P}정산`,
        `${JSON.stringify(worker1)} (기대 ${JSON.stringify(`${P}정산`)})`,
      ),
      assert(
        "★두 번 불러도 접두가 겹치지 않는다(멱등)",
        worker2 === worker1,
        `1회=${JSON.stringify(worker1)} 2회=${JSON.stringify(worker2)}`,
      ),
      assert(
        "★에이전트로 승격되면 접두가 떨어진다",
        agent1 === "정산",
        `${JSON.stringify(agent1)} (기대 "정산")`,
      ),
      assert(
        "★떼는 것도 멱등이다(접두 없는 라벨을 깎지 않는다)",
        agent2 === agent1 && f("agent", "이름") === "이름",
        `2회=${JSON.stringify(agent2)} · 무접두=${JSON.stringify(f("agent", "이름"))}`,
      ),
      assert(
        "★접두로 시작하는 **사용자 문구**를 잘못 깎지 않는다(워커 경로)",
        f("worker", `${P}${P}x`) === `${P}${P}x`,
        JSON.stringify(f("worker", `${P}${P}x`)),
      ),
      // 호출부가 그 함수를 실제로 쓰는가 — 함수만 있고 안 부르면 규칙이 죽은 것이다.
      assert(
        "★갱신 경로가 이 함수를 쓴다(정의만 있고 안 부르면 규칙이 없는 것)",
        /const next = withKindPrefix\(entry\.kind, cur\);/.test(src),
        /withKindPrefix\(entry\.kind/.test(src) ? "호출 있음" : "★인라인으로 되돌아갔다",
      ),
    ];
  },
};
