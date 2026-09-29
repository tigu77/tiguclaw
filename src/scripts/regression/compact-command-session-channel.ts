/**
 * 회귀: **`/compact` 는 자동 압축과 같은 세션 키로 기록을 찾는다** (2026-09-27, 적대 검토 부수 발견).
 *
 * ★사고: 텔레그램이 대시보드 세션을 이어 쓰는 턴은 `msg.channel=telegram`, `msg.threadKey=dashboard:…` 로 들어오고,
 *  기록은 세션 저장 채널(canonical) 아래 색인된다. 다른 슬래시 명령(`/reset`·`/model`)은 그 키(`sidChannel`)를 쓰는데
 *  `/compact` 만 `msg.channel` 을 넘겨 **기록을 못 찾았다**(«아직 기록이 없습니다»).
 *
 * 핸들러를 그대로 부른다 — 요약 LLM 만 포트로 가짜, 토큰은 가짜 환경값. 모델 호출 0.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "compact-command-session-channel",
  guards: "텔레그램에서 이어 쓰는 대시보드 세션에 /compact 를 치면 다른 채널 키로 기록을 찾아 «기록이 없습니다» 로 끝나던 것",
  run: async (): Promise<Assertion[]> => {
    const { initStore, canonicalSessionChannel } = await import("../../store/sessions.js");
    const { appendApiTurn } = await import("../../store/memory.js");
    const { clearThreadSummary, getThreadSummary } = await import("../../store/thread-summaries.js");
    const { setSummarizerPort } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { handleCompact } = await import("../../core/entry/slash-commands.js");
    initStore();
    const TK = `dashboard:regr-compact-${Date.now()}`;
    const sid = canonicalSessionChannel(TK, "telegram");
    clearThreadSummary(sid, TK);
    for (let i = 0; i < 40; i++) {
      appendApiTurn({ channel: sid, threadKey: TK, claudeSessionId: `codex-regr-compact-${TK}`, userContent: `질문 ${i} ` + "가".repeat(200), assistantContent: `답 ${i} ` + "나".repeat(200) });
    }
    const replies: string[] = [];
    let summarized = 0;
    let cancelled = { replies: -1, summarized: -1 };
    const saved = { token: process.env.OPENAI_CODEX_OAUTH_TOKEN, exp: process.env.OPENAI_CODEX_OAUTH_EXPIRES };
    process.env.OPENAI_CODEX_OAUTH_TOKEN = "regression-fake-token";
    process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(Date.now() + 3_600_000);
    setSummarizerPort(async () => { summarized += 1; return "요약본 ".repeat(20); });
    try {
      await handleCompact({
        msg: { channel: "telegram", threadKey: TK, text: "/compact", reply: async (t: string) => { replies.push(t); } } as never,
        args: [],
        trimmed: "/compact",
        sidChannel: sid,
      } as never);
      // `/stop` 으로 멈춘 /compact — 안내는 `/stop` 이 이미 했으니 «압축 실패» 를 덧붙이지 않는다(요약도 안 부른다).
      const stopped = new AbortController();
      stopped.abort(Object.assign(new Error("user cancelled turn (/stop)"), { name: "UserCancelledError" }));
      const before = { replies: replies.length, summarized };
      await handleCompact({
        msg: { channel: "telegram", threadKey: TK, text: "/compact", reply: async (t: string) => { replies.push(t); } } as never,
        args: [],
        trimmed: "/compact",
        sidChannel: sid,
        signal: stopped.signal,
      } as never);
      cancelled = { replies: replies.length - before.replies, summarized: summarized - before.summarized };
    } finally {
      setSummarizerPort(null);
      if (saved.token === undefined) delete process.env.OPENAI_CODEX_OAUTH_TOKEN; else process.env.OPENAI_CODEX_OAUTH_TOKEN = saved.token;
      if (saved.exp === undefined) delete process.env.OPENAI_CODEX_OAUTH_EXPIRES; else process.env.OPENAI_CODEX_OAUTH_EXPIRES = saved.exp;
    }
    return [
      assert("재현 조건: 세션 저장 채널이 인입 채널(telegram)과 다르다(같으면 공짜 초록)", sid !== "telegram", sid),
      assert("★텔레그램에서 친 /compact 가 세션의 기록을 찾아 접는다(«기록이 없습니다» 아님)",
        summarized > 0 && (getThreadSummary(TK)?.compactedThrough ?? 0) > 0 && replies.some((r) => r.includes("압축했습니다")), { summarized, replies }),
      assert("★/stop 으로 멈춘 /compact 는 답을 덧붙이지 않고 요약도 안 부른다", cancelled.replies === 0 && cancelled.summarized === 0, cancelled),
    ];
  },
};
