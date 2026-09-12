/**
 * 회귀: **지침 글이 그 소비자에게 없는 도구를 쓰라고 하지 않는다** (2026-09-11).
 *
 * 사고: `.tiguclaw/skills/tiguclaw-orchestrator/SKILL.md` 가 **데몬이 읽는 사본**인데
 * «`.claude/agents/` 의 팀원을 `Agent` 도구로 spawn 하고, 진행은 `TaskCreate`/`TaskUpdate` 로
 * 추적한다» 고 적고 있었다. 셋 다 데몬엔 **없다** — `Agent`·`Task` 는 차단이고
 * (`SDK_SUBAGENT_TOOLS`), `TaskCreate` 류도 차단이며(`SDK_TODO_TOOL_NAMES`), 데몬은
 * `.tiguclaw/agents` 를 읽는다. 매니저가 이 스킬을 실제로 싣고 있었으므로 **시키는 대로 부르면
 * 반드시 실패**한다. 같은 결함이 `sync-public` 에도 있었다(`Agent` 도구에 worktree 격리 —
 * `spawn_agent` 엔 그 옵션이 없다).
 *
 * ★**그물이 그 결함을 고정하고 있었다.** `shipped-asset-self-contained` 가 두 사본의 «바이트
 *  동일» 을 강제해서, `.tiguclaw` 쪽만 데몬 어휘로 고치면 그 검사가 빨개졌다. 그래서 두 개를
 *  같이 바꾼다 — 저쪽은 «소비자별 구역» 만 예외로 두고(에이전트의 `model:` 예외와 같은 관용구),
 *  여기서는 **그 구역 안 어휘가 소비자에게 실재하는지**를 본다. 한쪽만 있으면 반쪽이다:
 *  완화만 하면 아무 어휘나 써도 되고, 어휘만 보면 나머지 드리프트가 샌다.
 *
 * ★**금지 목록을 손으로 적지 않는다** — 전부 정의점에서 가져온다(`SDK_SUBAGENT_TOOLS` ·
 *  `SDK_TODO_TOOL_NAMES` · `DAEMON_SUBAGENT_TOOL` · `DAEMON_TODO_TOOL`). 이름이 바뀌는 날
 *  한쪽만 고쳐지는 것이 이 레포의 반복 사고다([[feedback_hand_maintained_lists]]).
 *
 * ★**백틱만 보지 않는다** (2026-09-11 적대 검토 P2). 첫 판은 백틱 표기만 도구로 봤고, 그래서
 *  ①평문 «Agent 도구로 spawn 한다» ②굵게 «**TaskCreate**» ③**코드펜스 안 호출 예시**
 *  «Agent(subagent_type: …)» ④MCP 접두사 «`mcp__agents__spawn_agent`» 가 **전부 통과**했다.
 *  ③이 가장 나쁘다 — 리터럴 호출 예시는 가능한 가장 강한 지시형인데 그물이 못 봤다.
 *  ★«낱말로 재면 시끄러워진다» 는 첫 판의 걱정은 **실측으로 반박됐다**: `.tiguclaw/skills`
 *   전체에서 백틱 없는 충돌은 금지 9종 중 `Agent` **3건뿐**이고 둘은 «Claude Agent SDK»,
 *   하나는 `migrateLegacyAgent`(낱말경계에 안 걸린다). 나머지 8종은 **0건**이다. 즉 백틱
 *   요구는 아무것도 사주지 못하면서 커버리지만 버리고 있었다.
 *  ★그래서 **고유명사 하나만 깎고** 낱말경계로 넓힌다. 오탐이 0이어야 다음 사람이 예외를
 *   파기 시작하지 않는다 — 시끄러운 검사는 결국 꺼진다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import {
  SDK_SUBAGENT_TOOLS,
  SDK_COORDINATION_TOOLS,
  DAEMON_SUBAGENT_TOOL,
} from "../../core/llm-runtime/subagent-tools.js";
import {
  SDK_TODO_TOOL_NAMES,
  DAEMON_TODO_TOOL,
} from "../../core/llm-runtime/capabilities/todo-mcp.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 그 소비자에게 **없는** 도구 이름들 — 정의점에서 파생(손 목록 0). */
const FORBIDDEN: Readonly<Record<string, readonly string[]>> = {
  // 데몬이 읽는 사본에 SDK 빌트인 어휘가 있으면 그건 «없는 도구» 지시다.
  // ★`SDK_COORDINATION_TOOLS` 를 빠뜨렸던 것이 P5 였다 — 이 변경이 «고치겠다» 고 명시한 결함
  //  넷 중 하나(`SendMessage` 로 후속 지시)를 글자 그대로 되돌려도 그물이 못 봤다.
  ".tiguclaw/skills": [
    ...SDK_SUBAGENT_TOOLS,
    ...SDK_COORDINATION_TOOLS,
    ...SDK_TODO_TOOL_NAMES,
  ],
  // 반대 방향도 본다 — 한쪽만 보면 반쪽이다. Claude Code 에는 우리 MCP 도구가 없다.
  ".claude/skills": [DAEMON_SUBAGENT_TOOL, DAEMON_TODO_TOOL],
};

/** 각 사본이 **가리키면 안 되는** 자산 경로 — 소비자마다 읽는 트리가 다르다. */
const FORBIDDEN_PATH: Readonly<Record<string, string>> = {
  ".tiguclaw/skills": ".claude/agents/",
  ".claude/skills": ".tiguclaw/agents/",
};

/** 고유명사 — 도구 지시가 아니라 제품 이름이다(유일한 실측 충돌). */
const stripProductNames = (t: string): string => t.replace(/Claude\s+Agent\s+SDK/g, "");

/** MCP 접두사를 벗긴다 — `mcp__agents__spawn_agent` 도 같은 지시다(정의점 `bare()` 와 같은 규칙). */
const stripMcpPrefix = (t: string): string => t.replace(/mcp__[a-z0-9-]+__/g, "");

const normalize = (t: string): string => stripMcpPrefix(stripProductNames(t));

/** 그 이름이 **도구로 불린 자리**의 개수 — 백틱·굵게·평문·코드펜스를 다 센다. */
const countMentions = (text: string, tool: string): number => {
  const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = normalize(text).match(new RegExp(`(^|[^\\w#/-])${esc}(?![\\w-])`, "gm"));
  return m === null ? 0 : m.length;
};

const mentions = (text: string, tool: string): boolean => countMentions(text, tool) > 0;

/**
 * 이 트리가 **이 레포에 실리는가** — 배포 레포엔 dev 하네스가 없다.
 *
 * ★`.claude/`·`.tiguclaw/` 는 `sync-public` manifest 가 통째로 제외한다(dev 전용 자산 ·
 *  절대경로 PII). 그래서 배포 트리에선 이 검사의 **대상이 0개**인데, 종전엔 그걸 «탐색이
 *  깨졌다» 로 읽어 **빨강 4건**을 냈다(실측 2026-09-12 dev 싱크에서 push 가 막혔다).
 * ★그렇다고 «0개면 통과» 로 풀면 안 된다 — 그건 이 검사가 스스로 막아둔 실패 모드다.
 *  가르는 것은 **폴더의 존재**다: 폴더가 아예 없으면 대상이 아닌 것이고(배포 트리),
 *  폴더는 있는데 스킬이 0개면 그건 탐색이 깨진 것이다(개발 트리) — 그쪽은 그대로 빨강.
 */
const treeShips = (rel: string): boolean => existsSync(path.join(REPO, rel));

const skillFiles = (rel: string): { name: string; text: string }[] => {
  const root = path.join(REPO, rel);
  if (!existsSync(root)) return [];
  const out: { name: string; text: string }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(root, e.name, "SKILL.md");
    if (existsSync(f)) out.push({ name: e.name, text: readFileSync(f, "utf8") });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "harness-skill-vocabulary",
  guards:
    "데몬이 읽는 스킬이 데몬에 없는 도구(`Agent`·`TaskCreate` 등)를 쓰라고 지시하던 것 — " +
    "매니저가 그 스킬을 실제로 싣고 있어 시키는 대로 부르면 반드시 실패했다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];

    for (const [rel, forbidden] of Object.entries(FORBIDDEN)) {
      if (!treeShips(rel)) {
        out.push(
          assert(
            `★${rel} 은 이 트리에 **없다** — 배포 레포는 dev 하네스를 안 싣는다(대상 아님)`,
            true,
            "배포 트리: 대상 없음(조용한 통과가 아니라 명시)",
          ),
        );
        continue;
      }
      const files = skillFiles(rel);
      const hits: string[] = [];
      for (const f of files) {
        for (const t of forbidden) {
          if (mentions(f.text, t)) hits.push(`${f.name}:\`${t}\``);
        }
      }
      out.push(
        assert(
          `★★${rel} 의 지침이 **그 소비자에게 있는 도구만** 쓰라고 한다(금지 ${forbidden.length}종)`,
          files.length > 0 && hits.length === 0,
          files.length === 0
            ? `★${rel} 에서 스킬을 하나도 못 찾았다 — 검사가 안 돈 것이지 통과가 아니다`
            : hits.length === 0
              ? `${files.length}개 스킬 · 금지 어휘 0`
              : `★없는 도구를 지시한다: ${hits.join(" / ")}`,
        ),
      );
    }

    // ── 소비자가 읽지 않는 트리를 가리키지 않는다 ─────────────────────────────────
    // ★도구 이름만 보면 `.claude/agents/` 를 읽으라는 지시를 못 본다 — 데몬은 그 트리를
    //  안 읽으므로(`agent-registry.ts`) 그것도 «없는 것을 가리키는 글» 이다(P5).
    for (const [rel, badPath] of Object.entries(FORBIDDEN_PATH)) {
      if (!treeShips(rel)) continue; // 위에서 이미 «대상 아님» 을 명시했다.
      const hits = skillFiles(rel)
        .filter((f) => f.text.includes(badPath))
        .map((f) => f.name);
      out.push(
        assert(
          `★${rel} 의 지침이 **자기가 읽는 트리**만 가리킨다(금지: ${badPath})`,
          hits.length === 0,
          hits.length === 0 ? `참조 0` : `★다른 소비자 트리를 가리킨다: ${hits.join(", ")}`,
        ),
      );
    }

    // ★검사가 **실제로 무언가를 보고 있는가** — 위 단언들은 "하나도 없다" 라서, 대상이 0개여도
    //  초록이 된다(파일 탐색이 깨지면 조용히 그렇게 된다). 그래서 반대편을 함께 못박는다:
    //  각 소비자의 **자기 어휘**는 실제로 쓰이고 있어야 한다.
    //
    // ★**개수로 센다** (적대 검토 G). 첫 판은 «한 번이라도 나오나» 였는데, 그러면 유일한 언급이
    //  «쓰지 마라» 라는 **부정문**이어도 충족된다(실제로 그 상태였다 — 데몬 사본의 `spawn_agent`
    //  백틱 하나가 금지 문장 안에 있었다). 완전한 «지지/부정» 판정은 비용 대비 과하니, 한 줄
    //  부정문으로는 못 채우는 **하한 2**로 둔다.
    const daemonUses = skillFiles(".tiguclaw/skills").reduce(
      (n, f) => n + countMentions(f.text, DAEMON_SUBAGENT_TOOL),
      0,
    );
    const claudeUses = skillFiles(".claude/skills").reduce(
      (n, f) => n + SDK_SUBAGENT_TOOLS.reduce((m, t) => m + countMentions(f.text, t), 0),
      0,
    );
    // ★두 사본이 다 안 실리는 트리(배포 레포)에선 이 대조 자체가 성립하지 않는다 —
    //  «자기 어휘를 쓴다» 는 반대편 못이므로, 대상이 없으면 못을 박을 자리도 없다.
    if (treeShips(".tiguclaw/skills") || treeShips(".claude/skills")) {
      out.push(
        assert(
          `★데몬 사본이 **자기 도구**(\`${DAEMON_SUBAGENT_TOOL}\`)를 실제로 쓴다 — 금지만 검사하면 «아무 말도 안 하는 글» 도 통과하고, 1회 하한이면 «쓰지 마라» 한 줄로도 채워진다`,
          daemonUses >= 2,
          `언급 ${daemonUses}회(하한 2)`,
        ),
        assert(
          "★Claude Code 사본도 **자기 도구**를 실제로 쓴다 — 양쪽 다 봐야 이 대조가 성립한다",
          claudeUses >= 2,
          `언급 ${claudeUses}회(하한 2)`,
        ),
      );
    }

    return out;
  },
};
