/**
 * 회귀: **삼킨 실패가 화면과 저장본 양쪽에 온전히 남는다** — ★행동 게이트 (2026-08-08).
 *
 * 이 자리에서 하루에 **사용자 대면 결함이 세 번** 났고, 세 번 다 회귀는 초록이었다:
 *  ①`finalText` 덮어쓰기 → 화면엔 **잘린 문장만**(조기 종료와 구분 불가)
 *  ②원시 `closeSegment()` 로 **세그먼트를 훔침** → 그 턴 텍스트가 통째로 사라지고 도구만 남음
 *  ③택일→결합으로 바꾸며 stall 재시도의 **중복 문단**을 저장본에 들여놓음
 *
 * ★검사가 매번 초록이었던 이유는 하나다 — **소스 정규식이었다.** 어댑터 한복판의 인라인
 *  로직은 "무엇이 화면에 가고 무엇이 저장되나" 를 **실행으로 물어볼 수가 없다.** 레드팀이
 *  `if (process.env.X === "1") { …발행… }` 한 줄로 8개 단언을 전부 통과시켜 증명했다.
 *
 * 그래서 판정을 `composeSwallowedFailure`(순수)로 뽑고, 여기서 **실제 입력을 넣어 결과를
 * 본다**. 위 세 결함은 전부 이 함수의 입출력으로 표현되므로 재발하면 빨간불이 된다.
 *
 * ★남은 한계(정직하게): 어댑터가 그 판정을 **실제로 쓰는지**는 여전히 소스 검사다. 닫으려면
 *  어댑터를 실행해야 하고 그건 SDK·네트워크가 필요하다. 아래 `[린트]` 표시가 붙은 단언은
 *  **우연한 드리프트는 잡지만 적은 못 막는다** — 등급을 적어 다음 사람이 속지 않게 한다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "swallowed-failure-visible",
  guards:
    "삼킨 실패의 화면·저장본 구성 — 잘린 문장만 남거나, 텍스트가 사라지거나, 중복되지 않게",
  run: async (): Promise<Assertion[]> => {
    const { composeSwallowedFailure, presentFailure } = await import(
      "../../core/llm-runtime/swallowed-failure.js"
    );
    const { withPartialReport, partialReportOf, markReplayBlocked, replayBlockOf, withFailureNotice, failureNoticeOf } = await import("../../core/llm-runtime/partial-failure.js");
    const { classifyCooldown } = await import("../../core/llm-runtime/rate-limit.js");
    const extra: Assertion[] = [];
    const entry = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const start = entry.indexOf("    const failText = withResumeNote(");
    const end = entry.indexOf("    // ★StopFailure 훅", start);
    const replyBlock = entry.slice(start, end);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const [raw, kind] of [["429 usage_limit_reached", "limit"], ["401 Unauthorized", "auth"], ["terminated", null]] as const) {
      const secret = ["sk", "regrSecret1234567890abcdef"].join("-");
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      const original = Object.assign(new Error(raw, { cause }), { name: raw === "terminated" ? "TypeError" : "Error" });
      const rawName = original.name;
      const same = withPartialReport(original, `partial ${secret}`);
      withFailureNotice(original, `try again in a moment ${secret}`);
      markReplayBlocked(original, `Tools had already started running: Read ${secret}`);
      const shown = presentFailure(original, raw);
      extra.push(assert(`${raw}: original identity/name/message/cause/classification unchanged; metadata separate`,
        same === original && same.name === rawName && same.message === raw && same.cause === cause && classifyCooldown(same, same.message) === kind &&
        partialReportOf(same) === `partial ${secret}` && replayBlockOf(same)?.includes("Read") === true && failureNoticeOf(same)?.includes("try again") === true,
        { identity: same === original, name: same.name, message: same.message, causeSame: same.cause === cause, classification: classifyCooldown(same, same.message), partial: partialReportOf(same), replay: replayBlockOf(same), notice: failureNoticeOf(same) }));
      extra.push(assert(`${raw}: actual presentation preserves partial/guidance/replay and redacts every part`,
        shown.includes("Incomplete partial report") && shown.includes("partial") && shown.includes(raw) && shown.includes("try again in a moment") && shown.includes("Read") && !shown.includes(secret) && shown.includes("REDACTED"), shown));
      const delivered: Array<{ text: string; failed?: boolean }> = [];
      const deps = { e: same, detail: raw, errName: rawName, presentFailure,
        withResumeNote: (s: string) => s, formatRegionAError: (s: string) => s, noteTurnLimitStop: () => undefined,
        msg: { threadKey: "regr:failure-display" }, egressTargets: [], bus: {},
        replyCommand: async (_msg: unknown, text: string, opts: { turnFailed?: boolean }) => { delivered.push({ text, failed: opts.turnFailed }); return "origin"; },
        fanOutEgress: async (_targets: unknown, text: string) => { delivered.push({ text }); },
      };
      await new AsyncFunction(...Object.keys(deps), replyBlock)(...Object.values(deps));
      extra.push(assert(`${raw}: actual daemon catch reply and egress both use sanitized presentation, still failed`,
        start > 0 && end > start && delivered.length === 2 && delivered[0]?.failed === true && delivered.every(x => x.text === shown), delivered));
    }
    const plain = new Error("plain failure");
    extra.push(assert("unrelated errors never inherit another error's metadata; plain display unchanged", partialReportOf(plain) === undefined && replayBlockOf(plain) === undefined && failureNoticeOf(plain) === undefined && presentFailure(plain, plain.message) === plain.message, { partial: partialReportOf(plain), replay: replayBlockOf(plain), notice: failureNoticeOf(plain), shown: presentFailure(plain, plain.message) }));
    // Execute the actual worker outcome/harvest/report slices without importing the SDK/runtime.
    const ts = await import("typescript");
    const worker = await readFile(new URL("../../core/worker-jobs.ts", import.meta.url), "utf8");
    const outcomeStart = worker.indexOf("export const failureOutcome =");
    const outcomeEnd = worker.indexOf("/** Persist/display", outcomeStart);
    const reportStart = worker.indexOf("const failedReport =", outcomeEnd);
    const reportEnd = worker.indexOf("export interface WorkerJobRecord", reportStart);
    const compile = (source: string): string => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");
    const workerFns = new Function("partialReportOf", "failureNoticeOf", "replayBlockOf", "resumeAtOf", "redactSecrets",
      compile(worker.slice(outcomeStart, outcomeEnd).replace("export ", "") + worker.slice(reportStart, reportEnd)) + "return { failureOutcome, failedReport };")(
      partialReportOf, failureNoticeOf, replayBlockOf, () => undefined, redactSecrets);
    const registry = await readFile(new URL("../../core/llm-runtime/capabilities/worker-registry.ts", import.meta.url), "utf8");
    const caughtStart = registry.indexOf("            harvestFailure = e instanceof Error");
    const caughtEnd = registry.indexOf("            break;", caughtStart);
    const composeStart = registry.indexOf("        const report = composeWorkerReport(mainText, harvestTexts);");
    const composeEnd = registry.indexOf("              };", composeStart) + "              };".length;
    const harvestDeclStart = registry.indexOf("      let harvestFailure: string | undefined;");
    const harvestDeclEnd = registry.indexOf("      // ─── ★소환자", harvestDeclStart);
    const harvest = new Function("e", "failureOutcome", "composeWorkerReport", compile(
      registry.slice(harvestDeclStart, harvestDeclEnd) + "let outcome;" +
      "const mainText = '[COMPLETE]'; const harvestTexts = [];" +
      registry.slice(caughtStart, caughtEnd) + registry.slice(composeStart, composeEnd) + "return outcome;"));
    const secret = ["sk", "workerSecret1234567890abcdef"].join("-");
    const workerError = withPartialReport(new TypeError("fetch failed"), `[PARTIAL] ${secret}`);
    withFailureNotice(workerError, `try again in a moment ${secret}`);
    const first = workerFns.failureOutcome(workerError);
    const harvested = harvest(workerError, workerFns.failureOutcome, (text: string) => text);
    for (const [lane, outcome] of [["first/agent", first], ["harvest", harvested]] as const) {
      const report = workerFns.failedReport(outcome);
      extra.push(assert(`${lane}: actual worker slices preserve failed outcome, raw classification, partial/guidance and redact output`,
        outcome.error === "fetch failed" && outcome.errorName === "TypeError" && !("result" in outcome) &&
        outcome.partialReport === `[PARTIAL] ${secret}` && outcome.failureNotice === `try again in a moment ${secret}` &&
        typeof report === "string" && report.includes("Incomplete partial report") && report.includes("[PARTIAL]") && report.includes("try again in a moment") && !report.includes(secret) && report.includes("[REDACTED]") &&
        (lane !== "harvest" || report.includes("[COMPLETE]")), { outcome, report }));
    }
    // Parent text/raw is a distinct display boundary: persistence redaction alone is insufficient.
    const parentStart = worker.indexOf("const summonerDeliveryText =");
    const parentEnd = worker.indexOf("/**", worker.indexOf("const deliverToSummoner =", parentStart));
    const deliveries: Array<{ text: string; raw: string }> = [];
    const steerAttempts: Array<{ message: string }> = [];
    const parentFns = new Function("failedReport", "redactSecrets", "parentJobIdOf", "jobs", "jobResultChannels", "publishSteerAttempt",
      compile(worker.slice(parentStart, parentEnd)) + "return { summonerDeliveryText, deliverToSummoner };")(
      workerFns.failedReport, redactSecrets, () => "parent", new Map([["parent", { status: "running" }]]),
      new Map([["parent", { push: (item: { text: string; raw: string }) => { deliveries.push(item); return true; } }]]),
      (item: { message: string }) => steerAttempts.push(item));
    const markStart = worker.indexOf("    markFailed(\n", worker.indexOf("const deliverCompletionInner ="));
    const markEnd = worker.indexOf("    // ★한도 자동 이어가기", markStart);
    const persist = new Function("outcome", "failedReport", "redactSecrets", compile(
      "const jobId = 'review-fix'; let stored; const markFailed = (_id, error, errorName, result) => { stored = { label: 'review-fix', status: 'failed', error, errorName, result }; };" +
      worker.slice(markStart, markEnd) + "return stored;"));
    const noticeStart = worker.indexOf("export const renderJobNotice =");
    const noticeEnd = worker.indexOf("/** 작업자가 끝난 뒤", noticeStart);
    // Execute the real renderer + builder with an identity cause presenter (no DB/SDK/sender).
    const { translate } = await import("../../core/i18n.js");
    const notice = new Function("translate", "failureCauseOf", compile(
      worker.slice(noticeStart, noticeEnd).replace("export ", "")) + "return buildRawNotice;")(
      translate, (n: { error?: string }) => ({ cause: n.error ?? "" }));
    const failureKindStart = worker.indexOf("export const failureKind =");
    const failureKindEnd = worker.indexOf("/** 로그 줄의 분류", failureKindStart);
    const failureKind = new Function("FAILURE_KIND_BY_NAME", "isRateLimited", compile(
      worker.slice(failureKindStart, failureKindEnd).replace("export ", "")) + "return failureKind;")(
      { WorkerTimeoutError: "wall" }, (raw: string) => classifyCooldown(new Error(raw), raw) === "limit");
    extra.push(assert("worker review-fix source slice boundaries are all present", [parentStart, parentEnd, markStart, markEnd, noticeStart, noticeEnd, failureKindStart, failureKindEnd, harvestDeclStart, harvestDeclEnd].every(n => n > 0), { parentStart, parentEnd, markStart, markEnd, noticeStart, noticeEnd, failureKindStart, failureKindEnd, harvestDeclStart, harvestDeclEnd }));
    const rawSecret = "workerSyntheticToken_20261110_0123456789abcdef";
    const rawMessage = `429 usage_limit_reached Bearer ${rawSecret}`;
    const unsafeReason = `Tool 'Write' had already started running; replay could apply the side effect twice. Bearer ${rawSecret}`;
    for (const mode of ["empty-report", "with-report", "replay-only", "harvest"] as const) {
      const cause = new Error("synthetic network cause");
      const original = Object.assign(new Error(rawMessage, { cause }), { name: "WorkerTimeoutError" });
      if (mode === "with-report" || mode === "harvest") {
        withPartialReport(original, `[PARTIAL] Bearer ${rawSecret}`);
        withFailureNotice(original, `try again in a moment Bearer ${rawSecret}`);
      }
      if (mode !== "empty-report") markReplayBlocked(original, unsafeReason);
      const outcome = mode === "harvest" ? harvest(original, workerFns.failureOutcome, (text: string) => text) : workerFns.failureOutcome(original);
      const stored = persist(outcome, workerFns.failedReport, redactSecrets);
      const noticeText = notice(stored);
      const job = { label: "review-fix", status: "failed", threadKey: "worker:parent:child", resultDelivered: false };
      deliveries.length = 0; steerAttempts.length = 0;
      const delivered = parentFns.deliverToSummoner(job, outcome);
      const pushed = deliveries[0];
      extra.push(assert(`${mode}: raw Error identity/name/message/cause and worker classification stay separate from display`,
        original.message === rawMessage && original.name === "WorkerTimeoutError" && original.cause === cause && outcome.error === rawMessage && outcome.errorName === original.name && !('result' in outcome) &&
        failureKind(outcome.error, outcome.errorName) === "wall" && failureKind(outcome.error) === "limit" &&
        partialReportOf(original) === outcome.partialReport && failureNoticeOf(original) === outcome.failureNotice && replayBlockOf(original) === outcome.replayBlock,
        { raw: original.message, identity: original.cause === cause, outcome, namedKind: failureKind(outcome.error, outcome.errorName), rawKind: failureKind(outcome.error) }));
      extra.push(assert(`${mode}: actual parent box text/raw and steer attempt redact the raw error, not just the stored copy`,
        delivered === true && job.resultDelivered && deliveries.length === 1 && pushed?.text === pushed?.raw && steerAttempts.length === 1 && steerAttempts[0]?.message === pushed?.text &&
        [pushed?.text, pushed?.raw, steerAttempts[0]?.message, stored.error, noticeText].every(s => typeof s === "string" && !s.includes(rawSecret) && s.includes("REDACTED")),
        { delivered, stored, pushed, steerAttempts, noticeText }));
      if (mode !== "empty-report") {
        const allEvidence = [workerFns.failedReport(outcome), stored.result, pushed?.text, pushed?.raw, noticeText];
        extra.push(assert(`${mode}: specific unsafe tool and twice-applied reason survive worker report, notice and parent delivery`,
          outcome.replayBlock === unsafeReason && allEvidence.every(s => typeof s === "string" && s.includes("[Tool replay blocked]") && s.includes("'Write'") && s.includes("side effect twice") && !s.includes(rawSecret)), allEvidence));
        if (mode !== "replay-only") extra.push(assert(`${mode}: partial + notice + replay remain distinct and preserved together; harvest retains completed report too`,
          outcome.partialReport === `[PARTIAL] Bearer ${rawSecret}` && outcome.failureNotice === `try again in a moment Bearer ${rawSecret}` &&
          allEvidence.every(s => s.includes("Incomplete partial report") && s.includes("[PARTIAL]") && s.includes("try again in a moment") && (mode !== "harvest" || s.includes("[COMPLETE]"))), { outcome, allEvidence }));
      } else extra.push(assert("empty-report: no fabricated report or metadata on stored/parent/notice branch", stored.result === undefined && workerFns.failedReport(outcome) === undefined && pushed?.text.includes("보고 보존") === false && outcome.replayBlock === undefined, { outcome, stored, pushed }));
    }
    const { createReplayGuard, canReplay, replayBlockedReason } = await import("../../core/llm-runtime/replay-safety.js");
    const adapterSource = await readFile(new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url), "utf8");
    const rethrowStart = adapterSource.indexOf("    const rethrow = (err: unknown): never => {");
    const rethrowEnd = adapterSource.indexOf("    // ★실패·취소로 끝난 턴도", rethrowStart);
    for (const raw of ["Codex backend request failed: 429 usage_limit_reached", "Codex backend request failed: 401 invalid_api_key"]) {
      const guard = createReplayGuard(); guard.unsafe = true; guard.firstTool = "Write";
      const original = new Error(raw, { cause: new Error("synthetic cause") });
      const deps = { input: { replay: guard, threadKey: "regr:rethrow" }, steeringLedger: { giveBack: () => 0 },
        sideEffectExecuted: true, toolHandlingStarted: true, nativeStreamAccepted: false, responseEmitted: false,
        executedToolNames: new Set(["Write"]), finalText: "[PARTIAL]", closeTextSegment: () => undefined, streamedInFlight: "",
        partialReportOf, composeSwallowedFailure, CodexBackendFailureError: class extends Error {}, failureNoticeOf, withFailureNotice,
        translate: () => "", codexFailureAdvice: () => "", withPartialReport };
      const rethrow = new Function(...Object.keys(deps), compile(adapterSource.slice(rethrowStart, rethrowEnd)) + "return rethrow;")(...Object.values(deps));
      let caught: unknown;
      try { rethrow(original); } catch (e) { caught = e; }
      const blocked = replayBlockedReason(guard);
      markReplayBlocked(caught, blocked);
      extra.push(assert(`${raw}: actual adapter rethrow preserves Error, partial and specific unsafe-tool replay metadata`,
        caught === original && original.message === raw && original.cause instanceof Error && original.cause.message === "synthetic cause" &&
        partialReportOf(caught) === "[PARTIAL]" && !canReplay(guard) && blocked.includes("'Write' had already started running") && replayBlockOf(caught) === blocked && presentFailure(caught, raw).includes(blocked),
        { identity: caught === original, raw: original.message, cause: String(original.cause), partial: partialReportOf(caught), replay: replayBlockOf(caught), canReplay: canReplay(guard) }));
    }
    const N = "요청 처리 중 오류가 발생했습니다 — terminated";

    // ①덮어쓰기 금지 — 화면에 있던 것이 저장본에도 있어야 한다.
    const cut = composeSwallowedFailure("", "네. M6-a 부터 시작하겠습니다", N);
    // ②다중 iteration — 앞 조각이 버려지면 안 된다(택일 시절의 결함).
    const multi = composeSwallowedFailure("T1 결과 정리", "T2 진행 중", N);
    // ③stall 재시도 중복 — 재전송이 앞부분을 다시 냈다. 한 번만 남아야 한다.
    const dup = composeSwallowedFailure("앞부분", "앞부분 그리고 뒷부분", N);
    // ④빈 턴 — 안내만.
    const empty = composeSwallowedFailure("", "", N);

    const src = await readFile(
      new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url),
      "utf8",
    );
    // ★창을 쓰지 않는다. 고정 바이트 창은 본문이 자라면 뒷부분을 조용히 놓치고(방금 그렇게
    //  걸렸다), 중괄호 균형은 본문 안 정규식 리터럴에 부서진다(레드팀 실증). **행동은 위
    //  순수 함수가 지키므로** 아래 린트는 파일 전체에서 공존만 본다 — 창 관리가 필요 없다.
    const body = src.replace(/\/\/[^\n]*/g, "");

    return [
      ...extra,
      assert(
        "★화면에 나간 텍스트가 저장본에 **남는다**(덮어쓰기 금지 — 잘린 문장만 남던 사고)",
        cut.saved.startsWith("네. M6-a 부터 시작하겠습니다") && cut.saved.includes(N),
        cut.saved.slice(0, 40),
      ),
      assert(
        "★이미 나간 조각은 **다시 안 보낸다**(중복 렌더 0) — delta 엔 안내만",
        cut.deltaText.trim() === N && !cut.deltaText.includes("M6-a"),
        JSON.stringify(cut.deltaText).slice(0, 40),
      ),
      assert(
        "★다중 iteration 에서 앞 조각이 안 버려진다(택일 시절 결함)",
        multi.saved.includes("T1 결과 정리") && multi.saved.includes("T2 진행 중"),
        multi.saved.slice(0, 40),
      ),
      assert(
        "★stall 재시도 중복이 저장본에 안 들어간다(결합으로 바꾸며 새로 연 창)",
        (dup.saved.match(/앞부분/g) ?? []).length === 1 && dup.saved.includes("뒷부분"),
        `앞부분 ${(dup.saved.match(/앞부분/g) ?? []).length}회`,
      ),
      assert(
        "빈 턴이면 안내만(구분선 없이)",
        empty.saved === N && empty.deltaText === N && empty.shown === "",
        empty.saved.slice(0, 30),
      ),
      assert(
        "[린트] 어댑터가 그 판정을 쓴다(직접 조립으로 되돌아가지 않게)",
        /composeSwallowedFailure\(/.test(body) && /const failure = withPartialReport\(e, view\.shown\);\s+withFailureNotice\(failure, notice\);\s+rethrow\(failure\);/.test(body),
        body.match(/const failure = withPartialReport[\s\S]*?rethrow\(failure\);/)?.[0],
      ),
      assert(
        "[린트] 원시 closeSegment 는 **헬퍼 안에서만**(세그먼트 훔치기 금지)",
        // 정상 호출은 `closeTextSegment()` 정의 안 **딱 1회**다(뽑기와 발행이 한 몸).
        // 그 밖에서 부르면 버퍼만 비워 대시보드 턴 뷰의 텍스트가 사라진다(실측 사고).
        (body.match(/deltaStream\.closeSegment\(\)/g) ?? []).length === 1,
        `원시 호출 ${(body.match(/deltaStream\.closeSegment\(\)/g) ?? []).length}회`,
      ),
      assert(
        "★★[린트] 매니저·에이전트 턴에서도 **흘러나온 텍스트를 싣는다** — `deltaStream` 은 `depth===0 && workerDepth===0` 에서만 켜지므로, 폴백이 없으면 매니저의 부분 보고가 통째로 사라진다(2026-09-01 실측: iter=15 에서 끊긴 매니저가 3,859자를 잃고 `shown=0자`)",
        /closeTextSegment\(\) \?\? streamedInFlight/.test(body) &&
          // 시도마다 초기화한다 — stall 재개는 같은 body 를 재전송해 텍스트를 처음부터 다시
          // 내므로, 누적하면 답장에 같은 문단이 두 번 실린다. 초기화가 SSE 호출 **직전**인지 본다.
          // ★함수 **이름**이 아니라 «초기화가 SSE 호출 직전인가» 를 본다 — 파서를 감싸는
          //  이름이 바뀌어도(`parseCodexSseObserved`) 성질은 같다.
          // ★2026-10-10: 서버 끊김 뒤 «이어 쓰기» 시도는 앞에 흘린 글(`carriedText`)을 안고 시작한다 — 그 외엔 빈 값이다(같은 성질:
          //  이 시도의 시작점으로 되돌린다). 그래서 초기값이 `carriedText` 인지, 그리고 그 사이에 파서 호출 말고 다른 대입만 있는지 본다.
          /streamedInFlight = carriedText;(?:\s*\n\s*\w+ = [^;\n]+;)*\s*\n\s*sseResult = await parseCodexSse\w*\(/.test(body) &&
          /let carriedText = "";/.test(body) &&
          // 그 버퍼를 실제로 채우는가 — 선언만 있고 안 채우면 폴백이 늘 빈 문자열이다.
          /streamedInFlight \+= delta;/.test(body),
        "폴백·시도별 초기화·적재 셋 다 확인",
      ),
      assert(
        "[린트] 삼키기 전에 판정 수치와 함께 로그를 남긴다",
        /codex-swallowed/.test(body) &&
          /iter=\$\{iteration\}/.test(body) &&
          /shown=\$\{view\.shown\.length\}/.test(body),
        "iter·tools·shown",
      ),
    ];
  },
};
