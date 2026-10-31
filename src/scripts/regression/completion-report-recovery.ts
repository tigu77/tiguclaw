/**
 * 회귀: **완료 보고 복구** — 원결과·원오류 영속 · 통지 전달 상태 · 다음 사람 메시지 때 회수 (2026-10-31 설계
 * docs/decisions/2026-10-31-completion-report-recovery-design.md §11 증분 2~4).
 *
 * 사고(진단 2026-10-31 기제 A·C): 백그라운드 작업이 끝났는데 종료 통지가 끝내 못 가면 시스템이 그 사실을 잊었고(A), 재시작하면 결과·오류를
 *  정식 조회로 못 읽었다(C — «그런 작업이 없습니다»). 메인은 결과를 몰라 같은 작업을 다시 띄웠다.
 *
 * 지키는 것(자식 `_completion-report-recovery-child.ts` — 진짜 레지스트리·저장소·조회 도구·대시보드 라우트·발송 통로·회수 입구, 채널만 가짜):
 *  - 재시작(새 프로세스) 뒤 단건·목록·`list_workers`·대시보드 단건이 표에서 읽는다 · 구버전 행은 사유를 말한다 · 저장 상한 표기 · UTF-16/서로게이트
 *  - 정리로 미전달 행이 상한 밖으로 나가면 상태별 건수 로그
 *  - 첫 통지 실패 → `undelivered`(+사람 대화 키 / 스케줄 소유는 NULL) · 성공 → `delivered` · 부모 결과함·연쇄 취소·합류 → NULL · 첫 통지 좌표 그대로
 *  - 보내는 도중 종료 → 부팅 정리 → `undelivered` · 재전달 도중 종료 → 시도 수대로 `undelivered`/`gave_up`
 *  - 회수: 같은 세션 사람 메시지만 · 그 메시지가 온 곳으로 · 메시지당 3건 · 행당 3회 · 목적지 미확정·미등록 채널·보관 대화·다른 세션·스케줄 소유 → 0 ·
 *    같은 틱 두 메시지 → 1회 · 서로 다른 채널 동시 → 먼저 잡은 쪽 · 뒤 청크 실패를 실패로 · `msg.reply` 안 씀 · 한도 재개 현재 상태 문구 ·
 *    정리 경합 0행 무해 · 기록 실패 뒤 재선점 0 → 재시작 뒤 1회 · 한 턴 줄(보내는 중 · 남은 건수 · 읽으면 지움)
 *  - 배선(소스 대조 — `src/index.ts` 클로저는 import 로 못 뽑는다): 부팅 정리가 채널 시작 **전** · 회수 입구가 `queueHandler` 맨 앞 `steerable` 뒤 ·
 *    종료 기록이 `INSERT OR REPLACE` 를 안 탄다
 *
 * 등급: **동작**(자식 5단계 · 재시작은 진짜 프로세스 경계) + 배선.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceSync } from "./_wiring.js";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_completion-report-recovery-child.ts");
type J = Record<string, unknown>;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const runPhase = async (home: string, phase: string, ids: unknown): Promise<J | string> => {
  const r = await spawnWithin(120_000, `completion-report-recovery:${phase}`, ["--import", "tsx", CHILD, phase], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CRR_HOME: home, CRR_IDS: JSON.stringify(ids ?? {}) },
  });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (r.timedOut || line === undefined) return `${phase}: ${r.timedOut ? "timeout" : "no output"} — ${(r.err || r.out).slice(-600)}`;
  return JSON.parse(line) as J;
};

export const check: RegressionCheck = {
  name: "completion-report-recovery",
  guards:
    "백그라운드 작업의 종료 통지가 끝내 못 가면 시스템이 잊고(다시 보낼 길 없음), 재시작하면 결과·오류를 정식 조회로 못 읽어 메인이 같은 작업을 다시 띄우던 것(2026-10-31 진단 기제 A·C)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const s = (v: unknown): string => JSON.stringify(v).slice(0, 400);

    // ── 증분 2 — 영속·조회(재시작 = 새 프로세스) ─────────────────────────────────────────────────
    const homeP = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "crr-persist-"));
    const pa = await runPhase(homeP, "persist-a", {});
    if (typeof pa === "string") return [assert("자식(persist-a)이 결과를 낸다", false, pa)];
    const pb = await runPhase(homeP, "persist-b", pa.ids);
    if (typeof pb === "string") return [assert("자식(persist-b)이 결과를 낸다", false, pb)];
    const str = (k: string): string => String(pb[k] ?? "");
    const big = pb.big as { len: number; capped?: { kept: number; total: number }; lone: boolean; endsA: boolean };
    const bigErr = pb.bigErr as { len: number; capped?: { kept: number; total: number }; lone: boolean };
    const dashF1 = pb.dashF1 as { status?: string; result?: string; error?: string; notice?: { recover?: string } };
    out.push(
      assert("종료 기록이 원결과를 같은 행에 남긴다(REPLACE 로 지워지지 않는다)", pa.doneRowHasText === true, s(pa.doneRowHasText)),
      assert("재시작 뒤 메모리는 비어 있다(전제)", pb.memEmpty === true, s(pb.memEmpty)),
      assert(
        "★재시작 뒤 `read_worker_result(id)` 가 표에서 원결과를 읽는다(완료)",
        str("readD").includes("결과 ✅ 이모지 포함 🎉 끝") && !str("readD").includes("그런 작업이 없습니다"),
        str("readD").slice(0, 200),
      ),
      assert(
        "★재시작 뒤 마무리 실패는 «실패(마무리 단계) · 원인» 머리 + 본 보고",
        str("readF1").includes("실패(마무리 단계) · 원인: fetch failed") && str("readF1").includes("[F1 본 보고] 완성됨"),
        str("readF1").slice(0, 200),
      ),
      assert("원결과 없는 실패는 원오류를 말한다 · 취소는 «중지됐습니다»", str("readF0").includes("plain failure") && str("readC").includes("중지됐습니다"), `${str("readF0").slice(0, 80)} / ${str("readC").slice(0, 60)}`),
      assert(
        "★구버전 행(본문 열 없음)은 «없음» 이 아니라 «본문 저장 이전 판» 이라고 말한다 — 이주가 됐다",
        str("readLegacyDone").includes("본문 저장 이전 판") && str("readLegacyFailed").includes("본문 저장 이전 판"),
        str("readLegacyDone").slice(0, 120),
      ),
      assert("모르는 id 는 종전 안내 그대로", str("readUnknown").includes("그런 작업이 없습니다"), str("readUnknown").slice(0, 80)),
      assert(
        "★재시작 뒤 목록(`read_worker_result()`)·`list_workers` 에 끝난 작업이 다 보인다(구버전 행 포함)",
        ["이모지완료", "마무리실패", "그냥실패", "취소", "큰결과", "큰오류", "옛 완료", "옛 실패"].every((l) => str("list").includes(l) && str("listWorkers").includes(l)),
        `${str("list").slice(0, 120)} / ${str("listWorkers").slice(0, 120)}`,
      ),
      assert(
        "★대시보드 단건이 재시작 뒤 표에서 원결과·원오류·전달 판정을 준다",
        dashF1.status === "failed" && dashF1.result === "[F1 본 보고] 완성됨" && dashF1.error === "fetch failed" && dashF1.notice?.recover === "none",
        s(dashF1),
      ),
      assert("대시보드 단건 — 구버전 행은 `bodyPredates`", (pb.dashLegacy as { bodyPredates?: boolean }).bodyPredates === true, s(pb.dashLegacy)),
      assert(
        "★상한 이내의 보충 평면 문자(이모지) 원문 — 재시작 뒤 잘림 표기 **없음**(SQL length 비교면 거짓 표기)",
        (pb.emoji as { capped?: unknown }).capped === undefined && !str("readD").includes("저장 상한"),
        s(pb.emoji),
      ),
      assert(
        "★상한 경계가 서로게이트 쌍 가운데 → 저장 255,999 단위 · 전체 길이 · 홑 서로게이트 없음 · 표기",
        big.len === 255_999 && big.capped?.kept === 255_999 && big.capped?.total === 256_002 && big.lone === false && big.endsA === true &&
          str("readBIG").includes("저장 상한으로 앞부분만 보존(앞 255,999/전체 256,002자)"),
        s(big),
      ),
      assert(
        "★원결과 없는 실패의 원오류도 상한·표기(앞 256,000/전체 300,001) · 홑 서로게이트 없음",
        bigErr.len === 256_000 && bigErr.capped?.total === 300_001 && bigErr.lone === false && str("readBIGERR").includes("저장 상한으로 앞부분만 보존(앞 256,000/전체 300,001자)"),
        s(bigErr),
      ),
      assert("상한 초과는 본문 없이 로그 한 줄씩", pa.capLogs === 2, s(pa.capLogs)),
      assert(
        "★정리로 미전달 행이 보관 상한 밖으로 나가면 상태별 건수를 남긴다",
        pb.f0Gone === true && (pb.pruneLog as string[]).some((l) => l.includes("미전달 1")),
        s(pb.pruneLog),
      ),
    );

    // ── 증분 3·4 — 전달 상태 · 회수 ─────────────────────────────────────────────────────────────
    const homeD = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "crr-delivery-"));
    const da = await runPhase(homeD, "delivery-a", {});
    if (typeof da === "string") return [...out, assert("자식(delivery-a)이 결과를 낸다", false, da)];
    const db = await runPhase(homeD, "delivery-b", da.ids);
    if (typeof db === "string") return [...out, assert("자식(delivery-b)이 결과를 낸다", false, db)];
    const dc = await runPhase(homeD, "delivery-c", db.crash);
    if (typeof dc === "string") return [...out, assert("자식(delivery-c)이 결과를 낸다", false, dc)];
    const st = da.states as Record<string, { state: string | null; session: string | null; status: string }>;
    const S = "dashboard:crr-s";
    const g = (o: unknown, k: string): Record<string, unknown> => (o as Record<string, Record<string, unknown>>)[k] ?? {};
    const B = (k: string): string => String(db[k] ?? "");
    out.push(
      assert(
        "★첫 통지 실패(실패 원문·완료 안전망·재시작 중단 통지) → `undelivered` + 사람 대화 키",
        ["A", "K", "G", "H"].every((k) => st[k]?.state === "undelivered" && st[k]?.session === S) && st.H?.status === "interrupted",
        s({ A: st.A, G: st.G, H: st.H }),
      ),
      assert("스케줄 소유 작업은 `undelivered` 이되 세션 NULL(자동 회수 제외)", st.C?.state === "undelivered" && st.C?.session === null, s(st.C)),
      assert("첫 통지 성공 → `delivered`", st.B?.state === "delivered", s(st.B)),
      assert(
        "★부모 결과함·연쇄 취소·합류 넘겨받음은 «미전달» 이 아니다(NULL)",
        st.childBox?.state === null && st.cascade?.state === null && st.joined?.state === null,
        s({ childBox: st.childBox, cascade: st.cascade, joined: st.joined }),
      ),
      assert("첫 통지는 종전 좌표(`destForJob` — notifyDest)로 간다", JSON.stringify(da.firstTarget) === JSON.stringify(["111"]), s(da.firstTarget)),
      assert("★보내는 도중 종료 → 그 프로세스엔 `sending` · 부팅 정리 → `undelivered`", da.jState === "sending" && db.jAfterBoot === "undelivered", `${String(da.jState)} → ${String(db.jAfterBoot)}`),
      assert(
        "★재전달 도중 종료 → 부팅 정리가 시도 수대로(1 → `undelivered` · 3 → `gave_up`)",
        g(dc, "afterBoot").r1 === "undelivered/1" && g(dc, "afterBoot").r3 === "gave_up/3",
        s(dc.afterBoot),
      ),
      // 조회 도구 출력(§4-3)
      assert(
        "★조회 도구 — 미전달·자동: «작업을 띄운 대화에 다음 일반 메시지가 오면 그 메시지가 온 곳으로 자동 재전달(시도 0/3)» — 다른 대화에서 읽어도 «이 대화» 아님",
        B("readA").includes("작업을 띄운 대화에 다음 일반 메시지가 오면 그 메시지가 온 곳으로 자동 재전달(시도 0/3)") &&
          B("readAOther").includes("작업을 띄운 대화에") && !B("readAOther").includes("이 대화"),
        B("readAOther").slice(0, 200),
      ),
      assert("조회 도구 — 보관 대화 · 사람 소유 아님 · 전달됨 · 정상 경로 NULL 이 각각 갈린다",
        B("readARCH").includes("보관돼 자동 재전달 보류") && B("readC").includes("자동 재전달 대상 아님") && B("readB").includes("보고 전달: 전달됨") &&
          B("readChild").includes("보고 전달 기록 없음"),
        `${B("readARCH").slice(-60)} / ${B("readC").slice(-50)} / ${B("readB").slice(-20)}`,
      ),
      assert("목록·`list_workers` 에 «보고 미전달» 짧은 표시 · 재시작 중단 작업도 보인다",
        B("listS").includes("A실패") && B("listS").includes("· 보고 미전달") && B("listWorkersS").includes("중단됨(재시작)") && B("listWorkersS").includes("· 보고 미전달"),
        B("listWorkersS").slice(0, 200),
      ),
      assert("★대시보드 단건 `notice.recover` 가 선점과 같은 판정(auto / not_human_owner)",
        g(db, "dashA").recover === "auto" && g(db, "dashC").recover === "not_human_owner", s({ a: db.dashA, c: db.dashC })),
      // 회수 — 0 이어야 하는 것들
      assert("다른 세션 메시지 → 회수 0", g(db, "otherSession").p === true && g(db, "otherSession").aAttempts === 0, s(db.otherSession)),
      assert("★목적지 미확정(미등록 채널 · 물리 발송 채널인데 주소 없음) → 선점 0 · 시도 그대로 · 기본 좌표 발송 0",
        g(db, "unregistered").p === true && g(db, "noAddress").p === true && g(db, "noAddress").aAttempts === 0 && g(db, "noAddress").tgDelta === 0,
        s({ u: db.unregistered, n: db.noAddress })),
      assert("★보관된 대화 명시 메시지 → 선점 0 · 시도 그대로 · 보관 해제 뒤 메시지 → 회수",
        g(db, "archived").p === true && g(db, "archived").attempts === 0 && g(db, "unarchived").state === "delivered" && g(db, "unarchived").attempts === 1,
        s({ a: db.archived, u: db.unarchived })),
      assert("스케줄 소유는 어느 메시지로도 회수 안 됨", g(db, "schedOwned").p === true && g(db, "schedOwned").state === "undelivered", s(db.schedOwned)),
      // ⑩ 대시보드 메시지가 텔레그램 소유 작업을 회수
      assert(
        "★현재 채널로 — 텔레그램 소유 작업 · 같은 대화의 대시보드 메시지 → 그 세션 탭 관측 3건 · 텔레그램 물리 발송 0 · 메시지당 3건 · `delivered`(시도 1) · `msg.reply` 안 씀",
        g(db, "dash").tgDelta === 0 && g(db, "dash").observed === 3 && g(db, "dash").replies === 0 &&
          JSON.stringify((g(db, "dash").states as string[]).slice(0, 3)) === JSON.stringify(["delivered/1", "delivered/1", "delivered/1"]),
        s(db.dash),
      ),
      assert("회수 글은 대화 기록(chat_log)에 그 세션으로 남는다", db.chatRows === 3, s(db.chatRows)),
      assert(
        "★재전달 본문 = 머리 «↻ … 다시 보냅니다» + 저장 내용 렌더(실패 원인 · 완료 결과 전문)",
        (g(db, "dash").texts as string[]).every((t) => t.startsWith("↻")) &&
          (g(db, "dash").texts as string[]).some((t) => t.includes("원인: fetch failed")) &&
          (g(db, "dash").texts as string[]).some((t) => t.includes("[G 결과 전문]")),
        s(g(db, "dash").texts),
      ),
      assert(
        "★한 턴 줄 — «방금 메시지가 온 곳으로 따로 다시 보내는 중 · 도착 여부는 아직 모릅니다 · 남은 미전달 2건» · «보냈습니다» 없음 · 원문 제공 허용 · 읽으면 지운다",
        B("line").includes("따로 다시 보내는 중") && B("line").includes("도착 여부는 아직 모릅니다") && B("line").includes("남은 미전달 2건") &&
          !B("line").includes("보냈습니다") && B("line").includes("read_worker_result(job_id)") && !B("lineAgain").includes("다시 보내는 중"),
        B("line").slice(0, 300),
      ),
      assert(
        "★텔레그램 답글 메시지(같은 세션) → 그 chatId 로 · 세션 라벨 · 답장 매핑(그 글에 답장하면 그 세션으로) · 남은 2건",
        g(db, "tgReply").sent === 2 && (g(db, "tgReply").targets as string[]).every((t) => t === "222") &&
          (g(db, "tgReply").labels as string[]).every((l) => l === S) && g(db, "tgReply").mapped === S && g(db, "tgReply").leftAuto === 0,
        s(db.tgReply),
      ),
      assert("★재시작 중단 통지의 회수 본문은 «데몬 재시작으로 중단» 분기(원인 미상 실패 아님)",
        (g(db, "tgReply").texts as string[]).some((t) => t.includes("데몬 재시작으로 중단")), s(g(db, "tgReply").texts)),
      assert("★같은 세션 메시지 둘을 같은 틱에 → 발송 1회", g(db, "sameTick").secondNone === true && g(db, "sameTick").sends === 1 && g(db, "sameTick").state === "delivered", s(db.sameTick)),
      assert(
        "★서로 다른 채널 동시 → 먼저 잡은 쪽(텔레그램)으로만 · 그 실패는 시도로 셈 → 다음 대시보드 메시지가 대시보드로",
        g(db, "crossChannel").dashNone === true && g(db, "crossChannel").tgTries === 1 && g(db, "crossChannel").state === "undelivered" &&
          g(db, "crossChannel").attempts === 1 && g(db, "crossChannel").finalState === "delivered" && g(db, "crossChannel").finalAttempts === 2 &&
          g(db, "crossChannel").dashObserved === 1,
        s(db.crossChannel),
      ),
      assert(
        "★3회 실패 → `gave_up`(로그 한 줄) · 4번째 메시지 → 0 · 조회는 «재전달 포기(3/3) — 원문은 이 조회로»",
        JSON.stringify(g(db, "gaveUp").seq) === JSON.stringify(["undelivered/1", "undelivered/2", "gave_up/3"]) && g(db, "gaveUp").fourth === true &&
          String(g(db, "gaveUp").read).includes("재전달 포기(3/3)") && g(db, "gaveUp").giveUpLog === 1,
        s(db.gaveUp),
      ),
      assert(
        "★뒤 청크 실패 → 실패로 센다(빈 반환을 성공으로 안 읽음) · 다음 재전달은 **전문**(앞부분 중복 허용)",
        g(db, "partial").afterPartial === "undelivered/1" && g(db, "partial").final === "delivered/2" && g(db, "partial").fullHasHead === true && g(db, "partial").replies === 0,
        s(db.partial),
      ),
    );
    // 한도 재개(§4-4) — 재시작 뒤(메모리 없음) 현재 상태로
    const lim = (db.limit ?? {}) as Record<string, unknown>;
    const L = (k: string): string => String(lim[k] ?? "");
    const noRetry = (t: string): boolean => !/다시 시켜|처음부터 다시/.test(t);
    out.push(
      assert(
        "★대기 중(합쳐져 늦춰짐) → `failedLimitResume` 갈래 · 그 scheduleId 취소 길 · «다시 시켜» 없음 · 회수 경로로 실제 발송된 글도 같다",
        L("waiting").includes("사용량 한도로 멈췄습니다") && L("waiting").includes(`/schedule delete ${String(lim.scheduleId)}`) && noRetry(L("waiting")) &&
          ((lim.sentTexts as string[] | undefined) ?? []).some((t) => t.includes(`/schedule delete ${String(lim.scheduleId)}`)),
        L("waiting").slice(0, 300),
      ),
      assert("★재개 처리 중 → «자동 이어가기가 지금 진행 중 — 다시 시키지 않으셔도 됩니다»", L("resuming").includes("지금 진행 중") && noRetry(L("resuming").replace("다시 시키지 않으셔도", "")), L("resuming").slice(-160)),
      assert(
        "★예약 없음(행 없음·/stop·옮긴 타이머) → 중립 «지금 이 작업의 자동 이어가기 예약은 없습니다» · 예약 단정·재실행 권유 없음",
        [L("none"), L("moved"), L("deleted")].every((t) => t.includes("자동 이어가기 예약은 없습니다") && noRetry(t) && !t.includes("/schedule delete")),
        L("moved").slice(-200),
      ),
      assert(
        "★조회 예외(대기가 살아 있어도) → «확인할 수 없습니다» — «예약돼 있습니다»·«예약은 없습니다»·«다시 시켜 주세요» 셋 다 없음",
        L("unreadable").includes("확인할 수 없습니다") && !L("unreadable").includes("/schedule delete") && !L("unreadable").includes("예약은 없습니다") && noRetry(L("unreadable")),
        L("unreadable").slice(-200),
      ),
      assert("한도가 아닌 실패는 조회가 실패해도·평소에도 일반 실패 문구 그대로", L("nonLimit").includes("실패했습니다") && L("nonLimitUnreadable") === L("nonLimit"), L("nonLimit").slice(-120)),
      assert(
        "(§4-4 ⑱ 확인) 해제 시각이 이미 지난 대기 — 원오류의 낡은 «N초 뒤» 를 쓰지 않고 지금 읽은 예약 시각에서 낸다(최소 «약 1분»)",
        L("pastWaiting").includes("사용량 한도로 멈췄습니다") && /1분/.test(L("pastWaiting")),
        L("pastWaiting").slice(0, 300),
      ),
    );
    out.push(
      assert(
        "★렌더는 **발송 직전** — 앞 알림 발송을 기다리는 사이 예약이 지워지면 뒤 한도 알림은 «예약은 없습니다»(낡은 «이어서 진행 · /schedule delete» 아님)",
        g(db, "renderAtSend").n === 2 && String(g(db, "renderAtSend").last).includes("자동 이어가기 예약은 없습니다") &&
          !String(g(db, "renderAtSend").last).includes("/schedule delete"),
        String(g(db, "renderAtSend").last).slice(-220),
      ),
      assert(
        "★발송 뒤 상태 기록 실패 → 같은 프로세스에선 재선점 0(발송 1회) · 부팅 정리 뒤 메시지에 1회 더(허용 중복) · 로그",
        g(db, "recordFail").stuck === "recovering" && g(db, "recordFail").again === true && g(db, "recordFail").sendsBefore === 1 &&
          g(db, "recordFail").sendsAfter === 2 && g(db, "recordFail").final === "delivered" && g(db, "recordFail").log === true,
        s(db.recordFail),
      ),
      assert(
        "★정리 경합 — 한 번에 선점한 3건이 첫 발송 도중 보관 상한 밖으로 지워져도 **셋 다** 스냅숏으로 발송 · 첫 통지 중 행도 · 뒤 전이 0행(로그) · 예외 없음 · 행 재생성 없음 · 정리 로그에 상태별",
        g(db, "pruneRace").sends777 === 3 &&
          g(db, "pruneRace").pruneLogRecovering === true && g(db, "pruneRace").pruneLogSending === true && g(db, "pruneRace").threw === false &&
          g(db, "pruneRace").recreated === false && g(db, "pruneRace").skipLogs === 2,
        s(db.pruneRace),
      ),
    );

    // ── 증분 5 — 대시보드 펼침: **제품 블록**(hydrate·보고 적용)을 떼어 **실제 서버 단건 응답**(위 자식 출력) 위에서 돌린다 ─────────
    //  ★재구현하지 않는다 — 소스 블록을 그대로 실행한다(`job-task-full-on-expand` 관용구). 서버가 주는 모양과 화면이 읽는 모양이 갈리면 여기서 빨개진다.
    {
      const bd = readSourceSync("packages/dashboard/js/background-drawer.js");
      const a = bd.indexOf("const hydrateFullTask = (jobId, entry) => {");
      const b = bd.indexOf('registerBuiltinHandler("job.toggleDetail"');
      const block = a >= 0 && b > a ? bd.slice(a, b) : "";
      const ko = JSON.parse(readSourceSync("locales/ko.json")) as Record<string, string>;
      const i18n = (k: string, p: Record<string, unknown> = {}): string =>
        (ko[k] ?? k).replace(/\{(\w+)\}/g, (m, n: string) => (p[n] === undefined ? m : String(p[n])));
      // 저장 상한 표기는 공용(`util.js`) — 그것도 소스 그대로 떼어 쓴다.
      const util = readSourceSync("packages/dashboard/js/util.js");
      const capAt = util.indexOf("const storedCapNote = (c) =>");
      const capSrc = capAt < 0 ? "" : util.slice(capAt, util.indexOf(";\n", capAt) + 2);
      // eslint-disable-next-line no-new-func
      const storedCapNote = new Function("i18n", `${capSrc} return storedCapNote;`)(i18n) as (c: unknown) => string;
      const render = async (
        status: string,
        body: unknown,
        /** 이벤트가 이미 채운 카드 상태(잘린 요약) — 펼침이 단건 원문으로 **덮는지** 잰다. */
        preset: { result?: string; error?: string } = {},
      ): Promise<{ fetched: number; result: string; report: string | null; err: string }> => { // err = 보이는 오류 줄(숨김이면 "")
        let fetched = 0;
        const kids: Array<{ textContent: string }> = [];
        const entry: Record<string, unknown> = {
          status, taskTruncated: false, taskHydrateTried: false, hasResult: preset.result !== undefined,
          resultEl: { textContent: preset.result ?? "", style: { display: preset.result !== undefined ? "" : "none" } },
          errEl: { textContent: preset.error ?? "", style: { display: preset.error !== undefined ? "" : "none" } },
          el: { querySelector: (sel: string) => (sel === ".bg-job-detail" ? { appendChild: (c: { textContent: string }) => kids.push(c) } : null) },
        };
        const fetchStub = (): Promise<unknown> => { fetched += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }); };
        const documentStub = { createElement: () => ({ className: "", textContent: "", style: {} as Record<string, string> }) };
        // eslint-disable-next-line no-new-func
        const make = new Function("fetch", "i18n", "updateChev", "document", "requestAnimationFrame", "bgGeometryChanged", "storedCapNote", `${block} return hydrateFullTask;`) as (
          ...a: unknown[]
        ) => (id: string, e: unknown) => void;
        make(fetchStub, i18n, () => {}, documentStub, (f: () => void) => f(), () => {}, storedCapNote)("J", entry);
        await new Promise((r) => setTimeout(r, 10));
        const resultEl = entry.resultEl as { textContent: string; style: { display: string } };
        const errEl = entry.errEl as { textContent: string; style: { display: string } };
        return { fetched, result: resultEl.style.display === "none" ? "" : resultEl.textContent, report: kids[0]?.textContent ?? null, err: errEl.style.display === "none" ? "" : errEl.textContent };
      };
      const f1 = await render("failed", pb.dashF1);
      const aRow = await render("failed", { status: "failed", error: "fetch failed", notice: db.dashA });
      const cRow = await render("failed", { status: "failed", error: "fetch failed", notice: db.dashC });
      const running = await render("running", pb.dashF1);
      // 이벤트 요약(결과 1,200자 · 오류 300자)이 이미 든 카드 — 펼침이 저장 원문 + 잘림 표기로 덮어야 한다.
      const bigDone = await render("done", pb.dashBIG, { result: `결과 · ${"a".repeat(1200)}` });
      const bigErr = await render("failed", pb.dashBIGERR, { error: "e".repeat(300) });
      out.push(
        assert("대시보드 블록을 소스에서 떼어냈다(검사 전제)", block.includes("applyJobReport") && block.includes("hydrateFullTask"), `${block.length}자`),
        assert(
          "★끝난 카드 펼침 — 실패+원결과면 «본 보고(마무리 단계 실패 전에 완성)» 와 **원오류**를 함께 보인다(재시작 뒤 서버 단건 그대로)",
          f1.fetched === 1 && f1.result.includes("본 보고(마무리 단계") && f1.result.includes("[F1 본 보고] 완성됨") && f1.report === i18n("bg.report.none") &&
            f1.err === "fetch failed", // 본 보고가 있어도 실패 원인은 보인다(독립 사냥 U3)
          s(f1),
        ),
        assert(
          "★보고 전달 줄은 서버 판정(`recover`)대로 갈린다 — 사람 대화 소유 «자동 재전달(시도 0/3)» · 스케줄 소유 «자동 재전달 대상 아님»",
          aRow.report === i18n("bg.report.auto", { n: 0, max: 3 }) && cRow.report === i18n("bg.report.notHuman"),
          s({ a: aRow.report, c: cRow.report }),
        ),
        assert("진행 중 카드(지시문 안 잘림)는 펼쳐도 단건을 안 부른다(종전 그대로)", running.fetched === 0, s(running)),
        assert(
          "★이벤트 요약(1,200자)이 이미 든 완료 카드도 펼치면 단건 원문으로 덮고 **저장 상한 잘림을 표기**한다(앞 255,999/전체 256,002)",
          bigDone.result.length > 250_000 && bigDone.result.includes("저장 상한으로 앞 255,999자만 보존됐습니다 — 전체 256,002자"),
          `${bigDone.result.length}자 · 꼬리 ${JSON.stringify(bigDone.result.slice(-60))}`,
        ),
        assert(
          "★이벤트 요약(300자) 오류가 든 실패 카드도 펼치면 저장 원오류로 덮고 잘림을 표기한다(앞 256,000/전체 300,001)",
          bigErr.err.length > 250_000 && bigErr.err.includes("저장 상한으로 앞 256,000자만 보존됐습니다 — 전체 300,001자"),
          `${bigErr.err.length}자 · 꼬리 ${JSON.stringify(bigErr.err.slice(-60))}`,
        ),
      );
    }

    // ── 증분 5 (연결) — 대시보드 스크립트를 가짜 DOM 위에 **통째로** 부팅: 이벤트 카드 → 펼침(단건 = 실제 서버 출력) → 같은 카드를 읽는
    //  에이전트 상세·복사까지 저장 상한 표기가 이어지는가(GPT R2 — 표기가 드로어 DOM 에만 붙던 것).
    {
      const { bootDashboard, jsonResponse, makeClock } = await import("./_mini-dom.js");
      const { bgPanelHtml } = await import("./_bg-panel-fixture.js");
      const { i18nForContext } = await import("./_framework.js");
      const clock = makeClock();
      const copied: string[] = [];
      const bodies: Record<string, unknown> = { big: pb.dashBIG, bigerr: pb.dashBIGERR };
      const dash = bootDashboard({
        html: bgPanelHtml(), clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true,
        extra: { navigator: { clipboard: { writeText: async (t: string) => { copied.push(t); } } } },
        fetch: async (url: string) => {
          const m = /[?&]jobId=([^&]+)/.exec(url);
          const id = m === null ? "" : decodeURIComponent(m[1]!);
          if (bodies[id] !== undefined) return jsonResponse(bodies[id]);
          return url.startsWith("/api/shells") ? jsonResponse({ shells: [] }) : jsonResponse({}, 404);
        },
      });
      await clock.advance(20);
      const R = (code: string): any => dash.run(code);
      const t0 = Date.now() - 60_000;
      const ev = (p: Record<string, unknown>): string => JSON.stringify({ kind: "worker", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", startedAt: t0, ...p });
      R(`handleWorkerEvent(${ev({ jobId: "big", status: "running", label: "큰결과", task: "t" })}, "")`);
      R(`handleWorkerEvent(${ev({ jobId: "big", status: "done", label: "큰결과", finishedAt: t0 + 1000, result: "a".repeat(1200) })}, "")`);
      R(`handleWorkerEvent(${ev({ jobId: "bigerr", status: "running", label: "큰오류", task: "t" })}, "")`);
      R(`handleWorkerEvent(${ev({ jobId: "bigerr", status: "failed", label: "큰오류", finishedAt: t0 + 1000, error: "e".repeat(300) })}, "")`);
      R(`setJobOpen("big", jobCards.get("big"), true); setJobOpen("bigerr", jobCards.get("bigerr"), true);`);
      for (let i = 0; i < 5; i += 1) { await clock.advance(20); await new Promise((r) => setTimeout(r, 5)); }
      const note = (kept: string, total: string): string => `앞 ${kept}자만 보존됐습니다 — 전체 ${total}자`;
      const drawerResult = String(R(`jobCards.get("big").resultEl.textContent`) ?? "");
      const agentResult = String(R(`(() => { const c = buildAgentCard("big", jobCards.get("big"), Date.now(), null, {}); const b = c.querySelector(".result"); return b ? b.textContent : ""; })()`) ?? "");
      const agentErr = String(R(`(() => { const c = buildAgentCard("bigerr", jobCards.get("bigerr"), Date.now(), null, {}); const b = c.querySelector(".error"); return b ? b.textContent : ""; })()`) ?? "");
      await R(`builtinHandlers.get("job.copyResult")({ targetId: "big" })`);
      await R(`builtinHandlers.get("job.copy")({ targetId: "bigerr" })`);
      // 재연결 상태 복구 — 진행 중 카드가 목록에서 빠져 서버 단건(저장본·잘림 메타)을 이벤트 처리기로 받는 경로(GPT R3)
      bodies.rc = { ...(pb.dashBIG as Record<string, unknown>), jobId: "rc" };
      bodies.rce = { ...(pb.dashBIGERR as Record<string, unknown>), jobId: "rce" };
      R(`handleWorkerEvent(${ev({ jobId: "rc", status: "running", label: "재연결결과", task: "t" })}, "")`);
      R(`handleWorkerEvent(${ev({ jobId: "rce", status: "running", label: "재연결오류", task: "t" })}, "")`);
      await R(`recoverJobState("rc", jobCards.get("rc"))`);
      await R(`recoverJobState("rce", jobCards.get("rce"))`);
      for (let i = 0; i < 5; i += 1) { await clock.advance(20); await new Promise((r) => setTimeout(r, 5)); }
      const rcAgent = String(R(`(() => { const c = buildAgentCard("rc", jobCards.get("rc"), Date.now(), null, {}); const b = c.querySelector(".result"); return b ? b.textContent : ""; })()`) ?? "");
      const rceAgent = String(R(`(() => { const c = buildAgentCard("rce", jobCards.get("rce"), Date.now(), null, {}); const b = c.querySelector(".error"); return b ? b.textContent : ""; })()`) ?? "");
      const rcStatus = String(R(`jobCards.get("rc").status`) ?? "");
      out.push(
        assert(
          "★[연결] 이벤트 요약 카드 → 펼침 → 드로어 결과가 저장 원문 + «앞 255,999/전체 256,002» 표기",
          drawerResult.length > 250_000 && drawerResult.includes(note("255,999", "256,002")),
          `${drawerResult.length}자 · ${JSON.stringify(drawerResult.slice(-50))}`,
        ),
        assert(
          "★[연결] 같은 카드를 읽는 에이전트 상세도 결과·오류 **원문**(이벤트 요약이 아니라)과 잘림 표기를 보인다(표기가 드로어에만 남지 않는다)",
          agentResult.length > 250_000 && agentResult.includes(note("255,999", "256,002")) &&
            agentErr.length > 250_000 && agentErr.includes(note("256,000", "300,001")),
          `결과 ${agentResult.length}자 꼬리 ${JSON.stringify(agentResult.slice(-40))} · 오류 ${agentErr.length}자 꼬리 ${JSON.stringify(agentErr.slice(-40))}`,
        ),
        assert(
          "★[연결] 복사(결과 복사·카드 복사)도 잘림을 표기한다",
          copied.length === 2 && copied[0]!.length > 250_000 && copied[0]!.includes(note("255,999", "256,002")) &&
            copied[1]!.length > 250_000 && copied[1]!.includes(note("256,000", "300,001")),
          `${copied.length}건 · ${copied.map((c) => `${c.length}자 ${JSON.stringify(c.slice(-40))}`).join(" / ")}`,
        ),
        assert(
          "★[연결] 재연결 상태 복구(서버 단건 → 이벤트 처리기)도 잘림 메타를 보존한다 — 펼치지 않고 에이전트 상세를 봐도 원문 + 표기",
          rcStatus === "done" && rcAgent.length > 250_000 && rcAgent.includes(note("255,999", "256,002")) &&
            rceAgent.length > 250_000 && rceAgent.includes(note("256,000", "300,001")),
          `${rcStatus} · 결과 ${rcAgent.length}자 ${JSON.stringify(rcAgent.slice(-40))} · 오류 ${rceAgent.length}자 ${JSON.stringify(rceAgent.slice(-40))}`,
        ),
      );
    }

    // ── 배선(소스 대조) ────────────────────────────────────────────────────────────────────────
    const idx = readSourceSync("src/index.ts");
    const boot = idx.indexOf("reconcileNoticeStatesAtBoot();");
    const qh = idx.indexOf("const queueHandler: MessageHandler = (msg) => {");
    const entry = idx.indexOf("if (steerable(msg)) void recoverUndeliveredNotices(msg);");
    const firstRestart = idx.indexOf('if (msg.text.trim() === "/restart")', qh);
    const wjSrc = readSourceSync("src/core/worker-jobs.ts");
    out.push(
      assert(
        "[배선] 부팅 잔여 정리는 저장소 뒤 · 채널 시작 **전**",
        boot > idx.indexOf("initStore();") && boot > 0 && boot < idx.indexOf("await ch.start(serializedHandler)"),
        `${boot} / ${idx.indexOf("await ch.start(serializedHandler)")}`,
      ),
      assert("[배선] 회수 입구는 `queueHandler` 맨 앞(아웃오브밴드 명령보다 먼저) · `steerable` 일 때만", entry > qh && entry < firstRestart, `${qh} < ${entry} < ${firstRestart}`),
      assert("[배선] `upsertWorkerJob`(INSERT OR REPLACE)은 등록 한 곳뿐 — 종료 기록은 UPDATE", (wjSrc.match(/upsertWorkerJob\(/g) ?? []).length === 1, String((wjSrc.match(/upsertWorkerJob\(/g) ?? []).length)),
      assert("LONE 정규식 자체 확인(검사의 전제)", LONE.test("a\uD83D") && !LONE.test("a😀"), `홑=${String(LONE.test("a\uD83D"))} · 쌍=${String(LONE.test("a😀"))}`),
    );
    return out;
  },
};
