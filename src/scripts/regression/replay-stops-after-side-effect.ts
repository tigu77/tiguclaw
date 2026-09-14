/**
 * 회귀: **부작용이 시작되면 다른 모델로 다시 돌리지 않는다** (2026-09-14)
 *
 * 잡는 결함(외부 검토 §2): 모델 후보 전환은 `runPool` 이 하는데 **도구 실행은 어댑터 안**
 * 에서 일어난다. 예외를 받은 풀은 «이미 부작용이 시작됐는지» 를 알 수 없어 그대로 다음
 * 후보로 넘겼고, **같은 요청을 처음부터 다시** 돌렸다 — 파일 쓰기·발송·외부 API 가 그
 * 사이에 있었으면 **두 번 실행**된다(되돌릴 수 없다).
 *
 * 지키는 계약(계획서 §2):
 *  - 표시는 **dispatch 직전**이다(성공 후가 아니다 — 효과를 내고 실패할 수 있다)
 *  - 실패·정리·후보 변경으로 **초기화하지 않는다**
 *  - 검증된 read-only 실패는 **폴백을 유지**한다
 *  - 실행 전 **거절**은 replay 를 막지 않는다
 *  - **다음 독립 턴**에는 상태가 넘어가지 않는다
 *  - 외부 MCP 는 이름이 `read_` 여도 안전하다고 **추정하지 않는다**
 *
 * 등급: **동작 검사** — 실제 `runRegionA` 를 두 후보 풀로 돌리고, 첫 후보 안에서 도구 효과를
 * 낸 뒤 던진다. 모델 호출은 주입된 가짜 어댑터가 대신한다(네트워크 0).
 */
import {
  canReplay,
  createReplayGuard,
  markToolDispatch,
  replayBlockedReason,
} from "../../core/llm-runtime/replay-safety.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "replay-stops-after-side-effect",
  guards:
    "도구가 이미 실행에 들어갔는데도 모델 후보를 바꿔 같은 요청을 재실행해 부작용이 두 번 일어나던 것 (2026-09-14 외부 검토)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ① 표시 규칙 — 순수 함수라 여기서 전수로 잰다.
    {
      const g = createReplayGuard();
      out.push(
        assert("처음엔 재실행 가능하다(도구를 안 썼으면 폴백은 안전하다)", canReplay(g), `${canReplay(g)}`),
      );
      markToolDispatch(g, "Read", true); // 검증된 read-only
      out.push(
        assert(
          "★검증된 read-only 는 **폴백을 유지**한다 — 읽기 실패까지 막으면 폴백이 죽는다",
          canReplay(g),
          `read-only 뒤 ${canReplay(g)}`,
        ),
      );
      markToolDispatch(g, "send_file", false);
      out.push(
        assert(
          "★★부작용 도구가 dispatch 되면 재실행이 막힌다",
          !canReplay(g) && g.firstTool === "send_file",
          `막힘=${!canReplay(g)} · 첫 도구=${g.firstTool ?? "(없음)"}`,
        ),
      );
      markToolDispatch(g, "Read", true);
      markToolDispatch(g, "other_write", false);
      out.push(
        assert(
          "★한 번 막히면 **되돌아오지 않는다** — 뒤에 무엇이 오든(정리·성공·read-only) 유지",
          !canReplay(g) && g.firstTool === "send_file",
          `막힘=${!canReplay(g)} · 첫 도구 보존=${g.firstTool === "send_file"}`,
        ),
        assert(
          "막힌 이유가 **무엇까지 갔는지**를 말한다(부분 실행을 사용자가 알 수 있어야 한다)",
          replayBlockedReason(g).includes("send_file"),
          replayBlockedReason(g).slice(0, 50),
        ),
      );
      // 다음 독립 턴 = 새 객체. 상태가 넘어가면 안 된다.
      out.push(
        assert(
          "★다음 독립 턴에는 상태가 넘어가지 않는다",
          canReplay(createReplayGuard()),
          `${canReplay(createReplayGuard())}`,
        ),
      );
    }

    // ② 실제 폴백 루프 — 첫 후보가 **효과를 낸 뒤** 던지면 두 번째 후보가 돌면 안 된다.
    {
      const { runRegionA, __setAdapterForTest } = await import(
        "../../core/llm-runtime/index.js"
      );
      const effects: string[] = [];
      const attempts: string[] = [];
      const chain = [
        [
          { adapter: "claude" as const, model: "regr-first" },
          { adapter: "claude" as const, model: "regr-second" },
        ],
      ];
      const run = async (kind: "side-effect" | "read-only" | "rejected"): Promise<string> => {
        effects.length = 0;
        attempts.length = 0;
        const restore = __setAdapterForTest(async (_a, i) => {
          attempts.push(i.model ?? "?");
          if (i.model === "regr-first") {
            if (kind !== "rejected") {
              // ★**dispatch 직전** 표시 — 어댑터가 실제로 하는 일과 같은 순서다.
              markToolDispatch(
                i.replay,
                kind === "read-only" ? "Read" : "send_file",
                kind === "read-only",
              );
              effects.push("실행");
            }
            throw new Error("첫 후보가 터졌다");
          }
          effects.push("실행");
          return { text: "둘째 후보 성공" };
        });
        try {
          const out2 = await runRegionA(
            {
              text: "부작용 뒤 폴백 시험",
              threadKey: `regr-replay-${kind}`,
              channel: "dashboard",
              internal: true,
            } as never,
            { chain } as never,
          );
          return out2.text;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        } finally {
          restore();
        }
      };

      const sideEffect = await run("side-effect");
      out.push(
        assert(
          "★★효과를 낸 뒤 던지면 **다음 후보가 안 돈다**(효과 1회 · 시도 1회)",
          attempts.length === 1 && effects.length === 1,
          `시도 [${attempts.join(",")}] · 효과 ${effects.length}회`,
        ),
        assert(
          "★그리고 실패 사유에 **부분 실행**이 실린다",
          sideEffect.includes("다시 돌릴 수 없습니다"),
          sideEffect.split("\n").slice(-1)[0]?.slice(0, 60) ?? "",
        ),
      );

      const readOnly = await run("read-only");
      out.push(
        assert(
          "★검증된 read-only 실패는 **폴백이 살아 있다**(둘째 후보가 돈다)",
          attempts.length === 2 && readOnly === "둘째 후보 성공",
          `시도 [${attempts.join(",")}] · 결과 ${readOnly.slice(0, 30)}`,
        ),
      );

      const rejected = await run("rejected");
      out.push(
        assert(
          "★실행 전 **거절**은 replay 를 막지 않는다 — 안 돈 도구까지 막으면 폴백을 공짜로 잃는다",
          attempts.length === 2 && rejected === "둘째 후보 성공",
          `시도 [${attempts.join(",")}] · 결과 ${rejected.slice(0, 30)}`,
        ),
      );
    }

    // ③ ★★**풀 간 경계** — 첫 판이 여기서 뚫렸다(외부 검토 P1, 2026-09-14).
    //  `runPool` 안에서 guard 를 만들면 **풀이 바뀔 때 새로 생겨** 다음 풀이 원 요청을
    //  다시 돌린다. 단일 풀 검사 10건은 전부 통과하는데 이 경계만 샌다 — 그래서 여기를
    //  따로 잰다(«한 풀에서 막혔다» 를 «폴백이 안전하다» 로 확대 해석하지 않는다).
    {
      const { runRegionA, __setAdapterForTest } = await import(
        "../../core/llm-runtime/index.js"
      );
      const effects: string[] = [];
      const attempts: string[] = [];
      // 풀 **둘** — chain[0] 실패 → chain[1] 로 넘어가는 프로파일 간 폴백 경로.
      const twoPools = [
        [{ adapter: "claude" as const, model: "pool0-a" }],
        [{ adapter: "claude" as const, model: "pool1-a" }],
      ];
      const restore = __setAdapterForTest(async (_a, i) => {
        attempts.push(i.model ?? "?");
        if (i.model === "pool0-a") {
          markToolDispatch(i.replay, "Write", false); // dispatch 직전 표시.
          effects.push("실행");
          // ★**풀 간 폴백이 실제로 트리거되는 에러**여야 한다 — 평범한 에러는 구조적 실패가
          //  아니라 다음 풀로 안 간다(첫 판이 그래서 **공허하게 초록**이었다. 변이가 잡았다).
          //  `model_not_found` = `MODEL_REJECTED_PATTERNS` 매칭 = 프로파일 간 폴백 조건.
          throw new Error("호출 실패: 404 model_not_found");
        }
        effects.push("실행"); // 여기가 돌면 부작용이 두 번이다.
        return { text: "둘째 풀 성공" };
      });
      let result: string;
      try {
        const o = await runRegionA(
          {
            text: "풀 간 경계 시험",
            threadKey: "regr-replay-pools",
            channel: "dashboard",
            internal: true,
          } as never,
          { chain: twoPools } as never,
        );
        result = o.text;
      } catch (e) {
        result = e instanceof Error ? e.message : String(e);
      } finally {
        restore();
      }
      out.push(
        assert(
          "★★부작용 뒤에는 **다음 풀로도 안 간다**(효과 1회 · 시도 1회)",
          attempts.length === 1 && effects.length === 1,
          `시도 [${attempts.join(",")}] · 효과 ${effects.length}회`,
        ),
        assert(
          "★★부분 실행 실패가 **다음 풀의 성공에 가려지지 않는다**",
          result.includes("다시 돌릴 수 없습니다") && !result.includes("둘째 풀 성공"),
          result.split("\n").slice(-1)[0]?.slice(0, 60) ?? "",
        ),
      );
    }

    // ④ 다음 **독립 턴**은 새 guard 로 정상 실행된다(상태가 안 남는다).
    {
      const { runRegionA, __setAdapterForTest } = await import(
        "../../core/llm-runtime/index.js"
      );
      const attempts: string[] = [];
      const restore = __setAdapterForTest(async (_a, i) => {
        attempts.push(i.model ?? "?");
        return { text: "정상" };
      });
      try {
        const o = await runRegionA(
          {
            text: "다음 독립 턴",
            threadKey: "regr-replay-next-turn",
            channel: "dashboard",
            internal: true,
          } as never,
          { chain: [[{ adapter: "claude" as const, model: "fresh" }]] } as never,
        );
        out.push(
          assert(
            "★다음 독립 턴은 **새 guard** 로 정상 실행된다 — 상태가 전역으로 새면 안 된다",
            o.text === "정상" && attempts.length === 1,
            `결과 ${o.text} · 시도 ${attempts.length}`,
          ),
        );
      } finally {
        restore();
      }
    }

    return out;
  },
};
