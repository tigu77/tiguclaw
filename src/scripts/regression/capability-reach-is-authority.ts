/**
 * 회귀: **능력 등급표가 유일한 권위다** (2026-09-10 정태님: *"역할에 따라서 명확히 도구
 * 필터가 필요하고"* · *"도구 자체가 사용권한이 필요할거같아 — 비서까지만·매니저까지만·전부"*).
 *
 * 사고: `REACH` 는 *"빠뜨림이 조용하지 않게"* 만든 표인데, 어댑터에 **«항상 켜지는 브리지
 * 여덟»** 이라는 목록이 따로 있어 그 여덟이 표를 **한 번도 안 거쳤다.** 증거: 표를
 * `session-tools: "main"` 으로 바꿔도 서브에이전트 도구 수가 **1개도 안 줄었다**(실측).
 * 그리고 그중 둘(`file-ops`·`todo`)은 **표에 아예 없었다** — 여덟을 표로 돌리자 타입체커가
 * 즉시 잡았다.
 *
 * ★실피해: 위임받아 **1턴** 도는 서브에이전트가 `rename_session`·`archive_session` 으로
 *  **사용자의 대화를 이름 바꾸거나 보관 처리**할 수 있었다. 크기가 아니라 권한이다.
 * ★단위는 **능력(서버)** 이지 도구가 아니다 — 도구마다 등급을 달면 키가 55개가 되고 그건
 *  손으로 관리하는 목록이다. 섞인 묶음이 나오면 등급이 아니라 **묶음을 쪼갠다**.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const ADAPTERS = [
  "src/core/llm-runtime/adapters/openai-codex-oauth.ts",
  "src/core/llm-runtime/adapters/claude-agent-sdk.ts",
  "src/core/llm-runtime/adapters/openai-agents-sdk.ts",
] as const;

export const check: RegressionCheck = {
  name: "capability-reach-is-authority",
  guards:
    "능력 등급표(REACH)가 있는데 어댑터의 «항상 켜지는» 목록이 그 표를 안 거쳐, 위임받은 " +
    "서브에이전트가 사용자의 대화를 이름 바꾸거나 보관 처리할 수 있던 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { REACH, turnKindOf, reaches } = await import(
      "../../core/llm-runtime/capability-reach.js"
    );

    // ① 세 단계가 그대로 있고, 사다리가 의도대로 돈다 — 동작으로 잰다.
    const main = turnKindOf({});
    const manager = turnKindOf({ workerDepth: 1 });
    const sub = turnKindOf({ subagentDepth: 1 });
    out.push(
      assert(
        "★★사다리가 «비서까지만 → 매니저까지만 → 전부» 로 돈다 — `main` 전용은 매니저·서브에 안 닿고, `subagent` 는 셋 다 닿는다",
        reaches("session-tools", main) &&
          !reaches("session-tools", manager) &&
          !reaches("session-tools", sub) &&
          reaches("memory", sub) &&
          reaches("agents", manager) &&
          !reaches("agents", sub),
        JSON.stringify({
          "session-tools": [main, manager, sub].map((t) => reaches("session-tools", t)),
          agents: [main, manager, sub].map((t) => reaches("agents", t)),
          memory: [main, manager, sub].map((t) => reaches("memory", t)),
        }),
      ),
    );

    // ② 사용자의 대화를 고치는 도구는 **위임에 안 닿는다** — 이번 사고의 본체.
    out.push(
      assert(
        "★★`session-tools`(rename·archive·list_sessions)가 **비서까지만** 닿는다 — 위임받아 1턴 도는 쪽이 사용자의 대화를 고칠 이유가 없다(크기가 아니라 권한이다)",
        REACH["session-tools"] === "main",
        `선언=${REACH["session-tools"]}`,
      ),
    );

    // ③ **표를 안 거치는 등록이 없다** — 이게 재발 방지의 본체다.
    for (const f of ADAPTERS) {
      const src = stripComments(readSourceSync(f));
      // ★«항상 켜지는 목록이 없다» 는 단언은 뺐다 — 나머지 일곱은 전부 `subagent` 라
      //  게이트가 오늘 아무것도 안 바꾸고, 한 어댑터에만 달면 **비대칭**만 생긴다.
      //  재는 것은 «등급이 갈리는 능력에 게이트가 있나» 다.
      out.push(
        assert(
          `★${f.split("/").pop()}: \`session-tools\` 등록이 \`reaches\` 를 거친다`,
          /reaches\("session-tools"/.test(src),
          /reaches\("session-tools"/.test(src) ? "게이트 있음" : "★무조건 등록",
        ),
      );
    }

    // ④ 표에 빠진 능력이 없다 — 어댑터가 부르는 이름은 전부 표에 있어야 한다.
    const called = new Set<string>();
    for (const f of ADAPTERS) {
      for (const m of stripComments(readSourceSync(f)).matchAll(/reaches\(\s*"([a-z-]+)"/g)) {
        called.add(m[1] ?? "");
      }
    }
    const missing = [...called].filter((n) => !(n in REACH));
    out.push(
      assert(
        "★어댑터가 부르는 능력 이름이 **전부 표에 있다** — 없으면 타입 에러가 나야 하고, 그게 이 표의 존재 이유다",
        missing.length === 0,
        missing.length === 0 ? `${called.size}종 전부 표에 있음` : `★없음: ${missing.join(", ")}`,
      ),
    );
    return out;
  },
};
