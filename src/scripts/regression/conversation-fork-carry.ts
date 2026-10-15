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
    const { recordChatMessage } = await import("../../store/chat-log.js");
    const P = `dashboard:${randomUUID()}`;
    seed(P, "여행 계획");
    recordChatMessage({ threadKey: P, channel: "dashboard", role: "user", text: "갈라지기 전 메시지 — 여행지는 미정", ts: Date.now() } as never);
    const K = `dashboard:${randomUUID()}`;
    await forkThread(P, K, noSdk);
    recordChatMessage({ threadKey: K, channel: "dashboard", role: "user", text: "가지에서 처음 보낸 말 — 숙소부터 정하자", ts: Date.now() + 1 } as never);

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
        a!.threadKey === K && a!.synthetic === true && a!.session?.explicitSessionId === K && a!.turnOrigin === "fork-carry" &&
        b!.threadKey === P && b!.synthetic === true && b!.session?.explicitSessionId === P && b!.turnOrigin !== "fork-carry" &&
        b!.text.includes("결론: 3박 4일") && b!.text.includes("여행 계획 (2)") &&
        // 정리 지시: **빠짐없이** + 경계 = 가지에서 처음 보낸 메시지(갈라지기 전 메시지가 아니다 · 10-15 정태님 «충분히 정리해서 넘기는 거지?»)
        a!.text.includes("빠짐없이") && a!.text.includes("가지에서 처음 보낸 말") && !a!.text.includes("갈라지기 전 메시지"),
      { r, turns: seen.map((m) => ({ tk: m.threadKey === K ? "K" : m.threadKey === P ? "P" : m.threadKey, synthetic: m.synthetic, origin: m.turnOrigin, text: m.text.slice(0, 40) })) }));

    // ★정리 턴(`fork-carry`)엔 끼워넣기 채널을 안 붙인다 — 붙이면 그 사이 가지에 친 말이 정리에 섞여 «결론» 으로 원래 대화에 가고,
    //  그 말은 «보냄» 앞이라 다음 보내기에서도 빠졌다(릴리스 레드팀 F2). 원래 대화 턴(②)은 종전대로 받는다.
    {
      const { readSourceSync, stripComments } = await import("./_wiring.js");
      const entry = stripComments(readSourceSync("src/index.ts"));
      out.push(assert("★진입점: 끼워넣기 채널은 `fork-carry` 턴에 안 만든다",
        /if\s*\(\s*STEERING_ENABLED\s*&&\s*msg\.turnOrigin\s*!==\s*"fork-carry"\s*\)/.test(entry),
        entry.split("\n").filter((l) => l.includes("STEERING_ENABLED")).map((l) => l.trim())));
    }

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

    // ★다시 보내면 **지난번 보낸 뒤**만 (10-15 정태님 «보낸 부분까지는 저장되고 다시 보내면 그 이후의 내용을»).
    //  보내기는 가지 화면에 `thread.carried` 구분선을 남기고(대화 가시 이벤트 → chat_log), 다음 보내기는 그 뒤 첫 사용자 메시지부터 정리한다.
    //  새 대화가 없으면 가지 비서를 부르지 않는다(헛턴·같은 결론 중복). 적재는 이벤트 영속기(`event-persist`)가 한다 — 여기선 그 한 줄을 흉내 낸다.
    {
      const { getEventBus } = await import("../../core/eventbus.js");
      const K3 = `dashboard:${randomUUID()}`;
      await forkThread(P, K3, noSdk);
      recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "첫 이야기 — 숙소", ts: Date.now() + 10 } as never);
      const marks: { threadKey?: string; parentKey?: string; parentName?: string }[] = [];
      const unsub = getEventBus().subscribe((e: { type: string; ts: number; payload: Record<string, unknown> }) => {
        if (e.type !== "thread.carried") return;
        marks.push(e.payload as never);
        recordChatMessage({ ts: e.ts, threadKey: String(e.payload.threadKey), channel: "http-bridge", role: "assistant", text: "", notice: true, kind: e.type, data: e.payload } as never);
      });
      const asks: string[] = [];
      // 원래 대화도 답한다 — «보냄» 표식은 원래 대화의 비서가 실패 없이 답한 **뒤에만** 남는다(릴리스 레드팀 F1).
      // 답은 진짜처럼 **화면 기록에도 남긴다**(진입점이 답 직후 `channel.message.out` 을 동기 발행 → 영속기) — 안 남기면 «결론 행 자신이
      //  다음 새 내용으로 잡히는가» 를 못 본다(재검토 G).
      const answerK3 = async (m: IncomingMessage, t: string): Promise<void> => {
        await m.reply(t);
        recordChatMessage({ threadKey: m.threadKey, channel: "dashboard", role: "assistant", text: t, ts: Date.now() } as never);
      };
      const h3 = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
        if (m.threadKey === K3) { asks.push(m.text); await answerK3(m, "결론: 갱신"); } else await m.reply("받았습니다");
      });
      const settle = (): Promise<unknown> => new Promise((res) => setTimeout(res, 20));
      try {
        const c1 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        const c2 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "두 번째 이야기 — 렌터카", ts: Date.now() + 20 } as never);
        const c3 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        out.push(assert("★보내면 가지에 «여기까지 보냈다» 표식 · 새 대화 없이 다시 보내면 가지 비서를 부르지 않고 «새 내용 없음» · 새 대화가 생기면 그 뒤부터만 정리",
          c1.ok && marks.length >= 1 && marks[0]!.threadKey === K3 && marks[0]!.parentKey === P && marks[0]!.parentName === "여행 계획" &&
            !c2.ok && c2.reason === "nothing_new" && asks.length === 2 &&
            c3.ok && asks[1]!.includes("두 번째 이야기") && !asks[1]!.includes("첫 이야기") && asks[1]!.includes("이미 한 번 이상") &&
            asks[0]!.includes("첫 이야기") && !asks[0]!.includes("이미 한 번 이상"),
          { c1: c1.ok, c2, c3: c3.ok, marks: marks.length, asks: asks.map((x) => x.slice(0, 120)) }));
        // ★보낸 뒤 **매니저가 끝났다** — 사용자 말 없이 비서 보고만 남는다(숨은 완료 알림 + 보고). 그것도 새 내용이다(10-15 정태님
        //  «매니저들이 엄청나게 작업을 했어»). 진행 통지(notice)만 있으면 새 내용이 아니다.
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "assistant", text: "매니저 결과 — 보고서 docs/r.md 작성", ts: Date.now() + 30 } as never);
        const c4 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "assistant", text: "⏳ 작업 진행 중", notice: true, ts: Date.now() + 40 } as never);
        const c5 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await new Promise((res) => setTimeout(res, 20));
        out.push(assert("★보낸 뒤 사용자 말 없이 매니저 결과(비서 보고)만 왔어도 다시 보내면 그 결과를 정리한다(범위 첫 기록 = 그 보고) · 진행 통지만이면 «새 내용 없음»",
          c4.ok && asks.length === 3 && asks[2]!.includes("매니저 결과 — 보고서") && asks[2]!.includes("비서의 답") && asks[2]!.includes("매니저·백그라운드 작업이 한 일") &&
            !c5.ok && c5.reason === "nothing_new" && asks.length === 3,
          { c4: c4.ok, c5, asks: asks.length, last: asks[2]?.slice(0, 200) }));

        // ★`/fork back` 도 보낼 게 없으면 **방을 옮기지 않고** 한 번만 답한다 — 종전엔 «보냅니다» 를 말하고 방을 원래 대화로 옮긴 뒤
        //  «새 내용 없음» 을 이어 말했다(릴리스 레드팀 F4).
        setChannelSessionBinding("telegram", "chat-carry-3", K3);
        replies.length = 0;
        const asksBefore = asks.length;
        await handleFork({ msg: { ...tg, threadKey: K3, channelAddress: "chat-carry-3" } as never, args: "back", trimmed: "/fork back", sidChannel: CH });
        await settle();
        out.push(assert("★`/fork back` 에 보낼 새 내용이 없으면 방은 가지에 그대로 · 답은 «새 내용 없음» 한 번 · 가지 비서를 안 부른다",
          getChannelSessionBinding("telegram", "chat-carry-3") === K3 && replies.length === 1 && asks.length === asksBefore,
          { bound: getChannelSessionBinding("telegram", "chat-carry-3") === K3 ? "K3" : "moved", replies, asks: asks.length - asksBefore }));

        // ★«보냄» 표식은 원래 대화가 **실패 없이 답한 뒤에만** — 그 턴이 실패하면(한도·장애) 다시 보낼 때 «새 내용 없음» 이 아니라
        //  같은 범위를 다시 정리한다(릴리스 레드팀 F1 — 종전엔 줄에 넣자마자 표식을 남겨 결론이 사라졌다).
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "세 번째 이야기 — 환전", ts: Date.now() + 50 } as never);
        const marksBefore = marks.length;
        const parentFails = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
          if (m.threadKey === K3) { asks.push(m.text); await answerK3(m, "결론: 환전"); } else await m.reply("⚠️ 응답 생성 실패: 429", { turnFailed: true });
        });
        const c6 = await carryForkConclusion(K3, { channel: CH }, { runTurn: parentFails, deliver });
        await settle();
        const c7 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        out.push(assert("★원래 대화 턴이 실패하면 «보냄» 표식을 안 남긴다 — 다시 보내면 같은 범위(세 번째 이야기)를 다시 정리해 보낸다",
          c6.ok && c7.ok && marks.length === marksBefore + 1 && asks[asks.length - 1]!.includes("세 번째 이야기"),
          { c6: c6.ok, c7, marks: marks.length - marksBefore, last: asks[asks.length - 1]?.slice(0, 160) }));

        // ★원래 대화가 받는 **동안** 가지에 생긴 말은 «보냄» 에 묻히지 않는다 — 표식은 그 턴이 끝난 뒤 남지만, 범위 끝은 정리 직후
        //  위치(`throughChatId`)다(F1 수정이 낳을 수 있는 빈틈).
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "네 번째 이야기 — 보험", ts: Date.now() + 60 } as never);
        let releaseParent: () => void = () => {};
        const parentSlow = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
          if (m.threadKey === K3) { asks.push(m.text); await answerK3(m, "결론: 보험"); return; }
          await new Promise<void>((res) => { releaseParent = res; setTimeout(res, 2000); });
          await m.reply("받았습니다");
        });
        const c8 = await carryForkConclusion(K3, { channel: CH }, { runTurn: parentSlow, deliver });
        await settle();
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "다섯 번째 이야기 — 받는 동안 친 말", ts: Date.now() } as never);
        // ★원래 대화가 받는 동안 다시 보내면 «보내는 중» — 표식이 아직 없어 같은 범위를 또 정리해 같은 결론이 두 번 들어간다(재검토 G).
        const asksMid = asks.length;
        const busyMid = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        out.push(assert("★원래 대화가 받는 동안 다시 보내면 «보내는 중» 으로 거절 · 가지 비서를 다시 안 부른다",
          !busyMid.ok && busyMid.reason === "busy" && asks.length === asksMid, { busyMid, asks: asks.length - asksMid }));
        releaseParent();
        await settle();
        const c9 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        out.push(assert("★원래 대화가 받는 동안 가지에 친 말은 다음 보내기 범위에 든다(표식 위치 = 정리 직후)",
          c8.ok && c9.ok && asks[asks.length - 1]!.includes("다섯 번째 이야기") && !asks[asks.length - 1]!.includes("네 번째 이야기"),
          { c8: c8.ok, c9, last: asks[asks.length - 1]?.slice(0, 160) }));
        // 구분선 «여기까지 보냈다» 는 범위 끝(결론 행) 바로 뒤 시각 — 화면 기록은 ts 순이라, 받는 동안 친 말이 구분선 **아래**에 보여야 한다(재검토 P1).
        {
          const rows = db.prepare(`SELECT id, ts, kind, text FROM chat_log WHERE thread_key = ? ORDER BY ts ASC, id ASC`).all(K3) as { id: number; ts: number; kind: string | null; text: string }[];
          const fifth = rows.findIndex((x) => x.text.includes("다섯 번째 이야기"));
          const insuranceMark = rows.findIndex((x, i) => x.kind === "thread.carried" && rows.slice(0, i).some((y) => y.text === "결론: 보험"));
          out.push(assert("★표식(구분선)은 ts 순으로 결론 행 뒤 · 받는 동안 친 말보다 앞",
            insuranceMark >= 0 && fifth > insuranceMark, { insuranceMark, fifth, order: rows.map((x) => x.kind ?? x.text.slice(0, 8)) }));
        }

        // ★정리 턴(①) 중에 가지에 친 말 — 그 턴은 줄 **뒤**에서 시작할 때 적재된다. 그 적재가 범위 끝을 잡는 것보다 먼저 돌아도(호출자가
        //  한 겹 더 감싸 한 틱 늦는 경우) 묻히지 않고 다음 범위의 첫 기록이어야 한다(재검토 G — 종전엔 «지금의 최대 id» 라 한 틱 차이에 기댔다).
        recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "여섯 번째 이야기 — 정리 직전", ts: Date.now() } as never);
        let queued: Promise<unknown> | undefined;
        const h6 = (m: IncomingMessage): Promise<unknown> => enqueueThreadTurn(m.threadKey, async () => {
          if (m.threadKey === K3) {
            asks.push(m.text);
            // 정리하는 중에 사용자가 가지에 말을 친다 — 줄 뒤에 서고, 그 턴이 시작될 때 입력 행이 적재된다.
            queued = enqueueThreadTurn(K3, async () => {
              recordChatMessage({ threadKey: K3, channel: "dashboard", role: "user", text: "일곱 번째 이야기 — 정리 중에 친 말", ts: Date.now() } as never);
              await answerK3({ ...m, reply: async () => {} } as IncomingMessage, "네, 렌터카도 볼게요");
            });
            await answerK3(m, "결론: 직전");
          } else await m.reply("받았습니다");
        });
        // 몇 틱 늦춘다 — 줄 선 턴(적재 + 답)이 범위 끝을 잡기 전에 다 돌아도 묻히지 않아야 한다.
        const wrapped = async (m: IncomingMessage): Promise<unknown> => { const r = await h6(m); for (let i = 0; i < 20; i++) await Promise.resolve(); return r; };
        const c10 = await carryForkConclusion(K3, { channel: CH }, { runTurn: wrapped, deliver });
        await queued;
        await settle();
        const c11 = await carryForkConclusion(K3, { channel: CH }, { runTurn: h3, deliver });
        await settle();
        out.push(assert("★정리 중에 가지에 친 말은 (적재가 한 틱 앞서도) 다음 보내기 범위의 첫 기록이다",
          c10.ok && c11.ok && asks[asks.length - 1]!.includes("일곱 번째 이야기") && !asks[asks.length - 1]!.includes("여섯 번째 이야기"),
          { c10: c10.ok, c11, last: asks[asks.length - 1]?.slice(0, 200) }));
      } finally {
        unsub();
      }
    }

    // ★갈라진 뒤 아무것도 안 했으면 «새 내용 없음»(지난번 보낸 뒤) 이 아니라 «아직 대화 없음» 이다 — 처음인데 «지난번» 을 말하던 것
    //  (릴리스 레드팀 F5). 가지 비서를 부르지 않는다.
    {
      const K5 = `dashboard:${randomUUID()}`;
      await forkThread(P, K5, noSdk);
      seen.length = 0;
      const y = await carryForkConclusion(K5, { channel: CH }, { runTurn: handler, deliver });
      out.push(assert("★갈라진 뒤 대화가 없으면 «nothing_yet» · 가지 비서를 부르지 않는다", !y.ok && y.reason === "nothing_yet" && seen.length === 0, { y, turns: seen.length }));
    }
    return out;
  },
};
