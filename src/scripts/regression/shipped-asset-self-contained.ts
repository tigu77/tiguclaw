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
import { readSourceSync, stripComments } from "./_wiring.js";
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
    // ★★**헌법이 부르라는 스킬 이름이 실제로 풀리는가** (2026-09-09).
    //  사고: 시스템 프롬프트(모든 사용자·매 턴)와 능력 안내가 `harness:harness` 로 부르라고
    //  했는데 그 이름의 스킬은 **없다**(콜론 이름을 가진 스킬이 0개). 시키는 대로 부르면
    //  **반드시** «미발견» 이 돌아온다 — 그런데 아무 검사도 안 울었다.
    //  ★배포되는 글이 **없는 능력을 광고**하는 것은 크기가 아니라 정확성 문제다.
    {
      const { discoverSkills } = await import(
        "../../core/llm-runtime/capabilities/skill-registry.js"
      );
      const names = new Set((await discoverSkills(REPO)).map((x) => x.name));
      // ★★**파일을 손으로 적지 않는다** — 첫 판이 `src/` 둘만 적어 **`SYSTEM.md` 를
      //  빠뜨렸다.** 그게 매 턴 최상단에 실리는 헌법 본체인데, 거기 남은 «없는 스킬
      //  이름» 둘이 그대로 공개 배포본까지 나갔다([[feedback_hand_maintained_lists]]).
      //  ★대상은 «사람이 읽는 지침으로 배포되는 글» 이다 — 정의에서 파생시킨다.
      const shipped = [
        "SYSTEM.md",
        "src/core/llm-runtime/adapters/_shared-sysprompt.ts",
        "src/core/llm-runtime/capabilities/find-capabilities-mcp.ts",
      ]
        // ★**주석을 빼고 본다** — 첫 실행이 «종전엔 X 스킬을 …» 이라는 **이력 주석**을
        //  잡아 없는 위반을 만들었다(그 스킬은 의도적으로 걷어낸 것이다).
        //  검사 대상은 **사용자에게 나가는 문자열**이지 그걸 설명하는 글이 아니다.
        .map((f) => ({ file: f, text: stripComments(readSourceSync(f)) }))
        .filter((d) => d.text !== "");
      // 백틱으로 감싼 «<이름> 스킬» 형태만 본다 — 산문 속 낱말까지 잡으면 오탐이 난다.
      const cited = new Set<string>();
      for (const d of shipped) {
        // ★**두 규칙의 합집합이다 — 어느 하나만 쓰면 반쪽이다** (2026-09-09, 코드 리뷰).
        //  ① «`<이름>` 스킬» 처럼 **스킬이라고 말한 것**: 이름이 실재하는지 모르는 상태에서도
        //     잡아야 한다 — 이 게이트가 막으려던 원래 사고가 «없는 이름 둘이 배포본까지
        //     나갔다» 였고, 없는 이름은 정의상 `names` 에 없다.
        //  ② **콜론 형 토큰**: 실제 표현이 «`harness:harness` 로» 라 ①에 안 걸렸다.
        //  ★오늘 ②로 갈아끼우면서 ①을 지웠고, 그래서 **콜론 없는 «없는 이름» 을 못 잡게
        //   됐다**(리뷰어가 `harness` → `harnesss` 로 실증: 옛 규칙 적발 / 새 규칙 통과).
        //   고치려던 것보다 나쁜 실패다 — 둘 다 둔다.
        for (const m of d.text.matchAll(/`([a-z][a-z0-9:_-]*)`\s*스킬/g)) {
          cited.add(m[1] ?? "");
        }
        for (const m of d.text.matchAll(/`([a-z][a-z0-9:_-]*)`/g)) {
          const tok = m[1] ?? "";
          if (tok.includes(":") || names.has(tok)) cited.add(tok);
        }
      }
      const missing = [...cited].filter((n) => !names.has(n));
      out.push(
        assert(
          "★★배포되는 글이 부르라는 스킬 이름이 **실제로 풀린다** — 안 풀리면 시키는 대로 부른 모델이 매번 «미발견» 을 받는다(없는 능력을 광고하는 것)",
          cited.size > 0 && missing.length === 0,
          cited.size === 0
            ? "★인용된 스킬 이름을 하나도 못 뽑았다(검사가 공허하다)"
            : missing.length === 0
              ? `인용 ${[...cited].sort().join("·")} 전부 실재`
              : `★없는 스킬을 부르라 한다: ${missing.join(", ")}`,
        ),
      );
    }

    return out;
  },
};
