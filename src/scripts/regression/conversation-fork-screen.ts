/**
 * 회귀: **가지 화면 = 물려받은 기록(갈라진 순간까지) + 자기 기록**, 그리고 `/fork` 는 실제로 한 일만 말한다 (2026-10-15 v1 ③단계).
 * 설계: `docs/decisions/2026-10-14-conversation-fork-design.md` §3(화면·검색)·§8(활성 세션 이동).
 *
 * 본다: 화면 이력(세그먼트 합침·갈라진 뒤 부모 행 제외·표시 키 = 가지·페이지 넘김 중복/누락 0) · 대화 내 검색(부모를 보관해도 물려받은 행이 찾힘)
 *  · 도구 스텝(부모 것은 갈라진 시각까지만, 가지 키로) · 구분선 이벤트 · `/fork`(바인딩 이동 / 화면이 세션을 지정한 메시지는 안 옮기고 그렇게 말함).
 *
 * 등급: **실행**(격리 DB · 실제 조회·명령 함수).
 */
import { randomUUID } from "node:crypto";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "conversation-fork-screen",
  guards: "가지 화면에 물려받은 대화가 안 보이거나 갈라진 뒤의 부모 대화가 섞이고, 가지 검색이 물려받은 기록을 못 찾고, /fork 가 옮기지 않은 대화방을 옮겼다고 말하던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb, SESSION_STORAGE_CHANNEL: CH } = await import("../../store/sessions.js");
    initStore();
    const { recordChatMessage, getRecentChatLog, searchChatLog } = await import("../../store/chat-log.js");
    const { setSessionArchived, getChannelSessionBinding, setChannelSessionBinding } = await import("../../store/channel-session.js");
    const { insertEvent } = await import("../../store/events.js");
    const mem = await import("../../store/memory.js");
    const { forkThread } = await import("../../core/thread-fork.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const db = getDb();
    const noSdk = { forkSession: async (): Promise<{ sessionId: string }> => { throw new Error("SDK 를 부르면 안 된다(Codex 만 쓴 부모)"); }, sessionKnown: async () => true };
    const t0 = Date.now() - 60_000;
    const seed = (k: string, name: string): void => {
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, last_used_at, created_at, name) VALUES (?, ?, ?, 'm', 1, 1, ?)`).run(CH, k, `codex-${k}`, name);
      mem.appendTranscript({ claudeSessionId: `codex-${k}`, role: "user", content: "q" });
      mem.indexCodexTurn({ channel: CH, threadKey: k, claudeSessionId: `codex-${k}` });
    };
    const chat = (k: string, ts: number, role: "user" | "assistant", text: string): void => recordChatMessage({ ts, threadKey: k, channel: CH, role, text });

    const P = `dashboard:${randomUUID()}`;
    seed(P, "부모 대화");
    chat(P, t0 + 1, "user", "물려받는-질문");
    chat(P, t0 + 1, "assistant", "물려받는-답"); // 같은 ts — 페이지 경계 동률
    insertEvent(t0 + 2, "llm.activity", JSON.stringify({ kind: "tool", threadKey: P, adapter: "codex", seq: 1, label: "Read", detail: "물려받는-도구" }));
    insertEvent(t0 + 3, "llm.activity", JSON.stringify({ kind: "tool", phase: "end", threadKey: P, adapter: "codex", seq: 1, output: "부모-출력" }));
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    const unsub = getEventBus().subscribe((e) => { if (e.type === "thread.forked") seen.push(e); });
    const K = `dashboard:${randomUUID()}`;
    const r = await forkThread(P, K, noSdk);
    unsub();
    const after = Date.now() + 1000;
    chat(P, after, "user", "갈라진뒤-부모-질문");
    insertEvent(after + 1, "llm.activity", JSON.stringify({ kind: "tool", threadKey: P, adapter: "codex", seq: 2, label: "Read", detail: "갈라진뒤-부모-도구" }));
    chat(K, after + 2, "user", "가지-질문");
    // 가지 자기 턴의 스텝 — 부모 스텝과 seq 가 겹친다(턴마다 1부터). 출력이 서로 섞이면 안 된다.
    insertEvent(after + 3, "llm.activity", JSON.stringify({ kind: "tool", threadKey: K, adapter: "codex", seq: 1, label: "Read", detail: "가지-도구" }));
    insertEvent(after + 4, "llm.activity", JSON.stringify({ kind: "tool", phase: "end", threadKey: K, adapter: "codex", seq: 1, output: "가지-출력" }));

    const view = getRecentChatLog({ threadKey: K, limit: 50 });
    const texts = view.map((e) => e.text);
    out.push(assert("★★가지 화면 = 물려받은 기록 + 자기 기록 · 갈라진 뒤 부모 기록은 없다 · 전부 가지 키로 그린다",
      r.ok && JSON.stringify(texts) === JSON.stringify(["물려받는-질문", "물려받는-답", "가지-질문"]) && view.every((e) => e.threadKey === K),
      { r, texts, keys: [...new Set(view.map((e) => e.threadKey))] }));

    // 페이지 넘김 — 한 건씩 넘겨도 중복·누락 0(세그먼트를 합친 뒤 같은 복합 커서).
    const paged: string[] = [];
    let cur: { ts: number; id: number } | undefined;
    for (let i = 0; i < 6; i++) {
      const page = getRecentChatLog({ threadKey: K, limit: 1, ...(cur !== undefined ? { beforeTs: cur.ts, beforeId: cur.id } : {}) });
      if (page.length === 0) break;
      paged.unshift(...page.map((e) => e.text));
      cur = { ts: page[0]!.ts, id: page[0]!.id! };
    }
    out.push(assert("★한 건씩 페이지를 넘겨도 물려받은 구간까지 중복·누락 없이 이어진다(동률 ts 포함)",
      JSON.stringify(paged) === JSON.stringify(texts), paged));

    const parentView = getRecentChatLog({ threadKey: P, limit: 50 }).map((e) => e.text);
    out.push(assert("부모 화면은 그대로 — 가지 기록이 안 섞인다",
      parentView.includes("갈라진뒤-부모-질문") && !parentView.includes("가지-질문"), parentView));

    // 대화 내 검색 — 물려받은 기록이 가지에서 찾히고, 부모를 보관해도 그대로, 갈라진 뒤 부모 기록은 안 찾힌다.
    setSessionArchived(P, true);
    const hit = searchChatLog("물려받는-질문", { threadKey: K });
    const leak = searchChatLog("갈라진뒤-부모", { threadKey: K });
    out.push(assert("★가지 검색: 물려받은 기록을 찾고(부모를 보관해도) 가지 키로 연다 · 갈라진 뒤 부모 기록은 안 찾는다",
      hit.length === 1 && hit[0]!.threadKey === K && leak.length === 0, { hit: hit.map((h) => h.threadKey), leak: leak.length }));
    setSessionArchived(P, false);

    // 도구 스텝 — 부모 것은 갈라진 시각까지만, 가지 키로.
    const actUrl = new URL("../../../plugins/http-bridge/history-activities.js", import.meta.url).href;
    const { historyActivities } = (await import(actUrl)) as { historyActivities: (e: { ts: number }[], tk?: string) => { threadKey: string; detail: string; output?: unknown }[] };
    const acts = historyActivities(view, K);
    const outOf = (d: string): unknown => acts.find((a) => a.detail === d)?.output;
    out.push(assert("★물려받은 스텝과 가지 스텝의 seq 가 겹쳐도 출력이 제 스텝에 붙는다(병합은 원래 대화 키로)",
      outOf("물려받는-도구") === "부모-출력" && outOf("가지-도구") === "가지-출력", { 부모: outOf("물려받는-도구"), 가지: outOf("가지-도구") }));
    out.push(assert("★가지 화면의 도구 스텝: 물려받은 턴의 스텝은 보이고(가지 키) 갈라진 뒤 부모 스텝은 없다",
      acts.some((a) => a.detail === "물려받는-도구" && a.threadKey === K) && !acts.some((a) => a.detail === "갈라진뒤-부모-도구"),
      acts.map((a) => `${a.threadKey === K ? "K" : a.threadKey}:${a.detail}`)));

    out.push(assert("구분선 — 가지에 `thread.forked`(부모 이름 포함)를 남긴다(화면이 «여기서 갈라짐» 을 그린다)",
      seen.length === 1 && seen[0]!.payload.threadKey === K && seen[0]!.payload.parentName === "부모 대화", seen.map((e) => e.payload)));

    // /fork — 바인딩으로 세션을 고르는 방은 옮기고, 화면이 세션을 지정한 메시지는 안 옮긴다(그리고 그렇게 말한다).
    const { handleFork } = await import("../../core/entry/slash-commands.js");
    const { translate } = await import("../../core/i18n.js");
    const Q = `dashboard:${randomUUID()}`;
    seed(Q, "텔레그램 대화");
    setChannelSessionBinding("telegram", "chat-fork-1", Q);
    const replies: string[] = [];
    const tgMsg = { channel: "telegram", channelUserId: "u", threadKey: Q, channelAddress: "chat-fork-1", text: "/fork", receivedAt: Date.now(), reply: async (t: string) => { replies.push(t); } };
    await handleFork({ msg: tgMsg as never, args: "", trimmed: "/fork", sidChannel: CH });
    const bound = getChannelSessionBinding("telegram", "chat-fork-1");
    out.push(assert("★텔레그램 `/fork`: 이 대화방을 새 가지로 옮기고 «이어집니다» 라고 말한다",
      bound !== null && bound !== Q && bound.startsWith("dashboard:") && replies[0]?.includes(translate("srv.fork.created", { name: "텔레그램 대화 (2)" }).split("\n")[0]!) === true &&
        replies[0]?.includes("텔레그램 대화 (2)") === true,
      { bound, reply: replies[0] }));
    const dashMsg = { ...tgMsg, channel: CH, channelAddress: Q, threadKey: Q, session: { explicitSessionId: Q, channelAddress: Q } };
    replies.length = 0;
    await handleFork({ msg: dashMsg as never, args: "", trimmed: "/fork", sidChannel: CH });
    out.push(assert("화면이 세션을 지정한 메시지(대시보드 탭)는 바인딩을 안 옮기고 «목록에서 열 수 있다» 고 말한다",
      getChannelSessionBinding(CH, Q) === null && replies[0]?.includes(translate("srv.fork.createdListed", { name: "x" }).split("\n")[1]!.slice(0, 6)) === true,
      { reply: replies[0] }));
    
    // `/fork` 는 그 세션의 줄 안에서 처리된다 — 줄에 다시 넣으면 자기 자신을 기다려 세션이 영원히 멈춘다(변이 생존 G).
    const { enqueueThreadTurn } = await import("../../core/worker-jobs.js");
    const Z = `dashboard:${randomUUID()}`;
    seed(Z, "줄 안 명령");
    const inQueue = enqueueThreadTurn(Z, () => handleFork({ msg: { ...tgMsg, threadKey: Z, channelAddress: "chat-fork-2" } as never, args: "", trimmed: "/fork", sidChannel: CH }).then(() => "done"));
    const settled = await Promise.race([inQueue, new Promise((res) => setTimeout(() => res("멈춤"), 5000))]);
    out.push(assert("★`/fork` 를 세션 줄 안에서 처리해도 끝난다(자기 자신을 기다리지 않는다)", settled === "done", settled));

    // threadKey 없이 오는 http 요청 — 채널이 세션을 스스로 고르므로 바인딩을 쓰지도, «이어집니다» 라고 말하지도 않는다(적대 검토 P3).
    const H = `dashboard:${randomUUID()}`;
    seed(H, "http 대화");
    replies.length = 0;
    await handleFork({ msg: { ...tgMsg, channel: CH, threadKey: H, channelAddress: "dashboard:default" } as never, args: "", trimmed: "/fork", sidChannel: CH });
    out.push(assert("★세션을 스스로 고르는 채널(threadKey 없는 http)은 바인딩을 안 쓰고 «목록에서 열 수 있다» 고 말한다",
      getChannelSessionBinding(CH, "dashboard:default") === null && replies[0]?.includes("텔레그램") === false && replies[0]?.includes("http 대화 (2)") === true &&
        !replies[0]!.includes(translate("srv.fork.created", { name: "x" }).split("\n")[1]!.slice(0, 8)),
      { reply: replies[0] }));
    // 텔레그램 답장으로 갈린 세션(explicit)에서 `/fork` — 그 방의 바인딩은 그대로(답장 하나가 방 전체를 옮기지 않는다).
    const T2 = `dashboard:${randomUUID()}`;
    seed(T2, "답장 대화");
    setChannelSessionBinding("telegram", "chat-fork-3", Q);
    await handleFork({ msg: { ...tgMsg, threadKey: T2, channelAddress: "chat-fork-3", session: { explicitSessionId: T2, channelAddress: "chat-fork-3" } } as never, args: "", trimmed: "/fork", sidChannel: CH });
    out.push(assert("텔레그램 답장으로 갈린 세션에서 `/fork` 는 그 방의 바인딩을 옮기지 않는다",
      getChannelSessionBinding("telegram", "chat-fork-3") === Q, getChannelSessionBinding("telegram", "chat-fork-3")));
    // 대시보드 프록시 — 답을 기다리는 두 요청은 기본 fetch(300초 상한)가 아니라 무제한 대기 경로로(5분 502 의 뿌리, 재검토 G1).
    const { readSource } = await import("./_wiring.js");
    const proxy = await readSource("../../../packages/dashboard/index.ts");
    const cond = /if \(bridgePath === "\/messages"([^)]*)\)\s*\{\s*const r = await requestBridgeMessage/.exec(proxy)?.[1] ?? "";
    out.push(assert("대시보드 프록시: /session-fork·/session-carry 는 /messages 와 같은 무제한 대기 경로",
      cond.includes(`"/session-fork"`) && cond.includes(`"/session-carry"`), cond));
    const { isEphemeralCommandText } = await import("../../core/entry/command-registry.js");
    out.push(assert("`/fork` 는 휘발 — 명령 버블이 갈라진 순간 앞에 끼어 가지가 답 없는 버블을 물려받지 않는다",
      isEphemeralCommandText("/fork"), isEphemeralCommandText("/fork")));

    // 대시보드 경로(`/session-fork`)는 부모 줄을 기다린다 — 진행 중인 답이 가지에 통째로 들어간다(반쪽 없음, 변이 생존 G).
    const routeUrl = new URL("../../../plugins/http-bridge/routes-sessions.js", import.meta.url).href;
    const { handleSessionFork } = (await import(routeUrl)) as { handleSessionFork: (ctx: unknown) => Promise<void> };
    const { Readable } = await import("node:stream");
    const R = `dashboard:${randomUUID()}`;
    seed(R, "대시보드 대화");
    const R2 = `dashboard:${randomUUID()}`;
    const busy = enqueueThreadTurn(R, async () => {
      await new Promise((res) => setTimeout(res, 150));
      mem.appendTranscript({ claudeSessionId: `codex-${R}`, role: "assistant", content: "진행중-답" });
    });
    const body = JSON.stringify({ threadKey: R, childKey: R2 });
    const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-length": String(Buffer.byteLength(body)) } });
    let status = 0, sent = "";
    const res = { writeHead: (c: number) => { status = c; return res; }, setHeader: () => res, end: (b: string) => { sent = b; } };
    await handleSessionFork({ req, res, url: new URL("http://x/session-fork"), pathname: "/session-fork" });
    await busy;
    const childTexts = mem.loadThreadHistory(CH, R2).map((t) => t.content);
    out.push(assert("★대시보드 갈라내기는 진행 중인 답이 끝난 뒤 갈라진다 — 그 답이 가지에 들어간다",
      status === 200 && childTexts.includes("진행중-답"), { status, sent: sent.slice(0, 120), childTexts }));
    return out;
  },
};
