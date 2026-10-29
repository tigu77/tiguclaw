/**
 * 회귀: **답 큐가 표시 탭과 다른 선택지(대화 밖 작업의 질문)는 «바쁨»·✕ 취소·승격을 그 큐로 본다** (2026-10-28, 설계
 * `docs/decisions/2026-10-28-prompt-choice-release-followup.md` §2.3·§4.2 — GPT d918 P2-1 보정).
 *
 * 사고(설계 검토 지적): 선택지는 목적지 대화(`dashboard:X`)에 보이지만 답은 작업 스레드(`scheduler:…`)에 줄 선다. 화면의 «바쁨»(대기 버블)과
 *  ✕ 취소가 **표시 탭** 키를 보면, 답 큐가 바빠도 대기 버블·✕ 가 없고, 두 탭 다 바쁘면 ✕ 가 `dashboard:X` 큐에서 그 항목을 못 찾는다
 *  («not-found») → 취소·재선택이 막힌다.
 *
 * 지키는 것(진짜 대시보드 JS · 가짜 fetch):
 *  ① 답 큐만 바쁨 → 대기 버블(✕) · 전송 방은 표시 탭 그대로 · ✕ 는 답 큐 키·같은 상관 id 로 → cancelled → 카드 재개방 → 재선택
 *  ② 두 탭 다 바쁨 → ✕ 는 여전히 답 큐 키 · ③ 표시 탭만 바쁨 → 대기 버블 없음
 *  ④ 답 큐의 같은 상관 id echo → 버블 승격·되살림 거둠 · 다른 상관 id·같은 글의 숨은 스레드 echo → 활성 탭에 아무것도 안 그림
 *  ⑤ 필드 없는 카드 → 종전(활성 탭 키) · ⑥ 닫힘 거절 때 «작업 중» 끄기는 **이 탭**이 전송 전에 바빴나로(답 큐와 섞지 않는다)
 *
 * 등급: **동작**.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { promptCardDash } from "./_prompt-card-fixture.js";

const TAB = "dashboard:regr-shown";
const AQ = "scheduler:regr-aq";
const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];

export const check: RegressionCheck = {
  name: "prompt-card-answer-queue-seat",
  guards: "답 큐가 표시 탭과 다른 선택지의 «바쁨»·✕ 취소가 표시 탭 키를 봐서 대기 버블이 없거나 ✕ 가 not-found 로 빗나가던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const f = promptCardDash(TAB);
    const busy = (k: string): void => { f.dash.run(`markTurnActive(${JSON.stringify(k)})`); };
    const idle = (k: string): void => { f.dash.run(`markTurnDone(${JSON.stringify(k)})`); };
    const cancelBodies = (): Array<Record<string, unknown>> => f.sent.filter((s) => s.url === "/api/cancel-queued").map((s) => s.body);

    // ① 답 큐만 바쁨
    busy(AQ);
    const c1 = f.card({ question: "S1", options: OPTS, promptId: "s1", threadKey: TAB, answerThreadKey: AQ });
    const d1 = f.deferred();
    f.reply("/api/messages", d1.fn);
    c1.click(0);
    await f.flush();
    const post1 = f.lastPost()?.body ?? {};
    const cid1 = String(post1.correlationId ?? "");
    const bubble1 = f.pending().find((p) => p.cid === cid1) ?? null;
    f.reply("/api/cancel-queued", { status: 200, body: { result: "cancelled" } });
    f.clickCancel(cid1);
    await f.flush();
    const x1 = cancelBodies().at(-1) ?? {};
    const reopened1 = c1.state();
    d1.release({ replyText: "", cancelled: true }, 200);
    await f.flush();
    f.reply("/api/messages", { status: 200, body: { replyText: "ok" } });
    c1.click(1);
    await f.flush();
    const post1b = f.lastPost()?.body ?? {};
    out.push(assert(
      "★① 답 큐만 바쁨 — 대기 버블(✕) · 전송 방은 표시 탭 · ✕ = 답 큐 키·같은 상관 id → cancelled → 카드 재개방 → 같은 질문으로 재선택",
      bubble1?.queued === true && bubble1.cancelable && bubble1.queueKey === AQ && post1.threadKey === TAB && post1.promptId === "s1" &&
        x1.threadKey === AQ && x1.correlationId === cid1 && reopened1.picked.length === 0 && reopened1.anyEnabled &&
        post1b.promptId === "s1" && post1b.text === "b",
      { 버블: bubble1, 전송: { threadKey: post1.threadKey, promptId: post1.promptId }, 취소요청: x1, 재개방: reopened1, 재선택: { text: post1b.text, promptId: post1b.promptId } },
    ));

    // ② 두 탭 다 바쁨 → ✕ 는 답 큐 키
    busy(AQ); busy(TAB);
    const c2 = f.card({ question: "S2", options: OPTS, promptId: "s2", threadKey: TAB, answerThreadKey: AQ });
    f.reply("/api/messages", f.deferred().fn);
    c2.click(0);
    await f.flush();
    const cid2 = String(f.lastPost()?.body.correlationId ?? "");
    f.reply("/api/cancel-queued", { status: 200, body: { result: "cancelled" } });
    f.clickCancel(cid2);
    await f.flush();
    const x2 = cancelBodies().at(-1) ?? {};
    out.push(assert("★② 두 탭 다 바빠도 ✕ 는 답 큐 키로(표시 탭 큐를 지목하지 않는다)", x2.threadKey === AQ && x2.correlationId === cid2, x2));

    // ③ 표시 탭만 바쁨 → 대기 버블 없음
    idle(AQ); busy(TAB);
    const c3 = f.card({ question: "S3", options: OPTS, promptId: "s3", threadKey: TAB, answerThreadKey: AQ });
    f.reply("/api/messages", f.deferred().fn);
    c3.click(0);
    await f.flush();
    const cid3 = String(f.lastPost()?.body.correlationId ?? "");
    out.push(assert("③ 표시 탭만 바쁘고 답 큐는 한가 — 대기 버블 없음(바로 시작될 답)", !f.pending().some((p) => p.cid === cid3), f.pending()));

    // ④ 승격 · 남의 숨은 echo
    busy(AQ);
    const c4 = f.card({ question: "S4", options: OPTS, promptId: "s4", threadKey: TAB, answerThreadKey: AQ });
    f.reply("/api/messages", { status: 504, body: { error: "timeout", accepted: true, running: true } });
    c4.click(0);
    await f.flush();
    const cid4 = String(f.lastPost()?.body.correlationId ?? "");
    const drawnBefore = f.dash.run(`vtItems.length`) as number;
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: AQ, text: "a", correlationId: "someone-else" } })})`);
    const afterForeign = { drawn: f.dash.run(`vtItems.length`) as number, stillQueued: f.pending().find((p) => p.cid === cid4)?.queued ?? null };
    // ④b (GPT 0f P2) 활성 표시 탭의 메아리는 답 큐 버블을 승격하지 못한다 — 다른 상관 id·같은 글(다른 브라우저가 같은 «a» 를 보냄)도,
    //  같은 상관 id 라도 키가 답 큐가 아니면. 표시 탭의 그 글은 평소처럼 새 말풍선으로 그려진다.
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: TAB, text: "a", correlationId: "other-browser" } })})`);
    const crossText = f.pending().find((p) => p.cid === cid4) ?? null;
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now() + 1, payload: { channel: "http-bridge", threadKey: TAB, text: "a" } })})`);
    const crossNoCid = f.pending().find((p) => p.cid === cid4) ?? null;
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now() + 2, payload: { channel: "http-bridge", threadKey: TAB, text: "a", correlationId: cid4 } })})`);
    const crossSameCid = f.pending().find((p) => p.cid === cid4) ?? null;
    const drawnBeforeOwn = f.dash.run(`vtItems.length`) as number;
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now() + 3, payload: { channel: "http-bridge", threadKey: AQ, text: "a", correlationId: cid4 } })})`);
    const afterOwn = { inPending: f.pending().some((p) => p.cid === cid4), reopener: f.hasReopener(cid4), drawn: f.dash.run(`vtItems.length`) as number };
    out.push(assert(
      "★④ 답 큐의 같은 상관 id echo → 버블 승격(대기 해제)·되살림 거둠 · 다른 상관 id·같은 글의 숨은 echo → 아무것도 안 그리고 버블 그대로",
      afterForeign.drawn === drawnBefore && afterForeign.stillQueued === true && !afterOwn.inPending && !afterOwn.reopener && afterOwn.drawn === drawnBeforeOwn,
      { drawnBefore, afterForeign, afterOwn },
    ));
    out.push(assert(
      "★④b 활성 표시 탭의 메아리는 답 큐 버블을 승격하지 못한다 — 다른 상관 id·같은 글 · 상관 id 없는 같은 글 · 같은 상관 id 라도 답 큐 키가 아니면 버블(✕)이 그대로",
      crossText?.queued === true && crossText.cancelable && crossNoCid?.queued === true && crossNoCid.cancelable && crossSameCid?.queued === true && crossSameCid.cancelable,
      { 다른cid같은글: crossText, cid없는같은글: crossNoCid, 같은cid다른키: crossSameCid },
    ));
    // ④c 보존 — 답 큐가 없는 평소 대기 버블(직접 친 글 · 필드 없는 카드)은 종전대로 활성 탭의 상관 id·텍스트 폴백으로 승격된다.
    busy(TAB);
    f.reply("/api/messages", f.deferred().fn);
    void f.dash.run(`sendChatMessage("직접 친 글 C", undefined, undefined)`);
    await f.flush();
    const directQueued = f.pending().find((p) => p.cid === String(f.lastPost()?.body.correlationId ?? "")) ?? null;
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now() + 4, payload: { channel: "telegram", threadKey: TAB, text: "직접 친 글 C" } })})`);
    const directAfter = f.pending().some((p) => p.cid === directQueued?.cid);
    out.push(assert(
      "④c 보존 — 답 큐 없는 평소 대기 버블(직접 친 글)은 활성 탭의 텍스트 메아리(상관 id 없음)로 종전대로 승격된다",
      directQueued?.queued === true && directQueued.queueKey === undefined && directAfter === false,
      { 대기버블: directQueued, 승격뒤남음: directAfter },
    ));

    // ⑤ 필드 없는 카드 → 종전(활성 탭 키)
    busy(AQ); idle(TAB);
    const c5 = f.card({ question: "S5", options: OPTS, promptId: "s5", threadKey: TAB });
    f.reply("/api/messages", f.deferred().fn);
    c5.click(0);
    await f.flush();
    const cid5 = String(f.lastPost()?.body.correlationId ?? "");
    const noBubble5 = !f.pending().some((p) => p.cid === cid5);
    busy(TAB);
    const c5b = f.card({ question: "S5b", options: OPTS, promptId: "s5b", threadKey: TAB });
    f.reply("/api/messages", f.deferred().fn);
    c5b.click(0);
    await f.flush();
    const cid5b = String(f.lastPost()?.body.correlationId ?? "");
    f.reply("/api/cancel-queued", { status: 200, body: { result: "cancelled" } });
    f.clickCancel(cid5b);
    await f.flush();
    const x5 = cancelBodies().at(-1) ?? {};
    out.push(assert("⑤ answerThreadKey 없는 카드 — «바쁨»·✕ 모두 종전대로 활성 탭 키", noBubble5 && x5.threadKey === TAB && x5.correlationId === cid5b, { 답큐만바쁨일때버블없음: noBubble5, 취소요청: x5 }));

    // ⑥ 닫힘 거절 — 이 탭이 전송 전에 한가했으면 이번 전송이 켠 «작업 중» 을 끈다(답 큐가 바빠도)
    busy(AQ); idle(TAB);
    const c6 = f.card({ question: "S6", options: OPTS, promptId: "s6", threadKey: TAB, answerThreadKey: AQ });
    f.reply("/api/messages", { status: 409, body: { error: "closed", code: "prompt-closed", reason: "answered" } });
    c6.click(0);
    await f.flush();
    const tabWorking = f.dash.run(`activeTurns.has(${JSON.stringify(TAB)})`) as boolean;
    const aqStill = f.dash.run(`activeTurns.has(${JSON.stringify(AQ)})`) as boolean;
    out.push(assert("⑥ 닫힘 거절 — 이 탭의 «작업 중» 은 끈다(전송 전 한가) · 답 큐의 진행 표시는 그대로", tabWorking === false && aqStill === true, { tabWorking, aqStill }));
    return out;
  },
};

export default check;
