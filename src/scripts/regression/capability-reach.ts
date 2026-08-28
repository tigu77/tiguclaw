/**
 * 회귀: **도구 노출 사다리 — 어디까지 닿나** (2026-08-28).
 *
 * 정태님: *"매니저나 서브에이전트한테 굳이 필요없는 도구는 안 쥐어주지?"* → 안 준다.
 * 그런데 그 규칙을 지키던 게 **주석뿐**이었다. `depth === 0 && (input.workerDepth ?? 0) === 0`
 * 이 세 어댑터에 **24곳** 복사돼 있었고, 블록마다 *"worker 와 동일 가드"* 라고 적혀 있었다 —
 * 그건 규칙이 아니라 관례다.
 *
 * ★**이게 실패한 전례가 이 레포에 있다.** 같은 모양의 형제 사다리(`http-bridge` 의 role
 *  게이트)에서 `/set-session-profile` 이 빠져 **read 토큰이 쓰기를 했다**(2026-07-28 —
 *  그 파일 주석에 흔적이 남아 있다). 손으로 유지하는 게이트는 언젠가 한 줄을 빠뜨린다.
 *
 * 지키는 것 넷:
 *  ① **사다리가 실제로 그렇게 판정한다** — 표를 읽는 게 아니라 `reaches()` 를 **부른다**.
 *  ② **세 어댑터가 같은 판정을 쓴다** — 한 곳만 고쳐지면 "codex 로 바꾸면 매니저가
 *     update_self 를 갖는" 종류의 비대칭이 생긴다(원칙 #2).
 *  ③ **날 조건식이 되살아나지 않는다** — 다음 사람이 습관대로 `depth === 0 && …` 를 쓰면
 *     표를 우회한다. 그 순간을 잡는다.
 *  ④ **위험한 것이 위임된 턴에 안 간다** — 재귀를 낳거나 데몬 구성을 바꾸는 것들.
 *
 * 등급: ①②④는 **동작**(판정을 실행), ③은 소스 대조(그 성질이 소스에만 있다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REACH,
  capabilitiesFor,
  reaches,
  turnKindOf,
  type CapabilityName,
  type TurnKind,
} from "../../core/llm-runtime/capability-reach.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTERS = [
  "src/core/llm-runtime/adapters/claude-agent-sdk.ts",
  "src/core/llm-runtime/adapters/openai-agents-sdk.ts",
  "src/core/llm-runtime/adapters/openai-codex-oauth.ts",
];

/** 위임된 턴이 **절대** 가지면 안 되는 것 — 재귀를 낳거나 데몬 구성을 바꾼다. */
const NEVER_DELEGATED: CapabilityName[] = [
  "workers",
  "endpoints",
  "commands",
  "update-self",
  "mcp-admin",
  "model-settings",
  "home-widgets",
];

export const check: RegressionCheck = {
  name: "capability-reach",
  guards:
    "도구가 어느 턴에 나가는지가 세 어댑터의 조건식 24곳에 손으로 복사돼 있어, 새 도구를 게이트 없이 더해도 아무것도 안 잡던 것(같은 모양의 형제 사다리가 실제로 뚫려 read 토큰이 쓰기를 한 전례가 있다) + 한 어댑터만 고쳐져 매니저가 어댑터에 따라 다른 도구를 갖는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 턴 종류 도출 — 두 카운터에서 한 번 ──────────────────────────────
    const kinds: Array<[string, { subagentDepth?: number; workerDepth?: number }, TurnKind]> = [
      ["메인", {}, "main"],
      ["메인(명시 0)", { subagentDepth: 0, workerDepth: 0 }, "main"],
      ["매니저", { workerDepth: 1 }, "manager"],
      ["서브에이전트", { subagentDepth: 1 }, "subagent"],
      ["매니저가 띄운 자식", { subagentDepth: 1, workerDepth: 1 }, "subagent"],
    ];
    const wrongKind = kinds.filter(([, input, want]) => turnKindOf(input) !== want);
    out.push(
      assert(
        "★턴 종류가 두 카운터에서 바르게 나온다(매니저가 띄운 자식도 **서브에이전트** — 더 깊은 쪽이 이긴다)",
        wrongKind.length === 0,
        wrongKind.length === 0
          ? kinds.map(([n, i]) => `${n}=${turnKindOf(i)}`).join(" · ")
          : `★틀림: ${wrongKind.map(([n]) => n).join(", ")}`,
      ),
    );

    // ── ② 사다리 — **부른다** ─────────────────────────────────────────────
    const mainSet = capabilitiesFor("main");
    const managerSet = capabilitiesFor("manager");
    const subSet = capabilitiesFor("subagent");
    out.push(
      assert(
        "★★사다리가 포개진다 — 서브에이전트가 받는 것은 매니저도, 매니저가 받는 것은 메인도 받는다(메인이 못 받는 도구는 없다)",
        subSet.every((n) => managerSet.includes(n)) &&
          managerSet.every((n) => mainSet.includes(n)) &&
          mainSet.length === Object.keys(REACH).length,
        `메인 ${mainSet.length} ⊇ 매니저 ${managerSet.length} ⊇ 서브 ${subSet.length}`,
      ),
    );
    out.push(
      assert(
        "★`spawn_agent`(agents)은 매니저까지 — 매니저는 자식을 띄우고, 자식은 못 띄운다(재귀 팬아웃 차단)",
        reaches("agents", "main") &&
          reaches("agents", "manager") &&
          !reaches("agents", "subagent"),
        `main=${reaches("agents", "main")} manager=${reaches("agents", "manager")} subagent=${reaches("agents", "subagent")}`,
      ),
    );

    // ── ④ 위험한 것이 위임된 턴에 안 간다 ─────────────────────────────────
    const leaked = NEVER_DELEGATED.filter(
      (n) => reaches(n, "manager") || reaches(n, "subagent"),
    );
    out.push(
      assert(
        "★★재귀를 낳거나 데몬 구성을 바꾸는 도구가 **위임된 턴에 안 간다**(매니저가 update_self 를 부르면 자기를 돌리는 데몬을 재시작한다)",
        leaked.length === 0,
        leaked.length === 0 ? `${NEVER_DELEGATED.length}개 전부 메인 전용` : `★샘: ${leaked.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "일하는 데 필요한 것은 위임된 턴도 받는다(메모리·스킬·세션 도구가 없으면 매니저가 반쪽이 된다)",
        (["memory", "skills", "session-tools", "projects"] as CapabilityName[]).every((n) =>
          reaches(n, "subagent"),
        ),
        capabilitiesFor("subagent").join(" "),
      ),
    );
    out.push(
      assert(
        "플러그인 도구는 오늘 **전부**에게 간다 — 그 답이 표에 **명시**돼 있다(조건 없는 통과로 두면 결정인지 빠뜨림인지 모른다)",
        REACH.plugins === "subagent" && reaches("plugins", "subagent"),
        `plugins=${REACH.plugins}`,
      ),
    );

    // ── ③ 날 조건식이 되살아나지 않는다 (소스) ────────────────────────────
    //  ★도구 조립부에서만 본다. `depth` 는 스트리밍·트레이스 판정에도 쓰이므로
    //   (`enabled:`·`traceDelta`) 그 자리는 이 규칙의 대상이 아니다 — 같은 문자열이라고
    //   묶으면 질문이 다른 둘을 한 판정에 담는 것이다.
    const regrown: string[] = [];
    for (const rel of ADAPTERS) {
      const src = readFileSync(path.join(REPO, rel), "utf8");
      for (const line of src.split("\n")) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) continue;
        if (!/workerDepth \?\? 0\) === 0/.test(t)) continue;
        // 도구를 등록하는 자리인가 — `if (…) {` 또는 조건부 spread.
        if (/^(if \(|\.\.\.\()/.test(t)) regrown.push(`${path.basename(rel)}: ${t.slice(0, 60)}`);
      }
    }
    out.push(
      assert(
        "★★어댑터 도구 조립부에 **날 게이트가 없다** — 습관대로 `depth === 0 && workerDepth === 0` 을 쓰면 표를 우회하고, 그게 24곳이 된 경위다",
        regrown.length === 0,
        regrown.length === 0 ? "세 어댑터 모두 reaches() 로만 판정" : `★되살아남: ${regrown.join(" / ")}`,
      ),
    );

    // ── ② 세 어댑터가 같은 판정을 쓴다 ────────────────────────────────────
    const perAdapter = ADAPTERS.map((rel) => {
      const src = readFileSync(path.join(REPO, rel), "utf8");
      const names = new Set(
        [...src.matchAll(/reaches\("([a-z-]+)"/g)].map((m) => m[1] as string),
      );
      return { rel, names };
    });
    const union = new Set(perAdapter.flatMap((a) => [...a.names]));
    const asymmetric = perAdapter
      .filter((a) => a.names.size !== union.size)
      .map((a) => `${path.basename(a.rel)}(${a.names.size}/${union.size})`);
    out.push(
      assert(
        "★★세 어댑터가 **같은 능력 집합**을 게이트한다 — 한쪽만 고쳐지면 '모델을 바꾸면 매니저가 다른 도구를 갖는' 비대칭이 된다(원칙 #2)",
        asymmetric.length === 0 && union.size >= 8,
        asymmetric.length === 0 ? `${union.size}개 대칭: ${[...union].sort().join(" ")}` : `★비대칭: ${asymmetric.join(" ")}`,
      ),
    );
    const unknown = [...union].filter((n) => !(n in REACH));
    out.push(
      assert(
        "어댑터가 부르는 이름이 전부 표에 있다(표에 없는 이름은 타입 에러지만, 표만 지우는 변이도 잡는다)",
        unknown.length === 0,
        unknown.length === 0 ? `${union.size}개 전부 표에 있음` : `★표에 없음: ${unknown.join(", ")}`,
      ),
    );

    return out;
  },
};
