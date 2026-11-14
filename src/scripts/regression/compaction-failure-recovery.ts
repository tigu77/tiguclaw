/**
 * 회귀: **요약이 실패해도 기존 요약·원문·경계는 그대로이고, 다음 요청이 필요할 때 다시 접는다 — 손실 안내는 실제로 빠졌을 때만** (2026-11-12 요약 실패 인계).
 *
 * 관측(개발돌쇠 11-12): 답한 뒤 요약이 공급자 과부하(`server_is_overloaded`)로 실패했고, 화면은 실패 이벤트만 보고
 *  «오래된 맥락이 잘렸습니다» 를 띄웠다. 그러나 실패는 경계를 옮기지 않고, 이번 요청 입력에서 실제로 빠졌는지는
 *  창 안전망(`recentTurnsAfter`)만 안다. 그래서 실패 문구는 «완료하지 못했다» 까지만 말하고, 실제 제외는 그 판정 자리에서
 *  `llm.history_trimmed` 로 따로 알린다. 재시도 타이머·즉시 재시도·예산 변경은 없다 — 다음 요청이 다시 판정한다.
 *
 * 요약 LLM 만 가짜(포트)이고 계획·루프·판정·저장·창 안전망은 제품 코드다. 실제 조립(`buildTurnHistory`)으로 부른다.
 * ★쿨다운 장부는 프로세스 전역이라 provider 키를 이 검사 전용으로 둔다(과부하는 원래 등록 대상이 아니지만 다른 검사를 오염시키지 않게).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
const OVERLOAD = "요약 호출 실패: error/server_is_overloaded";

type Ev = { type: string; payload: Record<string, unknown> };

export const check: RegressionCheck = {
  name: "compaction-failure-recovery",
  guards:
    "요약 실패 이벤트만으로 «맥락이 잘렸다» 고 단정하던 것(11-12 과부하) — 실패해도 요약·원문·경계 보존 · 다음 요청이 필요하면 재요약 · 들어가면 기다림 없이 진행 · 실제 제외(턴/도구 기록)만 안내",
  run: async (): Promise<Assertion[]> => {
    const H = await import(SRC);
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { getThreadSummary, clearThreadSummary, upsertThreadSummary } = await import("../../store/thread-summaries.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    initStore();
    const run = Date.now();
    let ts = 1_770_000_000_000;
    const PER = 3_750;
    const PROVIDER = `regr-fail-recovery-${run}`;

    let mode: "ok" | "fail" | "abort" = "ok";
    let calls = 0;
    H.setSummarizerPort(async (_text: string, target: number) => {
      calls += 1;
      if (mode === "fail") throw new Error(OVERLOAD);
      if (mode === "abort") throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      return "새요약:" + "약".repeat(Math.max(0, Math.min(target, 400) - 4));
    });

    const events: Ev[] = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (/^llm\.(compact_failed|compaction_stuck|compacted|history_trimmed)$/.test(e.type)) {
        events.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
      }
    });
    const count = (type: string, tk: string, from = 0): Ev[] =>
      events.slice(from).filter((e) => e.type === type && e.payload.threadKey === tk);

    const keyOf = (name: string): string => `dashboard:regr-fail-recovery-${name}-${run}`;
    const addTurns = (tk: string, n: number): void => {
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: `${tk}-sid` });
      for (let i = 0; i < n; i++) {
        appendTranscript({ claudeSessionId: `${tk}-sid`, role: i % 2 === 0 ? "user" : "assistant", content: `턴${i}@${ts}:` + "가".repeat(PER), ts: (ts += 60_000) });
      }
    };
    const request = async (tk: string): Promise<{ history: number; unsummarized: number }> => {
      let history = -1;
      await H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: PROVIDER }, "현재 턴", [], "fake-token", undefined, "fake-model", 0, undefined,
        (b: { historyCount: number }) => { history = b.historyCount; });
      const wm = getThreadSummary(tk)?.compactedThrough ?? 0;
      return { history, unsummarized: loadThreadHistoryWithIds("http-bridge", tk, { after: wm }).length };
    };
    const snap = (tk: string): { summary: string; wm: number } => ({
      summary: getThreadSummary(tk)?.summary ?? "",
      wm: getThreadSummary(tk)?.compactedThrough ?? 0,
    });

    const out: Assertion[] = [];
    try {
      // ① 창을 넘는 대화에서 과부하로 3회 연속 실패 — 매번 요약·경계 그대로 · 끝 신호 1회 · 실제로 빠진 턴 수 그대로 안내 · 고착 경보는 3회째 한 번.
      const M = keyOf("over");
      clearThreadSummary("http-bridge", M);
      addTurns(M, 4);
      const seedRows = loadThreadHistoryWithIds("http-bridge", M);
      upsertThreadSummary({ threadKey: M, summary: "기존요약:" + "기".repeat(300), compactedThrough: seedRows[1]!.id });
      addTurns(M, 66); // ≈ 248K — 상한 20만 위
      const before = snap(M);
      const rounds: Array<Record<string, unknown>> = [];
      mode = "fail";
      // 연속 실패 경고 로그도 같은 기준인지 본다(GPT R1 검사 부족) — 횟수·사유는 남기고 손실은 단정하지 않는다.
      const errors: string[] = [];
      const realError = console.error;
      console.error = (...a: unknown[]): void => { errors.push(a.map(String).join(" ")); };
      try {
        for (let i = 0; i < 3; i++) {
          const from = events.length;
          calls = 0;
          const r = await request(M);
          const after = snap(M);
          const trimmed = count("llm.history_trimmed", M, from);
          rounds.push({
            calls,
            kept: after.summary === before.summary && after.wm === before.wm,
            failed: count("llm.compact_failed", M, from).length,
            compacted: count("llm.compacted", M, from).length,
            dropped: r.unsummarized - r.history,
            trimmed: trimmed.map((e) => [e.payload.droppedTurns, e.payload.toolsOmittedTurns, e.payload.unsummarizedTurns]),
            stuck: count("llm.compaction_stuck", M, from).length,
          });
        }
      } finally {
        console.error = realError;
      }
      const okRound = (x: Record<string, unknown>, stuck: number): boolean => {
        const t = x.trimmed as unknown[][];
        return (x.calls as number) > 0 && x.kept === true && x.failed === 1 && x.compacted === 0 && (x.dropped as number) > 0 &&
          t.length === 1 && t[0]![0] === x.dropped && t[0]![1] === 0 && x.stuck === stuck;
      };
      out.push(assert(
        "★과부하 실패 3회 연속 — 매번 기존 요약·경계 그대로 · 끝 신호 1회 · 실제로 빠진 턴 수만큼 `llm.history_trimmed` 1회 · 고착 경보는 3회째 한 번",
        okRound(rounds[0]!, 0) && okRound(rounds[1]!, 0) && okRound(rounds[2]!, 1),
        rounds,
      ));
      const stuckLog = errors.filter((l) => l.includes(`threadKey=${M}`));
      out.push(assert(
        "★연속 실패 경고 로그는 횟수·사유·어댑터를 남기되 실패만으로 맥락 손실을 단정하지 않는다(실제 제외는 창 안전망 줄이 말한다)",
        stuckLog.length === 1 && stuckLog[0]!.includes("3회 연속 실패") && stuckLog[0]!.includes("server_is_overloaded") &&
          stuckLog[0]!.startsWith("[codex 6b]") && !/버려|버린|잊|잘렸|잃/.test(stuckLog[0]!) && stuckLog[0]!.includes("창 안전망이 이력을 잘랐다"),
        stuckLog,
      ));

      // ② 다음 요청에서 요약이 되면 그때만 경계를 옮긴다 — 기존 요약 위에 덧붙이고 · 버린 턴 0 · 제외 안내 없음.
      {
        mode = "ok";
        const from = events.length;
        calls = 0;
        const r = await request(M);
        const after = snap(M);
        out.push(assert(
          "★실패 뒤 다음 요청이 다시 접는다(성공해야 경계 전진 · 기존 요약 보존 · 버린 턴 0 · 제외 안내 0 · 실패 신호 0)",
          calls > 0 && after.wm > before.wm && after.summary.startsWith(before.summary) && after.summary.includes("새요약:") &&
            r.history === r.unsummarized && count("llm.history_trimmed", M, from).length === 0 &&
            count("llm.compact_failed", M, from).length === 0 && count("llm.compacted", M, from).length === 1,
          { calls, wmBefore: before.wm, wmAfter: after.wm, summaryKept: after.summary.startsWith(before.summary), history: r.history, unsummarized: r.unsummarized },
        ));
      }

      // ③ 답한 뒤 접기가 실패했지만 다음 요청은 창에 들어간다 — 요약을 기다리지 않고(호출 0) 그대로 진행 · 제외 0 · 안내 0.
      {
        const F = keyOf("fits");
        clearThreadSummary("http-bridge", F);
        addTurns(F, 44); // ≈ 165K — 요약 기준 위, 상한 아래
        mode = "fail";
        await request(F); // 요청 때는 들어가므로 접지 않는다 — 답한 뒤 접기 설정만 기억된다
        const from = events.length;
        calls = 0;
        await H.compactHistoryAfterTurn(F);
        const postCalls = calls;
        const postFailed = count("llm.compact_failed", F, from).length;
        const kept = snap(F);
        const from2 = events.length;
        calls = 0;
        const r = await request(F);
        out.push(assert(
          "★답한 뒤 요약이 실패해도 들어가는 다음 요청은 요약 대기 없이 진행한다(요약 호출 0 · 미요약 턴 전부 실림 · 제외 안내 0)",
          postCalls > 0 && postFailed === 1 && kept.wm === 0 && kept.summary === "" &&
            calls === 0 && r.history === r.unsummarized && r.unsummarized === 44 &&
            count("llm.history_trimmed", F, from2).length === 0 && count("llm.compact_failed", F, from2).length === 0,
          { postCalls, postFailed, kept, foregroundCalls: calls, history: r.history, unsummarized: r.unsummarized },
        ));
      }

      // ④ 사용자 취소는 실패가 아니다 — 끝 신호·연속 실패 계수 없음 · 요약 그대로(이번 입력의 실제 제외는 그대로 안내된다).
      {
        const C = keyOf("cancel");
        clearThreadSummary("http-bridge", C);
        addTurns(C, 66);
        mode = "abort";
        const from = events.length;
        const r = await request(C);
        out.push(assert(
          "★요약 취소는 실패 신호·고착 계수를 내지 않는다 · 경계 그대로 · 실제로 빠진 것만 안내",
          count("llm.compact_failed", C, from).length === 0 && count("llm.compaction_stuck", C, from).length === 0 &&
            snap(C).wm === 0 && count("llm.history_trimmed", C, from).length === (r.unsummarized > r.history ? 1 : 0),
          { failed: count("llm.compact_failed", C, from).length, wm: snap(C).wm, dropped: r.unsummarized - r.history, trimmed: count("llm.history_trimmed", C, from).length },
        ));
      }

      // ⑤ 공유 함수 — 도구 기록만 뺀 경우는 그 수로, 안 잘렸거나 스레드가 없으면 안내 0.
      {
        const T = keyOf("tools");
        const call = { type: "function_call", call_id: "c1", name: "Read", arguments: "{}" };
        const turns = [
          { id: 1, role: "user", content: "질문", items: [call], itemsChars: 5_000 },
          { id: 2, role: "assistant", content: "답" },
        ];
        const from = events.length;
        const kept = H.recentTurnsAfter(turns, 0, { budgetUsedChars: 0, charCap: 100, threadKey: T }) as Array<{ items?: unknown }>;
        const t1 = count("llm.history_trimmed", T, from).map((e) => [e.payload.droppedTurns, e.payload.toolsOmittedTurns]);
        const from2 = events.length;
        H.recentTurnsAfter(turns, 0, { budgetUsedChars: 0, charCap: 100_000, threadKey: T });
        H.recentTurnsAfter(turns, 0, { budgetUsedChars: 0, charCap: 100 }); // 스레드 없는 호출(조사·검사용)
        const quiet = events.slice(from2).filter((e) => e.type === "llm.history_trimmed").length;
        out.push(assert(
          "★도구 기록만 뺐으면 «턴 0 · 도구 기록 1» 로 알린다 · 안 잘렸으면/스레드 없는 호출이면 안내 0",
          kept.length === 2 && kept[0]!.items === undefined && t1.length === 1 && t1[0]![0] === 0 && t1[0]![1] === 1 && quiet === 0,
          { kept: kept.length, toolsKept: kept[0]?.items !== undefined, trimmed: t1, quiet },
        ));
      }

      // ⑥ OpenAI 소비 경로 — 같은 드라이버(adapter=openai)가 실패해도 보존 · 그 어댑터와 같은 호출 모양의 창 안전망이 실제 제외를 안내.
      {
        const O = keyOf("openai");
        clearThreadSummary("http-bridge", O);
        addTurns(O, 66);
        mode = "fail";
        const from = events.length;
        const r = await H.compactThreadHistory({
          channel: "http-bridge",
          threadKey: O,
          provider: PROVIDER,
          adapter: "openai",
          budget: { instructionsChars: 0, promptChars: 10, capChars: 200_000 },
          summarize: async () => {
            throw new Error(OVERLOAD);
          },
        });
        const failed = count("llm.compact_failed", O, from);
        const kept = H.recentTurnsAfter(r.allTurns, r.watermark, { budgetUsedChars: 10 + r.summary.length, charCap: 200_000, threadKey: O }) as unknown[];
        const trimmed = count("llm.history_trimmed", O, from);
        const openaiSrc = await readFile(new URL("../../core/llm-runtime/adapters/openai-agents-sdk.ts", import.meta.url), "utf8");
        const at = openaiSrc.indexOf("recentTurnsAfter(allTurns, watermark, {");
        const wired = at >= 0 && /threadKey: input\.threadKey/.test(openaiSrc.slice(at, at + 300));
        out.push(assert(
          "★OpenAI 경로도 실패 시 경계 보존 · 끝 신호에 adapter=openai · 같은 공유 함수가 실제 제외를 안내 · 어댑터가 threadKey 를 넘긴다",
          r.watermark === 0 && failed.length === 1 && failed[0]!.payload.adapter === "openai" &&
            trimmed.length === 1 && trimmed[0]!.payload.droppedTurns === 66 - kept.length && kept.length < 66 && wired,
          { watermark: r.watermark, failed: failed.map((e) => e.payload.adapter), kept: kept.length, trimmed: trimmed.map((e) => e.payload.droppedTurns), wired },
        ));
      }

      // ⑦ 화면 문구 — 실패·연속 실패는 손실을 단정하지 않고, 제외 안내는 «이번 요청 입력» 과 «원문 보존» 을 구분한다(양문).
      {
        const ko = JSON.parse(await readFile(new URL("../../../locales/ko.json", import.meta.url), "utf8")) as Record<string, string>;
        const en = JSON.parse(await readFile(new URL("../../../locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
        const bad: string[] = [];
        for (const k of ["sys.compact.failed", "sys.compactStuck"]) {
          if (/잘렸|버려|버린|잊/.test(ko[k] ?? "")) bad.push(`ko:${k}`);
          if (/dropp|forg|lost|discard/i.test(en[k] ?? "")) bad.push(`en:${k}`);
        }
        const need: Array<[string, string[]]> = [
          ["sys.history.trimmed", ["{turns}"]],
          ["sys.history.trimmedWithTools", ["{turns}", "{tools}"]],
          ["sys.history.toolsOmitted", ["{tools}"]],
        ];
        for (const [k, ph] of need) {
          for (const [l, cat, input, orig] of [["ko", ko, /이번 요청의 모델 입력/, /원문/], ["en", en, /model input for this request/, /original/i]] as const) {
            const v = cat[k] ?? "";
            if (!ph.every((p) => v.includes(p)) || !input.test(v) || !orig.test(v)) bad.push(`${l}:${k}`);
          }
        }
        out.push(assert("★실패 문구는 손실을 단정하지 않고, 제외 안내는 «이번 요청 입력» 과 «원문 보존» 을 양문으로 구분한다", bad.length === 0, bad));
      }
    } finally {
      H.setSummarizerPort(null);
      unsub();
    }
    return out;
  },
};
