import { readFileSync } from "node:fs";
import { assert, assertIsolated, type RegressionCheck } from "./_framework.js";
import { initStore, setContextBoundary } from "../../store/sessions.js";
import { appendTranscript, indexCodexTurn, loadThreadHistory } from "../../store/memory.js";
import { loadClaudeReplayHistory } from "../../core/llm-runtime/adapters/_claude-replay-history.js";

export const check: RegressionCheck = {
  name: "claude-foreign-history-boundary",
  guards: "Claude 경계가 최근 창 밖으로 밀리거나 동일 문장이 반복될 때 다른 모델 기록을 누락하던 결함",
  run: async () => {
    assertIsolated(); initStore();
    const channel = "http-bridge" as const;
    let ts = 1_800_000_000_000;
    const add = (key: string, sid: string, content: string) => {
      indexCodexTurn({ channel, threadKey: key, claudeSessionId: sid });
      appendTranscript({ claudeSessionId: sid, role: "assistant", content, ts: ++ts });
    };
    const key = "regr:claude-foreign-count", own = key + ":claude", other = key + ":codex";
    add(key, own, "Claude boundary");
    for (let i = 0; i < 45; i++) add(key, other, `foreign ${i}`);
    const count = loadClaudeReplayHistory(channel, key, own);
    const charKey = "regr:claude-foreign-chars";
    add(charKey, charKey + ":claude", "x".repeat(199_900));
    add(charKey, charKey + ":codex", "y".repeat(150));
    const chars = loadClaudeReplayHistory(channel, charKey, charKey + ":claude");
    const repeatKey = "regr:claude-foreign-repeat";
    add(repeatKey, repeatKey + ":claude", "same answer");
    add(repeatKey, repeatKey + ":codex", "important new requirement");
    add(repeatKey, repeatKey + ":codex", "same answer");
    const repeated = loadClaudeReplayHistory(channel, repeatKey, repeatKey + ":claude");
    const fresh = loadClaudeReplayHistory(channel, repeatKey, undefined);
    add(repeatKey, repeatKey + ":claude", "latest Claude");
    const continuous = loadClaudeReplayHistory(channel, repeatKey, repeatKey + ":claude");
    setContextBoundary(channel, repeatKey, ts);
    add(repeatKey, repeatKey + ":codex", "after reset");
    const reset = loadClaudeReplayHistory(channel, repeatKey, repeatKey + ":claude");
    // 창보다 긴 스레드에서 자기 행이 창 **안**(맨 끝)이면 보낼 것이 없다 — 긴 스레드에서 경계 탐색을
    //  건너뛰면 재개된 Claude 가 매 턴 최근 40개를 다시 받는다(싱크 레드팀 B G1).
    const longKey = "regr:claude-foreign-long";
    for (let i = 0; i < 50; i++) add(longKey, longKey + ":codex", `long foreign ${i}`);
    add(longKey, longKey + ":claude", "Claude latest");
    const long = loadClaudeReplayHistory(channel, longKey, longKey + ":claude");
    // 경계는 **시각 순**의 마지막 자기 행이다 — 늦게 색인된 Claude 줄(id 는 크고 ts 는 이른)이
    //  그 뒤의 다른 모델 행을 가리면 안 된다(싱크 레드팀 B G3).
    const lateKey = "regr:claude-foreign-late-index";
    const t0 = ++ts; ts += 2;
    indexCodexTurn({ channel, threadKey: lateKey, claudeSessionId: lateKey + ":codex" });
    appendTranscript({ claudeSessionId: lateKey + ":codex", role: "assistant", content: "codex after claude", ts: t0 + 2 });
    indexCodexTurn({ channel, threadKey: lateKey, claudeSessionId: lateKey + ":claude" });
    appendTranscript({ claudeSessionId: lateKey + ":claude", role: "assistant", content: "claude indexed late", ts: t0 + 1 });
    const late = loadClaudeReplayHistory(channel, lateKey, lateKey + ":claude");
    const adapter = readFileSync(new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url), "utf8");
    return [
      assert("40개 창 밖 경계여도 최근 다른 모델 기록 유지", count.delta.length === 40 && count.delta[0]?.content === "foreign 5" && count.delta.at(-1)?.content === "foreign 44", { count: count.delta.length, first: count.delta[0], last: count.delta.at(-1) }),
      assert("문자 상한 밖 경계여도 최근 다른 모델 기록 유지", chars.delta.length === 1 && chars.delta[0]?.content === "y".repeat(150), chars.delta.map(x => x.content.length)),
      assert("같은 본문을 다른 세션의 경계로 오인하지 않음", repeated.delta.length === 2 && repeated.delta[0]?.content === "important new requirement", repeated.delta),
      assert("연속 Claude 재주입 없음·재개 실패용 전체 기록 유지", continuous.delta.length === 0 && continuous.full.length === 4, { delta: continuous.delta, full: continuous.full }),
      assert("창보다 긴 스레드에서도 자기 행 뒤만 — 자기 행이 끝이면 보낼 것 없음", long.delta.length === 0 && long.full.length === 40, { delta: long.delta.length, full: long.full.length }),
      assert("경계는 시각 순 — 늦게 색인된 자기 줄이 그 뒤 다른 모델 행을 가리지 않음", late.delta.length === 1 && late.delta[0]?.content === "codex after claude", late.delta),
      assert("fresh 경로는 전체 최근 기록 전달", fresh.delta.length === 3 && JSON.stringify(fresh.delta) === JSON.stringify(fresh.full), fresh),
      assert("reset 이전 기록을 복원하지 않음", reset.delta.length === 1 && reset.full.length === 1 && reset.delta[0]?.content === "after reset", reset),
      assert("기존 전체 기록 로더는 경계 지정 없이 동일", loadThreadHistory(channel, key).length === 40, loadThreadHistory(channel, key).length),
      assert("실제 어댑터가 재개 SID와 결과를 연결", /loadClaudeReplayHistory\(\s*idChannel, input.threadKey, resumable \? prior.claudeSessionId : undefined/.test(adapter) && /threadTurnsForRebuild = history.full/.test(adapter) && /formatForeignDelta\(history.delta\)/.test(adapter), { call: adapter.match(/loadClaudeReplayHistory\([\s\S]*?\);/)?.[0], full: adapter.includes("threadTurnsForRebuild = history.full"), delta: adapter.includes("formatForeignDelta(history.delta)") }),
    ];
  },
};
