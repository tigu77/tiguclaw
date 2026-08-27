/**
 * 회귀: **openai 어댑터가 usage 를 실제로 잡는다** (2026-08-27).
 *
 * ★사고: 추출이 `result.context.usage` 를 읽고 있었는데 **그런 필드가 없다.** Agents SDK 의
 *  `RunResult` 공개 표면은 `state` 하나이고 usage 는 `RunState.usage`(공개 getter)로 나온다.
 *  그래서 openai 어댑터의 usage 는 **한 번도 안 잡혔는데**, 추출이 graceful 이라 `/status`
 *  에 "측정 전" 으로 조용히 보였다 — 없는 것과 못 잰 것이 화면에서 같아 보인 것이다.
 *  실측으로 드러났다: 같은 턴이 옛 경로 `null` / 새 경로 `{inputTokens:4095, outputTokens:3}`.
 *
 * ★**두 축을 같이 지킨다.** 이 부류는 한쪽만 보면 반드시 다시 뚫린다:
 *   ① **잡는가** — 진짜 `RunState` 모양을 주면 값이 나오는가(옛 경로로 되돌리면 빨강).
 *   ② **거짓말하지 않는가** — 없으면 `undefined`(0 을 지어내지 않는다). `/status` 는
 *      "측정 전" 과 "0 토큰" 을 다르게 말해야 한다.
 *
 * ★그리고 **사설 필드(`state._context.usage`)로 가지 않는다.** 같은 값을 주지만 그걸 읽으면
 *  다음 SDK 업그레이드가 조용히 깨뜨린다 — 이 어댑터가 이미 그 부류로 두 번 데었다
 *  (usage 가 스냅샷이 되고, `result` 가 스트림당→턴당이 된 것).
 *
 * 등급: **동작 검사** — 판정을 순수 함수로 뽑아 **실제로 부른다**(`extractUsage`).
 * 인라인이던 동안엔 소스 grep 말고 검증 수단이 없어서 "안 잡힌다" 를 아무도 못 봤다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractUsage } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 라이브 ollama 왕복에서 실제로 관측한 모양(2026-08-27). 지어낸 픽스처가 아니다. */
const realShape = {
  state: {
    usage: {
      requests: 1,
      inputTokens: 4095,
      outputTokens: 3,
      totalTokens: 4098,
      inputTokensDetails: [{ cached_tokens: 512 }],
      outputTokensDetails: [{ reasoning_tokens: 0 }],
    },
  },
};

export const check: RegressionCheck = {
  name: "openai-usage-is-captured",
  guards:
    "openai 어댑터의 usage 추출이 존재하지 않는 `result.context.usage` 를 읽어 한 번도 안 잡히던 것 — graceful 폴백이라 /status 에 '측정 전' 으로 조용히 보였고, 없는 것과 못 잰 것이 화면에서 같아 보였다",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(
      path.join(REPO, "src/core/llm-runtime/adapters/openai-agents-sdk.ts"),
      "utf8",
    );
    // ★주석을 지우고 본다 — 안 그러면 **금지 대상을 설명하는 주석**이 위반으로 세어져
    //  상시 빨강이 된다. 이 레포에서 같은 부류로 **다섯 번째**다(첫 실행에서 바로 걸렸다).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const got = extractUsage(realShape);
    const noCache = extractUsage({ state: { usage: { inputTokens: 10, outputTokens: 2 } } });

    return [
      assert(
        "★진짜 RunState 모양에서 토큰을 뽑는다(옛 경로면 undefined 였다)",
        got?.inputTokens === 4095 && got.outputTokens === 3,
        JSON.stringify(got),
      ),
      assert(
        "★캐시 적중도 같이 뽑는다(관측 비대칭 — codex·claude 만 싣고 있었다)",
        got?.cachedTokens === 512,
        `cachedTokens=${String(got?.cachedTokens)}`,
      ),
      assert(
        "캐시 정보가 없으면 그 키를 지어내지 않는다",
        noCache?.inputTokens === 10 && noCache.cachedTokens === undefined,
        JSON.stringify(noCache),
      ),
      // ② 거짓말 금지 — 없을 때 0 을 만들어내면 "측정 전" 과 "0 토큰" 이 구분되지 않는다.
      ((): Assertion => {
        const cases: Array<[string, unknown]> = [
          ["undefined", undefined],
          ["null", null],
          ["{}", {}],
          ["state 만", { state: {} }],
          ["usage=null", { state: { usage: null } }],
          ["토큰이 문자열", { state: { usage: { inputTokens: "4095", outputTokens: 3 } } }],
          ["옛(없는) 경로", { context: { usage: { inputTokens: 1, outputTokens: 1 } } }],
        ];
        const leaked = cases.filter(([, v]) => extractUsage(v) !== undefined).map(([n]) => n);
        return assert(
          "★못 뽑으면 undefined 다(0 을 지어내지 않는다)",
          leaked.length === 0,
          leaked.length === 0
            ? `${cases.length}케이스 전부 undefined`
            : `★값이 나온 케이스: ${leaked.join(", ")}`,
        );
      })(),
      // ★사설 필드로 새지 않는가 — 같은 값을 주지만 업그레이드가 조용히 깨뜨린다.
      assert(
        "★사설 `_context` 를 읽지 않는다(공개 getter `state.usage` 만)",
        !/_context/.test(code) && /\.state\?\.usage/.test(code),
        `사설 _context 접근=${/_context/.test(code)} · 공개 state?.usage 읽음=${/\.state\?\.usage/.test(code)}`,
      ),
      // 정의만 있고 안 부르면 규칙이 죽는다.
      assert(
        "★어댑터가 이 함수를 쓴다(인라인으로 되돌아가지 않았다)",
        /const usage = extractUsage\(result\);/.test(code),
        /extractUsage\(/.test(code) ? "호출 있음" : "★인라인으로 되돌아갔다",
      ),
    ];
  },
};
