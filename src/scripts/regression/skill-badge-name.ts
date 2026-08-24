/**
 * 회귀: **스킬 배지가 이름을 보여준다** — `path` 가 붙어도 (2026-08-24 사용자 신고).
 *
 * 증상: *"프로젝트 전용 스킬이라 그런가 배지에 물음표로 나올 때가 있네"* — 배지가 `스킬:?`.
 *
 * 근본: 대시보드 파서가 `name=([^,]*)$` — **끝 앵커**였다. 주석엔 *"path 지정 시
 * `path=…, name=<skill>`"* 이라 적혀 있었는데, 공유 detail 빌더가 2026-08-20 에
 * **식별자를 맨 앞으로** 옮겼다(`spawn_agent` 요약에서 name 이 접히던 것을 고치며
 * `IDENTITY_KEYS` 최우선). 그래서 실물은 `name=<skill>, path=…` 가 됐고 끝 앵커는
 * **path 가 붙는 순간 전부 실패**했다 = `path` 를 넘기는 **프로젝트 전용 스킬은 항상 `?`**.
 *
 * ★부류: A(빌더의 키 순서)를 바꾸고 A에 의존하던 B(이 파서)를 안 봤다
 * ([[feedback_scope_of_a_fix]]). 게다가 B의 주석이 **낡은 순서를 사실처럼** 적어두고
 * 있어서, 읽는 사람이 오히려 안심하게 돼 있었다.
 *
 * ★등급: **행동 게이트**. 소스를 훑지 않고 실물 파서를 `vm` 에 올려 **빌더가 실제로 내는
 *  문자열**로 돌린다 — 픽스처는 dev DB 에서 뜬 것이다(지어낸 값이 아니다).
 * ★그리고 **양쪽 순서를 다 넣는다.** 한쪽만 보면 순서가 또 뒤집힐 때 그대로 깨진다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type SkillInfo = { name: string } | null;

/** 실물 `skillStepInfo` 를 소스에서 떼어 실행 가능한 함수로 만든다. */
const loadParser = (): ((p: unknown) => SkillInfo) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    path.join(here, "../../../packages/dashboard/js/background-drawer.js"),
    "utf8",
  );
  const start = src.indexOf("function skillStepInfo(");
  if (start < 0) throw new Error("skillStepInfo 를 못 찾았다(이름이 바뀌었나)");
  // 함수 본문 끝 = 같은 들여쓰기의 닫는 중괄호.
  const end = src.indexOf("\n      }", start);
  if (end < 0) throw new Error("skillStepInfo 본문 끝을 못 찾았다");
  const body = src.slice(start, end + "\n      }".length);
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(`${body}\nthis.__fn = skillStepInfo;`, ctx);
  return ctx.__fn as (p: unknown) => SkillInfo;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const parse = loadParser();
  const step = (detail: string): SkillInfo =>
    parse({ kind: "tool", label: "invoke_skill", detail });

  // ★픽스처는 실측이다 — dev DB `events` 의 실제 invoke_skill detail.
  const cases: Array<[string, string, string]> = [
    ["name=tech-radar, path=/Users/x/workspace/shared-wiki", "tech-radar", "프로젝트 스킬(실측)"],
    ["name=news-digest, path=", "news-digest", "빈 path 도 콤마를 만든다(실측)"],
    ["name=harness", "harness", "path 없음(전역 스킬)"],
    ["path=/x/y, name=old-order", "old-order", "빌더가 순서를 되돌려도 잡는다"],
  ];
  const wrong = cases.filter(([d, want]) => (step(d)?.name ?? "") !== want);
  out.push(
    assert(
      "★detail 의 `name=` 위치와 무관하게 스킬명을 뽑는다(끝 앵커 금지)",
      wrong.length === 0,
      wrong.length === 0
        ? cases.map(([, w]) => w).join(" · ")
        : `★실패 ${wrong.length}건: ${wrong
            .map(([d, w, why]) => `${why}: ${JSON.stringify(d)} → ${JSON.stringify(step(d)?.name)} (기대 ${w})`)
            .join(" / ")}`,
    ),
  );

  // 못 뽑아도 **스킬 스텝인 것은 유지**한다 — 배지를 일반 도구로 강등하지 않는다.
  const unknown = step("");
  out.push(
    assert(
      "detail 이 비어도 스킬 스텝으로는 남는다(배지 '?' 는 최후 표시)",
      unknown !== null && unknown.name === "?",
      JSON.stringify(unknown),
    ),
  );

  // 경계 — 스킬이 아닌 것을 스킬로 승격하지 않는다.
  out.push(
    assert(
      "invoke_skill 이 아닌 도구는 스킬 스텝이 아니다",
      parse({ kind: "tool", label: "Bash", detail: "name=x" }) === null,
      "Bash → null",
    ),
    assert(
      "도구가 아닌 활동(text 등)은 스킬 스텝이 아니다",
      parse({ kind: "text", label: "invoke_skill", detail: "name=x" }) === null,
      "kind=text → null",
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "skill-badge-name",
  guards:
    "스킬 배지가 `스킬:?` 로 뜨던 것 — detail 빌더가 식별자를 앞으로 옮기자(2026-08-20) 끝 앵커 파서가 path 붙은 호출(=프로젝트 전용 스킬) 전부에서 실패했다",
  run,
};
export default check;
