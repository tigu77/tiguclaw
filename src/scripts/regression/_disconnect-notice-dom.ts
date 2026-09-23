import vm from "node:vm";

// Minimal DOM boundary, not a replacement for the product's notice/virtualization logic.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  scrollTop = 0;
  clientHeight = 800;
  scrollHeight = 800;
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  get firstChild() { return this.children[0] || null; }
  appendChild(node: Element) { return this.insertBefore(node, null); }
  insertBefore(node: Element, before: Element | null) {
    node.parentNode?.removeChild(node);
    const index = before ? this.children.indexOf(before) : this.children.length;
    if (index < 0) throw new Error("unknown DOM sibling");
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: Element) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error("unknown DOM child");
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (selector === "[data-ts]" ? !!child.dataset.ts : child.classList.contains(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function section(source: string, start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`missing product boundary: ${start} / ${end}`);
  return source.slice(a, b);
}

export async function disconnectNoticeDom(reply: string, sse: string, virtualization: string, arrived: false | null) {
  const stream = new Element();
  const frames: (() => void)[] = [];
  const working: boolean[] = [];
  let now = 1_800_000_000_000;
  const context = vm.createContext({
    stream, console, Date: { now: () => now },
    document: { createElement: () => new Element(), getElementById: () => null },
    window: { matchMedia: () => ({ matches: false }) },
    ResizeObserver: class { observe() {} unobserve() {} },
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    updateChatJump() {}, dateKey: () => "2026-09-23", fmtDate: () => "2026-09-23", fmtTime: () => "12:00",
    holdSseEventDuringHistory: () => false, renderedNoticeKeys: new Set(),
    firstEvent: false, localChatCount: 0, refreshChatEmpty() {}, currentView: "chat", assistantName: "assistant",
    i18n: (key: string) => key, setChatBody: (node: Element, text: string) => { node.textContent = text; },
    activeThreadKey: "room-A", recordTypedTags() {}, self: { crypto: { randomUUID: () => "cid" } }, activeTurns: new Set(),
    setChatWorking: (value: boolean) => working.push(value),
    fetch: async () => { now += 15_000; throw new Error("network disconnected"); },
    messageReachedServer: async () => arrived,
    arrivalOutcome: (value: boolean | null) => ({ normal: value === true }),
  });
  // Execute the actual product stale gate, append, divider and DOM mount paths.
  // Exclude unrelated history/scroll listeners; vtCap runs unchanged below the cap.
  vm.runInContext(
    section(virtualization, "      const VT_", "      const vtPrependOlder") +
    section(virtualization, "      const vtCap =", "\n      };" ) + "\n      };\n" +
    section(sse, "      const renderLocalChat =", "\n      };" ) + "\n      };\n" +
    section(reply, "      const sendChatMessage =", "      const submitOptionValue") +
    '\n globalThis.send = sendChatMessage; renderLocalChat("reply", "existing history", { ts: Date.now() - 1000 });', context,
  );
  const flush = () => {
    let count = 0;
    while (frames.length) {
      if (++count > 100) throw new Error("animation frame loop");
      frames.shift()!();
    }
  };
  flush();
  const result = await (context.send as (text: string) => Promise<{ ok: boolean; restore?: boolean }>)("hello");
  flush();
  const windowNode = stream.querySelector(".vt-window");
  const notices = (windowNode?.children || []).filter(node =>
    node.classList.contains("local") && node.querySelector(".chat-message")?.textContent === "chat.send.deliveryUnknown");
  return { result, working, mounted: notices.length, timestamps: notices.map(node => Number(node.dataset.ts)), now,
    historyMounted: !!windowNode?.children.some(node => node.querySelector(".chat-message")?.textContent === "existing history") };
}
