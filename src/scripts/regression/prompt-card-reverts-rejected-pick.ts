/**
 * 회귀: **대시보드 선택지 카드는 서버가 거절·취소한 선택을 «고른 것» 으로 남기지 않는다** (2026-10-28, 설계
 * `docs/decisions/2026-10-28-prompt-choice-release-followup.md` §4 A2).
 *
 * 사고(독립 검토 성립): 카드는 클릭 즉시 선택을 저장·표시하고 전송 결과를 버렸다 — 다른 곳에서 이미 답한 질문(409)도, 큐에서 ✕ 로 취소된
 *  답도 영구히 «선택됨» 이었다(새로 고침해도 복원).
 *
 * 지키는 것(진짜 대시보드 JS · 가짜 fetch):
 *  ① 409 닫힘 → 선택 표시 해제 · 버튼·기타 계속 비활성(되살리지 않음) · 서버 문구 한 줄 · `po:` 삭제·닫힘 저장 → 같은 카드 다시 그려도 닫힘
 *  ② `sendChatMessage` 가 사실을 돌려준다 — 409 → closed·reason · 200 cancelled → cancelled · 504 → stillRunning
 *  ③ 늦게 온 cancelled · 서버가 «안 받았다»(400) → 다시 활성 · 저장 없음 / 수락(200) → 선택·저장 유지 · 되살림 거둠
 *  ④ 세대 — 취소 확정 뒤 다시 고른 답을 늦게 온 첫 응답이 덮지 않는다
 *  ⑤ 504 뒤에도 되살림이 산다 → ✕ cancelled 확정에 다시 열려 같은 질문 id 로 재전송 · ✕ 누르기만으론 안 열림 · already-started 면 닫힌 채·되살림 거둠
 *  ⑥ 그 상관 id 의 시작 echo(승격)가 되살림을 거둔다 · 상한 50(가장 오래된 것부터)
 *
 * 등급: **동작**.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { promptCardDash } from "./_prompt-card-fixture.js";

const TAB = "dashboard:regr-card";
const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
const CLOSED_MSG = "This question has already been answered.";

export const check: RegressionCheck = {
  name: "prompt-card-reverts-rejected-pick",
  guards: "대시보드 선택지 카드가 서버가 거절(409)하거나 큐에서 취소된 선택을 선택된 것으로 영구 저장·표시하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const f = promptCardDash(TAB);

    // ① 409 닫힘
    const c1 = f.card({ question: "Q1", options: OPTS, promptId: "p1", threadKey: TAB });
    f.reply("/api/messages", { status: 409, body: { error: CLOSED_MSG, code: "prompt-closed", reason: "answered" } });
    c1.click(0);
    await f.flush();
    const s1 = c1.state();
    // 같은 rawTs·질문으로 다시 그린 카드(새로 고침 복원과 같은 빌더) — 손잡이는 다른 ts 라 직접 빌더를 부른다.
    const rebuilt = f.dash.run(`(() => { const d = buildPromptOptions(${JSON.stringify({ question: "Q1", options: OPTS, promptId: "p1", threadKey: TAB })}, "10:00", ${c1.rawTs}); return { picked: [...d.querySelectorAll(".prompt-option-btn.picked")].length, disabled: [...d.querySelectorAll("button")].every((b) => b.disabled), note: (d.querySelector(".prompt-closed-note") || {}).textContent || null }; })()`) as { picked: number; disabled: boolean; note: string | null };
    out.push(assert(
      "★① 409 닫힘 — 선택 해제 · 전부 비활성(되살리지 않음) · 서버 문구 · `po:` 없음·닫힘 저장 → 다시 그려도 닫힘",
      s1.picked.length === 0 && s1.allDisabled && s1.note === CLOSED_MSG && s1.saved === null && s1.closedSaved === CLOSED_MSG &&
        rebuilt.picked === 0 && rebuilt.disabled && rebuilt.note === CLOSED_MSG,
      { 첫카드: s1, 다시그림: rebuilt },
    ));

    // ② sendChatMessage 반환 사실
    f.reply("/api/messages", { status: 409, body: { error: CLOSED_MSG, code: "prompt-closed", reason: "expired" } });
    const r409 = (await f.dash.run(`sendChatMessage("x", undefined, undefined, "p-x")`)) as Record<string, unknown>;
    f.reply("/api/messages", { status: 200, body: { replyText: "", cancelled: true } });
    const r200c = (await f.dash.run(`sendChatMessage("y", undefined, undefined, "p-y")`)) as Record<string, unknown>;
    f.reply("/api/messages", { status: 504, body: { error: "timeout", accepted: true, running: true } });
    const r504 = (await f.dash.run(`sendChatMessage("z", undefined, undefined, "p-z")`)) as Record<string, unknown>;
    out.push(assert(
      "② sendChatMessage — 409 → closed·reason·문구 · 200 cancelled → cancelled · 504 → stillRunning(되돌리지 않음)",
      r409.closed === true && r409.reason === "expired" && r409.error === CLOSED_MSG && r409.restore === false &&
        r200c.ok === true && r200c.cancelled === true && r504.stillRunning === true && r504.restore === false,
      { r409, r200c, r504 },
    ));

    // ③ cancelled(늦은 응답) · 400 · 수락
    const c3 = f.card({ question: "Q3", options: OPTS, promptId: "p3", threadKey: TAB });
    f.reply("/api/messages", { status: 200, body: { replyText: "", cancelled: true } });
    c3.click(1);
    await f.flush();
    const s3 = c3.state();
    const c3b = f.card({ question: "Q3b", options: OPTS, promptId: "p3b", threadKey: TAB });
    f.reply("/api/messages", { status: 400, body: { error: "bad" } });
    c3b.click(0);
    await f.flush();
    const s3b = c3b.state();
    const c3c = f.card({ question: "Q3c", options: OPTS, promptId: "p3c", threadKey: TAB });
    f.reply("/api/messages", { status: 200, body: { replyText: "ok" } });
    c3c.click(0);
    await f.flush();
    const s3c = c3c.state();
    const cid3c = String(f.lastPost()?.body.correlationId ?? "");
    out.push(assert(
      "★③ 늦게 온 cancelled·서버가 «안 받았다»(400) → 다시 활성·저장 없음 / 수락(200) → 선택·저장 유지 · 되살림 거둠",
      s3.picked.length === 0 && s3.anyEnabled && s3.saved === null && s3b.picked.length === 0 && s3b.anyEnabled && s3b.saved === null &&
        s3c.picked.join() === "a" && s3c.allDisabled && s3c.saved === "a" && cid3c !== "" && !f.hasReopener(cid3c),
      { cancelled: s3, rejected400: s3b, accepted: s3c, 수락되살림: f.hasReopener(cid3c) },
    ));

    // ④ 세대 — 첫 POST 보류 → 취소 확정(되살림) → B 재선택 → 첫 응답 cancelled 늦게 → B 유지
    const c4 = f.card({ question: "Q4", options: OPTS, promptId: "p4", threadKey: TAB });
    const d4a = f.deferred();
    const d4b = f.deferred();
    f.reply("/api/messages", d4a.fn);
    f.reply("/api/messages", d4b.fn);
    c4.click(0);
    await f.flush();
    const cid4a = String(f.lastPost()?.body.correlationId ?? "");
    f.dash.run(`reopenPromptCard(${JSON.stringify(cid4a)})`);
    const reopened4 = c4.state();
    c4.click(1);
    await f.flush();
    d4a.release({ replyText: "", cancelled: true }, 200);
    await f.flush();
    const mid4 = c4.state();
    d4b.release({ replyText: "ok" }, 200);
    await f.flush();
    const end4 = c4.state();
    out.push(assert(
      "★④ 세대 — 취소 확정 뒤 다시 고른 B 를 늦게 온 첫 응답(cancelled)이 덮지 않는다",
      reopened4.picked.length === 0 && reopened4.anyEnabled && mid4.picked.join() === "b" && mid4.saved === "b" && end4.picked.join() === "b" && end4.saved === "b",
      { 되살림직후: reopened4, 늦은첫응답뒤: mid4, 끝: end4 },
    ));

    // ⑤ 504 뒤 ✕ (탭이 바쁠 때 대기 버블·✕)
    f.dash.run(`markTurnActive(${JSON.stringify(TAB)})`);
    const c5 = f.card({ question: "Q5", options: OPTS, promptId: "p5", threadKey: TAB });
    f.reply("/api/messages", { status: 504, body: { error: "timeout", accepted: true, running: true } });
    c5.click(0);
    await f.flush();
    const cid5 = String(f.lastPost()?.body.correlationId ?? "");
    const after504 = { ...c5.state(), reopener: f.hasReopener(cid5), bubble: f.pending().find((p) => p.cid === cid5) ?? null };
    const dX = f.deferred();
    f.reply("/api/cancel-queued", dX.fn);
    f.clickCancel(cid5);
    await f.flush();
    const clickOnly = c5.state();
    dX.release({ result: "cancelled" }, 200);
    await f.flush();
    const afterCancel = { ...c5.state(), reopener: f.hasReopener(cid5) };
    f.reply("/api/messages", { status: 200, body: { replyText: "ok" } });
    c5.click(1);
    await f.flush();
    const resend = f.lastPost()?.body;
    // already-started
    f.dash.run(`markTurnActive(${JSON.stringify(TAB)})`); // 504 즉시 응답이 이 탭의 작업 표시를 껐다 — 다시 바쁘게.
    const c5b = f.card({ question: "Q5b", options: OPTS, promptId: "p5b", threadKey: TAB });
    f.reply("/api/messages", { status: 504, body: { error: "timeout", accepted: true, running: true } });
    c5b.click(0);
    await f.flush();
    const cid5b = String(f.lastPost()?.body.correlationId ?? "");
    f.reply("/api/cancel-queued", { status: 200, body: { result: "already-started" } });
    f.clickCancel(cid5b);
    await f.flush();
    const started5b = { ...c5b.state(), reopener: f.hasReopener(cid5b) };
    out.push(assert(
      "★⑤ 504 뒤에도 되살림이 산다 — ✕ 누르기만으론 닫힌 채 · cancelled 확정에 다시 열림(`po:` 없음)·같은 질문 id 로 재전송 · already-started 면 닫힌 채·되살림 거둠",
      after504.picked.join() === "a" && after504.saved === "a" && after504.allDisabled && after504.reopener && after504.bubble?.cancelable === true &&
        clickOnly.picked.join() === "a" && clickOnly.allDisabled &&
        afterCancel.picked.length === 0 && afterCancel.anyEnabled && afterCancel.saved === null && !afterCancel.reopener &&
        resend?.promptId === "p5" && resend?.text === "b" &&
        started5b.picked.join() === "a" && started5b.allDisabled && !started5b.reopener,
      { after504, clickOnly, afterCancel, 재전송: resend ?? null, alreadyStarted: started5b },
    ));

    // ⑥ 승격 echo 가 되살림을 거둔다 · 상한 50
    const c6 = f.card({ question: "Q6", options: OPTS, promptId: "p6", threadKey: TAB });
    f.reply("/api/messages", { status: 504, body: { error: "timeout", accepted: true, running: true } });
    c6.click(0);
    await f.flush();
    const cid6 = String(f.lastPost()?.body.correlationId ?? "");
    const before6 = f.hasReopener(cid6);
    f.dash.run(`renderEvent(${JSON.stringify({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: TAB, text: "a", correlationId: cid6 } })})`);
    const after6 = f.hasReopener(cid6);
    f.dash.run(`for (let i = 0; i < 51; i += 1) registerPromptCardReopener("cap-" + i, () => {})`);
    const cap = { size: f.reopeners(), oldest: f.hasReopener("cap-0"), second: f.hasReopener("cap-1"), newest: f.hasReopener("cap-50") };
    out.push(assert(
      "⑥ 그 상관 id 의 시작 echo 가 되살림을 거둔다 · 되살림 상한 50 — 넘치면 가장 오래된 것부터",
      before6 && !after6 && cap.size === 50 && !cap.oldest && cap.second && cap.newest,
      { 승격전: before6, 승격후: after6, cap },
    ));
    return out;
  },
};

export default check;
