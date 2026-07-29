/**
 * 회귀: **잡 목록의 세션 경계** (2026-07-29).
 *
 * 사고: 다른 대화에서 도는 general 워커를 보고 메인 비서가 "이전 워커가 실행 중" 이라고
 * 판단해 새 작업을 안 띄웠다(사용자 신고). 잡 레코드에는 띄운 세션의 threadKey 가 처음부터
 * 실려 있었는데 **읽는 쪽(list_workers)이 전 세션 통합**이었다 = 데이터가 아니라 질의의 결함.
 * 게다가 비서는 자기 세션 id 조차 프롬프트에서 볼 수 없어 남의 것인지 구분할 수단도 없었다.
 *
 * 그래서 (1) 소속 판정 규칙과 (2) 세션 정체성 노출을 둘 다 검사한다.
 */
import { jobBelongsToSession } from "../../core/worker-jobs.js";
import { formatConversationContext } from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "job-session-scope",
  guards: "다른 세션의 매니저를 자기 것으로 오인해 새 작업을 안 띄우던 것",
  run: async (): Promise<Assertion[]> => {
    const A = "dashboard:aaa";
    const B = "dashboard:bbb";
    const ctx = formatConversationContext("dashboard", A);
    return [
      assert(
        "같은 세션이 띄운 잡은 소속",
        jobBelongsToSession({ threadKey: A }, A),
        "직접 소속",
      ),
      assert(
        "★다른 세션이 띄운 잡은 소속 아님",
        !jobBelongsToSession({ threadKey: B }, A),
        "교차 누수 0",
      ),
      assert(
        "환원 불가(부모 미상) 잡 좌표는 소속 아님 — 미상을 내 것으로 넘기지 않는다",
        !jobBelongsToSession({ threadKey: "worker:없는잡" }, A),
        "fail-closed",
      ),
      assert(
        "빈 세션 키에는 아무것도 소속되지 않는다",
        !jobBelongsToSession({ threadKey: A }, ""),
        "빈 키 가드",
      ),
      assert(
        "★프롬프트가 자기 세션 id 를 노출한다(구분할 근거)",
        ctx.includes(A),
        ctx.split("\n")[0] ?? "",
      ),
    ];
  },
};
