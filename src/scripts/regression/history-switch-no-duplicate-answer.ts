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
import { stepSuggestionStream } from "../../core/llm-runtime/adapters/_delta-stream.js";
import { extractInlineSuggestion } from "../../core/next-message-suggestion.js";
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Act = { ts: number; threadKey: string; kind?: string; seq: number; text?: string; model?: string; reasoning?: string; spend?: unknown; turnId?: string };
type Entry = { ts: number; role: string; threadKey: string; text: string; kind?: string; notice?: boolean; attachments?: unknown[]; model?: string; reasoning?: string; spend?: unknown; turnId?: string };
type Unit = { kind: string; act?: Act; entry?: Entry; acts?: Act[]; reasoning?: string };

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

    // F4: 마지막 텍스트와 완료 답이 같은 밀리초. 탭 전환/새로고침 둘 다 잰다.
    const tiedEntries = [entries[0]!, { ...entries[1]!, ts: 130 }];
    const tiedActive = shown(tiedEntries, doneTurn, true);
    const tiedInactive = shown(tiedEntries, doneTurn, false);
    const group = (e: Entry[], a: Act[]): Unit[] => ctx.group?.(e, a) ?? [];
    const tiedUnits = group(tiedEntries, doneTurn);
    const laterUnits = group(entries, doneTurn); // 시각이 다른 대조군: 유닛 전체가 같아야 한다.
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

    const model = "test:model";
    const spend = { usd: 0.25 };
    const full = "완성된 정본 본문";
    const canonicalEntries: Entry[] = [entries[0]!, {
      ts: 130, role: "assistant", threadKey: TK, text: full,
      model, reasoning: "high", spend, turnId: "turn-f4",
    }];
    const canonicalActs: Act[] = [
      { ts: 110, threadKey: TK, kind: "tool", seq: 0, model },
      { ts: 130, threadKey: TK, kind: "text", seq: 1, text: "완성된…", model },
    ];
    const canonical = group(canonicalEntries, canonicalActs);
    const promoted = canonical.find((u) => u.kind === "text")?.act;

    // 같은 ms 사용자 행은 활동보다 먼저: 앞 턴의 강도를 새 턴으로 넘기거나 그 반대가 되면 안 된다.
    const boundaryEntries: Entry[] = [
      { ts: 130, role: "user", threadKey: TK, text: "새 질문" },
      canonicalEntries[1]!,
    ];
    const boundary = group(boundaryEntries, canonicalActs);
    const sameTimeTool = { ...canonicalActs[0]!, ts: 130 };
    const userFirst = group(boundaryEntries, [sameTimeTool, canonicalActs[1]!]);
    // 답→사용자 행 순서까지 뒤집는 단순 역할 우선 정렬도 막는다.
    const answerBeforeUser = group([canonicalEntries[1]!, boundaryEntries[0]!], canonicalActs);

    const attachment: Entry = { ts: 130, role: "assistant", threadKey: TK, text: "파일", attachments: [{ rel: "f4.txt" }] };
    const options: Entry = { ts: 130, role: "assistant", threadKey: TK, text: "선택", kind: "prompt.options" };
    const visible = group([entries[0]!, attachment, options, canonicalEntries[1]!], canonicalActs);
    const otherThread = "dashboard:other";
    const foreign = group([{ ...canonicalEntries[1]!, threadKey: otherThread }], canonicalActs);
    const foreignTool = group(canonicalEntries, [{ ...canonicalActs[0]!, threadKey: otherThread }, canonicalActs[1]!]);
    const segments: Act[] = [
      { ts: 110, threadKey: TK, kind: "text", seq: 0, text: "앞부분" },
      { ts: 120, threadKey: TK, kind: "tool", seq: 1, model },
      { ts: 130, threadKey: TK, kind: "text", seq: 2, text: "뒷부분" },
    ];
    const multi = group([{ ...canonicalEntries[1]!, text: "앞부분\n뒷부분" }], segments);
    const chronologicalEntries: Entry[] = [
      { ts: 90, role: "assistant", threadKey: TK, text: "이전 답" },
      entries[0]!, entries[1]!,
      { ts: 140, role: "user", threadKey: TK, text: "다음 질문" },
    ];
    const chronological = group(chronologicalEntries, doneTurn);

    // 검토 재현: 답1의 완료 시각이 다음 턴의 첫 활동과 같아도 턴을 넘지 않는다.
    const firstAnswer: Entry = { ...canonicalEntries[1]!, text: "답1", turnId: "t1" };
    const secondAnswer: Entry = { ...canonicalEntries[1]!, ts: 151, text: "답2", reasoning: "low", spend: { usd: 0.5 }, turnId: "t2" };
    const firstActs: Act[] = [canonicalActs[0]!, { ...canonicalActs[1]!, ts: 120, text: "답1" }];
    const crossEntries = [entries[0]!, firstAnswer, secondAnswer];
    const nextText: Act[] = [...firstActs, { ts: 130, threadKey: TK, kind: "text", seq: 0, text: "답2", model }];
    const crossText = group(crossEntries, nextText);
    const nextTools: Act[] = [...firstActs, { ts: 130, threadKey: TK, kind: "tool", seq: 0, model }];
    const crossTool = group([entries[0]!, firstAnswer], nextTools);
    const sameBodyCross = group([entries[0]!, firstAnswer, { ...secondAnswer, text: "답1" }], [...firstActs, { ...nextText[2]!, text: "답1" }]);
    const newUser = { ...entries[0]!, ts: 130 };
    const newUserTurn = group([newUser, canonicalEntries[1]!], [
      { ...canonicalActs[0]!, seq: 9 }, { ...sameTimeTool, seq: 0 }, canonicalActs[1]!,
    ]);
    const earlierUserTurn = group([{ ...newUser, ts: 125 }, canonicalEntries[1]!], [
      { ...canonicalActs[0]!, seq: 9 }, { ...sameTimeTool, seq: 0 }, canonicalActs[1]!,
    ]);
    // 동률 묶음 안에서도 증가하던 seq가 리셋되면 그 앞까지만 이동한다.
    const insideReset = group(crossEntries, [canonicalActs[0]!, { ...firstActs[1]!, ts: 130 }, nextText[2]!]);
    const correctTurns = (us: Unit[]): boolean => {
      const texts = us.filter((u) => u.kind === "text");
      return texts.length === 2 && !us.some((u) => u.entry?.role === "assistant") &&
        texts[0]?.act?.text === "답1" && texts[0]?.act?.turnId === "t1" && texts[0]?.act?.reasoning === "high" && same(texts[0]?.act?.spend, spend) &&
        texts[1]?.act?.text === "답2" && texts[1]?.act?.turnId === "t2" && texts[1]?.act?.reasoning === "low" && same(texts[1]?.act?.spend, secondAnswer.spend);
    };
    const notice: Entry = { ts: 130, role: "assistant", threadKey: TK, text: "알림", notice: true };
    const delivery: Entry = { ts: 130, role: "assistant", threadKey: TK, text: SCHED };
    const noticeOnly = group([entries[0]!, notice], canonicalActs);
    const deliveryOnly = group([entries[0]!, delivery], canonicalActs);
    const deliveryAndAnswer = group([entries[0]!, delivery, canonicalEntries[1]!], canonicalActs);
    const noticeAndAnswer = group([entries[0]!, { ...notice, text: full }, canonicalEntries[1]!], canonicalActs);
    const attachmentAndAnswer = group([entries[0]!, attachment, canonicalEntries[1]!], canonicalActs);
    const optionsAndAnswer = group([entries[0]!, options, canonicalEntries[1]!], canonicalActs);
    const visibleBeforeText = (us: Unit[], row: Entry): boolean => {
      const index = us.findIndex((u) => u.entry === row);
      return index >= 0 && index < us.findIndex((u) => u.kind === "text");
    };
    // 非답 행 하나만 있을 때도 가드를 직접 밟는다(본문을 답과 같게 해 본문 일치 우회 방지).
    const loneAttachment = { ...attachment, text: full };
    const loneOptions = { ...options, text: full };
    const loneNotice = { ...notice, text: full };
    const loneUser = { ...canonicalEntries[1]!, role: "user" };

    // 실제 생산 함수의 출력: 스트림에는 제안 앞 개행이 남고 정본에서는 trimEnd 된다.
    const suggestedRaw = "정리했습니다 — 회귀 답입니다.\n\n<next-message>다음 검사를 해줘</next-message>";
    const suggestedSegment = stepSuggestionStream(suggestedRaw, false).emit;
    const suggestedAnswer = extractInlineSuggestion(suggestedRaw).text;
    const suggestedActs = [canonicalActs[0]!, { ...canonicalActs[1]!, text: suggestedSegment }];
    const suggestedEntry = { ...canonicalEntries[1]!, text: suggestedAnswer };
    const suggested = group([entries[0]!, suggestedEntry], suggestedActs);
    const suggestedLater = group([entries[0]!, { ...suggestedEntry, ts: 131 }], suggestedActs);
    const suggestedText = suggested.find((u) => u.kind === "text")?.act;
    // 완료 표식 없는 배달까지 새 공백 정규화에 걸려 사라지면 안 된다.
    const unmarkedDelivery = { ...suggestedEntry, turnId: undefined };
    const unmarked = group([entries[0]!, unmarkedDelivery], suggestedActs);
    // 도구 없는 단답 두 턴: 0 → 0도 경계다(0 < 0은 거짓).
    const shortTurns = group([
      entries[0]!, { ...firstAnswer, text: "네" }, { ...secondAnswer, text: "네" },
    ], [
      { ts: 120, threadKey: TK, kind: "text", seq: 0, text: "네", model },
      { ts: 130, threadKey: TK, kind: "text", seq: 0, text: "네", model },
    ]);

    return [
      assert("F4 제안 생산 출력: 꼬리 개행 차이·답 1개·turnId와 강도 보존", suggestedSegment === suggestedAnswer + "\n\n" &&
        same(suggested.map((u) => u.kind), ["msg", "turn", "text"]) && suggestedText?.turnId === "turn-f4" &&
        suggestedText.reasoning === "high" && same(suggestedText.spend, spend) && suggested[1]?.reasoning === "high" &&
        same(suggested, suggestedLater), { suggestedSegment, suggestedAnswer, suggested, suggestedLater }),
      assert("F4 공백 대응은 완료 답에만: 표식 없는 배달은 그대로", visibleBeforeText(unmarked, unmarkedDelivery), unmarked),
      assert("F4 단답 두 턴 seq 0→0: 각 답·turnId·강도 보존", same(shortTurns.map((u) => u.kind), ["msg", "text", "text"]) &&
        same(shortTurns.filter((u) => u.kind === "text").map((u) => [u.act?.text, u.act?.turnId, u.act?.reasoning]), [["네", "t1", "high"], ["네", "t2", "low"]]), shortTurns),
      assert("F4 본문이 같은 사용자도 답으로 이동하지 않는다", visibleBeforeText(group([loneUser], canonicalActs), loneUser), group([loneUser], canonicalActs)),
      assert("F4 같은 본문의 다음 턴도 seq 경계로 메타 분리", same(sameBodyCross.filter((u) => u.kind === "text").map((u) => u.act?.turnId), ["t1", "t2"]) && !sameBodyCross.some((u) => u.entry?.role === "assistant"), sameBodyCross),
      assert("F4 이전 시각 사용자 경계도 seq 이력 초기화", same(earlierUserTurn.map((u) => u.kind), ["turn", "msg", "turn", "text"]) && earlierUserTurn[0]?.reasoning === undefined && earlierUserTurn[2]?.reasoning === "high" && earlierUserTurn[3]?.act?.turnId === "turn-f4", earlierUserTurn),
      assert("F4 사용자 경계 뒤 seq 리셋은 새 답의 자기 턴", same(newUserTurn.map((u) => u.kind), ["turn", "msg", "turn", "text"]) && newUserTurn[0]?.reasoning === undefined && newUserTurn[2]?.reasoning === "high" && newUserTurn[3]?.act?.turnId === "turn-f4", newUserTurn),
      assert("F4 다음 턴 텍스트 동률: 각 답 1개와 자기 turnId·강도·비용", correctTurns(crossText), crossText),
      assert("F4 다음 턴 도구 동률: 앞 턴 강도를 다음 카드에 주지 않는다", crossTool.filter((u) => u.kind === "turn")[0]?.reasoning === "high" && crossTool.filter((u) => u.kind === "turn")[1]?.reasoning === undefined && crossTool.find((u) => u.kind === "text")?.act?.turnId === "t1", crossTool),
      assert("F4 동률 내부 seq 리셋: 같은 턴까지만 이동", correctTurns(insideReset), insideReset),
      assert("F4 동률 알림 단독·답과 함께: 알림 위치와 답 1개 보존", visibleBeforeText(noticeOnly, notice) && noticeAndAnswer.filter((u) => u.kind === "msg").length === 2 && noticeAndAnswer.filter((u) => u.kind === "text").length === 1 && visibleBeforeText(group([loneNotice], canonicalActs), loneNotice), { noticeOnly, noticeAndAnswer, lone: group([loneNotice], canonicalActs) }),
      assert("F4 동률 평범한 배달 단독·답과 함께: 배달 보존 및 답 1개", visibleBeforeText(deliveryOnly, delivery) && visibleBeforeText(deliveryAndAnswer, delivery) && deliveryAndAnswer.filter((u) => u.kind === "msg").length === 2 && deliveryAndAnswer.filter((u) => u.kind === "text").length === 1, { deliveryOnly, deliveryAndAnswer }),
      assert("F4 인접 첨부→답: 첨부 위치와 답 1개 보존", visibleBeforeText(attachmentAndAnswer, attachment) && attachmentAndAnswer.filter((u) => u.kind === "msg").length === 2 && visibleBeforeText(group([loneAttachment], canonicalActs), loneAttachment), attachmentAndAnswer),
      assert("F4 인접 선택지→답: 선택지는 조각 앞으로 보존", visibleBeforeText(optionsAndAnswer, options) && optionsAndAnswer.filter((u) => u.kind === "msg").length === 2 && visibleBeforeText(group([loneOptions], canonicalActs), loneOptions), optionsAndAnswer),
      assert("F4 같은 ms: 탭 전환과 새로고침 모두 답 1개·live 0", tiedActive.n === 1 && tiedActive.live === 0 && tiedInactive.n === 1 && tiedInactive.live === 0, { tiedActive, tiedInactive }),
      assert("F4 시각이 다른 대조군: 동률 수정 뒤에도 유닛 전체가 동일", same(tiedUnits, laterUnits), { tiedUnits, laterUnits }),
      assert("F4 동률 정본 승격·강도·비용·turnId 및 도구 강도 보존", promoted?.text === full && promoted.reasoning === "high" && same(promoted.spend, spend) && promoted.turnId === "turn-f4" && canonical.find((u) => u.kind === "turn")?.reasoning === "high", canonical),
      assert("F4 사용자 경계: 이전 도구에 새 답의 강도를 주지 않는다", same(boundary.map((u) => u.kind), ["turn", "msg", "text"]) && boundary[0]?.reasoning === undefined && boundary[1]?.entry?.role === "user", boundary),
      assert("F4 동률 사용자→도구→텍스트 순서와 새 턴 강도 보존", same(userFirst.map((u) => u.kind), ["msg", "turn", "text"]) && userFirst[0]?.entry?.role === "user" && userFirst[1]?.reasoning === "high", userFirst),
      assert("F4 같은 ms 답→사용자 경계는 뒤집지 않는다", same(answerBeforeUser.map((u) => u.kind), ["turn", "msg", "msg", "text"]) && answerBeforeUser[1]?.entry?.role === "assistant" && answerBeforeUser[2]?.entry?.role === "user" && answerBeforeUser[0]?.reasoning === "high" && answerBeforeUser[3]?.act?.reasoning === undefined, answerBeforeUser),
      assert("F4 동률 첨부·선택지는 사라지지 않고 원래 순서 보존", same(visible.filter((u) => u.kind === "msg").map((u) => u.entry), [entries[0], attachment, options]) && visible.filter((u) => u.kind === "text").length === 1 && visible.find((u) => u.kind === "text")?.act?.text === full, visible),
      assert("F4 다른 스레드의 답을 흡수하거나 메타를 옮기지 않는다", foreign.filter((u) => u.kind === "msg").length === 1 && foreign.find((u) => u.kind === "text")?.act?.text === "완성된…" && foreign.every((u) => u.reasoning === undefined && u.act?.reasoning === undefined) && foreignTool.find((u) => u.kind === "turn")?.reasoning === undefined, { foreign, foreignTool }),
      assert("F4 여러 세그먼트: 뒤쪽 세그먼트는 정본 전체로 올리지 않는다", same(multi.map((u) => u.kind), ["text", "turn", "text"]) && same(multi.filter((u) => u.kind === "text").map((u) => u.act?.text), ["앞부분", "뒷부분"]), multi),
      assert("F4 다른 시각의 메시지·활동은 기존 시간순 유지", same(chronological.map((u) => u.kind), ["msg", "msg", "turn", "text", "msg"]) && same(chronological.filter((u) => u.kind === "msg").map((u) => u.entry?.ts), [90, 100, 140]), chronological),
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
