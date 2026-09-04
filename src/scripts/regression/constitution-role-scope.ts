/**
 * **헌법 역할 범위** — 표시가 도는가, 그리고 **자를 때 안전선을 안 자르는가** (2026-09-04).
 *
 * ★이 검사가 겨누는 실패는 «안 자름» 이 아니라 **«잘못 자름»** 이다. 여는 표시만 있고
 *  닫는 표시가 없으면 그 뒤 전부가 조용히 사라지는데, `SYSTEM.md` 구조상 그건 **안전선이
 *  통째로 빠지는** 모양이다. 그래서 세 칸 모두에서 안전선·Identity 를 **실제로 찾는다**
 *  (문자열이 있나가 아니라 `scopeConstitution` 을 **돌려서**).
 *
 * ★그리고 **메인은 바이트 단위로 종전과 같아야 한다** — 이 기능은 메인에게 무변경이다.
 *  표시를 넣다가 본문을 건드리면 여기서 잡힌다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { scopeConstitution } from "../../core/constitution-scope.js";
import type { TurnKind } from "../../core/llm-runtime/capability-reach.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const KINDS: TurnKind[] = ["main", "manager", "subagent"];

/**
 * 본문이 서로를 가리키는 표현 → 그 대상(절 제목).
 *
 * ★잘라낸 절을 아직 가리키는 문장이 남는 것이 이 기능의 **두 번째 실패 모드**다(첫째는
 *  안전선을 자르는 것). 실제로 초판에서 「스킬화 제안」 불릿이 `§4` 를 가리킨 채 남아
 *  매니저·서브에이전트에게 **없는 절을 인용**하고 있었다 — 이 검사가 잡았다.
 */
const CROSS_REFS: Array<[string, string]> = [
  ["「위임과 규모」", "### 위임과 규모"],
  ["§4 가변영역", "## §4. 가변 영역"],
  ["§2", "## §2. Identity 보존선"],
  ["§3", "## §3. 자기 규칙"],
  ["§5", "## §5. 폴더 모델"],
];

/** 어느 칸에서도 사라지면 안 되는 것 — «아무도 안 볼 때 무너지는 것» 들. */
const MUST_SURVIVE = [
  "파괴적·비가역·외부 영향 작업은 절대 자율 실행 금지",
  "§2. Identity 보존선",
  "사실 왜곡 X",
];

export const check: RegressionCheck = {
  name: "constitution-role-scope",
  guards:
    "서브에이전트가 «자기에게 없는 도구를 쓰라» 는 절을 받던 것 + 그걸 자르다 안전선까지 자르는 것 (등급: 동작)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const repo = path.resolve(import.meta.dirname, "../../..");
    const text = readFileSync(path.join(repo, "SYSTEM.md"), "utf8");

    const scoped = new Map(KINDS.map((k) => [k, scopeConstitution(text, k)]));

    // ① 표시가 문법적으로 성하다 — 깨지면 `scopeConstitution` 이 **원문을 그대로** 돌려주므로
    //    «안 잘림» 으로 조용히 통과한다. 그래서 이상 목록을 직접 본다.
    const bad = scoped.get("main")!.stats.malformed;
    out.push(assert("role 표시가 문법적으로 성하다", bad.length === 0, bad.join(" | ") || "이상 없음"));
    out.push(assert("★role 표시가 실재한다 — 지우면 이 기능이 조용히 무효가 된다", scoped.get("main")!.stats.regions > 0, `구간 ${scoped.get("main")!.stats.regions}개`));

    // ② 안전선·Identity 는 **세 칸 모두**에 남는다.
    for (const k of KINDS) {
      const body = scoped.get(k)!.body;
      for (const must of MUST_SURVIVE) {
        out.push(assert(`★${k} 칸에도 «${must.slice(0, 20)}…» 가 남는다 — 자르기가 안전선을 먹지 않는다`, body.includes(must), body.includes(must) ? "있음" : "사라짐"));
      }
    }

    // ③ 메인은 **표시만 걷힌** 원문과 같다(본문 무변경).
    const mainBody = scoped.get("main")!.body;
    const stripped = text
      .split("\n")
      .filter((l) => !/^[ \t]*<!--\s*\/?role(:[a-z]+)?\s*-->[ \t]*$/.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    out.push(assert("★메인이 받는 본문 == 표시만 걷은 원문 (메인 무영향)", mainBody === stripped, `${Buffer.byteLength(mainBody, "utf8")}B vs ${Buffer.byteLength(stripped, "utf8")}B`));
    out.push(assert("메인에선 한 바이트도 안 잘린다", scoped.get("main")!.stats.droppedBytes === 0, `${scoped.get("main")!.stats.droppedBytes}B`));

    // ④ 사다리가 실제로 단조다: 메인 ≥ 매니저 ≥ 서브에이전트.
    const size = (k: TurnKind): number =>
      Buffer.byteLength(scoped.get(k)!.body, "utf8");
    out.push(assert("범위가 사다리를 지킨다 (main ≥ manager ≥ subagent)", size("main") >= size("manager") && size("manager") >= size("subagent"), `${size("main")} / ${size("manager")} / ${size("subagent")}`));

    // ⑤ 서브에이전트에겐 **실제로 뭔가 걸러진다** — 안 그러면 이 기능은 선언일 뿐이다.
    out.push(assert("서브에이전트에선 실제로 걸러진다 — 표시가 선언이 아니다", scoped.get("subagent")!.stats.droppedBytes > 0, `${scoped.get("subagent")!.stats.droppedBytes}B 걸러짐`));

    // ⑥ **못 쓰는 도구를 시키는 절이 실제로 빠졌나** — 이 기능의 목적 그 자체.
    //    `spawn_agent` 은 `agents: "manager"` 라 서브에이전트 턴엔 등록되지 않는다.
    const subHasDelegation = scoped.get("subagent")!.body.includes("### 위임과 규모");
    out.push(assert("★서브에이전트는 「위임과 규모」를 안 받는다 — 그 칸엔 spawn_agent 이 등록되지 않는다", !subHasDelegation, subHasDelegation ? "아직 실려 있다" : `없음 (그 칸 본문 ${size("subagent")}B)`));
    const mgrHasDelegation = scoped.get("manager")!.body.includes("### 위임과 규모");
    out.push(assert("★매니저는 「위임과 규모」를 받는다 — 팬아웃을 하는 칸이다", mgrHasDelegation, mgrHasDelegation ? `있음 (그 칸 본문 ${size("manager")}B)` : "사라졌다"));

    // ⑦ ★**끊긴 참조가 없다** — 잘라낸 절을 아직 «가리키는» 문장이 남으면, 그 칸의 헌법은
    //    없는 조항을 인용하게 된다. 자르기보다 이쪽이 더 조용한 실패다: 모델은 못 찾는
    //    참조를 만나면 지어내거나 그 문장을 통째로 무시한다.
    //    ★대상을 **본문에서 찾는다**(손 목록이 아니라) — 절 제목이 곧 참조 대상이다.
    for (const k of KINDS) {
      const body = scoped.get(k)!.body;
      for (const [needle, target] of CROSS_REFS) {
        out.push(
          assert(
            `${k}: «${needle}» 를 가리키는 문장이 있으면 그 절도 있다`,
            !body.includes(needle) || body.includes(target),
            body.includes(needle) ? (body.includes(target) ? "둘 다 있음" : "★참조만 있고 대상 없음") : "참조 없음",
          ),
        );
      }
    }

    return out;
  },
};
