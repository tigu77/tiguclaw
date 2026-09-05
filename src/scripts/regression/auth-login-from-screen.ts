/**
 * 회귀: **화면에서 구독 인증을 할 수 있다 — 그리고 그 문이 아무나 여는 문이 아니다**
 * (2026-09-05 정태님 요청: 인증 버튼).
 *
 * 배경: 발급 수단은 있었지만 전부 **터미널 안**이라(`npm run codex-auth`·`claude-auth`),
 * 폰이나 원격에서는 인증할 길이 아예 없었다. 손잡이를 달면서 세 가지가 동시에 걸린다 —
 * 그래서 셋을 한 자리에서 지킨다.
 *
 * ①**자격증명을 만드는 문은 admin 이다.** 로그인 시작·마무리는 `/self-update`·`/restart` 와
 *   같은 등급이어야 한다. 이 레포는 이 자리에서 실제로 당했다: `/set-session-profile` 이
 *   role 표에서 빠져 **read 토큰이 세션 프로파일을 바꿀 수 있었다**(2026-07-28). 표에 한 줄
 *   빠지는 것은 조용하다 — 그래서 검사가 본다.
 * ②**화면이 provider 이름을 박지 않는다.** 어떤 구독이 있는지는 auth 레지스트리가 알고,
 *   어느 플러그인 것인지는 그 플러그인의 선언(`needs.auth`)이 말한다. 화면에 이름을 적으면
 *   셋째 구독이 생길 때 조용히 빠진다([[feedback_hand_maintained_lists]]).
 * ③**토큰은 밖으로 안 나간다.** 인증 라우트는 «인증됐나» 라는 불리언만 내보낸다.
 *   `getAccessToken` 은 부르지도 않는다 — 그건 refresh 부작용까지 있다.
 *
 * ★그리고 **판단이 한 곳**임을 지킨다: 붙여넣은 주소 파싱·CSRF·토큰 저장은 코어에 있고
 *  CLI 도 그걸 쓴다. 베끼면 한쪽만 고쳐지는 날 한쪽 사용자가 조용히 로그아웃된다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "auth-login-from-screen",
  guards:
    "터미널에서만 되던 구독 인증을 화면에 열면서 생기는 셋 — 자격증명 문이 read 로 열리는 것 · 화면이 provider 이름을 박아 셋째 구독이 빠지는 것 · 토큰이 응답에 실리는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── ① 권한 등급 — 시작·마무리는 admin, 목록은 read ────────────────────────
    const bridge = read("plugins/http-bridge/index.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    const roleOf = (route: string): string | null => {
      const m = new RegExp(
        `pathname === "${route}" && method === "(?:GET|POST)"\\s*\\n?\\s*\\?\\s*"(read|write|admin)"`,
      ).exec(bridge);
      return m === null ? null : (m[1] ?? null);
    };
    const begin = roleOf("/auth-login-begin");
    const finish = roleOf("/auth-login-finish");
    out.push(
      assert(
        "★★로그인 시작·마무리는 **admin** 이다(자격증명을 만드는 행위 — read 토큰이 열면 안 된다)",
        begin === "admin" && finish === "admin",
        `begin=${begin ?? "★표에 없음"} finish=${finish ?? "★표에 없음"}`,
      ),
    );
    out.push(
      assert(
        "인증 상태 목록은 read 다(상태를 보는 것은 위험하지 않다 — 토큰은 안 실린다)",
        roleOf("/auth-providers") === "read",
        `providers=${roleOf("/auth-providers") ?? "★표에 없음"}`,
      ),
    );

    // ── ② 이름을 박지 않는다 ──────────────────────────────────────────────────
    const view = read("packages/dashboard/js/view-plugins.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const routes = read("plugins/http-bridge/routes-auth.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const hardcoded = ["codex", "claude-subscription"].filter(
      (id) => view.includes(`"${id}"`) || routes.includes(`"${id}"`),
    );
    out.push(
      assert(
        "★화면·라우트 어디에도 provider 이름이 박혀 있지 않다(레지스트리와 매니페스트가 말한다)",
        hardcoded.length === 0,
        hardcoded.length === 0 ? "박힌 이름 0" : `★박힌 이름: ${hardcoded.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "화면은 플러그인 **선언**(needs.auth)에서 provider 를 뽑는다",
        /authProvidersOf\s*=/.test(view) && /kind === "auth"/.test(view),
        /kind === "auth"/.test(view) ? "needsFacts 의 auth 사실에서 파생" : "★파생 경로 없음",
      ),
    );

    // ── ③ 토큰이 안 나간다 ───────────────────────────────────────────────────
    out.push(
      assert(
        "★인증 라우트는 `getAccessToken` 을 부르지 않는다(토큰 노출 + refresh 부작용)",
        !/getAccessToken\s*\(/.test(routes),
        !/getAccessToken\s*\(/.test(routes) ? "호출 0" : "★호출이 있다",
      ),
    );
    out.push(
      assert(
        "붙여넣은 값(토큰·리다이렉트 주소)을 로그에 남기지 않는다",
        !/console\.[a-z]+\([^)]*pasted/.test(routes),
        !/console\.[a-z]+\([^)]*pasted/.test(routes) ? "로그에 pasted 없음" : "★붙여넣은 값이 로그로 샌다",
      ),
    );

    // ── ④ 판단은 한 곳 — CLI 도 코어 것을 쓴다 ────────────────────────────────
    const cli = read("src/scripts/codex-auth.ts");
    out.push(
      assert(
        "★CLI 가 코어의 마무리 함수를 쓴다(파싱·CSRF·토큰 저장이 두 벌이 아니다)",
        /completeCodexLogin/.test(cli) && !/upsertCodexTokens\(/.test(cli),
        `completeCodexLogin=${/completeCodexLogin/.test(cli)} · 자체 upsert 호출=${/upsertCodexTokens\(/.test(cli)}`,
      ),
    );

    // ── ⑤ 파싱은 **실제로 돌린다** — 사용자가 무엇을 붙여넣을지 우리가 못 정한다 ──
    const { parseRedirectInput } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-login.js"
    );
    const full = parseRedirectInput("http://localhost:1455/auth/callback?code=abc123&state=xyz");
    const qsOnly = parseRedirectInput("code=abc123&state=xyz");
    const quoted = parseRedirectInput('  "http://localhost:1455/auth/callback?code=abc123"  ');
    const junk = parseRedirectInput("그냥 아무거나");
    out.push(
      assert(
        "★주소 전체·쿼리스트링·따옴표 붙은 것 모두에서 code 를 뽑는다(관대하게 받는다)",
        full?.code === "abc123" &&
          full?.state === "xyz" &&
          qsOnly?.code === "abc123" &&
          quoted?.code === "abc123",
        `full=${JSON.stringify(full)} qs=${JSON.stringify(qsOnly)} quoted=${JSON.stringify(quoted)}`,
      ),
    );
    out.push(
      assert(
        "code 가 없으면 null 이다 — 엉뚱한 입력이 «성공» 으로 보이지 않는다",
        junk === null,
        `junk=${JSON.stringify(junk)}`,
      ),
    );

    // ── ⑥ 플러그인 둘 다 «어떻게 인증하나» 를 선언한다 ────────────────────────
    const codexPlugin = read("plugins/codex-subscription-auth/index.ts");
    const claudePlugin = read("plugins/claude-subscription-auth/index.mjs");
    out.push(
      assert(
        "두 구독 플러그인이 login 을 선언한다(선언이 없으면 화면은 버튼을 안 그린다)",
        /login:\s*\{/.test(codexPlugin) && /login:\s*\{/.test(claudePlugin),
        `codex=${/login:\s*\{/.test(codexPlugin)} claude=${/login:\s*\{/.test(claudePlugin)}`,
      ),
    );
    out.push(
      assert(
        "★claude 플러그인은 여전히 **아무것도 import 하지 않는다**(홈으로 옮겨 살아남는 근거)",
        !/^import /m.test(claudePlugin) && /host\.saveAuthEnv/.test(claudePlugin),
        `import=${/^import /m.test(claudePlugin) ? "★생겼다" : "0"} · 저장=host.saveAuthEnv`,
      ),
    );

    return out;
  },
};
export default check;
