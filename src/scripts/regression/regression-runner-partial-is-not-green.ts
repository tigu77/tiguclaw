/**
 * 회귀: **부분 실행이 «전체 통과» 로 보이지 않는다** (2026-09-11).
 *
 * 배경: 변이 하나 확인하는 데 스위트 3,200건을 통째로 돌리고 있었다(하루 약 25회 실측).
 * 그래서 러너에 «이 검사만» 필터를 넣었다 — `npm run test:regression -- fast-mode`.
 *
 * ★**그 편의가 곧 이 레포가 가장 싫어하는 실패 모양의 입구다.** 필터를 건 실행이 «✅ 회귀
 *  스위트 통과» 를 찍으면, 로그만 보는 사람에게 «전체를 봤다» 와 구분이 안 된다. 러너가
 *  이미 같은 사고로 한 번 못을 박았다 — 배포본에서 `*.ts` 를 못 찾아 **검사 0개로 «통과,
 *  0건» · exit 0** 이 나오던 것(`checks.length === 0` 가드). 필터는 그 구멍을 **사람이
 *  일부러 여는** 손잡이라, 가드도 같이 따라와야 한다.
 *
 * 그래서 셋을 **러너를 실제로 돌려서** 잰다:
 *
 *  1. 필터를 걸면 최종 줄이 «부분 실행» 이라고 말하고, «✅ 회귀 스위트 통과» 는 **안 나온다**.
 *  2. 몇 개 중 몇 개를 돌렸는지 그 줄에 있다 — 로그가 혼자 서야 한다
 *     ([[feedback_logs_must_stand_alone]]).
 *  3. 필터가 **하나도 못 맞히면 실패**(exit 1). 오타 한 글자로 «0건 초록» 이 나오면 안 된다.
 *
 * ★검사 이름을 손으로 박지 않는다 — 자식에게 **이 파일 자신**을 필터로 준다. 그러면 «어떤
 *  검사가 존재하나» 에 의존하지 않아 파일이 지워져도 이 검사가 거짓말하지 않는다. 무한 재귀는
 *  `REGRESSION_SELFTEST_CHILD` 로 끊는다(자식에서 이 검사는 0건을 돌려주고 끝낸다) — 덕분에
 *  자식 실행이 **검사 0개 분량**이라 싸다.
 *
 * ★필터 **없는** 경로(전체 실행)는 여기서 안 잰다 — 그걸 재려면 3,200건을 또 돌려야 하고,
 *  그 경로는 이 스위트가 **매일 스스로** 증명한다(지금 이 줄이 그 안에서 돌고 있다).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { probeInterpreter } from "./_probe-helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = "regression-runner-partial-is-not-green";

interface Run {
  readonly out: string;
  readonly code: number | null;
  readonly spawnError: string;
}

/**
 * 러너의 **최종 판정 줄**만 — 출력 전체를 `includes` 로 보면 안 된다.
 *
 * ★첫 판이 여기서 걸렸다(실측): 판정 문구를 출력 전체에서 찾았더니, 러너가 검사마다 찍는
 *  **`guards` 설명**에 같은 낱말이 들어 있어 **자기 자신의 설명에 오탐**했다. 이 파일의
 *  `guards` 가 «…«✅ 회귀 스위트 통과» 로 보이던 것» 이라고 적고 있기 때문이다.
 * ★문구를 바꿔 피하지 않는다 — 그건 우연이고, 다른 검사 설명에 같은 낱말이 들어오는 날 또
 *  터진다. **줄 시작**으로 판정 줄을 식별한다(설명은 줄 중간에 온다).
 */
const verdictOf = (out: string): string =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(✅ 회귀 스위트|🔴 회귀 스위트|⚠️ 부분 실행|🔴 부분 실행)/.test(l))
    .at(-1) ?? "";

/** 러너를 자식으로 돌린다 — 인자가 곧 필터다. */
const runRunner = (args: readonly string[]): Run => {
  const r = spawnSync(
    probeInterpreter(REPO),
    ["src/scripts/regression/run.ts", ...args],
    {
      cwd: REPO,
      // ★자식 안에서 이 검사가 또 자식을 띄우지 않게 — 재귀 차단.
      env: { ...process.env, REGRESSION_SELFTEST_CHILD: "1" },
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  return {
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    code: r.status,
    spawnError: r.error === undefined ? "" : String(r.error.message),
  };
};

export const check: RegressionCheck = {
  name: SELF,
  guards:
    "부분 실행(`-- <필터>`)이 «✅ 회귀 스위트 통과» 로 보이던 것 — 로그만 보면 전체를 돈 것과 " +
    "구분이 안 된다 + 필터 오타로 «0건 초록» 이 나오던 것",
  async run(): Promise<Assertion[]> {
    // ★자식으로 불린 판 — 여기서 또 자식을 띄우면 무한 재귀다. 0건을 돌려주고 끝낸다.
    //  (러너는 이 «0건» 으로도 부분 실행 문구를 찍으므로 부모가 재려는 것은 그대로 재진다.)
    if (process.env.REGRESSION_SELFTEST_CHILD === "1") return [];

    const out: Assertion[] = [];

    // ── ① 필터를 걸면 «통과» 라고 말하지 않는다 ────────────────────────────────────
    const partial = runRunner([SELF]);
    const partialVerdict = verdictOf(partial.out);
    out.push(
      assert(
        "★러너가 실제로 돌았다(0이면 아래는 미검사다)",
        partial.spawnError === "" && partialVerdict !== "",
        partial.spawnError !== ""
          ? `★spawn 실패 — ${partial.spawnError}`
          : partial.out.slice(-300),
      ),
      assert(
        "★★부분 실행의 **판정 줄이 «전체 통과» 가 아니다** — 이 한 문장이 필터의 안전장치 전부다. 초록 로그만 복붙되면 다음 사람은 전체를 돈 줄 안다",
        partialVerdict.startsWith("⚠️ 부분 실행"),
        partialVerdict === "" ? "(판정 줄 없음)" : partialVerdict.slice(0, 200),
      ),
      assert(
        "★★무엇을 **안 봤는지**가 그 줄에 있다 — 선택 개수(n/전체)와 필터가 적혀야 로그가 혼자 선다",
        /\d+\/\d+개/.test(partialVerdict) && partialVerdict.includes(SELF),
        partialVerdict === "" ? "(판정 줄 없음)" : partialVerdict.slice(0, 200),
      ),
      assert(
        "★부분 실행도 실패가 없으면 exit 0 — 경고 문구를 넣자고 성공을 실패로 만들면 CI 가 못 쓴다",
        partial.code === 0,
        `exit=${String(partial.code)}`,
      ),
    );

    // ── ② 필터가 하나도 못 맞히면 **실패**다 ──────────────────────────────────────
    // ★러너가 `checks.length === 0` 에 못박은 것과 같은 사고 — «안 돈 것» 과 «통과» 는 다르다.
    const miss = runRunner(["__no_such_check_name__"]);
    out.push(
      assert(
        "★★필터가 0개를 맞히면 **exit 1** — 오타 한 글자가 «0건 초록» 이 되면, 그 순간 이 스위트는 아무것도 안 보면서 통과한다",
        miss.code === 1,
        `exit=${String(miss.code)}`,
      ),
      assert(
        "★그 실패가 **이유를 말한다** — «아무것도 안 돈 것이지 통과가 아니다» 를 사람이 읽을 수 있어야 다음 행동이 정해진다",
        miss.out.includes("맞는 검사가 없다") && miss.out.includes("통과가 아니다"),
        (miss.out.split("\n").find((l) => l.includes("필터")) ?? "(줄 없음)").slice(0, 200),
      ),
      assert(
        "★0개 매치는 **검사를 하나도 돌리지 않는다** — 판정 줄이 아예 없어야 한다(«통과» 도 «부분 실행» 도 아니다)",
        verdictOf(miss.out) === "",
        verdictOf(miss.out) === "" ? "판정 줄 없음" : `🔴 ${verdictOf(miss.out).slice(0, 160)}`,
      ),
    );

    return out;
  },
};
