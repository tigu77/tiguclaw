/**
 * 회귀: **Claude 실행기와 경로가 보인다** (2026-08-27).
 *
 * 세 갈래가 같은 병이었다 — *"필요한 것이 어디 있는지 아무도 말해주지 않는다."*
 *
 *  ① **doctor 가 실행기를 안 봤다.** 키만 보고 통과시켜서, **키는 있는데 실행기가 없는**
 *     상태가 "정상" 으로 보였다. rg 는 보면서 이건 안 봤다.
 *  ② **어댑터가 SDK 원문을 그대로 냈다** — `Is options.pathToClaudeCodeExecutable set?`.
 *     그 옵션은 **우리 코드의 인자 이름**이라 사용자에겐 뜻이 없다. 게다가 풀에 다른
 *     provider 가 있으면 폴백이 조용히 덮어 **claude 만 영영 죽어 있는 걸 아무도 모른다.**
 *  ③ **모델이 `<home>` 을 몰랐다.** 매 턴 env 블록엔 `Working directory` 뿐인데 그건
 *     턴마다 달라진다(프로젝트 폴더일 수 있다). 그래서 *"테마 만들어줘"* 에 갈 곳이 없었다 —
 *     도구 설명에 "홈에 두세요" 라고 적어도 **홈이 어딘지 모르면 실행 불가**다.
 *
 * ★셋 다 "안내가 한 걸음 앞에서 끊긴다" 는 같은 형상이다. 검사도 한 자리에 둔다.
 *
 * 등급: **동작 검사**(해석기·env 렌더를 실제로 부른다) + 소스 대조(doctor·어댑터 배선).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBundledClaude, bundledClaudeMissingHint } from "../../core/claude-cli.js";
import { formatEnvContext } from "../../core/runtime-env.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** SDK 가 **실제로** 만드는 문구 3종 — 번들에서 떠서 확인했다(지어낸 게 아니다). */
const SDK_MESSAGES = [
  "Claude Code native binary not found at /p. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
  "Claude Code executable not found at /p. Is options.pathToClaudeCodeExecutable set?",
  "Claude Code executable at /p exists but failed to launch.",
];

export const check: RegressionCheck = {
  name: "claude-runtime-is-visible",
  guards:
    "doctor 가 키만 보고 실행기 부재를 '정상' 으로 통과시키던 것 + 어댑터가 SDK 원문(우리 옵션 이름이 든)을 그대로 내보내 사용자가 조치를 알 수 없던 것(폴백이 덮으면 아예 안 보임) + 모델이 <home> 을 몰라 '테마 만들어줘' 에 갈 곳이 없던 것",
  run: async (): Promise<Assertion[]> => {
    const adapter = strip(read("src/core/llm-runtime/adapters/claude-agent-sdk.ts"));
    const doctor = strip(read("src/scripts/doctor.ts"));
    const themeTool = read("src/core/llm-runtime/capabilities/model-settings-mcp.ts");
    const env = formatEnvContext({ cwd: "/tmp/some-project" });

    // ② 판정 함수를 **실제 SDK 문구로** 태운다. 어댑터에서 떼어 vm 없이 재현한다.
    const reSrc = /const isClaudeExecutableMissing[\s\S]{0,400}?return (\/.*?\/i)\.test/.exec(
      adapter,
    )?.[1];
    let matched = 0;
    if (reSrc !== undefined) {
      const body = /^\/(.*)\/i$/.exec(reSrc)?.[1] ?? "";
      const re = new RegExp(body, "i");
      matched = SDK_MESSAGES.filter((m) => re.test(m)).length;
    }

    return [
      // ── ① doctor ──
      assert(
        "★doctor 가 Claude 실행기를 본다(키만 보고 통과시키지 않는다)",
        /findBundledClaude\(\)/.test(doctor) && /issues\.push\(\s*\n?\s*"Claude 실행기 없음/.test(doctor),
        `해석 호출=${/findBundledClaude\(\)/.test(doctor)} · 문제로 보고=${/Claude 실행기 없음/.test(doctor)}`,
      ),
      // ── ② 어댑터 ──
      assert(
        "★판정 정규식을 떼어냈다(못 떼면 아래는 미검사다)",
        reSrc !== undefined,
        reSrc ?? "★isClaudeExecutableMissing 을 못 찾음 — 구조가 바뀌었나",
      ),
      assert(
        "★SDK 실제 문구 3종을 전부 잡는다(내가 지어낸 패턴이 아니다)",
        matched === SDK_MESSAGES.length,
        `${matched}/${SDK_MESSAGES.length} — 하나라도 놓치면 그 경로만 원문이 그대로 나간다`,
      ),
      assert(
        "★잡은 뒤 **우리 말로** 바꿔 던진다(원문만 흘리지 않는다)",
        /if \(isClaudeExecutableMissing\(e\)\) \{[\s\S]{0,300}?bundledClaudeMissingHint\(\)/.test(
          adapter,
        ),
        /isClaudeExecutableMissing\(e\)/.test(adapter)
          ? "치환 있음"
          : "★판정만 있고 치환이 없다 — 사용자에겐 여전히 우리 옵션 이름이 보인다",
      ),
      assert(
        "★안내가 전역 설치를 시키지 않는다(같은 259MB 를 두 벌 받게 하지 마라)",
        !/npm i -g/.test(bundledClaudeMissingHint().split("지원 안 하는")[0]),
        bundledClaudeMissingHint().slice(0, 70),
      ),
      // ── ③ 경로 ──
      assert(
        "★env 블록이 홈과 앱 루트를 싣는다(cwd 는 턴마다 달라 홈과 무관하다)",
        /tiguclaw home: \//.test(env) && /tiguclaw app root: \//.test(env),
        env.split("\n").filter((l) => l.startsWith("tiguclaw ")).join(" · ") || "★두 줄이 없다",
      ),
      assert(
        "★홈과 앱 루트가 서로 다른 값으로 나온다(같으면 구분이 죽은 것)",
        (/tiguclaw home: (\S+)/.exec(env)?.[1] ?? "a") !==
          (/tiguclaw app root: (\S+)/.exec(env)?.[1] ?? "b"),
        `home=${/tiguclaw home: (\S+)/.exec(env)?.[1]} · root=${/tiguclaw app root: (\S+)/.exec(env)?.[1]}`,
      ),
      assert(
        "★테마 도구가 **만드는 자리**를 알려준다(고르기·덮어쓰기만 알던 것)",
        /<home>\/themes\/<이름>\.css/.test(themeTool),
        /<home>\/themes/.test(themeTool) ? "만들기 경로 있음" : "★새 테마를 만들 곳이 없다",
      ),
      assert(
        "★그 안내가 실재하는 것만 가리킨다(없는 도구를 시키지 않는다)",
        !/get_status/.test(themeTool),
        /get_status/.test(themeTool)
          ? "★존재하지 않는 `get_status` 를 가리킨다"
          : "env 블록을 가리킨다",
      ),
      // 해석기 자체 — 정상/부재 양쪽.
      assert(
        "★번들 실행기를 실제로 찾는다 + 없는 곳에선 null",
        findBundledClaude() !== null &&
          findBundledClaude("/tmp") === null &&
          existsSync(findBundledClaude() as string),
        `${findBundledClaude() ?? "★못 찾음"}`,
      ),
    ];
  },
};
