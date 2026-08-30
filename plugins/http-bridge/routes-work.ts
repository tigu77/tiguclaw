/**
 * **매니저·셸 라우트** — 잡 목록과 **중단**.
 *
 * ★`/cancel-queued`·`/cancel-worker`·`/kill-shell` 은 **돌고 있는 것을 죽인다.** 한자리에
 *  모아두면 "취소가 메인 비서에게 닿는가" 같은 계약을 한 파일에서 볼 수 있다
 *  (회귀 `cancel-reaches-main` 이 지키는 축).
 *
 * ★용어: 화면·모델 대면은 **매니저**, 식별자·DB·이벤트는 `worker` 그대로다
 *  ([[project_manager_agent_naming]]).
 */
import { killShellById, listShells, tailShell } from "../../src/core/llm-runtime/capabilities/file-ops-mcp.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { RUNNING_WORK, stampFor } from "../../src/core/resource-revision.js";
import { cancelJob, cancelQueuedTurn, getJobActivity, listJobs, resolveOwnerThreadKey } from "../../src/core/worker-jobs.js";
import { readJsonBody } from "./http-body.js";
import type { RouteCtx } from "./route-ctx.js";

export const handleWorkerJobs = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  // ★리비전을 **목록보다 먼저** 읽는다 (2026-08-27 Phase 1). 반대로 하면 목록을 만드는
  //  사이에 들어온 변경이 리비전에만 반영돼, 화면이 "이미 최신" 이라 믿고 그 이벤트를
  //  버린다(잃어버린 갱신). 먼저 읽으면 최악이 **한 번 더 받는 것**이라 안전한 쪽이다.
  const stamp = stampFor(RUNNING_WORK);
  const jobs = listJobs({ runningOnly: true, limit: 200 }).map((j) => ({
    jobId: j.jobId,
    label: j.label,
    kind: j.kind ?? "worker",
    threadKey: j.threadKey,
    // 원 세션(잡 좌표 환원) — worker.* 이벤트 payload 와 동형. 대시보드 세션 스코프 필터가
    // SSE·하이드레이션 어느 경로로 카드를 만들든 같은 근거로 판정하게 한다.
    ownerThreadKey: resolveOwnerThreadKey(j.threadKey),
    status: j.status,
    // ★시작 시각 (2026-08-19 사용자 지적: 카드에 `1787121377393` 같은 숫자가 뜬다).
    //  종전엔 이 필드가 없어서 하이드레이션이 `Date.now()` 를 시각 자리에 넣었고,
    //  그것도 **포맷 안 된 epoch** 라 카드에 원값이 그대로 보였다. 시각은 서버가 아는
    //  사실이므로 여기서 준다 — 클라가 "지금"으로 지어내면 그건 다른 값이다.
    ...(typeof j.startedAt === "number" ? { startedAt: j.startedAt } : {}),
    ...(j.agentName !== undefined ? { agentName: j.agentName } : {}),
    ...(j.modelTier !== undefined && j.modelTier !== ""
      ? { modelTier: j.modelTier }
      : {}),
    ...(j.task !== undefined ? { task: j.task } : {}),
    ...(j.cwd !== undefined && j.cwd !== "" ? { cwd: j.cwd } : {}),
    // ★"지금 무엇을 하는 중인가" 도 같이 준다 (2026-08-24 사용자 신고: "새로고침하면
    //  백그라운드 매니저·에이전트의 뭘 진행중인지가 사라져"). 종전엔 이 한 줄이 SSE
    //  스텝으로만 왔는데, replay 창(50) 밖으로 밀린 긴 잡은 새로고침 뒤 영영 안 왔다 —
    //  카드는 복원되는데 **속이 비었다.**
    //  ★새로 재지 않는다 — **점검(check-in)이 쓰는 것과 같은 증거**를 읽는다
    //   (`getJobActivity`). 채팅 `/workers` 도 이미 이걸로 같은 문구를 만든다.
    //   계측을 또 만들면 같은 사실을 두 곳이 다르게 말하게 된다.
    //  ★한계(정직하게): `evidence` 는 in-memory 라 **데몬 재시작이면 비어 있다**.
    //   그땐 카드는 서고 이 줄만 없다(잡 자체도 재시작으로 끊기므로 실질 영향은 작다).
    ...(() => {
      const act = getJobActivity(j.jobId);
      return act === undefined ? {} : { activity: act };
    })(),
  }));
  writeJson(res, 200, { ...stamp, items: jobs, jobs });
  return;
};

export const handleShells = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  writeJson(res, 200, { shells: listShells() });
  return;
};

export const handleShellOutput = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  const shellId = url.searchParams.get("id") ?? "";
  if (shellId === "") {
    writeJson(res, 400, { error: "id required" });
    return;
  }
  const tail = tailShell(shellId);
  if (tail === undefined) {
    writeJson(res, 404, { error: "shell not found", shellId });
    return;
  }
  writeJson(res, 200, tail);
  return;
};

export const handleCancelQueued = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let cbody: Record<string, unknown>;
  try {
    cbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const threadKey =
    typeof cbody.threadKey === "string" ? cbody.threadKey.trim() : "";
  const correlationId =
    typeof cbody.correlationId === "string" ? cbody.correlationId.trim() : "";
  if (threadKey === "" || correlationId === "") {
    writeJson(res, 400, {
      error: "threadKey and correlationId required",
    });
    return;
  }
  const result = cancelQueuedTurn(threadKey, correlationId);
  writeJson(res, 200, { result });
  return;
};

export const handleCancelWorker = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let wbody: Record<string, unknown>;
  try {
    wbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const jobId = typeof wbody.jobId === "string" ? wbody.jobId.trim() : "";
  if (jobId === "") {
    writeJson(res, 400, { error: "jobId required" });
    return;
  }
  const cancelled = cancelJob(jobId);
  writeJson(res, 200, { ok: true, cancelled });
  return;
};

export const handleKillShell = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let kbody: Record<string, unknown>;
  try {
    kbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const shellId =
    typeof kbody.shellId === "string" ? kbody.shellId.trim() : "";
  if (shellId === "") {
    writeJson(res, 400, { error: "shellId required" });
    return;
  }
  const killed = await killShellById(shellId);
  writeJson(res, 200, { ok: true, killed });
  return;
};
