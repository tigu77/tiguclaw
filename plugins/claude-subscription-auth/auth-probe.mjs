/** runtime과 독립 CLI가 함께 쓰는 네트워크·쓰기 없는 판정. */
export const claudeSubscriptionAuthenticated = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim() !== "";
export const authProbe = {
  provider: "claude-subscription",
  isAuthenticated: claudeSubscriptionAuthenticated,
  register: (host) => host.registerAuthProvider({
    provider: "claude-subscription",
    isAuthenticated: claudeSubscriptionAuthenticated,
    getAccessToken: async () => { throw new Error("Standalone auth probe cannot supply access tokens"); },
  }),
};
