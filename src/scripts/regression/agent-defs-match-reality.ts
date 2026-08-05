/**
 * 회귀: **하네스 에이전트 정의가 실제 코드·실제 능력과 맞는다** (2026-08-02 사용자 지적).
 *
 * 사용자가 "하네스 에이전트들도 검수한 건가" 라고 물어 열어보니, 5개 정의가 **3개월 전
 * 프로젝트를 설명**하고 있었다. 스킬보다 나빴다:
 *
 *   ①**담당 파일 8/14 가 없다** — 채널·트리거·훅이 `plugins/` 로 옮겨갔는데 정의는
 *     `src/channels/telegram.ts`·`src/triggers/cron.ts`·`src/hooks/runner.ts` 를 "네가 만들
 *     파일" 로 적고 있었다. `src/triggers`·`src/hooks` 디렉터리 자체가 없다.
 *   ②**없는 능력을 지시** — `tools:` 는 Read/Glob/Grep/Edit/Write/Bash 뿐인데 5개 전부
 *     "메시지 발신 대상" 절을 갖고 있었고(에이전트끼리 통신할 도구가 없다), architect 는
 *     `TaskCreate` 로 작업을 분배하라고 적혀 있었다 — 도구가 없을 뿐 아니라 **손자 금지
 *     하드 규칙 정면 위반**이다. 정작 그 손자 금지 문구는 5개 중 **0개**에 있었다.
 *   ③**폐기된 전제** — region-engineer 는 "영역 A/B" 가 이름인데 `router.ts` 머리말이
 *     "V8 영역 통합: 영역 A/B 구분·prefix·분류 전부 폐기" 라고 적고 있다. 작업 원칙에
 *     남은 `@gpt`·`@claude` 라우팅은 **사용자가 확정 금지한 것**이었다.
 *
 * ★고쳐도 또 썩는다 — 정의가 코드 배치를 **손으로 옮겨 적기** 때문이다. 그래서 검사는
 *  "지금 맞나" 가 아니라 **경로가 실재하는가 · 도구 없는 지시가 없는가** 라는 판정이다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AGENTS = ".claude/agents";

/** 백틱 안의 레포 상대 경로를 뽑는다. `plugins/{a,b}/` 같은 중괄호 전개도 푼다. */
const pathsIn = (src: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(/`((?:src|plugins|packages|docs|skills|bin)\/[^`\s]*)`/g)) {
    const raw = m[1].replace(/[.,)]+$/, "");
    const brace = /^(.*?)\{([^}]+)\}(.*)$/.exec(raw);
    // 와일드카드(`*.ts`)는 존재 판정 대상이 아니다 — 디렉터리만 본다.
    const expand = brace
      ? brace[2].split(",").map((p) => `${brace[1]}${p.trim()}${brace[3]}`)
      : [raw];
    for (const e of expand) out.push(e.includes("*") ? e.slice(0, e.lastIndexOf("/")) : e);
  }
  // 템플릿(`docs/decisions/{YYYY-MM-DD}-{topic}.md`)·말줄임(`{a,b,...}`)은 실재 판정 대상이
  // 아니다 — 실제 경로가 아니라 **이름 규칙**을 적은 것이다. 남은 중괄호가 그 표식이다.
  return out.filter((p) => p.length > 0 && !p.includes("*") && !/[{}]|\.\.\./.test(p));
};

export const check: RegressionCheck = {
  name: "agent-defs-match-reality",
  guards:
    "하네스 에이전트 정의가 3개월 전 배치를 설명하고(담당 파일 8/14 실종) 없는 도구를 지시하던 것(손자 금지 0/5)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const dir = path.join(REPO, AGENTS);

    // ★개발 레포 전용 — 배포 EXCLUDE 라 설치본엔 없다. 조용히 통과시키지 않고 명시한다.
    if (!existsSync(dir)) {
      out.push(assert("개발 레포 전용 검사 — 배포본엔 .claude/agents 가 없다", true, "대상 아님"));
      return out;
    }
    const names = readdirSync(dir).filter((f) => f.endsWith(".md"));
    const src = new Map(names.map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
    out.push(assert("에이전트 정의를 찾는다(검사 전제)", names.length >= 5, `${names.length}개`));

    // ★① 정의가 가리키는 경로가 **전부 실재하는가.** 여기가 실제로 썩은 자리다.
    const dead: string[] = [];
    for (const [f, s] of src) {
      for (const p of pathsIn(s)) if (!existsSync(path.join(REPO, p))) dead.push(`${f}→${p}`);
    }
    const total = [...src.values()].reduce((n, s) => n + pathsIn(s).length, 0);
    out.push(
      assert(
        `★정의가 가리키는 경로가 전부 실재한다(${total}개 대조)`,
        total >= 15 && dead.length === 0,
        dead.length === 0 ? `실재 ${total}/${total}` : `★실종 ${dead.length}: ${dead.join(", ")}`,
      ),
    );

    // ★② 도구 없는 지시가 없는가 — `tools:` 에 없는 도구 이름을 본문이 시키면 안 된다.
    //  (실제: architect 가 TaskCreate 로 작업 분배 → 도구 부재 + 손자 금지 위반)
    const KNOWN = ["TaskCreate", "TaskUpdate", "SendMessage", "Skill", "WebSearch", "WebFetch"];
    const phantom: string[] = [];
    for (const [f, s] of src) {
      const granted = /^tools:\s*(.+)$/m.exec(s)?.[1] ?? "";
      const body = s.slice(s.indexOf("---", 3) + 3);
      for (const t of KNOWN) if (body.includes(t) && !granted.includes(t)) phantom.push(`${f}→${t}`);
    }
    out.push(
      assert(
        "★본문이 tools 에 없는 도구를 시키지 않는다",
        phantom.length === 0,
        phantom.length === 0 ? `${names.length}개 정의 대조 · 유령 지시 0` : `★${phantom.join(", ")}`,
      ),
    );
    // 에이전트끼리 직접 통신하는 절이 남아 있지 않은가(그런 도구가 없다).
    const talky = [...src].filter(([, s]) => /메시지 (발신|수신) 대상/.test(s)).map(([f]) => f);
    out.push(
      assert(
        "에이전트 간 직접 통신 프로토콜이 없다(할 수단이 없다)",
        talky.length === 0,
        talky.length === 0 ? "통신 절 0" : `★잔존: ${talky.join(", ")}`,
      ),
    );

    // ★③ 손자 금지 — CLAUDE.md 가 "항상 박는다" 고 하드로 규정한 문구. 0/5 였다.
    const noBan = [...src].filter(([, s]) => !s.includes("서브에이전트를 띄우지 마라")).map(([f]) => f);
    out.push(
      assert(
        `★손자 금지 문구가 모든 정의에 박혀 있다(${names.length}개)`,
        noBan.length === 0,
        noBan.length === 0 ? "전부 명시" : `★누락: ${noBan.join(", ")}`,
      ),
    );

    // ★④ .claude/(내가 읽음) ↔ .tiguclaw/(데몬이 읽음) 사본이 안 갈렸는가.
    //  스킬에서 실제로 갈렸다(principle-check Q0 누락) — 에이전트도 같은 두 벌 구조다.
    const mirror = path.join(REPO, ".tiguclaw/agents");
    const drift = existsSync(mirror)
      ? names.filter(
          (f) =>
            !existsSync(path.join(mirror, f)) ||
            readFileSync(path.join(mirror, f), "utf8") !== src.get(f),
        )
      : names;
    out.push(
      assert(
        "★.claude/agents 와 .tiguclaw/agents 가 한 글자도 안 다르다",
        existsSync(mirror) && drift.length === 0,
        drift.length === 0 ? `대조 ${names.length}개 · 드리프트 0` : `★드리프트: ${drift.join(", ")}`,
      ),
    );
    return out;
  },
};
