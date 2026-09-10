/**
 * 회귀: **못 싣는 스킬은 이유를 말한다** (2026-09-10).
 *
 * 사고: `skill-registry.ts` 에 `console` 호출이 **0개**였다. frontmatter 에 오타 하나 나면
 * 스킬이 `return null` 로 사라지는데 **로그에 한 줄도 안 남았다** — 사용자는 «왜 안 뜨지»
 * 를 알 방법이 없고, 원격으로 못 붙는 설치본(회사돌쇠·회사 PC)에선 그게 곧 «영영 못
 * 잡는다» 는 뜻이다([[feedback_logs_must_stand_alone]]).
 *
 * ★계기: Agent Skills 가 **공개 표준**(agentskills.io — Anthropic 이 내고 CC·Codex·
 *  Gemini CLI·OpenClaw 등이 채택)이 되면서 **밖에서 온 스킬**이 들어오기 시작한다.
 *  남이 쓴 파일일수록 조용한 드롭이 비싸다.
 *
 * ★소스를 grep 하지 않는다 — **임시 스킬 폴더를 만들어 실제로 발견을 돌린다.** 이 판정이
 *  순수 함수(`skillLoadDefect`)로 떨어져 있어서 그게 가능하다
 *  ([[feedback_simple_composable_no_duplication]] 「검사가 껄끄러우면 코드가 잘못 놓인 것」).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "skill-drop-is-not-silent",
  guards:
    "frontmatter 오타 하나로 스킬이 조용히 사라지던 것 — 로더에 console 호출이 0개라 " +
    "«왜 안 뜨는지» 를 로그로는 영영 못 짚었다(원격 설치본에선 곧 «못 잡는다»)",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { skillLoadDefect, discoverSkills } = await import(
      "../../core/llm-runtime/capabilities/skill-registry.js"
    );

    // ── ① 판정 자체 ─────────────────────────────────────────────────────────
    const noFm = skillLoadDefect(null);
    const noDesc = skillLoadDefect({ name: "x" });
    const fine = skillLoadDefect({ name: "x", description: "무엇을 언제" });
    out.push(
      assert(
        "★frontmatter 를 못 읽으면 **이유와 고치는 법**을 낸다 — 증상만 적힌 로그는 한 번 더 묻게 만든다",
        noFm !== null && noFm.reason !== "" && noFm.hint.includes("---"),
        JSON.stringify(noFm),
      ),
      assert(
        "★`description` 이 비면 그걸 이름으로 말한다 — 실제로 스킬이 사라지는 두 원인 중 하나다",
        noDesc !== null && noDesc.reason.includes("description"),
        JSON.stringify(noDesc),
      ),
      assert(
        "★멀쩡한 스킬엔 **아무 말도 안 한다** — 상시 발화하는 경고는 아무도 안 보게 되고, 그 사이에 진짜 사고가 묻힌다(실측 12일)",
        fine === null,
        JSON.stringify(fine),
      ),
    );

    // ── ② 실제로 발견을 돌려 본다 ───────────────────────────────────────────
    const root = mkdtempSync(path.join(tmpdir(), "skill-drop-"));
    const skills = path.join(root, "skills");
    mkdirSync(path.join(skills, "good"), { recursive: true });
    writeFileSync(
      path.join(skills, "good", "SKILL.md"),
      "---\nname: good\ndescription: 멀쩡한 스킬. 검사용.\n---\n\n본문\n",
    );
    mkdirSync(path.join(skills, "broken"), { recursive: true });
    // 여는 `---` 가 없다 — 사람이 가장 흔히 내는 실수.
    writeFileSync(path.join(skills, "broken", "SKILL.md"), "name: broken\ndescription: 사라진다\n");

    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]): void => {
      warned.push(a.map(String).join(" "));
    };
    let found: ReadonlyArray<{ name: string }> = [];
    try {
      found = await discoverSkills(root);
    } finally {
      console.warn = realWarn;
    }

    const names = found.map((s) => s.name);
    out.push(
      assert(
        "★깨진 스킬은 실려 가지 않는다(멀쩡한 것만 실린다)",
        names.includes("good") && !names.includes("broken"),
        `발견=[${names.join(",")}]`,
      ),
      assert(
        "★★그런데 **조용하지 않다** — 건너뛴 파일 경로가 경고로 나온다. 이게 없으면 사용자는 스킬이 사라진 것조차 모른다",
        warned.some((w) => w.includes("broken") && w.includes("SKILL.md")),
        warned.length === 0 ? "★경고 0건 — 조용히 사라졌다" : warned.join(" | ").slice(0, 160),
      ),
      assert(
        "★멀쩡한 스킬을 두고는 경고하지 않는다",
        !warned.some((w) => w.includes(`${path.sep}good${path.sep}`)),
        `경고 ${warned.length}건`,
      ),
    );

    // ── ③ 매 턴 다시 찍지 않는다 ────────────────────────────────────────────
    //  `discoverSkills` 는 턴마다 돈다(캐시 0). 같은 결함을 매번 찍으면 배경소음이 된다.
    const warned2: string[] = [];
    console.warn = (...a: unknown[]): void => {
      warned2.push(a.map(String).join(" "));
    };
    try {
      await discoverSkills(root);
      await discoverSkills(root);
    } finally {
      console.warn = realWarn;
    }
    out.push(
      assert(
        "★★같은 결함을 **두 번 더 발견해도 다시 안 찍는다** — discoverSkills 는 턴마다 도므로, 안 막으면 이 경고가 매 턴 로그를 채우고 아무도 안 보게 된다",
        warned2.length === 0,
        warned2.length === 0 ? "재발화 0건" : `${warned2.length}건 재발화: ${warned2[0]?.slice(0, 90)}`,
      ),
    );

    // ★★**고쳤다가 다시 깨지면 다시 말한다** (2026-09-10 적대 검토 G-3). 중복 억제만 검사하면
    //  `clearSkillDefect(filePath)` **한 줄을 지워도 스위트가 초록**인데, 그러면 «고쳤다 다시
    //  깨진» 스킬이 프로세스 수명 내내 **조용하다.** 그 한 줄이 이 변경의 절반이다.
    {
      const warned3: string[] = [];
      const realWarn2 = console.warn;
      const good = "---\nname: broken\ndescription: 이제 멀쩡하다.\n---\n\n본문\n";
      const bad = "name: broken\ndescription: 사라진다\n";
      const p = path.join(skills, "broken", "SKILL.md");
      console.warn = (...a: unknown[]): void => {
        warned3.push(a.map(String).join(" "));
      };
      try {
        writeFileSync(p, good); // 고침
        await discoverSkills(root);
        writeFileSync(p, bad); // 다시 깨짐
        await discoverSkills(root);
      } finally {
        console.warn = realWarn2;
        writeFileSync(p, bad); // 뒷정리 — 다음 실행이 같은 상태에서 시작하게
      }
      out.push(
        assert(
          "★★고쳤다가 **다시 깨지면 다시 경고한다** — 안 그러면 그 스킬은 프로세스가 죽을 때까지 조용하고, 사용자는 사라진 줄도 모른다",
          warned3.some((w) => w.includes("broken")),
          warned3.length === 0 ? "★재파손인데 경고 0건" : warned3.join(" | ").slice(0, 120),
        ),
      );
    }

    return out;
  },
};
