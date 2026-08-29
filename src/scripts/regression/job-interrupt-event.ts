/**
 * 회귀: **모든 종료 전이는 관측자에게 알린다** (2026-07-29).
 *
 * 사고: 재시작 복구가 DB status 만 조용히 running→interrupted 로 바꾸고 **이벤트를 안 냈다.**
 * started/done/failed/cancelled 는 전부 발행하는데 이 전이만 빠져서, 이벤트 스트림만 보는
 * 관측자(대시보드 SSE replay)는 "시작"만 알고 "끝"을 영영 못 배웠다 → 재시작 후에도 매니저·
 * 서브에이전트가 진행 중으로 남았다(사용자 신고). 실측: dev events 에 종료 이벤트가 아예
 * 없는 worker.started 6건. 대시보드의 클라이언트 폴링 대조는 부팅·재연결 때만 도는 부분 보정.
 *
 * 여기선 실제로 잡을 심고 복구를 돌려 **이벤트가 나가는지**를 본다(소스 문자열 검사 아님).
 * kind='agent' 로 심는다 — 매니저 분기는 사용자 통지(외부 채널)를 시도하므로 검사에 부적합.
 */
import { getEventBus } from "../../core/eventbus.js";
import { recoverInterruptedJobs } from "../../core/worker-jobs.js";
import { getDb } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "job-interrupt-event",
  guards: "재시작 복구가 조용히 상태만 바꿔 관측자가 영영 '진행 중'으로 남던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const jobId = "regr-interrupt-1";
    getDb()
      .prepare(
        `INSERT INTO worker_jobs (job_id, label, thread_key, channel, channel_user_id,
                                  status, started_at, kind)
         VALUES (?, ?, ?, ?, ?, 'running', ?, 'agent')`,
      )
      .run(jobId, "회귀-중단-검사", "dashboard:regr", "dashboard", "regr", Date.now() - 60_000);

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (typeof e.type === "string" && e.type.indexOf("worker.") === 0) {
        seen.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
      }
    });
    try {
      await recoverInterruptedJobs();
    } finally {
      if (typeof unsub === "function") unsub();
    }

    const ev = seen.find((e) => (e.payload as { jobId?: string }).jobId === jobId);
    const row = getDb()
      .prepare(`SELECT status FROM worker_jobs WHERE job_id = ?`)
      .get(jobId) as { status?: string } | undefined;

    return [
      assert("DB 가 interrupted 로 전이", row?.status === "interrupted", String(row?.status)),
      assert(
        "★종료 이벤트가 발행된다(관측자가 끝을 배운다)",
        ev !== undefined,
        seen.map((e) => e.type).join(",") || "(이벤트 0)",
      ),
      assert(
        "이벤트 타입이 worker.interrupted",
        ev?.type === "worker.interrupted",
        String(ev?.type),
      ),
      assert(
        "payload.status 가 interrupted — 클라이언트가 카드를 닫는 근거",
        (ev?.payload as { status?: string } | undefined)?.status === "interrupted",
        String((ev?.payload as { status?: string } | undefined)?.status),
      ),
    ];
  },
};
