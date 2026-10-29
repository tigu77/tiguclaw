/** 서비스/login/usage 모듈을 부팅하지 않는 독립 CLI용 조회 표면. */
import type { PluginHost } from "../../src/core/plugins/host.js";
import { codexAuthAvailable } from "../../src/core/llm-runtime/codex-auth-presence.js";
export const authProbe = {
  provider: "codex",
  isAuthenticated: codexAuthAvailable,
  register: (host: Pick<PluginHost, "registerAuthProvider">) => host.registerAuthProvider({
    provider: "codex",
    isAuthenticated: codexAuthAvailable,
    getAccessToken: async () => { throw new Error("Standalone auth probe cannot supply access tokens"); },
  }),
};
