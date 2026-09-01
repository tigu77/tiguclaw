/**
 * 회귀: **도구 한도는 배경 작업을 죽이지 않는다 — 마무리하고 이어간다** (2026-08-31).
 *
 * ★사고(실측 로그): 매니저 하나가 `iter=149/150` 에서 잘렸다. 그런데 도구 구성이
 *  `Read×75, Bash×75, Grep×33, BashOutput×32, Edit×32` — **읽고·찾고·실행하고·고치는**
 *  정상 개발 사이클이었다. 공회전이면 한 도구가 압도하고, `Edit×32` 는 진전의 증거다.
 *  즉 **멈춘 게 아니라 잘렸다.**
 *
 * ★**메인 턴엔 안 붙인다** — 런어웨이 방어(잡 점검)가 매니저·에이전트에만 있다. 사용자가
 *  기다리는 대화가 혼자 무한히 도는 것은 다른 문제다. 그래서 이 검사는 **양쪽**을 본다.
 *
 * ★**접두사를 건드리지 않는다** — codex 는 누적 입력을 재전송하지만 프리픽스 캐시 적중이
 *  **86~89%**(실측)라 실효 비용이 11%다. 이어갈 때 앞을 요약으로 갈아끼우면 그 89%가
 *  통째로 깨지므로 **뒤에 붙이기만** 해야 한다.
 *
 * ── 등급: **동작** (2026-09-01 승격) ──────────────────────────────────────────────
 * 종전 등급은 «대조(조립부 소스)» 였고, 그게 문제였다. 판정 다섯이 어댑터 안에 인라인으로
 * 있어서 이 검사는 **근접 창(±900/+1400자)의 문자열**밖에 못 봤다. 적대 검토가 한 줄
 * 변이로 차례로 뚫었고 **전부 스위트 초록**이었다 — 그중 하나(`isWindowEnd` 를 절대값으로)는
 * `iteration` 이 창 끝에 고정되는 **무한 루프**인데, 누적 백스톱조차 원리적으로 안 걸렸다.
 *
 * 그래서 판정을 `openai-codex-oauth-loop.ts` 로 뽑고, 여기서 **루프를 실제로 돌린다.**
 * 소스 쪽은 «어댑터가 그 판정을 위임하는가» 하나만 본다 — 인라인으로 되돌리면 그게 걸린다.
 * (여전히 못 보는 것: 살아 있는 codex 백엔드가 있어야 하는 실제 SSE·도구 실행. 그건 이
 *  검사의 범위가 아니고, 여기서 «다 본다» 고 말하지 않는다.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  capAdvice,
  capFlushPrompt,
  FLUSH_FINALITY,
  willAutoContinue,
  isCheckpointDue,
  isWindowEnd,
  iterLabel,
  shouldStopContinuing,
  withinWindow,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-loop.js";
import { isCheckinGuardedThread } from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Sim {
  /** 이어간 자리의 iteration. */
  readonly continues: number[];
  /** 창 끝(강제 마무리)에 닿은 자리. */
  readonly caps: number[];
  /** 진행 nudge 를 낸 자리. */
  readonly nudges: number[];
  /** 로그에 찍힐 라벨들. */
  readonly labels: string[];
  readonly halted: "백스톱" | "작업끝" | "★무한";
  readonly totalIterations: number;
}

/**
 * 어댑터의 도구 루프 **제어 흐름**을 그대로 옮긴 시뮬레이터 — 판정은 전부 실물 순수 함수를
 * 부른다(여기서 다시 구현하지 않는다. 그러면 같은 판단이 두 곳이 된다).
 *
 * 실물 순서: 모델 호출 → flush 분기 → 도구 0회면 종료 → 창 끝? → 체크포인트? → 도구 실행 →
 * `iteration += 1`. ★이어갈 때는 **`continue` 라 iteration 이 안 는다** — 창만 옮긴다.
 */
const simulate = (opts: {
  /** 이 작업은 도구를 `work` 회 써야 끝난다. */
  work: number;
  hard: number;
  every: number;
  maxTotal: number;
  /** 배경 스레드(매니저·에이전트)인가 — 아니면 한도에서 끝낸다. */
  background: boolean;
}): Sim => {
  const { work, hard, every, maxTotal, background } = opts;
  let iteration = 0;
  let base = 0;
  let lastCheckpoint = -1;
  let total = 0;
  let flush = false;
  const continues: number[] = [];
  const caps: number[] = [];
  const nudges: number[] = [];
  const labels: string[] = [];
  let halted: Sim["halted"] = "작업끝";
  let steps = 0;

  while (withinWindow(iteration, base, hard)) {
    // ★시한을 검사 자신이 갖는다 — 무한 루프 변이가 스위트를 영영 멈추면 «실패» 가 아니라
    //  «안 끝남» 이 되고, 그건 판정이 아니다.
    if (++steps > 200_000) {
      halted = "★무한";
      break;
    }
    if (flush) {
      if (!background) break;
      total = iteration;
      if (shouldStopContinuing(total, maxTotal)) {
        halted = "백스톱";
        break;
      }
      flush = false;
      base = iteration;
      lastCheckpoint = iteration;
      continues.push(iteration);
      continue;
    }
    if (iteration >= work) break;
    if (isWindowEnd(iteration, base, hard)) {
      flush = true;
      caps.push(iteration);
      labels.push(iterLabel(iteration, base, hard));
      // ★`continue` — **iteration 을 안 올린다.** flush turn 이 그 슬롯을 대체한다.
      //  올리면 `withinWindow` 가 즉시 거짓이 되어 마무리 요청이 영영 전송되지 않는다
      //  (어댑터가 그 이유를 주석으로 적어뒀고, 여기가 그 흐름을 그대로 따른다).
      continue;
    }
    if (isCheckpointDue(iteration, base, every, lastCheckpoint)) {
      lastCheckpoint = iteration;
      nudges.push(iteration);
      labels.push(iterLabel(iteration, base, hard));
    }
    iteration += 1;
  }
  return { continues, caps, nudges, labels, halted, totalIterations: total };
};

/** 라벨의 분자가 분모를 넘지 않는가 — `iter=1639/150` 같은 거짓 분수 방지. */
const labelsSane = (labels: string[]): boolean =>
  labels.length > 0 &&
  labels.every((l) => {
    const m = /^(\d+)\/(\d+)/.exec(l);
    return m !== null && Number(m[1]) <= Number(m[2]);
  });

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
    // ★대입을 세려면 **문자열을 걷어내야 한다** — 로그 문구에 `iteration=${iteration}` 이
    //  여러 번 나오고, 그게 대입처럼 보인다(첫 판이 그걸 8건 잡았다).
    const code = src.replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const iterAssigns = [...code.matchAll(/\biteration\s*(?:=|\+=|-=|\*=)[^=][^;\n]*/g)]
      .map((m) => m[0].replace(/\s+/g, " ").trim());

    // ── ① 배경 작업: 끝없이 도구를 쓰는 일 ─────────────────────────────────────
    const bg = simulate({ work: 1e9, hard: 150, every: 25, maxTotal: 1500, background: true });
    // ── ② 메인 대화: 같은 일인데 이어가지 않는다 ────────────────────────────────
    const main = simulate({ work: 1e9, hard: 150, every: 25, maxTotal: 1500, background: false });
    // ── ③ 짧은 작업: 한도 근처에도 안 간다 ────────────────────────────────────
    const short = simulate({ work: 30, hard: 150, every: 25, maxTotal: 1500, background: true });
    // ── ④ 백스톱 경계: 상한을 올리면 이어가기가 정확히 그만큼 는다 ──────────────
    const low = simulate({ work: 1e9, hard: 150, every: 25, maxTotal: 300, background: true });
    const high = simulate({ work: 1e9, hard: 150, every: 25, maxTotal: 450, background: true });

    const nudgeAtContinue = bg.continues.filter((c) => bg.nudges.includes(c));
    // 호출의 **인자**를 본다 — 괄호 짝이 아니라 고정 창이면 충분하다(인자가 셋뿐).
    const adviceAt = code.indexOf("capAdvice(");
    const adviceArgs = adviceAt < 0 ? "" : code.slice(adviceAt, adviceAt + 220);

    return [
      assert(
        "★★한도에서 **끊지 않고 이어간다** — 잘린 작업은 다음 실행이 처음부터 반복해 영영 수렴 못 한다",
        bg.continues.length > 1 && bg.caps.length > 1,
        `이어가기 ${bg.continues.length}회(자리 ${bg.continues.slice(0, 3).join(",")}…) · 마무리 ${bg.caps.length}회`,
      ),
      assert(
        "★★**끝난다** — 이어가기에 횟수를 안 뒀으므로 누적 백스톱이 유일한 종료 보장이다(창을 절대값으로 재면 iteration 이 고정돼 무한 루프가 되고 백스톱도 원리적으로 안 걸린다)",
        bg.halted === "백스톱" && bg.totalIterations >= 1500,
        `종료=${bg.halted} 누적=${bg.totalIterations}`,
      ),
      assert(
        "★★백스톱이 **그 수치에서** 끊는다 — 상한을 1.5배 하면 이어가기도 그만큼 는다(존재만 보면 상한을 MAX_SAFE_INTEGER 로 바꿔도 통과한다)",
        low.halted === "백스톱" &&
          high.halted === "백스톱" &&
          high.continues.length > low.continues.length &&
          low.totalIterations < 450,
        `상한300 → ${low.continues.length}회(누적 ${low.totalIterations}) · 상한450 → ${high.continues.length}회(누적 ${high.totalIterations})`,
      ),
      assert(
        "★★**배경 스레드만** — 사용자가 기다리는 대화는 한도에서 마무리하고 끝낸다",
        main.continues.length === 0 &&
          main.halted === "작업끝" &&
          isCheckinGuardedThread("worker:abc") &&
          isCheckinGuardedThread("agent:xyz") &&
          !isCheckinGuardedThread("dashboard:default") &&
          !isCheckinGuardedThread("tg:123"),
        `메인 이어가기=${main.continues.length}회 · 판정 실행 OK`,
      ),
      assert(
        "★이어간 **그 자리**에서 진행 nudge 가 겹치지 않는다 — 창을 옮기면 거기가 곧 배수라 즉시 다시 참이 된다",
        nudgeAtContinue.length === 0 && bg.nudges.length > 0,
        nudgeAtContinue.length === 0
          ? `nudge ${bg.nudges.length}개, 이어간 자리와 겹침 0`
          : `★겹침: ${nudgeAtContinue.join(",")}`,
      ),
      assert(
        "★짧은 작업은 한도에 안 닿는다(이어가기 0) — 그러면서 진행 nudge 는 나온다",
        short.continues.length === 0 && short.nudges.length > 0 && short.halted === "작업끝",
        `이어가기 ${short.continues.length} · nudge ${short.nudges.join(",")}`,
      ),
      assert(
        "★로그 분수의 분자가 분모를 안 넘는다 — 창을 옮기며 분자만 절대값이 되면 `iter=1639/150` 이 찍히고, 원격에서 그 줄만 보는 사람은 계산이 깨졌다고 읽는다",
        labelsSane(bg.labels) && labelsSane(short.labels),
        `라벨 ${bg.labels.length}개 · 예: ${bg.labels.slice(0, 2).join(" / ")}`,
      ),
      assert(
        "★★한도 로그의 **처방이 그 스레드에 맞다** — 배경 작업은 자동으로 이어가므로 잘리지 않는데, 종전엔 그런 턴에게도 «150을 올리세요» 라고 말했다(실제 손잡이는 누적 상한이다). 수치가 맞아도 처방이 틀리면 로그는 거짓이다",
        /멈춰야 하면 누적 상한 CODEX_MAX_TOTAL_ITERATIONS/.test(capAdvice(true, 150, 1_500)) &&
          /CODEX_MAX_TOOL_ITERATIONS_HARD 를 올리세요/.test(capAdvice(false, 150, 1_500)) &&
          capAdvice(true, 150, 1_500) !== capAdvice(false, 150, 1_500) &&
          // 상한 수치를 문구에 **박아 넣지 않았다** — 바꾸면 문구도 따라와야 한다.
          /9,?999/.test(capAdvice(true, 150, 9_999)),
        `배경="${capAdvice(true, 150, 1_500).slice(0, 30)}…" · 메인="${capAdvice(false, 150, 1_500).slice(0, 24)}…"`,
      ),
      assert(
        "★★그 처방에 **무엇을 먹이는지**까지 본다 — 순수 함수가 옳아도 어댑터가 `false` 를 넘기면 배경 작업이 영영 틀린 안내를 받는다(백스톱에서 이미 같은 이음매를 겪었다)",
        /isCheckinGuardedThread\(input\.threadKey\)/.test(adviceArgs) &&
          /CODEX_MAX_TOOL_ITERATIONS_HARD/.test(adviceArgs) &&
          /CODEX_MAX_TOTAL_ITERATIONS/.test(adviceArgs),
        `인자=${adviceArgs.replace(/\s+/g, " ").trim().slice(0, 90)}`,
      ),
      // ── ★«완료라고 해놓고 계속 돈다» (2026-09-01, 라이브 worker:4bb5d813) ──────────
      //  한 문구를 두 상황에 같이 썼다: 배경 작업에게도 *"**최종 요약** 텍스트를 작성하세요"*
      //  라고 시켜놓고, 그 답을 받자마자 *"방금 **중간 정리**를 마쳤습니다"* 하며 이어 돌렸다.
      //  모델은 시킨 대로 **완료 문장**을 쓴다 — 사용자 눈엔 14:21 에 «완료» 라고 해놓고
      //  15:53 까지 새 수정·새 위임을 하는 것으로 보인다. 이어가기 자체는 의도된 결정이고,
      //  틀린 것은 **그때 뭐라고 시키느냐** 였다.
      assert(
        "★이어갈 턴과 끝내는 턴은 **다른 지시**를 받는다 — 한 문구를 둘에 같이 쓰면 모델이 완료 문장을 쓰고 우리는 계속 돈다",
        capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).kind ===
          "checkpoint" &&
          capFlushPrompt({ willContinue: false, userTextEcho: "", ranListMsg: "" }).kind ===
            "final" &&
          capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).text !==
            capFlushPrompt({ willContinue: false, userTextEcho: "", ranListMsg: "" }).text,
        `이어감=${capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).kind} · 끝냄=${capFlushPrompt({ willContinue: false, userTextEcho: "", ranListMsg: "" }).kind}`,
      ),
      assert(
        "★모델에게 가는 것은 그 상태의 **본문**이다 — kind 만 맞고 본문이 안 실리면 아무것도 안 바뀐다",
        capFlushPrompt({ willContinue: true, userTextEcho: "ECHO", ranListMsg: "RAN" }).text.includes(
          "ECHO",
        ) &&
          capFlushPrompt({ willContinue: false, userTextEcho: "ECHO", ranListMsg: "RAN" }).text.includes(
            "RAN",
          ),
        `이어감본문="${capFlushPrompt({ willContinue: true, userTextEcho: "ECHO", ranListMsg: "RAN" }).text.slice(-70)}"`,
      ),
      // ── ★여기엔 **낱말 검사가 없다** (2026-09-01, 두 번째 정정) ────────────────────
      //  한때 «이어갈 턴 지시에 “최종” 이 없다» 를 넣었었다. 그건 땜빵이었다 — 검사가
      //  산문의 의미를 판정하는 척하면 문구를 정당하게 다듬을 때마다 빨개지고, 그러면
      //  아무도 안 보는 게이트가 된다. 그 검사가 «필요했던» 것 자체가 구조를 반만 고쳤다는
      //  신호였다: 두 분기가 지시문 전체를 각자 손으로 쓰고 있었다.
      //  이제 상태별 문장이 `FLUSH_FINALITY` 표에 하나씩 있고 조립부가 `kind` 로 조회하므로,
      //  «자기 상태와 다른 문장» 은 국소 편집으로 만들어지지 않는다. 아래 셋은 **그 구조가
      //  살아 있는지**만 본다(한국어 리터럴 0).
      assert(
        "★상태마다 문장이 **하나씩만** 있다 — 키가 늘거나 줄면 조회가 조용히 undefined 를 집는다",
        Object.keys(FLUSH_FINALITY).sort().join(",") === "checkpoint,final" &&
          Object.values(FLUSH_FINALITY).every((v) => v.trim() !== ""),
        `키=${Object.keys(FLUSH_FINALITY).sort().join(",")}`,
      ),
      assert(
        "★두 상태의 문장이 서로 다르다 — 같아지면 «한 문구를 두 상황에» 가 그대로 부활한다",
        FLUSH_FINALITY.checkpoint !== FLUSH_FINALITY.final,
        FLUSH_FINALITY.checkpoint === FLUSH_FINALITY.final ? "★같다" : "다르다",
      ),
      assert(
        "★★조립된 지시문이 **자기 상태의 문장**을 담는다 — 조회 키가 kind 와 갈리면 여기서 걸린다(그게 이 결함의 기제였다)",
        capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).text.includes(
          FLUSH_FINALITY.checkpoint,
        ) &&
          capFlushPrompt({ willContinue: false, userTextEcho: "", ranListMsg: "" }).text.includes(
            FLUSH_FINALITY.final,
          ) &&
          !capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).text.includes(
            FLUSH_FINALITY.final,
          ),
        `이어감이 checkpoint 문장을 담음=${capFlushPrompt({ willContinue: true, userTextEcho: "", ranListMsg: "" }).text.includes(FLUSH_FINALITY.checkpoint)}`,
      ),
      assert(
        "★판정: 배경 + 백스톱 미도달이면 이어간다 · 메인이거나 백스톱이면 안 이어간다",
        willAutoContinue(true, 300, 1500) &&
          !willAutoContinue(false, 300, 1500) &&
          !willAutoContinue(true, 1500, 1500),
        `배경300=${String(willAutoContinue(true, 300, 1500))} 메인300=${String(willAutoContinue(false, 300, 1500))} 배경1500=${String(willAutoContinue(true, 1500, 1500))}`,
      ),
      assert(
        "★★«뭐라고 시킬까» 와 «이어갈까» 가 **한 결정**이다 — 어댑터가 저장한 값을 쓰고, 이어가기 분기에서 스레드를 다시 묻지 않는다(다시 물으면 두 문구가 또 갈린다)",
        /flushWillContinue = willAutoContinue\(/.test(code) &&
          /capFlushPrompt\(\{ willContinue: flushWillContinue/.test(code) &&
          /if \(flushWillContinue\) \{/.test(code) &&
          !/if \(isCheckinGuardedThread\(input\.threadKey\)\) \{/.test(code),
        `저장=${/flushWillContinue = willAutoContinue\(/.test(code)} 넛지=${/capFlushPrompt\(\{ willContinue: flushWillContinue/.test(code)} 소비=${/if \(flushWillContinue\) \{/.test(code)} 재질의잔존=${/if \(isCheckinGuardedThread\(input\.threadKey\)\) \{/.test(code)}`,
      ),
      assert(
        "★flush 를 켜는 **모든** 자리가 그 결정을 세운다 — 하나라도 빠지면 그 경로의 이어가기가 조용히 사라진다(기본값 false)",
        (code.match(/finalFlushRequested = true;/g) ?? []).length ===
          (code.match(/flushWillContinue = willAutoContinue\(/g) ?? []).length,
        `flush 켜는 곳 ${(code.match(/finalFlushRequested = true;/g) ?? []).length}곳 · 결정 세우는 곳 ${(code.match(/flushWillContinue = willAutoContinue\(/g) ?? []).length}곳`,
      ),
      assert(
        "★★어댑터가 그 판정을 **위임한다**(인라인으로 되돌리면 위 실행 검사가 못 본다)",
        ["withinWindow(", "isWindowEnd(", "isCheckpointDue(", "shouldStopContinuing(", "iterLabel(", "capAdvice("].every(
          (f) => src.includes(f),
        ),
        `호출 ${["withinWindow", "isWindowEnd", "isCheckpointDue", "shouldStopContinuing", "iterLabel", "capAdvice"].filter((f) => src.includes(`${f}(`)).length}/6`,
      ),
      assert(
        "★★백스톱에 **무엇을 먹이는지**까지 본다 — 순수 함수가 옳아도 어댑터가 상수를 넘기면 영원히 안 걸린다(실측: `totalIterations = 0` 변이가 스위트를 통과했다). 사본 변수를 없애고 호출을 통째로 대조한다",
        /shouldStopContinuing\(iteration, CODEX_MAX_TOTAL_ITERATIONS\)/.test(code) &&
          !/\btotalIterations\b/.test(code),
        `호출부=${(/shouldStopContinuing\([^)]*\)/.exec(code) ?? ["(없음)"])[0]} · 사본변수 ${(code.match(/\btotalIterations\b/g) ?? []).length}건`,
      ),
      assert(
        "★창 산술이 어댑터에 **다시 생기지 않았다** — 판정이 두 곳이면 갈린다",
        !/iterationBase \+ CODEX_MAX_TOOL_ITERATIONS_HARD/.test(code) &&
          !/% CODEX_MAX_TOOL_ITERATIONS\b/.test(code),
        `창합 ${(code.match(/iterationBase \+ CODEX_MAX_TOOL_ITERATIONS_HARD/g) ?? []).length}건 · 나머지연산 ${(code.match(/% CODEX_MAX_TOOL_ITERATIONS\b/g) ?? []).length}건`,
      ),
      assert(
        "★★`iteration` 을 **되돌리는 대입이 없다** — 되돌리면 iteration 0 전용 입력 상한 가드가 다시 켜지고, 그게 throw 하면 폴백이 턴을 처음부터 재실행해 **부작용이 중복**된다(`Edit×32` 면 편집이 두 번)",
        // ★철자를 막지 않는다 — `iteration = 0;` 만 금지하면 `iteration -= iteration;` 으로
        //  뚫린다(실측). 대입 **전수**를 열거해 증가와 선언만 남는지 본다.
        iterAssigns.length > 1 &&
          iterAssigns.every((a) => a === "iteration = 0" || a === "iteration += 1"),
        iterAssigns.join(" · "),
      ),
      assert(
        "★★**접두사를 안 건드린다**(뒤에 붙이기만) — 앞을 요약으로 갈아끼우면 프리픽스 캐시 86~89%가 통째로 깨진다(실측)",
        /inputArray\.push\(/.test(src) && !/inputArray\s*=/.test(src),
        "push 만 사용",
      ),
    ];
  },
};
