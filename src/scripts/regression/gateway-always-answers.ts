/**
 * 회귀: **게이트웨이는 반드시 결과를 준다** — 등급 ★배선 린트 (2026-08-09).
 *
 * 사용자 규칙(2026-08-09): *"제일 안좋은게 아무것도 없이 응답이 없는거야. 뭐가 됐든 결과를
 * 줘야지."* 게이트웨이 응답은 셋 중 하나여야 한다 — `tool_calls` · 텍스트 · **명시적 에러**.
 * 침묵도, 빈 200 도 없다.
 *
 * 실사용 사고: 외부 앱이 `tools` 를 보냈는데 어댑터가 그걸 버리고 평범한
 * 텍스트를 200 으로 돌려줬다. 앱 입장에선 **"AI 가 도구를 안 쓴다"** 로만 보였고 어디를
 * 고쳐야 할지 알 수 없었다. 원인 규명에 하루가 들었다.
 *
 * 실측으로 확인한 계약 위반 2건(같은 날):
 *  - `tool_choice:"none"` 인데 **tool_calls 가 나왔다**(부르지 말라는데 불렀다).
 *  - `tool_choice:"required"` 인데 **텍스트를 200 으로 돌려줬다**(반드시 부르라는데 안 불렀고,
 *    그 사실을 알리지도 않았다).
 *
 * ★등급이 **배선 린트**인 이유: 판정이 http-bridge 플러그인의 요청 핸들러 안에 있어 데몬 없이
 *  실행할 수 없다. 이건 [[feedback_gate_must_actually_run]] 이 말하는 약한 검사다 — 동의어나
 *  `if (false)` 로 뚫린다. 승격하려면 응답 조립을 순수 함수로 뽑아야 한다(백로그).
 *  그때까지는 이 검사가 **문구가 아니라 구조**를 보도록 유지한다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const BRIDGE = "../../../plugins/http-bridge/index.ts";

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

export const check: RegressionCheck = {
  name: "gateway-always-answers",
  guards:
    "게이트웨이가 tool_calls·텍스트·명시적 에러 중 하나를 반드시 준다 — 빈 200 과 조용한 계약 위반이 앱을 하루 묶던 것",
  run: async (): Promise<Assertion[]> => {
    const bridge = strip(await readFile(new URL(BRIDGE, import.meta.url), "utf8"));

    // ①빈 응답을 200 으로 내보내지 않는다(사용자 규칙의 본체).
    const emptyGuarded =
      /empty_completion/.test(bridge) && /bodyText\.trim\(\) === ""/.test(bridge);
    // ②tool_choice:"none" 은 **스키마를 안 넘겨서** 집행한다(부탁이 아니라 수단 제거).
    const noneEnforced = /body\.tool_choice === "none"\) return \{\}/.test(bridge);
    // ③tool_choice:"required" 미충족을 에러로 알린다.
    const requiredEnforced =
      /tool_choice_unsatisfied/.test(bridge) &&
      /externalToolChoice === "required"/.test(bridge);
    // ④★토큰 두 축이 **같은 규칙**(Total ?? 단건). 한쪽만 합계면 클라 회계가 비대칭으로 틀린다
    //   — 2026-08-09 벤치에서 같은 비대칭이 "우리가 11배 효율적" 이라는 거짓을 만들었다.
    const inTotal = /inputTokensTotal \?\? out\.usage\?\.inputTokens/.test(bridge);
    const outTotal = /outputTokensTotal \?\? out\.usage\?\.outputTokens/.test(bridge);
    // ⑤★특정 함수 강제(`tool_choice:{function:{name}}`)를 **노출 축소**로 집행한다.
    //   실측(2026-08-09): 그전엔 조용히 무시돼 강제한 것과 **다른 함수가 호출됐다**
    //   (set_voxel_layers 를 강제했는데 clear_scene). 목록에 없는 이름은 400 으로 알린다.
    const forcedEnforced =
      /externalTools: only, externalToolChoice: "required"/.test(bridge) &&
      /invalid_tool_choice/.test(bridge);
    // ⑥에러 응답이 OpenAI 규격(`error.message`)이어야 클라가 읽는다.
    const openAiShape = (bridge.match(/error: \{\s*message:/g) ?? []).length >= 2;

    return [
      assert(
        "★빈 응답을 200 으로 내보내지 않는다(텍스트도 함수콜도 없으면 에러)",
        emptyGuarded,
        emptyGuarded ? "empty_completion 가드" : "★앱이 빈 성공을 받는다 — 최악의 실패",
      ),
      assert(
        '`tool_choice:"none"` 을 **스키마 미전달**로 집행한다(부탁이 아니라 수단 제거)',
        noneEnforced,
        noneEnforced ? "none → 미주입" : "★부르지 말라는데 부를 수 있다",
      ),
      assert(
        '`tool_choice:"required"` 미충족을 에러로 알린다(텍스트를 성공인 척 주지 않는다)',
        requiredEnforced,
        requiredEnforced ? "tool_choice_unsatisfied" : "★조용히 텍스트가 나간다",
      ),
      assert(
        "★토큰 입력·출력이 **같은 규칙**(Total ?? 단건)을 쓴다",
        inTotal && outTotal,
        `input=${String(inTotal)} output=${String(outTotal)}`,
      ),
      assert(
        "★특정 함수 강제를 노출 축소로 집행한다(조용히 다른 함수가 불리던 것) + 없는 이름은 400",
        forcedEnforced,
        forcedEnforced ? "축소 + invalid_tool_choice" : "★tool_choice 객체형이 무시된다",
      ),
      assert(
        "에러가 OpenAI 규격(error.message)이라 클라이언트가 읽는다",
        openAiShape,
        openAiShape ? "규격 준수" : "★클라가 못 읽는 에러 모양",
      ),
    ];
  },
};
