/**
 * 회귀: **대화 밖(스케줄) 작업 턴의 선택지는 목적지 대화에 보이고, 답은 그 작업 스레드로 간다** (2026-10-28, 설계
 * `docs/decisions/2026-10-28-prompt-choice-release-followup.md` §2 B4).
 *
 * 사고(독립 검토 성립 · 격리 재현 R0-3): 스케줄이 띄운 작업의 완료·점검·알림 턴은 숨은 스레드(`scheduler:…`)에서 돈다. 코어 관측 래퍼의 좌표가
 *  늘 `msg.threadKey` 라 그 선택지가 `scheduler:…` 로 발행돼 대시보드 **어느 탭에도** 안 떴다(탭 후보에서 `scheduler:` 는 빠진다).
 *
 * 지키는 것:
 *  ① 대시보드 목적지 → 표시 = 그 대화 · 답 = 작업 스레드(발급 대장 `promptReplySession`) · payload `answerThreadKey` = 작업 스레드
 *  ② 텔레그램 목적지 → 표시 = 기본 세션(그 대화의 세션) · 답 = 작업 스레드
 *  ③ 사람의 대화 스레드 턴(목적지가 있어도) · `replyTarget` 없는 내부 턴 → 종전 그대로(`msg.threadKey`) · `answerThreadKey` 없음
 *  ④ 진짜 대시보드: 목적지 탭이 활성이면 그 카드가 그려진다(수정 전 0장)
 *  ⑤ 배선 — 메인 핸들러의 관측 래퍼 좌표가 이 판정을 쓴다
 *
 * 등급: **동작**(⑤만 구조).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Payload = Record<string, unknown>;
type Observe = typeof import("../../core/prompt-options-observe.js");

export const check: RegressionCheck = {
  name: "prompt-options-display-seat",
  guards: "대화 밖(스케줄) 작업의 완료·점검·알림 턴 선택지가 숨은 스레드(scheduler:…)로 발행돼 대시보드 어느 탭에도 안 뜨던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const observe = (await import("../../core/prompt-options-observe.js")) as Observe;
    const { promptReplySession, __resetPromptClaimsForTest } = await import("../../core/prompt-answer-claims.js");
    const { DEFAULT_SESSION_ID } = await import("../../core/threadkey.js");
    const seatOf = (m: { threadKey: string; replyTarget?: { channel: string; target: string | null } }): { threadKey: string; replyToSession?: string } =>
      typeof observe.promptObservationSeat === "function" ? observe.promptObservationSeat(m as never) : { threadKey: m.threadKey };
    /** 메인 핸들러와 같은 모양으로 래퍼를 돌려 발행 payload 를 받는다. */
    const publishOf = async (m: { threadKey: string; replyTarget?: { channel: string; target: string | null } }): Promise<Payload> => {
      const got: Payload[] = [];
      const bus = { publish: (e: { type: string; payload: Payload }) => { if (e.type === "prompt.options") got.push(e.payload); }, subscribe: () => () => {} };
      const present = observe.withPromptOptionsObservation(async () => ({ ok: true as const }), { channel: "http-bridge", ...seatOf(m), bus: bus as never });
      await present?.("어느 형식?", [{ label: "A", value: "a" }]);
      return got[0] ?? {};
    };
    __resetPromptClaimsForTest();
    const JOB = "scheduler:regr";

    // ① 대시보드 목적지
    const dash = await publishOf({ threadKey: JOB, replyTarget: { channel: "http-bridge", target: "dashboard:regr-x" } });
    out.push(assert(
      "★① 대시보드 목적지 — 그 대화에 보이고 · 답은 작업 스레드로(대장) · 화면이 답 큐를 알도록 answerThreadKey = 작업 스레드",
      dash.threadKey === "dashboard:regr-x" && promptReplySession(String(dash.promptId)) === JOB && dash.answerThreadKey === JOB,
      { 표시: dash.threadKey, 답: promptReplySession(String(dash.promptId)), 답큐: dash.answerThreadKey ?? null },
    ));
    // ② 텔레그램 목적지
    const tg = await publishOf({ threadKey: JOB, replyTarget: { channel: "telegram", target: "4242" } });
    out.push(assert(
      "★② 텔레그램 목적지 — 표시 = 기본 세션(그 대화의 세션) · 답 = 작업 스레드",
      tg.threadKey === DEFAULT_SESSION_ID && promptReplySession(String(tg.promptId)) === JOB && tg.answerThreadKey === JOB,
      { 표시: tg.threadKey, 답: promptReplySession(String(tg.promptId)), 답큐: tg.answerThreadKey ?? null },
    ));
    // ③ 불변 두 갈래
    const user = await publishOf({ threadKey: "dashboard:regr-a", replyTarget: { channel: "telegram", target: "4242" } });
    const internal = await publishOf({ threadKey: "endpoint:regr" });
    out.push(assert(
      "★③ 사람의 대화 스레드 턴(목적지가 있어도)·replyTarget 없는 내부 턴은 종전 그대로 — 그 스레드에 보이고 답도 그 스레드 · answerThreadKey 없음",
      user.threadKey === "dashboard:regr-a" && promptReplySession(String(user.promptId)) === "dashboard:regr-a" && !("answerThreadKey" in user) &&
        internal.threadKey === "endpoint:regr" && promptReplySession(String(internal.promptId)) === "endpoint:regr" && !("answerThreadKey" in internal),
      { 사람: [user.threadKey, promptReplySession(String(user.promptId)), user.answerThreadKey ?? null], 내부: [internal.threadKey, promptReplySession(String(internal.promptId)), internal.answerThreadKey ?? null] },
    ));
    // ④ 진짜 대시보드
    const d = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    d.run(`activeThreadKey = "dashboard:regr-x"`);
    d.run(`renderEvent(${JSON.stringify({ type: "prompt.options", ts: Date.now(), payload: dash })})`);
    // 채팅은 가상화돼 있다 — 카드는 `vtItems` 에 들어간다(화면 부착은 나중).
    const cards = d.run(`vtItems.filter((it) => it.node && it.node.dataset && it.node.dataset.type === "prompt.options").length`) as number;
    out.push(assert("④ 진짜 대시보드 — 목적지 탭이 활성이면 그 선택지 카드가 그려진다", cards === 1, { 카드: cards }));
    // ⑤ 배선
    const idx = await readFile(path.join(HERE, "../../index.ts"), "utf8");
    const wired = /withPromptOptionsObservation\(\s*withEgressPromptOptions\([\s\S]{0,1600}?\{ channel: msg\.channel, \.\.\.promptObservationSeat\(msg\), bus \},?\s*\);/.test(idx);
    out.push(assert("⑤ 배선 — 메인 핸들러의 관측 래퍼 좌표가 이 판정(promptObservationSeat)을 쓴다", wired, {
      래퍼일치: wired,
      좌표등장: idx.split("...promptObservationSeat(msg)").length - 1,
    }));
    __resetPromptClaimsForTest();
    return out;
  },
};

export default check;
