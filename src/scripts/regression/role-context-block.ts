/**
 * 회귀: **역할 표시가 맞는 자리에, 맞는 값으로 실린다** (2026-08-21).
 *
 * 사고: 메인·매니저·서브에이전트가 **같은 헌법을 받는데 아무도 자기가 누군지 몰랐다.**
 * 헌법엔 역할 조건절이 있는데("이 판정은 메인 턴에만 적용된다") 읽는 쪽이 자기가 어느
 * 쪽인지 모르니 조건이 풀리지 않았다. 그 결과 매 턴 넛지가 **매니저에게 "매니저를
 * 소환하라"** 고 말하고 있었다 — 매니저 안엔 `run_in_background` 가 등록조차 안 되는데.
 *
 * 지키는 것 넷:
 *  ①메인은 **바이트가 안 변한다** — 역할 슬롯이 비어 걸러진다(기존 캐시 무영향)
 *  ②매니저/서브가 각자 자기 역할을 받고, 서로 다르다
 *  ③자리는 **시스템 채널의 맨 끝** — 앞에 두면 뒤따르는 전부가 역할별로 갈린다
 *  ④매니저 안의 서브에이전트는 **서브**다(둘 다 >0 일 때 정체는 서브)
 */
import {
  buildContextSlots,
  roleContextBlock,
  splitSystemContext,
} from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const base = {
  system: "SYS",
  env: "ENV",
  agent: "AGENT",
  agentWarn: "",
  convoContext: "CONVO",
  memoryIndex: "MEM",
  memorySnippet: "SNIP",
  skillIndex: "SKILL",
  agentIndex: "AGENTS",
};

export const check: RegressionCheck = {
  name: "role-context-block",
  guards:
    "매니저·서브에이전트가 자기 역할을 몰라 메인용 지침(없는 도구를 쓰라는 것)을 자기 것으로 읽던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const main = roleContextBlock({});
    const manager = roleContextBlock({ workerDepth: 1 });
    const sub = roleContextBlock({ subagentDepth: 1 });
    const subInManager = roleContextBlock({ workerDepth: 1, subagentDepth: 1 });

    // ① 메인은 빈 값 — 슬롯이 걸러져 기존 바이트가 그대로다.
    const mainStable = splitSystemContext({ ...base }).stable;
    const mainStableExplicitEmpty = splitSystemContext({ ...base, role: "" }).stable;
    out.push(
      assert(
        "★메인은 역할 문구가 없다 — 기존 시스템 채널 바이트가 그대로(캐시 무영향)",
        main === "" && mainStable === mainStableExplicitEmpty,
        `main="${main}" 동일=${mainStable === mainStableExplicitEmpty}`,
      ),
    );

    // ② 매니저·서브가 각자 자기 것을 받고 서로 다르다.
    out.push(
      assert(
        "★매니저·서브에이전트가 서로 다른 역할 문구를 받는다",
        manager !== "" && sub !== "" && manager !== sub,
        `manager=${manager.length}자 sub=${sub.length}자 다름=${manager !== sub}`,
      ),
    );

    // 매니저는 **직접 팬아웃**하라고 듣는다(메인용 "매니저에게 넘겨라" 가 아니라).
    out.push(
      assert(
        "★매니저는 spawn_agent 로 직접 팬아웃하라고 듣는다(없는 도구를 권하지 않는다)",
        manager.includes("spawn_agent") &&
          manager.includes("run_in_background") &&
          !sub.includes("spawn_agent"),
        `매니저에 spawn_agent=${manager.includes("spawn_agent")} · 서브엔 없음=${!sub.includes("spawn_agent")}`,
      ),
    );

    // ④ 매니저 안의 서브에이전트는 서브다.
    out.push(
      assert(
        "★매니저 안에서 띄운 서브에이전트의 정체는 '서브'다(둘 다 >0 일 때)",
        subInManager === sub,
        subInManager === sub ? "서브로 판정" : "★매니저로 오판",
      ),
    );

    // ③ 자리 — 시스템 채널의 **맨 끝**.
    const slots = buildContextSlots({ ...base, role: "ROLE" });
    const sys = slots.filter((s) => s.channel === "system");
    const last = sys[sys.length - 1];
    out.push(
      assert(
        "★역할 슬롯은 시스템 채널의 맨 끝이다(앞에 두면 뒤따르는 전부가 역할별로 갈린다)",
        last !== undefined && last.key === "role",
        `마지막 시스템 슬롯=${last?.key ?? "(없음)"}`,
      ),
    );
    out.push(
      assert(
        "역할은 system 채널이다 — 대화 내내 안 변하므로 user 채널이면 매 턴 재전송이다",
        slots.find((s) => s.key === "role")?.channel === "system",
        `channel=${slots.find((s) => s.key === "role")?.channel}`,
      ),
    );

    // 역할 문구가 헌법을 재진술하지 않는다 — 그러면 그게 곧 "헌법 세 벌"이다.
    const restated = ["안전선", "승인", "정직", "검증"].filter(
      (w) => manager.includes(w) || sub.includes(w),
    );
    out.push(
      assert(
        "★역할 문구가 헌법을 재진술하지 않는다(그 역할이 실제로 다른 점만 적는다)",
        restated.length === 0,
        restated.length === 0 ? "재진술 0" : `★재진술: ${restated.join(", ")}`,
      ),
    );
    return out;
  },
};
