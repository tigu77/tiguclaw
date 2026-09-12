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
    //
    // ★**«소비자별 구역» 만 예외**다 (2026-09-11). 종전엔 «한 글자도 안 다르다» 였는데, 그건
    //  두 파일의 소비자가 같다고 본 것이다 — 에이전트에서 이미 틀린 것으로 판명된 가정이고
    //  (`agent-defs-match-reality` 의 `model:` 예외), 스킬에서도 같은 값을 치렀다:
    //  `tiguclaw-orchestrator` 가 **데몬에 없는 도구**(`Agent`·`TaskCreate`)를 쓰라고 지시하고
    //  있었는데, 바이트-동일 단언이 그 결함을 **고정**하고 있었다(고치면 여기가 빨개지니까).
    //  ★경계를 «도구 이름이 든 줄» 로 잡지 않는다 — `Agent` 는 «Claude Agent SDK» 처럼 흔한
    //   낱말이라 무관한 줄까지 지워 **진짜 드리프트를 놓친다.** 대신 파일 안에 **명시 마커**를
    //   두게 한다: 왜 갈리는지가 그 자리에 적히고, 검사는 경계를 추측하지 않는다.
    //  ★어휘 자체의 유효성(어느 쪽에 무엇이 허용되나)은 `harness-skill-vocabulary` 가 본다.
    const CONSUMER_BLOCK = /<!-- 소비자별:시작 — .+? -->\n[\s\S]*?<!-- 소비자별:끝 -->\n/g;
    const withoutConsumerBlocks = (t: string): string =>
      t.replace(CONSUMER_BLOCK, "<소비자별 구역>\n");
    const both = dirs(".claude/skills").filter((n) => dirs(".tiguclaw/skills").includes(n));
    const pair = (n: string): { a: string; b: string } | null => {
      const a = path.join(REPO, ".claude/skills", n, "SKILL.md");
      const b = path.join(REPO, ".tiguclaw/skills", n, "SKILL.md");
      if (!existsSync(a) || !existsSync(b)) return null;
      return { a: readFileSync(a, "utf8"), b: readFileSync(b, "utf8") };
    };
    const drift = both.filter((n) => {
      const p = pair(n);
      if (p === null) return true;
      return withoutConsumerBlocks(p.a) !== withoutConsumerBlocks(p.b);
    });
    // ★마커를 **양쪽이 같은 수·같은 제목**으로 달았는가 — 한쪽에만 달면 그 구역이 통째로
    //  비교에서 빠져 드리프트가 조용히 숨는다(완화가 만드는 가장 그럴듯한 새 구멍).
    const titles = (t: string): string[] =>
      [...t.matchAll(/<!-- 소비자별:시작 — (.+?) -->/g)].map((m) => m[1] ?? "");
    const markMismatch = both.filter((n) => {
      const p = pair(n);
      if (p === null) return true;
      return titles(p.a).join("|") !== titles(p.b).join("|");
    });
    // ★예외가 **예외로만** 남는지 — 마커를 달아 놓고 양쪽 내용이 같으면 그 완화는 아무것도
    //  거르지 않는 빈 예외다(`agent-defs-match-reality` 의 «model 은 실제로 갈려 있다» 와 같은 축).
    const emptyException = both.filter((n) => {
      const p = pair(n);
      if (p === null || titles(p.a).length === 0) return false; // 마커 없는 스킬은 대상 아님
      return p.a === p.b;
    });
    // ★**예외가 «예외» 로 남는 크기인가** (2026-09-11 적대 검토 P1). 마커 구역에 상한이 없어서,
    //  본문 전체를 마커 한 쌍으로 감싸고 데몬 사본을 **90% 들어내도**(5,735 → 559 바이트)
    //  전 스위트가 초록이었다. 즉 «마커 밖만 동일» 이 «아무것도 대조 안 함» 이 될 수 있었다.
    //  ★비율로 못박는다 — 30%. 이 수는 «소비자별로 갈리는 건 메커니즘 문단 몇 개» 라는 오늘의
    //   실측(최대 13%)에 여유를 준 값이고, 넘으면 그건 예외가 아니라 **다른 문서**다.
    const blockRatio = (t: string): number =>
      [...t.matchAll(CONSUMER_BLOCK)].reduce((n, m) => n + m[0].length, 0) / Math.max(t.length, 1);
    const overExempt = both
      .map((n) => ({ n, p: pair(n) }))
      .filter(
        ({ p }) => p !== null && Math.max(blockRatio(p.a), blockRatio(p.b)) > 0.3,
      )
      .map(({ n, p }) => `${n}(${Math.round(Math.max(blockRatio(p!.a), blockRatio(p!.b)) * 100)}%)`);
    // ★하한을 **집합 동등**으로 바꾼다(적대 검토 G) — `both.length >= 5` 는 한쪽 스킬을 하위
    //  폴더로 밀어 넣어 **10→9 로 줄여도** 통과했다. 손 상수 `5` 도 같이 사라진다.
    const claudeSet = dirs(".claude/skills").sort().join("|");
    const tiguSet = dirs(".tiguclaw/skills").sort().join("|");
    out.push(
      assert(
        "★★양쪽 스킬 **집합이 정확히 같다** — 한쪽에서 하나가 사라져도 «공통만 대조» 라 조용히 통과하던 자리다",
        claudeSet === tiguSet && both.length > 0,
        claudeSet === tiguSet
          ? `양쪽 ${both.length}개 일치`
          : `★집합 불일치 — .claude=${dirs(".claude/skills").length}개 / .tiguclaw=${dirs(".tiguclaw/skills").length}개`,
      ),
      assert(
        `★.claude/ 와 .tiguclaw/ 의 같은 스킬이 «소비자별 구역» 말고는 한 글자도 안 다르다(${both.length}개)`,
        both.length > 0 && drift.length === 0,
        drift.length === 0
          ? `대조 ${both.length}개 · 드리프트 0`
          : `★드리프트 ${drift.length}건: ${drift.join(", ")} — 데몬이 낡은 규칙으로 돈다`,
      ),
      assert(
        "★★마커 구역이 **파일의 30% 를 넘지 않는다** — 상한이 없으면 본문을 통째로 감싸 대조를 무력화할 수 있다(실측: 90% 소실에도 전 스위트 초록이었다)",
        overExempt.length === 0,
        overExempt.length === 0 ? "최대 비율 정상" : `★예외 구역 과다: ${overExempt.join(", ")}`,
      ),
      assert(
        "★★그 마커가 **양쪽에 같은 수·같은 제목**으로 있다 — 한쪽에만 달면 그 구역이 비교에서 통째로 빠져 드리프트가 조용히 숨는다",
        markMismatch.length === 0,
        markMismatch.length === 0
          ? `마커 짝 맞음(${both.filter((n) => titles(pair(n)?.a ?? "").length > 0).length}개 스킬이 마커 사용)`
          : `★불일치: ${markMismatch.join(", ")}`,
      ),
      assert(
        "★마커를 단 스킬은 그 안이 **실제로 갈려 있다** — 같으면 완화가 빈 예외로 굳은 것이고, 그때 이 검사는 초록인 채로 죽는다",
        emptyException.length === 0,
        emptyException.length === 0
          ? "빈 예외 0"
          : `★마커만 있고 내용이 같다: ${emptyException.join(", ")}`,
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
