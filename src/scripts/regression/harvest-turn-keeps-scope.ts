/**
 * 회귀: **거두기 턴은 «원래 맡은 일» 을 다시 싣는다 — 권한은 그대로 둔 채** (2026-09-01).
 *
 * ★라이브 사고(`worker:4bb5d813`, 정태님이 준 데몬 로그로 확정). 매니저가 14:27:51 에
 *  *"최종 판정: 마감 완료"* 를 쓴 뒤, **거두기 턴 하나 안에서 새 서브에이전트 일곱을
 *  순차로 띄우며 86분을 더 돌았다.** 늦게 온 감사 의견(«provider identity 를 더 엄격하게»)을
 *  **원래 요청의 완료조건이 아니라 «해야 할 새 일» 로 읽은 것**이다.
 *
 * ★**고칠 자리는 권한이 아니라 맥락이다** (정태님 확정). 한때 이 턴의 도구를 0으로 막았다가
 *  되돌렸다 — 그러면 진짜 차단 결함(필수 회귀 실패 등)도 못 고쳐 «작업 전체를 매니저가
 *  소유한다» 가 깨진다. 서브에이전트 결과는 **새 지시가 아니라 참고 증거**이고, 그 판단은
 *  매니저가 한다. 시스템은 판단을 대신하지 않고 **판단 기준을 눈앞에 둔다.**
 *
 * ★그래서 이 검사가 지키는 것은 둘이다:
 *  ① 거두기 입력에 **원래 과제(`job.task`)가 실린다** — 이게 장치의 전부다. 거두기 턴은
 *    원 요청에서 멀고(도구 수십 회 뒤) codex 는 히스토리를 압축하므로, 안 실으면 판단
 *    기준이 맥락에서 흐려진다.
 *  ② 거두기 턴이 **매니저 권한을 그대로 갖는다** — 다시 조이면 «매니저가 소유한다» 가
 *    깨진다. 되돌린 결정이므로 못을 박아 둔다.
 *
 * 등급: **동작** — 레지스트리를 실제로 돌려 거두기 입력을 받아낸다. 모델 호출 0.
 */
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  getJob,
  registerJob,
  registerWorkerHandler,
  getJobResultChannel,
  markDone,
} from "../../core/worker-jobs.js";
import { reaches, turnKindOf } from "../../core/llm-runtime/capability-reach.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/** 원 과제에만 있는 낱말 — 거두기 입력에서 이걸 찾아 «실렸나» 를 잰다. */
const TASK = "VOXEL-Q6-5B-원과제표식";

export const check: RegressionCheck = {
  name: "harvest-turn-keeps-scope",
  guards:
    "매니저가 자식 결과를 거두는 턴에서 늦게 온 감사 의견을 «원래 요청의 완료조건» 이 아니라 «새 지시» 로 읽어, 마감 보고 뒤 86분간 새 자식 7개를 띄우며 범위를 다시 열던 것(라이브 worker:4bb5d813) — 거두기 턴은 원 요청에서 멀고 히스토리가 압축돼 판단 기준이 흐려진다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    registerWorkerHandler((async () => ({ text: "" })) as never);

    const base = { channel: "cli" as const, channelUserId: "u", task: TASK };
    const jid = registerJob({ ...base, kind: "worker", label: "범위보존", threadKey: "cli:s1" });
    const child = registerJob({
      ...base, kind: "agent", label: "감사자", threadKey: `worker:${jid}`, detached: true,
    });

    let turns = 0;
    let harvest: RegionASdkInput | undefined;
    runWorkerJob(getJob(jid) as never, async (input): Promise<RegionASdkOutput> => {
      turns += 1;
      if (turns === 1) {
        setTimeout(() => {
          markDone(child, "늦은 감사 의견");
          getJobResultChannel(jid)?.push({
            text: "늦은 감사 의견", raw: "[감사자] identity 를 더 엄격히 하면 좋겠습니다", ts: 2, source: "job",
          });
        }, 20);
        return { text: "마감 완료" } as RegionASdkOutput;
      }
      harvest = input;
      return { text: "최종 보고" } as RegionASdkOutput;
    });

    const end = Date.now() + 6000;
    while (Date.now() < end && getJob(jid)?.status === "running") {
      await new Promise((r) => setTimeout(r, 10));
    }

    const text = harvest?.text ?? "";
    const managerTurn = turnKindOf({ workerDepth: harvest?.workerDepth });

    const out: Assertion[] = [
      assert(
        "★거두기 턴이 실제로 돌았다(0이면 아래는 미검사다)",
        harvest !== undefined && turns >= 2,
        `모델 호출 ${turns}회`,
      ),
      assert(
        "★★거두기 입력에 **원래 맡은 일**이 실린다 — 이게 범위 보존 장치의 전부다. 없으면 매니저는 늦게 온 의견을 무엇과 대조해야 하는지 알 길이 없다",
        text.includes(TASK),
        text.includes(TASK) ? "원 과제 실림" : `★안 실림 — 앞머리="${text.slice(0, 60)}"`,
      ),
      assert(
        "★자식 결과도 같이 실린다(원 과제만 싣고 결과를 빠뜨리면 거둘 게 없다)",
        text.includes("identity 를 더 엄격히"),
        text.includes("identity 를 더 엄격히") ? "결과 실림" : "★결과가 빠졌다",
      ),
      // ★되돌린 결정을 못 박는다 — 한때 여기 `toolPolicy:{mode:"none"}` 을 걸었다가 뺐다.
      //  다시 조이면 매니저가 진짜 차단 결함도 못 고쳐 «작업 전체 소유» 가 깨진다.
      assert(
        "★★거두기 턴은 **매니저 권한 그대로** — 도구를 다시 막으면 늦게 발견된 진짜 차단 결함(필수 회귀 실패 등)을 매니저가 못 고친다",
        harvest?.toolPolicy === undefined,
        harvest?.toolPolicy === undefined
          ? "제약 없음(의도)"
          : `★조여 있다: ${JSON.stringify(harvest?.toolPolicy)}`,
      ),
      assert(
        "★거두기 턴도 매니저다 — 그래서 위임 권한을 갖는다(그 권한이 곧 «작업 전체 소유» 다)",
        managerTurn === "manager" && reaches("agents", managerTurn),
        `turnKind=${managerTurn} · agents 도달=${String(reaches("agents", managerTurn))}`,
      ),
    ];

    __resetJobsForTest();
    return out;
  },
};
