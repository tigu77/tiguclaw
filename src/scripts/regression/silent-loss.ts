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

    // ★①-b 두 갈래(`!say` 직송 / LLM 경유)가 **같은 전달 실패에 같은 결과**를 낸다.
    //  (2026-08-01 A4e: 직송만 자동 재전송을 안 걸어, 프롬프트 접두사 하나로 결과가
    //   갈렸다 — LLM 경유는 5분 뒤 되살아나고 직송은 그냥 유실. 재전송이 필요한 이유는
    //   "무엇으로 문구를 만들었나" 와 무관하다.)
    // ★plugins/ 는 tsconfig rootDir(src) 밖이라 정적 import 를 쓰면 빌드가 깨진다.
    //  경로를 **변수**로 주면 tsc 가 프로그램에 넣지 않는다(다른 검사들이 plugins 를
    //  sourceHas 로만 본 이유가 이 제약이다 — 여기선 동작을 봐야 해서 이렇게 우회한다).
    const runnerPath = new URL(
      "../../../plugins/scheduler/src/runner.js",
      import.meta.url,
    ).href;
    const { runScheduleFiring } = (await import(runnerPath)) as {
      runScheduleFiring: (
        s: unknown,
        b: unknown,
        d: Record<string, unknown>,
      ) => Promise<void>;
    };
    // ★initStore 필수 — 재전송 경로가 `getSchedule` 로 "아직 유효한가" 를 확인한다.
    //  스토어가 없으면 재전송이 거기서 죽고, 그러면 이 검사는 **아무것도 증명하지 못한
    //  채 초록**이 된다(메모리: initStore 없으면 '이상없음' 오판).
    const { initStore } = await import("../../store/sessions.js");
    const { addSchedule } = await import("../../store/schedules.js");
    initStore();

    const driveFiring = async (
      prompt: string,
    ): Promise<{ attempts: number; firstWillRetry: unknown; firings: Array<{ ok: boolean }> }> => {
      // 재전송은 스케줄이 **실재할 때만** 진행한다(철 지난 재전송 방지) → 진짜 행을 만든다.
      const row = addSchedule({
        label: "회귀-전달실패",
        cronExpr: "0 0 * * *",
        prompt,
        destChannel: "regr-nonexistent-channel",
        destTarget: "x",
      });
      let attempts = 0;
      let firstWillRetry: unknown = undefined;
      const firings: Array<{ ok: boolean }> = [];
      const bus = {
        publish: (e: { type: string; payload?: Record<string, unknown> }): void => {
          // ★**첫** dispatch 실패 이벤트만 본다. 뒤따르는 재전송 결과 이벤트까지 덮어쓰면
          //  "재전송을 예약했는가" 대신 "재전송이 성공했는가" 를 보게 된다(다른 질문).
          if (e.type === "scheduler.error" && firstWillRetry === undefined) {
            firstWillRetry = e.payload?.willRetry ?? null;
          }
        },
        history: () => [],
        subscribe: () => () => undefined,
      };
      await runScheduleFiring(row, bus, {
        runClaude: async () => ({ text: "생성된 본문" }),
        recordFiring: (_id: unknown, r: { ok: boolean }) => firings.push({ ok: r.ok }),
        dispatch: async () => {
          attempts += 1;
          throw new Error("전달 실패(합성)");
        },
        retryDelayMs: 30, // 5분을 기다리지 않는다.
        cwd: process.cwd(),
      });
      await new Promise((r) => setTimeout(r, 300)); // 재전송 타이머가 돌 시간.
      return { attempts, firstWillRetry, firings };
    };
    const say = await driveFiring("!say 고정 문구입니다");
    const llm = await driveFiring("오늘 일정 알려줘");
    // ★크래시 루프 가드 — 이 경로는 `void runScheduleFiring(...)` 로 불린다. 전달 실패가
    //  reject 로 새어 나가면 unhandledRejection → crash-fast → launchd respawn → 부팅마다
    //  재발이었다(라이브에 reboot 트리거 + `!say` 스케줄이 있었다). **await 가 던지지
    //  않는다**는 사실 자체가 그 가드다 — 위 두 호출이 여기 도달한 것이 곧 증거다.
    out.push(
      assert(
        "★직송 전달 실패가 reject 로 새지 않고 ok:false 로 기록된다(부팅 크래시 루프 0)",
        say.firings.length > 0 && say.firings.every((f) => !f.ok),
        `기록 ${say.firings.length}건 · ok=${say.firings.map((f) => String(f.ok)).join(",")}`,
      ),
    );
    out.push(
      assert(
        "★`!say` 직송도 전달 실패 시 자동 재전송한다(LLM 경유와 동형)",
        say.attempts >= 2,
        `직송 시도 ${say.attempts}회 · LLM경유 ${llm.attempts}회`,
      ),
    );
    out.push(
      assert(
        "★두 갈래가 같은 실패 입력에 같은 횟수로 재시도한다(접두사로 결과가 갈리지 않는다)",
        say.attempts === llm.attempts && say.attempts >= 2,
        `직송 ${say.attempts} vs LLM ${llm.attempts}`,
      ),
    );
    out.push(
      assert(
        "★재전송 예약 사실이 이벤트에 실린다(관측자가 성급히 '유실' 이라 안 하게)",
        say.firstWillRetry === true && llm.firstWillRetry === true,
        `직송 willRetry=${String(say.firstWillRetry)} · LLM willRetry=${String(llm.firstWillRetry)}`,
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
      // ★게이트는 **미들웨어 한 곳**에 있어야 한다. 텍스트 핸들러에만 달았더니
      //  사진·음성·문서·영상이 그대로 통과해, 24시간치 미디어가 부팅 시 턴을 발사했다
      //  (검토 실측). 핸들러마다 다는 건 손으로 관리하는 목록이다.
      /bot\.use\(async \(ctx, next\) => \{\s*if \(ctx\.message !== undefined && isStaleInbound\(ctx\.message\.date\)\)/,
    ]);
    // 개별 핸들러에 흩어져 있으면 안 된다(미들웨어로 승격됐는지 확인).
    const perHandler = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      /if \(isStaleInbound\(ctx\.message\.date\)\) \{\s*noteStaleInbound\(ctx\);/,
    ]);
    out.push(
      assert(
        "★재시작 창 메시지를 처리하고, 오래된 것은 **모든 종류**(사진·음성 포함) 거르되 알린다",
        inbound.ok && !perHandler.ok,
        inbound.ok && !perHandler.ok
          ? "미들웨어 1곳 확인"
          : perHandler.ok
            ? "핸들러별로 흩어졌다 — 첨부 경로가 게이트를 안 탄다"
            : `누락 ${inbound.missing.join(" ")}`,
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
