/**
 * **원격 MCP OAuth 콜백** — `GET /oauth/mcp/callback?code&state` (2026-10-18, 원격 MCP 2단계 2묶음).
 *
 * ★토큰 검사 없이 받는 유일한 이유: 인가 서버가 보낸 **브라우저 리다이렉트**라 브리지 토큰을 실을 수 없다. 대신 1회용 state(무작위 256비트 ·
 *  10분 · 로그인 시도·대상·redirect·PKCE 에 결부)가 지킨다(`completeMcpLogin`). Host 검사(DNS 리바인딩 방어)는 그대로 앞에서 돈다.
 * ★**절대 던지지 않는다** — 바깥의 요청 실패 로그가 `req.url` 원문(code·state)을 찍는다(아스트라 회신 D). 로그엔 서버 이름·결과 이름만.
 *  응답은 값을 되비추지 않고, 캐시·참조자로 새지 않게 막는다.
 */
import type { ServerResponse } from "node:http";
import { completeMcpLogin, mcpLoginReasonText, type McpLoginCompletion } from "../../src/core/mcp-oauth.js";
import { translate } from "../../src/core/i18n.js";

const page = (r: McpLoginCompletion): string => {
  const msg = r.ok ? translate("srv.mcpLogin.page.ok", { name: r.name }) : translate("srv.mcpLogin.page.failed", { reason: mcpLoginReasonText(r.reason) });
  const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>tiguclaw</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem"><p>${esc(msg)}</p></body>`;
};

export const serveMcpOAuthCallback = async (url: URL, res: ServerResponse): Promise<void> => {
  let r: McpLoginCompletion;
  try {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    r = state === "" ? { ok: false, reason: "unknown-or-used" } : await completeMcpLogin({ state, ...(code !== undefined ? { code } : {}), ...(error !== undefined ? { error } : {}) });
  } catch {
    r = { ok: false, reason: "exchange-failed" };
  }
  console.log(`[http-bridge] MCP 로그인 콜백 — ${r.ok ? `'${r.name}' 로그인됨` : `실패(${r.reason})`}`);
  try {
    res.writeHead(r.ok ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(page(r));
  } catch {
    /* 응답을 못 써도 던지지 않는다 */
  }
};
