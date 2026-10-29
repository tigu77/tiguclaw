/**
 * 선택지 카드 검사 공용 — **진짜 대시보드 JS**(`bootDashboard` upTo tabs.js: reply·axis1-options·prompt-options·sse 포함)에
 * 가짜 fetch 만 끼운다. `/api/messages`·`/api/cancel-queued` 응답은 검사가 하나씩 정한다(보류 가능).
 */
import { i18nForContext } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

type Resp = { body: unknown; status?: number };
export interface Sent { url: string; body: Record<string, unknown> }

export const promptCardDash = (activeTab: string) => {
  const clock = makeClock();
  const sent: Sent[] = [];
  /** 다음 응답들 — 앞에서부터 쓴다. 함수면 보류(프라미스)도 된다. */
  const queue = new Map<string, Array<Resp | (() => Promise<Resp>)>>();
  const reply = (url: string, r: Resp | (() => Promise<Resp>)): void => {
    const q = queue.get(url) ?? [];
    q.push(r);
    queue.set(url, q);
  };
  const dash = bootDashboard({
    clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true,
    fetch: async (url: string, init?: { body?: string }) => {
      const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      sent.push({ url, body });
      const next = queue.get(url)?.shift();
      if (next === undefined) return jsonResponse({}, 404);
      const r = typeof next === "function" ? await next() : next;
      return jsonResponse(r.body, r.status ?? 200);
    },
  });
  dash.run(`activeThreadKey = ${JSON.stringify(activeTab)}`);
  /** 보류 응답 — `release(body,status)` 로 푼다. */
  const deferred = (): { fn: () => Promise<Resp>; release: (body: unknown, status?: number) => void } => {
    let release: (body: unknown, status?: number) => void = () => {};
    const p = new Promise<Resp>((r) => { release = (body, status) => r({ body, status }); });
    return { fn: () => p, release };
  };
  let seq = 0;
  /** 카드 하나 — 진짜 빌더. 반환 = 상태를 읽는 손잡이. */
  const card = (payload: Record<string, unknown>) => {
    seq += 1;
    const rawTs = 1_930_000_000_000 + seq;
    const q = String(payload.question ?? "");
    const div = dash.run(`buildPromptOptions(${JSON.stringify(payload)}, "10:00", ${rawTs})`);
    dash.document.body.appendChild(div);
    const btns = () => [...div.querySelectorAll(".prompt-option-btn")] as Array<{ disabled: boolean; classList: { contains: (c: string) => boolean }; click: () => void; dataset: Record<string, string> }>;
    const other = () => div.querySelector(".prompt-other-input") as { disabled: boolean; value: string };
    const note = () => (div.querySelector(".prompt-closed-note") as { textContent: string } | null)?.textContent ?? null;
    const poKey = `po:${rawTs}|${q}`;
    const ls = (k: string): string | null => dash.run(`localStorage.getItem(${JSON.stringify(k)})`) as string | null;
    return {
      div, rawTs, poKey,
      click: (i: number) => btns()[i]!.click(),
      state: () => ({
        picked: btns().filter((b) => b.classList.contains("picked")).map((b) => b.dataset.optvalue),
        allDisabled: btns().every((b) => b.disabled) && other().disabled,
        anyEnabled: btns().some((b) => !b.disabled),
        saved: ls(poKey),
        closedSaved: ls(`${poKey}|closed`),
        note: note(),
      }),
    };
  };
  const reopeners = (): number => dash.run(`promptCardReopeners.size`) as number;
  const hasReopener = (cid: string): boolean => dash.run(`promptCardReopeners.has(${JSON.stringify(cid)})`) as boolean;
  const lastPost = (): Sent | undefined => [...sent].reverse().find((s) => s.url === "/api/messages");
  const pending = (): Array<{ cid: string; queueKey?: string; queued: boolean; cancelable: boolean }> =>
    dash.run(`pendingQueued.map((p) => ({ cid: p.cid, queueKey: p.queueKey, queued: p.el.classList.contains("queued"), cancelable: !!p.el.querySelector(".queued-cancel") }))`) as never;
  /** 그 상관 id 의 대기 버블 ✕ 를 누른다 — 버블·✕ 가 없으면 누르지 않고 false(검사가 던지지 않고 단언으로 떨어지게). */
  const clickCancel = (cid: string): boolean =>
    dash.run(`(() => { const p = pendingQueued.find((q) => q.cid === ${JSON.stringify(cid)}); const x = p && p.el.querySelector(".queued-cancel"); if (!x) return false; x.click(); return true; })()`) as boolean;
  return { dash, clock, sent, reply, deferred, card, reopeners, hasReopener, lastPost, pending, clickCancel, flush: () => clock.flush() };
};
