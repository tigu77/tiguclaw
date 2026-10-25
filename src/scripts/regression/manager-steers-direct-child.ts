/**
 * **소환자는 직속 자식에게 지시할 수 있다** (2026-10-25 사용자 —
 * [설계](../../../docs/decisions/2026-10-25-summoner-steers-direct-child.md)).
 *
 * 매니저는 `spawn_agent`·`wait_for_worker` 로 자식을 띄우고 거둘 수 있었지만 돌고 있는 자식에 지시를 얹을 수 없었다
 * (`steer_worker` 가 메인 전용 `workers` 서버에만 있었다). 이 검사가 지키는 것:
 *  ① 노출 — 매니저 턴의 `agents` 서버에만 생기고, 메인 도구 면(이름·설명·스키마)은 그대로다.
 *  ② 관계 — 대상은 그 호출자의 **직속 자식**(실행 중·detached)뿐이다. 형제·형제의 자식(동명)·부모·다른 대화·끝난/취소·
 *     알고 있는 남의 jobId·끝난 호출자로는 어떤 식별자로도 닿지 않고, 거절 기록이 남의 카드에 그려지지 않는다.
 *  ③ 출처 — 자식은 «소환자의 지시» 로 받는다(«사용자 추가 지시» 로 포장 금지 · 승인 위조 방지).
 *  ④ 메인 규약은 종전 그대로(공통 원칙보다 넓다 — 손자·다른 대화 job_id·동명 안내. 바꾸지 않았다).
 *  ⑤ 늦게 도착 — 자식이 못 읽고 끝나면(성공·실패 · 교체된 옛 채널 잔여 포함) 보낸 매니저에게 돌아가고, 매니저도 못 읽고 끝나도
 *     사용자 통지로 둔갑하지 않는다.
 *  ⑥ 순서 — 반송은 완료 배달보다 먼저다(매니저가 완료를 받는 순간 이미 큐에 있다).
 *
 * 등급: 동작 검사(실제 핸들러·채널·러너·완료 출구, 모델 호출 0). 전역 핸들러를 거므로 자식 프로세스.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "_manager-steer-child.ts");
const REPO = path.resolve(HERE, "../../..");
/** 메인 `steer_worker` 의 설명+스키마 지문 — 이 변경 전 HEAD(18fe3b48)와 같은 값. 메인 도구 면을 바꾸면 여기가 빨개진다. */
const MAIN_STEER_FINGERPRINT = "984702331f281c76";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

export const check: RegressionCheck = {
  name: "manager-steers-direct-child",
  guards:
    "매니저가 자식에 지시를 못 얹던 것 · 넣으면서 직속 자식 밖(형제·부모·다른 대화·알고 있는 id)으로 새거나, 매니저 글이 «사용자 지시» 로 보이거나, 메인 도구 면·규약이 몰래 바뀌는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(90_000, "manager-steer", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (r.timedOut || line === undefined) return [assert("자식이 결과를 낸다", false, r.timedOut ? "timeout" : r.err.slice(-600))];
    const d = JSON.parse(line) as R;
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
    const ex = d.exposure as R, di = d.direct as R, mn = d.main as R;
    const refused = Object.entries(di.refused as Record<string, { text: string; leaked: number }>);
    const adapters = ["claude-agent-sdk", "openai-agents-sdk", "openai-codex-oauth"].map((a) => {
      const src = readFileSync(path.join(REPO, `src/core/llm-runtime/adapters/${a}.ts`), "utf8");
      return [a, /reaches\("agents", turnKind\)[\s\S]{0,240}?createSpawnAgentMcpServer\(input\)/.test(src)] as const;
    });
    return [
      assert("① 매니저 턴 `agents` 에 steer_worker 가 생긴다", (ex.mgrAgents as string[]).includes("steer_worker"), show(ex.mgrAgents)),
      assert("① ★메인 `agents` 엔 없다(메인은 `workers` 에 이미 있다 — 두 번 싣지 않는다)", !(ex.mainAgents as string[]).includes("steer_worker"), show(ex.mainAgents)),
      assert(
        "① ★메인 `workers` 도구 이름 목록 불변",
        show(ex.mainWorkers) === show(["run_in_background", "list_workers", "list_all_workers", "steer_worker", "cancel_worker"]),
        show(ex.mainWorkers),
      ),
      assert("① ★메인 steer_worker 설명·스키마가 변경 전과 바이트 단위로 같다(지문)", ex.mainSteerFingerprint === MAIN_STEER_FINGERPRINT, ex.mainSteerFingerprint),
      assert("① 세 어댑터가 `agents` 서버를 같은 조건으로 붙인다(노출 판단은 팩토리 한 곳)", adapters.every(([, ok]) => ok), show(adapters)),
      assert("② 직속 자식 label → 1건 전달 · 형제의 같은 이름 자식엔 0", di.got === 1 && di.gotC2 === 0 && String(di.r1).includes("전달했어요"), show({ got: di.got, gotC2: di.gotC2, r1: di.r1 })),
      assert("② 직속 자식 job_id → 1건 전달", di.gotById === 1 && String(di.r2).includes("전달했어요"), show({ gotById: di.gotById, r2: di.r2 })),
      assert(
        "③ ★자식이 받는 글은 «소환자 '<매니저>' 의 추가 지시» 이고 «사용자 추가 지시» 가 아니다 · 보낸 작업(from) · 원문 그대로",
        String(di.head).startsWith("[소환자 '지휘' 의 추가 지시]") && di.userHead === false && di.from === di.M && di.raw === "B만 봐",
        show({ head: di.head, userHead: di.userHead, from: di.from, raw: di.raw }),
      ),
      assert("③ 관측(worker.steered)에 보낸 작업이 실린다", di.deliveredEv?.fromJobId === di.M && di.deliveredEv?.fromLabel === "지휘", show(di.deliveredEv)),
      ...refused.map(([name, v]) =>
        assert(`② ★직속 자식이 아니면 전달 0 — ${name}`, v.leaked === 0 && v.text.includes("찾지 못했어요") && !v.text.includes("다른 대화"), show(v)),
      ),
      assert(
        "② 거절 기록은 남기되 대상 jobId 를 싣지 않는다(남의 카드에 스텝을 그리지 않는다) · 보낸 작업은 실린다",
        (di.refusedEvents as R[]).length === refused.length && (di.refusedEvents as R[]).every((e) => e.jobId === "" && e.outcome === "no-target" && e.fromJobId === di.M),
        show(di.refusedEvents),
      ),
      assert("② 부모로는 안 간다(서브에이전트 좌표에서 자기 부모 id — 같은 판정)", di.parentLeak === 0 && di.parentRefused === true, show({ parentText: di.parentText, parentLeak: di.parentLeak })),
      ...(["완료", "실패", "취소"] as const).map((how) =>
        assert(`② 호출자 작업이 실행 중이 아니면(${how}) 거절한다 · 자식 큐 0`, di.deadCallers?.[how]?.leaked === 0 && String(di.deadCallers?.[how]?.text).includes("이미 끝나"), show(di.deadCallers?.[how])),
      ),
      assert(
        "④ ★메인 규약 종전 그대로 — 손자 label 전달 · 다른 대화 job_id 전달 · 다른 대화 동명은 안내만 · «사용자 추가 지시» 머리 · from 없음",
        mn.grandchild === 1 && mn.otherSessionId === 1 && mn.otherSessionLabel === true && mn.otherLeak === 0 &&
          mn.gHead === "[사용자 추가 지시] " && mn.gFrom === null && (mn.events as R[]).every((e) => e.from === null),
        show(mn),
      ),
      ...(["late", "lateRotated", "lateFailed"] as const).map((k) => {
        const v = d[k] as R;
        const how = { late: "그대로", lateRotated: "교체된 채널 — 옛 채널 잔여까지", lateFailed: "자식이 실패로 끝남" }[k];
        return assert(
          `⑤ ★늦게 도착(${how}) — 자식이 못 읽고 끝나면 보낸 매니저에게 반송 1(점검 시계는 안 민다) · 매니저도 못 읽고 끝나도 사용자에게 0`,
          v.pStatus === "done" && v.cStatus === (k === "lateFailed" ? "failed" : "done") && show(v.bounce) === show(["delivered"]) && v.bouncedLate === true &&
            v.userLateNotices === 0 && v.managerTextToUser === 0 && v.anchorKept === true &&
            (k === "lateRotated" ? v.rotated === true && v.bouncedEarly === true : v.rotated === false),
          show(v),
        );
      }),
      assert(
        "⑥ ★순서 — 매니저가 자식 완료를 받는 순간 반송이 이미 그 매니저 큐에 있다(반송은 완료 배달보다 먼저)",
        d.order?.bounceQueuedAtCompletion === 1 && d.order?.completions === 1 && d.order?.bounced === 1,
        show(d.order),
      ),
      assert(
        "⑤ 대조 — 사용자(메인)의 늦은 지시는 종전대로 사용자에게 «이미 끝난 뒤» 통지 1 · 매니저 글은 섞이지 않는다",
        d.lateUserControl?.userLateNotices === 1 && d.lateUserControl?.userTextToUser === 1 && d.lateUserControl?.managerTextToUser === 0,
        show(d.lateUserControl),
      ),
    ];
  },
};
