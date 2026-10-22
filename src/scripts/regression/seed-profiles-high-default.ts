/**
 * 회귀: **빌트인 모델 프로파일은 high/mid/low 셋이고 기본은 high** (사용자 결정 2026-08-13).
 *
 * 종전 시드는 넷이었다 — `default`(메인 턴 풀) + high/mid/low(등급), 그리고 등급마다
 * `fallback: "default"`. 그래서 "메인 턴은 무엇으로 도는가" 에 답이 **두 곳**에 있었다:
 * `default` 라는 이름의 프로파일과 `models.default` 포인터. 둘은 갈릴 수 있고, 갈리면
 * 사용자는 자기가 고른 쪽이 안 먹는 이유를 못 찾는다([[feedback_hand_maintained_lists]]).
 *
 * 지금은 등급 축 하나(high↔low) + 포인터 하나(`models.default = "high"`)다.
 *
 * ★이 검사가 지키는 진짜 함정: `fallback` 을 안 적는 게 **게으름이 아니라 설계**라는 것.
 *  `resolveProfileChain` 이 모든 체인 말미에 기본 프로파일을 자동으로 덧붙이므로 low→high
 *  는 이미 성립한다. 그걸 모르고 "폴백이 없네" 하며 `fallback: "high"` 를 손으로 도로
 *  적으면, 기본이 바뀔 때 같이 안 바뀌는 두 번째 진실 소스가 생긴다. 그래서 **폴백이
 *  실제로 도는지를 실행해서** 본다 — 소스에 그 단어가 있는지가 아니라.
 *
 * ★등급: 폴백·기본 판정 = **실행**(실제 core 함수 + 임시 settings.json).
 *  init 은 2026-10-22 부터 프로파일을 시드하지 않는다(설치는 늘 자동) — 이 모양은 사용자가 직접 쓰거나
 *  비서에게 시켜 쓴 settings.json 의 모양이고, «init 이 아무것도 안 쓴다» 는 `onboard-one-shot` 이 본다.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const HIGH = "anthropic:claude-opus-5";
const LOW = "anthropic:claude-haiku-4-5";

export const check: RegressionCheck = {
  name: "seed-profiles-high-default",
  guards:
    "메인 턴 모델이 `default` 프로파일과 `models.default` 포인터 두 곳에 적혀 갈릴 수 있던 것 + 등급 폴백을 손으로 적어 기본이 바뀔 때 안 따라오던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { getDefaultProfileName, resolveProfileChain } = await import(
      "../../core/settings.js"
    );
    const { resolveModelSpecs } = await import("../../core/llm-runtime/index.js");

    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-seed-"));
    try {
      // 사용자가 고정할 때 쓰는 모양 — 셋뿐이고, fallback 은 아무 데도 없다.
      await writeFile(
        path.join(dir, "settings.json"),
        JSON.stringify({
          models: {
            default: "high",
            profiles: {
              high: { pool: [HIGH] },
              mid: { pool: ["anthropic:claude-sonnet-5"] },
              low: { pool: [LOW] },
            },
          },
        }),
        "utf8",
      );

      out.push(
        assert(
          "★기본 프로파일 = high",
          getDefaultProfileName(dir) === "high",
          `기본=${getDefaultProfileName(dir)}`,
        ),
      );

      // 메인 턴 암묵 풀이 실제로 high 로 풀리는가 — 포인터만 있고 해석이 안 되면 무의미.
      const main = resolveModelSpecs(undefined, dir);
      out.push(
        assert(
          "★메인 턴이 high 풀로 돈다(포인터가 실행까지 닿는다)",
          main.length > 0 && main[0].model === "claude-opus-5",
          `메인=${main.map((s) => s.model).join(",") || "(없음)"}`,
        ),
      );

      // ★`fallback` 을 안 적었는데도 low → high 가 성립해야 한다. 이게 성립해서
      //  손 폴백이 불필요한 것 — 안 성립하면 저 설계 자체가 틀린 것이다.
      const lowChain = resolveProfileChain("low", dir);
      const lowOk =
        lowChain.length === 2 && lowChain[0][0]?.spec === LOW && lowChain[1][0]?.spec === HIGH;
      out.push(
        assert(
          "★low 는 fallback 을 안 적어도 high 로 떨어진다(자동 덧붙임이 실제로 돈다)",
          lowOk,
          `체인=${JSON.stringify(lowChain)}`,
        ),
      );

      // 기본 자신은 중복되지 않는다(자기 체인에 자기를 두 번 붙이면 폴백이 헛돈다).
      const highChain = resolveProfileChain("high", dir);
      out.push(
        assert(
          "기본 프로파일 체인은 1단(자기 자신을 두 번 붙이지 않는다)",
          highChain.length === 1,
          `체인 길이=${highChain.length}`,
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    return out;
  },
};
