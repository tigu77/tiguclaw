/**
 * 회귀: **«빠름 켰는데 왜 안 빨라지죠» 에 답할 것이 그날 로그에 남는다** (2026-09-11 N2·N3).
 *
 * 사고 전 상태(v0.52.1 적대 검토):
 *
 *  **N2 — 거절까지 서명으로 묶어 데몬 수명 내 한 번만 찍었다.** 형제 rate-limit 블록은 같은
 *  파일에서 `status !== "allowed" || signature !== last` 로 **거절은 항상** 남긴다. 그 규칙을
 *  인용한 주석이 fast-mode 블록 바로 위에 있는데 정작 안 따랐다. 이 줄은 «왜 안 빨라지나» 의
 *  **유일한 답변 경로**인데(화면은 «적혔다» 만 보여준다), 며칠 뒤 물으면 그날 로그엔 아무것도
 *  없다 — 데몬이 뜬 첫 턴에 한 번 찍고 끝이었기 때문이다.
 *
 *  **N3 — 모듈 스코프 근거가 같은 블록과 모순.** 근거는 «`fast_mode_state` 는 계정 전역 값이라
 *  세션이 달라도 같은 답이 온다» 였는데, 같은 블록이 `model_not_allowed` 를 다뤘다 — 그건
 *  **모델** 스코프 사유다. 서로 다른 모델의 두 세션이 겹치면 서명이 튀어 **매 메시지 찍히거나**
 *  한쪽 사유가 **영영 가려진다**.
 *
 * ★이 검사는 **접는 규칙을 돌려서** 잰다. 소스에 문자열이 있는지로 재면 안 되는 것이 이 레포의
 *  반복 학습이다 — 같은 주에 `if (false && …)` 한 글자로 두 번 뚫렸다. 그래서 판정·접기를
 *  `fast-mode-view.ts` 순수 모듈로 떼어 두고, 여기서 턴을 흉내 내 **나온 줄을 센다.**
 * ★AST 는 마지막 한 축(배선)에만 쓴다 — 순수 모듈이 아무리 옳아도 어댑터가 안 부르면 0이고,
 *  그 자리는 돌려서 잴 수 없다(어댑터 루프는 라이브 SDK 스트림을 탄다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import ts from "typescript";
import { readSourceSync } from "./_wiring.js";
import {
  createFastModeReporter,
  parseFastMode,
} from "../../core/llm-runtime/fast-mode-view.js";

/** SDK 가 실어 보내는 모양 그대로(실측). */
const sdkMsg = (state: string, reason?: string): unknown => ({
  type: "system",
  fast_mode_state: state,
  ...(reason === undefined ? {} : { fast_mode_disabled_reason: reason }),
});

interface Step {
  readonly model?: string;
  readonly msg: unknown;
  /** 이 턴이 «빠름» 을 요청했나. 미지정 = 요청함(대부분의 픽스처가 그 경우다). */
  readonly speed?: string;
}

/**
 * 턴들을 흉내 내 **실제로 나온 줄**을 돌려준다.
 *
 * 데몬 수명 상태(모델별 마지막 서명)는 턴 밖 맵 하나, 턴 상태는 턴마다 새 게이트 —
 * 제품(`runClaude`)의 수명 배치를 그대로 재현한다.
 *
 * ★**제품이 부르는 그 함수를 그대로 부른다** (2026-09-11 P6). 종전엔 하네스가
 *  `parseFastMode` → `admit` → `line !== null` 을 **자기 손으로 조립**했는데, 그러면 두 가지가
 *  샜다: ①제품 배선이 조립을 다르게 해도 하네스는 모른다 ②하네스가 제품보다 **엄격**해져
 *  (제품은 `line` 을 다시 안 봤다) 게이트가 져야 할 책임을 하네스가 대신 졌다(적대 검토 C).
 *  이제 게이트·판정·접기가 전부 `fastModeLogFor` 안에 있으므로 **그 하나만 돌리면 된다.**
 */
/**
 * `console.log` 를 **가로채** 실제로 나간 줄을 받는다.
 *
 * ★스파이를 «주입» 하지 않는다 (2026-09-11, 외부 사냥 #1). 앞 판은 출력 함수를 인자로 받고
 *  회귀가 다섯째 인자로 스파이를 넣었는데, **제품은 기본값을 쓰므로** 그 기본값을 `() => {}`
 *  로 죽여도 회귀가 영원히 못 봤다 — 측정하려고 낸 구멍으로 측정 대상이 빠져나간 것이다.
 *  이제 제품도 회귀도 `console.log` **같은 경로**를 지난다.
 */
const captureLogs = (fn: () => void): string[] => {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]): void => void lines.push(String(args[0] ?? ""));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
};

const PREFIX = "[fast-mode] ";

/**
 * 턴들을 흉내 내 **실제로 찍힌 줄**을 돌려준다(접두 제거).
 *
 * ★턴 경계는 **토큰의 identity** 다 — 제품이 `input` 객체를 넘기는 자리에 여기서는 `{}` 를
 *  턴마다 새로 만든다. 같은 턴의 메시지는 같은 토큰을 공유한다.
 */
const runTurns = (turns: readonly (readonly Step[])[]): string[] => {
  const report = createFastModeReporter();
  return captureLogs(() => {
    for (const turn of turns) {
      const token = {}; // 한 턴 = 한 토큰(제품의 `input` 자리)
      for (const step of turn) report(token, step.msg, step.speed ?? "fast", step.model);
    }
  }).map((l) => (l.startsWith(PREFIX) ? l.slice(PREFIX.length) : `★접두 없음: ${l}`));
};

/**
 * 어댑터가 이 모듈을 **정말 부르는가** — AST 로 본다.
 *
 * ★게이트가 `input.speed === "fast"` 하나여야 하고, 그 안에서 판정(`parseFastMode`)과 접기
 *  게이트를 **둘 다** 써야 한다. 접기만 빼면 매 메시지 찍히고, 판정만 빼면 아무것도 안 찍힌다.
 *
 * ── 첫 판이 뚫린 자리 (2026-09-11 적대 검토 C·B) ───────────────────────────────────
 *
 * 첫 판은 «소스 어딘가에 이 모양의 `if` 가 있나» 만 봤고, 그래서 **다섯 변이가 통과했다.**
 * 전부 «글자는 그대로인데 기능은 0» 인 부류다 — 이 검사가 막으라고 있는 바로 그것이다.
 *
 *  - **배선을 통째로 지우고** 아무도 안 부르는 데코이 함수만 남겨도 초록이었다. 순회가
 *    파일 전체를 훑어서 «어디에 있나» 를 안 봤다 → 이제 **`runClaude` 안**에서만 찾는다.
 *  - **죽은 조건으로 감싸도**(`if (msg.type === "__never__") { if (input.speed === "fast") …`)
 *    초록이었다. 첫 판 주석은 «죽은 조건이 앞에 붙으면 걸린다» 고 주장했는데 `&&` 로 붙일
 *    때만 참이었다 — 게다가 순회가 매치마다 결과를 **덮어써서** 가장 안쪽 `if` 가 이겼다.
 *    → 이제 **조상 `if` 가 하나라도 있으면 탈락**시킨다.
 *  - **`parseFastMode(msg, lastModel)`** 로 바꿔도 초록이었다. 모듈 헤더가 «SDK 가 뒤늦게
 *    알려주는 값을 쓰면 같은 턴의 두 메시지가 다른 키를 갖는다» 고 **콕 집어 금지**한 건데
 *    그물엔 없었다(형제 `speed-tier-is-adapter-agnostic` 은 인자를 AST 로 본다 — 같은 축인데
 *    이쪽만 빠졌다). → 이제 **둘째 인자가 `input.model`** 인지 본다.
 *  - **`console.log` 만 지워도**(호출 둘은 남김) 초록이었다. → 이제 접기 결과가 **출력을
 *    지배하는지** 본다.
 *  - **게이트 생성(`createFastModeLogGate(...)`)을 모듈 스코프로 한 줄 올려도** 초록이었다.
 *    그건 **N2 결함 그 자체의 복원**이다(턴 상태가 데몬 수명이 되어 첫 턴에 한 번 찍고 끝).
 *    첫 판은 **맵**이 턴 밖인지만 봤지 **게이트**가 턴 안인지는 안 봤다 → `gateInTurn`.
 *
 * ★두 수명은 **짝**이다 — 맵은 턴 **밖**(`daemonStateLivesOutsideTurn`), 게이트는 턴 **안**.
 *  한쪽만 재면 나머지 한쪽으로 같은 결함이 돌아온다.
 */
interface FastModeWiring {
  /** `runClaude` 안에서 `reportFastMode` 를 **정확히 한 번** 부르는가. */
  readonly calls: boolean;
  /** 네 인자가 전부 맞는가 — 하나만 바꿔도 로그가 통째로 죽는다. */
  readonly args: boolean;
  /** `runClaude` 안에 있는가 — 모듈 최상위·안쪽 데코이를 배제한다. */
  readonly inRunClaude: boolean;
  /** 메시지 루프의 **직계**인가 — 한 겹 더 감싸면 한 번도 안 돌 수 있다. */
  readonly directChild: boolean;
}

/** 노드 아래에서 조건에 맞는 것을 전부 — «있나» 가 아니라 «몇 개인가» 를 세려고. */
const collect = (root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(root);
  return out;
};

const isCallTo = (n: ts.Node, name: string): boolean =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;

/**
 * `runClaude` 의 선언 — 이 안이 «턴 안» 이다.
 *
 * ★`const` 와 `function` 을 **둘 다** 받는다 (적대 검토 G). 첫 판은 `VariableStatement` 만
 *  봐서, `function runClaude(…)` 로 바꾸는 **동작 동일 리팩터**에 6건이 한꺼번에 빨개졌다.
 *  검사가 리팩터를 막으면 다음 사람은 리팩터를 피하거나 검사를 끈다 — 둘 다 손해다.
 */
const findRunClaude = (src: ts.SourceFile): ts.Node | null => {
  for (const st of src.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === "runClaude") return st;
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "runClaude") return d;
    }
  }
  return null;
};

const adapterUsesFastModeView = (): FastModeWiring => {
  const src = ts.createSourceFile(
    "claude-agent-sdk.ts",
    readSourceSync("src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  const dead: FastModeWiring = {
    calls: false,
    args: false,
    inRunClaude: false,
    directChild: false,
  };
  const runClaude = findRunClaude(src);
  if (runClaude === null) return dead;

  // 호출은 **`runClaude` 안**에서만 센다 — 파일 어딘가의 데코이는 배선이 아니다.
  const callsInRun = collect(runClaude, (n) => isCallTo(n, "reportFastMode")) as ts.CallExpression[];
  if (callsInRun.length !== 1) {
    return { ...dead, inRunClaude: callsInRun.length > 0 };
  }
  const call = callsInRun[0]!;

  // ★**네 인자가 전부 맞아야** 한다 — 첫째를 `{}` 로 바꾸면 `view.line` 이 영원히 `null` 이라
  //  로그가 통째로 죽고, 둘째를 `undefined` 로 바꾸면 게이트가 영원히 닫힌다(실측 둘 다).
  //  인자가 명시적이라 확인이 단순하다.
  const want = ["input", "msg", "input.speed", "input.model"];
  const args =
    call.arguments.length === want.length &&
    call.arguments.every((a, i) => a.getText() === want[i]);

  // ★그 문장이 **메시지 루프의 직계**인가 — `for (…) { 호출 }` 처럼 한 겹 더 감싸면 그 안은
  //  한 번도 안 돌 수 있다(실측: `for (const _ of [])` 로 감싸도 첫 판은 초록이었다).
  //  ★«조상 제어구조가 하나뿐» 으로 세면 안 된다 — 실제 체인은 **메시지 루프 + 재시도 루프**
  //   둘이라 개수로 재면 상수가 틀린다(첫 시도가 그래서 빨간불이 났다). 개수가 아니라
  //   **위로 올라가며 처음 만나는 제어구조가 메시지 루프 자신인가** 를 본다.
  //  ★그 루프를 **`msg` 를 바인딩한다** 로 식별한다 — `for (const _ of [])` 같은 감싸기는
  //   같은 `ForOf` 라도 바인딩 이름이 달라 걸린다.
  const isCtrl = (n: ts.Node): boolean =>
    ts.isIfStatement(n) ||
    ts.isForStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isWhileStatement(n) ||
    ts.isDoStatement(n) ||
    ts.isSwitchStatement(n);
  let firstCtrl: ts.Node | null = null;
  for (let p: ts.Node | undefined = call.parent; p !== undefined && p !== runClaude; p = p.parent) {
    if (isCtrl(p)) {
      firstCtrl = p;
      break;
    }
  }
  const directChild =
    firstCtrl !== null &&
    ts.isForOfStatement(firstCtrl) &&
    /\bmsg\b/.test(firstCtrl.initializer.getText());

  return { calls: true, args, inRunClaude: true, directChild };
};


export const check: RegressionCheck = {
  name: "fast-mode-log-answers-the-question",
  guards:
    "«빠름» 이 안 켜진 이유를 로그가 데몬 수명 내 한 번만 말하던 것(N2) + 접는 서명이 모델을 " +
    "안 세어 두 모델이 겹치면 매 메시지 찍히거나 한쪽 사유가 가려지던 것(N3)",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];

    // ── ① N2: 거절은 접지 않는다 — 물어보는 그날 로그에 있어야 한다 ────────────────
    const blocked = sdkMsg("off", "extra_usage_disabled");
    const threeTurns = runTurns([
      [{ model: "claude-opus-5", msg: blocked }],
      [{ model: "claude-opus-5", msg: blocked }],
      [{ model: "claude-opus-5", msg: blocked }],
    ]);
    out.push(
      assert(
        "★★같은 거절이 **턴마다** 남는다 — 이게 없으면 데몬 뜬 첫 턴에 한 번 찍고 끝이라, 며칠 뒤 «왜 안 빨라지죠» 를 물었을 때 그날 로그엔 아무것도 없다(N2)",
        threeTurns.length === 3,
        `3턴 연속 거절 → ${threeTurns.length}줄`,
      ),
      assert(
        "★처방까지 같이 남는다 — 증상만 적힌 로그는 한 번 더 묻게 만든다",
        threeTurns[0]?.includes("추가 사용량") === true,
        threeTurns[0] ?? "(줄 없음)",
      ),
    );

    // ── ①b N2 의 반대편: 그렇다고 **매 메시지** 찍지는 않는다 ──────────────────────
    // ★`fast_mode_state` 는 한 턴에 system·result 로 두 번 이상 온다(실측). 그건 새 사실이
    //  아니라 같은 사실이다 — «거절은 항상» 을 이 스트림 모양에 정직하게 옮기면 «턴마다» 다.
    //  이 어세션이 없으면 N2 수정이 배경소음이라는 **새 결함**으로 착지한다.
    const oneTurnTwice = runTurns([
      [
        { model: "claude-opus-5", msg: blocked },
        { model: "claude-opus-5", msg: blocked },
        { model: "claude-opus-5", msg: blocked },
      ],
    ]);
    out.push(
      assert(
        "★★한 턴 안의 중복(system·result)은 **한 줄** — 같은 턴의 같은 사실을 세 번 찍으면 그게 배경소음이고, 배경소음은 12일 묻힌 전적이 있다",
        oneTurnTwice.length === 1,
        `한 턴 3메시지 → ${oneTurnTwice.length}줄`,
      ),
    );

    // ── ①c 허용은 접는다 — 좋은 소식은 반복할 값이 없다 ───────────────────────────
    const allowedThrice = runTurns([
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
    ]);
    out.push(
      assert(
        "★★«쓸 수 있는 상태» 는 **바뀔 때만** — 거절을 풀면서 «다 남긴다» 로 넓히면 매 턴 한 줄이 나간다(형제 rate-limit 이 데인 자리와 같은 모양)",
        allowedThrice.length === 1,
        `3턴 연속 on → ${allowedThrice.length}줄`,
      ),
      assert(
        "★«on» 은 «막는 게 없다» 까지만 말한다 — «이 턴이 빨랐다»·«2배로 청구됐다» 는 재지 않은 단언이다(N4 와 같은 방향)",
        allowedThrice[0]?.includes("막는 조건 없음") === true &&
          !/빨랐|2배|배 청구/.test(allowedThrice[0] ?? ""),
        allowedThrice[0] ?? "(줄 없음)",
      ),
    );

    // ── ② N3: 모델이 다르면 서명도 다르다 — 튀지도, 가려지지도 않는다 ──────────────
    // ★튐: opus 는 켜지고 haiku 는 `model_not_allowed` 인 두 세션이 번갈아 돌면, 모델을 안
    //  센 서명은 매번 뒤집혀 **opus 의 «쓸 수 있다» 가 턴마다 다시 찍힌다.**
    const interleaved = runTurns([
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
      [{ model: "claude-haiku-4-5", msg: sdkMsg("off", "model_not_allowed") }],
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
      [{ model: "claude-haiku-4-5", msg: sdkMsg("off", "model_not_allowed") }],
      [{ model: "claude-opus-5", msg: sdkMsg("on") }],
    ]);
    const opusLines = interleaved.filter((l) => l.includes("claude-opus-5"));
    const haikuLines = interleaved.filter((l) => l.includes("claude-haiku-4-5"));
    out.push(
      assert(
        "★★다른 모델이 끼어들어도 허용 줄이 **튀지 않는다** — 모델을 안 세는 서명은 두 세션 사이에서 매번 뒤집혀 «쓸 수 있다» 를 턴마다 다시 찍는다(N3)",
        opusLines.length === 1,
        `opus «쓸 수 있다» → ${opusLines.length}줄 (전체 ${interleaved.length}줄)`,
      ),
      assert(
        "★★끼어든 쪽 거절도 제 턴마다 남는다 — 한쪽 사유가 다른 쪽 서명에 가려지면 그 모델 사용자는 영영 답을 못 받는다(N3)",
        haikuLines.length === 2 && haikuLines.every((l) => l.includes("빠름 티어를 지원하지 않습니다")),
        `haiku 거절 → ${haikuLines.length}줄`,
      ),
    );

    // ── ②b N3: 같은 사유라도 모델이 다르면 **둘 다** 남는다(가림 0) ────────────────
    const sameReasonTwoModels = runTurns([
      [
        { model: "claude-opus-5", msg: blocked },
        { model: "claude-sonnet-5", msg: blocked },
      ],
    ]);
    out.push(
      assert(
        "★★사유가 같아도 모델이 다르면 **두 줄** — 모델을 안 세면 뒤엣것이 앞엣것 서명에 접혀 사라지고, 그 세션 사용자는 자기 답을 못 본다",
        sameReasonTwoModels.length === 2,
        `두 모델 같은 사유 → ${sameReasonTwoModels.length}줄`,
      ),
      assert(
        "★줄이 **혼자 서야 한다** — 어느 모델 얘기인지 줄 안에 있어야 나중에 로그만 보고 판정한다([[feedback_logs_must_stand_alone]])",
        parseFastMode(sdkMsg("off", "model_not_allowed"), "claude-haiku-4-5").line?.includes(
          "model=claude-haiku-4-5",
        ) === true,
        parseFastMode(sdkMsg("off", "model_not_allowed"), "claude-haiku-4-5").line ?? "(줄 없음)",
      ),
      assert(
        "★서명이 모델을 **정말** 센다 — 같은 상태·같은 사유인데 모델만 다르면 서명이 달라야 한다",
        parseFastMode(blocked, "a").signature !== parseFastMode(blocked, "b").signature,
        `${parseFastMode(blocked, "a").signature} vs ${parseFastMode(blocked, "b").signature}`,
      ),
    );

    // ── ③ 동시 턴 — 턴 상태를 모듈에 두면 한쪽 거절이 사라진다 ────────────────────
    // ★우리는 세션을 병렬로 돌린다. 턴 상태가 모듈 스코프 변수 하나면 A 턴이 찍은 서명을
    //  B 턴이 «이미 찍었다» 로 읽어 **B 의 거절이 통째로 사라진다.** 그래서 게이트는
    //  턴마다 새로 만들고 데몬 수명 상태만 공유한다 — 그 배치를 여기서 겹쳐 돌려 잰다.
    // ★턴 경계가 **토큰** 이므로, 두 턴을 겹쳐 돌리는 것이 곧 두 토큰을 번갈아 넘기는 것이다.
    const reportC = createFastModeReporter();
    const tokenA = {};
    const tokenB = {};
    const concurrent = captureLogs(() => {
      for (const tok of [tokenA, tokenB, tokenA, tokenB]) {
        reportC(tok, blocked, "fast", "claude-opus-5");
      }
    });
    out.push(
      assert(
        "★★동시에 도는 두 턴이 **각자** 거절을 남긴다 — 턴 상태를 턴 밖에 두면 늦게 온 턴이 «이미 찍었다» 로 접혀 그 사용자 답이 통째로 사라진다",
        concurrent.length === 2,
        `겹친 두 턴(각 2메시지) → ${concurrent.length}줄`,
      ),
    );

    // ── ④ 상태가 안 실린 메시지엔 할 말이 없다 ────────────────────────────────────
    out.push(
      assert(
        "★`fast_mode_state` 가 없는 메시지엔 **아무 줄도 없다** — 스트림의 대부분이 그렇다. 여기서 지어내면 매 메시지 한 줄이 된다",
        parseFastMode({ type: "assistant" }, "claude-opus-5").line === null &&
          parseFastMode(undefined, "claude-opus-5").line === null,
        `line=${String(parseFastMode({ type: "assistant" }, "claude-opus-5").line)}`,
      ),
      assert(
        "★`cooldown` 은 **거절 쪽**이다 — `on` 이 아닌 것을 허용으로 읽으면 한도에 걸린 턴을 «쓸 수 있다» 로 찍는다",
        parseFastMode(sdkMsg("cooldown"), "claude-opus-5").allowed === false &&
          runTurns([
            [{ model: "m", msg: sdkMsg("cooldown") }],
            [{ model: "m", msg: sdkMsg("cooldown") }],
          ]).length === 2,
        `allowed=${String(parseFastMode(sdkMsg("cooldown"), "claude-opus-5").allowed)}`,
      ),
    );

    // ── ⑤ 게이트·사유도 **돌려서** 잰다 — 종전엔 게이트만 AST 였다 ────────────────
    out.push(
      assert(
        "★★«빠름» 을 안 켠 턴은 **아무 줄도 없다** — 안 켠 턴은 언제나 `sdk_opt_in_required` 라 매 턴 찍으면 배경소음이 된다",
        runTurns([[{ model: "claude-opus-5", msg: blocked, speed: "slow" }]]).length === 0,
        `speed 오타 → ${runTurns([[{ model: "m", msg: blocked, speed: "slow" }]]).length}줄`,
      ),
      assert(
        "★그 게이트가 **너무 좁지도** 않다 — `fast` 를 켠 턴은 정상적으로 남는다(좁힘 방향 오탐은 옳은 수정을 막는다)",
        runTurns([[{ model: "claude-opus-5", msg: blocked, speed: "fast" }]]).length === 1,
        `fast → ${runTurns([[{ model: "m", msg: blocked, speed: "fast" }]]).length}줄`,
      ),
      // ★**사유 문자열이 줄에 실린다** (2026-09-11, 외부 사냥 #2). 종전엔 `사유=` 를 통째로
      //  지워도 아무 단언이 안 울었다 — `PRESCRIPTION` 에 처방이 있는 두 사유만 문구로 간접
      //  생존했고, SDK 가 선언한 나머지 여덟 사유는 **줄에서 사라져도** 검사가 몰랐다.
      //  처방이 없는 사유일수록 그 낱말이 유일한 단서라 더 필요하다.
      assert(
        "★★처방이 **없는** 사유도 낱말 그대로 줄에 남는다 — 처방 있는 둘만 간접 확인되던 자리라, 나머지가 통째로 사라져도 아무도 안 울었다",
        runTurns([[{ model: "m", msg: sdkMsg("off", "not_first_party") }]])[0]?.includes(
          "사유=not_first_party",
        ) === true,
        runTurns([[{ model: "m", msg: sdkMsg("off", "not_first_party") }]])[0] ?? "(줄 없음)",
      ),
      assert(
        "★상태 값도 줄에 남는다 — `state=` 가 빠지면 «무엇이 막았나» 의 절반이 사라진다",
        runTurns([[{ model: "m", msg: sdkMsg("cooldown") }]])[0]?.includes("state=cooldown") === true,
        runTurns([[{ model: "m", msg: sdkMsg("cooldown") }]])[0] ?? "(줄 없음)",
      ),
    );

    // ── ⑥ 배선 — 순수 모듈이 옳아도 어댑터가 안 부르면 0이다 ──────────────────────
    // ★**여기 남은 술어는 여섯이 아니라 다섯이고, 전부 «한 줄·네 인자» 에 대한 것**이다
    //  (2026-09-11 P6). 종전엔 게이트·판정·접기를 어댑터가 제 손으로 해서 검사가 그걸 AST 로
    //  따라다녔고, 술어를 얹을수록 우회로가 늘었다(두 판에 걸쳐 **열 갈래**). 로직을 전부
    //  `fastModeLogFor` 로 내리고 나니 확인할 모양이 이만큼으로 줄었다.
    //
    // ★**이 검사가 못 잡는 것**(적어 둔다 — 지키지도 못하면서 지킨다고 하는 게 제일 나쁘다):
    //  호출 **앞**에 형제 `continue`/`return` 을 놓아 도달을 막는 변이는 여기서 안 걸린다.
    //  그건 제어흐름 분석이고, 그 자리는 라이브 SDK 스트림이라 돌려서 잴 수 없다. 대신
    //  «도달했을 때 무엇이 일어나는가» 는 위 ①~⑤가 전부 실행으로 보장한다.
    const wired = adapterUsesFastModeView();
    out.push(
      assert(
        "★★어댑터가 `reportFastMode` 를 **`runClaude` 안에서 정확히 한 번** 부른다 — 배선을 지우고 데코이만 남기거나(모듈 최상위·안쪽 래퍼 둘 다 실측으로 통과했다) 두 벌을 두면 걸린다",
        wired.calls && wired.inRunClaude,
        `calls=${wired.calls} inRunClaude=${wired.inRunClaude}`,
      ),
      assert(
        "★★**네 인자가 전부 맞다**(`input`·`msg`·`input.speed`·`input.model`) — 첫째를 `{}` 로만 바꿔도 `view.line` 이 영원히 `null` 이라 로그가 통째로 죽는데 호출 글자는 그대로다(실측)",
        wired.args,
        `args=${wired.args}`,
      ),
      assert(
        "★★메시지 루프의 **직계**다 — 한 겹 더 감싸면(`for (const _ of [])`) 그 안은 한 번도 안 돌 수 있는데 소스 모양은 멀쩡하다(실측으로 통과했다)",
        wired.directChild,
        `directChild=${wired.directChild}`,
      ),
    );

    return out;
  },
};
