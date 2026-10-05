/**
 * 회귀: **실패 분류기는 두 언어를 다 알아보고, 이름이 있으면 이름으로 가른다.**
 *
 * 사정 (2026-10-05, 서버 고정 문구 영어 통일 — 예외 원문 단계): 사용자에게 보이는 예외 원문을
 *  영어로 바꾸려는데, 그 원문을 **분류기가 한국어 정규식으로 직접 매칭**하고 있었다. 영어로만
 *  바꾸면 분류가 «기타» 로 무너지고(통지가 «wall-clock 상한» 대신 원문 덤프), 반대로 영어만
 *  알아보게 하면 **DB 에 이미 저장된 한국어 오류**(events·worker_jobs)를 못 알아본다.
 *
 * 지키는 것 —
 *  ① 각 분류기가 **새 영어 원문**을 맞게 가른다 — 원문은 **실제 생성처**(오류 클래스·어댑터 가드)에서
 *     만든다. 생성처 문장을 바꾸면 여기서 빨개진다(생성처 ↔ 분류기 이음매).
 *  ② **옛 한국어 원문**도 같은 분류가 나온다(과거 기록).
 *  ③ 타입 이름이 있으면 문장과 무관하게 이름으로 가른다(구조 분류).
 *  ④ 시간 종료 문장이 «모델 거부» 로 오분류되지 않는다(시한 숫자에 404 가 껴도).
 *
 * 등급: **동작** — 분류 함수와 생성처를 실제로 돌린다(데몬·네트워크·실모델 0).
 */
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];

  const wj = await import("../../core/worker-jobs.js");
  const { ToolHangError } = await import("../../core/llm-runtime/tool-watchdog.js");
  const { IdleTimeoutError } = await import("../../core/llm-runtime/idle-timeout.js");
  const { TurnTimeoutError } = await import("../../core/llm-runtime/turn-timeout.js");
  const rt = await import("../../core/llm-runtime/index.js");
  const { isAuthRejected } = await import("../../core/llm-runtime/rate-limit.js");
  const { describeTurnErrors } = await import("../../core/health-sweep.js");
  const { deriveWorkerErrorKind } = await loadPluginModule<{
    deriveWorkerErrorKind: (error: string, errorName?: string) => string;
  }>("../../../plugins/self-growth/src/failure.ts");

  // ── 표본 — 새 원문은 **생성처가 만든 것**, 옛 원문은 2026-10-05 이전 판 그대로 ──────────────
  const fresh = {
    wall: new wj.WorkerTimeoutError(7_200_000),
    tool: new ToolHangError("Bash", 780_000),
    idle: new IdleTimeoutError("idle", 90_000),
    turn: new TurnTimeoutError(600_000),
    cancel: new wj.WorkerCancelledError(),
  };
  const old = {
    wall: "매니저 처리 시간 초과 (7200000ms wall-clock 상한) — 모델 거부 아님",
    tool: "도구 'Bash' 이(가) 780초 안에 응답하지 않아 턴을 중단했습니다.",
    toolLog: "[tool-hang] dashboard:default 도구 Bash 이(가) 780s 안에 안 끝나 **턴을 중단**합니다",
    idle: "LLM 응답 유휴 타임아웃 (idle, 90000ms 무수신) — 모델 거부 아님",
    turn: "턴 처리 시간 초과 (600000ms wall-clock 백스톱) — 모델 거부 아님",
    cancel: "매니저가 사용자 요청으로 취소됨 — 모델 거부 아님",
    pool: "llm-runtime: 모델 풀이 비어있음.",
    poolAll: "llm-runtime: 모든 어댑터 실패 — boom",
  };

  // ── ① ② 매니저 실패 분류(`failureKind` — 통지·로그 공용) ─────────────────────────────
  {
    const byText = {
      wall: wj.failureKind(fresh.wall.message),
      tool: wj.failureKind(fresh.tool.message),
      idle: wj.failureKind(fresh.idle.message),
      turn: wj.failureKind(fresh.turn.message),
      cancel: wj.failureKind(fresh.cancel.message),
      pool: wj.failureKind("llm-runtime: the model pool is empty."),
    };
    out.push(
      assert(
        "★새 영어 원문을 **문장만으로** 가른다(이름 없이 — 감싸진 오류·문자열 경로)",
        byText.wall === "wall" && byText.tool === "tool" && byText.idle === "idle" &&
          byText.turn === "timeout" && byText.cancel === "cancel" && byText.pool === "pool",
        byText,
      ),
    );
    const byOld = {
      wall: wj.failureKind(old.wall),
      tool: wj.failureKind(old.tool),
      toolLog: wj.failureKind(old.toolLog),
      idle: wj.failureKind(old.idle),
      turn: wj.failureKind(old.turn),
      cancel: wj.failureKind(old.cancel),
      pool: wj.failureKind(old.pool),
      poolAll: wj.failureKind(old.poolAll),
    };
    out.push(
      assert(
        "★옛 한국어 원문도 같은 분류(과거 기록)",
        byOld.wall === "wall" && byOld.tool === "tool" && byOld.toolLog === "tool" && byOld.idle === "idle" &&
          byOld.turn === "timeout" && byOld.cancel === "cancel" && byOld.pool === "pool" && byOld.poolAll === "pool",
        byOld,
      ),
    );
    const byName = {
      wall: wj.failureKind("unrelated text", fresh.wall.name),
      tool: wj.failureKind("unrelated text", fresh.tool.name),
      idle: wj.failureKind("unrelated text", fresh.idle.name),
      turn: wj.failureKind("unrelated text", fresh.turn.name),
      cancel: wj.failureKind("unrelated text", fresh.cancel.name),
      plain: wj.failureKind("unrelated text", "Error"),
    };
    out.push(
      assert(
        "★타입 이름이 있으면 문장과 무관하게 이름으로 가른다(모르는 이름은 문구로)",
        byName.wall === "wall" && byName.tool === "tool" && byName.idle === "idle" &&
          byName.turn === "timeout" && byName.cancel === "cancel" && byName.plain === "other",
        byName,
      ),
    );
    // 통지 문장 — 분류가 실제로 사용자 문장을 고른다(옛·새 둘 다 «멈춘 게 아니다»).
    const notice = {
      fresh: wj.humanizeWorkerError(fresh.wall.message),
      old: wj.humanizeWorkerError(old.wall),
      named: wj.humanizeWorkerError("unrelated text (3600000ms", "WorkerTimeoutError"),
    };
    out.push(
      assert(
        "매니저 실패 통지가 새·옛·이름 셋 다 wall-clock 문장을 고른다(시간 표기 포함)",
        notice.fresh.includes("2-hour wall-clock limit") && notice.old.includes("2-hour wall-clock limit") &&
          notice.named.includes("1-hour wall-clock limit"),
        notice,
      ),
    );
    // 이름이 **배선을 따라 실제로 도착하는가** — outcome → markFailed → 잡 레코드.
    const jobId = wj.registerJob({
      label: "회귀-이름배선",
      task: "t",
      channel: "http-bridge",
      threadKey: "regr:failure-name",
      channelUserId: "regr",
    });
    const fo = wj.failureOutcome(fresh.tool);
    const orig = console.error;
    console.error = (): void => {};
    try {
      wj.markFailed(jobId, "error" in fo ? fo.error : "", "error" in fo ? fo.errorName : undefined);
    } finally {
      console.error = orig;
    }
    const rec = wj.getJob(jobId);
    out.push(
      assert(
        "던져진 오류의 이름이 실패 outcome·잡 레코드까지 실린다",
        "error" in fo && fo.errorName === "ToolHangError" && rec?.errorName === "ToolHangError",
        { outcome: fo, recorded: rec?.errorName },
      ),
    );
    // ★끝까지 — `onWorkerComplete` 가 실제로 사용자에게 보내는 raw 통지가 **이름으로** 문장을 고르는가.
    //  (문장엔 분류 단서가 없고 시한만 있다 — 이름이 배선을 따라 안 오면 원문 덤프가 나간다.)
    const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
    const CH = "regr-failure-name";
    const raws: string[] = [];
    registerChannelOutbound(CH, { deliver: async (_t, text) => void raws.push(text), defaultOutboundTarget: async () => "regr-target" });
    wj.registerWorkerHandler(async () => {}); // 실패는 raw 직행 — 핸들러는 «등록돼 있다» 만 필요하다.
    const job2 = wj.registerJob({ label: "회귀-이름통지", task: "t", threadKey: `${CH}:1`, channel: CH, channelUserId: "regr" });
    // ★이벤트 배선 — self-growth 는 `worker.failed` 이벤트의 errorName 으로 묶는다. 상수로 박아도 초록이던 이음매(적대 검토 G4-b).
    const { getEventBus } = await import("../../core/eventbus.js");
    const failedNames: unknown[] = [];
    const unsub = getEventBus().subscribe((e) => { if (e.type === "worker.failed") failedNames.push((e.payload as { errorName?: unknown }).errorName); });
    console.error = (): void => {};
    try {
      await wj.onWorkerComplete(job2, { error: "unrelated text (3600000ms", errorName: "WorkerTimeoutError" });
      const job3 = wj.registerJob({ label: "회귀-이름이벤트", task: "t", threadKey: `${CH}:2`, channel: CH, channelUserId: "regr" });
      await wj.onWorkerComplete(job3, { error: "boom", errorName: "TypeError" });
    } finally {
      console.error = orig;
      unsub();
    }
    out.push(
      assert(
        "★매니저 실패 raw 통지가 배선을 따라 온 **이름**으로 원인 문장을 고른다",
        raws.length >= 1 && raws[0]!.includes("1-hour wall-clock limit"),
        raws,
      ),
    );
    out.push(
      assert(
        "★worker.failed 이벤트가 던져진 오류의 **실제** 이름을 싣는다(self-growth 가 그걸로 묶는다)",
        failedNames.join(",") === "WorkerTimeoutError,TypeError",
        failedNames,
      ),
    );
  }

  // ── ① ② 자가 점검의 턴 실패 요약(`describeTurnErrors` — DB 의 옛 기록도 읽는다) ─────────
  {
    const payload = (message: string, errorKind?: string): string =>
      JSON.stringify({ adapter: "codex", model: "m", threadKey: "dashboard:default", message, ...(errorKind ? { errorKind } : {}) });
    const timedOut = (s: string): boolean => s.includes("aborted/timed out");
    const got = {
      freshTurnNoKind: describeTurnErrors([payload(fresh.turn.message)]),
      freshWallNoKind: describeTurnErrors([payload(fresh.wall.message)]),
      freshIdleNoKind: describeTurnErrors([payload(fresh.idle.message)]),
      oldTurn: describeTurnErrors([payload(old.turn)]),
      oldWall: describeTurnErrors([payload(old.wall)]),
      kindOnly: describeTurnErrors([payload("boom", "timeout")]),
      plain: describeTurnErrors([payload("boom", "error")]),
      // ★넓힘 방지(적대 검토 G2·G3) — «time» 하나로 넓히면 «runtime» 이 걸리고, errorKind 조건을 넓히면 모델 거부도 시간 종료가 된다.
      poolEmpty: describeTurnErrors([payload("llm-runtime: the model pool is empty.", "error")]),
      rejected: describeTurnErrors([payload("Codex backend request failed: 404 model not found", "model_rejected")]),
    };
    out.push(
      assert(
        "★자가 점검이 새 영어·옛 한국어·발행 종류(errorKind) 어느 쪽으로도 시간 종료를 알아본다",
        timedOut(got.freshTurnNoKind) && timedOut(got.freshWallNoKind) && timedOut(got.freshIdleNoKind) &&
          timedOut(got.oldTurn) && timedOut(got.oldWall) && timedOut(got.kindOnly) && !timedOut(got.plain) &&
          !timedOut(got.poolEmpty) && !timedOut(got.rejected),
        got,
      ),
    );
  }

  // ── ① ② self-growth 의 매니저 실패 종류(`deriveWorkerErrorKind` — 이벤트의 옛 기록도 읽는다) ─
  {
    const got = {
      freshWall: deriveWorkerErrorKind(fresh.wall.message),
      freshTool: deriveWorkerErrorKind(fresh.tool.message),
      freshIdle: deriveWorkerErrorKind(fresh.idle.message),
      freshTurn: deriveWorkerErrorKind(fresh.turn.message),
      oldWall: deriveWorkerErrorKind(old.wall),
      oldTool: deriveWorkerErrorKind(old.tool),
      oldTurn: deriveWorkerErrorKind(old.turn),
      named: deriveWorkerErrorKind("unrelated text", "WorkerTimeoutError"),
      plain: deriveWorkerErrorKind("boom"),
      // ★운영 모양 — failureOutcome 은 모든 Error 에 이름을 싣는다(일반 오류도 "Error"). 이름이 있어도 매핑에 없으면 timeout 이 아니다(G4).
      plainNamed: deriveWorkerErrorKind("boom", "Error"),
      otherNamed: deriveWorkerErrorKind("pool empty", "ProviderUnavailableError"),
    };
    out.push(
      assert(
        "★self-growth 가 새 영어·옛 한국어·이름 셋 다 timeout 으로 묶는다(무관한 실패는 error)",
        got.freshWall === "timeout" && got.freshTool === "timeout" && got.freshIdle === "timeout" &&
          got.freshTurn === "timeout" && got.oldWall === "timeout" && got.oldTool === "timeout" &&
          got.oldTurn === "timeout" && got.named === "timeout" && got.plain === "error" &&
          got.plainNamed === "error" && got.otherNamed === "error",
        got,
      ),
    );
  }

  // ── ① ② ③ 자격 증명 부재(풀 간 폴백 판정) — 생성처는 실제 어댑터 가드 ────────────────────
  {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      OPENAI_CODEX_OAUTH_TOKEN: process.env.OPENAI_CODEX_OAUTH_TOKEN,
      OPENAI_CODEX_OAUTH_REFRESH: process.env.OPENAI_CODEX_OAUTH_REFRESH,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
    let codexErr: unknown;
    let claudeErr: unknown;
    try {
      const { ensureFreshAccessToken } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-auth.js");
      await ensureFreshAccessToken().catch((e: unknown) => {
        codexErr = e;
      });
      const claude = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
      // 가짜 SDK — 실모델 가드를 지나 **인증 가드**에서 멈추는지 본다(SDK 는 안 불린다).
      const fake = ((): never => {
        throw new Error("가짜 SDK 가 불렸다 — 인증 가드를 지나쳤다");
      }) as unknown as Parameters<typeof claude.withFakeClaudeQuery>[0];
      await claude
        .withFakeClaudeQuery(fake, () =>
          claude.runClaude({ text: "x", threadKey: "regr:auth", channel: "http-bridge" } as Parameters<typeof claude.runClaude>[0]),
        )
        .catch((e: unknown) => {
          claudeErr = e;
        });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const got = {
      codex: { name: codexErr instanceof Error ? codexErr.name : "-", msg: msg(codexErr) },
      claude: { name: claudeErr instanceof Error ? claudeErr.name : "-", msg: msg(claudeErr) },
    };
    out.push(
      assert(
        "★어댑터 자격 증명 가드가 이름 있는 오류를 던지고, 그 **문장만으로도** 부재로 읽힌다",
        rt.providerUnavailable(codexErr) && rt.providerUnavailable(claudeErr) &&
          rt.isProviderUnavailable(msg(codexErr)) && rt.isProviderUnavailable(msg(claudeErr)) &&
          !/[가-힣]/.test(msg(codexErr) + msg(claudeErr)),
        got,
      ),
    );
    const named = Object.assign(new Error("unrelated text"), { name: "ProviderUnavailableError" });
    out.push(
      assert(
        "자격 증명 부재: 옛 한국어 문장·openai 영어 문장·이름 셋 다 인정, 무관한 실패는 아님",
        rt.isProviderUnavailable("Claude 인증 없음. ANTHROPIC_API_KEY 또는 CLAUDE_CODE_OAUTH_TOKEN 이 필요합니다.") &&
          rt.isProviderUnavailable("OpenAI Codex OAuth 토큰 없음. `npm run codex-auth` 로 발급 필요.") &&
          rt.isProviderUnavailable("'openai' credentials missing — OPENAI_API_KEY is required.") &&
          rt.providerUnavailable(named) &&
          !rt.isProviderUnavailable("Codex backend request failed: 500 internal error") &&
          // ★넓힘 방지(10-05 적대 검토 G1) — «missing» 만 보면 요청 오류(400 Missing required parameter)가 «자격 증명 부재» 로 읽혀
          //  override 풀의 어댑터 결함이 기본 풀 폴백으로 가려진다.
          !rt.isProviderUnavailable('Codex backend request failed: 400 {"message":"Missing required parameter: input"}') &&
          !rt.isProviderUnavailable("tool argument missing: path"),
        "",
      ),
    );
  }

  // ── ① ② 모델 거부·인증 거부(codex HTTP 실패 문장) ───────────────────────────────────
  {
    const got = {
      rejNew: rt.isModelRejected('Codex backend request failed: 404 {"detail":"Not Found"}'),
      rejOld: rt.isModelRejected('Codex backend 호출 실패: 404 {"detail":"Not Found"}'),
      paramNew: rt.isModelRejected('Codex backend request failed: 400 {"error":{"param":"model","code":"invalid_value"}}'),
      paramOld: rt.isModelRejected('Codex backend 호출 실패: 400 {"error":{"param":"model","code":"invalid_value"}}'),
      authNew: isAuthRejected('Codex backend request failed: 401 {"code":"token_expired"}'),
      authOld: isAuthRejected('Codex backend 호출 실패: 401 {"code":"token_expired"}'),
      authSummaryNew: isAuthRejected("Codex summary request failed: 401 {}"),
    };
    out.push(
      assert(
        "codex HTTP 실패 문장 — 모델 거부·인증 거부를 새 영어·옛 한국어 둘 다 알아본다",
        Object.values(got).every((v) => v === true),
        got,
      ),
    );
  }

  // ── ④ 시간 종료 문장은 모델 거부가 아니다(폴백 오작동 방지 — TT-I3·I-3) ─────────────────────
  {
    const samples = [
      new wj.WorkerTimeoutError(404_000).message,
      new TurnTimeoutError(404_000).message,
      new IdleTimeoutError("first", 404_000).message,
      new ToolHangError("x", 404_000).message,
      new wj.WorkerCancelledError().message,
    ];
    const hits = samples.filter((s) => rt.isModelRejected(s) || isAuthRejected(s) || rt.isProviderUnavailable(s));
    out.push(
      assert(
        "시간 종료·취소 문장이 모델 거부·인증 거부·자격 증명 부재로 읽히지 않는다(시한에 404 가 껴도)",
        hits.length === 0,
        hits.length === 0 ? `${samples.length}개 모두 비매칭` : hits,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "failure-classifiers-bilingual",
  guards:
    "사용자에게 보이는 예외 원문을 영어로 바꾸면 한국어 정규식만 보던 분류기(매니저 실패 통지·로그·자가 점검·self-growth·풀 간 폴백)가 조용히 «기타» 로 무너지던 것 + 영어만 알아보게 하면 DB 의 옛 한국어 기록을 못 읽게 되는 것",
  run,
};
