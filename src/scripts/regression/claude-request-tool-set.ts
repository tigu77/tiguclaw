/**
 * 회귀: **Claude 요청에서 쓸 수 없는 CC 빌트인은 빼고, 능력 있는 도구는 남긴다** (2026-09-30).
 *
 * 사고: SDK 가 CC 작업 흐름용 빌트인을 매 호출 실어 첫 요청이 75K 토큰이었다(쌩 Claude Code 31K). 그중 `CronCreate`
 *  (세션 전용 — 턴이 끝나면 사라져 거짓 약속) · `LSP`(서버 없음) · `PushNotification`(늘 «터미널 활성» 이라 안 보냄) ·
 *  `Workflow`(SDK 서브에이전트와 같은 병) 등은 tiguclaw 에서 값이 0이었다 → 막으니 57.7K(−23%). 근거는 가짜 Anthropic
 *  서버로 실제 SDK 요청·도구 결과를 잡은 실측(상수 주석).
 * ★두 방향을 같이 잠근다 — 막을 것이 실리면 토큰이 새고, **남길 것이 빠지면 능력이 준다**(정태님: «정체성과 능력이
 *  손실되면 안 된다»). 회귀는 실제 SDK 를 띄우지 않는다(러너 봉인) — 그래서 배선과 목록을 본다.
 */
import { readFileSync } from "node:fs";
import { assert, type RegressionCheck } from "./_framework.js";

/** 반드시 남아야 하는 빌트인 — 파일·웹(능력) · 세션 간 메시지(실측: 사용자의 다른 Claude Code 세션이 보인다) · Monitor · Worktree. */
const MUST_KEEP = ["Read", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "SendMessage", "ListAgents", "Monitor", "EnterWorktree", "ExitWorktree"];

export const check: RegressionCheck = {
  name: "claude-request-tool-set",
  guards: "tiguclaw 에서 동작하지 않는 CC 빌트인(세션 전용 Cron·LSP·PushNotification·Workflow 등)이 매 호출 ~19K 토큰을 싣던 것 + 줄이다 능력 있는 도구까지 빠지는 것",
  run: async () => {
    const { SDK_UNUSABLE_TOOL_NAMES } = await import("../../core/llm-runtime/adapters/_claude-unusable-builtins.js");
    const adapter = readFileSync(new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url), "utf8");
    const at = adapter.indexOf("disallowedTools: withSdkSubagentsBlocked([");
    const block = at < 0 ? "" : adapter.slice(at, adapter.indexOf("]),", at));
    const names = [...SDK_UNUSABLE_TOOL_NAMES] as string[];
    const overBlocked = MUST_KEEP.filter((n) => names.includes(n));
    return [
      assert("★차단 배열이 쓸 수 없는 빌트인 목록을 펼친다(깊이 무관 — 자식도 같다)",
        /\n\s*\.\.\.SDK_UNUSABLE_TOOL_NAMES,\s*\n/.test(block.replace(/\/\/[^\n]*/g, "")), { found: at >= 0 }),
      assert("★목록: 세션 전용 Cron·LSP·PushNotification·Workflow 와 CC 전용 진입점 셋 — 능력 있는 도구는 없다",
        ["CronCreate", "CronDelete", "CronList", "LSP", "PushNotification", "Workflow", "ScheduleWakeup", "DesignSync", "ReportFindings"]
          .every((n) => names.includes(n)) && names.length === 9 && overBlocked.length === 0,
        { names, overBlocked }),
    ];
  },
};
