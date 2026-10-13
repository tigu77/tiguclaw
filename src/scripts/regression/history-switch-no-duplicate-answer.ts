/**
 * 회귀: **답이 온 세션을 눌러 들어가도 같은 답이 두 번 뜨지 않는다** (2026-10-13 정태님:
 *  «응답이 와서 세션을 눌러서 들어가니까 2개가 떠있던 상황 · 새로고침하면 하나만 남는다»).
 *
 * 사고(코드 추적): 탭 전환은 이력을 다시 받고, 그 세션이 진행 중으로 표시돼 있으면 **마지막 활동
 *  묶음**을 진행 중 턴으로 보고 실시간 경로로 다시 그린다. 답이 끝났는데도 표시가 켜져 있으면
 *  (작업 완료 보고 턴이 줄을 섰거나 막 시작해 아직 활동이 없을 때) 끝난 턴의 **답 조각**이 떼어졌다 —
 *  이력은 짝 조각을 잃어 chat_log 답 행을 중복으로 못 지우고 말풍선으로 그렸고, 떼어 간 조각도
 *  실시간 경로가 또 그렸다. 새로고침에선 진행 중 표시가 없어 하나만 보였다.
 *
 * 재는 것 — 판정(`splitLiveResume`)과 이력 병합(`groupMergedItems`)을 **실제로 같이 돌려**
 *  화면에 그려질 답의 수를 센다(이력의 텍스트·답 행 유닛 + 실시간으로 넘긴 텍스트 조각):
 *  ① 끝난 턴 + 진행 중 표시(다음 턴은 아직 활동 없음) → 답 1개, 실시간 0
 *  ② 대조 — 진행 중 표시가 없으면 답 1개
 *  ③ 진짜 진행 중 턴(답 행 뒤 활동)은 그대로 실시간으로 넘긴다 — 끝난 턴의 답은 1개
 *  ①' 끝난 턴이 둘 — «마지막» 답을 본다(적대 검토 F1)
 *  ④ 진행 턴 중간의 평범한 비서 행(스케줄 배달·매니저 실패 보고)이 사라지지 않는다(적대 검토 F2)
 *  ⑤⑥ 마지막 조각 뒤에 답 행이 없으면(선택지·통지·첨부뿐이어도) 아직 진행 중
 *
 * 등급: **동작**.
 */
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Act = { ts: number; threadKey: string; kind?: string; seq: number; text?: string };
type Entry = { ts: number; role: string; threadKey: string; text: string; kind?: string; notice?: boolean; attachments?: unknown[] };
type Unit = { kind: string; act?: { text?: string }; entry?: Entry; acts?: Act[] };

const TK = "dashboard:regr-dup";
const ANSWER = "정리했습니다 — 회귀 답";

export const check: RegressionCheck = {
  name: "history-switch-no-duplicate-answer",
  guards: "답이 온 세션을 눌러 들어가면 같은 답이 연속으로 두 번 뜨던 것(새로고침하면 하나)",
  run: async (): Promise<Assertion[]> => {
    const read = (n: string): Promise<string> =>
      readFile(new URL(`../../../packages/dashboard/js/${n}`, import.meta.url), "utf8");
    const tabs = await read("tabs.js");
    const hist = await read("history-render.js");
    const sp = /const splitLiveResume = \([\s\S]*?\n {6}\};/.exec(tabs);
    const gm = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(hist);
    const cb = /const canonicalBodyFor = \([\s\S]*?\n {6}\};/.exec(hist);
    const ctx: {
      split?: (a: Act[], e: Entry[], on: boolean) => { hist: Act[]; live: Act[] };
      group?: (e: Entry[], a: Act[]) => Unit[];
    } = {};
    if (sp !== null && gm !== null && cb !== null) {
      vm.createContext(ctx);
      vm.runInContext(
        `const renderedMsgKeys = new Set();
         const msgKey = (ts, role) => ts + "|" + role;
         ${cb[0]}
         ${gm[0]}
         ${sp[0]}
         this.group = groupMergedItems; this.split = splitLiveResume;`,
        ctx,
      );
    }
    /** 화면에 그려질 «이 답» 의 수 — 이력 유닛 + 실시간으로 넘긴 텍스트 조각. */
    const shown = (entries: Entry[], acts: Act[], active: boolean, answer = ANSWER): { n: number; live: number } => {
      if (ctx.split === undefined || ctx.group === undefined) return { n: -1, live: -1 };
      const { hist: h, live } = ctx.split(acts, entries, active);
      const units = ctx.group(entries, h);
      const inHist = units.filter(
        (u) => (u.kind === "text" && u.act?.text === answer) || (u.kind === "msg" && u.entry?.role === "assistant" && u.entry.text === answer),
      ).length;
      const inLive = live.filter((a) => a.kind === "text" && a.text === answer).length;
      return { n: inHist + inLive, live: live.length };
    };

    // 끝난 턴: 사용자 → 도구 둘 → 답 조각 → 답 행
    const doneTurn: Act[] = [
      { ts: 110, threadKey: TK, kind: "tool", seq: 0 },
      { ts: 120, threadKey: TK, kind: "tool", seq: 1 },
      { ts: 130, threadKey: TK, kind: "text", seq: 2, text: ANSWER },
    ];
    const entries: Entry[] = [
      { ts: 100, role: "user", threadKey: TK, text: "회귀 질문" },
      { ts: 131, role: "assistant", threadKey: TK, text: ANSWER },
    ];
    const r1 = shown(entries, doneTurn, true);
    const r2 = shown(entries, doneTurn, false);

    // ①' 끝난 턴이 둘 — «마지막» 답을 본다(적대 검토 F1: 첫 답 행을 써도 통과하던 그물)
    const A1 = "첫 턴 답";
    const two: Act[] = [
      { ts: 50, threadKey: TK, kind: "tool", seq: 0 },
      { ts: 60, threadKey: TK, kind: "text", seq: 1, text: A1 },
      ...doneTurn,
    ];
    const twoEntries: Entry[] = [
      { ts: 40, role: "user", threadKey: TK, text: "첫 질문" },
      { ts: 61, role: "assistant", threadKey: TK, text: A1 },
      ...entries,
    ];
    const r1b = shown(twoEntries, two, true);
    const r1bFirst = shown(twoEntries, two, true, A1);

    // ③ 다음 턴이 실제로 돌고 있다(답 행 뒤 활동, seq 가 다시 0부터)
    const running: Act[] = [...doneTurn, { ts: 200, threadKey: TK, kind: "tool", seq: 0 }, { ts: 210, threadKey: TK, kind: "tool", seq: 1 }];
    const r3 = shown(entries, running, true);

    // ④ ★진행 턴 중간의 **평범한 비서 행**(스케줄 배달·매니저 실패 보고 — notice 표식 없음)은 턴의 끝이 아니다
    //  (적대 검토 F2): 진행 턴이 텍스트 조각으로 시작했으면, 끝으로 세는 순간 그 행이 «조각의 중복» 으로 버려졌다.
    const SCHED = "⏰ 스케줄 배달 — 회귀";
    const runningWithText: Act[] = [
      ...doneTurn,
      { ts: 200, threadKey: TK, kind: "text", seq: 0, text: "살펴볼게요" },
      { ts: 210, threadKey: TK, kind: "tool", seq: 1 },
      { ts: 230, threadKey: TK, kind: "tool", seq: 2 },
    ];
    const midEntries: Entry[] = [...entries, { ts: 190, role: "user", threadKey: TK, text: "다음 질문" }, { ts: 220, role: "assistant", threadKey: TK, text: SCHED }];
    const r4 = shown(midEntries, runningWithText, true, SCHED);

    // ⑤ 진행 턴의 마지막 활동이 텍스트 조각이어도 **답 행이 아직 없으면** 진행 중이다(«텍스트면 끝» 으로 좁히는 편집을 막는다)
    const runningEndsText: Act[] = [...doneTurn, { ts: 200, threadKey: TK, kind: "tool", seq: 0 }, { ts: 210, threadKey: TK, kind: "text", seq: 1, text: "중간 말" }];
    const r5 = shown(entries, runningEndsText, true, "중간 말");

    // ⑥ 선택지·통지·첨부 행은 답이 아니다 — 마지막 조각(210) **뒤에** 그것만 있으면 아직 진행 중
    const nonAnswerRows: Entry[] = [
      { ts: 215, role: "assistant", threadKey: TK, text: "선택지", kind: "prompt.options" },
      { ts: 216, role: "assistant", threadKey: TK, text: "⏳ 통지", notice: true },
      { ts: 217, role: "assistant", threadKey: TK, text: "", attachments: [{ rel: "x" }] },
    ];
    const r6 = shown([...entries, ...nonAnswerRows], runningEndsText, true, "중간 말");

    return [
      assert("판정과 병합을 실제로 뽑아 돌렸다(문자열 검사 아님)", ctx.split !== undefined && ctx.group !== undefined, sp === null ? "★splitLiveResume 추출 실패" : "OK"),
      assert(
        "★① 답이 끝난 세션이 진행 중으로 표시돼 있어도(다음 턴 아직 활동 없음) 답은 한 번만 뜬다",
        r1.n === 1 && r1.live === 0,
        r1,
      ),
      assert("② 대조 — 진행 중 표시가 없으면 답은 한 번", r2.n === 1 && r2.live === 0, r2),
      assert("★①' 끝난 턴이 둘이어도 «마지막» 답을 본다 — 각 답이 한 번씩", r1b.n === 1 && r1bFirst.n === 1 && r1b.live === 0, { 마지막: r1b, 첫: r1bFirst }),
      assert("★③ 진짜 진행 중 턴의 활동은 실시간으로 넘기고, 끝난 턴의 답은 한 번", r3.n === 1 && r3.live === 2, r3),
      assert("★④ 진행 턴 중간의 평범한 비서 행(스케줄 배달 등)은 사라지지 않고, 진행 턴은 통째로 실시간", r4.n === 1 && r4.live === 3, r4),
      assert("⑤ 마지막 활동이 텍스트여도 답 행이 아직 없으면 진행 중 — 실시간으로 넘긴다", r5.live === 2 && r5.n === 1, r5),
      assert("⑥ 선택지·통지·첨부 행은 답이 아니다 — 진행 중으로 남는다", r6.live === 2, r6),
    ];
  },
};

export default check;
