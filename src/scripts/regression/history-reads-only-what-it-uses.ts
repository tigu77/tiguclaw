/**
 * 회귀: **모델 이력은 쓰는 만큼만 읽는다** — 결과는 그대로 (2026-10-15 정태님 «굳이 다 읽을 필요가 있어? … 하루에 엄청나게 많은 대화가 생길 수 있다»).
 *
 * 종전엔 매 턴 대화 기록 **전체**를 DB 에서 읽었다(동기 — 그동안 데몬 전체가 멎는다, 8만 행 ≈0.5초). 그런데 쓰는 것은
 *  ①Claude 재개 보강: 끝에서 최대 `limit`(40) 행 ②Codex·OpenAI: 요약 워터마크 **뒤**만(앞은 이미 요약에 접혔다). 이제 그만큼만 읽는다.
 * ★위험은 «0개 = 기록 없음» 판정이었다 — 워터마크 뒤가 비어도 요약은 있다. 요약만 있는 대화에서 요약이 빠지면 안 된다.
 *
 * 등급: **실행**(격리 DB · 실제 적재기·조립기).
 */
import { randomUUID } from "node:crypto";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "history-reads-only-what-it-uses",
  guards: "매 턴 대화 기록 전체를 읽어 긴 대화일수록 매 턴 데몬이 멎던 것 — 결과(최근 창·재개 경계·요약)는 그대로여야 한다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb, SESSION_STORAGE_CHANNEL: CH } = await import("../../store/sessions.js");
    initStore();
    const mem = await import("../../store/memory.js");
    const db = getDb();
    const K = `dashboard:${randomUUID()}`;
    const ins = db.prepare(`INSERT INTO transcripts (claude_session_id, ts, role, content) VALUES (?, ?, ?, ?)`);
    const idx = db.prepare(`INSERT OR IGNORE INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed) VALUES (?, ?, ?, '(codex)', 0, 0)`);
    const N = 30_000;
    // Codex 턴(턴마다 세션) 사이사이 Claude 세션 하나 — 재개 경계가 창 안·밖 모두 생기게.
    const claude = `claude-${K}`;
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const sid = i % 50 === 0 || i === N - 5 ? claude : `codex-${K}-${i}`; // 마지막 Claude 턴은 끝 가까이 — 경계가 창 안에 오게
        // ★ts 동률을 일부러 만든다 — 실제 기본 대화엔 동률 묶음이 170개다(같은 ms 의 사용자·비서 쌍). 창 안 순서가 뒤집히면 잡혀야 한다.
        ins.run(sid, 1000 + Math.floor(i / 3) * 2, "user", `질문${i}`);
        ins.run(sid, 1000 + Math.floor(i / 3) * 2, "assistant", `답${i}`);
        idx.run(CH, K, sid);
      }
    })();
    // 참조 = 종전 동작을 **독립으로** 다시 짓는다(검사 대상 함수를 참조로 쓰면 같은 변이가 양쪽에 걸려 안 보인다 — 재검토 G1):
    //  이 대화 행 전부를 (ts, id) 오름차순으로 · 재개 경계 = 그 세션 마지막 행 뒤 · 끝에서 limit 개.
    const tailOf = <T>(xs: T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n));
    const allRows = db.prepare(`SELECT t.claude_session_id AS sid, t.content FROM transcripts t JOIN transcript_index ti ON ti.claude_session_id = t.claude_session_id
      WHERE ti.channel = ? AND ti.thread_key = ? AND t.role IN ('user','assistant') ORDER BY t.ts ASC, t.id ASC`).all(CH, K) as { sid: string; content: string }[];
    const full = allRows.map((r) => r.content);
    const afterOf = (sid: string): string[] => { let i = -1; allRows.forEach((r, j) => { if (r.sid === sid) i = j; }); return full.slice(i + 1); };
    const fullAfter = afterOf(claude);
    const now = mem.loadThreadHistory(CH, K).map((t) => t.content);
    const nowAfter = mem.loadThreadHistory(CH, K, { afterSessionId: claude }).map((t) => t.content);
    out.push(assert("★★Claude 보강(최근 창·재개 경계 뒤)이 종전 «전체를 읽고 끝에서 자르기» 와 같다",
      JSON.stringify(now) === JSON.stringify(tailOf(full, 40)) && JSON.stringify(nowAfter) === JSON.stringify(tailOf(fullAfter, 40)) && nowAfter.length > 0 && nowAfter.length < 40,
      { now: now.length, nowAfter: nowAfter.length, last: nowAfter.at(-1) }));
    // 창 밖 경계 — 최근 40 행 안에 Claude 행이 없으면 종전처럼 창 전체.
    const far = `claude-far-${K}`;
    ins.run(far, 1, "user", "아주 옛날"); idx.run(CH, K, far);
    const farNow = mem.loadThreadHistory(CH, K, { afterSessionId: far }).map((t) => t.content);
    const farRef = tailOf(mem.loadThreadHistory(CH, K, { limitTurns: 1e9, charCap: 1e12 }).map((t) => t.content), 40);
    out.push(assert("재개 경계가 창 밖(오래전)이면 종전처럼 창 전체", JSON.stringify(farNow) === JSON.stringify(farRef) && farNow.length === 40, farNow.length));

    // 읽는 양 — DB 가 돌려준 행 수를 직접 센다(시간은 뒤처리까지 섞여 읽기 양을 못 가른다 — 처음 그렇게 썼다가 «전체 읽기» 변이가 살았다).
    const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as { all: (...a: unknown[]) => unknown };
    const origAll = proto.all;
    let fetched = 0;
    proto.all = function (this: unknown, ...a: unknown[]) { const r = origAll.apply(this, a); if (Array.isArray(r)) fetched += r.length; return r; };
    try { mem.loadThreadHistory(CH, K); mem.loadThreadHistory(CH, K, { afterSessionId: claude }); } finally { proto.all = origAll; }
    out.push(assert("★6만 행 대화에서 Claude 보강 두 번이 DB 에서 받은 행 = 80 이하(창만큼)", fetched <= 80, { fetched }));

    // Codex·OpenAI — 워터마크 뒤만 읽는다. 뒤가 비어도 **요약은 실린다**.
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { upsertThreadSummary } = await import("../../store/thread-summaries.js");
    const Z = `dashboard:${randomUUID()}`;
    let lastId = 0;
    for (let i = 0; i < 5; i++) {
      mem.appendTranscript({ claudeSessionId: `codex-${Z}-${i}`, role: "user", content: `옛질문${i}` });
      lastId = mem.appendTranscript({ claudeSessionId: `codex-${Z}-${i}`, role: "assistant", content: `옛답${i}` })!;
      mem.indexCodexTurn({ channel: CH, threadKey: Z, claudeSessionId: `codex-${Z}-${i}` });
    }
    upsertThreadSummary({ threadKey: Z, summary: "요약본-ZQX", compactedThrough: lastId });
    const after = mem.loadThreadHistoryWithIds(CH, Z, { after: lastId });
    const built = JSON.stringify(await H.buildTurnHistory({ threadKey: Z, channel: CH, provider: "codex-oauth" } as never, "지금 질문", [], "t", undefined, "gpt-6-sol", 1_000));
    out.push(assert("★Codex: 요약 뒤 새 턴이 없어도 요약이 실린다(«0개 = 기록 없음» 으로 요약을 빠뜨리지 않는다) · 접힌 옛 턴은 안 읽는다",
      after.length === 0 && built.includes("요약본-ZQX") && !built.includes("옛질문0") && built.includes("지금 질문"),
      { after: after.length, hasSummary: built.includes("요약본-ZQX"), hasOld: built.includes("옛질문0") }));
    mem.appendTranscript({ claudeSessionId: `codex-${Z}-new`, role: "user", content: "새질문" });
    mem.appendTranscript({ claudeSessionId: `codex-${Z}-new`, role: "assistant", content: "새답" });
    mem.indexCodexTurn({ channel: CH, threadKey: Z, claudeSessionId: `codex-${Z}-new` });
    const built2 = JSON.stringify(await H.buildTurnHistory({ threadKey: Z, channel: CH, provider: "codex-oauth" } as never, "다음 질문", [], "t", undefined, "gpt-6-sol", 1_000));
    out.push(assert("Codex: 요약 + 그 뒤 새 턴(새질문·새답) · 옛 턴 없음",
      built2.includes("요약본-ZQX") && built2.includes("새질문") && built2.includes("새답") && !built2.includes("옛답4"), built2.slice(0, 300)));
        // 수동 /compact 안내 — 요약만 있고 그 뒤 새 턴이 없으면 «접을 만큼 오래된 게 없다», 기록이 아예 없으면 «기록 없음»(재검토 G3).
    const { translate } = await import("../../core/i18n.js");
    const onlySummary = await H.compactThreadNow(CH, `dashboard:${randomUUID()}`, "gpt-6-sol", "t", undefined);
    const Y = `dashboard:${randomUUID()}`;
    let yLast = 0;
    for (let i = 0; i < 2; i++) { mem.appendTranscript({ claudeSessionId: `codex-${Y}-${i}`, role: "user", content: `y${i}` }); yLast = mem.appendTranscript({ claudeSessionId: `codex-${Y}-${i}`, role: "assistant", content: `ya${i}` })!; mem.indexCodexTurn({ channel: CH, threadKey: Y, claudeSessionId: `codex-${Y}-${i}` }); }
    upsertThreadSummary({ threadKey: Y, summary: "Y요약", compactedThrough: yLast });
    const ySummaryOnly = await H.compactThreadNow(CH, Y, "gpt-6-sol", "t", undefined);
    out.push(assert("수동 /compact: 기록이 없으면 «기록 없음» · 요약만 있고 새 턴이 없으면 «오래된 게 없음»",
      !onlySummary.ok && onlySummary.reason === translate("srv.compact.noHistory") && !ySummaryOnly.ok && ySummaryOnly.reason === translate("srv.compact.nothingOld"),
      { empty: !onlySummary.ok && onlySummary.reason, summaryOnly: !ySummaryOnly.ok && ySummaryOnly.reason }));

    // 배선 — Codex·OpenAI 적재가 워터마크 뒤만 읽는다(결과는 어차피 같아 출력으로는 안 보인다 — 읽는 양의 문제라 배선을 본다).
    const { readSource } = await import("./_wiring.js");
    const hist = await readSource("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts");
    out.push(assert("배선: 이력 적재가 `after: watermark` 로 읽는다", /loadThreadHistoryWithIds\(channel, threadKey, \{[^}]*after: watermark/.test(hist), "loadHistoryTurns"));
    return out;
  },
};
