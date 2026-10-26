/**
 * `notify_owner` 의 판단 — 작업자(매니저·서브에이전트)가 **소환자만 풀어 줄 수 있는 것**을 한 줄 알리고 계속 일한다 (2026-10-25).
 *
 * 진실 소스: `docs/decisions/2026-10-23-notify-owner-design.md`(§4 모양 · §5 배달 · §18 현행 대조). 사용자 승인(10-25):
 *  «notice_id 추가, 작업당 최대 3회·본문 300자, 셸 실행은 유지하고 대기만 깨우는 설계».
 *
 * 이 모듈은 **순수**하다 — 잡 맵·스티어·메인 핸들러를 모른다(그건 `worker-jobs.ts` 의 배달 배선).
 *  여기 있는 것: ①형식·중복·상한 판정 ②«받을 스레드 앞 수신함» — 넣기·한 번 꺼내기 ③스레드별 합류 등록 ④모델에게 보이는 문구.
 * ★수신함이 이 기능의 유일한 새 판단이다(설계 §5.2): 알림은 받을 스레드(`T`) 앞으로 놓이고, 먼저 닿는 자리(그 스레드의 합류 ·
 *  세션 합성 턴의 `beforeTurn` · 매니저 스티어) 하나가 **한 번만** 꺼낸다. 합류 경합·중단·막 끝나는 창이 전부 이 규칙 하나로 닫힌다.
 */

/** 작업당 알림 상한 — 상수이지 설정이 아니다(설계 Q6 · 사용자 10-25 확정). */
export const NOTICE_CAP_PER_JOB = 3;
/** 본문 상한(글자 — 코드 포인트). 넘으면 **거절**한다 — 잘라 보내지 않는다(조용한 유실 금지). */
export const NOTICE_MAX_CHARS = 300;

/** 꺼낸 자리 — 합류가 받음 · 매니저 스티어에 넣음 · 세션 합성 턴이 받음. */
export type NoticeRoute = "join" | "steer" | "turn";

/**
 * 잡 레코드에 남는 알림 한 건(최대 3). 카드·진행 알림·답 확정이 이 값을 읽는다.
 * ★`answeredAt` 은 **`notice_id` 일치 AND 지시 전달(delivered)** 일 때만 선다(설계 §5.6 R2 #1) — 시간 순서로 잇지 않는다.
 */
export interface JobNotice {
  /** 잡 안의 순번 — `n1`·`n2`·`n3`. */
  id: string;
  at: number;
  /** 정규화한 본문(앞뒤 공백 제거·연속 공백 하나로). 중복 판정도 이 값으로 한다. */
  text: string;
  /** 받을 스레드(`T`) — 못 찾았으면 `""`. 비전달로 위로 올리면 그 스레드로 바뀐다. */
  target: string;
  /** queued = 수신함에 있음 · taken = 꺼내 감 · recorded = 받을 곳이 없어 기록만. */
  state: "queued" | "taken" | "recorded";
  route?: NoticeRoute;
  answeredAt?: number;
  /** 진행 알림에 한 번 실렸다(설계 §7.2 — 알림당 최대 한 번). */
  progressShown?: boolean;
}

/** 수신함 한 칸 — 꺼낸 쪽이 문구를 만들 재료를 같이 든다(잡 맵을 다시 안 봐도 되게). */
export interface InboxItem {
  jobId: string;
  noticeId: string;
  /** 받을 스레드(`T`). */
  threadKey: string;
  label: string;
  kind: "worker" | "agent";
  text: string;
  at: number;
  /** 위로 올린 사유 한 줄(소환자 매니저가 끝났거나 못 받음) — 세션 본문에 붙는다. */
  note?: string;
  redelivery?: boolean;
}

/** 정규화 — 앞뒤 공백 제거 · 연속 공백(줄바꿈 포함) 하나로. «한 줄» 이므로 줄바꿈도 공백이 된다. */
export const normalizeNoticeText = (s: string): string => s.trim().replace(/\s+/g, " ");

export type NoticeCheck =
  | { kind: "rejected"; reason: "empty" | "too-long"; chars: number }
  | { kind: "duplicate"; prior: JobNotice }
  | { kind: "cap" }
  | { kind: "ok"; id: string; text: string };

/**
 * 형식 → 중복 → 상한 순서로 본다(설계 §4-2·3·4). 중복은 상한을 소모하지 않으므로 상한보다 **먼저** 본다 —
 * 10분 폴링마다 같은 문장을 다시 보내는 작업자가 상한에 막혀 «상한을 다 썼다» 는 틀린 안내를 받지 않게.
 */
export const checkNotice = (prior: readonly JobNotice[], message: unknown): NoticeCheck => {
  const text = normalizeNoticeText(typeof message === "string" ? message : "");
  const chars = [...text].length;
  if (chars === 0) return { kind: "rejected", reason: "empty", chars };
  if (chars > NOTICE_MAX_CHARS) return { kind: "rejected", reason: "too-long", chars };
  const dup = prior.find((n) => n.text === text);
  if (dup !== undefined) return { kind: "duplicate", prior: dup };
  if (prior.length >= NOTICE_CAP_PER_JOB) return { kind: "cap" };
  return { kind: "ok", id: `n${prior.length + 1}`, text };
};

// ─── 받을 스레드 앞 수신함 (설계 §5.2) ─────────────────────────────────────────

const inbox = new Map<string, InboxItem[]>();

export const putNotice = (item: InboxItem): void => {
  const list = inbox.get(item.threadKey) ?? [];
  list.push(item);
  inbox.set(item.threadKey, list);
};

/** `T` 앞 대기 알림이 있나 — 합류의 깨우기 조건. */
export const hasNotices = (threadKey: string): boolean => (inbox.get(threadKey)?.length ?? 0) > 0;

/** `T` 앞 알림 **전부**를 꺼낸다(합류 · 합류 미수령 재배달). 꺼낸 것은 수신함에서 사라진다 — 다른 자리는 빈손이다. */
export const takeNotices = (threadKey: string): InboxItem[] => {
  const list = inbox.get(threadKey);
  if (list === undefined) return [];
  inbox.delete(threadKey);
  return list;
};

/** 그 알림 **하나**만 꺼낸다(세션 합성 턴의 `beforeTurn`). 이미 꺼내졌으면 `undefined`. */
export const takeNotice = (threadKey: string, jobId: string, noticeId: string): InboxItem | undefined => {
  const list = inbox.get(threadKey);
  if (list === undefined) return undefined;
  const i = list.findIndex((x) => x.jobId === jobId && x.noticeId === noticeId);
  if (i < 0) return undefined;
  const [hit] = list.splice(i, 1);
  if (list.length === 0) inbox.delete(threadKey);
  return hit;
};

// ─── 스레드별 합류 등록 (설계 §5.3 · §18-3) ───────────────────────────────────
// ★완료 결과의 «합류 권리»(`claimJobJoin`, 잡 기준 토큰)와 **다른 표**다 — 권리는 «내 자식의 결과» 에만 생기지만, 알림은 `T` 의 턴이
//  무엇을 기다리든(남의 id 관찰 포함) 그 합류를 깨워야 한다. 섞으면 완료 보류 규칙을 건드린다.

const joins = new Map<string, number>();

export const beginNoticeJoin = (threadKey: string): void => {
  if (threadKey === "") return;
  joins.set(threadKey, (joins.get(threadKey) ?? 0) + 1);
};

export const endNoticeJoin = (threadKey: string): void => {
  const n = (joins.get(threadKey) ?? 0) - 1;
  if (n > 0) joins.set(threadKey, n);
  else joins.delete(threadKey);
};

/** `T` 의 턴이 지금 합류(`wait_for_worker`) 중인가. 같은 스레드의 겹친 합류도 센다. */
export const isNoticeJoining = (threadKey: string): boolean => (joins.get(threadKey) ?? 0) > 0;

/** 검사 전용 — 수신함·합류 등록을 비운다. */
export const __resetNoticesForTest = (): void => {
  inbox.clear();
  joins.clear();
};

/** 검사 전용 — 수신함 크기. */
export const __noticeInboxSizeForTest = (): number => [...inbox.values()].reduce((a, l) => a + l.length, 0);

// ─── 모델에게 보이는 문구 (설계 §5.3·5.4·5.6) ─────────────────────────────────

const kindWord = (kind: "worker" | "agent"): string => (kind === "agent" ? "서브에이전트" : "매니저");

/** 답 안내 — 세 자리(세션 턴·매니저 스티어·합류 반환)가 같은 문장을 쓴다. */
const ANSWER_HOW = "steer_worker(job_id, message, notice_id)";

/** 세션 비서의 합성 턴 본문(설계 §5.4). */
export const sessionNoticeText = (it: InboxItem): string =>
  `[작업자 알림] ${kindWord(it.kind)} '${it.label}'(job_id ${it.jobId}, notice_id ${it.noticeId})이 실행 중에 알립니다: «${it.text}»` +
  (it.note !== undefined ? ` ${it.note}` : "") +
  `\n작업자는 기다리지 않고 계속 일하고 있습니다. 맥락으로 풀 수 있으면 ${ANSWER_HOW} 로 답하세요. ` +
  `사용자만 정할 수 있으면(사용자 앱·결정·범위 밖) 사용자에게 알리거나 prompt_options 로 물은 뒤 그 답을 ${ANSWER_HOW} 로 전하세요. ` +
  `이미 풀렸거나 할 일이 없으면 아무 말도 안 해도 됩니다.`;

/** 도는 매니저가 받는 본문(설계 §5.6) — 스티어로 들어가 다음 판단 시점에 읽힌다. */
export const managerNoticeText = (it: InboxItem): string =>
  `[작업자 알림 — ${kindWord(it.kind)} '${it.label}' (job_id ${it.jobId}, notice_id ${it.noticeId})] ${it.text}\n` +
  `작업자는 기다리지 않고 계속 일합니다. 풀어 줄 수 있으면 ${ANSWER_HOW} 로 답하세요. ` +
  `당신도 못 정하는 것(사용자 결정·공유 자원)이면 notify_owner 로 당신의 소환자에게 올리거나 결과 보고에 적으세요. 할 일이 없으면 무시해도 됩니다.`;

/** 합류 반환의 맨 위 블록(설계 §5.3). */
export const joinNoticeBlock = (items: readonly InboxItem[]): string =>
  `📣 기다리는 동안 작업자 알림\n` +
  items
    .map(
      (it) =>
        `- '${it.label}'(job_id ${it.jobId}, notice_id ${it.noticeId}): «${it.text}» — 작업은 계속 진행 중. ` +
        `답: ${ANSWER_HOW}. 결과가 필요하면 다시 wait_for_worker`,
    )
    .join("\n");

/** 답 지시의 머리 — 작업자가 무엇에 대한 답인지 안다(설계 §5.6). */
export const answerHead = (noticeId: string): string => `[알림 ${noticeId} 에 대한 답] `;

/** `steer_worker.notice_id` 설명 — 메인·매니저 두 도구 스키마가 같은 문장을 쓴다(설계 §18-1: 스키마는 도구마다 따로 있다). */
export const NOTICE_ID_DESCRIBE =
  "작업자 알림(notify_owner)에 대한 답이면 그 알림의 notice_id(예 n1). 주면 그 알림이 «답 받음» 으로 기록됩니다 — 무관한 지시엔 넣지 마세요.";

/** 도구 반환의 꼬리 — 언제나(설계 §4-7). */
export const KEEP_WORKING =
  "답을 기다리지 말고 할 수 있는 일을 계속하세요. 답이 오면 다음 판단 시점에 지시로 들어옵니다.";
