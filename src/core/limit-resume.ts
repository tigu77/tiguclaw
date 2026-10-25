/**
 * **사용량 한도로 멈춘 일을 «풀린 뒤» 이어 간다** — 옵션 `limitResume.enabled` (2026-10-23, 설계 docs/decisions/2026-10-22-limit-auto-resume-design.md).
 *
 * 한 줄: 옵션이 켜져 있으면, 한도로 **턴이 실패한 그 순간에만** 그 대화(세션)에 «한 번 울리는 타이머» 하나를 건다(이미 있으면 합친다). 울리는 시각 =
 *  그 실패를 낸 풀에서 쓸 수 있는 후보가 생기는 가장 이른 시각(런타임이 정한다 — `resumeAtOf`) **+ 여유 2분**. 울리면 그 대화에 «한도로 멈춘 것» 을 적은
 *  합성 턴이 한 번 들어가고, 무엇을 다시 맡길지는 비서가 맥락으로 정한다. 사용자 메시지 사이에 자동으로 다시 거는 것은 **최대 3번**.
 *
 * ★평소 비용 0 — 이 모듈은 실패 출구(메인 턴 catch·작업 실패)·재개 턴 시작·사람 메시지·`/stop`·부팅에서만 불리고, 매 턴 프롬프트에 아무것도 안 얹는다.
 * ★타이머 실행기는 «이게 재개 타이머인가» 를 모른다 — 실행 도중 같은 행을 다시 걸어도 정산하지 않는 일반 규칙(`plugins/scheduler/src/runner.ts`)이 받는다.
 * ★상태는 코어 소유의 작은 표(`limit_resumes`) — 공용 `schedules` 에 기능 전용 칸을 섞지 않는다. 판단은 전부 동기라 두 실패가 끼어들 수 없다.
 */
import type { TriggerRun } from "./llm-runtime/types.js";
import { partialReasonOf, resumeAtOf } from "./llm-runtime/resume-signal.js";
import { formatResetAt } from "./llm-runtime/rate-limit.js";
import { resolveSessionId } from "./threadkey.js";
import { getEventBus } from "./eventbus.js";
import { translate } from "./i18n.js";
import { loadLimitResumeEnabled } from "./settings.js";
import { isConversationLive, isHumanSessionKey } from "../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, updateSchedule } from "../store/schedules.js";
import {
  claimLimitResumeRow,
  getLimitResume,
  listClaimedLimitResumes,
  putLimitResume,
  releaseLimitResumeRow,
  resetLimitResumeArmsRow,
  type LimitStopItem,
} from "../store/limit-resumes.js";

/** 여유 — 해제 시각 출처 중 가장 거친 문구(«resets 2:20am»)가 분 단위로 잘려 최대 59초 이르다(설계 §3.3, 사용자 결정: 상수 2분). */
export const RESUME_MARGIN_MS = 2 * 60_000;
/** 마지막 사용자 메시지 이후 새로 거는 횟수 상한(합침은 안 센다 — 설계 §3.7, 사용자 결정: 상수 3). */
export const RESUME_MAX_ARMS = 3;
/** 깨우는 글의 경계 — 매 턴이 아니라 깨울 때 한 번 실린다(핫경로 바운드). 저장은 넉넉히, 글엔 최근 것부터. */
const ITEMS_STORED_MAX = 50;
const ITEMS_SHOWN_MAX = 10;
const TURN_TEXT_MAX = 1_500;
const PROMPT_MAX = 6_000;

export type ResumeNote = { kind: "armed"; scheduleId: number; wakeAt: number } | { kind: "capped"; arms: number };

export interface LimitStopInput {
  /** 사람의 대화 키 — 메인 턴은 그 턴이 실제로 돈 세션, 작업은 소환자 좌표. */
  session: string;
  /** 런타임이 정한 «그 풀을 쓸 수 있는 가장 이른 시각». */
  resumeAtMs: number;
  /** 이번에 멈춘 것. */
  item: LimitStopItem;
  /** 메인 턴만 — 이 턴이 그 대화의 재개 턴 자신인지 가른다. */
  triggerRun?: TriggerRun;
  /** 그 실패 안내가 나간 좌표 — 재개 턴의 답도 거기로. */
  dest: { channel: string; target: string | null };
  now?: number;
}

/**
 * 스케줄러 플러그인이 떠 있나 — 부팅이 꽂는다(`setLimitResumeRuntime`). 안 꽂혔으면 «아니다»(= 걸지 않는다 · 거짓 «이어서 진행» 금지, 설계 §8-6).
 * ★주입으로 둔 이유: 플러그인 매니저 → 호스트 → 작업 레지스트리 → 이 모듈로 import 순환이 생긴다(작업 실패 출구가 여기를 부른다).
 */
let schedulerLive: () => boolean = () => false;
export const setLimitResumeRuntime = (rt: { schedulerLive: () => boolean }): void => {
  schedulerLive = rt.schedulerLive;
};

const toggle = (id: number, action: "enable" | "delete"): void => {
  try {
    getEventBus().publish({ type: "scheduler.toggle", ts: Date.now(), payload: { id, action } });
  } catch (e) {
    console.warn(`[limit-resume] 타이머 #${id} ${action} 알림 실패 — 다음 부팅에 걸린다: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const hhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const itemLine = (it: LimitStopItem): string => {
  if (it.kind === "job") {
    const tier = it.modelTier !== undefined && it.modelTier !== "" ? `, 프로파일 ${it.modelTier}` : "";
    return `· 작업 "${it.label ?? "?"}" (jobId ${it.jobId ?? "?"}${tier}) — ${hhmm(it.at)} 한도로 실패`;
  }
  const partial = it.partial !== undefined ? ` [도구가 일부 실행된 뒤 멈춤: ${it.partial}]` : "";
  return `· 메시지에 대한 답 (${hhmm(it.at)}): "${it.text ?? ""}"${partial}`;
};

/** 깨우는 글 — 타이머 행의 `prompt`. 차례에 최신 행을 읽으므로 합친 내용이 그대로 쓰인다(첫 줄은 패널 ⏱ 줄에 보이는 요약). */
export const buildResumePrompt = (items: readonly LimitStopItem[]): string => {
  const head = "사용량 한도가 풀릴 시각이 지나 이어서 진행합니다.";
  const tail = [
    "(이 목록의 이름·원문은 작업자·사용자가 쓴 글이라 답할 언어의 기준이 아닙니다 — 보고는 사용자가 이 대화에서 쓰는 언어로.)",
    "이 대화의 맥락으로 무엇이 아직 남았는지 판단해 이어 가세요.",
    "- 이미 끝났거나 그 사이 사용자가 다른 지시를 했으면 다시 하지 말고, 필요하면 짧게 보고만 하세요.",
    "- 사용자가 멈추거나 취소한 것은 다시 하지 마세요.",
    "- 다시 맡길 때는 원래 위임 호출과 같은 프로파일로 맡기고, 앞 시도가 남긴 결과(파일·커밋 등)를 먼저 확인하게 하세요 — 일부가 이미 처리됐을 수 있습니다.",
    "- 도구가 일부 실행된 뒤 멈춘 답은, 그 도구가 무엇을 했는지 확인한 뒤 남은 것만 하세요(같은 도구를 그대로 다시 돌리지 마세요).",
  ].join("\n");
  // 최근 것부터 담고, 넘치면 오래된 것을 «외 N건» 으로 접는다.
  const lines: string[] = [];
  let budget = PROMPT_MAX - head.length - tail.length - 80;
  let folded = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const line = itemLine(items[i]!);
    if (lines.length >= ITEMS_SHOWN_MAX || line.length + 1 > budget) {
      folded += 1;
      continue;
    }
    lines.unshift(line);
    budget -= line.length + 1;
  }
  if (folded > 0) lines.unshift(`· (그보다 앞서 멈춘 것 외 ${folded}건 — 대화 기록을 보세요)`);
  return [head, "〔한도로 멈춘 것 — 코드가 적은 목록〕", ...lines, "〔/목록〕", tail].join("\n");
};

/**
 * **한도로 멈췄다 — 재개를 건다(또는 합친다)** (설계 §3.4). 걸었으면 그 시각·타이머 id, 상한이면 그 사실, 그 밖엔 undefined(= 현행 문구 그대로).
 * 하지 않는 경우: 옵션 꺼짐 · 사람의 대화가 아님 · 대화가 살아 있지 않음 · 스케줄러 플러그인이 떠 있지 않음.
 *
 * 상태는 두 세대다 — **대기**(`items`: 다음 재개 턴이 맡을 것)와 **도는 재개 턴이 맡은 것**(`claimedItems`). 판정:
 *  - 대기 세대가 있다 = 행이 이 대화 것이고 켜져 있으며 **대기 목록이 비어 있지 않다** → **합친다**
 *    (항목 추가 · 시각은 늦은 쪽 · 건 횟수 그대로). 실패한 것이 재개 턴 자신이면 그 턴이 맡은 목록이 대기로 돌아간다.
 *  - 없다 → 상한이면 걸지 않는다(재개 턴 자신이면 행을 지운다), 아니면 **새로 건다**(재개 턴이 돌고 있으면 그 행을 제자리에서) · 횟수 +1.
 */
export const noteLimitStop = (input: LimitStopInput): ResumeNote | undefined => {
  if (!loadLimitResumeEnabled()) return undefined;
  const session = input.session;
  if (session === "" || !isHumanSessionKey(session) || !isConversationLive(session)) return undefined;
  if (!schedulerLive()) return undefined;
  const now = input.now ?? Date.now();
  const wakeAt = Math.max(now, input.resumeAtMs) + RESUME_MARGIN_MS;
  const state = getLimitResume(session);
  const found = state?.scheduleId != null ? getSchedule(state.scheduleId) : undefined;
  // ★그 행이 아직 이 대화 것인가 — 사용자가 `move_here` 로 옮긴 타이머를 옛 대화가 다시 걸거나 지우면 안 된다(GPT 검토 R1). 옮겼으면 연결은 끊긴 것이다.
  const row = found !== undefined && found.originThreadKey === session ? found : undefined;
  const claimed = state !== undefined && state.claimed && row !== undefined;
  const pending = row !== undefined ? state?.items ?? [] : [];
  const taken = claimed ? state.claimedItems : [];
  const ownResumeTurn = claimed && input.triggerRun?.kind === "schedule" && input.triggerRun.id === row.id;
  const arms = state?.arms ?? 0;
  const save = (items: LimitStopItem[], claimedItems: LimitStopItem[], scheduleId: number | null, nextArms: number, stillClaimed: boolean): void =>
    putLimitResume({ threadKey: session, scheduleId, items: items.slice(-ITEMS_STORED_MAX), claimedItems, arms: nextArms, claimed: stillClaimed }, now);
  // 재개 턴 자신의 실패면 그 턴이 맡은 목록을, 아니면 이번 것을 더한다(재개 턴 자신은 항목이 아니다).
  const added = ownResumeTurn ? taken : [input.item];

  // 대기 세대가 있다 = **대기 목록이 비어 있지 않다** → 합친다. 갓 건 행은 늘 항목이 있고, 재개 턴이 넘겨받거나 내려놓으면 빈다.
  //  ★«넘겨받지 않음» 으로 읽으면 안 된다 — 재개 턴이 끝나 내려놓은 뒤 실행기가 정산하기 전의 실패가 «합침» 으로 들어가 상한을 건너뛰었다(GPT 검토 R3).
  const waiting = row !== undefined && row.enabled && pending.length > 0;
  if (waiting) {
    const items = [...pending, ...added].slice(-ITEMS_STORED_MAX);
    const runAt = Math.max(row.runAt ?? wakeAt, wakeAt);
    updateSchedule(row.id, { runAt, prompt: buildResumePrompt(items) });
    save(items, ownResumeTurn ? [] : taken, row.id, arms, claimed && !ownResumeTurn);
    toggle(row.id, "enable");
    console.log(`[limit-resume] ${session} — 대기 중인 재개 #${row.id} 에 합침(항목 ${items.length} · ${new Date(runAt).toISOString()})`);
    return { kind: "armed", scheduleId: row.id, wakeAt: runAt };
  }

  // 대기 세대가 없다(행 없음 · 꺼짐 · 재개 턴이 돌고 있고 아직 다시 안 걸림).
  if (arms >= RESUME_MAX_ARMS) {
    if (ownResumeTurn) {
      // 재개의 정상 종료 — 행을 지운다(남기면 실행기가 «타이머 실패» 로 정산해 자가 진단이 한 통 더 보낸다).
      deleteSchedule(row.id);
      toggle(row.id, "delete");
      save([], [], null, arms, false);
    }
    console.log(`[limit-resume] ${session} — 자동 재개 상한(${arms}/${RESUME_MAX_ARMS}) — 걸지 않음`);
    return { kind: "capped", arms };
  }
  const items = [...added];
  const prompt = buildResumePrompt(items);
  let scheduleId: number;
  if (row !== undefined && (claimed || row.enabled)) {
    // 재개 턴이 돌고 있거나 막 끝나 실행기 정산 전 — 그 행을 **제자리에서** 다시 건다(실행기는 실행 도중 바뀐 행을 정산하지 않는다 · 세션당 하나).
    updateSchedule(row.id, { runAt: wakeAt, prompt, enabled: true });
    scheduleId = row.id;
  } else {
    scheduleId = addSchedule({
      label: translate("srv.limitResume.label"),
      cronExpr: "",
      prompt,
      destChannel: input.dest.channel,
      destTarget: input.dest.target,
      triggerType: "once",
      runAt: wakeAt,
      originThreadKey: session,
    }).id;
  }
  // 도는 재개 턴이 있고 그게 이번 실패가 아니면, 그 턴은 계속 자기 목록을 맡고 있다.
  const stillClaimed = row !== undefined && claimed && !ownResumeTurn;
  save(items, stillClaimed ? taken : [], scheduleId, arms + 1, stillClaimed);
  toggle(scheduleId, "enable");
  console.log(`[limit-resume] ${session} — 재개 #${scheduleId} 걸음(${arms + 1}/${RESUME_MAX_ARMS} · 항목 ${items.length} · ${new Date(wakeAt).toISOString()})`);
  return { kind: "armed", scheduleId, wakeAt };
};

/**
 * 재개 턴이 실제로 시작됐다 — 핸들러 줄에서 `beforeTurn` 통과 직후(같은 동기 구간). 그 순간 읽은 목록(=대기)을 넘겨받는다.
 * `session` = 그 턴이 도는 대화 — 다른 대화로 옮긴 타이머는 옛 대화의 목록을 못 맡는다.
 */
export const claimLimitResume = (scheduleId: number, session: string): void => {
  try {
    claimLimitResumeRow(scheduleId, session);
  } catch (e) {
    console.warn(`[limit-resume] 넘겨받음 표시 실패(#${scheduleId}): ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * 재개 턴이 끝났다(성공·실패·멈춤 무엇이든) — 그 턴이 맡은 세대를 내려놓는다. 한도 실패는 이미 대기로 돌려줬고, 한도 아닌 실패·`/stop` 은
 *  자동 재개 대상이 아니다(설계 §3.7·§3.10). 그 사이 다른 실패가 다시 건 대기 목록·예약은 그대로 남는다.
 */
export const releaseLimitResume = (scheduleId: number, session: string): void => {
  try {
    releaseLimitResumeRow(scheduleId, session);
  } catch (e) {
    console.warn(`[limit-resume] 넘겨받음 해제 실패(#${scheduleId}): ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** 사람이 쓴 메시지 — 자동으로 건 횟수를 처음부터. 대기 중인 재개는 지우지 않는다(멈춘 일은 여전히 남아 있다). */
export const resetLimitResumeArms = (session: string): void => {
  try {
    resetLimitResumeArmsRow(session);
  } catch {
    /* 저장소 실패가 메시지를 막지 않는다 */
  }
};

/**
 * 부팅 — 끊긴 재개 턴이 맡았던 목록을 **대기로 되돌린다**(부팅 시점엔 도는 재개 턴이 있을 수 없다). 행이 남아 있으면 그 글을 합친 목록으로 다시 쓴다
 *  — 그 행은 실행기가 정산하기 전에 끊겨 남아 있으므로 다음 부팅 보충에 다시 운다(설계 §3.10).
 */
export const resetLimitResumeClaims = (): void => {
  try {
    const rows = listClaimedLimitResumes();
    for (const st of rows) {
      const found = st.scheduleId != null ? getSchedule(st.scheduleId) : undefined;
      const row = found !== undefined && found.originThreadKey === st.threadKey ? found : undefined;
      const items = row !== undefined ? [...st.claimedItems, ...st.items].slice(-ITEMS_STORED_MAX) : [];
      if (row !== undefined) updateSchedule(row.id, { prompt: buildResumePrompt(items) });
      putLimitResume({ threadKey: st.threadKey, scheduleId: row?.id ?? null, items, claimedItems: [], arms: st.arms, claimed: false });
    }
    if (rows.length > 0) console.log(`[limit-resume] 부팅 — 끊긴 재개 턴 ${rows.length}건이 맡았던 목록을 대기로 되돌렸다`);
  } catch {
    /* 표가 없으면 할 일도 없다 */
  }
};

/**
 * `/stop` — 그 대화의 **대기 중** 재개(아직 어느 재개 턴도 안 맡은 것)를 지운다. 지웠으면 그 시각(답 끝에 한 줄로 알린다), 없으면 undefined.
 * 도는 재개 턴만 있으면(대기 없음) `/stop` 이 그 턴을 멈추고 실행기가 지운다(실패 출구를 안 지나 다시 걸리지 않는다). 도는 사이 이미 다시 걸렸으면
 *  그 대기도 지운다(같은 행이다 — 실행기는 실행 도중 지워진 행을 정산하지 않는다).
 */
export const cancelLimitResume = (session: string): { wakeAt: number } | undefined => {
  try {
    const state = getLimitResume(session);
    if (state === undefined || state.scheduleId == null) return undefined;
    const found = getSchedule(state.scheduleId);
    const row = found !== undefined && found.originThreadKey === session ? found : undefined; // 옮긴 타이머는 옛 대화가 못 지운다
    const waiting = row !== undefined && row.enabled && state.items.length > 0; // 대기 세대 = 대기 목록이 있다(noteLimitStop 과 같은 판정)
    if (!waiting) return undefined;
    deleteSchedule(row.id);
    toggle(row.id, "delete");
    putLimitResume({ threadKey: session, scheduleId: null, items: [], claimedItems: [], arms: state.arms, claimed: false });
    console.log(`[limit-resume] ${session} — /stop 으로 대기 중인 재개 #${row.id} 취소`);
    return { wakeAt: row.runAt ?? Date.now() };
  } catch (e) {
    console.warn(`[limit-resume] /stop 의 재개 취소 실패: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
};

/** 안내 한 줄 — 걸었으면 «{when} 이어서 · 취소 길», 상한이면 «멈췄습니다». `{when}` = 여유가 더해진 실제로 깨우는 시각. */
export const resumeNoteLine = (note: ResumeNote, now: number = Date.now()): string =>
  note.kind === "armed"
    ? translate("srv.limitResume.at", { when: formatResetAt(Math.max(0, note.wakeAt - now), now), id: note.scheduleId })
    : translate("srv.limitResume.capped", { n: note.arms });

/** 실패 안내 글 끝에 같은 메시지로 붙인다(한 사건 알림 하나). 없으면 글 그대로(바이트 동일). */
export const withResumeNote = (text: string, note: ResumeNote | undefined): string =>
  note === undefined ? text : `${text}\n${resumeNoteLine(note)}`;

/** 핸들러 메시지 → 그 턴이 실제로 도는 세션(라우터와 같은 순수 함수). 세션 지정이 없으면 threadKey 그대로(라우터 현행). */
export const turnSessionOf = (msg: { channel: string; threadKey: string; channelAddress?: string; session?: { explicitSessionId?: string; channelAddress?: string } }): string =>
  msg.session !== undefined
    ? resolveSessionId(msg.channel, msg.session.channelAddress ?? msg.channelAddress, msg.session.explicitSessionId)
    : msg.threadKey;

/**
 * **메인 턴 출구** — 핸들러 catch 가 사용자 중지·작업 취소를 지난 뒤 부른다. 한도로 끝난 턴(`resumeAtOf`)만 걸고, 그 밖·저장소 실패는 undefined(현행 문구).
 */
export const noteTurnLimitStop = (
  e: unknown,
  msg: {
    channel: string;
    threadKey: string;
    text: string;
    channelAddress?: string;
    session?: { explicitSessionId?: string; channelAddress?: string };
    replyTarget?: { channel: string; target: string | null };
    triggerRun?: TriggerRun;
  },
): ResumeNote | undefined => {
  const resumeAtMs = resumeAtOf(e);
  if (resumeAtMs === undefined) return undefined;
  const partial = partialReasonOf(e);
  try {
    return noteLimitStop({
      session: turnSessionOf(msg),
      resumeAtMs,
      item: { kind: "turn", at: Date.now(), text: msg.text.slice(0, TURN_TEXT_MAX), ...(partial !== undefined ? { partial } : {}) },
      ...(msg.triggerRun !== undefined ? { triggerRun: msg.triggerRun } : {}),
      dest: msg.replyTarget ?? { channel: msg.channel, target: msg.channelAddress ?? null },
    });
  } catch (err) {
    console.warn(`[limit-resume] 메인 턴 재개를 못 걸었다 — 현행 안내로: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
};
