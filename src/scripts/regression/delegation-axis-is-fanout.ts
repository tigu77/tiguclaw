/**
 * 회귀: **위임 선택 기준이 «기다림» 이 아니라 «팬아웃» 이다** (2026-09-03).
 *
 * ★배경. 종전엔 `spawn_agent` 과 `run_in_background` 를 «결과를 이번 답변 안에서 쓰나»
 *  로 갈랐다. 그런데 `spawn_agent` 의 `wait` 인자를 없애 **둘 다 즉시 jobId 를 돌려주게**
 *  되면서 그 축이 사라졌다 — 그리고 매니저 설명엔 *"결과를 이번 답변 안에서 써야 하면
 *  어려워도 spawn_agent"* 라는 **이제 거짓인 문장**이 남아 있었다.
 *
 * ★프롬프트의 낡은 문장은 **틀린 문장이 아니라 틀린 행동**이 된다 — 비서는 그 말을 그대로
 *  사용자에게 옮긴다. 그리고 프롬프트 변경은 **효과가 조용히** 나타나 다음 사고 때에야
 *  드러나므로, 지운 것을 회귀로 못박는다(안 그러면 다음 편집이 되살린다).
 *
 * 남은 진짜 축은 **«자식을 또 나눠 붙여야 하나»** 다. 이건 취향이 아니라 **능력 차이**다:
 * `capability-reach.ts` 가 `agents: "manager"` 로 정해서, 서브에이전트 턴엔 `spawn_agent`
 * 이 **아예 등록되지 않는다**(에이전트는 재위임 불가, 매니저는 가능).
 *
 * 등급: **판정**(설명 문구) + **동작**(도달 표를 실제로 호출).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reaches } from "../../core/llm-runtime/capability-reach.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (f: string): string =>
  readFileSync(path.join(REPO, "src/core/llm-runtime/capabilities", f), "utf8");

export const check: RegressionCheck = {
  name: "delegation-axis-is-fanout",
  guards:
    "위임 도구 설명이 «결과를 이번 답변 안에서 쓰나» 로 선택을 안내하던 것 — wait 인자를 없애 둘 다 즉시 jobId 를 돌려주게 되면서 그 문장이 거짓이 됐다(프롬프트의 낡은 문장은 틀린 행동이 된다). 남은 진짜 축은 «자식을 또 나눠 붙여야 하나» 이고 그건 능력 차이다 (2026-09-03)",
  run: async (): Promise<Assertion[]> => {
    const worker = read("worker-registry.ts");
    const agent = read("agent-registry.ts");
    const STALE = [
      "결과를 이번 답변 안에서",
      "결과를 *이번 답변 안에서*",
      "매니저를 기다리지 마세요",
    ];
    const staleHits = STALE.filter((t) => worker.includes(t) || agent.includes(t));

    return [
      assert(
        "★★이제 거짓인 선택 기준이 **되살아나지 않았다** — `spawn_agent` 은 결과를 답변 안에서 주지 않는다",
        staleHits.length === 0,
        staleHits.length === 0 ? "낡은 문구 0" : `★남음: ${staleHits.join(" / ")}`,
      ),
      assert(
        "★★매니저 설명이 **팬아웃 축**으로 고른다 — 축이 없으면 모델은 기본값처럼 한쪽으로 흐른다",
        /자식을 또 나눠 붙여야 하나/.test(worker) &&
          /매니저만 `spawn_agent` 으로 자기 자식을 붙일 수 있습니다/.test(worker),
        /자식을 또 나눠 붙여야 하나/.test(worker) ? "축 명시" : "★축 없음",
      ),
      assert(
        "★★매니저 설명이 **헌법을 정본으로 가리킨다** — 개수 판정(2명)을 여기 베껴 적으면 두 벌이 되어 갈린다",
        /서브에이전트가 2명 이상 필요하면 매니저/.test(worker) &&
          /작동 컨텍스트의 위임 규칙이 정본/.test(worker),
        /위임 규칙이 정본/.test(worker) ? "정본 포인터 있음" : "★포인터 없음 — 두 벌이 갈린다",
      ),
      assert(
        "★두 설명이 **합류 도구를 가리킨다** — 안 가리키면 결과를 받는 법을 모른다",
        /wait_for_worker/.test(worker) && /wait_for_worker/.test(agent),
        `매니저=${String(/wait_for_worker/.test(worker))} · 에이전트=${String(/wait_for_worker/.test(agent))}`,
      ),
      assert(
        "★★그 축이 **말이 아니라 실제 능력 차이**다 — 매니저 턴엔 `agents` 가 닿고 서브에이전트 턴엔 안 닿는다",
        reaches("agents", "manager") && !reaches("agents", "subagent"),
        `manager=${String(reaches("agents", "manager"))} · subagent=${String(reaches("agents", "subagent"))}`,
      ),
      // ★★**불변식: 띄울 수 있으면 거둘 수 있어야 한다** (2026-09-03, 정태님 지적).
      //  `wait_for_worker` 를 처음엔 `worker-registry` 에 뒀는데 그 서버는 `workers:"main"`
      //  이라 **매니저가 못 닿는다** — 그런데 매니저는 `agents:"manager"` 로 자식을 띄운다.
      //  `spawn_agent` 이 항상 비동기가 된 뒤라, 매니저는 «넷을 띄워놓고 기다릴 수단이 자기
      //  턴에 없는» 상태였다. 소환과 합류는 **같은 서버**에 둬야 이 불변식이 구조로 지켜진다.
      (() => {
        // 합류 도구가 **실제로 실린 서버**를 찾아, 그 서버의 도달 범위로 «거둘 수 있나» 를 정한다.
        // ★항진식을 쓰지 않는다 — `!x || x` 는 무엇을 옮겨도 초록이라 검사가 아니다.
        const inAgents = /tools:\s*\[[^\]]*waitForWorker/.test(agent);
        const inWorkers = /tools:\s*\[[^\]]*waitForWorker/.test(worker);
        const joinCap = inAgents ? ("agents" as const) : inWorkers ? ("workers" as const) : undefined;
        const broken = (["main", "manager", "subagent"] as const).filter(
          (t) => reaches("agents", t) && (joinCap === undefined || !reaches(joinCap, t)),
        );
        return assert(
          "★★★띄울 수 있는 턴은 **거둘 수도 있다** — 합류이 소환보다 좁은 서버에 있으면 «띄웠는데 못 거두는» 턴이 생긴다",
          joinCap !== undefined && broken.length === 0,
          joinCap === undefined
            ? "★합류 도구가 어느 서버에도 안 실렸다"
            : `합류=${joinCap} 서버 · 못 거두는 턴: ${broken.join(", ") || "없음"}`,
        );
      })(),
      assert(
        "★매니저가 매니저를 못 띄운다 — 무한 팬아웃 차단(이 축의 반대쪽 끝)",
        !reaches("workers", "manager") && reaches("workers", "main"),
        `manager=${String(reaches("workers", "manager"))} · main=${String(reaches("workers", "main"))}`,
      ),
    ];
  },
};
