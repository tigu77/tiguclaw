/**
 * 회귀: **백그라운드 잡의 토큰 합계는 서버가 턴마다 더하고, 목록·종료 이벤트로 나간다** (2026-09-23).
 *
 * ★사고: 채팅 턴은 머리에 `↓입력 · N회 · 캐시 % · ↑출력` 을 달지만 백그라운드 잡은
 *  아무 데도 안 보였다. 매니저 한 턴이 메인의 두 배를 넘게 먹는데(dev 실측 턴당 평균
 *  158만 vs 70만) 가장 비싼 자리가 가장 안 보였다.
 * ★합계를 화면이 SSE 로 더하면 새로고침 뒤 replay 창(50)만큼만 남아 **거짓 합계**가 된다
 *  — 그래서 서버가 든다. 이 검사가 지키는 것:
 *  ① 턴 실비용 규칙 — 반복 2회↑ 면 합계 필드(출력도 합계), 아니면 단일 필드(`turnSpend`).
 *     ★이 규칙은 **발행자 한 곳**에만 있다 — `llm.turn_done.spend` 로 실리고 채팅 줄·잡 합계는
 *     읽기만 한다. 그래서 아래 ②~⑤ 는 실제 발행자(`publishTurnDone`)를 거쳐 잰다.
 *  ② 잡 좌표(`worker:`·`agent:`)의 턴만 그 잡에 더한다 — 세션 턴·남의 잡은 안 섞인다.
 *  ③ 미보고 턴은 **0 으로 더하지 않고 센다**(합계가 하한임을 화면이 말할 수 있게).
 *  ④ ★종료 이벤트(`worker.done`)에 합계가 실린다 — 끝난 카드가 replay 로만 서도 보이게.
 *  ⑤ ★진행 중 목록(`GET /api/worker-jobs`)에 합계가 실린다 — 새로고침 복원 경로다.
 *
 * 등급: 동작(실제 발행자로 `llm.turn_done` 을 내고 실제 레지스트리·라우트를 읽는다).
 */
import { readFileSync } from "node:fs";
import { getEventBus } from "../../core/eventbus.js";
import { publishTurnDone } from "../../core/llm-runtime/index.js";
import { turnSpend } from "../../core/llm-runtime/turn-spend.js";
import type { RegionASdkOutput } from "../../core/llm-runtime/types.js";
import {
  __resetJobsForTest,
  getJob,
  markDone,
  registerJob,
} from "../../core/worker-jobs.js";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const reg = (label: string): string =>
  registerJob({
    label,
    task: "합계 검사",
    threadKey: "dashboard:usage-test",
    channel: "dashboard",
    channelUserId: "u",
  });

/** 실제 발행자로 턴 하나를 낸다 — `spend` 를 붙이는 자리를 우회하지 않는다. */
const turnDone = (threadKey: string, usage: RegionASdkOutput["usage"]): void =>
  publishTurnDone(
    { adapter: "codex-oauth", model: "synthetic" },
    { channel: "cli", threadKey, text: "synthetic" },
    { text: "done", ...(usage !== undefined ? { usage } : {}) },
    1,
  );

export const check: RegressionCheck = {
  name: "job-usage-is-summed-by-server",
  guards:
    "백그라운드 잡의 토큰·캐시가 어디에도 안 보이던 것 — 화면이 SSE 로 더하면 새로고침 뒤 거짓 합계가 되므로 서버가 턴마다 더해 목록·종료 이벤트로 낸다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // ① 턴 실비용 규칙
    const single = turnSpend({ inputTokens: 1000, cachedTokens: 800, outputTokens: 50 });
    const loop = turnSpend({
      inputTokens: 900, cachedTokens: 850, outputTokens: 10,
      iterations: 3, inputTokensTotal: 2500, cachedTokensTotal: 2000, outputTokensTotal: 70,
    });
    out.push(
      assert(
        "① 단일 턴은 단일 필드, 루프 턴은 합계 필드(출력 포함)를 쓴다",
        single?.input === 1000 && single.cached === 800 && single.output === 50 && single.requests === 1 &&
          loop?.input === 2500 && loop.cached === 2000 && loop.output === 70 && loop.requests === 3,
        JSON.stringify({ single, loop }),
      ),
      assert(
        "① 미보고(입력 없음)는 0 이 아니라 «없음» 이다",
        turnSpend({ outputTokens: 5 }) === undefined,
        String(turnSpend({ outputTokens: 5 })),
      ),
    );

    // ① 소비처는 층을 다시 고르지 않는다 — `*TokensTotal` 을 직접 읽는 순간 두 번째 규칙이 생긴다.
    //  대상: 채팅 줄(token-delta) · 게이트웨이 · 로그 적중률 집계. (생산자인 어댑터·발행자의
    //  필드 복사와 dev 전용 벤치 엔진은 대상이 아니다.)
    const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const src = (rel: string): string =>
      strip(readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8"));
    const runtime = src("src/core/llm-runtime/index.ts");
    const rollup = /const accumulatePrefixCacheRollup = [\s\S]*?\n\};/.exec(runtime)?.[0] ?? "";
    const consumers: Array<[string, string]> = [
      ["packages/dashboard/js/token-delta.js", src("packages/dashboard/js/token-delta.js")],
      ["plugins/http-bridge/routes-gateway.ts", src("plugins/http-bridge/routes-gateway.ts")],
      ["accumulatePrefixCacheRollup", rollup],
    ];
    const reread = consumers
      .filter(([, body]) => /\b(?:input|output|cached)TokensTotal\b/.test(body))
      .map(([name]) => name);
    out.push(
      assert(
        "① 턴 비용 소비처(채팅 줄·게이트웨이·로그 집계)는 `turnSpend`/`spend` 만 쓴다",
        rollup !== "" && reread.length === 0,
        rollup === ""
          ? "★집계 함수를 못 찾음(검사 전제)"
          : reread.length === 0
            ? "3곳 모두 한 규칙"
            : `★*TokensTotal 을 직접 해석: ${reread.join(", ")}`,
      ),
    );

    // ②③ 레지스트리 합계
    __resetJobsForTest();
    const a = reg("A");
    const b = reg("B");
    const done: Record<string, unknown>[] = [];
    const unsub = getEventBus().subscribe((ev) => {
      if (ev.type === "worker.done") done.push(ev.payload as Record<string, unknown>);
    });
    const seen: Record<string, unknown>[] = [];
    const unsubSeen = getEventBus().subscribe((ev) => {
      if (ev.type === "llm.turn_done") seen.push(ev.payload as Record<string, unknown>);
    });
    turnDone(`worker:${a}`, { inputTokens: 1000, cachedTokens: 800, outputTokens: 50 });
    turnDone(`worker:${a}`, {
      inputTokens: 900, outputTokens: 10,
      iterations: 3, inputTokensTotal: 2500, cachedTokensTotal: 2000, outputTokensTotal: 70,
    });
    turnDone(`worker:${a}`, undefined); // 미보고 턴
    turnDone(`agent:${b}`, { inputTokens: 300, cachedTokens: 0, outputTokens: 3 });
    turnDone("dashboard:usage-test", { inputTokens: 99999, outputTokens: 9 }); // 세션 턴
    unsubSeen();
    const loopEv = seen.find((p) => (p.spend as { requests?: number } | undefined)?.requests === 3);
    out.push(
      assert(
        "① 발행된 `llm.turn_done` 에 `spend` 가 실린다(채팅 줄이 읽는 값 — 루프 출력은 합계 70)",
        (loopEv?.spend as { input?: number; output?: number } | undefined)?.input === 2500 &&
          (loopEv?.spend as { output?: number }).output === 70,
        JSON.stringify(loopEv?.spend),
      ),
    );
    const ua = getJob(a)?.usage;
    const ub = getJob(b)?.usage;
    out.push(
      assert(
        "② 잡 A 에는 A 좌표의 턴만 더해진다(세션 턴·남의 잡 제외)",
        ua?.turns === 3 && ua.requests === 4 && ua.inputTokens === 3500 &&
          ua.cachedTokens === 2800 && ua.outputTokens === 120,
        JSON.stringify(ua),
      ),
      assert("③ 미보고 턴은 0 으로 더하지 않고 센다", ua?.unreportedTurns === 1, JSON.stringify(ua)),
      assert(
        "② `agent:` 좌표(서브에이전트)의 턴도 그 잡에 더해진다",
        ub?.turns === 1 && ub.inputTokens === 300,
        JSON.stringify(ub),
      ),
    );

    // ⑤ 진행 중 목록 — 라우트를 실제로 부른다(`plugins/` 는 계산된 지정자로, TS6059 회피).
    const { handleWorkerJobs } = await loadPluginModule<{
      handleWorkerJobs: (ctx: unknown) => Promise<void>;
    }>("../../../plugins/http-bridge/routes-work.js");
    let body = "";
    await handleWorkerJobs({
      req: {},
      res: { writeHead: () => {}, end: (s: string) => { body = s; } },
      url: new URL("http://x/worker-jobs"),
      pathname: "/worker-jobs",
      channelName: "regr",
      bus: null,
      sseClients: new Set(),
      channelHandler: null,
    });
    const listed = (JSON.parse(body === "" ? "{}" : body) as { jobs?: Array<Record<string, unknown>> })
      .jobs?.find((j) => j.jobId === a)?.usage as Record<string, unknown> | undefined;
    out.push(
      assert(
        "⑤ 진행 중 목록(`/api/worker-jobs`)에 합계가 실린다(새로고침 복원 경로)",
        listed?.inputTokens === 3500 && listed.turns === 3,
        JSON.stringify(listed),
      ),
    );

    // ④ 종료 이벤트에 합계가 실린다
    markDone(a, "끝");
    const pa = done.find((p) => p.jobId === a)?.usage as Record<string, unknown> | undefined;
    out.push(
      assert(
        "④ `worker.done` 에 잡 합계가 실린다(끝난 카드가 replay 로만 서도 보이게)",
        pa?.inputTokens === 3500 && pa.requests === 4 && pa.unreportedTurns === 1,
        JSON.stringify(pa),
      ),
    );
    unsub();
    __resetJobsForTest();
    return out;
  },
};
