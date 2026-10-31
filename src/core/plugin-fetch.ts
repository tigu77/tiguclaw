// src/core/plugin-fetch.ts
/**
 * **플러그인이 밖으로 나가는 유일한 문** — 선언한 호스트만 (2026-08-28, 위젯 플랫폼 §D).
 *
 * ★설계엔 *"플러그인이 값으로 선언하고 코어가 집행한다"* 고 적어놨는데 **읽는 코드가 0**
 *  이었다. `weather` 의 `needs.network` 는 그냥 글자였다 — 선언이 집행 없이 있으면 그건
 *  약속이 아니라 **장식**이고, 다음 사람은 선언 없이 아무 데나 나간다.
 *
 * ★**여기가 유일한 출구인 이유는 우리가 정한 게 아니다.** 대시보드 CSP 가
 *  `connect-src 'self'` 라 브라우저는 외부로 못 나간다 — 플러그인의 외부 통신은 **정의상**
 *  데몬을 지난다. 그래서 한 곳에서 막으면 전부 막힌다.
 *
 * ★**정직한 한계**: 라이브러리가 자기 안에서 소켓을 여는 경우(grammy 등)는 여기를 안 지난다.
 *  이 문은 **플러그인이 직접 부르는 HTTP** 를 덮는다. 전부를 덮으려면 프로세스 격리가
 *  필요하고 그건 지금 0이다(설계 §H) — 덮는 범위를 넓혀 말하지 않는다.
 */
// ★허용 호스트는 **호출자가 넘긴다**(로더가 이미 읽은 매니페스트의 `needs.network`) — 2026-10-31.
//  종전엔 여기서 `appRoot()/plugins/<이름>/package.json` 을 **다시** 읽어, 홈(`<home>/plugins`)에 설치한 플러그인은
//  선언을 적어도 «현재 선언: [없음]» 으로 늘 막혔다(실측 재현). 부팅 로그·설치 화면은 같은 선언을 «외부 …» 로 보여 주는데
//  집행만 다른 파일을 봤다 — 같은 판단이 두 자리에 있었다. 이제 판단 재료는 로더 한 곳이다.

/**
 * 선언과 대조 — 순수 판정. 회귀가 이걸 **실행해서** 확인한다.
 *
 * ★와일드카드를 안 만든다. `*.example.com` 을 허용하면 선언이 곧 "그 회사 전부" 가 되고,
 *  그건 사용자가 뭘 허락했는지 다시 모르게 되는 길이다. 필요해지면 그때 근거를 대고 넣는다.
 * ★http 도 막는다 — 평문으로 나갈 이유가 없고, 허용하면 그게 다운그레이드 통로가 된다.
 */
export const isDeclaredUrl = (hosts: ReadonlySet<string>, url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return hosts.has(u.hostname);
};

/**
 * 리다이렉트를 **따라가는** 최대 횟수. 처음 요청 1 + 따라간 요청 최대 5 = 나가는 요청 최대 6.
 * 여섯 번째 리다이렉트 응답이 오면 던지고, 그 `Location` 으로는 요청하지 않는다.
 * (Node 내장 `fetch` 는 20 — 플러그인이 쓰는 API 에 그만큼 긴 사슬은 정상이 아니다.)
 */
export const PLUGIN_FETCH_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 본문을 버릴 때 같이 지우는 헤더 — fetch 표준 «request-body-header name». */
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];
/** 다른 출처로 넘어갈 때 지우는 헤더 — Node 내장 `fetch` 가 지우는 목록 그대로(실측, 표준은 `Authorization` 만 요구). */
const CROSS_ORIGIN_DROP = ["authorization", "proxy-authorization", "cookie", "host"];
/** fetch 가 대문자로 정규화하는 메서드 — 그 밖의 메서드는 대소문자를 그대로 둔다(표준 «normalize a method»). */
const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

const refuse = (plugin: string, hosts: ReadonlySet<string>, url: string): Error => {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url.slice(0, 60);
    }
  })();
  return new Error(
    `플러그인 '${plugin}' 이 선언하지 않은 곳으로 나가려 했습니다: ${host}. ` +
      `package.json 의 tiguclaw.needs.network 에 호스트를 추가하세요(https 만 허용). ` +
      `현재 선언: [${[...hosts].join(", ") || "없음"}]`,
  );
};

/**
 * 한 번 보내면 다시 못 만드는 본문인가 — 비동기 반복자(`ReadableStream`·Node 스트림 포함, 표준 «body's source is null»).
 * 그 밖(문자열·버퍼·Blob·FormData·URLSearchParams, 문자열로 바뀌는 객체)은 fetch 가 hop 마다 다시 만든다.
 */
const oneShotBody = (body: unknown): boolean =>
  typeof body === "object" && body !== null &&
  typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

/**
 * 본문의 «source» 를 처음에 한 번 고정한다 — fetch 는 리다이렉트 때 호출자 객체를 다시 읽지 않고 처음 추출한 source 를 다시
 * 쓴다(표준 «safely extract»). 그래서 문자열로 바뀌는 객체는 한 번만 바꾸고, `URLSearchParams`·버퍼는 지금 값을 복사한다.
 * `FormData`·`Blob` 은 표준대로 그대로 둔다(FormData 는 hop 마다 다시 추출). 버퍼 본문의 307/308 은 표준대로 다시 보낸다
 * — Node 22 내장 fetch 는 이 경우 버퍼 분리로 실패하는데(실측) 그건 따르지 않는다.
 */
const fixBody = (b: unknown): RequestInit["body"] => {
  if (b === undefined || b === null) return null;
  if (typeof b === "string" || b instanceof Blob || b instanceof FormData || oneShotBody(b)) return b as BodyInit;
  if (b instanceof URLSearchParams) return new URLSearchParams(b);
  if (b instanceof ArrayBuffer) return b.slice(0);
  if (ArrayBuffer.isView(b)) {
    const copy = new Uint8Array(b.byteLength);
    copy.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    return copy;
  }
  return String(b);
};

/** userinfo 를 뺀 URL — 같은 출처의 자격 증명 든 Location 을 따라갈 때 Node 가 실제로 요청하는 주소(실측). */
const withoutCredentials = (u: URL): string => {
  const x = new URL(u.href);
  x.username = "";
  x.password = "";
  return x.href;
};

/** `RequestInit` 의 사전 멤버 — 상속된 값도 fetch 가 읽으므로 같이 읽는다(Node 22 내장 fetch 기준 + 표준). */
const INIT_KEYS = [
  "body", "cache", "credentials", "dispatcher", "duplex", "headers", "integrity", "keepalive",
  "method", "mode", "priority", "redirect", "referrer", "referrerPolicy", "signal", "window",
];

/**
 * 호출자의 `init` 을 **한 번만** 읽어 평범한 객체로 고정한다. 판정에 쓴 값과 `fetch` 가 실제로 쓰는 값이 갈리면 안 된다 —
 * getter·`String` 객체는 읽을 때마다 다른 값을 낼 수 있고(판정은 "manual", fetch 는 "follow"), 프로토타입에 둔 `signal` 은
 * `fetch` 는 읽지만 펼치기(`{...init}`)는 놓친다.
 */
const snapshotInit = (init: RequestInit | undefined): Record<string, unknown> => {
  if (init === undefined || init === null) return {};
  const own: Record<string, unknown> = { ...init };
  for (const k of INIT_KEYS) if (!Object.hasOwn(own, k) && k in init) own[k] = (init as Record<string, unknown>)[k];
  return own;
};

/**
 * 플러그인용 `fetch`. **선언 안 한 호스트면 던진다 — 처음 URL 만이 아니라 나가는 요청마다.**
 *
 * @param plugin 플러그인 이름 — 거절 문구에만 쓴다.
 * @param declaredHosts 그 플러그인 매니페스트의 `needs.network`(로더가 읽은 값).
 *
 * ★던지는 이유: 조용히 막으면 플러그인은 "네트워크가 안 되네" 로 오해하고 재시도 루프를
 *  돈다. 사유를 문장으로 주면 **개발자가 고칠 곳을 안다**(선언에 호스트를 추가하면 된다).
 *
 * ★리다이렉트를 `fetch` 에 맡기지 않는다(2026-10-31). 종전엔 처음 URL 만 대조하고 `fetch` 의 자동 따라가기를 그대로 둬,
 *  선언한 호스트가 `302 → 선언 밖` 을 주면 그 호스트로 요청이 나갔다(307/308 이면 본문까지). 이제 `redirect: "manual"` 로
 *  받아 **다음 요청 전에** 같은 판정을 거친다. 따라가는 규칙(메서드·본문·헤더)은 fetch 표준 «HTTP-redirect fetch» 와
 *  Node 내장 `fetch` 의 실측 동작을 따른다 — 다른 점은 상한(`PLUGIN_FETCH_MAX_REDIRECTS`)·선언 대조, 그리고 Node 가 표준과
 *  어긋나거나 끝나지 않는 두 경우(버퍼 본문 307/308 재전송 — `fixBody` · 아래 `no-cors`)뿐이다.
 *  호출자가 `redirect: "manual"`·`"error"` 를 주면 따라가지 않으므로 요청은 한 번뿐이라 그대로 맡긴다.
 *  ★`mode: "no-cors"` 의 교차 출처 리다이렉트는 Node 가 불투명 응답을 만들다 끝나지 않는다(실측) — 그 동작은 흉내 내지 않고 `cors` 처럼 따라간다.
 */
export const pluginFetch = async (
  plugin: string,
  declaredHosts: readonly string[],
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const hosts = new Set(declaredHosts);
  let current = String(url);
  if (!isDeclaredUrl(hosts, current)) throw refuse(plugin, hosts, current);
  // 판정할 값은 여기서 원시 문자열로 한 번 바꾸고, `fetch` 에도 그 값을 준다.
  const opts = snapshotInit(init);
  const redirect = opts.redirect === undefined ? "follow" : String(opts.redirect);
  if (redirect !== "follow") return fetch(current, { ...opts, redirect } as RequestInit);

  const mode = opts.mode === undefined ? "cors" : String(opts.mode);
  const requested = opts.method === undefined ? "GET" : String(opts.method);
  let method = NORMALIZED_METHODS.has(requested.toUpperCase()) ? requested.toUpperCase() : requested;
  let body = fixBody(opts.body);
  const headers = new Headers(opts.headers as HeadersInit | undefined);
  const firstOrigin = new URL(current).origin;
  /** 처음 출처와 다른 hop 을 거쳤나 — 그러면 Node 내장 fetch 의 응답 `type` 이 `cors` 다(한 번 서면 유지). */
  let tainted = false;
  const cannotFollow = (why: string): TypeError =>
    new TypeError(`플러그인 '${plugin}' 요청의 리다이렉트를 따라갈 수 없습니다: ${why}`);
  /** 실제로 요청할 주소 — 보통 `current` 와 같고, 자격 증명 든 Location 을 따라갈 때만 userinfo 가 빠진다. */
  let target = current;
  // 따라간 응답은 내장 fetch 처럼 보이게 — 복제본도 같은 표시를 갖는다. `url` 은 따라간 주소(조각 제외, userinfo 는 Node 처럼 유지).
  const markFollowed = (r: Response): Response => {
    const cloneOf = r.clone.bind(r);
    const finalUrl = new URL(current);
    finalUrl.hash = "";
    Object.defineProperties(r, {
      redirected: { value: true },
      url: { value: finalUrl.href },
      ...(tainted ? { type: { value: "cors" } } : {}),
      clone: { value: (): Response => markFollowed(cloneOf()) },
    });
    return r;
  };

  for (let followed = 0; ; followed += 1) {
    const res = await fetch(target, { ...opts, mode, method, headers, body, redirect: "manual" } as RequestInit);
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (location === null) {
      // 리다이렉트가 아니거나 `Location` 이 없다 — 표준대로 그 응답이 결과다.
      return followed > 0 ? markFollowed(res) : res;
    }
    // 여기서부터는 다음 요청이거나 던짐이다 — 이 응답 본문은 버린다(연결 반납).
    await res.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw cannotFollow(`잘못된 Location (${location.slice(0, 60)})`);
    }
    if (!isDeclaredUrl(hosts, next.href)) throw refuse(plugin, hosts, next.href);
    if (followed >= PLUGIN_FETCH_MAX_REDIRECTS) {
      throw cannotFollow(`리다이렉트가 ${PLUGIN_FETCH_MAX_REDIRECTS}번을 넘었습니다`);
    }
    if (mode === "same-origin" && next.origin !== firstOrigin) {
      throw cannotFollow("mode 가 same-origin 인데 다른 출처로 리다이렉트됐습니다");
    }
    // 자격 증명 든 Location — Node 내장 fetch 는 `cors` 면 거절하고, `same-origin`(같은 출처는 위에서 보장)이면 userinfo 없이
    //  요청하며 따라간다(실측).
    const credentialed = next.username !== "" || next.password !== "";
    if (credentialed && mode !== "same-origin") throw cannotFollow("Location 에 자격 증명이 들어 있습니다");
    if (res.status !== 303 && body !== null && oneShotBody(body)) {
      throw cannotFollow("스트림 본문은 다시 보낼 수 없습니다");
    }
    if (((res.status === 301 || res.status === 302) && method === "POST") ||
        (res.status === 303 && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = null;
      for (const h of BODY_HEADERS) headers.delete(h);
    }
    if (new URL(current).origin !== next.origin) for (const h of CROSS_ORIGIN_DROP) headers.delete(h);
    if (mode === "cors" && next.origin !== firstOrigin) tainted = true;
    current = next.href;
    target = credentialed ? withoutCredentials(next) : next.href;
  }
};
