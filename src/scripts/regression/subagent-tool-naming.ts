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

 * ─────────────────────────────────────────────────────────────────────────────
 * ★등급: **배선 린트** (2026-08-08 레드팀 결과 표시)
 *  이 파일의 단언 상당수는 **소스를 훑는다** — 코드가 그렇게 *쓰여 있는지*는 보지만
 *  그렇게 *동작하는지*는 못 본다. `if (false)`·env 게이트·조건 강화·동의어 치환으로
 *  전부 우회된다(레드팀이 13개 변이로 실증했고 7개를 동시에 넣어도 전 스위트 초록이었다).
 *  ★그러니 **우연한 드리프트는 잡지만 적은 못 막는다.** 행동을 지켜야 하는 축은 판정을
 *   순수 함수로 뽑아 **실행**해야 한다(`swallowed-failure.ts` 가 그 예).
 *  등급을 적어 두는 이유: 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다 —
 *  다음 사람이 "여긴 그물이 있다" 고 믿고 지나간다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "subagent-tool-naming",
  guards:
    "SDK 가 서브에이전트 도구를 개명(Task→Agent)하자 잡 등록·경고완화·하드컷면제·잡카드링크가 한꺼번에 죽던 것",
  run: async (): Promise<Assertion[]> => {
    const {
      isSubagentTool,
      isLongRunningByDesign,
      isSdkSubagentTool,
      withSdkSubagentsBlocked,
    } = await import(
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
    // ★임계 완화는 **없앴다** (2026-08-19 사용자 확정: "서브에이전트가 오래 걸리는 건
    //  당연한 거라 경고를 할 필요가 없지 — 이미 백그라운드 잡에서 뭘 하는지 보이잖아").
    //  종전 계약은 "서브에이전트는 더 늦게 경고" 였는데, 그건 경고가 **사용자에게 가던
    //  시절**의 완화책이다. 이제 서브에이전트 지연은 채널 푸시·화면 렌더 양쪽에서 빠졌으니
    //  임계로 달랠 대상이 없다. 그래서 지키는 것을 **임계에서 억제로** 옮긴다.
    const warnSingle =
      toolSlowWarnMs("Agent") === toolSlowWarnMs("Bash") &&
      toolSlowWarnMs("spawn_agent") === toolSlowWarnMs("Bash");
    // ★MCP 접두사가 붙어 와도 같아야 한다 — claude 만 벗겨 넘기고 codex·openai 는 원문을
    //  넘겨서, 접두사가 붙으면 억제·면제가 조용히 풀렸다(어댑터별 그물 차이 = 원칙 #2).
    const pushSuppressed =
      !shouldNotifyToolSlow("Agent") &&
      !shouldNotifyToolSlow("spawn_agent") &&
      !shouldNotifyToolSlow("mcp__agents__spawn_agent") &&
      shouldNotifyToolSlow("Bash") &&
      shouldNotifyToolSlow("mcp__file-ops__Bash");
    const hardExempt =
      isLongRunningByDesign("Agent") && isLongRunningByDesign("mcp__agents__spawn_agent");

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

    const adapterSrc = await readFile(
      new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url),
      "utf8",
    );

    return [
      assert(
        "★판정이 신·구 이름을 다 받는다(설치본마다 SDK 버전이 다르다)",
        accepts && rejects,
        `accepts=${accepts} rejects=${rejects}`,
      ),
      assert(
        "★어댑터가 그 이름들로 **차단**한다(2026-08-08 이후 이 이름의 쓰임은 차단 하나다)",
        // 종전엔 "잡 등록이 판정을 쓴다" 였다. SDK 빌트인 서브에이전트를 모든 깊이에서
        // 차단하면서 그 등록 경로가 통째로 사라졌고, 이름의 유일한 소비처가 차단이 됐다.
        // 검사가 **없어진 코드**를 계속 요구하면 올바른 삭제를 처벌한다(적대 검토 지적).
        /withSdkSubagentsBlocked\(/.test(adapterSrc),
        /withSdkSubagentsBlocked\(/.test(adapterSrc) ? "차단 배선" : "★차단 배선 없음",
      ),
      assert(
        "★하드 타임아웃 면제가 새 이름에도 걸린다(13분 컷이 정상 위임을 죽이던 창)",
        hardExempt && watchdog.ok,
        `exempt=${hardExempt} 배선=${watchdog.ok}`,
      ),
      assert(
        "★느림 경고 임계는 하나다(도구별 완화 없음 — 억제는 푸시·렌더에서 한다)",
        warnSingle,
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
        "★어댑터가 **넓은 판정**으로 차단하지 않는다(그러면 우리 spawn_agent 까지 막힌다)",
        // 종전엔 "잡 등록이 좁은 판정을 쓴다" 였는데 그 등록이 사라졌다(차단으로 대체).
        // 남는 위험은 반대 방향이다 — 차단에 넓은 판정(`isSubagentTool`)을 쓰면 우리
        // 도구까지 목록에 들어가 위임 경로가 통째로 막힌다. 그건 실행으로 확인한다.
        !withSdkSubagentsBlocked([]).includes("spawn_agent"),
        withSdkSubagentsBlocked([]).join(","),
      ),
      // ★판정이 옮겨졌다 (2026-08-20) — 종전엔 이 조건이 `virtualization.js` 안에만 있어서
      //  이력 렌더러엔 없었고, 그래서 턴이 끝나면 배지가 사라졌다(사용자 신고). 지금은
      //  `util.js:isSpawnStep` 한 곳이 정본이고 두 렌더러가 그걸 부른다.
      //  ★그래서 여기서도 **새 자리**를 본다 — 판정을 옮기면 그걸 지키던 검사도 같이 옮겨야
      //   한다(안 그러면 검사가 빈 자리를 보며 초록이거나, 오늘처럼 빨개진다).
      //  이름 축(`Agent`)의 실제 행동은 `spawn-badge-parity` 가 판정을 **실행**해서 지킨다.
      assert(
        "대시보드 잡카드 링크도 새 이름을 받는다(공용 판정 isSpawnStep)",
        (await sourceHas("../../../packages/dashboard/js/util.js", [
          /l === "Agent"/,
        ])).ok,
        "util.js:isSpawnStep",
      ),
    ];
  },
};
