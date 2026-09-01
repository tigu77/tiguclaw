/**
 * 회귀: **거두기 턴은 «원래 맡은 일» 과 판단 규칙을 다시 싣는다 — 권한은 그대로 둔 채**
 * (2026-09-01, 적대 검토로 크게 보강).
 *
 * ★라이브 사고(`worker:4bb5d813`). 매니저가 14:27:51 에 *"최종 판정: 마감 완료"* 를 쓴 뒤,
 *  **거두기 턴 하나 안에서 새 서브에이전트 일곱을 순차로 띄우며 86분을 더 돌았다.** 늦게 온
 *  감사 의견을 **원래 요청의 완료조건이 아니라 «해야 할 새 일» 로** 읽은 것이다.
 *
 * ★**고칠 자리는 권한이 아니라 맥락이다**(사용자 확정). 한때 이 턴의 도구를 0으로 막았다가
 *  되돌렸다 — 그러면 진짜 차단 결함(필수 회귀 실패 등)도 못 고쳐 «작업 전체를 매니저가
 *  소유한다» 가 깨진다. 시스템은 판단을 대신하지 않고 **판단 기준을 눈앞에 둔다.**
 *
 * ★**첫 판은 절반만 지켰다** (적대 검토 G-1). «`job.task` 가 들어 있나» 하나만 봐서,
 *  판단 규칙 문단을 **통째로 지워도**·*"새 사용자 지시입니다 — 그대로 따르세요"* 로 **의미를
 *  반대로 뒤집어도**·원 과제를 **200자로 잘라도**·**2회째 라운드부터 안 실어도**·자식 결과를
 *  **첫 건만 실어도** 전부 초록이었다(실측 5종). 사고를 실제로 막는 문장이 무방비였다.
 *  그래서 판단 규칙을 `HARVEST_SCOPE_GUIDANCE` 상수로 빼고, 아래를 **전부** 잰다.
 *
 * 등급: **동작** — 레지스트리를 실제로 돌려 거두기 입력을 받아낸다. 모델 호출 0.
 */
import { runWorkerJob, HARVEST_SCOPE_GUIDANCE } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  getJob,
  registerJob,
  registerWorkerHandler,
  getJobResultChannel,
  markDone,
} from "../../core/worker-jobs.js";
import { reaches, turnKindOf } from "../../core/llm-runtime/capability-reach.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * 원 과제 — **200자보다 길다**. 짧게 두면 `job.task.slice(0, 200)` 같은 절단 변이가
 * 안 잡힌다(적대 검토 A2 가 그렇게 통과했다). 앞뒤 표식으로 «통째로» 실렸는지 본다.
 */
const TASK =
  "VOXEL-Q6-5B-앞표식 " + "완료조건을 길게 적는다. ".repeat(40) + "VOXEL-Q6-5B-뒤표식";

/**
 * 두 턴 입력이 어긋난 필드 — `text`(당연히 다르다)와 `steering`(라운드마다 **교체**가 의도)만
 * 뺀다. 나머지는 첫 턴과 같아야 한다. ★필드를 열거하지 않는 것이 요점이다: 새 필드가 생겨도
 * 저절로 덮이고, 손 목록처럼 낡지 않는다([[feedback_hand_maintained_lists]]).
 */
const diffFields = (a: RegionASdkInput, b: RegionASdkInput): string[] => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("text");
  keys.delete("steering");
  return [...keys].filter(
    (k) => (a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k],
  );
};

export const check: RegressionCheck = {
  name: "harvest-turn-keeps-scope",
  guards:
    "매니저가 자식 결과를 거두는 턴에서 늦게 온 감사 의견을 «원래 요청의 완료조건» 이 아니라 «새 지시» 로 읽어, 마감 보고 뒤 86분간 새 자식 7개를 띄우며 범위를 다시 열던 것(라이브 worker:4bb5d813) — 그리고 그걸 막는 문단을 지우거나 뒤집어도 스위트가 초록이던 것(적대 검토 실측 5종)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    registerWorkerHandler((async () => ({ text: "" })) as never);

    // ★`cwd`·`modelTier` 를 **실제로 준다** (2026-09-01 2라운드 G-3). 안 주면 두 값이
    //  양쪽 다 `undefined` 라, 거두기에서 그 필드를 빼는 변이를 검사가 **원리적으로 못 본다**
    //  (실측: cwd 제거·체인 제거 변이가 둘 다 초록이었다).
    const base = { channel: "cli" as const, channelUserId: "u", task: TASK };
    const jid = registerJob({
      ...base, kind: "worker", label: "범위보존", threadKey: "cli:s1",
      cwd: "/tmp/regr-harvest-cwd", modelTier: "high",
    });
    const c1 = registerJob({ ...base, kind: "agent", label: "감사자1", threadKey: `worker:${jid}`, detached: true });
    const c2 = registerJob({ ...base, kind: "agent", label: "감사자2", threadKey: `worker:${jid}`, detached: true });

    let turns = 0;
    /** 첫(구현) 턴 입력 — 여기까지 조이면 매니저가 아무 일도 못 한다. */
    let implTurn: RegionASdkInput | undefined;
    let implOpts: { chain?: unknown } | undefined;
    const inputs: RegionASdkInput[] = [];
    const optsSeen: Array<{ chain?: unknown } | undefined> = [];
    runWorkerJob(getJob(jid) as never, async (input, opts): Promise<RegionASdkOutput> => {
      turns += 1;
      if (turns === 1) {
        implTurn = input;
        implOpts = opts;
        // ★두 자식 결과를 **동시에** 넣는다 — 하나만 실으면 나머지는 drain 돼 영구 유실이다
        //  (적대 검토 A4: `arrived.slice(0,1)` 변이가 통과했다).
        setTimeout(() => {
          markDone(c1, "감사1");
          getJobResultChannel(jid)?.push({ text: "감사1", raw: "[감사자1] 결과-첫째", ts: 2, source: "job" });
          getJobResultChannel(jid)?.push({ text: "감사2", raw: "[감사자2] 결과-둘째", ts: 3, source: "job" });
        }, 20);
        return { text: "마감 완료" } as RegionASdkOutput;
      }
      inputs.push(input);
      optsSeen.push(opts);
      if (turns === 2) {
        // ★2라운드를 강제한다 — 원 과제를 «1회째만» 싣는 변이(A3)를 잡으려면 필요하다.
        setTimeout(() => {
          markDone(c2, "감사3");
          getJobResultChannel(jid)?.push({ text: "감사3", raw: "[감사자2] 결과-셋째", ts: 4, source: "job" });
        }, 20);
      }
      return { text: "최종 보고" } as RegionASdkOutput;
    });

    const end = Date.now() + 8000;
    while (Date.now() < end && getJob(jid)?.status === "running") {
      await new Promise((r) => setTimeout(r, 10));
    }

    const first = inputs[0];
    const text = first?.text ?? "";
    const managerTurn = turnKindOf({ workerDepth: first?.workerDepth });

    const out: Assertion[] = [
      assert(
        "★거두기 턴이 **두 번 이상** 돌았다(0이면 아래는 미검사 · 1이면 라운드 축을 못 잰다)",
        inputs.length >= 2,
        `모델 호출 ${turns}회 · 거두기 ${inputs.length}회`,
      ),
      assert(
        "★★원 과제가 **통째로** 실린다 — 잘라 실으면 완료조건의 뒷부분이 판단에서 빠진다(적대 검토: 200자 절단 변이가 통과했다)",
        text.includes(TASK),
        text.includes("VOXEL-Q6-5B-앞표식") && !text.includes("VOXEL-Q6-5B-뒤표식")
          ? "★앞만 실림 — 잘렸다"
          : text.includes(TASK)
            ? "통째로 실림"
            : "★안 실림",
      ),
      // ★상수가 **비어 있으면** `includes("")` 가 항상 참이라 아래 단언이 공짜로 통과한다
      //  (2026-09-01 2라운드 G-1 실측: 상수를 `""` 로 만들면 2,510건 전부 초록이었다).
      //  술어를 제품 값에서 읽을 때는 **그 값이 실질적인지** 먼저 재야 한다.
      assert(
        "★★판단 규칙 상수가 **비어 있지 않다** — 비면 아래 «실린다» 단언이 항상 참이 된다(술어를 제품 값에서 읽는 함정)",
        HARVEST_SCOPE_GUIDANCE.trim().length > 150,
        `${HARVEST_SCOPE_GUIDANCE.trim().length}자 (150 초과여야)`,
      ),
      assert(
        "★★판단 규칙이 실린다 — 이게 장치의 나머지 절반이다. 없으면 매니저는 «무엇과 대조하라» 는 말을 못 듣는다(문구를 지워도 초록이던 자리)",
        text.includes(HARVEST_SCOPE_GUIDANCE),
        text.includes(HARVEST_SCOPE_GUIDANCE) ? "판단 규칙 실림" : "★안 실림",
      ),
      assert(
        "★★자식 결과가 **전부** 실린다 — 한 건만 실으면 나머지는 수신함에서 이미 비워져 영구 유실이다",
        text.includes("결과-첫째") && text.includes("결과-둘째"),
        `첫째=${text.includes("결과-첫째")} 둘째=${text.includes("결과-둘째")}`,
      ),
      assert(
        "★★**모든** 거두기 라운드가 원 과제와 판단 규칙을 싣는다 — 1회째만 실으면 2회째부터 범위를 잃는다",
        inputs.length >= 2 &&
          inputs.every((i) => (i.text ?? "").includes(TASK) && (i.text ?? "").includes(HARVEST_SCOPE_GUIDANCE)),
        `라운드별 적재=${inputs.map((i) => ((i.text ?? "").includes(TASK) && (i.text ?? "").includes(HARVEST_SCOPE_GUIDANCE) ? "O" : "X")).join(",")}`,
      ),
      // ── 되돌린 결정을 못 박는다 — 한때 여기 `toolPolicy:{mode:"none"}` 을 걸었다가 뺐다 ──
      assert(
        "★★거두기 턴은 **매니저 권한 그대로** — 도구를 다시 막으면 늦게 발견된 진짜 차단 결함(필수 회귀 실패 등)을 매니저가 못 고친다",
        inputs.every((i) => i.toolPolicy === undefined),
        inputs.every((i) => i.toolPolicy === undefined)
          ? "제약 없음(의도)"
          : `★조여 있다: ${JSON.stringify(inputs.find((i) => i.toolPolicy !== undefined)?.toolPolicy)}`,
      ),
      // ★반대편도 못 박는다 (적대 검토 G-4). `worker-runner-runs-for-real` 에서 뺀 단언 셋
      //  중 이것만 갈 곳이 없었고, 실제로 «구현 턴에 toolPolicy:none 부착» 변이가 스위트
      //  전체를 통과했다. 삭제된 단언이 스스로 *"여기까지 none 이면 매니저가 일을 못 한다
      //  — 더 조용한 결함"* 이라고 지목한 자리다.
      assert(
        "★★구현(첫) 턴도 제약이 없다 — 여기까지 조이면 매니저가 아무 일도 못 하고 «했다» 는 보고만 낸다(더 조용한 결함)",
        implTurn !== undefined && implTurn.toolPolicy === undefined,
        implTurn === undefined
          ? "★첫 턴을 못 잡음"
          : implTurn.toolPolicy === undefined
            ? "제약 없음(의도)"
            : `★조여 있다: ${JSON.stringify(implTurn.toolPolicy)}`,
      ),
      // ── ★배관은 **열거하지 않고 기준으로** 잰다 (2026-09-01 2라운드 G-3) ──────────
      //  1라운드는 «중요한 것만» 골라 `threadKey`·`abortSignal` 둘을 손으로 적었다. 그래서
      //  나머지 셋을 지워도 전체 스위트가 초록이었다 — `cwd`(거두기 턴 파일 쓰기가 홈으로
      //  샌다) · `steering`(`steer_worker` 가 거두기 턴에 안 닿는다 = 사용자 개입 창이 바로
      //  거기다) · 모델 체인(`high` 매니저가 조용히 기본 풀로 떨어진다).
      //  ★손으로 고른 목록은 낡는다([[feedback_hand_maintained_lists]]) — **«text 만 다르고
      //   나머지는 첫 턴과 같다»** 라는 판정 하나로 바꾼다. 새 필드가 생겨도 저절로 덮인다.
      assert(
        "★★거두기 입력은 첫 턴과 **`text`·`steering` 외 전 필드가 같다** — 손으로 고른 필드만 지키면 나머지가 조용히 샌다(cwd·모델체인이 실제로 그랬다)",
        implTurn !== undefined &&
          inputs.length > 0 &&
          inputs.every((i) => diffFields(implTurn as RegionASdkInput, i).length === 0),
        implTurn === undefined || inputs.length === 0
          ? "★비교 대상을 못 잡음"
          : (() => {
              const d = inputs.flatMap((i) => diffFields(implTurn as RegionASdkInput, i));
              return d.length === 0 ? "text·steering 외 전 필드 동일" : `★어긋난 필드: ${[...new Set(d)].join(", ")}`;
            })(),
      ),
      // ★`steering` 은 **값이 아니라 존재**로 잰다 — 거두기 라운드마다 채널을 새로 교체하는
      //  것이 의도이기 때문이다(`rotateSteerChannel`: 어댑터가 턴 끝에 닫으므로). 예외를
      //  기준 안에 우겨넣지 않고 여기 한 줄로 남긴다 — 표는 규칙만 말하고, 규칙으로 안 되는
      //  것은 눈에 보이는 편이 낫다.
      assert(
        "★★거두기 턴에도 **스티어 채널이 있다** — 없으면 `steer_worker` 가 안 닿는다. 매니저는 후반부를 거두기 턴에서 보내므로 사용자 개입 창이 바로 거기다",
        inputs.length > 0 &&
          inputs.every((i) => (i.steering !== undefined) === (implTurn?.steering !== undefined)),
        `첫턴=${implTurn?.steering !== undefined} 거두기=${inputs.map((i) => i.steering !== undefined).join(",")}`,
      ),
      assert(
        "★★모델 체인도 거두기 턴에 그대로 간다 — 빠지면 `high` 로 띄운 매니저가 거두기부터 조용히 기본 풀로 떨어진다",
        optsSeen.length > 0 &&
          optsSeen.every((o) => JSON.stringify(o?.chain) === JSON.stringify(implOpts?.chain)),
        `첫턴=${JSON.stringify(implOpts?.chain)} 거두기=${optsSeen.map((o) => JSON.stringify(o?.chain)).join(",")}`,
      ),
      assert(
        "★거두기 턴도 매니저다 — 그래서 위임 권한을 갖는다(그 권한이 곧 «작업 전체 소유» 다)",
        managerTurn === "manager" && reaches("agents", managerTurn),
        `turnKind=${managerTurn} · agents 도달=${String(reaches("agents", managerTurn))}`,
      ),
    ];

    __resetJobsForTest();
    return out;
  },
};
