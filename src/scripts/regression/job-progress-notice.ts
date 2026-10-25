/**
 * 회귀: **오래 도는 매니저의 진행 알림** (2026-10-14, 설계 `docs/decisions/2026-10-14-job-progress-notice.md`).
 *
 * 사고(단계 1 관찰): 매니저 점검은 **무활동**일 때만 깨워서, 4시간 잘 도는 잡은 말이 없었다. 비서가 그 빈자리를 «중간에 먼저
 *  보고하라» 는 AGENT.md 규칙으로 메우다 일을 16분짜리로 쪼개 매번 멈췄고, 사용자는 «이어서» 를 17번 쳤다.
 *
 * 재는 것(격리 홈 · 실제 점검 틱 · 시각만 주입 · 모델 호출 0 — 요약기는 가짜로 바꿔 끼운다):
 *  ① 활동이 있는 최상위 매니저는 주기가 되면 **한 번** 알린다(같은 주기 안 두 번째 틱은 조용)
 *  ② 활동이 없으면 알리지 않는다(«진행 중» 은 거짓 — 그건 무활동 점검의 몫)
 *  ③ 요약이 실패하면 기계 요약이 대신 나간다(최근 행동이 실린다)
 *  ④ 오류로 끝난 행동은 요약이 «잘 진행 중» 이라 해도 하네스가 «오류 N건» 을 붙인다
 *  ⑤ 매니저·메인 컨텍스트 무변경 — 재주입 0 · 그 잡의 steering 큐 0
 *  ⑥ 요약 사이에 잡이 끝나면 버린다(완료 뒤 진행 알림 역전 금지)
 *  ⑦ 설정 — 끄면 안 나가고, 간격을 바꾸면 그 간격을 따른다(재시작 없이)
 *  ⑧ 대상 밖 — 서브에이전트·스케줄이 띄운 매니저엔 안 나간다
 *
 * 등급: **동작**.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

export const check: RegressionCheck = {
  name: "job-progress-notice",
  guards:
    "오래 잘 도는 매니저가 몇 시간 말이 없어, 비서가 일을 잘게 쪼개 매번 멈추고 사용자가 «이어서» 를 반복해야 했던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { initStore, isUserConversationThread } = await import("../../store/sessions.js");
    initStore();
    const wj = await import("../../core/worker-jobs.js");
    const jp = await import("../../core/job-progress.js");
    const { setProgressNoticeSettings, readProgressNoticeSettings } = await import("../../core/settings.js");
    const { registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const { createSteeringChannel } = await import("../../core/steering.js");

    const sent: string[] = [];
    registerChannelOutbound("regr-progress", {
      deliver: async (_t: unknown, text: string) => {
        sent.push(text);
        return { messageIds: [1] };
      },
      defaultOutboundTarget: async () => "t",
    } as never);
    const reinjected: string[] = [];
    wj.registerWorkerHandler((async (m: { text?: string }) => {
      reinjected.push(String(m.text ?? ""));
      return { text: "" };
    }) as never);

    const realSummarizer = jp.getRegisteredProgressSummarizer();
    const prompts: string[] = [];
    let summarizerImpl: (prompt: string) => Promise<string | undefined> = async () => "요약: 자료를 모으는 중입니다.";
    jp.registerProgressSummarizer(async (prompt) => {
      prompts.push(prompt);
      return summarizerImpl(prompt);
    });

    const base = { channel: "regr-progress", channelUserId: "u", task: "회귀 과제", threadKey: "dashboard:regr-progress" };
    // ★어댑터가 내는 **실제 모양** — 시작 이벤트엔 `phase` 가 없다(계약: 미지정 = start). 손으로 phase:"start" 를 넣으면
    //  시작을 `=== "start"` 로 읽는 결함이 숨는다(실제로 숨어 있었다 — 2026-10-14 실검증에서 «최근 행동 0건»).
    const tool = (key: string, label: string, phase: "start" | "end", extra: Record<string, unknown> = {}): void => {
      getEventBus().publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: { threadKey: key, kind: "tool", ...(phase === "end" ? { phase: "end" } : {}), label, seq: 1, ...extra },
      } as never);
    };
    const settle = async (): Promise<void> => sleep(80);
    const fresh = (label: string, extra: Record<string, unknown> = {}): { id: string; key: string; t0: number } => {
      const id = wj.registerJob({ ...base, kind: "worker", label, ...extra } as never);
      return { id, key: `worker:${id}`, t0: Date.now() };
    };

    try {
      setProgressNoticeSettings({ enabled: true, intervalMinutes: 60 });

      // ① 활동 있음 → 주기에 한 번
      wj.__resetJobsForTest();
      const a = fresh("진행대상");
      const steer = createSteeringChannel();
      wj.setSteerChannel(a.id, steer);
      tool(a.key, "WebSearch", "start", { detail: "query=수익 모델" });
      tool(a.key, "WebSearch", "end");
      sent.length = 0;
      wj.__checkinTickForTest(a.t0 + 59 * MIN);
      await settle();
      const before = sent.length;
      wj.__checkinTickForTest(a.t0 + 61 * MIN);
      await settle();
      const first = sent.slice();
      // 시각 관문 — 첫 알림 뒤 새 활동이 있어도 1분 뒤엔 조용(알림 시각을 밀었나)
      tool(a.key, "Read", "start");
      wj.__checkinTickForTest(a.t0 + 62 * MIN);
      await settle();
      const afterSecond = sent.length;

      // 활동 관문 — 간격 10분, 첫 알림 뒤 활동 없이 다음 주기가 와도 조용(알림 뒤 표식을 내렸나)
      setProgressNoticeSettings({ intervalMinutes: 10 });
      wj.__resetJobsForTest();
      const h = fresh("활동관문");
      // 끝난 도구 — 진행 중인 도구는 «활동 중» 으로 본다(⑨). 여기는 끝난 뒤 새 활동이 없을 때를 잰다.
      tool(h.key, "Read", "start");
      tool(h.key, "Read", "end");
      sent.length = 0;
      wj.__checkinTickForTest(h.t0 + 11 * MIN);
      await settle();
      const hFirst = sent.length;
      wj.__checkinTickForTest(h.t0 + 22 * MIN);
      await settle();
      const hIdle = sent.length;
      setProgressNoticeSettings({ intervalMinutes: 60 });

      // ② 활동 없음 → 안 나감
      wj.__resetJobsForTest();
      const b = fresh("조용한대상");
      sent.length = 0;
      wj.__checkinTickForTest(b.t0 + 61 * MIN);
      await settle();
      const quiet = sent.length;

      // ③ 요약 실패 → 기계 요약
      wj.__resetJobsForTest();
      const c = fresh("요약실패");
      tool(c.key, "Read", "start", { detail: "path=보고서.md" });
      summarizerImpl = async () => {
        throw new Error("요약 불가");
      };
      sent.length = 0;
      wj.__checkinTickForTest(c.t0 + 61 * MIN);
      await settle();
      const mech = sent.slice();
      summarizerImpl = async () => "요약: 순조롭게 잘 진행 중입니다.";

      // ④ 오류는 하네스가 붙인다
      wj.__resetJobsForTest();
      const d = fresh("오류대상");
      tool(d.key, "Bash", "start", { detail: "command=npm test" });
      tool(d.key, "Bash", "end", { output: { text: "Error: 실패", isError: true } });
      sent.length = 0;
      wj.__checkinTickForTest(d.t0 + 61 * MIN);
      await settle();
      const withErr = sent.slice();

      // ⑤ 는 여기서 잰다 — 아래 ⑥ 은 잡을 완료시켜 **정상 완료 통지**(재주입)가 나간다. 그건 진행 알림이 아니다.
      const reinjectedByProgress = reinjected.length;
      const steerQueued = steer.drain().length;

      // ⑥ 요약 사이에 끝나면 버린다
      wj.__resetJobsForTest();
      const e = fresh("늦은요약");
      tool(e.key, "Grep", "start");
      let release: () => void = () => {};
      summarizerImpl = () => new Promise<string>((r) => (release = () => r("요약: 늦게 도착")));
      sent.length = 0;
      wj.__checkinTickForTest(e.t0 + 61 * MIN);
      await sleep(20);
      wj.markDone(e.id, "끝");
      release();
      await settle();
      const lateProgress = sent.filter((t) => t.includes("늦게 도착")).length;
      summarizerImpl = async () => "요약: 자료를 모으는 중입니다.";

      // ⑦ 설정 — 끄기 · 간격 변경. ★간격은 무활동 점검(2시간)보다 짧게 잰다 — 활동 시각은 실제 시계라, 121분 시점이면
      //  «2시간 무활동» 으로 보는 게 맞는 동작이다(그건 점검의 몫).
      wj.__resetJobsForTest();
      setProgressNoticeSettings({ enabled: false });
      const f = fresh("꺼짐");
      tool(f.key, "Read", "start");
      sent.length = 0;
      wj.__checkinTickForTest(f.t0 + 61 * MIN);
      await settle();
      const whenOff = sent.length;
      setProgressNoticeSettings({ enabled: true, intervalMinutes: 90 });
      wj.__resetJobsForTest();
      const g = fresh("구십분");
      tool(g.key, "Read", "start");
      sent.length = 0;
      wj.__checkinTickForTest(g.t0 + 61 * MIN);
      await settle();
      const at61 = sent.length;
      tool(g.key, "Read", "start");
      wj.__checkinTickForTest(g.t0 + 91 * MIN);
      await settle();
      const at91 = sent.length;
      setProgressNoticeSettings({ intervalMinutes: 60 });
      let rejected = false;
      try {
        setProgressNoticeSettings({ intervalMinutes: 1 });
      } catch {
        rejected = true;
      }

      // ⑧ 대상 밖
      wj.__resetJobsForTest();
      const agentId = wj.registerJob({ ...base, kind: "agent", agentName: "p", label: "서브", detached: true } as never);
      tool(`agent:${agentId}`, "Read", "start");
      const sch = fresh("스케줄매니저", { threadKey: "scheduler:9" });
      tool(sch.key, "Read", "start");
      sent.length = 0;
      wj.__checkinTickForTest(sch.t0 + 61 * MIN);
      await settle();
      const offTarget = sent.length;

      // ⑨ 진행 중인 긴 도구 — 첫 알림 뒤에도 주기마다(간격 10분), 줄에 «진행 중인 도구»
      setProgressNoticeSettings({ intervalMinutes: 10 });
      wj.__resetJobsForTest();
      const lt = fresh("긴도구");
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: lt.key, kind: "tool", label: "Bash", seq: 7 } } as never);
      sent.length = 0;
      const promptsBeforeLong = prompts.length;
      wj.__checkinTickForTest(lt.t0 + 11 * MIN);
      await settle();
      wj.__checkinTickForTest(lt.t0 + 22 * MIN);
      await settle();
      const longTool = sent.slice();
      // 두 번째 알림 때 «직전 알림 이후 행동» 은 없다 — 옛 행동으로 다시 요약하지 않는다(요약 호출 1번)
      const longToolPrompts = prompts.length - promptsBeforeLong;
      // ⑩ 글만 쓰는 잡 — 말할 사실이 없으면 보내지 않는다
      wj.__resetJobsForTest();
      const tx = fresh("글만");
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: tx.key, kind: "text" } } as never);
      sent.length = 0;
      wj.__checkinTickForTest(tx.t0 + 11 * MIN);
      await settle();
      const textOnly = sent.length;
      // ⑮ 오류 경계(아스트라 10-14) — 알림 전에 시작해 알림 뒤 실패한 호출도 다음 알림에 든다 · 다음 주기엔 두 번 안 센다
      wj.__resetJobsForTest();
      const eb = fresh("경계오류");
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: eb.key, kind: "tool", label: "Bash", seq: 21 } } as never);
      sent.length = 0;
      wj.__checkinTickForTest(eb.t0 + 11 * MIN); // 알림 1 — 아직 실패 전
      await settle();
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: eb.key, kind: "tool", label: "Bash", seq: 21, phase: "end", output: { text: "Error: 실패", isError: true } } } as never);
      wj.__checkinTickForTest(eb.t0 + 22 * MIN); // 알림 2 — 그 실패가 실려야
      await settle();
      // 진행 중인 도구 하나 — 활동 시각은 실제 시계라 주입한 «직전 알림 시각» 보다 앞이므로, 알림 3 은 진행 중 도구로 나가게 한다.
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: eb.key, kind: "tool", label: "Grep", seq: 22 } } as never);
      wj.__checkinTickForTest(eb.t0 + 33 * MIN); // 알림 3 — 같은 실패를 또 세면 안 된다
      await settle();
      const boundary = sent.slice();
      // ⑯ 실패 하나 뒤 정상 행동 41개 — 목록(40개)에서 밀려나도 오류는 남는다
      wj.__resetJobsForTest();
      const ev41 = fresh("밀려난오류");
      tool(ev41.key, "Bash", "start");
      tool(ev41.key, "Bash", "end", { output: { text: "Error: x", isError: true } });
      for (let i = 0; i < 41; i += 1) {
        getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: ev41.key, kind: "tool", label: "Read", seq: 100 + i } } as never);
        getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: ev41.key, kind: "tool", label: "Read", seq: 100 + i, phase: "end" } } as never);
      }
      sent.length = 0;
      wj.__checkinTickForTest(ev41.t0 + 11 * MIN);
      await settle();
      const evicted = sent.slice();
      // ⑰ 시스템 통지 표식 — 진행 알림은 비서 답이 아니다
      const outs: Array<{ text?: unknown; notice?: unknown }> = [];
      const unsubOut = getEventBus().subscribe((e) => {
        if (e.type === "channel.message.out") outs.push(e.payload as { text?: unknown; notice?: unknown });
      });
      wj.__resetJobsForTest();
      const nt = fresh("통지표식");
      tool(nt.key, "Read", "start");
      tool(nt.key, "Read", "end");
      wj.__checkinTickForTest(nt.t0 + 11 * MIN);
      await settle();
      unsubOut();
      const progressOut = outs.filter((o) => typeof o.text === "string" && (o.text as string).startsWith("⏳"));
      setProgressNoticeSettings({ intervalMinutes: 60 });

      // ⑱ 실제 마지막 활동 — 무활동 점검이 앵커를 밀어도 «새 활동 없음» 은 실제 경과로(간격 180분)
      setProgressNoticeSettings({ intervalMinutes: 180 });
      wj.__resetJobsForTest();
      const an = fresh("앵커");
      tool(an.key, "Read", "start");
      tool(an.key, "Read", "end");
      wj.__checkinTickForTest(an.t0 + 121 * MIN); // 무활동 점검 — 앵커를 now 로 민다
      await settle();
      sent.length = 0;
      wj.__checkinTickForTest(an.t0 + 181 * MIN);
      await settle();
      const anchorNotice = sent.filter((t) => t.startsWith("⏳"));
      setProgressNoticeSettings({ intervalMinutes: 60 });

      // ⑪ 같은 틱 — 무활동 2시간을 넘긴 잡엔 점검만, 진행 알림 없음 + 그 분기에서도 이월
      wj.__resetJobsForTest();
      const st = fresh("굳은잡");
      tool(st.key, "Read", "start");
      getEventBus().publish({ type: "todo.update", ts: Date.now(), payload: { threadKey: st.key, todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] } } as never);
      // 무활동 분기 **전에** 알림을 한 번 보내 둔다 — 그래야 «알림 시각» 이월을 잴 수 있다(둘 다 없음이면 같아 보인다).
      wj.__checkinTickForTest(st.t0 + 61 * MIN);
      await settle();
      // 알림 뒤 성공한 파일 쓰기 하나 — 무활동 분기를 건너도 다음 알림까지 남아야 한다(이월)
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: st.key, kind: "tool", label: "Write", seq: 77 } } as never);
      getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: st.key, kind: "tool", label: "Write", seq: 77, phase: "end" } } as never);
      const evBefore = wj.__checkinEvidenceForTest(st.id);
      sent.length = 0;
      reinjected.length = 0;
      wj.__checkinTickForTest(st.t0 + 122 * MIN);
      await settle();
      const staleProgress = sent.filter((t) => t.startsWith("⏳")).length;
      const staleCheckin = reinjected.length + sent.filter((t) => !t.startsWith("⏳")).length;
      const evAfter = wj.__checkinEvidenceForTest(st.id);

      // ⑫ Edit 실패도 오류로 센다 — 출력 미리보기 제외 목록이 오류 표시까지 지우던 것
      const { buildActivityOutput } = await import("../../core/llm-runtime/adapters/_activity-output.js");
      wj.__resetJobsForTest();
      const ed = fresh("편집실패");
      tool(ed.key, "Edit", "start", { detail: "path=a.ts" });
      tool(ed.key, "Edit", "end", { output: buildActivityOutput("Edit", "Error: old_string not found", true) });
      sent.length = 0;
      wj.__checkinTickForTest(ed.t0 + 61 * MIN);
      await settle();
      const editErr = sent.slice();
      // 플래그 없는 «Error: …» 텍스트 — codex file-ops 의 Edit 실패가 이 모양이다(어댑터가 isError 를 안 옮긴다)
      wj.__resetJobsForTest();
      const ed2 = fresh("편집실패2");
      tool(ed2.key, "Edit", "start");
      tool(ed2.key, "Edit", "end", { output: buildActivityOutput("Edit", "Error: old_string not found") });
      sent.length = 0;
      wj.__checkinTickForTest(ed2.t0 + 61 * MIN);
      await settle();
      const editErrText = sent.slice();
      const editOkPreview = buildActivityOutput("Edit", "Wrote 120 chars");

      // ⑬ 기본값 — 설정이 없으면 켜짐·60분
      const { getPaths } = await import("../../core/paths.js");
      const sf = getPaths().settings;
      const saved = readFileSync(sf, "utf8");
      const rootNoJobs = JSON.parse(saved) as Record<string, unknown>;
      delete rootNoJobs.jobs;
      writeFileSync(sf, JSON.stringify(rootNoJobs));
      const defaults = readProgressNoticeSettings();
      writeFileSync(sf, saved);

      // ⑭ 요약 호출은 내부 단발이다 — 빠지면 요약마다 세션이 목록·검색에 생기고 turn_done 이 다른 관측의 입력이 된다
      const classify = readFileSync(path.join(REPO, "src/core/llm-runtime/classify.ts"), "utf8");
      const sumBody = classify.slice(classify.indexOf("export const summarizeJobProgress"));
      const internalCall = /internal:\s*true/.test(sumBody) && /leanMemory:\s*true/.test(sumBody) && /toolPolicy:\s*\{\s*mode:\s*"none"\s*\}/.test(sumBody);
      const wired = jp.getRegisteredProgressSummarizer === undefined ? false : realSummarizer !== undefined;

      // ⑲ 산출물이 있는데 «진행 없음» — 운영 인스턴스 10-23 실사례 모양 그대로: 할 일은 시작 직후 한 번(0/7)뿐, 두 번째 주기에 커밋 1·파일 쓰기 2가
      //  있었는데 그 사이 Bash 24·BashOutput 15·Grep 7 이 쌓여 커밋 호출은 최근 행동 40개 밖으로 밀리고(그리고 명령 줄은 120자에서 잘려 «git commit» 이 안 보인다),
      //  요약 입력엔 낡은 «할 일 0/7» 만 «지금» 처럼 남았다 → 요약이 «실질적 진행 없음·0/7 그대로». 활동 시각은 실제 시계라 이 구간만 시계를 주입한다.
      const realNow = Date.now;
      let fakeNow = 0;
      wj.__resetJobsForTest();
      const lk = fresh("잠금대기");
      const at = (min: number, fn: () => void): void => {
        fakeNow = lk.t0 + min * MIN;
        Date.now = () => fakeNow;
        try { fn(); } finally { Date.now = realNow; }
      };
      let lseq = 500;
      const call = (label: string, detail?: string, output?: Record<string, unknown>): void => {
        lseq += 1;
        const s = lseq;
        getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: lk.key, kind: "tool", label, seq: s, ...(detail !== undefined ? { detail } : {}) } } as never);
        getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: lk.key, kind: "tool", label, seq: s, phase: "end", ...(output !== undefined ? { output } : {}) } } as never);
      };
      at(3, () => getEventBus().publish({ type: "todo.update", ts: Date.now(), payload: { threadKey: lk.key, todos: Array.from({ length: 7 }, (_, i) => ({ content: `단계 ${i + 1}`, status: "pending" })) } } as never));
      at(10, () => call("Read", "path=src/a.ts"));
      sent.length = 0;
      summarizerImpl = async () => "요약: 코드를 읽는 중입니다.";
      const promptsBefore1 = prompts.length;
      wj.__checkinTickForTest(lk.t0 + 61 * MIN); // 알림 1 — 할 일은 이 구간에 적힌 것(낡지 않음)
      await settle();
      const lkPrompt1 = prompts.slice(promptsBefore1).pop() ?? "";
      // 경계 — 갱신 시각 == 구간 시작이면 신선하다(요약 입력에 남는다), 그보다 1ms 앞이면 낡았다(안 실린다)
      const pAt = (todosAt: number): string => jp.buildProgressPrompt({
        label: "x", task: "x", elapsedMs: 0, actions: [], todos: [{ content: "신선", status: "in_progress" }], language: "한국어",
        now: 5000, lastActivityAt: 5000, inFlight: [], errors: 0, todosAt, since: 1000,
      });
      // 커밋 — 셋이 다 있어야 센다(git commit 명령 + 출력의 요약 줄 + 오류 아님). 진짜 셋(둘째는 커밋 뒤 명령이 실패 — 커밋은 됐다 · 전역 옵션 -C·-c):
      at(70, () => call("Bash", "command=git add src/x.ts && git commit -m \"작업 3\"", { text: "[main a1b2c3d] 작업 3\n 2 files changed, 10 insertions(+)\n\nexit code: 0" }));
      at(70.2, () => call("Bash", "command=git -C ../repo commit -m \"작업 4\" && npm test", { text: "[dev 0f1e2d3] 작업 4\n 1 file changed\nnpm ERR! Test failed\n\nexit code: 1" }));
      at(70.3, () => call("Bash", "command=git -c user.name=x commit -m \"작업 5\"", { text: "[main 4444444] 작업 5" }));
      // 아닌 것(GPT R1 재현 모양): 실패(종료 1 · 오류 플래그 없음) · 요약 줄 모양을 찍는 조회 · 명령 줄이 잘려 «git commit» 이 안 보임 · 오류 플래그
      at(70.4, () => call("Bash", "command=git commit --dry-run", { text: "stdout:\nOn branch main\nnothing to commit\n\nexit code: 1" }));
      at(70.5, () => call("Bash", "command=git log -1 --format='[main %h] %s'", { text: "[main a1b2c3d] 작업 3\n\nexit code: 0" }));
      at(70.55, () => call("Bash", "command=git log -1 --format='[main %h] git commit'", { text: "[main 8a9f9c4] git commit\n\nexit code: 0" })); // 인용 안의 «git commit»(GPT R2)
      at(70.57, () => call("Bash", "command=npm test, description=run tests before git commit", { text: "[main 1111111] x" })); // 설명 글의 «git commit»
      at(70.58, () => call("Bash", "command=echo \"done; git commit later\"", { text: "[main 2222222] y" })); // 따옴표 안의 «; git commit»
      at(70.59, () => call("Bash", "command=git -C commit log -1 --format='[main %h] %s'", { text: "[main 54eff33] fixture" })); // 옵션 값 «commit»(GPT R3)
      at(70.6, () => call("Bash", "command=jj commit -m x", { text: "[main 3333333] x" })); // git 이 아닌 도구의 commit
      at(70.6, () => call("Bash", `command=cd /Users/someone/${"very-long-directory/".repeat(8)}repo && git add . && git commit -m x`.slice(0, 160), { text: "[main 9a8b7c6] x" }));
      at(70.7, () => call("Bash", "command=git commit -m x", { text: "Error: nothing to commit", isError: true }));
      // 파일 쓰기: 성공 둘(접두 붙은 MCP 이름표 포함) · 실패 하나는 안 센다
      at(71, () => call("Write", "path=src/x.ts"));
      at(72, () => call("mcp__file-ops__Edit", "path=src/y.ts"));
      at(72.5, () => call("Edit", "path=src/z.ts", { text: "Error: old_string not found", isError: true }));
      for (let i = 0; i < 24; i += 1) at(73 + i, () => call("Bash", `command=git status --short # ${i}`));
      for (let i = 0; i < 15; i += 1) at(97 + i, () => call("BashOutput", "bash_id=bash_lock"));
      for (let i = 0; i < 7; i += 1) at(112 + i, () => call("Grep", "pattern=lock"));
      const promptsBefore2 = prompts.length;
      summarizerImpl = async () => "요약: 실질적 구현 진행 없음, 할 일 0/7 그대로입니다.";
      wj.__checkinTickForTest(lk.t0 + 121 * MIN); // 알림 2 — 커밋 1·쓰기 2가 있었던 구간
      await settle();
      const lkPrompt = prompts.slice(promptsBefore2).pop() ?? "";
      const lkNotice = sent.filter((t) => t.startsWith("⏳")).pop() ?? "";
      // 알림 3 — 그 뒤 산출이 없으면 사실 줄도 없다(센 것은 알림마다 비운다 — 같은 커밋을 다음 알림에 또 세지 않는다)
      at(125, () => call("Read", "path=src/z.ts"));
      wj.__checkinTickForTest(lk.t0 + 181 * MIN);
      await settle();
      const lkNotice3 = sent.filter((t) => t.startsWith("⏳")).pop() ?? "";

      // ⑲‴ 경계 — 알림 전에 시작해 알림 뒤 성공한 커밋도 다음 알림에 든다(시작 행동이 없는 구간이어도 — GPT R1: 빈 알림 판정에 걸려 버려졌다)
      wj.__resetJobsForTest();
      const bd = fresh("경계커밋");
      const bseq = 900;
      at(10, () => getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: bd.key, kind: "tool", label: "Bash", seq: bseq, detail: "command=git commit -m y" } } as never));
      wj.__checkinTickForTest(bd.t0 + 61 * MIN); // 알림 1 — 진행 중 도구(아직 커밋 전)
      await settle();
      at(70, () => getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: bd.key, kind: "tool", label: "Bash", seq: bseq, phase: "end", output: { text: "[main 1234567] y" } } } as never));
      sent.length = 0;
      wj.__checkinTickForTest(bd.t0 + 121 * MIN); // 알림 2 — 그 커밋이 실려야
      await settle();
      const boundaryCommit = sent.filter((t) => t.startsWith("⏳"));

      // ⑳ 비율은 부정이 아니다(2026-10-23 재조정) — 산출이 있는 구간에서 «3/4 통과» 요약은 버려지고 «4건 중 3건 통과» 는 남던 갈림(실모델 근사: haiku·luna).
      //  버려도 기계 요약이 같은 «3/4» 를 싣는다. 사례 둘: A = 낡은 할 일 0/7 + 커밋 3·쓰기 2(운영 인스턴스 실사례) · B = 신선한 할 일 3/4 + 도구 출력 «3/4 통과».
      const cA = {
        jobId: "ca", name: "A", task: "x", elapsedMs: 121 * MIN, language: "한국어", now: 121 * MIN, lastActivityAt: 118 * MIN, inFlight: [], errors: 0,
        actions: [{ at: 115 * MIN, tool: "Grep", detail: "pattern=lock" }], todos: Array.from({ length: 7 }, (_, i) => ({ content: `단계 ${i + 1}`, status: "pending" })),
        outputs: { writes: 2, commits: 3 }, todosAt: 3 * MIN, since: 61 * MIN,
      };
      const cB = {
        ...cA, jobId: "cb", name: "B", lastActivityAt: 90 * MIN, outputs: { writes: 1, commits: 1 }, todosAt: 92 * MIN,
        actions: [{ at: 90 * MIN, tool: "Bash", detail: "command=node verify.mjs  # 결과: 3/4 통과, 1건 시한 초과" }],
        todos: [{ content: "원인 재현", status: "completed" }, { content: "수정", status: "completed" }, { content: "회귀 추가", status: "completed" }, { content: "검증", status: "in_progress", activeForm: "검증하는 중" }],
      };
      const composeWith = async (input: typeof cA, text: string): Promise<{ text: string; summarized: boolean } | null> => {
        summarizerImpl = async () => text;
        return jp.composeProgressNotice(input as never);
      };
      const keptCases: Array<[typeof cA, string]> = [
        [cB, "job-progress.ts를 수정하고 회귀 검증 및 커밋을 완료했습니다. 검증 결과 3/4 통과했으나 1건이 시한 초과 오류가 있으며, 한동안 새 활동이 없습니다."],
        [cB, "`verify.mjs` 결과는 4건 중 3건 통과, 1건 시한 초과였습니다."],
        [cA, "10/23 일정 문서를 고친 뒤 lock 패턴을 찾고 있습니다."],
        // ⑳'' «그대로»·«unchanged» 가 진척이 아니라 «기존 동작 유지» 를 말하는 정상 설명(2026-10-23 릴리스 검토 P3 — 쓰기 1·커밋 0 그대로 재현)
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "기존 기능은 그대로 유지하면서 취소 시 완료 보고가 누락되는 오류를 수정했습니다."],
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "The public API is unchanged; cancellation now delivers the completion report."],
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "할 일 목록은 그대로 두고 회귀 검사를 추가했습니다."],
        // ⑳''' 상태·status 는 진척 주어가 아니다 · 비율은 쉼표 너머를 안 본다(GPT R1 결함 2 + 형제)
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "The HTTP status is unchanged; cancellation now delivers the completion report."],
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "HTTP 상태 코드는 그대로 유지되고, 취소 시 완료 보고가 나가도록 고쳤습니다."],
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "3/4 tests pass, API unchanged otherwise."],
        [{ ...cA, jobId: "ck", outputs: { writes: 1, commits: 0 } }, "The completion report has remained unchanged; added a retry test."],
      ];
      // 커밋 없이 파일 쓰기만 있는 구간도 산출이다(변이 사냥 E: 가드를 «커밋 있을 때만» 으로 좁혀도 초록이었다 — 버림 사례가 전부 커밋 3이었다)
      const cW = { ...cA, jobId: "cw", outputs: { writes: 1, commits: 0 } };
      const droppedCases: Array<[typeof cA, string]> = [
        [cW, "요약: 실질적 구현 진행 없음, 할 일 0/7 그대로입니다."],
        [cA, "요약: 실질적 구현 진행 없음, 할 일 0/7 그대로입니다."],
        [cA, "같은 대기 작업을 반복 중이며 새로운 진전이 보이지 않습니다."],
        [cA, "Still at 0/7 — searching for lock."],
        [cA, "No real progress; waiting on bash_lock."],
        // ⑳'' 진척을 가리키는 «그대로»·«unchanged» 는 «진행 없음» 없이 단독으로 와도 여전히 버린다(P3 를 좁히며 지킬 계약)
        [cA, "할 일 0/7 그대로입니다. lock 패턴을 찾는 중입니다."],
        [cA, "Progress unchanged — to-dos still 0/7."],
        [cA, "To-do list unchanged at 0/7."],
        [cA, "Remains unchanged at 0/7 after the lock wait."],
        // ⑳''' 진척 주어면 «그대로 유지·남아» 도 정체다 · completion 바로 뒤 unchanged 도(GPT R1 결함 1)
        [cA, "진행률은 0/7 그대로 유지되고 있습니다."],
        [cA, "진척은 그대로 남아 있습니다."],
        [cA, "Completion remains unchanged — waiting on bash_lock."],
        [cA, "Completion has remained unchanged — waiting on bash_lock."], // GPT R2 — 완료형도
      ];
      const kept: Array<{ t: string; r: { text: string; summarized: boolean } | null }> = [];
      for (const [i, t] of keptCases) kept.push({ t, r: await composeWith(i, t) });
      const dropped: Array<{ t: string; r: { text: string; summarized: boolean } | null }> = [];
      for (const [i, t] of droppedCases) dropped.push({ t, r: await composeWith(i, t) });

      const errLine = (t: string | undefined): boolean => /오류로 끝났습니다|ended in an error/.test(t ?? "");
      const todoNowLine = (p: string): string => p.split("\n").find((l) => /^(할 일|To-dos) \d+\/\d+/.test(l)) ?? "";
      return [
        assert(
          "★★⑲ 산출물(커밋·파일 쓰기)은 하네스가 센 사실로 알림에 붙고(커밋 호출이 최근 행동 40개 밖이어도), 그와 부딪히는 요약(«진행 없음·0/7 그대로»)은 버려 기계 요약(낡은 할 일엔 «마지막 갱신»)이 나간다 · 커밋은 `git commit` 실행(명령 머리 — 인용·설명 글 제외)+요약 줄+오류 아님일 때만(드라이런·`git log` 요약 줄 모양·인용 안 «git commit»·잘린 명령 줄·오류는 안 셈, 커밋 뒤 명령의 실패는 셈) · 실패한 쓰기 안 셈",
          /커밋 3건|commits 3\b/.test(lkNotice) && /파일 쓰기 2건|file writes 2\b/.test(lkNotice) && errLine(lkNotice) &&
            !/진행 없음|그대로/.test(lkNotice) && /마지막 갱신|last updated/.test(lkNotice),
          lkNotice.split("\n"),
        ),
        assert(
          "★★⑳ 산출이 있는 구간에서 비율(«3/4 통과»·«4건 중 3건»·날짜 «10/23»)만 담은 요약은 그대로 나간다(비율은 부정이 아니다) · 산출 사실 줄도 붙는다 · ⑳'' «기존 기능은 그대로 유지하면서 …수정»·«The public API is unchanged; …»·«할 일 목록은 그대로 두고» 같은 정상 설명도 나간다(P3)",
          kept.every(({ t, r }) => r !== null && r.summarized && r.text.includes(t) && /결과물|file writes/.test(r.text)),
          kept.map(({ r }) => ({ summarized: r?.summarized, text: r?.text.split("\n") })),
        ),
        assert(
          "★★⑳' 산출 사실과 부딪히는 요약(«진행 없음·0/7 그대로»·«진전이 보이지 않»·«still at 0/7»·«no real progress» · ⑳'' 진척 주어에 붙은 «0/7 그대로»·«Progress unchanged»·«unchanged at 0/7» 단독)은 여전히 버려 기계 요약 — 커밋 없이 파일 쓰기만 있어도 · 낡은 할 일엔 «마지막 갱신» · 산출 사실 줄",
          dropped.every(({ t, r }) => r !== null && !r.summarized && !r.text.includes(t) && /마지막 갱신|last updated/.test(r.text) && /결과물|file writes/.test(r.text)) &&
            /파일 쓰기 1건|file writes 1\b/.test(dropped[0]?.r?.text ?? "") && /커밋 3건|commits 3\b/.test(dropped[1]?.r?.text ?? ""),
          dropped.map(({ r }) => ({ summarized: r?.summarized, text: r?.text.split("\n") })),
        ),
        assert(
          "★⑲⁗ 신선한 할 일(그 구간에 갱신됨)은 요약 입력에 그대로 남는다 — 갱신 시각 == 구간 시작도 신선 · 1ms 앞이면 낡음",
          /^(할 일|To-dos) 0\/7/m.test(lkPrompt1) && /신선/.test(pAt(1000)) && !/신선/.test(pAt(999)),
          { 첫알림할일: todoNowLine(lkPrompt1), 같음: /신선/.test(pAt(1000)), 앞: /신선/.test(pAt(999)) },
        ),
        assert(
          "★⑲‴ 알림 전에 시작해 알림 뒤 성공한 커밋도 다음 알림에 «커밋 1» 로 든다(그 구간에 시작 행동이 없어도)",
          boundaryCommit.length === 1 && /커밋 1건|commits 1\b/.test(boundaryCommit[0] ?? ""),
          boundaryCommit.map((t) => t.split("\n")),
        ),
        assert(
          "⑲'' 다음 알림은 그 뒤 산출만 센다 — 산출이 없으면 사실 줄이 없다(같은 커밋을 두 번 세지 않는다)",
          lkNotice3 !== lkNotice && lkNotice3.startsWith("⏳") && !/결과물|Since the last update: file writes/.test(lkNotice3),
          lkNotice3.split("\n"),
        ),
        assert(
          "★⑲' 요약 입력에도 그 사실이 실리고, 그 구간에 갱신 없는 할 일(0/7)은 요약 입력에 안 실린다(지금 상태처럼 쓰지 못하게)",
          /커밋 3건/.test(lkPrompt) && /파일 쓰기 2건/.test(lkPrompt) && todoNowLine(lkPrompt) === "" && !/0\/7/.test(lkPrompt),
          { 할일줄: todoNowLine(lkPrompt), 사실줄: lkPrompt.split("\n").filter((l) => /커밋|파일 쓰기/.test(l)) },
        ),
        assert(
          "★⑮ 알림 전에 시작해 알림 뒤 실패한 호출도 다음 알림에 든다 · 다음 주기엔 두 번 안 센다",
          boundary.length === 3 && !errLine(boundary[0]) && errLine(boundary[1]) && !errLine(boundary[2]),
          boundary.map((t) => t.split("\n").slice(-1)[0]),
        ),
        assert(
          "★⑯ 실패 뒤 정상 행동이 40개를 넘어 목록에서 밀려나도 오류는 남는다",
          evicted.length === 1 && errLine(evicted[0]),
          evicted[0]?.split("\n"),
        ),
        assert(
          "★⑰ 진행 알림은 시스템 통지로 나간다(channel.message.out notice:true) — 비서 답과 구분",
          progressOut.length === 1 && progressOut[0]!.notice === true,
          progressOut.map((o) => ({ notice: o.notice })),
        ),
        assert(
          "★⑨ 진행 중인 긴 도구는 첫 알림 뒤에도 주기마다 알리고 «진행 중인 도구» 를 붙인다",
          longTool.length === 2 && longTool.every((t) => /진행 중인 도구|Still running/.test(t) && t.includes("Bash")) && longToolPrompts === 1 &&
            !longTool.some((t) => /최근 행동 0건|0 recent actions/.test(t)),
          { 끝줄: longTool.map((t) => t.split("\n").slice(-1)[0]), 요약호출: longToolPrompts },
        ),
        assert("⑩ 도구 행동 없이 글만 쓰는 잡엔 빈 알림을 보내지 않는다", textOnly === 0, { 알림: textOnly }),
        assert(
          "⑱ 무활동 점검이 앵커를 밀어도 «새 활동 없음» 은 실제 마지막 활동 기준(약 3시간)",
          // 머리줄의 경과(«3 h 1 min째») 말고 **«새 활동 없음» 줄**에서 잰다 — 머리줄에 맞으면 앵커를 읽어도 초록이었다.
          anchorNotice.length === 1 &&
            /(3시간|3 h)/.test((anchorNotice[0] ?? "").split("\n").find((l) => /새 활동이 없습니다|No new activity/.test(l)) ?? ""),
          anchorNotice[0]?.split("\n"),
        ),
        assert(
          "★⑪ 무활동 2시간을 넘긴 잡엔 점검만 나가고 진행 알림은 없다 · 그 분기에서도 최근 행동·할 일(갱신 시각 포함)·산출 수·표식·알림 시각이 이월된다",
          staleProgress === 0 && staleCheckin > 0 && evBefore !== undefined && evAfter !== undefined &&
            evAfter.recent === evBefore.recent && evAfter.todos === 2 && evAfter.activeSinceProgress === evBefore.activeSinceProgress &&
            evBefore.todosAt !== undefined && evAfter.todosAt === evBefore.todosAt && evBefore.outputs === "1/0" && evAfter.outputs === "1/0" &&
            evBefore.lastProgressAt !== undefined && evAfter.lastProgressAt === evBefore.lastProgressAt,
          { 진행알림: staleProgress, 점검: staleCheckin, 전: evBefore, 후: evAfter },
        ),
        assert(
          "★⑫ Edit 실패도 오류 건수에 든다(성공 미리보기는 여전히 뺀다)",
          editErr.length === 1 && /오류|error/i.test(editErr[0]!.split("\n").slice(-1)[0] ?? "") && editOkPreview === undefined &&
            editErrText.length === 1 && /오류로 끝났습니다|ended in an error/.test(editErrText[0] ?? ""),
          { 본문: editErr[0]?.split("\n"), 성공미리보기: editOkPreview },
        ),
        assert("⑬ 설정이 없으면 켜짐·60분", defaults.enabled === true && defaults.intervalMinutes === 60, defaults),
        assert("⑭ 요약 호출은 내부 단발(internal·leanMemory·도구 0) · 요약기가 부팅 때 주입돼 있다", internalCall && wired, { internalCall, wired }),
        assert(
          "★① 활동이 있는 최상위 매니저는 주기가 되면 한 번 알린다 — 주기 전·같은 주기의 두 번째 틱은 조용하다",
          before === 0 && first.length === 1 && afterSecond === 1 && first[0]!.includes("진행대상") && first[0]!.includes("자료를 모으는 중") &&
            prompts.some((p) => p.includes("WebSearch") && p.includes("수익 모델") && p.includes("마지막 활동")),
          { 주기전: before, 알림: first.length, 두번째틱뒤: afterSecond, 본문: first[0]?.slice(0, 80) },
        ),
        assert(
          "★①'' 마지막 활동이 오래됐으면 요약이 «모으는 중» 이라 해도 하네스가 «새 활동 없음» 줄을 붙인다(정체를 진행으로 포장 금지)",
          /새 활동이 없습니다|No new activity/.test(first[0] ?? ""),
          first[0]?.split("\n"),
        ),
        assert(
          "★①' 두 관문을 따로 잰다 — 새 활동이 있어도 주기 전엔 조용 · 주기가 와도 그 사이 활동이 없으면 조용",
          afterSecond === 1 && hFirst === 1 && hIdle === 1,
          { 시각관문: afterSecond, 활동관문첫: hFirst, 활동관문둘째: hIdle },
        ),
        assert("★② 활동이 없으면 알리지 않는다", quiet === 0, { 알림: quiet }),
        assert(
          "③ 요약이 실패하면 기계 요약이 나간다(최근 행동이 실린다)",
          mech.length === 1 && mech[0]!.includes("Read") && mech[0]!.includes("보고서.md"),
          mech[0]?.slice(0, 120),
        ),
        assert(
          "★④ 오류로 끝난 행동은 요약이 «순조롭다» 고 해도 하네스가 오류 줄을 붙인다",
          withErr.length === 1 && /오류|error/i.test(withErr[0]!.split("\n").slice(-1)[0] ?? ""),
          withErr[0]?.split("\n"),
        ),
        assert(
          "★⑤ 매니저·메인 컨텍스트 무변경 — 재주입 0 · 그 잡의 steering 큐 0",
          reinjectedByProgress === 0 && steerQueued === 0,
          { 재주입: reinjectedByProgress, steering: steerQueued },
        ),
        assert("★⑥ 요약을 만드는 사이 잡이 끝나면 그 알림은 버린다", lateProgress === 0, { 늦은알림: lateProgress }),
        assert(
          "★⑦ 설정 — 끄면 안 나가고, 간격 90분이면 61분엔 조용·91분에 나간다, 범위 밖 간격은 거절",
          whenOff === 0 && at61 === 0 && at91 === 1 && rejected && readProgressNoticeSettings().intervalMinutes === 60,
          { 꺼짐: whenOff, 분61: at61, 분91: at91, 범위밖거절: rejected },
        ),
        assert(
          "⑧ 서브에이전트·스케줄이 띄운 매니저엔 안 나간다 · 사용자 대화 판정은 내부 접두 상수에서 파생",
          offTarget === 0 && isUserConversationThread("dashboard:x") && !isUserConversationThread("scheduler:1") &&
            !isUserConversationThread("worker:1") && !isUserConversationThread("dashboard:x::sub::y"),
          { 알림: offTarget },
        ),
      ];
    } finally {
      jp.registerProgressSummarizer(realSummarizer);
      unregisterChannelOutbound("regr-progress");
      wj.__resetJobsForTest();
    }
  },
};

export default check;
