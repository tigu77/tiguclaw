/**
 * Codex 구독 로그인 — **터미널 밖에서도** 되게 하는 공용 조각 (2026-09-05).
 *
 * ★왜 새 모듈인가: 이 흐름은 지금까지 `src/scripts/codex-auth.ts`(CLI) **안에만** 있었다.
 *  대시보드 버튼이 같은 일을 하려면 둘 중 하나다 — 복사하거나, 꺼내거나. 복사하면 CSRF
 *  검증·토큰 저장·쿨다운 해제 같은 판단이 두 벌이 되고, 한쪽만 고쳐지는 날 한쪽 사용자가
 *  조용히 로그아웃된다([[feedback_simple_composable_no_duplication]]). 그래서 꺼낸다.
 *
 * ★여기 있는 것은 **판단**이고, 화면·터미널 문구는 각자 자리에 남는다.
 *
 * ★자동 콜백을 믿지 않는다(2026-08-11 윈도우 실사고 — 콜백이 우리 핸들러까지 안 왔고
 *  새로고침을 해야 진행됐다). 그래서 **붙여넣기 경로가 언제나 같이 열려 있다.** 대시보드를
 *  폰에서 열었다면 콜백의 `localhost` 는 폰이라 자동 경로는 **원리적으로** 안 온다 — 그때
 *  사용자가 빠져나갈 길이 이것뿐이다.
 */
import { createServer, type Server } from "node:http";
import {
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  upsertCodexTokens,
} from "./openai-codex-oauth-auth.js";

export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";

/** 로그인 창을 열어두는 시간 — 넘으면 콜백 서버를 닫는다(포트를 물고 있지 않게). */
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * 붙여넣은 문자열에서 code·state 를 뽑는다 — 전체 리다이렉트 URL 이든, 쿼리스트링이든,
 * `code=` 한 조각이든 받는다. ★사용자가 무엇을 붙여넣을지 우리가 못 정한다(주소창 전체를
 * 복사하는 게 가장 자연스럽다) → 관대하게 받고, 판정은 state 검증에서 한다.
 */
export const parseRedirectInput = (
  raw: string,
): { code: string; state: string | null } | null => {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (s === "") return null;
  const qs = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
  const params = new URLSearchParams(qs.replace(/^#/, ""));
  const code = params.get("code");
  if (code === null || code === "") return null;
  return { code, state: params.get("state") };
};

/**
 * code → 토큰 → 홈 `.env`. **자동(콜백)·수동(붙여넣기) 공통 종착점** — 판단이 두 곳에
 * 생기지 않게 한 곳으로 모은다. state 가 오면 CSRF 검증을 하고, 안 오면(사용자가 code 만
 * 붙여넣은 경우) 통과시킨다 — 관대하게 받되 검증할 수 있는 것은 검증한다.
 */
export const completeCodexLogin = async (input: {
  code: string;
  state: string | null;
  expectedState: string;
  verifier: string;
}): Promise<{ expiresInSec: number; clearedCooldowns: number }> => {
  if (input.state !== null && input.state !== input.expectedState) {
    throw new Error("State mismatch (CSRF guard)");
  }
  const tokens = await exchangeAuthorizationCode(input.code, input.verifier);
  await upsertCodexTokens(tokens);
  // ★재인증했으면 이전 한도 판정은 무효다(2026-07-28). 쿨다운은 "호출 성공 시"에만 풀리는데
  //  쿨다운 중엔 그 백엔드를 아예 안 부르므로 스스로는 안 풀린다 = 자기 잠금. 새 자격증명은
  //  전제가 바뀐 것이므로 여기서 지운다.
  let clearedCooldowns = 0;
  try {
    const { initStore } = await import("../../../store/sessions.js");
    const { loadLiveCooldowns, deleteCooldown } = await import("../../../store/cooldowns.js");
    initStore();
    const live = loadLiveCooldowns(Date.now()).filter((c) => c.key.startsWith("codex"));
    for (const c of live) deleteCooldown(c.key);
    clearedCooldowns = live.length;
  } catch {
    /* store 미준비 — 인증 자체는 성공했으므로 진행 */
  }
  return {
    expiresInSec: Math.round((tokens.expires - Date.now()) / 1000),
    clearedCooldowns,
  };
};

// ── 데몬 안에서 도는 로그인 세션(대시보드 버튼용) ───────────────────────────
// ★CLI 는 이걸 안 쓴다 — 거긴 readline 과 콘솔이 있고 프로세스가 곧 끝난다. 여기는 **오래
//  사는 프로세스**라 «지금 열려 있는 로그인» 이라는 상태와 그 수명이 필요하다.

interface PendingLogin {
  state: string;
  verifier: string;
  url: string;
  startedAt: number;
  server: Server | null;
  timer: NodeJS.Timeout;
  done: boolean;
}

let pending: PendingLogin | null = null;

const closePending = (): void => {
  if (pending === null) return;
  clearTimeout(pending.timer);
  pending.server?.close();
  pending = null;
};

/**
 * 로그인을 시작한다 — 인가 URL 을 만들고 콜백을 **기다린다**.
 *
 * ★콜백 서버가 안 떠도(포트 점유 등) 실패로 만들지 않는다. 붙여넣기 경로가 그대로 살아
 *  있으므로 사용자는 여전히 끝낼 수 있다 — 자동이 안 되는 것과 못 하게 되는 것은 다르다.
 */
export const beginCodexLogin = async (): Promise<{ url: string; autoCallback: boolean }> => {
  closePending(); // 이전 시도는 버린다 — 열린 창이 둘이면 어느 state 가 맞는지 모른다.
  const flow = await createAuthorizationFlow();
  const session: PendingLogin = {
    state: flow.state,
    verifier: flow.pkce.verifier,
    url: flow.url,
    startedAt: Date.now(),
    server: null,
    timer: setTimeout(closePending, SESSION_TTL_MS),
    done: false,
  };
  pending = session;

  let autoCallback = false;
  try {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://localhost:${CODEX_CALLBACK_PORT}`);
        // ★들어온 것을 전부 남긴다 — "첫 요청이 뭐였나" 를 다음엔 추론하지 않는다.
        console.log(
          `[codex-login] ← ${req.method ?? "?"} ${url.pathname}` +
            ` (code=${url.searchParams.has("code")} state=${url.searchParams.has("state")})`,
        );
        if (url.pathname !== CODEX_CALLBACK_PATH) {
          res.writeHead(404).end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        if (code === null || code === "") {
          res.writeHead(400).end("Missing code");
          return; // 중단하지 않는다 — 프리페치·재시도 하나로 흐름이 죽으면 안 된다.
        }
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            '<!doctype html><meta charset="utf-8"><title>tiguclaw</title>' +
              '<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:30rem;padding:0 1.5rem">' +
              "<h1>✅ 인증이 끝났습니다</h1><p>대시보드로 돌아가세요 — 상태가 곧 «인증됨» 으로 바뀝니다.</p>",
          );
        try {
          await completeCodexLogin({
            code,
            state: url.searchParams.get("state"),
            expectedState: session.state,
            verifier: session.verifier,
          });
          session.done = true;
          console.log("[codex-login] 콜백으로 인증 완료 — 토큰을 홈 .env 에 저장했습니다.");
        } catch (e) {
          console.warn(`[codex-login] 콜백 처리 실패: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          closePending();
        }
      })();
    });
    await new Promise<void>((resolve) => {
      server.once("error", (err) => {
        // 포트 점유(공식 CLI 로그인·이전 codex-auth) — 자동만 포기한다.
        console.warn(`[codex-login] 콜백 서버를 못 띄웠습니다(${String(err)}) — 붙여넣기로 마칩니다.`);
        resolve();
      });
      server.listen(CODEX_CALLBACK_PORT, () => {
        session.server = server;
        autoCallback = true;
        resolve();
      });
    });
  } catch {
    /* 자동 경로 실패 = 붙여넣기로 진행 */
  }
  return { url: flow.url, autoCallback };
};

/** 사용자가 붙여넣은 주소로 마무리한다(자동 콜백이 안 왔을 때 — 원격·폰은 항상 이 길이다). */
export const finishCodexLogin = async (
  pasted: string,
): Promise<{ ok: boolean; message: string }> => {
  const session = pending;
  if (session === null) {
    return { ok: false, message: "열려 있는 로그인이 없습니다 — 인증을 다시 시작하세요." };
  }
  const parsed = parseRedirectInput(pasted);
  if (parsed === null) {
    return { ok: false, message: "code 를 못 찾았습니다 — 로그인 뒤 주소창 전체를 붙여넣어 주세요." };
  }
  try {
    const r = await completeCodexLogin({
      code: parsed.code,
      state: parsed.state,
      expectedState: session.state,
      verifier: session.verifier,
    });
    session.done = true;
    closePending();
    return {
      ok: true,
      message:
        `인증됐습니다 — 토큰을 홈 .env 에 저장했습니다(access ~${r.expiresInSec}초).` +
        (r.clearedCooldowns > 0 ? ` codex 쿨다운 ${r.clearedCooldowns}건도 해제했습니다.` : ""),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};
