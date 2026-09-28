/**
 * 회귀: **스케줄 이력 정책** — 매번 새로 시작 / 직전 N회만 / 계속(기본) (2026-09-26).
 *
 * ★사고(전체 검토 효율 감사): 매일 도는 스케줄이 `scheduler:<id>` 한 스레드에서 지난 발화를 전부 이어,
 *  아침 뉴스(21)의 Claude 첫 요청이 18만→29만 토큰으로 불었다. 하루 간격이라 캐시도 만료돼 매번 새로
 *  쓴다 — 스케줄이 입력의 12% 인데 캐시 제외 입력의 29%.
 *
 * 지키는 것(격리 저장소, 실제 함수):
 *  ① 경계 계산(순수) — 0 = 지금 · N = N번째 최근 발화 바로 앞 · 발화가 부족하면 자르지 않음
 *  ② 직전 N회만 — 그보다 오래된 발화는 재전송 이력에서 빠지고 최근 N회는 남는다(합성 턴은 발화로 안 센다)
 *  ③ 매번 새로 — 이력이 비고 Claude 이어가기·Codex 롤링 요약도 끊긴다(`/clear` 와 같은 세 걸음)
 *  ④ 기본(null)은 아무것도 안 건드린다
 *  ⑤ `/clear` 와 스케줄이 **같은 초기화 함수**를 지난다(두 벌이면 한쪽만 늙는다)
 */
import { readFileSync } from "node:fs";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { getContextBoundary, getSession, initStore, saveSession } from "../../store/sessions.js";
import { appendTranscript, indexCodexTurn, loadThreadHistory } from "../../store/memory.js";
import { getThreadSummary, upsertThreadSummary } from "../../store/thread-summaries.js";
import { applyScheduleHistory, keepRunsBoundary, resetThreadContext, scheduleRunStarts } from "../../store/thread-reset.js";
import { KEEP_RUNS_MAX, addSchedule, deleteSchedule, getSchedule, recordScheduleRun, scheduleRunTimes, updateSchedule } from "../../store/schedules.js";

export const check: RegressionCheck = {
  name: "schedule-history-policy",
  guards:
    "매일 도는 스케줄이 지난 발화를 전부 이어 첫 요청이 18만→29만 토큰으로 불고, 하루 간격이라 캐시도 못 타 매번 새로 쓰던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const ch = "scheduler" as const;
    const PROMPT = "아침 뉴스와 기술 레이더를 요약해서 보고하라 — 회귀용 합성 프롬프트";
    let ts = 1_900_000_000_000;
    const seed = (tk: string) => {
      const sid = `${tk}:sid`;
      indexCodexTurn({ channel: ch, threadKey: tk, claudeSessionId: sid });
      const starts: number[] = [];
      for (let run = 1; run <= 3; run++) {
        ts += 1000; starts.push(ts);
        // Claude 는 조립 접두(`<system-reminder>…</system-reminder>`)째 저장한다 — 걷고 세야 한다(재검토 M11).
        const body = `${PROMPT} (발화 ${run})`;
        appendTranscript({ claudeSessionId: sid, role: "user", content: run === 2 ? `<system-reminder>\n환경 정보\n</system-reminder>\n\n${body}` : body, ts });
        ts += 10;
        appendTranscript({ claudeSessionId: sid, role: "assistant", content: `보고 ${run}`, ts });
        ts += 10; // 매니저 완료 재주입 같은 합성 사용자 턴 — 발화로 세면 안 된다.
        // 재주입이 원래 작업을 **인용**한다 — «포함» 으로 세면 발화로 오인한다(싱크 레드팀 P2).
        appendTranscript({ claudeSessionId: sid, role: "user", content: `[내부] 작업 완료 알림 ${run} — 원래 작업: "${PROMPT}"`, ts });
      }
      saveSession({ channel: ch, threadKey: tk, claudeSessionId: sid, model: null, systemPromptHash: "hash" });
      upsertThreadSummary({ threadKey: tk, summary: "옛 요약", compactedThrough: 1 });
      return starts;
    };
    const texts = (tk: string) => loadThreadHistory(ch, tk).map((t) => t.content);

    // ② 직전 2회
    const tkN = "scheduler:regr-keep2";
    const startsN = seed(tkN);
    const appliedN = applyScheduleHistory(ch, tkN, PROMPT, 2, ts + 5000);
    const histN = texts(tkN);
    // ③ 매번 새로
    const tk0 = "scheduler:regr-fresh";
    seed(tk0);
    const now0 = ts + 5000;
    const applied0 = applyScheduleHistory(ch, tk0, PROMPT, 0, now0);
    // ④ 기본
    const tkC = "scheduler:regr-continue";
    seed(tkC);
    const appliedC = applyScheduleHistory(ch, tkC, PROMPT, null);

    const hashN = getSession(ch, tkN)?.systemPromptHash ?? null;
    // keep_runs 저장 왕복 — 조용히 null 로 떨어지면 정책이 «계속» 으로 돌아가고 비용이 원상 복귀한다.
    const sch = addSchedule({ label: "regr-keep", cronExpr: "0 8 * * *", prompt: PROMPT, destChannel: "cli", keepRuns: 2 });
    const r1 = getSchedule(sch.id)?.keepRuns;
    updateSchedule(sch.id, { keepRuns: 0 });
    const r2 = getSchedule(sch.id)?.keepRuns;
    updateSchedule(sch.id, { keepRuns: null });
    const r3 = getSchedule(sch.id)?.keepRuns;
    // `/clear` 는 경계를 **지금**으로 둔다(기본 인자) — 0 이면 Codex·OpenAI 이력을 안 끊는다.
    const tkClear = "dashboard:regr-clear";
    const t0 = Date.now();
    resetThreadContext(ch, tkClear);
    const clearBoundary = getContextBoundary(ch, tkClear);
    const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const runner = readFileSync(new URL("../../../plugins/scheduler/src/runner.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const applyAt = runner.indexOf("applyScheduleHistory(");
    const runAt = runner.indexOf("await deps.runClaude({", applyAt < 0 ? 0 : applyAt);
    const clearBlock = /if \(trimmed === "\/clear"\) \{[\s\S]*?\n  \}/.exec(index)?.[0] ?? "";

    // ⑥ 경계는 앞으로만(전체 검토 2026-09-28) — 사용자가 잘라 둔(/clear) 뒤 «직전 N회» 가 그보다 앞을 가리켜도 되돌리지 않는다.
    const tkB = "scheduler:regr-no-backward";
    seed(tkB);
    resetThreadContext(ch, tkB, ts + 100); // 세 발화 **뒤** 로 잘라 둠
    const cutAt = getContextBoundary(ch, tkB);
    upsertThreadSummary({ threadKey: tkB, summary: "잘린 뒤의 요약", compactedThrough: 1 });
    const appliedB = applyScheduleHistory(ch, tkB, PROMPT, 2, ts + 5000);
    // ⑦ 새 실행 없이 두 번 — 두 번째는 경계가 그대로라 아무것도 안 한다(요약·이어가기 보존).
    const tkT = "scheduler:regr-twice";
    seed(tkT);
    const firstT = applyScheduleHistory(ch, tkT, PROMPT, 2, ts + 5000);
    upsertThreadSummary({ threadKey: tkT, summary: "첫 적용 뒤 요약", compactedThrough: 1 });
    saveSession({ channel: ch, threadKey: tkT, claudeSessionId: `${tkT}:sid2`, model: null, systemPromptHash: "hash2" });
    const secondT = applyScheduleHistory(ch, tkT, PROMPT, 2, ts + 6000);
    // ⑧ 발화 시각 조회는 필요한 N 개에서 멈춘다.
    const limited = scheduleRunStarts(ch, tkT, PROMPT, 2);
    const all = scheduleRunStarts(ch, tkT, PROMPT);

    // ── 발화 기록(2026-09-28, Windows 리뷰 인계 1번) — 프롬프트를 고쳐도 «직전 N회» 가 먹는다 ──
    // ⑨ 발화 기록이 N개 이상이면 그것으로 — 옛 프롬프트로 남은 대화도 발화로 센다.
    const schP = addSchedule({ label: "regr-prompt-change", cronExpr: "0 8 * * *", prompt: PROMPT, destChannel: "cli", keepRuns: 2 });
    const tkP = `scheduler:${schP.id}`;
    const startsP = seed(tkP);
    for (const st of startsP) recordScheduleRun(schP.id, st - 5); // 발화 시작은 대화 행보다 앞선다
    const NEW_PROMPT = "완전히 새로 쓴 프롬프트 — 앞 40자가 옛 것과 전혀 다르다";
    const appliedP = applyScheduleHistory(ch, tkP, NEW_PROMPT, 2, ts + 5000, schP.id);
    const histP = texts(tkP);
    // 반대 방향(종전 결함의 재현): 기록 없이 프롬프트 일치만이면 새 프롬프트로는 발화를 못 찾아 안 자른다.
    const tkPOld = "scheduler:regr-prompt-change-old";
    seed(tkPOld);
    const appliedPOld = applyScheduleHistory(ch, tkPOld, NEW_PROMPT, 2, ts + 5000);
    // ⑩ 기록 기준이어도 경계는 앞으로만 — `/clear` 로 잘라 둔 것을 되살리지 않는다.
    const schQ = addSchedule({ label: "regr-log-clear", cronExpr: "0 8 * * *", prompt: PROMPT, destChannel: "cli", keepRuns: 2 });
    const tkQ = `scheduler:${schQ.id}`;
    for (const st of seed(tkQ)) recordScheduleRun(schQ.id, st - 5);
    resetThreadContext(ch, tkQ, ts + 100);
    const cutQ = getContextBoundary(ch, tkQ);
    const appliedQ = applyScheduleHistory(ch, tkQ, NEW_PROMPT, 2, ts + 5000, schQ.id);
    // ⑪ 기록이 N개보다 모자라면(배포 직후 기존 스케줄) 종전 방식으로 대신한다.
    const schR = addSchedule({ label: "regr-log-short", cronExpr: "0 8 * * *", prompt: PROMPT, destChannel: "cli", keepRuns: 2 });
    const tkR = `scheduler:${schR.id}`;
    const startsR = seed(tkR);
    recordScheduleRun(schR.id, startsR[2]! - 5);
    const appliedR = applyScheduleHistory(ch, tkR, PROMPT, 2, ts + 5000, schR.id);
    // ⑫ 기록은 스케줄마다 최근 KEEP_RUNS_MAX 개 · 스케줄을 지우면 같이 지운다.
    const schS = addSchedule({ label: "regr-log-bound", cronExpr: "0 8 * * *", prompt: PROMPT, destChannel: "cli" });
    for (let i = 1; i <= KEEP_RUNS_MAX + 5; i++) recordScheduleRun(schS.id, i);
    const kept = scheduleRunTimes(schS.id, 1_000);
    deleteSchedule(schS.id);
    const afterDelete = scheduleRunTimes(schS.id, 1_000);
    // ⑬ 러너 실경로: 대화가 남은 발화만, **발화 시작 시각**으로 적는다(실패·빈 답은 안 적는다).
    type RunnerMod = { runScheduleFiring: (schedule: unknown, bus: unknown, deps: unknown) => Promise<void> };
    const { runScheduleFiring } = await loadPluginModule<RunnerMod>("../../../plugins/scheduler/src/runner.ts");
    const { getEventBus } = await import("../../core/eventbus.js");
    const fire = async (reply: () => Promise<{ text: string }>, opts: { prompt?: string; dispatchFails?: boolean; deleteMidway?: boolean } = {}) => {
      const row = addSchedule({ label: "regr-runner-log", cronExpr: "0 8 * * *", prompt: opts.prompt ?? "러너 기록 시험 프롬프트", destChannel: "cli" });
      const before = Date.now();
      let calledAt = 0;
      await runScheduleFiring(row, getEventBus() as never, {
        // 응답이 시간이 걸린다 — 발화 **시작** 시각과 끝난 시각을 가르려고(끝난 시각으로 적으면 이 턴의 재주입이 경계 밖으로 샌다).
        runClaude: async () => { calledAt = Date.now(); if (opts.deleteMidway === true) deleteSchedule(row.id); await new Promise((r) => setTimeout(r, 25)); return reply(); },
        recordFiring: () => {},
        dispatch: async () => { if (opts.dispatchFails === true) throw new Error("합성 전달 실패"); },
        cwd: process.cwd(),
      });
      return { runs: scheduleRunTimes(row.id, 10), before, calledAt };
    };
    const okFire = await fire(async () => ({ text: "보고" }));
    const failFire = await fire(async () => { throw new Error("합성 실패"); });
    const emptyFire = await fire(async () => ({ text: "" }));
    // 적대 검토 G1·G2·P5-b — 전달 실패여도 대화는 남았으니 적는다 · `!say` 직송은 대화가 없으니 안 적는다 · 발화 도중 지운 스케줄은 안 적는다.
    const dispatchFailFire = await fire(async () => ({ text: "보고" }), { dispatchFails: true });
    const sayFire = await fire(async () => ({ text: "안 불림" }), { prompt: "!say 고정 문구" });
    const deletedFire = await fire(async () => ({ text: "보고" }), { deleteMidway: true });

    return [
      assert("★⑨ 프롬프트를 고쳐도 «직전 N회» 가 먹는다 — 발화 기록의 N번째 발화 앞에서 끊는다",
        appliedP !== null && appliedP.source === "log" && appliedP.kept === 2 && appliedP.boundary === startsP[1]! - 5 - 1 &&
          !histP.some((t) => t.includes("(발화 1)")) && histP.some((t) => t.includes("(발화 2)")),
        { appliedP, histP }),
      assert("반대 방향: 기록 없이 프롬프트 일치만이면 새 프롬프트로 발화를 못 찾는다(고친 결함이 여기 있었다)", appliedPOld === null, appliedPOld),
      assert("★⑩ 기록 기준이어도 경계는 앞으로만 — 잘라 둔 이력을 되살리지 않는다", appliedQ === null && getContextBoundary(ch, tkQ) === cutQ, { appliedQ, cutQ }),
      assert("⑪ 기록이 N개보다 모자라면 종전 방식(프롬프트 일치)으로 대신한다", appliedR !== null && appliedR.source === "prompt" && appliedR.boundary === startsR[1]! - 1, appliedR),
      assert("⑫ 기록은 스케줄마다 최근 KEEP_RUNS_MAX 개만 · 스케줄을 지우면 같이 지운다",
        kept.length === KEEP_RUNS_MAX && kept[0] === KEEP_RUNS_MAX + 5 && afterDelete.length === 0, { kept: kept.length, newest: kept[0], afterDelete }),
      assert("★⑬ 러너: 대화가 남은 발화만 발화 시작 시각으로 적는다 — 실패·빈 답은 안 적는다",
        okFire.runs.length === 1 && okFire.runs[0]! >= okFire.before && okFire.runs[0]! <= okFire.calledAt && failFire.runs.length === 0 && emptyFire.runs.length === 0,
        { ok: okFire, fail: failFire.runs, empty: emptyFire.runs }),
      assert("⑭ 전달만 실패한 발화는 적는다(대화는 남았다) · `!say` 직송은 안 적는다 · 발화 도중 지운 스케줄은 안 적는다",
        dispatchFailFire.runs.length === 1 && sayFire.runs.length === 0 && deletedFire.runs.length === 0,
        { dispatchFail: dispatchFailFire.runs, say: sayFire.runs, deleted: deletedFire.runs }),
      assert("⑮ «매번 새로» 는 출처를 기록이라 적지 않는다", applied0?.source === "fresh", applied0),
      assert("★⑥ 경계는 앞으로만 — `/clear` 뒤 «직전 N회» 가 그보다 앞을 가리켜도 되돌리지 않고 요약도 지우지 않는다",
        appliedB === null && getContextBoundary(ch, tkB) === cutAt && getThreadSummary(tkB)?.summary === "잘린 뒤의 요약",
        { appliedB, boundary: getContextBoundary(ch, tkB), cutAt, summary: getThreadSummary(tkB)?.summary }),
      assert("★⑦ 새 실행 없이 다시 적용하면 아무것도 안 한다 — 요약·Claude 이어가기 보존",
        firstT !== null && secondT === null && getThreadSummary(tkT)?.summary === "첫 적용 뒤 요약" && getSession(ch, tkT)?.systemPromptHash === "hash2",
        { firstT, secondT, summary: getThreadSummary(tkT)?.summary, hash: getSession(ch, tkT)?.systemPromptHash }),
      assert("⑧ 발화 시각 조회는 N 개에서 멈춘다(전 기록을 읽지 않는다) · 순서·값은 전체 조회의 앞부분과 같다",
        limited.length === 2 && all.length >= 3 && limited[0] === all[0] && limited[1] === all[1], { limited, all }),
      assert(
        "① 경계 — 0=지금 · N=N번째 최근 발화 바로 앞 · 부족하면 자르지 않음",
        keepRunsBoundary([30, 20, 10], 0, 99) === 99 && keepRunsBoundary([30, 20, 10], 2, 99) === 19 &&
          keepRunsBoundary([30, 20], 3, 99) === null,
        JSON.stringify([keepRunsBoundary([30, 20, 10], 0, 99), keepRunsBoundary([30, 20, 10], 2, 99), keepRunsBoundary([30, 20], 3, 99)]),
      ),
      assert(
        "★② 직전 2회만 — 첫 발화는 빠지고 둘째·셋째는 남는다(합성 턴은 발화로 안 셈)",
        appliedN?.kept === 2 && appliedN.boundary === startsN[1]! - 1 &&
          !histN.some((t) => t.includes("(발화 1)")) && histN.some((t) => t.includes("(발화 2)")) && histN.some((t) => t.includes("(발화 3)")),
        JSON.stringify({ appliedN, histN }),
      ),
      assert("② 직전 N회만일 때도 Claude 이어가기를 끊는다(안 끊으면 resume 이 옛 이력을 통째로 실어 온다)", hashN === null, `hash=${String(hashN)}`),
      assert("keep_runs 저장 왕복 — 추가·수정·되돌리기가 그대로 읽힌다", r1 === 2 && r2 === 0 && r3 === null, JSON.stringify([r1, r2, r3])),
      assert("`/clear` 경계는 지금(기본 인자) — 0 이면 Codex·OpenAI 이력을 안 끊는다", clearBoundary >= t0 && clearBoundary <= Date.now(), `경계=${clearBoundary} (호출 ${t0})`),
      assert(
        "★③ 매번 새로 — 이력이 비고 Claude 이어가기·Codex 롤링 요약도 끊긴다",
        applied0?.boundary === now0 && texts(tk0).length === 0 &&
          getSession(ch, tk0)?.systemPromptHash == null && getThreadSummary(tk0) === undefined,
        JSON.stringify({ applied0, hist: texts(tk0).length, hash: getSession(ch, tk0)?.systemPromptHash, summary: getThreadSummary(tk0) ?? null }),
      ),
      assert(
        "④ 기본(null)은 아무것도 안 건드린다",
        appliedC === null && getContextBoundary(ch, tkC) === 0 && texts(tkC).length === 9 && getSession(ch, tkC)?.systemPromptHash === "hash",
        JSON.stringify({ appliedC, boundary: getContextBoundary(ch, tkC), hist: texts(tkC).length }),
      ),
      assert(
        "⑥ 스케줄 실행기가 **발화 직전**(runClaude 앞)에 정책을 적용하고 keepRuns 를 **그때 새로 읽으며**, 발화 기록을 볼 스케줄 id 를 넘긴다",
        applyAt > 0 && runAt > applyAt && /\(getSchedule\(schedule\.id\) \?\? schedule\)\.keepRuns,\s*Date\.now\(\),\s*schedule\.id,?\s*\)/.test(runner.slice(applyAt, runAt)),
        `적용=${applyAt} 발화=${runAt}`,
      ),
      assert(
        "⑤ `/clear` 는 스케줄과 같은 초기화 함수(resetThreadContext)를 지난다",
        /resetThreadContext\(sidChannel, msg\.threadKey\)/.test(clearBlock) && !/setContextBoundary\(/.test(clearBlock),
        clearBlock === "" ? "★/clear 분기를 못 찾음" : clearBlock.slice(0, 120).replace(/\s+/g, " "),
      ),
    ];
  },
};
