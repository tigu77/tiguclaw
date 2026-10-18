/**
 * 회귀: **원격 MCP OAuth 로그인 2묶음 — 시작 도구 · 루프백 콜백 · 모델을 거치지 않는 붙여넣기** (2026-10-18, 아스트라 회신 D 반영).
 *
 * 본다(브리지를 실제로 띄운 자식 `_mcp-oauth-login-child.ts`, 가짜 인가 서버 `_fake-oauth-server.ts`):
 *  ① `login_mcp_server` 가 인가 링크를 준다 · 인가 서버가 **브리지 루프백 콜백**으로 보낸다 · 브리지가 토큰 없이 받아 로그인 완료(200) · 목록에 «로그인됨»
 *  ② 같은 콜백 다시 → 400(교환 한 번) · 응답은 no-store·no-referrer · 남의 Host 는 인증 면제 경로여도 403(DNS 리바인딩 방어가 먼저)
 *  ③ `/mcp_login <주소>` 붙여넣기로 완료 · 콜백 경로가 아닌 주소는 사용법만 · 같은 주소 다시는 «이미 처리됨»
 *  ④ code·state·토큰이 로그와 응답(콜백 화면·명령 답)에 안 남는다
 * 등급: **실행**(격리 홈 · 실제 브리지 · 실제 HTTP).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_mcp-oauth-login-child.ts");

export const check: RegressionCheck = {
  name: "mcp-oauth-login-flow",
  guards: "원격 MCP OAuth 로그인을 끝낼 길 — 브리지 콜백(토큰 없이 받되 state·Host 로 지킴)과 다른 기기용 붙여넣기(모델을 거치지 않음)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(90_000, "mcp-oauth-login", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const j = line === undefined ? {} : (JSON.parse(line) as Record<string, unknown>);
    const show = (keys: string[]): string => JSON.stringify(Object.fromEntries(keys.map((k) => [k, j[k]]))).slice(0, 300) || r.err.slice(-200);
    return [
      assert("★① 시작 도구 → 링크 → 브리지 루프백 콜백(토큰 없이) → 로그인 완료 · 목록에 «로그인됨»",
        j.toolGaveLink === true && j.callbackToBridge === true && j.r1 === 200 && j.status1 === "authorized" && j.listedAuthorized === true,
        show(["toolGaveLink", "callbackToBridge", "r1", "status1", "listedAuthorized"])),
      assert("★② 같은 콜백 다시 → 400 · 응답 no-store·no-referrer · 남의 Host → 403(면제 경로여도 Host 검사가 먼저)",
        j.r1b === 400 && JSON.stringify(j.cbHeaders) === JSON.stringify({ cache: "no-store", referrer: "no-referrer" }) && j.evil === 403,
        show(["r1b", "cbHeaders", "evil"])),
      assert("★③ `/mcp_login <주소>` 로 완료 · 엉뚱한 주소는 사용법 · 같은 주소 다시는 거절",
        j.pastedOk === true && j.status2 === "authorized" && j.badIsUsage === true && j.againRefused === true,
        show(["pastedOk", "status2", "badIsUsage", "againRefused"])),
      assert("④ code·state·토큰이 로그·콜백 화면·명령 답에 안 남는다", j.leakedLogs === 0 && j.leakedBodies === 0, show(["leakedLogs", "leakedBodies"])),
      // [배선] 채널 입구가 `/mcp_login` 을 모델로 안 보내고, 입력 메아리는 가려서 적재 없이(ephemeral) 낸다 — 빠지면 주소(code·state)가 chat_log 에 남는다.
      (() => {
        const src = stripComments(readSourceSync("src/index.ts"));
        const branch = src.match(/=== "\/mcp_login"\) \{[\s\S]{0,600}?\n {2}\}/)?.[0] ?? "";
        const ok = /publishInboundEcho\(\{ \.\.\.msg, text: "\/mcp_login …" \}, \{ ephemeral: true \}\)/.test(branch) &&
          /runMcpLoginCommand\(msg\.text\)/.test(branch) && !/enqueue|serializedHandler|runRegionA/.test(branch);
        return assert("[배선] `/mcp_login` 은 모델로 안 가고, 메아리는 가려서 적재 없이", ok, branch === "" ? "분기 없음" : `${branch.length}자 분기`);
      })(),
    ];
  },
};
