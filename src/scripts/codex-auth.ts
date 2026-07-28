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
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import { createServer } from "node:http";
import {
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  upsertCodexTokens,
} from "../core/llm-runtime/adapters/openai-codex-oauth.js";

const PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

const main = async (): Promise<void> => {
  const flow = await createAuthorizationFlow();
  console.log("\n=== tiguclaw V3.1 Codex OAuth flow ===\n");
  console.log("브라우저에서 아래 URL 을 열고 ChatGPT 로그인 + 권한 허용을 진행하세요:\n");
  console.log(flow.url);
  console.log(`\ncallback 대기 중 (localhost:${PORT}${CALLBACK_PATH})...\n`);

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.url === undefined) {
            res.writeHead(400).end("Missing url");
            return;
          }
          const url = new URL(req.url, `http://localhost:${PORT}`);
          if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404).end("Not found");
            return;
          }
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error !== null && error !== "") {
            res.writeHead(400).end(`Authorization error: ${error}`);
            server.close();
            reject(new Error(`Authorization error: ${error}`));
            return;
          }
          if (code === null || state === null) {
            res.writeHead(400).end("Missing code or state");
            server.close();
            reject(new Error("Missing code or state in callback"));
            return;
          }
          if (state !== flow.state) {
            res.writeHead(400).end("State mismatch (CSRF guard)");
            server.close();
            reject(new Error("State mismatch (CSRF guard)"));
            return;
          }

          const tokens = await exchangeAuthorizationCode(
            code,
            flow.pkce.verifier,
          );
          await upsertCodexTokens(tokens);
          const expiresInSec = Math.round((tokens.expires - Date.now()) / 1000);
          res
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(
              "<h1>tiguclaw OAuth 완료</h1><p>창을 닫고 터미널로 돌아가세요.</p>",
            );
          server.close();
          // ★재인증했으면 이전 한도 판정은 무효다 (2026-07-28). 쿨다운은 "호출 성공 시"에만
          //  풀리는데 쿨다운 중엔 그 백엔드를 아예 안 부르므로 스스로는 안 풀린다 = 자기 잠금.
          //  새 자격증명은 전제가 바뀐 것이므로 여기서 지운다. 이 CLI 는 데몬과 별 프로세스라
          //  DB 만 지울 수 있다 → 돌고 있는 데몬에는 `/cooldown clear codex` 또는 재시작이 필요.
          //  (그래서 아래 안내를 반드시 함께 출력한다 — 조용히 안 풀리면 원인을 알 수 없다.)
          let cooldownNote = "";
          try {
            const { initStore } = await import("../store/sessions.js");
            const { loadLiveCooldowns, deleteCooldown } = await import(
              "../store/cooldowns.js"
            );
            initStore();
            const live = loadLiveCooldowns(Date.now()).filter((c) =>
              c.key.startsWith("codex"),
            );
            for (const c of live) deleteCooldown(c.key);
            if (live.length > 0) {
              cooldownNote =
                `\n⚠️ codex 쿨다운 ${live.length}건을 해제했습니다(재인증 = 이전 한도 판정 무효).` +
                `\n   돌고 있는 데몬에는 즉시 반영되지 않습니다 — 채팅에서 \`/cooldown clear codex\` 를 보내거나 데몬을 재시작하세요.`;
            }
          } catch {
            /* store 미준비 등 — 인증 자체는 성공했으므로 진행 */
          }
          console.log(`\n✅ 토큰 발급 + .env 저장 완료.${cooldownNote}`);
          console.log(`   access_token expires in ~${expiresInSec}s`);
          console.log(`   refresh_token 보존 (V3.3 자동 refresh hook 활성)`);
          console.log(`\n다음: REGION_A_MODELS=codex:gpt-5.5 npm run dev 또는 직접 runRegionA 호출.\n`);
          resolve();
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          try {
            res.writeHead(500).end(`Token exchange failed: ${reason}`);
          } catch {
            // res 이미 끝났을 수 있음.
          }
          server.close();
          reject(e instanceof Error ? e : new Error(reason));
        }
      })();
    });
    server.on("error", (err) => {
      reject(err);
    });
    server.listen(PORT);
  });
};

main().catch((err) => {
  console.error("codex-auth failed:", err);
  process.exit(1);
});
