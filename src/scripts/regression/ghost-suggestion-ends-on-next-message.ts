/**
 * 회귀: **새 메시지가 들어오면 그 앞의 제안은 끝난다 — 어느 길로 왔든, 재접속해도** (2026-10-01).
 *
 * 정태님: *"메시지를 보냈는데도 이전 제안 메시지가 계속 남아있는 상황이 있을 수 있나?"* — 있었다(둘 다 재현):
 *  ① 지우는 곳이 대시보드 입력창의 전송 한 곳뿐이라, 선택지 클릭·텔레그램·다른 탭/기기로 보내면 옛 제안이 남았다.
 *  ② 지울 때 저장 항목을 통째로 지워 replay 가드의 기준까지 사라졌다 — 재접속(폰 복귀) 때 서버가 다시 흘리는
 *     옛 제안이 되살아났다.
 *
 * 등급: ①②는 **실행**으로 본다(고스트 모듈을 가짜 DOM 위에서 그대로 돌린다). sse.js 배선은 **자리 판정**(소스 위치) —
 *  합성·대기 버블 분기의 이른 return 보다 앞에서 부르는가만 본다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard");
const TK = "dashboard:default";

type Ghost = {
  ctx: Record<string, unknown> & {
    applyChatSuggestion: (p: unknown, ts: number) => void;
    clearChatSuggestion: () => void;
    refreshChatSuggestion: () => void;
    endChatSuggestion: (tk: string, ts: number) => void;
  };
  shown: () => string | null;
  input: { value: string; dispatchEvent: (e: { type: string; [k: string]: unknown }) => boolean };
};

const boot = (src: string, store: Record<string, string>, opts: { noActiveCheck?: boolean } = {}): Ghost => {
  const mk = () => {
    const l: Record<string, Array<(e: unknown) => void>> = {};
    return {
      hidden: true, textContent: "", value: "", dataset: {}, parentElement: { dataset: {} },
      addEventListener: (t: string, f: (e: unknown) => void) => { (l[t] ??= []).push(f); },
      dispatchEvent: (e: { type: string }) => { (l[e.type] ?? []).forEach((f) => f(e)); return true; },
      setSelectionRange() {}, focus() {},
    };
  };
  const els: Record<string, ReturnType<typeof mk>> = { "chat-input": mk(), "chat-ghost": mk(), "chat-ghost-accept": mk() };
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => els[id] },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    activeThreadKey: TK,
  };
  // constants.js 의 판정과 같은 꼴(키 없음 = 활성) — 활성 세션은 ctx.activeThreadKey 를 바꿔 옮긴다.
  if (!opts.noActiveCheck) ctx.isActiveThread = (tk: string) => !tk || tk === ctx.activeThreadKey;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const ghost = els["chat-ghost"]!;
  return { ctx: ctx as Ghost["ctx"], shown: () => (ghost.hidden ? null : ghost.textContent), input: els["chat-input"]! };
};

export const check: RegressionCheck = {
  name: "ghost-suggestion-ends-on-next-message",
  guards: "메시지를 보냈는데 이전 제안이 남던 것 — 입력창 밖(선택지·텔레그램·다른 탭)으로 보내거나, 보낸 뒤 재접속 replay 로 옛 제안이 되살아나던 것",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(path.join(DASH, "js/ghost-suggest.js"), "utf8");
    const sse = await readFile(path.join(DASH, "js/sse.js"), "utf8");
    const T0 = 1_700_000_000_000;
    const out: Assertion[] = [];

    // ② 보낸 뒤 재접속 replay
    {
      const store: Record<string, string> = {};
      const g = boot(src, store);
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "옛 제안" }, T0);
      const before = g.shown();
      g.ctx.clearChatSuggestion();
      const g2 = boot(src, store);
      g2.ctx.refreshChatSuggestion();
      g2.ctx.applyChatSuggestion({ threadKey: TK, text: "옛 제안" }, T0);
      out.push(assert("★보낸 뒤 재접속 replay 가 옛 제안을 되살리지 않는다", before === "옛 제안" && g2.shown() === null, { before, after: g2.shown() }));
    }

    // 입력창에 초안이 있어 제안이 메모리에 안 올라온 채(새로고침 직후) 보낸다 — 보낸 뒤 비면 옛 제안이 다시 뜨면 안 된다
    {
      const store: Record<string, string> = {};
      boot(src, store).ctx.applyChatSuggestion({ threadKey: TK, text: "옛 제안" }, T0);
      const g = boot(src, store);
      g.input.value = "초안";
      g.ctx.refreshChatSuggestion();
      g.ctx.clearChatSuggestion();
      g.input.value = "";
      g.ctx.refreshChatSuggestion();
      out.push(assert("초안이 있던 채 보내도(제안이 아직 메모리에 없음) 보낸 뒤 옛 제안이 다시 뜨지 않는다", g.shown() === null, g.shown()));
    }

    // ① 다른 길로 보낸 메시지(서버 인바운드)가 끝낸다 + 다음 턴 제안은 뜬다 + 제안보다 앞선 인바운드 replay 는 안 끝낸다
    {
      const store: Record<string, string> = {};
      const g = boot(src, store);
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "옛 제안" }, T0);
      g.ctx.endChatSuggestion(TK, T0 + 5_000);
      const afterIn = g.shown();
      const reloaded = boot(src, store);
      reloaded.ctx.refreshChatSuggestion();
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "새 제안" }, T0 + 9_000);
      const next = g.shown();
      g.ctx.endChatSuggestion(TK, T0 + 1_000);
      const afterOldIn = g.shown();
      g.ctx.endChatSuggestion("dashboard:other", T0 + 20_000);
      const afterOtherThread = g.shown();
      out.push(assert("★다른 길로 들어온 메시지(인바운드)가 그 세션의 제안을 끝낸다 · 새로고침해도 안 돌아온다", afterIn === null && reloaded.shown() === null, { afterIn, reloaded: reloaded.shown() }));
      out.push(assert("다음 턴의 새 제안은 뜬다(끝낸 표시가 새 제안을 막지 않는다)", next === "새 제안", next));
      out.push(assert("제안보다 앞선 인바운드(replay)·다른 세션의 인바운드는 제안을 끝내지 않는다", afterOldIn === "새 제안" && afterOtherThread === "새 제안", { afterOldIn, afterOtherThread }));
    }

    // ③ 다른 세션의 제안 수신 (2026-10-31) — SSE 는 모든 세션 이벤트를 받는다. B 의 제안이 A 의 표시·수락·종료 대상을 덮으면 안 된다.
    {
      const TB = "dashboard:other";
      const store: Record<string, string> = {};
      const g = boot(src, store);
      const saved = (tk: string) => (JSON.parse(store["dash.suggestion.v1"] ?? "{}") as Record<string, { text: string }>)[tk]?.text;
      const key = (k: string) => g.input.dispatchEvent({ type: "keydown", key: k, preventDefault() {}, stopPropagation() {} });
      const typeIn = (v: string) => { g.input.value = v; g.input.dispatchEvent({ type: "input" }); };
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "A 제안" }, T0);
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B1" }, T0 + 1_000);
      const afterB1 = g.shown();
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B2" }, T0 + 2_000);
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B1" }, T0 + 1_000); // replay(옛것)
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B2" }, T0 + 2_000); // replay(같은 것)
      const afterBs = g.shown();
      key("Tab");
      const accepted = g.input.value;
      typeIn("");
      out.push(assert(
        "★다른 세션 제안이 신규·반복·replay 로 와도 지금 세션 제안의 표시와 수락 대상은 그대로 · 그 세션 것은 최신으로 저장된다",
        afterB1 === "A 제안" && afterBs === "A 제안" && accepted === "A 제안" && saved(TB) === "B2",
        { afterB1, afterBs, accepted, savedB: saved(TB) },
      ));
      g.ctx.activeThreadKey = TB; g.ctx.refreshChatSuggestion();
      const onB = g.shown();
      g.ctx.activeThreadKey = TK; g.ctx.refreshChatSuggestion();
      const backA = g.shown();
      typeIn("초안");
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B3" }, T0 + 3_000);
      const draft = g.input.value;
      const whileDraft = g.shown();
      typeIn("");
      const afterDraft = g.shown();
      out.push(assert(
        "세션을 옮기면 그 세션의 최신 제안, 돌아오면 원래 제안 · 초안 중 다른 세션 제안이 와도 초안 유지, 비우면 지금 세션 제안",
        onB === "B2" && backA === "A 제안" && draft === "초안" && whileDraft === null && afterDraft === "A 제안",
        { onB, backA, draft, whileDraft, afterDraft },
      ));
      // A 에서 Esc → A 만 끝난다. 새 A 제안 → 뜬다. A 에서 전송·인바운드 → A 만 끝난다(B 는 살아 있다).
      key("Escape");
      const escA = saved(TK), escB = saved(TB);
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "A2" }, T0 + 4_000);
      const newA = g.shown();
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B4" }, T0 + 4_500);
      g.ctx.clearChatSuggestion();
      const sentA = saved(TK), sentB = saved(TB), shownAfterSend = g.shown();
      g.ctx.applyChatSuggestion({ threadKey: TK, text: "A3" }, T0 + 5_000);
      g.ctx.applyChatSuggestion({ threadKey: TB, text: "B5" }, T0 + 5_500);
      g.ctx.endChatSuggestion(TK, T0 + 6_000);
      const inA = g.shown(), inB = saved(TB);
      g.ctx.activeThreadKey = TB; g.ctx.refreshChatSuggestion();
      const finalB = g.shown();
      out.push(assert(
        "★지금 세션에서 Esc·전송·인바운드로 끝내도 다른 세션 제안은 안 끝난다 · 지금 세션의 새 제안은 뜬다",
        escA === "" && escB === "B3" && newA === "A2" && sentA === "" && sentB === "B4" && shownAfterSend === null &&
          inA === null && inB === "B5" && finalB === "B5",
        { escA, escB, newA, sentA, sentB, shownAfterSend, inA, inB, finalB },
      ));
    }

    // ④ 메모리가 빈 채(새로고침 직후 초안 복원) 대시보드 밖 세션(tg:) 제안이 온다 — 그래도 지금 세션 것만 뜨고 끝난다
    {
      const TG = "tg:12345";
      const store: Record<string, string> = {};
      boot(src, store).ctx.applyChatSuggestion({ threadKey: TK, text: "A 제안" }, T0);
      const g = boot(src, store);
      const saved = (tk: string) => (JSON.parse(store["dash.suggestion.v1"] ?? "{}") as Record<string, { text: string }>)[tk]?.text;
      g.input.value = "초안";
      g.ctx.refreshChatSuggestion();
      g.ctx.applyChatSuggestion({ threadKey: TG, text: "TG 제안" }, T0 + 1_000);
      g.input.value = ""; g.input.dispatchEvent({ type: "input" });
      const restored = g.shown();
      g.input.dispatchEvent({ type: "keydown", key: "Tab", preventDefault() {}, stopPropagation() {} });
      const accepted = g.input.value;
      g.input.value = "";
      g.ctx.clearChatSuggestion();
      out.push(assert(
        "★메모리가 빈 채 다른 채널 세션(tg:) 제안이 와도 비우면 지금 세션 제안·Tab 은 지금 세션 것 · 보내면 지금 세션만 끝난다",
        restored === "A 제안" && accepted === "A 제안" && saved(TK) === "" && saved(TG) === "TG 제안",
        { restored, accepted, savedA: saved(TK), savedTG: saved(TG) },
      ));
    }

    // 호환 — 키 없는 제안은 지금 세션 것으로 뜬다(저장은 안 함) · 세션 판정 함수가 없으면 거르지 않는다(구버전)
    {
      const g = boot(src, {});
      g.ctx.applyChatSuggestion({ text: "키 없음" }, T0);
      const noKey = g.shown();
      const legacy = boot(src, {}, { noActiveCheck: true });
      legacy.ctx.applyChatSuggestion({ threadKey: "dashboard:other", text: "판정 없음" }, T0);
      out.push(assert("호환: 키 없는 제안은 뜨고 · 세션 판정 함수가 없으면 거르지 않는다", noKey === "키 없음" && legacy.shown() === "판정 없음", { noKey, legacy: legacy.shown() }));
    }

    // 배선 — 인바운드마다, 합성·대기 버블 분기의 이른 return 보다 앞에서
    const call = sse.indexOf("window.endChatSuggestion(tk, ev.ts)");
    const synthetic = sse.indexOf("ev.payload && ev.payload.synthetic");
    const inBranch = sse.indexOf('if (ev.type === "channel.message.in") {');
    out.push(assert(
      "sse.js 가 channel.message.in 마다 제안 끝내기를 부른다 — 합성·대기 버블 분기보다 먼저",
      call > 0 && synthetic > call && inBranch > call && /if \(ev\.type === "channel\.message\.in" && typeof window\.endChatSuggestion === "function"\)/.test(sse),
      { call, synthetic, inBranch },
    ));
    return out;
  },
};
