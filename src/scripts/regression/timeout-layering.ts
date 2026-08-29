/**
 * 회귀: **경계는 안쪽에서 바깥으로 갈수록 느슨해야 한다** (2026-07-28).
 *
 * 이 불변식이 깨지면 바깥 경계가 정상 진행 중인 작업을 "무응답"으로 자르고, 모델은 그
 * 에러를 보고 같은 일을 다시 띄운다(중복 실행·작업 충돌). 실제 사고 3건이 전부 같은 구조다:
 *  - 2026-06-19 위키 11h outage — MCP 60s 천장이 정상 도구(60s+)를 자름.
 *  - 2026-06-23 메인 턴 wall-clock 폐기 — 정상 긴 작업을 자르던 부작용.
 *  - 2026-07-28 어댑터 8분 도구 시계 — MCP 11분·잡 2시간보다 **더 조여서** 서브에이전트를
 *    끊었고, 모델이 같은 작업을 매니저로 재실행했다(사용자 신고 3회).
 *
 * 그래서 "이번엔 안 그러겠지"가 아니라 숫자 관계 자체를 검사한다.
 */
import {
  WORKER_TIMEOUT_MS,
  SUBAGENT_TIMEOUT_MS,
  JOB_OWNING_TOOL_CALL_TIMEOUT_MS,
} from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** _mcp-bridge.ts 의 기본 천장(같은 기본값·같은 env 키를 여기서도 해석 — 드리프트 감지). */
const mcpCallTimeoutMs = (): number => {
  const raw = process.env.MCP_CALL_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 660_000;
};
/** file-ops Bash 의 최대 타임아웃(도구 자체 경계 = 가장 안쪽). */
const BASH_MAX_TIMEOUT_MS = 600_000;

export const check: RegressionCheck = {
  name: "timeout-layering",
  guards: "바깥 경계가 안쪽보다 조여 정상 작업을 끊고 모델이 중복 실행하던 것",
  run: async (): Promise<Assertion[]> => {
    const mcp = mcpCallTimeoutMs();
    const jobOwning = JOB_OWNING_TOOL_CALL_TIMEOUT_MS();
    return [
      assert(
        "MCP 천장 > Bash 최대(도구 자체가 먼저 발화)",
        mcp > BASH_MAX_TIMEOUT_MS,
        `mcp=${mcp} bash=${BASH_MAX_TIMEOUT_MS}`,
      ),
      assert(
        "잡 소유 도구의 천장이 잡 상한보다 느슨하다(잡이 먼저 끝나게)",
        outerIsLooser(jobOwning, WORKER_TIMEOUT_MS),
        `천장=${fmt(jobOwning)} 잡상한=${fmt(WORKER_TIMEOUT_MS)}`,
      ),
      assert(
        "잡 소유 도구의 천장 > 기본 MCP 천장(기본값을 쓰면 잡이 잘린다)",
        jobOwning > mcp,
        `천장=${fmt(jobOwning)} 기본=${mcp}`,
      ),
      assert(
        // ★안쪽 축이 **실제로 존재**하는가 (2026-07-29). 숫자 관계만 보면, 안쪽 경계가
        //  아예 없는데도(서브에이전트가 cancel-only 였다) 부등식은 전부 참이라 통과한다.
        //  그 구멍으로 "멈춘 서브가 부모를 125분 잡는" 상태가 검사를 통과했다.
        //  ★2026-08-22 상한 무한화 이후엔 "값이 있는가" 로는 못 본다(Infinity > 0 은 참).
        //   축의 존재는 **배선**으로 판정한다 — 아래 두 검사가 그 몫이다.
        "서브에이전트 상한이 잡 천장보다 느슨하지 않다",
        outerIsLooser(jobOwning, SUBAGENT_TIMEOUT_MS),
        `서브상한=${fmt(SUBAGENT_TIMEOUT_MS)} 천장=${fmt(jobOwning)}`,
      ),
      assert(
        // ★두 레인이 **대칭**인가 (2026-08-22). `startDetachedAgent` 엔 하드 백스톱이
        //  없어서, abort 를 안 듣는 자식(hung MCP)이면 잡이 영원히 running 으로 굳고
        //  통지가 0건이었다(매니저 레인은 1건). 실측으로 확인한 실사고 —
        //  사용자 신고 "타임아웃 이후 아무런 응답이 없어".
        "★두 잡 레인 모두 하드 백스톱이 있다(abort 를 안 듣는 자식도 닫힌다)",
        await bothLanesHaveHardBackstop(),
        "worker-registry.ts · agent-registry.ts",
      ),
      ...(await (async () => {
        // ★`setTimeout(fn, Infinity)` 은 Node 가 **1ms 로 클램프**한다 = 상한 없음이
        //  상한 1ms 로 뒤집혀 모든 잡이 즉시 죽는다. 무한을 허용하는 한 이 가드는 필수.
        const g = await timerGuardsAgainstInfinity();
        return [
          assert(
            "★무한 상한에 타이머를 걸지 않는다(Infinity → 1ms 클램프 방지)",
            g.ok,
            g.detail,
          ),
        ];
      })()),
      assert(
        "서브에이전트 잡이 timeoutMs 로 abort 를 만든다(배선 확인)",
        await subagentAbortHasTimeout(),
        "agent-registry.ts",
      ),
      assert(
        // 어댑터 층에 별도 도구 시계가 되살아나면 이 검사가 의미를 잃으므로 소스로 확인한다.
        "어댑터에 per-tool wall-clock 이 없다(중복 경계 0)",
        await adapterHasNoToolWallClock(),
        "openai-codex-oauth.ts",
      ),
    ];
  },
};

/** 표시용 — Infinity 를 사람이 읽는 말로. */
const fmt = (ms: number): string => (Number.isFinite(ms) ? String(ms) : "무한(상한 없음)");

/**
 * 바깥 경계가 안쪽보다 **느슨한가.**
 *
 * ★단순 `>` 로 쓰면 안 된다 (2026-08-22 상한 무한화). 안쪽이 무한이면 `Infinity > Infinity`
 *  가 거짓이라 **정상 배치가 실패로 뜬다.** 불변식의 뜻은 "안쪽이 먼저 발화한다" 이고,
 *  둘 다 무한이면 어느 쪽도 발화하지 않으므로 위반이 아니다. 반대로 안쪽만 무한인데 바깥이
 *  유한이면 바깥이 가장 조이는 것 = 정확히 이 회귀가 막으려는 그 배치다.
 */
const outerIsLooser = (outer: number, inner: number): boolean =>
  Number.isFinite(inner) ? outer > inner : !Number.isFinite(outer);

/** 두 잡 레인(매니저·서브에이전트)이 **모두** 하드 백스톱 race 를 갖는지. */
const bothLanesHaveHardBackstop = async (): Promise<boolean> => {
  const { readFile } = await import("node:fs/promises");
  const read = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(new URL(rel, import.meta.url), "utf8");
    } catch {
      return null;
    }
  };
  const worker = await read("../../core/llm-runtime/capabilities/worker-registry.ts");
  const agent = await read("../../core/llm-runtime/capabilities/agent-registry.ts");
  if (worker === null || agent === null) return true; // 배포본(.ts 미포함) — 오탐 0.
  const hasRace = (src: string): boolean =>
    /Promise\.race\(\[/.test(src) && /new WorkerTimeoutError\(/.test(src);
  return hasRace(worker) && hasRace(agent);
};

/**
 * 타이머 상한 가드 — 없으면 무한 상한이 **1ms 상한**으로 뒤집혀 모든 잡이 즉시 죽는다.
 *
 * ★종전엔 세 파일에 문자열 `Number.isFinite(` 가 **있는지만** 봤다 — 클램프를 세 곳 다
 *  지워도 초록이었다(2026-08-23 2라운드 F3, 변이 M8 로 실증). 있다/없다를 세는 검사는
 *  동의어 하나·다른 용도 한 줄로 뚫린다. [[feedback_gate_must_actually_run]] 의 반대편
 *  (항상 초록인 가짜 검사)이다.
 *
 * 그래서 둘로 바꾼다: ①**순수 함수를 실행**해 접힘 방지를 직접 확인 ②타이머 호출의
 * 지연 인자가 `_MS` 값을 쓰면서 래퍼를 안 거치는 자리가 있는지 **구문으로** 판정.
 */
const timerGuardsAgainstInfinity = async (): Promise<{
  ok: boolean;
  detail: string;
}> => {
  const MAX = 2_147_483_647;
  // ① 실행 — 이게 본질이다(구현이 무엇이든 결과가 판정한다).
  const { asFiniteTimeoutMs } = await import("../../core/worker-jobs.js");
  const rows: Array<[string, number, boolean]> = [
    ["Infinity", asFiniteTimeoutMs(Number.POSITIVE_INFINITY), true],
    ["1e10(2^31 초과)", asFiniteTimeoutMs(1e10), true],
    ["NaN", asFiniteTimeoutMs(Number.NaN), true],
    ["5000(정상)", asFiniteTimeoutMs(5_000), false],
  ];
  const bad = rows.filter(([, got, clamp]) =>
    clamp ? !(got > 0 && got <= MAX) : got !== 5_000,
  );
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `★asFiniteTimeoutMs 가 접힘을 못 막는다: ${bad
        .map(([n, g]) => `${n}→${g}`)
        .join(", ")}`,
    };
  }
  // ② ★타이머를 **실제로 건다**. 구문 검사로는 부족했다 — 첫 판은 `_MS` 식별자만 봤는데
  //  진짜 위험한 자리(`createJobAbort`)는 지연이 지역변수 `ms` 라 그물 밖이었고, 클램프를
  //  떼는 변이가 그대로 통과했다. 여기선 큰 유한값·무한을 넣고 **안 터지는지** 본다.
  const { createJobAbort } = await import("../../core/worker-jobs.js");
  const fires = async (timeoutMs: number): Promise<boolean> => {
    const a = createJobAbort(`regr-clamp-${timeoutMs}`, { timeoutMs });
    await new Promise((r) => setTimeout(r, 120));
    const aborted = a.signal.aborted;
    a.done();
    return aborted;
  };
  const overflowFired = await fires(2_147_483_647 * 3); // 2^31-1 초과 = 접힘 위험
  const infiniteFired = await fires(Number.POSITIVE_INFINITY);
  if (overflowFired || infiniteFired) {
    return {
      ok: false,
      detail:
        `★타이머가 즉시 발화했다 — 상한이 1ms 로 뒤집혔다(모든 잡 즉사): ` +
        `2^31-1×3→${overflowFired ? "발화" : "정상"} · Infinity→${infiniteFired ? "발화" : "정상"}`,
    };
  }
  return {
    ok: true,
    detail: "클램프 4종 + 실제 타이머 2종(2^31-1×3 · Infinity) 120ms 내 미발화",
  };
};


/** 서브에이전트 abort 가 timeoutMs 를 받는지(배선이 빠지면 안쪽 축이 사라진다). */
const subagentAbortHasTimeout = async (): Promise<boolean> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(
    "../../core/llm-runtime/capabilities/agent-registry.ts",
    import.meta.url,
  );
  try {
    const src = await readFile(url, "utf8");
    return /createJobAbort\(jobId,\s*\{\s*timeoutMs/.test(src);
  } catch {
    return true; // 배포본(.ts 미포함) — 오탐 0.
  }
};

/** 어댑터 소스에 도구 wall-clock 이 다시 생겼는지 확인(문자열 검사 — 의도적으로 무디게). */
const adapterHasNoToolWallClock = async (): Promise<boolean> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(
    "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
    import.meta.url,
  );
  try {
    const src = await readFile(url, "utf8");
    // 폐기한 심볼들이 살아 돌아오면 실패 — 주석에는 남아 있으므로 코드 형태로만 본다.
    return !/CODEX_TOOL_TIMEOUT_MS\s*[,)]/.test(src) && !/armToolTimeout\s*\(/.test(src);
  } catch {
    return true; // 배포본(.ts 미포함)에선 검사 불가 — 통과 처리(오탐 0).
  }
};
