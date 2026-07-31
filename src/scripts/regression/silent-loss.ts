/**
 * 회귀: **조용한 손실 3종** — 실패했는데 성공으로 보이던 것들 (2026-07-31 전체검토 P1).
 *
 * 셋 다 "아무 일도 안 일어났는데 로그·DB·화면 어디에도 신호가 없다" 는 같은 병이다.
 *
 *  ①**스케줄이 아무것도 안 보내고 `ok` 로 기록됐다.** `deliverOutbound` 는 미등록 채널이면
 *   `console.warn` 후 **throw 없이 return** 했고, 호출한 runner 는 그걸 성공으로 보아
 *   `recordFiring(ok:true)` + `scheduler.fired{ok:true}` 를 남겼다. 자가 점검 스윕은
 *   `last_status='error'` 만 보므로 **영영 안 잡힌다**. 실경로: TELEGRAM_BOT_TOKEN 부재
 *   → 채널 outbound 미등록. 게다가 `add_schedule` 의 `dest_channel` 은 `z.string().max(64)`
 *   뿐이라 **오타 한 글자면 영구 무발신**이었다.
 *
 *  ②**재시작 창의 텔레그램 메시지가 무통지 폐기됐다.** `drop_pending_updates: true` 인데
 *   이 데몬은 하루 **23~49회** 재시작하고(실측) 종료→부팅 창이 **1~5초**다. 그 창의
 *   메시지는 통째로 버려졌고 사용자에겐 "씹혔다" 로만 보였다.
 *
 *  ③**취소가 자식 잡에 전파되지 않았다.** 실측 재현: `cancelJob(parent)=true /
 *   parent=cancelled / child=running / child abort 훅 호출 false`. 매니저를 중지시켜도
 *   서브에이전트가 상한(2시간)까지 모델을 태우고, 결과는 부모가 abort 돼 폐기된다.
 *   더 나쁜 건 프롬프트의 "진행 중인 백그라운드 작업" 줄이 **취소된 작업을 진행 중이라고
 *   메인에게 보고**한 것 — 소속 판정(`jobBelongsToSession`)이 이미 있는데 취소만 안 썼다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "silent-loss",
  guards:
    "스케줄이 미발송인데 ok 로 기록되고, 재시작 창의 메시지가 무통지 폐기되고, 취소가 자식에 전파 안 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 미배달이 **결과로** 돌아온다.
    const { deliverOutbound } = await import("../../core/outbound.js");
    const undelivered = await deliverOutbound({
      channel: "regr-nonexistent-channel",
      target: "x",
      text: "본문",
      observe: false,
    });
    out.push(
      assert(
        "★미등록 채널 발송이 실패로 보고된다(조용한 성공 아님)",
        undelivered.delivered === false && (undelivered.reason ?? "") !== "",
        `delivered=${undelivered.delivered} reason=${(undelivered.reason ?? "").slice(0, 60)}`,
      ),
    );

    // 스케줄 dispatch 가 그 결과를 **읽고 throw** 한다 — runner 가 ok:false 로 기록하게.
    const dispatchWired = await sourceHas("../../../plugins/scheduler/src/dispatcher.ts", [
      /const r = await deliverOutbound\(\{/,
      /if \(!r\.delivered\) \{/,
      /throw new Error\(`스케줄 발송 실패/,
    ]);
    out.push(
      assert(
        "★스케줄 dispatch 가 미배달을 throw 한다(성공 기록 차단)",
        dispatchWired.ok,
        dispatchWired.ok ? "3개 확인" : `누락 ${dispatchWired.missing.join(" ")}`,
      ),
    );

    // 오타는 **등록 시점에** 잡는다 — 이름 하드코딩이 아니라 레지스트리 대조로.
    const createGate = await sourceHas("../../../plugins/scheduler/src/mcp.ts", [
      /const known = listOutboundChannels\(\);/,
      /!known\.includes\(args\.dest_channel\)/,
      /isError: true,/,
    ]);
    out.push(
      assert(
        "★add_schedule 이 dest_channel 을 레지스트리와 대조한다(오타 = 영구 무발신)",
        createGate.ok,
        createGate.ok ? "3개 확인" : `누락 ${createGate.missing.join(" ")}`,
      ),
    );

    // ★② 재시작 창 메시지를 살린다 — 오래된 것만 시간으로 가르고, 버릴 땐 말한다.
    const inbound = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      /bot\.start\(\{ drop_pending_updates: false \}\)/,
      /const isStaleInbound = \(dateSec: number \| undefined\): boolean =>/,
      // 창 밖이라도 **조용히 버리지 않는다**(원래 사고가 그것이다).
      /const noteStaleInbound = \(ctx: Context\): void =>/,
      /if \(isStaleInbound\(ctx\.message\.date\)\) \{\s*noteStaleInbound\(ctx\);/,
    ]);
    out.push(
      assert(
        "★재시작 창(1~5초)의 메시지를 처리하고, 오래된 것은 버리되 알린다",
        inbound.ok,
        inbound.ok ? "4개 확인" : `누락 ${inbound.missing.join(" ")}`,
      ),
    );

    // ★③ 취소가 자손 전체로 — 동작으로 본다.
    const wj = await import("../../core/worker-jobs.js");
    const fired: Record<string, boolean> = {};
    const reg = (threadKey: string, label: string, kind: "worker" | "agent"): string =>
      wj.registerJob({
        threadKey,
        label,
        kind,
        task: "회귀 검사용",
        channel: "regr",
        channelUserId: "regr",
      });
    const P = reg("regr:cancel", "부모", "worker");
    const C = reg(`worker:${P}`, "자식", "agent");
    const G = reg(`agent:${C}`, "손자", "agent");
    for (const [id, k] of [[P, "p"], [C, "c"], [G, "g"]] as const) {
      fired[k] = false;
      wj.setCancelHook(id, () => {
        fired[k] = true;
      });
    }
    wj.cancelJob(P);
    const status = (id: string): string =>
      wj.listJobs().find((j) => j.jobId === id)?.status ?? "?";
    const allCancelled = [P, C, G].every((id) => status(id) === "cancelled");
    out.push(
      assert(
        "★취소가 자식·손자까지 전파된다(abort 훅 포함)",
        allCancelled && fired.p === true && fired.c === true && fired.g === true,
        `상태 ${[P, C, G].map(status).join("/")} 훅 ${JSON.stringify(fired)}`,
      ),
    );
    // 취소된 잡이 "진행 중" 으로 메인 프롬프트에 보고되면 안 된다.
    out.push(
      assert(
        "취소 후 '진행 중인 백그라운드 작업' 에 안 남는다(메인에 거짓 보고 0)",
        wj.listLiveChildJobs("regr:cancel").length === 0,
        `${wj.listLiveChildJobs("regr:cancel").length}건`,
      ),
    );
    return out;
  },
};
