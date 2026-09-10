/**
 * 회귀: **완료 잡이 런타임 메모리에서도 바운드된다** (2026-09-10, 외부 검토가 지목).
 *
 * 사고: `worker-jobs.ts` 의 `TERMINAL_WORKER_JOB_KEEP` 캡은 **DB 미러에만** 걸려 있었고
 * 런타임 `jobs` Map 은 무바운드였다 — `jobs.delete` 호출 **0건**, `jobs.clear` 는 테스트 전용.
 * 상주 데몬에서 완료 잡이 프로세스 수명 내내 쌓인다.
 *
 * ★그리고 무바운드인 쪽이 하필 **무거운 쪽**이었다: DB 테이블엔 `result`·`task` 컬럼이
 *  아예 없다(`store/worker-jobs.ts`: *"result/error 본문·풀 재개는 비범위"*). 매니저 출력
 *  전문이 이 Map 에만 산다.
 *
 * ★삭제가 아니라 **바운드**다 — running 은 절대 안 자르고(진행 중 상태가 사라지면 취소·
 *  합류·통지가 전부 깨진다), 오래 끝난 것부터 버리며, 메타데이터는 DB 에 남는다.
 *
 * ★소스 grep 이 아니라 **실제로 잡을 등록하고 끝내서** 캡이 도는지 본다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "terminal-jobs-are-bounded",
  guards:
    "완료 잡이 런타임 Map 에서 영원히 안 지워지던 것(jobs.delete 0건) — DB 캡만 있고 " +
    "정작 result/task 전문을 들고 있는 Map 은 무바운드였다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const m = await import("../../core/worker-jobs.js");
    const {
      registerJob,
      markDone,
      TERMINAL_WORKER_JOB_KEEP,
      __jobsMapSizeForTest,
      __resetJobsForTest,
    } = m as unknown as {
      registerJob: (i: Record<string, unknown>) => string;
      markDone: (id: string, r: string) => void;
      TERMINAL_WORKER_JOB_KEEP: number;
      __jobsMapSizeForTest: () => number;
      __resetJobsForTest: () => void;
    };

    __resetJobsForTest();
    const mk = (label: string): string =>
      registerJob({
        label,
        task: "t",
        threadKey: "regr-bound",
        channel: "cli",
        channelUserId: "u",
        kind: "agent",
      });

    // 진행 중으로 남길 잡 셋 — 절대 안 잘려야 한다.
    const alive = [mk("살아있음1"), mk("살아있음2"), mk("살아있음3")];

    // 캡을 넘기도록 완료 잡을 만든다.
    const over = TERMINAL_WORKER_JOB_KEEP + 25;
    const doneIds: string[] = [];
    const realLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]): void => {
      logs.push(a.map(String).join(" "));
    };
    try {
      for (let i = 0; i < over; i += 1) {
        const id = mk(`끝남${i}`);
        doneIds.push(id);
        markDone(id, `결과 ${i}`);
      }
    } finally {
      console.log = realLog;
    }

    const size = __jobsMapSizeForTest();
    out.push(
      assert(
        `★★완료 잡이 캡(${TERMINAL_WORKER_JOB_KEEP})을 넘지 않는다 — 넘으면 상주 데몬에서 프로세스 수명 내내 쌓인다`,
        size <= TERMINAL_WORKER_JOB_KEEP + alive.length,
        `${over}건 완료시킨 뒤 Map=${size}건 (캡 ${TERMINAL_WORKER_JOB_KEEP} + 진행중 ${alive.length})`,
      ),
      assert(
        "★★**진행 중** 잡은 절대 안 잘린다 — 사라지면 취소·합류·통지가 전부 깨진다",
        alive.every((id) => m.getJob(id) !== undefined),
        `진행중 ${alive.filter((id) => m.getJob(id) !== undefined).length}/${alive.length}건 생존`,
      ),
      assert(
        "★**오래 끝난 것부터** 버린다 — 최근 결과가 먼저 사라지면 대시보드가 방금 끝난 카드를 못 펼친다",
        m.getJob(doneIds[doneIds.length - 1]!) !== undefined &&
          m.getJob(doneIds[0]!) === undefined,
        `가장 최근=${m.getJob(doneIds[doneIds.length - 1]!) !== undefined ? "생존" : "잘림"} · 가장 오래됨=${m.getJob(doneIds[0]!) === undefined ? "잘림" : "생존"}`,
      ),
      assert(
        "★조용히 지우지 않는다 — 무엇이 얼마나 사라졌는지 로그가 말한다",
        logs.some((l) => l.includes("런타임 완료 잡") && l.includes("정리")),
        logs.filter((l) => l.includes("런타임 완료 잡")).slice(-1)[0]?.slice(0, 120) ?? "★로그 0건",
      ),
    );

    __resetJobsForTest();
    return out;
  },
};
