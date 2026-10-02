/**
 * 회귀: **정기 스케줄의 발화 턴이면 대화 컨텍스트가 그 사실을 말한다 — 발화 턴에만** (2026-10-02).
 *
 * 사고: 매일 08:10 GA 리포트 스케줄이 9/27 부터 6일 중 4일 «인증 파일을 읽어도 될까요» 를 물었다. 헌법 «홈 밖·위험 경로»
 * ④(등록한 스케줄이 실행마다 하는 일은 다시 묻지 않는다)는 모델이 «이게 스케줄 실행» 임을 알아야 성립하는데, 대화
 * 컨텍스트엔 세션 id 뿐이었다(실측: ④만 넣으면 6/8 물음 · 이 한 줄과 같이 넣으면 0/8 · 스케줄에 없는 삭제는 그대로 0회).
 *
 * ★반대 방향(적대 검토 2026-10-02): 처음엔 세션 id(`scheduler:<id>`)로 갈랐는데, 그 세션엔 스케줄이 띄운 매니저의
 *  **완료 턴**·선택지 답도 돈다(#18·#21 이 매일). 거기 붙으면 «지시문» 이 매니저 결과(외부 글일 수 있다)가 되고 ④ 면제가
 *  그 글에 적힌 자격 증명 경로까지 넓어진다. 그래서 표식은 발화임을 아는 쪽(스케줄 실행기)이 싣는 값으로만 붙는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatConversationContext } from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "schedule-run-is-named",
  guards: "정기 스케줄 실행인데 모델이 그걸 몰라 실행마다 다시 묻던 것 + 같은 세션의 발화 아닌 턴(매니저 완료·선택지 답)에 그 표식이 붙어 면제가 넓어지는 것",
  run: async (): Promise<Assertion[]> => {
    const firing = formatConversationContext({ channel: "scheduler", threadKey: "scheduler:19", scheduleRun: 19 });
    // 같은 세션에서 도는 발화 아닌 턴 — 매니저 완료 턴·선택지 답은 scheduleRun 을 안 싣는다.
    const sameThread = formatConversationContext({ channel: "scheduler", threadKey: "scheduler:19" });
    const chat = formatConversationContext({ channel: "telegram", threadKey: "tg:12345" });
    // ★어댑터 셋이 입력을 **통째로** 넘기는가 — 필드를 골라 넘기면 새 필드가 한 어댑터에서 조용히 빠진다.
    const adapters = ["claude-agent-sdk.ts", "openai-codex-oauth.ts", "openai-agents-sdk.ts"].map((f) => {
      const src = fs.readFileSync(path.join(repo, "src/core/llm-runtime/adapters", f), "utf8");
      return { f, whole: /formatConversationContext\(input\)/.test(src) };
    });
    return [
      assert("★발화 턴(scheduleRun)이면 «등록된 정기 스케줄(#id)의 실행» 을 말한다", firing.includes("정기 스케줄(#19)의 실행"), firing),
      assert("★같은 scheduler:<id> 세션이라도 발화가 아닌 턴엔 붙이지 않는다(완료 턴·선택지 답)", !sameThread.includes("정기 스케줄"), sameThread),
      assert("일반 대화엔 붙이지 않는다", !chat.includes("정기 스케줄"), chat),
      assert("세 어댑터가 대화 컨텍스트에 턴 입력을 통째로 넘긴다", adapters.every((a) => a.whole), adapters),
    ];
  },
};
