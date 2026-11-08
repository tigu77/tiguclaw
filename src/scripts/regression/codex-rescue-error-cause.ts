import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-rescue-error-cause",
  guards: "One local context rescue must not relabel later auth/quota/transport errors as context errors or replay the whole tool-executing turn.",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const existing = ["Read", "Write"].flatMap((tool) => ["401", "403", "429", "400", "network", "context", "cancel", "sse-auth"].map((mode) => [tool, mode] as const));
    const recovery = ["retry-backend", "retry-stall", "retry-cut", "retry-backend-exhaust", "retry-stall-exhaust", "retry-partial", "retry-external", "retry-native", "retry-search", "retry-cancel", "zero-http", "zero-sse", "zero-native-http", "zero-native-sse", "zero-text", "zero-external", "zero-failed-read", "zero-blocked"].map((mode) => ["Read", mode] as const);
    for (const [tool, mode] of [...existing, ...recovery]) {
      const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "rescue-error-"));
      const osHome = path.join(home, "os-home");
      const tmp = path.join(home, "tmp");
      mkdirSync(osHome); mkdirSync(tmp);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|LANG|LC_ALL|NODE_COMPILE_CACHE|TIGUCLAW_DISABLE_ENV_FILE|TIGUCLAW_REGRESSION_NO_LIVE_MODEL|TIGUCLAW_OS_LOCALE|TIGUCLAW_REGRESSION|TIGUCLAW_REGRESSION_NETWORK_PRELOAD)$/.test(k)));
      const r = await spawnWithin(mode === "retry-backend-exhaust" ? 45_000 : 20_000, `${tool}/${mode}`, [...process.execArgv, fileURLToPath(new URL("./_codex-rescue-error-child.ts", import.meta.url)), mode, tool], {
        cwd: home, env: { ...env, HOME: osHome, TIGUCLAW_HOME: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, stdio: ["ignore", "pipe", "pipe"],
      });
      const raw = /RESCUE_ERROR_RESULT (.+)/.exec(r.out)?.[1];
      const v = raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>;
      out.push(assert(`${tool}/${mode}: actual adapter fixture completes`, !r.timedOut && r.code === 0 && v !== undefined, v ?? { r }));
      if (v === undefined) continue;
      if (mode.startsWith("zero-")) {
        const allowed = ["zero-http", "zero-sse", "zero-native-http"].includes(mode);
        out.push(assert(`${mode}: only proven pre-rescue zero-dispatch rejection may fall back`,
          v.requests === (mode === "zero-failed-read" ? 2 : 1) && v.starts === (mode === "zero-failed-read" ? 1 : 0) &&
          v.fallback === (allowed ? 1 : 0) && v.attempts === (allowed ? 2 : 1) &&
          (allowed ? v.text === "INCORRECT_FALLBACK" : v.text !== "INCORRECT_FALLBACK"), v));
        continue;
      }
      if (mode.startsWith("retry-")) {
        const success = ["retry-backend", "retry-stall", "retry-cut"].includes(mode);
        const expected = mode === "retry-backend-exhaust" ? 8 : mode === "retry-stall-exhaust" ? 6 : success ? 5 : 4;
        out.push(assert(`${mode}: bounded same-step requests; no tool/turn replay or candidate fallback`,
          v.starts === 6 && v.requests === expected && v.reduced === true && v.sameRetryBody === true &&
          v.attempts === 1 && v.fallback === 0 && v.replayAllowed === false &&
          (success ? v.text === "recovered current step" : v.text === ""), v));
        if (mode === "retry-native" || mode === "retry-search") out.push(assert(`${mode}: provider-executed tool was actually offered in the failed request`, v.providerToolsOffered === true, v));
        if (mode === "retry-cancel") out.push(assert("retry backoff abort preserves cancellation identity without one extra fetch", v.cancellationIdentity === true, v));
        continue;
      }
      const expectedRequests = mode === "429" || mode === "network" ? 6 : 4;
      out.push(assert(`${tool}/${mode}: six planned tool dispatches, one reduced rescue, no whole-turn fallback or extra stream/fold recovery`,
        v.starts === 6 && v.requests === expectedRequests && v.reduced === true && v.sameRetryBody === true && v.attempts === 1 && v.fallback === 0 && v.text === "" && v.replayAllowed === false,
        v));
      const expectedKind = ["401", "403", "sse-auth"].includes(mode) ? "auth" : mode === "429" ? "limit" : null;
      const expectedContext = mode === "context";
      const reasonPreserved = mode === "context" ? v.context === true : mode === "network" ? v.networkIdentity === true && v.causeIdentity === true && v.networkCode === "SYNTHETIC_NETWORK" && v.causeCode === "ECONNRESET" : mode === "cancel" ? v.cancellationIdentity === true :
        String(v.message).includes(mode === "sse-auth" ? "authentication_error" : `failed: ${mode}`) && String(v.message).includes(mode === "429" ? "usage_limit_reached" : mode === "400" ? "invalid_prompt" : mode === "sse-auth" ? "synthetic access rejected" : "invalid_api_key");
      out.push(assert(`${tool}/${mode}: actual failure identity/status/code/message/cause and facade cooldown classification are preserved`,
        v.context === expectedContext && reasonPreserved && v.classified === expectedKind && v.cooldown === expectedKind && (tool !== "Write" || v.writeContent === "synthetic-executed-once"), v));
    }
    return out;
  },
};
