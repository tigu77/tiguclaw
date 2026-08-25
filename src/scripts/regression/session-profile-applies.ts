/**
 * 회귀: **세션에 건 모델 프로파일이 실제로 적용된다** (2026-08-25 실사고).
 *
 * 사용자 신고: *"공통 세션에서 gpt-high 로 설정을 했는데 왜 자꾸 기본 프로필로 응답을 하지?"*
 *
 * 뿌리: 08-24 에 프로파일 풀 원소를 문자열에서 **객체**(`{spec, reasoning?}`)로 바꾸면서
 * "배열→콤마문자열→재파싱" 왕복을 지웠는데 **`router.ts` 한 곳을 빠뜨렸다.**
 * `chain[0].join(",")` 이 `"[object Object],[object Object]"` 를 만들고, 파싱이 빈 배열을
 * 돌려주고, 빈 풀이면 오버라이드를 **안 걸고 조용히 기본 프로파일로 떨어진다.**
 *
 * ★조용했던 이유가 핵심이다: 실패가 예외가 아니라 **폴백**이었다. 로그엔 `model_profile=`
 *  줄이 아예 안 찍히는데, 없는 줄은 아무도 안 본다. 실측으로 08-24 이후 **0건**이었고
 *  (그 전엔 `low`·`claude-test`) 사용자가 알아채기까지 하루가 걸렸다.
 *
 * ★이 경로엔 그물이 **아예 없었다.** `resolveProfileChain` 도 `poolToSpecs` 도 각각
 *  검사되는데, **둘을 잇는 자리**는 아무도 안 봤다. 그래서 이 검사는 이음매를 본다:
 *  프로파일 이름 → 실제 스펙 목록까지 **한 번에** 실행한다.
 *
 * ★등급: **행동 게이트**. 순수 함수 조합을 실행해 값을 본다. 다만 `router.ts` 가 그 조합을
 *  쓰는지는 소스 대조다(라우터를 돌리려면 LLM 이 필요하다) — 그 한계를 단언 이름에 적었다.
 */
import { readFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProfileChain } from "../../core/settings.js";
import { poolToSpecs } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 이음매 — 이름 → 스펙까지 **실행으로** ────────────────────────────────
  const dir = mkdtempSync(path.join(tmpdir(), "sess-prof-"));
  mkdirSync(path.join(dir, ".tiguclaw"), { recursive: true });
  writeFileSync(
    path.join(dir, ".tiguclaw", "settings.json"),
    JSON.stringify({
      models: {
        default: "base",
        profiles: {
          base: { pool: ["codex:base-model"] },
          // ★문자열·객체가 **섞인** 풀 — 실사고 형상 그대로다.
          "gpt-high": {
            pool: ["codex:gpt-sol", { model: "anthropic:opus", reasoning: "high" }],
          },
        },
      },
    }) + "\n",
    "utf8",
  );

  const chain = resolveProfileChain("gpt-high", dir);
  const specs = chain.length > 0 ? poolToSpecs(chain[0]!, dir) : [];
  const models = specs.map((s) => s.model);
  out.push(
    assert(
      "★세션 프로파일 이름이 **실제 모델 목록**으로 풀린다(빈 풀로 조용히 떨어지지 않는다)",
      specs.length === 2 && models[0] === "gpt-sol" && models[1] === "opus",
      specs.length === 0
        ? "★빈 풀 — 오버라이드가 안 걸리고 기본 프로파일로 떨어진다(2026-08-25 실사고)"
        : models.join(" → "),
    ),
    assert(
      "★문자열·객체가 섞인 풀도 똑같이 풀린다(객체 원소가 `[object Object]` 로 뭉개지지 않게)",
      specs.every((s) => typeof s.model === "string" && !s.model.includes("object")),
      specs.map((s) => s.model).join(","),
    ),
    assert(
      "프로파일이 정한 강도가 스펙까지 따라온다(풀 원소 오버라이드가 살아 있다)",
      specs[1]?.reasoning === "high",
      `opus.reasoning=${String(specs[1]?.reasoning)}`,
    ),
    assert(
      "없는 프로파일이면 빈 체인 — 호출부가 기본으로 떨어지는 건 **의도된** 폴백이다",
      resolveProfileChain("nope", dir).length === 0,
      "댕글링 이름 확인",
    ),
  );

  // ── ② 배선 — router 가 그 조합을 쓰는가 ───────────────────────────────────
  //  ★[소스 대조] 라우터를 실제로 돌리려면 LLM 이 필요하다. 여기선 **옛 왕복이 되살아나지
  //   않았는지**만 본다 — 그게 이 사고의 정확한 모양이었다.
  const router = await readFile(new URL("../../core/router.ts", import.meta.url), "utf8");
  const usesHelper = /poolToSpecs\(\s*chain\[0\]/.test(router);
  const revived = /chain\[0\]\.join\(/.test(router);
  out.push(
    assert(
      "★[소스 대조] router 가 `poolToSpecs` 로 푼다(문자열 왕복이 되살아나지 않았다)",
      usesHelper && !revived,
      revived ? "★`chain[0].join(` 재등장 — 같은 사고가 되살아난다" : `helper=${usesHelper}`,
    ),
  );

  // ── ③ 왕복이 다른 데 또 남아 있나 — 전수 ──────────────────────────────────
  //  ★[소스 대조] 이 사고의 뿌리는 "같은 판단이 여러 벌" 이었다. 다섯 곳을 지우고 한 곳을
  //   빠뜨렸다. 그러니 개수를 센다 — 존재 확인이 아니라.
  const files = ["../../core/router.ts", "../../core/llm-runtime/index.ts"];
  const offenders: string[] = [];
  for (const rel of files) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (/(chain|pool)\w*\[?\d*\]?\.join\(/.test(line)) {
        offenders.push(`${rel.split("/").pop() ?? rel}:${i + 1}`);
      }
    }
  }
  out.push(
    assert(
      "★[소스 대조] 풀/체인을 문자열로 이어 붙이는 자리가 **0곳**이다",
      offenders.length === 0,
      offenders.length === 0 ? "0곳" : `★${offenders.join(", ")}`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "session-profile-applies",
  guards:
    "세션에 건 모델 프로파일이 조용히 무시되고 기본 프로파일로 답하던 것 — 풀 원소가 객체가 되면서 문자열 왕복이 `[object Object]` 를 만들었고, 빈 풀은 예외가 아니라 폴백이라 아무도 못 봤다",
  run,
};
export default check;
