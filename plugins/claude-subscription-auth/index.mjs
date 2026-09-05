/**
 * Claude **구독** 인증을 이 설치에서 허용한다.
 *
 * ★왜 플러그인인가 (2026-09-01, 정태님 확정). Business 판은 구독을 빼고, 꼭 필요하면 기업이
 *  **설치라는 명시적·귀속 가능한 행위**로 책임을 가져간다. 그 «되돌리는 길» 이 성립하려면
 *  코드가 앱 트리 밖에 있어야 한다 — 앱 트리는 `/update` 가 소스에서 다시 지어 되살린다.
 *  홈(`<home>/plugins/`)은 레포 밖이라 살아남는다.
 *
 * ★**어댑터가 아니라 인증만** 여기 있다. claude 어댑터는 SDK 의존이라 코어에 남는다(홈
 *  플러그인엔 `node_modules` 가 없다 — 폴더에 `npm i` 하면 실측 247MB). 여기가 하는 일은
 *  «이 설치에서 구독 토큰을 인증으로 인정한다» 는 **선언** 하나이고, 그건 env 문자열을 보는
 *  게 전부라 **의존성이 0**이다. 그래서 이 파일은 아무것도 import 하지 않는다.
 *
 * ★**없는 상태가 안전한 상태다.** 이 플러그인이 없으면 `CLAUDE_CODE_OAUTH_TOKEN` 이
 *  `.env` 에 있어도 데몬은 구독으로 안 돈다. API 키(`ANTHROPIC_API_KEY`)는 레지스트리를
 *  안 지나므로 **그대로 산다** — 능력 손실이 아니라 비용 차이다.
 *
 * ★이건 격리가 아니라 **책임 경계**다. 격리가 0이라 마음먹은 운영자는 우회할 수 있다.
 *  막는 것은 «아무도 모르게 구독으로 돌아가는 것» 이다.
 */
const token = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();

export default class ClaudeSubscriptionAuth {
  async startService(_bus, host) {
    if (host === undefined) return; // 옛 런타임(호스트 미전달)에선 조용히 아무것도 안 한다.
    const r = host.registerAuthProvider({
      provider: "claude-subscription",
      isAuthenticated: () => token() !== "",
      getAccessToken: async () => {
        const t = token();
        if (t === "") {
          throw new Error(
            "claude 구독 토큰이 없습니다 — `npm run claude-auth` 로 CLAUDE_CODE_OAUTH_TOKEN 을 발급하세요.",
          );
        }
        return t;
      },
      /**
       * ★**여기는 «끝까지» 가 안 된다 — 그래서 그렇게 말한다** (2026-09-05 실측).
       *  발급은 번들 `claude setup-token` 이 하는데 그건 **TTY 가 필요**하다: 비TTY 로 돌리면
       *  12초간 출력이 0이고, `script -q` 로 PTY 를 붙이는 무의존 우회도 부모에 TTY 가
       *  없으면 실패한다(`tcgetattr/ioctl`). codex 처럼 «버튼 한 번» 이라고 적으면 그건
       *  거짓말이 된다.
       * ★대신 두 길을 연다: 그 기계 **터미널 한 줄**(화면이 복사 버튼과 함께 보여준다)과,
       *  이미 받은 토큰 **붙여넣기**. 폰에서도 후자로 끝낼 수 있다.
       * ★저장은 `host.saveAuthEnv` 로 한다 — 이 파일이 **아무것도 import 하지 않는** 성질을
       *  지키기 위해서다(그게 이 플러그인이 홈으로 옮겨 살아남는 근거다).
       */
      login: {
        label: "구독 토큰 발급",
        begin: async () => ({
          summary:
            "Claude Code 실행기가 토큰을 발급합니다. 이 발급기는 터미널이 필요해서(실측) " +
            "여기서 끝까지는 안 됩니다 — 아래 명령을 그 기계 터미널에서 돌리고, 나온 토큰을 붙여넣으세요.",
          command: "npm run claude-auth",
          pasteHint: "발급된 토큰 (sk-ant- 로 시작합니다)",
          needsRestart: false,
        }),
        finish: async (pasted) => {
          const t = String(pasted ?? "").trim();
          // ★모양만 본다(접두는 우리 redact 규칙이 이미 아는 것과 같다). 유효성은 상류가
          //  정하는 것이라 여기서 단정하지 않는다 — 다만 빈 값·따옴표 사고는 막는다.
          const token = (/\bsk-ant-[A-Za-z0-9._-]{20,}\b/.exec(t) ?? [])[0] ?? "";
          if (token === "") {
            return { ok: false, message: "토큰을 못 찾았습니다 — `sk-ant-` 로 시작하는 값을 붙여넣으세요." };
          }
          const w = await host.saveAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: token });
          if (!w.ok) return { ok: false, message: w.error ?? "저장 실패" };
          return { ok: true, message: "토큰을 홈 .env 에 저장했습니다 — 다음 턴부터 구독으로 돕니다." };
        },
      },
    });
    if (!r.ok) host.log(`구독 인증을 못 켰습니다: ${r.error}`);
    else if (token() === "") {
      host.log("구독 인증 허용됨 — 다만 CLAUDE_CODE_OAUTH_TOKEN 이 아직 없습니다(API 키는 그대로 됩니다).");
    }
  }
  async stop() {}
}
