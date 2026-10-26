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

/**
 * **실제 산출** — 직전 알림 이후 끝까지 성공한 파일 쓰기·커밋 수(2026-10-23, 운영 인스턴스 실사례). 하네스가 종료 이벤트에서 센다
 *  (최근 행동 40개 표본 밖·잘린 명령 줄과 무관). 요약이 «진행 없음» 이라 해도 이 줄은 하네스가 붙인다 — 오류 건수와 같은 자리.
 */
export interface ProgressOutputs {
  writes: number;
  commits: number;
}

/** 파일을 바꾸는 도구인가 — 이름표의 MCP 접두(`mcp__<서버>__`)는 떼고 본다(claude 의 MCP 이름표 모양). */
export const isFileWriteTool = (label: string): boolean =>
  /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/.test(label.replace(/^mcp__[^_]+(?:_[^_]+)*__/, ""));

/**
 * 그 호출이 만든 **커밋 수** — 셋이 다 있어야 센다(GPT R1: 문자열 하나로 세면 `git commit --dry-run`(종료 1)·`git log --format='[main %h] %s'`·
 *  `git show HEAD:commit.md` 가 커밋이 됐다): ①명령 줄이 `git … commit` 하위 명령(`git -C 경로 commit`·`git -c k=v commit` 포함) ②출력에 git 이
 *  커밋마다 내는 요약 줄 `[브랜치 abc1234] 제목`(번역되지 않는 모양 — 드라이런·실패한 커밋은 이 줄을 안 낸다) ③오류로 끝나지 않음(호출부가 오류
 *  플래그를 본다). 종료 코드는 안 본다 — `git commit … && npm test` 처럼 커밋 뒤 명령이 실패해도 커밋은 됐다(요약 줄이 그 증거다).
 *  명령 줄이 잘려 «git commit» 이 안 보이거나 출력 미리보기가 잘려 요약 줄이 없으면 **안 센다**(모르면 세지 않는다).
 */
/**
 * 명령 줄이 `git … commit` 을 **실행**하나 — 따옴표 안(인수·메시지)은 지우고, `&&`·`||`·`;`·`|`·줄바꿈으로 나눈 각 명령의 **머리**에서만 찾는다
 *  (GPT R2: `git log -1 --format='[main %h] git commit'` 이 커밋으로 셌다). 확실히 못 읽는 모양은 세지 않는다.
 */
const runsGitCommit = (detail: string): boolean => {
  const cmd = detail.replace(/^\s*(?:command|cmd)=/, "").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  // 값을 다음 토큰으로 받는 git 전역 옵션 — 그 값(예: `-C commit`)을 하위 명령으로 읽지 않는다(GPT R3).
  const TAKES_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"]);
  return cmd.split(/&&|\|\||[;|\n]/).some((part) => {
    const t = part.trim().split(/\s+/);
    if (!/^(?:.*[\\/])?git(?:\.exe)?$/i.test(t[0] ?? "")) return false;
    let i = 1;
    while (i < t.length && t[i]!.startsWith("-")) i += TAKES_VALUE.has(t[i]!) ? 2 : 1;
    return t[i] === "commit";
  });
};

export const commitsMade = (detail: string | undefined, text: string | undefined): number => {
  if (typeof detail !== "string" || typeof text !== "string") return 0;
  if (!runsGitCommit(detail)) return 0;
  return (text.match(/^\[[^\]\s]+(?: \(root-commit\))? [0-9a-f]{7,40}\] /gm) ?? []).length;
};

/**
 * 요약이 **진척을 부정하는가** — 하네스가 센 산출(쓰기·커밋)이 있는데 요약이 «진행 없음·그대로» 를 말하면 그 요약을 버린다(2026-10-23,
 *  GPT R1: 사실 줄을 덧붙여도 «실질적 구현 진행 없음, 할 일 0/7 그대로» 가 그대로 나갔다). 요약은 모델 글이라 사실과 부딪히면 하네스가 이긴다.
 * ★**비율(N/M) 자체는 부정이 아니다**(2026-10-23 재조정). 낡은 할 일은 요약 입력에 안 실리므로(`buildProgressPrompt`) 요약의 비율은 기록
 *  (신선한 할 일·도구 출력 «3/4 통과»)에서 온 것이고, 버려도 기계 요약이 같은 비율을 다시 싣는다 — 그래서 «3/4 통과» 는 버려지고 «4건 중 3건
 *  통과» 는 남던 갈림만 생겼다. 버리는 근거는 산출 사실과 **부딪히는 말**(진행 없음·그대로·unchanged·still at)뿐이다.
 * ★**«그대로»·«unchanged» 는 진척을 가리킬 때만**(2026-10-23 릴리스 검토 P3). 낱말 하나로 버리면 «기존 기능은 그대로 유지하면서 …를 수정했습니다»·
 *  «The public API is unchanged; …» 같은 정상 설명까지 버렸다. 그래서 **진척 주어**(진행·진척·진전·할 일·비율 / progress·completion·to-do·비율)에
 *  붙은 것만 센다. ★주어가 진척이면 «그대로 유지·남아» 도 정체다(GPT R1 — «진행률은 0/7 그대로 유지» 를 놓쳤다). 빼는 건 일부러 손대지 않았다는
 *  «그대로 두/둔» 뿐. ★«상태·status» 는 진척 주어가 아니다(«HTTP 상태는 그대로»·«The HTTP status is unchanged» 는 정상 설명 — 진행 상태는 «진행» 이
 *  잡는다). «completion» 은 바로 뒤 동사·조동사만 거친다(«has remained» 포함 — GPT R2; «completion report is unchanged» 는 보고 형식 얘기다). 비율은 쉼표 너머를 보지 않는다(«3/4 pass, API
 *  unchanged»). 남는 한계: 진척 낱말이 우연히 앞에 오면(«진행 표시는 그대로 유지하며 …수정») 여전히 버린다 — 버려도 기계 요약이 나간다.
 */
export const summaryDeniesProgress = (text: string): boolean =>
  /(진행|진척|진전|구현|변화|변경)[^\n.。]{0,12}?(없|않)|(\d+\s*\/\s*\d+|진행|진척|진전|할 일)[^\n.。,;]{0,12}?그대로(?!\s*(?:두|둔))|no (?:real |actual |meaningful |substantive )?progress|(?:hasn't|has not|haven't|have not) (?:made|changed|progressed)|(?:progress|to-?dos?|\d+\s*\/\s*\d+)[^\n.;,]{0,20}?\bunchanged|\bcompletion(?:\s+rate)?\s+(?:(?:is|was|has|had|been|remains|remained|stays|stayed|still)\s+)*unchanged|\bunchanged (?:at|since)\b|still at \d/i.test(text);

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

/**
 * 할 일 줄 — ★**그 구간에 갱신되지 않았으면 낡았다고 적는다**(2026-10-23, 운영 인스턴스 실사례). 종전엔 시작 직후 한 번 적힌 «0/7» 이
 *  세 시간 뒤 알림에도 «지금» 처럼 실려, 커밋이 셋 있었는데 요약이 «할 일 0/7 그대로 · 진행 없음» 이라 했다.
 * @param stale `{ at, now }` — 마지막 갱신 시각이 이 알림 구간의 시작보다 앞이면 준다.
 */
const todoLine = (todos: readonly Todo[] | undefined, stale?: { at: number; now: number }): string | undefined => {
  if (todos === undefined || todos.length === 0) return undefined;
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  const params = { done, total: todos.length, now: now !== undefined ? (now.activeForm ?? now.content) : "—" };
  return stale === undefined
    ? translate("srv.job.progress.todos", params)
    : translate("srv.job.progress.todosStale", { ...params, ago: formatDuration(Math.max(0, stale.now - stale.at)) });
};
/** 그 구간에 할 일 갱신이 없었나 — `since` = 이 알림 구간의 시작(직전 알림·없으면 잡 시작). 갱신 시각을 모르면 낡았다고 하지 않는다. */
const staleOf = (todosAt: number | undefined, since: number, now: number): { at: number; now: number } | undefined =>
  todosAt !== undefined && todosAt < since ? { at: todosAt, now } : undefined;
/** 산출 사실 줄 — 0이면 없다. */
const outputsLine = (o: ProgressOutputs | undefined): string | undefined =>
  o !== undefined && o.writes + o.commits > 0 ? translate("srv.job.progress.outputs", { writes: o.writes, commits: o.commits }) : undefined;

/** 사람이 읽는 행동 한 줄 — `도구 대상`. */
const actionText = (a: ProgressAction): string => (a.detail !== undefined && a.detail !== "" ? `${a.tool} ${a.detail}` : a.tool);

/**
 * LLM 없이 만드는 진행 문단 — 요약이 실패하거나 요약기가 없을 때. 기록에 있는 것만 싣는다.
 */
export const mechanicalProgress = (p: { actions: readonly ProgressAction[]; todos?: readonly Todo[]; todosStale?: { at: number; now: number } }): string => {
  const recent = p.actions.slice(-3).map(actionText).join(" · ");
  // 행동이 없으면 그 줄을 안 싣는다 — 진행 중인 도구만 있는 알림에 «최근 행동 0건 · 마지막: —» 가 다시 나왔다(2026-10-14 재검토 P1).
  const lines = p.actions.length === 0 ? [] : [translate("srv.job.progress.mechanical", { count: p.actions.length, recent })];
  const t = todoLine(p.todos, p.todosStale);
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
  /** 직전 알림 이후 성공한 파일 쓰기·커밋(하네스가 센 값). */
  outputs?: ProgressOutputs;
  /** 할 일의 마지막 갱신 시각 · 이 구간의 시작 — 그 구간에 갱신이 없으면 할 일 줄에 «마지막 갱신» 을 붙인다. */
  todosAt?: number;
  since?: number;
}): string => {
  const ago = (at: number): string => formatDurationKo(Math.max(0, p.now - at));
  const lines = p.actions.map((a) => `- (${ago(a.at)} 전) ${actionText(a)}${a.error === true ? "  [오류]" : ""}`);
  // ★낡은 할 일은 요약 입력에 **안 싣는다**(2026-10-23) — 실으면 «0/7 그대로» 를 지금 상태처럼 쓴다. 사람에겐 기계 요약이 «마지막 갱신» 을 붙여 보인다.
  const t = p.since !== undefined && staleOf(p.todosAt, p.since, p.now) !== undefined ? undefined : todoLine(p.todos);
  const out = p.outputs !== undefined && p.outputs.writes + p.outputs.commits > 0 ? p.outputs : undefined;
  return [
    "아래는 백그라운드에서 돌고 있는 작업의 최근 도구 기록이다. 사용자에게 보낼 진행 상황을 2~3줄로 써라.",
    "규칙: 기록에 있는 것만 말한다. 결과·성공을 지어내지 않는다. 앞으로 할 일을 약속하지 않는다. [오류] 가 있으면 숨기지 말고 말한다.",
    "같은 행동이 반복되면 «같은 일을 반복하고 있다» 고, 최근에 활동이 없으면 «한동안 새 활동이 없다» 고 사실대로 말한다. 머리말·인사 없이 본문만.",
    "진척 여부·완료율·할 일 진행률은 평가하지 않는다 — 그건 하네스가 따로 붙인다. 무엇을 하고 있는지만 말한다.",
    `언어: ${p.language}`,
    "",
    `작업 이름: ${p.label}`,
    `맡긴 일: ${p.task.slice(0, 400)}`,
    `경과: ${formatDurationKo(p.elapsedMs)}`,
    `마지막 활동: ${ago(p.lastActivityAt)} 전`,
    ...(p.errors > 0 ? [`직전 보고 이후 오류로 끝난 도구 호출: ${String(p.errors)}건`] : []),
    ...(out !== undefined ? [`결과물(직전 보고 이후, 하네스가 센 값): 파일 쓰기 ${String(out.writes)}건 · 커밋 ${String(out.commits)}건`] : []),
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
 * 답이 이어지지 않은 작업자 알림 줄(2026-10-25, `notify_owner` 설계 §7.2) — `⛔ 막힘(07:46): …`. 요약 프롬프트엔 넣지 않는다(오류 줄처럼
 *  하네스가 붙이는 사실 줄). 시각은 데몬 기계의 현지 시각(HH:MM).
 */
export const noticeLines = (notices: readonly { at: number; text: string }[]): string[] =>
  notices.map((n) => {
    const d = new Date(n.at);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return translate("srv.job.progress.notice", { time, text: n.text });
  });

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
  /** 직전 알림 이후 성공한 파일 쓰기·커밋 — 종료 이벤트에서 센 값(목록 밖으로 밀린 것도 든다). */
  outputs?: ProgressOutputs;
  /** 할 일의 마지막 갱신 시각 · 이 알림 구간의 시작(직전 알림, 없으면 잡 시작). */
  todosAt?: number;
  since?: number;
  /**
   * 답이 이어지지 않은 작업자 알림 — 머리줄 **바로 아래** 첫 줄들(머리줄이 «어느 작업인가» 를 말해야 그 줄이 주어를 갖는다).
   * ★값이 아니라 **함수**다 — 요약을 기다리는 사이 답이 도착할 수 있다(GPT R1 #1). 본문을 조립하는 그 순간에 묻는다.
   */
  notices?: () => readonly { at: number; text: string }[];
}): Promise<{ text: string; summarized: boolean } | null> => {
  // 말할 사실이 없으면 보내지 않는다 — 글만 쓰는 잡에 «최근 행동 0건» 빈 알림이 나갔다(2026-10-14 적대 검토 P1).
  // ★산출도 말할 사실이다 — 알림 전에 시작해 알림 뒤 끝난 커밋은 이 구간의 시작 행동이 없어 빈 알림 판정에 걸려, 센 값이 버려졌다(GPT R1).
  const hasOutputs = p.outputs !== undefined && p.outputs.writes + p.outputs.commits > 0;
  if (p.actions.length === 0 && p.inFlight.length === 0 && p.errors === 0 && !hasOutputs) return null;
  const todosStale = p.since === undefined ? undefined : staleOf(p.todosAt, p.since, p.now);
  let body: string | undefined;
  if (summarizer !== undefined && p.actions.length > 0) {
    try {
      const out = await summarizer(
        buildProgressPrompt({
          label: p.name, task: p.task, elapsedMs: p.elapsedMs, actions: p.actions, todos: p.todos, language: p.language,
          now: p.now, lastActivityAt: p.lastActivityAt, inFlight: p.inFlight, errors: p.errors,
          ...(p.outputs !== undefined ? { outputs: p.outputs } : {}),
          ...(p.todosAt !== undefined ? { todosAt: p.todosAt } : {}),
          ...(p.since !== undefined ? { since: p.since } : {}),
        }),
        { jobId: p.jobId },
      );
      const trimmed = out?.trim();
      // 산출이 있는데 진척을 부정하는 요약은 버린다 — 기계 요약(기록에 있는 것만)이 대신 나간다.
      if (trimmed !== undefined && trimmed !== "" && !(hasOutputs && summaryDeniesProgress(trimmed))) body = trimmed.slice(0, 600);
    } catch {
      body = undefined;
    }
  }
  const summarized = body !== undefined;
  const lines = [
    translate("srv.job.progress.header", { name: p.name, elapsed: formatDuration(p.elapsedMs) }),
    ...noticeLines(p.notices?.() ?? []),
    body ?? mechanicalProgress({ actions: p.actions, todos: p.todos, ...(todosStale !== undefined ? { todosStale } : {}) }),
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
  // ★산출도 하네스가 붙인다 — 요약이 «진행 없음» 이라 해도 커밋·파일 쓰기가 있었다는 사실은 남는다(2026-10-23).
  const o = outputsLine(p.outputs);
  if (o !== undefined) lines.push(o);
  return { text: lines.join("\n"), summarized };
};
