/**
 * 회귀: **작업자가 소환자만 풀 수 있는 것을 `notify_owner` 로 한 줄 알리고 계속 일한다** (2026-10-25,
 * [설계](../../../docs/decisions/2026-10-23-notify-owner-design.md) §14 · 사용자 승인 «notice_id 추가, 작업당 최대 3회·본문 300자,
 * 셸 실행은 유지하고 대기만 깨우는 설계»).
 *
 * 사고(10-23 운영 인스턴스 실사례): 매니저가 «스튜디오 플레이어가 잠금을 쥐고 있다» 는 걸 **알고 있었는데** 알릴 통로가 없어
 * 2시간 20분을 기다렸다. 이 검사가 지키는 것(§14 번호):
 *  ① 소환자=세션 → 합성 턴 1 · 도구는 메인 턴을 기다리지 않는다 ② 소환자=도는 매니저 → 지시 채널 1(점검 시계 안 민다)
 *  ③ 합류가 즉시 꺼낸다 ③b 남의 합류는 안 깨운다 ③c·③d 중단된 합류는 꺼내지 않고 남은 알림은 정확히 1곳으로 ③e 세션 합류 선점
 *  ④ 소환자가 끝났으면 위로 ④b·④c 막 끝나는 창 ⑤ 중복·상한·길이 ⑥ 노출 ⑧ 답 잇기 ⑨ 진행 알림 ⑩ 카드 ⑫ 거두기 문구 ⑬ 기록
 *  ⑭ 비전달 상승 · 18-5 셸 대기 깨움 · 18-8 타임라인 다섯 갈래.
 *
 * 등급: 동작 검사(실제 도구·채널·러너·완료 출구·셸 대기·진행 틱·미니 DOM, 모델 호출 0 · 외부 송신 0). 전역 핸들러를 거므로 자식 프로세스 둘.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, i18nForContext, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const runChild = async (file: string, label: string): Promise<{ d?: R; err?: string; out: string }> => {
  const r = await spawnWithin(120_000, label, ["--import", "tsx", path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (r.timedOut || line === undefined) return { err: r.timedOut ? "timeout" : r.err.slice(-800), out: r.out };
  return { d: JSON.parse(line) as R, out: r.out };
};

export const check: RegressionCheck = {
  name: "job-notice",
  guards:
    "작업자가 소환자만 풀 수 있는 막힘을 알고도 알릴 통로가 없어 몇 시간 기다리던 것(10-23 · 2시간 20분) — 그걸 열면서 생길 것: 차단(메인 턴을 기다림)·중복 배달·남발·합류를 못 깨움·중단된 합류가 가로챔·끝나는 소환자에서 조용한 유실·무관한 지시를 답으로 오인",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const [a, b] = await Promise.all([runChild("_job-notice-child.ts", "job-notice"), runChild("_job-notice-timeout-child.ts", "job-notice-timeout")]);
    // 어댑터가 **실제 모델 요청**에 싣는가 — 세 어댑터 × (작업자 → 메인 → 작업자), 어댑터마다 **한 프로세스**에서 순서대로(자식 주석).
    const adapterRuns: Record<string, unknown> = {};
    for (const ad of ["claude", "codex", "openai"]) {
      const r = await spawnWithin(90_000, `job-notice-${ad}`, ["--import", "tsx", path.join(HERE, "_job-notice-adapters-child.ts"), ad, "worker,main,worker"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
      });
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("[")).pop();
      adapterRuns[ad] = line === undefined ? { err: r.timedOut ? "timeout" : r.err.slice(-300) } : JSON.parse(line);
    }
    if (a.d === undefined) return [assert("자식(job-notice)이 결과를 낸다", false, a.err)];
    if (b.d === undefined) return [assert("자식(job-notice-timeout)이 결과를 낸다", false, b.err)];
    const d = a.d, t = b.d;
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);
    const out: Assertion[] = [];

    // 합류 시나리오의 전제 — 알림 전에 합류 등록이 실제로 확인됐다(안 되면 아래 ③ 계열 단언은 전제가 무너진 것이다).
    const jr = d.joinRegistered as R;
    out.push(assert(
      "③ 전제 — 다섯 합류 시나리오 모두 합류 등록을 확인한 뒤 알렸다",
      ["join", "otherJoin", "abortMgr", "abortSession", "sessionJoin"].every((k) => jr?.[k] === true),
      show(jr),
    ));

    // ① ② ③ — 배달 갈래
    const s = d.session as R;
    out.push(assert(
      "① 소환자=세션 — 합성 턴 1 · synthetic · worker-notice · 본문에 원문·job_id·notice_id · ★영원히 안 끝나는 메인 핸들러로도 도구가 즉시 반환 · 차례가 오면 꺼낸다(모델 턴 진행)",
      s.turns === 1 && s.synthetic === true && s.origin === "worker-notice" && s.hasText && s.hasIds && s.ms < 500 &&
        String(s.ret).includes("대화의 비서에게") && String(s.ret).includes("답을 기다리지 말고") && s.took === "(없음)" && s.inboxAfter === 0 &&
        show(s.events) === show(["sent", "taken/turn"]),
      show(s),
    ));
    const m = d.manager as R;
    out.push(assert(
      "② 소환자=도는 매니저 — 지시 채널 1 · 작업 쪽 글 + noticeOf · 답 안내 · ★점검 시계(stallReports·앵커) 안 민다 · 메인 턴 0 · 관측에 noticeOf(보낸 쪽 label)",
      m.got === 1 && m.source === "job" && m.noticeOf?.noticeId === "n1" && m.hasAnswerHow && m.stall === 1 && m.anchorKept && m.turns === 0 &&
        show(m.events) === show(["sent", "taken/steer"]) && m.steerEv?.[0]?.noticeOf?.label === "조사" && m.steerEv?.[0]?.source === "job",
      show(m),
    ));
    const j = d.join as R;
    out.push(assert(
      "③ ★합류 중인 소환자 매니저 — 1초 안에 돌아오고 맨 위 «📣» · 다른 id 는 기다리지 않고 지금 상태 · 스티어 0 · 메인 0",
      j.ms < 1000 && j.top && j.hasId && j.c2Running && j.steer === 0 && j.turns === 0 && show(j.events) === show(["sent", "taken/join"]),
      show(j),
    ));
    const oj = d.otherJoin as R;
    out.push(assert(
      "③b 남의 합류(같은 대화의 다른 매니저가 그 자식을 합류) — 알림은 받을 스레드(P 스티어)로 정확히 1 · Q 는 안 깨어남(시한까지) · Q 반환에 알림 없음",
      oj.toP === 1 && oj.toQ === 0 && oj.qNotice === false && oj.ms >= 1100 && oj.turns === 0,
      show(oj),
    ));
    const ja = d.joinAbort as R;
    out.push(assert(
      "③c·③d ★중단된 합류(신호가 선 순간 알림 도착)는 꺼내지 않는다 — 매니저: 즉시 «취소됨» · 스티어로 정확히 1(재배달) · 수신함 0 / 세션: 줄 선 합성 턴이 꺼냄 1",
      ja.mgr.cancelled && ja.mgr.joinTook === false && ja.mgr.ms < 1000 && ja.mgr.steer === 1 && ja.mgr.inbox === 0 && ja.mgr.turns === 0 &&
        show(ja.mgr.events) === show(["sent", "taken/steer*"]) &&
        ja.session.joinTook === false && ja.session.turns === 1 && show(ja.session.took) === show(["(none)"]) && show(ja.session.events) === show(["sent", "taken/turn"]),
      show(ja),
    ));
    const sj = d.sessionJoin as R;
    out.push(assert(
      "③e 세션 턴이 합류 중 — 합류가 꺼내고(1초 안·«📣») 줄 선 합성 턴은 `beforeTurn` 사유로 건너뜀(모델 호출 0) · 기록 skipped",
      sj.ms < 1000 && sj.top && sj.turns === 1 && typeof sj.skip === "string" && sj.skip.length > 0 && show(sj.events) === show(["sent", "taken/join", "skipped/turn"]),
      show(sj),
    ));
    const pd = d.parentDone as R;
    out.push(assert("④ 소환자 매니저가 이미 끝남 — 기록만으로 두지 않고 소유 세션 합성 턴 1 · 본문에 «'<부모>' 는 이미 끝나»", pd.turns === 1 && pd.threadKey === "dashboard:regr-notice-s" && pd.note, show(pd)));
    out.push(assert(
      "⑭ 비전달 상승 — 도는 부모에 지시 채널이 없으면(absent) 그 자리에서 소유 세션으로 1 · 반환 «대화의 비서에게»",
      show(d.absentUp.steer) === show(["absent"]) && d.absentUp.turns === 1 && String(d.absentUp.ret).includes("대화의 비서에게"),
      show(d.absentUp),
    ));

    // ④b·④c — 막 끝나는 창
    const fw = d.failWindow as R;
    out.push(assert(
      "④b-1 ★(가) 본 턴 실패 — 러너 finally 가 못 읽은 알림을 회수 → 실패 마킹 직후 세션 수신함 1 · 알림 턴 1(재배달) · 자식이 이미 끝났으면 0",
      fw.live.pStatus === "failed" && fw.live.inbox === 1 && fw.live.noticeTurns === 1 && fw.live.took[0] === null && fw.live.note &&
        show(fw.live.events) === show(["sent", "taken/steer", "taken/turn*"]) &&
        fw.childEnded.inbox === 0 && fw.childEnded.noticeTurns === 0,
      show(fw),
    ));
    out.push(assert(
      "④b-2 대조군 — 거두기 대기 중 알림은 거두기 턴이 소비(«〔작업자 알림〕») · 재배달 0",
      t.control?.consumed === true && t.control?.noticeTurns === 0 && t.control?.inbox === 0,
      show(t.control),
    ));
    out.push(assert(
      "④b-2 ★(다) 거두기 대기 중 시한 — abort 와 러너 finally 사이에 든 알림이 **끝나지 않는 완료 턴**(실제 줄)에서도 수신함 1 · 줄 순서 «완료 → 알림»",
      t.window?.pStatus === "done" && t.window?.cStatus === "running" && t.window?.inbox === 1 && show(t.window?.order) === show(["worker-completion", "worker-notice"]),
      show(t.window),
    ));
    out.push(assert(
      "④c ★완료 턴이 그 자식을 합류하면 그 합류가 즉시 꺼낸다(≤1초·«📣») · 뒤의 알림 턴은 `beforeTurn` 사유로 건너뜀",
      t.joinTakes?.join?.top === true && t.joinTakes?.join?.ms < 1000 &&
        show(t.joinTakes?.ran) === show([{ origin: "worker-completion", skipped: false }, { origin: "worker-notice", skipped: true }]) && t.joinTakes?.inbox === 0,
      show(t.joinTakes),
    ));

    // ⑤ ⑥
    const l = d.limits as R;
    out.push(assert(
      "⑤ 중복·상한·길이 — 같은 글(공백만 다름) 2회째는 배달 0·상한 미소모 · 다른 글 4번째는 cap · 300자 통과·301자·빈 글 거절(잘라 보내지 않음) · ★글자는 코드 포인트(이모지 300개 통과·301개 거절)",
      l.turns === 3 && l.notices === 3 && String(l.a2).startsWith("이미") && String(l.d).includes("상한") && show(l.events) === show(["sent", "duplicate", "sent", "sent", "cap"]) &&
        String(l.ok300).startsWith("알림 n1") && String(l.bad301).includes("301자") && String(l.empty).startsWith("빈 알림") && show(l.lenEvents) === show(["sent", "rejected", "rejected"]) &&
        String(l.emoji300).startsWith("알림 n1") && l.emojiKept === 1 && String(l.emoji301).includes("301자"),
      show(l),
    ));
    const e = d.exposure as R;
    // ★소스 문자열이 아니라 **모델 경계에서 본 실제 요청**으로(독립 변이 사냥 구멍 1: 등록 줄을 끄는 변이가 문자열 검사를 통과했다).
    const adapters = ["claude", "codex", "openai"].map((n) => {
      const [w, m, w2] = (Array.isArray(adapterRuns[n]) ? adapterRuns[n] : []) as R[];
      const ok = (t: R | undefined, has: boolean): boolean => t?.has === has && t?.calls >= 1 && t?.err === undefined;
      return [n, ok(w, true) && ok(m, false) && ok(w2, true)] as const;
    });
    out.push(assert(
      "⑥ 노출 — 메인·엔드포인트 턴엔 없다 · 실행 중인 매니저·서브 턴엔 있다(도구 하나) · 끝난 잡엔 없다 · 설명 600자 이내 · ★세 어댑터가 작업자 턴의 실제 모델 요청에 싣고 메인 턴엔 안 싣는다(한 프로세스에서 작업자→메인→작업자 — 모두 모델까지 간다) · steer_worker(메인·매니저 둘 다) 에 notice_id",
      e.main && e.endpoint && e.manager && e.sub && e.ended && e.descLen <= 600 && e.mainSteerHasNoticeId && e.mgrSteerHasNoticeId && adapters.every(([, ok]) => ok),
      show({ e, adapters, adapterRuns }),
    ));

    // ⑧ 답
    const an = d.answer as R;
    out.push(assert(
      "⑧ ★답은 명시로만 — 무관한 지시(id 없음)·틀린 id 는 미해결 그대로(틀리면 안내) · 맞는 id + delivered 만 답 확정(그 하나만) · 머리 «[알림 n2 에 대한 답]» · answered 발행 1",
      show(an.afterPlain) === show([false, false]) && String(an.wrong).includes("그런 알림이 없습니다") && show(an.states) === show([false, true]) &&
        String(an.head?.[2]).startsWith("[알림 n2 에 대한 답]") && an.answeredEv?.length === 1 && an.answeredEv[0].noticeId === "n2" && an.answeredEv[0].answeredAt === "number" &&
        String(an.right).includes("답으로 기록"),
      show({ afterPlain: an.afterPlain, wrong: an.wrong, states: an.states, head: an.head, ev: an.answeredEv }),
    ));
    out.push(assert(
      "⑧ ★유효한 id 인데 전달 실패(absent) → 미해결 유지 · worker.steered 에 시도(answersNoticeId·outcome) 만 · 매니저 도구(agents.steer_worker)로도 답 확정",
      an.failedState === true && String(an.failed).includes("미해결") && show(an.failedAttempt) === show([{ outcome: "absent", answersNoticeId: "n1" }]) &&
        an.mgrState === true && String(an.mgrAns).includes("답으로 기록") &&
        show(an.attempts?.map((x: R) => x.answersNoticeId)) === show([null, "n9", "n2"]),
      show({ failed: an.failed, failedAttempt: an.failedAttempt, mgr: an.mgrAns, attempts: an.attempts }),
    ));

    out.push(assert(
      "⑧ ★이미 끝난 작업에 답(대상 없음) — 메인·매니저 두 갈래 모두 no-target 시도에 answersNoticeId 가 남는다(어느 알림의 답이었나) · 답 확정 없음",
      show(an.late?.attempts) === show([{ answersNoticeId: "n1", from: false }, { answersNoticeId: "n1", from: true }]) && an.late?.unanswered === true,
      show(an.late),
    ));
    out.push(assert(
      "⑧ ★다른 대화의 작업을 이름으로 짚은 답(other-session) — 시도에 answersNoticeId 가 남는다 · 전달 0 · 답 확정 없음",
      show(an.otherSession?.attempts) === show([{ outcome: "other-session", answersNoticeId: "n1" }]) && an.otherSession?.delivered === 0 && an.otherSession?.unanswered === true,
      show(an.otherSession),
    ));

    // ⑨ 진행 알림
    const pr = d.progress as R;
    out.push(assert(
      "⑨ ★진행 알림 — 미해결 알림이 머리줄 **바로 다음** 첫 줄(«⛔ 막힘(07:46): …») · 답 확정 알림은 없음 · 무관한 지시 뒤에도 실림 · 두 번째 진행 알림엔 안 실림 · 전달 실패한 답 뒤에도 실림 · 요약 프롬프트엔 없음 · ★요약을 기다리는 사이 답이 오면 안 실림",
      typeof pr.expectedLine === "string" && pr.expectedLine.startsWith("⛔") && pr.lineAfterHead === pr.expectedLine && pr.answeredShown === false &&
        pr.second?.length === 1 && !String(pr.second[0]).includes("⛔") &&
        String(pr.failed?.[0]).split("\n")[1]?.startsWith("⛔") && String(pr.failed?.[0]).includes("실패한 답의 막힘") && pr.inPrompt === false &&
        pr.raced?.length === 1 && !String(pr.raced[0]).includes("⛔") && pr.racedAnswered === true,
      show(pr),
    ));

    // ⑫ 거두기 · 18-5 셸
    const h = d.harvest as R;
    out.push(assert(
      "⑫ 거두기 대기 중 알림 → 거두기 턴 입력에 «〔작업자 알림〕» 묶음(알림 머리) · «지시» 묶음엔 없다 · 순수 조립도 세 묶음을 가른다",
      h.rounds === 1 && h.hasBlock && h.noticeHead && h.inInstr === false && h.pureSplit && show(h.events) === show(["sent", "taken/steer"]),
      show(h),
    ));
    out.push(assert(
      "18-5 ★매니저의 셸 대기(BashOutput)가 자식 알림으로 **일찍 돌아온다** — 사유 «작업자 알림»(«새 지시» 아님) · 셸은 계속 실행 중",
      d.shell?.why === true && d.shell?.notInstr === true && d.shell?.running === true && d.shell?.ms < 3000,
      show(d.shell),
    ));

    // ⑩ 카드 · 18-8 타임라인 — 실제 발행 payload · 실제 목록 응답으로
    const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    const sentP = an.payloads?.sent as R;
    const ansP = an.payloads?.answered as R;
    const jid = String(sentP?.jobId ?? "");
    const lineOf = (id: string): { text: string; display: string; answered: boolean; status: string } =>
      dash.run(`(() => { const e = jobCards.get(${JSON.stringify(id)}); return e ? { text: e.noticeEl.textContent, display: e.noticeEl.style.display, answered: e.noticeEl.classList.contains("answered"), status: e.status } : null; })()`) as never;
    dash.run(`handleWorkerEvent(${JSON.stringify({ jobId: jid, threadKey: "dashboard:regr-notice-s", kind: "worker", label: "답받을작업", status: "running" })}, "10:00")`);
    dash.run(`renderEvent(${JSON.stringify({ type: "worker.notice", ts: Date.now(), payload: sentP })})`);
    const afterSent = lineOf(jid);
    dash.run(`renderEvent(${JSON.stringify({ type: "worker.steered", ts: Date.now(), payload: { jobId: jid, label: "답받을작업", outcome: "absent", answersNoticeId: "n1", message: "x" } })})`);
    const afterFailedAnswer = lineOf(jid);
    dash.run(`renderEvent(${JSON.stringify({ type: "worker.notice", ts: Date.now(), payload: ansP })})`);
    const afterAnswered = lineOf(jid);
    const before = an.list?.before as R;
    const after = an.list?.after as R;
    dash.run(`handleWorkerEvent(${JSON.stringify({ ...before, jobId: "hyd-before" })}, "10:00")`);
    dash.run(`handleWorkerEvent(${JSON.stringify({ ...after, jobId: "hyd-after" })}, "10:00")`);
    const hydBefore = lineOf("hyd-before");
    const hydAfter = lineOf("hyd-after");
    out.push(assert(
      "⑩ ★카드 — 실제 sent payload → «막힘: …» · 잡 상태 불변 · 실패한 답 시도(worker.steered)만으로는 줄 불변 · 실제 answered payload → «막힘(답 받음)»",
      afterSent.display !== "none" && afterSent.text.includes("막힘: 첫 막힘") && afterSent.answered === false && afterSent.status === "running" &&
        afterFailedAnswer.text === afterSent.text && afterFailedAnswer.answered === false &&
        afterAnswered.text.includes("막힘(답 받음): 둘째 막힘") && afterAnswered.answered === true,
      show({ afterSent, afterFailedAnswer, afterAnswered }),
    ));
    out.push(assert(
      "⑩ ★새로고침 — 실제 목록 응답(`activity.notice`)으로 같은 줄(답 확정 전 «막힘» · 후 «답 받음»)",
      hydBefore.text.includes("막힘: 둘째 막힘") && hydBefore.answered === false && hydAfter.text.includes("막힘(답 받음): 둘째 막힘") && hydAfter.answered === true,
      show({ hydBefore, hydAfter, before: before?.activity, after: after?.activity }),
    ));
    // ★같은 밀리초에 난 두 알림 — 옛 알림(n1)의 답 이벤트가 최신 미해결(n2)을 덮지 않는다(GPT R1 #2 재현 모양). 최신은 서버 순번.
    const seqBase = { jobId: "seq-job", label: "순번", kind: "worker", threadKey: "dashboard:regr-notice-s" };
    dash.run(`handleWorkerEvent(${JSON.stringify({ ...seqBase, status: "running" })}, "10:00")`);
    for (const p of [
      { ...seqBase, outcome: "sent", noticeId: "n1", text: "옛 막힘", at: 1000 },
      { ...seqBase, outcome: "sent", noticeId: "n2", text: "새 막힘", at: 1000 },
      { ...seqBase, outcome: "answered", noticeId: "n1", text: "옛 막힘", at: 1000, answeredAt: 2000 },
      { ...seqBase, outcome: "duplicate", noticeId: "n1", text: "옛 막힘", at: 1000 },
    ]) dash.run(`renderEvent(${JSON.stringify({ type: "worker.notice", ts: Date.now(), payload: p })})`);
    const seq = lineOf("seq-job");
    out.push(assert(
      "⑩ ★같은 시각의 두 알림 — 옛 알림의 답·중복 이벤트가 뒤늦게 와도 카드는 최신 미해결(n2) «막힘: 새 막힘»",
      seq.text.includes("막힘: 새 막힘") && seq.answered === false,
      show(seq),
    ));
    // 18-8 — 같은 이벤트의 다섯 갈래(알림 배달 · 답 지시 · 실패한 답 · 결과 · 반송)가 서로 다른 줄로 그려진다
    const all = (an.steeredAll ?? []) as R[];
    const pick = {
      notice: all.find((x) => x.noticeOf !== undefined),
      answer: all.find((x) => x.answersNoticeId === "n1" && x.outcome === "delivered" && x.fromJobId !== undefined),
      failedAnswer: all.find((x) => x.answersNoticeId === "n1" && x.outcome === "absent"),
      result: all.find((x) => x.source === "job" && x.noticeOf === undefined && x.returnedByJobId === undefined),
      returned: all.find((x) => x.returnedByJobId !== undefined),
    };
    const labels: Record<string, string> = {};
    for (const [k, p] of Object.entries(pick)) {
      if (p === undefined) { labels[k] = "(payload 없음)"; continue; }
      const id = `tl-${k}`;
      dash.run(`renderEvent(${JSON.stringify({ type: "worker.steered", ts: Date.now(), payload: { ...p, jobId: id } })})`);
      labels[k] = String(dash.run(`(() => { const e = jobCards.get(${JSON.stringify(id)}); const l = e && e.stepsEl.querySelector(".bg-steer"); return l ? l.textContent : "(줄 없음)"; })()`));
    }
    const vals = Object.values(labels);
    out.push(assert(
      "18-8 ★타임라인 — 실제 payload 다섯(알림 배달 · 답 지시 · 실패한 답 · 결과 · 반송)이 서로 다른 줄 · 알림은 «'<보낸 작업>' 의 알림»(답 지시를 알림으로 그리지 않는다)",
      new Set(vals).size === 5 && !vals.includes("(payload 없음)") && labels.notice === "'자식' 의 알림" && !labels.answer!.includes("알림") && !labels.failedAnswer!.includes("알림"),
      show(labels),
    ));

    // ⑬ 기록 — 경로마다의 결과 어휘가 위 단언에 흩어져 있다(sent·taken(route)·skipped·duplicate·cap·rejected·재배달*). 로그 1차 진단면:
    out.push(assert(
      "⑬ 로그만으로 판정 — «[job-notice] '<label>' (<kind>:<id>) n1 1/3 · target=… · …자» 줄이 남는다",
      /\[job-notice\] '잠금대기' \(worker:[^)]+\) n1 1\/3 · target=dashboard:regr-notice-s · /.test(a.out),
      (a.out.match(/\[job-notice\][^\n]*/) ?? [""])[0].slice(0, 160),
    ));
    return out;
  },
};

export default check;
