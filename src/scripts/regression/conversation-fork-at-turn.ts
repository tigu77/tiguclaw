/**
 * 회귀: **메시지에서 갈라내기** — 비서 답 카드 «여기까지로 갈라내기» 가 그 답까지 정확히 물려준다 (2026-10-15 가지치기 v2).
 * 설계: `docs/decisions/2026-10-15-fork-from-message-design.md` «유효 계약 — 구현 기준» + 아스트라 회신 두 번의 경계 사례.
 *
 * 화면 기록과 모델 기록엔 서로를 가리키는 칸이 없어서, 저장이 **확인된** 정상 답에만 «완료 턴 표식»(T·Claude 체크포인트 S·hash)을
 *  답 행에 함께 남기고, 갈라내기는 그 표식으로만 자른다(시각 추정 없음). 표식이 없는 답(오류 안내·저장 미확인·옛 답)은 거절한다.
 *
 * 등급: **실행**(격리 DB · 실제 적재기 · 가짜 SDK — 실제처럼 같은 폴더에 uuid·시각을 새로 매긴 복제본).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "conversation-fork-at-turn",
  guards:
    "메시지에서 갈라낸 가지가 그 답 뒤 내용을 보거나, 오류 안내·같은 ms·물려받은 카드에서 엉뚱한 지점을 자르거나, Claude 복제가 S·hash 를 현재 값으로 잡아 델타가 겹치거나 옛 세션을 지금 지침으로 재개하거나, 복제 중 요약이 진전해 미래 내용을 물려주던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, getDb, getSession, setContextBoundary, SESSION_STORAGE_CHANNEL: CH } = await import("../../store/sessions.js");
    initStore();
    const mem = await import("../../store/memory.js");
    const { recordChatMessage, getRecentChatLog } = await import("../../store/chat-log.js");
    const { apiTurnMark, claudeTurnMark } = await import("../../store/turn-marks.js");
    const { upsertThreadSummary } = await import("../../store/thread-summaries.js");
    const { loadClaudeReplayHistory } = await import("../../core/llm-runtime/adapters/_claude-replay-history.js");
    const { forkThread, newForkKey } = await import("../../core/thread-fork.js");
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-fork-at-"));
    // 시각은 실제 «지금» 을 따라 흐른다 — Codex 기록(`appendApiTurn`)은 실제 현재 시각으로 저장되므로, 가짜 시계가 앞서거나 뒤지면 시간순이 섞인다.
    //  ★앞지르지도 않는다 — 실제로는 답 발행 시각이 다음 턴 저장 시각보다 늘 이르다(같은 시계 · 그 사이에 모델 호출). 가짜 시계가
    //   앞서면 «이 답보다 이른데 T 밖» 안전망이 다음 턴 행에 걸린다(실제엔 없는 순서).
    let clock = 0;
    const tick = (): number => {
      while (Date.now() <= clock) { /* 1ms 를 기다린다 — 시각이 겹치지 않게 */ }
      return (clock = Date.now());
    };

    const texts = (k: string): string[] => mem.loadThreadHistory(CH, k).map((t) => t.content);
    const screen = (k: string): string[] => getRecentChatLog({ threadKey: k, limit: 200 }).map((e) => e.text).filter((t) => t !== "");
    const lineageCount = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM thread_lineage`).get() as { n: number }).n;
    const files = (): number => fs.readdirSync(dir).length;
    const lin = (k: string) => db.prepare(`SELECT sdk_session_id, sdk_included_through, through_ts FROM thread_lineage WHERE thread_key = ?`).get(k) as
      { sdk_session_id: string | null; sdk_included_through: number | null; through_ts: number | null };
    const ensureThread = (k: string, sid: string, hash: string | null = null): void => {
      db.prepare(`INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at)
                  VALUES (?, ?, ?, 'm', ?, 1, 1) ON CONFLICT DO NOTHING`).run(CH, k, sid, hash);
    };
    /** 화면 기록 — 사용자 말 + 비서 답(표식 있으면 함께). 답의 시각을 돌려준다. */
    const chat = (k: string, u: string, a: string, mark?: ReturnType<typeof apiTurnMark>, ts?: number): number => {
      recordChatMessage({ threadKey: k, channel: "dashboard", role: "user", text: u, ts: tick() } as never);
      const at = ts ?? tick();
      recordChatMessage({ threadKey: k, channel: "dashboard", role: "assistant", text: a, ts: at, ...(mark !== undefined ? { turn: mark } : {}) } as never);
      return at;
    };
    /** Codex 턴 — 기록 저장 뒤 표식(퍼사드와 같은 순서) + 화면. */
    const codexTurn = (k: string, u: string, a: string, chatTs?: number): { id: string; ts: number } => {
      const sid = `codex-${randomUUID()}`;
      ensureThread(k, sid);
      tick(); // 앞 답 시각보다 **뒤**에 저장된다(실제: 그 사이에 모델 호출)
      mem.appendApiTurn({ channel: CH, threadKey: k, claudeSessionId: sid, userContent: u, assistantContent: a });
      const mark = apiTurnMark(randomUUID());
      return { id: mark.id, ts: chat(k, u, a, mark, chatTs) };
    };
    const line = (type: "user" | "assistant", content: unknown, ts: number, uuid = randomUUID(), extra: Record<string, unknown> = {}): { uuid: string; text: string } =>
      ({ uuid, text: JSON.stringify({ type, uuid, timestamp: new Date(ts).toISOString(), message: { role: type, content }, ...extra }) });
    /** Claude 턴 — 세션 파일에 줄을 붙이고 적재 → 표식(이 턴의 hash 로) + 화면. */
    const claudeTurn = (k: string, sid: string, u: string, a: string, hash: string): { id: string; ts: number; uuid: string } => {
      const file = path.join(dir, `${sid}.jsonl`);
      const ul = line("user", u, tick());
      const al = line("assistant", [{ type: "text", text: a }], tick());
      fs.appendFileSync(file, `${ul.text}\n${al.text}\n`);
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: k, claudeSessionId: sid, jsonlPath: file });
      const mark = claudeTurnMark(randomUUID(), { channel: CH, threadKey: k, sid, uuid: al.uuid, systemPromptHash: hash });
      if (mark === undefined) throw new Error("픽스처: Claude 표식이 안 나왔다");
      return { id: mark.id, ts: chat(k, u, a, mark), uuid: al.uuid };
    };

    // 가짜 SDK — 실제처럼 같은 폴더에 새 파일, uuid·시각을 새로 매긴다. `race` 는 복제 대기 중 부모 요약을 진전시킨다.
    let mode: "ok" | "race" = "ok";
    let raceParent = "";
    let raceThrough = 0;
    const forkCalls: { sid: string; upTo: string }[] = [];
    const sdk = {
      forkSession: async (sid: string, opts: { upToMessageId: string }) => {
        forkCalls.push({ sid, upTo: opts.upToMessageId });
        if (mode === "race") upsertThreadSummary({ threadKey: raceParent, summary: "진전한 요약", compactedThrough: raceThrough });
        const src = fs.readFileSync(path.join(dir, `${sid}.jsonl`), "utf8").trim().split("\n");
        const upto = src.findIndex((l) => (JSON.parse(l) as { uuid?: string }).uuid === opts.upToMessageId);
        const kept = src.slice(0, upto + 1).map((l) => JSON.stringify({ ...JSON.parse(l), uuid: randomUUID(), timestamp: new Date(0).toISOString() }));
        const ns = randomUUID();
        fs.writeFileSync(path.join(dir, `${ns}.jsonl`), kept.join("\n") + "\n");
        return { sessionId: ns };
      },
      sessionKnown: async () => true,
    };

    try {
      // ── 섞인 부모: Claude(a) → Codex x1 → Claude(a) → Codex x2 ──
      const P = `dashboard:${randomUUID()}`;
      const a = randomUUID();
      ensureThread(P, a, "H-new"); // 지금 부모 hash 는 «새 지침»
      const c1 = claudeTurn(P, a, "C1", "A1", "H-old");
      const x1 = codexTurn(P, "X1", "XA1");
      mem.appendTranscript({ claudeSessionId: `codex-other-${randomUUID()}`, role: "user", content: "남의 대화" }); // 전역 T 가 남의 행을 가리키게
      const c2 = claudeTurn(P, a, "C2", "A2", "H-new");
      codexTurn(P, "X2", "XA2");
      const a1Id = (db.prepare(`SELECT MAX(id) AS m FROM transcripts WHERE claude_session_id = ? AND role = 'assistant' AND content = 'A1'`).get(a) as { m: number }).m;

      // ① Codex 답(x1)에서 — 그 앞 Claude 체크포인트(c1)까지 복제 + 그 뒤(x1)는 델타. S = 체크포인트 값(T 아님) · hash = 체크포인트 값.
      forkCalls.length = 0;
      const K1 = newForkKey();
      const r1 = await forkThread(P, K1, sdk, x1.id);
      const l1 = lin(K1);
      const s1 = getSession(CH, K1);
      const delta1 = loadClaudeReplayHistory(CH, K1, s1?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★★Codex 답에서 갈라내면 그 답까지만 — 모델 기록·화면 모두 뒤 턴(C2·X2)이 없다 · 도구 스텝 상한 = 그 답 시각",
        r1.ok && JSON.stringify(texts(K1)) === JSON.stringify(["C1", "A1", "X1", "XA1"]) &&
          screen(K1).includes("XA1") && !screen(K1).includes("A2") && !screen(K1).includes("XA2") && l1.through_ts === x1.ts,
        { r1, texts: texts(K1), screen: screen(K1), throughTs: l1.through_ts, x1ts: x1.ts }));
      out.push(assert("★★Claude 체크포인트 = 그 앞 마지막 Claude 답(c1 의 sid·uuid) · S = 체크포인트의 S(전역 T 아님) · 델타 = 그 뒤 Codex 구간만(한 벌) · hash = 체크포인트의 hash(현재 부모 hash 아님)",
        r1.ok && r1.claude === "copied" && forkCalls.length === 1 && forkCalls[0]!.sid === a && forkCalls[0]!.upTo === c1.uuid &&
          l1.sdk_included_through === a1Id && JSON.stringify(delta1) === JSON.stringify(["X1", "XA1"]) && s1?.systemPromptHash === "H-old",
        { forkCalls, S: l1.sdk_included_through, a1Id, delta1, hash: s1?.systemPromptHash }));

      // ② Claude 답(c2)에서 — 그 답의 uuid 까지 · 델타 없음 · hash = 그 턴 것.
      forkCalls.length = 0;
      const K2 = newForkKey();
      const r2 = await forkThread(P, K2, sdk, c2.id);
      const s2 = getSession(CH, K2);
      const delta2 = loadClaudeReplayHistory(CH, K2, s2?.claudeSessionId).delta.map((t) => t.content);
      out.push(assert("★Claude 답에서 갈라내면 그 답의 uuid 까지 복제 · 델타 없음 · 뒤 Codex(X2) 없음",
        r2.ok && r2.claude === "copied" && forkCalls[0]?.upTo === c2.uuid && delta2.length === 0 && s2?.systemPromptHash === "H-new" &&
          !texts(K2).includes("X2"),
        { r2, forkCalls, delta2, texts: texts(K2) }));

      // ③ 물려받은 카드 — 끝에서 갈라낸 가지(복제본은 uuid·시각이 바뀌었다)에서 조상의 x1 카드로 다시 갈라낸다 → 원래 조상의 sid·uuid.
      const KE = newForkKey();
      await forkThread(P, KE, sdk);
      forkCalls.length = 0;
      const K3 = newForkKey();
      const r3 = await forkThread(KE, K3, sdk, x1.id);
      out.push(assert("★물려받은 카드(조상 행)에서도 갈라진다 — 복제 지점은 원래 조상 세션의 uuid(복제본의 바뀐 uuid·시각을 거치지 않는다) · 그 답까지만",
        r3.ok && forkCalls[0]?.sid === a && forkCalls[0]?.upTo === c1.uuid && JSON.stringify(texts(K3)) === JSON.stringify(["C1", "A1", "X1", "XA1"]),
        { r3, forkCalls, texts: texts(K3) }));

      // ③' 조상이 **갈라진 뒤** 낸 답은 가지의 화면 범위 밖이다 — 그 턴 id 로 가지에서 갈라내면 거절.
      const later = codexTurn(P, "부모만", "부모만 답");
      const r3b = await forkThread(KE, newForkKey(), sdk, later.id);
      out.push(assert("가지에서 조상의 «갈라진 뒤» 답을 지정하면 `not_turn`(화면 범위 밖 — 가지가 모르는 미래)",
        !r3b.ok && r3b.reason === "not_turn", r3b));

      // ④ 같은 ms 의 다른 두 답 — 표식 id 로 가린다.
      const Z = `dashboard:${randomUUID()}`;
      const sameTs = tick();
      const z1 = codexTurn(Z, "Z1", "ZA1", sameTs);
      codexTurn(Z, "Z2", "ZA2", sameTs);
      const K4 = newForkKey();
      const r4 = await forkThread(Z, K4, sdk, z1.id);
      out.push(assert("★같은 ms 에 찍힌 두 답 — 고른 답(앞)까지만", r4.ok && JSON.stringify(texts(K4)) === JSON.stringify(["Z1", "ZA1"]), { r4, texts: texts(K4) }));

      // ⑤ 표식 없는 답(오류 안내·저장 미확인) — 거절, 아무것도 안 남김.
      const n0 = lineageCount();
      chat(Z, "실패한 질문", "⚠️ 응답 생성 실패"); // 표식 없음
      const r5 = await forkThread(Z, newForkKey(), sdk, randomUUID());
      out.push(assert("표식 없는 답(오류 안내 등)·다른 대화의 턴 id 는 `not_turn` — 아무것도 안 남김",
        !r5.ok && r5.reason === "not_turn" && lineageCount() === n0, { r5, lineage: lineageCount() - n0 }));

      // ⑥ 요약된 구간 · 그 답 뒤 /clear — 거절(지금은 지원 안 하는 지점), 아무것도 안 남김. 요약이 그 답 이하면 물려준다.
      const Y = `dashboard:${randomUUID()}`;
      const y1 = codexTurn(Y, "Y1", "YA1");
      const y2 = codexTurn(Y, "Y2", "YA2");
      const y2Id = (db.prepare(`SELECT MAX(id) AS m FROM transcripts WHERE content = 'YA2'`).get() as { m: number }).m;
      upsertThreadSummary({ threadKey: Y, summary: "Y 요약(Y2 까지)", compactedThrough: y2Id });
      const n1 = lineageCount();
      const r6 = await forkThread(Y, newForkKey(), sdk, y1.id);
      const K6 = newForkKey();
      const r6b = await forkThread(Y, K6, sdk, y2.id);
      const sum6 = db.prepare(`SELECT summary FROM thread_summaries WHERE thread_key = ?`).get(K6) as { summary: string } | undefined;
      out.push(assert("★그 답이 요약된 구간이면 `summarized`(아무것도 안 남김) · 요약이 그 답 이하면 그 요약을 물려준다",
        !r6.ok && r6.reason === "summarized" && r6b.ok && sum6?.summary === "Y 요약(Y2 까지)" && lineageCount() === n1 + 1,
        { r6, r6b: r6b.ok, sum6, lineage: lineageCount() - n1 }));
      const V = `dashboard:${randomUUID()}`;
      const v1 = codexTurn(V, "V1", "VA1");
      setContextBoundary(CH, V, v1.ts + 1); // 그 답 뒤에 /clear
      const n2 = lineageCount();
      const r7 = await forkThread(V, newForkKey(), sdk, v1.id);
      out.push(assert("그 답 뒤에 대화를 비웠으면 `cleared_after`(그 시점 경계를 몰라 지운 맥락이 되살아난다) — 아무것도 안 남김",
        !r7.ok && r7.reason === "cleared_after" && lineageCount() === n2, { r7 }));

      // ⑦ SDK 복제를 기다리는 사이 답한 뒤 접기가 요약을 그 답 너머로 진전 — 최종 트랜잭션이 거절하고 복제본을 지운다.
      const x2Id = (db.prepare(`SELECT MAX(id) AS m FROM transcripts WHERE content = 'XA2'`).get() as { m: number }).m;
      mode = "race"; raceParent = P; raceThrough = x2Id;
      const f0 = files();
      const n3 = lineageCount();
      const r8 = await forkThread(P, newForkKey(), sdk, x1.id);
      mode = "ok";
      out.push(assert("★복제 대기 중 요약이 진전하면 검사한 요약 ≠ 복사할 요약 — `summarized` 로 거절 · SDK 복제본 삭제 · 기록 없음(조용히 요약을 빼고 성공시키지 않는다)",
        !r8.ok && r8.reason === "summarized" && files() === f0 && lineageCount() === n3, { r8, files: files() - f0 }));

      // ⑧ 체크포인트가 도구 호출 중 메시지면 거절(반쪽 턴 복사 금지 — 보조 검사).
      const W = `dashboard:${randomUUID()}`;
      const w = randomUUID();
      ensureThread(W, w);
      const wfile = path.join(dir, `${w}.jsonl`);
      const tu = line("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], tick());
      fs.writeFileSync(wfile, `${line("user", "W1", tick()).text}\n${tu.text}\n`);
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: W, claudeSessionId: w, jsonlPath: wfile });
      const bogus = claudeTurnMark(randomUUID(), { channel: CH, threadKey: W, sid: w, uuid: tu.uuid, systemPromptHash: null })!;
      chat(W, "W1", "(도구 중)", bogus);
      const r9 = await forkThread(W, newForkKey(), sdk, bogus.id);
      out.push(assert("체크포인트가 도구 호출 중인 메시지면 `boundary` — 반쪽 턴을 복사하지 않는다", !r9.ok && r9.reason === "boundary", r9));

      // ⑨ 표식 발급 조건(퍼사드가 부르는 그대로) — 파일 없음·덜 쓴 마지막 줄은 미발급, 새 줄 0 이어도 이미 적재됐으면 발급, 사이드체인은 무시.
      const M = `dashboard:${randomUUID()}`;
      const m = randomUUID();
      const mfile = path.join(dir, `${m}.jsonl`);
      const missing = (() => { mem.indexJsonlIfNeeded({ channel: CH, threadKey: M, claudeSessionId: m, jsonlPath: mfile }); return claudeTurnMark(randomUUID(), { channel: CH, threadKey: M, sid: m, uuid: "u-none", systemPromptHash: null }); })();
      const ml1 = line("user", "M1", tick());
      const ma1 = line("assistant", [{ type: "text", text: "MA1" }], tick());
      fs.writeFileSync(mfile, `${ml1.text}\n${ma1.text}`); // 마지막 줄 덜 씀(개행 없음)
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: M, claudeSessionId: m, jsonlPath: mfile });
      const partial = claudeTurnMark(randomUUID(), { channel: CH, threadKey: M, sid: m, uuid: ma1.uuid, systemPromptHash: null });
      fs.appendFileSync(mfile, "\n" + line("assistant", [{ type: "text", text: "하위" }], tick(), randomUUID(), { isSidechain: true }).text + "\n");
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: M, claudeSessionId: m, jsonlPath: mfile });
      const complete = claudeTurnMark(randomUUID(), { channel: CH, threadKey: M, sid: m, uuid: ma1.uuid, systemPromptHash: null });
      mem.indexJsonlIfNeeded({ channel: CH, threadKey: M, claudeSessionId: m, jsonlPath: mfile }); // 새 줄 0
      const again = claudeTurnMark(randomUUID(), { channel: CH, threadKey: M, sid: m, uuid: ma1.uuid, systemPromptHash: null });
      out.push(assert("★표식 발급: 파일 없음·덜 쓴 마지막 줄은 미발급 · 줄이 완성되면 발급(뒤의 하위 에이전트 줄은 무시) · 이미 적재돼 새 줄 0 이어도 발급",
        missing === undefined && partial === undefined && complete?.claude?.uuid === ma1.uuid && again?.claude?.uuid === ma1.uuid,
        { missing: missing !== undefined, partial: partial !== undefined, complete: complete?.claude?.uuid === ma1.uuid, again: again !== undefined }));

      // ⑪ 늦게 적재된 Claude 답(그 턴엔 마지막 줄이 덜 써져 표식 없음) 뒤 Codex 답에서 갈라내기 — 그 Claude 답이 T 밖이라 빠지는 대신
      //  `catch_up` 으로 거절한다(적대 검토 P2 탐침 A). 따라잡기는 갈라내기 진입 때 먼저 한다.
      {
        const L = `dashboard:${randomUUID()}`;
        const l = randomUUID();
        ensureThread(L, l);
        const lfile = path.join(dir, `${l}.jsonl`);
        claudeTurn(L, l, "L0", "LA0", "H");
        const lu = line("user", "L1", tick());
        const la = line("assistant", [{ type: "text", text: "LA1-late" }], tick());
        fs.appendFileSync(lfile, `${lu.text}\n${la.text}`); // 답 줄 덜 씀 → 그 턴 표식 없음
        mem.indexJsonlIfNeeded({ channel: CH, threadKey: L, claudeSessionId: l, jsonlPath: lfile });
        chat(L, "L1", "LA1-late"); // 화면엔 답이 있다
        const lx = codexTurn(L, "LX", "LXA");
        // 줄이 아직 덜 쓰인 채 — 그 꼬리는 고른 Codex 답보다 **앞선** Claude 답이다(파일 안에 고른 답보다 늦은 메시지가 없다) → 거절.
        const n0 = lineageCount();
        const rp = await forkThread(L, newForkKey(), sdk, lx.id);
        out.push(assert("★덜 쓴 꼬리가 고른 답보다 앞선 기록일 수 있으면(파일 안에 고른 답·그보다 늦은 메시지 없음) `catch_up` 거절 — 늦은 Claude 답이 조용히 빠지지 않는다",
          !rp.ok && rp.reason === "catch_up" && lineageCount() === n0, rp));
        fs.appendFileSync(lfile, "\n"); // 줄 완성 — 다음 적재가 그 답을 lx 의 T 뒤 id 로 넣는다
        const n = lineageCount();
        const rl = await forkThread(L, newForkKey(), sdk, lx.id);
        out.push(assert("★늦게 적재된 Claude 답 뒤 Codex 답에서 갈라내면 `catch_up` 거절(그 답이 가지에서 조용히 빠지지 않는다) — 아무것도 안 남김",
          !rl.ok && rl.reason === "catch_up" && lineageCount() === n, rl));
      }

      // ⑫ Claude 답 뒤에 내용 있는 queue-operation 행 — 그 턴 표식의 T(전역 최대)와 S(대화 행 끝)가 갈린다. 뒤 Codex 답에서 갈라내면
      //  델타 = Codex 구간만(복제 내용 중복 없음). «S = T» 변이를 잡는 자리(적대 검토 G1 탐침 F).
      {
        const Fk = `dashboard:${randomUUID()}`;
        const f = randomUUID();
        ensureThread(Fk, f);
        const ffile = path.join(dir, `${f}.jsonl`);
        const fu = line("user", "FC", tick());
        const fa = line("assistant", [{ type: "text", text: "FA" }], tick());
        const fq = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(tick()).toISOString(), content: "줄 선 입력" });
        fs.writeFileSync(ffile, `${fu.text}\n${fa.text}\n${fq}\n`);
        mem.indexJsonlIfNeeded({ channel: CH, threadKey: Fk, claudeSessionId: f, jsonlPath: ffile });
        const fmark = claudeTurnMark(randomUUID(), { channel: CH, threadKey: Fk, sid: f, uuid: fa.uuid, systemPromptHash: "H" })!;
        chat(Fk, "FC", "FA", fmark);
        const fx = codexTurn(Fk, "FX", "FXA");
        const KF = newForkKey();
        const rf = await forkThread(Fk, KF, sdk, fx.id);
        const sf = getSession(CH, KF);
        const deltaF = loadClaudeReplayHistory(CH, KF, sf?.claudeSessionId).delta.map((t) => t.content);
        out.push(assert("★Claude 답 뒤 queue-operation 행이 있어도(T ≠ S) Codex 답에서 갈라낸 가지의 델타는 Codex 구간만",
          rf.ok && fmark.through !== fmark.claude!.includedThrough && JSON.stringify(deltaF) === JSON.stringify(["FX", "FXA"]),
          { rf, T: fmark.through, S: fmark.claude!.includedThrough, deltaF }));
      }

      // ⑬ 적재 완료 계약(아스트라 구현 검토 2) — «이번 답의 마지막 메시지까지» 만 본다: 그 뒤 덜 쓴 꼬리가 있어도 발급하고(복제는 그 uuid
      //  까지라 꼬리와 무관), 표식 뒤 파일이 사라졌으면 갈라내기가 «기록으로 다시 짓기»(rebuilt)로 간다.
      {
        const Gk = `dashboard:${randomUUID()}`;
        const g = randomUUID();
        ensureThread(Gk, g);
        const gfile = path.join(dir, `${g}.jsonl`);
        const gu = line("user", "G1", tick());
        const ga = line("assistant", [{ type: "text", text: "GA1" }], tick());
        fs.writeFileSync(gfile, `${gu.text}\n${ga.text}\n{"type":"last-prompt","partial`); // 답 뒤 덜 쓴 꼬리
        mem.indexJsonlIfNeeded({ channel: CH, threadKey: Gk, claudeSessionId: g, jsonlPath: gfile });
        const gm = claudeTurnMark(randomUUID(), { channel: CH, threadKey: Gk, sid: g, uuid: ga.uuid, systemPromptHash: null });
        if (gm !== undefined) chat(Gk, "G1", "GA1", gm);
        // 꼬리를 **남긴 채** 그 답에서 갈라낸다(아스트라 마무리 검토 — 종전 검사는 파일을 지운 뒤라 이 경로를 안 봤다).
        forkCalls.length = 0;
        const rg = gm === undefined ? undefined : await forkThread(Gk, newForkKey(), sdk, gm.id);
        out.push(assert("★적재 완료: 답 뒤 덜 쓴 꼬리가 있어도 표식 발급 · 그 꼬리를 남긴 채 그 답에서 갈라진다(그 uuid 까지만 복제)",
          gm !== undefined && rg?.ok === true && rg.claude === "copied" && forkCalls[0]?.upTo === ga.uuid, { gm: gm !== undefined, rg, forkCalls }));
        // 표식 뒤 파일이 사라지면 «기록으로 다시 짓기».
        const Hk = `dashboard:${randomUUID()}`;
        const h = randomUUID();
        ensureThread(Hk, h);
        const hfile = path.join(dir, `${h}.jsonl`);
        const hu = line("user", "H1", tick());
        const ha = line("assistant", [{ type: "text", text: "HA1" }], tick());
        fs.writeFileSync(hfile, `${hu.text}\n${ha.text}\n`);
        mem.indexJsonlIfNeeded({ channel: CH, threadKey: Hk, claudeSessionId: h, jsonlPath: hfile });
        const hm = claudeTurnMark(randomUUID(), { channel: CH, threadKey: Hk, sid: h, uuid: ha.uuid, systemPromptHash: null })!;
        chat(Hk, "H1", "HA1", hm);
        fs.rmSync(hfile);
        const rh = await forkThread(Hk, newForkKey(), sdk, hm.id);
        out.push(assert("표식 뒤 파일이 사라지면 갈라내기는 `rebuilt`(기록으로 다시 짓기)", rh.ok && rh.claude === "rebuilt", rh));
        // Codex 답을 골랐고 그 **뒤** Claude 턴이 이미 있다 + 파일 끝에 덜 쓴 꼬리 → 꼬리는 고른 답보다 늦은 메시지 뒤라 무관 — 갈라진다.
        const Jk = `dashboard:${randomUUID()}`;
        const j = randomUUID();
        ensureThread(Jk, j);
        const jc = claudeTurn(Jk, j, "J1", "JA1", "H");
        const jx = codexTurn(Jk, "JX", "JXA");
        claudeTurn(Jk, j, "J2", "JA2", "H");
        fs.appendFileSync(path.join(dir, `${j}.jsonl`), `{"type":"last-prompt","partial`);
        forkCalls.length = 0;
        const KJ = newForkKey();
        const rj = await forkThread(Jk, KJ, sdk, jx.id);
        out.push(assert("★Codex 답을 골랐고 파일에 그보다 늦은 메시지가 있으면 끝의 덜 쓴 꼬리는 무관 — 갈라진다(체크포인트 = 그 앞 Claude 답 · 뒤 J2 없음)",
          rj.ok && forkCalls[0]?.upTo === jc.uuid && JSON.stringify(texts(KJ)) === JSON.stringify(["J1", "JA1", "JX", "JXA"]), { rj, forkCalls, texts: texts(KJ) }));
        // 끝에서 가르면(v1) 덜 쓴 꼬리는 거절 — T(지금)가 그 줄을 놓친다.
        const nj = lineageCount();
        const rv1 = await forkThread(Jk, newForkKey(), sdk);
        out.push(assert("끝에서 갈라내기는 현재 Claude 세션 끝에 덜 쓴 줄이 있으면 `catch_up` 거절(v1 그대로)",
          !rv1.ok && rv1.reason === "catch_up" && lineageCount() === nj, rv1));
      }

      // ⑭ 조상의 «갈라진 뒤» Claude 표식은 가지의 체크포인트가 아니다 · 체크포인트와 고른 답 사이 /clear 면 Claude 복제 안 함 ·
      //  forkedAt(도구 스텝 상한) = 고른 답 시각(적대 검토 G3).
      {
        const c3 = claudeTurn(P, a, "C3-부모만", "A3-부모만", "H-new"); // KE 가 갈라진 뒤 부모에만 생긴 Claude 답
        const kx = codexTurn(KE, "KX", "KXA");
        forkCalls.length = 0;
        const rk = await forkThread(KE, newForkKey(), sdk, kx.id);
        out.push(assert("★가지에서 Codex 답으로 갈라내면 체크포인트는 그 가지가 아는 마지막 Claude 답(조상이 갈라진 뒤 낸 Claude 답 아님)",
          rk.ok && forkCalls[0]?.upTo !== c3.uuid && forkCalls[0]?.upTo === c2.uuid, { rk, forkCalls, c2: c2.uuid, c3: c3.uuid }));
        const Q = `dashboard:${randomUUID()}`;
        const q = randomUUID();
        ensureThread(Q, q);
        const qc = claudeTurn(Q, q, "Q1", "QA1", "H");
        setContextBoundary(CH, Q, qc.ts + 1); // /clear — Claude 답 뒤
        const qx = codexTurn(Q, "QX", "QXA");
        tick(); tick(); // 가지를 만드는 시각이 고른 답 시각과 갈리게 — 같으면 «만든 시각» 으로 되돌린 변이와 구별이 안 된다
        forkCalls.length = 0;
        const KQ = newForkKey();
        const rq = await forkThread(Q, KQ, sdk, qx.id);
        const { lineageChain } = await import("../../store/thread-members.js");
        out.push(assert("체크포인트와 고른 답 사이에 /clear 면 Claude 복제 안 함(지운 맥락 부활 금지) · 도구 스텝 상한 = 고른 답 시각",
          rq.ok && rq.claude === "none" && forkCalls.length === 0 && lineageChain(CH, KQ)[0]?.forkedAt === qx.ts,
          { rq, forkCalls, forkedAt: lineageChain(CH, KQ)[0]?.forkedAt, qx: qx.ts }));
      }

      // ⑮ 생각(thinking)만 있는 메시지는 행을 만들지 않는다(uuid 만 남긴다) — ts=0 빈 행이 기록 맨 앞에 끼지 않는다(적대 검토 G4).
      const zeroTs = (db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ts = 0`).get() as { n: number }).n;
      out.push(assert("생각만 있는 메시지가 빈 행(ts=0)을 만들지 않는다", zeroTs === 0, { zeroTs }));

      // ⑯ 화면 조회·라우트 — 표식 있는 답만 turnId · 라우트가 body.turn 으로 그 지점에서 가른다(적대 검토 G2: 이 배선이 빠지면 «끝에서» 로 조용히 퇴화).
      {
        const hist = getRecentChatLog({ threadKey: Z, limit: 50 });
        const routeUrl = new URL("../../../plugins/http-bridge/routes-sessions.js", import.meta.url).href;
        const { handleSessionFork } = (await import(routeUrl)) as { handleSessionFork: (ctx: unknown) => Promise<void> };
        const { Readable } = await import("node:stream");
        const call = async (body: Record<string, unknown>): Promise<{ status: number; sent: string }> => {
          const raw = JSON.stringify(body);
          const req = Object.assign(Readable.from([Buffer.from(raw)]), { headers: { "content-length": String(Buffer.byteLength(raw)) } });
          let status = 0, sent = "";
          const res = { writeHead: (c: number) => { status = c; return res; }, setHeader: () => res, end: (b: string) => { sent = b; } };
          await handleSessionFork({ req, res, url: new URL("http://x/session-fork"), pathname: "/session-fork" });
          return { status, sent };
        };
        const KR = newForkKey();
        const okRoute = await call({ threadKey: Z, childKey: KR, turn: z1.id });
        const badRoute = await call({ threadKey: Z, childKey: newForkKey(), turn: randomUUID() });
        out.push(assert("★화면 조회는 표식 있는 답에만 turnId · 라우트는 body.turn 지점에서 가른다(뒤 답 없음) · 표식 없는 지점은 400",
          hist.some((e) => e.turnId === z1.id) && hist.filter((e) => e.role === "user").every((e) => e.turnId === undefined) &&
            hist.some((e) => e.text === "⚠️ 응답 생성 실패" && e.turnId === undefined) &&
            okRoute.status === 200 && JSON.stringify(texts(KR)) === JSON.stringify(["Z1", "ZA1"]) && badRoute.status === 400,
          { okRoute: okRoute.status, badRoute: badRoute.status, texts: texts(KR) }));
      }

      // ⑰ 끼워넣기 잔여 — 답 발행 때 통로에 남은 입력이 있으면 표식을 싣지 않는다(그 입력은 다음 턴인데 화면엔 이 답 앞에 있다, 적대 검토 P2).
      {
        const { createSteeringChannel } = await import("../../core/steering.js");
        const ch = createSteeringChannel();
        const p0 = ch.pending();
        ch.push({ text: "x", raw: "x", ts: 1 } as never);
        const p1 = ch.pending();
        const drained = ch.drain();
        const p2 = ch.pending();
        ch.restore(drained);
        out.push(assert("끼워넣기 통로 `pending()` 은 비파괴로 남은 입력 수를 센다(되돌린 것 포함)",
          p0 === 0 && p1 === 1 && p2 === 0 && ch.pending() === 1, { p0, p1, p2, after: ch.pending() }));
      }

      // ⑩ 배선 — 퍼사드가 저장 확인 뒤 표식을 만들고(Codex: appendApiTurn 성공 뒤 · Claude: 적재를 그 자리에서), 답 이벤트·화면 기록이 싣는다.
      const { readSource } = await import("./_wiring.js");
      const facade = await readSource("../../core/llm-runtime/index.ts");
      const entry = await readSource("../../index.ts");
      const persist = await readSource("../../core/event-persist.ts");
      const wired = {
        codex: /appendApiTurn\(\{[\s\S]{0,600}?\}\);\s*output\.turn = apiTurnMark\(/.test(facade),
        claude: /indexJsonlIfNeeded\(\{[^}]*\}\);\s*const mark = claudeTurnMark\(/.test(facade) && !/void Promise\.resolve\(\)\s*\.then\(\(\) =>\s*indexJsonlIfNeeded/.test(facade),
        out: /out\.turn !== undefined && \(steeringCh\?\.pending\(\) \?\? 0\) === 0 \? \{ turn: out\.turn \}/.test(entry),
        router: /out\.turn !== undefined \? \{ turn: out\.turn \}/.test(await readSource("../../core/router.ts")),
        persist: /channel\.message\.out" && payload\.turn/.test(persist),
      };
      out.push(assert("배선: 저장 확인 뒤 표식(Codex·Claude 동기 적재) → 런타임→라우터 → 답 이벤트(끼워넣기 잔여 없을 때만) → 화면 기록", Object.values(wired).every(Boolean), wired));
      // 대시보드 — 라이브 세 갈래·복원(세그먼트 병합 포함)이 같은 turn id 를 카드에, 메뉴는 그 값이 있을 때만, 요청은 turn·재시도 키 (대화, 지점).
      const dash = (f: string): string => fs.readFileSync(new URL(`../../../packages/dashboard/js/${f}`, import.meta.url), "utf8");
      const hints = dash("channel-hints.js"), hr = dash("history-render.js"), rp = dash("reply.js"), tb = dash("tabs.js");
      const ui = {
        liveThree: (hints.match(/dataset\.turn = turnId/g) ?? []).length === 3 && /payload\.notice !== true && payload\.turn/.test(hints),
        restored: /isOut && !isNotice && typeof entry\.turnId === "string"/.test(hr) && /it\.m\.turnId/.test(hr) && /a\.turnId/.test(hr),
        menu: /closest\("\[data-turn\]"\)/.test(rp) && /if \(ctx && ctx\.turn\) items\.push/.test(rp),
        request: /turn \? \{ threadKey: tk, childKey, turn \}/.test(tb) && /const rk = turn \? tk \+ "\|" \+ turn : tk/.test(tb),
      };
      out.push(assert("배선(화면): 라이브 세 갈래·복원·세그먼트 병합에 같은 turn id · 메뉴는 그 값 있을 때만 · 요청에 turn · 재시도 키 (대화, 지점)",
        Object.values(ui).every(Boolean), ui));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return out;
  },
};
