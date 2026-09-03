/**
 * 회귀: **합류(join) 계약을 실제로 돌려서 지킨다** (2026-09-03 적대 검토 A).
 *
 * ★검토자가 변이 **8종**을 이 한 구멍으로 통과시켰다. 합류 배관(`claimJobJoin`·
 *  `isJobJoined`·`releaseJobJoin`·`awaitJobOutcome`)을 **실행하는 검사가 0건**이었고,
 *  그물이라곤 소스 정규식 세 줄(`/tool\(\s*"wait_for_worker"/` 류)뿐이었다.
 *  뚫린 것들: 시한 초과 시 선점 해제 삭제 · 완료 감지 무력화 · 전체 시한을 잡별 시한으로 ·
 *  첫 잡만 거두기 · 결과 본문 제거 · 선점 자체 삭제 · 상태 마킹 앞으로 선점 검사 이동.
 *
 * ★그리고 **실제 결함 둘**이 같은 자리에서 나왔다:
 *  - **P-A**: `wait_for_worker` 가 `SUBAGENT_TIMEOUT_MS` 를 기본 시한으로 썼는데 그 값의
 *    기본이 **`Infinity`** 다(자식을 죽이는 시계를 부모가 기다리는 시계로 쓴 것). 그래서
 *    시한 분기가 영원히 거짓이고, 도구 설명은 있지도 않은 시한을 약속했다.
 *  - **P-B**: 선점한 채 부모 턴이 죽으면 `onWorkerComplete` 가 배달을 건너뛰어 **결과가
 *    조용히 사라진다.** 유일한 자동 복구가 «시한 초과 시 해제» 였는데 P-A 때문에 절대
 *    안 돌았다. 둘이 겹쳐 영구 유실이 됐다.
 *
 * 등급: **동작**(레지스트리를 실제로 조작하고 합류 함수를 실행한다. 모델 호출 0).
 */
import {
  awaitJobOutcome,
  claimJobJoin,
  isJobJoined,
  releaseJobJoin,
  registerJob,
  markDone,
  markFailed,
  JOIN_WAIT_TIMEOUT_MS,
  resolveJoinTimeoutMs,
  SUBAGENT_TIMEOUT_MS,
} from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const mkJob = (label: string): string =>
  registerJob({
    task: `probe ${label}`,
    label,
    threadKey: "probe:join",
    channel: "cli",
    channelUserId: "probe",
    kind: "agent",
  });

export const check: RegressionCheck = {
  name: "join-contract-behaves",
  guards:
    "합류(wait_for_worker) 배관에 동작 검사가 0건이라 변이 8종이 통과하던 것 + 기본 시한이 Infinity 라 «시한 초과 시 선점 해제» 라는 유일한 자동 복구가 절대 안 돌아, 부모 턴이 죽으면 자식 결과가 조용히 사라지던 것 (2026-09-03 적대 검토 A: P-A·P-B·G-1)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 시한 — **유한이어야 한다.** 무한이면 자동 복구가 원리적으로 안 돈다.
    out.push(
      assert(
        "★★★합류 기본 시한이 **유한**하다 — 무한이면 «시한 초과 시 선점 해제» 가 영원히 안 돌아 결과가 영구 유실된다",
        Number.isFinite(JOIN_WAIT_TIMEOUT_MS) && JOIN_WAIT_TIMEOUT_MS > 0,
        `JOIN_WAIT_TIMEOUT_MS=${String(JOIN_WAIT_TIMEOUT_MS)}`,
      ),
      assert(
        "★그 시계를 **자식을 죽이는 시계와 섞지 않는다** — `SUBAGENT_TIMEOUT_MS` 는 기본이 무한이다(성질이 반대)",
        JOIN_WAIT_TIMEOUT_MS !== SUBAGENT_TIMEOUT_MS || Number.isFinite(SUBAGENT_TIMEOUT_MS),
        `subagent=${String(SUBAGENT_TIMEOUT_MS)} · join=${String(JOIN_WAIT_TIMEOUT_MS)}`,
      ),
    );

    // ② 선점 — 도는 잡만 선점되고, 끝난 잡은 선점되지 않는다(늦은 합류는 재주입이 옳다).
    const running = mkJob("도는 잡");
    const finished = mkJob("끝난 잡");
    markDone(finished, "결과 본문");
    const claimedRunning = claimJobJoin(running);
    const claimedFinished = claimJobJoin(finished);
    out.push(
      assert(
        "★도는 잡은 선점된다 — 선점이 안 되면 같은 결과가 합류·재주입으로 두 번 보고된다",
        claimedRunning && isJobJoined(running),
        `claim=${String(claimedRunning)} · joined=${String(isJobJoined(running))}`,
      ),
      assert(
        "★★이미 끝난 잡은 **선점되지 않는다** — 늦게 합류한 것이므로 재주입이 옳다(결과를 잃지 않는 쪽)",
        !claimedFinished && !isJobJoined(finished),
        `claim=${String(claimedFinished)} · joined=${String(isJobJoined(finished))}`,
      ),
    );

    // ③ ★★해제 — 이게 P-B 의 본체다.
    releaseJobJoin(running);
    out.push(
      assert(
        "★★★선점은 **풀 수 있다** — 못 풀면 부모 턴이 죽었을 때 자식 결과가 조용히 사라진다",
        !isJobJoined(running),
        `joined=${String(isJobJoined(running))} (false 여야)`,
      ),
    );

    // ④ 완료 감지 — 끝난 잡을 실제로 알아보고, 받으면서 선점을 푼다.
    const done = mkJob("완료 감지");
    claimJobJoin(done);
    markDone(done, "본문-A");
    const got = await awaitJobOutcome(done, 2_000);
    out.push(
      assert(
        "★★합류가 **끝난 잡을 알아본다** — 못 알아보면 상한까지 헛기다린다",
        got?.status === "done" && got.result === "본문-A",
        `status=${String(got?.status)} · result=${String(got?.result)}`,
      ),
      assert(
        "★받으면서 선점을 푼다 — 남기면 다음 완료가 배달을 건너뛴다(누수)",
        !isJobJoined(done),
        `joined=${String(isJobJoined(done))}`,
      ),
    );

    // ⑤ 시한 초과 — running 인 채로 **돌아오고**, 선점이 풀린다(자동 복구).
    const stuck = mkJob("안 끝나는 잡");
    claimJobJoin(stuck);
    const t0 = Date.now();
    const still = await awaitJobOutcome(stuck, 300, 50);
    const waited = Date.now() - t0;
    out.push(
      assert(
        "★★시한이 지나면 **돌아온다** — 안 돌아오면 그 세션 대화가 통째로 언다",
        still?.status === "running" && waited < 5_000,
        `status=${String(still?.status)} · ${waited}ms 대기`,
      ),
      assert(
        "★★★시한 초과 시 선점이 **풀린다** — 이게 유일한 자동 복구다(안 풀면 나중에 끝나도 배달이 생략된다)",
        !isJobJoined(stuck),
        `joined=${String(isJobJoined(stuck))} (false 여야)`,
      ),
    );

    // ⑥ 무한 시한을 넘겨도 유한으로 떨어진다 — P-A 의 구조적 방어.
    //   ★**순수 함수로 확인한다.** 실제로 기다리게 만들었더니 회귀가 10분을 붙잡고
    //    스위트를 멈춰 세웠다 — 검사가 껄끄러우면 코드가 잘못 놓인 것이다.
    out.push(
      assert(
        "★★무한 시한을 받아도 **유한으로 떨어진다** — 호출부 하나가 실수해도 대화가 얼지 않는다",
        Number.isFinite(resolveJoinTimeoutMs(Number.POSITIVE_INFINITY)) &&
          Number.isFinite(resolveJoinTimeoutMs(undefined)) &&
          resolveJoinTimeoutMs(1_234) === 1_234,
        `∞→${String(resolveJoinTimeoutMs(Number.POSITIVE_INFINITY))} · 미지정→${String(resolveJoinTimeoutMs(undefined))} · 1234→${String(resolveJoinTimeoutMs(1_234))}`,
      ),
    );

    // ⑦ 실패한 잡도 결과를 준다 — 부분 실패에서 성공분을 버리지 않는 전제.
    const failed = mkJob("실패 잡");
    markFailed(failed, "원인-X");
    const f = await awaitJobOutcome(failed, 1_000);
    out.push(
      assert(
        "★실패도 상태·원인을 돌려준다 — 통째로 throw 하면 형제들의 성공분이 버려진다",
        f?.status === "failed" && (f.error ?? "").includes("원인-X"),
        `status=${String(f?.status)} · error=${String(f?.error)}`,
      ),
    );

    return out;
  },
};
