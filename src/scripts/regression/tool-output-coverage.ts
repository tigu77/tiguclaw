/**
 * 회귀: **도구 결과 출력이 붙는 범위** (2026-07-29).
 *
 * 사고: 출력 프리뷰가 이름 화이트리스트 7개(file-ops 계열)로 제한돼 있어, 이후 늘어난 MCP
 * 도구(read_memory·search_code·project_capabilities…)는 **아무도 목록에 넣지 않았다.**
 * 그 카드들은 160자 detail 한 줄뿐이라 펼칠 내용이 없었고, 사용자에겐 "MCP 도구는 눌러도
 * 안 열린다"로 보였다(신고 2026-07-29). 이름 목록은 새 도구마다 사람이 기억해야 해 반드시
 * 드리프트한다 — 같은 날 아침 고친 MCP 도구명 이중 하드코딩과 같은 부류다.
 *
 * 그래서 "특정 이름이 포함됐나"가 아니라 **기본 포함 + 중복만 제외**라는 규칙 자체를 검사한다.
 * 화이트리스트로 되돌리면 첫 단언이 즉시 깨진다.
 */
import { buildActivityOutput } from "../../core/llm-runtime/adapters/_activity-output.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 실사용 MCP 도구(2026-07-29 events 실측 상위) — 이들이 빠지면 카드가 안 펼쳐진다. */
const MCP_TOOLS = [
  "read_memory",
  "search_memory",
  "project_capabilities",
  "search_code",
  "invoke_skill",
  "list_workers",
];
/** 결과가 다른 블록과 중복이라 일부러 뺀 것들. */
const EXCLUDED = ["Edit", "Write", "ExitPlanMode", "prompt_options", "update_todos", "KillShell"];

export const check: RegressionCheck = {
  name: "tool-output-coverage",
  guards: "MCP 도구 카드가 출력 없이 한 줄만 나와 펼쳐지지 않던 것(이름 화이트리스트 드리프트)",
  run: async (): Promise<Assertion[]> => {
    const missing = MCP_TOOLS.filter(
      (n) => buildActivityOutput(n, "결과 텍스트") === undefined,
    );
    const leaked = EXCLUDED.filter(
      (n) => buildActivityOutput(n, "결과 텍스트") !== undefined,
    );
    const long = buildActivityOutput("Bash", Array.from({ length: 200 }, (_, i) => `line${i}`).join("\n"));
    return [
      assert("★MCP 도구에 출력이 붙는다(펼칠 내용이 생긴다)", missing.length === 0, `누락=[${missing.join(",")}]`),
      assert("처음 보는 도구도 기본 포함(목록 관리 불필요)", buildActivityOutput("brand_new_tool_xyz", "결과") !== undefined, "기본 포함"),
      assert("중복 블록을 가진 도구는 제외 유지", leaked.length === 0, `누출=[${leaked.join(",")}]`),
      assert("빈 결과는 출력 없음(빈 카드 방지)", buildActivityOutput("read_memory", "") === undefined, "빈 결과"),
      assert(
        "긴 출력은 캡으로 묶인다(페이로드 폭주 0)",
        long !== undefined && long.text.length <= 4000 && long.truncated === true,
        `len=${long?.text.length ?? -1} truncated=${String(long?.truncated)}`,
      ),
    ];
  },
};
