/**
 * 회귀: **대화 가지치기 — 가지는 «갈라진 순간의 부모» 를 보고, 갈라진 뒤의 부모를 안 본다** (2026-10-15 v1 ②단계).
 * 설계: `docs/decisions/2026-10-14-conversation-fork-design.md` §4·§6.
 *
 * 가짜 SDK(복제본 = uuid·시각을 새로 매긴 줄 — 실측한 실제 SDK 와 같은 모양)와 격리 DB 로, 데몬 없이 실제 절차(`forkThread`)를 돌린다.
 * 본다: Codex 만 쓴 부모 · Claude 부모(복제 + 델타) · 대화 없이 다시 가른 가지(S 이어받기) · 멱등 · /clear 독립 · 원문 회수 상한 ·
 *  어긋난 복제본 거부 · 복제 실패 분류 · 이름 번호 · 사용자 대화만.
 *
 * 등급: **실행**.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "conversation-fork-records",
  guards: "가지가 갈라진 뒤의 부모 기록을 보거나, 물려받을 기록을 잃거나, Claude 복제본과 공통 기록이 같은 내용을 두 번 넣거나, 실패한 분기가 반쪽 가지를 남기던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb, getSession, setContextBoundary, SESSION_STORAGE_CHANNEL: CH } = await import("../../store/sessions.js");
    initStore();
    const mem = await import("../../store/memory.js");
    const { readThreadToolResult } = await import("../../store/tool-recall.js");
    const { loadClaudeReplayHistory } = await import("../../core/llm-runtime/adapters/_claude-replay-history.js");
    const { forkThread, newForkKey } = await import("../../core/thread-fork.js");
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-fork-"));
    const texts = (k: string): string[] => mem.loadThreadHistory(CH, k).map((t) => t.content);
    const codexTurn = (k: string, sid: string, u: string, a: string, ts?: number): number => {
      mem.appendTranscript({ claudeSessionId: sid, role: "user", content: u, ...(ts !== undefined ? { ts } : {}) });
      const id = mem.appendTranscript({ claudeSessionId: sid, role: "assistant", content: a, ...(ts !== undefined ? { ts: ts + 1 } : {}) })!;
      mem.indexCodexTurn({ channel: CH, threadKey: k, claudeSessionId: sid });
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, last_used_at, created_at)
                  VALUES (?, ?, ?, 'm', 1, 1) ON CONFLICT DO NOTHING`).run(CH, k, sid);
      return id;
    };
    const line = (type: "user" | "assistant", text: string, ts: number): string =>
      JSON.stringify({ type, uuid: randomUUID(), timestamp: new Date(ts).toISOString(), message: { role: type, content: [{ type: "text", text }] } });
    // 가짜 SDK — 실제처럼 같은 폴더에 새 파일, uuid·시각을 새로 매긴다. mode 로 실패를 만든다.
    let mode: "ok" | "drop-last" | "throw-known" | "throw-unknown" = "ok";
    const sdk = {
      forkSession: async (sid: string, opts: { upToMessageId: string }) => {
        if (mode.startsWith("throw")) throw new Error("disk full");
        const src = fs.readFileSync(path.join(dir, `${sid}.jsonl`), "utf8").trim().split("\n");
        const upto = src.findIndex((l) => (JSON.parse(l) as { uuid?: string }).uuid === opts.upToMessageId);
        let kept = src.slice(0, upto + 1).map((l) => JSON.stringify({ ...JSON.parse(l), uuid: randomUUID(), timestamp: new Date(0).toISOString() }));
        if (mode === "drop-last") kept = kept.slice(0, -1);
        const ns = randomUUID();
        fs.writeFileSync(path.join(dir, `${ns}.jsonl`), [...kept, JSON.stringify({ type: "custom-title", title: "x" })].join("\n") + "\n");
        return { sessionId: ns };
      },
      sessionKnown: async () => mode !== "throw-unknown",
    };

    try {
      // ── Codex 만 쓴 부모 ──
      const P = `dashboard:${randomUUID()}`;
      setName(db, CH, P, "아침 뉴스");
      codexTurn(P, `codex-${P}`, "질문1", "답1");
      const before = texts(P);
      const K = newForkKey();
      const r = await forkThread(P, K, sdk);
      codexTurn(P, `codex-${P}`, "부모만2", "부모답2"); // 갈라진 뒤 부모 — 가지에 안 보여야
      out.push(assert("★★Codex 만 쓴 대화도 갈라진다 · 가지는 갈라진 순간의 부모 기록을 보고 갈라진 뒤의 부모 기록은 안 본다",
        r.ok && r.claude === "none" && JSON.stringify(texts(K)) === JSON.stringify(before) && texts(P).includes("부모만2"),
        { r, child: texts(K), parent: texts(P) }));
      const again = await forkThread(P, K, sdk);
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM thread_lineage WHERE thread_key = ?`).get(K) as { n: number }).n;
      out.push(assert("같은 가지 키로 다시 부르면 두 번째 가지를 만들지 않는다(멱등)", again.ok && rows === 1, { again, rows }));
      out.push(assert("이름 = 원래 이름 + 번호(2부터)", r.ok && r.name === "아침 뉴스 (2)", r));

      // ── Claude 부모: Claude(세션 a) → Codex → 분기 → Claude 재개 ──
      const Q = `dashboard:${randomUUID()}`;
      const a = randomUUID();
      const file = path.join(dir, `${a}.jsonl`);
      fs.writeFileSync(file, [line("user", "C질문1", 1000), line("assistant", "C답1", 1001), line("user", "C질문2", 1002), line("assistant", "C답2", 1003)].join("\n") + "\n");
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: Q, claudeSessionId: a, jsonlPath: file });
      // ★아직 적재 안 된 Claude 줄 — 분기가 따라잡아야 T 에 들어간다. 이 줄들은 아래 Codex 행보다 **id 가 크고 시각은 이르다**(실측 역전).
      fs.appendFileSync(file, [line("user", "C질문3", 1004), line("assistant", "C답3", 1005)].join("\n") + "\n");
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at, name)
                  VALUES (?, ?, ?, 'm', 'H', 1, 1, '작업')`).run(CH, Q, a);
      codexTurn(Q, `codex-${Q}`, "X질문", "X답", 2000); // Claude 세션 뒤 Codex 구간 — SDK 복제본엔 없다
      codexTurn(`dashboard:${randomUUID()}`, `codex-other-${Q}`, "남의 질문", "남의 답", 2500); // 다른 대화 행 — T(전역 최대)와 S 가 갈린다
      const K2 = newForkKey();
      const r2 = await forkThread(Q, K2, sdk);
      const s2 = getSession(CH, K2);
      const lin2 = db.prepare(`SELECT sdk_session_id, sdk_included_through FROM thread_lineage WHERE thread_key = ?`).get(K2) as { sdk_session_id: string; sdk_included_through: number };
      const lastClaudeId = (db.prepare(`SELECT MAX(id) AS m FROM transcripts WHERE claude_session_id = ?`).get(a) as { m: number }).m;
      const delta = loadClaudeReplayHistory(CH, K2, s2?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★★Claude 부모: SDK 복제 + 재개 델타는 복제본에 없는 Codex 구간만(한 벌씩) · 해시 이어받아 재개 가능",
        r2.ok && r2.claude === "copied" && s2?.claudeSessionId === lin2.sdk_session_id && s2.systemPromptHash === "H" &&
          lin2.sdk_included_through === lastClaudeId && JSON.stringify(delta) === JSON.stringify(["X질문", "X답"]),
        { r2, delta, S: lin2.sdk_included_through, lastClaudeId }));
      const pre = db.prepare(`SELECT jsonl_path, bytes_indexed FROM transcript_index WHERE thread_key = ? AND claude_session_id = ?`).get(K2, lin2.sdk_session_id) as { jsonl_path: string; bytes_indexed: number };
      out.push(assert("적재기 선등록 — 복제본 끝까지 읽은 것으로 둬 다음 턴에 꼬리만 읽는다(복제 내용이 가지 행으로 두 번 들어가지 않는다)",
        pre !== undefined && pre.bytes_indexed === fs.statSync(pre.jsonl_path).size, pre));

      // ── 대화 없이 다시 가른다 → S 를 이어받아야 델타가 한 벌 ──
      codexTurn(`dashboard:${randomUUID()}`, `codex-other2-${Q}`, "남의 질문2", "남의 답2", 2600); // T(전역 최대) ≠ S 가 되게
      const K3 = newForkKey();
      const r3 = await forkThread(K2, K3, sdk);
      const s3 = getSession(CH, K3);
      const delta3 = loadClaudeReplayHistory(CH, K3, s3?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★대화 없이 다시 가른 가지도 S 를 이어받는다 — 델타 = Codex 구간만(복제본이 가진 Claude 구간을 다시 넣지 않는다)",
        r3.ok && r3.claude === "copied" && JSON.stringify(delta3) === JSON.stringify(["X질문", "X답"]),
        { r3, delta3 }));
      out.push(assert("가지의 가지 이름 — 바탕에서 번호만 오른다", r3.ok && r2.ok && r2.name === "작업 (2)" && r3.name === "작업 (3)", { r2: r2.ok && r2.name, r3: r3.ok && r3.name }));

      // ── /clear 독립 ──
      setContextBoundary(CH, Q, Date.now() + 1000); // 갈라진 뒤 부모를 비운다
      out.push(assert("★갈라진 뒤 부모의 /clear 는 가지를 안 바꾼다(가지 기록 그대로)",
        texts(Q).length === 0 && texts(K2).length === 8 && texts(K2).includes("C답3"), { parent: texts(Q).length, child: texts(K2) }));
      // 갈라지기 **전** 부모의 /clear — 지운 문맥이 가지에서 되살아나지 않는다(활성 경계 복사).
      const W = `dashboard:${randomUUID()}`;
      codexTurn(W, `codex-${W}`, "지운 질문", "지운 답", 3000);
      setContextBoundary(CH, W, 3500);
      codexTurn(W, `codex-${W}`, "남은 질문", "남은 답", 4000);
      const KW = newForkKey();
      await forkThread(W, KW, sdk);
      out.push(assert("★갈라지기 전 부모의 /clear 는 가지에도 그대로 — 지운 문맥이 되살아나지 않는다",
        JSON.stringify(texts(KW)) === JSON.stringify(["남은 질문", "남은 답"]), texts(KW)));

      // ── 진행 중인 답이 있으면 그게 끝난 뒤 갈라진다(부모 대화의 줄) ──
      const { enqueueThreadTurn } = await import("../../core/worker-jobs.js");
      const V = `dashboard:${randomUUID()}`;
      codexTurn(V, `codex-${V}`, "첫 질문", "첫 답", 5000);
      const inflight = enqueueThreadTurn(V, async () => { await new Promise((res) => setTimeout(res, 150)); codexTurn(V, `codex-${V}`, "진행 중 질문", "진행 중 답", 6000); });
      const KV = newForkKey();
      await forkThread(V, KV, sdk);
      await inflight;
      out.push(assert("★진행 중인 답이 있으면 끝난 뒤 갈라진다 — 그 답이 가지에 들어간다(반쪽 없음)",
        texts(KV).includes("진행 중 답"), texts(KV)));

      // ── 원문 회수 상한 ──
      const R = `dashboard:${randomUUID()}`;
      const tid1 = codexTurn(R, `codex-${R}`, "도구 질문", "도구 답");
      addToolResult(db, tid1, "c1", "OLD-RESULT");
      const K4 = newForkKey();
      await forkThread(R, K4, sdk);
      const tid2 = codexTurn(R, `codex-${R}`, "뒤 질문", "뒤 답");
      addToolResult(db, tid2, "c2", "NEW-RESULT");
      const okRead = readThreadToolResult(CH, K4, `${tid1}#1`);
      const leak = readThreadToolResult(CH, K4, `${tid2}#1`);
      out.push(assert("★원문 회수: 가지는 물려받은 부모 도구 결과를 읽고, 갈라진 뒤 부모 결과는 «다른 대화» 로 거절",
        okRead.ok && okRead.text === "OLD-RESULT" && !leak.ok && leak.reason === "other_conversation", { okRead, leak }));

      // ── 어긋난 복제본 · 복제 실패 분류 ──
      const lineageCount = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM thread_lineage`).get() as { n: number }).n;
      const files = (): number => fs.readdirSync(dir).length;
      mode = "drop-last";
      const n0 = lineageCount(), f0 = files();
      const bad = await forkThread(Q, newForkKey(), sdk);
      out.push(assert("★복제본의 끝이 부모와 다르면 거부하고 복제본을 지운다(반쪽 가지 없음)",
        !bad.ok && bad.reason === "boundary" && lineageCount() === n0 && files() === f0, { bad, lineage: lineageCount() - n0, files: files() - f0 }));
      mode = "throw-known";
      const fail = await forkThread(Q, newForkKey(), sdk);
      out.push(assert("부모 세션은 멀쩡한데 복제만 실패 → 생성 실패(조용히 기록 기반으로 대체하지 않는다)",
        !fail.ok && fail.reason === "sdk_copy" && lineageCount() === n0, fail));
      mode = "throw-unknown";
      const K5 = newForkKey();
      const rebuilt = await forkThread(Q, K5, sdk);
      const s5 = getSession(CH, K5);
      out.push(assert("부모 세션을 SDK 도 모르면 «기록으로 다시 짓는» 가지 — 재개 없음(sid '' · 해시 NULL)",
        rebuilt.ok && rebuilt.claude === "rebuilt" && s5?.claudeSessionId === "" && s5.systemPromptHash === null, { rebuilt, s5 }));
      mode = "ok";

      // ── 저장·런타임 적대 검토(10-15) 반영 ──
      // P3: Codex·OpenAI 는 턴마다 세션이 새로 생긴다 — 조상 세션이 1000개여도 가지 조회가 던지지 않는다(SQLite 식 깊이 1000).
      const Big = `dashboard:${randomUUID()}`;
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, last_used_at, created_at) VALUES (?, ?, 'x', 'm', 1, 1)`).run(CH, Big);
      const insT = db.prepare(`INSERT INTO transcripts (claude_session_id, ts, role, content) VALUES (?, ?, 'user', ?)`);
      const insI = db.prepare(`INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed) VALUES (?, ?, ?, '(codex)', 0, 0)`);
      db.transaction(() => { for (let i = 0; i < 1200; i++) { insT.run(`codex-big-${i}`, 7000 + i, `턴${i}`); insI.run(CH, Big, `codex-big-${i}`); } })();
      const KB = newForkKey();
      await forkThread(Big, KB, sdk);
      let bigErr = "";
      let bigN = 0;
      try { bigN = mem.loadThreadHistory(CH, KB, { limitTurns: 5000, charCap: 10_000_000 }).length; } catch (e) { bigErr = e instanceof Error ? e.message : String(e); }
      out.push(assert("★조상 세션이 1200개(Codex 턴마다 새 세션)여도 가지의 기록 조회가 된다", bigErr === "" && bigN === 1200, { bigN, bigErr }));

      // P2: 부모 Claude 파일이 system 줄로 끝나도 S 는 대화 행 — 가지 재개 델타가 부모와 같다(복제본 내용을 두 번 넣지 않는다).
      const Sy = `dashboard:${randomUUID()}`;
      const sa = randomUUID();
      const sf = path.join(dir, `${sa}.jsonl`);
      fs.writeFileSync(sf, [line("user", "S질문", 8000), line("assistant", "S답", 8001), JSON.stringify({ type: "system", subtype: "local_command", content: "system 내용", timestamp: new Date(8002).toISOString() })].join("\n") + "\n");
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: Sy, claudeSessionId: sa, jsonlPath: sf });
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at) VALUES (?, ?, ?, 'm', 'H', 1, 1)`).run(CH, Sy, sa);
      codexTurn(Sy, `codex-${Sy}`, "SX질문", "SX답", 9000);
      const KS = newForkKey();
      await forkThread(Sy, KS, sdk);
      const parentDelta = loadClaudeReplayHistory(CH, Sy, sa).delta.map((t) => t.content);
      const childDelta = loadClaudeReplayHistory(CH, KS, getSession(CH, KS)?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★부모 Claude 파일이 system 줄로 끝나도 가지 재개 델타 = 부모 델타(Codex 구간만)",
        JSON.stringify(childDelta) === JSON.stringify(parentDelta) && JSON.stringify(childDelta) === JSON.stringify(["SX질문", "SX답"]), { parentDelta, childDelta }));

      // G: 가지가 Claude 로 대화한 **뒤** 다시 가르면 S = 그 대화의 끝(복제로 받은 옛 S 가 아니다).
      const k2sid = s2!.claudeSessionId;
      const k2file = pre.jsonl_path;
      fs.appendFileSync(k2file, [line("user", "가지C질문", 10_000), line("assistant", "가지C답", 10_001)].join("\n") + "\n");
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: K2, claudeSessionId: k2sid, jsonlPath: k2file });
      codexTurn(K2, `codex-${K2}`, "가지X질문", "가지X답", 11_000);
      const K6 = newForkKey();
      await forkThread(K2, K6, sdk);
      const delta6 = loadClaudeReplayHistory(CH, K6, getSession(CH, K6)?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★가지가 Claude 로 대화한 뒤 다시 가르면 델타 = 그 뒤 Codex 구간만(가지의 Claude 대화를 다시 넣지 않는다)",
        JSON.stringify(delta6) === JSON.stringify(["가지X질문", "가지X답"]), delta6));

      // G: 세션 설정·요약·글자당 토큰이 복사된다(목록에서 하나가 빠지면 가지가 부모보다 못하다).
      const Cp = `dashboard:${randomUUID()}`;
      codexTurn(Cp, `codex-${Cp}`, "설정 질문", "설정 답", 12_000);
      db.prepare(`INSERT INTO thread_summaries (thread_key, summary, compacted_through, updated_at) VALUES (?, '요약본', 1, 1)`).run(Cp);
      db.prepare(`INSERT INTO session_projects (thread_key, project_path, linked_at) VALUES (?, '/p/one', 1)`).run(Cp);
      db.prepare(`INSERT INTO session_model_profile (channel, thread_key, profile_name, updated_at) VALUES (?, ?, 'mid', 1)`).run(CH, Cp);
      db.prepare(`INSERT INTO session_model_override (channel, thread_key, model_spec, updated_at) VALUES (?, ?, 'anthropic:x', 1)`).run(CH, Cp);
      db.prepare(`INSERT INTO thread_token_density (thread_key, chars, tokens, updated_at) VALUES (?, 100, 30, 1)`).run(Cp);
      const KC = newForkKey();
      await forkThread(Cp, KC, sdk);
      const one = (sql: string, ...a: unknown[]): unknown => db.prepare(sql).get(...a);
      const copied = {
        summary: (one(`SELECT summary FROM thread_summaries WHERE thread_key = ?`, KC) as { summary?: string } | undefined)?.summary,
        project: (one(`SELECT project_path FROM session_projects WHERE thread_key = ?`, KC) as { project_path?: string } | undefined)?.project_path,
        profile: (one(`SELECT profile_name FROM session_model_profile WHERE thread_key = ?`, KC) as { profile_name?: string } | undefined)?.profile_name,
        override: (one(`SELECT model_spec FROM session_model_override WHERE thread_key = ?`, KC) as { model_spec?: string } | undefined)?.model_spec,
        density: (one(`SELECT tokens FROM thread_token_density WHERE thread_key = ?`, KC) as { tokens?: number } | undefined)?.tokens,
      };
      out.push(assert("요약·프로젝트·모델 프로파일·모델 덮어쓰기·글자당 토큰이 가지로 복사된다",
        copied.summary === "요약본" && copied.project === "/p/one" && copied.profile === "mid" && copied.override === "anthropic:x" && copied.density === 30, copied));

      // G: 원문 회수 셋 모두 상한 — 도구 결과 검색·접힌 결과 목록·이력 도구 항목도 갈라진 뒤 부모 결과를 안 싣는다.
      const { searchThreadToolResults, listFoldedToolResults } = await import("../../store/tool-recall.js");
      const sHits = searchThreadToolResults(CH, K4, "RESULT").hits.map((h) => h.ref);
      const folded = listFoldedToolResults(CH, K4, Number.MAX_SAFE_INTEGER, 0, 50).map((f) => f.ref);
      const items = mem.loadThreadHistoryWithIds(CH, K4, { itemsAfter: 0 }).flatMap((t) => JSON.stringify(t));
      out.push(assert("★도구 결과 검색·접힌 결과 목록·이력 도구 항목 셋 다 물려받은 결과만(갈라진 뒤 부모 결과 없음)",
        sHits.includes(`${tid1}#1`) && !sHits.includes(`${tid2}#1`) && folded.includes(`${tid1}#1`) && !folded.includes(`${tid2}#1`) &&
          items.some((x) => x.includes("OLD-RESULT")) && !items.some((x) => x.includes("NEW-RESULT")),
        { sHits, folded }));

      // G(재검토): 다단 가지 — 조부모가 첫 분기 뒤에도 대화를 이어가도, 손주는 조부모의 «첫 분기까지» 만 본다(경로상 최소 상한).
      const G0 = `dashboard:${randomUUID()}`;
      codexTurn(G0, `codex-${G0}-1`, "G-처음", "G-처음답", 13_000);
      const P0 = newForkKey();
      await forkThread(G0, P0, sdk);
      codexTurn(G0, `codex-${G0}-2`, "G-after-P", "G-after-P답", 13_100);
      codexTurn(P0, `codex-${P0}`, "P-질문", "P-답", 13_200);
      const C0 = newForkKey();
      await forkThread(P0, C0, sdk);
      const cTexts = mem.loadThreadHistory(CH, C0).map((t) => t.content);
      out.push(assert("★다단 가지: 손주는 조부모의 첫 분기 뒤 대화(G-after-P)를 안 본다 · 부모 대화는 본다",
        cTexts.includes("G-처음") && cTexts.includes("P-질문") && !cTexts.includes("G-after-P"), cTexts));

      // G(재검토): 부모 Claude 세션이 **답 없는 사용자 줄**로 끝나도 가지 델타 = 부모 델타.
      const Us = `dashboard:${randomUUID()}`;
      const ua = randomUUID();
      const uf = path.join(dir, `${ua}.jsonl`);
      fs.writeFileSync(uf, [line("user", "U질문", 14_000), line("assistant", "U답", 14_001), line("user", "U-답없는질문", 14_002)].join("\n") + "\n");
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: Us, claudeSessionId: ua, jsonlPath: uf });
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at) VALUES (?, ?, ?, 'm', 'H', 1, 1)`).run(CH, Us, ua);
      codexTurn(Us, `codex-${Us}`, "UX질문", "UX답", 15_000);
      const KU = newForkKey();
      await forkThread(Us, KU, sdk);
      const uParent = loadClaudeReplayHistory(CH, Us, ua).delta.map((t) => t.content);
      const uChild = loadClaudeReplayHistory(CH, KU, getSession(CH, KU)?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("부모 Claude 세션이 답 없는 사용자 줄로 끝나도 가지 재개 델타 = 부모 델타",
        JSON.stringify(uChild) === JSON.stringify(uParent) && JSON.stringify(uChild) === JSON.stringify(["UX질문", "UX답"]), { uParent, uChild }));

      const internal = await forkThread("scheduler:9", newForkKey(), sdk);
      out.push(assert("사용자 대화만 가른다 — 스케줄 실행 맥락은 거절", !internal.ok && internal.reason === "not_forkable", internal));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return out;
  },
};

const setName = (db: import("better-sqlite3").Database, ch: string, k: string, name: string): void => {
  db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, last_used_at, created_at, name)
              VALUES (?, ?, '', 'm', 1, 1, ?) ON CONFLICT (channel, channel_thread_id) DO UPDATE SET name = excluded.name`).run(ch, k, name);
};

const addToolResult = (db: import("better-sqlite3").Database, tid: number, callId: string, text: string): void => {
  db.prepare(`INSERT INTO turn_items (transcript_id, seq, item) VALUES (?, 0, ?)`).run(tid, JSON.stringify({ type: "function_call", call_id: callId, name: "Read", arguments: "{}" }));
  db.prepare(`INSERT INTO turn_items (transcript_id, seq, item) VALUES (?, 1, ?)`).run(tid, JSON.stringify({ type: "function_call_output", call_id: callId, output: text }));
};
