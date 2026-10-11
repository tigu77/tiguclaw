/**
 * 회귀: **이름 없이 띄운 서브에이전트 카드는 제목만** (2026-10-10 정태님 — «에이전트가 따로 지정되지 않았으면 저 부분은 그냥 비워도»).
 *
 * 카드 제목이 `🤖 subagent(mid) · B2 구현` 이었다 — `subagent(<등급>)` 은 서버가 이름 없는 즉석 서브에이전트에 붙이는 자리표시이고,
 *  등급은 옆 배지(`mid`)가 이미 보인다. 같은 말을 두 번 했다.
 *
 * 지키는 것(실제 `background-drawer.js` 의 `ensureJobCard`):
 *  ① 즉석(`subagent(…)`) + 제목 → 제목만
 *  ② 이름 있는 에이전트 + 제목 → 종전대로 «이름 · 제목»(deep 셋을 동시에 띄웠을 때 가르는 재료)
 *  ③ 즉석인데 제목이 없으면 그 이름이라도 보인다(빈 카드 X)
 *  ④ 서버가 그 자리표시를 정말 그 모양으로 만든다 — 모양이 바뀌면 화면 판정이 조용히 죽는다(이음매)
 *
 * 등급: **동작**(미니 DOM) + 이음매 대조.
 */
import { readFileSync } from "node:fs";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

export const check: RegressionCheck = {
  name: "bg-adhoc-agent-title",
  guards: "이름 없이 띄운 서브에이전트 카드가 «subagent(mid) · 제목» 으로 등급을 배지와 이름 칸에 두 번 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "virtualization.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    const label = (id: string, opts: Record<string, unknown>): string => {
      dash.run(`ensureJobCard(${JSON.stringify(id)}, ${JSON.stringify({ threadKey: "dashboard:default", kind: "agent", ...opts })})`);
      return String(dash.run(`jobCards.get(${JSON.stringify(id)}).label`));
    };
    const adhoc = label("a1", { agentName: "subagent(mid)", label: "B2 공통 레이아웃 구현", modelTier: "mid" });
    const named = label("a2", { agentName: "explore", label: "로그 조사", modelTier: "low" });
    const bare = label("a3", { agentName: "subagent(mid)", modelTier: "mid" });
    const subNamed = label("a4", { agentName: "subtask-runner", label: "정리", modelTier: "low" });
    const registry = readFileSync("src/core/llm-runtime/capabilities/agent-registry.ts", "utf8");
    return [
      assert("★① 이름 없이 띄운 서브에이전트 + 제목 → 제목만(등급은 배지가 보인다)", adhoc.includes("B2 공통 레이아웃 구현") && !adhoc.includes("subagent("), adhoc),
      assert("② 이름 있는 에이전트 + 제목 → «이름 · 제목» 그대로(sub 로 시작하는 이름도)", named.includes("explore · 로그 조사") && subNamed.includes("subtask-runner · 정리"), { named, subNamed }),
      assert("③ 제목이 없으면 자리표시 이름이라도 보인다(빈 카드 X)", bare.includes("subagent(mid)"), bare),
      assert(
        "④ 서버가 이름 없는 서브에이전트에 `subagent(<등급>)` 을 붙인다 — 화면 판정과 같은 모양",
        /agentName \?\? `subagent\(\$\{tier \?\? "default"\}\)`/.test(registry),
        (registry.match(/const shownName = [^\n]+/) ?? ["(shownName 없음)"])[0],
      ),
    ];
  },
};

export default check;
