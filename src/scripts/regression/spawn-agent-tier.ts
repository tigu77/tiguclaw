/**
 * 회귀: **서브에이전트는 이름 = 역할, 등급 = 모델** (2026-10-03 정태님).
 *
 * 기본 범용 명세(deep·general·quick·explore)는 «모델 등급 + 일반론» 이라 모델 프로필과 같은 선택을 두 이름 체계로
 * 했다. 그래서 뺐고 `spawn_agent` 가 `tier` 를 받는다(매니저와 같은 모양). 실제 처리기를 불러 잰다:
 *  - 이름 없이 tier → 즉석 서브에이전트가 그 등급으로 · 아무것도 없으면 기본 등급
 *  - 명세 + tier → 역할은 명세, 모델은 tier 가 덮는다 · 명세만 → 명세의 모델
 *  - 모르는 이름(옛 기본 명세 포함) → 등급으로 몰래 바꾸지 않고 «tier 로 띄우라» 를 돌려준다
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpawnAgentMcpServer } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { createWorkerMcpServer } from "../../core/llm-runtime/capabilities/worker-registry.js";
import { __resetJobsForTest, cancelJob, getJob } from "../../core/worker-jobs.js";
import { __setAdapterForTest, resolveModelChain } from "../../core/llm-runtime/index.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type ToolReg = { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };

export const check: RegressionCheck = {
  name: "spawn-agent-tier",
  guards: "서브에이전트를 띄우려면 명세 이름을 꼭 골라야 해서 등급 선택이 이름 체계로 겹치던 것 — 지정·미지정·덮어쓰기·모르는 이름이 각자 맞게 도는가",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tc-spawn-tier-"));
    fs.mkdirSync(path.join(proj, ".tiguclaw", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".tiguclaw", "agents", "roleful.md"),
      "---\nname: roleful\ndescription: 회귀용 역할 명세\nmodel: codex:regr-low\ntools: Read\n---\n\n너는 회귀용 역할이다.\n",
    );
    const srv = createSpawnAgentMcpServer({ channel: "cli", threadKey: "regr:spawn-tier", cwd: proj, text: "" } as never) as unknown as {
      instance: { _registeredTools: Record<string, ToolReg> };
    };
    const spawn = Object.entries(srv.instance._registeredTools).find(([k]) => /spawn/.test(k))?.[1];
    const textOf = (r: { content: Array<{ text?: string }> }): string => r.content.map((c) => c.text ?? "").join("");
    const jobOf = (t: string): ReturnType<typeof getJob> => getJob(/jobId=([0-9a-f-]+)/.exec(t)?.[1] ?? "");
    // ★자식이 **실제로 받는 모델**까지 잰다(적대 검토 G1 — 카드엔 high 가 보이는데 자식은 명세의 low 로 도는 변이가 살아남았다).
    //  어댑터 호출을 가로채 자식 스레드(agent:<jobId>)가 받은 모델을 적는다. 모델 호출은 없다.
    const childModel = new Map<string, string>();
    const restore = __setAdapterForTest(async (_adapter, input) => {
      childModel.set(input.threadKey, String(input.model ?? ""));
      return { text: "ok" };
    });
    const ran: string[] = [];
    const call = async (args: Record<string, unknown>, n: number): Promise<{ text: string; err: boolean; tier?: string; name?: string; jobId?: string }> => {
      const r = await spawn!.handler({ prompt: `회귀 작업 ${n}`, ...args }, {});
      const text = textOf(r);
      const j = jobOf(text);
      if (j !== undefined) ran.push(j.jobId);
      return { text, err: r.isError === true, ...(j?.modelTier !== undefined ? { tier: j.modelTier } : {}), ...(j?.agentName !== undefined ? { name: j.agentName } : {}), ...(j !== undefined ? { jobId: j.jobId } : {}) };
    };
    let res: Record<string, Awaited<ReturnType<typeof call>>> = {};
    try {
      res = {
        tierOnly: await call({ tier: "codex:regr-mid" }, 1),
        nothing: await call({}, 2),
        specAndTier: await call({ name: "roleful", tier: "codex:regr-high" }, 3),
        specOnly: await call({ name: "roleful" }, 4),
        oldBuiltin: await call({ name: "deep" }, 5),
        habit: await call({ subagent_type: "Explore" }, 6),
        modelAlias: await call({ model: "codex:regr-high" }, 7),
        // 풀리지 않는 등급(Claude Code 습관 `sonnet`·없는 프로필) — 조용히 기본 모델로 돌리지 않고 거절한다(명세 모델도 안 덮는다).
        badAlias: await call({ name: "roleful", model: "sonnet" }, 8),
        badTier: await call({ tier: "no-such-profile" }, 9),
      };
      // 자식들이 어댑터에 닿을 때까지(최대 3초)
      for (let i = 0; i < 60 && ran.some((id) => !childModel.has(`agent:${id}`)); i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      restore();
      for (const id of ran) cancelJob(id);
      fs.rmSync(proj, { recursive: true, force: true });
    }
    // 프로필이 격리 홈에선 실제 모델로 안 풀리므로 provider:model 직접 지정으로 잰다 — 해석은 제품의 resolveModelChain 그대로.
    const firstModel = (tier: string): string => String(resolveModelChain(tier)?.[0]?.[0]?.model ?? "?");
    const got = (k: string): string => childModel.get(`agent:${res[k]?.jobId ?? ""}`) ?? "(안 닿음)";
    const models = { specAndTier: got("specAndTier"), specOnly: got("specOnly"), modelAlias: got("modelAlias"), high: firstModel("codex:regr-high"), low: firstModel("codex:regr-low") };
    // 매니저도 같은 판정 — 두 도구의 등급 의미가 갈리지 않게.
    const wsrv = createWorkerMcpServer({ channel: "cli", threadKey: "regr:spawn-tier", cwd: os.tmpdir(), text: "" } as never) as unknown as {
      instance: { _registeredTools: Record<string, ToolReg> };
    };
    const runBg = wsrv.instance._registeredTools["run_in_background"];
    const mgrBad = runBg === undefined ? undefined : await runBg.handler({ label: "회귀", task: "회귀 매니저", tier: "sonnet" }, {});
    const refused = (r: { text: string; err: boolean } | undefined): boolean => r !== undefined && r.err && /모델로 풀 수 없습니다/.test(r.text) && !/jobId=/.test(r.text);
    const hinted = (r: { text: string; err: boolean }): boolean => r.err && /명세가 없습니다/.test(r.text) && /tier/.test(r.text) && /roleful/.test(r.text);
    return [
      assert("spawn_agent 처리기를 찾았다", spawn !== undefined, Object.keys(srv.instance._registeredTools)),
      assert("★이름 없이 tier → 즉석 서브에이전트가 그 등급으로(잡 이름이 등급을 보인다) · 아무것도 없으면 기본 등급", !res.tierOnly?.err && res.tierOnly?.tier === "codex:regr-mid" && res.tierOnly?.name === "subagent(codex:regr-mid)" && !res.nothing?.err && res.nothing?.tier === "default", { tierOnly: res.tierOnly, nothing: res.nothing }),
      assert("★명세 + tier → 모델은 tier 가 덮는다 · 명세만 → 명세의 모델", res.specAndTier?.tier === "codex:regr-high" && res.specAndTier?.name === "roleful" && res.specOnly?.tier === "codex:regr-low", { specAndTier: res.specAndTier, specOnly: res.specOnly }),
      assert(
        "★자식이 **실제로** 그 등급의 모델로 돈다 — 명세+tier 는 tier 쪽 · 명세만은 명세 쪽 · 둘이 다르다",
        models.high !== models.low && models.specAndTier === models.high && models.specOnly === models.low,
        models,
      ),
      assert("★`model` 로 불러도(Claude Code 습관·옛 안내) 조용히 기본으로 떨어지지 않고 tier 로 받는다", res.modelAlias?.tier === "codex:regr-high" && models.modelAlias === models.high, { modelAlias: res.modelAlias, model: models.modelAlias }),
      assert(
        "★풀리지 않는 등급은 거절한다 — `model:\"sonnet\"`(명세 모델을 기본으로 덮던 것) · 없는 프로필 · 매니저도 같다",
        refused(res.badAlias) && refused(res.badTier) && mgrBad !== undefined && mgrBad.isError === true && /모델로 풀 수 없습니다/.test(textOf(mgrBad)),
        { badAlias: res.badAlias?.text, badTier: res.badTier?.text, manager: mgrBad === undefined ? "(도구 없음)" : textOf(mgrBad) },
      ),
      assert("★모르는 이름(옛 기본 명세 `deep` · 습관 `Explore`)은 등급으로 몰래 바꾸지 않고 «tier 로 띄우라» + 있는 명세 이름을 돌려준다", hinted(res.oldBuiltin!) && hinted(res.habit!), { oldBuiltin: res.oldBuiltin, habit: res.habit }),
    ];
  },
};
