/**
 * 회귀: **도구 한 번 안 쓰고 끝난 서브에이전트가 표면에 뜬다** (2026-08-07 실측 3건).
 *
 * 실측: 파일을 읽으라고 시켰는데 **5초 만에 도구 0회**로 그럴듯한 값을 지어냈다(실제
 * `0.18.0` 인데 "0.5.5" 라고 답했다). 40초 대기를 시키자 17초에 백그라운드로 던지고
 * "완료되면 알려드리겠습니다" 로 끝냈다. 07-30 `news-researcher` 도 84초/0회로 같은 모양.
 * 정상 건은 내부 도구를 **9~30회** 쓴다 — `seq === 0` 은 "일을 안 했다" 의 좋은 대리 지표다.
 *
 * ★단정하지 않는다. 요약·판단만 시키면 도구 0회가 정상이라, 실패로 닫으면 오탐이다.
 *  그래서 **신호만** 낸다 — 사람이 결과를 읽고 의심해야만 알던 것을 화면으로 올린다.
 *
 * ★검사는 **도달**을 본다(발행 아님). 이 레포에서 "발행했는데 소비처가 없어 로그에만 남은"
 *  사고가 반복됐다(`llm.compaction_stuck`·`llm.tool_hang`). 그래서 (a) 어댑터가 낸다
 *  (b) 대시보드가 그린다 (c) **`worker.` 접두를 쓰지 않는다** 셋을 같이 못 박는다.
 *  (c) 가 필요한 이유: `sse.js` 는 `worker.*` 를 **타입 없이** handleWorkerEvent(payload) 로
 *  넘기는 블라인드 라우팅이라, 상태 없는 페이로드가 잡 카드 상태를 건드릴 수 있다.

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
  name: "agent-did-no-work",
  guards:
    "서브에이전트가 도구를 하나도 안 쓰고 답을 지어내도 아무 신호가 없어 사람이 결과를 의심해야만 알던 것",
  run: async (): Promise<Assertion[]> => {
    const emit = await sourceHas(
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      [
        // 이미 세고 있는 잡별 스텝 수를 쓴다(새 카운터 0, 비용 0).
        /if \(entry\.seq === 0 && !isError\)/,
        /\[agent-no-tools\]/,
        /type: "llm\.agent_no_tools"/,
      ],
    );
    const render = await sourceHas("../../../packages/dashboard/js/sse.js", [
      /ev\.type === "llm\.agent_no_tools"/,
      /renderLocalChat\(/,
      // 남의 세션 신호가 내 대화에 끼어들면 오독.
      /isActiveThread\(p\.threadKey\)/,
    ]);
    // ★`worker.` 접두 금지 — 블라인드 라우팅에 딸려 들어가면 카드 상태를 건드린다.
    const { readFile } = await import("node:fs/promises");
    const adapterSrc = await readFile(
      new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url),
      "utf8",
    );
    const noWorkerPrefix = !/type:\s*"worker\.no_tools"/.test(adapterSrc);

    // ★조건은 **값**이어야 한다 — Promise 를 넘기면 항상 truthy 라 상시 초록인 가짜 검사가
    //  된다(이 파일에서 실제로 그렇게 썼다가 잡았다). 미리 읽어 문자열로 비교한다.
    let registrySrc = "";
    try {
      registrySrc = await (await import("node:fs/promises")).readFile(
        new URL("../../core/llm-runtime/capabilities/agent-registry.ts", import.meta.url),
        "utf8",
      );
    } catch { /* 부재 시 아래 단언이 실패로 드러난다(조용한 통과 금지) */ }

    return [
      assert(
        "★신호가 **우리 루프(spawn_agent)** 에서 나온다 — SDK 경로는 차단됐다",
        // 이관 전엔 claude 어댑터의 SDK Task 경로에만 있었다. 그 경로를 막으면서 신호가
        // 통째로 죽었고(정리하다 발견), 살아 있는 자리는 spawn_agent 뿐이다.
        // 여기 오면서 세 어댑터 공통이 된다(claude 전용 신호가 아니게).
        registrySrc !== "" && /"llm\.agent_no_tools"/.test(registrySrc),
        "agent-registry 발행",
      ),
      assert(
        "★대시보드가 그 신호를 화면에 그린다(로그에만 있으면 없는 것과 같다)",
        render.ok,
        render.ok ? "sse.js" : `누락: ${render.missing.join(" / ")}`,
      ),
      assert(
        "품질 신호에 `worker.` 접두를 쓰지 않는다(타입 없는 블라인드 라우팅 회피)",
        noWorkerPrefix,
        noWorkerPrefix ? "llm.agent_no_tools" : "worker.no_tools 부활",
      ),
    ];
  },
};
