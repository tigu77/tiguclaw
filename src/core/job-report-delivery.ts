/**
 * **완료 보고 전달 상태 · 회수** (2026-10-31, 설계 docs/decisions/2026-10-31-completion-report-recovery-design.md §5).
 *
 * 한 줄: 사용자 대상 **종료 통지**가 끝내 발송되지 못하면 잡 행에 «미전달» 로 남기고, 그 잡을 띄운 **사람 대화**에 다음 일반 메시지가
 *  오면 **그 메시지가 온 채널·주소로**, 저장된 내용만으로 다시 보낸다(행당 최대 3회 · 메시지당 최대 3건). 작업·모델은 다시 돌리지 않는다.
 *
 * ★이 모듈이 정하는 것(판정): 전이의 «언제» · 자동 회수 가능 여부(`noticeRecoverability` — 선점과 모든 표시가 이 하나를 쓴다) ·
 *  회수 목적지(`replyDestOf`) · 조회 도구의 전달 상태 문구. SQL 은 `store/worker-jobs.ts`, 문구 렌더러는 `worker-jobs.ts` 의 `renderJobNotice`.
 * ★`job-notice.ts`(작업자 → 소유자 알림 `notify_owner`)와는 **다른 것**이다 — 이름·내용을 섞지 않는다.
 * ★정확히 한 번이 아니다 — 유실·중복 창은 설계 §5-5. 새 outbox·주기 감시·무한 재시도·새 설정은 없다.
 */
import { getChannelOutbound } from "./channel-outbound.js";
import { translate } from "./i18n.js";
import { limitResumeStatusOf, turnSessionOf } from "./limit-resume.js";
import {
  failureKind,
  reacquireReply,
  renderJobNotice,
  type JobNoticeLimit,
  type WorkerNotifyDest,
} from "./worker-jobs.js";
import { isConversationLive } from "../store/sessions.js";
import {
  claimUndeliveredNotices,
  markInterruptedSending,
  noticeBeginSending,
  noticeSettleRecovering,
  noticeSettleSending,
  reconcileNoticesAtBoot,
  type NoticeState,
  type PersistedWorkerJob,
} from "../store/worker-jobs.js";
import type { ChannelName } from "../channels/types.js";

/** 행당 자동 재전달 상한(설계 §5-4 · 사용자 미확정 권고 U2). 첫 발송은 안 센다. */
export const NOTICE_MAX_ATTEMPTS = 3;
/** 사람 메시지 하나가 회수하는 최대 건수 — 나머지는 다음 메시지로(시도 수 안 셈). */
export const NOTICE_RECOVER_PER_MESSAGE = 3;

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ─── 전이 (설계 §5-2) ──────────────────────────────────────────────────────────────
// ★기대 상태를 조건으로 건다 — 0행이면(정리로 지워졌거나 상태가 이미 다르면) 던지지 않고 다시 넣지 않는다(§5-6). DB 오류는 삼킨다(데몬 생존).

const logSkipped = (jobId: string, expected: string, what: string): void => {
  console.warn(`job-report-delivery: 전달 상태 전이 생략 — 행 없음 또는 상태 다름(${jobId} · 기대 ${expected} · ${what})`);
};

/**
 * NULL → `sending` — 사용자 대상 종료 통지 갈래로 확정된 **직후**(앞의 상태 마킹과 같은 동기 구간). `session` = 자동 회수 대상 사람 대화
 *  (`jobSessionLabel` 의 판정 — 사람 대화가 아니면 undefined → 자동 회수 제외 · 조회만).
 */
export const beginNoticeSending = (jobId: string, session: string | undefined): void => {
  try {
    if (noticeBeginSending(jobId, session ?? null, Date.now()) === 0) logSkipped(jobId, "NULL", "sending");
  } catch (e) {
    console.error(`job-report-delivery: 전달 상태 기록 실패(${jobId} · sending): ${reasonOf(e)}`);
  }
};

/** 첫 통지 결과 — `sending` → `delivered` | `undelivered`. */
export const settleFirstNotice = (jobId: string, delivered: boolean, session: string | undefined): void => {
  try {
    if (noticeSettleSending(jobId, delivered, Date.now()) === 0) {
      logSkipped(jobId, "sending", delivered ? "delivered" : "undelivered");
      return;
    }
    if (!delivered) {
      console.warn(
        `job-report-delivery: 미전달 기록 — ${jobId}` +
          (session !== undefined ? ` · 다음 사람 메시지 때 회수(${session})` : " · 자동 회수 대상 아님(사람 대화가 띄운 작업이 아님) — 조회만"),
      );
    }
  } catch (e) {
    console.error(`job-report-delivery: 전달 상태 기록 실패(${jobId} · ${delivered ? "delivered" : "undelivered"}): ${reasonOf(e)}`);
  }
};

/** 재시작 중단 — `running` → `interrupted` + NULL → `sending` 을 한 UPDATE 로(중단 통지 직전). 바뀌었으면 true. */
export const beginInterruptedNotice = (jobId: string, session: string | undefined): boolean => {
  try {
    return markInterruptedSending(jobId, Date.now(), session ?? null) === 1;
  } catch (e) {
    console.error(`job-report-delivery: 중단 상태 기록 실패(${jobId}): ${reasonOf(e)}`);
    return false;
  }
};

/**
 * **부팅 잔여 정리**(설계 §5-3) — 이전 프로세스의 `sending` → `undelivered`, `recovering` → 시도 수대로 `undelivered`/`gave_up`.
 * ★채널 시작 **전**에 부른다(`src/index.ts`) — 그래야 이번 프로세스의 선점·발송과 겹치지 않는다.
 */
export const reconcileNoticeStatesAtBoot = (): void => {
  try {
    const r = reconcileNoticesAtBoot(NOTICE_MAX_ATTEMPTS, Date.now());
    if (r.sending + r.recovering > 0) {
      console.log(`job-report-delivery: 부팅 — 이전 프로세스가 보내다 끊긴 통지 정리(보내는 중 ${r.sending} · 재전달 중 ${r.recovering})`);
    }
  } catch (e) {
    console.error(`job-report-delivery: 부팅 잔여 정리 실패 — 그 행들은 «보내는 중» 으로 남는다: ${reasonOf(e)}`);
  }
};

// ─── 판정 — 자동 회수 가능 여부 (설계 §5-4) ───────────────────────────────────────

export type NoticeRecoverability = "auto" | "not_human_owner" | "owner_archived" | "exhausted" | "none";

/**
 * 저장 행 하나 → 자동 회수 가능 여부. ★**선점과 모든 표시(조회 도구·대시보드)가 이 함수 하나를 쓴다** — 화면이 «재전달된다» 고 말하는
 *  조건과 실제 선점 조건이 갈릴 수 없다. 행만 본다(회수 유발 메시지의 목적지는 `replyDestOf` 가 따로).
 */
export const noticeRecoverability = (
  row: { noticeState?: NoticeState; noticeSession?: string; noticeAttempts?: number },
  /** 대화 생존 판정 — 기본은 기존 `isConversationLive`(보관한 탭은 죽은 대화). 선점은 세션당 한 번만 재도록 기억한 것을 넘긴다. */
  live: (session: string) => boolean = isConversationLive,
): NoticeRecoverability => {
  if (row.noticeState === "gave_up") return "exhausted";
  if (row.noticeState !== "undelivered") return "none";
  if ((row.noticeAttempts ?? 0) >= NOTICE_MAX_ATTEMPTS) return "exhausted";
  if (row.noticeSession === undefined || row.noticeSession === "") return "not_human_owner";
  return live(row.noticeSession) ? "auto" : "owner_archived";
};

/** 회수 유발 메시지의 응답 목적지 — 그 메시지가 온 채널·주소. 확정 못 하면 undefined(기본 좌표로 추측하지 않는다 — 설계 §5-4 «목적지»). */
export const replyDestOf = (msg: { channel: string; channelAddress?: string }): WorkerNotifyDest | undefined => {
  const ob = getChannelOutbound(msg.channel);
  if (ob === undefined) return undefined; // 미등록 채널
  const target = typeof msg.channelAddress === "string" && msg.channelAddress !== "" ? msg.channelAddress : null;
  // 물리 발송 채널인데 좌표가 없으면 미확정 — 채널 기본 좌표(`defaultOutboundTarget`)로 풀지 않는다. 관측 전용(대시보드)은 좌표 없이도 확정.
  if (target === null && ob.deliver !== undefined) return undefined;
  return { channel: msg.channel as ChannelName, target };
};

// ─── 조회 도구 출력 계약 (설계 §4-3) ────────────────────────────────────────────

/** 단건 조회·대시보드 단건의 «보고 전달» 한 줄. «이 대화» 라고 쓰지 않는다(다른 대화에서도 단건을 읽는다). */
export const noticeSingleLine = (row: { noticeState?: NoticeState; noticeSession?: string; noticeAttempts?: number }): string => {
  const s = row.noticeState;
  const n = row.noticeAttempts ?? 0;
  if (s === undefined) return "보고 전달 기록 없음(통지 대상이 아니었거나 기록 이전 판)";
  if (s === "delivered") return n === 0 ? "보고 전달: 전달됨" : `보고 전달: 재전달로 전달됨(${n}회째)`;
  if (s === "sending" || s === "recovering") return "보고 전달: 보내는 중";
  const r = noticeRecoverability(row);
  if (r === "exhausted") return `보고 전달: 재전달 포기(${n}/${NOTICE_MAX_ATTEMPTS}) — 원문은 이 조회로 읽으세요`;
  if (r === "owner_archived") return "보고 전달: 미전달 — 작업을 띄운 대화가 보관돼 자동 재전달 보류(보관을 풀면 재개)";
  if (r === "not_human_owner") return "보고 전달: 미전달 — 자동 재전달 대상 아님(사람 대화가 띄운 작업이 아님)";
  return `보고 전달: 미전달 — 작업을 띄운 대화에 다음 일반 메시지가 오면 그 메시지가 온 곳으로 자동 재전달(시도 ${n}/${NOTICE_MAX_ATTEMPTS})`;
};

/** 목록 조회의 짧은 표시(없으면 ""). */
export const noticeListNote = (row: { noticeState?: NoticeState; noticeSession?: string; noticeAttempts?: number }): string => {
  const s = row.noticeState;
  if (s === undefined || s === "delivered") return "";
  if (s === "sending" || s === "recovering") return " · 보고 보내는 중";
  const r = noticeRecoverability(row);
  if (r === "exhausted") return " · 보고 전달 실패";
  if (r === "owner_archived") return " · 보고 미전달(보류)";
  if (r === "not_human_owner") return " · 보고 미전달(자동 회수 없음)";
  return " · 보고 미전달";
};

/** 표시용 판정 — 저장소·생존 확인이 실패해도 조회는 나간다(전달 상태 줄만 일반 문구로). */
export const safeNoticeRecoverability = (row: Parameters<typeof noticeRecoverability>[0]): NoticeRecoverability | "unknown" => {
  try {
    return noticeRecoverability(row);
  } catch {
    return "unknown";
  }
};

// ─── 모델에게 한 턴만 알리기 (설계 §5-4 «모델에게 알리기») ─────────────────────────
// 회수가 생긴 세션의 **다음 턴** 대화 컨텍스트에 한 번만 싣고 읽으면 지운다(평시 0바이트 · 두 어댑터 공용 조립).

const RECOVERY_LINES = new Map<string, { items: Array<{ label: string; jobId: string }>; remaining: number }>();

/** `formatConversationContext` 가 부른다 — 있으면 한 줄을 내고 지운다. */
export const takeRecoveryNoticeLine = (threadKey: string): string => {
  const r = RECOVERY_LINES.get(threadKey);
  if (r === undefined) return "";
  RECOVERY_LINES.delete(threadKey);
  const list = r.items.map((i) => `'${i.label}'(${i.jobId})`).join(" · ");
  return (
    `- ★앞서 전달되지 못한 작업 보고 ${r.items.length}건의 원문을 **방금 메시지가 온 곳으로 따로 다시 보내는 중**입니다 — 도착 여부는 아직 모릅니다: ${list}` +
    (r.remaining > 0 ? ` · 남은 미전달 ${r.remaining}건` : "") +
    `.\n  같은 원문을 답에 다시 붙이지 마세요. 사용자가 원문을 원하거나 받지 못했다고 하면 \`read_worker_result(job_id)\` 로 읽어 제공하세요. 같은 작업을 다시 돌리지 마세요.`
  );
};

// ─── 회수 (설계 §5-4) ────────────────────────────────────────────────────────────

const hhmmOf = (ts: number | null | undefined): string => {
  if (ts === null || ts === undefined) return "?";
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

/**
 * 재전달 때의 한도 재개 상태 — **발송 직전, 렌더와 같은 동기 구간**에 재개 저장소에서 읽는다(설계 §4-4). 메모리 `limitResume` 은 쓰지 않는다.
 * 원장을 먼저 보고(있으면 원장대로), 없음·조회 실패일 때만 원오류 분류로 한도 실패인지 가른다.
 */
export const redeliveryLimitOf = (row: { jobId: string; threadKey: string; status: string; errorText?: string; errorName?: string }): JobNoticeLimit | undefined => {
  if (row.status !== "failed") return undefined;
  const st = limitResumeStatusOf(row.threadKey, row.jobId);
  if (st.kind === "waiting" || st.kind === "resuming") return st;
  if (failureKind(row.errorText ?? "", row.errorName) !== "limit") return undefined; // 한도 실패가 아니면 일반 문구 그대로
  return st.kind === "unreadable" ? { kind: "unreadable" } : { kind: "unknown" };
};

/** 저장 스냅숏 → 재전달 본문(머리 한 줄 + 렌더러 + 저장 상한 표기). 작업을 다시 돌리지 않는다. */
export const renderRedelivery = (row: PersistedWorkerJob, now: number = Date.now()): string => {
  const status = row.status === "running" ? "failed" : row.status;
  const limit = redeliveryLimitOf(row);
  const body = renderJobNotice(
    {
      label: row.label,
      status,
      ...(row.resultText !== undefined ? { result: row.resultText } : {}),
      ...(row.errorText !== undefined ? { error: row.errorText } : {}),
      ...(row.errorName !== undefined ? { errorName: row.errorName } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    now,
  );
  const capped = (text: string | undefined, total: number | undefined): string =>
    text !== undefined && total !== undefined && text.length < total ? `\n${translate("srv.job.storedTruncated", { kept: text.length, total })}` : "";
  // 원결과가 렌더에 실렸으면 그 잘림을, 원결과 없는 실패면 원오류의 잘림을 적는다.
  const note = row.resultText !== undefined ? capped(row.resultText, row.resultChars) : status === "failed" ? capped(row.errorText, row.errorChars) : "";
  return `${translate("srv.job.redeliveryHead", { time: hhmmOf(row.finishedAt) })}\n${body}${note}`;
};

/** 회수 발송의 작업 — 선점한 행을 오래된 순으로 하나씩(뒤의 것이 앞지르지 않게). 사용자 턴을 붙잡지 않는다(기다리지 않는 promise). */
const sendClaimed = async (rows: readonly PersistedWorkerJob[], dest: WorkerNotifyDest, session: string): Promise<void> => {
  for (const row of rows) {
    let ok = false;
    let reason = "";
    try {
      // 공통 발송 래퍼 — 관측(그 세션 탭·chat_log) · 답장 매핑 · 세션 라벨 · **실패 = 던짐**. `msg.reply` 는 쓰지 않는다(설계 §5-4).
      await reacquireReply(dest, { sessionThreadKey: session, originThreadKey: session, labelSession: session })(renderRedelivery(row));
      ok = true;
    } catch (e) {
      reason = reasonOf(e);
    }
    let next: NoticeState | undefined;
    try {
      next = noticeSettleRecovering(row.jobId, ok, NOTICE_MAX_ATTEMPTS, Date.now());
      if (next === undefined) logSkipped(row.jobId, "recovering", ok ? "delivered" : "undelivered/gave_up");
    } catch (e) {
      // 같은 프로세스에선 다시 선점되지 않는다(`recovering` 은 선점 대상이 아님) — 재시작 뒤 부팅 정리가 되돌린다(§5-6 허용 중복).
      console.error(`job-report-delivery: 전달 상태 기록 실패(${row.jobId} · 의도 ${ok ? "delivered" : "undelivered"}): ${reasonOf(e)}`);
    }
    const tries = row.noticeAttempts ?? 0;
    if (ok) {
      console.log(`job-report-delivery: 회수 전달 — ${row.jobId} · channel=${dest.channel} · 시도 ${tries}/${NOTICE_MAX_ATTEMPTS} · session=${session}`);
    } else {
      console.warn(
        `job-report-delivery: ${next === "gave_up" ? "회수 포기" : "회수 실패"} — ${row.jobId} · channel=${dest.channel} · 시도 ${tries}/${NOTICE_MAX_ATTEMPTS} · ${reason}`,
      );
    }
  }
};

/**
 * **회수 입구** — 사람의 일반 메시지(`steerable`)가 줄 입구에 닿을 때 한 번(`src/index.ts` `queueHandler`). 동기로 선점까지 하고,
 *  발송은 기다리지 않는 promise 로 돌린다(반환값 = 그 promise — 검사가 기다릴 수 있게. 호출부는 기다리지 않는다).
 * 선점 조건: 같은 세션(`turnSessionOf` 와 `notice_session` 이 정확히 같음) · 응답 목적지 확정 · `noticeRecoverability === "auto"` · 메시지당 3건.
 */
export const recoverUndeliveredNotices = (msg: {
  channel: string;
  threadKey: string;
  channelAddress?: string;
  session?: { explicitSessionId?: string; channelAddress?: string };
}): Promise<void> | undefined => {
  let session: string;
  let claimed: PersistedWorkerJob[];
  let remaining = 0;
  let dest: WorkerNotifyDest | undefined;
  try {
    session = turnSessionOf(msg);
    if (session === "") return undefined;
    let held: "archived" | undefined;
    claimed = claimUndeliveredNotices(
      session,
      (candidates) => {
        if (candidates.length === 0) return [];
        // 목적지는 후보가 있을 때만 정한다(평시 0비용) — 확정 못 하면 아무것도 고르지 않는다(시도 수 그대로).
        dest = replyDestOf(msg);
        if (dest === undefined) {
          console.warn(`job-report-delivery: 회수 보류 — 이 메시지의 응답 목적지 미확정(channel=${msg.channel} · session=${session} · 후보 ${candidates.length})`);
          return [];
        }
        // 살아 있는 대화 확인은 세션 하나에 한 번(같은 동기 구간) — 후보는 전부 같은 세션이다.
        const memo = new Map<string, boolean>();
        const live = (s: string): boolean => {
          if (!memo.has(s)) memo.set(s, isConversationLive(s));
          return memo.get(s) === true;
        };
        const auto = candidates.filter((c) => {
          const r = noticeRecoverability(c, live);
          if (r === "owner_archived") held = "archived";
          return r === "auto";
        });
        remaining = Math.max(0, auto.length - NOTICE_RECOVER_PER_MESSAGE);
        return auto.slice(0, NOTICE_RECOVER_PER_MESSAGE);
      },
      Date.now(),
    );
    if (held === "archived") console.warn(`job-report-delivery: 회수 보류 — 보관된 대화(${session})`);
  } catch (e) {
    console.error(`job-report-delivery: 회수 선점 실패 — 이 메시지에선 회수하지 않는다: ${reasonOf(e)}`);
    return undefined;
  }
  if (claimed.length === 0 || dest === undefined) return undefined;
  RECOVERY_LINES.set(session, { items: claimed.map((r) => ({ label: r.label, jobId: r.jobId })), remaining });
  const target = dest;
  return sendClaimed(claimed, target, session).catch((e: unknown) => {
    console.error(`job-report-delivery: 회수 발송 루프 오류: ${reasonOf(e)}`);
  });
};
