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
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { getContextBoundary, getSession, initStore, saveSession } from "../../store/sessions.js";
import { appendTranscript, indexCodexTurn, loadThreadHistory } from "../../store/memory.js";
import { getThreadSummary, upsertThreadSummary } from "../../store/thread-summaries.js";
import { applyScheduleHistory, keepRunsBoundary, resetThreadContext } from "../../store/thread-reset.js";
import { addSchedule, getSchedule, updateSchedule } from "../../store/schedules.js";

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

    return [
      assert(
        "① 경계 — 0=지금 · N=N번째 최근 발화 바로 앞 · 부족하면 자르지 않음",
        keepRunsBoundary([30, 20, 10], 0, 99) === 99 && keepRunsBoundary([30, 20, 10], 2, 99) === 19 &&
          keepRunsBoundary([30, 20], 3, 99) === null,
        JSON.stringify([keepRunsBoundary([30, 20, 10], 0, 99), keepRunsBoundary([30, 20, 10], 2, 99), keepRunsBoundary([30, 20], 3, 99)]),
      ),
      assert(
        "★② 직전 2회만 — 첫 발화는 빠지고 둘째·셋째는 남는다(합성 턴은 발화로 안 셈)",
        appliedN?.runs === 3 && appliedN.boundary === startsN[1]! - 1 &&
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
        "⑥ 스케줄 실행기가 **발화 직전**(runClaude 앞)에 정책을 적용하고 keepRuns 를 **그때 새로 읽는다**",
        applyAt > 0 && runAt > applyAt && /\(getSchedule\(schedule\.id\) \?\? schedule\)\.keepRuns,?\s*\)/.test(runner.slice(applyAt, runAt)),
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
