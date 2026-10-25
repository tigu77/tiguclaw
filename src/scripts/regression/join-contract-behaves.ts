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
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    "합류(wait_for_worker) 배관에 동작 검사가 0건이라 변이 8종이 통과하던 것 + 기본 시한이 Infinity 라 «시한 초과 시 선점 해제» 라는 유일한 자동 복구가 절대 안 돌아, 부모 턴이 죽으면 자식 결과가 조용히 사라지던 것 (2026-09-03 적대 검토 A: P-A·P-B·G-1) + 소환자가 아닌 대기·관찰자의 해제·취소된 대기가 소환자 완료 보고를 막거나 지우던 것(2026-10-23 외부 GPT 검토 P1~P3)",
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

    // ② 선점 — **직속 소환자**가 도는 잡에만 권리를 건다. 끝난 잡은 선점되지 않는다(늦은 합류는 재주입이 옳다).
    //  ★2026-10-23: 권리는 대기자 좌표가 `job.threadKey` 와 같을 때만(형제 매니저의 관찰이 소환자 보고를 막던 것, 외부 GPT 검토 P1).
    const running = mkJob("도는 잡");
    const finished = mkJob("끝난 잡");
    markDone(finished, "결과 본문");
    const claimedRunning = claimJobJoin(running, "probe:join");
    const claimedFinished = claimJobJoin(finished, "probe:join");
    const claimedStranger = claimJobJoin(running, "worker:남");
    out.push(
      assert(
        "★도는 잡은 소환자의 대기로 선점된다 — 선점이 안 되면 같은 결과가 합류·재주입으로 두 번 보고된다",
        claimedRunning !== undefined && isJobJoined(running),
        `claim=${String(claimedRunning !== undefined)} · joined=${String(isJobJoined(running))}`,
      ),
      assert(
        "★★이미 끝난 잡은 **선점되지 않는다** — 늦게 합류한 것이므로 재주입이 옳다(결과를 잃지 않는 쪽) · 소환자가 아닌 대기도 권리 없음",
        claimedFinished === undefined && !isJobJoined(finished) && claimedStranger === undefined,
        `finished=${String(claimedFinished)} · joined=${String(isJobJoined(finished))} · stranger=${String(claimedStranger)}`,
      ),
    );

    // ③ ★★해제 — 이게 P-B 의 본체다(이제 **그 호출의 토큰만**).
    releaseJobJoin(claimedRunning, { handedOff: false });
    out.push(
      assert(
        "★★★선점은 **풀 수 있다** — 못 풀면 부모 턴이 죽었을 때 자식 결과가 조용히 사라진다",
        !isJobJoined(running),
        `joined=${String(isJobJoined(running))} (false 여야)`,
      ),
    );

    // ④ 완료 감지 — 끝난 잡을 실제로 알아본다. ★대기 함수는 권리를 **건드리지 않는다**(관찰자의 대기가 소환자 권리를 풀던 것, P2).
    const done = mkJob("완료 감지");
    const doneClaim = claimJobJoin(done, "probe:join");
    markDone(done, "본문-A");
    const got = await awaitJobOutcome(done, 2_000);
    const joinedAfterAwait = isJobJoined(done);
    releaseJobJoin(doneClaim, { handedOff: true });
    out.push(
      assert(
        "★★합류가 **끝난 잡을 알아본다** — 못 알아보면 상한까지 헛기다린다",
        got?.status === "done" && got.result === "본문-A",
        `status=${String(got?.status)} · result=${String(got?.result)}`,
      ),
      assert(
        "★대기 함수는 권리를 안 푼다(푸는 건 권리를 얻은 호출) · 그 호출의 해제 뒤엔 남지 않는다(누수 0)",
        joinedAfterAwait && !isJobJoined(done),
        `대기 뒤=${String(joinedAfterAwait)} · 해제 뒤=${String(isJobJoined(done))}`,
      ),
    );

    // ⑤ 시한 초과 — running 인 채로 **돌아온다**. 권리는 그 호출의 해제가 푼다(핸들러 finally — 자식 검사가 실제 핸들러로 잰다).
    const stuck = mkJob("안 끝나는 잡");
    const stuckClaim = claimJobJoin(stuck, "probe:join");
    const t0 = Date.now();
    const still = await awaitJobOutcome(stuck, 300, 50);
    const waited = Date.now() - t0;
    releaseJobJoin(stuckClaim, { handedOff: false });
    out.push(
      assert(
        "★★시한이 지나면 **돌아온다** — 안 돌아오면 그 세션 대화가 통째로 언다",
        still?.status === "running" && waited < 5_000,
        `status=${String(still?.status)} · ${waited}ms 대기`,
      ),
      assert(
        "★★★시한 뒤 그 호출의 해제로 선점이 **풀린다** — 안 풀면 나중에 끝나도 배달이 생략된다",
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

    // ⑧ ★★경합 — 실제 `wait_for_worker` 핸들러·브리지·완료 출구로(자식 프로세스, 설계 §5 1~14).
    out.push(...(await raceChecks()));

    return out;
  },
};

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_join-owner-claim-child.ts");
type R = Record<string, any>;
const raceChecks = async (): Promise<Assertion[]> => {
  assertIsolated();
  const r = await spawnWithin(90_000, "join-owner-claim", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (r.timedOut || line === undefined) return [assert("경합 자식이 결과를 낸다", false, r.timedOut ? "timeout" : r.err.slice(-400))];
  const d = JSON.parse(line) as R;
  const clean = (x: R | undefined): boolean => x?.state?.claims === 0 && x?.state?.parked === 0;
  const show = (k: string): string => JSON.stringify(d[k]).slice(0, 400);
  return [
    assert("0 각 시나리오가 «권리가 걸렸다» 를 조건으로 확인한 뒤 진행했다(고정 대기 가정 아님 · 유한 시한)", Array.isArray(d.notReady) && d.notReady.length === 0, `시한 안에 권리를 못 건 시나리오=${JSON.stringify(d.notReady)}`),
    assert("1★직속 소환자 정상 대기 — 결과를 받고 재주입 0 · 권리·보류 0", d.owner?.got === true && d.owner?.reinject === 0 && clean(d.owner), show("owner")),
    assert("2★★소환자가 아닌 대기(형제 매니저) — 결과는 받고 권리는 없다 · 소환자 보고 1(실사례: 메인 완료 보고 누락)", d.observer?.got === true && d.observer?.claimedByObserver === false && d.observer?.reinject === 1 && clean(d.observer), show("observer")),
    assert("3★★관찰자의 시한·finally 가 소환자 권리를 안 푼다 · 둘이 같이 기다리다 끝나면 둘 다 받고 재주입 0", d.ownerAndObserver?.stillOwner === true && d.ownerAndObserver?.ownerGot === true && d.ownerAndObserver?.observerGot === true && d.ownerAndObserver?.reinject === 0 && clean(d.ownerAndObserver), show("ownerAndObserver")),
    assert("4★소환자 중첩 대기 — 먼저 끝난 호출의 해제가 나머지 권리를 안 지운다 · 재주입 0", d.nested?.stillJoined === true && d.nested?.got === true && d.nested?.reinject === 0 && clean(d.nested), show("nested")),
    ...(["turn", "extra", "pre", "bothExtra"] as const).map((m) => {
      const c = d[`cancel_${m}`] as R | undefined;
      const what = { turn: "턴 신호만", extra: "도구 호출 신호만", pre: "진입 전 취소", bothExtra: "턴 신호가 살아 있는데 도구 호출 쪽만 취소" }[m];
      return assert(
        `5★★취소된 소환자 대기(${what}) — 권리 즉시 무효 · 폴 간격 안에 반환(오류) · 뒤 완료는 소환자 보고 1`,
        c?.before === (m !== "pre") && c?.afterAbort === false && c?.isError === true && Number(c?.returnedMs) < 1_000 && c?.reinject === 1 && clean(c),
        show(`cancel_${m}`),
      );
    }),
    assert("6★같은 tick abort → 완료(finally 전) — 취소된 권리는 권리가 아니다: 소환자 보고 정확히 1", d.sameTick?.reinject === 1 && clean(d.sameTick), show("sameTick")),
    assert("7★★[A,B] 중 A 완료(보류) 뒤 B 대기 중 취소 — A 는 버려지지 않고 소환자 보고 1 · B 는 나중 완료에 1", d.partialCancel?.parkedMid === 1 && d.partialCancel?.reinjectMid === 0 && d.partialCancel?.isError === true && d.partialCancel?.a === 1 && d.partialCancel?.b === 1 && clean(d.partialCancel), show("partialCancel")),
    assert("8★★권리가 있는 채 «진행 중» 으로 기록된 작업이 끝나면 보류 → 넘겨받지 못했으니 해제에 배달 1 · 핸들러 시한 뒤 완료도 1 · 핸들러가 «진행 중» 을 기록한 뒤 finally 전에 끝나도 1", d.timedOut?.stillRunning === true && d.timedOut?.parked === 1 && d.timedOut?.reinject === 1 && d.timedOut?.handlerSaysRunning === true && d.timedOut?.handlerReinject === 1 &&
      d.timedOut?.gapReads === true && d.timedOut?.gapSaysRunning === true && d.timedOut?.gapReinject === 1 && clean(d.timedOut), show("timedOut")),
    assert("9 이미 끝난 작업 관찰은 결과를 받고 권리 없음 · 대기자 좌표 없음(undefined·\"\")도 권리 없음 · 다른 작업 권리 그대로", d.edges?.got === true && d.edges?.finishedClaim === true && d.edges?.noWaiter === true && d.edges?.yStill === true, show("edges")),
    assert("10★★신호 없는 브리지 callTool(codex·openai 경로)로 불러도 턴 신호가 핸들러에 닿는다 — 권리 무효 · 곧 반환 · 소환자 보고 1", d.bridge?.before === true && d.bridge?.afterAbort === false && Number(d.bridge?.returnedMs) < 1_500 && d.bridge?.reinject === 1 && clean(d.bridge), show("bridge")),
    assert("11★늦은 지시 — 넘겨받음: 별도 통지 1 · 못 넘겨받음: 메인 재주입이면 완료 턴에 실림(별도 0) / 실패면 raw 1 + 별도 1 / 결과 수신함이면 수신함 1 + 별도 1",
      d.late?.handed?.lateNotices === 1 && d.late?.handed?.reinject === 0 && d.late?.reinjectPath?.carriedInTurn === true && d.late?.reinjectPath?.separate === 0 &&
        d.late?.failedPath?.raw === 1 && d.late?.failedPath?.separate === 1 && d.late?.inboxPath?.inboxMid === 0 && d.late?.inboxPath?.inbox === 1 && d.late?.inboxPath?.separate === 1 && clean(d.late),
      show("late")),
    assert("12★★같은 소환자 T1·T2 중 T1 만 취소 → finally 전 완료는 보류 · T1 해제가 T2 를 안 지움 · T2 인계 → 재주입 0", d.oneCancelled?.parkedAfterComplete === 1 && d.oneCancelled?.stillJoined === true && d.oneCancelled?.t2Got === true && d.oneCancelled?.reinject === 0 && clean(d.oneCancelled), show("oneCancelled")),
    assert("13★★보류 닫기는 정확히 한 번 — 둘 다 취소·배달 지연·두 finally 겹침에도 재주입 1 · 늦은 지시는 완료 턴에 1(별도 0)", d.exactlyOnce?.reinject === 1 && d.exactlyOnce?.lateCarried === 1 && d.exactlyOnce?.lateSeparate === 0 && clean(d.exactlyOnce), show("exactlyOnce")),
    assert("14 보류 중 잡이 맵에서 빠져도(보관 상한 정리) 보류분이 든 레코드로 배달 1", d.pruned?.reinject === 1 && clean(d.pruned), show("pruned")),
    assert("15★핸들러 예외 — A 를 거둔 뒤 B 에서 예외가 나도 오류 응답 · A 는 넘겨받지 못했으니 보고 1 · B 는 나중 완료에 1 · 잔류 0", d.handlerThrows?.fired === true && d.handlerThrows?.isError === true && d.handlerThrows?.threw === true && d.handlerThrows?.a === 1 && d.handlerThrows?.b === 1 && clean(d.handlerThrows), show("handlerThrows")),
    assert("16★먼저 넘겨받은 호출 뒤 같은 소환자의 다른 호출이 취소돼도 «넘겨받음» 은 되돌아가지 않는다 — A 보고 0 · B 는 나중 완료에 1", d.handedThenCancelled?.t1Got === true && d.handedThenCancelled?.parkedAfterT1 === 1 && d.handedThenCancelled?.t2Error === true && d.handedThenCancelled?.a === 0 && d.handedThenCancelled?.b === 1 && clean(d.handedThenCancelled), show("handedThenCancelled")),
  ];
};
