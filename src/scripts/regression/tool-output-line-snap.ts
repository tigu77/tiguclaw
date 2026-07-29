/**
 * 회귀: **도구 출력 절단을 줄 경계에서 한다** (2026-07-29, 사용자 제안).
 *
 * 히스토리에 넣는 도구 출력은 머리+꼬리만 남기고 중략한다. 종전엔 **글자 수로만** 잘라서
 * JSON·로그가 줄 한복판에서 끊겼다(`…"key": "va`). 모델은 그 조각을 온전한 값으로 오해할
 * 수 있고, 사람이 읽기도 나쁘다. 줄 단위로 끊으면 조각이 항상 의미 단위가 된다.
 *
 * 단 **될 만할 때만** — 미니파이 JSON처럼 한 줄이 통째로 거대하면 스냅할 자리가 없다.
 * 그때 억지로 당기면 내용을 과하게 버리므로, 허용오차를 넘으면 종전대로 글자 수로 자른다.
 * (이모지 깨짐 방지는 기존 surrogate 처리가 계속 담당.)
 */
import { capToolOutputForEntry } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const OPTS = { cap: 1000, headChars: 500, tailChars: 500 };
const split = (s: string) => {
  const head = s.split("\n…[중략")[0] ?? "";
  const tail = s.split("]…\n")[1] ?? "";
  return { head, tail };
};

export const check: RegressionCheck = {
  name: "tool-output-line-snap",
  guards: "도구 출력이 줄 한복판에서 끊겨 모델이 조각을 오해하던 것",
  run: async (): Promise<Assertion[]> => {
    const lines = Array.from({ length: 3000 }, (_, i) => `[line ${i}] 판독 결과 항목 ${i}`).join("\n");
    const { head, tail } = split(capToolOutputForEntry(lines, OPTS));
    // 개행이 전혀 없는 입력 — 스냅 포기하고 종전 동작(글자 수) 유지.
    const flat = split(capToolOutputForEntry("x".repeat(50_000), OPTS));
    // 캡 이하는 손대지 않는다.
    const small = capToolOutputForEntry("짧은 출력", OPTS);
    return [
      assert(
        "★head 가 줄 중간에서 끊기지 않는다",
        head.length > 0 && !head.endsWith(" ") && /항목 \d+$/.test(head.trimEnd()),
        JSON.stringify(head.slice(-30)),
      ),
      assert(
        "★tail 이 줄 처음부터 시작한다",
        tail.startsWith("[line "),
        JSON.stringify(tail.slice(0, 30)),
      ),
      assert(
        "스냅해도 예산을 넘지 않는다(더 담지 않는다)",
        head.length <= OPTS.headChars && tail.length <= OPTS.tailChars,
        `head=${head.length} tail=${tail.length}`,
      ),
      assert(
        "개행 없는 거대 입력은 스냅을 포기한다(내용 과다 손실 방지)",
        flat.head.length === OPTS.headChars,
        `head=${flat.head.length}`,
      ),
      assert("캡 이하는 원본 그대로", small === "짧은 출력", small),
    ];
  },
};
