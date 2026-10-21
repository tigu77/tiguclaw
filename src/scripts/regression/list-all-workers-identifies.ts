/**
 * 회귀: **전체 작업 목록이 작업을 지목할 재료를 준다** (2026-10-20 회사돌쇠 전달본 P2).
 *
 * 사고: 감시 대화(`file-watch:3`)가 띄운 매니저를 원래 대화의 비서가 멈추려다 이름 지목이 거절됐다(이름은 이 대화 안에서만 — 동명 보호).
 *  그런데 `list_all_workers` 는 이름·상태·경과·«이 대화/다른 대화» 만 보여, 다른 대화의 작업을 정확히 가리킬 id 가 화면에 없었다.
 * 지키는 것: 줄마다 id·속한 대화·부모가 실리고, 이름 지목은 여전히 이 대화 안에서만이다(id 를 보여 준다고 이름 보호가 풀리지 않는다).
 */
import { createWorkerMcpServer } from "../../core/llm-runtime/capabilities/worker-registry.js";
import { __resetJobsForTest, getJob, registerJob } from "../../core/worker-jobs.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Tools = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content?: { text?: string }[]; isError?: boolean }> }>;
const toolsOf = (threadKey: string): Tools =>
  (createWorkerMcpServer({ text: "x", channel: "http-bridge", threadKey } as never).instance as unknown as { _registeredTools: Tools })._registeredTools;
const textOf = (r: { content?: { text?: string }[] }): string => (r.content ?? []).map((c) => c.text ?? "").join("\n");

export const check: RegressionCheck = {
  name: "list-all-workers-identifies",
  guards: "전체 작업 목록에 id·속한 대화·부모가 없어 다른 대화(감시 대화 등)의 작업을 정확히 지목할 재료가 없던 것(회사돌쇠 10-20)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    try {
      const parent = registerJob({ label: "감시 매니저", task: "검수", threadKey: "file-watch:3", channel: "file-watch" as never, channelUserId: "u", detached: true });
      const child = registerJob({ label: "감시 자식", task: "세부", threadKey: `worker:${parent}`, channel: "file-watch" as never, channelUserId: "u", detached: true });
      const mine = registerJob({ label: "내 작업", task: "이 대화 일", threadKey: "dashboard:rpg", channel: "http-bridge" as never, channelUserId: "u", detached: true });
      const tools = toolsOf("dashboard:rpg");
      const all = textOf(await tools.list_all_workers!.handler({}, {}));
      const childLine = all.split("\n").find((l) => l.includes("'감시 자식'")) ?? "";
      const parentLine = all.split("\n").find((l) => l.includes("'감시 매니저'")) ?? "";
      const mineLine = all.split("\n").find((l) => l.includes("'내 작업'")) ?? "";
      const byName = await tools.cancel_worker!.handler({ label: "감시 매니저" }, {});
      return [
        assert(
          "★★줄마다 작업 id·속한 대화가 실린다 — 다른 대화(감시) 작업도 정확히 가리킬 수 있다",
          parentLine.includes(`\`${parent}\``) && parentLine.includes("`file-watch:3`") && parentLine.includes("다른 대화") &&
            mineLine.includes(`\`${mine}\``) && mineLine.includes("이 대화"),
          JSON.stringify({ parentLine, mineLine }),
        ),
        assert(
          "★하위 작업은 부모(이름·id)가 붙고, 속한 대화는 **맨 위 소유**(감시 대화)다 — 멈추면 무엇이 같이 멈추는지 보인다",
          childLine.includes(`\`${child}\``) && childLine.includes(`부모 '감시 매니저'(\`${parent}\`)`) && childLine.includes("`file-watch:3`"),
          childLine,
        ),
        assert(
          "★id 를 보여 줘도 **이름 지목은 이 대화 안에서만** — 다른 대화의 동명 작업을 이름으로 못 멈춘다",
          getJob(parent)?.status === "running" && /취소하지 않았습니다|찾지 못/.test(textOf(byName)),
          `상태 ${getJob(parent)?.status} · ${textOf(byName).slice(0, 120)}`,
        ),
      ];
    } finally {
      __resetJobsForTest();
    }
  },
};
