/**
 * 회귀: **돌고 있는 매니저에 지시가 닿는다** (2026-07-29).
 *
 * 배경: steering 소비층(3어댑터)은 `input.steering` 하나만 보므로 배관은 처음부터
 * LLM-agnostic 이었다. 매니저가 못 받은 이유는 단 하나 — runner 가 steering 을 안 넘기고
 * 아무도 `worker:<jobId>` 키로 채널을 만들지 않았다(채널 핸들러의 맵은 세션 키 전용).
 * 즉 버퍼 키 불일치가 아니라 **부재**였다. 배선이 다시 빠지면 매니저는 조용히 fire-and-forget
 * 으로 되돌아가고, 사용자는 "보냈는데 아무 일도 안 일어남" 만 겪는다(조용한 실패).
 *
 * 레지스트리 계약(등록·전달·종료 후 거절·미상 구분)을 검사한다 — 네트워크·LLM 0.
 */
import {
  setSteerChannel,
  clearSteerChannel,
  steerJob,
  WORKER_STEERING_ENABLED,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const msg = (t: string) => ({ text: t, raw: t, ts: 1 });

/** runner → runRegionA 배선 확인. 이게 빠지면 매니저는 조용히 fire-and-forget 으로 돌아간다. */
const runnerPassesSteering = async (): Promise<boolean> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(
    "../../core/llm-runtime/capabilities/worker-registry.ts",
    import.meta.url,
  );
  try {
    const src = await readFile(url, "utf8");
    return /steering:\s*steerCh/.test(src) && /setSteerChannel\(job\.jobId/.test(src);
  } catch {
    return true; // 배포본(.ts 미포함) — 검사 불가, 오탐 0.
  }
};

export const check: RegressionCheck = {
  name: "worker-steering",
  guards: "돌고 있는 매니저에 추가 지시가 안 닿아 fire-and-forget 이던 것",
  run: async (): Promise<Assertion[]> => {
    const id = "regr-steer-1";
    const ch = createSteeringChannel();
    setSteerChannel(id, ch);

    const delivered = steerJob(id, msg("이것도 해줘"));
    const buffered = ch.drain();

    ch.close();
    const afterClose = steerJob(id, msg("늦은 지시"));

    clearSteerChannel(id);
    const afterClear = steerJob(id, msg("없는 매니저"));

    return [
      assert("기본 활성(끄려면 명시적으로)", WORKER_STEERING_ENABLED === true, "기본 on"),
      assert("★진행 중 매니저에 전달된다", delivered === "delivered", delivered),
      assert(
        "전달된 지시가 버퍼에 실린다(어댑터가 다음 경계에서 소비)",
        buffered.length === 1 && buffered[0]?.raw === "이것도 해줘",
        `${buffered.length}건`,
      ),
      assert(
        "턴이 닫힌 뒤엔 closed — 조용히 삼키지 않는다(잔여 통지의 근거)",
        afterClose === "closed",
        afterClose,
      ),
      assert("없는 매니저는 absent", afterClear === "absent", afterClear),
      assert(
        // ★배선이 실제로 존재하는가 (변이 테스트가 잡은 구멍, 2026-07-29): 위 단언들은
        //  레지스트리 *계약*만 본다. runner 가 runRegionA 에 steering 을 안 넘겨도 전부
        //  통과했고 타입체크도 0 에러였다 — 즉 이 검사만으론 원래 결함을 못 잡는다.
        //  timeout-layering 이 "서브에이전트에 자체 상한이 실제로 있나"를 소스로 확인하는 것과
        //  같은 이유·같은 방식(배포본엔 .ts 가 없어 오탐 0으로 통과).
        "매니저 runner 가 runRegionA 에 steering 을 넘긴다(배선 확인)",
        await runnerPassesSteering(),
        "worker-registry.ts",
      ),
    ];
  },
};
