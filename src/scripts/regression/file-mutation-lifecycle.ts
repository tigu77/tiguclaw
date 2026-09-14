/** 실패가 일어날 때 후속 작업이 이미 큐에 있는 조건과 완료 후 보유 상태를 검사한다. */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "file-mutation-lifecycle",
  guards: "실패 전에 후속 작업이 큐에 붙은 경우의 복구와 완료 후 Map 정리를 검사하지 않던 것",
  run: async (): Promise<Assertion[]> => {
    // 실제 모듈 전체를 실행하되 Map의 set 관측만 붙인다. 제품 export나 전역 Map은 바꾸지 않는다.
    let observed!: Map<string, Promise<unknown>>;
    let onSet: (() => void) | undefined;
    class ObservedMap extends Map<string, Promise<unknown>> {
      constructor() { super(); observed = this; }
      override set(key: string, value: Promise<unknown>): this {
        super.set(key, value); onSet?.(); onSet = undefined; return this;
      }
    }
    const source = readFileSync(new URL("../../core/llm-runtime/capabilities/_file-mutation.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {} as { withFileMutation: <T>(file: string, run: () => Promise<T>) => Promise<T> };
    new Function("require", "exports", "Map", compiled)(createRequire(import.meta.url), exports, ObservedMap);
    const run = exports.withFileMutation;
    const dir = await mkdtemp(path.join(tmpdir(), "file-queue-lifecycle-"));
    const file = path.join(dir, "new.txt");
    const out: Assertion[] = [];
    let releaseFirst!: () => void, releaseSecond!: () => void, enteredFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const started = new Promise<void>(resolve => { enteredFirst = resolve; });
    let first: Promise<string> | undefined, second: Promise<string> | undefined;
    try {
      first = run(file, async () => { enteredFirst(); await firstGate; throw new Error("synthetic failure"); }).catch(() => "failed");
      const began = await within(2000, "첫 작업 시작", started);
      if (!("value" in began)) throw new Error(began.timedOut);
      const enqueued = new Promise<void>(resolve => { onSet = resolve; });
      let secondRan = false;
      second = run(file, async () => { secondRan = true; await secondGate; return "recovered"; }).catch(() => "rejected");
      const queued = await within(2000, "후속 작업 큐 등록", enqueued);
      if (!("value" in queued)) throw new Error(queued.timedOut);
      out.push(assert("후속 작업 등록 뒤에도 첫 작업을 추월하지 않음", !secondRan && observed.size === 1, { secondRan, size: observed.size }));
      releaseFirst(); await first;
      out.push(assert("앞선 실패 정리가 대기 중인 새 tail을 지우지 않음", observed.size === 1, observed.size));
      releaseSecond();
      const recovered = await within(2000, "후속 실패 복구", second);
      out.push(assert("이미 큐에 붙은 후속 작업은 첫 실패 뒤 실제 실행", "value" in recovered && recovered.value === "recovered" && secondRan, { recovered, secondRan }));
      out.push(assert("실패와 후속 성공이 정리된 경로는 Map에서 해제", observed.size === 0, observed.size));
      for (let i = 0; i < 12; i++) {
        await run(path.join(dir, `success-${i}`), async () => i);
        await run(path.join(dir, `failure-${i}`), async () => { throw new Error("failure"); }).catch(() => undefined);
      }
      out.push(assert("서로 다른 완료 경로가 성공·실패와 무관하게 누적되지 않음", observed.size === 0, observed.size));
    } finally {
      releaseFirst(); releaseSecond(); onSet = undefined;
      await within(2000, "검사 작업 정리", Promise.allSettled([first, second]));
      await rm(dir, { recursive: true, force: true });
    }
    return out;
  },
};
