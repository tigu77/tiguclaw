/**
 * 회귀: **가지의 결론을 원래 대화로 보낸다** — 가지 비서가 정리하고(가지에 남음) 원래 대화에 «가져온 결론» 으로 넣는다 (2026-10-15).
 * 합치기는 안 한다(설계 문서·로드맵). 두 턴 모두 메인 핸들러(세션 줄)를 타므로 어댑터 무관이다.
 *
 * 본다: 두 턴의 순서·세션 지정·합성 여부 · 빈 결론이면 원래 대화에 아무것도 안 넣음 · 가지가 아니면 거절 · `/fork back`
 *  (대화방을 원래 대화로 돌리고, 가지 줄 안에서 불려도 멈추지 않음) · 세션 목록이 가지를 알려 준다(화면 메뉴 재료).
 *
 * 등급: **실행**(격리 DB · 대역 핸들러).
 */
import { randomUUID } from "node:crypto";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import type { IncomingMessage } from "../../channels/types.js";

export const check: RegressionCheck = {
  name: "conversation-fork-carry",
  guards: "가지에서 낸 결론을 원래 대화로 가져갈 길이 없거나, 빈 결론·가지 아닌 대화에서 엉뚱한 메시지를 넣거나, /fork back 이 가지 줄에서 멈추던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb, SESSION_STORAGE_CHANNEL: CH } = await import("../../store/sessions.js");
    initStore();
    const mem = await import("../../store/memory.js");
    const { forkThread, carryForkConclusion } = await import("../../core/thread-fork.js");
    const { enqueueThreadTurn } = await import("../../core/worker-jobs.js");
    const db = getDb();
    const noSdk = { forkSession: async (): Promise<{ sessionId: string }> => { throw new Error("no"); }, sessionKnown: async () => true };
    const seed = (k: string, name: string): void => {
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, last_used_at, created_at, name) VALUES (?, ?, ?, 'm', 1, 1, ?)`).run(CH, k, `codex-${k}`, name);
      mem.appendTranscript({ claudeSessionId: `codex-${k}`, role: "user", content: "q" });
      mem.indexCodexTurn({ channel: CH, threadKey: k, claudeSessionId: `codex-${k}` });
    };
    const P = `dashboard:${randomUUID()}`;
    seed(P, "여행 계획");
    const K = `dashboard:${randomUUID()}`;
    await forkThread(P, K, noSdk);

    // 대역 핸들러 — 진짜처럼 **세션 줄**에 넣고, 가지 턴엔 결론을 답한다.
    const seen: IncomingMessage[] = [];
    let answer = "결론: 3박 4일 · 숙소는 B";
    const handler = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
      seen.push(m);
      if (m.threadKey === K) await m.reply(answer);
    });
    const delivered: { text: string; originThreadKey: string }[] = [];
    const deliver = async (i: { text: string; originThreadKey: string }): Promise<void> => { delivered.push(i); };
    const r = await carryForkConclusion(K, { channel: CH }, { runTurn: handler, deliver });
    await new Promise((res) => setTimeout(res, 20)); // ②는 줄에 넣고 돌아온다
    const [a, b] = seen;
    // ★②도 합성이다 (10-15 정태님 «시스템적인 메시지 알림 같아») — 비서에게 하는 당부가 사용자 말풍선에 사용자 이름으로 뜨던 것.
    //  원래 대화의 비서가 알림으로 받고, 화면엔 «무엇을 받았는지» 알리는 비서 답만 남는다(백그라운드 작업 완료 알림과 같은 모양).
    out.push(assert("★★① 가지 턴(합성·가지 지정)으로 결론을 받고 ② 원래 대화의 비서에게 **합성 알림**으로 전한다(사용자 말풍선 없음 · 가지 이름·결론 포함 · 원래 대화 지정) · 결과에 원래 대화 이름",
      r.ok && r.parentKey === P && r.parentName === "여행 계획" && seen.length === 2 &&
        a!.threadKey === K && a!.synthetic === true && a!.session?.explicitSessionId === K &&
        b!.threadKey === P && b!.synthetic === true && b!.session?.explicitSessionId === P &&
        b!.text.includes("결론: 3박 4일") && b!.text.includes("여행 계획 (2)"),
      { r, turns: seen.map((m) => ({ tk: m.threadKey === K ? "K" : m.threadKey === P ? "P" : m.threadKey, synthetic: m.synthetic, text: m.text.slice(0, 40) })) }));

    seen.length = 0;
    answer = "   ";
    const empty = await carryForkConclusion(K, { channel: CH }, { runTurn: handler, deliver });
    await new Promise((res) => setTimeout(res, 20));
    out.push(assert("결론이 비면 원래 대화에 아무것도 넣지 않는다", !empty.ok && empty.reason === "empty" && seen.length === 1, { empty, turns: seen.length }));
    const notFork = await carryForkConclusion(P, { channel: CH }, { runTurn: handler, deliver });
    out.push(assert("가지가 아닌 대화는 거절한다", !notFork.ok && notFork.reason === "not_fork", notFork));

    // ★가지 턴이 **실패 답**(한도·장애·훅 차단 — `turnFailed`)을 내면 그건 결론이 아니다 — 원래 대화에 넣지 않는다(적대 검토 P3).
    seen.length = 0;
    const failing = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
      seen.push(m);
      if (m.threadKey === K) await m.reply("⚠️ 응답 생성 실패: 429 rate limit", { turnFailed: true });
    });
    const failedCarry = await carryForkConclusion(K, { channel: CH }, { runTurn: failing, deliver });
    await new Promise((res) => setTimeout(res, 20));
    out.push(assert("★가지 턴이 실패 답을 내면 실패로 끝내고 원래 대화엔 아무것도 안 넣는다", !failedCarry.ok && failedCarry.reason === "failed" && seen.length === 1, { failedCarry, turns: seen.length }));

    // 답 배달 귀속 — ① 은 가지, ② 는 원래 대화 이름으로(답장하면 그 세션으로 간다, 적대 검토 P2).
    delivered.length = 0; seen.length = 0; answer = "결론: 귀속 확인";
    const replying = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => { seen.push(m); await m.reply(m.threadKey === K ? answer : "받았습니다"); });
    await carryForkConclusion(K, { channel: "telegram", address: "chat-x" }, { runTurn: replying, deliver });
    await new Promise((res) => setTimeout(res, 20));
    out.push(assert("★답 배달: 가지 정리는 가지 이름으로, 원래 대화의 확인은 원래 대화 이름으로 귀속된다",
      delivered.some((d) => d.originThreadKey === K && d.text === "결론: 귀속 확인") && delivered.some((d) => d.originThreadKey === P && d.text === "받았습니다"),
      delivered.map((d) => `${d.originThreadKey === K ? "K" : d.originThreadKey === P ? "P" : "?"}:${d.text}`)));

    // 같은 가지를 겹쳐 보내면 두 번째는 거절 — 같은 결론이 두 번 들어가지 않는다.
    // 걸린 턴을 **전부** 풀 수 있게 모은다 — 가드가 빠져 두 번째가 줄에 서도 검사가 매달리지 않고 빨강으로 끝난다.
    const releases: (() => void)[] = [];
    let gate = true;
    const slow = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
      if (m.threadKey === K) { if (gate) await new Promise<void>((res) => { releases.push(res); }); await m.reply("결론: 느림"); }
    });
    const firstCarry = carryForkConclusion(K, { channel: CH }, { runTurn: slow, deliver });
    await new Promise((res) => setTimeout(res, 10));
    const secondP = carryForkConclusion(K, { channel: CH }, { runTurn: slow, deliver });
    await new Promise((res) => setTimeout(res, 10));
    gate = false;
    for (const r of releases) r();
    const [, second] = await Promise.all([firstCarry, secondP]);
    out.push(assert("같은 가지를 겹쳐 보내면 두 번째는 «보내는 중» 으로 거절", !second.ok && second.reason === "busy", second));

    // `/fork back` — 대화방을 원래 대화로 돌리고, 가지 줄 **안**에서 불려도 멈추지 않는다(결론 정리는 같은 줄의 뒤에서 돈다).
    const { handleFork } = await import("../../core/entry/slash-commands.js");
    const { getChannelSessionBinding, setChannelSessionBinding } = await import("../../store/channel-session.js");
    const { registerWorkerHandler } = await import("../../core/worker-jobs.js");
    seen.length = 0;
    answer = "결론: 가지에서 정한 것";
    registerWorkerHandler(handler as never);
    setChannelSessionBinding("telegram", "chat-carry-1", K);
    const replies: string[] = [];
    const tg = { channel: "telegram", channelUserId: "u", threadKey: K, channelAddress: "chat-carry-1", text: "/fork back", receivedAt: Date.now(), reply: async (t: string) => { replies.push(t); } };
    const inQueue = enqueueThreadTurn(K, () => handleFork({ msg: tg as never, args: "back", trimmed: "/fork back", sidChannel: CH }).then(() => "done"));
    const settled = await Promise.race([inQueue, new Promise((res) => setTimeout(() => res("멈춤"), 5000))]);
    await new Promise((res) => setTimeout(res, 50));
    out.push(assert("★`/fork back`: 가지 줄 안에서 불려도 끝나고 · 대화방이 원래 대화로 돌아가고 · 결론이 원래 대화로 간다",
      settled === "done" && getChannelSessionBinding("telegram", "chat-carry-1") === P &&
        seen.some((m) => m.threadKey === K && m.synthetic === true) && seen.some((m) => m.threadKey === P && m.text.includes("가지에서 정한 것")),
      { settled, bound: getChannelSessionBinding("telegram", "chat-carry-1") === P ? "P" : "?", turns: seen.map((m) => (m.threadKey === K ? "K" : "P")), replies }));

    // 세션 목록이 가지를 알린다 — 화면이 «결론을 원래 대화로 보내기» 를 가지 탭에만 보인다.
    const routeUrl = new URL("../../../plugins/http-bridge/routes-sessions.js", import.meta.url).href;
    const { handleSessions } = (await import(routeUrl)) as { handleSessions: (ctx: unknown) => Promise<void> };
    let body = "";
    const res = { writeHead: () => res, setHeader: () => res, end: (b: string) => { body = b; } };
    await handleSessions({ req: {}, res, url: new URL("http://x/sessions") });
    const list = (JSON.parse(body) as { sessions: { threadKey: string; forkedFrom?: string }[] }).sessions;
    out.push(assert("세션 목록: 가지는 forkedFrom(원래 대화) · 원래 대화엔 없음",
      list.find((x) => x.threadKey === K)?.forkedFrom === P && list.find((x) => x.threadKey === P)?.forkedFrom === undefined,
      { K: list.find((x) => x.threadKey === K)?.forkedFrom === P, P: list.find((x) => x.threadKey === P)?.forkedFrom }));
        // `/fork back` 실패 — 방을 **가지로 되돌리고** 다시 하라고 말한다(안 그러면 다시 치는 곳이 원래 대화라 «가지가 아닙니다»).
    seen.length = 0;
    registerWorkerHandler(failing as never);
    setChannelSessionBinding("telegram", "chat-carry-2", K);
    replies.length = 0;
    await handleFork({ msg: { ...tg, channelAddress: "chat-carry-2" } as never, args: "back", trimmed: "/fork back", sidChannel: CH });
    await new Promise((res) => setTimeout(res, 50));
    out.push(assert("★`/fork back` 이 실패하면 방이 가지로 돌아가고 «다시 해 주세요» 를 말한다",
      getChannelSessionBinding("telegram", "chat-carry-2") === K && replies.length === 2, { bound: getChannelSessionBinding("telegram", "chat-carry-2") === K ? "K" : "P", replies }));
    return out;
  },
};
