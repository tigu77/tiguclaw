/**
 * 회귀: **서브에이전트 도구 이름이 바뀌어도 관측이 안 죽는다** (2026-08-07 사용자 신고).
 *
 * 사고: 대시보드 백그라운드 패널의 "매니저/에이전트" 가 **항상 0** 이었다. 사용자가
 * "에이전트가 대시보드에 안 뜬다" 고 신고했고, 실측(24시간 실트래픽)에서 갈렸다 —
 * 서브에이전트 도구가 **`Agent` 로 14회** 호출됐는데 우리 코드는 전부 **`"Task"`** 를
 * 찾고 있었다. Claude SDK 0.3 이 그 도구를 개명했고 우리는 옛 이름에 남았다.
 *
 * ★같은 이름이 **네 곳**에 하드코딩돼 있었고 넷 다 조용히 죽었다:
 *  ①잡 등록 → 패널이 빈다  ②느림 경고 완화 → 정상 위임에 3분마다 "멈춤 의심"
 *  ③**하드 타임아웃 면제** → ★전날 넣은 13분 컷이 **정상 서브에이전트를 죽일 수 있었다**
 *  ④대시보드 잡카드 링크 → 스텝에서 드로어로 점프 불가
 *
 * ★부류: 상류가 계약을 바꿨는데 우리 소비가 옛 가정에 머문 것 — `sdk-turn-boundary`(result
 *  의미 변경)·usage 스냅샷과 **같은 업그레이드에서 세 번째**다. 앞의 둘은 메시지 *타입*이라
 *  `sdk-contract-surface` 가 잡지만, 이건 **도구 이름**이라 그 그물에 안 걸린다(정직하게
 *  적어둔다 — 그 게이트를 만능으로 읽으면 안 된다).
 *
 * 그래서 검사는 두 가지를 못 박는다: (a) 판정이 두 이름을 다 받는다 (b) **소비처가 이름을
 * 직접 열거하지 않는다** — (b) 가 없으면 다섯 번째 곳이 또 생긴다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "subagent-tool-naming",
  guards:
    "SDK 가 서브에이전트 도구를 개명(Task→Agent)하자 잡 등록·경고완화·하드컷면제·잡카드링크가 한꺼번에 죽던 것",
  run: async (): Promise<Assertion[]> => {
    const { isSubagentTool, isLongRunningByDesign, isSdkSubagentTool } = await import(
      "../../core/llm-runtime/subagent-tools.js"
    );
    const { toolSlowWarnMs } = await import("../../core/llm-runtime/tool-watchdog.js");
    const { shouldNotifyToolSlow } = await import("../../core/worker-jobs.js");

    // (a) 판정 — 신·구 이름과 우리 도구를 다 받고, 무관한 도구는 안 받는다.
    const accepts = ["Agent", "Task", "spawn_agent"].every(isSubagentTool);
    const rejects = ["Bash", "Read", "Edit", "WebSearch", ""].every(
      (t) => !isSubagentTool(t),
    );

    // (b) 소비처가 판정을 **실제로** 쓰는가 — 동작으로 본다.
    const warnSame =
      toolSlowWarnMs("Agent") === toolSlowWarnMs("spawn_agent") &&
      toolSlowWarnMs("Agent") > toolSlowWarnMs("Bash");
    const pushSuppressed =
      !shouldNotifyToolSlow("Agent") &&
      !shouldNotifyToolSlow("spawn_agent") &&
      shouldNotifyToolSlow("Bash");
    const hardExempt = isLongRunningByDesign("Agent");

    // (c) ★이름을 다시 열거하지 않는다 — 소비처에 리터럴이 **되살아나는 것 자체**를 막는다.
    //  존재 검사(sourceHas)만으로는 약하다: 판정 호출이 한 군데라도 남아 있으면 다른 곳이
    //  리터럴로 되돌아가도 초록이다(이 검사의 첫 판이 실제로 그 변이를 놓쳤다).
    const { readFile } = await import("node:fs/promises");
    const LITERAL = /toolName === "(Task|Agent)"|tool === "(Task|Agent)"|tool !== "(Task|Agent)"/;
    const literalIn: string[] = [];
    for (const rel of [
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      "../../core/llm-runtime/tool-watchdog.ts",
      "../../core/worker-jobs.ts",
    ]) {
      const url = new URL(rel, import.meta.url);
      const body = await readFile(url, "utf8");
      // 주석 줄은 제외 — 사고 경위를 설명하는 글까지 세면 문서를 못 쓴다(마크업 vs 설명).
      const code = body
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      if (LITERAL.test(code)) literalIn.push(rel.split("/").pop() ?? rel);
    }

    const adapter = await sourceHas(
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      [/isSdkSubagentTool\(toolName\)/],
    );
    const watchdog = await sourceHas("../../core/llm-runtime/tool-watchdog.ts", [
      /isLongRunningByDesign\(tool\)/,
    ]);
    const jobs = await sourceHas("../../core/worker-jobs.ts", [
      /!isSubagentTool\(tool\)/,
    ]);

    return [
      assert(
        "★판정이 신·구 이름을 다 받는다(설치본마다 SDK 버전이 다르다)",
        accepts && rejects,
        `accepts=${accepts} rejects=${rejects}`,
      ),
      assert(
        "★잡 등록이 판정을 쓴다(이 한 줄이 죽어 패널이 항상 0이었다)",
        adapter.ok,
        adapter.ok ? "claude-agent-sdk.ts" : `누락: ${adapter.missing.join(" / ")}`,
      ),
      assert(
        "★하드 타임아웃 면제가 새 이름에도 걸린다(13분 컷이 정상 위임을 죽이던 창)",
        hardExempt && watchdog.ok,
        `exempt=${hardExempt} 배선=${watchdog.ok}`,
      ),
      assert(
        "느림 경고 임계가 서브에이전트에 완화된다(Bash 보다 큼)",
        warnSame,
        `Agent=${toolSlowWarnMs("Agent")} spawn_agent=${toolSlowWarnMs("spawn_agent")} Bash=${toolSlowWarnMs("Bash")}`,
      ),
      assert(
        "서브에이전트 지연은 채널로 푸시하지 않는다(드로어에 스텝이 보인다)",
        pushSuppressed && jobs.ok,
        `억제=${pushSuppressed} 배선=${jobs.ok}`,
      ),
      assert(
        "★소비처가 도구 이름을 직접 열거하지 않는다(다섯 번째 곳이 생기지 않게)",
        literalIn.length === 0,
        literalIn.length === 0 ? "리터럴 0" : `리터럴 부활: ${literalIn.join(", ")}`,
      ),
      assert(
        "★`spawn_agent` 은 **SDK 빌트인이 아니다** — 어댑터 관측 잡 등록에서 빠져야 한다",
        !isSdkSubagentTool("spawn_agent") &&
          isSdkSubagentTool("Agent") &&
          isSdkSubagentTool("Task") &&
          isSubagentTool("spawn_agent"),
        `sdk(spawn_agent)=${isSdkSubagentTool("spawn_agent")} sdk(Agent)=${isSdkSubagentTool("Agent")} long(spawn_agent)=${isSubagentTool("spawn_agent")}`,
      ),
      assert(
        "★어댑터의 잡 등록은 SDK 판정을 쓴다(넓은 판정을 쓰면 우리 spawn_agent 이 스텝 0으로 오인된다)",
        (await sourceHas("../../core/llm-runtime/adapters/claude-agent-sdk.ts", [
          /isSdkSubagentTool\(toolName\)/,
        ])).ok &&
          !(await sourceHas("../../core/llm-runtime/adapters/claude-agent-sdk.ts", [
            /[^d]isSubagentTool\(toolName\)/,
          ])).ok,
        "claude-agent-sdk.ts",
      ),
      assert(
        "대시보드 잡카드 링크도 새 이름을 받는다",
        (await sourceHas("../../../packages/dashboard/js/virtualization.js", [
          /spawnLabel === "Agent"/,
        ])).ok,
        "virtualization.js",
      ),
    ];
  },
};
