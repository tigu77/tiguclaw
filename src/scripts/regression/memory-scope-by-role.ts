/**
 * 회귀: **비서·매니저·에이전트가 같은 기억 뭉치를 받지 않는다** (2026-09-03, 정태님 제안).
 *
 * 정태님: *"비서·매니저·에이전트가 다 똑같은 입력토큰을 사용할 이유가 있을까. 코어만 같이
 * 쓰고 각자 필요한 것만 추가하는 거지."*
 *
 * ★실측이 근거다. 자식은 프롬프트 상수의 **95.8%를 물려받고**(depth0 95,426B /
 *  depth1 91,394B), 그중 가장 큰 조각이 **메모리 인덱스 32,417B** 다 — 그건 «사용자에 관한
 *  사실 목록» 이라 `alpha.js` 버그를 고치는 자식에게 필요할 근거가 약하다. 그리고 위임 런에서
 *  **자식이 입력 토큰의 66%**를 쓴다(자식 2,054,963 / 메인 1,068,864).
 *
 * ★**인덱스와 스니펫을 가르는 것**이 이 판정의 핵심이다. 목록(전체)은 걷고, 검색된 것
 *  (이번 입력 기준 5건)은 남긴다 — 통째로 끊으면 자식이 맥락을 잃고 되묻거나 엉뚱하게 가고,
 *  **그건 토큰보다 비싸다.** 「필요하면 닿는다」가 유지되는지가 이 회귀의 진짜 대상이다.
 *
 * ★판정을 **코어 한 곳**에 둔 이유: 종전엔 어댑터 셋이 `input.leanMemory === true` 를 각자
 *  복제했다. 한 곳에서 파생시키지 않으면 새 규칙이 한 어댑터에만 들어가 **조용히 갈린다**
 *  (LLM-agnostic 위반은 무소음이다 — 사용자는 어댑터를 바꿨을 때 답이 달라지는 걸로만 안다).
 *
 * 등급: **동작**(판정 함수를 실제로 실행) + **배선**(세 어댑터가 그 판정을 쓰는가).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryScopeFor } from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTERS = [
  "claude-agent-sdk.ts",
  "openai-agents-sdk.ts",
  "openai-codex-oauth.ts",
] as const;

export const check: RegressionCheck = {
  name: "memory-scope-by-role",
  guards:
    "비서·매니저·에이전트가 같은 기억 뭉치(인덱스 32.4KB)를 받아 자식이 입력 토큰의 66%를 쓰던 것 + 그 판정이 어댑터 셋에 복제돼 있어 새 규칙이 한 곳에만 들어가면 조용히 갈리던 것(2026-09-03 정태님 제안)",
  run: async (): Promise<Assertion[]> => {
    const main = memoryScopeFor({});
    const sub = memoryScopeFor({ subagentDepth: 1 });
    const worker = memoryScopeFor({ workerDepth: 1 });
    const lean = memoryScopeFor({ leanMemory: true });
    const leanChild = memoryScopeFor({ leanMemory: true, subagentDepth: 1 });
    const srcs = ADAPTERS.map((f) => ({
      f,
      s: readFileSync(path.join(REPO, "src/core/llm-runtime/adapters", f), "utf8"),
    }));
    const uses = srcs.filter((x) => /memoryScopeFor\(input\)/.test(x.s));
    const dupes = srcs.filter((x) => /const leanMemory = input\.leanMemory === true;/.test(x.s));

    return [
      assert(
        "★비서(depth 0)는 **전부** 받는다 — 여기가 깨지면 사용자가 자기 기억을 잃는다",
        main.index && main.snippet,
        `index=${String(main.index)} snippet=${String(main.snippet)}`,
      ),
      assert(
        "★★서브에이전트는 **목록을 안 받는다** — 32.4KB 상수가 자식마다 재적재되던 자리다",
        !sub.index,
        `index=${String(sub.index)} (false 여야)`,
      ),
      assert(
        "★★매니저도 같다 — 종전엔 `worker-registry` 가 lean 장치를 **아예 안 지났다**",
        !worker.index,
        `index=${String(worker.index)} (false 여야)`,
      ),
      assert(
        "★★★자식도 **검색은 받는다** — 통째로 끊으면 맥락을 잃고 되묻는다(토큰보다 비싸다)",
        sub.snippet && worker.snippet,
        `sub=${String(sub.snippet)} worker=${String(worker.snippet)} (둘 다 true 여야)`,
      ),
      assert(
        "★기존 `leanMemory`(tools:none 선언)는 **종전대로 둘 다** 끊는다 — 의미를 안 바꿨다(회귀 0)",
        !lean.index && !lean.snippet && !leanChild.index && !leanChild.snippet,
        `lean=${JSON.stringify(lean)} leanChild=${JSON.stringify(leanChild)}`,
      ),
      assert(
        "★★세 어댑터가 **모두** 그 판정을 쓴다 — 하나만 빠지면 그 어댑터의 자식만 다르게 굴고 무소음이다",
        uses.length === ADAPTERS.length,
        `쓰는 어댑터 ${uses.length}/${ADAPTERS.length}: ${uses.map((x) => x.f).join(", ") || "(없음)"}`,
      ),
      assert(
        "★복제된 옛 판정이 남아 있지 않다 — 남으면 판정이 두 곳이 되고 갈린다",
        dupes.length === 0,
        dupes.length === 0 ? "복제 0" : `★복제 남음: ${dupes.map((x) => x.f).join(", ")}`,
      ),
    ];
  },
};
