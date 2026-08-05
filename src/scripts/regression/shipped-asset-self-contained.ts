/**
 * 회귀: **배포되는 자산이 개발 레포 전용 자산을 가리키지 않는다** (2026-08-01 사용자 지적).
 *
 * 사고: 배포되는 빌트인 스킬 `skills/harness/SKILL.md` 에 `principle-check` 를 "거쳐라"라고
 * 적었다. 그런데 그 스킬은 **`.claude/`(Claude Code 하네스)와 `.tiguclaw/`(tiguclaw 자체개발
 * 프로젝트 스코프)에만 있고 둘 다 sync manifest EXCLUDE** 다 — 즉 **다른 사용자의 설치본에는
 * 존재하지 않는다.** 그 사용자의 비서는 있지도 않은 스킬을 찾다가 못 찾는다.
 *
 * ★같은 날 같은 병을 세 번 봤다: dev 기계 포트가 제품 기본값으로(3101), dev 포트가 배포
 *  문서로("현재 dev 값 3002"), 그리고 이것. **내 작업 환경에서만 참인 것이 제품으로 샌다.**
 *  더구나 이건 그 병을 고치는 문서를 쓰면서 저질렀다 — 규칙을 아는 것과 걸리는 것은 다르다.
 *
 * ★판정 기준(이름 열거 아님): `.claude/skills/`·`.tiguclaw/skills/` 에 있는데 `skills/`(배포)
 *  에는 **없는** 이름 = 개발 전용. 그 이름이 배포 자산 본문에 나오면 잡는다. 개발 스킬이
 *  새로 생겨도 저절로 대상이 된다.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs = (rel: string): string[] =>
  existsSync(path.join(REPO, rel)) ? readdirSync(path.join(REPO, rel)) : [];

/** 배포 자산 트리(sync manifest 가 SHIP 하는 것 중 사람이 읽는 지침). */
const SHIPPED_TREES = ["skills", "agents"] as const;

const walkMd = (rel: string): string[] => {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith(".md")) out.push(path.relative(REPO, p));
    }
  };
  rec(abs);
  return out;
};

export const check: RegressionCheck = {
  name: "shipped-asset-self-contained",
  guards:
    "배포 빌트인 스킬이 개발 전용 스킬을 가리켜 설치본에 없던 것 + .claude/ 와 .tiguclaw/ 사본이 말없이 갈라져 데몬이 낡은 규칙으로 돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const shipped = new Set(dirs("skills"));
    const devOnly = [...new Set([...dirs(".claude/skills"), ...dirs(".tiguclaw/skills")])]
      .filter((n) => !shipped.has(n))
      .sort();

    // ★이 검사는 **개발 레포 전용**이다 — 비교 대상(`.claude/skills`·`.tiguclaw/skills`)이
    //  배포 EXCLUDE 라 배포 레포엔 아예 없다. 종전엔 그걸 모르고 "전제 실패" 로 빨간불을
    //  냈다(2026-08-02 CI). **이 검사가 잡으려던 병을 이 검사 자신이 앓고 있었다** —
    //  개발 레포 가정이 배포본으로 새는 것. 없으면 대상 아님으로 **명시하고** 넘어간다
    //  (조용히 통과시키지 않는다 — 왜 안 돌았는지가 보여야 한다).
    const devTreesPresent = dirs(".claude/skills").length + dirs(".tiguclaw/skills").length > 0;
    if (!devTreesPresent) {
      out.push(
        assert(
          "개발 레포 전용 검사 — 배포 레포에는 비교 대상이 없어 대상 아님",
          true,
          ".claude/skills·.tiguclaw/skills 부재(배포 EXCLUDE) → 개발 레포에서만 유효",
        ),
      );
      return out;
    }
    out.push(
      assert(
        "개발 전용 스킬 목록을 파생한다(검사 전제 — 0이면 공짜 통과)",
        devOnly.length >= 3,
        `${devOnly.length}개: ${devOnly.join(", ")}`,
      ),
    );
    if (devOnly.length === 0) return out;

    const files = SHIPPED_TREES.flatMap((t) => walkMd(t));
    out.push(
      assert(
        "배포 자산 문서를 찾는다(검사 전제)",
        files.length >= 5,
        `${files.length}개 (${SHIPPED_TREES.join("·")})`,
      ),
    );

    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(REPO, f), "utf8");
      for (const name of devOnly) {
        // 단어 경계로 — `code-review` 처럼 배포에도 있는 이름의 부분일치를 피한다.
        if (new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`).test(src)) {
          hits.push(`${f} → ${name}`);
        }
      }
    }
    out.push(
      assert(
        "★배포 자산이 개발 전용 스킬을 가리키지 않는다(설치본에서 없는 것 0)",
        hits.length === 0,
        hits.length === 0
          ? `${files.length}개 문서 · 개발 전용 ${devOnly.length}개 대조 · 참조 0`
          : `★누수 ${hits.length}건: ${hits.join(" / ")}`,
      ),
    );

    // 반대 방향 확인 — 배포 자산끼리의 참조는 정상이어야 한다(과잉 차단 0).
    //  `skill-creator` 는 배포되므로 harness 가 가리켜도 문제없다는 것을 못 박는다.
    const harness = readFileSync(path.join(REPO, "skills/harness/SKILL.md"), "utf8");
    out.push(
      assert(
        "배포 스킬끼리의 참조는 정상이다(skill-creator)",
        harness.includes("skill-creator") && shipped.has("skill-creator"),
        `skill-creator 배포=${shipped.has("skill-creator")} 참조=${harness.includes("skill-creator")}`,
      ),
    );

    // ★같은 스킬이 `.claude/`(내가 읽음)와 `.tiguclaw/`(데몬이 읽음) 두 벌로 있다. 손으로
    //  맞추는 사본이라 **말없이 갈라진다** — 2026-08-02 감사에서 실제로 둘이 뒤처져 있었고,
    //  하필 빠진 게 principle-check 의 **Q0**(전날 2차결함 5건으로 추가한 가장 중요한 칸)과
    //  sync-public 의 **§8 CI 확인**이었다. 즉 내가 쓴 규칙이 **데몬한텐 없는 상태로** 며칠
    //  돌았다(데몬은 그 사이 principle-check 를 실제로 2번 불렀다).
    //  ★이름을 열거하지 않는다 — 양쪽에 다 있는 스킬 전부가 대상이다(세 번째가 갈려도 걸린다).
    const both = dirs(".claude/skills").filter((n) => dirs(".tiguclaw/skills").includes(n));
    const drift = both.filter((n) => {
      const a = path.join(REPO, ".claude/skills", n, "SKILL.md");
      const b = path.join(REPO, ".tiguclaw/skills", n, "SKILL.md");
      if (!existsSync(a) || !existsSync(b)) return true;
      return readFileSync(a, "utf8") !== readFileSync(b, "utf8");
    });
    out.push(
      assert(
        `★.claude/ 와 .tiguclaw/ 의 같은 스킬이 한 글자도 안 다르다(${both.length}개)`,
        both.length >= 5 && drift.length === 0,
        drift.length === 0
          ? `대조 ${both.length}개 · 드리프트 0`
          : `★드리프트 ${drift.length}건: ${drift.join(", ")} — 데몬이 낡은 규칙으로 돈다`,
      ),
    );
    return out;
  },
};
