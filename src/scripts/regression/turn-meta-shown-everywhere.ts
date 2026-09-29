/**
 * 회귀: **실제로 보낸 추론 강도와 턴 비용이 실시간·기록·잡 카드에 같은 모양으로 뜬다** (2026-09-29).
 *
 * 요청(정태님): 채팅 카드·잡 카드의 모델 옆에 추론 등급도 · «코덱스 채팅 카드에 캐싱 정보가 아예 안 뜬다».
 *  뒤엣것의 원인: 비용 줄(입력·캐시 %·출력)은 도입부터 **실시간 turn_done 에만** 있었다 — 새로고침·다른 기기에서
 *  기록으로 다시 그린 카드엔 채우는 코드가 없었다. 그래서 답변 행(chat_log)에 강도·비용을 같이 남기고, 실시간과
 *  기록이 **같은 함수**(`modelWithEffort`·`costLine`)로 그린다.
 * ★강도는 어댑터가 **실제로 보낸 값**만 — 화면이 설정을 다시 읽어 계산하지 않는다(턴 도중 설정 변경·어댑터별 해석 차이).
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const read = (file: string): string => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const fn = (source: string, name: string): string => {
  const start = source.indexOf(`      const ${name} =`);
  const end = source.indexOf("\n      };", start);
  if (start < 0 || end < 0) throw Error(`missing function ${name}`);
  return source.slice(start, end + "\n      };".length);
};

export const check: RegressionCheck = {
  name: "turn-meta-shown-everywhere",
  guards:
    "추론 강도가 어디에도 안 보이던 것 + 턴 비용(캐시 %)이 실시간 카드에만 있어 새로고침·다른 기기에서 통째로 사라지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 턴 완료가 실제로 보낸 강도를 싣는다 — 가짜 어댑터로 runRegionA 를 태운다(모델 호출 0).
    const { __setAdapterForTest, runRegionA } = await import("../../core/llm-runtime/index.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const TK = `regr:turn-meta:${Date.now()}`;
    const done: Array<Record<string, unknown>> = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload: Record<string, unknown> }) => {
      if (e.type === "llm.turn_done" && e.payload.threadKey === TK) done.push(e.payload);
    });
    let reasoning: string | undefined = "medium";
    const restore = __setAdapterForTest(async () => ({
      text: "답",
      model: "gpt-regr",
      ...(reasoning !== undefined ? { reasoning } : {}),
      usage: { inputTokens: 1000, outputTokens: 10, cachedTokens: 800 },
    }) as never);
    try {
      await runRegionA({ text: "probe", threadKey: TK, channel: "cli" as never }, { specs: [{ adapter: "codex-oauth", model: "gpt-regr", provider: "codex" }] });
      reasoning = undefined;
      await runRegionA({ text: "probe", threadKey: TK, channel: "cli" as never }, { specs: [{ adapter: "codex-oauth", model: "gpt-regr", provider: "codex" }] });
    } finally {
      restore();
      unsub();
    }
    out.push(
      assert(
        "★턴 완료가 어댑터가 실제로 보낸 강도를 싣는다 · 안 보냈으면 싣지 않는다(설정으로 추측하지 않는다)",
        done[0]?.reasoning === "medium" && done.length === 2 && !("reasoning" in done[1]!),
        done.map((d) => d.reasoning ?? "(없음)"),
      ),
    );

    // ② 답변 행에 강도·비용이 남고 기록 조회가 돌려준다 — 적재 구독을 실제로 태운다.
    const { startEventPersistence } = await import("../../core/event-persist.js");
    const { getRecentChatLog } = await import("../../store/chat-log.js");
    const bus = getEventBus();
    startEventPersistence(bus);
    const TK2 = `dashboard:regr-turn-meta-${Date.now()}`;
    const spend = { input: 158110, output: 313, cached: 109952, requests: 2 };
    bus.publish({ type: "channel.message.out", ts: Date.now(), payload: { channel: "http-bridge", threadKey: TK2, text: "답변", model: "gpt-6-sol", reasoning: "high", spend } });
    bus.publish({ type: "channel.message.out", ts: Date.now() + 1, payload: { channel: "http-bridge", threadKey: TK2, text: "옛 모양 답변", model: "gpt-6-sol" } });
    await new Promise((r) => setTimeout(r, 20));
    // ★개수로 단언하지 않는다 — 같은 러너의 다른 검사도 적재 구독을 켜서, 순서에 따라 행이 겹칠 수 있다.
    const rows = getRecentChatLog({ threadKey: TK2 });
    const withMeta = rows.find((r) => r.text === "답변");
    const legacy = rows.find((r) => r.text === "옛 모양 답변");
    out.push(
      assert(
        "★답변 행이 강도·비용을 남기고 기록 조회가 돌려준다(새로고침·다른 기기) · 없는 행은 키 자체가 없다",
        withMeta?.reasoning === "high" && withMeta?.spend?.cached === 109952 && withMeta?.spend?.requests === 2 &&
          legacy !== undefined && legacy.reasoning === undefined && legacy.spend === undefined,
        rows.map((r) => ({ reasoning: r.reasoning ?? null, spend: r.spend ?? null })),
      ),
    );

    // ③ 화면 — 실시간·기록·잡 카드가 같은 함수로 그린다. 실제 브라우저 함수 본문을 떼어 돌린다.
    const token = read("packages/dashboard/js/token-delta.js");
    const i18n = (k: string, v?: Record<string, unknown>): string => `${k}${v ? JSON.stringify(v) : ""}`;
    const historySrc = read("packages/dashboard/js/history-render.js");
    const drawerSrc = read("packages/dashboard/js/background-drawer.js");
    const cardByThread = new Map<string, unknown>();
    const ctx = vm.createContext({
      i18n, Number, Math, JSON, Object, String, cardByThread, renderedMsgKeys: new Set(), msgKey: (ts: number, r: string) => `${ts}|${r}`,
      // 버블 빌더의 입력만 본다 — 병합 결과가 **버블까지** 가는지(적대 검토 G4: 넘기는 단계를 되돌려도 초록이었다).
      renderedActivityKeys: new Set(), actKey: (...k: unknown[]) => k.join("|"), buildHistoryDiv: (e: unknown) => e,
    });
    vm.runInContext(
      [fn(token, "fmtTokens"), fn(token, "modelWithEffort"), fn(token, "setTurnModel"), fn(token, "setTurnEffort"), fn(token, "usageSummary"), fn(token, "costLine"),
        fn(historySrc, "canonicalBodyFor"), fn(historySrc, "groupMergedItems"), fn(historySrc, "buildHistoryTextEl"), fn(drawerSrc, "setJobModel"),
        "globalThis.api = { modelWithEffort, setTurnModel, setTurnEffort, costLine, groupMergedItems, buildHistoryTextEl, setJobModel };"].join("\n"),
      ctx,
    );
    type Api = {
      modelWithEffort: (m: string, r?: string) => string;
      setTurnModel: (c: unknown, m?: string, r?: string) => void;
      setTurnEffort: (t: string, p: unknown) => void;
      costLine: (s: unknown, o?: unknown) => { text: string } | null;
      groupMergedItems: (e: unknown[], a: unknown[]) => Array<{ kind: string; act?: Record<string, unknown>; entry?: unknown }>;
      buildHistoryTextEl: (a: unknown) => Record<string, unknown>;
      setJobModel: (e: unknown, m?: string, r?: string, rm?: string) => void;
    };
    const api = (ctx as unknown as { api: Api }).api;
    const lbl = (m: string, r: string): string => api.modelWithEffort(m, r);
    const card = { modelEl: { textContent: "", title: "" } } as { modelEl: { textContent: string } };
    api.setTurnModel(card, "gpt-6-sol");                // 활동 이벤트(모델만)
    const a1 = card.modelEl.textContent;
    api.setTurnModel(card, "gpt-6-sol", "high");        // turn_done(강도)
    const a2 = card.modelEl.textContent;
    api.setTurnModel(card, "gpt-6-sol");                // 뒤늦은 활동 이벤트가 강도를 지우지 않는다
    const a3 = card.modelEl.textContent;
    api.setTurnModel(card, "claude-opus-5");            // 모델이 바뀌면(폴백) 앞 모델의 강도를 물려받지 않는다
    const a4 = card.modelEl.textContent;
    const hist = api.costLine(spend, { missingRequests: 0 });
    const histPartial = api.costLine(spend, { missingRequests: 1 });
    out.push(
      assert(
        "★모델 옆 강도: 턴 끝에 붙고, 뒤늦은 모델-only 이벤트가 안 지우고, 모델이 바뀌면 떨어진다 · 기록 카드 비용 줄에 캐시 % (미보고면 «+», 캐시 말 안 함)",
        a1 === "gpt-6-sol" && a2 === lbl("gpt-6-sol", "high") && a3 === lbl("gpt-6-sol", "high") && a4 === "claude-opus-5" &&
          a2.includes("models.effort.badge") &&
          hist !== null && hist.text.includes("tok.cacheRate") && histPartial !== null && histPartial.text.endsWith("+") && !histPartial.text.includes("tok.cacheRate"),
        { a1, a2, a3, a4, hist: hist?.text, histPartial: histPartial?.text },
      ),
    );

    // ③-b ★기록 병합 — 스트리밍된 턴은 답이 세그먼트로 먼저 남고 답변 행은 중복으로 버려진다. 강도·비용은 **그 행**이
    //  싣으므로, 버리기 전에 세그먼트로 옮겨야 한다(적대 검토 P4 — 직접 렌더만 확인해서 놓쳤다).
    const units = api.groupMergedItems(
      [{ ts: 1000, role: "user", text: "질문", threadKey: "t" }, { ts: 1200, role: "assistant", text: "답", threadKey: "t", reasoning: "high", spend }],
      [{ ts: 1100, kind: "text", text: "답", threadKey: "t", seq: 1, model: "gpt-6-sol" }],
    );
    const textUnit = units.find((u) => u.kind === "text");
    // setTurnEffort 가 강도를 실제로 넘긴다.
    const liveCard = { modelEl: { textContent: "", title: "" } };
    cardByThread.set("t", liveCard);
    api.setTurnEffort("t", { model: "gpt-6-sol", reasoning: "xhigh" });
    out.push(
      assert(
        "★새로고침 병합: 스트리밍된 턴의 답 세그먼트가 답변 행의 강도·비용을 이어받는다(행은 여전히 중복으로 버려짐) · 실시간 turn_done 이 강도를 넘긴다",
        units.length === 2 && textUnit?.act?.reasoning === "high" && (textUnit?.act?.spend as { cached?: number } | undefined)?.cached === 109952 &&
          liveCard.modelEl.textContent === lbl("gpt-6-sol", "xhigh"),
        { units: units.map((u) => u.kind), act: textUnit?.act, live: liveCard.modelEl.textContent },
      ),
    );
    // ③-b2 ★버블까지 · 순서 · 한쪽만 — 병합 결과만 보면 버블로 넘기는 단계를 되돌려도 초록이었고(G4), 세그먼트 1개
    //  픽스처라 메타가 **첫** 세그먼트(도구 카드 위)에 붙는 변이도 살았다(G3). 강도만 있는 턴도 옮겨져야 한다(G2).
    const bubble = api.buildHistoryTextEl(textUnit?.act);
    const two = api.groupMergedItems(
      [{ ts: 2000, role: "user", text: "질문", threadKey: "t2" }, { ts: 2300, role: "assistant", text: "앞말 끝말", threadKey: "t2", reasoning: "low" }],
      [
        { ts: 2100, kind: "text", text: "앞말", threadKey: "t2", seq: 1, model: "gpt-6-sol" },
        { ts: 2150, kind: "tool", label: "Read", threadKey: "t2", seq: 2 },
        { ts: 2200, kind: "text", text: "끝말", threadKey: "t2", seq: 3, model: "gpt-6-sol" },
      ],
    );
    const segs = two.filter((u) => u.kind === "text");
    out.push(
      assert(
        "★새로고침 병합 → 버블: 강도·비용이 버블 입력까지 간다 · 세그먼트가 여럿이면 **마지막**(답)에만 붙는다 · 강도만 있는 턴도 옮겨진다",
        bubble.reasoning === "high" && (bubble.spend as { cached?: number } | undefined)?.cached === 109952 &&
          two.map((u) => u.kind).join(",") === "msg,text,turn,text" &&
          segs[0]?.act?.reasoning === undefined && segs[1]?.act?.reasoning === "low" && segs[1]?.act?.spend === undefined,
        { bubble: { reasoning: bubble.reasoning, spend: bubble.spend }, two: two.map((u) => [u.kind, u.act?.reasoning ?? null]) },
      ),
    );
    // ③-c ★잡 카드 — 강도는 그 강도를 보낸 모델과 짝일 때만(폴백 뒤 다른 모델에 안 붙음) · 합계가 먼저 와도 쥐고 있다 · 강도 없는 턴이면 떨어진다.
    const badge = () => ({ style: { display: "none" }, textContent: "", title: "" });
    const j1 = { modelBadgeEl: badge() } as { modelBadgeEl: { textContent: string } };
    api.setJobModel(j1, "gpt-6-sol");
    api.setJobModel(j1, undefined, "high", "gpt-6-sol");
    const jA = j1.modelBadgeEl.textContent;
    api.setJobModel(j1, "claude-opus-5"); // 잡 안 폴백
    const jB = j1.modelBadgeEl.textContent;
    const j2 = { modelBadgeEl: badge() } as { modelBadgeEl: { textContent: string } };
    api.setJobModel(j2, undefined, "medium", "gpt-6-sol"); // 합계가 모델보다 먼저(하이드레이션)
    api.setJobModel(j2, "gpt-6-sol");
    const jC = j2.modelBadgeEl.textContent;
    api.setJobModel(j2, undefined, "", undefined); // 다음 턴은 강도를 안 보냈다
    const jD = j2.modelBadgeEl.textContent;
    out.push(
      assert(
        "★잡 카드: 강도는 보낸 모델과 짝일 때만 · 폴백 뒤 다른 모델엔 안 붙음 · 합계가 먼저 와도 유지 · 강도 없는 턴이면 떨어짐",
        jA === lbl("gpt-6-sol", "high") && jB === "claude-opus-5" && jC === lbl("gpt-6-sol", "medium") && jD === "gpt-6-sol",
        { jA, jB, jC, jD },
      ),
    );

    // ③-d ★잡 합계가 강도와 **그 강도를 보낸 모델**을 짝으로 든다 — 짝 모델이 빠지면 화면은 «아무 모델과 짝» 으로 읽어
    //  폴백 뒤 다른 모델에 강도가 붙던 결함이 되살아난다(적대 검토 G3: 서버는 정규식만 보고 있었다).
    const wj = await import("../../core/worker-jobs.js");
    const jobId = wj.registerJob({ kind: "worker", channel: "dashboard", channelUserId: "u", task: "t", label: "강도 짝", threadKey: `dashboard:${TK}` });
    const jobTk = `worker:${jobId}`;
    wj.recordJobTurnUsage({ threadKey: jobTk, model: "gpt-6-sol", reasoning: "high" });
    const u1 = { ...wj.getJob(jobId)?.usage };
    wj.recordJobTurnUsage({ threadKey: jobTk, model: "claude-opus-5" });
    const u2 = { ...wj.getJob(jobId)?.usage };
    out.push(
      assert(
        "★잡 합계: 강도는 보낸 모델과 짝으로 남고 · 강도 없는 턴이면 둘 다 떨어진다",
        u1.reasoning === "high" && u1.reasoningModel === "gpt-6-sol" && u2.reasoning === undefined && u2.reasoningModel === undefined,
        { u1: [u1.reasoning, u1.reasoningModel], u2: [u2.reasoning, u2.reasoningModel] },
      ),
    );

    // ④ 배선 — 세 어댑터가 **요청에 실은 같은 변수**를 출력에 싣는다 · 답변 이벤트·기록 카드·잡 카드가 그걸 쓴다.
    const codex = read("src/core/llm-runtime/adapters/openai-codex-oauth.ts");
    const claude = read("src/core/llm-runtime/adapters/claude-agent-sdk.ts");
    const openai = read("src/core/llm-runtime/adapters/openai-agents-sdk.ts");
    const entry = read("src/index.ts");
    const history = read("packages/dashboard/js/history-render.js");
    const drawer = read("packages/dashboard/js/background-drawer.js");
    const sse = read("packages/dashboard/js/sse.js");
    const jobs = read("src/core/worker-jobs.ts");
    const wired = {
      // 식 전체를 대조한다 — 조건을 `false ?` 로 바꾼 변이가 부분 문자열 대조를 통과했다(적대 검토 G3).
      codex: /body\.reasoning = \{ effort: turnReasoning \}/.test(codex) &&
        (codex.match(/\.\.\.\(turnReasoning !== undefined \? \{ reasoning: turnReasoning \} : \{\}\)/g) ?? []).length === 2,
      claude: /const e = claudeEffort;/.test(claude) &&
        (claude.match(/\.\.\.\(claudeEffort !== undefined \? \{ reasoning: claudeEffort \} : \{\}\)/g) ?? []).length === 2,
      openai: (openai.match(/\.\.\.\(reasoningEffort !== undefined \? \{ reasoning: reasoningEffort \} : \{\}\)/g) ?? []).length === 2,
      outEvent: /\.\.\.\(typeof out\.reasoning === "string" && out\.reasoning !== "" \? \{ reasoning: out\.reasoning \} : \{\}\)/.test(entry) &&
        /const spend = turnSpend\(out\.usage\);\s*if \(spend === undefined\) return \{\};\s*const missing = out\.usage\?\.unreportedRequests;\s*return \{ spend: \{ \.\.\.spend, \.\.\.\(typeof missing === "number" && missing > 0 \? \{ unreportedRequests: missing \} : \{\}\) \} \};/.test(entry),
      router: /\.\.\.\(typeof out\.reasoning === "string" && out\.reasoning !== "" \? \{ reasoning: out\.reasoning \} : \{\}\),\s*\.\.\.\(out\.usage !== undefined \? \{ usage: out\.usage \} : \{\}\),/.test(read("src/core/router.ts")),
      history: /modelWithEffort\(entry\.model\.trim\(\), entry\.reasoning\)/.test(history) &&
        /if \(isOut && entry\.spend\) \{\s*const line = costLine\(entry\.spend,[\s\S]{0,200}if \(line !== null\) \{[\s\S]{0,300}head\.appendChild\(cEl\);/.test(history),
      live: /setTurnEffort\(tk, ev\.payload \|\| \{\}\);/.test(sse),
      job: /u\.reasoning = payload\.reasoning;[\s\S]{0,200}u\.reasoningModel = payload\.model;[\s\S]{0,200}\} else \{\s*delete u\.reasoning;\s*delete u\.reasoningModel;/.test(jobs) &&
        /entry\.usage = u;[\s\S]{0,400}setJobModel\(entry, undefined, typeof u\.reasoning === "string" \? u\.reasoning : "", u\.reasoningModel\);/.test(drawer),
    };
    out.push(assert("★세 어댑터·답변 이벤트·기록 카드·실시간·잡 카드가 같은 값과 같은 함수를 쓴다", Object.values(wired).every(Boolean), wired));
    return out;
  },
};
