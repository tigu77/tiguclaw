/**
 * 회귀: **묶음 합류는 어떤 자식도 조용히 버리지 않는다** (2026-09-14)
 *
 * 잡는 사고 — 외부 재현(회사 인스턴스, 같은 커밋)이 실측한 것:
 * ```
 * 6,000자 자식 셋을 wait_for_worker 로 한 번에 거둠
 *   도구 응답 원문      18,169자 · 표식 9/9
 *   어댑터 진입 후      10,193자 · 표식 5/9   ← ★둘째 자식이 **통째로** 사라졌다
 * ```
 * 잘린 자리는 `wait_for_worker` 가 아니라 그 뒤의 진입 cap(codex C2 = 16,000, 머리 8,000 +
 * 꼬리 4,000)이고, **묶음 전체**에 걸리므로 가운데 자식이 없어진다. 아무 표시도 안 남는다.
 * 그래서 «마지막에 전부 한 번에 다시 읽으면 안전하다» 는 처방이 성립하지 않았다.
 *
 * 지키는 성질 셋:
 *  ① 응답이 어댑터 cap 에 **닿지 않는다** — 자를 것이 없으면 조용히 사라질 것도 없다.
 *  ② 자식마다 **jobId·상태·생략 표시**가 남는다(뒤가 잘려도 머리의 명세는 남는다).
 *  ③ 하나만 다시 부르면 **전문에 닿는다** — 그리고 그 재조회가 자식을 **다시 돌리지 않는다**.
 *
 * 등급: **동작 검사** — 제품의 `wait_for_worker` 핸들러를 실제로 부른다. 모델 호출 0.
 */
import { createSpawnAgentMcpServer } from "../../core/llm-runtime/capabilities/agent-registry.js";
import {
  capToolOutputForEntry,
  compactOldToolOutputs,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import {
  __resetJobsForTest,
  getJob,
  getJobResultChannel,
  listJobs,
  markDone,
  registerJob,
  setJobResultChannel,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

interface ToolReg {
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

/** 처음·중간·끝에 표식을 박은 6,000자 본문 — 어디가 사라졌는지 보이게 한다. */
const body = (n: number): string => {
  const pad = "x".repeat(1900);
  return `CHILD_${n}_BEGIN|${pad}|CHILD_${n}_MIDDLE|${pad}|${"y".repeat(2000)}|CHILD_${n}_END`;
};

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

export const check: RegressionCheck = {
  name: "join-keeps-every-child",
  guards:
    "여러 자식을 한 번에 합류하면 어댑터 진입 cap 이 묶음 전체에 걸려 가운데 자식이 표시도 없이 사라지던 것 — 외부 재현 실측(2026-09-14): 18,169자 → 10,193자, 표식 9개 중 5개, 둘째 자식 전멸",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    __resetJobsForTest();

    const parent = registerJob({
      kind: "worker",
      label: "매니저",
      task: "셋을 거둔다",
      threadKey: "dashboard:default",
      channel: "dashboard",
      channelUserId: "u",
    } as never);
    setJobResultChannel(parent, createSteeringChannel());
    const bodies = [1, 2, 3].map(body);
    const ids = bodies.map((b, i) => {
      const id = registerJob({
        kind: "agent",
        label: `자식 ${i + 1}`,
        task: "리뷰",
        threadKey: `worker:${parent}`,
        channel: "dashboard",
        channelUserId: "u",
      } as never);
      markDone(id, b);
      return id;
    });

    const srv = createSpawnAgentMcpServer({
      text: "거둬라",
      threadKey: `worker:${parent}`,
      channel: "dashboard",
      workerDepth: 1,
    } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
    const wait = srv.instance._registeredTools["wait_for_worker"];
    if (wait === undefined) throw new Error("wait_for_worker 핸들러를 못 찾음");

    const raw = textOf(await wait.handler({ job_ids: ids, timeout_seconds: 1 }, {}));
    const capped = capToolOutputForEntry(raw);

    out.push(
      // ① 어댑터가 자를 게 없다 — 이 단언이 «묶으면 사라진다» 를 원천에서 막는다.
      assert(
        "★묶음 합류 응답이 어댑터 진입 cap 에 닿지 않는다 — 자를 것이 없으면 조용히 사라질 것도 없다",
        capped === raw,
        `응답 ${raw.length.toLocaleString()}자 · 진입 후 ${capped.length.toLocaleString()}자`,
      ),
      // ② 자식 셋이 **전부** 보인다(명세).
      assert(
        "자식 셋의 jobId 가 모두 남는다 — 하나라도 없으면 모델이 그 자식을 다시 읽을 수 없다",
        ids.every((id) => capped.includes(id)),
        `${ids.filter((id) => capped.includes(id)).length}/3`,
      ),
      assert(
        "각 자식의 시작 표식이 모두 보인다 — 한 자식이 통째로 빠지지 않는다",
        [1, 2, 3].every((n) => capped.includes(`CHILD_${n}_BEGIN`)),
        [1, 2, 3].map((n) => `${n}=${capped.includes(`CHILD_${n}_BEGIN`) ? "O" : "X"}`).join(" "),
      ),
      assert(
        "예산을 넘겨 줄인 자식은 **생략을 밝힌다** — 조용한 절단 0",
        (capped.match(/자 생략 —/g) ?? []).length === 3,
        `생략 표시 ${(capped.match(/자 생략 —/g) ?? []).length}건`,
      ),
    );

    // ③ 복구 — 하나만 다시 부르면 전문에 닿고, 자식이 **다시 돌지 않는다**.
    const before = listJobs().length;
    const one = textOf(await wait.handler({ job_ids: [ids[1]], timeout_seconds: 1 }, {}));
    const again = textOf(await wait.handler({ job_ids: [ids[1]], timeout_seconds: 1 }, {}));
    out.push(
      assert(
        "★하나만 다시 부르면 그 자식의 처음·중간·끝이 모두 온다(복구 경로가 실제로 산다)",
        ["BEGIN", "MIDDLE", "END"].every((p) => one.includes(`CHILD_2_${p}`)),
        ["BEGIN", "MIDDLE", "END"].map((p) => `${p}=${one.includes(`CHILD_2_${p}`) ? "O" : "X"}`).join(" "),
      ),
      assert(
        "재조회는 **읽기**다 — 자식이 새로 돌지 않고 상태도 그대로다",
        listJobs().length === before && getJob(ids[1] as string)?.status === "done" && again === one,
        `잡 ${before}→${listJobs().length} · status=${getJob(ids[1] as string)?.status} · 두 번째 호출 동일=${again === one}`,
      ),
      assert(
        "재조회가 부모 결과함을 건드리지 않는다 — 거두기 몫을 먹으면 안 된다",
        getJobResultChannel(parent)?.drain().length === 0,
        `결과함 ${getJobResultChannel(parent)?.drain().length ?? -1}건`,
      ),
    );
    // ── ④ ★**큰 결과의 구간 조회** — 「다시 부르면 더 받는다」가 참이 되게 한다 ────────
    //  외부 재현 실측: 18,000자 자식은 **혼자 불러도** 예산(12,000)에 걸려 가운데가 계속
    //  생략됐다. 안내가 가리키는 곳에 실제로 닿아야 한다.
    const read = srv.instance._registeredTools["read_worker_result"];
    if (read === undefined) throw new Error("read_worker_result 핸들러를 못 찾음");
    {
      const big = `BIG_BEGIN|${"가".repeat(6000)}|BIG_MIDDLE|${"나".repeat(6000)}|😀🎉|${"다".repeat(5900)}|BIG_END`;
      const bigId = registerJob({
        kind: "agent", label: "큰 결과", task: "리뷰",
        threadKey: `worker:${parent}`, channel: "dashboard", channelUserId: "u",
      } as never);
      markDone(bigId, big);

      // 페이지를 끝까지 이어붙인다 — 합친 것이 원문과 **정확히** 같아야 한다.
      const pages: string[] = [];
      let offset = 0;
      let guard = 0;
      let lastHead = "";
      for (;;) {
        guard += 1;
        if (guard > 20) break; // 무한 루프 방지(자체 시한).
        const r = textOf(await read.handler({ job_id: bigId, offset }, {}));
        const SEP = "\n──\n";
        const at = r.indexOf(SEP);
        lastHead = r.slice(0, at >= 0 ? at : 120);
        const body = at >= 0 ? r.slice(at + SEP.length) : "";
        pages.push(body);
        const m = /read_worker_result\("[^"]+", (\d+)\)/.exec(lastHead);
        if (m === null) break; // 마지막 구간.
        offset = Number(m[1]);
      }
      const joined = pages.join("");
      out.push(
        assert(
          "★★구간을 이어붙이면 **원문과 정확히 같다** — 누락·중복·문자 손상 0",
          joined === big,
          `${pages.length}쪽 · ${joined.length.toLocaleString()}자 / 원문 ${big.length.toLocaleString()}자 · 일치=${joined === big}`,
        ),
        assert(
          "★**쪽 하나하나가** 온전하다 — 이어붙이면 같아지므로 합친 것만 보면 쪼갠 것을 못 본다",
          pages.every((p) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p) && !/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)),
          `${pages.length}쪽 중 깨진 쪽 ${pages.filter((p) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p)).length}건`,
        ),
        assert(
          "★가운데 표식에 **실제로 닿는다** — 이게 안 되면 안내가 거짓말이다",
          joined.includes("BIG_MIDDLE") && joined.includes("BIG_END"),
          `MIDDLE=${joined.includes("BIG_MIDDLE")} · END=${joined.includes("BIG_END")}`,
        ),
      );

      // ★경계를 **이모지 한가운데로 정조준**한다 — 자연 경계는 BMP 한복판이라 가드가 안 돈다.
      {
        const at = big.indexOf("😀");
        const r = await read.handler({ job_id: bigId, offset: at - 3, limit: 4 }, {});
        const t = textOf(r as { content: Array<{ type: string; text?: string }> });
        const page = t.slice(t.indexOf("\n──\n") + "\n──\n".length);
        out.push(
          assert(
            "★★쌍 한가운데서 끊길 자리면 **한 칸 물러선다** — 다음 offset 이 이모지 시작이다",
            !/[\uD800-\uDBFF]$/.test(page) && t.includes(`, ${at})`),
            `쪽 끝 온전=${!/[\uD800-\uDBFF]$/.test(page)} · 다음 offset=${/read_worker_result\("[^"]+", (\d+)\)/.exec(t)?.[1] ?? "없음"}(기대 ${at})`,
          ),
        );
      }

      // ★반복 조회는 아무것도 바꾸지 않는다 — 새 자식·결과함 소비·중복 전달 0.
      {
        const before = listJobs().length;
        const a = textOf(await read.handler({ job_id: bigId, offset: 0 }, {}));
        const b = textOf(await read.handler({ job_id: bigId, offset: 0 }, {}));
        out.push(
          assert(
            "★반복 조회가 새 작업을 만들지 않고 결과함도 안 먹는다(읽기 전용)",
            a === b && listJobs().length === before && getJobResultChannel(parent)?.drain().length === 0,
            `동일=${a === b} · 잡 ${before}→${listJobs().length} · 결과함 ${getJobResultChannel(parent)?.drain().length ?? -1}건`,
          ),
        );
      }

      // 한 쪽이 어댑터 진입 한도를 넘지 않는다 — 메타데이터까지 포함한 **실제 응답**으로 잰다.
      const first = textOf(await read.handler({ job_id: bigId, offset: 0 }, {}));
      out.push(
        assert(
          "★한 쪽 응답이 어댑터 진입 cap 에 닿지 않는다(메타데이터 포함) — 넘으면 또 조용히 잘린다",
          capToolOutputForEntry(first) === first,
          `한 쪽 ${first.length.toLocaleString()}자`,
        ),
      );

      // 못 읽는 경우를 **구분**한다 — 빈 문자열로 성공을 흉내 내지 않는다.
      const runningId = registerJob({
        kind: "agent", label: "도는 중", task: "리뷰",
        threadKey: `worker:${parent}`, channel: "dashboard", channelUserId: "u",
      } as never);
      const isErr = (r: { isError?: boolean }) => r.isError === true;
      const missing = await read.handler({ job_id: "없는-id" }, {}) as { isError?: boolean };
      const running = await read.handler({ job_id: runningId }, {}) as { isError?: boolean };
      const over = await read.handler({ job_id: bigId, offset: 999_999 }, {}) as { isError?: boolean };
      out.push(
        assert(
          "★못 읽는 이유를 **구분해서** 말한다(없음·진행 중·범위 초과) — 빈 성공으로 삼키지 않는다",
          isErr(missing) && isErr(running) && isErr(over),
          `없음=${isErr(missing)} 진행중=${isErr(running)} 범위초과=${isErr(over)}`,
        ),
      );
    }

    // ── ⑤ ★**압축 뒤 종단 복구** — 안내 → 목록 → 선택 → 구간 조회가 실제로 이어진다 ──
    //  자식 6명이면 옛 첫 줄(UUID 나열)은 200자에서 **넷만 남고 둘이 잘렸다**.
    {
      const many = [0, 1, 2, 3, 4, 5].map((i) => {
        const id = registerJob({
          kind: "agent", label: `여섯 ${i}`, task: "리뷰",
          threadKey: `worker:${parent}`, channel: "dashboard", channelUserId: "u",
        } as never);
        markDone(id, body(i + 10));
        return id;
      });
      const raw6 = textOf(await wait.handler({ job_ids: many, timeout_seconds: 1 }, {}));
      const arr: Array<{ type: string; call_id: string; output: string }> = [
        { type: "function_call_output", call_id: "wait6", output: capToolOutputForEntry(raw6) },
      ];
      for (let i = 0; i < 4; i++) {
        arr.push({ type: "function_call_output", call_id: `t${i}`, output: `읽음 ${i}` });
      }
      compactOldToolOutputs(arr as never);
      const left = arr[0]?.output ?? "";
      out.push(
        assert(
          "★압축 안내가 **도구 이름**을 가리킨다 — UUID 나열은 200자에서 잘려 복구가 끊긴다",
          left.includes("read_worker_result") && left.length < 400,
          `남은 안내 ${left.length}자`,
        ),
      );
      // 안내만 들고 목록 → 선택 → 구간 조회로 이어진다.
      const listed = textOf(await read.handler({}, {}));
      const found = many.filter((id) => listed.includes(id));
      out.push(
        assert(
          "★★안내만으로 **여섯 전부**를 되찾는다 — 잘려 사라진 정보가 필요하면 안 된다",
          found.length === many.length,
          `${found.length}/${many.length}건`,
        ),
      );
      const one6 = textOf(await read.handler({ job_id: many[4] }, {}));
      out.push(
        assert(
          "★되찾은 id 로 원문 **가운데**까지 읽는다 — 종단 복구가 실제로 닫힌다",
          one6.includes("CHILD_14_MIDDLE") && one6.includes("CHILD_14_END"),
          `MIDDLE=${one6.includes("CHILD_14_MIDDLE")} · END=${one6.includes("CHILD_14_END")}`,
        ),
      );
    }

    return out;
  },
};
