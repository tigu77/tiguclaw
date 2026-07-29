/**
 * 회귀: 잡 좌표 → 원 세션 환원 (2026-07-28).
 *
 * 사고: 서브에이전트의 threadKey 는 세션 키가 아니라 *부모 잡 좌표*인데, 대시보드가
 * 자기 화면에 렌더된 카드만으로 부모를 거슬러 올라가다 실패하면 "소속 미상"이 되고,
 * 미상을 노출로 처리해 **다른 세션에서도 진행 중으로 보였다**(사용자 신고 2회).
 * 서버가 환원하도록 옮긴 뒤로는 이 함수가 그 판정의 단일 근거다.
 */
import {
  registerJob,
  resolveOwnerThreadKey,
  __resetJobsForTest,
} from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SESSION = "dashboard:regression";

export const check: RegressionCheck = {
  name: "owner-thread-key",
  guards: "서브에이전트가 남의 세션에 진행 중으로 뜨던 것(잡 좌표 미환원)",
  run: async (): Promise<Assertion[]> => {
    __resetJobsForTest();
    const mk = (threadKey: string, label: string): string =>
      registerJob({
        label,
        threadKey,
        channel: "dashboard",
        channelUserId: "regression",
        task: "regression",
      });
    const w = mk(SESSION, "worker");
    const a1 = mk(`worker:${w}`, "sub");
    const a2 = mk(`agent:${a1}`, "sub-of-sub");
    const orphan = mk("worker:does-not-exist", "orphan");
    const out = [
      assert("세션 키는 그대로", resolveOwnerThreadKey(SESSION) === SESSION, resolveOwnerThreadKey(SESSION)),
      assert("매니저 좌표 → 세션", resolveOwnerThreadKey(`worker:${w}`) === SESSION, resolveOwnerThreadKey(`worker:${w}`)),
      assert("서브 좌표 → 세션(2단)", resolveOwnerThreadKey(`agent:${a1}`) === SESSION, resolveOwnerThreadKey(`agent:${a1}`)),
      assert("서브의 서브 → 세션(3단)", resolveOwnerThreadKey(`agent:${a2}`) === SESSION, resolveOwnerThreadKey(`agent:${a2}`)),
      // ★미상은 ""여야 한다 — 여기서 활성 세션을 반환하면 그게 곧 남의 세션 노출 버그다.
      assert("부모 없는 고아 = 미상", resolveOwnerThreadKey(`worker:${orphan}`) === "", resolveOwnerThreadKey(`worker:${orphan}`)),
      assert("빈 값 = 미상", resolveOwnerThreadKey("") === "", resolveOwnerThreadKey("")),
    ];
    __resetJobsForTest();
    return out;
  },
};
