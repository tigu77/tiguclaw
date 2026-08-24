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
 * ★등급: ①폴백·기본 판정 = **실행**(실제 core 함수 + 임시 settings.json) ②시드 모양 =
 *  배선 린트(init.ts 는 import 시 readline 을 잡아 stdin 을 물므로 실행 불가).
 */
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
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
      // init 이 새로 까는 것과 같은 모양 — 셋뿐이고, fallback 은 아무 데도 없다.
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

    // 시드 모양 — 위 실행 검사는 **내가 쓴 픽스처**를 보므로, init 이 진짜 그 모양을
    // 까는지는 별도로 본다(픽스처와 실물이 갈리면 위 초록은 아무것도 안 지킨다).
    const src = await readFile(new URL("../init.ts", import.meta.url), "utf8");
    const seedBlock = src.slice(
      src.indexOf("const buildSeedProfiles"),
      src.indexOf("const seedModelProfiles"),
    );
    const three =
      seedBlock !== "" &&
      /\n  high: \{/.test(seedBlock) &&
      /\n  mid: \{/.test(seedBlock) &&
      /\n  low: \{/.test(seedBlock) &&
      !/\n  default: \{/.test(seedBlock) &&
      !/fallback:/.test(seedBlock);
    out.push(
      assert(
        "★init 시드는 high/mid/low 셋뿐이고 손 fallback 이 없다",
        three,
        three ? "3개 · fallback 0" : "★`default` 프로파일이 돌아왔거나 fallback 을 손으로 적었다",
      ),
    );
    const pointer = /seedModelProfiles\(buildSeedProfiles\(answers\), "high"\)/.test(src);
    out.push(
      assert(
        "★init 이 기본 포인터를 함께 쓴다(키 순서에 기대지 않는다)",
        pointer,
        pointer ? 'models.default="high"' : "★포인터를 안 쓴다 — 기본이 키 순서에 달린다",
      ),
    );
    // 메인 턴의 레거시 경로(.env REGION_A_MODELS)가 high 와 갈리지 않는가 —
    // 같은 질문에 두 답이 있으면 프로파일을 지웠을 때 답하는 모델이 조용히 바뀐다.
    const envAligned = /regionAModels: tier\.high,/.test(src);
    out.push(
      assert(
        "★REGION_A_MODELS 시드가 high 와 같은 값이다(레거시 경로가 갈리지 않는다)",
        envAligned,
        envAligned ? "tier.high 로 일치" : "★.env 와 프로파일이 다른 모델을 가리킨다",
      ),
    );
    return out;
  },
};
