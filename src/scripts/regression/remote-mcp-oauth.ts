/**
 * 회귀: **원격 MCP OAuth — 로그인·저장·갱신·삭제가 코어 한 곳에서 맞게 돈다** (2026-10-18, 원격 MCP 2단계 1묶음 · 아스트라 회신 «1차 범위와 검증»).
 *
 * 로컬에 **가짜 인가 서버 + 보호된 MCP 서버**를 한 원점에 띄운다(RFC 9728 보호 자원 메타데이터 · RFC 8414 인가 서버 메타데이터 · RFC 7591 동적 등록 ·
 *  PKCE S256 검증 · refresh 토큰 회전). 본다:
 *  ① 토큰 없이 연결 → 401 → «인증 필요» 로 적힘(브리지 경로)
 *  ② 로그인 시작 = 인가 URL(링크 생성 ≠ 성공) · 브라우저 대신 따라간 콜백의 code·state 로 완료 · 같은 state 두 번째는 «이미 씀»(교환 한 번) · 엉뚱한 state 거절
 *  ③ 로그인 뒤 — Claude 경로가 받는 설정에 Bearer 합성 · 브리지가 그 토큰으로 실제 연결·호출 · 사용자가 Authorization 을 준 서버엔 합성 안 함
 *  ④ 만료 임박 → 동시 요청 5개에 갱신 **1회**(회전형 refresh 경합 없음) · 갱신 거절(invalid_grant) → «로그인 필요» · 일시 실패(서버 오류) → 안 만료된 토큰 유지
 *  ⑤ 서버 제거 → 로컬 기록 삭제 · 제거 뒤 늦게 온 완료는 «stale» 로 버림(인증이 되살아나지 않는다)
 *  ⑥ code·state·verifier·access·refresh 토큰이 로그에 안 남는다
 *  ⑬ 발급 서버 표식(`issuer`) — 갱신 뒤에도 유지 · 옛 기록은 갱신 후 묶임 · 다른 인가 서버에 묶인 것은 refresh 를 안 보낸다(만료 전 토큰은 그대로)
 *  ⑭ 자원 지시자 — 경로 없는 자원에서 로그인·갱신의 resource 가 같다 · 같은 기록으로 우리 갱신과 SDK `auth()` 갱신 요청이 같다
 *  ⑮ 인증 상태 기록이 실패하면 서버 이름·오류 코드만 경고로 남고 상태는 «인증 필요» 로 보이지 않는다(①·⑦ 은 고정 대기 없이 기록 완료 뒤 읽는다)
 * 등급: **실행**(격리 홈 · 같은 프로세스의 실제 HTTP 서버들). 실서비스 로그인은 하지 않는다.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { startFakeOAuthMcp } from "./_fake-oauth-server.js";


export const check: RegressionCheck = {
  name: "remote-mcp-oauth",
  guards: "원격 MCP 의 OAuth 로그인 서버(Notion·Atlassian 류)에 붙을 길이 없던 것 + 그 인증을 세 어댑터가 같은 토큰으로 쓰는 계약",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { getPaths } = await import("../../core/paths.js");
    const ext = await import("../../core/external-mcp.js");
    const oauth = await import("../../core/mcp-oauth.js");

    const fake = await startFakeOAuthMcp();
    const { as, origin, url } = fake;
    const redirectUrl = `http://127.0.0.1:1${oauth.MCP_OAUTH_CALLBACK_PATH}`; // 따라가지 않는다 — Location 만 읽는다

    const file = path.join(getPaths().home, "mcp.json");
    const prev = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    /** 그 줄이 남는 순간 — 기다리지 않는 백그라운드 경로(Claude init `failed` 의 확인)의 끝을 시간 대신 이 사건으로 안다. */
    const warns: string[] = [];
    const logWaiters = new Set<{ test: (l: string) => boolean; done: () => void }>();
    const nextLog = (test: (l: string) => boolean): Promise<void> => new Promise((done) => void logWaiters.add({ test, done }));
    for (const m of ["log", "warn", "error"] as const)
      console[m] = (...a: unknown[]) => {
        const line = a.map(String).join(" ");
        logs.push(line);
        if (m === "warn") warns.push(line); // 경고 수준만 — 기록 실패는 «경고» 로 남아야 한다(독립 변이 사냥: log 로 낮춰도 초록이었다)
        for (const w of logWaiters) if (w.test(line)) (logWaiters.delete(w), w.done());
      };
    /** 실패 판정 전용 시한 — 정상 경로는 사건이 오는 즉시 끝나 이 시간을 쓰지 않는다. 사건이 안 오면(변이) 매달리지 않고 «timeout» 으로 빨개진다. */
    const within = <T>(p: Promise<T>, ms = 10_000): Promise<T | "timeout"> => {
      let t: NodeJS.Timeout | undefined;
      return Promise.race([p, new Promise<"timeout">((r) => (t = setTimeout(() => r("timeout"), ms)))]).finally(() => clearTimeout(t));
    };
    /** 인증 상태 기록 실패 경고의 허용 형식 — 서버 이름과 오류 코드(또는 오류 이름)뿐. 메시지·경로·그 밖의 값이 붙으면 맞지 않는다. */
    const AUTH_NOTE_WARN = /^external-mcp: '[A-Za-z0-9_-]+' 인증 상태 기록 실패 — [A-Za-z0-9_]+$/;
    const key = { file, name: "oauthsrv", url };
    const follow = async (authUrl: string): Promise<string> => (await fetch(authUrl, { redirect: "manual" })).headers.get("location") ?? "";
    /** 기록을 지우고 지금 `as.expiresIn` 으로 새로 로그인한다. */
    const loginFresh = async (k: { file: string; name: string; url: string }): Promise<void> => {
      await oauth.forgetMcpOAuth(k.file, k.name);
      const st = await oauth.startMcpLogin(k, redirectUrl);
      const pp = st.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(st.url)) : null;
      if (pp !== null) await oauth.completeMcpLogin(pp);
    };
    try {
      writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url }, withheader: { type: "http", url, headers: { authorization: "Bearer user-given" } } } }));

      // ① 토큰 없이 → 401 → 인증 필요. 연결 시도의 끝(턴이 기다리는 그것)이 기록까지 포함한다 — 고정 대기 없이 바로 읽는다(v8 Windows: 50ms 대기가 느린 쓰기를 못 기다렸다).
      const tConn1 = Date.now();
      for (const b of await ext.getConnectedExternalMcpBridges()) await b.close();
      const waited1 = Date.now() - tConn1; // 실패 진단용 — 연결 시도(기록 포함)를 기다린 시간
      out.push(assert("① 토큰 없이 연결 → 401 → «인증 필요»(login-needed) 로 적힌다", (await oauth.mcpOAuthStatus(key)) === "login-needed",
        `${await oauth.mcpOAuthStatus(key)} (연결 시도·기록 대기 ${waited1}ms)`));

      // ② 로그인
      const started = await oauth.startMcpLogin(key, redirectUrl);
      const loc = started.status === "redirect" ? await follow(started.url) : "";
      const parsed = oauth.parseMcpOAuthRedirect(loc);
      const wrong = await oauth.completeMcpLogin({ state: "not-a-real-state", code: "x" });
      const done = parsed === null ? { ok: false } : await oauth.completeMcpLogin(parsed);
      const again = parsed === null ? { ok: true } : await oauth.completeMcpLogin(parsed);
      out.push(assert("★② 로그인 시작 → 인가 URL · 콜백의 code·state 로 완료 · 같은 state 두 번째는 «이미 씀» · 엉뚱한 state 거절",
        started.status === "redirect" && parsed !== null && done.ok === true && again.ok === false &&
          (again as { reason?: string }).reason === "unknown-or-used" && (wrong as { reason?: string }).reason === "unknown-or-used" &&
          (await oauth.mcpOAuthStatus(key)) === "authorized",
        JSON.stringify({ started: started.status, parsed: parsed !== null, done, again, wrong })));
      const elsewhere = oauth.parseMcpOAuthRedirect(`${origin}/elsewhere?code=a&state=b`);
      const noCode = oauth.parseMcpOAuthRedirect(`http://127.0.0.1:1${oauth.MCP_OAUTH_CALLBACK_PATH}?state=b`);
      out.push(assert("② 붙여넣기 파싱 — 콜백 경로가 아닌 URL·code 없는 URL 은 받지 않는다",
        elsewhere === null && noCode === null, JSON.stringify({ elsewhere, noCode })));

      // ③ 합성 · 브리지 연결 — 사용자 헤더 서버에도 로그인 기록을 만들어 «있어도 덮지 않는다» 를 본다
      const wkey = { file, name: "withheader", url };
      const sw = await oauth.startMcpLogin(wkey, redirectUrl);
      const pw = sw.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(sw.url)) : null;
      if (pw !== null) await oauth.completeMcpLogin(pw);
      const forClaude = await ext.readExternalMcpServers();
      const injected = (forClaude.oauthsrv as { headers?: Record<string, string> }).headers?.Authorization ?? "";
      const userGiven = (forClaude.withheader as { headers?: Record<string, string> }).headers ?? {};
      await ext.closeAllExternalMcp();
      const bridges = await ext.getConnectedExternalMcpBridges();
      const b = bridges.find((x) => x.name === "oauthsrv");
      const called = b === undefined ? "" : JSON.stringify(await b.callTool("whoami", {}));
      for (const x of bridges) await x.close();
      out.push(assert("★③ 로그인 뒤 — Claude 경로 설정에 Bearer 합성 · 브리지가 그 토큰으로 실제 연결·호출 · 사용자 Authorization 엔 손대지 않음",
        injected.startsWith("Bearer at-") && called.includes("OAUTH-OK") && userGiven.authorization === "Bearer user-given" && userGiven.Authorization === undefined,
        JSON.stringify({ injected: injected.slice(0, 10), called: called.slice(0, 40), userGiven: Object.keys(userGiven) })));

      // ④ 갱신 — 만료 임박을 만들려고 짧은 토큰으로 다시 로그인한다
      as.expiresIn = 60;
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const s2 = await oauth.startMcpLogin(key, redirectUrl);
      const p2 = s2.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(s2.url)) : null;
      if (p2 !== null) await oauth.completeMcpLogin(p2);
      as.expiresIn = 3600;
      const before = as.refreshCalls;
      const got = await Promise.all(Array.from({ length: 5 }, () => oauth.mcpAccessToken(key)));
      const calls = as.refreshCalls - before;
      out.push(assert("★④ 만료 임박 → 동시 요청 5개에 갱신 1회 · 모두 같은 새 토큰(회전형 refresh 경합 없음)",
        calls === 1 && new Set(got).size === 1 && got[0] !== undefined && as.access.has(got[0]!), JSON.stringify({ calls, distinct: new Set(got).size })));

      // 일시 실패 — 서버 오류면 안 만료된 토큰 유지
      as.expiresIn = 60;
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const s3 = await oauth.startMcpLogin(key, redirectUrl);
      const p3 = s3.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(s3.url)) : null;
      if (p3 !== null) await oauth.completeMcpLogin(p3);
      as.refreshMode = "server_error";
      const kept = await oauth.mcpAccessToken(key);
      const statusAfterTransient = await oauth.mcpOAuthStatus(key);
      // ★일시 실패 뒤엔 잠시 다시 갱신하지 않는다(⑧) — 거절 경우는 새로 로그인해서 본다.
      await loginFresh(key);
      as.refreshMode = "invalid_grant";
      const rejected = await oauth.mcpAccessToken(key);
      const statusAfterReject = await oauth.mcpOAuthStatus(key);
      as.refreshMode = "ok";
      out.push(assert("④ 갱신 일시 실패(서버 오류) → 안 만료된 토큰 유지·상태 그대로 / 거절(invalid_grant) → 토큰 없음·«로그인 필요»",
        kept !== undefined && statusAfterTransient === "authorized" && rejected === undefined && statusAfterReject === "login-needed",
        JSON.stringify({ kept: kept !== undefined, statusAfterTransient, rejected: rejected !== undefined, statusAfterReject })));

      // ⑧ 인가 서버가 답하지 않는다 — 턴은 짧게만 기다리고(아직 유효한 토큰으로 간다), 서버끼리 함께 기다리며, 일시 실패 뒤엔 잠시 안 매달린다.
      //  ★없을 때: 서버마다 기본 시한(~5분)을 차례로 매 턴 기다렸다(적대 검토 P1 — 3개에 904초).
      const hangKeys = ["hang1", "hang2", "hang3"].map((name) => ({ file, name, url }));
      writeFileSync(file, JSON.stringify({ mcpServers: Object.fromEntries(hangKeys.map((k) => [k.name, { type: "http", url }])) }));
      as.expiresIn = 60;
      for (const k of hangKeys) await loginFresh(k);
      as.expiresIn = 3600;
      as.refreshMode = "hang";
      const t0 = Date.now();
      const hungRead = await ext.readExternalMcpServers();
      const hungMs = Date.now() - t0;
      const allHaveToken = hangKeys.every((k) => ((hungRead[k.name] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization ?? "").startsWith("Bearer at-"));
      // ★손으로 끊지 않는다 — 갱신 요청 자체의 시한(10초)이 매달린 요청을 끊어야 한다(없으면 그 갱신이 영원히 남아 매 턴 3초씩 기다린다).
      const tCut = Date.now();
      while (as.held.some((r) => !r.destroyed && !(r.socket?.destroyed ?? true)) && Date.now() - tCut < 14_000) await new Promise((r) => setTimeout(r, 200));
      const clientCutMs = Date.now() - tCut;
      await new Promise((r) => setTimeout(r, 100));
      const hitsAfterFail = as.refreshCalls;
      const t1 = Date.now();
      await ext.readExternalMcpServers();
      const backoffMs = Date.now() - t1;
      out.push(assert("★⑧ 인가 서버 무응답 — 원격 셋을 함께 짧게(<4.5초) 기다리고 유효한 토큰으로 간다 · 갱신 요청은 자기 시한으로 끊긴다 · 일시 실패 뒤 바로 다시 매달리지 않는다(갱신 0회)",
        hungMs < 4_500 && allHaveToken && clientCutMs < 13_000 && as.refreshCalls === hitsAfterFail && backoffMs < 1_000,
        JSON.stringify({ hungMs, allHaveToken, clientCutMs, extraRefresh: as.refreshCalls - hitsAfterFail, backoffMs })));
      fake.release();
      as.refreshMode = "ok";
      for (const k of hangKeys) await oauth.forgetMcpOAuth(file, k.name);
      writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url }, withheader: { type: "http", url, headers: { authorization: "Bearer user-given" } } } }));

      // ⑨ 401 하나로 «로그인 필요» 가 되지 않는다 — 갱신을 한 번 해 보고, 그 새 토큰도 401 이면 그때. ★없을 때: 공급자가 토큰을 일찍
      //  무효화하거나 `expires_in` 을 안 주면 살아 있는 refresh 토큰을 버리고 영구 재로그인이 됐다(적대 검토 P2-1).
      await loginFresh(key);
      const tok1 = await oauth.mcpAccessToken(key);
      as.access.delete(tok1 ?? ""); // 공급자가 일찍 무효화
      // 실제 길로 — 브리지가 그 (무효) 토큰으로 붙어 401 을 받는다.
      await ext.closeAllExternalMcp();
      for (const b of await ext.getConnectedExternalMcpBridges()) await b.close();
      await new Promise((r) => setTimeout(r, 100));
      const statusAfter401 = await oauth.mcpOAuthStatus(key);
      const r0 = as.refreshCalls;
      const tok2 = await oauth.mcpAccessToken(key);
      const forcedRefreshes = as.refreshCalls - r0;
      // 늦게 온 401 — 헤더 없이 보낸 연결 · 옛 토큰으로 보낸 연결. **보낸 토큰**으로 판정하므로 새 토큰을 버리지 않는다(재검토 P2-a).
      await oauth.noteMcpUnauthorized(key, undefined);
      await oauth.noteMcpUnauthorized(key, tok1);
      const statusAfterLate401 = await oauth.mcpOAuthStatus(key);
      await oauth.noteMcpUnauthorized(key, tok2); // 새 토큰도 거절
      const statusAfterSecond401 = await oauth.mcpOAuthStatus(key);
      out.push(assert("★⑨ 401 → «로그인 필요» 아님 · 다음 읽기가 갱신 1회로 새 토큰 · 늦게 온 401(헤더 없음·옛 토큰)은 무시 · 그 새 토큰으로 성공 전에 401 이면 그때 «로그인 필요»",
        statusAfter401 === "authorized" && forcedRefreshes === 1 && tok2 !== undefined && tok2 !== tok1 && as.access.has(tok2) &&
          statusAfterLate401 === "authorized" && statusAfterSecond401 === "login-needed",
        JSON.stringify({ statusAfter401, forcedRefreshes, newToken: tok2 !== undefined && tok2 !== tok1, statusAfterLate401, statusAfterSecond401 })));

      // ⑨b 강제 갱신 토큰으로 **인증에 성공한 뒤**의 401 은 «새 토큰도 거절» 이 아니다 — 다시 갱신(아스트라 회신 Q2: 고정 10분 창 대신 증거로).
      await loginFresh(key);
      const b1 = await oauth.mcpAccessToken(key);
      as.access.delete(b1 ?? "");
      await oauth.noteMcpUnauthorized(key, b1);
      const b2 = await oauth.mcpAccessToken(key); // 강제 갱신
      await ext.closeAllExternalMcp();
      const okBridges = await ext.getConnectedExternalMcpBridges(); // b2 로 실제 연결 성공 → 검증됨
      const connectedWithB2 = okBridges.some((x) => x.name === "oauthsrv");
      for (const x of okBridges) await x.close();
      as.access.delete(b2 ?? ""); // 한참 쓰다가 공급자가 무효화
      await oauth.noteMcpUnauthorized(key, b2);
      const statusAfterVerified401 = await oauth.mcpOAuthStatus(key);
      const rb = as.refreshCalls;
      const b3 = await oauth.mcpAccessToken(key);
      const refreshesAfterVerified = as.refreshCalls - rb;
      // 만료 시각이 이미 지난 강제 갱신 토큰의 401 — 정상 만료(검증 전이어도 «로그인 필요» 아님). 새 로그인에서 따로 본다
      //  (b3 는 아직 검증 안 된 강제 갱신 토큰이라 그 401 은 규칙대로 «로그인 필요» 다).
      await loginFresh(key);
      const x1 = await oauth.mcpAccessToken(key);
      as.access.delete(x1 ?? "");
      await oauth.noteMcpUnauthorized(key, x1);
      as.expiresIn = 0;
      const e1 = await oauth.mcpAccessToken(key); // 강제 갱신 — 받자마자 만료
      as.expiresIn = 3600;
      await oauth.noteMcpUnauthorized(key, e1);
      const statusAfterExpired401 = await oauth.mcpOAuthStatus(key);
      out.push(assert("★⑨b 강제 갱신 토큰으로 연결에 성공한 뒤의 401 → 다시 갱신(로그인 필요 아님) · 만료 시각이 지난 토큰의 401 도 정상 만료",
        connectedWithB2 && statusAfterVerified401 === "authorized" && refreshesAfterVerified === 1 && b3 !== undefined && b3 !== b2 && statusAfterExpired401 === "authorized",
        JSON.stringify({ connectedWithB2, statusAfterVerified401, refreshes: refreshesAfterVerified, statusAfterExpired401 })));

      // ⑨c **옛 토큰**의 성공은 새 강제 갱신 토큰을 검증하지 않는다 — 검증은 그 토큰 자신의 성공만(재검토 10-18 그물 구멍).
      await loginFresh(key);
      const c1 = await oauth.mcpAccessToken(key);
      as.access.delete(c1 ?? "");
      await oauth.noteMcpUnauthorized(key, c1);
      const c2 = await oauth.mcpAccessToken(key);
      oauth.noteMcpAuthorized(key, c1);
      await oauth.noteMcpUnauthorized(key, c2);
      out.push(assert("⑨c 옛 토큰의 연결 성공은 새 강제 갱신 토큰을 «검증됨» 으로 만들지 않는다 — 새 토큰의 401 은 그대로 «로그인 필요»",
        c2 !== c1 && (await oauth.mcpOAuthStatus(key)) === "login-needed", await oauth.mcpOAuthStatus(key)));

      // ⑩ 엇갈린 동시 요청 — 갱신이 끝나기 직전에 옛 기록을 읽은 요청이 회전된 refresh 로 두 번째 갱신을 하지 않는다(적대 검토 P2-2).
      as.expiresIn = 60;
      await loginFresh(key);
      as.expiresIn = 3600;
      const r1 = as.refreshCalls;
      // 1ms 마다 10개씩 80ms — 갱신 기록이 바뀌는 순간에 읽기가 걸쳐 있게(성기게 두면 30번에 1번꼴로만 드러났다).
      //  ★확률적 그물이다 — 수정을 되돌리는 변이(작업 안 재읽기 → 밖 사본)를 실행마다 약 3번에 1번 잡는다(2026-10-18 실측).
      const staggered = await Promise.all(Array.from({ length: 800 }, (_, i) => new Promise<string | undefined>((res) => setTimeout(() => void oauth.mcpAccessToken(key).then(res), Math.floor(i / 10)))));
      const staggeredCalls = as.refreshCalls - r1;
      out.push(assert("★⑩ 0~80ms 에 엇갈려 온 800개 — 갱신 정확히 1회 · 전부 살아 있는 토큰 · «로그인 필요» 안 됨",
        staggeredCalls === 1 && staggered.every((t) => t !== undefined && as.access.has(t)) && (await oauth.mcpOAuthStatus(key)) === "authorized",
        JSON.stringify({ staggeredCalls, missing: staggered.filter((t) => t === undefined).length, status: await oauth.mcpOAuthStatus(key) })));

      // ⑪ 브리지 포트가 바뀌었다 — 등록한 클라이언트는 옛 콜백 주소에 묶여 있으니 다시 등록한다(리뷰 10-18: 공급자가 redirect_uri 불일치로 영구 거절).
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const sa = await oauth.startMcpLogin(key, redirectUrl); // 옛 포트로 등록만 해 둔다(완료하지 않음)
      const otherPort = `http://127.0.0.1:2${oauth.MCP_OAUTH_CALLBACK_PATH}`;
      const sb = await oauth.startMcpLogin(key, otherPort);
      const locB = sb.status === "redirect" ? await follow(sb.url) : "";
      out.push(assert("⑪ 브리지 포트가 바뀌면 클라이언트를 다시 등록한다 — 새 콜백 주소로 인가가 이어진다",
        sa.status === "redirect" && locB.startsWith(`${otherPort}?`), JSON.stringify({ sa: sa.status, locB: locB.slice(0, 60) })));
      // ⑪b 새 포트로 로그인을 시작만 하고 마치지 않았다 — 옛 클라이언트의 refresh 는 그대로 돈다(공급자는 refresh 를 클라이언트에 묶는다).
      //  ★다시 등록한 클라이언트를 시작 때 기록에 넣으면 다음 갱신이 새 client_id 로 나가 거절 → 영구 재로그인(재검토 10-18).
      as.expiresIn = 60;
      await loginFresh(key);
      as.expiresIn = 3600;
      await oauth.startMcpLogin(key, `http://127.0.0.1:3${oauth.MCP_OAUTH_CALLBACK_PATH}`);
      const afterAbandon = await oauth.mcpAccessToken(key);
      out.push(assert("★⑪b 새 포트로 로그인을 시작만 하고 버려도 — 옛 클라이언트의 refresh 로 갱신이 된다",
        afterAbandon !== undefined && as.access.has(afterAbandon) && (await oauth.mcpOAuthStatus(key)) === "authorized",
        JSON.stringify({ token: afterAbandon !== undefined, status: await oauth.mcpOAuthStatus(key) })));
      // ⑫ refresh 를 안 주는 공급자 — 옛 토큰의 늦은 401 이 방금 한 로그인을 버리지 않는다(재검토 10-18).
      as.noRefresh = true;
      await loginFresh(key);
      const n1 = await oauth.mcpAccessToken(key);
      await loginFresh(key);
      const n2 = await oauth.mcpAccessToken(key);
      await oauth.noteMcpUnauthorized(key, n1);
      const statusOldLate = await oauth.mcpOAuthStatus(key);
      await oauth.noteMcpUnauthorized(key, n2);
      const statusCurrent = await oauth.mcpOAuthStatus(key);
      as.noRefresh = false;
      out.push(assert("⑫ refresh 없는 공급자 — 옛 토큰의 늦은 401 은 무시 · 지금 토큰의 401 은 «로그인 필요»(갱신할 길이 없다)",
        n1 !== n2 && statusOldLate === "authorized" && statusCurrent === "login-needed", JSON.stringify({ statusOldLate, statusCurrent })));

      // ⑬ 발급 서버 묶음(`issuer`) — SDK 1.32 가 로그인 때 토큰·클라이언트에 찍는 표식을 **우리 갱신**도 지키고 쓴다(GPT 검토 10-25).
      //  ★없을 때: 첫 자체 갱신이 토큰 표식을 지웠고(전체 교체 저장), 다른 인가 서버에 찍힌 refresh 토큰도 그대로 보낼 수 있었다.
      const recOf = (k: { name: string; url: string }): { f: string; r: Record<string, any> } | undefined => {
        const dir = path.join(getPaths().home, "mcp-oauth");
        for (const n of existsSync(dir) ? readdirSync(dir) : []) {
          if (!n.endsWith(".json")) continue;
          const f = path.join(dir, n);
          const r = JSON.parse(readFileSync(f, "utf8")) as Record<string, any>;
          if (r.name === k.name && r.url === k.url) return { f, r };
        }
        return undefined;
      };
      const sameAs = (v: unknown): boolean => typeof v === "string" && new URL(v).href === new URL(origin).href;
      as.expiresIn = 60; // 읽을 때마다 갱신하게
      await loginFresh(key);
      const stamped = recOf(key)?.r;
      const rs0 = as.refreshCalls;
      const g1 = await oauth.mcpAccessToken(key);
      const g2 = await oauth.mcpAccessToken(key);
      const afterTwo = recOf(key)?.r;
      out.push(assert("★⑬ 로그인이 찍은 발급 서버 표식이 갱신 두 번 뒤에도 토큰·클라이언트에 남는다",
        sameAs(stamped?.tokens?.issuer) && sameAs(stamped?.client?.issuer) && as.refreshCalls - rs0 === 2 && g1 !== g2 && g2 !== undefined &&
          sameAs(afterTwo?.tokens?.issuer) && sameAs(afterTwo?.client?.issuer),
        JSON.stringify({ login: [stamped?.tokens?.issuer, stamped?.client?.issuer], refreshes: as.refreshCalls - rs0, after: [afterTwo?.tokens?.issuer ?? null, afterTwo?.client?.issuer ?? null] })));
      // 옛 판이 저장한 기록(표식 없음) — 그대로 갱신되고, 받아 준 이 서버로 묶인다.
      const legacy = recOf(key)!;
      delete legacy.r.tokens.issuer;
      delete legacy.r.client.issuer;
      writeFileSync(legacy.f, JSON.stringify(legacy.r));
      const rs1 = as.refreshCalls;
      const gLegacy = await oauth.mcpAccessToken(key);
      const afterLegacy = recOf(key)?.r;
      out.push(assert("★⑬ 표식 없는 옛 기록 — 갱신이 되고(로그인 필요 아님) 그 뒤 토큰·클라이언트가 이 서버로 묶인다",
        gLegacy !== undefined && as.access.has(gLegacy) && as.refreshCalls - rs1 === 1 && sameAs(afterLegacy?.tokens?.issuer) && sameAs(afterLegacy?.client?.issuer) &&
          (await oauth.mcpOAuthStatus(key)) === "authorized",
        JSON.stringify({ token: gLegacy !== undefined, refreshes: as.refreshCalls - rs1, after: [afterLegacy?.tokens?.issuer ?? null, afterLegacy?.client?.issuer ?? null] })));
      // 다른 인가 서버에 찍힌 토큰 / 클라이언트 — 이 서버에 refresh 를 **보내지 않는다**. 만료 전이면 그 액세스 토큰을 그대로 쓰고(refresh 없는 분기와
      //  같은 규칙 · SDK 전송도 액세스 토큰은 발급 서버를 안 보고 401 까지 쓴다), 만료됐으면 «로그인 필요».
      //  ★없을 때: 아직 유효한 토큰도 갱신 창(만료 5분 전)에 들어서는 순간 버려 잘 되던 연결이 먼저 끊겼다(독립 검토 10-25).
      const elsewhereRuns: Array<{ which: string; expired: boolean; posted: number; status: string; token: boolean }> = [];
      for (const which of ["tokens", "client"] as const) {
        for (const expired of [false, true]) {
          await loginFresh(key);
          const e = recOf(key)!;
          e.r[which].issuer = "http://127.0.0.1:1/";
          if (expired) e.r.expiresAt = Date.now() - 1000;
          writeFileSync(e.f, JSON.stringify(e.r));
          const rs2 = as.refreshCalls;
          const t = await oauth.mcpAccessToken(key);
          elsewhereRuns.push({ which, expired, posted: as.refreshCalls - rs2, status: await oauth.mcpOAuthStatus(key), token: t !== undefined && as.access.has(t) });
        }
      }
      out.push(assert("★⑬ 다른 인가 서버에 묶인 토큰·클라이언트 — refresh 요청 0건 · 만료 전이면 그 토큰을 그대로(상태 유지) · 만료됐으면 «로그인 필요»",
        elsewhereRuns.length === 4 && elsewhereRuns.every((x) => x.posted === 0 && (x.expired ? x.status === "login-needed" && !x.token : x.status === "authorized" && x.token)),
        JSON.stringify(elsewhereRuns)));
      // 같은 상황(만료 전 · 갱신 창 안)을 여러 번 읽는다 — 첫 감지에 경고 한 줄(만료 시각과 함께), 그 뒤엔 갱신 작업(탐색)을 다시 돌리지 않는다.
      //  401 이 오면(강제 갱신) 그 칸을 건너뛰어 바로 «로그인 필요». ★없을 때: 만료 5분 전부터 호출마다 갱신 작업이 다시 돌고(탐색 캐시가 없으면
      //  호출마다 탐색 2회), 만료 순간까지 로그가 0줄이었다(독립 검토 10-25 B-5 — 실측).
      {
        await loginFresh(key);
        const e = recOf(key)!;
        e.r.tokens.issuer = "http://127.0.0.1:1/";
        delete e.r.discovery; // 탐색 캐시 없음 — 반복이 네트워크로 드러나는 모양
        writeFileSync(e.f, JSON.stringify(e.r));
        const realFetch = globalThis.fetch;
        let probes = 0;
        globalThis.fetch = ((u: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (String(u instanceof Request ? u.url : u).includes("/.well-known/")) probes += 1;
          return realFetch(u, init);
        }) as typeof fetch;
        const l0 = logs.length;
        let toks: Array<string | undefined> = [];
        let probesAfterFirst = -1;
        try {
          toks.push(await oauth.mcpAccessToken(key));
          const p1 = probes;
          toks.push(await oauth.mcpAccessToken(key), await oauth.mcpAccessToken(key));
          probesAfterFirst = probes - p1;
        } finally {
          globalThis.fetch = realFetch;
        }
        const warned = logs.slice(l0).filter((x) => x.includes("다른 인가 서버에 묶여") && x.includes("만료("));
        await oauth.noteMcpUnauthorized(key, toks[0]);
        const afterUnauthorized = await oauth.mcpAccessToken(key);
        toks = toks.map((t) => (t === undefined ? undefined : as.access.has(t) ? "ok" : "unknown"));
        out.push(assert("★⑬ 다른 인가 서버 · 만료 전 반복 읽기 — 경고 1줄(만료 시각) · 첫 읽기 뒤 탐색 0회 · 토큰 그대로 · 401 이 오면 바로 «로그인 필요»",
          warned.length === 1 && probesAfterFirst === 0 && toks.every((t) => t === "ok") && afterUnauthorized === undefined &&
            (await oauth.mcpOAuthStatus(key)) === "login-needed",
          JSON.stringify({ warned: warned.length, probesAfterFirst, toks, afterUnauthorized: afterUnauthorized !== undefined, status: await oauth.mcpOAuthStatus(key) })));
      }
      // 만료 경계 — 갱신하지 않고 «아직 유효하면 그 토큰» 을 쓰는 두 분기(refresh 없음 · 다른 인가 서버)에서, 시계를 «k 번째 읽기부터 만료» 로 바꿔
      //  가며 쓸어 본다. 어느 순간 만료돼도 **토큰을 주거나, 아니면 «로그인 필요» 로 적는다** — 둘 다 아닌 결과(헤더 없이 연결 · 상태는 «인증됨»)는
      //  없다. ★없을 때: 유효 판정을 두 번 읽어 그 사이 만료되면 기록·로그 없이 undefined 로 빠졌다(독립 검토 10-25 A-2).
      {
        const sweep = async (which: "noRefresh" | "elsewhere"): Promise<{ bad: number[]; gave: number; marked: number }> => {
          const bad: number[] = [];
          let gave = 0;
          let marked = 0;
          for (let k = 0; k <= 12; k++) {
            as.noRefresh = which === "noRefresh";
            await loginFresh(key);
            as.noRefresh = false;
            const e = recOf(key)!;
            if (which === "elsewhere") {
              e.r.tokens.issuer = "http://127.0.0.1:1/";
              writeFileSync(e.f, JSON.stringify(e.r));
            }
            const exp = e.r.expiresAt as number;
            const realNow = Date.now;
            let reads = 0;
            Date.now = () => (reads++ < k ? exp - 1 : exp + 1);
            let t: string | undefined;
            try {
              t = await oauth.mcpAccessToken(key);
            } finally {
              Date.now = realNow;
            }
            const st = await oauth.mcpOAuthStatus(key);
            if (t !== undefined) gave += 1;
            else if (st === "login-needed") marked += 1;
            else bad.push(k);
          }
          return { bad, gave, marked };
        };
        const nr = await sweep("noRefresh");
        const el = await sweep("elsewhere");
        out.push(assert("★만료 경계 — refresh 없음 · 다른 인가 서버 두 분기 모두, 어느 순간 만료돼도 «토큰» 아니면 «로그인 필요»(둘 다 아닌 결과 0) · 쓸기가 양쪽 결과를 다 지난다",
          nr.bad.length === 0 && el.bad.length === 0 && nr.gave > 0 && nr.marked > 0 && el.gave > 0 && el.marked > 0,
          JSON.stringify({ noRefresh: nr, elsewhere: el })));
        // 정확히 만료 시각 — 그 순간부터 쓰지 않는다(두 분기 같은 규칙). ★없을 때: 위 쓸기는 만료 ±1ms 만 지나, 유효 판정 `>` 를 `>=` 로 넓혀
        //  만료 시각의 토큰을 내주고 «로그인 필요» 도 안 남기는 변이가 전체 초록으로 살아남았다(독립 재확증 10-25).
        const atExpiry = async (which: "noRefresh" | "elsewhere"): Promise<{ token: boolean; status: string }> => {
          as.noRefresh = which === "noRefresh";
          await loginFresh(key);
          as.noRefresh = false;
          const e = recOf(key)!;
          if (which === "elsewhere") {
            e.r.tokens.issuer = "http://127.0.0.1:1/";
            writeFileSync(e.f, JSON.stringify(e.r));
          }
          const exp = e.r.expiresAt as number;
          const realNow = Date.now;
          Date.now = () => exp;
          let t: string | undefined;
          try {
            t = await oauth.mcpAccessToken(key);
          } finally {
            Date.now = realNow;
          }
          return { token: t !== undefined, status: await oauth.mcpOAuthStatus(key) };
        };
        const xr = { noRefresh: await atExpiry("noRefresh"), elsewhere: await atExpiry("elsewhere") };
        out.push(assert("★만료 경계 — 지금이 정확히 만료 시각이면 두 분기 모두 토큰을 주지 않고 «로그인 필요»",
          Object.values(xr).every((x) => !x.token && x.status === "login-needed"),
          JSON.stringify(xr)));
        // 같은 경계를 **갱신 작업을 거치지 않는 지름길**에서도 — 다른 인가 서버에 묶인 같은 토큰의 재읽기 · 갱신이 일시 실패한 뒤 재시도
        //  대기 창 안의 읽기. 둘째 읽기만 정확히 만료 시각(또는 1ms 전). ★없을 때: 위 단언은 새 로그인 뒤 한 번만 읽어 지름길의 유효 판정을
        //  `>=`·`> +1` 로 바꿔도 전체 초록이었다(독립 변이 사냥 10-26 — 구멍 2, 재사냥 — 다른 서버 지름길의 1ms 전 1).
        const readTwice = async (which: "elsewhere" | "backoff", second: number): Promise<{ first: boolean; token: boolean; status: string }> => {
          await loginFresh(key);
          const e = recOf(key)!;
          if (which === "elsewhere") {
            e.r.tokens.issuer = "http://127.0.0.1:1/";
            writeFileSync(e.f, JSON.stringify(e.r));
          }
          const exp = e.r.expiresAt as number;
          const realNow = Date.now;
          if (which === "backoff") as.refreshMode = "server_error";
          let first: string | undefined;
          let t: string | undefined;
          try {
            Date.now = () => exp - 1000; // 갱신 창 안 · 아직 유효 — 지름길 상태(다른 서버 기억 · 일시 실패 시각)를 만든다
            first = await oauth.mcpAccessToken(key);
            Date.now = () => exp + second;
            t = await oauth.mcpAccessToken(key);
          } finally {
            Date.now = realNow;
            as.refreshMode = "ok";
          }
          return { first: first !== undefined, token: t !== undefined, status: await oauth.mcpOAuthStatus(key) };
        };
        const sr = {
          elsewhereAt: await readTwice("elsewhere", 0),
          elsewhereBefore: await readTwice("elsewhere", -1),
          backoffAt: await readTwice("backoff", 0),
          backoffBefore: await readTwice("backoff", -1),
        };
        await loginFresh(key); // 지름길 기억(다른 서버·일시 실패 시각)을 남기지 않는다 — forgetMcpOAuth 가 지운다
        out.push(assert("★만료 경계(지름길) — 다른 인가 서버 재읽기·갱신 일시 실패 뒤 대기 창: 정확히 만료 시각엔 토큰 없음(다른 서버는 «로그인 필요»), 1ms 전엔 그 토큰",
          sr.elsewhereAt.first && !sr.elsewhereAt.token && sr.elsewhereAt.status === "login-needed" &&
            sr.elsewhereBefore.first && sr.elsewhereBefore.token && sr.elsewhereBefore.status === "authorized" &&
            sr.backoffAt.first && !sr.backoffAt.token && sr.backoffBefore.first && sr.backoffBefore.token,
          JSON.stringify(sr)));
      }
      as.expiresIn = 3600;

      // ⑭ 자원 지시자(RFC 8707) — 경로 없는 자원(`http://host:port`)에서 로그인과 우리 갱신이 **같은 문자열**을 보낸다. 인가 서버는 문자 그대로 비교한다.
      //  ★없을 때: SDK 1.32 `auth()` 는 메타데이터 문자열을 그대로, 우리 갱신은 `selectResourceURL` 의 `URL.href`(끝 `/` 붙음)를 보내 invalid_target
      //  → 토큰이 만료될 때마다 다시 로그인(독립 검토 10-25 — SDK 를 1.32 로 올린 b62f7da3 이 만든 어긋남).
      as.resource = origin;
      as.expiresIn = 60;
      const seen0 = as.resourceSeen.length;
      await loginFresh(key);
      const tr0 = as.tokenRequests.length;
      const rTok = await oauth.mcpAccessToken(key);
      const ours = as.tokenRequests.slice(tr0).filter((r) => r.grant_type === "refresh_token");
      const seen = as.resourceSeen.slice(seen0);
      const rStatus = await oauth.mcpOAuthStatus(key);
      out.push(assert("★⑭ 경로 없는 자원 — 인가 요청·코드 교환·우리 갱신의 resource 가 모두 메타데이터 문자열 그대로 · 갱신 성공(로그인 필요 아님)",
        seen.map((x) => x.at).join(",") === "authorize,authorization_code,refresh_token" && seen.every((x) => x.resource === origin) &&
          rTok !== undefined && as.access.has(rTok) && rStatus === "authorized",
        JSON.stringify({ seen, token: rTok !== undefined, rStatus })));
      // 같은 기록으로 SDK `auth()` 가 갱신하면 보내는 요청과 우리 갱신 요청이 같다 — SDK 를 올릴 때 다음 어긋남을 여기서 잡는다(우리 갱신은 `auth()` 의 일부를 옮겨 적었다).
      const { auth: sdkAuth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      const cur = recOf(key)!.r;
      const tr1 = as.tokenRequests.length;
      const sdkResult = await sdkAuth({
        redirectUrl,
        clientMetadata: { redirect_uris: [redirectUrl] },
        clientInformation: () => cur.client,
        saveClientInformation: () => undefined,
        tokens: () => cur.tokens,
        saveTokens: () => undefined,
        redirectToAuthorization: () => undefined,
        saveCodeVerifier: () => undefined,
        codeVerifier: () => "",
        discoveryState: () => cur.discovery,
        saveDiscoveryState: () => undefined,
      }, { serverUrl: url }).catch((e: unknown) => `rejected:${String((e as Error)?.message ?? e).slice(0, 80)}`);
      const viaSdk = as.tokenRequests.slice(tr1);
      const canon = (r: Record<string, string> | undefined): string => JSON.stringify(Object.entries(r ?? {}).sort(([a], [b]) => a.localeCompare(b)));
      out.push(assert("★⑭ 같은 기록 — 우리 갱신 요청과 SDK auth() 갱신 요청의 파라미터(grant·client·resource)가 같다",
        sdkResult === "AUTHORIZED" && ours.length === 1 && viaSdk.length === 1 && canon(ours[0]) === canon(viaSdk[0]),
        JSON.stringify({ sdkResult, ours, viaSdk })));
      as.resource = undefined;
      as.expiresIn = 3600;

      // ⑤b 로그인 **준비 중**(인가 서버 탐색을 기다리는 동안 — 기록도 시도도 아직 없다) 삭제 → 늦게 돌아온 준비가 아무것도 남기지 않는다(아스트라 10-19).
      //  대기점은 가짜 서버가 탐색 응답을 붙잡는 것(고정 sleep 아님).
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      as.holdDiscovery = true;
      const preparing = oauth.startMcpLogin(key, redirectUrl).then((r) => r.status, (e: unknown) => `rejected:${String((e as Error)?.message ?? e).slice(0, 60)}`);
      for (let i = 0; i < 200 && as.heldDiscovery.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const heldAtDelete = as.heldDiscovery.length;
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      fake.releaseDiscovery();
      const prepResult = await preparing;
      out.push(assert("★⑤b 로그인 준비 중 삭제 — 늦게 돌아온 준비는 거절되고 인증 기록·시도가 남지 않는다",
        heldAtDelete >= 1 && prepResult.startsWith("rejected") && (await oauth.mcpOAuthStatus(key)) === "none",
        JSON.stringify({ heldAtDelete, prepResult, status: await oauth.mcpOAuthStatus(key) })));

      // ⑤ 제거 · 늦은 완료 — 로그인이 **진행 중**이어야 하므로 기록부터 비운다(앞 단계가 로그인을 끝내 둔다).
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const s4 = await oauth.startMcpLogin(key, redirectUrl);
      const p4 = s4.status === "redirect" ? oauth.parseMcpOAuthRedirect(await follow(s4.url)) : null;
      await ext.removeExternalMcpServer("oauthsrv");
      const late = p4 === null ? { ok: true } : await oauth.completeMcpLogin(p4);
      // 제거가 진행 중 시도도 취소하므로 보통 «unknown-or-used» · 교환 도중 제거면 «stale» — 어느 쪽이든 거절되고 기록이 안 생긴다.
      out.push(assert("★⑤ 서버 제거 → 로그인 기록 삭제 · 제거 뒤 늦게 온 완료는 거절(되살아나지 않음)",
        s4.status === "redirect" && late.ok === false && ["unknown-or-used", "stale"].includes((late as { reason?: string }).reason ?? "") && (await oauth.mcpOAuthStatus(key)) === "none",
        JSON.stringify({ late, status: await oauth.mcpOAuthStatus(key) })));

      // ⑦ Claude 경로 — SDK 가 직접 연결하므로 401 이 브리지를 안 지난다. SDK init 의 `needs-auth` 가 같은 «인증 필요» 로 모인다.
      writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url } } }));
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
      const fakeQuery = (() =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name: "oauthsrv", status: "needs-auth" }] };
          yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s2", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        })()) as never;
      // 턴 신호 관찰 — 가짜 SDK 가 받는 턴의 AbortController(어댑터의 중단 신호 그 자체)에서, 스트림이 끝난 뒤 붙는 abort 리스너(인증 기록
      //  대기)가 정상 완료 뒤 떨어지는지 본다(제품 상태 0 · 코드 검토 R1).
      const afterEnd = { ended: false, added: 0, live: new Set<unknown>() };
      const watchedQuery = ((args: { options?: { abortController?: AbortController } }) => {
        const sig = args.options?.abortController?.signal;
        if (sig !== undefined) {
          type Listen = (t: string, f: unknown, o?: unknown) => void;
          const s = sig as unknown as { addEventListener: Listen; removeEventListener: Listen };
          const add = s.addEventListener.bind(sig);
          const remove = s.removeEventListener.bind(sig);
          s.addEventListener = (t, f, o) => {
            if (t === "abort" && afterEnd.ended) (afterEnd.added += 1, afterEnd.live.add(f));
            add(t, f, o);
          };
          s.removeEventListener = (t, f, o) => {
            if (t === "abort") afterEnd.live.delete(f);
            remove(t, f, o);
          };
        }
        return (async function* () {
          yield* (fakeQuery as unknown as () => AsyncGenerator<unknown>)();
          afterEnd.ended = true;
        })();
      }) as never;
      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      const t7 = Date.now();
      try {
        await withFakeClaudeQuery(watchedQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude", channel: "cli" } as never));
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      const waited7 = Date.now() - t7; // 실패 진단용 — 턴(기록 대기 포함) 시간
      // 고정 대기 없음 — 턴은 init 이 알린 인증 상태의 기록이 끝난 뒤에 돌아온다.
      out.push(assert("★⑦ Claude 경로 — SDK init 의 needs-auth 가 «인증 필요» 로 적힌다(브리지와 같은 상태)",
        (await oauth.mcpOAuthStatus(key)) === "login-needed", `${await oauth.mcpOAuthStatus(key)} (턴·기록 대기 ${waited7}ms)`));
      out.push(assert("⑦ 기록 대기의 abort 리스너는 정상 완료 뒤 떨어진다(턴 신호에 남지 않는다)",
        afterEnd.ended && afterEnd.added >= 1 && afterEnd.live.size === 0, JSON.stringify({ ended: afterEnd.ended, added: afterEnd.added, live: afterEnd.live.size })));
      // ⑦d 그 기록을 기다리는 중에도 취소가 막히지 않는다 — 기록 쓰기를 붙잡아 둔 채 턴을 취소하면 쓰기를 풀기 전에 중단 사유로 끝난다(설계 검토 R1).
      //  붙잡는 자리는 이 프로세스의 `fs.promises.writeFile` 중 인증 기록 폴더로 가는 것만(제품 훅 0 · 비밀 파일 쓰기의 첫 단계라 POSIX·Windows 공통).
      //  풀 때는 그 쓰기를 실패시켜 늦은 기록이 뒤 단계와 겹치지 않게 하고, 그 실패도 같은 경고로 남는지 본다.
      await oauth.forgetMcpOAuth(file, "oauthsrv");
      const fsp = (await import("node:fs/promises")).default;
      const origWriteFile = fsp.writeFile;
      const storeMark = `${path.sep}mcp-oauth${path.sep}`;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((r) => (openGate = r));
      let reached: () => void = () => undefined;
      const writeReached = new Promise<void>((r) => (reached = r));
      fsp.writeFile = (async (...a: Parameters<typeof origWriteFile>) => {
        if (String(a[0]).includes(storeMark)) {
          reached();
          await gate;
          throw Object.assign(new Error("regression: held auth write dropped"), { code: "EREGRHELD" });
        }
        return origWriteFile.apply(fsp, a);
      }) as typeof origWriteFile;
      const cancel = new AbortController();
      let reachedWrite: unknown = "not-run";
      let cancelOutcome: unknown = "not-run";
      let droppedWarn: unknown = "not-run";
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      try {
        const turn = withFakeClaudeQuery(fakeQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude-d", channel: "cli", abortSignal: cancel.signal } as never))
          .then(() => "returned", (e: unknown) => String((e as Error)?.message ?? e));
        reachedWrite = await within(writeReached.then(() => "reached"));
        cancel.abort(new Error("regr-cancel-during-auth-note"));
        cancelOutcome = await within(turn); // 쓰기는 아직 붙잡혀 있다
        const dropped = nextLog((l) => l.startsWith("external-mcp: 'oauthsrv' 인증 상태 기록 실패"));
        openGate();
        droppedWarn = await within(dropped.then(() => "warned"));
        await within(turn);
      } finally {
        openGate();
        fsp.writeFile = origWriteFile;
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      const droppedLine = warns.find((l) => l.startsWith("external-mcp: 'oauthsrv' 인증 상태 기록 실패")) ?? "";
      out.push(assert("★⑦d 인증 기록을 기다리는 중 취소 → 쓰기를 풀기 전에 중단 사유로 끝난다 · 풀린 쓰기의 실패는 형식대로 경고되고 기록은 남지 않는다",
        reachedWrite === "reached" && cancelOutcome === "regr-cancel-during-auth-note" && droppedWarn === "warned" &&
          droppedLine === "external-mcp: 'oauthsrv' 인증 상태 기록 실패 — EREGRHELD" && AUTH_NOTE_WARN.test(droppedLine) && // 주입한 그 코드가 그대로(가짜 코드로 바꾸면 빨강)
          (await oauth.mcpOAuthStatus(key)) === "none",
        JSON.stringify({ reachedWrite, cancelOutcome, droppedWarn, droppedLine, status: await oauth.mcpOAuthStatus(key) })));
      // ⑦b 로그인돼 있는데 공급자가 그 토큰을 거절 — ★실제 CLI 는 이때 `needs-auth` 가 아니라 `failed` 를 낸다(싱크 전 적대 검토 10-18, 실 CLI 확인).
      //  우리는 그 토큰으로 한 번 직접 물어 401 이면 브리지와 같은 규칙(갱신 1회 먼저)으로 간다. 종전 이 검사는 가짜 CLI 가 needs-auth 를 내게 짜여
      //  실제와 다른 동작을 고정하고 있었다.
      await loginFresh(key);
      const tokB = await oauth.mcpAccessToken(key);
      as.access.delete(tokB ?? "");
      const rc0 = as.refreshCalls;
      as.rejected.length = 0;
      const failedQuery = (() =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name: "oauthsrv", status: "failed" }] };
          yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s2b", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        })()) as never;
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      try {
        await withFakeClaudeQuery(failedQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude-b", channel: "cli" } as never));
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      await new Promise((r) => setTimeout(r, 400)); // 확인 요청(실제 HTTP)이 돌아올 시간
      const statusB = await oauth.mcpOAuthStatus(key);
      await oauth.mcpAccessToken(key);
      out.push(assert("★⑦b Claude init 의 failed(우리 토큰 거절) → 직접 확인해 401 → «로그인 필요» 가 아니라 갱신 1회(브리지와 같은 규칙)",
        statusB === "authorized" && as.refreshCalls - rc0 === 1 && as.rejected.includes(tokB ?? "-"),
        JSON.stringify({ statusB, refreshes: as.refreshCalls - rc0, probeSentOurToken: as.rejected.includes(tokB ?? "-") })));
      // ⑦b' 보낸 설정의 주소가 지금 설정과 다르면(그새 바뀜) 확인 요청을 **안 보낸다** — 토큰·헤더가 다른 곳으로 가지 않게(재검토 10-18).
      as.rejected.length = 0;
      await ext.noteRemoteConnectFailed("oauthsrv", undefined, { type: "http", url: `${url}?moved=1`, headers: { Authorization: "Bearer at-stale-elsewhere" } });
      await new Promise((r) => setTimeout(r, 200));
      out.push(assert("⑦b' 보낸 설정의 주소가 지금 설정과 다르면 확인 요청을 보내지 않는다", as.rejected.length === 0, JSON.stringify(as.rejected)));
      // ⑦c Claude init 의 `connected` 도 «강제 갱신 토큰으로 성공» 의 증거다 — 그 뒤 그 토큰의 401 은 다시 갱신으로 간다.
      const connectedQuery = (() =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name: "oauthsrv", status: "connected" }] };
          yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s3", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        })()) as never;
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      try {
        await withFakeClaudeQuery(connectedQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude-c", channel: "cli" } as never));
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      const cTok = await oauth.mcpAccessToken(key);
      await oauth.noteMcpUnauthorized(key, cTok);
      out.push(assert("⑦c Claude init 의 connected 가 강제 갱신 토큰을 «검증됨» 으로 — 그 뒤 401 은 로그인 필요가 아니다",
        (await oauth.mcpOAuthStatus(key)) === "authorized", await oauth.mcpOAuthStatus(key)));

      // ⑮ 기록이 실패하면 — 두 경로(브리지 401 · Claude init needs-auth) 모두 서버 이름·오류 코드만 경고로 남기고, 연결·턴은 예외 없이 끝나며,
      //  상태가 «인증 필요» 로 보이지 않는다(기다림이 실패를 성공으로 만들지 않는다). 실패 주입은 제품 훅 없이: 기록 폴더 자리에 같은 이름의
      //  **파일**을 둬 기록 폴더 만들기를 실패시킨다(POSIX·Windows 공통). 끝나면 원상 복구.
      writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url }, authfail: { type: "http", url } } }));
      const failKey = { file, name: "authfail", url };
      const store = path.join(getPaths().home, "mcp-oauth");
      const aside = `${store}.regression-aside`;
      const warnFrom = warns.length;
      let failErr = "";
      let expectCode = "not-run";
      renameSync(store, aside);
      try {
        writeFileSync(store, "not a folder");
        // 기대 코드 = 같은 자리에 같은 폴더 만들기를 직접 해 본 결과(플랫폼마다 달라도 된다) — 경고가 **실제** 코드를 싣는지 본다.
        expectCode = await fsp.mkdir(store, { recursive: true, mode: 0o700 }).then(() => "no-error", (e: unknown) => String((e as { code?: unknown })?.code ?? (e as Error)?.name));
        for (const b of await ext.getConnectedExternalMcpBridges()) await b.close();
        const failQuery = (() =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name: "authfail", status: "needs-auth" }] };
            yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s4", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
          })()) as never;
        process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
        try {
          await withFakeClaudeQuery(failQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude-fail", channel: "cli" } as never));
        } finally {
          if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
          else process.env.ANTHROPIC_API_KEY = prevKey;
        }
      } catch (e) {
        failErr = String((e as Error)?.message ?? e).slice(0, 120);
      } finally {
        rmSync(store, { force: true });
        renameSync(aside, store);
      }
      const failWarns = warns.slice(warnFrom).filter((l) => l.includes("'authfail' 인증 상태 기록 실패 — "));
      const failStatus = await oauth.mcpOAuthStatus(failKey);
      out.push(assert("★⑮ 인증 상태 기록 실패 — 브리지·Claude 두 경로 모두 서버 이름·오류 코드만(형식 고정) 경고 · 연결·턴은 예외 없이 끝남 · 상태는 none(실패가 «인증 필요» 로 보이지 않음)",
        failErr === "" && failWarns.length === 2 && failWarns.every((l) => AUTH_NOTE_WARN.test(l) && l === `external-mcp: 'authfail' 인증 상태 기록 실패 — ${expectCode}`) &&
          failStatus === "none",
        JSON.stringify({ failErr, expectCode, failWarns, failStatus })));
      // ⑮b Claude init `failed` 의 직접 확인은 턴이 **기다리지 않는다**(시한 10초 네트워크) — 확인 응답을 붙잡아 둔 채 턴이 돌아오고, 그 뒤 확인이
      //  401 로 끝나 기록이 실패하면 같은 형식의 경고가 남는다(설계 검토 R1).
      writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url } } }));
      await loginFresh(key);
      const tokE = await oauth.mcpAccessToken(key);
      as.access.delete(tokE ?? ""); // 공급자가 무효화 — 확인 요청이 401 을 받게
      let probeHeld: () => void = () => undefined;
      const probeArrived = new Promise<void>((r) => (probeHeld = r));
      as.onHeldMcp = () => probeHeld();
      as.holdMcp = true;
      const probeQuery = (() =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake", tools: [], mcp_servers: [{ name: "oauthsrv", status: "failed" }] };
          yield { type: "result", subtype: "success", is_error: false, result: "답", num_turns: 1, session_id: "s5", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        })()) as never;
      let turnE: unknown = "not-run";
      let probeE: unknown = "not-run";
      let warnE: unknown = "not-run";
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      try {
        const turn = withFakeClaudeQuery(probeQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude-e", channel: "cli" } as never))
          .then(() => "returned", (e: unknown) => String((e as Error)?.message ?? e));
        turnE = await within(turn); // 확인 응답은 아직 붙잡혀 있다 — 돌아왔다면 기다리지 않은 것
        probeE = await within(probeArrived.then(() => "held"));
        renameSync(store, aside);
        try {
          writeFileSync(store, "not a folder");
          const warned = nextLog((l) => l.startsWith("external-mcp: 'oauthsrv' 인증 상태 기록 실패"));
          fake.releaseMcp();
          warnE = await within(warned.then(() => "warned"));
        } finally {
          rmSync(store, { force: true });
          renameSync(aside, store);
        }
        await within(turn);
      } finally {
        as.onHeldMcp = undefined;
        fake.releaseMcp();
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      const warnLineE = [...warns].reverse().find((l) => l.startsWith("external-mcp: 'oauthsrv' 인증 상태 기록 실패")) ?? "";
      out.push(assert("★⑮b Claude init failed 의 확인 요청은 턴이 기다리지 않는다(응답 전에 돌아옴) · 그 확인이 401 로 끝나 기록이 실패하면 형식대로 경고",
        turnE === "returned" && probeE === "held" && warnE === "warned" && warnLineE === `external-mcp: 'oauthsrv' 인증 상태 기록 실패 — ${expectCode}`,
        JSON.stringify({ turnE, probeE, warnE, expectCode, warnLineE })));
      // ⑮c 그 확인이 401 이 아니면(서버 일시 오류 503) 인증 상태를 바꾸지 않는다 — 일시 장애가 재로그인 요구로 보이면 안 된다
      //  (독립 변이 사냥: 401 판정을 «200 아님» 으로 넓혀도 초록이었다). 확인 함수를 직접 기다린다(고정 대기 없음).
      let flakyServed = 0; // 확인 요청이 실제로 와서 503 을 받았나 — 안 오면(요청 실패) «none» 이 거짓 통과가 된다(R3)
      const flaky = createServer((_req, res) => void (flakyServed += 1, res.writeHead(503).end("busy")));
      await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", () => r()));
      const flakyUrl = `http://127.0.0.1:${(flaky.address() as { port: number }).port}/mcp`;
      const flakyKey = { file, name: "flaky", url: flakyUrl };
      let flakyStatus = "not-run";
      try {
        writeFileSync(file, JSON.stringify({ mcpServers: { oauthsrv: { type: "http", url }, flaky: { type: "http", url: flakyUrl } } }));
        await ext.noteRemoteConnectFailed("flaky", undefined, { type: "http", url: flakyUrl, headers: { Authorization: "Bearer at-regression-flaky" } });
        flakyStatus = await oauth.mcpOAuthStatus(flakyKey);
      } finally {
        await new Promise<void>((r) => flaky.close(() => r()));
      }
      out.push(assert("⑮c failed 확인이 401 이 아닌 오류(503)면 «로그인 필요» 로 적지 않는다(확인 요청이 실제로 503 을 받은 뒤)",
        flakyServed === 1 && flakyStatus === "none", JSON.stringify({ flakyServed, flakyStatus })));

      // ⑥ 비밀이 로그에 없다
      const leaked = as.issued.filter((sec) => logs.some((l) => l.includes(sec)));
      out.push(assert("⑥ code·access·refresh 토큰이 로그에 안 남는다", leaked.length === 0, leaked.length === 0 ? `로그 ${logs.length}줄 검사` : `노출 ${leaked.length}건`));
    } finally {
      Object.assign(console, orig);
      await ext.closeAllExternalMcp();
      await oauth.forgetMcpOAuth(file, "oauthsrv").catch(() => 0);
      await oauth.forgetMcpOAuth(file, "withheader").catch(() => 0);
      if (prev === undefined) rmSync(file, { force: true });
      else writeFileSync(file, prev);
      await fake.close();
    }
    return out;
  },
};
