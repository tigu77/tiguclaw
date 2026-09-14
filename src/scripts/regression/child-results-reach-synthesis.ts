/**
 * 회귀: **자식 본문이 매니저의 «종합 시점» 까지 닿는다** (2026-09-14)
 *
 * 잡는 사고 — 회사 인스턴스 v0.53.0 `81e4c50`, 매니저 `9f2b486a`:
 * «티구클로 전체 재검토» 에서 자식 셋이 다 완주했는데 **매니저가 1/3 만 쥐고 종합했다.**
 *
 * ★DB·로그 실측이 원인을 **배달이 아니라 거리**로 확정했다
 * (`docs/decisions/2026-09-14-child-result-lifetime.md` §1.5):
 * ```
 * wait_for_worker 인자 3 → 3 → 2 → 1 → 3   ← 마지막에 셋을 **다시** 받았다(본문 12,995자)
 * 그 뒤 도구 13회 더 → keepRecent=3 초과 → [codex-turn-end] iter=53 ★압축=39건
 * 최종 답 6,474자는 **본문 없는 입력**에서 쓰였다
 * ```
 * 배달 축은 **세 번 성공**했고 C 는 도구 출력과 결과함 **양쪽**으로 왔는데도 보고에서 빠졌다.
 * 그래서 «어느 경로로 보내나» 를 고치는 처방으로는 재발한다 — 지켜야 할 성질은
 * **«매니저가 종합하기 전에 자식 본문을 (다시) 받는다»** 다.
 *
 * ★이 성질을 지키는 검사가 **0건**이어서 11일간 안 보였다(2026-09-03 위임 분리 이후).
 *
 * 등급: **동작 검사** — 러너(`runWorkerJob`)를 실제로 돌리고 완료 배관(`onWorkerComplete`)을
 * 실제로 통과시킨다. 모델 호출 0·네트워크 0·라이브 데몬 0. 어댑터 무관(러너 층 성질).
 */
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  claimJobJoin,
  getJob,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
  releaseJobJoin,
} from "../../core/worker-jobs.js";
import { compactOldToolOutputs } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { packJoinResponse } from "../../core/llm-runtime/capabilities/join-response.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { addendumHeader } from "../../core/worker-report.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/** settle 대기 — 상한이 있어 무한대기 0. */
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
};

/** 실제 사고의 본문 길이(4,876·4,755·3,364자) — 임계 2,000 을 넘는 쪽이라야 재현이다. */
const BODIES = [
  `[A]${"a".repeat(4873)}`,
  `[B]${"b".repeat(4752)}`,
  `[C]${"c".repeat(3361)}`,
];

/**
 * 자식 셋을 띄워 완주시키는 매니저 한 판을 **러너로 실제로 돌린다.**
 * `viaJoin` = 합류(`wait_for_worker`)가 선점한 채 자식이 끝난다(사고 그대로).
 * 반환값은 **첫 턴 이후** 매니저가 받은 입력들 — 즉 «종합 전에 본문이 왔나» 의 관측면.
 */
const MAIN_REPORT = `[본 보고서]${"보".repeat(6000)}`;
const ADDENDUM = "[후속 의견] 확인했습니다.";
const LATE_BODY = `[D]${"d".repeat(2500)}`;

/** 거두기 턴이 무엇을 내는가 — 시나리오 축. */
type HarvestBehavior = "addendum" | "empty" | "throw" | "rewrite";

const runManagerTurn = async (
  viaJoin: boolean,
  harvest: HarvestBehavior = "addendum",
  /** 첫 거두기 턴 안에서 자식 하나를 더 완주시킨다 — 거두기 라운드 둘을 만든다. */
  extraChildOnFirstHarvest = false,
): Promise<{
  laterInputs: string[];
  turns: number;
  finalResult: string;
  finalError: string;
  status: string;
}> => {
  __resetJobsForTest();
  registerWorkerHandler((async () => ({ text: "" })) as never);
  const managerId = registerJob({
    kind: "worker",
    label: "전체 검토",
    task: "자식 셋을 띄워 종합하라",
    threadKey: "dashboard:default",
    channel: "dashboard",
    channelUserId: "u",
  } as never);

  const inputs: string[] = [];
  runWorkerJob(getJob(managerId) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    inputs.push(String(input.text ?? ""));
    if (inputs.length === 1) {
      // 첫 턴 = 사고의 본 작업 턴: 자식 셋을 띄우고 전부 완주시킨다.
      for (const body of BODIES) {
        const childId = registerJob({
          kind: "agent",
          label: `자식 ${body.slice(0, 3)}`,
          task: "읽기전용 리뷰",
          threadKey: `worker:${managerId}`,
          channel: "dashboard",
          channelUserId: "u",
        } as never);
        // 합류가 **먼저** 선점한다(그래야 status=running 에서 걸린다 — 실제 순서와 같다).
        if (viaJoin) claimJobJoin(childId);
        await onWorkerComplete(childId, { result: body });
        if (viaJoin) releaseJobJoin(childId);
      }
      // ★그리고 도구를 계속 쓴 뒤(실측 13회) 본문 **없이** 종합한다 — 압축이 먹은 상태.
      //  실제 사고의 본 보고서는 6,474자였다.
      return { text: MAIN_REPORT } as RegionASdkOutput;
    }
    // 거두기 라운드를 하나 더 만든다 — 늦게 끝난 자식이 또 있는 경우.
    if (extraChildOnFirstHarvest && inputs.length === 2) {
      const late = registerJob({
        kind: "agent",
        label: "자식 [D]",
        task: "늦은 리뷰",
        threadKey: `worker:${managerId}`,
        channel: "dashboard",
        channelUserId: "u",
      } as never);
      await onWorkerComplete(late, { result: LATE_BODY });
    }
    // ★거두기 턴은 **짧은 후속 의견**만 낸다 — 실제 사고가 537자였고, 헌법이 시키는 바다
    //  (`HARVEST_SCOPE_GUIDANCE`: "고치지 말고 최종 보고에 후속 제안으로만 적으세요").
    if (harvest === "throw") throw new Error("거두기 턴이 터졌다");
    if (harvest === "empty") return { text: "   " } as RegionASdkOutput;
    if (harvest === "rewrite") {
      return { text: `${MAIN_REPORT}\n\n${ADDENDUM}` } as RegionASdkOutput;
    }
    return { text: `${ADDENDUM} (${inputs.length - 1}회째)` } as RegionASdkOutput;
  });
  await until(() => getJob(managerId)?.status !== "running");
  return {
    laterInputs: inputs.slice(1),
    turns: inputs.length,
    finalResult: getJob(managerId)?.result ?? "",
    finalError: getJob(managerId)?.error ?? "",
    status: getJob(managerId)?.status ?? "(없음)",
  };
};

export const check: RegressionCheck = {
  name: "child-results-reach-synthesis",
  guards:
    "합류(wait_for_worker)로만 전달된 자식 본문이 매니저의 종합 시점엔 없던 것 — 회사 인스턴스 실측(2026-09-14): 마지막 수집 뒤 도구 13회 → keepRecent=3 초과 → 압축 39건 → 최종 답이 3건 중 1건만 반영. 배달은 세 번 성공했으므로 «경로» 가 아니라 «종합 전 재공급» 을 지킨다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── 전제 + 요구⑤: 압축은 본문을 치우지만 **식별자는 남긴다** ────────────────
    //  이 전제(«한 번 줬다» 가 보장이 아니다)가 참이라서 종합 전 재공급이 필요하다.
    //  그리고 압축 뒤에도 «무엇을 어떻게 다시 읽나» 가 남아야 복구 경로가 성립한다.
    {
      const packed = packJoinResponse(
        BODIES.map((b, i) => ({
          jobId: `job-${i + 1}`,
          label: `자식 ${b.slice(0, 3)}`,
          status: "✅ 완료",
          body: b,
        })),
      );
      const arr: Array<{ type: string; call_id: string; output: string }> = [
        { type: "function_call_output", call_id: "wait", output: packed },
      ];
      for (let i = 0; i < 13; i++) {
        arr.push({ type: "function_call_output", call_id: `t${i}`, output: `읽음 ${i}` });
      }
      compactOldToolOutputs(arr as never);
      const left = arr[0]?.output ?? "";
      out.push(
        assert(
          "전제: 합류 본문은 이후 도구 출력 13회에 밀려 원문이 안 남는다(keepRecent=3)",
          !left.includes(BODIES[1] as string) && left.length < 1_000,
          `${packed.length}자 → ${left.length}자`,
        ),
        // ★**안내는 «이름» 이어야 한다** (2026-09-14 정정). 종전엔 첫 줄에 jobId 를 전부
        //  실었는데, 압축 안내문은 첫 줄을 **200자에서 다시 자른다** — 자식 6명이면 UUID 가
        //  넷만 남았다(외부 재현 실측). 복구 가능성이 안내문 길이에 걸려 있으면 안 된다.
        //  목록은 `read_worker_result()` 가 주므로 안내는 그 이름만 가리키면 된다.
        assert(
          "★압축 뒤에도 **복구 경로가 남는다** — 목록 도구를 가리키면 자식이 몇이든 안 잘린다",
          left.includes("read_worker_result"),
          `남은 ${left.length}자 · 도구 지목=${left.includes("read_worker_result")}`,
        ),
      );
    }

    // ── 대조군: 결과함 경로면 종합 전에 본문이 온다 (지금도 초록이어야 한다) ──────
    {
      const { laterInputs, turns, finalResult } = await runManagerTurn(false);
      const joined = laterInputs.join("\n");
      out.push(
        assert(
          "대조군(결과함 경로): 매니저가 종합 전에 자식 본문 3건을 받는다",
          BODIES.every((b) => joined.includes(b.slice(0, 3))),
          `턴 ${turns}회 · 이후 입력 ${laterInputs.length}건 · ` +
            BODIES.map((b) => `${b.slice(1, 2)}=${joined.includes(b.slice(0, 3)) ? "O" : "X"}`).join(" "),
        ),
        // ★**두 번째 결함** — 거두기 턴의 짧은 후속 의견이 본 보고서를 **대체**한다
        //  (2026-09-14 아스트라 재현, 코드 확인: `out = await rerunP` → `outcome = out.text`).
        //  회사 로그가 그대로다: text=6474 → text=537 → 전달된 건 537자.
        //  ★헌법은 «최종 보고에 후속 제안으로만 적으세요» 라고 **덧붙이기**를 지시하는데
        //   배관은 **치환**한다 — 프롬프트와 코드가 서로 다른 말을 하는 이음매다.
        assert(
          "★거두기 턴이 본 보고서를 대체하지 않는다 — 앞단을 다 고쳐도 여기서 잃으면 사용자에겐 안 간다",
          finalResult.includes("[본 보고서]"),
          `최종 결과 ${finalResult.length}자 · 본보고서=${finalResult.includes("[본 보고서]") ? "O" : "X"} · ` +
            `후속의견=${finalResult.includes("[후속 의견]") ? "O" : "X"}`,
        ),
      );
    }

    // ── ★본 성질: 합류로 전달돼도 종합 전에 본문이 와야 한다 ─────────────────────
    {
      const { laterInputs, turns } = await runManagerTurn(true);
      const joined = laterInputs.join("\n");
      const missing = BODIES.filter((b) => !joined.includes(b.slice(0, 3)));
      out.push(
        assert(
          "★합류로만 전달된 자식도 종합 전에 본문이 다시 온다 — 경로가 보고 내용을 바꾸면 안 된다",
          missing.length === 0,
          `턴 ${turns}회 · 이후 입력 ${laterInputs.length}건 · 빠진 본문 ${missing.length}건` +
            (missing.length === 0 ? "" : `(${missing.map((b) => b.slice(1, 2)).join(",")})`),
        ),
      );
    }

    // ── 요구 ①: 추가 의견도 누락되지 않는다 ─────────────────────────────────────
    {
      const { finalResult } = await runManagerTurn(true);
      out.push(
        assert(
          "본 보고서와 후속 의견이 **둘 다** 남는다 — 보존이 후속을 버리는 방식이면 안 된다",
          finalResult.includes("[본 보고서]") && finalResult.includes("[후속 의견]"),
          `${finalResult.length}자 · 본=${finalResult.includes("[본 보고서]") ? "O" : "X"} 후속=${finalResult.includes("[후속 의견]") ? "O" : "X"}`,
        ),
      );
    }

    // ── 요구 ②: 여러 거두기 턴 — 중복 증식 0 · 정정이 앞 판단과 구분된다 ────────
    {
      const { finalResult, turns } = await runManagerTurn(true, "addendum", true);
      const dup = finalResult.split("[본 보고서]").length - 1;
      out.push(
        assert(
          "거두기 여러 회에도 본 보고서가 **한 번만** 들어간다(중복 증식 0)",
          dup === 1,
          `본 보고서 ${dup}회 · 턴 ${turns}회 · ${finalResult.length}자`,
        ),
        assert(
          "후속 정정이 앞 판단과 **구분된다** — 머리표로 우선순위가 보인다",
          finalResult.includes(addendumHeader(1)) && finalResult.includes(addendumHeader(2)),
          `1회째=${finalResult.includes(addendumHeader(1)) ? "O" : "X"} 2회째=${finalResult.includes(addendumHeader(2)) ? "O" : "X"}`,
        ),
      );
    }

    // ── 요구 ②-b: 매니저가 전문을 다시 썼으면 **교체**다(중복 아님) ─────────────
    {
      const { finalResult } = await runManagerTurn(true, "rewrite");
      const dup = finalResult.split("[본 보고서]").length - 1;
      out.push(
        assert(
          "거두기 턴이 전문을 다시 쓰면 덧붙이지 않고 교체한다",
          dup === 1 && !finalResult.includes(addendumHeader(1)),
          `본 보고서 ${dup}회 · 머리표=${finalResult.includes(addendumHeader(1)) ? "있음" : "없음"}`,
        ),
      );
    }

    // ── 요구 ③: 거두기 빈 응답·실패에도 본 보고서를 안 잃는다 ───────────────────
    {
      const empty = await runManagerTurn(true, "empty");
      out.push(
        assert(
          "거두기 턴이 빈 응답이어도 본 보고서가 남는다(빈 것으로 덮지 않는다)",
          empty.finalResult.includes("[본 보고서]") && !empty.finalResult.includes(addendumHeader(1)),
          `${empty.finalResult.length}자 · status=${empty.status}`,
        ),
      );
      const failed = await runManagerTurn(true, "throw");
      out.push(
        assert(
          "★거두기 턴이 터져도 본 보고서가 전달된다 — 그리고 **실패는 실패로** 남는다",
          `${failed.finalResult}${failed.finalError}`.includes("[본 보고서]") &&
            failed.status !== "done",
          `status=${failed.status} · result ${failed.finalResult.length}자 · error ${failed.finalError.length}자`,
        ),
      );
    }

    return out;
  },
};
