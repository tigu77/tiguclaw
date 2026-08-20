/**
 * 매니저(워커) 러너의 **실행 경로를 진짜로 돌린다** (2026-08-20)
 *
 * 잡는 회귀 — 재검토 F2, **위험도 4**:
 * `worker-registry.ts` 의 `await onWorkerComplete(job.jobId, outcome)` 를 **지워도 1,343건이
 * 전부 초록**이었다. 형제(`startDetachedAgent`)엔 어제 같은 구멍을 닫아놨는데, 이쪽은
 * 그대로였다 — **한 쪽만 고치고 옆 레인을 안 봤다**(오늘 반복하는 그 부류).
 *
 * 안 고치면: 매니저가 일을 다 끝내도 결과가 **아무에게도 안 간다**. 사용자 화면엔 잡이
 * 영원히 "진행 중" 이고(카드가 안 닫힌다), 그 매니저를 기다리던 소환자는 상한까지 붙잡힌다.
 * 그리고 **조용하다** — 에러가 없어서 신고될 기제가 없다.
 *
 * ★근본은 검사 기법이 아니라 **비대칭**이었다: 형제엔 주입 이음매가 있고 여기엔 없어서,
 *  여기만 "문자열이 있나" 로 지켜지고 있었다. 이음매를 대칭으로 내고 행동으로 지킨다.
 *
 * 등급: **동작 검사**. 모델 호출 0, 네트워크 0, 라이브 데몬 0.
 */
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  getJob,
  registerJob,
  registerWorkerHandler,
  getSteerChannel,
} from "../../core/worker-jobs.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/** settle 대기 — 상한이 있어 무한대기 0. */
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
};

export const check: RegressionCheck = {
  name: "worker-runner-runs-for-real",
  guards:
    "매니저 러너의 결과 전달(onWorkerComplete)을 통째로 지워도 스위트가 초록이던 것 — 형제(에이전트) 러너엔 그물이 있는데 이쪽만 없었다 (2026-08-20 재검토 F2)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const base = { channel: "dashboard" as const, channelUserId: "u", task: "일을 해라" };

    // 메인 재주입 핸들러를 가로챈다 — onWorkerComplete 가 실제로 불렸는지의 **관측점**.
    // (여기까지 와야 사용자에게 결과가 간다. 부르지 않으면 아무 일도 안 일어난다.)
    const reinjected: string[] = [];
    registerWorkerHandler((async (m: { text?: string }) => {
      reinjected.push(String(m.text ?? ""));
      return { text: "" };
    }) as never);

    // ── ① 정상 완료: 잡이 닫히고 **결과가 메인으로 재주입된다** ────────────────────
    __resetJobsForTest();
    {
      const jid = registerJob({ ...base, kind: "worker", label: "정산", threadKey: "dashboard:s1" });
      let seen: RegionASdkInput | undefined;
      runWorkerJob(getJob(jid) as never, async (input): Promise<RegionASdkOutput> => {
        seen = input;
        return { text: "매니저가 낸 값" } as RegionASdkOutput;
      });
      await until(() => getJob(jid)?.status !== "running");

      out.push(
        assert("잡이 done 으로 닫힌다 — 안 닫히면 카드가 영원히 진행 중", getJob(jid)?.status === "done",
          `${getJob(jid)?.status}`),
        assert("결과가 잡 레코드에 남는다", (getJob(jid)?.result ?? "").includes("매니저가 낸 값"),
          `${getJob(jid)?.result?.slice(0, 30) ?? "(없음)"}`),
        assert(
          "★결과가 **메인으로 재주입된다** — 이 한 줄이 사라지면 결과가 아무에게도 안 간다(조용히)",
          reinjected.some((t) => t.includes("매니저가 낸 값")),
          reinjected.join(" | ").slice(0, 60) || "★아무것도 안 옴",
        ),
        assert("매니저가 실제로 실행됐다(입력을 받았다)", seen !== undefined, seen ? "받음" : "★미실행"),
        assert("매니저 좌표가 worker:<jobId> 다", seen?.threadKey === `worker:${jid}`, `${seen?.threadKey}`),
        assert(
          "★매니저는 workerDepth=1 — 이 값이 없으면 매니저가 또 매니저를 띄운다(무한 팬아웃)",
          seen?.workerDepth === 1,
          `workerDepth=${String(seen?.workerDepth)}`,
        ),
      );
    }

    // ── ② 실패도 **반드시** 닫히고 전달된다(조용히 사라지지 않는다) ────────────────
    __resetJobsForTest();
    reinjected.length = 0;
    {
      const jid = registerJob({ ...base, kind: "worker", label: "터질것", threadKey: "dashboard:s1" });
      runWorkerJob(getJob(jid) as never, async (): Promise<RegionASdkOutput> => {
        throw new Error("모델이 터졌다");
      });
      await until(() => getJob(jid)?.status !== "running");
      out.push(
        assert("실패가 잡에 기록된다", getJob(jid)?.status === "failed", `${getJob(jid)?.status}`),
        assert(
          "★실패도 전달된다 — 안 그러면 사용자는 '진행 중' 만 보고 영원히 기다린다",
          reinjected.length > 0 || (getJob(jid)?.error ?? "").includes("모델이 터졌다"),
          `재주입 ${reinjected.length}건 · error=${getJob(jid)?.error?.slice(0, 30) ?? "(없음)"}`,
        ),
      );
    }

    // ── ③ 자원 해제 — 채널이 남으면 맵이 샌다(형제 러너의 F3 과 같은 축) ────────────
    __resetJobsForTest();
    {
      const jid = registerJob({ ...base, kind: "worker", label: "해제", threadKey: "dashboard:s1" });
      runWorkerJob(getJob(jid) as never, async (): Promise<RegionASdkOutput> =>
        ({ text: "ok" }) as RegionASdkOutput);
      await until(() => getJob(jid)?.status !== "running");
      out.push(
        assert(
          "끝나면 스티어 채널이 레지스트리에서 해제된다(누수 0)",
          getSteerChannel(jid) === undefined,
          getSteerChannel(jid) === undefined ? "해제됨" : "★남아 있음",
        ),
      );
    }

    __resetJobsForTest();
    return out;
  },
};
