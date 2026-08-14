/**
 * 도구 지연 감시 — **어댑터 무관** 단일 엔진 (2026-07-28, 딥리뷰 D).
 *
 * ★왜 공통층인가: 이 경고는 codex 어댑터의 수동 도구 루프 안에만 있었다. 그래서 claude·
 *  openai 로 도는 워커는 도구가 권한 다이얼로그에 막혀 조용히 멈춰도 **사용자에게 아무
 *  신호가 안 갔다** — "모든 기능은 LLM 무관"(원칙 #2) 위반. 판정 로직은 어댑터와 무관한
 *  순수 시간 문제라 여기 한 번만 두고, 어댑터는 자기 관측 지점에서 start/stop 만 부른다.
 *
 * 죽이지 않고 **경고만** 한다. 실행 취소·타임아웃은 각 어댑터/도구의 소관이다(경계 분리).
 *
 * 배경(codex 시절 실측): 워커 도구(Bash 등)가 macOS 권한 요청 다이얼로그에 막혀 멈췄는데
 * 도구 시작만 찍히고 완료 신호가 없어 "느림 vs 막힘" 구분이 안 돼 30분+ 헤맸다.
 */
import { getEventBus } from "../eventbus.js";
// ★도구 이름을 여기 열거하지 않는다 — 상류 SDK 가 개명하면(0.3 의 Task→Agent) 조용히
//  죽는다. 판정은 subagent-tools 한 곳(2026-08-07 사고).
import { isLongRunningByDesign } from "./subagent-tools.js";

const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * 기본 임계. 구 이름(CODEX_*)도 계속 읽는다 — 이미 설정해 둔 사용자를 깨지 않는다.
 *
 * ★모듈 로드 시점이 아니라 **호출 시점**에 읽는다 (2026-07-29). 상수로 굳히면 (a) 설정을
 *  바꿔도 재시작 전엔 안 먹고 (b) 회귀 검사가 짧은 임계로 **실제 발화**를 확인할 수 없다.
 *  실제로 그래서 tool-watchdog-parity 가 상수 비교만 하는 vacuous 검사였다(변이 테스트에서
 *  watchToolStart 를 통째로 no-op 으로 만들어도 46건 전부 초록). env 파싱은 마이크로초.
 */
const toolSlowWarnDefaultMs = (): number =>
  parsePosIntEnv(
    process.env.TOOL_SLOW_WARN_MS ?? process.env.CODEX_TOOL_SLOW_WARN_MS,
    180_000,
  );

/**
 * 도구별 임계 — "오래 걸리는 게 정상"인 도구는 이 경고의 대상이 아니다.
 * 실측(완료 서브에이전트 138건): 평균 124초·최대 627초. 90초 임계로는 59%가 초과해
 * 사실상 "서브에이전트가 돌고 있다" 알림이었다. 서브는 백그라운드 드로어에 스텝이
 * 실시간으로 보여 이 경고가 시키는 "확인해봐"를 사용자가 이미 다른 수단으로 한다.
 * 반대로 Bash·외부 MCP 는 그런 관측 수단이 없어 짧은 임계가 그대로 유효하다.
 */
const LONG_RUNNING_WARN_MS = 300_000;

export const toolSlowWarnMs = (tool: string): number =>
  isLongRunningByDesign(tool) ? LONG_RUNNING_WARN_MS : toolSlowWarnDefaultMs();

/**
 * ★**하드 상한 — 여기서는 끊는다** (2026-08-06, 회사 PC 로그 실측).
 *
 * 위 경고는 알려주기만 하고 아무도 안 끊었다. 실측(2026-08-05 회사 PC): `add_schedule`·
 * `list_schedules`·`Task` 가 경고 후 **완료 기록이 하나도 없이** 멈췄고, 마지막 건은 로그가
 * 끝나는 39분 뒤까지 조용했다. 세션은 직렬 큐라 그 턴이 안 끝나면 **다음 메시지도 처리되지
 * 않는다** — 사용자가 겪은 "먹통" 이 이것이다.
 *
 * ★왜 어댑터가 아니라 여기인가: 도구 상한(`MCP_CALL_TIMEOUT_MS` 11분)은 `_mcp-bridge` 에만
 *  있고 그건 **codex·openai 전용**이다. claude 는 MCP 서버를 SDK 에 직접 넘겨 그 상한을 안
 *  탄다 — 즉 **어댑터별로 그물이 달랐다**(원칙 #2 위반). 판정은 순수 시간 문제이므로 공통층에
 *  두고, 실제 중단 레버(AbortController)만 어댑터가 넘긴다.
 *
 * ★경계 순서: 안쪽이 먼저 끝나야 "무엇이 왜 끝났는지" 가 정확히 남는다. 기본 13분은 브리지
 *  11분보다 **바깥**이라, codex·openai 는 종전대로 브리지가 먼저 자르고 이 상한은 안 닿는다.
 *  claude 에만 실질 효력이 있다(그쪽에만 그물이 없었으므로 정확히 그게 목적).
 */
/**
 * ★**기본은 끊지 않는다** (2026-08-12, 사용자 확정: "오래 걸리는 건 그냥 냅두는 게 맞는 거고,
 *  에러는 확실히 알려주는 게 맞는 거고, 무슨 에러가 난 건지 정확하게 알려주는 게 중요하지").
 *
 * 종전 기본 13분은 **경과 시간으로 진행 중인 작업을 죽이는** 유일한 자리였다. 빌드·테스트·
 * 대형 마이그레이션은 13분을 예사로 넘기고, 그때 잘리면 사용자에겐 "LLM 응답이 멈춰
 * (타임아웃)" 로 전달됐다 — **원인도 틀리고 결과도 잘못된 죽음**이었다.
 *
 * 그럼 2026-08-06 에 이 상한을 넣게 만든 사고(도구가 진짜 멈춰 세션 직렬 큐가 얼어붙음)는?
 * 그건 **끊어서** 가 아니라 **몰라서** 나쁜 사고였다 — 아무 신호가 없어 39분을 헤맸다.
 * 그래서 신호는 남기고(`[tool-slow]` 경고 + `llm.tool_slow` 이벤트 → 워커 핑) 칼만 뺀다.
 * 진짜 멈춘 도구의 회복 경로는 그대로다: `/stop`(턴 중단) · `cancel_worker` · `/restart`.
 *
 * 끊고 싶으면 `TOOL_HARD_TIMEOUT_MS` 에 ms 를 명시한다(미설정 = 안 끊음).
 */
const toolHardMs = (): number | null => {
  const raw = process.env.TOOL_HARD_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return null; // 기본 = 상한 없음.
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 하드 상한에서 **제외**되는 도구 — 자기 상한을 이미 가진 것들.
 * 서브에이전트는 `SUBAGENT_TIMEOUT_MS`(기본 2시간)로 스스로 끊는다. 여기서 13분에 자르면
 * **정상적인 장시간 위임을 죽인다**(실측: 완료 서브 138건 평균 124초·최대 627초지만 상한은
 * 시간 단위). 느림 경고 완화와 같은 판정을 쓰는 것은 우연이 아니다 —
 * "오래 걸리는 게 정상" 이라는 같은 사실의 두 얼굴이다.
 */
const hardExempt = (tool: string): boolean => isLongRunningByDesign(tool);

/**
 * 사용자에게 나가는 "도구가 오래 걸린다" 통지 문구 — **로그와 같은 자리에서 만든다**.
 *
 * ★2026-08-14 사용자 신고: "도구호출 한도는 자꾸 왜 걸리는거지". 실제로 걸린 한도는
 *  하나도 없었다(전 기간 상한 이벤트 0건). 사용자가 본 것은 이 경고였고, 문구가
 *  **"멈춰 있어요 … 확인해주세요"** 라 한도에 걸려 중단된 것처럼 읽혔다.
 *
 * ★왜 여기냐: 2026-08-12 에 "오래 걸리는 건 실패가 아니다" 로 **로그 문구만** 고치고
 *  채널 푸시(worker-jobs.ts)를 안 봤다. 같은 판단이 두 곳에 있으면 한쪽만 늙는다 —
 *  그리고 늙은 쪽이 하필 **사용자가 실제로 읽는 쪽**이었다. 판정도 로그도 통지도 한 자리.
 *
 * ★인자는 **초**다(ms 아님) — 2026-08-14 적대 검토. 종전엔 ms 를 받아 두 호출부가
 *  `secs * 1000` 으로 되돌려 넘겼고, 변이 시험에서 `ms: secs` 로 바꾸자 180초 지연이
 *  **"0초째 실행 중입니다"** 로 나갔는데 검사는 초록이었다. 순수 함수는 잘 검사됐지만
 *  **호출부가 옳게 부르는지**는 아무도 안 봤다. 단위를 왕복시키지 않으면 그 부류가 사라진다.
 *
 * 문구 규칙 셋:
 *  ① **경과 보고지 판정이 아니다** — "멈췄다" 고 단정하지 않는다.
 *  ② **정상이 먼저** — 흔한 쪽(그냥 오래 걸림)을 앞에, 드문 원인(권한 다이얼로그)을 뒤에.
 *     드문 원인을 앞세우면 그게 진단으로 읽힌다(이번 신고의 기전).
 *  ③ **되돌릴 수단을 준다** — 기다릴지 끊을지는 사용자가 정한다.
 */
export const formatToolSlowNotice = (input: {
  readonly tool: string;
  /** 경과 **초**. ms 를 넘기지 마라 — 호출부는 이미 초를 갖고 있다. */
  readonly secs: number;
  /** 워커 통지면 잡 라벨. 없으면 메인 턴 통지. */
  readonly jobLabel?: string;
}): string => {
  const secs = Math.max(1, Math.round(input.secs));
  const subject =
    input.jobLabel === undefined
      ? `도구 '${input.tool}' 이(가)`
      : `백그라운드 작업 '${input.jobLabel}' 의 도구 '${input.tool}' 이(가)`;
  // 조사는 레버마다 박는다 — "cancel_worker 으로" 는 틀린 한국어다(받침 ㄹ → "로").
  const stop = input.jobLabel === undefined ? "`/stop` 으로" : "`cancel_worker` 로";
  return (
    `⏳ ${subject} ${secs}초째 실행 중입니다. ` +
    `오래 걸리는 작업이면 정상이니 그대로 두셔도 됩니다 — 끝나면 알려드려요. ` +
    `안 끝나는 것 같으면 OS 권한 요청 다이얼로그가 떠 있는지, 외부 MCP 도구면 대상 앱이 켜져 있는지 확인해 보시고, ` +
    `${stop} 중단하실 수 있어요.`
  );
};

export interface ToolWatchInput {
  readonly channel: string;
  readonly threadKey: string;
  readonly tool: string;
  /** 어댑터가 아는 추가 맥락(예: "8분에 타임아웃") — 경고 문구 끝에 붙는다. 없으면 생략. */
  readonly note?: string;
  /**
   * 하드 상한 도달 시 **실제로 끊는** 레버(어댑터의 AbortController 등). 넘기지 않으면
   * 종전대로 경고만 한다 — 판정은 공통층, 중단 수단은 어댑터 소유(경계 분리 유지).
   */
  readonly onHard?: (tool: string, ms: number) => void;
}

/**
 * 도구 실행 감시 시작 — 반환된 함수를 도구가 끝날 때 **반드시** 부른다(타이머 누수 0).
 * 타이머는 unref 라 이것 때문에 프로세스가 살아있지는 않는다.
 */
export const watchToolStart = (input: ToolWatchInput): (() => void) => {
  const ms = toolSlowWarnMs(input.tool);
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    // ★문구에서 "의심" 을 뺀다 (2026-08-12, 사용자: "오래 걸리는 건 실패가 아니야").
    //  이건 **경과 시간 보고**지 판정이 아니다. 종전 문구는 5분 넘게 도는 정상 서브에이전트
    //  까지 매번 hung 의심으로 적어(실측 08-11 하루 27회) 로그를 읽는 사람에게 잘못된
    //  선입견을 심었다. 진짜 멈춤은 결과가 **영영 안 오는 것**이지 오래 걸리는 게 아니다.
    console.warn(
      `[tool-slow] ${input.threadKey} 도구 ${input.tool} 이(가) ${Math.round(ms / 1000)}s+ ` +
        `실행 중입니다(진행 중일 수 있음 — 오래 걸리는 것 자체는 실패가 아닙니다). ` +
        `안 끝나는 것으로 보이면 권한 다이얼로그(OS) 대기·외부 MCP 대상 앱 미실행을 먼저 확인하세요.` +
        `${input.note !== undefined ? ` ${input.note}` : ""}`,
    );
    // 관측 이벤트 — worker-jobs 가 구독해 워커면 사용자에게 "멈춤, 권한 확인" 핑(잡당 1회).
    // 채널 무결합(어댑터는 event 만, dest 라우팅은 워커 계층). best-effort.
    try {
      getEventBus().publish({
        type: "llm.tool_slow",
        ts: Date.now(),
        payload: {
          channel: input.channel,
          threadKey: input.threadKey,
          tool: input.tool,
          ms,
        },
      });
    } catch {
      /* best-effort — 관측 실패가 도구를 무르지 않는다 */
    }
  }, ms);
  timer.unref?.();

  // ★하드 상한 — 여기서 끊는다(위 경고와 달리 실효). 어댑터가 `onHard` 로 자기 중단 레버를
  //  넘겼을 때만 동작한다(레버 없는 호출부는 종전대로 경고만 = 회귀 0).
  const hardMs = toolHardMs();
  const hardTimer =
    hardMs !== null && input.onHard !== undefined && !hardExempt(input.tool)
      ? setTimeout(() => {
          const secs = Math.round(hardMs / 1000);
          console.error(
            `[tool-hang] ${input.threadKey} 도구 ${input.tool} 이(가) ${secs}s 안에 안 끝나 ` +
              `**턴을 중단**합니다 — 도구 결과가 영영 안 오면 이 세션의 다음 메시지도 처리되지 ` +
              `않습니다(직렬 큐). 상한은 TOOL_HARD_TIMEOUT_MS 로 조정.`,
          );
          try {
            getEventBus().publish({
              type: "llm.tool_hang",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                tool: input.tool,
                ms: hardMs,
              },
            });
          } catch {
            /* best-effort */
          }
          try {
            input.onHard?.(input.tool, hardMs);
          } catch {
            /* 중단 레버 실패가 감시자를 죽이지 않는다 */
          }
        }, hardMs)
      : null;
  hardTimer?.unref?.();

  let stopped = false;
  return (): void => {
    if (stopped) return; // 멱등 — 어댑터가 중복 호출해도 안전.
    stopped = true;
    clearTimeout(timer);
    if (hardTimer !== null) clearTimeout(hardTimer);
  };
};
