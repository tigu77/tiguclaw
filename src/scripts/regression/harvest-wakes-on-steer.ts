/**
 * 회귀: **자식 결과를 기다리는 매니저는 끼워넣은 지시에 깨어난다** (2026-10-12 맥돌쇠).
 *
 * 사고: 아침 스케줄의 매니저가 08:10 에 본 턴을 끝내고 자식 둘을 기다리는 동안(거두기 대기), 소환자가 08:30·08:33·08:45 에
 *  «더 기다리지 말고 종료하라» 를 세 번 끼워넣었다. 기록은 셋 다 «전달됨» 인데 매니저의 모델 호출은 08:10 이 마지막이었다 —
 *  대기가 **결과 수신함만** 지켜봐서 지시는 채널에 쌓이기만 했다. 자식들은 2시간 시한까지 폭주했고 매니저도 그때 끝났다.
 *
 * 지키는 것(레지스트리를 실제로 돌린다 · 모델 호출 0):
 *  ① 자식이 아직 도는 대기 중 지시가 오면 **턴이 열리고**, 그 지시 본문이 **턴 입력에** 실린다(어댑터 끼워넣기에 두 번 X)
 *  ② 그 턴의 입력은 «지시로 깨어남» 을 말한다(결과 도착이라고 하지 않는다)
 *  ③ 지시 없이 결과만 오면 종전대로 결과 턴(대조)
 *  ④ 결과와 지시가 같은 순간에 와도 둘 다 실린다(적대 검토 F2 — 진 쪽이 꺼낸 지시가 사라지던 변이)
 *  ⑤ 끼워넣기를 끈 매니저(WORKER_STEERING_ENABLED=0)도 결과를 거둔다(F1 — 채널이 없을 때의 대기를 게으르게 고치면 결과 유실)
 *
 * 등급: **동작**.
 */
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  getJob,
  getJobResultChannel,
  getSteerChannel,
  markDone,
  registerJob,
  registerWorkerHandler,
} from "../../core/worker-jobs.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const waitUntil = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
};

export const check: RegressionCheck = {
  name: "harvest-wakes-on-steer",
  guards:
    "자식 결과를 기다리는 매니저가 소환자의 «종료하라» 끼워넣기를 2시간 동안 못 읽던 것 — 대기가 결과 수신함만 지켜봤다(맥돌쇠 10-12)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    registerWorkerHandler((async () => ({ text: "" })) as never);
    const base = { channel: "cli" as const, channelUserId: "u", task: "회귀 과제" };
    const jid = registerJob({ ...base, kind: "worker", label: "대기중지시", threadKey: "cli:steer-wake" });
    const child = registerJob({ ...base, kind: "agent", label: "폭주자식", threadKey: `worker:${jid}`, detached: true });

    const turns: Array<{ text: string; steered: string[] }> = [];
    runWorkerJob(getJob(jid) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
      const steered = (input.steering?.drain() ?? []).map((m) => m.raw);
      turns.push({ text: input.text, steered });
      if (turns.length === 2) markDone(child, "정리됨"); // 매니저가 지시를 받고 자식을 정리했다 — 대기를 끝낸다
      return { text: turns.length === 1 ? "본 턴 끝" : "지시 반영 후 마무리" } as RegionASdkOutput;
    });
    // 본 턴이 끝나고 대기에 들어간 뒤 지시를 끼워넣는다.
    await waitUntil(() => turns.length === 1, 2000);
    await new Promise((r) => setTimeout(r, 50));
    const pushed = getSteerChannel(jid)?.push({ text: "[끼워넣기] 더 기다리지 말고 종료하세요", raw: "회귀-종료지시", ts: Date.now() }) === true;
    const woke = await waitUntil(() => turns.length >= 2, 2000);
    await waitUntil(() => getJob(jid)?.status !== "running", 2000);
    const second = turns[1];

    // ③ 대조: 지시 없이 결과만 오면 결과 턴
    __resetJobsForTest();
    const jid2 = registerJob({ ...base, kind: "worker", label: "결과만", threadKey: "cli:steer-wake2" });
    const child2 = registerJob({ ...base, kind: "agent", label: "자식2", threadKey: `worker:${jid2}`, detached: true });
    const turns2: string[] = [];
    runWorkerJob(getJob(jid2) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
      turns2.push(input.text);
      return { text: "끝" } as RegionASdkOutput;
    });
    await waitUntil(() => turns2.length === 1, 2000);
    markDone(child2, "결과");
    getJobResultChannel(jid2)?.push({ text: "결과", raw: "[자식2] 회귀-결과", ts: 1, source: "job" });
    await waitUntil(() => turns2.length >= 2, 2000);
    await waitUntil(() => getJob(jid2)?.status !== "running", 2000);

    // ④ 결과와 지시가 같은 순간에
    __resetJobsForTest();
    const jid3 = registerJob({ ...base, kind: "worker", label: "동시도착", threadKey: "cli:steer-wake3" });
    const child3 = registerJob({ ...base, kind: "agent", label: "자식3", threadKey: `worker:${jid3}`, detached: true });
    const turns3: Array<{ text: string; steered: string[] }> = [];
    runWorkerJob(getJob(jid3) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
      turns3.push({ text: input.text, steered: (input.steering?.drain() ?? []).map((m) => m.raw) });
      return { text: "끝" } as RegionASdkOutput;
    });
    await waitUntil(() => turns3.length === 1, 2000);
    await new Promise((r) => setTimeout(r, 50));
    markDone(child3, "결과");
    getJobResultChannel(jid3)?.push({ text: "결과", raw: "[자식3] 회귀-동시결과", ts: 1, source: "job" });
    getSteerChannel(jid3)?.push({ text: "[끼워넣기] 회귀-동시지시", raw: "회귀-동시지시", ts: 2 });
    await waitUntil(() => getJob(jid3)?.status !== "running", 2000);
    const all3 = JSON.stringify(turns3.slice(1));
    // ⑤ 끼워넣기 꺼짐 — 모듈 상수라 프로세스를 따로 띄운다
    const off = await spawnWithin(30000, "끼워넣기 꺼진 매니저", ["--import", "tsx", fileURLToPath(new URL("./_harvest-steer-off-child.ts", import.meta.url))], {
      env: { ...process.env, WORKER_STEERING_ENABLED: "0" },
    });
    const offLine = off.out.split(/\r?\n/).find((l) => l.startsWith("STEER_OFF "));
    const offR = offLine ? JSON.parse(offLine.slice(10)) : {};

    // ⑥ 지시로 깨어난 턴이 실패하면 그 지시는 «반영 못 한 지시» 로 소유 대화에 알려진다(조용히 사라지지 않는다)
    __resetJobsForTest();
    const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
    const sentTexts: string[] = [];
    registerChannelOutbound("regr-wake", { deliver: async (_t: unknown, text: string) => { sentTexts.push(text); }, defaultOutboundTarget: async () => "regr-target" } as never);
    const jid4 = registerJob({ channel: "regr-wake" as never, channelUserId: "u", task: "회귀 과제", kind: "worker", label: "깨어난턴실패", threadKey: "regr-wake:1" });
    registerJob({ channel: "regr-wake" as never, channelUserId: "u", task: "회귀 과제", kind: "agent", label: "자식4", threadKey: `worker:${jid4}`, detached: true });
    let turns4 = 0;
    runWorkerJob(getJob(jid4) as never, async (): Promise<RegionASdkOutput> => {
      turns4 += 1;
      if (turns4 === 2) throw new Error("회귀-거두기실패");
      return { text: "본 턴 끝" } as RegionASdkOutput;
    });
    await waitUntil(() => turns4 === 1, 2000);
    await new Promise((r) => setTimeout(r, 50));
    getSteerChannel(jid4)?.push({ text: "[끼워넣기] 회귀-실패지시", raw: "회귀-실패지시", ts: Date.now() });
    await waitUntil(() => getJob(jid4)?.status !== "running", 3000);
    await new Promise((r) => setTimeout(r, 50));

    const out: Assertion[] = [
      assert(
        "★⑥ 지시로 깨어난 턴이 실패하면 그 지시가 «반영 못 한 지시» 로 소유 대화에 알려진다",
        turns4 === 2 && sentTexts.some((t) => t.includes("회귀-실패지시")),
        { 턴: turns4, 상태: getJob(jid4)?.status, 보낸글: sentTexts.map((t) => t.slice(0, 80)) },
      ),
      assert(
        "★① 자식을 기다리는 중 지시가 오면 매니저 턴이 열리고, 그 지시 본문이 턴 입력에 실린다(끼워넣기로 또 들어가지 않는다)",
        pushed && woke && second !== undefined && second.text.includes("더 기다리지 말고 종료하세요") && !second.steered.includes("회귀-종료지시"),
        { 끼워넣음: pushed, 턴열림: woke, 입력: second?.text.slice(-120), 끼워넣기: second?.steered },
      ),
      assert(
        "★④ 결과와 지시가 같은 순간에 와도 둘 다 매니저에게 닿는다",
        all3.includes("회귀-동시결과") && all3.includes("회귀-동시지시"),
        { 턴: turns3.length, 결과: all3.includes("회귀-동시결과"), 지시: all3.includes("회귀-동시지시") },
      ),
      assert(
        "★⑤ 끼워넣기를 끈 매니저도 자식 결과를 거둔다",
        offR.enabled === false && offR.turns === 2 && offR.resultSeen === true,
        offLine ?? off.err.slice(-500),
      ),
      assert(
        "② 그 턴의 입력은 «지시로 깨어남» 이다(결과 도착이라고 하지 않는다)",
        second !== undefined && /지시 도착/.test(second.text) && !second.text.startsWith("[백그라운드 작업 결과 도착]"),
        second?.text.slice(0, 120),
      ),
      assert(
        "③ 대조 — 지시 없이 결과만 오면 종전대로 결과 턴",
        turns2.length >= 2 && (turns2[1] ?? "").startsWith("[백그라운드 작업 결과 도착]") && (turns2[1] ?? "").includes("회귀-결과"),
        (turns2[1] ?? "").slice(0, 120),
      ),
    ];
    return out;
  },
};

export default check;
