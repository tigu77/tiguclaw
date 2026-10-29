/**
 * 회귀: **HTML 오류 페이지(프록시 520 등)는 오류 안내에 원문째 실리지 않고, 근거 없는 재개를 권하지 않는다** (2026-10-28).
 *
 * 사고: 도구를 쓴 뒤 백엔드가 520 HTML 을 돌려주자, 오류 안내에 `<!DOCTYPE html>…<title>…</title><style>body{…` 가
 *  200자로 잘린 채 실려 채팅에 제목·CSS 가 드러났다. 그리고 그 안내는 실제 작업 상태를 보지 않고 «"이어서 진행해줘" 라고
 *  말씀해 주세요» 를 권했다(시작한 작업이 아직 도는지 모르는 자리다). 수동 `/compact` 사유도 같은 원문을 실었다.
 *
 * 본다: ① `describeFailureBody` — HTML 만 제목 한 줄로 · JSON·평문은 그대로(분류기가 읽는다)
 *  ② 실제 어댑터(가짜 네트워크): 도구 뒤 520 · 도구 없이 520 · 도구 뒤 스트림 안 HTML 사유 — 마크업·CSS 0, 제목은 남는다,
 *     재개 권유 대신 «결과 확인·다시 요청»
 *  ③ [배선] 요약(compact) 경로 두 자리도 같은 함수를 지난다 · 재개 권유 문구는 카탈로그에서 빠졌다
 *
 * 등급: ①② **실행**, ③ 배선(소스).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "_codex-html-failure-child.ts");
type J = { outcome?: string; text?: string; calls?: number; advice?: { checkOrAskAgain?: string } };
const child = async (scenario: string): Promise<J> => {
  const r = await spawnWithin(60_000, `codex-html-failure(${scenario})`, ["--import", "tsx", CHILD, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.timedOut) return { outcome: "timeout" };
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  try {
    return line === undefined ? { outcome: "no-output", text: r.err.slice(-300) } : (JSON.parse(line) as J);
  } catch {
    return { outcome: "bad-json", text: line };
  }
};
const MARKUP = /<!DOCTYPE|<html|<head|<title|<style|font-family|margin:0/i;
const TITLE = "chatgpt.com | 520: Web server is returning an unknown error";

export const check: RegressionCheck = {
  name: "codex-html-failure-summarized",
  guards: "프록시 520 HTML 이 오류 안내·/compact 사유에 원문째 실려 제목·CSS 가 채팅에 보이던 것 + 작업 상태를 모른 채 «이어서 진행해줘» 를 권하던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { describeFailureBody } = await import("../../core/outbound-sanitize.js");
    const { isRateLimited } = await import("../../core/llm-runtime/rate-limit.js");
    const cf = `<!DOCTYPE html>\n<html lang="en-US"><head><title>${TITLE}</title><style>body{margin:0}</style></head><body>x</body></html>`;
    const json429 = '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":120}}';
    const pure = {
      html: describeFailureBody(cf),
      lead: describeFailureBody(`  \n<html><body>no title</body></html>`),
      json: describeFailureBody(json429),
      plain: describeFailureBody("error code: 520"),
      empty: describeFailureBody(""),
      inline: describeFailureBody("bad request: <b>x</b>"),
    };
    const limitKept = isRateLimited(`Codex backend request failed: 429 ${describeFailureBody(json429)}`);

    const [se, ne, sh, rf, cx, ch, cs] = [
      await child("side-effect-then-520"),
      await child("520-no-side-effect"),
      await child("side-effect-then-sse-html"),
      await child("oauth-refresh-520"),
      await child("oauth-exchange-520"),
      await child("compact-http-520"),
      await child("compact-sse-html"),
    ];
    const advice = se.advice?.checkOrAskAgain ?? "(없음)";
    const resumeAsk = /이어서 진행해줘|just say "continue"/;

    const hist = stripComments(readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth-history.ts"));
    const main = stripComments(readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"));
    const ko = readSourceSync("locales/ko.json");
    const en = readSourceSync("locales/en.json");
    return [
      assert(
        "★① HTML 오류 페이지만 제목 한 줄로 · 제목 없으면 표식만 · JSON·평문·빈 값·HTML 조각이 섞인 평문은 그대로 · 한도 판정 유지",
        pure.html === `(HTML error page: ${TITLE})` && pure.lead === "(HTML error page)" && pure.json === json429 &&
          pure.plain === "error code: 520" && pure.empty === "" && pure.inline === "bad request: <b>x</b>" && limitKept,
        { ...pure, limitKept },
      ),
      assert(
        "★② 도구 뒤 520 — 안내에 마크업·CSS 0 · 상태와 제목은 남는다 · 재개 권유 대신 결과 확인 안내",
        se.outcome === "returned" && !MARKUP.test(se.text ?? "") && (se.text ?? "").includes("520") &&
          (se.text ?? "").includes(TITLE) && (se.text ?? "").includes(advice) && !resumeAsk.test(se.text ?? ""),
        { outcome: se.outcome, tail: (se.text ?? "").slice(-300) },
      ),
      assert(
        "★② 도구 없이 520 — 정직하게 던지되 오류 문장에 마크업·CSS 0 · 상태 코드·제목은 남는다(재시도 횟수 불변: 1회)",
        ne.outcome === "threw" && !MARKUP.test(ne.text ?? "") && /request failed: 520 \(HTML error page: /.test(ne.text ?? "") &&
          ne.calls === 1,
        { outcome: ne.outcome, calls: ne.calls, text: (ne.text ?? "").slice(0, 300) },
      ),
      assert(
        "② 도구 뒤 스트림 안 실패 사유가 HTML 이어도 안내에 원문이 안 실린다",
        sh.outcome === "returned" && !MARKUP.test(sh.text ?? "") && (sh.text ?? "").includes(TITLE),
        { outcome: sh.outcome, tail: (sh.text ?? "").slice(-300) },
      ),
      assert(
        "★② OAuth 토큰 갱신·코드 교환이 520 HTML 을 받아도 오류 문장에 마크업·CSS 0 · 상태 코드·제목은 남는다(/compact·로그인 안내로 나간다)",
        rf.outcome === "threw" && !MARKUP.test(rf.text ?? "") && (rf.text ?? "").startsWith("OAuth token refresh failed: 520 (HTML error page: ") &&
          (rf.text ?? "").includes(TITLE) &&
          cx.outcome === "threw" && !MARKUP.test(cx.text ?? "") && (cx.text ?? "").startsWith("OAuth code exchange failed: 520 (HTML error page: ") &&
          (cx.text ?? "").includes(TITLE),
        { refresh: (rf.text ?? "").slice(0, 300), exchange: (cx.text ?? "").slice(0, 300) },
      ),
      assert(
        "★② 수동 /compact — 요약 요청이 520 HTML(HTTP)·스트림 안 HTML 사유를 받아도 답장에 마크업·CSS 0 · 제목은 남는다",
        ch.outcome === "skipped" && ch.calls === 1 && !MARKUP.test(ch.text ?? "") && /summary request failed: 520 \(HTML error page: /.test(ch.text ?? "") &&
          (ch.text ?? "").includes(TITLE) &&
          cs.outcome === "skipped" && cs.calls === 1 && !MARKUP.test(cs.text ?? "") && /summary stream failed: [^\n]*\(HTML error page: /.test(cs.text ?? "") &&
          (cs.text ?? "").includes(TITLE),
        { http: (ch.text ?? "").slice(0, 300), sse: (cs.text ?? "").slice(0, 300), calls: [ch.calls, cs.calls] },
      ),
      assert(
        "③ [배선] 요약(compact) HTTP 본문·스트림 사유가 같은 함수를 지나고 · 본 턴도 그 공용 함수를 쓴다 · 재개 권유 키는 카탈로그에 없다",
        /request failed: \$\{res\.status\} \$\{describeFailureBody\(await res\.text\(\)/.test(hist) &&
          /: \$\{describeFailureBody\(f\.message\)\}/.test(hist) &&
          /from "\.\.\/\.\.\/outbound-sanitize\.js"/.test(main) && !/const describeFailureBody/.test(main) &&
          !/srv\.codex\.sayContinue/.test(main + ko + en),
        "history.ts·oauth.ts·locales",
      ),
    ];
  },
};
