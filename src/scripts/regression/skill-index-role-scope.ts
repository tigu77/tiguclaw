/**
 * 회귀: **스킬 인덱스도 역할을 탄다** — 그리고 **발견은 안 막는다** (2026-09-04).
 *
 * 사고 아님, 설계 확인: 번들 스킬 다수는 트리거가 *«사용자가 이렇게 말하면»* 인데
 * **자식에겐 사용자 발화가 없다**(부모가 준 지시 한 건뿐). 그 설명을 매 호출 싣는 건
 * 크기 이전에 **발동 조건이 성립하지 않는 텍스트**를 보내는 것이다.
 *
 * ★이 검사가 겨누는 실패는 «안 줄임» 이 아니라 **«능력을 잃음»** 이다:
 *  ①`find_skills` 가 같이 걸러지면 자식은 그 스킬을 **찾을 수도** 없게 된다(인덱스는
 *   «미리 알려주는 것» 이고 검색은 «닿는 길» 이다 — 후자까지 막으면 그건 다른 변경이다).
 *  ②헌법이 **이름으로 가리키는** 스킬(`code-review`·`verify`)이 자식에서 사라지면
 *   헌법이 없는 것을 인용하게 된다(헌법 역할 분할에서 겪은 «끊긴 참조» 와 같은 모양).
 *  ③`reach` 오타 하나로 스킬이 조용히 안 보이게 되는 것.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverSkills,
  formatSkillIndex,
  type Skill,
} from "../../core/llm-runtime/capabilities/skill-registry.js";
import type { TurnKind } from "../../core/llm-runtime/capability-reach.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const KINDS: TurnKind[] = ["main", "manager", "subagent"];
const B = (s: string): number => Buffer.byteLength(s, "utf8");

/** 헌법이 **이름으로** 가리키는 스킬 — 자식에서 사라지면 헌법이 없는 것을 인용한다. */
const NAMED_BY_CONSTITUTION = ["code-review", "verify"];

const mk = (name: string, reach: Skill["reach"]): Skill => ({
  name,
  description: `설명 ${name}`,
  filePath: `/x/${name}/SKILL.md`,
  baseDir: `/x/${name}`,
  source: "builtin",
  disableModelInvocation: false,
  reach,
});

export const check: RegressionCheck = {
  name: "skill-index-role-scope",
  guards:
    "자식이 «사용자가 이렇게 말하면» 트리거인 스킬 설명을 매 호출 받던 것 + 그걸 거르다 발견 경로(find_skills)나 헌법이 이름으로 가리키는 스킬까지 잃는 것 (등급: 동작)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ─── 순수 판정 — 주입한 스킬로 사다리를 직접 돌린다 ───────────────────
    const fixture = [mk("m", "main"), mk("g", "manager"), mk("s", "subagent")];
    const seen = (turn: TurnKind): string[] =>
      fixture.filter((f) => formatSkillIndex([f], turn) !== "").map((f) => f.name);
    out.push(assert("main 은 전부 본다", seen("main").join() === "m,g,s", seen("main").join()));
    out.push(assert("manager 는 main 전용을 뺀다", seen("manager").join() === "g,s", seen("manager").join()));
    out.push(assert("subagent 는 자기 것만", seen("subagent").join() === "s", seen("subagent").join()));

    // ★`turn` 생략 = 종전 그대로(전부) — 옛 호출부가 안 깨진다.
    out.push(
      assert(
        "turn 을 안 주면 종전대로 전부 실린다(옛 호출부 무영향)",
        formatSkillIndex(fixture) === formatSkillIndex(fixture, "main"),
        `${B(formatSkillIndex(fixture))}B vs ${B(formatSkillIndex(fixture, "main"))}B`,
      ),
    );

    // ★모르는 값은 **기본(전부)** 으로 떨어진다 — 오타로 스킬이 조용히 사라지면 안 된다.
    const typo = { ...mk("t", "subagent"), reach: "mian" as unknown as Skill["reach"] };
    out.push(
      assert(
        "★reach 오타는 «전부에게 실림» 쪽으로 떨어진다(조용한 실종 금지)",
        formatSkillIndex([typo], "subagent") !== "",
        formatSkillIndex([typo], "subagent") === "" ? "사라짐" : "실림",
      ),
    );

    // ─── 실물 번들로 — 홈·프로젝트 없는 빈 cwd(= 보통 사용자) ──────────────
    const home = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-skillscope-"));
    const emptyCwd = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-cwd-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home;
    let bundled: Skill[];
    try {
      bundled = [...(await discoverSkills(emptyCwd))];
    } finally {
      if (prevHome !== undefined) process.env.TIGUCLAW_HOME = prevHome;
    }
    out.push(assert("번들 스킬이 실제로 발견된다(0이면 아래가 전부 공허하다)", bundled.length > 0, `${bundled.length}개`));

    const size = (t: TurnKind): number => B(formatSkillIndex(bundled, t));
    out.push(
      assert(
        "사다리가 단조다 (main ≥ manager ≥ subagent)",
        size("main") >= size("manager") && size("manager") >= size("subagent"),
        `${size("main")} / ${size("manager")} / ${size("subagent")}`,
      ),
    );
    out.push(
      assert(
        "★main 은 바이트가 안 변한다 — 이 기능은 비서에게 무변경",
        size("main") === B(formatSkillIndex(bundled)),
        `${size("main")}B vs ${B(formatSkillIndex(bundled))}B`,
      ),
    );
    out.push(
      assert(
        "자식에선 실제로 줄어든다 — 표시가 선언이 아니다",
        size("subagent") < size("main"),
        `${size("subagent")}B < ${size("main")}B`,
      ),
    );

    // ★헌법이 이름으로 가리키는 스킬은 **세 칸 모두**에 남는다.
    for (const t of KINDS) {
      const idx = formatSkillIndex(bundled, t);
      for (const n of NAMED_BY_CONSTITUTION) {
        const present = bundled.some((s) => s.name === n) ? idx.includes(`- ${n}:`) : true;
        out.push(
          assert(
            `★${t} 인덱스에 «${n}» 이 남는다 — 헌법이 이름으로 가리키는 스킬이다`,
            present,
            present ? "있음" : "사라짐 — 헌법이 없는 것을 인용하게 된다",
          ),
        );
      }
    }

    // ★**검색도 같은 규칙을 탄다** (2026-09-04 정태님: *"비서도 마찬가지고"*).
    //  첫 판은 검색을 안 걸렀는데 앞뒤가 안 맞았다 — `reach: main` 의 근거가 *"그 칸에선
    //  절차를 완료할 수 없다"* 인데, 완료 못 할 절차를 검색에 띄우면 자식이 본문을 로드하고
    //  따라가다 막힌다(막다른 길). 규칙은 하나: **모든 칸이 자기 칸 것만 본다.**
    //  ★탈출구는 `invoke_skill(name)` — 거긴 게이트가 없다(아래 단언이 지킨다).
    const registrySrc = await (await import("node:fs")).promises.readFile(
      path.resolve(import.meta.dirname, "../../core/llm-runtime/capabilities/skill-registry.ts"),
      "utf8",
    );
    const findBody = registrySrc.slice(registrySrc.indexOf('"find_skills"'));
    const findHead = findBody.slice(0, findBody.indexOf("okText(") + 1 || 3000);
    out.push(
      assert(
        "★find_skills 도 자기 칸 것만 돌려준다(인덱스와 같은 규칙 — 막다른 길 금지)",
        /turnReaches\(/.test(findHead),
        /turnReaches\(/.test(findHead) ? "칸으로 거른다" : "★전부 반환 — 완료 못 할 절차를 띄운다",
      ),
    );
    // ★그리고 **`invoke_skill` 은 안 거른다** — 부모가 이름을 대면 닿아야 한다. 여기까지
    //  막으면 표시가 잘못 붙은 순간 되돌릴 길이 사라진다(자동 발견만 막고 명시 지정은 남긴다).
    const invokeBody = registrySrc.slice(registrySrc.indexOf('"invoke_skill"'));
    const invokeHead = invokeBody.slice(0, invokeBody.indexOf('"find_skills"') + 1 || 3000);
    out.push(
      assert(
        "★invoke_skill 은 reach 로 안 막는다 — 부모가 이름을 대면 닿는다(탈출구)",
        !/turnReaches\(/.test(invokeHead),
        /turnReaches\(/.test(invokeHead) ? "★탈출구까지 막혔다" : "이름 지정은 통과",
      ),
    );

    // ★**가려진 개수를 알리지 않는다** (2026-09-04 정태님 반문). 자식이 그 정보로 할
    //  행동이 없다 — 탈출구(`invoke_skill(name)`)는 **부모가** 쓰는 것이고, 필요가 생기면
    //  자식은 «필요» 를 보고하면 된다(헌법이 이미 시킨다). 행동으로 안 이어지는 정보를
    //  매 호출 싣지 않는다. ★한 판 전엔 반대로 했다가 되돌렸으므로 **되돌아가지 않게** 세운다.
    const subIdx = formatSkillIndex(bundled, "subagent");
    out.push(
      assert(
        "★자식 인덱스에 «가려진 N개» 안내가 없다(행동으로 안 이어지는 정보)",
        !subIdx.includes("이 밖에"),
        subIdx.includes("이 밖에") ? "★안내가 다시 붙었다" : "없음",
      ),
    );
    out.push(
      assert(
        "자식 인덱스는 자기 칸 스킬 목록 그 자체다(군더더기 0)",
        subIdx.split("\n- ").length - 1 === bundled.filter((s) => formatSkillIndex([s], "subagent") !== "").length,
        `항목 ${subIdx.split("\n- ").length - 1}개`,
      ),
    );

    // ★**열거가 가능하다** — `find_skills` 에 query 를 안 줘도 된다. 종전 `min(1)` 이면
    //  키워드를 모르는 자식은 «무엇이 있나» 에 도달할 길이 0이었다(순환).
    const skillsSrc = await (await import("node:fs")).promises.readFile(
      path.resolve(import.meta.dirname, "../../core/llm-runtime/capabilities/skill-registry.ts"),
      "utf8",
    );
    const findDecl = skillsSrc.slice(skillsSrc.indexOf('"find_skills"'));
    const argLine = findDecl.slice(0, findDecl.indexOf("async (args)"));
    out.push(
      assert(
        "★find_skills 는 query 없이 부를 수 있다(열거 경로) — min(1) 이면 순환에 갇힌다",
        /query:\s*z\.string\(\)\.optional\(\)/.test(argLine),
        /min\(1\)/.test(argLine) ? "★min(1) — 열거 불가" : "optional",
      ),
    );

    // ★**개수를 모를 때도 버틴다** (2026-09-04 정태님: *"스킬은 계속 추가될 수 있고
    //  유저가 매니저·에이전트용도 추가할 수 있고 몇 개가 들어갈지는 아무도 모른다"*).
    //  ★캡이 **개수에만** 걸려 있어서 설명 길이가 무제한이었다 — 실측 39개 × 5,000자 =
    //   585,675B 인데 캡이 안 걸렸다. 바이트 축을 닫았고, 여기서 **실제로 눌리는지** 본다.
    //   («바운드가 있다» 가 아니라 «바운드가 무는가» 를 재야 한다.)
    const bulk = (n: number, len: number, reach: Skill["reach"] = "subagent"): Skill[] =>
      Array.from({ length: n }, (_, i) => ({
        ...mk(`bulk-${i}`, reach),
        description: "가".repeat(len),
      }));
    const CAP_BYTES = 25_600;
    for (const [n, len] of [
      [500, 200],
      [40, 2000],
      [39, 5000],
    ] as const) {
      const idx = formatSkillIndex(bulk(n, len), "subagent");
      out.push(
        assert(
          `★스킬 ${n}개 × 설명 ${len}자 에서도 인덱스가 바운드된다`,
          B(idx) <= CAP_BYTES + 600, // 헤더·넘침 안내 몫
          `${B(idx)}B (상한 ${CAP_BYTES}B + 머리말)`,
        ),
      );
      out.push(
        assert(
          `★잘렸으면 «나머지 N개는 find_skills» 를 말한다(조용한 절단 금지)`,
          idx.includes("나머지") && idx.includes("find_skills"),
          idx.includes("나머지") ? "안내 있음" : "★조용히 잘렸다",
        ),
      );
    }
    // ★역할 필터가 **캡보다 먼저** 걸린다 — 안 그러면 남의 칸 스킬이 캡을 먹고
    //  자기 칸 스킬이 밀려난다(«캡 있는 자리에 반드시 도달해야 할 것을 두지 마라»).
    const mixed = [...bulk(200, 400, "main"), mk("mine", "subagent")];
    const subMixed = formatSkillIndex(mixed, "subagent");
    out.push(
      assert(
        "★남의 칸 스킬 200개가 있어도 자기 칸 스킬이 안 밀려난다(역할 필터가 캡보다 먼저)",
        subMixed.includes("- mine:"),
        subMixed.includes("- mine:") ? "살아 있음" : "★밀려났다",
      ),
    );

    // ★**우리 스킬의 «간단 명세» 가 간단하게 유지되는가** (2026-09-04 정태님: *"스킬 간단
    //  명세가 그렇게 사이즈가 크면 안 되긴 하지"*). 위 바이트 캡은 **폭주를 막을 뿐**이고,
    //  우리가 쓰는 설명이 슬금슬금 길어지는 건 그것과 다른 문제다 — 캡에 걸리기 전까지
    //  아무도 모르고, 걸리는 순간엔 이미 다른 스킬을 밀어내고 있다.
    //  ★기준은 **실측에서 왔다**: 지금 번들 최대가 986B(code-review)다. 1,400B 는 그 위
    //   여유이고, 하는 일은 «정밀한 한도» 가 아니라 **드리프트 감지**다(설명이 배로 늘면 운다).
    const DESC_MAX = 1_400;
    const fat = bundled
      .map((s) => [s.name, B(s.description)] as const)
      .filter(([, b]) => b > DESC_MAX);
    out.push(
      assert(
        `★번들 스킬 설명이 «간단 명세» 로 유지된다 (≤${DESC_MAX}B)`,
        fat.length === 0,
        fat.length === 0
          ? `최대 ${Math.max(...bundled.map((s) => B(s.description)))}B`
          : `★비대: ${fat.map(([n, b]) => `${n}(${b}B)`).join(", ")} — 본문으로 내려라`,
      ),
    );

    return out;
  },
};
