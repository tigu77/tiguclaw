/**
 * 회귀: **LLM 턴의 선택지는 어느 채널에서 시작했든 대시보드에 정확히 한 번 뜨고, 한 질문의 답은 한 번만 처리된다** (2026-10-26).
 *
 * 사고(격리 재현, 진단 잡 b623583b): 텔레그램에서 시작한 턴이 `prompt_options` 를 부르면 텔레그램엔 버튼이 가고 도구는 `ok:true`
 *  인데 대시보드엔 `prompt.options` 가 **0건**이었다(새로고침해도 없음). 답 글은 코어가 세션 키로 관측을 내는데 선택지만 그 처방이
 *  없어, http-bridge 가 직접 그릴 때만 떴다. 텔레그램 목적지의 매니저 완료·대화 밖 스케줄도 같았다.
 *  설계: `docs/decisions/2026-10-26-prompt-options-observation-and-telegram-session-label.md` §A.
 *
 * 재는 것(LLM·네트워크 0):
 *  ① 텔레그램형 인입(egress 0) → 관측 1건(답이 보이는 세션 · 질문 id) · 인입 렌더러가 질문 id·코어 관측 표식을 받는다
 *  ② 대시보드 인입(실제 `handleMessages` 가 만든 클로저) + 래퍼 → 정확히 1건(이중 발행 0) · 슬래시 경로(표식 없음) → 클로저가 직접 1건
 *  ③ 렌더 전부 실패 → 관측 0건 · `ok:false`(도구 텍스트 폴백 의미 보존)
 *  ④ 완료 턴의 실제 presenter(`optionsPresenterFor`)가 표식·라벨 세션을 렌더러까지 나른다 · http-bridge 목적지가 턴 세션과 달라도
 *     채널은 안 내고 래퍼가 턴 세션에 1건(소유권은 경로로)
 *  ⑤ 대화 밖 스케줄(`scheduleChannels`) → 답이 처리될 실행 스레드에 1건
 *  ⑥ 발급 대장 — 첫 답 ok · 두 번째 answered · 모르는 id expired · 상한 밖으로 밀린 id expired(재수락 없음)
 *  ⑦ 대시보드 POST — 닫힌 질문의 답은 핸들러 전에 409 `prompt-closed`(핸들러 0회), 처음 답은 통과
 *  ⑧ 대시보드 거절 판정 — `prompt-closed` 는 되돌리지 않고, 작업 표시는 이번 전송이 켠 것만 끈다(바빴으면 보존)
 *
 * 등급: **동작**(⑧은 화면 순수 함수를 실제로 돌린다).
 */
import http from "node:http";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Ev = { type: string; ts: number; payload: Record<string, unknown> };
type Present = (q: string, o: { label: string; value: string }[], x?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];

const readRel = (rel: string): Promise<string> => readFile(new URL(rel, import.meta.url), "utf8");
const grabFn = (src: string, name: string): string => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} 을 못 찾음`);
  const end = src.indexOf("\n      };", start);
  return src.slice(start, end + "\n      };".length);
};

/** 실제 `handleMessages` 를 격리 서버에 태워 한 번 POST — 핸들러가 받은 메시지를 돌려준다. */
const postOnce = async (
  handleMessages: (ctx: unknown) => Promise<void>,
  bus: { publish: (e: Ev) => void },
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; handled: Array<Record<string, unknown>> }> => {
  const handled: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMessages({
      req, res, url, pathname: url.pathname, channelName: "http-bridge", bus,
      sseClients: new Set<http.ServerResponse>(),
      channelHandler: async (msg: Record<string, unknown>) => { handled.push(msg); return undefined as never; },
    } as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown>, handled };
  } finally {
    server.close();
  }
};

export const check: RegressionCheck = {
  name: "prompt-options-observed-once",
  guards:
    "텔레그램에서 시작한 턴(·텔레그램 목적지 완료 턴·대화 밖 스케줄)의 선택지가 대시보드에 0건이던 것 + 고치면서 대시보드 턴에 2건이 되는 것 + 같은 질문을 텔레그램·대시보드에서 두 번 답해 두 번 처리되는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { withPromptOptionsObservation } = await import("../../core/prompt-options-observe.js");
    const { withEgressPromptOptions } = await import("../../core/prompt-options-egress.js");
    const { issuePromptId, claimPromptAnswer, promptReplySession, PROMPT_ID_CAP, __resetPromptClaimsForTest } = await import("../../core/prompt-answer-claims.js");
    const { registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
    const { optionsPresenterFor } = await import("../../core/outbound.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    __resetPromptClaimsForTest();

    const events: Ev[] = [];
    const bus = { publish: (e: Ev) => { events.push(e); } } as never;
    const optionEvents = (): Ev[] => events.filter((e) => e.type === "prompt.options");
    const noDeliver = { deliverText: async (): Promise<void> => { throw new Error("텍스트 폴백 불가 경로"); }, originThreadKey: "dashboard:default" };

    // ── ① 텔레그램형 인입 ─────────────────────────────────────────────────────
    {
      events.length = 0;
      let seenOpts: Record<string, unknown> | undefined;
      const tgInbound: Present = async (_q, _o, x) => { seenOpts = x; return { ok: true }; };
      const wrapped = withPromptOptionsObservation(withEgressPromptOptions(tgInbound as never, [], noDeliver), { channel: "telegram", threadKey: "dashboard:default", bus });
      const r = await (wrapped as unknown as Present)("고를까요?", OPTS, { note: "n" });
      const ev = optionEvents();
      out.push(assert(
        "★① 텔레그램 인입 턴의 선택지가 대시보드 세션에 **정확히 1건** 관측된다(질문 id 포함) — 종전 0건",
        r.ok && ev.length === 1 && ev[0]?.payload.threadKey === "dashboard:default" && ev[0]?.payload.channel === "telegram" &&
          typeof ev[0]?.payload.promptId === "string" && ev[0]?.payload.note === "n" && (ev[0]?.payload.options as unknown[]).length === 2,
        JSON.stringify({ ok: r.ok, n: ev.length, p: ev[0]?.payload }),
      ));
      out.push(assert(
        "① 인입 렌더러가 같은 질문 id 와 «코어가 관측함» 표식을 받는다(채널이 답 소비 판정에 쓴다)",
        seenOpts?.promptId === ev[0]?.payload.promptId && seenOpts?.observedByCore === true && seenOpts?.replyToSession === undefined,
        JSON.stringify(seenOpts),
      ));
    }

    // ── ② 대시보드 인입 — 실제 handleMessages 가 만든 클로저 ─────────────────────
    const routes = await loadPluginModule<{ handleMessages: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-chat.ts");
    {
      events.length = 0;
      const sent = await postOnce(routes.handleMessages, { publish: (e) => events.push(e) }, { text: "회귀 인입", threadKey: "dashboard:regr-po" });
      const msg = sent.handled[0];
      const inbound = msg?.presentOptions as Present | undefined;
      const wrapped = withPromptOptionsObservation(withEgressPromptOptions(inbound as never, [], { ...noDeliver, originThreadKey: "dashboard:regr-po" }), { channel: "http-bridge", threadKey: "dashboard:regr-po", bus });
      events.length = 0;
      const r = await (wrapped as unknown as Present)("대시보드 질문?", OPTS);
      const llmTurn = optionEvents();
      events.length = 0;
      const slash = await inbound?.("세션 고르기", OPTS);
      const slashEv = optionEvents();
      out.push(assert(
        "★② 대시보드 인입 LLM 턴은 정확히 1건(이중 발행 0) — 클로저는 표식이 있으면 안 내고 래퍼가 낸다",
        r.ok && llmTurn.length === 1 && llmTurn[0]?.payload.threadKey === "dashboard:regr-po" && typeof llmTurn[0]?.payload.promptId === "string",
        JSON.stringify({ ok: r.ok, n: llmTurn.length }),
      ));
      out.push(assert(
        "② 슬래시 경로(표식 없이 클로저 직접)는 종전처럼 그 채널에 1건 — 질문 id 없음(소비 판정 비대상)",
        slash?.ok === true && slashEv.length === 1 && slashEv[0]?.payload.promptId === undefined,
        JSON.stringify({ ok: slash?.ok, n: slashEv.length }),
      ));
    }

    // 실제 영속 sink — 관측 1회가 대화 복원과 검색에도 1회 그대로 살아야 한다.
    {
      const { createEventBus } = await import("../../core/eventbus.js");
      const { startEventPersistence } = await import("../../core/event-persist.js");
      const { getRecentChatLog, searchChatLog } = await import("../../store/chat-log.js");
      const persistedBus = createEventBus({ bufferSize: 10 });
      startEventPersistence(persistedBus);
      const threadKey = "dashboard:po-persist-search";
      const { getDb } = await import("../../store/sessions.js");
      getDb().prepare("INSERT OR IGNORE INTO threads (channel, channel_thread_id, claude_session_id, last_used_at, created_at) VALUES ('http-bridge', ?, '', ?, ?)").run(threadKey, Date.now(), Date.now());
      const q = "독특질문선택지복원";
      const wrapped = withPromptOptionsObservation(async () => ({ ok: true }), { channel: "telegram", threadKey, bus: persistedBus });
      await wrapped?.(q, [{ label: "독특보기검색", value: "internal-value" }], { note: "독특설명검색" });
      const rows = getRecentChatLog({ threadKey, limit: 20 }).filter((r) => r.kind === "prompt.options");
      out.push(assert("★관측 1회가 실제 대화 기록 1행으로 질문·보기·설명·promptId 구조를 보존", rows.length === 1 && rows[0]?.data?.question === q && rows[0]?.data?.note === "독특설명검색" && typeof rows[0]?.data?.promptId === "string", rows));
      out.push(assert("★질문·보기·설명 각각 검색에 1회 나오며 다른 대화로 누수 없음", [q, "독특보기검색", "독특설명검색"].every((s) => searchChatLog(s, { threadKey }).length === 1) && searchChatLog(q, { threadKey: "dashboard:other-po" }).length === 0, rows.map((r) => r.text)));
    }

    // ── ③ 렌더 전부 실패 ───────────────────────────────────────────────────────
    {
      events.length = 0;
      const failing: Present = async () => ({ ok: false, error: "chat not found" });
      const wrapped = withPromptOptionsObservation(failing as never, { channel: "telegram", threadKey: "dashboard:default", bus });
      const r = await (wrapped as unknown as Present)("q", OPTS);
      out.push(assert(
        "③ 렌더가 전부 실패하면 관측도 0건 · 결과 그대로 `ok:false`(도구가 텍스트로 폴백하고 그 글이 양쪽에 보인다)",
        !r.ok && optionEvents().length === 0,
        JSON.stringify({ r, n: optionEvents().length }),
      ));
      out.push(assert(
        "③ 렌더할 곳이 없으면 래퍼도 없다(도구 미등록 — 관측만 있는 선택지는 답이 돌아올 통로가 없다)",
        withPromptOptionsObservation(undefined, { channel: "x", threadKey: "y", bus }) === undefined,
        String(withPromptOptionsObservation(undefined, { channel: "x", threadKey: "y", bus })),
      ));
    }

    // native refs는 렌더 성공분만 모아 공통 관측 한 번에 싣는다. ID 없는 성공/실패/관측실패도 기존 계약 유지.
    {
      events.length = 0;
      const refs = [{ channel: "telegram", address: "one", messageIds: [901] }];
      const second = { channel: "telegram", address: "two", messageIds: [902] };
      const inbound = async () => ({ ok: true as const, channelRefs: refs });
      let textFallbacks = 0;
      const wrapped = withPromptOptionsObservation(withEgressPromptOptions(inbound, [
        { channel: "telegram", target: "two", outbound: { deliver: async () => {}, presentOptionsTo: async () => ({ ok: true as const, channelRefs: [second] }) } },
        { channel: "telegram", target: "bad", outbound: { deliver: async () => {}, presentOptionsTo: async () => ({ ok: false as const, error: "fixture partial" }) } },
        { channel: "no-native", target: "text", outbound: { deliver: async () => {} } },
      ], { originThreadKey: "dashboard:refs", deliverText: async () => { textFallbacks++; } }), {
        channel: "http-bridge", threadKey: "dashboard:refs", bus,
      });
      const result = await wrapped?.("refs 질문", OPTS);
      const ev = optionEvents();
      out.push(assert("★성공 native refs만 여러 주소에서 모아 1회 관측: 인입+egress+텍스트 폴백+부분 실패",
        result?.ok === true && result.channelRefs?.length === 2 && textFallbacks === 1 && ev.length === 1 &&
        JSON.stringify(ev[0]?.payload.channelRefs) === JSON.stringify([...refs, second]),
        JSON.stringify({ result, textFallbacks, events: ev })));
      let tried = 0;
      const observerBroken = withPromptOptionsObservation(inbound, { channel: "telegram", threadKey: "dashboard:refs", bus: {
        publish() { tried++; throw new Error("fixture observer unavailable"); },
      } as never });
      const kept = await observerBroken?.("관측실패", OPTS);
      out.push(assert("관측 실패도 이미 성공한 렌더/ref를 실패로 뒤집지 않는다(best-effort)",
        tried === 1 && kept?.ok === true && JSON.stringify(kept.channelRefs) === JSON.stringify(refs),
        JSON.stringify({ tried, kept })));
      events.length = 0;
      const noNative = withPromptOptionsObservation(withEgressPromptOptions(async () => ({ ok: true as const }), [], noDeliver), {
        channel: "http-bridge", threadKey: "dashboard:refs", bus,
      });
      const noId = await noNative?.("native ID 없는 성공", OPTS);
      out.push(assert("native ref 없는 성공은 성공+관측 한 번 유지(허위 ID/좌표 없음)",
        noId?.ok === true && noId.channelRefs === undefined && optionEvents().length === 1 && optionEvents()[0]?.payload.channelRefs === undefined,
        JSON.stringify({ noId, events: optionEvents() })));
    }

    // ── ④ 완료 턴의 실제 presenter ──────────────────────────────────────────────
    {
      const CH = "regr-po-chan";
      let got: Record<string, unknown> | undefined;
      registerChannelOutbound(CH, {
        defaultOutboundTarget: () => "chat-1",
        presentOptionsTo: async (_t, _q, _o, x) => { got = x as Record<string, unknown>; return { ok: true }; },
      });
      const Bridge = (await loadPluginModule<{ default: new () => { outbound: { presentOptionsTo?: (t: string | null, q: string, o: { label: string; value: string }[], x?: Record<string, unknown>) => Promise<{ ok: boolean }> } } }>("../../../plugins/http-bridge/index.js")).default;
      const savedTok = process.env.HTTP_BRIDGE_TOKEN;
      process.env.HTTP_BRIDGE_TOKEN = "regression-fake-bridge-token";
      const inst = new Bridge();
      if (savedTok === undefined) delete process.env.HTTP_BRIDGE_TOKEN; else process.env.HTTP_BRIDGE_TOKEN = savedTok;
      const bridgeEvents: Ev[] = [];
      (inst as unknown as { bus: unknown }).bus = { publish: (e: Ev) => { bridgeEvents.push(e); } };
      registerChannelOutbound("regr-po-bridge", inst.outbound as never);
      try {
        events.length = 0;
        const viaChan = withPromptOptionsObservation(optionsPresenterFor(CH, null, "dashboard:job-turn", "dashboard:job-turn"), { channel: "http-bridge", threadKey: "dashboard:job-turn", bus });
        await (viaChan as unknown as Present)("완료 보고 질문", OPTS, { note: "권장 A" });
        const chanEv = optionEvents();
        out.push(assert(
          "★④ 완료 턴 presenter 가 질문 id·코어 표식·라벨 세션·물어본 세션을 렌더러까지 나른다(재조립에서 안 떨어진다) · 관측 1건",
          got?.promptId === chanEv[0]?.payload.promptId && got?.observedByCore === true && got?.labelSession === "dashboard:job-turn" &&
            got?.replyToSession === "dashboard:job-turn" && got?.note === "권장 A" && chanEv.length === 1,
          JSON.stringify({ got, n: chanEv.length }),
        ));
        events.length = 0;
        bridgeEvents.length = 0;
        const viaBridge = withPromptOptionsObservation(optionsPresenterFor("regr-po-bridge", "dashboard:other-target", "dashboard:job-turn"), { channel: "http-bridge", threadKey: "dashboard:job-turn", bus });
        await (viaBridge as unknown as Present)("목적지가 다른 질문", OPTS);
        const direct = await inst.outbound.presentOptionsTo?.("dashboard:other-target", "표식 없는 직접 호출", OPTS);
        out.push(assert(
          "★④ http-bridge 목적지가 턴 세션과 달라도 채널은 안 내고 래퍼가 **턴 세션에 1건** — 소유권은 세션 문자열이 아니라 경로(표식)",
          optionEvents().length === 1 && optionEvents()[0]?.payload.threadKey === "dashboard:job-turn" &&
            bridgeEvents.filter((e) => e.payload.question === "목적지가 다른 질문").length === 0,
          JSON.stringify({ core: optionEvents().map((e) => e.payload.threadKey), bridge: bridgeEvents.map((e) => e.payload.question) }),
        ));
        out.push(assert(
          "④ 표식 없는 좌표 호출은 종전처럼 채널이 직접 그 좌표에 낸다",
          direct?.ok === true && bridgeEvents.some((e) => e.payload.question === "표식 없는 직접 호출" && e.payload.threadKey === "dashboard:other-target"),
          JSON.stringify(bridgeEvents.map((e) => e.payload)),
        ));
      } finally {
        unregisterChannelOutbound(CH);
        unregisterChannelOutbound("regr-po-bridge");
      }
    }

    // ── ⑤ 대화 밖 스케줄 ───────────────────────────────────────────────────────
    {
      const CH = "regr-po-sched";
      let got: Record<string, unknown> | undefined;
      registerChannelOutbound(CH, {
        defaultOutboundTarget: () => "chat-1",
        presentOptionsTo: async (_t, _q, _o, x) => { got = x as Record<string, unknown>; return { ok: true }; },
      });
      const globalEvents: Ev[] = [];
      const unsub = getEventBus().subscribe((e) => { if (e.type === "prompt.options") globalEvents.push(e); });
      try {
        const sch = await loadPluginModule<{ scheduleChannels: (d: { channel: string; target: string | null } | undefined, tk: string) => { presentOptions?: Present } }>("../../../plugins/scheduler/src/index.js");
        const r = await sch.scheduleChannels({ channel: CH, target: null }, "scheduler:regr-po-7").presentOptions?.("보고서 형식?", OPTS);
        out.push(assert(
          "★⑤ 대화 밖 스케줄의 선택지도 관측 1건 — **최종 답과 같은 표시 대화**에(답 처리는 기존 실행 스레드), 질문 id 와 함께",
          r?.ok === true && globalEvents.length === 1 && globalEvents[0]?.payload.threadKey === "dashboard:default" &&
            got?.replyToSession === "scheduler:regr-po-7" && got?.promptId === globalEvents[0]?.payload.promptId && got?.labelSession === "dashboard:default",
          JSON.stringify({ n: globalEvents.length, tk: globalEvents[0]?.payload.threadKey, got }),
        ));
        // 발급부터 HTTP 답까지 한 계약으로 잰다. 따로 만든 id로는 표시/처리 혼동을 놓친다.
        const promptId = globalEvents[0]?.payload.promptId as string;
        const origin = promptReplySession(promptId);
        const answer = await postOnce(routes.handleMessages, { publish() {} }, {
          text: "a", threadKey: "dashboard:default", promptId,
        });
        const received = answer.handled[0];
        out.push(assert(
          "★⑤ 표시 대화에서 답해도 실제 발급 대장·HTTP threadKey·명시 세션 모두 scheduler 원세션",
          origin === "scheduler:regr-po-7" && answer.status === 200 && answer.handled.length === 1 &&
            received?.threadKey === origin &&
            (received?.session as { explicitSessionId?: string })?.explicitSessionId === origin,
          { origin, status: answer.status, thread: received?.threadKey, session: received?.session },
        ));
      } finally {
        unsub();
        unregisterChannelOutbound(CH);
      }
    }

    // ── ⑥ 발급 대장 ────────────────────────────────────────────────────────────
    {
      __resetPromptClaimsForTest();
      const id = issuePromptId();
      const first = claimPromptAnswer(id);
      const second = claimPromptAnswer(id);
      const unknown = claimPromptAnswer("never-issued");
      const oldest = issuePromptId();
      for (let i = 0; i < PROMPT_ID_CAP; i++) issuePromptId();
      const evicted = claimPromptAnswer(oldest);
      out.push(assert(
        "★⑥ 한 질문의 답은 한 번 — 첫 답 ok · 두 번째 answered · 모르는 id expired · 상한 밖으로 밀린 열린 질문도 expired(처음 보는 질문으로 다시 받지 않는다)",
        first === "ok" && second === "answered" && unknown === "expired" && evicted === "expired",
        JSON.stringify({ first, second, unknown, evicted }),
      ));
    }

    // ── ⑦ 대시보드 POST 소비 판정 ──────────────────────────────────────────────
    {
      __resetPromptClaimsForTest();
      const id = issuePromptId("scheduler:regr-po-answer");
      const noop = { publish: () => {} };
      const firstPost = await postOnce(routes.handleMessages, noop, { text: "a", threadKey: "dashboard:regr-po", promptId: id });
      const again = await postOnce(routes.handleMessages, noop, { text: "b", threadKey: "dashboard:regr-po", promptId: id });
      const expired = await postOnce(routes.handleMessages, noop, { text: "c", threadKey: "dashboard:regr-po", promptId: "unknown-id" });
      const plain = await postOnce(routes.handleMessages, noop, { text: "그냥 글", threadKey: "dashboard:regr-po" });
      out.push(assert(
        "★⑦ 닫힌 질문의 답은 **핸들러·큐 전에** 409 `prompt-closed`(핸들러 0회) — 처음 답과 질문 id 없는 글은 그대로 처리",
        firstPost.status === 200 && firstPost.handled.length === 1 &&
          firstPost.handled[0]?.threadKey === "scheduler:regr-po-answer" &&
          (firstPost.handled[0]?.session as { explicitSessionId?: string })?.explicitSessionId === "scheduler:regr-po-answer" &&
          again.status === 409 && again.body.code === "prompt-closed" && again.body.reason === "answered" && again.handled.length === 0 &&
          expired.status === 409 && expired.body.reason === "expired" && expired.handled.length === 0 &&
          plain.status === 200 && plain.handled.length === 1,
        JSON.stringify({ first: [firstPost.status, firstPost.handled[0]?.threadKey, firstPost.handled[0]?.session], again: [again.status, again.body], expired: [expired.status, expired.body.reason], plain: plain.status }),
      ));
    }

    // ── ⑧ 대시보드 거절 판정(순수 함수 실행) ────────────────────────────────────
    {
      const util = await readRel("../../../packages/dashboard/js/util.js");
      const ctx: Record<string, unknown> = {};
      vm.createContext(ctx);
      vm.runInContext([grabFn(util, "sendRejectionAction"), "this.__reject = sendRejectionAction;"].join("\n"), ctx);
      const reject = ctx.__reject as (e: number, s: number, b: unknown, busy?: boolean) => Record<string, unknown>;
      const busy = reject(20, 409, { code: "prompt-closed", error: "이미 답함" }, true);
      const idle = reject(20, 409, { code: "prompt-closed", error: "이미 답함" }, false);
      const other = reject(20, 409, { error: "다른 409" }, true);
      out.push(assert(
        "★⑧ 닫힌 선택지 거절은 되돌리지 않고(버튼 값) · 바빴으면 **진행 중 턴 표시를 보존**, 유휴였으면 이번 전송이 켠 표시를 끈다 · 다른 4xx 판정은 종전 그대로",
        busy.closed === true && busy.restore === false && busy.clearWorking === false &&
          idle.closed === true && idle.clearWorking === true &&
          other.closed === undefined && other.restore === true && other.clearWorking === true,
        JSON.stringify({ busy, idle, other }),
      ));
      const replySrc = await readRel("../../../packages/dashboard/js/reply.js");
      const promptSrc = await readRel("../../../packages/dashboard/js/prompt-options.js");
      out.push(assert(
        "⑧ 화면이 그 판정에 **전송 전 바쁨**을 넘기고, 선택지 버튼·기타 입력이 질문 id 를 싣는다",
        /sendRejectionAction\(Date\.now\(\) - t0, r\.status, data, busy\)/.test(replySrc) &&
          /if \(act\.closed\) foldRejectedQueuedBubble\(correlationId\)/.test(replySrc) &&
          // 버튼·기타 입력이 한 제출 함수(`submit`)를 지나 질문 id 를 싣는다(2026-10-28 A2 — 결과로 카드를 고치려고 한 곳으로 모았다).
          (promptSrc.match(/submitOptionValue\(v, payload\.promptId, \{/g) ?? []).length === 1 && /submit\(val\);/.test(promptSrc) && /submit\(v\);/.test(promptSrc),
        JSON.stringify({
          passesBusy: /sendRejectionAction\(Date\.now\(\) - t0, r\.status, data, busy\)/.test(replySrc),
          foldsClosed: /if \(act\.closed\) foldRejectedQueuedBubble\(correlationId\)/.test(replySrc),
          promptIdSubmissions: (promptSrc.match(/submitOptionValue\(v, payload\.promptId, \{/g) ?? []).length,
          buttonAndOtherViaSubmit: /submit\(val\);/.test(promptSrc) && /submit\(v\);/.test(promptSrc),
        }),
      ));
    }
    // ── ⑨ 배선 — 메인 핸들러·텔레그램 콜백 ────────────────────────────────────────
    //  메인 핸들러는 데몬 전체를 띄워야 돌릴 수 있어 배선만 본다(조합 자체는 ①~⑤가 실제로 돌린다).
    {
      const idx = await readRel("../../index.ts");
      const tg = await readRel("../../../plugins/telegram-channel/index.ts");
      const cb = /bot\.on\("callback_query:data"[\s\S]{0,12000}?\n    \}\);/.exec(tg)?.[0] ?? "";
      out.push(assert(
        "★⑨ 메인 핸들러의 선택지 통로는 관측 래퍼가 **바깥**에서 감싼다(인입·egress·완료·점검·트리거·끼워넣기 전부 여기를 지난다) — 관측 세션 = 그 턴의 답이 보이는 세션",
        /withPromptOptionsObservation\(\s*withEgressPromptOptions\(\s*msg\.presentOptions,/.test(idx) &&
          // 좌표 판정은 `promptObservationSeat`(대화 밖 작업 턴만 목적지 대화 — 2026-10-28 B4, 동작은 `prompt-options-display-seat`).
          /\{ channel: msg\.channel, \.\.\.promptObservationSeat\(msg\), bus \},?\s*\);/.test(idx) &&
          /presentOptions: presentOptionsForTurn/.test(idx),
        "배선",
      ));
      out.push(assert(
        "★⑨ 텔레그램 버튼은 질문 id 를 보기와 함께 들고 있다가, 콜백에서 **처리 전에** 소비 판정 — ok 가 아니면 안내만 하고 끝",
        /storePromptOption\(o\.value, opts\?\.replyToSession, opts\?\.promptId\)/.test(tg) &&
          /if \(entry\?\.promptId !== undefined\) \{\s*const claim = claimPromptAnswer\(entry\.promptId\);\s*if \(claim !== "ok"\) \{[\s\S]{0,300}?return;\s*\}\s*\}/.test(cb) &&
          cb.indexOf("claimPromptAnswer(") < cb.indexOf("const msg: IncomingMessage"),
        cb === "" ? "콜백 핸들러를 못 찾음" : "배선",
      ));
    }
    __resetPromptClaimsForTest();
    return out;
  },
};

export default check;
