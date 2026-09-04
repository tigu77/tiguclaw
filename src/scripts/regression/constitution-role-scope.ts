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

    // ─── ⑧ ★**제품 경로를 지난다** (2026-09-04 적대 검토 P-5) ─────────────────
    //  종전 단언 32건이 전부 `scopeConstitution` 을 **직접** 불렀다. 그래서 어댑터가 쓰는
    //  조립 경로(`buildContextSlots`→`splitSystemContext`)에서 그 호출을 **지워도**,
    //  칸을 **상수로 고정해도**(= 비서가 자식 헌법을 받는다) 스위트 2,766건이 전부 초록이었다.
    //  **부품은 검사되는데 이음매가 없었다** — 이 레포가 반복해서 데인 그 모양이다.
    const { splitSystemContext } = await import("../../core/prompt-assembly.js");
    const base = {
      system: text, env: "", agent: "", agentWarn: "", convoContext: "",
      memoryIndex: "", memorySnippet: "", skillIndex: "", agentIndex: "",
    };
    const stableFor = (roleSource: Record<string, number>): string =>
      splitSystemContext({ ...base, roleSource }).stable;
    const mainStable = stableFor({});
    const subStable = stableFor({ subagentDepth: 1 });
    const mgrStable = stableFor({ workerDepth: 1 });
    out.push(
      assert(
        "★조립 경로(splitSystemContext)가 실제로 헌법을 스코프한다 — 이음매 검사",
        subStable.length < mainStable.length && mgrStable.length < mainStable.length,
        `main ${mainStable.length} / manager ${mgrStable.length} / subagent ${subStable.length}`,
      ),
    );
    out.push(
      assert(
        "★조립 경로에서 서브에이전트는 「위임과 규모」를 안 받는다(칸이 상수로 고정되면 여기서 운다)",
        !subStable.includes("### 위임과 규모") && mainStable.includes("### 위임과 규모"),
        `main=${mainStable.includes("### 위임과 규모")} sub=${subStable.includes("### 위임과 규모")}`,
      ),
    );
    // ★**매니저도 본다** (2026-09-04 2R P-8). 첫 판은 `mgrStable.length < mainStable.length`
    //  하나뿐이었는데, 그 부등식은 **과잉 스코프에서도 참**이다 — 매니저를 자식 수준으로
    //  깎아도 통과했고, 그러면 **매니저가 「위임과 규모」를 통째로 잃는다**(팬아웃을 하는
    //  유일한 칸인데 팬아웃 교리가 사라진다). 세 칸 중 둘만 덮은 이음매였다.
    out.push(
      assert(
        "★조립 경로에서 매니저는 「위임과 규모」를 받는다(과잉 스코프면 여기서 운다)",
        mgrStable.includes("### 위임과 규모") && !subStable.includes("### 위임과 규모"),
        `manager=${mgrStable.includes("### 위임과 규모")} sub=${subStable.includes("### 위임과 규모")}`,
      ),
    );
    out.push(
      assert(
        "★조립 경로에서 비서는 전문을 받는다 — 칸을 자식으로 고정하면 비서 헌법이 잘린다",
        mainStable.includes("## §4. 가변 영역") && !subStable.includes("## §4. 가변 영역"),
        `main §4=${mainStable.includes("## §4. 가변 영역")} sub §4=${subStable.includes("## §4. 가변 영역")}`,
      ),
    );

    // ★**fail-safe 를 실제로 돌려 본다** (2026-09-04 3R P-8). 「짝이 안 맞으면 원문을 통째로
    //  돌려준다 — 실패는 크게, 안전한 쪽으로」가 이 파서의 핵심 안전 결정인데, 오늘
    //  `SYSTEM.md` 가 성해서 `malformed === 0` 이라 **그 분기가 한 번도 실행되지 않았다.**
    //  검토자가 fail-safe 를 «자른 결과를 그대로 반환» 으로 바꿨는데 2,791건이 초록이었다.
    //  ★중요한 건 **여기서 자르면 안 된다**는 것이다: 표시가 깨지는 흔한 모양은 «닫는 표시
    //   누락» 이고, 그러면 그 뒤 전부(=안전선 포함)가 조용히 사라진다.
    const BROKEN = [
      ["닫는 표시 누락", "머리\n<!--role:main-->\n비서용\n안전선\n"],
      ["짝 없는 닫는 표시", "머리\n<!--/role-->\n뒤\n"],
      ["중첩", "머리\n<!--role:main-->\n<!--role:manager-->\n안\n<!--/role-->\n"],
    ] as const;
    for (const [why, text] of BROKEN) {
      const r = scopeConstitution(text, "subagent");
      out.push(
        assert(
          `★표시가 깨지면(${why}) **원문을 통째로** 돌려준다 — 조용히 자르면 안전선이 사라진다`,
          r.body === text && r.stats.malformed.length > 0 && r.stats.droppedBytes === 0,
          `본문 ${r.body.length}/${text.length}자 · malformed ${r.stats.malformed.length}건 · 버린 ${r.stats.droppedBytes}B`,
        ),
      );
    }

    // ─── ⑨ ★안전선은 **구간**으로 지킨다 (적대 검토 P-4) ──────────────────────
    //  ②의 문자열 셋은 **손 목록**이라, 표제를 남기고 **절차만** 도려내면 통과했다
    //  (실측: 매니저·서브에이전트에서 «명시적 "응/해도 돼" 를 받은 뒤에만» 이 사라졌는데 초록).
    //  ★그래서 바늘이 아니라 **구간의 바이트**를 본다 — 이 절들은 어느 칸에서도 안 줄어든다.
    const sectionBytes = (body: string, header: string): number => {
      const i = body.indexOf(header);
      if (i < 0) return -1;
      const j = body.indexOf("\n## ", i + 1);
      const k = body.indexOf("\n### ", i + 1);
      const end = Math.min(...[j, k].filter((x) => x > 0).concat([body.length]));
      return Buffer.byteLength(body.slice(i, end), "utf8");
    };
    // §2·§3 은 통째로 불가침 — 어느 칸에서도 바이트가 같아야 한다.
    for (const header of ["## §2. Identity 보존선", "## §3. 자기 규칙"]) {
      const sizes = KINDS.map((k) => sectionBytes(scoped.get(k)!.body, header));
      out.push(
        assert(
          `★«${header}» 구간이 세 칸에서 바이트가 같다(표제만 남기고 절차를 도려낼 수 없다)`,
          sizes.every((n) => n > 0 && n === sizes[0]),
          sizes.join(" / "),
        ),
      );
    }
    // ★안전선은 **바이트 동일을 요구할 수 없다** — 그 안에 `register_endpoint`(endpoints:"main")
    //  처럼 그 칸에 **도구가 없는** 불릿이 정당하게 있다. 그렇다고 손 목록으로 돌아가면
    //  검토가 뚫은 «표제만 남기고 절차 도려내기» 를 다시 놓친다.
    //  ★그래서 **빠진 줄마다 근거를 요구한다**: 자식에게서 사라진 안전선 문장은 반드시
    //   «그 칸에 등록되지 않는 도구» 를 언급해야 한다. 근거 없이 사라지면 빨간불이다.
    // ★**손 목록을 없앤다** (2026-09-04 2R P-9). 첫 판은 이름 여섯을 손으로 적었고,
    //  그건 **고무도장**이었다 — 안전선의 승인 절차를 도려내고 끝에 무관한 낱말 하나
    //  («(`update_self` 시에도 동일.)»)를 붙이자 «근거 있음» 으로 통과했다. 반대로 목록에
    //  없는 진짜 main 전용 도구(`steer_worker`)를 근거로 대면 **틀린 이유로 빨간불**이었다.
    //  오탐과 미탐이 같은 방향으로 민다 — 빨간불을 본 사람이 목록에 이름을 더하면 그게
    //  고무도장을 하나 늘리는 행위다([[feedback_hand_maintained_lists]]).
    //  ★그래서 **정본에서 뽑는다**: `REACH` 가 그 칸에 안 주는 능력의 서버 파일에서
    //   `tool("<이름>"` 을 읽는다. 도구가 늘어도 목록을 안 고친다.
    const { REACH, reaches } = await import("../../core/llm-runtime/capability-reach.js");
    const capDir = path.join(repo, "src/core/llm-runtime/capabilities");
    const { readdirSync } = await import("node:fs");
    const capFiles = readdirSync(capDir).filter((f) => f.endsWith(".ts"));
    // ★능력 → 팩토리 이름은 **어댑터가 이미 짝지어 놨다** — 그 줄을 읽는다(이름 추측 금지:
    //  `endpoints` ↔ `endpoint-tools-mcp.ts` 처럼 표기가 안 맞는 게 넷이다).
    const adapterSrc = readFileSync(
      path.join(repo, "src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
      "utf8",
    );
    const capToFactory = new Map<string, string>();
    for (const m of adapterSrc.matchAll(
      /reaches\("([a-z-]+)", turnKind\)[\s\S]{0,80}?\b(create[A-Za-z]+)\(/g,
    )) capToFactory.set(m[1]!, m[2]!);
    /** 그 팩토리를 **내보내는 파일**의 `tool("이름"` 을 전부 모은다. */
    const toolsOfFactory = (factory: string): string[] => {
      for (const f of capFiles) {
        const src = readFileSync(path.join(capDir, f), "utf8");
        if (!src.includes(`export const ${factory}`)) continue;
        return [...src.matchAll(/\btool\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]!);
      }
      return [];
    };
    out.push(
      assert(
        "능력→도구 이름을 **소스에서 파생**한다(손 목록 없음 — 전제)",
        capToFactory.size >= 5 && [...capToFactory.values()].some((f) => toolsOfFactory(f).length > 0),
        `능력 ${capToFactory.size}개 매핑`,
      ),
    );
    /** 이 칸이 **못 받는** 능력에 속한 도구 이름 전부. */
    const unreachableTools = (turn: TurnKind): Set<string> => {
      const out2 = new Set<string>();
      for (const [cap, factory] of capToFactory) {
        if (reaches(cap as keyof typeof REACH, turn)) continue;
        for (const n of toolsOfFactory(factory)) out2.add(n);
      }
      return out2;
    };
    const safetyLines = (k: TurnKind): string[] => {
      const b = scoped.get(k)!.body;
      const i = b.indexOf("### 안전선");
      if (i < 0) return [];
      const j = b.indexOf("\n## ", i + 1);
      return b.slice(i, j > 0 ? j : b.length).split("\n").filter((l) => l.trim() !== "");
    };
    const mainSafety = safetyLines("main");
    for (const k of ["manager", "subagent"] as TurnKind[]) {
      const kept = new Set(safetyLines(k));
      const dropped = mainSafety.filter((l) => !kept.has(l));
      // ★근거는 **둘 다** 있어야 한다 — 낱말 하나면 고무도장이 된다(2026-09-04 2R P-9:
      //  승인 절차를 도려내고 끝에 «(`update_self` 시에도 동일.)» 를 붙이자 통과했다).
      //   ①**완결된 불릿**이어야 한다(`- ` 로 시작) — 정당한 예외는 «그 도구가 주어인 항목»
      //     통째다. 불릿 **조각**을 도려내는 것은 언제나 도려내기다. 이건 손 목록이 아니라
      //     **구조**라, 새 낱말이 생겨도 안 낡는다.
      //   ②그 칸이 **못 받는 도구**를 언급해야 한다(위 파생 집합).
      const cant = unreachableTools(k);
      //   ③★그 도구가 불릿의 **주어**여야 한다 — 어디든 «언급» 이면 충분하던 것을 조인다
      //     (2026-09-04 3R P-2). 종전 두 조건은 **불릿 하나 값**이었다: 무관한 안전선 불릿
      //     끝에 «(`register_endpoint` 시에도 동일.)» 를 붙이고 통째로 가두면 통과했고,
      //     그러면 `Bash`·`rm` 을 쥔 자식이 «파괴적 작업 금지» 표제만 받고 **어떻게 승인을
      //     받는가**를 못 받는다. 정당한 예외(`register_endpoint` 불릿)는 도구 이름이
      //     **머리**에 온다 — 그게 «그 도구에 대한 규칙» 의 모양이다. 뒤에 붙인 한 조각은
      //     주어가 아니다.
      const SUBJECT_HEAD = 60;
      const unjustified = dropped.filter((l) => {
        const isWholeBullet = /^\s*-\s/.test(l);
        const head = l.trim().slice(0, SUBJECT_HEAD);
        const isSubject = [...cant].some((t) => head.includes(`\`${t}\``));
        return !(isWholeBullet && isSubject);
      });
      out.push(
        assert(
          `★${k} 안전선에서 빠진 문장은 전부 «그 칸에 없는 도구» 때문이다(근거 없는 실종 금지)`,
          unjustified.length === 0,
          dropped.length === 0
            ? "빠진 문장 0"
            : `빠짐 ${dropped.length}줄 · 근거없음 ${unjustified.length}줄${unjustified.length ? " → " + unjustified[0]!.trim().slice(0, 46) : ""}`,
        ),
      );
    }

    return out;
  },
};
