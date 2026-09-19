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

    // ── ★**«resume 이 못 쓰는 상태» 를 알아보는가** (2026-09-19, 집 Windows 실사고) ──
    //  ★★종전 술어는 `process exited with code 1` **한 문장**에 묶여 있었다. 세션 jsonl 이
    //   없어지면 SDK 는 **다른 문장**을 낸다(`No conversation found with session ID: …`).
    //   못 알아보면 복구가 안 돌고 원본 오류가 그대로 나가며, 그 스레드는 매 턴 같은
    //   resume 을 재생하므로 **영구 실패**가 된다 — 사용자는 대화를 통째로 잃는다.
    //  ★그래서 «이 문장» 이 아니라 **부류**로 재고, **반대 방향도** 같이 잰다 — 넓히다
    //   엉뚱한 실패까지 원 요청 재실행으로 보내면 그게 더 나쁘다.
    {
      const body = conditionContaining(
        src("claude-agent-sdk.ts"),
        "const isResumeProcessFailure = (e: unknown): boolean =>",
      );
      const pred = (msg: string): boolean => {
        const m = /e instanceof Error &&([\s\S]*?);\n/.exec(
          src("claude-agent-sdk.ts").slice(
            src("claude-agent-sdk.ts").indexOf("const isResumeProcessFailure"),
          ),
        );
        if (m === null) return false;
        const fn = new Function("e", `return e instanceof Error &&(${m[1] ?? "false"});`) as (
          e: unknown,
        ) => boolean;
        return fn(new Error(msg));
      };
      void body;
      const hit = [
        "claude-agent-sdk error: process exited with code 1",
        "claude-agent-sdk error: No conversation found with session ID: ef272662-7851-4859",
      ];
      const miss = [
        "API Error: 429 rate_limit_error",
        "claude-agent-sdk error: server_is_overloaded",
        "AbortError: The operation was aborted",
      ];
      out.push(
        assert(
          "★★세션이 사라진 실패를 **알아본다** — 못 알아보면 그 스레드는 영구 실패한다",
          hit.every((m) => pred(m)),
          hit.map((m) => `${m.slice(0, 44)}→${String(pred(m))}`).join(" · "),
        ),
      );
      out.push(
        assert(
          "★반대 방향 — 과부하·한도·취소는 **fresh 재시작으로 보내지 않는다**(원 요청 재실행이다)",
          miss.every((m) => !pred(m)),
          miss.map((m) => `${m.slice(0, 32)}→${String(pred(m))}`).join(" · "),
        ),
      );
    }

    // ── ★★**fresh 재시도가 «이어간다» 인가, «빈 채로 다시» 인가** (2026-09-19 정태님) ──
    //  ★원칙: **우리 기록이 정본이고 어댑터 세션은 캐시다.** 캐시가 죽으면 정본으로 다시
    //   세우면 된다 — 어댑터 내부에서 무슨 일이 나든 우리는 우리대로 이어갈 수 있다.
    //  ★★종전 구현은 `resume` 만 떼고 **같은 프롬프트**를 다시 썼다. 그 프롬프트는 «resume 이
    //   옛 턴을 재생한다» 는 전제로 만들어져 **기록 주입이 0** 이라, 모델이 **처음 보는
    //   사람처럼** 답한다. 「이어졌다」가 아니었다.
    //  ★등급: **소스 검사**다(배선을 실행하지 않는다 — 실제 SDK 호출이 필요하다).
    //   지우거나 이름을 바꾸면 잡지만, 재조립이 «맞는 내용» 인지는 못 본다. 그 한계를 적어 둔다.
    {
      const whole = src("claude-agent-sdk.ts");
      const at = whole.indexOf("delete (freshOptions as");
      // ★★**창을 그 분기까지로 끊는다.** 처음엔 앵커에서 1,200자를 잘랐는데 그 창이
      //  **아래 이미지 오염 경로의 `invalidateResume` 까지 닿아서**, 이 분기에서 그 호출을
      //  지워도 검사가 통과했다(변이가 살아남아 드러났다) — 남의 코드를 세고 있었다.
      const end = at < 0 ? -1 : whole.indexOf("continue; // resume 없이", at);
      const tail = at < 0 || end < 0 ? "" : whole.slice(at, end);
      out.push(
        assert(
          "★fresh 재시도 블록을 찾을 수 있다(없으면 아래는 공짜 초록)",
          at >= 0,
          at < 0 ? "★못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라" : `위치 ${String(at)}`,
        ),
      );
      out.push(
        assert(
          "★★fresh 로 갈 때 **기록을 다시 싣는다** — 안 실으면 이어간 게 아니라 빈 채로 다시 시작이다",
          /rebuildPromptWithFullHistory\(\)/.test(tail),
          `재조립 호출=${String(/rebuildPromptWithFullHistory\(\)/.test(tail))}`,
        ),
      );
      out.push(
        assert(
          "★**죽은 resume id 도 버린다** — 안 버리면 다음 턴이 같은 것을 또 시도한다",
          /invalidateResume\(/.test(tail),
          `무효화 호출=${String(/invalidateResume\(/.test(tail))}`,
        ),
      );
      out.push(
        assert(
          "★재조립이 **스레드 전체**를 싣는다(claude 자기 턴을 비워 전체가 prepend 된다)",
          /computeForeignDelta\(threadTurnsForRebuild, \[\]\)/.test(whole),
          `전체 prepend=${String(/computeForeignDelta\(threadTurnsForRebuild, \[\]\)/.test(whole))}`,
        ),
      );
    }

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
