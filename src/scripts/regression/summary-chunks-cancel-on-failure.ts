/**
 * 회귀: **병렬 요약에서 한 조각이 실패하면 나머지 요청을 끊는다** (2026-10-08 외부 검토 E1).
 *
 * 사고(검토 재현): `summarizeInChunks` 가 조각을 `Promise.all` 로 동시에 부르는데, 첫 실패로 돌아와도 남은 요청은 그대로 돌아 끝까지
 * 과금됐다(실패 시점 진행 2 → 완료 2). 묶음 전체가 실패로 버려지므로 기다릴 이유가 없다.
 *
 * 등급: **동작** — 실제 `summarizeInChunks` 에 가짜 요약기를 넣는다(모델 호출 0).
 */
import { readFileSync } from "node:fs";
import { summarizeInChunks } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "summary-chunks-cancel-on-failure",
  guards: "조각 요약 하나가 실패해도 나머지 조각 요청이 끝까지 돌아 과금되던 것",
  run: async (): Promise<Assertion[]> => {
    let started = 0;
    let cancelled = 0;
    let completed = 0;
    const text = "가".repeat(30_000);
    const t0 = Date.now();
    let failedWith = "";
    try {
      await summarizeInChunks(text, 10_000, async (_piece, _target, signal) => {
        const me = started++;
        if (me === 0) {
          await new Promise((r) => setTimeout(r, 20));
          throw new Error("summary-fake-failure");
        }
        // 나머지는 오래 걸린다 — 신호로 끊기지 않으면 2초를 다 쓴다
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => { completed++; resolve(); }, 2_000);
          signal?.addEventListener("abort", () => { clearTimeout(t); cancelled++; reject(new Error("aborted")); }, { once: true });
        });
        return "요약";
      });
    } catch (e) {
      failedWith = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 50));
    const ms = Date.now() - t0;
    // 배선 — 두 요약기가 묶음 신호를 실제 요청까지 넘긴다(codex 는 compaction 회귀가 따로 본다 · openai 는 여기서만).
    const oa = readFileSync(new URL("../../core/llm-runtime/adapters/openai-agents-sdk.ts", import.meta.url), "utf8");
    const hist = readFileSync(new URL("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts", import.meta.url), "utf8");
    const wired = {
      openai: /summarize: async \(text, targetChars, batch\) =>/.test(oa) && /linkAbort\(sumAc\.signal, input\.abortSignal, batch\)/.test(oa),
      codexAuto: /summarize: \(text, targetChars, batch\) =>[\s\S]{0,300}anySignal\(input\.abortSignal, batch\)/.test(hist),
      codexManual: /summarizeInChunks\(prompt, plan\.chunkChars, \(piece, target, batch\) =>[\s\S]{0,300}anySignal\(signal, batch\)/.test(hist),
    };
    return [
      assert("전제 — 조각이 여럿 동시에 시작했다", started >= 3, `시작 ${started}`),
      assert(
        "★첫 조각이 실패하면 나머지는 신호로 끊긴다(끝까지 돌지 않는다) · 호출자는 그 실패를 받는다",
        cancelled === started - 1 && completed === 0 && failedWith === "summary-fake-failure" && ms < 1_000,
        { started, cancelled, completed, failedWith, ms },
      ),
      assert("배선 — codex(자동·수동)·openai 요약기가 묶음 신호를 요청 취소에 잇는다", Object.values(wired).every(Boolean), wired),
    ];
  },
};
