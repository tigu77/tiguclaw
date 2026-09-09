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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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


/**
 * ★**«가르치는 문장» 만 본다** — 인용은 빼고.
 *
 * 사고: 금지어 grep 이 «`wait:` 를 쓰지 마라 — 없어진 인자다» 라는 **옳은 경고**를 위반으로
 * 셌다(적대 검토 실측). 그러면 **재발을 막는 유일한 수단(문서로 못 박기)이 게이트에 의해
 * 봉쇄된다.** 같은 파일의 주석이 이미 그 함정을 적어뒀는데 옆 단언을 반대로 구현했다.
 *
 * 판정: 그 줄에 부정어(쓰지 마라·금지·없어진·아니다·안 된다·삭제)가 있으면 **인용**이다.
 */
const teachesPattern = (text: string, re: RegExp): boolean =>
  text
    .split("\n")
    .filter((l) => re.test(l))
    .some((l) => !/쓰지 마라|쓰지마라|금지|없어진|없앴|아니다|안 된다|안된다|삭제|더는|이제는/.test(l));

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
      // ★★**명세뿐 아니라 «명세를 만들라고 가르치는 글»도 본다** (2026-09-08).
      //  위 검사는 `agents/*.md` 의 `model:` **값**을 본다. 그런데 하루에 세 곳이 그 값을
      //  **틀리게 가르치고 있었다** — 래퍼 스킬이 «opus 는 티어로 해석되니 그대로 두면 됨»
      //  (거짓: 모르는 값은 에러 없이 디폴트로 떨어져 등급 의도만 사라진다), 오케스트레이션
      //  문서 둘이 «high→opus 매핑» 이라는 **없어진 규칙**을 적고 있었다.
      //  ★값을 지키면서 안내를 안 지키면, 사람은 안내를 읽고 값을 틀리게 쓴다.
      //  ★**«금지어 grep» 이 아니라 «필수어»로 판정한다** — 옳은 문서도 «`opus` 라고 쓰지
      //   마라» 처럼 그 낱말을 **인용**하기 때문이다(금지로 잡으면 정답이 빨개진다).
      ...(() => {
        const walk = (dir: string): { file: string; text: string }[] => {
          if (!existsSync(dir)) return [];
          const out2: { file: string; text: string }[] = [];
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p2 = `${dir}/${e.name}`;
            if (e.isDirectory()) out2.push(...walk(p2));
            else if (e.name.endsWith(".md")) out2.push({ file: p2, text: readFileSync(p2, "utf8") });
          }
          return out2;
        };
        const docs = walk("skills");
        // ★**«보여주는 글» 과 «설명하는 글» 을 가른다** — 첫 판이 이 둘을 안 갈라
        //  프런트매터 예시(`model: high`, 옳은 값)와 `provider:model` 직접 지정(실제 지원
        //  문법)까지 빨갛게 했다. 틀리게 **가르칠 수 있는** 글만 대상이다: 이 필드의
        //  **뜻**을 말하는 글(등급·티어·모델명을 논하는 글).
        const teaching = docs.filter(
          (d) => /`model:?`|model:/.test(d.text) && /등급|티어|모델명/.test(d.text),
        );
        const noProfile = teaching.filter((d) => !/프로파일/.test(d.text));
        const stale = docs.filter((d) => teachesPattern(d.text, /high\s*→\s*opus|MODEL_TIER|티어로 해석|티어로 읽|알아서 (등급|세기)/));
        return [
          assert(
            "★★`model:` 을 설명하는 빌트인 문서는 **«프로파일 이름»이라고 말한다** — 값만 지키고 안내를 안 지키면 읽은 사람이 값을 틀리게 쓴다(모르는 값은 에러 없이 디폴트로 떨어져 등급 의도만 사라진다)",
            teaching.length > 0 && noProfile.length === 0,
            teaching.length === 0
              ? "★`model:` 을 다루는 문서를 못 찾았다(검사가 공허하다)"
              : noProfile.length === 0
                ? `${teaching.length}개 전부 «프로파일» 을 말한다`
                : `★«프로파일» 없이 설명: ${noProfile.map((d) => d.file).join(", ")}`,
          ),
          assert(
            "★★없어진 도구 인자(`spawn_agent(wait:…)`)를 아직 가르치는 문서가 없다 — 이 도구는 **항상 즉시 jobId** 를 준다. 「기본은 기다린다」고 가르치면 따르는 쪽이 **아직 안 쓰인 산출물**을 읽으러 간다",
            (() => docs.filter((d) => teachesPattern(d.text, /wait\s*:\s*(true|false)/)).length === 0)(),
            (() => {
              const bad = docs.filter((d) => teachesPattern(d.text, /wait\s*:\s*(true|false)/));
              return bad.length === 0
                ? `문서 ${docs.length}개에 없어진 인자 0건`
                : `★아직 가르침: ${bad.map((d) => d.file).join(", ")}`;
            })(),
          ),
          // ★**«합류하라» 를 의무로 걸지 않는다** (2026-09-09 사용자 판단: *"이걸 사용할지
          //  안할지는 오케스트레이터 정하면 될 일"*). 도구 자신이 «합류하지 않고 턴을
          //  끝내도 결과는 사라지지 않는다» 고 말한다 — 첫 판이 이걸 필수로 걸어
          //  **판단이어야 할 것을 규칙으로** 만들 뻔했다.
          assert(
            "★없어진 규칙(`high→opus` · `MODEL_TIER_*` · «티어로 해석»)을 아직 가르치는 문서가 없다",
            stale.length === 0,
            stale.length === 0 ? "낡은 매핑 0건" : `★${stale.map((d) => d.file).join(", ")}`,
          ),
        ];
      })(),
    ];
  },
};
