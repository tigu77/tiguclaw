/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 대시보드 화면 파일을 **vm 에서 그대로 돌리기 위한** 작은 DOM 대역 (2026-10-09).
 *
 * ★왜 있나: 화면 결함(홈 전체 재마운트·메뉴 바깥 스크롤·await 뒤 다른 화면 덮기·확인 없는 중지)은
 *  전부 **동작**이라 소스 대조로는 «있다» 만 보이고 «도는가» 가 안 보인다. 레포엔 DOM 라이브러리가
 *  없어서(jsdom·happy-dom 미설치) 검사마다 손으로 가짜 노드를 지어 왔고, 그게 검사마다 다른 모양이었다.
 *  여기 한 벌을 둔다 — 제품 파일은 **베끼지 않고** 이 위에서 실제로 평가한다.
 *
 * 범위(일부러 좁다): 트리 조작·`innerHTML`(잘 닫힌 조각만)·셀렉터(태그·#id·.class·[attr]·[attr="v"]·
 * [attr*="v"]·:not(…)·자손/자식 결합자·쉼표)·이벤트(캡처/버블)·`dataset`↔`data-*`·MutationObserver
 * (속성·자식 — 마이크로태스크로 배달, 브라우저와 같은 순서). 레이아웃은 없다 — `rect` 를 손으로 준다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type Listener = { fn: (ev: any) => void; capture: boolean };

class EventTargetish {
  _ls = new Map<string, Listener[]>();
  addEventListener(type: string, fn: (ev: any) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    const arr = this._ls.get(type) ?? [];
    arr.push({ fn, capture });
    this._ls.set(type, arr);
  }
  removeEventListener(type: string, fn: (ev: any) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    const arr = this._ls.get(type) ?? [];
    this._ls.set(type, arr.filter((l) => !(l.fn === fn && l.capture === capture)));
  }
  _fire(ev: any, phase: "capture" | "target" | "bubble"): void {
    for (const l of [...(this._ls.get(ev.type) ?? [])]) {
      if (ev._stopped) return;
      if (phase === "capture" && !l.capture) continue;
      if (phase === "bubble" && l.capture) continue;
      ev.currentTarget = this;
      l.fn(ev);
    }
  }
}

interface MoReg { target: MNode; opts: any; mo: MiniMutationObserver }

export class MiniDocument extends EventTargetish {
  documentElement: MElement;
  head: MElement;
  body: MElement;
  activeElement: MElement | null = null;
  defaultView: any = null;
  _moRegs: MoReg[] = [];
  nodeType = 9;
  constructor() {
    super();
    this.documentElement = new MElement(this, "html");
    this.head = new MElement(this, "head");
    this.body = new MElement(this, "body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): MElement {
    return new MElement(this, tag);
  }
  createDocumentFragment(): MElement {
    return new MElement(this, "#fragment");
  }
  createTextNode(text: string): MNode {
    const n = new MNode(this, 3);
    n._data = String(text);
    return n;
  }
  getElementById(id: string): MElement | null {
    return this.documentElement.querySelector("#" + id);
  }
  querySelector(sel: string): MElement | null {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string): MElement[] {
    return this.documentElement.querySelectorAll(sel);
  }
  contains(n: MNode): boolean {
    return this.documentElement.contains(n);
  }
  /** 마이크로태스크로 배달 — 브라우저처럼 같은 틱의 기록은 한 번에 간다. */
  _record(target: MNode, rec: any): void {
    for (const reg of this._moRegs) {
      let hit = reg.target === target;
      if (!hit && reg.opts.subtree) {
        for (let p = target.parentNode; p; p = p.parentNode) if (p === reg.target) hit = true;
      }
      if (!hit) continue;
      if (rec.type === "attributes") {
        if (!reg.opts.attributes) continue;
        if (Array.isArray(reg.opts.attributeFilter) && !reg.opts.attributeFilter.includes(rec.attributeName)) continue;
      }
      if (rec.type === "childList" && !reg.opts.childList) continue;
      reg.mo._enqueue({ ...rec, target });
    }
  }
}

export class MNode extends EventTargetish {
  ownerDocument: MiniDocument;
  nodeType: number;
  parentNode: MElement | null = null;
  childNodes: MNode[] = [];
  _data = "";
  constructor(doc: MiniDocument, nodeType: number) {
    super();
    this.ownerDocument = doc;
    this.nodeType = nodeType;
  }
  get parentElement(): MElement | null {
    return this.parentNode;
  }
  get isConnected(): boolean {
    let n: MNode | null = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  get textContent(): string {
    if (this.nodeType === 3) return this._data;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3) {
      this._data = String(v);
      return;
    }
    for (const c of [...this.childNodes]) (this as unknown as MElement).removeChild(c);
    if (v !== "" && v != null) (this as unknown as MElement).appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceWith(n: MNode): void {
    const p = this.parentNode;
    if (!p) return;
    p.insertBefore(n, this);
    p.removeChild(this);
  }
  before(n: MNode): void {
    this.parentNode?.insertBefore(n, this);
  }
  after(n: MNode): void {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p.insertBefore(n, p.childNodes[i + 1] ?? null);
  }
  get nextSibling(): MNode | null {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null;
  }
  get nextElementSibling(): MElement | null {
    const p = this.parentNode;
    if (!p) return null;
    const kids = p.children;
    return kids[kids.indexOf(this as unknown as MElement) + 1] ?? null;
  }
  get previousElementSibling(): MElement | null {
    const p = this.parentNode;
    if (!p) return null;
    const kids = p.children;
    return kids[kids.indexOf(this as unknown as MElement) - 1] ?? null;
  }
}

const camelToData = (k: string): string => "data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const dataToCamel = (a: string): string => a.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

export class MElement extends MNode {
  tagName: string;
  attrs = new Map<string, string>();
  style: any;
  dataset: any;
  classList: any;
  value = "";
  disabled = false;
  hidden = false;
  checked = false;
  type = "";
  title = "";
  tabIndex = 0;
  scrollTop = 0;
  scrollLeft = 0;
  /** 레이아웃이 없다 — 검사가 필요한 자리에 손으로 준다. */
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  [k: string]: any;
  constructor(doc: MiniDocument, tag: string) {
    super(doc, 1);
    this.tagName = tag.toUpperCase();
    const styleStore: Record<string, string> = {};
    this.style = new Proxy(styleStore, {
      get: (t, k) => {
        if (k === "setProperty") return (n: string, v: string) => { t[n] = String(v); };
        if (k === "getPropertyValue") return (n: string) => t[n] ?? "";
        if (k === "removeProperty") return (n: string) => { delete t[n]; };
        return typeof k === "string" ? t[k] ?? "" : undefined;
      },
      set: (t, k, v) => { if (typeof k === "string") t[k] = String(v); return true; },
    });
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === "string" ? this.getAttribute(camelToData(k)) ?? undefined : undefined),
      set: (_t, k, v) => { if (typeof k === "string") this.setAttribute(camelToData(k), String(v)); return true; },
      deleteProperty: (_t, k) => { if (typeof k === "string") this.removeAttribute(camelToData(k)); return true; },
      has: (_t, k) => typeof k === "string" && this.attrs.has(camelToData(k)),
      ownKeys: () => [...this.attrs.keys()].filter((a) => a.startsWith("data-")).map(dataToCamel),
      getOwnPropertyDescriptor: (_t, k) =>
        typeof k === "string" && this.attrs.has(camelToData(k))
          ? { enumerable: true, configurable: true, value: this.getAttribute(camelToData(k)) }
          : undefined,
    });
    const cls = (): string[] => (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const setCls = (a: string[]): void => this.setAttribute("class", a.join(" "));
    this.classList = {
      [Symbol.iterator]: () => cls()[Symbol.iterator](),
      get length() { return cls().length; },
      item: (i: number) => cls()[i] ?? null,
      contains: (c: string) => cls().includes(c),
      add: (...cs: string[]) => { const a = cls(); for (const c of cs) if (!a.includes(c)) a.push(c); setCls(a); },
      remove: (...cs: string[]) => setCls(cls().filter((x) => !cs.includes(x))),
      toggle: (c: string, force?: boolean) => {
        const has = cls().includes(c);
        const want = force === undefined ? !has : force;
        if (want && !has) setCls([...cls(), c]);
        if (!want && has) setCls(cls().filter((x) => x !== c));
        return want;
      },
    };
  }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", String(v)); }
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(v: string) { this.setAttribute("id", String(v)); }
  getAttribute(n: string): string | null { return this.attrs.has(n) ? (this.attrs.get(n) as string) : null; }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  setAttribute(n: string, v: string): void {
    const old = this.getAttribute(n);
    this.attrs.set(n, String(v));
    this.ownerDocument._record(this, { type: "attributes", attributeName: n, oldValue: old });
  }
  removeAttribute(n: string): void {
    if (!this.attrs.has(n)) return;
    const old = this.getAttribute(n);
    this.attrs.delete(n);
    this.ownerDocument._record(this, { type: "attributes", attributeName: n, oldValue: old });
  }
  get children(): MElement[] { return this.childNodes.filter((c) => c.nodeType === 1) as MElement[]; }
  get childElementCount(): number { return this.children.length; }
  get firstChild(): MNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get firstElementChild(): MElement | null { return this.children[0] ?? null; }
  get lastElementChild(): MElement | null { const k = this.children; return k[k.length - 1] ?? null; }
  appendChild<T extends MNode>(n: T): T { return this.insertBefore(n, null); }
  append(...ns: Array<MNode | string>): void {
    for (const n of ns) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
  }
  prepend(n: MNode): void { this.insertBefore(n, this.childNodes[0] ?? null); }
  insertBefore<T extends MNode>(n: T, ref: MNode | null): T {
    // 조각은 자기 자식들을 옮겨 놓고 비워진다(브라우저와 같다).
    if (n instanceof MElement && n.tagName === "#FRAGMENT") {
      for (const c of [...n.childNodes]) this.insertBefore(c, ref);
      return n;
    }
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (i < 0) throw new Error("mini-dom: 모르는 형제 노드");
    this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    this.ownerDocument._record(this, { type: "childList", addedNodes: [n], removedNodes: [] });
    return n;
  }
  removeChild<T extends MNode>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error("mini-dom: 자식이 아님");
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    this.ownerDocument._record(this, { type: "childList", addedNodes: [], removedNodes: [n] });
    return n;
  }
  replaceChildren(...ns: MNode[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of ns) this.appendChild(n);
  }
  contains(n: MNode | null): boolean {
    for (let p: MNode | null = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  set innerHTML(html: string) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    parseInto(this, String(html));
  }
  get innerHTML(): string { return ""; }
  matches(sel: string): boolean { return matchesList(this, sel); }
  closest(sel: string): MElement | null {
    for (let p: MElement | null = this; p; p = p.parentNode) if (p.matches(sel)) return p;
    return null;
  }
  querySelectorAll(sel: string): MElement[] {
    const out: MElement[] = [];
    const walk = (e: MElement): void => {
      for (const c of e.children) {
        if (matchesList(c, sel, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): MElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect(): any { return { ...this.rect, x: this.rect.left, y: this.rect.top }; }
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollIntoView(): void {}
  click(): void { this.dispatchEvent(makeEvent("click", { bubbles: true, detail: 1 })); }
  dispatchEvent(ev: any): boolean { return dispatch(this, ev); }
}

export const makeEvent = (type: string, init: Record<string, unknown> = {}): any => ({
  type,
  bubbles: false,
  _stopped: false,
  defaultPrevented: false,
  stopPropagation(this: any) { this._stopped = true; },
  stopImmediatePropagation(this: any) { this._stopped = true; },
  preventDefault(this: any) { this.defaultPrevented = true; },
  ...init,
});

/** 캡처(창→문서→조상) · 대상 · 버블(bubbles 일 때만) — 브라우저와 같은 경로. */
export const dispatch = (target: MNode | MiniDocument, ev: any): boolean => {
  ev.target = target;
  const path: EventTargetish[] = [];
  if (target instanceof MNode) {
    for (let p: MNode | null = target.parentNode; p; p = p.parentNode) path.unshift(p);
    const doc = target.ownerDocument;
    if (target.isConnected) {
      path.unshift(doc);
      if (doc.defaultView) path.unshift(doc.defaultView);
    }
  } else if (target.defaultView) {
    path.unshift(target.defaultView);
  }
  for (const n of path) { if (ev._stopped) break; n._fire(ev, "capture"); }
  if (!ev._stopped) (target as EventTargetish)._fire(ev, "target");
  if (ev.bubbles) for (const n of [...path].reverse()) { if (ev._stopped) break; n._fire(ev, "bubble"); }
  return !ev.defaultPrevented;
};

export class MiniMutationObserver {
  cb: (recs: any[]) => void;
  doc: MiniDocument;
  q: any[] = [];
  scheduled = false;
  constructor(doc: MiniDocument, cb: (recs: any[]) => void) {
    this.doc = doc;
    this.cb = cb;
  }
  observe(target: MNode, opts: any): void { this.doc._moRegs.push({ target, opts: opts ?? {}, mo: this }); }
  disconnect(): void { this.doc._moRegs = this.doc._moRegs.filter((r) => r.mo !== this); this.q = []; }
  takeRecords(): any[] { const r = this.q; this.q = []; return r; }
  _enqueue(rec: any): void {
    this.q.push(rec);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const r = this.takeRecords();
      if (r.length > 0) this.cb(r);
    });
  }
}

// ── innerHTML — 잘 닫힌 조각만(제품 템플릿이 그렇다) ─────────────────────────
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);
const decode = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const parseInto = (root: MElement, html: string): void => {
  const doc = root.ownerDocument;
  const stack: MElement[] = [root];
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1] as MElement;
    if (m[3] !== undefined) {
      top.appendChild(doc.createTextNode(decode(m[3])));
      continue;
    }
    const tag = (m[1] as string).toLowerCase();
    if (m[0].startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = doc.createElement(tag);
    const ar = /([\w:-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
    let a: RegExpExecArray | null;
    const rest = (m[2] as string).replace(/\/\s*$/, "");
    while ((a = ar.exec(rest))) el.setAttribute(a[1] as string, decode(a[2] ?? a[3] ?? ""));
    top.appendChild(el);
    if (!VOID.has(tag) && !m[0].endsWith("/>")) stack.push(el);
  }
};

// ── 셀렉터 ─────────────────────────────────────────────────────────────
const splitTop = (s: string, sep: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
};
const matchCompound = (el: MElement, c: string, scope: MElement | null): boolean => {
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]|:not\(((?:[^()]|\([^()]*\))*)\)|(:scope)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(c))) {
    if (m.index !== consumed) return false;
    consumed = m.index + m[0].length;
    if (m[1] && m[1] !== "*" && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !el.classList.contains(m[3])) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v === null) return false;
      if (m[5] === "=" && v !== m[6]) return false;
      if (m[5] === "*=" && !v.includes(m[6] as string)) return false;
      if (m[5] === "^=" && !v.startsWith(m[6] as string)) return false;
      if (m[5] === "$=" && !v.endsWith(m[6] as string)) return false;
    }
    if (m[7] !== undefined && matchesList(el, m[7], scope)) return false;
    if (m[8] !== undefined && el !== (scope ?? el.ownerDocument.documentElement)) return false;
  }
  if (consumed !== c.length) throw new Error("mini-dom: 지원하지 않는 셀렉터 — " + c);
  return true;
};
const matchComplex = (el: MElement, sel: string, scope: MElement | null): boolean => {
  const toks = sel.replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
  const go = (e: MElement | null, i: number): boolean => {
    if (!e || i < 0) return i < 0;
    if (!matchCompound(e, toks[i] as string, scope)) return false;
    if (i === 0) return true;
    if (toks[i - 1] === ">") return go(e.parentNode, i - 2);
    for (let p = e.parentNode; p; p = p.parentNode) if (go(p, i - 1)) return true;
    return false;
  };
  return go(el, toks.length - 1);
};
const matchesList = (el: MElement, sel: string, scope: MElement | null = null): boolean =>
  splitTop(sel, ",").some((s) => matchComplex(el, s, scope));

// ── 창·타이머 ───────────────────────────────────────────────────────────
/** 손으로 돌리는 시계 — 검사가 «지금 몇 ms 지났다» 를 정한다(실제 대기 없음). */
export const makeClock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const errors: string[] = [];
  const setTimeout = (fn: () => void, ms = 0): number => { seq += 1; timers.set(seq, { at: now + Math.max(0, ms), fn, every: null }); return seq; };
  const setInterval = (fn: () => void, ms = 0): number => { seq += 1; timers.set(seq, { at: now + Math.max(1, ms), fn, every: Math.max(1, ms) }); return seq; };
  const clear = (id: number): void => { timers.delete(id); };
  const flush = async (): Promise<void> => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
  /** `ms` 만큼 시간을 흘린다 — 그 사이 만기된 타이머를 순서대로 돌리고 프라미스도 비운다. */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
      if (next === null) break;
      now = next[1].at;
      if (next[1].every === null) timers.delete(next[0]);
      else next[1].at = now + next[1].every;
      // ★던진 것은 **기록한다** — 브라우저도 타이머 예외로 멈추지 않는다(콘솔에 찍고 다음으로 간다). 검사가 `errors` 를 본다.
      try { next[1].fn(); } catch (e) { errors.push(e instanceof Error ? e.name + ": " + e.message : String(e)); }
    }
    now = end;
    await flush();
  };
  return {
    setTimeout, setInterval, clearTimeout: clear, clearInterval: clear, advance, flush, errors,
    pending: (): number => timers.size,
    intervals: (): number => [...timers.values()].filter((t) => t.every !== null).length,
    now: (): number => now,
  };
};

/**
 * 문서 + 창 + vm 컨텍스트 기본값. `extra` 가 전역(제품 파일이 부르는 이웃 함수 대역)을 덧붙인다.
 * ★`i18n` 은 진짜 카탈로그 규칙(`i18nForContext`)을 호출부가 넘긴다 — 여기서 항등 함수를 두면 키가 화면에 찍혀도 모른다.
 */
export const makeDomContext = (extra: Record<string, unknown> = {}) => {
  const document = new MiniDocument();
  const win: any = new EventTargetish();
  document.defaultView = win;
  Object.assign(win, {
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: (q: string) => ({ matches: /max-width:\s*900px/.test(q) ? win.innerWidth <= 900 : false, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    document,
  });
  const ctx: Record<string, unknown> = {
    document,
    window: win,
    self: win,
    console: { log() {}, warn() {}, error() {}, info() {} },
    HTMLElement: MElement,
    Node: MNode,
    MutationObserver: class { constructor(cb: (r: any[]) => void) { return new MiniMutationObserver(document, cb); } },
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, "\\$&") },
    queueMicrotask,
    Promise,
    JSON,
    Math,
    Date,
    URLSearchParams,
    localStorage: (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) }; })(),
    ...extra,
  };
  ctx["globalThis"] = ctx;
  return { document, window: win, ctx };
};

// ── 대시보드 부팅 앞부분 ─────────────────────────────────────────────────
export const DASH_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/js");
export const dashSource = (name: string): string => readFileSync(path.join(DASH_JS, name), "utf8");
/** 응답 대역 — 검사가 URL 마다 값을 정한다. */
export const jsonResponse = (body: unknown, status = 200): any => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * **index.html 순서대로** 싣는다 — `upTo` 파일 **앞까지**(기본: chat-core.js 앞 = 뷰 파일 전부).
 * ★손으로 고른 목록이 아니라 `_manifest.json` 순서다 — 부팅 경합은 «무엇이 먼저 실리나» 가 전부라서.
 * `stubs` 는 뒤 파일이 줄 전역의 대역(스크립트 문자열 — 같은 전역 렉시컬 범위에 들어간다).
 */
export const bootDashboard = (opts: {
  fetch: (url: string, init?: any) => Promise<any>;
  clock: ReturnType<typeof makeClock>;
  i18n: (k: string, p?: any) => string;
  upTo?: string;
  ids?: string[];
  /** index.html 의 `id` 전부를 (그 태그로, 평평하게) 만든다 — chat-core.js 처럼 정적 요소를 많이 잡는 파일을 실을 때. */
  allIds?: boolean;
  stubs?: string;
  width?: number;
  extra?: Record<string, unknown>;
}) => {
  const { document, window, ctx } = makeDomContext({
    i18n: opts.i18n,
    fetch: opts.fetch,
    setTimeout: opts.clock.setTimeout,
    setInterval: opts.clock.setInterval,
    clearTimeout: opts.clock.clearTimeout,
    clearInterval: opts.clock.clearInterval,
    requestAnimationFrame: (f: () => void) => opts.clock.setTimeout(f, 16),
    cancelAnimationFrame: opts.clock.clearTimeout,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    navigator: {},
    location: { origin: "http://dash.test", href: "http://dash.test/", pathname: "/" },
    ...(opts.extra ?? {}),
  });
  if (opts.width !== undefined) window.innerWidth = opts.width;
  // ★화면 문구는 util.js 의 **진짜 i18n** 이 카탈로그(index.html 이 심는 `__TIGU_I18N__`)를 읽는다 — 진짜 한국어 카탈로그를 심는다.
  window.__TIGU_I18N__ = {
    locale: "ko",
    strings: JSON.parse(readFileSync(path.join(DASH_JS, "../../../locales/ko.json"), "utf8")),
  };
  const made = new Set<string>();
  const add = (id: string, tag = "div"): void => {
    if (made.has(id)) return;
    made.add(id);
    const e = document.createElement(tag);
    e.id = id;
    document.body.appendChild(e);
  };
  for (const id of ["detail-panel", "workbench", "update-chip", ...(opts.ids ?? [])]) add(id);
  if (opts.allIds) {
    const html = readFileSync(path.join(DASH_JS, "../index.html"), "utf8");
    for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sid="([^"]+)"/g)) add(m[2] as string, (m[1] as string).toLowerCase());
  }
  vm.createContext(ctx);
  // ★돌려받은 프라미스가 거부되면 **기록한다** — 안 그러면 러너 전체가 «Unhandled rejection» 으로 죽고 어느 검사인지 안 보인다.
  const run = (code: string, filename = "inline.js"): any => {
    const v = vm.runInContext(code, ctx, { filename });
    if (v && typeof v.then === "function")
      v.then(undefined, (e: unknown) => opts.clock.errors.push(e instanceof Error ? e.name + ": " + e.message : String(e)));
    return v;
  };
  const files = JSON.parse(readFileSync(path.join(DASH_JS, "_manifest.json"), "utf8")) as string[];
  const stop = files.indexOf(opts.upTo ?? "chat-core.js");
  for (const f of files.slice(0, stop < 0 ? files.length : stop)) run(dashSource(f), f);
  if (opts.stubs) run(opts.stubs, "stubs.js");
  return { document, window, ctx, run };
};
