/**
 * 회귀: 진행 중인 백그라운드 작업이 **턴 컨텍스트에 보인다** (2026-07-29).
 *
 * 사고: 워커가 아직 도는데 메인이 같은 일로 워커를 하나 더 띄웠다(DB 실측: 23:41 시작한
 * 잡이 살아있는 채 23:43 재발사). 서브에이전트를 끊은 게 아니라 **그대로 둔 채 또 띄운**
 * 것이므로 타임아웃 문제가 아니다 — 원인은 모델이 **자기가 뭘 띄웠는지 턴 안에서 볼
 * 수단이 없었던** 것. 규칙으로 훈계하는 대신 사실을 준다(판단 근거를 가진 쪽이 판단).
 *
 * 평시 토큰 0이어야 한다 — 진행 중이 없으면 줄 자체를 넣지 않는다.
 */
import {
  registerJob,
  markDone,
  __resetJobsForTest,
} from "../../core/worker-jobs.js";
import { formatConversationContext } from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const TK = "dashboard:regression-livejobs";

export const check: RegressionCheck = {
  name: "live-jobs-context",
  guards: "메인이 자기가 띄운 작업을 모른 채 같은 일을 또 띄우던 것(중복 실행·충돌)",
  run: async (): Promise<Assertion[]> => {
    __resetJobsForTest();
    const none = formatConversationContext("http-bridge", TK, "addr");
    const out: Assertion[] = [
      assert("진행 중 없으면 줄 없음(평시 토큰 0)", !none.includes("진행 중인 백그라운드"), `${none.split("\n").length}줄`),
    ];
    const w = registerJob({ label: "파이프라인", threadKey: TK, channel: "dashboard", channelUserId: "u", task: "t" });
    const a = registerJob({ label: "검증 서브", threadKey: `worker:${w}`, channel: "dashboard", channelUserId: "u", task: "t", kind: "agent" });
    const withJobs = formatConversationContext("http-bridge", TK, "addr");
    out.push(assert("매니저가 보인다", withJobs.includes("파이프라인"), "포함 여부"));
    // ★손자까지 — 워커가 띄운 서브는 threadKey 가 잡 좌표라 정확 일치로는 안 걸린다.
    out.push(assert("손자(매니저가 띄운 서브)도 보인다", withJobs.includes("검증 서브"), "포함 여부"));
    markDone(a, "ok");
    markDone(w, "ok");
    const after = formatConversationContext("http-bridge", TK, "addr");
    out.push(assert("끝나면 사라진다", !after.includes("진행 중인 백그라운드"), "잔류 여부"));
    __resetJobsForTest();
    return out;
  },
};
