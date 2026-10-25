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
 *  ⑬ 발급 서버 표식(`issuer`) — 갱신 뒤에도 유지 · 옛 기록은 갱신 후 묶임 · 다른 인가 서버에 묶인 것은 refresh 를 안 보낸다
 * 등급: **실행**(격리 홈 · 같은 프로세스의 실제 HTTP 서버들). 실서비스 로그인은 하지 않는다.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const m of ["log", "warn", "error"] as const) console[m] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
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

      // ① 토큰 없이 → 401 → 인증 필요
      for (const b of await ext.getConnectedExternalMcpBridges()) await b.close();
      await new Promise((r) => setTimeout(r, 50));
      out.push(assert("① 토큰 없이 연결 → 401 → «인증 필요»(login-needed) 로 적힌다", (await oauth.mcpOAuthStatus(key)) === "login-needed", await oauth.mcpOAuthStatus(key)));

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
      // 다른 인가 서버에 찍힌 토큰 / 클라이언트 — 이 서버에 refresh 를 **보내지 않고** «로그인 필요».
      const elsewhereRuns: Array<{ which: string; posted: number; status: string; token: boolean }> = [];
      for (const which of ["tokens", "client"] as const) {
        await loginFresh(key);
        const e = recOf(key)!;
        e.r[which].issuer = "http://127.0.0.1:1/";
        writeFileSync(e.f, JSON.stringify(e.r));
        const rs2 = as.refreshCalls;
        const t = await oauth.mcpAccessToken(key);
        elsewhereRuns.push({ which, posted: as.refreshCalls - rs2, status: await oauth.mcpOAuthStatus(key), token: t !== undefined });
      }
      as.expiresIn = 3600;
      out.push(assert("★⑬ 다른 인가 서버에 묶인 토큰·클라이언트 — refresh 요청 0건 · «로그인 필요»",
        elsewhereRuns.length === 2 && elsewhereRuns.every((x) => x.posted === 0 && x.status === "login-needed" && !x.token), JSON.stringify(elsewhereRuns)));

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
      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key";
      try {
        await withFakeClaudeQuery(fakeQuery, () => runClaude({ text: "해줘", threadKey: "regr:oauth-claude", channel: "cli" } as never));
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
      await new Promise((r) => setTimeout(r, 50));
      out.push(assert("★⑦ Claude 경로 — SDK init 의 needs-auth 가 «인증 필요» 로 적힌다(브리지와 같은 상태)",
        (await oauth.mcpOAuthStatus(key)) === "login-needed", await oauth.mcpOAuthStatus(key)));
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
      await new Promise((r) => setTimeout(r, 50));
      const cTok = await oauth.mcpAccessToken(key);
      await oauth.noteMcpUnauthorized(key, cTok);
      out.push(assert("⑦c Claude init 의 connected 가 강제 갱신 토큰을 «검증됨» 으로 — 그 뒤 401 은 로그인 필요가 아니다",
        (await oauth.mcpOAuthStatus(key)) === "authorized", await oauth.mcpOAuthStatus(key)));

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
