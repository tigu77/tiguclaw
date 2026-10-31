/**
 * 회귀: **플러그인 `host.fetch` 가 리다이렉트로 선언 밖에 나가지 않는다** (2026-10-31).
 *
 * 결함: `pluginFetch` 가 처음 URL 만 `needs.network` 와 대조하고 `fetch` 의 자동 따라가기를 그대로 둬, 선언한 호스트가
 *  `302 → 선언 밖` 을 주면 그 호스트로 요청이 나갔다(307/308 이면 본문까지). 문서는 «`needs.network` 에 적은 호스트만»
 *  이라고 약속한다. 그리고 기존 검사는 순수 판정(`isDeclaredUrl`)만 재서, 집행 함수의 빈 선언 거절을 지워도 초록이었다.
 *
 * 지키는 것(전부 실제 `createPluginHost(...).fetch` → `pluginFetch` → Node 내장 `fetch`, 대역 연결 · 실소켓 0):
 *  ① 선언 밖으로 가는 302·307·308 — 그 호스트엔 요청 0 · 본문도 안 나간다 · 던진다
 *  ② 선언 안 리다이렉트는 따라간다(교차 출처 · 상대 경로) · 다른 출처로 넘어가면 자격 헤더를 지운다(Node fetch 와 같다)
 *  ③ 상한: 정확히 5번 따라가면 성공, 여섯 번째 리다이렉트는 던지고 그 Location 엔 요청 0 · 순환도 같은 상한에서 끝난다
 *  ④ 빈 선언 · 호스트 부분 일치 · userinfo · 평문 — 첫 URL 로도 리다이렉트로도 못 나간다
 *  ⑤ 메서드·본문은 fetch 표준대로(302 POST→GET 본문·본문 헤더 제거 · 303→GET · 307/301 PUT 유지) · 스트림 본문은 안전 실패
 *  ⑥ Location 없음 = 그 응답 · 잘못된/자격 증명 든 Location = 던짐 · `redirect: manual/error` 는 따라가지 않음
 *  ⑦ 호출자 신호가 모든 hop 에 실린다(hop 사이에 끊기면 다음 요청 0 · 상속된 signal 포함) · 버린 리다이렉트 응답의 연결을 반납한다
 *  ⑧ 옵션은 한 번만 읽는다(`String` 객체·getter 로 판정과 실제 fetch 가 갈리지 않음) · `mode: same-origin` 은 다른 출처 hop 전에 던짐
 *  ⑨ 따라간 응답은 내장 fetch 처럼 보인다(`redirected` · 교차 출처면 `type: cors` · 복제본도 같음)
 *
 * 등급: 전부 **동작**(자식 프로세스 — 전역 dispatcher 를 바꾸므로 러너와 격리).
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

type Wire = { method: string; url: string; headers: Record<string, string>; body: string };
type O = {
  ok?: boolean; status?: number; url?: string; redirected?: boolean; type?: string; cloneRedirected?: boolean; cloneType?: string; cloneUrl?: string;
  error?: string; errorName?: string; wire?: Wire[];
};

export const check: RegressionCheck = {
  name: "plugin-fetch-redirect",
  guards:
    "플러그인 host.fetch 가 처음 URL 만 선언과 대조하고 리다이렉트는 fetch 에 맡겨, 선언한 호스트가 302/307/308 로 선언 밖 호스트를 가리키면 그리로 요청(과 본문)이 나가던 것 + 집행 함수의 빈 선언 거절이 검사 밖이던 것",
  run: async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const childHome = mkdtempSync(`${tmpdir()}/tiguclaw-regression-plugin-fetch-`);
    const r = await spawnWithin(
      60000,
      "플러그인 fetch 리다이렉트",
      ["--import", "tsx", fileURLToPath(new URL("./_plugin-fetch-redirect-child.ts", import.meta.url))],
      { env: { ...process.env, TIGUCLAW_HOME: childHome } },
    ).finally(() => rmSync(childHome, { recursive: true, force: true }));
    const line = r.out.split("\n").find((x) => x.startsWith("PLUGIN_FETCH "));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (line ? JSON.parse(line.slice("PLUGIN_FETCH ".length)) : {}) as Record<string, any>;
    const o = (k: string): O => (g[k] ?? {}) as O;
    const urls = (x: O): string[] => (x.wire ?? []).map((w) => w.url);
    const s = (x: O): string =>
      `ok=${x.ok} status=${x.status ?? "-"} err=${(x.error ?? "").slice(0, 70)} wire=${JSON.stringify(
        (x.wire ?? []).map((w) => `${w.method} ${w.url}${w.body ? ` [${w.body}]` : ""}`),
      ).slice(0, 400)}`;
    const MAX = 5;
    const blocked = (x: O, n: number): boolean => x.ok === false && (x.wire ?? []).length === n;
    const noOutside = (x: O): boolean => urls(x).every((u) => !u.includes("outside.test"));
    const hdr = (x: O, i: number): Record<string, string> => x.wire?.[i]?.headers ?? {};

    const out302 = o("out302");
    const out307 = o("out307");
    const out308 = o("out308");
    const late = o("lateHop");
    const port = o("portCross");
    const bin7 = o("binary307");
    const bin2 = o("binary302");
    const cross = o("cross");
    const rel = o("relative");
    const chainMax = o("chainMax");
    const chainOver = o("chainOver");
    const cycle = o("cycle");
    const empty = o("empty");
    const trickFirst = (g.trickFirst ?? []) as O[];
    const trickRedirect = (g.trickRedirect ?? []) as O[];
    const post302 = o("post302");
    const put303 = o("put303");
    const post307 = o("post307");
    const put301 = o("put301");
    const stream307 = o("stream307");
    const noLoc = o("noLocation");
    const badLoc = o("badLocation");
    const credLoc = o("credLocation");
    const manual = o("manual");
    const err = o("error");
    const between = o("abortBetweenHops");
    const pre = o("preAborted");
    const inh = o("inheritedSignal");
    const lower = o("lowerPost302");
    const head = o("head303");
    const p308 = o("post308");
    const strF = o("stringFollow");
    const getter = o("getterRedirect");
    const soX = o("sameOriginCross");
    const soS = o("sameOriginSame");

    return [
      assert("자식이 끝까지 돌았다(시한 안 · 결과 줄 있음)", !r.timedOut && line !== undefined,
        r.timedOut ? "시한 초과" : line === undefined ? `결과 줄 없음: ${r.err.slice(-300)}` : "정상"),
      assert("★외부 통신 0 — 실제 소켓 연결 시도 없음", g.sockets === 0, `sockets=${g.sockets}`),
      assert("상한 계약은 정확히 5번(따라감) — 상수가 바뀌면 문서·노트도 같이 바뀌어야 한다", g.max === MAX, `max=${g.max}`),
      assert(
        "★★선언 밖으로 가는 302·307·308 — 던지고, 그 호스트엔 요청 0 · 본문은 선언 호스트 한 번에만",
        [out302, out307, out308].every((x) => blocked(x, 1) && noOutside(x) && /선언하지 않은 곳/.test(x.error ?? "")),
        `302: ${s(out302)} | 307: ${s(out307)} | 308: ${s(out308)}`,
      ),
      assert(
        "★선언 안 hop 을 거친 뒤 선언 밖으로 가는 307 도 — 던지고, 그 호스트엔 요청 0(판정은 매 hop)",
        blocked(late, 2) && noOutside(late) && /선언하지 않은 곳/.test(late.error ?? ""),
        s(late),
      ),
      assert(
        "같은 호스트명·다른 포트도 다른 출처 — 따라가되 authorization/cookie 제거 · 일반 헤더 유지",
        port.ok === true && port.wire?.[1]?.url === "https://declared.test:8443/end" &&
          hdr(port, 1).authorization === undefined && hdr(port, 1).cookie === undefined && hdr(port, 1)["x-custom"] === "keep",
        `${s(port)} · 2번째 헤더 ${JSON.stringify(hdr(port, 1)).slice(0, 200)}`,
      ),
      assert(
        "바이너리 본문 — 307 은 같은 본문을 다시 보내고 302 POST 는 본문 없는 GET",
        bin7.ok === true && bin7.wire?.[1]?.method === "POST" && bin7.wire?.[1]?.body === "BIN" &&
          bin2.ok === true && bin2.wire?.[1]?.method === "GET" && bin2.wire?.[1]?.body === "",
        `307: ${s(bin7)} | 302: ${s(bin2)}`,
      ),
      assert(
        "★선언 안 교차 출처 리다이렉트는 따라간다 — 결과 URL·redirected 보존 · authorization/cookie/proxy-authorization 제거 · 일반 헤더 유지",
        cross.ok === true && cross.status === 200 && cross.url === "https://other.test/landing" && cross.redirected === true &&
          JSON.stringify(urls(cross)) === JSON.stringify(["https://declared.test/cross", "https://other.test/landing"]) &&
          hdr(cross, 1).authorization === undefined && hdr(cross, 1).cookie === undefined &&
          hdr(cross, 1)["proxy-authorization"] === undefined && hdr(cross, 1)["x-custom"] === "keep",
        `${s(cross)} · 2번째 헤더 ${JSON.stringify(hdr(cross, 1)).slice(0, 200)}`,
      ),
      assert(
        "상대 경로 Location 은 현재 URL 기준으로 풀고, 같은 출처면 자격 헤더를 유지한다",
        rel.ok === true && rel.url === "https://declared.test/same/path?q=1" && hdr(rel, 1).authorization === "Bearer T",
        s(rel),
      ),
      assert(
        `★상한: ${MAX}번 따라가면 성공(요청 ${MAX + 1}) · ${MAX + 1}번째 리다이렉트는 던지고 그 Location 엔 요청 0 · 순환도 같은 자리에서 끝`,
        chainMax.ok === true && (chainMax.wire ?? []).length === MAX + 1 &&
          blocked(chainOver, MAX + 1) && !urls(chainOver).includes(`https://declared.test/long${MAX + 1}`) &&
          blocked(cycle, MAX + 1),
        `max: ${s(chainMax)} | over: ${s(chainOver)} | cycle: ok=${cycle.ok} n=${(cycle.wire ?? []).length}`,
      ),
      assert("★빈 선언 — 집행 함수가 던지고 요청 0", blocked(empty, 0) && /없음/.test(empty.error ?? ""), s(empty)),
      assert(
        "★호스트 부분 일치·userinfo·평문 — 첫 URL 로는 요청 0, 리다이렉트로는 선언 호스트 한 번만",
        trickFirst.length === 4 && trickFirst.every((x) => blocked(x, 0)) &&
          trickRedirect.length === 4 && trickRedirect.every((x) => blocked(x, 1)),
        `first=${trickFirst.map((x) => `${x.ok}/${(x.wire ?? []).length}`).join(",")} redirect=${trickRedirect
          .map((x) => `${x.ok}/${urls(x).join(">")}`)
          .join(" , ")}`,
      ),
      assert(
        "메서드·본문은 fetch 표준대로 — 302 POST→GET(본문·본문 헤더 제거, 일반 헤더 유지) · 303 PUT→GET · 307 POST·301 PUT 유지",
        post302.ok === true && post302.wire?.[1]?.method === "GET" && post302.wire?.[1]?.body === "" &&
          hdr(post302, 1)["content-type"] === undefined && hdr(post302, 1)["content-language"] === undefined &&
          hdr(post302, 1)["x-custom"] === "keep" &&
          put303.wire?.[1]?.method === "GET" && put303.wire?.[1]?.body === "" &&
          post307.wire?.[1]?.method === "POST" && post307.wire?.[1]?.body === "B" &&
          put301.wire?.[1]?.method === "PUT" && put301.wire?.[1]?.body === "B",
        `302: ${s(post302)} | 303: ${s(put303)} | 307: ${s(post307)} | 301: ${s(put301)}`,
      ),
      assert(
        "다시 보낼 수 없는 본문(스트림·비동기 반복자) + 307 — 안전하게 실패(두 번째 요청 0) · 303 이면 본문 없는 GET 으로 따라감",
        blocked(stream307, 1) && blocked(o("iterable307"), 1) &&
          o("iterable303").ok === true && o("iterable303").wire?.[1]?.method === "GET" && o("iterable303").wire?.[1]?.body === "",
        `stream: ${s(stream307)} | iterable: ${s(o("iterable307"))} | 303: ${s(o("iterable303"))}`,
      ),
      assert(
        "본문 source 는 처음에 고정 — 문자열로 바뀌는 객체는 두 hop 이 같은 값 · URLSearchParams·ArrayBuffer·오프셋 view 는 hop 사이 변경과 무관하게 처음 값(표준 — Node 22 는 버퍼 307 에서 실패)",
        JSON.stringify((o("toStringBody").wire ?? []).map((w) => w.body)) === JSON.stringify(["S1", "S1"]) &&
          JSON.stringify((o("uspBody").wire ?? []).map((w) => w.body)) === JSON.stringify(["a=1", "a=1"]) &&
          JSON.stringify((o("abBody").wire ?? []).map((w) => w.body)) === JSON.stringify(["ABC", "ABC"]) &&
          JSON.stringify((o("viewBody").wire ?? []).map((w) => w.body)) === JSON.stringify(["ABC", "ABC"]),
        `toString: ${s(o("toStringBody"))} | usp: ${s(o("uspBody"))} | ab: ${s(o("abBody"))} | view: ${s(o("viewBody"))}`,
      ),
      assert(
        "same-origin 의 같은 출처 자격 증명 Location — userinfo 없이 요청하며 따라가고(같은 출처라 authorization 유지) 응답·복제본 url 엔 userinfo 는 남고 조각은 빠진다",
        o("credSameOrigin").ok === true &&
          JSON.stringify(urls(o("credSameOrigin"))) === JSON.stringify(["https://declared.test/credsame", "https://declared.test/cred-end"]) &&
          hdr(o("credSameOrigin"), 1).authorization === "Bearer T" &&
          o("credSameOrigin").url === "https://u:p@declared.test/cred-end" && o("credSameOrigin").cloneUrl === "https://u:p@declared.test/cred-end",
        s(o("credSameOrigin")) + ` url=${o("credSameOrigin").url} clone=${o("credSameOrigin").cloneUrl}`,
      ),
      assert(
        "Location 없음은 그 응답 그대로 · 잘못된·자격 증명 든 Location 은 던지고 다음 요청 0",
        noLoc.ok === true && noLoc.status === 302 && (noLoc.wire ?? []).length === 1 && blocked(badLoc, 1) && blocked(credLoc, 1),
        `noloc: ${s(noLoc)} | bad: ${s(badLoc)} | cred: ${s(credLoc)}`,
      ),
      assert(
        "호출자 redirect 옵션 존중 — manual 은 3xx 를 그대로(따라가지 않음) · error 는 던짐 · 둘 다 요청 1",
        manual.ok === true && manual.status === 302 && (manual.wire ?? []).length === 1 && blocked(err, 1),
        `manual: ${s(manual)} | error: ${s(err)}`,
      ),
      assert(
        "★호출자 신호가 모든 hop 에 그대로 실린다 · hop 사이에 끊기면 다음 요청 0 · 이미 끊긴 신호·상속된 신호면 요청 0",
        g.signalEveryHop === true && o("signalHops").ok === true &&
          between.errorName === "AbortError" && (between.wire ?? []).length === 1 &&
          pre.errorName === "AbortError" && (pre.wire ?? []).length === 0 &&
          inh.errorName === "AbortError" && (inh.wire ?? []).length === 0,
        `everyHop=${g.signalEveryHop} | between: ${between.errorName} ${s(between)} | pre: ${pre.errorName} n=${(pre.wire ?? []).length} | 상속: ${inh.errorName} n=${(inh.wire ?? []).length}`,
      ),
      assert(
        "메서드 정규화·보존 — 소문자 post 의 302 도 GET(본문 헤더 제거) · 303 HEAD 는 HEAD · 선언 안 308 은 메서드·본문 유지",
        lower.wire?.[1]?.method === "GET" && lower.wire?.[1]?.body === "" && hdr(lower, 1)["content-type"] === undefined &&
          head.ok === true && head.wire?.[1]?.method === "HEAD" &&
          p308.ok === true && p308.wire?.[1]?.method === "POST" && p308.wire?.[1]?.body === "B" &&
          p308.wire?.[1]?.url === "https://other.test/after",
        `lower: ${s(lower)} | head: ${s(head)} | 308: ${s(p308)}`,
      ),
      assert(
        "★옵션은 한 번만 읽는다 — String 객체 follow 도 선언 대조를 거쳐 던지고(선언 밖 요청 0) · getter·toString 이 바뀌어도 처음 값(manual)으로 고정 · 상속된 redirect 도 읽는다",
        blocked(strF, 1) && noOutside(strF) && getter.ok === true && getter.status === 302 && (getter.wire ?? []).length === 1 &&
          o("inheritedRedirect").ok === true && o("inheritedRedirect").status === 302 && (o("inheritedRedirect").wire ?? []).length === 1 &&
          o("toStringRedirect").ok === true && o("toStringRedirect").status === 307 && (o("toStringRedirect").wire ?? []).length === 1 &&
          noOutside(o("toStringRedirect")),
        `String: ${s(strF)} | getter: ${s(getter)} | 상속: ${s(o("inheritedRedirect"))} | toString: ${s(o("toStringRedirect"))}`,
      ),
      assert(
        "mode same-origin — 선언된 다른 출처라도 그 hop 전에 던짐(요청 1, String 객체로 줘도) · 같은 출처 리다이렉트는 따라감",
        blocked(soX, 1) && soS.ok === true && (soS.wire ?? []).length === 2 && blocked(o("sameOriginObject"), 1),
        `cross: ${s(soX)} | same: ${s(soS)} | String 객체: ${s(o("sameOriginObject"))}`,
      ),
      assert(
        "따라간 응답은 내장 fetch 처럼 — 교차 출처면 type cors(처음 출처로 돌아와도 유지) · 같은 출처면 basic · 복제본도 redirected·type 이 같다",
        cross.type === "cors" && cross.cloneType === "cors" && cross.cloneRedirected === true &&
          o("abaTaint").type === "cors" && o("abaTaint").cloneType === "cors" && o("abaTaint").url === "https://declared.test/aba-end" &&
          rel.type === "basic" && rel.cloneRedirected === true && o("noLocation").redirected === false,
        `cross: ${cross.type}/${cross.cloneType}/${cross.cloneRedirected} | aba: ${o("abaTaint").type}/${o("abaTaint").cloneType} ${o("abaTaint").url} | rel: ${rel.type}/${rel.cloneRedirected} | noloc: ${o("noLocation").redirected}`,
      ),
      assert(
        "버린 리다이렉트 응답의 연결을 반납한다(본문을 끝내지 않은 302 가 취소된다)",
        JSON.stringify(g.released) === JSON.stringify(["https://declared.test/partial"]) && o("partial").ok === true,
        `released=${JSON.stringify(g.released)} · ${s(o("partial"))}`,
      ),
    ];
  },
};
