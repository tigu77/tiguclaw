/**
 * 회귀 둘 — 둘 다 **추론 강도**가 조용히 틀리던 자리다 (2026-09-10).
 *
 * ① **final flush 가 모델이 안 받는 값을 박지 않는다.** 종전엔 모델과 무관하게
 *    `{effort:"none"}` 을 보냈는데, 실측으로 `gpt-6-astra` 는 이걸 **400** 으로 거절한다
 *    (`Unsupported value: 'none' is not supported with the 'gpt-6-astra' model.
 *    Supported values are: 'low','medium','high','xhigh','max'`). 같은 요청이
 *    `gpt-5.6-sol` 에선 200 이다. 400 은 RETRIABLE_STATUS(429·5xx)에 없어 즉시 throw →
 *    `runPool` 이 **턴을 통째로 다음 모델에 다시 돌린다**(37 iteration 작업이면 다 버린다).
 *    마지막 안전망이 오히려 작업을 날리는 자리였다.
 *    ★아직 안 터졌다(로그 9개에서 `flush=true` 0건) — 잠복 결함이라 그물이 더 필요하다.
 *    ★고치는 방식이 중요하다: **모델 이름 분기 금지**, `"low"` 하드코딩도 금지(그것도 손
 *     목록이다). 백엔드 `/models` 가 주는 `supported_reasoning_levels` 첫 원소를 쓴다.
 *
 * ② **화면이 실제로 실려 나가는 강도를 숨기지 않는다** (정태님: *"모델프로필에서 기본값
 *    이더라도 항상 추론강도 표시해주고"*). 종전엔 풀 원소에 직접 적었을 때만 보였다 —
 *    안 보이는 동안에도 값은 나간다. 그리고 층이 셋이라(풀 원소 > 설정 > 카탈로그)
 *    **출처까지** 말해야 «전역을 바꿨는데 왜 안 먹지» 가 풀린다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "reasoning-floor-and-visibility",
  guards:
    "final flush 가 모든 모델에 'none' 을 박아 astra 에서 400 → 턴 통째 재실행되던 것 + " +
    "실제로 실려 나가는 추론 강도가 /models 화면에 안 보이던 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];

    // ── ① final flush 의 강도 ────────────────────────────────────────────────
    const adapter = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    out.push(
      assert(
        "★★final flush 가 `none` 을 **박지 않는다** — 백엔드가 광고한 최저값을 쓰고, 모르면 그때만 종전값으로 간다",
        /catalogReasoningFloor\("codex", model\) \?\? "none"/.test(adapter),
        (() => {
          const m = /finalFlushRequested\) \{\s*body\.reasoning = \{([^}]*)\}/.exec(adapter);
          return m === null ? "★조립부를 못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라" : m[1]?.trim() ?? "?";
        })(),
      ),
      assert(
        "★모델 이름으로 분기하지 않는다 — `gpt-6-astra` 를 코드가 알면 다음 모델에서 같은 사고가 난다",
        !/gpt-6-astra|gpt-5\.6-sol/.test(adapter),
        `어댑터 안 모델명 하드코딩 ${(adapter.match(/gpt-6-astra|gpt-5\.6-sol/g) ?? []).length}건`,
      ),
    );

    // 최저값 판정 자체 — 실행으로 잰다.
    const cat = await import("../../core/llm-runtime/model-catalog.js");
    cat.__setCatalogForTest({
      fetchedAt: Date.now(),
      models: { codex: ["gpt-6-astra"] },
      reasoningFloor: { "codex:gpt-6-astra": "low" },
    } as never);
    out.push(
      assert(
        "★카탈로그가 최저값을 말하면 그걸 낸다(astra=low — 실측한 400 이 말한 그 값)",
        cat.catalogReasoningFloor("codex", "gpt-6-astra") === "low",
        `관측=${String(cat.catalogReasoningFloor("codex", "gpt-6-astra"))}`,
      ),
      assert(
        "★모르는 모델엔 **undefined** — 어댑터가 종전값으로 가게 둔다(지어내지 않는다)",
        cat.catalogReasoningFloor("codex", "안-받아본-모델") === undefined,
        `관측=${String(cat.catalogReasoningFloor("codex", "안-받아본-모델"))}`,
      ),
    );

    // ── ② 화면이 실제 값을 보여준다 ─────────────────────────────────────────
    const { renderModelProfiles } = await import("../../core/entry/models-command.js");
    const caps = (spec: string) =>
      spec === "codex:a"
        ? { reasoning: "medium", reasoningFrom: "설정" as const }
        : spec === "codex:b"
          ? { reasoning: "low", reasoningFrom: "모델기본" as const }
          : undefined;
    const body = renderModelProfiles(
      {
        p: {
          pool: [{ spec: "codex:a" }, { spec: "codex:b" }, { spec: "codex:c", reasoning: "high" }],
        },
      } as never,
      null,
      "p",
      {} as NodeJS.ProcessEnv,
      false,
      caps,
    );
    out.push(
      assert(
        "★★프로파일에 안 적어도 **실제로 실려 나가는 강도**가 보인다 — 안 보이면 없는 값처럼 읽히는데 값은 나가고 있다",
        body.includes("강도 medium") && body.includes("강도 low"),
        body.split("\n").find((l) => l.includes("풀:"))?.trim() ?? "(풀 줄 없음)",
      ),
      assert(
        "★★출처가 세 층으로 갈린다(이 프로파일 / 설정 / 모델기본) — 뭉치면 «전역을 바꿨는데 왜 안 먹지» 가 그대로 남는다",
        body.includes("·설정") && body.includes("·모델기본") && body.includes("·이 프로파일"),
        body.split("\n").find((l) => l.includes("풀:"))?.trim() ?? "(풀 줄 없음)",
      ),
      assert(
        "★모르는 모델엔 강도를 지어내지 않는다",
        !/`codex:c`\(강도 [a-z]+·(설정|모델기본)\)/.test(body),
        body.split("\n").find((l) => l.includes("codex:c"))?.trim() ?? "(codex:c 줄 없음)",
      ),
    );

    return out;
  },
};
