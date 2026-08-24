/**
 * 회귀: **에이전트 `model:` 어휘는 소비자를 따른다** (2026-08-08).
 *
 * 에이전트 명세의 `model:` 은 **우리 어휘**(`high`/`mid`/`low` 프로파일)로만 쓴다.
 * `opus`/`sonnet`/`haiku` 는 **클로드 개념**이라 우리 레포에 두지 않는다(사용자 지정).
 *
 * ★그런데 오랫동안 **둘이 같아도 티가 안 났다.** claude 어댑터가 SDK 네이티브 경로로 갈 때
 *  `mapTierToSdkModel` 이 `high→opus`·`mid→sonnet` 으로 **뭉개** 어느 쪽을 써도 결과가 같았다.
 *  우리 루프(`spawn_agent`)로 오면 갈린다 — `resolveModelChain("opus")` 는 프로파일 조회에
 *  실패해 레거시 단일 풀로 떨어지고, **그 에이전트만 멀티 LLM 밖에 남는다**(원칙 2 위반).
 *
 * ★**2026-08-24 정정 — 위 문단의 전제가 틀렸다.** 종전엔 "Claude Code 는 `high` 를 못
 *  알아듣고 세션 모델을 **상속**하니 양쪽에 우리 어휘를 써도 둘 다 맞는다" 고 적혀 있었다.
 *  그런데 실제로는 **상속이 아니라 기동 실패**다 — `.claude/agents/*` 가 `model: high|mid`
 *  인 채로 서브에이전트를 띄우려다 **두 번 연달아 실패**했고(적대 검토 팀), `general-purpose`
 *  + 명시 `model: opus` 로 우회해야 돌았다. 사용자 판단: **"수정해야지."**
 *
 * ★그래서 규칙은 "우리 어휘로 통일" 이 아니라 **소비자별 유효성**이다:
 *    `agents/`·`.tiguclaw/agents/` (데몬이 읽음)      → 프로파일 이름. SDK 티어명 금지.
 *    `.claude/agents/`             (Claude Code 가 읽음) → 모델 이름. 프로파일 이름 금지.
 *  두 디렉터리는 심링크가 아니라 **별개 사본**이라(실측 `ls -la`) 각자 자기 소비자 문법을
 *  들 수 있다. 미러 동일성은 `agent-defs-match-reality` 가 보되 **`model:` 줄만 예외**다.
 *  ★이건 "이름이 같으니 묶자" 가 아니라 [[project_manager_agent_naming]] 과 같은 결론이다 —
 *   **UI·모델 대면만 개명하고 식별자는 그대로**, 즉 자리마다 그 자리의 어휘를 쓴다.
 *
 * ★이름 목록을 만들지 않는다: 금지 어휘(SDK 티어명)는 `mapTierToSdkModel` 이 인식하는 값이고,
 *  대상 디렉터리는 "데몬이 읽는가"로 정한다.

 * ─────────────────────────────────────────────────────────────────────────────
 * ★등급: **배선 린트** (2026-08-08 레드팀 결과 표시)
 *  이 파일의 단언 상당수는 **소스를 훑는다** — 코드가 그렇게 *쓰여 있는지*는 보지만
 *  그렇게 *동작하는지*는 못 본다. `if (false)`·env 게이트·조건 강화·동의어 치환으로
 *  전부 우회된다(레드팀이 13개 변이로 실증했고 7개를 동시에 넣어도 전 스위트 초록이었다).
 *  ★그러니 **우연한 드리프트는 잡지만 적은 못 막는다.** 행동을 지켜야 하는 축은 판정을
 *   순수 함수로 뽑아 **실행**해야 한다(`swallowed-failure.ts` 가 그 예).
 *  등급을 적어 두는 이유: 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다 —
 *  다음 사람이 "여긴 그물이 있다" 고 믿고 지나간다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** claude SDK 네이티브 티어 어휘 — 데몬 자산이 쓰면 프로파일 풀·폴백을 잃는다. */
const SDK_TIER_WORDS = new Set(["opus", "sonnet", "haiku"]);

/**
 * 우리 프로파일 이름 — `.claude/agents/` 가 쓰면 Claude Code 가 **기동에 실패**한다.
 * ★목록을 손으로 적지 않는다([[feedback_hand_maintained_lists]]): 데몬 자산이 실제로 쓰는
 *  값에서 뽑는다. 프로파일을 새로 만들어 `agents/` 에 쓰면 `.claude/` 금지어도 같이 는다.
 */
const profileWordsFrom = (lists: Array<Array<{ file: string; model: string }>>): Set<string> =>
  new Set(lists.flat().map((x) => x.model).filter((m) => !SDK_TIER_WORDS.has(m)));

/** `<dir>` 안 .md 의 `model:` 값 목록. 디렉터리 부재는 null(배포 레포엔 없는 경로가 있다). */
const modelValues = async (
  dir: string,
): Promise<Array<{ file: string; model: string }> | null> => {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const out: Array<{ file: string; model: string }> = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const m = /^model:\s*(\S+)\s*$/m.exec(await readFile(path.join(dir, f), "utf8"));
    if (m !== null) out.push({ file: f, model: m[1]!.toLowerCase() });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "agent-model-vocabulary",
  guards:
    "데몬이 읽는 에이전트 명세가 SDK 티어명을 쓰지 않는다 — 쓰면 그 에이전트만 멀티 LLM 밖으로 떨어진다",
  run: async (): Promise<Assertion[]> => {
    const root = new URL("../../../", import.meta.url).pathname;
    // 데몬이 읽는 자산 두 곳(빌트인 + 이 레포의 프로젝트 스코프).
    const daemonDirs = ["agents", ".tiguclaw/agents"];
    const notes: string[] = [];
    const offenders: string[] = [];

    for (const rel of daemonDirs) {
      const list = await modelValues(path.join(root, rel));
      if (list === null) {
        // ★조용한 통과 금지 — 무엇을 못 봤는지 남긴다(배포 레포엔 `.tiguclaw/` 가 없다).
        notes.push(`${rel}:없음`);
        continue;
      }
      notes.push(`${rel}:${list.length}개`);
      for (const { file, model } of list) {
        if (SDK_TIER_WORDS.has(model)) offenders.push(`${rel}/${file}=${model}`);
      }
    }

    // ★`.claude/agents/` 는 **다른 소비자**다 — 우리 어휘를 박으면 기동이 깨진다(위 정정).
    const ccList = await modelValues(path.join(root, ".claude/agents"));
    const daemonLists: Array<Array<{ file: string; model: string }>> = [];
    for (const rel of daemonDirs) {
      const l = await modelValues(path.join(root, rel));
      if (l !== null) daemonLists.push(l);
    }
    const profileWords = profileWordsFrom(daemonLists);
    const ccBad = (ccList ?? []).filter((x) => profileWords.has(x.model));

    return [
      assert(
        "데몬 자산을 실제로 읽었다(검사가 빈손으로 통과하지 않는다)",
        notes.some((n) => !n.endsWith(":없음")),
        notes.join(" · "),
      ),
      assert(
        "★데몬이 읽는 에이전트는 SDK 티어명(opus/sonnet/haiku)을 쓰지 않는다",
        offenders.length === 0,
        offenders.length === 0 ? notes.join(" · ") : offenders.join(", "),
      ),
      assert(
        "★`.claude/agents` 는 **모델 이름**을 쓴다(프로파일 이름이면 서브에이전트가 안 뜬다)",
        ccBad.length === 0,
        ccList === null
          ? ".claude/agents 없음(배포 레포)"
          : ccBad.length === 0
            ? `${ccList.length}개 · ${ccList.map((x) => x.model).join(",")}`
            : `★프로파일 이름이 박혔다: ${ccBad.map((x) => `${x.file}=${x.model}`).join(", ")}`,
      ),
      // ★금지어를 실제로 들고 있는지 — 빈 Set 이면 위 단언이 항상 초록이 된다(가짜 검사).
      assert(
        "금지어 목록이 데몬 자산에서 실제로 뽑혔다(빈 목록으로 통과하지 않는다)",
        profileWords.size > 0 || daemonLists.length === 0,
        profileWords.size > 0 ? [...profileWords].sort().join(",") : "데몬 자산 없음(배포 레포)",
      ),
    ];
  },
};
