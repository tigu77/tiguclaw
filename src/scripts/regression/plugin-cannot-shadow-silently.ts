/**
 * 회귀: **플러그인이 빌트인 능력을 조용히 덮지 않는다** (2026-09-09 정태님).
 *
 * 사고 전 상태: `plugins/<X>/skills/harness/` 를 두면 이름이 그냥 `harness` 라
 * 빌트인 `harness` 를 **덮는다**(우선순위 project > user > plugin > builtin). 경고 한 줄
 * 없다. 격리가 0인 현행에서 그건 **능력 바꿔치기가 조용히 되는 자리**다.
 *
 * ★user·project 가 덮는 것은 **의도**다 — 사용자가 자기 홈에 같은 이름을 두면 그게
 *  이기는 «기본 번들 + 홈 오버라이드» 모델이다. **플러그인만 «남의 것»** 이다.
 * ★**막지 않고 보이게 한다.** 막으면 이름이 겹치는 정당한 플러그인이 통째로 죽는다.
 *  이 레포의 처방은 늘 그것이었다(하드 게이트 금지 · 관측은 필수).
 * ★네 축(스킬·에이전트·커맨드·엔드포인트)이 **같은 함수**를 쓴다 — 축마다 손으로 적으면
 *  다섯 번째가 왔을 때 조용히 빠진다([[feedback_hand_maintained_lists]]). 그래서 판정도
 *  «네 자리가 그 함수를 부르는가» 로 센다.
 * ★이름공간 표기(`플러그인:이름`)는 다음 판이다 — 그건 `invoke_skill`·인덱스·문서가 같이
 *  움직이는 계약 변경이다. 지금은 «조용히 덮이는 것» 만 닫는다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "plugin-cannot-shadow-silently",
  guards:
    "서드파티 플러그인이 폴더 이름만 빌트인과 같게 지어도 그 능력을 덮어쓰던 것 — " +
    "경고 한 줄 없이. 격리 0인 현행에서 능력 바꿔치기가 조용히 되는 자리였다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { dedupeWithShadows } = await import(
      "../../core/llm-runtime/capabilities/dedup-by-source.js"
    );

    // ① 플러그인이 빌트인을 덮으면 **보고된다** — 동작으로 잰다.
    const r1 = dedupeWithShadows([
      { name: "harness", source: "builtin" as const },
      { name: "harness", source: "plugin" as const, pluginId: "evil" },
    ]);
    out.push(
      assert(
        "★★플러그인이 빌트인과 같은 이름을 쓰면 **덮은 사실이 보고된다** — 조용히 덮이면 사용자는 자기 비서의 능력이 바뀐 줄 모른다",
        r1.shadowed.length === 1 && r1.shadowed[0]?.name === "harness" && r1.shadowed[0]?.by === "evil",
        JSON.stringify(r1.shadowed),
      ),
    );
    out.push(
      assert(
        "★그래도 **막지는 않는다** — 막으면 이름이 겹치는 정당한 플러그인이 통째로 죽는다. 이기는 쪽은 종전대로 플러그인이다",
        r1.kept.length === 1 && (r1.kept[0] as { source: string }).source === "plugin",
        JSON.stringify(r1.kept),
      ),
    );

    // ② user·project 오버라이드는 **의도**다 — 보고하지 않는다.
    const r2 = dedupeWithShadows([
      { name: "harness", source: "builtin" as const },
      { name: "harness", source: "user" as const },
    ]);
    const r3 = dedupeWithShadows([
      { name: "code-review", source: "builtin" as const },
      { name: "code-review", source: "project" as const },
    ]);
    out.push(
      assert(
        "★사용자·프로젝트가 빌트인을 덮는 것은 **경고하지 않는다** — 그건 «기본 번들 + 홈 오버라이드» 라는 의도된 모델이고, 경고하면 정상 사용이 매번 시끄러워진다",
        r2.shadowed.length === 0 && r3.shadowed.length === 0,
        JSON.stringify({ user: r2.shadowed, project: r3.shadowed }),
      ),
    );

    // ③ 네 축이 **그 함수를 실제로 부르는가** — 한 축만 빠져도 그 축은 조용해진다.
    const axes = [
      ["skill", "src/core/llm-runtime/capabilities/skill-registry.ts"],
      ["agent", "src/core/llm-runtime/capabilities/agent-registry.ts"],
      ["command", "src/core/entry/command-registry.ts"],
      ["endpoint", "src/core/entry/endpoint-registry.ts"],
    ] as const;
    for (const [kind, file] of axes) {
      const src = stripComments(readSourceSync(file));
      out.push(
        assert(
          `★${kind} 레지스트리가 덮임을 **알린다**(\`warnShadowed\`) — 한 축만 빠져도 그 축은 조용히 덮인다`,
          /warnShadowed\(/.test(src) && /dedupeWithShadows\(/.test(src),
          `warn=${/warnShadowed\(/.test(src)} · dedup=${/dedupeWithShadows\(/.test(src)}`,
        ),
      );
    }

    // ④ 옛 이름을 그대로 쓰는 자리가 남아 있지 않은가(그 자리는 조용하다).
    const stale = axes.filter(([, f]) => /dedupeBySource\(/.test(stripComments(readSourceSync(f))));
    out.push(
      assert(
        "★네 축 어디에도 **알리지 않는 옛 경로**가 남아 있지 않다 — 하나라도 남으면 그 축만 조용히 덮인다",
        stale.length === 0,
        stale.length === 0 ? "옛 경로 0" : `★${stale.map(([k]) => k).join(", ")}`,
      ),
    );
    return out;
  },
};
