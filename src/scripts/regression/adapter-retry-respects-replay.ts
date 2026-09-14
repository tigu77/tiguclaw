/**
 * 회귀: **어댑터 내부 재시작도 replay 금지를 본다** (2026-09-14)
 *
 * 잡는 결함(외부 검토 P1): 풀·후보 전환은 막았는데 **어댑터 안의 재시작 둘**이 안 보고 있었다.
 *  - claude: resume 실패 → **fresh 세션으로 원 요청 재실행**
 *  - openai: tools-unsupported → **no-tools 로 원 요청 재실행**
 * 둘 다 «원 요청을 처음부터 다시» 라 풀 전환과 위험이 같다. 실측: Write dispatch 표시 뒤에도
 * fresh 1회 · runOnce 2회가 돌았다. 두 번째가 성공하면 **앞의 부분 실행 실패가 새 성공 응답에
 * 가려진다**(조용한 오답).
 *
 * ★**조건식을 소스에서 떼어 실제로 돌린다.** SDK 전체 세션을 띄우지 않고도 «그 분기가 무엇을
 *  보고 갈라지나» 는 정확히 잴 수 있다 — 정규식으로 `canReplay` 존재만 보면 이름만 바꿔도
 *  통과한다([[feedback_gate_must_actually_run]]).
 * ★**SDK 실제 오류 타이밍은 재현하지 않았다** — 이 검사는 분기 판정을 재는 것이고, 그 사실을
 *  헤더에 적어 «어댑터 전체가 검증됐다» 로 읽히지 않게 한다.
 *
 * 등급: **분기 판정 실행**(소스에서 조건을 떼어 평가). SDK 세션·네트워크 0.
 */
import { readFileSync } from "node:fs";
import { canReplay, createReplayGuard, markToolDispatch } from "../../core/llm-runtime/replay-safety.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const src = (rel: string): string =>
  readFileSync(new URL(`../../core/llm-runtime/adapters/${rel}`, import.meta.url), "utf8");

/** 앵커를 **포함하는** `if (…)` 의 조건식을 괄호 균형으로 떼어낸다. */
const conditionContaining = (text: string, anchor: string): string => {
  const at = text.indexOf(anchor);
  if (at < 0) return "";
  const ifAt = text.lastIndexOf("if (", at); // 앵커 **앞**의 가장 가까운 if.
  if (ifAt < 0) return "";
  const open = text.indexOf("(", ifAt);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        const cond = text.slice(open + 1, i);
        return cond.includes(anchor) ? cond : "";
      }
    }
  }
  return "";
};

export const check: RegressionCheck = {
  name: "adapter-retry-respects-replay",
  guards:
    "어댑터 내부 재시작(claude resume→fresh · openai tools-unsupported→no-tools)이 replay 금지를 안 봐서, 부작용이 시작된 뒤에도 원 요청을 다시 실행하던 것 (2026-09-14 외부 검토 P1)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    /** 부작용 **전**(비어 있는 guard)과 **후**(Write 표시) 두 상태. */
    const before = createReplayGuard();
    const after = createReplayGuard();
    markToolDispatch(after, "Write", false);

    // ── claude: resume 실패 → fresh ────────────────────────────────────────────
    {
      const use = conditionContaining(src("claude-agent-sdk.ts"), "!resumeRetried &&");
      out.push(
        assert(
          "★claude 의 fresh 재시작 조건을 떼어낼 수 있다(없으면 아래는 공짜 초록)",
          use !== "",
          use === "" ? "★못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라" : `${use.length}자`,
        ),
      );
      if (use !== "") {
        const fn = new Function(
          "resumeRetried", "resumable", "isResumeProcessFailure", "e", "effectiveAc", "input", "canReplay",
          `return (${use});`,
        ) as (...a: unknown[]) => boolean;
        const run = (guard: unknown): boolean =>
          fn(false, true, () => true, new Error("process exited with code 1"),
             { signal: { aborted: false } }, { replay: guard }, canReplay);
        out.push(
          assert(
            "★부작용 **전** resume 실패는 fresh 로 복구한다(안전한 회복을 잃지 않는다)",
            run(before),
            `복구=${run(before)}`,
          ),
          assert(
            "★★Write 표시 **뒤**에는 fresh 를 시작하지 않는다 — 원 요청 재실행이라 도구가 두 번 돈다",
            !run(after),
            `재시작=${run(after)}`,
          ),
        );
      }
    }

    // ── openai: tools-unsupported → no-tools ───────────────────────────────────
    {
      const use = conditionContaining(src("openai-agents-sdk.ts"), "isToolsUnsupported(e) &&");
      out.push(
        assert(
          "★openai 의 no-tools 재시작 조건을 떼어낼 수 있다(없으면 아래는 공짜 초록)",
          use !== "",
          use === "" ? "★못 찾음" : `${use.length}자`,
        ),
      );
      if (use !== "") {
        const fn = new Function(
          "isToolsUnsupported", "e", "toolsNone", "mcpServers", "effectiveAc", "input", "canReplay",
          `return (${use});`,
        ) as (...a: unknown[]) => boolean;
        const run = (guard: unknown): boolean =>
          fn(() => true, new Error("tools unsupported"), false, [{}],
             { signal: { aborted: false } }, { replay: guard }, canReplay);
        out.push(
          assert(
            "★부작용 **전** tools-unsupported 는 no-tools 로 복구한다",
            run(before),
            `복구=${run(before)}`,
          ),
          assert(
            "★★Write 표시 **뒤**에는 no-tools 재시작을 하지 않는다",
            !run(after),
            `재시작=${run(after)}`,
          ),
        );
      }
    }

    // ── codex 는 **같은 부류가 아니다** — 그 사실을 고정한다 ─────────────────────
    //  백엔드 5xx 재시도는 «같은 누적 body 재전송» 이라 이미 실행된 도구 출력이 히스토리에
    //  남아 있다(원 요청을 버리고 처음부터 다시가 아니다). 여기를 막으면 정당한 복구가 죽는다.
    {
      const codex = src("openai-codex-oauth.ts");
      out.push(
        assert(
          "★codex 백엔드 재시도는 **같은 body 재전송**이라 이 부류가 아니다(막으면 정당한 복구를 잃는다)",
          /continue; \/\/ 같은 body 로 재전송/.test(codex),
          `같은 body 재전송=${/같은 body 로 재전송/.test(codex)}`,
        ),
      );
    }
    return out;
  },
};
