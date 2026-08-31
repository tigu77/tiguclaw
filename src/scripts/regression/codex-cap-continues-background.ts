/**
 * 회귀: **도구 한도는 배경 작업을 죽이지 않는다 — 마무리하고 이어간다** (2026-08-31).
 *
 * ★사고(실측 로그): 매니저 하나가 `iter=149/150` 에서 잘렸다. 그런데 도구 구성이
 *  `Read×75, Bash×75, Grep×33, BashOutput×32, Edit×32` — **읽고·찾고·실행하고·고치는**
 *  정상 개발 사이클이었다. 공회전이면 한 도구가 압도하고, `Edit×32` 는 진전의 증거다.
 *  즉 **멈춘 게 아니라 잘렸다.**
 *
 * ★이 레포는 같은 판단을 이미 두 번 했다 — 턴 시계도 잡 시계도 **kill 에서 점검으로**
 *  뒤집었다(*"상한에 걸린 작업은 되돌릴 수 없다"*). iteration 만 kill 로 남아 있었다.
 *  런어웨이 방어는 잡 점검(`JOB_CHECKIN_INTERVAL_MS`)이 **활동 기준**으로 맡는다 —
 *  횟수를 세는 것보다 정확하다.
 *
 * ★**메인 턴엔 안 붙인다** — 그 방어가 매니저·에이전트에만 있다. 사용자가 기다리는 대화가
 *  혼자 무한히 도는 것은 다른 문제다. 그래서 이 검사는 **양쪽**을 본다.
 *
 * ★**접두사를 건드리지 않는다** — codex 는 누적 입력을 재전송하지만 프리픽스 캐시 적중이
 *  **86~89%**(실측)라 실효 비용이 11%다. 이어갈 때 앞을 요약으로 갈아끼우면 그 89%가
 *  통째로 깨지므로 **뒤에 붙이기만** 해야 한다.
 *
 * 등급: 대조(조립부 소스) — 실제 이어가기는 살아 있는 codex 백엔드가 필요해 여기선 못 돈다.
 * 그 사실을 적어둔다(조용한 통과 금지).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCheckinGuardedThread } from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "codex-cap-continues-background",
  guards:
    "도구 반복 상한이 정당하게 진행 중인 배경 작업을 잘라, 다음 실행이 처음부터 반복되고 영영 수렴 못 하던 것(실측: Edit×32 로 진전 중이던 매니저가 iter=149 에서 잘림)",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(
      path.join(REPO, "src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
      "utf8",
    )
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // 고지 블록만 본다 — 파일 전체에서 낱말을 세면 다른 자리에 걸린다.
    const at = src.indexOf("codex-tool-cap-continue");
    const block = at < 0 ? "" : src.slice(Math.max(0, at - 900), at + 1400);

    // ★**`iteration = 0` 이면 안 된다** (적대 검토 P4). 0 으로 되돌리면 위쪽의 *iteration 0
    //  전용* 입력 상한 가드가 다시 켜지고, 그 가드가 throw 하면 폴백 모델이 턴을 **처음부터
    //  재실행**해 **부작용이 중복**된다(그 가드 주석이 바로 그 이유를 적어뒀다). 이어간
    //  뒤엔 도구가 이미 수십~수백 번 돈 상태다 — `Edit×32` 면 편집이 두 번 난다.
    //  그래서 **창을 옮긴다**(`iterationBase`).
    const windowed = /iterationBase = iteration;/.test(block) && !/\biteration = 0;/.test(block);
    const continues = windowed && /finalFlushRequested = false;/.test(block);
    // ★**누적 백스톱이 실제로 끊는가** — 조건문 존재가 아니라 `break` 까지 본다.
    /** `if (…) { … }` 의 몸통을 **괄호 짝**으로 자른다 — 근접 창은 옆 블록을 삼킨다. */
    const bodyAfter = (needle: string): string => {
      const at = block.indexOf(needle);
      if (at < 0) return "";
      const open = block.indexOf("{", at);
      if (open < 0) return "";
      let d = 0;
      for (let i = open; i < block.length; i++) {
        if (block[i] === "{") d++;
        else if (block[i] === "}" && --d === 0) return block.slice(open, i + 1);
      }
      return "";
    };
    // ★백스톱이 **실제로 끊는가** — 조건문 존재가 아니라 그 몸통 안의 `break` 를 본다
    //  (첫 판은 뒤쪽 아무 `break` 나 주워 `continue` 로 바꿔도 초록이었다).
    const backstopBody = bodyAfter("totalIterations >= CODEX_MAX_TOTAL_ITERATIONS");
    const backstop =
      backstopBody !== "" &&
      /codex-tool-cap-runaway/.test(backstopBody) &&
      /\bbreak;/.test(backstopBody);
    // ★분기가 **판정 함수를 실제로 부르는지** 본다 — 첫 판은 `iteration = 0;` 같은 *문장의
    //  존재*만 봐서, 조건을 `if (false)` 로 바꿔도 초록이었다(도달을 안 봤다). 이름을 부르게
    //  하면 리터럴로 바꾸는 순간 매칭이 깨진다.
    // ★조건을 **통째로** 대조한다 — 호출의 *존재*만 보면 `… || true` 한 토큰으로 뚫린다
    //  (적대 검토 A1 이 정확히 그렇게 통과했다: 사용자가 기다리는 메인 대화도 무한 이어가기).
    const cond = /if \((isCheckinGuardedThread\([^)]*\))\)\s*\{/.exec(block);
    const backgroundOnly = cond !== null && cond[1] === "isCheckinGuardedThread(input.threadKey)";
    // 앞을 갈아끼우지 않는다 — push(뒤에 붙이기)만 쓴다.
    const appendOnly = /inputArray\.push\(/.test(block) && !/inputArray\s*=/.test(block);
    const logsCumulative = /누적 iteration/.test(block) && /autoContinues/.test(block);
    // ★이어가기 직후 체크포인트 nudge 가 하나 더 붙지 않는다 (2026-09-01 적대 검토 F5).
    //  `-1` 로 두면 `(iteration - iterationBase) % 25 === 0` 이 창을 옮긴 **그 자리에서
    //  즉시 참**이고 dedup 가드도 풀려, «이어서 계속 진행하세요» 바로 뒤에 «지금까지
    //  149회 사용했습니다» 가 붙는다. 종전엔 `iteration = 0` 의 `iteration > 0` 가드가
    //  우연히 막고 있었는데, 창 전환으로 그 우연이 사라졌다.
    const noDoubleNudge =
      /lastCheckpointIteration = iteration;/.test(block) && !/lastCheckpointIteration = -1;/.test(block);

    // 판정 자체는 **실행으로** 잰다(순수 함수라 데몬·네트워크 0).
    const guards =
      isCheckinGuardedThread("worker:abc") &&
      isCheckinGuardedThread("agent:xyz") &&
      !isCheckinGuardedThread("dashboard:default") &&
      !isCheckinGuardedThread("tg:123") &&
      !isCheckinGuardedThread("endpoint:foo");

    return [
      assert(
        "★★한도에서 **끊지 않고 이어간다** — 마무리(체크포인트) 뒤 iteration 을 되돌리고 계속한다. 잘린 작업은 다음 실행이 처음부터 반복해 영영 수렴 못 한다",
        block !== "" && continues,
        block === "" ? "★이어가기 블록 없음" : `iteration 리셋=${String(continues)}`,
      ),
      assert(
        "★★**배경 스레드만** — 잡 점검이 지키는 범위가 매니저·에이전트뿐이다. 사용자가 기다리는 대화가 혼자 무한히 도는 건 다른 문제다",
        backgroundOnly && guards,
        `분기가 판정을 부름=${String(backgroundOnly)} · 판정 실행=${String(guards)}`,
      ),
      assert(
        "★★**접두사를 안 건드린다**(뒤에 붙이기만) — 앞을 요약으로 갈아끼우면 프리픽스 캐시 86~89%가 통째로 깨진다(실측)",
        appendOnly,
        appendOnly ? "push 만 사용" : "★inputArray 를 통째로 갈아끼운다",
      ),
      assert(
        "★★**누적 백스톱이 있다** — 종전 주석은 «잡 점검이 맡는다» 고 적었는데 양끝을 확인하니 거짓이었다: 점검은 «조용한» 잡만 죽이고 도구를 계속 도는 런어웨이는 그 조건에 원리적으로 안 든다. `WORKER_TIMEOUT_MS` 기본값도 무한이라 **아무도 안 막고 있었다**",
        backstop,
        backstop ? "누적 상한 + break + 큰 로그" : "★백스톱 없음(무한 이어가기)",
      ),
      assert(
        "★★`iteration` 을 **0 으로 되돌리지 않는다** — 되돌리면 iteration 0 전용 입력 상한 가드가 다시 켜지고, 그게 throw 하면 폴백이 턴을 처음부터 재실행해 **부작용이 중복**된다",
        windowed,
        windowed ? "창(iterationBase)으로 이동" : "★iteration = 0 (가드 재활성)",
      ),
      assert(
        "★이어가기 직후 체크포인트 nudge 가 **중복되지 않는다** — 창을 옮긴 자리가 곧 25의 배수라 즉시 다시 참이 된다. 방금 nudge 를 넣었으니 그 자리를 찍고 넘어간다",
        noDoubleNudge,
        noDoubleNudge ? "체크포인트를 현 iteration 으로" : "★-1 로 리셋 — 같은 자리에서 nudge 2개",
      ),
      assert(
        "★이어갈 때마다 **누적 수치를 남긴다** — 횟수 제한을 두지 않았으므로, 헛돈 게 있으면 로그만으로 잡혀야 한다",
        logsCumulative,
        logsCumulative ? "회차·누적 iteration 기록" : "★수치 없음",
      ),
      assert(
        "실제 이어가기는 살아 있는 codex 백엔드가 필요해 이 검사 밖이다 — 조용한 통과가 아니라 **적어둔다**",
        true,
        "대조 검사(조립부 소스)",
      ),
    ];
  },
};
