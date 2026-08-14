/**
 * 회귀: SDK 빌트인을 우리 것으로 **일원화한 축들**이 한 쌍(막기+주기)을 지킨다.
 *
 * 현재 대상: **할일**(2026-08-14) · **스킬**(2026-08-15). 기준은 아키텍처 §9.
 *
 * 배경: `update_todos` 는 codex·openai 에만 등록돼 있었고 claude 는 SDK 빌트인을 썼다.
 * 그래서 같은 기능인데 **할일 카드가 claude 에서만 안 떴다**(원칙 #2 위반). 그리고
 * claude 의 빌트인은 우리가 추적하던 이름(`TodoWrite`)이 아니라 `TaskCreate/TaskUpdate`
 * 로 옮겨가 있었다 — 실사용 1,304건 중 `TodoWrite` 0건, 그 사실을 **아무도 몰랐다**.
 *
 * ★대체는 손해가 아니었다(A/B 실측, 같은 6단계 과제):
 *    SDK   `TaskCreate×6 + TaskUpdate×12` = 18 호출
 *    우리  `update_todos×6`               =  6 호출   (소요 54초 동일 · 산출 동일)
 *  SDK 는 항목별이라 "이전 완료 + 다음 시작" 에 2번이 들고, 우리는 배열 통째라 한 번에 둘 다.
 *
 * ★이 검사가 지키는 것 셋:
 *  ① 빌트인을 막았으면 **대체를 준다** — 한쪽만 하면 능력이 준다(원칙 1 슈퍼셋 위반).
 *  ② 이름은 **정의점 하나**에서 온다 — 어댑터가 다시 적으면 드리프트한다.
 *  ③ 상류 개명 감지 — ★**약한 검사**다(2026-08-14 정정, 등급을 정직하게 적는다).
 *    `sdk-tools.d.ts` 의 `<이름>Input` 은 **스키마 이름이지 도구 이름이 아니다**:
 *    `FileReadInput`→emit `Read` · `TaskOutputInput`→emit `BashOutput`. 우리가 막는
 *    이름 중 `TodoWrite`·`TaskCreate` 는 우연히 일치해 이 대조가 먹지만, **일반 규칙이
 *    아니다.** 그래서 "있으면 통과" 로만 쓰고 없을 때는 사람이 보라고만 말한다.
 *    ★진짜 개명 감지는 **우리 DB**(`llm.activity` 의 실제 emit 이름)로 해야 한다 —
 *    라이브 데이터가 필요해 회귀로는 못 만들고 자가 관측 쪽 일이다(백로그).
 */
import { readFile } from "node:fs/promises";
import { createTodoMcpServer, SDK_TODO_TOOL_NAMES } from "../../core/llm-runtime/capabilities/todo-mcp.js";
import { SDK_SKILL_TOOL_NAMES } from "../../core/llm-runtime/capabilities/skill-registry.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const claude = await readFile(
    new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url),
    "utf8",
  );

  // ── ① 막았으면 준다 — 한 쌍이어야 한다 ─────────────────────────────────────
  const blocks = /\.\.\.SDK_TODO_TOOL_NAMES,/.test(claude);
  const gives = /todo: createTodoMcpServer\(input\.threadKey\),/.test(claude);
  out.push(
    assert(
      "★SDK 할일 도구를 막고 **우리 것을 준다**(한쪽만 하면 능력이 준다)",
      blocks && gives,
      `차단=${blocks} 대체제공=${gives}`,
    ),
  );

  // ── ② 이름은 정의점에서 — 어댑터가 다시 적지 않는다 ────────────────────────
  const relisted = SDK_TODO_TOOL_NAMES.filter((n) => claude.includes(`"${n}"`));
  out.push(
    assert(
      "★어댑터가 도구 이름을 다시 적지 않는다(정의점 하나)",
      relisted.length === 0,
      relisted.length === 0 ? "재기재 0" : `재기재: ${relisted.join(",")}`,
    ),
  );

  // ── ③ ★상류 개명을 시끄럽게 — SDK 타입 파일과 대조 ─────────────────────────
  //  우리가 막는 이름이 SDK 정의에서 사라졌다면 둘 중 하나다: 그 도구가 없어졌거나,
  //  **개명됐거나**. 어느 쪽이든 사람이 봐야 한다 — 조용히 지나가면 그게 지난 두 번의 사고다.
  {
    const sdk = await readFile(
      new URL("../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts", import.meta.url),
      "utf8",
    ).catch(() => "");
    if (sdk === "") {
      out.push(
        assert(
          "(건너뜀) SDK 도구 정의 파일을 못 읽음 — 개명 감지 불가",
          true,
          "sdk-tools.d.ts 없음 — 설치 형태가 바뀌었는지 확인",
        ),
      );
    } else {
      const gone = SDK_TODO_TOOL_NAMES.filter((n) => !sdk.includes(`${n}Input`));
      out.push(
        assert(
          "(약한 검사) 우리가 막는 할일 도구 이름이 SDK 정의에 아직 있다",
          gone.length === 0,
          gone.length === 0
            ? `${SDK_TODO_TOOL_NAMES.length}종 확인`
            : `★SDK 에서 사라진 이름: ${gone.join(",")} — 개명됐다면 그 새 이름을 막아야 한다(안 그러면 두 도구가 공존해 계획이 갈린다)`,
        ),
      );
    }
  }

  // ── 우리 도구가 실제로 그 이름으로 뜬다(등록 계약) ─────────────────────────
  {
    const srv = await adaptClaudeMcpServer(createTodoMcpServer("t"), "todo");
    const names = ((await srv.listTools()) as Array<{ name: string }>).map((t) => t.name);
    out.push(
      assert(
        "우리 할일 도구 이름은 update_todos 하나다",
        names.length === 1 && names[0] === "update_todos",
        names.join(","),
      ),
    );
  }

  // ── ★스킬도 같은 규칙 — 막았으면 줬는가 (2026-08-15) ──────────────────────
  //  SDK `Skill` 은 `.claude/skills`+번들을 보는데, tiguclaw 의 스킬 범위는 **의도적으로**
  //  Claude 영역을 포함하지 않는다(가져오려면 `claude-wrapper-sync` 로 래핑 = 맥락 이전).
  //  열어두면 claude 만 그 경계를 우회하고(실측 6건 중 5건) 통계에서도 빠진다.
  //  ★막기와 주기는 한 쌍 — `invoke_skill` 은 **lean 이 아닌 일반 경로**에 등록돼야 한다.
  {
    const blocksSkill = /\.\.\.SDK_SKILL_TOOL_NAMES,/.test(claude);
    const givesSkill = /skills: createSkillInvokeMcpServer\(cwd, \{/.test(claude);
    out.push(
      assert(
        "★SDK Skill 을 막고 invoke_skill 을 준다(경계 복원 + 대체 제공)",
        blocksSkill && givesSkill,
        `차단=${blocksSkill} 대체제공=${givesSkill}`,
      ),
    );
    const relistedSkill = SDK_SKILL_TOOL_NAMES.filter((n) => claude.includes(`"${n}"`));
    out.push(
      assert(
        "스킬 도구 이름도 정의점에서만 온다",
        relistedSkill.length === 0,
        relistedSkill.length === 0 ? "재기재 0" : `재기재: ${relistedSkill.join(",")}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "sdk-tool-unified",
  guards:
    "할일·스킬이 claude 에서만 SDK 빌트인이라 카드가 안 뜨고 통계에서 빠지던 것 + 막기와 주기가 한 쌍이 아니면 능력이 조용히 주는 것",
  run,
};
