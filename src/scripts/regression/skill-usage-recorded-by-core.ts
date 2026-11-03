/**
 * 회귀: **스킬 사용 횟수(`skill_usage`)는 코어가 적는다 — 자가성장 플러그인이 꺼져 있어도** (2026-10-15 릴리스 적대 검토 F2).
 *
 * 사고: 횟수는 자가성장 플러그인이 `skill.invoked` 를 받아 적고 있었다. v0.71.0 에서 그 플러그인을 기본 꺼짐으로 바꾸자
 *  새 설치·업데이트에서 기록이 통째로 멈췄다 — 스킬 인덱스 사용빈도 순서와 `find_skills` 랭킹이 이 표를 읽는다.
 * ★2026-11-03: 그 플러그인을 뺐다 — «플러그인이 다시 적어 두 번 센다» 단언은 대상과 함께 지웠다(적는 곳은 코어 한 곳).
 *
 * 등급: **실행** — 러너의 격리 홈 DB 에 실제 `invoke_skill` 을 불러 행을 센다.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "skill-usage-recorded-by-core",
  guards: "스킬 사용 횟수를 플러그인이 적어 그 플러그인이 꺼지면 기록이 멈추고 스킬 인덱스·find_skills 의 사용빈도 순서가 굳던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { listSkillUsage } = await import("../../store/skill-usage.js");
    const { createSkillInvokeMcpServer } = await import("../../core/llm-runtime/capabilities/skill-registry.js");
    const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
    const count = (): number => listSkillUsage({ limit: 500 }).find((r) => r.skillName === "harness")?.invokeCount ?? 0;

    const before = count();
    const server = await adaptClaudeMcpServer(
      createSkillInvokeMcpServer(process.cwd(), { channel: "dashboard", threadKey: "regr-skill-usage", adapter: "claude" }),
      "regr-skill-usage",
    );
    await server.callTool("invoke_skill", { name: "harness" });
    await server.callTool("invoke_skill", { name: "harness" });
    const after = count();
    out.push(
      assert(
        "★★플러그인 없이 `invoke_skill` 두 번 → `skill_usage` 가 정확히 2 오른다(코어가 적는다 · 두 번 세지 않는다)",
        after - before === 2,
        `전=${before} 후=${after}`,
      ),
    );

    await server.callTool("invoke_skill", { name: "no-such-skill-regr" });
    const missing = listSkillUsage({ limit: 500 }).some((r) => r.skillName === "no-such-skill-regr");
    out.push(assert("없는 스킬 호출은 행을 만들지 않는다(성공 호출만 센다)", !missing, `없는 스킬 행=${String(missing)}`));

    return out;
  },
};
