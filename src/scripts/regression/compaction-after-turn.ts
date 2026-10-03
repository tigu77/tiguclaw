/**
 * 회귀: **이력 요약은 답을 보낸 뒤 뒤에서 미리 돈다** — 다음 요청이 요약을 기다리지 않는다 (2026-09-29).
 *
 * 사고(회사돌쇠 09-29): 도구를 많이 쓰는 긴 세션에서 매 턴 **요청 직전에** 요약 3회 + 재압축 1~2회가 돌아
 * 92자 답에도 3~6분을 기다렸다. 돌쇠 재현: 파일 6개를 읽는 턴부터 매 턴 요약 40~45초.
 * 처방: 같은 설정(모델·강도·요약기)으로 **턴 저장 직후** 접는다 — 접는 내용은 요청 때와 같다(능력 손실 0).
 *  다음 요청은 돌고 있으면 기다리고, 끝나 있으면 접을 게 없다.
 * ★경합: 뒤에서 접는 동안 `/clear`(대화 끊기)가 오면 **지운 대화의 요약을 다시 써넣으면 안 된다**.
 *
 * 요약 LLM 만 가짜(포트)이고 계획·루프·워터마크·저장·경합 판정은 전부 제품 코드다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

export const check: RegressionCheck = {
  name: "compaction-after-turn",
  guards:
    "이력 요약이 다음 요청 직전에 돌아 사용자가 매 턴 수 분을 기다리던 것(회사돌쇠 09-29) — 턴 뒤 미리 접기 · 다음 요청은 기다리기만 · /clear 경합에서 지운 대화 부활 금지",
  run: async (): Promise<Assertion[]> => {
    const {
      buildTurnHistory,
      setSummarizerPort,
      compactHistoryAfterTurn,
      compactThreadHistory,
      compactThreadNow,
      settleThreadCompaction,
      CODEX_HISTORY_COMPACT_TRIGGER_CHARS: TRIGGER,
      SUMMARY_SECTION_SEP,
      historyTriggerChars,
      historyFixedChars,
      lowWaterMark,
    } = await import(SRC);
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    const { getThreadSummary, clearThreadSummary, upsertThreadSummary } = await import("../../store/thread-summaries.js");
    const { resetThreadContext } = await import("../../store/thread-reset.js");
    initStore();

    let ts = 1_750_000_000_000;
    const seed = (tk: string, sid: string, turns: number, charsEach: number): void => {
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: sid });
      for (let i = 0; i < turns; i++) {
        appendTranscript({
          claudeSessionId: sid,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `턴${i}:` + "가".repeat(charsEach),
          ts: (ts += 60_000),
        });
      }
    };
    const request = (tk: string) =>
      buildTurnHistory({ threadKey: tk, channel: "http-bridge", provider: "codex-oauth" }, "현재 턴 프롬프트", [], "fake-token", undefined, "fake-model");

    let calls = 0;
    let delayMs = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    // 결정적 붙잡기 — `hold()` 뒤 첫 요약 호출이 `release()` 전까지 멈춘다(타이머 경쟁 없이 순서를 만든다).
    let holdNext = false;
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const hold = (): Promise<void> => {
      holdNext = true;
      return new Promise<void>((r) => (entered = r));
    };
    let tag = "요약";
    // 다음 요약 호출이 이 오류로 끝난다 — 실제 fetch 가 끊겼을 때(`/stop`·무응답 타임아웃)의 모양.
    let throwNext: Error | null = null;
    // ★한 벌이다 — 중간 시나리오가 다른 요약기로 바꿨다가 **이걸 다시 끼운다**(복사본으로 되돌리면 한쪽만 고쳐진다).
    const basePort = async (_text: string, target: number): Promise<string> => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (holdNext) {
          holdNext = false;
          entered();
          await new Promise<void>((r) => (release = r));
        }
        if (throwNext !== null) {
          const e = throwNext;
          throwNext = null;
          throw e;
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return `${tag}${calls}:` + "약".repeat(Math.max(0, Math.min(target, 400) - 5));
      } finally {
        inFlight -= 1;
      }
    };
    setSummarizerPort(basePort);
    const out: Assertion[] = [];
    try {
      const per = Math.ceil((TRIGGER as number) / 40);

      // ① 요청 때 한 번 접고(설정이 기억된다) → 그 뒤 크게 쌓이면 **턴 뒤**에서 접는다 → 다음 요청은 안 접는다.
      const A = "dashboard:regr-compact-after-turn-a";
      clearThreadSummary("http-bridge", A);
      seed(A, "regr-cat-a", 60, per);
      await request(A);
      const firstCalls = calls;
      seed(A, "regr-cat-a", 60, per); // 무거운 턴들이 더 쌓였다
      calls = 0;
      const job = compactHistoryAfterTurn(A);
      await job;
      const postCalls = calls;
      calls = 0;
      await request(A);
      const nextCalls = calls;
      out.push(
        assert(
          "★크게 쌓이면 **턴 뒤**에서 접고, 다음 요청은 접을 게 없어 바로 간다(대기 0)",
          firstCalls > 0 && job !== undefined && postCalls > 0 && nextCalls === 0,
          `요청1 요약=${firstCalls} · 턴 뒤=${postCalls} · 다음 요청=${nextCalls}`,
        ),
      );

      // ② 턴 뒤 접기가 **아직 도는 중**에 다음 요청이 오면 기다린다 — 같은 걸 두 번 접지도, 잘라내고 보내지도 않는다.
      const B = "dashboard:regr-compact-after-turn-b";
      clearThreadSummary("http-bridge", B);
      seed(B, "regr-cat-b", 60, per);
      await request(B);
      seed(B, "regr-cat-b", 60, per);
      calls = 0;
      maxInFlight = 0;
      delayMs = 30;
      const running = compactHistoryAfterTurn(B);
      const concurrent = await request(B);
      await running;
      delayMs = 0;
      const summaryB = getThreadSummary(B);
      out.push(
        assert(
          "★뒤에서 접는 중에 온 요청은 **끝날 때까지 기다렸다가** 그 결과로 조립한다(중복 접기 없음)",
          // 기다리지 않으면 요청이 같은 이력을 **동시에** 접는다 — 요약 호출이 겹친다.
          running !== undefined && calls > 0 && maxInFlight === 1 && Array.isArray(concurrent) && (summaryB?.summary ?? "") !== "",
          `요약 호출=${calls} · 동시 최대=${maxInFlight} · 조립 항목=${Array.isArray(concurrent) ? concurrent.length : "?"} · 요약=${(summaryB?.summary ?? "").length}자`,
        ),
      );

      // ③ 뒤에서 접는 중 `/clear` — 지운 대화의 요약을 **다시 써넣지 않는다**.
      const C = "dashboard:regr-compact-after-turn-c";
      clearThreadSummary("http-bridge", C);
      seed(C, "regr-cat-c", 60, per);
      await request(C);
      seed(C, "regr-cat-c", 60, per);
      const beforeClear = getThreadSummary(C)?.summary.length ?? 0;
      delayMs = 40;
      const racing = compactHistoryAfterTurn(C);
      await new Promise((r) => setTimeout(r, 10)); // 첫 요약 호출이 날아간 뒤
      resetThreadContext("http-bridge", C);
      await racing;
      delayMs = 0;
      const afterClear = getThreadSummary(C);
      out.push(
        assert(
          "★뒤에서 접는 중 /clear 가 오면 그 요약은 버린다 — 지운 대화가 요약으로 되살아나지 않는다",
          beforeClear > 0 && racing !== undefined && (afterClear === null || afterClear === undefined || afterClear.summary === ""),
          `초기화 전 요약 ${beforeClear}자 · 초기화 뒤 ${afterClear ? afterClear.summary.length + "자" : "없음"}`,
        ),
      );

      // ④' 뒤에서 접는 중에 요청이 줄을 서면 **패스 사이에서 양보**한다 (2026-10-03, 회사돌쇠 압축 인계서 1단계).
      //  회사 9/30: 답변 뒤 9패스 + 재압축이 잠금을 쥔 동안 새 메시지가 수분 기다렸다 — «뒤에선 기다리는 사람이 없다» 가
      //  새 메시지가 오는 순간 거짓이 된다. 대조군: 같은 양을 줄 선 요청 없이 접으면 여러 패스를 돈다(양보가 계획 탓이 아니다).
      {
        const yieldLines: string[] = [];
        const realLog = console.log;
        console.log = (...a: unknown[]): void => {
          const t = a.map(String).join(" ");
          if (t.includes("턴 뒤 접기 양보")) yieldLines.push(t);
          else realLog(...a);
        };
        try {
          const ctl = "dashboard:regr-compact-yield-control";
          clearThreadSummary("http-bridge", ctl);
          seed(ctl, "regr-cy-ctl", 60, per);
          await request(ctl);
          seed(ctl, "regr-cy-ctl", 240, per);
          calls = 0;
          await compactHistoryAfterTurn(ctl);
          const controlCalls = calls;
          // 대조군의 다음 요청이 조립하는 이력 — 양보한 쪽도 결국 **이만큼**을 실어야 한다(맥락 손실 0).
          const controlAssembled = await request(ctl);

          const Y = "dashboard:regr-compact-yield";
          clearThreadSummary("http-bridge", Y);
          seed(Y, "regr-cy", 60, per);
          await request(Y);
          seed(Y, "regr-cy", 240, per);
          calls = 0;
          maxInFlight = 0;
          const gateY = hold();
          const bgY = compactHistoryAfterTurn(Y);
          // 첫 패스의 요약 호출이 날아가 붙잡혔다 — ★시한을 둔다: 패스가 아예 안 시작되면(양보를 너무 일찍 하면) 붙잡기가
          //  영원히 안 풀려 검사가 실패 보고 없이 멈춘다(변이로 확인). 그 경우도 빨강으로 보이게.
          const enteredY = await Promise.race([gateY.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3_000))]);
          if (!enteredY) holdNext = false;
          const reqY = request(Y); // 그 사이 요청이 줄을 선다
          await new Promise((r) => setTimeout(r, 5));
          release();
          await bgY;
          const assembled = await reqY;
          const ctlLen = Array.isArray(controlAssembled) ? controlAssembled.length : -1;
          const yLen = Array.isArray(assembled) ? assembled.length : -2;
          out.push(
            assert(
              "★뒤에서 접는 중 요청이 줄을 서면 지금 패스까지만 하고 양보한다(1패스) · 줄이 없으면 여러 패스를 돈다 · 요청은 정상 조립 · 요약 호출이 겹치지 않는다 · ★양보한 몫을 요청이 이어받아 **대조군과 같은 이력**을 싣는다(창 안전망이 중간을 자르지 않는다)",
              enteredY && controlCalls > 1 && yLen === ctlLen && yieldLines.length === 1 && /\b1\/\d+패스에서 멈춤/.test(yieldLines[0] ?? "") && Array.isArray(assembled) && maxInFlight === 1,
              { enteredY, controlCalls, yieldLines, assembled: yLen, controlAssembled: ctlLen, maxInFlight },
            ),
          );
        } finally {
          console.log = realLog;
        }
      }

      // ⑤ 수동 /compact 가 뒤에서 도는 요약을 **덮지 않는다** — 같은 잠금에 줄 서고, 워터마크는 뒤로 가지 않는다(아스트라 P4).
      const D = "dashboard:regr-compact-after-turn-d";
      clearThreadSummary("http-bridge", D);
      seed(D, "regr-cat-d", 60, per);
      await request(D);
      seed(D, "regr-cat-d", 60, per);
      tag = "뒤";
      maxInFlight = 0;
      let gate = hold();
      const bg = compactHistoryAfterTurn(D);
      await gate;
      tag = "수";
      const manual = compactThreadNow("http-bridge", D, "fake-model", "fake-token", undefined);
      release();
      await bg;
      const afterBg = getThreadSummary(D);
      await manual;
      const afterManual = getThreadSummary(D);
      tag = "요약";
      out.push(
        assert(
          "★수동 /compact 는 뒤에서 도는 요약 뒤에 줄 선다 — 먼저 끝난 요약을 지우지 않고 워터마크를 되돌리지 않는다",
          // 잠금이 없으면 수동 요약이 붙잡힌 뒤 요약과 **동시에** 요약기를 부른다(동시 최대 2).
          maxInFlight === 1 && afterBg !== undefined && afterManual !== undefined &&
            afterManual.compactedThrough >= afterBg.compactedThrough && afterManual.summary.includes(afterBg.summary.slice(0, 30)),
          `동시 최대=${maxInFlight} · 뒤 요약 후 워터마크=${afterBg?.compactedThrough} · 수동 후=${afterManual?.compactedThrough} · 뒤 요약 보존=${afterManual?.summary.includes((afterBg?.summary ?? "~").slice(0, 30))}`,
        ),
      );

      // ⑥ 뒤 요약과 수동 요약이 둘 다 기다리는 중 /clear — **어느 쪽도** 지운 대화를 되살리지 않는다(아스트라 P4 재현 B).
      const E = "dashboard:regr-compact-after-turn-e";
      clearThreadSummary("http-bridge", E);
      seed(E, "regr-cat-e", 60, per);
      await request(E);
      seed(E, "regr-cat-e", 60, per);
      gate = hold();
      const bgE = compactHistoryAfterTurn(E);
      await gate;
      const manualE = compactThreadNow("http-bridge", E, "fake-model", "fake-token", undefined);
      resetThreadContext("http-bridge", E);
      release();
      await bgE;
      await manualE;
      const afterE = getThreadSummary(E);
      out.push(
        assert(
          "★두 요약이 기다리는 중 /clear 가 와도 어느 쪽도 옛 요약을 되살리지 않는다",
          afterE === undefined || afterE === null || afterE.summary === "",
          `초기화 뒤 요약=${afterE ? afterE.summary.length + "자" : "없음"}`,
        ),
      );

      // ⑦ 같은 길이의 다른 요약으로 바뀌어도 알아챈다(리비전) — 길이만 보던 가드는 옛 요약으로 덮었다(아스트라 P1).
      const F = "dashboard:regr-compact-after-turn-f";
      clearThreadSummary("http-bridge", F);
      seed(F, "regr-cat-f", 60, per);
      await request(F);
      seed(F, "regr-cat-f", 60, per);
      gate = hold();
      const bgF = compactHistoryAfterTurn(F);
      await gate;
      const prevF = getThreadSummary(F)!;
      const replacement = "새".repeat(prevF.summary.length);
      upsertThreadSummary({ threadKey: F, summary: replacement, compactedThrough: prevF.compactedThrough });
      release();
      await bgF;
      const afterF = getThreadSummary(F)!;
      out.push(
        assert(
          "★요약 중 다른 쓰기가 같은 길이로 바꿔도 알아채고 덮지 않는다(길이가 아니라 리비전으로 판정)",
          afterF.summary === replacement,
          `대체본 보존=${afterF.summary === replacement} · 워터마크 ${prevF.compactedThrough}→${afterF.compactedThrough}`,
        ),
      );

      // ⑧ 앞선 요약을 **기다리는 요청**도 자기 취소로 바로 빠진다(아스트라 P2 — 종전엔 취소가 대기에 닿지 않았다).
      const G = "dashboard:regr-compact-after-turn-g";
      clearThreadSummary("http-bridge", G);
      seed(G, "regr-cat-g", 60, per);
      await request(G);
      seed(G, "regr-cat-g", 60, per);
      gate = hold();
      const bgG = compactHistoryAfterTurn(G);
      await gate;
      const ac = new AbortController();
      let cancelled = "";
      const waiting = buildTurnHistory(
        { threadKey: G, channel: "http-bridge", provider: "codex-oauth", abortSignal: ac.signal },
        "현재 턴 프롬프트", [], "fake-token", undefined, "fake-model",
      ).then(() => "끝남", (e: unknown) => (cancelled = e instanceof Error ? e.name : String(e)));
      ac.abort();
      const raced = await Promise.race([waiting, new Promise((r) => setTimeout(() => r("아직 대기"), 200))]);
      release();
      await bgG;
      await waiting;
      out.push(
        assert(
          "★요약을 기다리던 요청은 취소하면 바로 빠진다(앞선 요약이 끝날 때까지 붙잡히지 않는다)",
          raced !== "아직 대기" && raced !== "끝남" && cancelled !== "",
          `200ms 안 결과=${String(raced)} · 오류=${cancelled || "없음"}`,
        ),
      );

      // ⑨ 뒤에서 접기의 기준 — **접을지**는 직전 턴 크기로, **얼마나**는 프롬프트 몫 0 저수위까지 (2026-09-29 재검토 P2).
      //  (a) 경량 세션: 이력이 요청 기준(133K−p)과 몫 0 기준(133K) 사이에 들면, 몫 0 으로만 판정하던 판은 뒤에서 건너뛰고
      //      **요청 때** 접었다(대기 재발). 이제 뒤에서 접고 다음 요청은 안 접는다.
      //  (b) 큰 프롬프트 뒤: 접은 뒤 몫 상한(50K) 요청도 다시 접지 않는다(저수위가 모든 요청 기준 아래).
      const summarizeFake = async (): Promise<string> => "요".repeat(400);
      const reqWith = (tk: string, promptChars: number) =>
        compactThreadHistory({ channel: "http-bridge", threadKey: tk, provider: "codex-oauth", adapter: "codex", budget: { instructionsChars: 47_000, promptChars }, summarize: summarizeFake });
      const hiSmall = historyTriggerChars(historyFixedChars(47_000, 8_000)) as number;
      const hiZero = historyTriggerChars(historyFixedChars(47_000, 0)) as number;
      const Hs = "dashboard:regr-compact-after-turn-h1";
      clearThreadSummary("http-bridge", Hs);
      await reqWith(Hs, 8_000); // 설정 기억(이력 없음)
      // 이력을 두 기준 **사이**로 채운다
      const target = Math.floor((hiSmall + hiZero) / 2);
      seed(Hs, "regr-cat-h1", 40, Math.ceil(target / 40));
      await compactHistoryAfterTurn(Hs);
      const postFoldedSmall = (getThreadSummary(Hs)?.compactedThrough ?? 0) > 0;
      calls = 0;
      const ports: number[] = [];
      setSummarizerPort(async (_t: string, target2: number) => { ports.push(1); return "약".repeat(Math.min(target2, 400)); });
      await compactThreadHistory({ channel: "http-bridge", threadKey: Hs, provider: "codex-oauth", adapter: "codex", budget: { instructionsChars: 47_000, promptChars: 8_000 }, summarize: async () => { ports.push(1); return "요".repeat(400); } });
      const nextSmallCalls = ports.length;
      out.push(
        assert(
          "★경량 세션도 뒤에서 접고 다음 요청은 안 접는다(몫 0 으로만 판정하면 두 기준 사이에서 요청 때 접었다)",
          postFoldedSmall && nextSmallCalls === 0,
          `기준 ${hiSmall}~${hiZero}자 사이 이력 → 뒤에서 접음=${postFoldedSmall} · 다음 요청 요약=${nextSmallCalls}`,
        ),
      );
      const Hb = "dashboard:regr-compact-after-turn-h2";
      clearThreadSummary("http-bridge", Hb);
      await reqWith(Hb, 50_000);
      seed(Hb, "regr-cat-h2", 60, 1800);
      await compactHistoryAfterTurn(Hb);
      ports.length = 0;
      await compactThreadHistory({ channel: "http-bridge", threadKey: Hb, provider: "codex-oauth", adapter: "codex", budget: { instructionsChars: 47_000, promptChars: 50_000 }, summarize: async () => { ports.push(1); return "요".repeat(400); } });
      // 과잉 접기 제한 — 원문은 **몫 0 기준 저수위 가까이** 남는다(직전 큰 프롬프트 기준 저수위까지 더 깊이 접지 않는다).
      const { loadThreadHistoryWithIds } = await import("../../store/memory.js");
      const wmB = getThreadSummary(Hb)?.compactedThrough ?? 0;
      const rawLeft = (loadThreadHistoryWithIds("http-bridge", Hb) as Array<{ id: number; content: string }>)
        .filter((t) => t.id > wmB)
        .reduce((n, t) => n + t.content.length, 0);
      const deepLow = lowWaterMark(historyTriggerChars(historyFixedChars(47_000, 50_000))) as number;
      out.push(
        assert(
          "★뒤에서 접은 뒤엔 몫 상한(50K) 프롬프트 요청도 다시 접지 않고, 원문은 직전 큰 프롬프트 기준보다 **덜** 접힌다",
          wmB > 0 && ports.length === 0 && rawLeft > deepLow,
          `뒤 워터마크=${wmB} · 큰 프롬프트 요청 요약=${ports.length} · 남은 원문=${rawLeft}자 > 깊은 저수위 ${deepLow}자`,
        ),
      );
      setSummarizerPort(basePort);

      // ⑬ 잠금 우회 — 대기 중 취소된 **마지막** 대기자가 항목을 지워 다음 요청이 잠금을 건너뛰던 것(재검토 P2, 실측 재현).
      const Lk = "dashboard:regr-compact-after-turn-lock";
      clearThreadSummary("http-bridge", Lk);
      seed(Lk, "regr-cat-lock", 60, per);
      await request(Lk);
      seed(Lk, "regr-cat-lock", 60, per);
      gate = hold();
      const bgL = compactHistoryAfterTurn(Lk);
      await gate;
      const callsHeld = calls;
      const acL = new AbortController();
      const r1 = buildTurnHistory({ threadKey: Lk, channel: "http-bridge", provider: "codex-oauth", abortSignal: acL.signal }, "현재 턴 프롬프트", [], "fake-token", undefined, "fake-model").catch(() => "취소");
      acL.abort();
      await r1;
      const pre = new AbortController();
      pre.abort();
      const preR = await Promise.race([
        buildTurnHistory({ threadKey: Lk, channel: "http-bridge", provider: "codex-oauth", abortSignal: pre.signal }, "현재 턴 프롬프트", [], "fake-token", undefined, "fake-model").then(() => "끝남", () => "즉시 취소"),
        new Promise((r) => setTimeout(() => r("붙잡힘"), 100)),
      ]);
      const r2 = request(Lk);
      await new Promise((r) => setTimeout(r, 60));
      const callsWhileHeld = calls - callsHeld;
      release();
      await bgL;
      await r2;
      out.push(
        assert(
          "★대기 중 취소된 마지막 대기자가 잠금을 풀지 않는다 — 뒤 요약이 도는 동안 다음 요청은 요약을 시작하지 않는다 · 미리 취소된 요청은 즉시 빠진다",
          callsWhileHeld === 0 && preR === "즉시 취소",
          `붙잡힌 동안 다음 요청의 요약 호출=${callsWhileHeld} · 미리 취소=${String(preR)}`,
        ),
      );

      // ⑭ 누적 요약 **재압축** 중 /clear — 재압축 경로도 옛 요약을 되살리지 않는다(재검토 G: 이 경로 검사가 없었다).
      const Rc = "dashboard:regr-compact-after-turn-recompact";
      clearThreadSummary("http-bridge", Rc);
      seed(Rc, "regr-cat-rc", 4, 100);
      await request(Rc); // 설정 기억(작은 이력 — 접을 것 없음)
      const bigSummary = Array.from({ length: 12 }, (_, i) => `구간${i}:` + "요".repeat(2_400)).join(SUMMARY_SECTION_SEP as string);
      upsertThreadSummary({ threadKey: Rc, summary: bigSummary, compactedThrough: getThreadSummary(Rc)?.compactedThrough ?? 0 });
      gate = hold();
      const bgR = compactHistoryAfterTurn(Rc);
      await gate; // 재압축 요약 호출이 붙잡혔다
      resetThreadContext("http-bridge", Rc);
      release();
      await bgR;
      const afterRc = getThreadSummary(Rc);
      out.push(
        assert(
          "★재압축 요약 중 /clear 가 오면 재압축 결과도 저장하지 않는다",
          afterRc === undefined || afterRc === null || afterRc.summary === "",
          `초기화 뒤 요약=${afterRc ? afterRc.summary.length + "자" : "없음"}`,
        ),
      );

      // ⑩ 수동 /compact 혼자 요약하는 중 /clear — 잠금 밖 변경이라 **리비전**으로만 잡힌다(지운 대화 부활 금지).
      const I = "dashboard:regr-compact-after-turn-i";
      clearThreadSummary("http-bridge", I);
      seed(I, "regr-cat-i", 60, per);
      gate = hold();
      const manualI = compactThreadNow("http-bridge", I, "fake-model", "fake-token", undefined);
      await gate;
      resetThreadContext("http-bridge", I);
      release();
      const resI = await manualI;
      const afterI = getThreadSummary(I);
      out.push(
        assert(
          "★수동 /compact 가 요약하는 중 /clear 가 오면 저장하지 않는다",
          (afterI === undefined || afterI === null || afterI.summary === "") && (resI as { ok: boolean }).ok === false,
          `요약=${afterI ? afterI.summary.length + "자" : "없음"} · 결과=${JSON.stringify(resI).slice(0, 80)}`,
        ),
      );

      // ⑪ 경계**만** 움직여도(스케줄 «직전 N회» 가 요약은 두고 경계만 민다) 뒤 요약은 낡은 것으로 버린다.
      const J = "dashboard:regr-compact-after-turn-j";
      clearThreadSummary("http-bridge", J);
      seed(J, "regr-cat-j", 60, per);
      await request(J);
      seed(J, "regr-cat-j", 60, per);
      const beforeJ = getThreadSummary(J)!;
      gate = hold();
      const bgJ = compactHistoryAfterTurn(J);
      await gate;
      const { setContextBoundary } = await import("../../store/sessions.js");
      setContextBoundary("http-bridge", J, Date.now());
      release();
      await bgJ;
      const afterJ = getThreadSummary(J)!;
      out.push(
        assert(
          "★요약 중 대화 경계만 움직여도 뒤 요약은 저장하지 않는다(경계 변경도 리비전을 올린다)",
          afterJ.compactedThrough === beforeJ.compactedThrough && afterJ.summary === beforeJ.summary,
          `워터마크 ${beforeJ.compactedThrough}→${afterJ.compactedThrough} · 요약 불변=${afterJ.summary === beforeJ.summary}`,
        ),
      );

      // ⑫ 워터마크는 뒤로 가지 않는다 — 저장 계층이 직접 막는다(늦게 끝난 옛 요약 방어의 마지막 선).
      {
        const K = "dashboard:regr-compact-after-turn-k";
        clearThreadSummary("http-bridge", K);
        upsertThreadSummary({ threadKey: K, summary: "앞선 요약", compactedThrough: 84 });
        const accepted = upsertThreadSummary({ threadKey: K, summary: "늦게 끝난 옛 요약", compactedThrough: 28 });
        const kept = getThreadSummary(K);
        out.push(
          assert(
            "★더 낮은 워터마크의 저장은 거절된다(이미 접은 범위를 되돌리지 않는다)",
            accepted === false && kept?.compactedThrough === 84 && kept.summary === "앞선 요약",
            `저장=${String(accepted)} · 워터마크=${kept?.compactedThrough} · 요약=${kept?.summary}`,
          ),
        );
      }

      // ④ 파생 스레드(매니저·에이전트)와 이번 턴에 이력을 조립하지 않은 스레드는 **돌리지 않는다**.
      const W = "worker:regr-compact-after-turn";
      clearThreadSummary("http-bridge", W);
      seed(W, "regr-cat-w", 60, per);
      await request(W); // 설정이 기억된 상태에서도 파생 스레드는 안 돌린다
      const derived = compactHistoryAfterTurn(W);
      const untouched = compactHistoryAfterTurn("dashboard:regr-compact-after-turn-none");
      out.push(
        assert(
          "파생 스레드·이번 턴에 조립 안 한 스레드는 뒤에서 접지 않는다(1회성 스레드에 요약 낭비 0)",
          derived === undefined && untouched === undefined,
          `worker=${String(derived)} · 미조립=${String(untouched)}`,
        ),
      );

      // ⑭ 수동 /compact 도 `/stop` 으로 끊긴다 (2026-09-29 백로그 P1). 종전엔 앞선 요약이 끝날 때까지 이 대화의 큐를
      //  붙잡았고 끊을 수단이 없었다. (a) 잠금 대기 중 취소 = 바로 빠지고 잠금은 그대로 · (b) 요약 중 취소 = 실패로 안 셈
      //  · (c) 신호 없이 난 AbortError(무응답 타임아웃)는 **실패로 답한다** — 오류 모양이 아니라 명령의 신호로 가른다.
      const M = "dashboard:regr-compact-after-turn-m";
      clearThreadSummary("http-bridge", M);
      seed(M, "regr-cat-m", 60, per);
      await request(M);
      seed(M, "regr-cat-m", 60, per);
      maxInFlight = 0;
      gate = hold();
      const bgM = compactHistoryAfterTurn(M);
      await gate;
      const acM = new AbortController();
      let mErr = "";
      const manualM = compactThreadNow("http-bridge", M, "fake-model", "fake-token", undefined, undefined, acM.signal)
        .then(() => "끝남", (e: unknown) => (mErr = e instanceof Error ? e.name : String(e)));
      acM.abort(Object.assign(new Error("user cancelled turn (/stop)"), { name: "UserCancelledError" }));
      const mRaced = await Promise.race([manualM, new Promise((r) => setTimeout(() => r("아직 대기"), 200))]);
      release();
      await bgM;
      const afterBgM = getThreadSummary(M);
      out.push(
        assert(
          "★(a) 앞선 요약을 기다리던 수동 /compact 는 /stop 에 바로 빠지고, 뒤 요약은 혼자 끝까지 돈다",
          mRaced !== "아직 대기" && mRaced !== "끝남" && mErr === "UserCancelledError" &&
            maxInFlight === 1 && afterBgM !== undefined && afterBgM !== null,
          `200ms 안 결과=${String(mRaced)} · 오류=${mErr || "없음"} · 동시 최대=${maxInFlight} · 뒤 요약 저장=${afterBgM ? "O" : "X"}`,
        ),
      );
      const N = "dashboard:regr-compact-after-turn-n";
      clearThreadSummary("http-bridge", N);
      // 실패 기록(끝 신호·연속 실패 경보의 입구)을 센다 — 사용자 자신의 정지를 고장으로 세면 경보가 그걸로 운다.
      const { getEventBus } = await import("../../core/eventbus.js");
      let failedN = 0;
      const unsubN = getEventBus().subscribe((e: { type: string; payload: { threadKey?: string } }) => {
        if (e.type === "llm.compact_failed" && e.payload.threadKey === N) failedN += 1;
      });
      seed(N, "regr-cat-n", 60, per);
      const acN = new AbortController();
      gate = hold();
      let nErr = "";
      const manualN = compactThreadNow("http-bridge", N, "fake-model", "fake-token", undefined, undefined, acN.signal)
        .then((r: { ok: boolean }) => `답:${r.ok}`, (e: unknown) => (nErr = e instanceof Error ? e.name : String(e)));
      await gate;
      acN.abort();
      throwNext = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      release();
      const nOut = await manualN;
      const afterN = getThreadSummary(N);
      const failedOnCancel = failedN;
      // (c) 신호는 멀쩡한데 요약 호출이 AbortError(무응답 타임아웃) — 사용자에게 실패로 답한다.
      throwNext = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      const timedOut = await compactThreadNow("http-bridge", N, "fake-model", "fake-token", undefined, undefined, new AbortController().signal)
        .then((r: { ok: boolean; reason?: string }) => r, (e: unknown) => ({ threw: e instanceof Error ? e.name : String(e) }));
      unsubN();
      out.push(
        assert(
          "★(b) 요약 중 /stop 은 던져서 끝낸다(저장 0 · 실패 기록 0) · (c) 신호 없는 AbortError 는 실패로 답하고 기록한다",
          nErr === "AbortError" && nOut === "AbortError" && (afterN === undefined || afterN === null) && failedOnCancel === 0 &&
            "ok" in timedOut && timedOut.ok === false && failedN === 1,
          `요약 중 취소=${String(nOut)} · 저장=${afterN ? "O" : "X"} · 취소 때 실패 기록=${failedOnCancel} · 타임아웃=${JSON.stringify(timedOut)} · 타임아웃 기록=${failedN - failedOnCancel}`,
        ),
      );

      // ⑮ 요약 줄 비우기 기다림 — 턴 뒤 요약이 도는 동안엔 안 끝나고, 끝나면 바로 끝난다(벤치 집계가 이걸 기다린다).
      const Q = "dashboard:regr-compact-after-turn-q";
      clearThreadSummary("http-bridge", Q);
      seed(Q, "regr-cat-q", 60, per);
      await request(Q);
      seed(Q, "regr-cat-q", 60, per);
      gate = hold();
      const bgQ = compactHistoryAfterTurn(Q);
      await gate;
      const q = { settled: false };
      const settling = settleThreadCompaction(Q).then(() => (q.settled = true));
      await new Promise((r) => setTimeout(r, 50));
      const whileRunning = q.settled;
      release();
      await bgQ;
      await settling;
      const idle = await Promise.race([settleThreadCompaction("dashboard:regr-compact-after-turn-idle").then(() => "끝남"), new Promise((r) => setTimeout(() => r("멈춤"), 200))]);
      out.push(
        assert(
          "★요약 줄 기다림은 턴 뒤 요약이 끝날 때까지 안 끝나고, 끝나면 풀린다 · 줄이 없으면 바로 끝난다",
          whileRunning === false && q.settled && getThreadSummary(Q) !== undefined && idle === "끝남",
          `도는 중 끝남=${whileRunning} · 뒤 요약 후=${q.settled} · 빈 줄=${String(idle)}`,
        ),
      );
    } finally {
      setSummarizerPort(null);
    }
    // ⑤ 배선 — 공통 경로가 **저장 직후** 부른다(어댑터가 아니라 facade 한 곳 — 두 어댑터가 같이 받는다).
    {
      const { readSourceSync } = await import("./_wiring.js");
      const facade = readSourceSync("src/core/llm-runtime/index.ts");
      const wired = /appendApiTurn\(\{[\s\S]{0,500}\}\);\s*(\/\/[^\n]*\n\s*)*void compactHistoryAfterTurn\(input\.threadKey\);/.test(facade);
      out.push(assert("★공통 경로가 턴 저장 직후 뒤에서 접기를 시작한다(기다리지 않는다)", wired, `facade 배선=${wired}`));
      // 두 어댑터 모두 이 턴의 취소를 드라이버에 넘긴다 — 안 넘기면 앞선 요약을 기다리는 동안 /stop 이 안 듣는다.
      const codexSrc = readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth-history.ts");
      const openaiSrc = readSourceSync("src/core/llm-runtime/adapters/openai-agents-sdk.ts");
      const sig = {
        codex: /adapter: "codex",[\s\S]{0,300}signal: input\.abortSignal,/.test(codexSrc),
        openai: /adapter: "openai",[\s\S]{0,600}signal: input\.abortSignal,/.test(openaiSrc),
        openaiCloses: /compactThreadHistory\(\{[\s\S]{0,6000}\}\)\.catch\(async \(e: unknown\) => \{[\s\S]{0,400}await server\.close\(\);/.test(openaiSrc),
      };
      out.push(assert("★두 어댑터가 취소를 드라이버에 넘기고, openai 는 대기 중 취소 때 연 브리지를 닫는다", sig.codex && sig.openai && sig.openaiCloses, JSON.stringify(sig)));
      // 수동 /compact — 진행 중 작업으로 등록돼 `/stop` 이 찾고, 그 신호가 잠금 대기와 요약 호출까지 간다.
      const entry = readSourceSync("src/index.ts");
      const slash = readSourceSync("src/core/entry/slash-commands.ts");
      const manualSig = {
        // 통지 좌표(재시작 알림이 텔레그램에 닿는다) · 끝나면 **자기 항목만** 치운다(새면 /health·작업표시가 굳는다).
        registered: /cmd === "\/compact"\) \{[\s\S]{0,600}target: msg\.channelAddress \?\? null,\s*command: true,[\s\S]{0,100}inflightTurns\.set\(msg\.threadKey, compactEntry\);[\s\S]{0,200}handleCompact\(\{ \.\.\.slashCtx, signal: compactEntry\.ac\.signal \}\);\s*\} finally \{\s*if \(inflightTurns\.get\(msg\.threadKey\) === compactEntry\) inflightTurns\.delete\(msg\.threadKey\);/.test(entry),
        handler: /compactThreadNow\([\s\S]{0,300}resolveReasoningEffort\("codex", codexModel\),\s*signal,\s*\)/.test(slash),
        summarizer: /const compactThreadNowUnlocked = [\s\S]{0,4000}runSummarizer\([\s\S]{0,200}turnReasoning,\s*signal,\s*threadKey,/.test(codexSrc),
        keepsJobs: /const stopped = entry\.command === true \? 0 : cancelJobsForThread\(msg\.threadKey\);/.test(entry),
        lock: /withThreadCompactionLock\(a\[1\], \(\) => compactThreadNowUnlocked\(\.\.\.a\), a\[6\]\)/.test(codexSrc),
      };
      out.push(
        assert(
          "★수동 /compact 는 진행 중 작업으로 등록되고, 그 신호가 잠금 대기·요약 호출까지 간다 · 그걸 멈추는 /stop 은 매니저 잡을 안 끊는다",
          manualSig.registered && manualSig.handler && manualSig.summarizer && manualSig.lock && manualSig.keepsJobs,
          JSON.stringify(manualSig),
        ),
      );
    }
    return out;
  },
};
