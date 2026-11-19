/**
 * 회귀: **요약 때문에 기다리는 한 구간은 시작 1·끝 1** — 재압축만·잠금 대기에도 안내가 나가고, 겹쳐도 중복·조기 종료·잔여가 없다
 * (2026-11-19 공개 이슈 #3, 설계 docs/decisions/2026-11-19-issue3-compaction-progress-fix.md).
 *
 * 사고(#3 신고): 긴 대화에서 답 앞 «턴 준비» 가 266초·170초였는데 화면에 요약 안내가 없었다. 원인 확정은 못 했지만 두 무표시 경로를
 *  코드·합성 재현으로 확인했다 — 누적 요약만 재압축할 때(F1) · 앞선 요약 잠금을 기다릴 때(F2). 텔레그램엔 압축 안내 경로가 없었다(F3).
 *  로그로 대기·재압축 시간을 나눌 수 없었다(F4). ★이 검사는 안내·계측을 본다 — 지연 시간 자체(성능)는 다루지 않는다.
 *
 * 재는 것(요약 LLM 만 가짜 포트, 계획·잠금·루프·판정·이벤트는 제품 코드 · 실제 조립 `buildTurnHistory`):
 *  ① S1 요청 때 재압축만 · S2 요청 때 원문 접기 · S3 잠금 대기(> 문턱) · 짧은 대기(< 문턱) · 겹침(백그라운드가 연 구간 + 요청 합류)
 *  ② 결과표 — 실패·재압축 예외·안 줄어듦·취소·양보·폐기·대기만 · 재압축 성공은 실패 계수 유지 · 구간 안 고착 경보는 구간을 싣는다
 *  ③ 참여자 — 둘 중 하나만 떠나면 유지, 요청이 연 구간은 요청이 다 떠나면 닫힘(남은 백그라운드는 뒤에 아무것도 안 냄)
 *  ④ 대시보드(`sse.js` 함수를 vm 으로 실행) — 같은 구간 새 줄 0 · 떨어진 노드 배지 걷힘 · 이력 로드 미룸·재생 · 구간 없는 끝이 구간 표시를 안 걷음
 *  ⑤ 텔레그램(채널 스텁) — 구간당 1회 · 마지막 인입이 텔레그램일 때만 · 백그라운드 0 · 실패 격리·재발송 0 · 끝에서 마커 정리
 *  ⑥ 단계 시간 로그 — 잠금 대기 ms · 재압축 호출 ms · (턴 뒤)/(요청 때) · 구간 끝 한 줄
 * 등급: **동작**(④ 의 이벤트 분기 배선만 린트).
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Ev = { type: string; payload: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "compaction-wait-progress",
  guards:
    "누적 요약만 재압축할 때·앞선 요약 잠금을 기다릴 때 진행 안내가 없어 수 분을 이유 없이 기다리던 것(공개 이슈 #3) — 겹치는 시작·끝으로 중복·조기 종료·잔여 · 텔레그램 무안내 · 로그로 대기 시간을 못 나누던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { getThreadSummary, clearThreadSummary, upsertThreadSummary } = await import("../../store/thread-summaries.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    initStore();

    // ── 하네스(#3 검토 §4 S1~S3 와 같은 모양) ──
    const PER = 3_750;
    const PROMPT = "현재 턴 프롬프트";
    let ts = 1_760_000_000_000;
    let calls = 0;
    let mode: "ok" | "throw" | "long" = "ok";
    let holdNext = false;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    H.setSummarizerPort(async (_t: string, target: number) => {
      calls += 1;
      if (holdNext) { holdNext = false; entered(); await new Promise<void>((r) => (release = r)); }
      if (mode === "throw") throw new Error("합성 요약 실패 503");
      if (mode === "long") return "길".repeat(200_000);
      return `요약${calls}:` + "약".repeat(Math.max(0, Math.min(target, 400) - 6));
    });
    const run = Date.now();
    const key = (n: string): string => `dashboard:regr-wait-progress-${n}-${run}`;
    const addTurns = (tk: string, n: number): void => {
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: `${tk}-sid` });
      for (let i = 0; i < n; i++) appendTranscript({ claudeSessionId: `${tk}-sid`, role: i % 2 === 0 ? "user" : "assistant", content: `턴${i}@${ts}:` + "가".repeat(PER), ts: (ts += 60_000) });
    };
    const request = (tk: string, signal?: AbortSignal): Promise<unknown> =>
      H.buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth", ...(signal !== undefined ? { abortSignal: signal } : {}) } as never, PROMPT, [], "fake-token", undefined, "fake-model", 0, undefined, () => {});
    const seedSummaryOver = (tk: string, rawTurns: number, sumLen = 30_000): void => {
      clearThreadSummary("http-bridge", tk);
      addTurns(tk, 2);
      const first = loadThreadHistoryWithIds("http-bridge", tk);
      upsertThreadSummary({ threadKey: tk, summary: "요".repeat(sumLen), compactedThrough: first[1]!.id });
      addTurns(tk, rawTurns);
    };
    const fits = (tk: string): boolean => {
      const wm = getThreadSummary(tk)?.compactedThrough ?? 0;
      const turns = loadThreadHistoryWithIds("http-bridge", tk, { after: wm });
      return H.historyFitsCap(turns, wm, PROMPT.length + (getThreadSummary(tk)?.summary.length ?? 0) + H.FOLDED_TOOL_INDEX_MAX_CHARS, 200_000);
    };
    const watch = (tk: string) => {
      const seen: Ev[] = [];
      const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        if (p.threadKey === tk && /^llm\.compact/.test(e.type)) seen.push({ type: e.type, payload: p });
      });
      return { seen, unsub };
    };
    const logs: string[] = [];
    const realLog = console.log, realWarn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const starts = (s: Ev[]) => s.filter((e) => e.type === "llm.compacting");
    const ends = (s: Ev[]) => s.filter((e) => e.type === "llm.compacted" || e.type === "llm.compact_failed" || e.type === "llm.compacting_ended");
    const oneSpan = (s: Ev[]): boolean => new Set(s.filter((e) => e.type !== "llm.compaction_stuck").map((e) => e.payload.spanId)).size === 1 && s.every((e) => typeof e.payload.spanId === "string" || e.type === "llm.compaction_stuck");

    try {
      // ① S1 — 요청 때 재압축만
      {
        const T = key("s1");
        seedSummaryOver(T, 0, 50_000);
        while (fits(T)) addTurns(T, 1);
        mode = "ok";
        const w = watch(T);
        await request(T);
        w.unsub();
        const st = starts(w.seen), en = ends(w.seen);
        out.push(assert("★S1 요청 때 재압축만: 시작 1(waiting)·끝 1(compacted, 재압축 ≥1, 접은 턴 0) · 같은 구간",
          st.length === 1 && st[0]!.payload.waiting === true && en.length === 1 && en[0]!.type === "llm.compacted" &&
            Number(en[0]!.payload.recompacted) >= 1 && Number(en[0]!.payload.foldedTurns) === 0 && oneSpan(w.seen),
          w.seen.map((e) => [e.type, e.payload.waiting, e.payload.recompacted, e.payload.spanId])));
      }
      // ① S2 — 요청 때 원문 접기(종전 시작·완료 그대로 + 구간)
      {
        const T = key("s2");
        clearThreadSummary("http-bridge", T);
        addTurns(T, 60);
        const w = watch(T);
        await request(T);
        w.unsub();
        const st = starts(w.seen), en = ends(w.seen);
        out.push(assert("S2 요청 때 원문 접기: 시작 1(접을 턴 수)·끝 1(compacted, 접은 턴 > 0) · 같은 구간",
          st.length === 1 && Number(st[0]!.payload.pendingTurns) > 0 && en.length === 1 && en[0]!.type === "llm.compacted" && Number(en[0]!.payload.foldedTurns) > 0 && oneSpan(w.seen),
          w.seen.map((e) => [e.type, e.payload.pendingTurns, e.payload.foldedTurns])));
      }
      // ① S3 — 답한 뒤 재압축(조용함)이 잠금을 쥔 동안 요청이 문턱보다 오래 기다린다 / 짧게 기다린다
      const lockWait = async (name: string, holdMs: number) => {
        const T = key(name);
        seedSummaryOver(T, 10);
        mode = "ok";
        await request(T); // 답한 뒤 접기 재료
        const gate = new Promise<void>((r) => { holdNext = true; entered = r; });
        const w = watch(T);
        const logFrom = logs.length;
        const bg = H.compactHistoryAfterTurn(T);
        await gate;
        const req = request(T);
        await sleep(holdMs);
        const during = starts(w.seen).length;
        release();
        await req;
        await bg;
        w.unsub();
        return { w, during, newLogs: logs.slice(logFrom), T };
      };
      // 1.8초 — 문턱(1.5초)을 상수에서 끌어오지 않는다(독립 변이 사냥 M08: 문턱을 3초로 올려도 초록이었다)
      const long = await lockWait("s3", 1_800);
      out.push(assert("★S3 잠금 대기 > 문턱: 대기 중에 시작 1(waiting) · 끝 1 · 같은 구간(백그라운드 재압축 결과가 그 구간에 합쳐진다)",
        long.during === 1 && starts(long.w.seen).length === 1 && starts(long.w.seen)[0]!.payload.waiting === true && ends(long.w.seen).length === 1 && oneSpan(long.w.seen),
        long.w.seen.map((e) => [e.type, e.payload.waiting, e.payload.outcome ?? e.payload.recompacted])));
      const short = await lockWait("s3short", 200);
      out.push(assert("★짧은 잠금 대기(< 문턱)·백그라운드 재압축만: 안내 0(시작·끝 모두 없음)",
        short.w.seen.length === 0, short.w.seen.map((e) => e.type)));
      out.push(assert("★단계 시간 로그: 잠금 대기 ms(요청 때) · 재압축 회차(턴 뒤)·호출 ms · 구간 끝 한 줄",
        long.newLogs.some((l) => /요약 잠금 대기 (\d+)ms\(요청 때\)/.test(l) && Number(/요약 잠금 대기 (\d+)ms/.exec(l)![1]) >= H.COMPACT_WAIT_NOTICE_MS) &&
          // 재요약 호출 ms 는 실제로 붙잡힌 시간이다(약 1.8초) — 숫자 존재만 보면 «호출 0ms» 로 고정해도 초록이었다(M10)
          long.newLogs.some((l) => Number(/누적 요약 재압축 1회차\(턴 뒤\)\(호출 (\d+)ms\)/.exec(l)?.[1] ?? -1) >= 1_500) &&
          long.newLogs.some((l) => /요약 대기 구간 끝 — 결과=done 연쪽=request/.test(l)),
        long.newLogs.filter((l) => /6b\]/.test(l)).map((l) => l.slice(0, 120))));

      // ① 겹침 — 백그라운드가 원문 접기로 연 구간에 요청이 합류(> 문턱) → 같은 구간 갱신 1 · 끝 1
      {
        const T = key("overlap");
        clearThreadSummary("http-bridge", T);
        addTurns(T, 40);
        mode = "ok";
        await request(T); // 설정 기억(이번 요청은 들어가면 접지 않는다)
        addTurns(T, 30);
        const gate = new Promise<void>((r) => { holdNext = true; entered = r; });
        const w = watch(T);
        const ovFrom = logs.length;
        const bg = H.compactHistoryAfterTurn(T);
        await gate;
        const req = request(T);
        await sleep(H.COMPACT_WAIT_NOTICE_MS + 300);
        release();
        await req;
        await bg;
        w.unsub();
        const ovLogs = logs.slice(ovFrom);
        out.push(assert("★생산 경로: 백그라운드가 기다리는 요청에 양보한 사실이 구간에 실린다(구간 끝 줄 양보=true)",
          ovLogs.some((l) => /턴 뒤 접기 양보/.test(l)) && ovLogs.some((l) => /요약 대기 구간 끝 — .*양보=true/.test(l)),
          ovLogs.filter((l) => /양보|구간 끝/.test(l)).map((l) => l.slice(0, 160))));
        const st = starts(w.seen);
        out.push(assert("★겹침: 백그라운드 시작(waiting:false) + 요청 대기 갱신(waiting:true) — 같은 구간 · 끝 1 · 백그라운드가 떠나도 요청 표시 유지",
          st.length === 2 && st[0]!.payload.waiting === false && st[1]!.payload.waiting === true && ends(w.seen).length === 1 && oneSpan(w.seen) &&
            w.seen.indexOf(ends(w.seen)[0]!) === w.seen.length - 1,
          w.seen.map((e) => [e.type, e.payload.waiting, e.payload.outcome ?? e.payload.foldedTurns])));
      }

      // ② 생산 경로 — 요청 때 원문 접기 도중 대화가 바뀌면(리비전 변경) 결과를 버리고 조용한 끝(discarded)
      {
        const { bumpThreadRevision } = await import("../../store/thread-revision.js");
        const T = key("discard");
        clearThreadSummary("http-bridge", T);
        addTurns(T, 60);
        mode = "ok";
        const gate = new Promise<void>((r) => { holdNext = true; entered = r; });
        const w = watch(T);
        const req = request(T);
        await gate;
        bumpThreadRevision(T);
        release();
        await req;
        w.unsub();
        const en = ends(w.seen);
        out.push(assert("★생산 경로: 접기 도중 대화가 바뀌면 결과를 버리고 조용한 끝 1(discarded) · 성공 표시 0",
          starts(w.seen).length === 1 && en.length === 1 && en[0]!.type === "llm.compacting_ended" && en[0]!.payload.outcome === "discarded",
          w.seen.map((e) => [e.type, e.payload.outcome])));
      }

      // ② 결과표 — 요청 때 원문 접기 실패 · 재압축 예외 · 안 줄어듦
      const outcomeOf = async (name: string, setup: (tk: string) => void, m: typeof mode) => {
        const T = key(name);
        setup(T);
        mode = m;
        const w = watch(T);
        await request(T);
        w.unsub();
        mode = "ok";
        return w.seen;
      };
      const foldFail = await outcomeOf("foldfail", (T) => { clearThreadSummary("http-bridge", T); addTurns(T, 60); }, "throw");
      const recFail = await outcomeOf("recfail", (T) => { seedSummaryOver(T, 0, 50_000); while (fits(T)) addTurns(T, 1); }, "throw");
      const recLong = await outcomeOf("reclong", (T) => { seedSummaryOver(T, 0, 50_000); while (fits(T)) addTurns(T, 1); }, "long");
      const failedOnce = (s: Ev[]) => starts(s).length === 1 && ends(s).length === 1 && ends(s)[0]!.type === "llm.compact_failed" && ends(s)[0]!.payload.outcome === "failed" && oneSpan(s);
      out.push(assert("★결과표 — 원문 접기 실패·재압축 예외·재압축이 안 줄어듦: 각각 시작 1·실패 끝 1(성공 표시 0)",
        failedOnce(foldFail) && failedOnce(recFail) && failedOnce(recLong) && String(ends(recLong)[0]!.payload.reason ?? "") !== "",
        { foldFail: foldFail.map((e) => e.type), recFail: recFail.map((e) => e.type), recLong: recLong.map((e) => [e.type, e.payload.reason]) }));

      // ② 재압축 성공은 실패 계수를 건드리지 않는다 — 계수 2 에서 재압축만 성공 뒤 실패 1번이면 고착 경보(3)
      {
        const T = key("streak");
        seedSummaryOver(T, 0, 50_000);
        while (fits(T)) addTurns(T, 1);
        H.noteCompactionOutcome(T, false, "합성 실패", 1);
        H.noteCompactionOutcome(T, false, "합성 실패", 1);
        mode = "ok";
        await request(T); // 재압축만 성공
        const w = watch(T);
        H.noteCompactionOutcome(T, false, "합성 실패", 1);
        w.unsub();
        out.push(assert("★재압축만 성공해도 0 아닌 실패 계수가 유지된다(그다음 실패에서 고착 경보)",
          w.seen.some((e) => e.type === "llm.compaction_stuck"), w.seen.map((e) => e.type)));
      }

      // ② 취소(대기 중) — 요청이 연 구간에서 요청이 떠나면 바로 닫히고(cancelled), 남은 백그라운드는 뒤에 아무것도 안 낸다
      {
        const T = key("cancel");
        seedSummaryOver(T, 10);
        mode = "ok";
        await request(T);
        const gate = new Promise<void>((r) => { holdNext = true; entered = r; });
        const w = watch(T);
        const bg = H.compactHistoryAfterTurn(T);
        await gate;
        const ac = new AbortController();
        const req = request(T, ac.signal).catch(() => "cancelled");
        await sleep(H.COMPACT_WAIT_NOTICE_MS + 300);
        ac.abort();
        await req;
        const atCancel = w.seen.length;
        release();
        await bg;
        await sleep(20);
        w.unsub();
        out.push(assert("★대기 중 취소: 시작 1 → 조용한 끝 1(compacting_ended·cancelled, 성공·실패 표시 0) · 백그라운드가 끝나도 뒤에 0",
          starts(w.seen).length === 1 && ends(w.seen).length === 1 && ends(w.seen)[0]!.type === "llm.compacting_ended" && ends(w.seen)[0]!.payload.outcome === "cancelled" &&
            w.seen.length === atCancel && oneSpan(w.seen),
          w.seen.map((e) => [e.type, e.payload.outcome])));
      }

      // ② 장부 직접 — 양보·폐기·대기만, 둘 중 하나만 떠남, 구간 안 고착 경보
      {
        const T = key("ledger");
        const w = watch(T);
        const end1 = (flag: "yielded" | "discarded" | "none") => {
          const before = w.seen.length;
          const h = H.joinProgressSpan(T, "codex", "request");
          H.announceProgress(h, 0);
          if (flag !== "none") (h.span as unknown as Record<string, boolean>)[flag] = true;
          H.leaveProgressSpan(h);
          return w.seen.slice(before);
        };
        const y = end1("yielded"), d = end1("discarded"), n = end1("none");
        const q = (s: Ev[], o: string) => s.length === 2 && s[1]!.type === "llm.compacting_ended" && s[1]!.payload.outcome === o;
        // 둘이 기다리다 하나만 떠남 → 끝 없음 · 마지막이 떠날 때 끝
        const a = H.joinProgressSpan(T, "codex", "request"), b = H.joinProgressSpan(T, "codex", "request");
        H.announceProgress(a, 0);
        H.announceProgress(b, 0); // 같은 구간 — 새 시작 없음
        const mid = w.seen.length;
        H.leaveProgressSpan(a);
        const afterOne = w.seen.length;
        H.leaveProgressSpan(b);
        const afterBoth = w.seen.length;
        // 구간 안 고착 경보 — 끝 신호는 미루고 경보는 구간을 싣는다
        const c = H.joinProgressSpan(T, "codex", "request");
        H.announceProgress(c, 0);
        const sBefore = w.seen.length;
        for (let i = 0; i < 3; i++) H.noteCompactionOutcome(`${T}-x`, true, "", 1); // 다른 대화 계수는 무관
        H.noteCompactionOutcome(T, true, "", 1); // 계수 0
        for (let i = 0; i < 3; i++) H.noteCompactionOutcome(T, false, "합성 실패", 1, "codex", c);
        const stuck = w.seen.slice(sBefore);
        H.leaveProgressSpan(c);
        const cEnd = w.seen.slice(-1)[0];
        w.unsub();
        out.push(assert("★결과표 — 양보·폐기·대기만은 조용한 끝(compacting_ended)에 각각 그 결과",
          q(y, "yielded") && q(d, "discarded") && q(n, "waited"), { y: y.map((e) => e.payload.outcome), d: d.map((e) => e.payload.outcome), n: n.map((e) => e.payload.outcome) }));
        out.push(assert("★참여자: 둘 중 하나만 떠나면 끝 없음 · 마지막이 떠날 때 끝 1 · 같은 구간 두 번 알림에 새 시작 0",
          w.seen[mid - 1]?.type === "llm.compacting" && afterOne === mid && starts(w.seen.slice(mid - 1, afterBoth)).length === 1 && ends(w.seen.slice(mid - 1, afterBoth)).length === 1,
          { mid, afterOne, afterBoth, tail: w.seen.slice(mid - 1, afterBoth).map((e) => [e.type, e.payload.outcome]) }));
        out.push(assert("★구간 안 실패: 끝 신호는 구간 끝 한 번(실패) · 고착 경보는 즉시이고 구간 id 를 싣는다",
          stuck.length === 1 && stuck[0]!.type === "llm.compaction_stuck" && stuck[0]!.payload.spanId === c.span.id &&
            cEnd?.type === "llm.compact_failed" && cEnd.payload.spanId === c.span.id,
          { stuck: stuck.map((e) => [e.type, e.payload.spanId]), end: cEnd?.type }));
      }
    } finally {
      H.setSummarizerPort(null);
      console.log = realLog;
      console.warn = realWarn;
    }

    // ④ 대시보드 — `sse.js` 의 진행 표시 함수들을 vm 으로 실행한다(가짜 DOM)
    {
      const raw = await readFile(new URL("../../../packages/dashboard/js/sse.js", import.meta.url), "utf8");
      const a = raw.indexOf("const compactingTimers = new Map();");
      const b = raw.indexOf("const renderEvent = (ev) =>");
      const lines: { removed: boolean; badge: { removed: boolean } | null; el: Record<string, unknown> }[] = [];
      const mkEl = () => {
        const line: { removed: boolean; badge: { removed: boolean; textContent?: string; className?: string } | null; el: Record<string, unknown> } = { removed: false, badge: null, el: {} };
        const body = { appendChild: (x: { removed: boolean }) => { line.badge = x; } };
        line.el = {
          isConnected: true,
          querySelector: (sel: string) => (sel.includes("dur-badge") ? (line.badge !== null && !line.badge.removed ? line.badge : null) : body),
        };
        lines.push(line);
        return line.el;
      };
      const owned = new Set<unknown>();
      let active = true;
      // 이력 로드 창 — 제품의 `holdSseEventDuringHistory` 와 같은 계약(창이 열려 있으면 미뤄 두고 true, 닫히면 차례로 실행).
      let loading = false;
      const held: (() => void)[] = [];
      const flushHeld = (): void => { loading = false; for (const f of held.splice(0)) f(); };
      const ctx: Record<string, unknown> = {
        vtOwns: (n: unknown) => owned.has(n),
        holdSseEventDuringHistory: (_ts: number, f: () => void) => { if (!loading) return false; held.push(f); return true; },
        renderLocalChat: () => { const el = mkEl(); owned.add(el); return el; },
        i18n: (k: string) => k,
        isEndpointThread: () => false,
        isActiveThread: () => active,
        fmtElapsed: (ms: number) => `${Math.round(ms / 1000)}s`,
        setInterval: () => 0,
        Date,
        document: { createElement: () => ({ className: "", textContent: "", removed: false, remove() { (this as { removed: boolean }).removed = true; } }) },
      };
      vm.createContext(ctx);
      vm.runInContext(`${raw.slice(a, b)}\nthis.__start = renderCompacting; this.__stop = stopCompactingTick; this.__tick = tickCompacting;`, ctx);
      const start = ctx.__start as (p: unknown, ts: number) => void;
      const stop = ctx.__stop as (p: unknown) => void;
      const tick = ctx.__tick as () => void;
      const badgeOn = (i: number) => lines[i]?.badge !== null && lines[i]?.badge?.removed === false;
      // D1 같은 구간 갱신 → 새 줄 0, 끝 → 배지 걷힘
      start({ threadKey: "t1", spanId: "A", pendingTurns: 0, waiting: false }, 1);
      start({ threadKey: "t1", spanId: "A", pendingTurns: 0, waiting: true }, 2);
      const d1Lines = lines.length;
      stop({ threadKey: "t1", spanId: "A" });
      const d1 = d1Lines === 1 && !badgeOn(0);
      // D2 구간 없는(Claude) 표시와 구간 B 공존 — 구간 없는 끝은 B 를 안 걷고, 다른 구간의 끝도 안 걷는다
      start({ threadKey: "t2", pendingTurns: 0 }, 3); // line 1
      start({ threadKey: "t2", spanId: "B", pendingTurns: 0, waiting: true }, 4); // line 2
      stop({ threadKey: "t2" });
      stop({ threadKey: "t2", spanId: "Z" });
      const d2 = !badgeOn(1) && badgeOn(2);
      stop({ threadKey: "t2", spanId: "B" });
      const d2b = !badgeOn(2);
      // D3 가상목록 이탈(분리된 노드) → 틱이 지우지 않고 끝에서 배지 걷힘
      start({ threadKey: "t3", spanId: "C", pendingTurns: 0, waiting: true }, 5); // line 3
      (lines[3]!.el as { isConnected: boolean }).isConnected = false;
      tick();
      stop({ threadKey: "t3", spanId: "C" });
      const d3 = !badgeOn(3);
      // D4 이력 로드 창(그리기 미룸) → 그 사이 끝 → 창이 닫혀도 그리지 않음 → 늦은 재생 시작 무시
      const before4 = lines.length;
      loading = true;
      start({ threadKey: "t4", spanId: "D", pendingTurns: 0, waiting: true }, 6);
      stop({ threadKey: "t4", spanId: "D" });
      flushHeld();
      start({ threadKey: "t4", spanId: "D", pendingTurns: 0, waiting: true }, 6);
      const d4 = lines.length === before4;
      // D4b 이력 로드 창에서 같은 구간 시작(백그라운드)·갱신(요청 대기) → 창이 닫히면 줄 1·배지 1 · 끝에 걷힘(구현 검토 R2)
      const before4b = lines.length;
      loading = true;
      start({ threadKey: "t4b", spanId: "DB", pendingTurns: 3, waiting: false }, 16);
      start({ threadKey: "t4b", spanId: "DB", pendingTurns: 0, waiting: true }, 17);
      flushHeld();
      const d4bLines = lines.length - before4b;
      const d4bBadge = d4bLines === 1 && badgeOn(lines.length - 1);
      start({ threadKey: "t4b", spanId: "DB", pendingTurns: 0, waiting: true }, 18); // 늦게 또 온 갱신 — 그린 줄이 있으니 새 줄 0
      const d4bAfter = lines.length - before4b;
      stop({ threadKey: "t4b", spanId: "DB" });
      const d4b = d4bBadge && d4bAfter === 1 && !badgeOn(lines.length - 1);
      // D5 재생 — 같은 열을 두 번 받아도 줄 1
      const before5 = lines.length;
      for (let k = 0; k < 2; k++) { start({ threadKey: "t5", spanId: "E", pendingTurns: 3 }, 7); stop({ threadKey: "t5", spanId: "E" }); }
      const d5 = lines.length === before5 + 1;
      // D6 구간 없는 시작이 앞 칸을 덮으면 앞 배지를 걷는다
      start({ threadKey: "t6", pendingTurns: 0 }, 8);
      const i6 = lines.length - 1;
      start({ threadKey: "t6", pendingTurns: 0 }, 9);
      const d6 = !badgeOn(i6) && badgeOn(lines.length - 1);
      // D7 다른 대화를 보던 중 연 구간 → 그 대화로 와서 같은 구간 갱신 → 그때 그린다(구간 생존 ≠ 화면 표시)
      active = false;
      start({ threadKey: "t7", spanId: "G", pendingTurns: 3, waiting: false }, 10);
      const before7 = lines.length;
      active = true;
      start({ threadKey: "t7", spanId: "G", pendingTurns: 0, waiting: true }, 11);
      const d7 = lines.length === before7 + 1 && badgeOn(lines.length - 1);
      stop({ threadKey: "t7", spanId: "G" });
      const d7b = !badgeOn(lines.length - 1);
      // D8 탭 이동으로 목록이 바뀌어 줄이 목록에 없음 → 같은 구간 갱신에 다시 그린다 · 가상목록 이탈(목록 소유)은 다시 안 그린다
      start({ threadKey: "t8", spanId: "H", pendingTurns: 0, waiting: true }, 12);
      const i8 = lines.length - 1;
      (lines[i8]!.el as { isConnected: boolean }).isConnected = false; // 가상목록 이탈 — 소유는 유지
      start({ threadKey: "t8", spanId: "H", pendingTurns: 0, waiting: true }, 13);
      const d8a = lines.length === i8 + 1;
      owned.delete(lines[i8]!.el); // 탭 이동 — 목록에서 사라짐
      start({ threadKey: "t8", spanId: "H", pendingTurns: 0, waiting: true }, 14);
      const d8b = lines.length === i8 + 2;
      stop({ threadKey: "t8", spanId: "H" });
      // D9 장부 상한 — 열린 구간 하나를 둔 채 닫힌 기록 300+ 가 쌓여도 그 구간의 끝이 배지를 걷는다
      start({ threadKey: "t9", spanId: "LONG", pendingTurns: 0, waiting: true }, 15);
      const i9 = lines.length - 1;
      for (let k = 0; k < 320; k++) stop({ threadKey: "t9x", spanId: `x${k}` });
      const d9Still = badgeOn(i9); // 끝 전에는 그대로(상한이 진행 중 표시를 일찍 걷지 않는다)
      stop({ threadKey: "t9", spanId: "LONG" });
      const d9 = d9Still && !badgeOn(i9);
      // D10 이력 로드 중 구간 없는(Claude) 시작 → 끝 → 해제: 줄 0 · 시작 → 새 시작 → 해제: 새 것만 1줄(배지 1) · 보류 중 탭 이동 → 해제: 줄 0(구현 검토 R3)
      const b10 = lines.length;
      loading = true;
      start({ threadKey: "t10", pendingTurns: 0 }, 20);
      stop({ threadKey: "t10" });
      flushHeld();
      const d10a = lines.length === b10;
      loading = true;
      start({ threadKey: "t10b", pendingTurns: 0 }, 21);
      start({ threadKey: "t10b", pendingTurns: 0 }, 22);
      flushHeld();
      const d10b = lines.length === b10 + 1 && badgeOn(lines.length - 1);
      stop({ threadKey: "t10b" });
      const b10c = lines.length;
      loading = true;
      start({ threadKey: "t10c", spanId: "TAB", pendingTurns: 0, waiting: true }, 23);
      active = false; // 보류 중 다른 대화로 이동
      flushHeld();
      active = true;
      const d10c = lines.length === b10c;
      stop({ threadKey: "t10c", spanId: "TAB" });
      out.push(assert("★대시보드(이력 로드 중): 끝난 시작·덮인 시작의 미룬 그리기는 무효 · 보류 중 탭을 바꾸면 다른 대화에 그리지 않는다",
        d10a && d10b && d10c, { d10a, d10b, d10c }));
      out.push(assert("★대시보드: 다른 대화를 보던 중 연 구간도 그 대화로 와서 갱신되면 그린다 · 목록에서 사라진 줄은 다시 그리고 가상목록 이탈은 안 그린다 · 상한이 열린 구간을 버리지 않는다",
        d7 && d7b && d8a && d8b && d9, { d7, d7b, d8a, d8b, d9 }));
      out.push(assert("★대시보드: 같은 구간 갱신에 새 줄 0 · 구간 없는 끝/다른 구간 끝은 구간 표시를 안 걷음 · 떨어진 노드도 끝에서 걷힘 · 미룸·재생에 줄 중복 0 · 덮인 칸 잔여 0",
        d1 && d2 && d2b && d3 && d4 && d4b && d5 && d6, { d1, d2, d2b, d3, d4, d4b, d5, d6, lines: lines.length }));
      const wiring = /ev\.type === "llm\.compacting_ended"\)\s*\{\s*stopCompactingTick\(ev\.payload \|\| \{\}\)/.test(raw) &&
        /if \(!p\.spanId\) stopCompactingTick\(\{ threadKey: p\.threadKey \}\)/.test(raw) &&
        /ev\.type === "llm\.compacted"\)\s*\{\s*stopCompactingTick\(ev\.payload \|\| \{\}\)/.test(raw);
      out.push(assert("[배선 린트] 끝 이벤트 셋이 구간째 걷고, 구간 안 고착 경보는 걷지 않는다", wiring, wiring));
      // 실패 끝은 실패 문구다 — 완료 문구로 바뀌면 사용자가 실패와 완료를 못 가른다(독립 변이 사냥 M09). renderEvent 전체를 실행하기 어려워 분기 안 문구 선택을 린트로 본다.
      const failAt = raw.indexOf('ev.type === "llm.compact_failed"');
      const failBranch = failAt < 0 ? "" : raw.slice(failAt, raw.indexOf('if (ev.type === "llm.', failAt + 10));
      out.push(assert("[배선 린트] llm.compact_failed 분기는 실패 문구(sys.compact.failed)만 고른다",
        /i18n\("sys\.compact\.failed"/.test(failBranch) && !/sys\.compact\.done/.test(failBranch), { len: failBranch.length }));
    }

    // ⑤ 텔레그램 — 채널 스텁(실제 발송 0)
    {
      const { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
      const { registerWorkerHandler } = await import("../../core/worker-jobs.js");
      const { saveSession, setSessionChannelMeta, SESSION_STORAGE_CHANNEL } = await import("../../store/sessions.js");
      const got: { target: string; text: string }[] = [];
      let fail = false;
      const prev = getChannelOutbound("telegram");
      registerChannelOutbound("telegram", {
        deliver: async (target: string, text: string) => { if (fail) throw new Error("합성 발송 실패"); got.push({ target, text }); },
        defaultOutboundTarget: async () => "owner-default",
      } as never);
      registerWorkerHandler((async () => undefined) as never);
      const rnd = Math.random().toString(36).slice(2);
      const mk = (tk: string, ch: string, target: string): void => {
        saveSession({ channel: SESSION_STORAGE_CHANNEL, threadKey: tk, claudeSessionId: `regr-${rnd}-${tk}`, model: null, systemPromptHash: null });
        setSessionChannelMeta({ channel: SESSION_STORAGE_CHANNEL, threadKey: tk, lastChannel: ch as never, lastChannelTarget: target });
      };
      const TG = `dashboard:regr-wait-tg-${rnd}`, DB = `dashboard:regr-wait-db-${rnd}`;
      mk(TG, "telegram", "4242"); mk(DB, "http-bridge", DB);
      const bus = getEventBus();
      const pub = (type: string, payload: Record<string, unknown>) => bus.publish({ type, ts: Date.now(), payload } as never);
      try {
        pub("llm.compacting", { threadKey: TG, spanId: "s1", waiting: false, pendingTurns: 3 }); // 백그라운드 — 0
        pub("llm.compacting", { threadKey: TG, spanId: "s1", waiting: true, pendingTurns: 0 }); // 요청 대기 — 1
        pub("llm.compacting", { threadKey: TG, spanId: "s1", waiting: true, pendingTurns: 0 }); // 같은 구간 — 0
        pub("llm.compacting", { threadKey: DB, spanId: "s2", waiting: true, pendingTurns: 0 }); // 대시보드 세션 — 0
        await sleep(30);
        const afterFirst = got.length;
        pub("llm.compacted", { threadKey: TG, spanId: "s1" });
        pub("llm.compacting", { threadKey: TG, spanId: "s3", waiting: true, pendingTurns: 0 }); // 새 구간 — 1
        await sleep(30);
        const afterSecond = got.length;
        fail = true;
        pub("llm.compacting", { threadKey: TG, spanId: "s4", waiting: true, pendingTurns: 0 }); // 실패 — 던지지 않는다
        await sleep(30);
        fail = false;
        pub("llm.compacting", { threadKey: TG, spanId: "s4", waiting: true, pendingTurns: 0 }); // 실패 뒤 같은 구간 — 재발송 0
        await sleep(30);
        // 조용한 끝(compacting_ended)도 마커를 지운다 — 같은 구간 id 로 다시 오면 다시 보낸다(정리 확인용 합성 순서)
        const beforeQuiet = got.length;
        pub("llm.compacting_ended", { threadKey: TG, spanId: "s3", outcome: "cancelled" });
        pub("llm.compacting", { threadKey: TG, spanId: "s3", waiting: true, pendingTurns: 0 });
        await sleep(30);
        const quietCleared = got.length === beforeQuiet + 1;
        got.length = beforeQuiet;
        out.push(assert("텔레그램 마커는 조용한 끝(compacting_ended)에서도 지워진다", quietCleared, { quietCleared }));
        out.push(assert("★텔레그램: 요청 대기 구간당 1회(마지막 인입 텔레그램 chatId) · 백그라운드·같은 구간·대시보드 세션 0 · 끝 뒤 새 구간 1 · 실패 격리·재발송 0",
          afterFirst === 1 && got[0]?.target === "4242" && got[0]!.text.length > 0 && afterSecond === 2 && got.length === 2,
          { afterFirst, afterSecond, total: got.length, targets: got.map((g) => g.target) }));
      } finally {
        if (prev !== undefined) registerChannelOutbound("telegram", prev); else unregisterChannelOutbound("telegram");
      }
    }
    return out;
  },
};
