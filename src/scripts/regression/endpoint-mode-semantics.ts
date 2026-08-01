/**
 * 회귀: **`mode` 가 도구와 인격을 함께 가른다** (2026-08-02 사용자 판단).
 *
 * 종전엔 `mode` 를 소비하는 코드가 전 레포에 **한 줄**(toolPolicy)뿐이었다. 그래서
 * `restricted` 엔드포인트는 **도구는 0인데 비서 인격·정책(SYSTEM.md ~25KB)은 그대로**
 * 받았다. 도구가 없으니 그 대부분(도구 사용법·승인 게이트·채널 발신·스킬 라우팅)은
 * 적용될 대상 자체가 없고, 남는 건 말투·보고 지시뿐인데 **그게 역할과 충돌했다** —
 * 정의 파일이 "순수 JSON 하나만 반환하세요 / 설명 문장 금지" 같은 **방어 문장**을 쓰고
 * 있었다(실측: 정의 3개 중 2개). 역할이 두 번 주어진 것이다.
 *
 * ★확정 의미:
 *   `restricted`(기본) = **순수 백엔드** — 도구 0 + 인격 0. 정의 본문이 곧 시스템 프롬프트.
 *   `full`             = **비서로서 실행** — 전체 도구 + 헌법(승인 게이트 포함).
 *  도구를 주면서 안전 규칙만 빼는 조합은 만들지 않는다.
 *
 * ★새 축을 만들지 않았다 — 기존 `mode` 의 의미를 완성했다. LLM 게이트웨이가 이미 같은
 *  이유로 `systemPromptOverride` 를 쓴다(동형, 프리미티브 재사용).
 *
 * ★만드는 쪽도 알아야 한다 — `restricted` 면 본문이 그대로 system 이므로 **자기완결**로
 *  써야 하고, 반대로 방어 문장은 쓰면 안 된다(맞설 인격이 없다). `register_endpoint`
 *  도구 설명이 그것을 말하는지도 여기서 지킨다. 규칙을 코드에만 두면 비서는 모른다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "endpoint-mode-semantics",
  guards:
    "restricted 엔드포인트가 도구는 0인데 비서 인격 25KB 를 받아 역할이 충돌하고 정의가 방어 문장을 쓰던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const bridge = read("plugins/http-bridge/index.ts");

    // ★① 두 갈래가 **같은 조건식**에서 갈리는가 — 따로 두면 하나만 바뀌어 어긋난다.
    const toolsGated = /toolPolicy: ep\.mode === "restricted" \? \{ mode: "none" \} : undefined/.test(
      bridge,
    );
    const personaGated =
      /ep\.mode === "restricted" \? \{ systemPromptOverride: prompt \} : \{\}/.test(bridge);
    out.push(
      assert(
        "★restricted 가 도구를 끈다",
        toolsGated,
        toolsGated ? "toolPolicy none" : "★도구 게이트 없음",
      ),
    );
    out.push(
      assert(
        "★restricted 가 인격도 끈다(정의 본문이 곧 system)",
        personaGated,
        personaGated ? "systemPromptOverride=prompt" : "★인격이 그대로 실린다 — 역할 충돌 재현",
      ),
    );
    // full 에서 헌법을 빼면 안 된다 — 도구를 쥐여주고 안전 규칙만 없애는 조합 금지.
    const overridesAlways = /systemPromptOverride: prompt,\s*$/m.test(bridge);
    out.push(
      assert(
        "★full 은 헌법을 유지한다(무조건 override 아님)",
        personaGated && !overridesAlways,
        overridesAlways ? "★모든 mode 에서 인격이 빠진다" : "restricted 에서만 override",
      ),
    );

    // ★② 만드는 쪽 — 비서가 `restricted` 의 의미를 알고 정의를 쓰는가.
    //  코드만 고치고 도구 설명을 안 고치면, 비서는 여전히 방어 문장을 쓴다.
    const tool = read("src/core/llm-runtime/capabilities/endpoint-tools-mcp.ts");
    const tellsSelfContained = /본문이 \*\*그대로 시스템 프롬프트\*\*/.test(tool);
    const tellsNoDefensive = /방어 문장은 쓰지 마세요/.test(tool);
    out.push(
      assert(
        "★register_endpoint 설명이 '본문이 곧 system, 자기완결' 을 알린다",
        tellsSelfContained,
        tellsSelfContained ? "안내 확인" : "★비서가 모른 채 정의를 쓴다",
      ),
    );
    out.push(
      assert(
        "★방어 문장을 쓰지 말라고 알린다(맞설 인격이 없다)",
        tellsNoDefensive,
        tellsNoDefensive ? "안내 확인" : "★불필요한 방어 문장이 계속 들어간다",
      ),
    );
    // full 쪽 의미도 같이 말해야 한다 — 한쪽만 설명하면 반대쪽을 오해한다.
    out.push(
      assert(
        "full 이 '비서로서 실행(도구+헌법)' 임을 알린다",
        /full 은 비서로서 실행/.test(tool),
        /full 은 비서로서 실행/.test(tool) ? "안내 확인" : "★full 의미 누락",
      ),
    );

    // ★②-b 등록 **완료 안내**도 같은 말을 하는가 — 사용자가 등록 직후 실제로 읽는 문장이다.
    //  도구 설명만 고치고 여기를 빼면, 방금 만든 사람이 옛 의미로 이해한다(실제로 그랬다).
    const noteSaysPersona = /restricted = 순수 백엔드\(도구 0 \+ 비서 인격 없음\)/.test(tool);
    const noteSaysFull = /full = 비서로서 실행\(전체 도구 \+ 헌법/.test(tool);
    out.push(
      assert(
        "★등록 완료 안내가 두 mode 를 같은 말로 설명한다(도구만 말하지 않는다)",
        noteSaysPersona && noteSaysFull,
        `restricted=${noteSaysPersona} full=${noteSaysFull}`,
      ),
    );

    // ★③ 프리미티브 재사용 — 게이트웨이가 쓰던 것과 같은 필드인가(새 길 X).
    out.push(
      assert(
        "게이트웨이와 같은 프리미티브(systemPromptOverride)를 쓴다",
        (bridge.match(/systemPromptOverride/g) ?? []).length >= 2,
        `${(bridge.match(/systemPromptOverride/g) ?? []).length}곳 사용`,
      ),
    );
    return out;
  },
};
