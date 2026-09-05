/**
 * codex-auth CLI — V3.2 OAuth flow live entry (2026-05-22).
 * V3.3 정정 — .env upsert 는 어댑터의 `upsertCodexTokens` 위임 (DRY).
 *
 * 흐름:
 *  1. createAuthorizationFlow() — PKCE pair + state + URL 생성
 *  2. URL 콘솔 출력 (사용자가 브라우저 열어 ChatGPT 로그인 + 권한 허용)
 *  3. HTTP server localhost:1455/auth/callback 띄움
 *  4. callback ?code & state 수신 → state 검증 (CSRF) → exchangeAuthorizationCode
 *  5. 어댑터의 `upsertCodexTokens` 로 .env 갱신 (refresh hook 과 단일 진실 소스)
 *  6. server 종료 + 콘솔 안내
 *
 * ★자동 콜백은 **믿을 수 있는 것이 아니다** (2026-08-11, 윈도우 신규 설치 실사고).
 *  사용자 보고: 인증을 마치고 브라우저를 닫아도 터미널이 안 넘어가고, 콜백 페이지에서
 *  **새로고침을 해야** 온보드가 진행됐다. 즉 첫 콜백이 우리 핸들러까지 안 왔다.
 *  정합 기준인 OpenClaw 도 같은 자리에 안내를 달아 뒀다 — *"If the callback doesn't
 *  auto-complete, paste the redirect URL"* — 즉 **상류 흐름의 알려진 성질**이고, 저쪽은
 *  ①수동 붙여넣기 폴백 ②실패해도 온보딩 유지를 갖고 있다.
 *
 *  그래서 여기서 두 가지를 바꾼다(원인 추정 없이 **닫는** 쪽):
 *   ①**들어온 요청을 전부 로그**로 남긴다 — 다음에 같은 신고가 오면 첫 요청이 무엇이었는지
 *     추론이 아니라 기록으로 본다(로그가 1차 진단면).
 *   ②**수동 붙여넣기 경로**를 항상 같이 연다 — 자동이 안 닫혀도 사용자가 빠져나갈 길이
 *     있어야 한다. 종전엔 영원히 매달렸고, onboard 는 그걸 실패로 보고 통째로 중단했다.
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createAuthorizationFlow } from "../core/llm-runtime/adapters/openai-codex-oauth.js";
// ★파싱·CSRF 검증·토큰 저장·쿨다운 해제는 **코어에 있다** — 대시보드 인증 버튼이 같은 일을
//  하게 되면서 꺼냈다(2026-09-05). 복사하면 한쪽만 고쳐지는 날 한쪽 사용자가 조용히
//  로그아웃된다. 여기 남는 것은 터미널 문구와 readline 뿐이다.
import {
  CODEX_CALLBACK_PORT as PORT,
  CODEX_CALLBACK_PATH as CALLBACK_PATH,
  parseRedirectInput,
  completeCodexLogin,
} from "../core/llm-runtime/adapters/openai-codex-oauth-login.js";

export { parseRedirectInput };
/** 이 시간 안에 콜백이 안 오면 수동 경로를 **다시** 안내한다(중단하지 않는다). */
const NUDGE_MS = 45_000;

/**
 * 콜백 성공 페이지. ★"창을 닫으세요" 로 끝내지 않는다 — 터미널이 안 넘어갔을 때
 *  사용자가 브라우저에서 할 수 있는 행동(다시 보내기)을 준다. 중복 콜백은 `settled`
 *  가드가 무시하므로 여러 번 눌러도 안전하다.
 */
const successPage = `<!doctype html><html lang="ko"><meta charset="utf-8">
<title>tiguclaw OAuth 완료</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}
 h1{font-size:1.4rem;margin:0 0 .6rem}
 p{color:#555;margin:.4rem 0}
 button{margin-top:1.4rem;padding:.7rem 1.2rem;font:inherit;border:0;border-radius:.5rem;
        background:#1a1a1a;color:#fff;cursor:pointer}
 button:hover{background:#333}
 small{display:block;margin-top:1rem;color:#888}
</style>
<h1>✅ 인증이 끝났습니다</h1>
<p>터미널로 돌아가면 설치가 이어집니다.</p>
<p><strong>터미널이 그대로 멈춰 있나요?</strong> 아래를 눌러 한 번 더 보내보세요.</p>
<button onclick="location.reload()">터미널로 다시 보내기</button>
<small>그래도 안 되면 이 페이지의 주소창 전체를 복사해 터미널에 붙여넣고 Enter 하세요.</small>
</html>`;

const main = async (): Promise<void> => {
  const flow = await createAuthorizationFlow();
  console.log("\n=== tiguclaw Codex OAuth flow ===\n");
  console.log("브라우저에서 아래 URL 을 열고 ChatGPT 로그인 + 권한 허용을 진행하세요:\n");
  console.log(flow.url);
  console.log(`\ncallback 대기 중 (localhost:${PORT}${CALLBACK_PATH})...`);
  console.log(
    "★자동으로 안 넘어가면: 로그인 후 브라우저 **주소창 전체**를 복사해 여기에 붙여넣고 Enter.\n",
  );

  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    const server = createServer();
    let nudge: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (nudge !== undefined) clearTimeout(nudge);
      rl.close();
      server.close();
    };
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    /** 자동(콜백)·수동(붙여넣기) 공통 종착점 — 판단이 두 곳에 생기지 않게 한 곳으로 모은다. */
    const complete = async (
      code: string,
      state: string | null,
    ): Promise<void> => {
      if (settled) return;
      const r = await completeCodexLogin({
        code,
        state,
        expectedState: flow.state,
        verifier: flow.pkce.verifier,
      });
      settled = true;
      cleanup();
      // ★쿨다운 해제는 코어가 했다 — 여기서는 «그래서 사용자가 무엇을 해야 하나» 만 말한다.
      //  이 CLI 는 데몬과 별 프로세스라 DB 만 바뀐다(돌고 있는 데몬엔 즉시 반영 안 됨).
      const cooldownNote =
        r.clearedCooldowns > 0
          ? `\n⚠️ codex 쿨다운 ${r.clearedCooldowns}건을 해제했습니다(재인증 = 이전 한도 판정 무효).` +
            `\n   돌고 있는 데몬에는 즉시 반영되지 않습니다 — 채팅에서 \`/cooldown clear codex\` 를 보내거나 데몬을 재시작하세요.`
          : "";
      console.log(`\n✅ 토큰 발급 + .env 저장 완료.${cooldownNote}`);
      console.log(`   access_token expires in ~${r.expiresInSec}s`);
      console.log(`   refresh_token 보존 (자동 refresh hook 활성)`);
      resolve();
    };

    // ── 자동 경로 — 브라우저 콜백 ──────────────────────────────────────────
    server.on("request", (req, res) => {
      void (async () => {
        const raw = req.url ?? "";
        const url = new URL(raw, `http://localhost:${PORT}`);
        const match = url.pathname === CALLBACK_PATH;
        // ★들어온 것을 전부 남긴다 — "첫 요청이 뭐였나" 를 다음엔 추론하지 않는다.
        console.log(
          `[codex-auth] ← ${req.method ?? "?"} ${url.pathname}` +
            ` (${match ? "callback" : "무관 — 무시"}` +
            `${match ? `, code=${url.searchParams.has("code")} state=${url.searchParams.has("state")}` : ""})`,
        );
        if (!match) {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error !== null && error !== "") {
          res.writeHead(400).end(`Authorization error: ${error}`);
          fail(new Error(`Authorization error: ${error}`));
          return;
        }
        const code = url.searchParams.get("code");
        if (code === null) {
          res.writeHead(400).end("Missing code");
          console.warn(
            "[codex-auth] code 없는 콜백 — 무시하고 계속 기다립니다(수동 붙여넣기도 가능).",
          );
          return; // ★중단하지 않는다 — 프리페치·재시도 요청 하나로 흐름이 죽으면 안 된다.
        }
        try {
          // ★응답을 **먼저** 보낸다. 종전엔 토큰 교환을 끝낸 뒤에야 응답해서, 그 사이
          //  브라우저가 기다리다 사용자가 창을 닫으면 무슨 일이 있었는지 화면에 안 남았다.
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
            // ★막다른 길을 만들지 않는다 (2026-08-11 사용자 지시). 종전엔 "창을 닫으세요"
            //  한 줄이라, 터미널이 안 넘어갔을 때 사용자가 브라우저에서 할 수 있는 게
            //  없었다(새로고침이 먹힌다는 걸 알 방법도 없었다). 버튼을 준다.
            successPage,
          );
          await complete(code, url.searchParams.get("state"));
        } catch (e) {
          fail(e);
        }
      })();
    });
    server.on("error", (err) => {
      const msg = String(err);
      if (msg.includes("EADDRINUSE")) {
        console.error(
          `🔴 포트 ${PORT} 이 이미 쓰이고 있습니다 — 공식 Codex CLI 로그인이 떠 있거나 ` +
            `이전 codex-auth 가 안 죽었습니다. 그것을 닫고 다시 실행하세요.`,
        );
      }
      fail(err);
    });
    server.listen(PORT);

    // ── 수동 경로 — 주소창 붙여넣기 ────────────────────────────────────────
    rl.on("line", (line) => {
      const parsed = parseRedirectInput(line);
      if (parsed === null) {
        if (line.trim() !== "") {
          console.warn("[codex-auth] code 를 못 찾았습니다 — 주소창 전체를 붙여넣어 주세요.");
        }
        return;
      }
      console.log("[codex-auth] 붙여넣은 URL 에서 code 확인 — 토큰 교환합니다.");
      void complete(parsed.code, parsed.state).catch(fail);
    });

    nudge = setTimeout(() => {
      if (settled) return;
      console.log(
        `\n… ${Math.round(NUDGE_MS / 1000)}초째 콜백이 안 옵니다.\n` +
          "   브라우저에서 로그인을 마치셨다면 **주소창 전체를 복사해 여기에 붙여넣고 Enter** 하세요.\n" +
          "   (콜백 페이지에서 새로고침을 해도 됩니다 — 둘 중 먼저 되는 쪽이 이깁니다.)\n",
      );
    }, NUDGE_MS);
  });
};

main().catch((err) => {
  console.error("codex-auth failed:", err);
  process.exit(1);
});
