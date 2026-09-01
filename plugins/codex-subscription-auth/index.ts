/**
 * Codex(ChatGPT) **구독** 인증을 이 설치에서 허용한다.
 *
 * ★claude 쪽(`claude-subscription-auth`)과 **같은 자리, 다른 무게**다. 저쪽은 env 문자열
 *  하나를 보는 게 전부라 의존성이 0이고 홈(`<home>/plugins/`)으로 그대로 옮길 수 있다.
 *  이쪽은 **라이브 리프레시**라 그렇지 않다 — PKCE(npm `@openauthjs/openauth`)와 회전한
 *  refresh 토큰을 홈 `.env` 에 다시 쓰는 코어 헬퍼(`upsertHomeEnvVars`·`homeEnvPath`)가
 *  필요하다. 홈 플러그인엔 `node_modules` 도, 코어 경로도 없다.
 *
 * ★그래서 **지금 이건 번들 전용이다.** 뺄 수는 있고(디렉터리를 배포에서 제외하면 codex
 *  백엔드가 `AuthProviderMissingError` 로 graceful self-disable 한다), 기업이 **홈에 다시
 *  깔아 되돌리는** 길은 claude 와 달리 아직 없다. 그 갭은 로드맵에 적었다 — 열려면
 *  «플러그인이 자기 시크릿을 회전·저장하는 길» 이 먼저 필요하다.
 *
 * ★구현은 **코어의 것을 그대로 쓴다**(번들이라 코어를 부를 수 있다). 여기로 복사하면 같은
 *  판단이 두 곳이 되고, 토큰 회전 규칙이 갈리는 순간 한쪽 사용자만 조용히 로그아웃된다.
 */
import type { EventBus } from "../../src/core/eventbus.js";
import type { PluginHost } from "../../src/core/plugins/host.js";
import {
  codexAuthAvailable,
  ensureFreshAccessToken,
} from "../../src/core/llm-runtime/adapters/openai-codex-oauth-auth.js";

export default class CodexSubscriptionAuth {
  async startService(_bus: EventBus, host?: PluginHost): Promise<void> {
    if (host === undefined) return; // 옛 런타임(호스트 미전달)에선 조용히 아무것도 안 한다.
    const r = host.registerAuthProvider({
      provider: "codex",
      getAccessToken: ensureFreshAccessToken,
      isAuthenticated: codexAuthAvailable,
    });
    if (!r.ok) host.log(`구독 인증을 못 켰습니다: ${r.error}`);
  }
  async stop(): Promise<void> {}
}
