/**
 * 회귀: **매니저에 얹은 지시는 흔적을 남긴다** (2026-08-05, ADR 2026-08-03-steer-observability).
 *
 * 사고: `steer_worker` 로 돌고 있는 매니저에 지시를 추가하면 **그 턴의 도구 반환값 말고는
 * 세상 어디에도 기록이 없었다** — 이벤트 발행 없음, `events` 0건, 대시보드 표시 없음.
 * 그래서 (a) 사용자는 전달 여부를 확인할 수단이 없고, (b) 사후에 "이 매니저가 왜 저렇게
 * 했지" 를 볼 때 **스티어가 있었다는 사실 자체를 모른다**(로그가 1차 진단면이라는 원칙 위반).
 *
 * 고침은 이름을 덮어쓰는 방향이 아니다(그러면 원래 의도가 사라진다) — 발행 + 타임라인이라
 * **원래 의도(label·task)와 변경(스티어)이 둘 다** 남는다.
 *
 * 사슬 양끝을 다 본다: ①코어가 결과와 무관하게 발행하는가 ②대시보드가 그걸 잡 카드 스텝으로
 * 그리는가(그리고 유령 카드를 지어내지 않는가) ③라우팅이 상태 전이 분기 **앞**에 있는가.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  setSteerChannel,
  clearSteerChannel,
  steerJob,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { getEventBus } from "../../core/eventbus.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const msg = (t: string) => ({ text: `[사용자 추가 지시] ${t}`, raw: t, ts: 1 });

// ── 대시보드 렌더 하네스 ─────────────────────────────────────────────────────
// background-drawer.js 의 실물 handleWorkerSteered 를 vm 에 올려 돌린다(스텁 복제 아님 —
// 스텁을 검사하면 실물이 바뀌어도 초록이다). tabs-reconcile-with-server 와 같은 방식.
interface FakeEl {
  className: string;
  textContent: string;
  children: FakeEl[];
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  appendChild(c: FakeEl): void;
}
const mkEl = (): FakeEl => ({
  className: "",
  textContent: "",
  children: [],
  scrollHeight: 0,
  scrollTop: 0,
  clientHeight: 0,
  appendChild(c: FakeEl): void {
    this.children.push(c);
  },
});
/** 스텝 한 줄을 사람이 읽는 문자열로 — 아이콘/라벨/원문/사유가 다 들어간다. */
const stepText = (el: FakeEl): string => el.children.map((c) => c.textContent).join(" ");

interface SteerPayload {
  jobId?: string;
  label?: string;
  message?: string;
  outcome?: string;
  ts?: number;
}
interface JobCard {
  label: string;
  seenSteps: Set<string>;
  stepsEl: FakeEl;
  stepCount: number;
}

/** 이벤트 payload 들을 순서대로 먹이고, 만들어진 카드/스텝을 돌려준다. */
const renderSteers = (
  payloads: SteerPayload[],
  existingCards: string[] = [],
): { cards: Map<string, JobCard>; created: string[] } => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/background-drawer.js"), "utf8");
  const pick = (re: RegExp, what: string): string => {
    const m = re.exec(src);
    if (m === null) throw new Error(`${what} 를 못 찾음(대시보드 구조 변경?)`);
    return m[0];
  };
  const appendFn = pick(/const appendJobStep = \(entry, line\) => \{[\s\S]*?\n {6}\};/, "appendJobStep");
  const noteMap = pick(/const STEER_OUTCOME_NOTE = \{[\s\S]*?\n {6}\};/, "STEER_OUTCOME_NOTE");
  const handler = pick(/const handleWorkerSteered = \(p, ts\) => \{[\s\S]*?\n {6}\};/, "handleWorkerSteered");

  const cards = new Map<string, JobCard>();
  for (const id of existingCards) {
    cards.set(id, { label: `기존:${id}`, seenSteps: new Set(), stepsEl: mkEl(), stepCount: 0 });
  }
  const created: string[] = [];
  const ctx: Record<string, unknown> = {
    jobCards: cards,
    document: { createElement: (): FakeEl => mkEl() },
    ensureJobCard: (jobId: string, o: { label?: string }): JobCard => {
      let e = cards.get(jobId);
      if (e === undefined) {
        e = { label: o.label ?? "", seenSteps: new Set(), stepsEl: mkEl(), stepCount: 0 };
        cards.set(jobId, e);
        created.push(jobId);
      }
      return e;
    },
    updateChev: (): void => {},
    scheduleAgentsRender: (): void => {},
    scheduleProjectAgentsRender: (): void => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${appendFn}\n${noteMap}\n${handler}\nthis.__run = handleWorkerSteered;`, ctx);
  const run = ctx.__run as (p: SteerPayload, ts: string) => void;
  for (const p of payloads) run(p, "12:00:00");
  return { cards, created };
};

/** 라우팅 배선 — 스티어는 상태 전이 분기 **앞**에서 가로채야 한다(뒤면 status 로 해석된다). */
const routedBeforeLifecycle = (): boolean => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/sse.js"), "utf8");
  const steer = src.indexOf('ev.type === "worker.steered"');
  const generic = src.indexOf('ev.type.indexOf("worker.") === 0');
  return steer !== -1 && generic !== -1 && steer < generic;
};

export const check: RegressionCheck = {
  name: "steer-observability",
  guards: "매니저에 얹은 지시가 이벤트·DB·화면 어디에도 안 남아 전달 확인도 사후 진단도 불가하던 것",
  run: async (): Promise<Assertion[]> => {
    // ── ① 코어 발행 — 전달됐든 유실됐든 남는다 ────────────────────────────
    const id = "regr-steerobs-1";
    const ch = createSteeringChannel();
    setSteerChannel(id, ch);
    const seen: Array<Record<string, unknown>> = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (e.type === "worker.steered") seen.push((e.payload ?? {}) as Record<string, unknown>);
    });
    try {
      steerJob(id, msg("이것도 해줘"));
      ch.close();
      steerJob(id, msg("늦은 지시")); // closed — 간발의 차 유실.
      clearSteerChannel(id);
      steerJob(id, msg("없는 매니저")); // absent.
    } finally {
      if (typeof unsub === "function") unsub();
    }
    const mine = seen.filter((p) => p.jobId === id);

    // ── ② 대시보드 렌더 ───────────────────────────────────────────────────
    const live = renderSteers(
      [{ jobId: "j1", label: "핫딜 크롤러", message: "대시보드 먼저", outcome: "delivered", ts: 100 }],
      ["j1"],
    );
    const liveCard = live.cards.get("j1");
    const liveStep = liveCard?.stepsEl.children[0];

    // 같은 이벤트 재전송(SSE replay = 새로고침) — 한 줄이어야 한다.
    const replay = renderSteers(
      [
        { jobId: "j1", label: "핫딜 크롤러", message: "대시보드 먼저", outcome: "delivered", ts: 100 },
        { jobId: "j1", label: "핫딜 크롤러", message: "대시보드 먼저", outcome: "delivered", ts: 100 },
      ],
      ["j1"],
    );

    // 유실(closed)도 같은 자리에 남되 사유가 붙는다.
    const missed = renderSteers(
      [{ jobId: "j2", label: "리서치", message: "그건 빼고", outcome: "closed", ts: 200 }],
      ["j2"],
    );
    const missedStep = missed.cards.get("j2")?.stepsEl.children[0];

    // 대상을 못 고른 시도(no-target) + 서버도 모르는 옛 jobId → 카드를 지어내지 않는다.
    const ghost = renderSteers([
      { message: "없는 매니저에", outcome: "no-target", ts: 300 }, // jobId 없음
      { jobId: "j-gone", message: "프루닝된 잡에", outcome: "absent", ts: 301 }, // 카드도 label 도 없음
    ]);

    return [
      assert(
        "★스티어 시도마다 worker.steered 가 발행된다(전달·유실 전부)",
        mine.length === 3,
        `${mine.length}건`,
      ),
      assert(
        "결과가 payload 에 실린다 — 유실을 사후에 셀 수 있다",
        mine.map((p) => p.outcome).join(",") === "delivered,closed,absent",
        mine.map((p) => p.outcome).join(",") || "(없음)",
      ),
      assert(
        "실린 문구는 framing 없는 사용자 원문(raw) — 화면·감사 양쪽이 이걸 본다",
        mine[0]?.message === "이것도 해줘",
        String(mine[0]?.message),
      ),
      assert(
        // 스티어해도 잡은 계속 돈다 — status 를 실으면 관측자에게 가짜 상태 전이가 된다.
        "상태 전이 필드(status)를 싣지 않는다(잡 상태 무영향)",
        mine.every((p) => p.status === undefined),
        String(mine[0]?.status),
      ),
      assert(
        "★잡 카드 타임라인에 지시가 한 줄로 쌓인다(사용자가 전달을 눈으로 확인)",
        liveCard?.stepCount === 1 && stepText(liveStep ?? mkEl()).includes("대시보드 먼저"),
        stepText(liveStep ?? mkEl()) || "(스텝 0)",
      ),
      assert(
        // 이름 덮어쓰기를 기각한 이유 그대로 — 원래 의도와 변경이 **둘 다** 남아야 한다.
        "이름(label)은 스티어로 바뀌지 않는다",
        live.cards.get("j1")?.label === "기존:j1",
        String(live.cards.get("j1")?.label),
      ),
      assert(
        "SSE replay 로 같은 스티어가 다시 와도 한 줄(dedup)",
        replay.cards.get("j1")?.stepCount === 1,
        `${replay.cards.get("j1")?.stepCount}줄`,
      ),
      assert(
        "전달 못 된 지시도 남고 사유가 붙는다(유실이 조용히 사라지지 않음)",
        stepText(missedStep ?? mkEl()).includes("그건 빼고") &&
          stepText(missedStep ?? mkEl()).includes("막 끝나"),
        stepText(missedStep ?? mkEl()) || "(스텝 0)",
      ),
      assert(
        "★근거 없는 잡 카드를 지어내지 않는다(유령 0)",
        ghost.created.length === 0 && ghost.cards.size === 0,
        ghost.created.join(",") || "0개",
      ),
      assert(
        // 뒤에 두면 status 없는 payload 가 "running" 으로 해석돼 잡 상태를 건드린다.
        "대시보드가 스티어를 상태 전이 분기 앞에서 가로챈다(배선 확인)",
        routedBeforeLifecycle(),
        "sse.js",
      ),
    ];
  },
};
