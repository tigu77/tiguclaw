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
    "배포 빌트인 스킬이 개발 레포에만 있는 스킬(principle-check 등)을 가리켜 사용자 설치본에서 존재하지 않던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const shipped = new Set(dirs("skills"));
    const devOnly = [...new Set([...dirs(".claude/skills"), ...dirs(".tiguclaw/skills")])]
      .filter((n) => !shipped.has(n))
      .sort();

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
    return out;
  },
};
