/**
 * 회귀: **사람이 답을 기다리는 요청은 «이번 요청이 창에 들어가면» 접지 않는다 — 정리는 답한 뒤에** (2026-10-15 회사돌쇠 압축 인계서).
 *
 * 사고(회사 RPG 세션, Codex): 짧은 메시지에 준비 404초 · 본 응답 18초. 답 앞에서 원문 8패스(기본 3 + 답한 뒤 접기가 양보하며
 *  넘긴 5)를 **저수위까지** 접고, 누적 요약을 두 번 재압축(약 3분)했다. 마지막 요청은 406K자로 안전선 595K자 아래였고
 *  재압축이 줄인 건 26K자뿐이었다 — 들어가는 요청을 붙들고 «한동안 다시 안 접게» 하는 정리를 한 것이다.
 * 처방: 요청 때 접기의 멈춤 조건 = 이번 요청이 창에 들어가는가(`historyFitsCap` — 창 안전망 `recentTurnsAfter` 와 같은 자·같은 상한).
 *  저수위 정리·재압축은 답한 뒤 접기의 몫. 들어가지 않으면 종전대로 접되 들어가는 순간 멈춘다.
 * ★파생 스레드(답한 뒤 접기가 없다)는 종전대로 요청 때 저수위까지 — 여기서 멈추면 매 턴 경계에서 다시 접는다.
 *
 * 요약 LLM 만 가짜(포트)이고 계획·루프·판정·저장은 전부 제품 코드다. 실제 조립(`buildTurnHistory`)으로 부른다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

export const check: RegressionCheck = {
  name: "compaction-answer-first",
  guards:
    "이미 창에 들어가는 요청을 붙들고 답 앞에서 저수위까지 여러 패스 접고 누적 요약을 재압축해 짧은 메시지에 수 분을 기다리던 것(회사돌쇠 10-15, 준비 404초) — 들어가면 바로 답하고, 버리는 턴은 0",
  run: async (): Promise<Assertion[]> => {
    const H = await import(SRC);
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { getThreadSummary, clearThreadSummary, upsertThreadSummary } = await import("../../store/thread-summaries.js");
    initStore();
    const run = Date.now();
    let ts = 1_760_000_000_000;
    const PER = 3_750; // 한 턴 글자 — 한 패스가 10턴 남짓을 접는다
    const PROMPT = "현재 턴 프롬프트";

    // 가짜 요약기 — 호출 수와 «붙잡기» (첫 패스 도중 요청을 줄 세운다).
    let calls = 0;
    let summaryLen = 400; // 요약 한 번이 돌려주는 길이 — ⑧ 은 크게 해서 «패스 뒤 늘어난 요약» 을 판정이 세는지 본다
    let holdNext = false;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const hold = (): Promise<void> => {
      holdNext = true;
      return new Promise<void>((r) => (entered = r));
    };
    H.setSummarizerPort(async (_text: string, target: number) => {
      calls += 1;
      if (holdNext) {
        holdNext = false;
        entered();
        await new Promise<void>((r) => (release = r));
      }
      return `요약${calls}:` + "약".repeat(Math.max(0, Math.min(target, summaryLen) - 6));
    });

    const keyOf = (name: string, derived = false): string => `${derived ? "agent:" : "dashboard:"}regr-answer-first-${name}-${run}`;
    const addTurns = (tk: string, n: number): void => {
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: `${tk}-sid` });
      for (let i = 0; i < n; i++) {
        appendTranscript({ claudeSessionId: `${tk}-sid`, role: i % 2 === 0 ? "user" : "assistant", content: `턴${i}@${ts}:` + "가".repeat(PER), ts: (ts += 60_000) });
      }
    };
    /** 실제 조립 — 조립된 이력 턴 수(요약·현재 턴 제외)를 함께 돌려준다. */
    const request = async (tk: string, prompt = PROMPT): Promise<{ history: number; unsummarized: number }> => {
      let history = -1;
      await H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth" }, prompt, [], "fake-token", undefined, "fake-model", 0, undefined,
        (b: { historyCount: number }) => { history = b.historyCount; });
      const wm = getThreadSummary(tk)?.compactedThrough ?? 0;
      return { history, unsummarized: loadThreadHistoryWithIds("http-bridge", tk, { after: wm }).length };
    };
    /** 다음 요청이 지금 상태 그대로 창에 들어가는가 — 제품 판정 그대로(전제 확인용). */
    const fitsNow = (tk: string): boolean => {
      const wm = getThreadSummary(tk)?.compactedThrough ?? 0;
      const turns = loadThreadHistoryWithIds("http-bridge", tk, { after: wm }).map((t: { id: number; role: string; content: string }) => t);
      return H.historyFitsCap(turns, wm, PROMPT.length + (getThreadSummary(tk)?.summary.length ?? 0) + H.FOLDED_TOOL_INDEX_MAX_CHARS, 200_000);
    };
    /** 창에 «겨우 넘치게» 쌓는다 — 한 패스면 다시 들어가는 크기. */
    const fillJustOver = (tk: string): number => {
      let n = 0;
      while (fitsNow(tk) && n < 400) { addTurns(tk, 2); n += 2; }
      return n;
    };

    const out: Assertion[] = [];
    try {
      // ① 들어가는데 요약 기준(고수위)은 넘은 요청 — 요청 때 요약 0회 · 버린 턴 0 · 답한 뒤 접기가 정리한다.
      {
        const A = keyOf("fits");
        clearThreadSummary("http-bridge", A);
        addTurns(A, 44); // 44 × 3.75K ≈ 165K — 기준(15만) 위, 상한(20만) 아래
        const above = H.historyTriggerChars(H.historyFixedChars(0, PROMPT.length), 200_000) < 44 * PER;
        const fitsBefore = fitsNow(A);
        calls = 0;
        // 요청 구간의 압축 알림 — 접지 않았으면 «압축 중» 도 띄우지 않는다(시작만 내고 끝이 없으면 답하는 내내 ⏳ 가 남는다 · 재검토 G4).
        const { getEventBus } = await import("../../core/eventbus.js");
        const alerts: string[] = [];
        const unsub = getEventBus().subscribe((e: { type: string; payload: { threadKey?: string } }) => {
          if ((e.type === "llm.compacting" || e.type === "llm.compacted") && e.payload.threadKey === A) alerts.push(e.type);
        });
        let r = { history: -1, unsummarized: -1 };
        try { r = await request(A); } finally { unsub(); }
        const fg = calls;
        calls = 0;
        await H.compactHistoryAfterTurn(A);
        const after = calls;
        out.push(assert(
          "★★들어가는 요청은 요약 기준을 넘었어도 답 앞에서 접지 않는다(요약 0회 · 미요약 턴 전부 실림) — 정리는 답한 뒤 접기가 한다",
          above && fitsBefore && fg === 0 && alerts.length === 0 && r.history === r.unsummarized && r.unsummarized === 44 && after > 0,
          { above, fitsBefore, alerts, foregroundCalls: fg, history: r.history, unsummarized: r.unsummarized, postTurnCalls: after },
        ));
      }

      // ② 사고 모양 — 답한 뒤 접기가 1패스에서 양보(남은 몫을 넘김) → 그 한 패스로 이미 들어간다 → 요청 때 요약 0회.
      //  종전: 이어받은 몫(기본 3 + 남은 8)으로 저수위까지 접었다.
      {
        const B = keyOf("yield");
        clearThreadSummary("http-bridge", B);
        addTurns(B, 20);
        await request(B); // 설정이 기억된다(답한 뒤 접기의 재료)
        const added = fillJustOver(B);
        const overBefore = !fitsNow(B);
        calls = 0;
        const gate = hold();
        const bg = H.compactHistoryAfterTurn(B);
        const enteredB = await Promise.race([gate.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3_000))]);
        if (!enteredB) holdNext = false;
        const req = request(B); // 첫 패스 도중 요청이 줄을 선다
        await new Promise((r) => setTimeout(r, 5));
        release();
        await bg;
        const bgCalls = calls;
        const r = await req;
        const fgCalls = calls - bgCalls;
        out.push(assert(
          "★★[사고 재현] 답한 뒤 접기가 양보한 뒤 이미 들어가는 요청은 이어받은 몫을 쓰지 않는다(요청 때 요약 0회 · 버린 턴 0)",
          enteredB && overBefore && added > 0 && bgCalls === 1 && fgCalls === 0 && r.history === r.unsummarized,
          { enteredB, added, overBefore, postTurnCalls: bgCalls, foregroundCalls: fgCalls, history: r.history, unsummarized: r.unsummarized },
        ));
      }

      // ③ 넘치는 요청 — 들어가는 순간 멈춘다(파생 스레드 대조군은 저수위까지 더 접는다). 둘 다 버린 턴 0.
      {
        const M = keyOf("over");
        const D = keyOf("over", true);
        const res: Record<string, { calls: number; history: number; unsummarized: number }> = {};
        for (const tk of [M, D]) {
          clearThreadSummary("http-bridge", tk);
          addTurns(tk, 66); // ≈ 248K — 상한 위, 두 패스 남짓이면 들어간다
          calls = 0;
          const r = await request(tk);
          res[tk] = { calls, ...r };
        }
        const m = res[M]!, d = res[D]!;
        out.push(assert(
          "★넘치는 요청은 들어갈 만큼만 접고 멈춘다 — 저수위까지 가는 파생 스레드(답한 뒤 접기가 없다)보다 적게 · 둘 다 버린 턴 0",
          m.calls > 0 && m.calls < d.calls && m.history === m.unsummarized && d.history === d.unsummarized,
          { main: m, derived: d },
        ));
      }

      // ④ 누적 요약이 요약 상한(2만)을 넘었지만 요청은 들어간다 — 답 앞 재압축 0 · 요약 그대로. 답한 뒤 접기가 줄인다.
      //  대조: 파생 스레드는 종전대로 요청 때 재압축한다.
      {
        const S = keyOf("recompact");
        const SD = keyOf("recompact", true);
        const cap = H.summaryCapChars(200_000) as number;
        const big = [0, 1, 2].map((i) => `구간${i}:` + "요".repeat(Math.ceil(cap / 2))).join(H.SUMMARY_SECTION_SEP);
        const seedSummary = (tk: string): void => {
          clearThreadSummary("http-bridge", tk);
          addTurns(tk, 4);
          const rows = loadThreadHistoryWithIds("http-bridge", tk);
          upsertThreadSummary({ threadKey: tk, summary: big, compactedThrough: rows[1]!.id });
        };
        seedSummary(S);
        seedSummary(SD);
        calls = 0;
        await request(S);
        const fg = calls;
        const kept = getThreadSummary(S)?.summary.length ?? 0;
        calls = 0;
        await H.compactHistoryAfterTurn(S);
        const post = calls;
        const shrunk = getThreadSummary(S)?.summary.length ?? 0;
        calls = 0;
        await request(SD);
        const derived = calls;
        out.push(assert(
          "★요약이 상한을 넘어도 요청이 들어가면 답 앞에서 재압축하지 않는다(요약 그대로) · 답한 뒤 접기가 줄인다 · 파생 스레드는 종전대로 요청 때 줄인다",
          big.length > cap && fg === 0 && kept === big.length && post > 0 && shrunk < kept && derived > 0,
          { summary: big.length, cap, foregroundCalls: fg, kept, postTurnCalls: post, shrunk, derivedCalls: derived },
        ));
      }

      // ⑤ **요약 때문에** 넘치는 요청 — 원문만 보면 들어가지만 누적 요약을 더하면 넘친다. 판정이 요약을 안 세면 접기를 건너뛰고
      //  창 안전망이 옛 턴을 버린다. 줄이는 작업을 하고(요약 호출 > 0) 버린 턴 0.
      {
        const T = keyOf("summary-tips");
        clearThreadSummary("http-bridge", T);
        addTurns(T, 2);
        const first = loadThreadHistoryWithIds("http-bridge", T);
        upsertThreadSummary({ threadKey: T, summary: "요".repeat(30_000), compactedThrough: first[1]!.id });
        addTurns(T, 46); // 원문 ≈ 173K + 목록 몫 4K — 요약(30K)을 더해야 넘친다
        const wm = getThreadSummary(T)?.compactedThrough ?? 0;
        const raw = loadThreadHistoryWithIds("http-bridge", T, { after: wm });
        const rawOnlyFits = H.historyFitsCap(raw, wm, PROMPT.length + H.FOLDED_TOOL_INDEX_MAX_CHARS, 200_000);
        const overWithSummary = !fitsNow(T);
        calls = 0;
        const r = await request(T);
        out.push(assert(
          "★요약 때문에 넘치는 요청은 줄이는 작업을 한다(판정이 누적 요약 길이를 센다) · 버린 턴 0",
          rawOnlyFits && overWithSummary && calls > 0 && r.history === r.unsummarized,
          { rawOnlyFits, overWithSummary, calls, history: r.history, unsummarized: r.unsummarized },
        ));
      }

      // ⑥ **이번 프롬프트 때문에** 넘치는 요청(긴 붙여넣기) — 판정은 프롬프트 전체 길이를 센다(요약 기준의 5만 자 몫 상한과 다르다).
      {
        const P = keyOf("prompt-tips");
        clearThreadSummary("http-bridge", P);
        addTurns(P, 37); // 원문 ≈ 140K — 짧은 프롬프트면 들어가고, 프롬프트를 5만 자로 깎아 세도 들어간다(실제 7만 자면 넘친다)
        const bigPrompt = "붙여넣기 " + "로".repeat(70_000);
        const shortFits = fitsNow(P);
        calls = 0;
        const r = await request(P, bigPrompt);
        out.push(assert(
          "★긴 프롬프트 때문에 넘치는 요청은 줄이는 작업을 한다(판정이 이번 프롬프트 길이를 센다) · 버린 턴 0",
          shortFits && calls > 0 && r.history === r.unsummarized,
          { shortFits, calls, history: r.history, unsummarized: r.unsummarized },
        ));
      }

      // ⑦ 그래도 잘리면 **남긴다** — 종전 창 안전망은 조용히 버렸다(버린 턴은 요약에도 원문에도 없어 모델이 못 본다). 아주 긴 붙여넣기는
      //  설계상 원문을 영구히 접지 않고(요약 기준의 프롬프트 몫 상한) 그 요청에서만 옛 턴이 빠진다 — 그 빈도를 이 줄로 잰다.
      {
        const Q = keyOf("drop-logged");
        clearThreadSummary("http-bridge", Q);
        addTurns(Q, 10);
        const warns: string[] = [];
        const realWarn = console.warn;
        console.warn = (...a: unknown[]): void => { warns.push(a.map(String).join(" ")); };
        let r = { history: -1, unsummarized: -1 };
        try {
          r = await request(Q, "붙여넣기 " + "로".repeat(185_000));
        } finally {
          console.warn = realWarn;
        }
        const line = warns.find((w) => w.includes("창 안전망이 이력을 잘랐다")) ?? "";
        const dropped = r.unsummarized - r.history;
        out.push(assert(
          "★창 안전망이 턴을 버리면 버린 수와 threadKey 를 로그에 남긴다(조용한 손실 금지)",
          dropped > 0 && line.includes(`${dropped}턴 버림`) && line.includes(`threadKey=${Q}`),
          { dropped, line },
        ));
      }

      // ⑧ **경계 훑기 — 접힌 도구 목록이 실제로 붙는 대화** (재검토 G1·G2·G3). 보내는 요약 뒤엔 접힌 긴 도구 결과 목록이 붙는데,
      //  목록이 빈 픽스처로는 판정이 그 몫을 빼먹어도·상한을 4천 자 느슨히 봐도·패스 뒤 늘어난 요약 대신 처음 길이를 써도 초록이었다.
      //  경계 근처를 1천 자 간격으로 훑어 **어느 크기에서도** 버린 턴 0 — 그리고 훑기가 «바로 답» 과 «접고 답» 을 둘 다 지났는지.
      {
        const { appendApiTurn } = await import("../../store/memory.js");
        const call = (id: string, args: unknown) => ({ type: "function_call" as const, call_id: id, name: "Read", arguments: JSON.stringify(args) });
        const res = (id: string, output: string) => ({ type: "function_call_output" as const, call_id: id, output });
        const S0 = 6_000;
        summaryLen = 3_000;
        const rows: { k: number; calls: number; dropped: number; index: number }[] = [];
        for (let k = 0; k < 56; k++) {
          const W = keyOf(`edge-${k}`);
          clearThreadSummary("http-bridge", W);
          for (let i = 0; i < 30; i++) {
            appendApiTurn({ channel: "http-bridge", threadKey: W, claudeSessionId: `${W}-tools`, userContent: "질문", assistantContent: "답",
              items: [call(`c${i}`, { path: `docs/file-${i}-${"x".repeat(60)}.md` }), res(`c${i}`, "결과 " + "나".repeat(H.FOLD_TOOL_OUTPUT_HEAD + 300))] });
          }
          const folded = loadThreadHistoryWithIds("http-bridge", W);
          upsertThreadSummary({ threadKey: W, summary: "요".repeat(S0), compactedThrough: folded[folded.length - 1]!.id });
          const index = H.foldedToolIndex("http-bridge", W, folded[folded.length - 1]!.id).length;
          // 경계 바로 아래(약 8천 자 여유)에서 시작해 1천 자씩 — 원문 한 턴 1천 자 남짓
          const base = Math.floor((200_000 - PROMPT.length - S0 - index - 8_000) / 1_020);
          indexCodexTurn({ channel: "http-bridge", threadKey: W, claudeSessionId: `${W}-sid` });
          for (let i = 0; i < base + k; i++) {
            appendTranscript({ claudeSessionId: `${W}-sid`, role: i % 2 === 0 ? "user" : "assistant", content: `e${i}:` + "다".repeat(1_000), ts: (ts += 60_000) });
          }
          calls = 0;
          const r = await request(W);
          rows.push({ k, calls, dropped: r.unsummarized - r.history, index });
        }
        summaryLen = 400;
        const dropped = rows.filter((x) => x.dropped !== 0);
        out.push(assert(
          "★접힌 도구 목록이 붙는 대화의 경계 근처 어느 크기에서도 버린 턴 0(판정이 목록 몫·실제 상한·패스 뒤 요약 길이를 센다) · 훑기가 «바로 답» 과 «접고 답» 을 둘 다 지났다",
          rows[0]!.index > 0 && dropped.length === 0 && rows.some((x) => x.calls === 0) && rows.some((x) => x.calls > 0),
          { index: rows[0]!.index, dropped, firstFold: rows.find((x) => x.calls > 0)?.k, multi: rows.filter((x) => x.calls > 1).map((x) => x.k) },
        ));
      }
    } finally {
      H.setSummarizerPort(null);
    }
    return out;
  },
};
