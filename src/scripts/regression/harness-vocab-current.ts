/**
 * 회귀: **폐기한 어휘가 하네스에 되살아나지 않는다** (2026-08-02 전수 정리에서 나옴).
 *
 * "영역 A/B" 는 V8(2026-05-27)에 폐기됐다 — 영역 구분·prefix·분류를 전부 없애고 단일
 * 파이프라인으로 갔다. 그런데 **67일 뒤에도 하네스 8개 파일이 그 어휘로 말하고 있었다**:
 * 내 원칙 게이트(`principle-check`)·헬스체크·에이전트 3명, 그리고 **사용자에게 배포되는**
 * `schedule-safety-check` 까지.
 *
 * ★가장 나빴던 건 어휘가 아니라 **그 어휘에 붙어 있던 낡은 판정**이다. principle-check Q2 가
 *  *"단, 영역 A는 Claude 종속이 의도이므로 제외"* 라고 적고 있었는데, README 는 2026-05-17 에
 *  **그 의도를 정정**했다("Claude LLM 으로만 실행한다는 종속은 거절"). 즉 원칙 게이트가
 *  **정정 이전 기준으로 67일간 판정**하고 있었다 — 게이트가 통과시키면 안 되는 걸 통과시킨다.
 *
 * ★이 목록은 화이트리스트가 아니라 **폐기 기록**이다(append-only). 하네스는 손으로 쓰는
 *  글이라 옛 문서를 복사하면 어휘가 되돌아온다 — 그 경로를 막는 게 목적이다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 폐기된 어휘 → 언제·무엇으로 바뀌었나. 새로 폐기하면 여기 한 줄 추가. */
const ABOLISHED: ReadonlyArray<{ term: string; since: string; use: string }> = [
  { term: "영역 A", since: "V8 2026-05-27", use: "어댑터 / LLM 런타임" },
  { term: "영역 B", since: "V8 2026-05-27", use: "어댑터 / LLM 런타임" },
  { term: "Vercel AI SDK", since: "V8 2026-05-27", use: "@anthropic-ai/claude-agent-sdk · @openai/agents" },
];

/** 하네스 = 내가 읽는 것(.claude) + 데몬이 읽는 것(.tiguclaw) + 배포되는 것(skills·agents). */
const TREES = [".claude/skills", ".claude/agents", ".tiguclaw", "skills", "agents"] as const;

const mdFiles = (rel: string): string[] => {
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
  name: "harness-vocab-current",
  guards:
    "V8 에서 폐기한 '영역 A/B' 어휘가 하네스 8개 파일에 67일 생존 — 그중 principle-check 는 정정 이전 판정을 그대로 들고 있었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const files = TREES.flatMap(mdFiles);
    out.push(assert("하네스 문서를 찾는다(검사 전제)", files.length >= 10, `${files.length}개`));

    const hits: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(path.join(REPO, f), "utf8").split("\n")) {
        // ★"이 어휘는 폐기됐다" 고 설명하는 줄은 대상이 아니다 — 폐기 사실을 적는 게
        //  재발 방지의 일부다. 표식은 '폐기' 또는 '종전엔'(과거형 인용).
        if (line.includes("폐기") || line.includes("종전엔")) continue;
        for (const a of ABOLISHED) if (line.includes(a.term)) hits.push(`${f}: ${a.term}`);
      }
    }
    out.push(
      assert(
        `★폐기 어휘가 하네스에 없다(${ABOLISHED.length}종 · ${files.length}개 문서)`,
        hits.length === 0,
        hits.length === 0
          ? ABOLISHED.map((a) => `${a.term}→${a.use}`).join(" · ")
          : `★${hits.length}건: ${[...new Set(hits)].slice(0, 8).join(", ")}`,
      ),
    );

    // ★원칙 게이트가 **정정된 의도**를 담고 있는가 — 어휘보다 이쪽이 실피해였다.
    const pc = path.join(REPO, ".claude/skills/principle-check/SKILL.md");
    if (existsSync(pc)) {
      const s = readFileSync(pc, "utf8");
      out.push(
        assert(
          "★멀티 LLM 게이트에 프로바이더 종속 예외가 없다(2026-05-17 의도 정정 반영)",
          !/단, 영역 A는 Claude 종속이 의도이므로 제외/.test(s) && /예외 없다/.test(s),
          /예외 없다/.test(s) ? "예외 0 확인" : "★종속 예외가 살아 있다 — 게이트가 락인을 통과시킨다",
        ),
      );
    }
    return out;
  },
};
