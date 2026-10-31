/**
 * `plugin-fetch-redirect` 의 자식 — **실제** `createPluginHost(...).fetch` → `pluginFetch` → Node 내장 `fetch` 를
 * 대역 dispatcher 위에서 돌려, 리다이렉트 hop 마다 **어디로 무엇이 나갔는지**를 기록한다.
 *
 * 자식인 이유: 대역은 undici 전역 dispatcher(`Symbol.for("undici.globalDispatcher.1")`)를 바꿔 끼운다 — 러너 프로세스의
 *  다른 검사가 쓰는 `fetch` 까지 가로채면 안 된다. 리다이렉트 따라가기는 `fetch` 안(undici)에 있어 `globalThis.fetch`
 *  스텁으로는 원 결함(자동 따라가기)을 재현할 수 없다 — 그래서 `fetch` 는 진짜를 두고 그 아래 연결만 대역으로 바꾼다.
 *
 * ★외부 통신 0: 대역이 모든 요청을 받고, 그래도 소켓을 열려는 시도가 있으면 `net.Socket#connect` 가 세고 막는다
 *  (결과의 `sockets` — 0 이어야 한다).
 *
 * 결과를 마지막 줄 `PLUGIN_FETCH {json}` 으로 낸다.
 */
import { mkdirSync } from "node:fs";
import net from "node:net";

const home = process.env.TIGUCLAW_HOME ?? "";
mkdirSync(home, { recursive: true });
process.chdir(home);
delete process.env.DATA_DIR;

let sockets = 0;
net.Socket.prototype.connect = function blocked(): never {
  sockets += 1;
  throw new Error("regression: 실제 소켓 연결 차단");
} as never;

type Wire = { method: string; url: string; headers: Record<string, string>; body: string };
type Route = { status: number; headers?: Record<string, string>; partial?: boolean; after?: () => void };
const wire: Wire[] = [];
const routes = new Map<string, Route>();
/** 응답 본문을 다 보내지 않은(`partial`) 리다이렉트 응답의 연결이 끊겼는지 — 연결 반납 확인. */
const released: string[] = [];

type Handler = {
  onConnect: (abort: (err?: Error) => void) => void;
  onHeaders: (status: number, headers: Buffer[], resume: () => void, statusText: string) => boolean;
  onData: (chunk: Buffer) => boolean;
  onComplete: (trailers: Buffer[]) => void;
  onError: (err: Error) => void;
};
type DispatchOpts = { origin: string | URL; path: string; method: string; headers?: unknown; body?: unknown };

const headerRecord = (h: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  } else if (h !== null && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
  }
  return out;
};

const fake = {
  dispatch(opts: DispatchOpts, h: Handler): boolean {
    const url = String(opts.origin) + opts.path;
    const rec: Wire = { method: opts.method, url, headers: headerRecord(opts.headers), body: "" };
    wire.push(rec);
    const respond = (): void => {
      const r = routes.get(url) ?? { status: 200 };
      queueMicrotask(() => {
        let done = false;
        h.onConnect((err?: Error) => {
          if (done) return;
          done = true;
          released.push(url);
          h.onError(err ?? new Error("aborted"));
        });
        const hs: Buffer[] = [];
        for (const [k, v] of Object.entries(r.headers ?? {})) hs.push(Buffer.from(k), Buffer.from(v));
        h.onHeaders(r.status, hs, () => {}, "X");
        h.onData(Buffer.from(`body:${url}`));
        if (r.partial) return; // 본문을 끝내지 않는다 — 소비자가 버려야(취소해야) 연결이 풀린다
        done = true;
        h.onComplete([]);
        r.after?.(); // 응답을 다 준 뒤의 부수 동작(예: 호출자 신호 끊기)
      });
    };
    const b = opts.body as unknown;
    if (b === null || b === undefined) respond();
    else if (typeof b === "string" || b instanceof Uint8Array) {
      rec.body = Buffer.from(b as string).toString();
      respond();
    } else if (typeof (b as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      void (async () => {
        for await (const c of b as AsyncIterable<Uint8Array>) rec.body += Buffer.from(c).toString();
        respond();
      })();
    } else {
      rec.body = `[unknown:${typeof b}]`;
      respond();
    }
    return true;
  },
  close: async (): Promise<void> => {},
  destroy: async (): Promise<void> => {},
  on(): unknown { return this; },
  once(): unknown { return this; },
  off(): unknown { return this; },
  emit: (): boolean => false,
};
(globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] = fake;

const { createPluginHost } = await import("../../core/plugins/host.js");
const { PLUGIN_FETCH_MAX_REDIRECTS } = (await import("../../core/plugin-fetch.js")) as { PLUGIN_FETCH_MAX_REDIRECTS?: number };
const MAX = PLUGIN_FETCH_MAX_REDIRECTS ?? 5;

const DECL = ["declared.test", "other.test"];
const via = (hosts: string[] = DECL) => createPluginHost("regr-fetch", { network: hosts }).fetch;

type Outcome = {
  ok: boolean;
  status?: number;
  url?: string;
  redirected?: boolean;
  type?: string;
  cloneRedirected?: boolean;
  cloneType?: string;
  cloneUrl?: string;
  text?: string;
  error?: string;
  errorName?: string;
  wire: Wire[];
};
/** 한 시나리오 — 요청 기록을 비우고 돌린 뒤, 결과와 그 사이 나간 요청을 돌려준다. 3초 넘게 매달리면 그것도 결과다. */
const run = async (f: () => Promise<Response>): Promise<Outcome> => {
  wire.length = 0;
  try {
    const r = await Promise.race([
      f(),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("HANG"), { name: "Hang" })), 3000)),
    ]);
    const c = r.clone();
    // 3xx 도 끝까지 읽는다(복제본까지) — 안 읽은 본문이 대역 연결을 붙들어 뒤 시나리오를 흐린다
    const [text] = await Promise.all([r.text(), c.text()]);
    return {
      ok: true, status: r.status, url: r.url, redirected: r.redirected, type: r.type,
      cloneRedirected: c.redirected, cloneType: c.type, cloneUrl: c.url, text, wire: [...wire],
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: String(err.message).slice(0, 300), errorName: err.name, wire: [...wire] };
  }
};

const set = (from: string, status: number, location?: string, extra: Partial<Route> = {}): void => {
  routes.set(from, { status, ...(location !== undefined ? { headers: { location } } : {}), ...extra });
};

const out: Record<string, unknown> = {};

// ① 선언 밖으로 가는 302 · 307 · 308 — 그 호스트엔 요청 0, 본문도 안 나간다
set("https://declared.test/r302", 302, "https://outside.test/leak");
set("https://declared.test/r307", 307, "https://outside.test/leak");
set("https://declared.test/r308", 308, "https://outside.test/leak");
out.out302 = await run(() => via()("https://declared.test/r302"));
out.out307 = await run(() => via()("https://declared.test/r307", { method: "POST", body: "SECRET-BODY" }));
out.out308 = await run(() => via()("https://declared.test/r308", { method: "PUT", body: "SECRET-BODY" }));
// 선언 안 hop 을 거친 뒤의 이탈도 같다(판정은 첫 리다이렉트만이 아니라 매 hop)
set("https://declared.test/late1", 307, "https://other.test/late2");
set("https://other.test/late2", 307, "https://outside.test/leak");
out.lateHop = await run(() => via()("https://declared.test/late1", { method: "POST", body: "SECRET-BODY" }));

// ② 선언 안 교차 출처 리다이렉트 — 따라간다 · 자격 헤더는 떨어지고 일반 헤더는 남는다(Node fetch 와 같다)
set("https://declared.test/cross", 302, "https://other.test/landing");
out.cross = await run(() =>
  via()("https://declared.test/cross", {
    headers: { authorization: "Bearer T", cookie: "c=1", "proxy-authorization": "P", "x-custom": "keep" },
  }),
);

// ②-2 같은 호스트명이라도 포트가 다르면 다른 출처 — 자격 헤더를 지운다(Node fetch 와 같다)
set("https://declared.test/port", 302, "https://declared.test:8443/end");
out.portCross = await run(() =>
  via()("https://declared.test/port", { headers: { authorization: "Bearer T", cookie: "c=1", "x-custom": "keep" } }),
);

// ②-3 교차 출처를 거쳐 처음 출처로 돌아와도 응답 type 은 cors 로 남는다(Node fetch 와 같다)
set("https://declared.test/aba1", 302, "https://other.test/aba2");
set("https://other.test/aba2", 302, "https://declared.test/aba-end");
out.abaTaint = await run(() => via()("https://declared.test/aba1"));

// ③ 상대 경로 Location · 같은 출처면 자격 헤더 유지
set("https://declared.test/rel", 301, "/same/path?q=1");
out.relative = await run(() => via()("https://declared.test/rel", { headers: { authorization: "Bearer T" } }));

// ④ 상한 — 정확히 MAX 번 따라가면 성공, MAX+1 번째 리다이렉트는 던진다(그 Location 으론 요청 0)
for (let i = 0; i < MAX; i += 1) set(`https://declared.test/chain${i}`, 302, `https://declared.test/chain${i + 1}`);
out.chainMax = await run(() => via()("https://declared.test/chain0"));
for (let i = 0; i <= MAX; i += 1) set(`https://declared.test/long${i}`, 302, `https://declared.test/long${i + 1}`);
out.chainOver = await run(() => via()("https://declared.test/long0"));

// ⑤ 순환
set("https://declared.test/c1", 302, "https://other.test/c2");
set("https://other.test/c2", 302, "https://declared.test/c1");
out.cycle = await run(() => via()("https://declared.test/c1"));

// ⑥ 빈 선언 — 아무 데도 못 나간다
out.empty = await run(() => via([])("https://declared.test/anything"));

// ⑦ 호스트 부분 일치 · userinfo · 평문 우회 — 첫 URL 로도, 리다이렉트로도
const tricks = [
  "https://declared.test.evil.test/x",
  "https://evildeclared.test/x",
  "https://declared.test@evil.test/x",
  "http://declared.test/x",
];
out.trickFirst = await Promise.all(tricks.map((u) => run(() => via()(u)))).then((rs) => rs);
const trickRedirect: Outcome[] = [];
for (const [i, u] of tricks.entries()) {
  set(`https://declared.test/trick${i}`, 302, u);
  trickRedirect.push(await run(() => via()(`https://declared.test/trick${i}`)));
}
out.trickRedirect = trickRedirect;

// ⑧ 메서드·본문 — 302 POST→GET(본문·본문 헤더 제거) · 303 PUT→GET · 307 POST 유지 · 301 PUT 유지
set("https://declared.test/p302", 302, "https://declared.test/after");
set("https://declared.test/p303", 303, "https://declared.test/after");
set("https://declared.test/p307", 307, "https://declared.test/after");
set("https://declared.test/p301", 301, "https://declared.test/after");
out.post302 = await run(() =>
  via()("https://declared.test/p302", {
    method: "POST",
    body: "B",
    headers: { "content-type": "text/plain", "content-language": "ko", "x-custom": "keep" },
  }),
);
out.put303 = await run(() => via()("https://declared.test/p303", { method: "PUT", body: "B" }));
out.post307 = await run(() => via()("https://declared.test/p307", { method: "POST", body: "B" }));
out.binary307 = await run(() => via()("https://declared.test/p307", { method: "POST", body: new TextEncoder().encode("BIN") }));
out.binary302 = await run(() => via()("https://declared.test/p302", { method: "POST", body: new TextEncoder().encode("BIN") }));
out.put301 = await run(() => via()("https://declared.test/p301", { method: "PUT", body: "B" }));
// 소문자 메서드도 fetch 처럼 정규화해 판정한다 · 303 HEAD 는 HEAD 그대로 · 선언 안 308 은 본문 유지
out.lowerPost302 = await run(() =>
  via()("https://declared.test/p302", { method: "post", body: "B", headers: { "content-type": "text/plain" } }),
);
out.head303 = await run(() => via()("https://declared.test/p303", { method: "HEAD" }));
set("https://declared.test/p308", 308, "https://other.test/after");
out.post308 = await run(() => via()("https://declared.test/p308", { method: "POST", body: "B" }));

// ⑨ 다시 보낼 수 없는 스트림 본문 + 307 — 안전하게 실패(두 번째 요청 0)
out.stream307 = await run(() =>
  via()("https://declared.test/p307", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("S"));
        c.close();
      },
    }),
    duplex: "half",
  } as RequestInit),
);

// 비동기 반복자 본문도 fetch 표준상 «다시 못 만드는 본문» 이다 — 다시 돌릴 수 있는 반복자라도 Node fetch 는 307 에서 실패한다.
//  (한 번 쓰면 끝나는 반복자는 fetch 가 알아서 실패하므로, 다시 돌릴 수 있는 쪽으로 잰다.)
out.iterable307 = await run(() =>
  via()("https://declared.test/p307", {
    method: "POST",
    body: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("G");
      },
    },
    duplex: "half",
  } as unknown as RequestInit),
);

// 303 은 본문을 버리고 GET 이라, 다시 못 보내는 본문이어도 따라간다
out.iterable303 = await run(() =>
  via()("https://declared.test/p303", {
    method: "POST",
    body: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("G");
      },
    },
    duplex: "half",
  } as unknown as RequestInit),
);

// 본문 source 는 처음에 고정 — 문자열로 바뀌는 객체는 한 번만 바뀌고, URLSearchParams 는 hop 사이에 바뀌어도 처음 값
{
  let n = 0;
  out.toStringBody = await run(() =>
    via()("https://declared.test/p307", {
      method: "POST",
      body: { toString: () => `S${++n}` } as unknown as BodyInit,
    }),
  );
  const usp = new URLSearchParams("a=1");
  set("https://declared.test/usp307", 307, "https://declared.test/after", { after: () => usp.set("a", "2") });
  out.uspBody = await run(() => via()("https://declared.test/usp307", { method: "POST", body: usp }));
  // 버퍼도 같다 — hop 사이에 원본 바이트가 바뀌어도 처음 바이트(ArrayBuffer · 오프셋 있는 view)
  const ab = new TextEncoder().encode("ABC").buffer;
  set("https://declared.test/ab307", 307, "https://declared.test/after", { after: () => new Uint8Array(ab).set([90, 90, 90]) });
  out.abBody = await run(() => via()("https://declared.test/ab307", { method: "POST", body: ab }));
  const big = new TextEncoder().encode("xxABCxx");
  const view = new DataView(big.buffer, 2, 3);
  set("https://declared.test/view307", 307, "https://declared.test/after", { after: () => big.set([90, 90, 90], 2) });
  out.viewBody = await run(() => via()("https://declared.test/view307", { method: "POST", body: view }));
}

// ⑩ Location 없음(그 응답 그대로) · 잘못된 Location(던짐) · 자격 증명 든 Location(던짐 — Node fetch 와 같다)
set("https://declared.test/noloc", 302);
set("https://declared.test/badloc", 302, "https://[bad");
set("https://declared.test/credloc", 302, "https://u:p@other.test/x");
out.noLocation = await run(() => via()("https://declared.test/noloc"));
out.badLocation = await run(() => via()("https://declared.test/badloc"));
out.credLocation = await run(() => via()("https://declared.test/credloc"));
// same-origin 의 같은 출처 자격 증명 Location 은 userinfo 없이 요청하며 따라가고, 응답 url 엔 남는다(Node fetch 와 같다)
set("https://declared.test/credsame", 302, "https://u:p@declared.test/cred-end#frag");
out.credSameOrigin = await run(() =>
  via()("https://declared.test/credsame", { mode: "same-origin", headers: { authorization: "Bearer T" } }),
);

// ⑪ 사용자 redirect 옵션 — manual 은 3xx 그대로(따라가지 않음) · error 는 던짐 · 둘 다 요청 1번
out.manual = await run(() => via()("https://declared.test/r302", { redirect: "manual" }));
out.error = await run(() => via()("https://declared.test/r302", { redirect: "error" }));

// ⑪-2 옵션은 한 번만 읽는다 — `String` 객체 follow 는 따라가되 선언 대조를 거치고, getter 는 처음 읽은 값(manual)으로 고정
out.stringFollow = await run(() =>
  via()("https://declared.test/r302", { redirect: new String("follow") } as unknown as RequestInit),
);
{
  let reads = 0;
  const init = {
    get redirect(): RequestRedirect {
      reads += 1;
      return reads < 2 ? "manual" : "follow"; // 두 번째 읽기부터 바뀐다 — 한 번만 읽어야 manual 로 고정된다
    },
  };
  out.getterRedirect = await run(() => via()("https://declared.test/r302", init as RequestInit));
}

// 상속된 redirect 도 fetch 처럼 읽는다 · toString 이 매번 다른 redirect 도 한 번 바꾼 값으로 fetch 에 준다
out.inheritedRedirect = await run(() => via()("https://declared.test/r302", Object.create({ redirect: "manual" }) as RequestInit));
{
  let n = 0;
  const flip = { toString: () => (++n === 1 ? "manual" : "follow") };
  out.toStringRedirect = await run(() =>
    via()("https://declared.test/r307", { method: "POST", body: "SECRET-BODY", redirect: flip } as unknown as RequestInit),
  );
}

// ⑪-3 mode — same-origin 은 다른 출처(선언돼 있어도) hop 전에 던짐 · 같은 출처는 따라감
out.sameOriginCross = await run(() => via()("https://declared.test/cross", { mode: "same-origin" }));
out.sameOriginSame = await run(() => via()("https://declared.test/rel", { mode: "same-origin" }));
out.sameOriginObject = await run(() =>
  via()("https://declared.test/cross", { mode: new String("same-origin") } as unknown as RequestInit),
);

// ⑫ 취소 — 모든 hop 에 호출자 신호가 그대로 실린다 · hop 사이에 끊기면 다음 요청 0 · 처음부터 끊겼거나 상속된 신호도 같다
// ★«매달린 두 번째 hop 에 취소가 닿나» 로 재지 않는다: Node 22 내장 fetch 는 요청 대기 중 GC 가 돌면 호출자 신호를 잃는다
//  (대역에서 `gc()` 한 번으로 결정적 재현 — 이 수정 전에도 같다). 그 방식은 앞 시나리오의 할당량에 따라 결과가 흔들렸다.
{
  const ac = new AbortController();
  const realFetch = globalThis.fetch;
  const seen: unknown[] = [];
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => {
    seen.push(i?.signal);
    return realFetch(u, i);
  }) as typeof fetch;
  try {
    out.signalHops = await run(() => via()("https://declared.test/cross", { signal: ac.signal }));
  } finally {
    globalThis.fetch = realFetch;
  }
  out.signalEveryHop = seen.length === 2 && seen.every((x) => x === ac.signal);
}
{
  const ac = new AbortController();
  set("https://declared.test/abort-between", 302, "https://other.test/never", { after: () => ac.abort() });
  out.abortBetweenHops = await run(() => via()("https://declared.test/abort-between", { signal: ac.signal }));
}
{
  const ac = new AbortController();
  ac.abort();
  out.preAborted = await run(() => via()("https://declared.test/r302", { signal: ac.signal }));
  // 프로토타입에 둔 signal 도 fetch 처럼 읽는다
  out.inheritedSignal = await run(() => via()("https://declared.test/r302", Object.create({ signal: ac.signal }) as RequestInit));
}

// ⑬ 연결 반납 — 따라간 리다이렉트 응답(본문을 다 안 보낸)이 버려진다
set("https://declared.test/partial", 302, "https://declared.test/after-partial", { partial: true });
out.partial = await run(() => via()("https://declared.test/partial"));
await new Promise((r) => setTimeout(r, 50));
out.released = [...released];

out.sockets = sockets;
out.max = MAX;
console.log(`PLUGIN_FETCH ${JSON.stringify(out)}`);
process.exit(0);
