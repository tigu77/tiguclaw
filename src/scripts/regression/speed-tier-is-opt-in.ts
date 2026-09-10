/**
 * 회귀: **빠른 티어는 프로파일이 켤 때만 켜지고, 화면에 보인다** (2026-09-10).
 *
 * 배경: codex `/models` 가 모델마다 추가 속도 티어를 광고하는데(`additional_speed_tiers:
 * ["fast"]`, 설명 «1.5~2x speed, **increased usage**») 우리는 `service_tier` 를 아예 안
 * 보내고 있었다. 실측: `priority`·`default` → 200 / `flex`·`auto` → 400.
 *
 * ★이건 **대가가 있는** 손잡이다 — 구독 한도를 더 빨리 쓴다. 그래서 셋을 지킨다:
 *  ①기본은 꺼짐(안 적으면 필드 자체가 안 나간다 = 회귀 0)
 *  ②모르는 값은 조용히 켜지지 않는다(오타가 «켜짐» 이 되면 한도를 태운다)
 *  ③화면에 보인다(한도가 왜 빨리 닳는지 알 수 없으면 안 된다)
 *
 * ★공용 계약의 낱말은 **중립**이다(`speed:"fast"`). `service_tier` 는 OpenAI 말이라
 *  거기 박으면 다른 provider 를 붙일 때 남의 벤더 어휘를 쓰게 된다 — 어댑터가 옮긴다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "speed-tier-is-opt-in",
  guards:
    "한도를 더 쓰는 속도 티어가 기본으로 켜지거나, 오타로 조용히 켜지거나, 켜졌는데 " +
    "화면에 안 보여 사용자가 한도가 닳는 이유를 모르게 되던 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];

    // ① 기본 꺼짐 — 어댑터가 **조건부로만** 싣는다.
    const adapter = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    const guarded = /\.\.\.\(input\.speed === "fast" \? \{ service_tier: "priority" \} : \{\}\)/.test(
      adapter,
    );
    out.push(
      assert(
        "★★빠른 티어는 **조건부로만** 실린다 — 무조건 싣거나 기본값을 주면 모든 사용자의 한도가 더 빨리 닳는다",
        guarded && !/service_tier: "priority",\s*$/m.test(adapter),
        `가드된 주입=${guarded}`,
      ),
      assert(
        "★공용 계약엔 `service_tier` 를 박지 않는다 — 그건 OpenAI 낱말이고, 어휘가 새면 다른 provider 를 붙일 때 남의 말을 쓰게 된다",
        !/service_tier/.test(stripComments(readSourceSync("src/core/llm-runtime/types.ts"))) &&
          !/service_tier/.test(stripComments(readSourceSync("src/core/settings.ts"))),
        (() => {
          const t = (stripComments(readSourceSync("src/core/llm-runtime/types.ts")).match(/service_tier/g) ?? []).length;
          const g = (stripComments(readSourceSync("src/core/settings.ts")).match(/service_tier/g) ?? []).length;
          return `types.ts=${t}건 · settings.ts=${g}건 (둘 다 0이어야)`;
        })(),
      ),
    );

    // ② 모르는 값은 안 켜진다 — **실행으로** 잰다.
    const { __parsePoolForTest } = await import("../../core/settings.js");
    const cases: Array<[unknown, "fast" | undefined, string]> = [
      ["fast", "fast", "정상"],
      ["Fast", undefined, "대소문자 다름"],
      ["priority", undefined, "벤더 낱말을 그대로 적음"],
      ["true", undefined, "불리언처럼 적음"],
      [undefined, undefined, "미지정"],
    ];
    const wrong = cases.filter(([raw, want]) => {
      const pool = __parsePoolForTest([
        { model: "codex:m", ...(raw === undefined ? {} : { speed: raw }) },
      ]);
      return pool[0]?.speed !== want;
    });
    out.push(
      assert(
        "★★아는 값(`fast`)만 켜고 나머지는 **안 켠다** — 오타가 조용히 «켜짐» 이 되면 한도를 태우고, 사용자는 왜인지 모른다",
        wrong.length === 0,
        cases
          .map(([raw, , label]) => {
            const pool = __parsePoolForTest([
              { model: "codex:m", ...(raw === undefined ? {} : { speed: raw }) },
            ]);
            return `${label}=${String(pool[0]?.speed)}`;
          })
          .join(" · "),
      ),
    );

    // ③ 화면에 보인다.
    const { renderModelProfiles } = await import("../../core/entry/models-command.js");
    const body = renderModelProfiles(
      { p: { pool: [{ spec: "codex:x", speed: "fast" }, { spec: "codex:y" }] } } as never,
      null,
      "p",
      {} as NodeJS.ProcessEnv,
      false,
      undefined,
    );
    const line = body.split("\n").find((l) => l.includes("풀:"))?.trim() ?? "(풀 줄 없음)";
    out.push(
      assert(
        "★★켜진 항목이 화면에 **배수와 함께** 표시된다 — 「한도 더 씀」처럼 뭉뚱그리면 경고가 아니라 장식이다(실제로는 크레딧 2.5배)",
        /codex:x`?\(빠름·크레딧 2\.5배\)/.test(body) && !/codex:y`?\(빠름/.test(body),
        line,
      ),
    );

    return out;
  },
};
