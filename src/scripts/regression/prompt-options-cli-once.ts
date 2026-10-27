/** CLI 숫자 선택도 공통 발급 대장의 첫 답만 처리한다. 실제 CLI line 핸들러, readline/화면만 가짜. */
import vm from "node:vm";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "prompt-options-cli-once",
  guards: "대시보드와 CLI 양쪽에서 같은 질문에 두 번 답하는 것 + CLI 숫자 답이 원세션 대신 바뀐 바인딩으로 가는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const claims = await import("../../core/prompt-answer-claims.js");
    const { withPromptOptionsObservation } = await import("../../core/prompt-options-observe.js");
    const { resolveSessionId } = await import("../../core/threadkey.js");
    let line: (s: string) => Promise<void> = async () => {};
    const rl = { setPrompt() {}, prompt() {}, close() {}, on(k: string, fn: typeof line) { if (k === "line") line = fn; } };
    const exports: Record<string, unknown> = {};
    const src = await readFile(new URL("../../../plugins/cli-channel/index.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, require: (n: string) => {
      if (n === "node:readline") return { createInterface: () => rl };
      if (n.endsWith("prompt-answer-claims.js")) return claims;
      if (n.endsWith("threadkey.js")) return { resolveSessionId };
      if (n.endsWith("i18n.js")) return { translate: (k: string) => k };
      throw new Error(`CLI fixture missing import: ${n}`);
    }, process: { stdin: {}, stdout: { write() {} }, exit() {} }, console });
    const Cli = exports.default as new () => { start(h: (m: Record<string, unknown>) => Promise<void>): Promise<void>; stop(): Promise<void> };
    const cli = new Cli();
    const seen: Record<string, unknown>[] = [];
    await cli.start(async (m) => { seen.push(m); });
    const out: Assertion[] = [];
    try {
      await line("질문 턴");
      const render = seen[0]?.presentOptions as never;
      let id = "";
      const present = withPromptOptionsObservation(render, { channel: "cli", threadKey: "dashboard:cli-origin", bus: { publish: (e: { payload: { promptId: string } }) => { id = e.payload.promptId; } } as never });
      const options = [{ label: "A", value: "answer-a" }, { label: "B", value: "answer-b" }];
      await present?.("질문", options);
      claims.claimPromptAnswer(id); // 대시보드가 먼저 응답
      const before = seen.length;
      await line("1");
      out.push(assert("★대시보드가 먼저 답한 질문의 CLI 숫자 선택은 실행하지 않는다", seen.length === before, { before, after: seen.length }));
      await present?.("질문2", options);
      await line("2");
      const last = seen.at(-1);
      out.push(assert("★CLI가 먼저 답하면 원세션/정규화 명시세션이 같고 대시보드 두번째 답은 거절된다", last?.text === "answer-b" && last.threadKey === "dashboard:cli-origin" && (last.session as { explicitSessionId?: string })?.explicitSessionId === "dashboard:cli-origin" && claims.claimPromptAnswer(id) === "answered", { text: last?.text, thread: last?.threadKey, session: last?.session }));
      await present?.("질문3", options);
      await line("직접 쓴 글");
      out.push(assert("직접 텍스트는 선택지 소비 없이 기존 발화로 전달", seen.at(-1)?.text === "직접 쓴 글" && claims.claimPromptAnswer(id) === "ok", { text: seen.at(-1)?.text }));
      const direct = seen[0]?.presentOptions as (q: string, o: typeof options) => Promise<unknown>;
      await direct("슬래시", [{ label: "세션", value: "/sessions" }]);
      await line("1");
      out.push(assert("ID 없는 슬래시 선택지의 숫자 답은 기존 경로·명시세션 없음", seen.at(-1)?.text === "/sessions" && (seen.at(-1)?.session as { explicitSessionId?: string })?.explicitSessionId === undefined, { text: seen.at(-1)?.text, session: seen.at(-1)?.session }));
      await present?.("질문4", options);
      claims.__resetPromptClaimsForTest();
      const beforeExpired = seen.length;
      await line("1");
      out.push(assert("재시작/상한 퇴출로 만료된 질문은 CLI도 재수락하지 않는다", seen.length === beforeExpired, { before: beforeExpired, after: seen.length }));
    } finally { await cli.stop(); }
    return out;
  },
};
export default check;
