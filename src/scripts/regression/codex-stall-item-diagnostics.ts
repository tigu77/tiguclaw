import { newCodexItemObservation, parseCodexSse } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-stall-item-diagnostics",
  guards: "무진전 중 항목 종류·상태·최종수신·제한된 중복을 본문 없이 관측하며 ID/미지종류 폭주에도 진단 메모리는 유계이고 진전 정책은 불변",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const secret = "PRIVATE-CONTENT-ID-CIPHERTEXT-ARGUMENT-998877";
    const obs = newCodexItemObservation();
    const start = Date.now();
    const events = [
      { type: "response.output_item.added", item: { type: "reasoning", id: secret, status: "in_progress", encrypted_content: secret, summary: secret } },
      { type: "response.output_item.added", item: { type: "reasoning", id: secret, status: "in_progress" } },
      { type: "response.output_item.done", item: { type: "reasoning", id: secret, status: "completed", content: secret } },
      { type: "response.output_item.done", item: { type: "reasoning", id: secret, status: "incomplete" } },
      { type: "response.output_item.added", item: { type: secret, id: "other", status: secret, arguments: secret } },
      { type: "response.output_item.done", item: { type: secret, id: "other", status: "failed" } },
      { type: "response.output_item.added" },
      { type: "response.reasoning_summary_text.delta", delta: secret },
      { type: "response.in_progress" },
      { type: "response.completed", response: { id: "r" } },
    ];
    const stream = (xs: unknown[]) => new ReadableStream<Uint8Array>({ start(c) {
      for (const x of xs) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(x)}\n\n`));
      c.close();
    } });
    const progress: string[] = [];
    const result = await parseCodexSse(stream(events), undefined, undefined, (k) => progress.push(k), undefined, undefined, undefined, obs);
    const snap = obs.snapshot();
    const r = snap.kinds.reasoning;
    const o = snap.kinds.other;
    out.push(assert("종류별 added/done·상태·최종수신 시각과 동일 ID 동일 lifecycle 중복만 관측", r?.added === 2 && r.done === 2 && r.duplicateObservations === 2 &&
      r.statuses.in_progress === 2 && r.statuses.completed === 1 && r.statuses.incomplete === 1 &&
      r.lastAddedAt >= start && r.lastDoneAt >= r.lastAddedAt && r.lastDoneAt <= Date.now() &&
      o?.added === 2 && o.done === 1 && o.statuses.other === 1 && o.statuses.failed === 1 && o.statuses.absent === 1,
      snap));
    out.push(assert("새 snapshot에 원문/ID/암호문/인자/미지타입/미지상태 비노출", !JSON.stringify(snap).includes(secret) &&
      snap.trackedItems === 2 && snap.untrackedObservations === 1 && snap.duplicateCoverage === "bounded-item-id", snap));
    out.push(assert("reasoning lifecycle/heartbeat는 진전 아님·기존 반환값도 관측기 유무와 동일", progress.length === 0 &&
      JSON.stringify(result) === JSON.stringify(await parseCodexSse(stream(events))), progress));

    // 고정 종류/상태와 최대128 ID. 이미 기억한 ID는 포화 뒤에도 판정하고 못 기억한 것은 불명확으로 센다.
    const bounded = newCodexItemObservation();
    for (let i = 0; i < 5000; i++) bounded.observe("added", { type: `unknown-${i}-${secret}`, status: `unknown-${i}`, id: `id-${i}` });
    bounded.observe("added", { type: "reasoning", id: "id-0" });
    bounded.observe("done", { type: "reasoning", id: "id-0" });
    bounded.observe("done", { type: "reasoning", id: "id-0" });
    bounded.observe("done", { type: "reasoning", id: "x".repeat(257) });
    bounded.observe("done", { type: "reasoning", id: "" });
    bounded.observe("done", { type: "reasoning", id: 4 });
    const full = bounded.snapshot();
    out.push(assert("진단 ID128개·미지종류/상태 한 버킷·누락/초과ID는 미추적, 포화 후 기존ID 중복은 관측", full.trackedItems === 128 &&
      full.untrackedObservations === 5000 - 128 + 3 && Object.keys(full.kinds).length === 2 &&
      full.kinds.other?.added === 5000 && full.kinds.other.statuses.other === 5000 && full.kinds.reasoning?.duplicateObservations === 2 &&
      JSON.stringify(full).length < 1500 && !JSON.stringify(full).includes(secret), full));
    const before = JSON.stringify(bounded.snapshot());
    full.kinds.reasoning!.added = -1;
    full.kinds.reasoning!.statuses.absent = -1;
    out.push(assert("snapshot은 내부상태를 내주지 않는다·새 시도는 완전히 빈 관측", JSON.stringify(bounded.snapshot()) === before &&
      JSON.stringify(newCodexItemObservation().snapshot().kinds) === "{}" && newCodexItemObservation().snapshot().trackedItems === 0, before));
    for (const type of ["message", "function_call", "web_search_call", "computer_call", "local_shell_call"]) {
      const one = newCodexItemObservation();
      one.observe("added", { type, id: type }); one.observe("done", { type, id: type, status: "completed" });
      out.push(assert(`${type}: added와done은 서로 중복 아님`, one.snapshot().kinds[type]?.added === 1 && one.snapshot().kinds[type]?.done === 1 &&
        one.snapshot().kinds[type]?.duplicateObservations === 0, one.snapshot()));
    }
    return out;
  },
};
