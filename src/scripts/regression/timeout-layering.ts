/**
 * 회귀: **경계는 안쪽에서 바깥으로 갈수록 느슨해야 한다** (2026-07-28).
 *
 * 이 불변식이 깨지면 바깥 경계가 정상 진행 중인 작업을 "무응답"으로 자르고, 모델은 그
 * 에러를 보고 같은 일을 다시 띄운다(중복 실행·작업 충돌). 실제 사고 3건이 전부 같은 구조다:
 *  - 2026-06-19 위키 11h outage — MCP 60s 천장이 정상 도구(60s+)를 자름.
 *  - 2026-06-23 메인 턴 wall-clock 폐기 — 정상 긴 작업을 자르던 부작용.
 *  - 2026-07-28 어댑터 8분 도구 시계 — MCP 11분·잡 2시간보다 **더 조여서** 서브에이전트를
 *    끊었고, 모델이 같은 작업을 워커로 재실행했다(사용자 신고 3회).
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
        "잡 소유 도구의 천장 > 잡 상한(잡이 먼저 끝나게)",
        jobOwning > WORKER_TIMEOUT_MS,
        `천장=${jobOwning} 잡상한=${WORKER_TIMEOUT_MS}`,
      ),
      assert(
        "잡 소유 도구의 천장 > 기본 MCP 천장(기본값을 쓰면 잡이 잘린다)",
        jobOwning > mcp,
        `천장=${jobOwning} 기본=${mcp}`,
      ),
      assert(
        // ★안쪽 축이 **실제로 존재**하는가 (2026-07-29). 숫자 관계만 보면, 안쪽 경계가
        //  아예 없는데도(서브에이전트가 cancel-only 였다) 부등식은 전부 참이라 통과한다.
        //  그 구멍으로 "멈춘 서브가 부모를 125분 잡는" 상태가 검사를 통과했다.
        "서브에이전트에 자체 상한이 있다(안쪽 축 존재)",
        SUBAGENT_TIMEOUT_MS > 0 && jobOwning > SUBAGENT_TIMEOUT_MS,
        `서브상한=${SUBAGENT_TIMEOUT_MS} 천장=${jobOwning}`,
      ),
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
