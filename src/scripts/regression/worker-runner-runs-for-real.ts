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
  getJobResultChannel,
  getRegisteredWorkerRunner,
  markDone,
  steerJob,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
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

    // ── ④ ★러너는 **레지스트리의 현재 채널**을 거둔다 (A1, 실재 결함이었다) ────────
    //  `steerJob` 은 채널이 닫혔어도 잡이 살아 있으면 갈아끼우고 `"delivered"` 를 준다.
    //  러너가 **자기 지역 변수**를 drain 하면 그 새 채널을 아무도 안 읽는다 — 지시가
    //  사라지는데 사용자에겐 "전달했어요" 가 뜨고 잔여 통지조차 안 나간다.
    //  형제 레인엔 어제 이 검사가 들어갔고, 이쪽은 오늘 적대 검토가 찾았다.
    __resetJobsForTest();
    {
      const jid = registerJob({ ...base, kind: "worker", label: "회전", threadKey: "dashboard:s1" });
      let rotated: ReturnType<typeof createSteeringChannel> | undefined;
      runWorkerJob(getJob(jid) as never, async (): Promise<RegionASdkOutput> => {
        getSteerChannel(jid)?.close(); // 어댑터가 턴 끝에 닫는 상황
        steerJob(jid, { text: "늦은 지시", raw: "늦은 지시", ts: 1 });
        rotated = getSteerChannel(jid);
        return { text: "ok" } as RegionASdkOutput;
      });
      await until(() => getJob(jid)?.status !== "running");
      out.push(
        assert("steerJob 이 닫힌 채널을 갈아끼웠다(전제 확인)", rotated !== undefined,
          rotated === undefined ? "★교체 없음" : "교체됨"),
        assert(
          "★러너가 **갈아끼운 채널**을 거둔다 — 지역 참조만 보면 지시가 조용히 사라진다",
          (rotated?.drain().length ?? 1) === 0,
          `${rotated?.drain().length ?? "?"}건 남음(0이어야)`,
        ),
      );
    }

    // ── ⑤ ★거두기 루프의 **입력**을 잰다 (B1·B2) ──────────────────────────────────
    //  적대 검토: `liveChildren: 0` 으로 고정해도, 결과 수신함을 **다른 채널**로 등록해도
    //  1,362건이 전부 초록이었다. 앞은 매니저가 자식이 도는데 턴을 닫게 하고(2026-08-19
    //  라이브 사고 재현), 뒤는 자식 결과가 고아 채널로 가 매니저가 상한까지 매달린다.
    //  둘 다 **조용하다**. 그래서 자식을 실제로 하나 띄워 루프가 도는지 본다.
    __resetJobsForTest();
    reinjected.length = 0;
    {
      const jid = registerJob({ ...base, kind: "worker", label: "거두기", threadKey: "dashboard:s1" });
      const child = registerJob({
        ...base, kind: "agent", label: "자식", threadKey: `worker:${jid}`, detached: true,
      });
      let turns = 0;
      const texts: string[] = [];
      const depths: Array<number | undefined> = [];
      runWorkerJob(getJob(jid) as never, async (input): Promise<RegionASdkOutput> => {
        turns += 1;
        texts.push(input.text);
        depths.push(input.workerDepth);
        // 첫 턴이 끝나는 시점에 자식이 아직 돈다 → 루프가 기다려야 한다.
        if (turns === 1) {
          setTimeout(() => {
            const box = getJobResultChannel(jid);
            markDone(child, "자식 결과");
            box?.push({ text: "자식 결과", raw: "[자식] 자식 결과", ts: 2, source: "job" });
          }, 30);
        }
        return { text: `턴${turns}` } as RegionASdkOutput;
      });
      await until(() => getJob(jid)?.status !== "running", 6000);
      out.push(
        assert(
          "★자식이 살아 있으면 매니저가 턴을 안 닫는다 — 거두기 루프가 실제로 한 바퀴 더 돈다",
          turns >= 2,
          `모델 호출 ${turns}회(2 이상이어야)`,
        ),
        assert(
          "★자식 결과가 **러너가 읽는 그 수신함**으로 들어온다 — 다른 채널이면 매니저가 상한까지 매달린다",
          texts.some((t) => t.includes("자식 결과")),
          texts.map((t) => t.slice(0, 20)).join(" | ") || "★안 실림",
        ),
        // ★손자 금지는 **이어받는 턴에도** 걸려야 한다 (적대 검토 B6). 종전엔 첫 호출
        //  입력만 봤고, 재주입 턴은 애초에 이음매 밖이라 검사가 닿지도 않았다. 여기서
        //  0이면 그 턴에 `run_in_background` 가 다시 열려 매니저가 매니저를 띄운다.
        assert(
          "★거두기 재주입 턴도 workerDepth=1 — 이어받는 턴에 팬아웃이 다시 열리면 안 된다",
          depths.length >= 2 && depths.every((d) => d === 1),
          `깊이=${depths.join(",")}`,
        ),
      );
    }

    // ── ⑥ ★배선: 데몬이 발사하는 러너가 **이 함수**다 (B3) ────────────────────────
    //  적대 검토: `registerWorkerRunner(runWorkerJob)` → `registerWorkerRunner(() => {})` 로
    //  바꿔도 초록이었다. 위 검사들이 `runWorkerJob` 을 **직접** 부르기 때문 — 판정은
    //  실행하는데 배선은 안 지키던 그 부류다. 등록된 러너를 꺼내 동일성을 본다.
    out.push(
      assert(
        "★데몬이 발사하는 워커 러너가 runWorkerJob 이다 — 아니면 run_in_background 가 아무것도 안 한다",
        getRegisteredWorkerRunner() === runWorkerJob,
        getRegisteredWorkerRunner() === runWorkerJob ? "동일" : "★다른 함수가 등록돼 있다",
      ),
    );

    __resetJobsForTest();
    return out;
  },
};
