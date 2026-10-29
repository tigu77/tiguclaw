// Isolated auth probe: no service/DB/token refresh or external requests.
import { writeFileSync } from "node:fs";
import path from "node:path";
const mode = process.argv[2]!;
const home = process.env.TIGUCLAW_HOME!;
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|OPENAI_)/.test(key)) delete process.env[key];
if (mode === "access") process.env.OPENAI_CODEX_OAUTH_TOKEN = "fixture-access";
if (mode === "refresh" || mode === "disabled") process.env.OPENAI_CODEX_OAUTH_REFRESH = "fixture-refresh";
if (mode === "claude") process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-claude";
if (mode === "openai") process.env.OPENAI_API_KEY = "fixture-key";
if (mode === "disabled") writeFileSync(path.join(home, "settings.json"), JSON.stringify({ modules: { disabled: ["codex-subscription-auth"] } }));
if (mode === "custom") writeFileSync(path.join(home, "settings.json"), JSON.stringify({ models: { providers: { localfixture: { adapter: "openai", baseURL: "http://127.0.0.1:1/v1", apiKeyEnv: null } }, profiles: { chosen: { pool: ["localfixture:fixture-model"] } }, default: "chosen" } }));
const { registerStandaloneAuthProbes } = await import("../../core/standalone-auth.js");
await registerStandaloneAuthProbes();
const { providerAuthAvailable } = await import("../../core/llm-runtime/provider-availability.js");
const { builtinPool } = await import("../../core/llm-runtime/builtin-profiles.js");
const { getAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
let tokenBlocked = false;
try { await getAuthProvider("codex")?.getAccessToken(); } catch { tokenBlocked = true; }
console.log("PROBE_RESULT=" + JSON.stringify({ codex: providerAuthAvailable("codex"), claude: providerAuthAvailable("anthropic"), openai: providerAuthAvailable("openai"), custom: providerAuthAvailable("localfixture"), pool: builtinPool(), registered: getAuthProvider("codex") !== undefined, tokenBlocked }));
