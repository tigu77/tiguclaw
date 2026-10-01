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
  input: { value: string };
};

const boot = (src: string, store: Record<string, string>): Ghost => {
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
    isActiveThread: (tk: string) => tk === TK,
  };
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
