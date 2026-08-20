/**
 * 백그라운드 서브에이전트의 **실행 경로를 진짜로 돌린다** (2026-08-20)
 *
 * 잡는 회귀 — 전체 검토(면적 A) F1, **위험도 5**:
 * `startDetachedAgent` 안의 `onWorkerComplete` 호출을 **지워도 1,299건이 전부 초록**이었다.
 * 그러면 백그라운드 서브의 결과가 아무에게도 안 가고, `markDone/markFailed` 가 그 안이라
 * 잡은 **영원히 running** 으로 굳으며(카드도 영구 진행 중), 매니저는 그 자식을 2시간
 * 상한까지 거둔다 — 오늘의 헤드라인 기능이 통째로, 조용히, 전 사용자에게 죽는다.
 *
 * ★근본: 기존 회귀가 `onWorkerComplete` 를 **직접** 부르고, 실행 경로는
 *  `/startDetachedAgent\(\{/` 라는 **문자열 존재**만 봤다. "판정은 실행하는데 배선은
 *  안 지킨다" 를 오늘 세 번째로 반복한 자리다. 그래서 여기서는 **모델 호출만** 갈아끼우고
 *  나머지(입력 조립·잡 마킹·결과 전달·자원 해제)는 전부 진짜로 돌린다.
 *
 * 곁들여 F3(**손자 금지**, 위험도 4)도 여기서 닫는다 — `subagentDepth: 1 → 0` 으로
 * 스위트가 초록이었다. 그러면 서브 턴에 `spawn_agent` 이 다시 등록되고(세 어댑터가
 * `depth === 0` 게이트), `buildAgentChildInput` 은 `workerDepth` 를 안 실으므로
 * `run_in_background` 까지 열려 **무한 팬아웃**이 된다. CLAUDE.md 의 하드룰인데 그물이 0이었다.
 *
 * 등급: **동작 검사**. 모델 호출 0, 네트워크 0, 라이브 데몬 0(러너가 임시 홈을 잡는다).
 */
import { startDetachedAgent } from "../../core/llm-runtime/capabilities/agent-registry.js";
import {
  __resetJobsForTest,
  createJobAbort,
  getJob,
  getSteerChannel,
  registerJob,
  setJobResultChannel,
  steerJob,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/** detached 실행이 settle 할 때까지 — 폴링이지만 상한이 있어 무한대기 0. */
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
};

const AGENT = { name: "probe", description: "d", filePath: "/x/probe.md", source: "user" } as const;

export const check: RegressionCheck = {
  name: "detached-agent-runs-for-real",
  guards:
    "startDetachedAgent 의 결과 전달(onWorkerComplete)을 통째로 지워도 스위트가 초록이던 것 + 손자 금지(subagentDepth)를 아무도 안 보던 것 (2026-08-20 전체 검토 A-F1·F3)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const base = { channel: "dashboard" as const, channelUserId: "u", task: "t" };

    // ── ① 정상 완료: 결과가 **소환자에게** 도달하고 잡이 닫힌다 ──────────────────
    __resetJobsForTest();
    const mgr = registerJob({ ...base, kind: "worker", label: "mgr", threadKey: "dashboard:s1" });
    const box = createSteeringChannel();
    setJobResultChannel(mgr, box);
    const child = registerJob({
      ...base, kind: "agent", label: "probe", threadKey: `worker:${mgr}`, detached: true,
    });
    const abort = createJobAbort(child, {});
    let seen: RegionASdkInput | undefined;
    startDetachedAgent({
      jobId: child,
      agent: AGENT as never,
      def: "정의",
      prompt: "해라",
      targetCwd: "/tmp",
      parentInput: { text: "", threadKey: `worker:${mgr}`, channel: "dashboard" } as RegionASdkInput,
      abort,
      __runForTest: async (input): Promise<RegionASdkOutput> => {
        seen = input;
        return { text: "자식이 낸 값" } as RegionASdkOutput;
      },
    });
    await until(() => getJob(child)?.status !== "running");

    out.push(
      assert(
        "★결과 전달이 실제로 일어난다 — 잡이 done 으로 닫힌다",
        getJob(child)?.status === "done",
        `${getJob(child)?.status}`,
      ),
      assert(
        "★결과가 소환자(매니저)의 수신함에 도착한다 — 이게 없으면 아무도 못 받는다",
        box.drain().some((m) => m.raw.includes("자식이 낸 값")),
        `${getJob(child)?.result?.slice(0, 30) ?? "(없음)"}`,
      ),
      assert("잡 레코드에 결과가 남는다", (getJob(child)?.result ?? "").includes("자식이 낸 값"),
        `${getJob(child)?.result?.slice(0, 30) ?? "(없음)"}`),
    );

    // ── ② 자식 turn 입력이 옳게 조립되는가 — **손자 금지 포함** ──────────────────
    out.push(
      assert("자식이 실제로 실행됐다(입력을 받았다)", seen !== undefined, seen ? "받음" : "★미실행"),
      assert(
        "★손자 금지: subagentDepth=1 — 이 값이 0이면 서브가 다시 spawn/run_in_background 를 연다",
        seen?.subagentDepth === 1,
        `subagentDepth=${String(seen?.subagentDepth)}`,
      ),
      assert(
        "자식 좌표가 agent:<jobId> 다(활동이 그 카드로 귀속된다)",
        seen?.threadKey === `agent:${child}`,
        `${seen?.threadKey}`,
      ),
      assert(
        "프롬프트에 에이전트 정의와 지시가 함께 실린다",
        (seen?.text ?? "").includes("정의") && (seen?.text ?? "").includes("해라"),
        (seen?.text ?? "").slice(0, 40),
      ),
      assert(
        "돌고 있는 서브에 지시를 얹을 수 있다(steering 채널 주입)",
        seen?.steering !== undefined,
        seen?.steering === undefined ? "★없음" : "있음",
      ),
    );

    // ── ③ 실패해도 **반드시** 소환자에게 간다(조용히 사라지지 않는다) ─────────────
    __resetJobsForTest();
    const mgr2 = registerJob({ ...base, kind: "worker", label: "mgr2", threadKey: "dashboard:s1" });
    const box2 = createSteeringChannel();
    setJobResultChannel(mgr2, box2);
    const child2 = registerJob({
      ...base, kind: "agent", label: "probe2", threadKey: `worker:${mgr2}`, detached: true,
    });
    startDetachedAgent({
      jobId: child2,
      agent: AGENT as never,
      def: "d",
      prompt: "p",
      targetCwd: "/tmp",
      parentInput: { text: "", threadKey: `worker:${mgr2}`, channel: "dashboard" } as RegionASdkInput,
      abort: createJobAbort(child2, {}),
      __runForTest: async (): Promise<RegionASdkOutput> => {
        throw new Error("모델이 터졌다");
      },
    });
    await until(() => getJob(child2)?.status !== "running");
    const failMsgs = box2.drain().map((m) => m.raw);
    out.push(
      assert("실패도 잡에 기록된다", getJob(child2)?.status === "failed", `${getJob(child2)?.status}`),
      assert(
        "★실패도 소환자에게 전달된다 — 안 그러면 매니저가 상한까지 기다린다",
        failMsgs.some((t) => t.includes("모델이 터졌다")),
        failMsgs.join(" | ").slice(0, 60) || "★아무것도 안 옴",
      ),
      assert(
        "실패는 '완료' 라고 하지 않는다",
        !failMsgs.some((t) => t.includes("완료]")),
        failMsgs.join(" | ").slice(0, 60),
      ),
    );

    // ── ④ ★러너는 **레지스트리의 현재 채널**을 거둔다 (A-F5, 실재 결함이었다) ─────
    //  `steerJob` 은 채널이 닫혔어도 잡이 살아 있으면 갈아끼우고 `"delivered"` 를 준다.
    //  그런데 러너가 **자기 지역 변수**를 drain 하면 그 새 채널을 아무도 안 읽는다 —
    //  지시가 사라지는데 사용자에겐 "전달했어요" 가 뜨고 잔여 통지조차 안 나간다.
    __resetJobsForTest();
    {
      const m3 = registerJob({ ...base, kind: "worker", label: "mgr3", threadKey: "dashboard:s1" });
      setJobResultChannel(m3, createSteeringChannel());
      const c3 = registerJob({
        ...base, kind: "agent", label: "probe3", threadKey: `worker:${m3}`, detached: true,
      });
      let rotated: ReturnType<typeof createSteeringChannel> | undefined;
      startDetachedAgent({
        jobId: c3,
        agent: AGENT as never,
        def: "d",
        prompt: "p",
        targetCwd: "/tmp",
        parentInput: { text: "", threadKey: `worker:${m3}`, channel: "dashboard" } as RegionASdkInput,
        abort: createJobAbort(c3, {}),
        __runForTest: async (): Promise<RegionASdkOutput> => {
          // 어댑터가 턴 끝에 닫는 상황을 재현 → steerJob 이 갈아끼운다.
          getSteerChannel(c3)?.close();
          steerJob(c3, { text: "늦은 지시", raw: "늦은 지시", ts: 1 });
          rotated = getSteerChannel(c3);
          return { text: "ok" } as RegionASdkOutput;
        },
      });
      await until(() => getJob(c3)?.status !== "running");
      out.push(
        assert(
          "steerJob 이 닫힌 채널을 갈아끼웠다(전제 확인)",
          rotated !== undefined,
          rotated === undefined ? "★교체 없음" : "교체됨",
        ),
        assert(
          "★러너가 **갈아끼운 채널**을 거둔다 — 지역 참조만 보면 지시가 조용히 사라진다",
          (rotated?.drain().length ?? 1) === 0,
          `${rotated?.drain().length ?? "?"}건 남음(0이어야)`,
        ),
        assert(
          "끝나면 레지스트리에서 채널이 해제된다(누수 0)",
          getSteerChannel(c3) === undefined,
          getSteerChannel(c3) === undefined ? "해제됨" : "★남아 있음",
        ),
      );
    }

    __resetJobsForTest();
    return out;
  },
};
