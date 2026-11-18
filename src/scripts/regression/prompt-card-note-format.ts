/**
 * 회귀: **선택지 카드의 설명(note)은 기존 채팅 안전 렌더로 서식, 질문·보기는 평문 · 긴 설명은 버튼과 대응을 지키며 나뉘고 일부 실패는 실패** (2026-11-18,
 * 결정 `docs/decisions/2026-11-18-choice-card-self-contained-note.md`).
 *
 * 사고(인계 정적 대조): 대시보드·텔레그램 모두 note 를 평문으로만 보내 초안·목록·명령을 카드에서 읽기 어려웠다. 텔레그램은 한 통에 몰아 보내
 *  4096자를 넘는 설명은 통째 실패했다. 도구 설명은 note 를 «보기 아래» 라 했지만 실제 자리는 버튼 위다.
 *
 * 지키는 것:
 *  ① 텔레그램 짧은 카드 — 한 통 · HTML 모드 · 설명은 채팅 답과 같은 변환(굵게·목록·코드·링크) · 질문(라벨 포함)은 이스케이프된 평문 · 버튼 그대로
 *  ② note 없는 카드 — 질문만 · 버튼 · 서식 변환 없음
 *  ③ 긴 설명 — 각 조각 ≤4096 · 버튼은 마지막 한 통에만 · 마지막 = 질문 · 설명 내용 손실 0 · 모든 조각을 답글 라우팅에 기록 · channelRefs = 전부
 *  ④ 설명 조각 실패 → ok:false · 버튼 미전송 / 버튼 통 실패 → ok:false / 빈 글 → ok:false
 *  ⑤ 버튼 통 HTML 파싱 실패 → 평문 폴백이 버튼을 유지한다
 *  ⑥ 대시보드 카드 — note 는 공용 안전 렌더(setChatBody, 마크다운)로 · 질문은 평문 · note 없으면 설명 칸 없음 · 이력 복원도 같은 빌더
 *  ⑦ 도구 설명 — 카드 완결·note 생략·중복 마무리 없음·실패≠전달 안내가 있고 «보기 아래» 표현이 없다(문구 연결 확인 — 모델 행동 보장 아님)
 *
 * 등급: ①~⑥ **동작**(실제 renderOptions·실제 prompt-options.js, 네트워크는 가짜 send) · ⑦ 문구.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { dashSource, makeDomContext } from "./_mini-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Extra = { parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
type Sent = { text: string; extra: Extra };
type Render = (
  send: (text: string, extra: Extra) => Promise<unknown>,
  q: string,
  o: { label: string; value: string }[],
  opts?: { note?: string; replyToSession?: string; labelSession?: string; chatId?: string; originThreadKey?: string },
) => Promise<{ ok: boolean; error?: string; channelRefs?: { messageIds: number[] }[] }>;

const O = [{ label: "만들기", value: "yes" }, { label: "취소", value: "no" }];

/** 가짜 send — `fail(i, extra)` 가 참이면 그 호출을 던진다(일반 Error = 재시도 대상 아님 → 평문 폴백 1회 뒤 실패). */
const fakeSend = (fail: (i: number, extra: Extra) => boolean = () => false) => {
  const sent: Sent[] = [];
  let calls = 0;
  let mid = 100;
  const send = async (text: string, extra: Extra): Promise<unknown> => {
    const i = calls++;
    if (fail(i, extra)) throw new Error(`회귀: 전송 실패 #${i}`);
    sent.push({ text, extra });
    return { message_id: ++mid, chat: { id: 4242 } };
  };
  return { send, sent };
};

const buildCard = (payload: Record<string, unknown>) => {
  const { ctx, document } = makeDomContext({ i18n: (k: string) => k });
  vm.createContext(ctx);
  vm.runInContext(
    `let firstEvent = false; let localChatCount = 0; const refreshChatEmpty = () => {}; const currentView = "chat";
     const showOverview = () => {}; const submitOptionValue = () => {}; const vtAppend = () => {}; const assistantName = "비서";
     const isTouchPrimary = () => false; const mdCalls = []; let registered = null;
     const registerChatKindBuilder = (k, fn) => { registered = { k, fn }; };
     const setChatBody = (el, text, asMarkdown) => { mdCalls.push({ cls: el.className, text, asMarkdown }); el.textContent = "MD:" + text; };`,
    ctx,
  );
  vm.runInContext(dashSource("prompt-options.js"), ctx, { filename: "prompt-options.js" });
  ctx.__payload = payload;
  const live = vm.runInContext(`buildPromptOptions(__payload, "10:00", 1)`, ctx);
  const restored = vm.runInContext(`registered && registered.k === "prompt.options" ? registered.fn(__payload, "10:00", 1) : null`, ctx);
  document.body.appendChild(live);
  const calls = vm.runInContext("mdCalls", ctx) as { cls: string; text: string; asMarkdown: boolean }[];
  return { live, restored, calls };
};

export const check: RegressionCheck = {
  name: "prompt-card-note-format",
  guards: "선택지 설명(note)이 평문뿐이라 초안·목록·명령을 카드에서 읽기 어렵고, 텔레그램은 4096자 넘는 설명이 통째 실패하며, 도구 설명의 note 위치가 실제와 달랐던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { findSessionForOutboundMessage } = await import("../../store/outbound-messages.js");
    const tg = await loadPluginModule<{ renderOptions: Render }>("../../../plugins/telegram-channel/index.ts");

    // ① 짧은 카드
    const note = "**만들 커맨드**\n- 이름: `deploy`\n- 실행: `npm run deploy:dev`\n\n```sh\nnpm run deploy:dev\n```\n[근거](https://example.com/a?b=1&c=2)";
    const a = fakeSend();
    const ra = await tg.renderOptions(a.send, "이대로 <만들까요> & 진행?", O, { note, labelSession: "dashboard:default" });
    const t0 = a.sent[0]?.text ?? "";
    out.push(assert(
      "★① 짧은 카드 — 한 통 · HTML 모드 · 설명 서식(굵게·목록·인라인/블록 코드·링크) · 질문은 이스케이프된 평문 · 버튼 그대로",
      ra.ok && a.sent.length === 1 && a.sent[0]!.extra.parse_mode === "HTML" &&
        /^\[[^\]]+\] 이대로 &lt;만들까요&gt; &amp; 진행\?\n\n/.test(t0) && !t0.includes("<만들까요>") &&
        t0.includes("<b>만들 커맨드</b>") && t0.includes("<code>deploy</code>") && /<pre><code[^>]*>npm run deploy:dev/.test(t0) &&
        t0.includes('<a href="https://example.com/a?b=1&amp;c=2">근거</a>') && !t0.includes("**") &&
        JSON.stringify(a.sent[0]!.extra.reply_markup?.inline_keyboard.map((r) => r[0]!.text)) === JSON.stringify(["만들기", "취소"]),
      { ok: ra.ok, text: t0, extra: a.sent[0]?.extra },
    ));

    // ② note 없는 카드
    const b = fakeSend();
    const rb = await tg.renderOptions(b.send, "A **그대로**?", O);
    out.push(assert(
      "② note 없는 카드 — 질문만 한 통(서식 변환 없음 · ** 그대로) · 버튼",
      rb.ok && b.sent.length === 1 && b.sent[0]!.text === "A **그대로**?" && b.sent[0]!.extra.reply_markup !== undefined,
      b.sent,
    ));

    // ③ 긴 설명
    const longNote = Array.from({ length: 400 }, (_, i) => `- 항목${i} **굵게** \`코드\``).join("\n");
    const c = fakeSend();
    const rc = await tg.renderOptions(c.send, "긴 설명 승인?", O, { note: longNote, chatId: "4242", originThreadKey: "dashboard:regr-note" });
    const withButtons = c.sent.filter((s) => s.extra.reply_markup !== undefined);
    const last = c.sent[c.sent.length - 1];
    const noteText = c.sent.slice(0, -1).map((s) => s.text).join("");
    const count = (s: string, sub: string): number => s.split(sub).length - 1;
    // 나뉜 설명도 서식이 그대로(굵게·코드 각 400) — 원시 마크다운 0.
    const allItems = Array.from({ length: 400 }, (_, i) => `항목${i} `).every((s) => noteText.includes(s)) &&
      count(noteText, "<b>굵게</b>") === 400 && count(noteText, "<code>코드</code>") === 400 && !noteText.includes("**");
    const ids = rc.channelRefs?.[0]?.messageIds ?? [];
    const routed = ids.length > 0 && ids.every((id) => findSessionForOutboundMessage("telegram", "4242", id) === "dashboard:regr-note");
    out.push(assert(
      "★③ 긴 설명 — 여러 통 · 각 ≤4096 · 버튼은 마지막 한 통에만 · 마지막 = 질문 · 설명 손실 0 · 모든 통 답글 라우팅 기록 · channelRefs 전부",
      rc.ok && c.sent.length >= 3 && c.sent.every((s) => s.text.length <= 4096 && s.extra.parse_mode === "HTML") &&
        withButtons.length === 1 && withButtons[0] === last && last!.text === "긴 설명 승인?" && allItems &&
        ids.length === c.sent.length && routed,
      { ok: rc.ok, sends: c.sent.map((s) => ({ len: s.text.length, buttons: s.extra.reply_markup !== undefined, head: s.text.slice(0, 20) })), ids, routed, allItems },
    ));

    // ④ 실패 계약
    const d = fakeSend((i) => i === 1 || i === 2); // 두 번째 조각: HTML·평문 둘 다 실패
    const rd = await tg.renderOptions(d.send, "긴 설명 승인?", O, { note: longNote, chatId: "4343", originThreadKey: "dashboard:regr-partial" });
    const e = fakeSend((_i, x) => x.reply_markup !== undefined); // 버튼 통만 실패(HTML·평문)
    const re = await tg.renderOptions(e.send, "긴 설명 승인?", O, { note: longNote });
    const f = fakeSend();
    const rf = await tg.renderOptions(f.send, "   ", O);
    out.push(assert(
      "★④ 설명 조각 하나라도 실패하면 ok:false · 버튼 미전송 / 버튼 통 실패도 ok:false / 빈 글은 보내지 않고 ok:false",
      !rd.ok && d.sent.every((s) => s.extra.reply_markup === undefined) && d.sent.length === 1 &&
        !re.ok && e.sent.every((s) => s.extra.reply_markup === undefined) && e.sent.length >= 2 &&
        !rf.ok && f.sent.length === 0,
      { d: { ok: rd.ok, error: rd.error, sent: d.sent.length }, e: { ok: re.ok, error: re.error, sent: e.sent.length }, f: { ok: rf.ok, sent: f.sent.length } },
    ));
    // 실패해도 이미 도착한 설명 조각의 답글은 물어본 세션으로(카드 성공 판정과 메시지 수명은 별개). 가짜 send 의 첫 id = 101.
    out.push(assert(
      "★④' 카드가 중간에 실패해도 이미 간 설명 조각은 답글 라우팅에 남는다(물어본 세션)",
      !rd.ok && d.sent.length === 1 && findSessionForOutboundMessage("telegram", "4343", 101) === "dashboard:regr-partial",
      { routed: findSessionForOutboundMessage("telegram", "4343", 101) },
    ));
    // 줄바꿈 없는 긴 한 줄은 분할기가 못 나눈다 — 아무것도 안 보내고 실패(상한·줄여 달라는 안내).
    const h = fakeSend();
    const rh = await tg.renderOptions(h.send, "한 줄 초안 승인?", O, { note: `\`${"x".repeat(5000)}\`` });
    const h2 = fakeSend();
    const rh2 = await tg.renderOptions(h2.send, "목록 뒤 긴 줄?", O, { note: `${longNote}\n\n${"y".repeat(5000)}` });
    out.push(assert(
      "★④'' 한 통 상한(4096)을 넘는 나눌 수 없는 줄 — 첫 조각조차 보내지 않고 ok:false(상한 안내) · 앞에 나눌 수 있는 설명이 있어도 마찬가지",
      !rh.ok && h.sent.length === 0 && /4096/.test(rh.error ?? "") && !rh2.ok && h2.sent.length === 0,
      { h: { ok: rh.ok, error: rh.error, sent: h.sent.length }, h2: { ok: rh2.ok, sent: h2.sent.length } },
    ));
    // 상한은 **보이는 글자** 기준 — 긴 링크 URL 은 글자에 안 든다(평문 폴백처럼 URL 을 펼쳐 세면 «핵심 + 자료 링크» 를 막는다).
    const k = fakeSend();
    const rk = await tg.renderOptions(k.send, "링크 달린 긴 설명?", O, { note: `${"가".repeat(3500)} [자료](https://example.com/${"p".repeat(620)})` });
    out.push(assert(
      "★④''' 보이는 글자는 상한 안·URL 은 긴 한 줄 설명 — 거절하지 않고 HTML 로 보낸다(링크 유지 · 버튼은 마지막)",
      rk.ok && k.sent.length === 2 && k.sent[0]!.extra.parse_mode === "HTML" && k.sent[0]!.text.includes('<a href="https://example.com/') &&
        k.sent[1]!.extra.reply_markup !== undefined,
      { ok: rk.ok, error: rk.error, sends: k.sent.map((s) => ({ len: s.text.length, buttons: s.extra.reply_markup !== undefined })) },
    ));

    // ⑤ 버튼 통의 HTML 파싱 실패 → 평문 폴백이 버튼을 유지
    const g = fakeSend((_i, x) => x.parse_mode === "HTML");
    const rg = await tg.renderOptions(g.send, "고를까요?", O, { note: "**굵게** 설명" });
    out.push(assert(
      "★⑤ HTML 거절 시 평문 폴백 — 태그 없는 글 + 버튼 유지 · ok",
      rg.ok && g.sent.length === 1 && g.sent[0]!.extra.parse_mode === undefined && g.sent[0]!.extra.reply_markup !== undefined &&
        g.sent[0]!.text === "고를까요?\n\n굵게 설명",
      g.sent,
    ));

    // ⑥ 대시보드 카드
    // 여러 줄·긴(텔레그램 상한보다 긴) 설명도 통째로 — 대시보드엔 길이 상한이 없다.
    const dashNote = `**설명** \`x\`\n- 하나\n- 둘\n\n\`\`\`sh\nnpm run deploy:dev\n\`\`\`\n${"본문 ".repeat(1700)}ENDMARK`;
    const withNote = buildCard({ question: "A **평문**?", options: O, note: dashNote });
    const qEl = withNote.live.querySelector(".chat-message");
    const nEl = withNote.live.querySelector(".prompt-note");
    const restoredNote = withNote.restored?.querySelector(".prompt-note");
    const noNote = buildCard({ question: "간단?", options: O });
    out.push(assert(
      "★⑥ 대시보드 — 여러 줄·긴 note 도 통째로 공용 안전 렌더(setChatBody·마크다운) · 질문은 평문 그대로 · 이력 복원도 같은 빌더 · note 없으면 설명 칸·렌더 호출 없음 · 버튼 2",
      dashNote.length > 5000 && qEl?.textContent === "A **평문**?" && nEl?.textContent === "MD:" + dashNote &&
        withNote.calls.length === 2 && withNote.calls.every((x) => x.asMarkdown === true && x.text === dashNote && x.cls === "prompt-note") &&
        restoredNote?.textContent === "MD:" + dashNote &&
        noNote.live.querySelector(".prompt-note") === null && noNote.calls.length === 0 &&
        withNote.live.querySelectorAll(".prompt-option-btn").length === 2,
      { q: qEl?.textContent, noteLen: nEl?.textContent?.length, calls: withNote.calls.map((x) => ({ ...x, text: x.text.length })), restoredLen: restoredNote?.textContent?.length, noNote: noNote.calls },
    ));

    // ⑦ 도구 설명 문구 — 부분 문자열이 아니라 **문장 그대로**(뒤에 부정이 붙어 뜻이 뒤집히면 잡히게)
    const src = readFileSync(path.join(HERE, "../../core/llm-runtime/capabilities/prompt-options-mcp.ts"), "utf8");
    const need = [
      "question 과 note 에 담아 카드만으로 판단할 수 있게 하세요.",
      "질문과 보기만으로 충분하면 note 는 생략하세요.",
      "제시가 성공했고 사용자 답이 필요하면 같은 내용을 되풀이하는 마무리 글 없이 턴을 마치세요.",
      "제시 실패 결과는 전달된 것으로 취급하지 마세요.",
      "질문과 보기 버튼 사이에 표시되고, 기본 마크다운",
    ];
    out.push(assert(
      "⑦ 도구 설명 — 카드 완결·note 생략·중복 마무리 없음·실패≠전달·note 실제 위치 안내 있음 · «보기 아래» 없음 (문구 연결 — 모델 행동 보장 아님)",
      need.every((s) => src.includes(s)) && !src.includes("보기 아래"),
      need.filter((s) => !src.includes(s)),
    ));
    return out;
  },
};
