/** Execute the real entry bodies in a VM with dependency spies, never real SDKs.
 * Removing/moving the guard must be observable before auth/network is reached.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const root = path.resolve("src/core/llm-runtime");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const js = (source: string): string => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// Keep the complete actual function body, not a hand-copied approximation.
const functionSource = (file: string, name: string): string => {
  const source = read(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const stmt of ast.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt.getText(ast).replace(/^export\s+/, "");
    }
    if (ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations.find((d) => d.name.getText(ast) === name);
      if (decl) return `const ${decl.getText(ast)};`;
    }
  }
  throw new Error(`missing function ${file}:${name}`);
};

export const check: RegressionCheck = {
  name: "regression-no-live-model",
  guards: "Subscription auth or a localhost provider made automatic regression call a real model",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const runner = readFileSync("src/scripts/regression/run.ts", "utf8");
    const seal = runner.indexOf('process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL = "1"');
    out.push(assert("runner seals before discovering/importing checks", seal >= 0 && seal < runner.indexOf('await import('), String(seal)));
    const guardSource = read("regression-model-guard.ts");
    const runtimeGuard = functionSource("index.ts", "assertRuntimeModelAllowed");
    const cases: [string, string, unknown[]][] = [
      ["index.ts", "runRegionA", [{ text: "dummy", channel: "internal", threadKey: "guard", attachments: [] }]],
      ["classify.ts", "cheapInternalTierSpecs", []],
      ["adapters/claude-agent-sdk.ts", "runClaude", [{}]],
      ["adapters/openai-agents-sdk.ts", "runOpenAi", [{}]],
      ["adapters/openai-codex-oauth.ts", "runOpenAiCodex", [{}]],
      ["adapters/openai-codex-oauth-history.ts", "summarizeViaCodex", ["dummy", "dummy-token", undefined, "dummy-model", 100, undefined, undefined]],
      ["codex-weight-probe.ts", "runCodexWeightProbe", []],
    ];
    for (const [file, name, args] of cases) {
      const source = functionSource(file, name);
      // Mutation control disables the guard, never runs real dependencies.
      for (const mode of ["sealed", "cleared", "live", "mutated"] as const) {
        const counts = { auth: 0, sdk: 0, network: 0, enrichment: 0 };
        const stop = (kind: keyof typeof counts) => (..._args: unknown[]): never => {
          counts[kind]++;
          throw new Error(`SPY_${kind}`);
        };
        const env: Record<string, string> = mode === "live" ? {} : { TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" };
        const exports: Record<string, unknown> = {};
        const context = vm.createContext({
          exports, process: { env }, args, adapterForTest: undefined,
          enrichTranscripts: stop("enrichment"), resolveTier: stop("auth"),
          claudeAuthAvailable: stop("auth"), resolveProviderConn: stop("auth"),
          getAuthProvider: stop("auth"), query: stop("sdk"), fetch: stop("network"),
          randomUUID: () => "dummy-uuid", buildSummarizeRequestBody: () => ({}),
          AbortController, setTimeout, clearTimeout, SUMMARY_TIMEOUT_MS: 10,
          config: {}, require: stop("auth"), CODEX_BASE_URL: "https://invalid.example",
          createIdleTimer: () => ({ done() {}, beat() {} }),
          linkAbort: (signal: AbortSignal) => ({ signal }),
        });
        const entries = runtimeGuard + "\n" + source;
        vm.runInContext(js(guardSource + "\n" + (mode === "mutated"
          // 인자 유무와 무관하게 모든 가드 호출을 지운다(`{ fetchOnly: true }` 포함).
          ? entries.replace(/assertLiveModelAllowed\([^)]*\)/g, "void 0") : entries)), context);
        if (mode === "cleared") delete env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL;
        let error = "";
        try { await vm.runInContext(`${name}(...args)`, context); }
        catch (e) { error = String(e); }
        const blocked = error.includes("REGRESSION_LIVE_MODEL_BLOCKED");
        const zero = Object.values(counts).every((n) => n === 0);
        const shouldBlock = mode === "sealed" || mode === "cleared";
        out.push(assert(`${name}: ${mode}`, shouldBlock ? blocked && zero : !blocked && !zero,
          `${error.slice(0, 150)} ${JSON.stringify(counts)}`));
      }
    }
    // The fake seam bypasses only the facade guard, never direct real adapters.
    for (const fake of [false, true]) {
      const context = vm.createContext({ exports: {}, process: { env: { TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" } }, adapterForTest: fake ? () => {} : undefined });
      vm.runInContext(js(guardSource + "\n" + runtimeGuard), context);
      let blocked = false;
      try { vm.runInContext("assertRuntimeModelAllowed()", context); } catch { blocked = true; }
      out.push(assert(`explicit fake=${fake}`, blocked === !fake, String(blocked)));
    }
    // Only after the isolated source-body proof passes, test real module wiring.
    // A broken guard never sends these probes down real dependencies.
    if (out.every((a) => a.ok)) {
      const runtime = await import("../../core/llm-runtime/index.js");
      const { runClaude } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
      const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
      const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
      const { cheapInternalTierSpecs } = await import("../../core/llm-runtime/classify.js");
      const { runCodexWeightProbe } = await import("../../core/llm-runtime/codex-weight-probe.js");
      const input = { text: "dummy", channel: "internal", threadKey: "regression-guard", internal: true };
      const actual: [string, () => unknown][] = [
        ["facade", () => runtime.runRegionA(input)],
        ["claude", () => runClaude(input)], ["openai", () => runOpenAi(input)],
        ["codex", () => runOpenAiCodex(input)], ["cheap-tier", cheapInternalTierSpecs],
        ["weight-probe", runCodexWeightProbe],
      ];
      for (const [name, call] of actual) {
        let error = "";
        try { await call(); } catch (e) { error = String(e); }
        out.push(assert(`actual module ${name} blocked`, error.includes("REGRESSION_LIVE_MODEL_BLOCKED"), error));
      }
      const restore = runtime.__setAdapterForTest(async () => { throw new Error("fake must not run on direct real adapter entry"); });
      try {
        let error = "";
        try { await runClaude(input); } catch (e) { error = String(e); }
        out.push(assert("fake facade seam cannot enable a direct real adapter", error.includes("REGRESSION_LIVE_MODEL_BLOCKED"), error));
      } finally { restore(); }
      // ★명시적 가짜 네트워크(`fakeNetwork`)는 **fetch 로만 통신하는 입구**만 연다 (2026-09-23).
      //  Codex 는 표식 붙은 스텁까지 가고, Claude(SDK 서브프로세스)·OpenAI(SDK) 는 그대로 막히며,
      //  표식 없는 스텁은 Codex 도 못 연다 — 예외가 넓어지면 여기서 운다.
      const { fakeNetwork } = await import("./_framework.js");
      const realFetch = globalThis.fetch;
      const probe = async (marked: boolean): Promise<Record<string, string>> => {
        const stub = async (): Promise<Response> => { throw new Error("FAKE_NETWORK_REACHED"); };
        globalThis.fetch = (marked ? fakeNetwork(stub) : stub) as typeof fetch;
        const res: Record<string, string> = {};
        for (const [name, call] of [["codex", () => runOpenAiCodex(input)], ["claude", () => runClaude(input)], ["openai", () => runOpenAi(input)]] as const) {
          try { await call(); res[name] = "no-error"; } catch (e) { res[name] = String(e).includes("REGRESSION_LIVE_MODEL_BLOCKED") ? "blocked" : "passed-guard"; }
        }
        return res;
      };
      try {
        const marked = await probe(true);
        const unmarked = await probe(false);
        out.push(
          assert("marked fake network opens codex only (claude/openai stay blocked)",
            marked.codex === "passed-guard" && marked.claude === "blocked" && marked.openai === "blocked",
            JSON.stringify(marked)),
          assert("unmarked fetch stub does not open codex", unmarked.codex === "blocked", JSON.stringify(unmarked)),
        );
      } finally { globalThis.fetch = realFetch; }
    }
    return out;
  },
};
