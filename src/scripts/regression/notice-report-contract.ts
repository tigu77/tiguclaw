/**
 * 회귀: **작업자 알림 턴의 사용자 보고는 기본 생략 — 단, 증명된 깨끗한 종료에서만** (2026-11-01,
 * [설계](../../../docs/decisions/2026-11-01-notify-owner-report-contract.md) · 사용자 «정상 내부 조율은 기본 생략 · 승인 요청/중요 오류/요청한 최종 결과는 전달»).
 *
 * 사고(10-31 검토 사실 1·2·8): 작업자 알림을 받은 메인 비서가 `steer_worker` 로 내부에서 풀어도 그 턴의 마지막 글이 **언제나** 사용자 채널·대시보드
 *  답 말풍선·안 읽음 배지로 나갔다(Codex 는 도구 뒤 글을 강제하므로 «아무 말도 안 해도 됩니다» 를 구조가 못 받쳤다). 이 검사가 지키는 것:
 *  ① 허용은 알림 턴에만(생산자 한 줄) · 완료 재주입엔 없음
 *  ② 세 어댑터: 허용 턴에만 `report_to_user` 노출 · 표시 없이 깨끗하게 끝나면 생략 증명 · 표시·흡수된 실패·대체 문구·오류 삼킴·도구 없는 재시도엔 없음 ·
 *     허용 턴의 글 조각(활동·델타)은 `audience:"internal"`
 *  ②b 선택지를 못 전달해 텍스트로 대신 물은 질문이 남은 허용 턴 — 증명 없음(2026-11-02) · 같은 질문 재시도 성공·처음부터 성공은 증명 유지 ·
 *     일부만 성공하면 남은 질문 보호 유지 · 명시 표시는 재시도 성공이 지우지 않음 · 남은 질문은 다음 호출로 새지 않음 ·
 *     공통 팩토리: 예외는 그대로 전파(보호로 바꾸지 않음)
 *  ③ 라우터·런타임: 허용을 입력으로, 증명을 결과로 옮김 · 폴백 안내를 덧붙인 결과엔 증명이 없음
 *  ④ 핸들러 판정: 허용 × 증명 × 덧붙인 안내 없음일 때만 생략 · 허용 턴은 끼워넣기를 안 받음 · «내부 처리» 통지(배지 안 올림)
 *  ⑤ 허용 턴은 합류 권리가 없다 — 최종 결과는 기존 완료 경로로(재주입 1) · 일반 턴은 그대로 넘겨받는다(양성 대조)
 *  ⑥ 허용 턴은 사람 턴 몫의 한 번짜리 줄을 꺼내지 않는다
 *  ⑦ 대시보드: 내부 기록 글은 라이브·이력 모두 답 말풍선이 아니라 스텝 · 통지 행은 세그먼트 뒤에도 안 버려진다
 *  ⑧ «내부 처리» 통지(2026-11-02 §11·§12) — 기록 행은 남고(구조 표식 `data.audience`) · 대화엔 짧은 시스템 상태 줄 1(라이브·이력) · 턴 카드는 마감 ·
 *     진행 턴 이어받기가 «끝난 턴» 증거로 쓴다 · 세션 미리보기에서만 빠진다 · 같은 문구의 사용자 글·표식 없는 통지는 그대로 ·
 *     판정은 문구가 아니라 표식(대시보드·서버 두 판정에 같은 입력표) · 안 읽음은 ④·배선의 `unread:false`
 *
 * 등급: ①~⑥ 동작(자식 프로세스 — 실제 어댑터·라우터·런타임·작업 기록, 모델 호출 0 · 외부 송신 0) · ⑦ 동작(미니 DOM·병합 함수 vm) + 진입점 배선 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, assertIsolated, i18nForContext, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, internalTextHelpersSource, jsonResponse, makeClock } from "./_mini-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const lastJson = (s: string, open: "{" | "["): R | R[] | undefined => {
  const line = s.trim().split("\n").filter((l) => l.startsWith(open)).pop();
  return line === undefined ? undefined : (JSON.parse(line) as R);
};

export const check: RegressionCheck = {
  name: "notice-report-contract",
  guards:
    "작업자 알림을 내부에서 풀어도 그 턴의 마지막 글이 언제나 사용자에게 가던 것 — 그걸 막으면서 생길 것: 실패·대체 문구·폴백 안내까지 생략 · 사람 질문 답이 섞여 생략 · 합류로 받은 최종 결과가 사라짐 · 대시보드 답 말풍선·배지 누출",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

    // ── ①③④⑤⑥ 코어 자식 ─────────────────────────────────────────────────────
    const core = await spawnWithin(120_000, "notice-report-core", ["--import", "tsx", path.join(HERE, "_notice-report-child.ts")], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
    });
    const d = lastJson(core.out, "{") as R | undefined;
    if (d === undefined) return [assert("자식(notice-report-core)이 결과를 낸다", false, core.timedOut ? "timeout" : core.err.slice(-600))];
    // 서버 문구는 설치 언어를 따른다(회귀 환경은 영어일 수 있다) — 두 카탈로그 중 하나와 글자 그대로 같아야 한다.
    const cat = (l: string): Record<string, string> => JSON.parse(readFileSync(path.join(REPO, `locales/${l}.json`), "utf8")) as Record<string, string>;
    const NOTICE_TEXTS = [cat("ko")["srv.notice.handledInternally"], cat("en")["srv.notice.handledInternally"]];

    const p = d.producer as R;
    out.push(assert(
      "★① 알림 턴에만 `reportDefault:\"omit\"` — 문구가 기본 생략·`report_to_user` 를 말하고 «아무 말도 안 해도» 는 없다 · 같은 대화의 완료 재주입엔 없다",
      p.notice.length === 1 && p.notice[0].rd === "omit" && p.notice[0].synthetic === true && p.notice[0].hasReportWord && p.notice[0].noSilence &&
        p.completion.length === 1 && p.completion[0].rd === null &&
        // 무활동 점검 차례도 같은 소환자 경로·같은 합성 턴 모양이지만 허용이 아니다(사용자 미결 U-B)
        Array.isArray(p.checkin) && p.checkin.length >= 1 && p.checkin.every((x: R) => x.rd === null),
      show(p),
    ));

    const nt = d.noticeTurn as R;
    out.push(assert(
      "★① 코어 `notifyOwner()` → 진짜 들이기·줄·차례(`beforeTurn` 이 알림을 꺼냄) → 마지막 단계: 표시 없는 깨끗한 종료면 채널 전송 0 · 생략 1",
      nt.sentDelta === 0 && nt.omittedDelta === 1,
      show(nt),
    ));
    const qd = d.queue as R, pl = d.plain as R, tl = d.tail as R;
    out.push(assert(
      "★④ 진짜 직렬 줄 — 알림 턴 진행 중 사람 메시지는 끼워지지 않고(0) 그 뒤 새 턴 1 · 그 턴엔 알림의 `reportDefault`·`beforeTurn` 이 없다 · 사람은 답을 받고 알림 턴의 글은 안 나간다",
      qd.during.steered === 0 && qd.during.turns === 1 && JSON.stringify(qd.order) === JSON.stringify(["worker-notice", "human"]) &&
        qd.human !== null && qd.human.rd === null && qd.human.bt === false && qd.humanAnswered === true && qd.noticeSent === false &&
        qd.counts.delivered === 1 && qd.counts.omitted === 1 && qd.counts.fanOut === 1 && qd.counts.suggest === 1 && qd.counts.outAnswers === 1 && qd.counts.outNotices === 1,
      show(qd),
    ));
    out.push(assert(
      "④ 차례에 `beforeTurn` 이 사유를 내면(알림을 이미 다른 자리가 꺼냄) 모델 없이 건너뛴다 — 턴 0",
      Array.isArray(d.skip) && (d.skip as string[]).length === 1 && (d.skip as string[])[0] === "(skipped)",
      show(d.skip),
    ));
    out.push(assert(
      "④ 양성 대조 — 일반 턴 진행 중 사람 메시지는 그 턴에 끼워진다(새 턴 0) · 꼬리 창(통로 닫힘)에 온 말은 새 턴",
      pl.steered === 1 && pl.turns === 1 && pl.steeredResult === true && tl.steered === 0 && JSON.stringify(tl.turns) === JSON.stringify(["일반 요청", "꼬리 창 말"]),
      show({ pl, tl }),
    ));
    const j = d.join as R;
    out.push(assert(
      "★⑤ 허용 턴의 `wait_for_worker` 는 권리 없이 결과만 본다 — 완료 재주입 1 → 사용자에게 실제로 전달 · CRR 전달 상태 delivered",
      j.omittable.joinedWhileWaiting === false && j.omittable.sawResult === true && j.omittable.completionTurns === 1 &&
        j.omittable.userGot === true && j.omittable.noticeState === "delivered",
      show(j.omittable),
    ));
    out.push(assert(
      "⑤ 양성 대조 — 일반 턴의 합류는 권리를 얻고 결과를 넘겨받는다(재주입 0)",
      j.normal.joinedWhileWaiting === true && j.normal.sawResult === true && j.normal.completionTurns === 0,
      show(j.normal),
    ));

    const r = d.route as R;
    out.push(assert(
      "③ 라우터 — 허용 메시지만 입력에 `reportOmittable` · 어댑터의 생략 증명은 결과로 그대로(소비 판정은 핸들러 한 곳)",
      r.err === undefined && r.inputs?.[0]?.reportOmittable === true && r.inputs?.[1]?.reportOmittable === null && r.omit === true,
      show(r),
    ));
    const fb = d.fallback as R;
    out.push(assert(
      "★③ 모델 폴백 안내를 본문에 덧붙인 결과엔 생략 증명이 없다(다음 풀이 증명을 실어도)",
      fb.err === undefined && fb.calls === 2 && fb.rejected === true && fb.appended === true && fb.omitted === null,
      show(fb),
    ));

    const dc = d.decide as R;
    out.push(assert(
      "★④ 생략 = 허용 × 증명 × 덧붙인 안내 없음 — 하나라도 빠지면 전달(허용 없는 메시지의 증명은 무시 · Stop 훅 안내가 있으면 전달)",
      dc.omit === true && dc.noProof === false && dc.noPolicy === false && dc.hookAppended === false,
      show(dc),
    ));
    out.push(assert(
      "★④ 허용 턴은 끼워넣기를 안 받는다(사람 입력은 새 턴으로) · 가지 정리 턴도 안 받음 · 일반 인입·허용 없는 알림 출처는 받는다",
      dc.steerNotice === false && dc.steerFork === false && dc.steerInbound === true && dc.steerNoticeNoPolicy === true,
      show(dc),
    ));
    const f = d.finish as R;
    out.push(assert(
      "★④ 진입점 마지막 단계(`finishTurnOutput`, 진짜 함수) — 생략: 채널 답·기록·사본·제안(deliver) 0회 · 통지 1 / 표시·Stop 훅 안내·허용 없는 완료 턴: deliver 1 · 통지 0 / 전송 실패: 그대로 던짐(통지로 안 바뀜)",
      f.omitted.fate === "omitted" && f.omitted.delivers === 0 && f.omitted.notices === 1 &&
        f.marked.fate === "delivered" && f.marked.delivers === 1 && f.marked.notices === 0 &&
        f.hook.fate === "delivered" && f.hook.delivers === 1 && f.hook.notices === 0 &&
        f.completion.fate === "delivered" && f.completion.delivers === 1 && f.completion.notices === 0 &&
        String(f.sendFail.fate).startsWith("threw:") && f.sendFail.notices === 0,
      show(f),
    ));
    const mk = d.mark as R;
    out.push(assert(
      "④ 완료 턴 표식은 채널 답을 보낸 **뒤** 기록 순간에 판정 — 보내는 사이 끼어든 입력이 있으면 표식 없음 · 없으면 표식(양성 대조)",
      mk.quiet.turn?.id === "saved-turn" && mk.interrupted.accepted === true && mk.interrupted.turn === null,
      show(mk),
    ));
    const st = d.steer as R;
    out.push(assert(
      "★④ 끼워넣기(진입점이 쓰는 함수로) — 알림 턴은 채널을 안 열어 사람 메시지가 끼워지지 않는다(→ 새 턴) · 일반 턴은 끼워진다(양성 대조) · 닫힌 뒤(꼬리 창)는 새 턴",
      st.noticeOpened === false && st.duringNotice === false && st.normalOpened === true && st.duringNormal === true && st.afterClose === false,
      show(st),
    ));
    const n = (d.internalNotice as R[])[0];
    out.push(assert(
      "④ «내부 처리» 통지 = 시스템 통지(`notice:true`) · 배지 안 올림(`unread:false`) · 내부 처리 표식(`audience:\"internal\"`) · 서버 문구 카탈로그 · 완료 턴 표식 없음",
      (d.internalNotice as R[]).length === 1 && n.notice === true && n.unread === false && n.audience === "internal" && n.turn === null &&
        NOTICE_TEXTS.every((t) => typeof t === "string" && t !== "") && NOTICE_TEXTS.includes(n.text),
      show(d.internalNotice),
    ));
    const c = d.context as R;
    out.push(assert(
      "★⑥ 허용 턴은 «직전 질문» 줄을 꺼내지 않고 다음 사람 턴이 받는다(한 번만)",
      c.internalHasAsked === false && c.humanHasAsked === true && c.againHasAsked === false,
      show(c),
    ));

    const h = d.history as R[] | undefined;
    out.push(assert(
      "★⑦ 서버 이력 투영 — 영속된 내부 기록 글 조각의 `audience` 가 이력 API 로 나간다(일반 글엔 없다) · 새로고침 뒤에도 같은 뜻",
      Array.isArray(h) && h.some((x) => x.text === "내부 메모" && x.audience === "internal") && h.some((x) => x.text === "보통 답" && x.audience === null),
      show(h),
    ));

    const ps = d.persist as R | undefined;
    {
      const ph = ps?.phrase;
      const p1 = (ps?.p1 ?? []) as R[], p3 = (ps?.p3 ?? []) as R[], p4 = (ps?.p4 ?? []) as R[];
      out.push(assert(
        "★⑧ 대시보드 적재(진짜 `event-persist`): «내부 처리» 통지는 대화 기록 행으로 **남는다**(문구·통지 표식 그대로) + 구조 표식 `data.audience:\"internal\"` · 일반 답·사용자 글·표식 없는 통지 행엔 표식 없음",
        ps !== undefined && typeof ph === "string" && ph !== "" &&
          p1.length === 3 && p1[2]!.notice === true && p1[2]!.text === ph && p1[2]!.aud === "internal" && p1[2]!.internal === true &&
          p1[0]!.aud === null && p1[1]!.aud === null && !p1[0]!.internal && !p1[1]!.internal &&
          p3.length === 2 && p3[1]!.role === "user" && p3[1]!.text === ph && p3[1]!.aud === null && !p3[1]!.internal &&
          p4.length === 2 && p4[1]!.notice === true && p4[1]!.aud === null && !p4[1]!.internal && ps.p2count === 3,
        show(ps),
      ));
      const pv = (ps?.preview ?? {}) as R;
      out.push(assert(
        "★⑧ 세션 목록 미리보기(최근 3건 창): 내부 기록 행을 건너뛴다(앞 일반 답) · 창이 전부 내부면 미리보기 없음(문구로 대체 안 함) · 같은 문구의 사용자 글·표식 없는 통지는 그대로",
        pv.p1 === "보통 답" && pv.p2 === null && pv.p3 === ps?.phrase && pv.p4 === "스케줄 실패 통지",
        show(pv),
      ));
    }

    // ── ② 세 어댑터 ───────────────────────────────────────────────────────────
    // ★`omitnext` 는 `optfail` 바로 뒤여야 한다 — 뒤 장면들(재시도 성공)이 같은 질문을 지워서, 집합이 호출 밖으로 새도 끝에선 비어 보인다(아래 단언이 순서도 본다).
    const OPT_SCENES = "optfail,omitnext,optunavail,optretry,optok,optpartial,optmark";
    const runs: Record<string, R[] | string> = {};
    for (const [ad, sc] of [["claude", `plain,omit,mark,fail,noresult,emptyhead,silent,ctx,ctxplain,${OPT_SCENES}`], ["codex", `plain,omit,mark,fail,swallow,flush,ctx,ctxplain,${OPT_SCENES}`], ["openai", `plain,omit,mark,fail,trunc,ctx,ctxplain,${OPT_SCENES}`]] as const) {
      const rr = await spawnWithin(120_000, `notice-report-${ad}`, ["--import", "tsx", path.join(HERE, "_notice-report-adapters-child.ts"), ad, sc], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
      });
      runs[ad] = (lastJson(rr.out, "[") as R[] | undefined) ?? (rr.timedOut ? "timeout" : rr.err.slice(-400));
    }
    for (const ad of ["claude", "codex", "openai"]) {
      const rs = runs[ad];
      if (!Array.isArray(rs)) { out.push(assert(`② ${ad} 자식이 결과를 낸다`, false, rs)); continue; }
      const by = (s: string): R | undefined => rs.find((x) => x.scenario === s);
      const plain = by("plain"), omit = by("omit"), mark = by("mark"), fail = by("fail");
      out.push(assert(
        `★② ${ad}: 허용 없는 턴 — 도구 미노출 · 증명 없음 · 글 조각에 출처 없음`,
        plain !== undefined && plain.err === undefined && !plain.exposed && !plain.omitted && plain.textAud.every((a: string) => a === "-") && plain.deltaAud.every((a: string) => a === "-"),
        show(plain),
      ));
      out.push(assert(
        `★② ${ad}: 허용 턴 · 표시 없이 깨끗한 종료 — 도구 노출 · 생략 증명 · 글 조각(활동·델타) 전부 «internal»`,
        omit !== undefined && omit.err === undefined && omit.exposed && omit.omitted && omit.textAud.length >= 1 && omit.textAud.every((a: string) => a === "internal") &&
          omit.deltaAud.length >= 1 && omit.deltaAud.every((a: string) => a === "internal"),
        show(omit),
      ));
      out.push(assert(`★② ${ad}: 허용 턴 · \`report_to_user\` 표시 — 증명 없음(평소대로 전달)`, mark !== undefined && mark.err === undefined && mark.exposed && !mark.omitted, show(mark)));
      out.push(assert(
        `★② ${ad}: 허용 턴 · 호스트가 깨끗한 종료를 증명 못 함(${ad === "claude" ? "확정 답 뒤 예외" : ad === "codex" ? "부작용 뒤 빈 글 → 대체 문구" : "도구 미지원 → 도구 없는 재시도"}) — 증명 없음`,
        fail !== undefined && !fail.omitted && (ad === "codex"
          ? fail.calls === 6 && String(fail.err).includes("no summary text could be produced") && String(fail.display).includes("steer_worker") && String(fail.text) === ""
          : fail.err === undefined),
        show(fail),
      ));
      if (ad === "codex") {
        const sw = by("swallow"), fl = by("flush");
        out.push(assert("★② codex: 부작용 뒤 요청 실패는 throw · 사용자 실패 안내 전달 — 생략 증명 없음", sw !== undefined && !sw.omitted && sw.calls === 2 && String(sw.text) === "" && String(sw.err) === 'Codex backend request failed: 400 {"error":{"message":"회귀: 요청 거부","type":"invalid_request_error"}}' && String(sw.display).includes("Check the results, or ask again") && String(sw.display).includes("steer_worker"), show(sw)));
        out.push(assert("★② codex: 빈 응답이 이어져 호스트가 마무리를 강제(final flush)한 턴 — 모델 글로 끝나도 증명 없음", fl !== undefined && fl.err === undefined && !fl.omitted && String(fl.text).includes("강제 마무리 뒤의 글"), show(fl)));
      }
      if (ad === "openai") {
        const tr = by("trunc");
        out.push(assert("★② openai: 상대가 입력을 잘라 처리한 턴(입력 토큰 1) — 증명 없음", tr !== undefined && tr.err === undefined && !tr.omitted, show(tr)));
      }
      if (ad === "claude") {
        const nr = by("noresult");
        out.push(assert("★② claude: 성공 결과 없이 글 조각만 남은 반환 — 증명 없음", nr !== undefined && nr.err === undefined && !nr.omitted && String(nr.text).length > 0, show(nr)));
        const eh = by("emptyhead"), si = by("silent");
        out.push(assert(
          "★② claude: 빈 성공 result 가 먼저 오고 그 뒤 글 조각만 남은 채 끝남 — 앞 성공이 뒤 글의 완료를 증명하지 않는다(증명 없음 · 그 글이 답)",
          eh !== undefined && eh.err === undefined && !eh.omitted && String(eh.text).includes("내부에서 답했습니다"),
          show(eh),
        ));
        out.push(assert("★② claude: 글 없이 성공 result 로 깨끗하게 끝난 허용 턴 — 증명 있음(양성 대조)", si !== undefined && si.err === undefined && si.exposed && si.omitted, show(si)));
      }
      // ②b 선택지 전달 실패 뒤 대체 질문 — 렌더 횟수로 «모델이 실제로 도구를 불렀다» 를 같이 본다(안 불렀으면 증명이 그대로라 거짓 초록).
      {
        const o = (sc: string, renders: number, omitted: boolean): boolean => {
          const x = by(sc);
          return x !== undefined && x.err === undefined && x.exposed && x.renders === renders && x.omitted === omitted && String(x.text).length > 0;
        };
        out.push(assert(
          `★②b ${ad}: 선택지 전달 실패·이 턴 불가 뒤 텍스트로 대신 물은 허용 턴 — \`report_to_user\` 없이 끝나도 증명 없음(대체 질문이 내부 기록으로 묻히지 않는다)`,
          o("optfail", 1, false) && o("optunavail", 1, false),
          show({ f: by("optfail"), u: by("optunavail") }),
        ));
        out.push(assert(
          `★②b ${ad}: 실패 뒤 같은 질문 재시도 성공 · 처음부터 성공 — 증명 유지(선택지 성공만으로 최종 글을 더 보내지 않는다)`,
          o("optretry", 2, true) && o("optok", 1, true),
          show({ r: by("optretry"), k: by("optok") }),
        ));
        out.push(assert(
          `★②b ${ad}: 두 질문 중 하나만 성공 — 남은 질문 보호 유지 · 명시 표시 뒤 재시도 성공 — 표시가 지워지지 않는다(둘 다 증명 없음)`,
          o("optpartial", 2, false) && o("optmark", 2, false),
          show({ p: by("optpartial"), m: by("optmark") }),
        ));
        // 순서 전제(`optfail` 바로 뒤)도 여기서 본다 — 결과 배열 = 실행 순서. 장면이 끼면 집합 누수가 다시 안 보인다(§5c R2).
        const nx = by("omitnext");
        const nxRight = nx !== undefined && rs.indexOf(nx) === rs.findIndex((x) => x.scenario === "optfail") + 1;
        out.push(assert(
          `★②b ${ad}: 대체 질문이 남은 호출(optfail) 바로 다음, 같은 프로세스의 표시 없는 허용 턴 — 증명 있음(미해결 질문은 그 호출에만 산다)`,
          o("optfail", 1, false) && nxRight && nx.err === undefined && nx.exposed && nx.omitted && String(nx.text).length > 0,
          show({ f: by("optfail"), n: nx }),
        ));
      }
      const cx = by("ctx"), cp = by("ctxplain");
      out.push(assert(
        `★⑥ ${ad}: 허용 턴은 어댑터가 조립할 때 «직전 질문» 줄을 꺼내지 않는다(남아 있음) · 허용 없는 턴은 꺼낸다(양성 대조 — 실제로 조립에 넘긴다)`,
        cx !== undefined && cp !== undefined && cx.err === undefined && cp.err === undefined && cx.askedLeft === true && cp.askedLeft === false,
        show({ cx, cp }),
      ));
    }

    // ── ②b 공통 팩토리 — 예외는 그대로 전파되고 보호 집합을 건드리지 않는다 · 성공 뒤 중복 호출은 렌더·집합 변화 없음 ──
    {
      const { createPromptOptionsMcpServer } = await import("../../core/llm-runtime/capabilities/prompt-options-mcp.js");
      type H = { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text?: string }> }> };
      const handlerOf = (srv: unknown): H => (srv as { instance: { _registeredTools: Record<string, H> } }).instance._registeredTools.prompt_options!;
      const args = { question: "Q", options: [{ label: "예" }, { label: "아니요" }] };
      const cancel = new Error("회귀: 취소");
      const fbThrow = new Set<string>();
      let thrown: unknown;
      try {
        await handlerOf(createPromptOptionsMcpServer(async () => { throw cancel; }, new Set(), "regr:qfb-throw", fbThrow)).handler(args, {});
      } catch (e) { thrown = e; }
      let n = 0;
      const fbOk = new Set<string>(["Q"]);
      const h = handlerOf(createPromptOptionsMcpServer(async () => { n += 1; return { ok: true }; }, new Set(), "regr:qfb-dup", fbOk));
      await h.handler(args, {});
      const afterFirst = fbOk.size;
      await h.handler(args, {});
      const fbNone = new Set<string>();
      await handlerOf(createPromptOptionsMcpServer(undefined, new Set(), "regr:qfb-none", fbNone)).handler(args, {});
      out.push(assert(
        "★②b 공통 팩토리: 렌더 콜백 예외(취소)는 같은 객체로 전파되고 보호 집합에 안 남는다 · 성공이 앞선 실패 표시를 지우고 중복 호출은 재렌더·재표시 없음 · 미지원 분기는 표시",
        thrown === cancel && fbThrow.size === 0 && afterFirst === 0 && n === 1 && fbOk.size === 0 && fbNone.has("Q"),
        show({ same: thrown === cancel, throwSet: fbThrow.size, afterFirst, n, dupSet: fbOk.size, none: [...fbNone] }),
      ));
    }

    // ── ⑦ 대시보드 ────────────────────────────────────────────────────────────
    {
      const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, allIds: true, upTo: "sse.js", fetch: async () => jsonResponse({}, 404) });
      const A = "dashboard:regr-int", B = "dashboard:regr-plain";
      dash.run(`renderDelta({ threadKey: "${A}", adapter: "codex", seq: 0, delta: "내부 ", audience: "internal" }, 1)`);
      // 스트리밍 **중간**(확정 조각 전) — 내부 델타가 진행 말풍선을 만들면 그 사이 사용자가 내부 글을 답처럼 본다(독립 사냥 K3).
      const mid = dash.run(`(() => { const c = cardByThread.get("${A}"); return c ? { bubble: !!c.replyBubble, raw: c.replyRaw || "" } : null; })()`) as R | null;
      dash.run(`renderActivity({ threadKey: "${A}", adapter: "codex", seq: 0, kind: "text", audience: "internal", label: "text", text: "내부 메모 본문" }, 2)`);
      const a = dash.run(`(() => { const c = cardByThread.get("${A}"); return c ? { saw: !!c.sawTextSegment, bubble: !!c.replyBubble, last: !!c.lastTextBubble, steps: c.count, label: c.lastEl ? c.lastEl.textContent : "" } : null; })()`) as R | null;
      dash.run(`renderDelta({ threadKey: "${B}", adapter: "codex", seq: 0, delta: "보통 " }, 3)`);
      dash.run(`renderActivity({ threadKey: "${B}", adapter: "codex", seq: 0, kind: "text", label: "text", text: "보통 답" }, 4)`);
      const b = dash.run(`(() => { const c = cardByThread.get("${B}"); return c ? { saw: !!c.sawTextSegment, last: !!c.lastTextBubble } : null; })()`) as R | null;
      out.push(assert(
        "★⑦ 라이브: 내부 기록 델타·글 조각은 답 말풍선을 안 만들고 그 턴의 스텝 한 줄(«내부 기록») — 일반 글은 지금처럼 답 말풍선(양성 대조)",
        (mid === null || (!mid.bubble && mid.raw === "")) &&
          a !== null && !a.saw && !a.bubble && !a.last && a.steps === 1 && String(a.label).includes(i18nForContext("chat.internalNote")) && b !== null && b.saw && b.last,
        show({ mid, a, b }),
      ));
    }
    {
      const src = readFileSync(path.join(REPO, "packages/dashboard/js/history-render.js"), "utf8");
      const gm = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(src);
      const cb = /const canonicalBodyFor = \([\s\S]*?\n {6}\};/.exec(src);
      const ctx: { group?: (e: unknown[], a: unknown[]) => Array<{ kind: string; acts?: R[]; act?: R; entry?: R }> } = {};
      vm.createContext(ctx);
      vm.runInContext(`const renderedMsgKeys = new Set(); const msgKey = (ts, role) => ts + "|" + role;
        ${internalTextHelpersSource()} ${cb?.[0] ?? ""} ${gm?.[0] ?? ""} this.group = groupMergedItems;`, ctx);
      const T = "dashboard:regr-hist";
      const units = ctx.group!(
        [{ ts: 30, role: "assistant", threadKey: T, text: "작업자 알림을 내부에서 처리했습니다 — 사용자 보고 없음", notice: true }],
        [{ ts: 10, threadKey: T, seq: 0, kind: "tool", label: "steer_worker", detail: "" }, { ts: 20, threadKey: T, seq: 1, kind: "text", audience: "internal", label: "text", text: "내부 메모" }],
      );
      const kinds = units.map((u) => u.kind);
      const turnActs = units.filter((u) => u.kind === "turn").flatMap((u) => u.acts ?? []);
      const units2 = ctx.group!(
        [{ ts: 30, role: "assistant", threadKey: T, text: "통지", notice: true }],
        [{ ts: 20, threadKey: T, seq: 0, kind: "text", label: "text", text: "보통 답" }],
      );
      out.push(assert(
        "★⑦ 이력: 내부 기록 글 조각은 텍스트 버블이 아니라 그 턴의 스텝(«내부 기록»·본문은 상세) · 통지 행은 남는다",
        !kinds.includes("text") && turnActs.some((x) => x.kind === "note" && x.label === "chat.internalNote" && x.detail === "내부 메모") &&
          units.some((u) => u.kind === "msg" && u.entry?.notice === true),
        show(units),
      ));
      out.push(assert(
        "⑦ 이력: 일반 텍스트 세그먼트 바로 뒤의 통지 행도 «세그먼트의 중복» 으로 버리지 않는다(답 행 이동 판정과 같은 규칙)",
        units2.some((u) => u.kind === "text") && units2.some((u) => u.kind === "msg" && u.entry?.notice === true),
        show(units2),
      ));
    }

    // ── ⑧ 대시보드 — «내부 처리» 통지 = 짧은 시스템 상태 줄(2026-11-02 §12 — §11 의 비표시를 대체) ─────────────
    {
      const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, allIds: true, upTo: "sse.js", fetch: async () => jsonResponse({}, 404) });
      const PH = NOTICE_TEXTS[0];
      const A = "dashboard:regr-hide-int", B = "dashboard:regr-hide-plain", C = "dashboard:regr-hide-user";
      const turn = (k: string, base: number): void => {
        dash.run(`renderActivity({ threadKey: "${k}", adapter: "codex", seq: 0, kind: "tool", label: "steer_worker", detail: "" }, ${base})`);
        dash.run(`renderActivity({ threadKey: "${k}", adapter: "codex", seq: 1, kind: "text", audience: "internal", label: "text", text: "내부 메모" }, ${base + 1})`);
      };
      const out_ = (k: string, ts: number, extra: string): void =>
        dash.run(`renderChannelMessage({ type: "channel.message.out", ts: ${ts}, payload: { threadKey: "${k}", text: ${JSON.stringify(PH)}, notice: true, unread: false${extra} } }, "t")`);
      // 렌더된 트리 전부(가상 목록 + 묶음 안)에서 세는 도우미
      dash.run(`globalThis.__walk = () => { const all = []; const w = (n) => { all.push(n); for (const c of (n.children || [])) w(c); }; for (const it of vtItems) w(it.node); return all; }`);
      const count = (sel: string): number => dash.run(`__walk().filter((n) => (" " + (n.className || "") + " ").includes(" ${sel} ")).length`) as number;
      const phrases = (): number => (dash.run(`__walk().filter((n) => (" " + (n.className || "") + " ").includes(" chat-message ")).map((n) => n.textContent)`) as string[]).filter((t) => String(t).includes(PH!)).length;
      turn(A, 10);
      const before = { notices: count("sys-notice"), chats: count("channel-chat") };
      out_(A, 20, `, audience: "internal"`);
      const a = dash.run(`(() => { const c = cardByThread.get("${A}"); return c ? { closed: !!c.closed, done: !!(c.el && c.el.classList.contains("done")) } : null; })()`) as R | null;
      const afterA = { notices: count("sys-notice"), chats: count("channel-chat"), phrases: phrases() };
      turn(B, 30);
      out_(B, 40, "");
      const afterB = { notices: count("sys-notice"), phrases: phrases() };
      dash.run(`renderChannelMessage({ type: "channel.message.in", ts: 50, payload: { threadKey: "${C}", text: ${JSON.stringify(PH)} } }, "t")`);
      const afterC = { chats: count("channel-chat"), phrases: phrases() };
      out.push(assert(
        "★⑧ 라이브: 내부 표식 out — 시스템 상태 줄(`sys-notice`) 1·그 문구 1(일반 답 말풍선 아님) · 그 턴 카드는 마감(닫힘·완료) / 표식 없는 통지도 상태 줄 1 / 같은 문구의 사용자 글은 사용자 말풍선으로 그대로 보인다",
        a !== null && a.closed && a.done && afterA.notices === before.notices + 1 && afterA.chats === before.chats + 1 && afterA.phrases === 1 &&
          afterB.notices === afterA.notices + 1 && afterB.phrases === 2 && afterC.chats === afterA.chats + 2 && afterC.phrases === 3,
        show({ before, a, afterA, afterB, afterC }),
      ));
      // ★활동 없이 끝난 생략 턴(GPT 코드 R1, 2026-11-02 §12): 직전 턴이 텍스트 세그먼트로 답하고 마감돼 그 카드가 남아 있어도(`closed`·`sawTextSegment`),
      //  내부 처리 out 은 그 답 말풍선의 «세그먼트 중복» 으로 흡수되지 않고 상태 줄 1로 보인다 — 직전 답의 행 좌표(`data-rowts`)도 그대로.
      const D = "dashboard:regr-hide-silent";
      dash.run(`renderActivity({ threadKey: "${D}", adapter: "codex", seq: 0, kind: "text", label: "text", text: "보통 답 세그먼트" }, 60)`);
      dash.run(`renderChannelMessage({ type: "channel.message.out", ts: 61, payload: { threadKey: "${D}", text: "보통 답 세그먼트" } }, "t")`);
      const rowtsOf = (): unknown => dash.run(`(() => { const c = cardByThread.get("${D}"); return c && c.lastTextBubble ? c.lastTextBubble.dataset.rowts ?? null : null; })()`);
      const beforeD = { notices: count("sys-notice"), phrases: phrases(), rowts: rowtsOf() };
      out_(D, 70, `, audience: "internal"`);
      const afterD = { notices: count("sys-notice"), phrases: phrases(), rowts: rowtsOf() };
      out.push(assert(
        "★⑧ 라이브: 활동 없이 끝난 생략 턴 — 직전 답 카드(텍스트 세그먼트·마감)가 남아 있어도 내부 처리 out 은 상태 줄 1로 보이고, 직전 답 말풍선의 행 좌표를 바꾸지 않는다",
        beforeD.rowts === "61" && afterD.notices === beforeD.notices + 1 && afterD.phrases === beforeD.phrases + 1 && afterD.rowts === "61",
        show({ beforeD, afterD }),
      ));
      // ★남은 진행 말풍선(GPT 코드 R2): 앞 시도가 부분 글만 흘리고 답 없이 끝난(turn_error → `markTurnCardDone`) 뒤 생략 턴의 내부 처리 out 이 오면 —
      //  상태 줄 1 · 부분 글은 덮어쓰지 않고 그대로 · 스트리밍 커서 0 · 카드의 진행 말풍선 참조 정리.
      const E = "dashboard:regr-hide-stream";
      dash.run(`renderDelta({ threadKey: "${E}", adapter: "codex", seq: 0, delta: "부분 답변" }, 80)`);
      dash.run(`markTurnCardDone("${E}")`);
      const streamingE = (): number => dash.run(`__walk().filter((n) => (" " + (n.className || "") + " ").includes(" streaming ")).length`) as number;
      const beforeE = { notices: count("sys-notice"), streaming: streamingE(), partial: (dash.run(`__walk().filter((n) => (" " + (n.className || "") + " ").includes(" chat-message ") && n.textContent === "부분 답변").length`) as number) };
      out_(E, 90, `, audience: "internal"`);
      const afterE = {
        notices: count("sys-notice"), streaming: streamingE(),
        partial: (dash.run(`__walk().filter((n) => (" " + (n.className || "") + " ").includes(" chat-message ") && n.textContent === "부분 답변").length`) as number),
        refs: dash.run(`(() => { const c = cardByThread.get("${E}"); return c ? { bubble: c.replyBubble === null, msg: c.replyMsg === null, raw: c.replyRaw } : null; })()`) as R | null,
      };
      out.push(assert(
        "★⑧ 라이브: 남은 진행 말풍선(답 없이 끝난 앞 시도) 뒤 내부 처리 out — 상태 줄 1 · 부분 글 그대로(덮어쓰기 0) · 스트리밍 커서 0 · 진행 말풍선 참조 정리",
        beforeE.streaming >= 1 && beforeE.partial === 1 && afterE.notices === beforeE.notices + 1 && afterE.streaming === 0 && afterE.partial === 1 &&
          afterE.refs !== null && afterE.refs.bubble === true && afterE.refs.msg === true && afterE.refs.raw === "",
        show({ beforeE, afterE }),
      ));
    }
    {
      const src = readFileSync(path.join(REPO, "packages/dashboard/js/history-render.js"), "utf8");
      const tabs = readFileSync(path.join(REPO, "packages/dashboard/js/tabs.js"), "utf8");
      const gm = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(src);
      const cb = /const canonicalBodyFor = \([\s\S]*?\n {6}\};/.exec(src);
      const sp = /const splitLiveResume = \([\s\S]*?\n {6}\};/.exec(tabs);
      const ctx: R = {};
      vm.createContext(ctx);
      vm.runInContext(`const renderedMsgKeys = new Set(); const msgKey = (ts, role) => ts + "|" + role;
        ${internalTextHelpersSource()} ${cb?.[0] ?? ""} ${gm?.[0] ?? ""} ${sp?.[0] ?? ""}
        this.group = groupMergedItems; this.split = splitLiveResume; this.keys = renderedMsgKeys; this.isInt = isInternalMessage;`, ctx);
      const T = "dashboard:regr-hide-hist";
      const PH = NOTICE_TEXTS[0];
      const tool = (ts: number, seq: number): R => ({ ts, threadKey: T, seq, kind: "tool", label: "steer_worker", detail: "" });
      const internalRow = { ts: 30, role: "assistant", threadKey: T, text: PH, notice: true, data: { audience: "internal" } };
      const u1 = ctx.group([internalRow], [tool(10, 0), { ts: 20, threadKey: T, seq: 1, kind: "text", audience: "internal", label: "text", text: "내부 메모" }]) as R[];
      // 내부 행이 런을 끊는다 — 뒤 턴의 활동이 seq 를 이어 가도 같은 카드로 합쳐지지 않는다(라이브에선 이 out 이 카드를 마감한다).
      const u2 = ctx.group([internalRow], [tool(10, 0), tool(20, 1), tool(40, 2)]) as R[];
      const legacy = ctx.group([{ ts: 30, role: "assistant", threadKey: T, text: PH, notice: true }], [tool(10, 0)]) as R[];
      const userSame = ctx.group([{ ts: 30, role: "user", threadKey: T, text: PH }, { ts: 31, role: "user", threadKey: T, text: "내부 처리" }, { ts: 32, role: "assistant", threadKey: T, text: "내부 처리", notice: true }], []) as R[];
      out.push(assert(
        "★⑧ 이력(병합 함수 vm): 내부 표식 행 → 통지 단위 1(상태 줄 — 세그먼트 중복으로 안 버려짐)·그 턴 스텝은 남음·도구 런을 끊음 / 표식 없는 옛 통지 행 → 통지 단위 1 / 같은 문구·짧은 같은 말의 사용자 행·표식 없는 통지 → 전부 보임",
        u1.filter((u) => u.kind === "msg" && u.entry?.notice === true && u.entry?.data?.audience === "internal").length === 1 && u1.some((u) => u.kind === "turn") &&
          u2.filter((u) => u.kind === "turn").length === 2 &&
          legacy.some((u) => u.kind === "msg" && u.entry?.notice === true) && userSame.length === 3 && userSame.every((u) => u.kind === "msg"),
        show({ u1, u2, legacy, userSame }),
      ));
      const acts = [tool(10, 0), { ts: 20, threadKey: T, seq: 1, kind: "text", audience: "internal", label: "text", text: "내부 메모" }];
      const s1 = ctx.split(acts, [internalRow], true) as R;
      const s2 = ctx.split([...acts, tool(40, 0)], [internalRow], true) as R;
      const s3 = ctx.split(acts, [{ ts: 30, role: "assistant", threadKey: T, text: PH, notice: true }], true) as R;
      out.push(assert(
        "★⑧ 진행 턴 이어받기: 내부 표식 행이 마지막 활동 뒤면 그 런은 끝난 턴(live 0 — 새 턴 활동 전 탭 복귀에 진행 카드로 되살아나지 않음) · 새 턴 활동이 있으면 그 런만 live(양성 대조) · 표식 없는 통지는 종전 그대로",
        s1.live.length === 0 && s1.hist.length === 2 && s2.live.length === 1 && s2.live[0].ts === 40 && s3.live.length === 2,
        show({ s1, s2, s3 }),
      ));
      // 두 판정(대시보드 `isInternalMessage` · 서버 `isInternalChatEntry`)에 같은 입력표 — 갈리면 화면과 목록이 다른 말을 한다.
      const { isInternalChatEntry } = await import("../../store/chat-log.js");
      const table: Array<[R, boolean]> = [
        [{ data: { audience: "internal" } }, true],
        [{ data: { audience: "internal" }, text: "아무 글", role: "user" }, true],
        [{ data: { audience: "Internal" } }, false],
        [{ data: { audience: "public" } }, false],
        [{ data: { replyTo: { text: "x" } } }, false],
        [{ data: null }, false],
        [{}, false],
        [{ text: PH, notice: true }, false],
        [{ text: PH, role: "user" }, false],
        // ★글 내용과 무관해야 한다 — 짧은 말·다른 언어·빈 글·보통 답 모두, 표식이 없으면 보이고 있으면 숨는다(문구 판정이 섞이면 여기서 갈린다 — 독립 변이 M07)
        ...(["내부 처리", "Handled", NOTICE_TEXTS[1] ?? "", "", "보통 답", "작업자 알림"] as string[]).flatMap((t): Array<[R, boolean]> => [
          [{ text: t, role: "user" }, false],
          [{ text: t, role: "assistant", notice: true }, false],
          [{ text: t, role: "assistant", notice: true, data: { audience: "internal" } }, true],
        ]),
      ];
      const dashRes = table.map(([x]) => ctx.isInt(x) === true);
      const srvRes = table.map(([x]) => isInternalChatEntry(x as never));
      out.push(assert(
        "⑧ 두 판정(대시보드·서버)이 같은 입력표에 같은 답 — 표식만 본다(문구·통지 표식만으로는 아니다) · 대시보드는 라이브 payload 의 `audience` 도 본다",
        table.every(([, want], i) => dashRes[i] === want && srvRes[i] === want) && ctx.isInt({ audience: "internal" }) === true,
        show({ dashRes, srvRes }),
      ));
    }

    // ── 진입점·배선 대조(실행이 어려운 자리만) ─────────────────────────────────
    {
      const { readSourceSync, stripComments } = await import("./_wiring.js");
      const idx = stripComments(readSourceSync("src/index.ts"));
      const at = (re: RegExp): number => { const m = re.exec(idx); return m === null ? -1 : m.index; };
      // 성공 경로의 채널 답·기록·사본·제안이 **전부** `finishTurnOutput` 의 `deliver` 안에 있는가 — 생략 갈래가 그걸 부를 수 없는 구조인지.
      // 진입점은 위에서 실행으로 잰 함수들을 **부르기만** 한다 — 그 연결(어느 함수에 무엇을 넘기나)만 소스로 본다.
      const finAt = at(/const fate = await finishTurnOutput\(\{\s*msg,\s*out,\s*appended:\s*stopHook\.additionalContext,\s*bus,\s*deliver: \(\) =>\s*deliverTurnReply\(\{/);
      const catchAt = finAt > 0 ? idx.indexOf("} catch (e) {", finAt) : -1; // 성공 경로의 끝 = 그 뒤 첫 catch(실패 경로 — 거기선 답 대신 실패 안내가 나간다)
      const tail = finAt > 0 && catchAt > finAt ? idx.slice(finAt, catchAt) : "";
      out.push(assert(
        "④ 진입점 연결: Stop 훅 뒤 `finishTurnOutput` 하나 → `deliver` 는 `deliverTurnReply`(사본=fanOutEgress·제안=maybeSuggestNextMessage 를 넘김) · 그 밖에 `msg.reply`·사본·제안 직접 호출 없음 · 들이기는 `admitTurn`(진짜 줄 `enqueueThreadTurn`) · 턴 입구는 `openTurnSteering`",
        finAt > 0 && at(/const stopHook = await runStopHooks\(/) < finAt &&
          /fanOut: \(text, original\) => fanOutEgress\(egressTargets, text, bus, msg\.threadKey, original\)/.test(tail) &&
          /suggest: \(\) => maybeSuggestNextMessage\(msg, out\.nextSuggestion\)/.test(tail) && !/msg\.reply\(/.test(tail) &&
          /steeringCh = openTurnSteering\(msg, steeringChannels, turnAc\.signal, STEERING_ENABLED\)/.test(idx) &&
          /return admitTurn\(msg, \{[\s\S]{0,1600}?channels: steeringChannels,[\s\S]{0,1600}?enqueue: enqueueThreadTurn,/.test(idx),
        { finAt, catchAt, tailLen: tail.length },
      ));
      const pa = stripComments(readSourceSync("src/core/prompt-assembly.ts"));
      const sse = stripComments(readSourceSync("packages/dashboard/js/sse.js"));
      out.push(assert(
        "⑥·⑦ 배선: 회수 줄도 같은 플래그로 막는다 · 배지는 `unread:false` 통지에 안 오른다",
        /const recovering = reportOmittable === true \? "" : takeRecoveryNoticeLineSafe\(threadKey\)/.test(pa) &&
          /channel\.message\.out"\s*&&\s*!\(ev\.payload\s*&&\s*ev\.payload\.unread\s*===\s*false\)\)\s*bumpUnread\(tk\)/.test(sse),
        "src 대조",
      ));
    }
    return out;
  },
};
