/**
 * `job-checkin-reports` 의 자식 프로세스 — **점검 시스템을 진짜로 돌린다.**
 *
 * ★자식으로 도는 이유: 점검 주기·상한은 모듈 상수이고 import 시점에 env 로 확정된다.
 *  per-call 로 못 바꾸므로 env 를 쥔 프로세스가 필요하다(`_data-safety-child` 동형).
 *
 * `PROBE_MODE`:
 *   · `stall`  — 활동이 없는 잡. 주기가 지나면 **보고**가 오고 잡은 **안 죽어야** 한다.
 *   · `alive`  — 활동이 계속 있는 잡. 같은 시간이 지나도 **보고가 없어야** 한다.
 *   · `nokill` — 기본 설정에서 잡을 시계로 죽이지 않는다(정상 작업이 즉시 안 죽는다).
 *
 * 결과를 마지막 줄 JSON 으로 낸다. 부모가 그것만 읽는다.
 */
const MODE = process.env.PROBE_MODE ?? "stall";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
};

const main = async (): Promise<void> => {
  const out: Record<string, unknown> = { mode: MODE };
  const { initStore } = await import("../../store/sessions.js");
  initStore();

  const wj = await import("../../core/worker-jobs.js");
  const { runWorkerJob } = await import(
    "../../core/llm-runtime/capabilities/worker-registry.js"
  );
  const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
  const { getEventBus } = await import("../../core/eventbus.js");

  out.checkinInterval = String(wj.JOB_CHECKIN_INTERVAL_MS);
  out.workerTimeout = String(wj.WORKER_TIMEOUT_MS);

  // 사용자에게 실제로 나가는 텍스트의 관측점.
  const sent: string[] = [];
  registerChannelOutbound("regr-checkin", {
    deliver: async (_t: unknown, text: string) => {
      sent.push(text);
      return { messageIds: [1] };
    },
    defaultOutboundTarget: async () => "t",
  } as never);
  // ★메인 핸들러 등록 여부가 **계약의 축**이다 (2026-08-23 적대 검토 F3 이후).
  //  소환자가 메인 비서면 점검이 그쪽으로 재주입되고 코어는 안 죽인다. 그래서
  //  "정말 아무도 못 받는" 상황을 재현하려면 핸들러를 **안 걸어야** 한다.
  //  `stall` 모드만 핸들러 없음(= raw 직행 → 자동 종료 대상), 나머지는 있음.
  const reinjected: string[] = [];
  // ★재주입 메시지의 **모양**도 붙잡는다 (2026-08-23 2라운드 F1/F1b). 텍스트만 보면
  //  "재주입됐다" 로 초록인데, 라이브에선 `msg.reply` 가 없어 턴 끝에서 TypeError 가 나고
  //  모델의 판단이 통째로 버려졌다. `as never` 가 그 계약 위반을 컴파일 단계에서 가렸다.
  const shapes: Array<Record<string, unknown>> = [];
  if (MODE !== "stall") {
    wj.registerWorkerHandler((async (m: {
      text?: string;
      reply?: unknown;
      synthetic?: unknown;
      receivedAt?: unknown;
    }) => {
      shapes.push({
        hasReply: typeof m.reply === "function",
        synthetic: m.synthetic === true,
        hasReceivedAt: typeof m.receivedAt === "number",
      });
      // 실제 핸들러가 하는 일 — 응답을 보낸다. `reply` 가 없으면 여기서 던진다(라이브 동형).
      if (MODE === "contract" && typeof m.reply === "function") {
        await (m.reply as (t: string) => Promise<unknown>)("점검 판단 결과");
      }
      reinjected.push(String(m.text ?? ""));
      // ★`judged` 는 raw 직행과 재주입을 **구분**해야 하므로 sent 에 안 섞는다.
      if (MODE !== "judged") sent.push(String(m.text ?? ""));
      return { text: "" };
    }) as never);
  }

  const base = {
    channel: "regr-checkin",
    channelUserId: "u",
    task: "t",
    threadKey: "dashboard:s1",
  };

  if (MODE === "leak") {
    // 잡 하나는 계속 running 으로 남겨 시계가 안 꺼지게 한다(그래야 clear() 로 가려지지 않는다).
    wj.__resetJobsForTest();
    const keeper = wj.registerJob({ ...base, kind: "worker", label: "지킴이" } as never);
    void keeper;
    for (let i2 = 0; i2 < 5; i2 += 1) {
      const t = wj.registerJob({ ...base, kind: "agent", label: `단기${i2}`, agentName: "p" } as never);
      wj.markDone(t, "끝");
    }
    out.runningJobs = wj.listJobs({ runningOnly: true }).length;
    out.evidenceAfter = wj.__checkinEvidenceSizeForTest();
    console.log(JSON.stringify(out));
    process.exit(0);
  }

  if (MODE === "parentclock") {
    // ★자식 점검을 부모 매니저에게 배달하는 것은 **시스템 독백**이지 판단이 아니다.
    //  종전엔 그 배달이 부모의 `stallReports` 를 0으로 되돌려, 자식이 하나라도 붙어 있으면
    //  **굳은 부모가 영원히 안 죽었다**(2026-08-23 2라운드 F2). 부모 시계가 도는지 본다.
    wj.__resetJobsForTest();
    const pid = wj.registerJob({ ...base, kind: "worker", label: "굳은매니저" } as never);
    const { createSteeringChannel } = await import("../../core/steering.js");
    const parentCh = createSteeringChannel();
    wj.setSteerChannel(pid, parentCh);
    wj.registerJob({
      ...base,
      kind: "agent",
      label: "굳은자식",
      agentName: "probe",
      threadKey: `worker:${pid}`,
    } as never);
    await sleep(wj.JOB_CHECKIN_INTERVAL_MS + 60);
    // ★재는 축은 부모의 `stallReports` 다. 앵커(`lastActivityAt`)로 재면 안 된다 —
    //  점검이 나갈 때마다 코어가 앵커를 now 로 미는 것은 **의도된 동작**(같은 보고를
    //  주기마다 쏟지 않으려는 스로틀)이라 두 구현이 똑같이 보인다.
    //  옛 코드: 자식 점검 배달 → 부모 stallReports=0 → 영원히 안 오름.
    //  고친 뒤: 시스템 독백은 안 세므로 부모가 조용한 동안 계속 오른다.
    const seen: number[] = [];
    let delivered = 0;
    for (let i2 = 0; i2 < 3; i2 += 1) {
      await sleep(wj.JOB_CHECKIN_INTERVAL_MS + 120); // 주기보다 길게 — 안 그러면 틱이 그냥 넘어간다.
      wj.__checkinTickForTest();
      await sleep(150);
      seen.push(wj.getJob(pid)?.stallReports ?? -1);
      delivered = parentCh.drain().length + delivered;
    }
    out.parentStalls = seen;
    out.childCheckinsToParent = delivered; // 0 이면 이 검사는 아무것도 안 본 것이다.
    console.log(JSON.stringify(out));
    process.exit(0);
  }

  if (MODE === "nokill") {
    // ── 기본 설정에서 시계가 잡을 안 죽인다 ──────────────────────────────────
    wj.__resetJobsForTest();
    const jid = wj.registerJob({ ...base, kind: "worker", label: "정상작업" } as never);
    const t0 = Date.now();
    runWorkerJob(wj.getJob(jid) as never, (async () => {
      await sleep(600);
      return { text: "정상 결과" };
    }) as never);
    await until(() => wj.getJob(jid)?.status !== "running", 8000);
    const job = wj.getJob(jid);
    out.elapsedMs = Date.now() - t0;
    out.status = String(job?.status);
    out.result = (job?.result ?? job?.error ?? "").slice(0, 60);
    console.log(JSON.stringify(out));
    process.exit(0);
  }

  // ── 점검 모드 — 잡을 띄우고 주기를 넘긴 뒤 틱을 돌린다 ─────────────────────────
  const interval = wj.JOB_CHECKIN_INTERVAL_MS;
  const isManagerSummoned = MODE === "managed";

  // `managed` = 소환자가 **돌고 있는 매니저**. 점검은 사용자가 아니라 그쪽으로 가야 한다.
  let parentId = "";
  if (isManagerSummoned) {
    parentId = wj.registerJob({ ...base, kind: "worker", label: "소환자매니저" } as never);
    const { createSteeringChannel } = await import("../../core/steering.js");
    const ch = createSteeringChannel();
    wj.setSteerChannel(parentId, ch);
    (globalThis as Record<string, unknown>).__parentBox = ch;
  }

  const jid = wj.registerJob({
    ...base,
    kind: MODE === "alive" || isManagerSummoned ? "agent" : "worker",
    label: MODE === "alive" ? "도는작업" : "점검대상",
    ...(MODE === "alive" || isManagerSummoned ? { agentName: "probe" } : {}),
    ...(isManagerSummoned ? { threadKey: `worker:${parentId}` } : {}),
  } as never);

  const childKey = MODE === "alive" || isManagerSummoned ? `agent:${jid}` : `worker:${jid}`;

  if (MODE === "alive") {
    // 활동을 계속 발행 — 대시보드가 쓰는 그 스트림.
    for (let i2 = 0; i2 < 6; i2 += 1) {
      getEventBus().publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: { threadKey: childKey, kind: "tool", phase: "start", label: "Bash" },
      } as never);
      getEventBus().publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: { threadKey: childKey, kind: "tool", phase: "end", label: "Bash" },
      } as never);
      await sleep(Math.max(10, Math.floor(interval / 3)));
    }
  } else if (MODE === "longtool") {
    // ★핵심 케이스: 도구 **하나**가 주기보다 오래 걸린다. 이벤트는 start 한 번뿐이라
    //  침묵으로만 보면 정체로 오판한다 — 증거에 "진행 중" 이 실려야 한다.
    getEventBus().publish({
      type: "llm.activity",
      ts: Date.now(),
      payload: { threadKey: childKey, kind: "tool", phase: "start", label: "Bash" },
    } as never);
    await sleep(interval + 60);
  } else {
    await sleep(interval + 60);
  }

  const parentBox = (globalThis as Record<string, unknown>).__parentBox as
    | { drain: () => { raw: string }[] }
    | undefined;
  const parentSeen: { raw: string }[] = [];
  const drainParent = (): number => {
    if (parentBox !== undefined) parentSeen.push(...parentBox.drain());
    return parentSeen.length;
  };
  wj.__checkinTickForTest();
  if (MODE === "alive") {
    // ★기다리면 안 된다: 활동 발행을 멈춘 순간부터 침묵이 쌓여 점검이 정당하게 나간다.
    //  이 케이스가 보려는 것은 **활동이 이어지는 동안** 점검이 안 나가는 것이므로,
    //  대기 없이 곧바로 판정한다(기다리는 검사는 자기가 만든 침묵을 재게 된다).
    await sleep(50);
  } else {
    await until(() => sent.length > 0 || drainParent() > 0, 4000);
    await sleep(80);
  }
  drainParent();
  out.shapes = shapes;
  out.afterFirst = String(wj.getJob(jid)?.status);
  out.firstReports = sent.length;
  out.sample = (sent[0] ?? parentSeen[0]?.raw ?? "").slice(0, 400);

  if (isManagerSummoned) {
    out.parentGot = parentSeen.length;
    out.parentSample = (parentSeen[0]?.raw ?? "").slice(0, 200);
    // ★자식 것이 샜는지로 본다. 사용자에게 가는 메시지가 0이어야 하는 게 아니다 —
    //  **부모 매니저 자신도** 소환자가 세션이라 자기 점검을 사용자에게 보낸다(정상).
    //  구별 없이 0을 요구하면 정상 동작을 실패로 읽는다.
    out.userGotChild = sent.filter((s2) => s2.includes("probe")).length;
    out.userGotAny = sent.length;
  }

  if (MODE === "judged") {
    // 메인 비서가 소환자 — 점검이 그쪽으로 가고, 아무리 조용해도 코어는 안 죽인다.
    for (let i2 = 0; i2 < 3; i2 += 1) {
      await sleep(interval + 60);
      wj.__checkinTickForTest();
      await sleep(200);
    }
    out.toMain = reinjected.filter((t) => t.includes("백그라운드 작업 점검")).length;
    out.rawToUser = sent.length;
    out.statusAfter3 = String(wj.getJob(jid)?.status);
  }
  if (MODE === "stall") {
    // 2주기 완전 침묵 + 판단할 소환자 없음 → 자동 종료.
    await sleep(interval + 60);
    wj.__checkinTickForTest();
    await until(() => sent.some((s2) => s2.includes("중단했습니다")), 4000);
    out.afterSecond = String(wj.getJob(jid)?.status);
    out.killNotice = sent.some((s2) => s2.includes("중단했습니다"));
  }
  if (MODE === "longtool") {
    await sleep(interval + 60);
    wj.__checkinTickForTest();
    await sleep(300);
    out.afterSecond = String(wj.getJob(jid)?.status);
  }
  if (isManagerSummoned) {
    // ★설계의 핵심: 자식이 **완전 침묵**으로 2주기를 넘겨도, 판단할 소환자(도는 매니저)가
    //  있으면 코어는 **안 죽인다**. 그 판단은 매니저 몫이다.
    //  부모는 활동을 계속 내서 살려 둔다 — 부모가 자동 종료되면 연쇄로 자식도 끊겨서
    //  이 케이스를 못 본다(그러면 검사가 의도한 것을 안 보게 된다).
    for (let i2 = 0; i2 < 6; i2 += 1) {
      getEventBus().publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: { threadKey: `worker:${parentId}`, kind: "text", label: "text" },
      } as never);
      await sleep(Math.max(10, Math.floor(interval / 3)));
    }
    wj.__checkinTickForTest();
    await sleep(300);
    drainParent();
    out.childAfterTwoRounds = String(wj.getJob(jid)?.status);
    out.parentAfterTwoRounds = String(wj.getJob(parentId)?.status);
    out.parentGot = parentSeen.length;
    out.userGotChild = sent.filter((s2) => s2.includes("probe")).length;
  }

  if (MODE === "alive") {
    // 활동이 계속 있었으니 마감이 계속 밀려 점검이 **한 번도** 안 나가야 한다.
    out.aliveReports = sent.length;
  }
  if (MODE === "leak") {
    // 잡을 여러 개 돌리고 끝낸 뒤에도 **다른 잡이 남아 있는 동안** 증거가 안 쌓여야 한다.
    out.evidenceAfter = wj.__checkinEvidenceSizeForTest();
  }

  const job = wj.getJob(jid);
  out.reports = sent.length;
  out.status = String(job?.status);
  console.log(JSON.stringify(out));
  process.exit(0);
};

void main();
