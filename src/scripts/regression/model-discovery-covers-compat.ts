/**
 * 회귀: **모델 발견이 openai 호환 provider 전부를 덮는다 — 등급은 주장하지 않는다** (2026-08-31).
 *
 * ★사고: 조회 대상이 배열에 손으로 적힌 **둘**(`anthropic`·`codex`)뿐이었고 그 둘은
 *  **구독** 경로다. 공식 API 키 경로(`openai`·`google`·`ollama` + 사용자 정의 전부)는 목록이
 *  **0** 이라, `provider:model` 을 요구하는 제품 안에서 *"어떤 provider 가 이 모델을
 *  지원하나"* 에 답할 자리가 없었다. 새 provider 를 붙여도 영원히 비어 있었다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★그리고 그걸 고치자마자 **반대편이 생겼다**(실측): 표준 `/models` 는 정렬을 약속하지
 *  않는데 등급 판정의 일반 경로는 *"첫 원소가 최상급"* 을 전제한다. 정품 openai 는 임베딩·
 *  TTS 까지 한 배열이라 `tier:high` 가 엉뚱한 것이 될 수 있었다. **넓힌 쪽에만 못을 박으면
 *  거짓양성 쪽으로 샌다.** 그래서 이 검사는 **양쪽**을 본다.
 *
 * 지키는 것 셋:
 *  ① 조회 대상이 **규칙**이다 — openai 어댑터를 쓰면 저절로 들어온다(손 목록 금지).
 *  ② 표준 조회는 스스로 **`unranked`** 를 선언한다.
 *  ③ 등급 판정이 그걸 **존중한다** — 순서에 의미가 없으면 `undefined`(모른다고 말한다).
 *
 * 등급: ①②는 대조(소스), ③은 **동작**(카탈로그를 세워 실제로 물어본다 — 네트워크 0).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogTierModel, __setCatalogForTest } from "../../core/llm-runtime/model-catalog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "model-discovery-covers-compat",
  guards:
    "모델 조회 대상이 손 목록 둘(구독 provider)뿐이라 공식 API 키 경로 전부가 목록 0이던 것 — provider 를 붙일 수는 있는데 무슨 모델이 있는지 물어볼 곳이 없었다 + 그걸 고치면서 순서 없는 목록에 등급을 주장하게 되는 것",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(path.join(REPO, "src/core/llm-runtime/model-catalog.ts"), "utf8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // ① 대상이 규칙에서 나온다(어댑터로 거른다) — 이름을 배열에 적지 않는다.
    const byRule =
      /listProviderNames\(\)[\s\S]{0,120}?adapter === "openai"/.test(src) &&
      /\.\.\.compat\.map\(/.test(src);
    // ② 표준 조회가 스스로 순위 없음을 선언한다.
    const declares = /unranked: true/.test(src);

    const out: Assertion[] = [
      assert(
        "★★조회 대상이 **규칙**이다 — `openai` 어댑터를 쓰는 provider 는 저절로 들어온다(배열에 이름을 적으면 셋째가 조용히 빠진다)",
        byRule,
        byRule ? "어댑터로 파생" : "★손 목록으로 돌아갔다",
      ),
      assert(
        "★표준 `/models` 조회가 스스로 **순위 없음**을 선언한다 — 정렬을 약속하지 않는 응답이다",
        declares,
        declares ? "unranked 선언 있음" : "★선언 없음",
      ),
    ];

    // ③ 동작 — 카탈로그를 세워 실제로 물어본다(네트워크 0).
    const prev = { anthropic: ["claude-opus-5"], zzcompat: ["text-embedding-3-small", "gpt-5.5"] };
    __setCatalogForTest({ fetchedAt: Date.now(), models: prev, unranked: ["zzcompat"] });
    const unrankedHigh = catalogTierModel("zzcompat", "high");
    const rankedHigh = catalogTierModel("anthropic", "high");
    __setCatalogForTest(null);

    out.push(
      assert(
        "★★순서에 의미가 없는 목록엔 **등급을 주장하지 않는다** — 첫 원소를 최상급으로 읽으면 `tier:high` 가 임베딩 모델이 된다(모르면 호출자가 정적 표로 강등한다)",
        unrankedHigh === undefined,
        `unranked provider 의 tier:high = ${String(unrankedHigh)}`,
      ),
      assert(
        "★반대 방향 — **순위 있는 provider 는 그대로 답한다**(전부 모른다고 하면 그것도 결함이다)",
        rankedHigh === "claude-opus-5",
        `anthropic tier:high = ${String(rankedHigh)}`,
      ),
    );
    return out;
  },
};
