/**
 * **오래 도는 매니저의 진행 알림** — 판단을 한 곳에 (2026-10-14).
 *
 * 설계: `docs/decisions/2026-10-14-job-progress-notice.md`. 정태님: *«1시간이든 2시간이든 기본적으로 진행 상황을 알려주는 게
 * 좋겠다»* · *«그렇게 오래 지난 거면 LLM 좀 써도 되겠다»*.
 *
 * ★왜 생겼나: 매니저 점검(`worker-jobs` `checkinTick`)은 **무활동** 일 때만 깨운다 — 잘 도는 잡은 일부러 안 건드린다(08-23 결정).
 *  그래서 4시간 잘 도는 잡은 말이 없었고, 비서가 그 빈자리를 «중간에 먼저 보고하라» 는 AGENT.md 규칙으로 메우다 일을 16분짜리로
 *  쪼개 매번 멈췄다(단계 1 관찰: 사용자 재촉 17건). 진행을 **하네스가** 알리면 비서가 일을 쪼갤 이유가 없다.
 * ★1방향이다 — 사용자에게만 간다. 매니저·메인 컨텍스트엔 아무것도 넣지 않는다(깨우면 08-23 결정과 같은 병이다).
 * ★정체·실패를 «잘 진행 중» 으로 포장하지 않는다 — 오류 건수는 요약이 뭐라 하든 **하네스가 따로** 붙인다(요약은 모델 글이라 못 믿는다).
 * ★판단은 순수 함수로 뺐다 — 데몬 없이 검사하려고. 요약기는 region 쪽이 부팅 때 주입한다(`registerWorkerRunner` 와 같은 경계).
 */
import { formatDuration, formatDurationKo } from "./format-duration.js";
import { translate } from "./i18n.js";

/** 잡마다 기억하는 최근 행동 상한 — 요약 입력의 원료. 바운드(잡이 몇 시간 돌아도 이 이상 안 쌓인다). */
export const PROGRESS_RECENT_CAP = 40;
/** 요약 입력에 싣는 행동 줄의 길이 상한(글자). */
const DETAIL_MAX = 120;

export interface ProgressAction {
  at: number;
  tool: string;
  detail?: string;
  /** 그 호출이 오류로 끝났나(종료 이벤트의 `output.isError`). */
  error?: boolean;
  /** 시작·종료를 잇는 호출 식별자(어댑터 `seq`) — 오류 표시를 맞는 행동에 붙이려고. */
  key?: string;
}

/** 최근 행동 고리 — 시작 이벤트마다 하나, 상한을 넘으면 오래된 것부터 버린다. */
export const pushRecentAction = (list: ProgressAction[], action: ProgressAction): void => {
  list.push({ ...action, ...(action.detail !== undefined ? { detail: action.detail.slice(0, DETAIL_MAX) } : {}) });
  if (list.length > PROGRESS_RECENT_CAP) list.splice(0, list.length - PROGRESS_RECENT_CAP);
};

/**
 * 알릴 때가 됐나. ★활동이 **없으면** 알리지 않는다 — 조용한 잡은 기존 무활동 점검의 몫이고, 여기서 «진행 중» 이라 하면 거짓이다.
 * @param since 직전 알림 시각(없으면 잡 시작).
 */
export const isProgressDue = (p: {
  now: number;
  since: number;
  /** 직전 알림(없으면 잡 시작) 이후 활동이 있었나 — 시각 비교가 아니라 **표식**이다(같은 밀리초의 시작·활동을 가르지 못해서). */
  activeSince: boolean;
  intervalMs: number;
}): boolean =>
  Number.isFinite(p.intervalMs) && p.now - p.since >= p.intervalMs && p.activeSince;

/**
 * 직전 알림 이후의 행동 — 오류 건수는 여기서 센다(요약이 아니라 기록에서).
 */
export const actionsSince = (list: readonly ProgressAction[], since: number): ProgressAction[] =>
  list.filter((a) => a.at >= since);

type Todo = { content: string; status: string; activeForm?: string };

/** 아직 끝나지 않은 도구 — 점검 증거의 `inFlight`. */
export interface InFlightTool {
  tool: string;
  at: number;
}

/**
 * 이만큼 새 활동이 없으면(그리고 진행 중인 도구도 없으면) 하네스가 «조용하다» 를 직접 붙인다(2026-10-14 적대 검토 P2).
 * 종전엔 마지막 활동 시각이 알림에도 요약 지시에도 없어, 59분 침묵한 잡에 «순조롭게 진행 중» 이 나갔다.
 */
export const PROGRESS_QUIET_MS = 10 * 60_000;

const todoLine = (todos: readonly Todo[] | undefined): string | undefined => {
  if (todos === undefined || todos.length === 0) return undefined;
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  return translate("srv.job.progress.todos", {
    done,
    total: todos.length,
    now: now !== undefined ? (now.activeForm ?? now.content) : "—",
  });
};

/** 사람이 읽는 행동 한 줄 — `도구 대상`. */
const actionText = (a: ProgressAction): string => (a.detail !== undefined && a.detail !== "" ? `${a.tool} ${a.detail}` : a.tool);

/**
 * LLM 없이 만드는 진행 문단 — 요약이 실패하거나 요약기가 없을 때. 기록에 있는 것만 싣는다.
 */
export const mechanicalProgress = (p: { actions: readonly ProgressAction[]; todos?: readonly Todo[] }): string => {
  const recent = p.actions.slice(-3).map(actionText).join(" · ");
  // 행동이 없으면 그 줄을 안 싣는다 — 진행 중인 도구만 있는 알림에 «최근 행동 0건 · 마지막: —» 가 다시 나왔다(2026-10-14 재검토 P1).
  const lines = p.actions.length === 0 ? [] : [translate("srv.job.progress.mechanical", { count: p.actions.length, recent })];
  const t = todoLine(p.todos);
  if (t !== undefined) lines.push(t);
  return lines.join("\n");
};

/** 요약 지시 — ★기록에 있는 것만, 추측·약속 금지, 짧게. 오류가 있으면 감추지 말 것. */
export const buildProgressPrompt = (p: {
  label: string;
  task: string;
  elapsedMs: number;
  actions: readonly ProgressAction[];
  todos?: readonly Todo[];
  language: string;
  now: number;
  lastActivityAt: number;
  inFlight: readonly InFlightTool[];
  errors: number;
}): string => {
  const ago = (at: number): string => formatDurationKo(Math.max(0, p.now - at));
  const lines = p.actions.map((a) => `- (${ago(a.at)} 전) ${actionText(a)}${a.error === true ? "  [오류]" : ""}`);
  const t = todoLine(p.todos);
  return [
    "아래는 백그라운드에서 돌고 있는 작업의 최근 도구 기록이다. 사용자에게 보낼 진행 상황을 2~3줄로 써라.",
    "규칙: 기록에 있는 것만 말한다. 결과·성공을 지어내지 않는다. 앞으로 할 일을 약속하지 않는다. [오류] 가 있으면 숨기지 말고 말한다.",
    "같은 행동이 반복되면 «같은 일을 반복하고 있다» 고, 최근에 활동이 없으면 «한동안 새 활동이 없다» 고 사실대로 말한다. 머리말·인사 없이 본문만.",
    `언어: ${p.language}`,
    "",
    `작업 이름: ${p.label}`,
    `맡긴 일: ${p.task.slice(0, 400)}`,
    `경과: ${formatDurationKo(p.elapsedMs)}`,
    `마지막 활동: ${ago(p.lastActivityAt)} 전`,
    ...(p.errors > 0 ? [`직전 보고 이후 오류로 끝난 도구 호출: ${String(p.errors)}건`] : []),
    ...(p.inFlight.length > 0 ? [`아직 끝나지 않은 도구: ${p.inFlight.map((f) => `${f.tool}(${ago(f.at)}째)`).join(", ")}`] : []),
    ...(t !== undefined ? [t] : []),
    "최근 기록(오래된 것부터):",
    ...lines,
  ].join("\n");
};

/** 요약기 — 프롬프트 → 2~3줄. 실패·시한 초과면 undefined(→ 기계 요약). region 쪽이 주입한다. `jobId` 는 사용량을 그 잡에 붙이려고. */
export type ProgressSummarizer = (prompt: string, ctx: { jobId: string }) => Promise<string | undefined>;

let summarizer: ProgressSummarizer | undefined;

/** region(`worker-registry`)이 부팅 때 주입. 없으면 기계 요약만 나간다. */
export const registerProgressSummarizer = (fn: ProgressSummarizer | undefined): void => {
  summarizer = fn;
};

/** 배선 검사용. */
export const getRegisteredProgressSummarizer = (): ProgressSummarizer | undefined => summarizer;

/**
 * 진행 알림 본문 — 머리줄 + (요약 또는 기계 요약) + **오류 줄(하네스가 붙임)**.
 * never-throw: 요약기가 던지거나 빈 글을 주면 기계 요약.
 */
export const composeProgressNotice = async (p: {
  /** 직전 알림 이후 오류로 끝난 도구 호출 수 — 종료 이벤트에서 센 값(목록 밖으로 밀린 실패도 든다). */
  errors: number;
  jobId: string;
  name: string;
  task: string;
  elapsedMs: number;
  actions: readonly ProgressAction[];
  todos?: readonly Todo[];
  language: string;
  now: number;
  lastActivityAt: number;
  inFlight: readonly InFlightTool[];
}): Promise<{ text: string; summarized: boolean } | null> => {
  // 말할 사실이 없으면 보내지 않는다 — 글만 쓰는 잡에 «최근 행동 0건» 빈 알림이 나갔다(2026-10-14 적대 검토 P1).
  if (p.actions.length === 0 && p.inFlight.length === 0 && p.errors === 0) return null;
  let body: string | undefined;
  if (summarizer !== undefined && p.actions.length > 0) {
    try {
      const out = await summarizer(
        buildProgressPrompt({
          label: p.name, task: p.task, elapsedMs: p.elapsedMs, actions: p.actions, todos: p.todos, language: p.language,
          now: p.now, lastActivityAt: p.lastActivityAt, inFlight: p.inFlight, errors: p.errors,
        }),
        { jobId: p.jobId },
      );
      const trimmed = out?.trim();
      if (trimmed !== undefined && trimmed !== "") body = trimmed.slice(0, 600);
    } catch {
      body = undefined;
    }
  }
  const summarized = body !== undefined;
  const lines = [
    translate("srv.job.progress.header", { name: p.name, elapsed: formatDuration(p.elapsedMs) }),
    body ?? mechanicalProgress({ actions: p.actions, todos: p.todos }),
  ].filter((l) => l !== "");
  // ★사실 줄은 요약과 별개로 하네스가 붙인다 — 요약은 모델 글이라 정체를 «순조롭다» 로 쓸 수 있다.
  if (p.inFlight.length > 0) {
    lines.push(translate("srv.job.progress.inFlight", {
      items: p.inFlight.map((f) => `${f.tool} · ${formatDuration(Math.max(0, p.now - f.at))}`).join(", "),
    }));
  } else if (p.now - p.lastActivityAt >= PROGRESS_QUIET_MS) {
    lines.push(translate("srv.job.progress.quiet", { quiet: formatDuration(p.now - p.lastActivityAt) }));
  }
  // ★분모를 섞지 않는다 — 오류 수는 «직전 알림 이후 전체 호출» 범위, 최근 행동 목록은 40개 표본이다.
  if (p.errors > 0) lines.push(translate("srv.job.progress.errors", { errors: p.errors }));
  return { text: lines.join("\n"), summarized };
};
