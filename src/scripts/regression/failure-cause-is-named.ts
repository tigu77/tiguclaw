/**
 * 회귀: **무슨 에러였는지 정확히 말한다 — 그리고 로그만으로 알 수 있다.**
 *
 * 사고 (2026-08-12, 사용자): 백그라운드 작업 실패 통지가
 *  `원인: LLM 응답이 멈춰(타임아웃) 완료하지 못했습니다` 였다. 그런데 코드를 따라가 보니
 *  **1층 유휴 타임아웃은 전 턴 면제**(idleConfigExempt = 사실상 무제한)라 "멈춰서" 는
 *  구조적으로 원인이 될 수 없었다. 실제 후보는 wall-clock 상한이나 도구 상한이었고,
 *  둘 다 **모델이 멈춘 게 아니라 진행 중인 걸 시계가 자른** 사건이다.
 *  즉 통지가 **틀린 원인**을 말했고, 그 말을 믿으면 백엔드를 뒤지게 된다.
 *
 * 사용자 지침(그대로): "오래 걸리는 건 그냥 냅두는 게 맞는 거고 / 에러는 확실히 알려주는
 *  게 맞는 거고 / 무슨 에러가 난 건지 정확하게 알려주는 게 중요하지 / 확실하게 로그를 심어보자."
 *
 * 지키는 것 —
 *  ① 시간 관련 종료를 **한 문구로 뭉치지 않는다**(wall-clock / 도구 / 유휴는 다른 사건)
 *  ② wall-clock 은 "멈춘 게 아니다" 를 명시한다(오진단 유발 금지)
 *  ③ 분류 못 한 타임아웃은 **원문을 실어 보낸다**(덮지 않는다)
 *  ④ 통지와 로그가 **같은 판정**을 쓴다(두 곳이 갈리면 원격 진단이 다시 추론이 된다)
 *  ⑤ 실패 로그에 판정 재료가 실린다(얼마나 돌았나·분류·스레드·원문)
 *  ⑥ ★도구 하드컷은 **기본 꺼짐** — 오래 걸리는 걸 시계로 죽이지 않는다
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const { classifyFailure } = await import("../../core/worker-jobs.js");

  const WALL = "매니저 처리 시간 초과 (7200000ms wall-clock 상한) — 모델 거부 아님";
  const TOOL = "[tool-hang] 도구 Bash 이(가) 780s 안에 안 끝나 턴을 중단합니다";
  const IDLE = "유휴 타임아웃 90000ms — 모델 거부 아님";
  const LIMIT = 'usage_limit_reached 429';
  const OVER = "error/server_is_overloaded: Our servers are currently overloaded.";

  // ── ①④ 분류가 실제로 갈린다(순수 함수를 돌린다) ───────────────────────────
  const got = {
    wall: classifyFailure(WALL),
    tool: classifyFailure(TOOL),
    idle: classifyFailure(IDLE),
    limit: classifyFailure(LIMIT),
    over: classifyFailure(OVER),
  };
  const distinct = new Set(Object.values(got)).size === 5;
  out.push({
    name: "★시간 관련 종료를 한 문구로 뭉치지 않는다(다섯 축이 서로 다른 분류)",
    ok: distinct && got.wall === "wall-clock상한" && got.idle === "유휴(무응답)",
    got: JSON.stringify(got),
  });

  // ── ②③ 사용자 문구 — wall-clock 은 "멈춘 게 아니다", 미분류는 원문 보존 ─────
  const src = await readFile(new URL("../../core/worker-jobs.ts", import.meta.url), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const saysNotStalled = /모델이 멈춘 게 아니라 진행 중이었을 수 있습니다/.test(code);
  out.push({
    name: "★wall-clock 중단을 '모델이 멈췄다' 로 말하지 않는다",
    ok: saysNotStalled,
    got: saysNotStalled ? "명시 문구 있음" : "★여전히 멈췄다고 말한다(엉뚱한 곳을 뒤지게 된다)",
  });
  const keepsRaw = /시간 관련 중단이 발생했습니다 — 원문: \$\{raw/.test(code);
  out.push({
    name: "분류 못 한 타임아웃은 원문을 실어 보낸다(뭉뚱그려 덮지 않는다)",
    ok: keepsRaw,
    got: keepsRaw ? "원문 보존" : "★일반 문구로 덮는다",
  });

  // ── ⑤ 실패 로그가 혼자 서는가 — **실제로 실패시켜 잡는다** ─────────────────
  //  ★소스 훑기로는 부족했다: `void 0 &&` 로 호출을 죽이는 변이를 통과시켰다(실측).
  //   그물이 지켜야 하는 건 "그 코드가 있다" 가 아니라 "그 줄이 실제로 찍힌다" 다.
  {
    const wj = await import("../../core/worker-jobs.js");
    const jobId = wj.registerJob({
      label: "회귀-실패로그",
      task: "t",
      channel: "http-bridge",
      threadKey: "regr:fail-log",
      channelUserId: "regr",
    });
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      wj.markFailed(jobId, WALL);
    } finally {
      console.error = orig;
    }
    const line = lines.find((l) => l.includes("[job-failed]")) ?? "";
    const hasAll =
      line.includes("회귀-실패로그") &&
      line.includes("분류=wall-clock상한") &&
      line.includes("thread=regr:fail-log") &&
      /\d+s 실행 후 실패/.test(line);
    out.push({
      name: "★실패하면 로그 한 줄이 실제로 찍힌다(라벨·경과·분류·스레드·원문)",
      ok: hasAll,
      got: line === "" ? "★[job-failed] 줄이 안 찍혔다" : line.slice(0, 200),
    });
  }

  // ── ⑥ 도구 하드컷 기본 꺼짐 ────────────────────────────────────────────────
  const wd = await readFile(
    new URL("../../core/llm-runtime/tool-watchdog.ts", import.meta.url),
    "utf8",
  );
  const wdCode = wd
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const optIn =
    /if \(raw === undefined \|\| raw\.trim\(\) === ""\) return null;/.test(wdCode) &&
    /hardMs !== null && input\.onHard !== undefined/.test(wdCode);
  out.push({
    name: "★도구 하드컷은 기본 꺼짐 — 오래 걸리는 걸 시계로 죽이지 않는다",
    ok: optIn,
    got: optIn ? "미설정=상한 없음" : "★기본값이 살아 있다(진행 중 작업이 잘린다)",
  });
  // 칼은 뺐지만 **신호는 남아야 한다** — 2026-08-06 사고는 '몰라서' 나빴다.
  const stillWarns = /\[tool-slow\]/.test(wdCode) && /llm\.tool_slow/.test(wdCode);
  out.push({
    name: "끊지 않는 대신 신호는 남는다(경고 + tool_slow 이벤트)",
    ok: stillWarns,
    got: stillWarns ? "경고·이벤트 유지" : "★신호까지 없앴다 — 멈춘 걸 알 길이 없다",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "failure-cause-is-named",
  guards:
    "실패 통지가 wall-clock 상한·도구 상한·유휴를 한 문구('LLM 응답이 멈춰')로 뭉쳐 틀린 원인을 말하던 것 + 그 판정이 로그에 안 남아 원격 기계에서 추론에 의존하던 것 + 13분 도구 하드컷이 진행 중인 작업을 시계로 죽이던 것",
  run,
};
