/**
 * 회귀: **Codex 다음 턴 첫 요청은 직전 턴 첫 요청의 연장이다 — 이력이 턴을 넘어 캐시를 탄다** (2026-09-28, 회사 돌쇠 로그).
 *
 * ★사고: 턴을 넘긴 첫 요청이 늘 지시문·도구까지만 캐시를 탔다(dev 일주일 49/49 · 회사 세션 한 턴 입력 10.1만 중 5.9만 정가).
 *  이 백엔드는 **직전 요청 전체가 앞머리에 있을 때만** 캐시를 준다(통제 실험: 앞 두 항목이 같아도 마지막 메시지가 다르면
 *  29,568 = 지시문·도구까지 / 직전 요청 + 새 항목이면 36,224, 3회 모두 같음). 우리는 이번 턴 사용자 메시지에 휘발 블록을
 *  붙여 보내고, 이력에는 **떼고** 되살렸다 — 그래서 다음 요청이 직전 요청의 연장이 아니었다.
 * 처방: 그 턴에 보낸 그대로를 사용자 행에 묶어 저장하고(`appendApiTurn.userSent`), Codex 이력이 그것으로 되살린다.
 *  발화 원문(`transcripts.content`)은 그대로다 — 요약 입력·다른 어댑터·검색이 쓴다.
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-history-extends-previous-request",
  guards: "Codex 이력이 휘발 블록을 뗀 채 되살아나 다음 턴 요청이 직전 요청의 연장이 아니게 되고, 이력 전체가 턴마다 캐시를 못 타던 것",
  run: async (): Promise<Assertion[]> => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const childHome = mkdtempSync(`${tmpdir()}/tiguclaw-regression-history-extends-`);
    const child = await spawnWithin(90_000, "이력 연장 실경로", ["--import", "tsx", fileURLToPath(new URL("./_codex-history-extends-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: childHome } })
      .finally(() => rmSync(childHome, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("EXTENDS_RESULT "));
    const N = (line === undefined ? {} : JSON.parse(line.slice("EXTENDS_RESULT ".length))) as {
      turns?: number; extensions?: Array<{ turn: number; prevLen: number; matched: number }>; userContents?: string[]; sentHasScaffold?: boolean[]; error?: string;
    };

    // 부품: 크기 셈 · 되살리지 않는 어댑터 · 같을 때 저장 안 함.
    const { initStore, getDb } = await import("../../store/sessions.js");
    const { appendApiTurn } = await import("../../store/memory.js");
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    initStore();
    const CH = "http-bridge" as const;
    const TK = "regr:history-extends-parts";
    appendApiTurn({ channel: CH, threadKey: TK, claudeSessionId: "codex-extends-1", userContent: "질문", assistantContent: "답", userSent: "<system-reminder>\n환경\n</system-reminder>\n\n질문" });
    appendApiTurn({ channel: CH, threadKey: TK, claudeSessionId: "codex-extends-1", userContent: "같은 글", assistantContent: "답2", userSent: "같은 글" });
    const load = (adapter: string) => H.compactThreadHistory({
      channel: CH, threadKey: TK, provider: adapter, adapter,
      budget: { instructionsChars: 1_000, promptChars: 100 },
      summarize: async () => { throw new Error("요약이 불리면 안 된다(작은 이력)"); },
    });
    const codex = await load("codex");
    const openai = await load("openai");
    const sentRows = (getDb().prepare(`SELECT count(*) AS n FROM turn_items ti JOIN transcripts t ON t.id = ti.transcript_id WHERE t.claude_session_id = 'codex-extends-1' AND t.role = 'user'`).get() as { n: number }).n;
    const firstUser = codex.allTurns.find((t) => t.role === "user");
    const input = H.buildCodexInputArray(H.recentTurnsAfter(codex.allTurns, codex.watermark, { budgetUsedChars: 0 }), "", { type: "message", role: "user", content: [{ type: "input_text", text: "다음" }] });
    const firstText = JSON.stringify(input[0]);

    // 크기 셈이 **자리마다** 보내는 쪽 길이인가 — 창 안전망·계획의 최근 몫(적대 검토 G1: 둘을 content 로 바꿔도 초록이었다).
    const big = "휘".repeat(800);
    const win = H.recentTurnsAfter([
      { id: 1, role: "user", content: "a", sent: big },
      { id: 2, role: "assistant", content: "b" },
      { id: 3, role: "user", content: "c" },
      { id: 4, role: "assistant", content: "d" },
    ], 0, { budgetUsedChars: 0, charCap: 500 });
    const huge = "휘".repeat(10_000);
    const plan = H.planHistoryCompaction([
      { id: 1, role: "user", content: "u1", sent: huge }, { id: 2, role: "assistant", content: "a1" },
      { id: 3, role: "user", content: "u2", sent: huge }, { id: 4, role: "assistant", content: "a2" },
      { id: 5, role: "user", content: "u3", sent: huge }, { id: 6, role: "assistant", content: "a3" },
    ], 0, { triggerChars: 100, keepRecentChars: 15_000, maxFoldChars: 1_000_000 });

    const ext = N.extensions ?? [];
    return [
      assert("실경로가 네 턴을 돌았다", N.turns === 4 && N.error === "", { turns: N.turns, error: N.error }),
      assert("★다음 턴 첫 요청 = 직전 턴 첫 요청 전체 + 새 항목(도구를 쓴 턴·안 쓴 턴 모두)",
        ext.length === 3 && ext.every((e) => e.prevLen > 0 && e.matched === e.prevLen), ext),
      assert("기록(transcripts)은 발화 원문 그대로 — 보낸 그대로는 따로 묶인다",
        JSON.stringify(N.userContents) === JSON.stringify(["첫 질문", "둘째 질문", "셋째 질문", "넷째 질문"]) && (N.sentHasScaffold ?? []).length === 4 && (N.sentHasScaffold ?? []).every(Boolean),
        { userContents: N.userContents, sentHasScaffold: N.sentHasScaffold }),
      assert("Codex 이력의 사용자 메시지는 보낸 그대로(휘발 블록 포함)", firstUser?.sent?.startsWith("<system-reminder>") === true && firstText.includes("<system-reminder>"), { firstUser, firstText: firstText.slice(0, 200) }),
      assert("크기는 보내는 쪽으로 센다(보낸 그대로의 길이)", H.turnSize({ content: "ab", sent: "abcd" }) === 4 && H.turnSize({ content: "ab" }) === 2,
        { withSent: H.turnSize({ content: "ab", sent: "abcd" }), without: H.turnSize({ content: "ab" }) }),
      assert("되살리지 않는 어댑터(OpenAI)에는 보낸 그대로가 실리지 않는다 — 안 보내는 것을 세지 않는다",
        openai.allTurns.every((t) => t.sent === undefined) && codex.allTurns.some((t) => t.sent !== undefined), { openai: openai.allTurns.map((t) => t.sent) }),
      assert("발화 원문과 같으면 따로 저장하지 않는다(중복 0)", sentRows === 1, { sentRows }),
      assert("창 안전망은 보낸 그대로의 길이로 센다 — 상한을 넘는 오래된 사용자 턴은 창 밖", win.length === 3 && win[0]?.content === "b", win.map((t) => t.content)),
      assert("계획의 «최근 원문 몫» 도 보낸 쪽 길이로 센다 — 큰 사용자 턴이 몫을 채우면 그 앞은 접는다",
        plan.needed && plan.toFold.length === 3 && plan.toFold[0]?.content.includes("u1") === true && !JSON.stringify(plan.toFold).includes("휘"),
        { needed: plan.needed, folded: plan.toFold.map((t) => t.content.slice(0, 20)) }),
    ];
  },
};
