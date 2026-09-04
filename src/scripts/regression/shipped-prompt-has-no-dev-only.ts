/**
 * 회귀: **전 사용자에게 나가는 프롬프트가 개발 레포에만 있는 것을 시키지 않는다** (2026-08-02).
 *
 * 하네스를 정리하다 발견. 배포되는 시스템 프롬프트(`REGION_A_SYSTEM_PROMPT`)가 **매 턴**
 * 두 가지를 시키고 있었는데 둘 다 **다른 사용자 설치본엔 없는 스킬**이었다:
 *
 *   ①`schedule-safety-check` — "`add_schedule` 호출 전에 위험성을 평가하라". 이건 개발
 *     편의가 아니라 **안전 게이트**다. 무인 발화 시점에 위험 도구가 도는 회색지대를 막으라고
 *     만든 것인데, 정작 `.claude/skills`·`.tiguclaw/skills` 에만 있어 **sync manifest 가
 *     둘 다 EXCLUDE** 했다. 즉 **나만 가진 안전장치를 전 사용자에게 지시**하고 있었다.
 *   ②`tiguclaw-orchestrator` — "tiguclaw 자체 작업 → 이 스킬" . 개발 토폴로지가 헌법에
 *     새어든 것(같은 줄의 "영역 A/B" 도 V8 에서 폐기된 어휘였다).
 *
 * ★어제 고친 것과 **같은 병의 세 번째**다(배포 스킬이 `principle-check` 참조 → 고침,
 *  배포 스킬에 dev 포트 → 고침, 그리고 이것). 앞의 둘을 잡으라고 만든 `shipped-asset-
 *  self-contained` 가 이건 못 잡았다 — **`skills/`·`agents/` 의 마크다운만 봤고 프롬프트를
 *  만드는 `src/` 는 안 봤다.** 잡으려던 병을 검사 범위 밖에 두고 있었다.
 *
 * ★그래서 이 검사는 문자열 grep 이 아니라 **실제로 조립된 프롬프트를 렌더해서** 본다.
 *  프롬프트가 어디서 어떻게 만들어지든(파일이 쪼개지든 조건부로 붙든) 결과물이 대상이다.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs = (rel: string): string[] =>
  existsSync(path.join(REPO, rel)) ? readdirSync(path.join(REPO, rel)) : [];

export const check: RegressionCheck = {
  name: "shipped-prompt-has-no-dev-only",
  guards:
    "배포 시스템 프롬프트가 매 턴 개발 레포 전용 스킬(안전 게이트 schedule-safety-check 포함)을 호출하라고 시키던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★개발 전용 = 하네스 루트엔 있는데 **배포 루트(`skills/`)엔 없는** 이름. 이름을 적지
    //  않으므로 새 개발 스킬이 생기면 저절로 대상이 된다.
    const shipped = new Set(dirs("skills"));
    const devOnly = [...new Set([...dirs(".claude/skills"), ...dirs(".tiguclaw/skills")])]
      .filter((n) => !shipped.has(n))
      .sort();
    if (devOnly.length === 0) {
      out.push(assert("개발 레포 전용 검사 — 배포본엔 비교 대상이 없다", true, "대상 아님"));
      return out;
    }
    out.push(
      assert(
        "개발 전용 스킬을 파생한다(검사 전제 — 0이면 공짜 통과)",
        devOnly.length >= 3,
        `${devOnly.length}개: ${devOnly.join(", ")}`,
      ),
    );

    // ★① 실제로 조립된 프롬프트를 렌더해서 본다(문자열 존재 검사가 아니다).
    const { REGION_A_SYSTEM_PROMPT } = await import(
      "../../core/llm-runtime/adapters/_shared-sysprompt.js"
    );
    const prompt = String(REGION_A_SYSTEM_PROMPT);
    out.push(
      assert(
        "배포 시스템 프롬프트를 렌더한다(검사 전제)",
        prompt.length > 2000,
        `${prompt.length}자`,
      ),
    );
    const leaked = devOnly.filter((n) => prompt.includes(n));
    out.push(
      assert(
        `★배포 프롬프트가 개발 전용 스킬을 시키지 않는다(${devOnly.length}개 대조)`,
        leaked.length === 0,
        leaked.length === 0
          ? `${prompt.length}자 · 누수 0`
          : `★누수: ${leaked.join(", ")} — 설치본엔 없는 것을 매 턴 시킨다`,
      ),
    );

    // ★② 프롬프트가 가리키는 **경로**도 실재하는 규약이어야 한다. deprecated 폴백을
    //  헌법이 안내하고 있었다(코드는 `.tiguclaw/skills` 가 우선인데 프롬프트는 `<cwd>/skills`).
    out.push(
      assert(
        "프로젝트 스킬 경로가 현행 규약이다(deprecated 폴백 안내 0)",
        prompt.includes("<cwd>/.tiguclaw/skills") && !prompt.includes("프로젝트 스킬(`<cwd>/skills`)"),
        prompt.includes("<cwd>/.tiguclaw/skills") ? ".tiguclaw/skills 안내" : "★deprecated 경로 안내",
      ),
    );

    // ★②-b 개발 레포 **토폴로지**도 누수다 (2026-08-05 프롬프트 감사).
    //  종전 이 검사는 **스킬 이름만** 대조해서, 개발 레포 경로(`./docs/decisions/…` 를 Read
    //  하라)와 내부 아키텍처 지시(`src/{core,channels,store,auth}` 안에 짓지 마라)가 그대로
    //  통과했다 — 비서에게 PDF 요약을 시키는 사용자의 매 턴에 우리 마이크로커널 구조가 실렸다.
    //  같은 병(나만 가진 것을 전 사용자에게)인데 검사 축이 이름 하나였던 것.
    const topology = [
      { pat: "docs/decisions", why: "개발 레포 결정노트 경로" },
      { pat: "src/{", why: "코어 디렉터리 구조 지시" },
      { pat: "packages/<plugin>", why: "레포 내부 배치 규약" },
    ].filter((t) => prompt.includes(t.pat));
    out.push(
      assert(
        "★배포 프롬프트에 개발 레포 토폴로지가 없다(경로·코어 구조)",
        topology.length === 0,
        topology.length === 0
          ? "경로·구조 지시 0"
          : `★누수: ${topology.map((t) => `${t.pat}(${t.why})`).join(", ")}`,
      ),
    );

    // ★②-c 프롬프트가 **이름으로 부르는 빌트인 서브에이전트는 배포돼야** 한다.
    //  실사고: `nano` 를 "빌트인 범용 서브에이전트" 로 안내했는데 배포 `agents/` 엔 없었다
    //  (`nano-simple` 은 **개발자 홈에만** 있는 것). 사용자 비서가 그 이름으로 spawn 하면
    //  '미발견' 에러 — 낭비가 아니라 **거짓 능력 안내**다. 이름 목록을 적지 않고, 그 문장에서
    //  백틱 토큰을 뽑아 배포 agents/ 와 대조한다(문장이 바뀌면 전제 단언이 먼저 깨진다).
    const builtinLine = prompt
      .split("\n")
      .find((l) => l.includes("빌트인 범용 서브에이전트"));
    const shippedAgents = new Set(
      dirs("agents")
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    );
    out.push(
      assert(
        "빌트인 에이전트 안내 문장을 찾는다(검사 전제 — 없으면 공짜 통과)",
        builtinLine !== undefined && shippedAgents.size > 0,
        `문장 ${builtinLine === undefined ? "없음" : "있음"} · 배포 에이전트 ${shippedAgents.size}개`,
      ),
    );
    if (builtinLine !== undefined) {
      const named = [...builtinLine.matchAll(/`([a-z][a-z0-9-]{2,})`/g)].map((m) => m[1]!);
      const ghosts = [...new Set(named)].filter((n) => !shippedAgents.has(n));
      out.push(
        assert(
          "★안내하는 빌트인 서브에이전트가 전부 배포본에 실재한다",
          ghosts.length === 0,
          ghosts.length === 0
            ? `대조 ${named.length}개 · 유령 0`
            : `★유령: ${ghosts.join(", ")} — 설치본엔 없는 이름을 매 턴 안내한다`,
        ),
      );
    }

    // ★③ 위험 트리거 등록 게이트가 **실제로 배달된다**.
    //
    //  ★**이름이 아니라 실질을 본다** (2026-09-04). 종전엔 `schedule-safety-check` 라는
    //   **스킬 이름**이 프롬프트에 있는지 + 그 스킬이 배포되는지를 봤다. 그런데 그 스킬을
    //   없애고 **규칙을 프롬프트에 인라인**으로 옮기자, 이 검사는 «게이트가 사라졌다» 고
    //   울었다 — 실제로는 게이트가 **더 확실해졌는데도**(스킬 조회가 필요 없고, 스킬
    //   인덱스에서 그것을 못 보는 위임 턴에도 같은 문장이 간다).
    //  ★그러니 검사가 지켜야 할 것은 **철자가 아니라 규칙의 실질**이다. 아래 조각이 전부
    //   있어야 통과한다 — «언제 평가하나 · 왜 위험한가 · 무엇을 받아야 하나». 조각 중
    //   하나라도 지우면 빨간불이 뜨므로 «지워서 통과시키는 길» 은 여전히 막혀 있다.
    const gateParts: Array<[string, string]> = [
      ["등록 시점", "등록하기 전"],
      ["대상 도구", "add_schedule"],
      ["무인 발화 근거", "bypassPermissions"],
      ["승인 요구", "명시 승인"],
    ];
    const missing = gateParts.filter(([, frag]) => !prompt.includes(frag)).map(([k]) => k);
    out.push(
      assert(
        "★위험 트리거 등록 게이트의 실질이 프롬프트에 있다(이름이 아니라 내용)",
        missing.length === 0,
        missing.length === 0
          ? `조각 ${gateParts.length}개 전부 있음`
          : `★빠진 조각: ${missing.join(", ")} — 게이트를 지워서 통과시킨 것 아닌가`,
      ),
    );
    return out;
  },
};
