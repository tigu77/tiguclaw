/**
 * 백그라운드 서브에이전트 — **소환자가 거둔다** (ADR 2026-08-19)
 *
 * 지키는 것: `spawn_agent(wait:false)` 가 생기면서 `kind === "agent"` 가 더는
 * "기다린다"를 뜻하지 않게 됐다. 그 등식에 기대던 판정 셋이 **조용히 틀린 답**을 낸다:
 *
 *  1. 재시작 복구가 kind 로 걸러 백그라운드 서브의 중단을 아무에게도 안 알림(조용한 손실)
 *  2. cancel_worker 가 "부모 대화를 멈추면 정리됩니다" 라는 거짓 안내 — 멈출 부모 턴이 없다
 *  3. 결과가 돌고 있는 매니저에게 새 턴으로 가서 **닿지 않음**(매니저는 핸들러가 아니다)
 *
 * 등급: **동작 검사** — 실제 레지스트리에 잡을 등록하고 판정 함수를 돌린다. 라이브
 * 데몬·모델 호출 없음(러너가 임시 홈을 잡는다).
 */
import {
  __resetJobsForTest,
  onWorkerComplete,
  cancelJob,
  getJob,
  markDone,
  findTargetableJob,
  parentJobIdOf,
  registerJob,
  registerWorkerHandler,
  getSteerChannel,
  rotateSteerChannel,
  steerJob,
  setJobResultChannel,
  setSteerChannel,
} from "../../core/worker-jobs.js";
import {
  createSteeringChannel,
  partitionSteering,
  shouldKeepReaping,
} from "../../core/steering.js";
import { readFile } from "node:fs/promises";
import type { Assertion, RegressionCheck } from "./_framework.js";
import { assert, assertIsolated } from "./_framework.js";

export const check: RegressionCheck = {
  name: "background-subagent",
  guards:
    "kind==='agent' 가 'awaited' 를 뜻한다는 전제 — wait:false 가 그걸 깼는데 재시작 통지·취소·결과 라우팅이 여전히 kind 로 갈라 조용히 틀린 답을 내던 것 (2026-08-19)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    __resetJobsForTest();

    // ── 소환자 좌표는 threadKey 규약에서 **파생**된다(별도 컬럼 아님) ────────────
    out.push(
      assert("세션 좌표는 소환자 잡이 없다", parentJobIdOf("dashboard:abc") === undefined, `${parentJobIdOf("dashboard:abc")}`),
      assert("worker:<id> → 그 매니저가 소환자", parentJobIdOf("worker:J1") === "J1", `${parentJobIdOf("worker:J1")}`),
      assert("agent:<id> → 그 서브가 소환자", parentJobIdOf("agent:J2") === "J2", `${parentJobIdOf("agent:J2")}`),
      assert("빈 문자열은 미상", parentJobIdOf("") === undefined, `${parentJobIdOf("")}`),
    );

    // ── 실행 축(detached)은 표시 축(kind)과 **독립**이다 ─────────────────────────
    const base = { channel: "dashboard" as const, channelUserId: "u", task: "t" };
    const awaited = registerJob({
      ...base, kind: "agent", label: "awaited-sub", threadKey: "dashboard:s1",
    });
    const bg = registerJob({
      ...base, kind: "agent", label: "bg-sub", threadKey: "dashboard:s1", detached: true,
    });
    const mgr = registerJob({ ...base, kind: "worker", label: "mgr", threadKey: "dashboard:s1" });

    out.push(
      assert("wait:true 서브는 awaited", getJob(awaited)?.detached === false, `${getJob(awaited)?.detached}`),
      assert("wait:false 서브는 detached — kind 는 그대로 agent",
        getJob(bg)?.detached === true && getJob(bg)?.kind === "agent",
        `detached=${getJob(bg)?.detached} kind=${getJob(bg)?.kind}`),
      assert("매니저는 명시 없이도 detached(정의상)", getJob(mgr)?.detached === true, `${getJob(mgr)?.detached}`),
    );

    // ── cancel_worker/steer_worker 의 대상 선택 = **detached** (kind 아님) ────────
    //  ★두 도구가 **실제로 쓰는 함수**를 부른다. 종전 판(필터를 검사 안에서 재구현)은
    //   진짜 코드를 안 지켜서, 게이트를 kind 로 되돌리는 변이가 그대로 통과했다.
    out.push(
      assert(
        "★백그라운드 서브는 취소·스티어 대상이다(부모 턴이 없으므로 직접 멈춰야 한다)",
        findTargetableJob({ label: "bg-sub" })?.jobId === bg,
        `${findTargetableJob({ label: "bg-sub" })?.label ?? "(미발견)"}`,
      ),
      assert(
        "awaited 서브는 대상이 아니다(진행 중 대화를 멈추는 게 맞는 경로)",
        findTargetableJob({ label: "awaited-sub" }) === undefined,
        `${findTargetableJob({ label: "awaited-sub" })?.label ?? "미발견(정답)"}`,
      ),
      assert("매니저는 종전대로 대상", findTargetableJob({ label: "mgr" })?.jobId === mgr, "mgr"),
      assert(
        "job_id 로도 백그라운드 서브가 잡힌다(카드 중지 버튼 경로)",
        findTargetableJob({ jobId: bg })?.jobId === bg,
        `${findTargetableJob({ jobId: bg })?.label ?? "(미발견)"}`,
      ),
      assert(
        "job_id 로도 awaited 서브는 안 잡힌다",
        findTargetableJob({ jobId: awaited }) === undefined,
        "미발견이어야",
      ),
    );

    // 실제로 취소가 먹는가 — 선택 기준만 맞고 취소가 안 되면 약속만 한 셈이다.
    out.push(assert("백그라운드 서브 cancelJob 이 실제로 먹는다", cancelJob(bg), "true 여야"));
    out.push(
      assert("취소 후 status=cancelled", getJob(bg)?.status === "cancelled", `${getJob(bg)?.status}`),
    );

    // ── 결과 라우팅: 돌고 있는 매니저면 그 잡의 **결과 수신함** ────────────────────
    //  매니저 밑의 백그라운드 서브가 끝나면 결과가 매니저에게 가야 한다. 새 턴으로 가면
    //  안 닿는다(매니저는 핸들러가 아니라 runRegionA 안이다).
    //  ★수신함은 **개입(steering) 큐와 별개**다 — 같은 큐로 넣었더니 결과가 진행 중인 턴에
    //   섞여 SDK 가 새 턴을 열었고, 어댑터의 턴 경계 가드가 그 답을 버렸다(라이브 3차 실측:
    //   매니저가 합계를 계산했는데 FINALIZE 는 31자짜리 첫 답만 남겼다).
    __resetJobsForTest();
    const mgr2 = registerJob({ ...base, kind: "worker", label: "mgr2", threadKey: "dashboard:s1" });
    const ch = createSteeringChannel();
    setJobResultChannel(mgr2, ch);
    const userCh = createSteeringChannel();
    setSteerChannel(mgr2, userCh);
    const subOfMgr = registerJob({
      ...base, kind: "agent", label: "sub-of-mgr", threadKey: `worker:${mgr2}`, detached: true,
    });

    await onWorkerComplete(subOfMgr, { result: "조사 끝: 원인은 X" });
    const queued = ch.drain();
    out.push(
      assert("★결과가 매니저의 결과 수신함으로 들어간다", queued.length === 1, `${queued.length}건`),
      assert(
        "★개입(steering) 큐엔 안 들어간다 — 진행 중 턴에 섞이면 어댑터가 그 답을 버린다",
        userCh.drain().length === 0,
        "0건이어야",
      ),
      assert(
        "본문에 서브 이름과 결과가 실린다",
        queued[0]?.text.includes("sub-of-mgr") === true &&
          queued[0]?.text.includes("원인은 X") === true,
        queued[0]?.text ?? "(없음)",
      ),
      assert(
        "raw 와 text 가 같다(미소비 재주입 시 우리 framing 이 사용자 발화로 노출되지 않게)",
        queued[0]?.raw === queued[0]?.text,
        `raw=${queued[0]?.raw?.slice(0, 40)}`,
      ),
      assert("서브 잡은 done 으로 닫힌다", getJob(subOfMgr)?.status === "done", `${getJob(subOfMgr)?.status}`),
    );

    // ── 매니저가 **이미 끝났으면** 큐로 안 가고 종전 경로(새 턴)로 떨어져야 한다 ──
    //  그래야 결과가 사라지지 않는다.
    //  ★두 경우를 따로 잰다 — 종전 판은 채널만 닫아놓고 매니저 status 는 running 이라
    //   `status !== "running"` 가드를 지우는 변이가 그대로 통과했다(둘 중 하나만 겨눴다).

    // (a) 매니저가 **끝났는데 채널은 열려 있는** 경우 — status 가드만이 막는다.
    __resetJobsForTest();
    const mgrDone = registerJob({ ...base, kind: "worker", label: "mgr-done", threadKey: "dashboard:s1" });
    const chOpen = createSteeringChannel();
    setJobResultChannel(mgrDone, chOpen);
    markDone(mgrDone, "매니저는 먼저 끝났다");
    const subOfDone = registerJob({
      ...base, kind: "agent", label: "sub-of-done", threadKey: `worker:${mgrDone}`, detached: true,
    });
    await onWorkerComplete(subOfDone, { result: "늦게 끝남" });
    out.push(
      assert(
        "★끝난 매니저 큐엔 안 넣는다(채널이 아직 열려 있어도) — 아무도 안 읽을 큐다",
        chOpen.drain().length === 0,
        `${chOpen.drain().length}건`,
      ),
      assert("그래도 잡은 done 으로 닫힌다", getJob(subOfDone)?.status === "done", `${getJob(subOfDone)?.status}`),
    );

    // (a-2) ★그럼 그 결과는 **어디로 가나** — 유령 좌표로 새면 안 된다.
    //  실측(2026-08-19): 합성 턴이 `worker:<죽은매니저>` 좌표로 열려 발송 대상이 없어
    //  "미배달"로 떨어졌다. 지휘자가 여럿을 wait:false 로 띄우고 먼저 끝내면 바로 이 상황이라
    //  드문 경로가 아니다. 소유 세션으로 환원돼야 사용자가 결과를 본다.
    {
      const seen: string[] = [];
      registerWorkerHandler((async (msg: { threadKey: string }) => {
        seen.push(msg.threadKey);
        return { text: "" };
      }) as never);
      __resetJobsForTest();
      const conductor = registerJob({
        ...base, kind: "worker", label: "지휘자", threadKey: "dashboard:S1",
      });
      markDone(conductor, "지휘자 먼저 종료");
      const player = registerJob({
        ...base, kind: "agent", label: "연주자",
        threadKey: `worker:${conductor}`, detached: true,
      });
      await onWorkerComplete(player, { result: "내 조사 결과" });
      out.push(
        assert(
          "★지휘자가 먼저 끝나도 연주자 결과가 **소유 세션**으로 간다(유령 좌표 금지)",
          seen.includes("dashboard:S1"),
          seen.join(",") || "(합성 턴 0건)",
        ),
        assert(
          "죽은 매니저 좌표로는 안 연다",
          !seen.some((k) => k.startsWith("worker:")),
          seen.join(",") || "(없음)",
        ),
      );
    }

    // (b) 매니저는 돌고 있는데 **채널이 닫힌** 경우 — steerJob 의 closed 판정이 막는다.
    __resetJobsForTest();
    const mgr3 = registerJob({ ...base, kind: "worker", label: "mgr3", threadKey: "dashboard:s1" });
    const ch3 = createSteeringChannel();
    setSteerChannel(mgr3, ch3);
    ch3.close();
    const subOfDead = registerJob({
      ...base, kind: "agent", label: "sub-of-dead", threadKey: `worker:${mgr3}`, detached: true,
    });
    await onWorkerComplete(subOfDead, { result: "늦게 끝남" });
    out.push(
      assert(
        "닫힌 채널엔 안 쌓인다(=새 턴 경로로 떨어져 결과 유실 0)",
        ch3.drain().length === 0,
        `${ch3.drain().length}건`,
      ),
    );

    // ── ★소환자는 **거두고** 끝난다 — 매니저 턴이 자식보다 먼저 안 닫힌다 ──────────
    //  사용자 확정: "소환해놓고 끝날 수는 없지" + "시스템적으로 안 거둘 수 없게 해야지".
    //  종전엔 프롬프트 넛지 한 줄뿐이라 모델이 안 지키면 조용히 결과가 샜다.
    out.push(
      assert(
        "자식이 돌면 턴을 안 닫는다",
        shouldKeepReaping({ aborted: false, pendingResults: 0, liveChildren: 2 }),
        "true 여야",
      ),
      assert(
        "★턴 끝 순간 도착한 결과가 있으면 자식이 다 끝났어도 이어서 먹인다",
        shouldKeepReaping({ aborted: false, pendingResults: 1, liveChildren: 0 }),
        "true 여야 — 안 그러면 그 결과가 '사용자 지시' 로 오해돼 되읽힌다",
      ),
      assert(
        "둘 다 없으면 닫는다",
        !shouldKeepReaping({ aborted: false, pendingResults: 0, liveChildren: 0 }),
        "false 여야",
      ),
      assert(
        "★abort(상한·취소)면 무조건 닫는다 — 무한 루프 0",
        !shouldKeepReaping({ aborted: true, pendingResults: 5, liveChildren: 5 }),
        "false 여야",
      ),
    );

    // ── 출처 표식 — 같은 큐의 두 종류를 가른다 ──────────────────────────────────
    const mixed = [
      { text: "그만해", raw: "그만해", ts: 1 },
      { text: "[백그라운드 …] 결과", raw: "[백그라운드 …] 결과", ts: 2, source: "job" as const },
      { text: "이것도 봐줘", raw: "이것도 봐줘", ts: 3, source: "user" as const },
    ];
    const part = partitionSteering(mixed);
    out.push(
      assert("자식 결과만 거두기 루프로", part.jobResults.length === 1, `${part.jobResults.length}건`),
      assert(
        "★출처 미지정은 사용자로 본다(이 필드 이전 호출부 전부가 그 의미 — 회귀 0)",
        part.userMessages.length === 2,
        part.userMessages.map((m) => m.raw).join(" | "),
      ),
      assert(
        "★자식 결과를 '방금 보내신 지시' 통지에 안 싣는다(안 보낸 문장을 통보받는 일 0)",
        !part.userMessages.some((m) => m.raw.includes("백그라운드")),
        part.userMessages.map((m) => m.raw).join(" | "),
      ),
    );

    // ── ★채널 수명은 **턴 단위**, 잡의 스티어 정체성은 **턴을 가로지른다** ──────────
    //  라이브에서만 드러난 회귀(2026-08-19): claude 어댑터가 첫 result 에서
    //  `input.steering.close()` 를 부른다(스트리밍 데드락 수정). 거두기 루프가 그 닫힌
    //  채널을 재사용하면 `stream()` 이 **즉시** 끝나 "기다렸다" 고 착각하고 빠져나온다.
    //  실측: 루프가 로그만 찍고 0초 만에 탈출, 매니저가 자식보다 먼저 done 이 됐다.
    //  회귀가 판정 함수만 격리 검사해서 이 상호작용을 못 봤다 — 그래서 여기 넣는다.
    __resetJobsForTest();
    {
      const rotJob = registerJob({ ...base, kind: "worker", label: "rot", threadKey: "dashboard:s1" });
      const first = createSteeringChannel();
      setSteerChannel(rotJob, first);
      first.push({ text: "먼저 온 결과", raw: "먼저 온 결과", ts: 1, source: "job" });
      first.close(); // ← 어댑터가 턴 끝에 하는 일

      const rot = rotateSteerChannel(rotJob);
      out.push(
        assert(
          "★교체 순간 이전 채널에 남아 있던 결과를 이어받는다(조용히 버리지 않는다)",
          rot.leftover.length === 1 && rot.leftover[0]?.raw === "먼저 온 결과",
          `${rot.leftover.length}건`,
        ),
        assert(
          "★닫힌 채널을 갈아끼운 뒤엔 새 결과가 **전달된다**(종전엔 closed 로 떨어졌다)",
          steerJob(rotJob, { text: "다음 결과", raw: "다음 결과", ts: 2, source: "job" }) ===
            "delivered",
          "delivered 여야",
        ),
        assert(
          "그 결과는 새 채널에서 걷힌다",
          rot.channel.drain().some((m) => m.raw === "다음 결과"),
          "새 채널",
        ),
      );
    }

    // ── ★어댑터가 개입 채널을 닫은 창에도 **사용자 지시**는 닿는다 ────────────────
    //  claude 어댑터는 첫 result 에서 `input.steering.close()` 를 부른다(데드락 수정).
    //  그 뒤로도 잡은 살아서 다음 턴을 돈다 — 그 창의 지시를 "closed" 로 버리면 사용자
    //  입장에선 "보냈는데 안 갔다" 다. 채널 수명은 턴 단위지만 잡의 정체성은 턴을 가로지른다.
    //  (자식 결과는 이제 별도 수신함이라 이 창의 영향을 아예 안 받는다.)
    __resetJobsForTest();
    {
      const liveMgr = registerJob({ ...base, kind: "worker", label: "돌고있는지휘자", threadKey: "dashboard:s1" });
      const turnCh = createSteeringChannel();
      setSteerChannel(liveMgr, turnCh);
      turnCh.push({ text: "먼저 도착", raw: "먼저 도착", ts: 1 });
      turnCh.close(); // ← 어댑터가 첫 result 에서 하는 일. 잡은 **아직 running**.

      const outcome = steerJob(liveMgr, { text: "그만해", raw: "그만해", ts: 2 });
      const nowCh = getSteerChannel(liveMgr);
      const got = nowCh === undefined ? [] : nowCh.drain();
      out.push(
        assert("★턴 채널이 닫혔어도 잡이 돌면 지시가 전달된다", outcome === "delivered", outcome),
        assert(
          "★교체 순간 남아 있던 것도 보존된다 — 도착 순 그대로",
          got.length === 2 && got[0]?.raw === "먼저 도착" && got[1]?.raw === "그만해",
          got.map((m) => m.raw).join(" | ") || "(비어 있음)",
        ),
        assert(
          "잡이 **끝났으면** 갈아끼우지 않는다(아무도 안 읽을 채널을 만들지 않는다)",
          (() => {
            const doneMgr = registerJob({ ...base, kind: "worker", label: "끝난지휘자", threadKey: "dashboard:s1" });
            const c = createSteeringChannel();
            setSteerChannel(doneMgr, c);
            c.close();
            markDone(doneMgr, "끝");
            return steerJob(doneMgr, { text: "x", raw: "x", ts: 1 }) === "closed";
          })(),
          "closed 여야",
        ),
      );
    }

    // ── 배선 검사 (등급: **소스 린트** — 위 동작 검사보다 약하다) ────────────────
    //  왜 여기만 약한가: 이 판정을 쓰는 자리(worker-registry 의 러너)는 `runRegionA` 를
    //  부른다 = 실제 모델 호출. 회귀 스위트에 못 넣는다(싸고·결정적이어야 한다).
    //  그래서 **판정 함수는 실행**해 지키고(위), **그 함수를 실제로 쓰는지**만 소스로 본다.
    //  ★정직하게: 이 줄은 동의어·우회로 뚫린다. 그래도 없는 것보단 낫다 —
    //   실제로 변이 검사에서 "잔여 통지가 자식 결과까지 싣는" 회귀가 여기로만 잡혔다.
    const runnerSrc = await readFile(
      new URL("../../core/llm-runtime/capabilities/worker-registry.ts", import.meta.url),
      "utf8",
    );
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const code = stripComments(runnerSrc);
    out.push(
      assert(
        "★러너가 라운드마다 채널을 교체한다(닫힌 채널 재사용 = 거두기가 조용히 안 돎)",
        code.includes("rotateSteerChannel(job.jobId"),
        code.includes("rotateSteerChannel") ? "교체 있음" : "★미교체 — 라이브에서 0초 탈출한다",
      ),
      assert(
        "러너가 거두기 판정을 직접 재구현하지 않고 shouldKeepReaping 을 쓴다",
        code.includes("shouldKeepReaping({"),
        code.includes("shouldKeepReaping") ? "호출 있음" : "★미사용 — 판정이 복제됐다",
      ),
      assert(
        "★잔여 통지가 userMessages 만 싣는다(자식 결과를 '방금 보내신 지시' 로 되읽지 않게)",
        /pendingSteerNotice[\s\S]{0,200}?userMessages|const leftover = partitionSteering\([\s\S]{0,60}?\)\.userMessages/.test(
          code,
        ),
        code.includes(".userMessages") ? "필터 있음" : "★raw drain — 자식 결과가 섞인다",
      ),
    );

    __resetJobsForTest();
    return out;
  },
};
