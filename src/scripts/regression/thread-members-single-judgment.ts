/**
 * 회귀: **«이 대화가 가진 기록» 의 판단은 한 곳(`memberClause`)이고, 세션이 몇 개든 조회가 된다** (2026-10-15 대화 가지치기 v1 ①단계 · 상한 제거).
 *
 * 종전엔 모델 이력 둘 · 원문 회수(`scopeOf`, 셋이 씀) · 스케줄 발화 판정이 각자 `transcript_index` 에서 세션 id 를 모았다.
 *  가지치기는 «부모 기록 중 갈라진 순간까지» 를 더하는데, 여러 벌이면 한 곳이 빠져 **갈라진 뒤의 부모 기록이 그 경로로만 샌다.**
 * ★세션 id 를 **값으로 넣던** 조회는 SQLite 값 개수 상한(32,766)에서 대화 전체가 던졌다 — Codex·OpenAI 는 턴마다 세션이 새로 생겨
 *  기본 세션처럼 오래 쓰는 대화는 언젠가 닿는다(정태님 «공통세션에서 문제가 생기는 거잖아»). 이제 하위 조회로 고른다.
 * ★가지가 없으면 상한도 없어 기존 검사가 이 상한을 못 본다 — 그래서 실제 lineage 행으로 상한을 직접 단언한다.
 *
 * 등급: **실행**(격리 DB 에 행을 넣고 실제 SQL 조건으로 고른다) + 배선(이 자리들이 스스로 세션을 모으지 않는다).
 */
import { readSource } from "./_wiring.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "thread-members-single-judgment",
  guards: "대화 기록 소속 판정이 여러 곳에 흩어져 물려받은 기록의 상한이 한 경로에서만 빠지던 것 + 세션이 3만 개를 넘는 대화(오래 쓴 기본 세션)의 모든 조회가 던지던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb } = await import("../../store/sessions.js");
    initStore();
    const { threadScope, memberClause, scopeHasRow } = await import("../../store/thread-members.js");
    const db = getDb();
    const tag = `tm-${Date.now()}`;
    const K = `${tag}-child`, P = `${tag}-parent`;
    const ins = db.prepare(`INSERT INTO transcripts (claude_session_id, ts, role, content) VALUES (?, ?, 'user', ?)`);
    const id = (sid: string, ts: number): number => Number(ins.run(sid, ts, `${sid}@${ts}`).lastInsertRowid);
    const idx = db.prepare(`INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed) VALUES ('dashboard', ?, ?, '(codex)', 0, 0)`);
    const p1 = id(`${P}-a`, 10), p2 = id(`${P}-b`, 20), p3 = id(`${P}-a`, 30); // p3 = 갈라진 뒤 부모에 생긴 행
    idx.run(P, `${P}-a`); idx.run(P, `${P}-b`);
    const o1 = id(`${K}-own`, 40), c1 = id(`${K}-codex`, 50);
    idx.run(K, `${K}-own`); idx.run(K, `${K}-codex`);
    db.prepare(`INSERT INTO thread_lineage (channel, thread_key, parent_key, through_transcript_id, through_chat_id, created_at) VALUES ('dashboard', ?, ?, ?, 0, 0)`).run(K, P, p2);

    const scope = threadScope("dashboard", K);
    const c = memberClause(scope, "t");
    const got = (db.prepare(`SELECT t.id FROM transcripts t WHERE ${c.sql} ORDER BY t.id`).all(...c.params) as { id: number }[]).map((r) => r.id);
    out.push(assert("★★자기 세션(Claude·Codex 섞임)은 전부 · 물려받은 부모 세션은 상한(id ≤ T)까지만 — 갈라진 뒤 부모 행(p3)은 빠진다",
      JSON.stringify(got) === JSON.stringify([p1, p2, o1, c1]), { got, p3 }));
    const has = [p1, p2, p3, o1, c1].map((r) => scopeHasRow(scope, r));
    out.push(assert("★행 하나 판정(`scopeHasRow`, 원문 회수가 쓴다)이 같은 SQL 로 같은 답을 낸다",
      JSON.stringify(has) === JSON.stringify([true, true, false, true, true]), has));
    const none = memberClause(threadScope("dashboard", `${tag}-nobody`));
    const zero = (db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ${none.sql}`).get(...none.params) as { n: number }).n;
    out.push(assert("세션이 없는 대화는 아무 행도 안 맞는다", zero === 0, zero));

    // 세션이 SQLite 값 상한(32,766)을 넘는 대화 — 하위 조회라 넣는 값 수가 세션 수와 무관하다.
    const B = `${tag}-big`;
    db.transaction(() => { for (let i = 0; i < 40_000; i++) { ins.run(`${B}-${i}`, i, "x"); idx.run(B, `${B}-${i}`); } })();
    const big = memberClause(threadScope("dashboard", B));
    let bigErr = "", bigN = 0;
    try { bigN = (db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ${big.sql}`).get(...big.params) as { n: number }).n; } catch (e) { bigErr = e instanceof Error ? e.message : String(e); }
    out.push(assert("★세션 4만 개 대화도 조회된다(값으로 넣으면 «too many SQL variables»)", bigErr === "" && bigN === 40_000 && big.params.length === 2, { bigN, bigErr, params: big.params.length }));

    // 배선 — 이 자리들이 스스로 세션을 모으지 않는다(모으면 상한·값 한도가 그 경로에서만 빠진다).
    const memory = await readSource("../../store/memory.ts");
    const recall = await readSource("../../store/tool-recall.ts");
    const reset = await readSource("../../store/thread-reset.ts");
    const selfCollect = {
      memory: (memory.match(/SELECT claude_session_id FROM transcript_index/g) ?? []).length,
      recall: (recall.match(/transcript_index/g) ?? []).length,
      reset: (reset.match(/transcript_index/g) ?? []).length,
    };
    const uses = {
      memory: (memory.match(/memberClause\(/g) ?? []).length,
      recall: (recall.match(/memberClause\(/g) ?? []).length + (recall.match(/scopeHasRow\(/g) ?? []).length,
      reset: (reset.match(/memberClause\(/g) ?? []).length,
    };
    out.push(assert("배선: 모델 이력 둘·원문 회수·스케줄 발화가 `memberClause` 로 소속을 받고 스스로 transcript_index 를 읽지 않는다",
      selfCollect.memory === 0 && selfCollect.recall === 0 && selfCollect.reset === 0 && uses.memory >= 3 && uses.recall >= 3 && uses.reset >= 1,
      { selfCollect, uses }));
    return out;
  },
};
