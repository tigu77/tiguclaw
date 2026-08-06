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
const toolHardMs = (): number =>
  parsePosIntEnv(process.env.TOOL_HARD_TIMEOUT_MS, 780_000);

/**
 * 하드 상한에서 **제외**되는 도구 — 자기 상한을 이미 가진 것들.
 * 서브에이전트는 `SUBAGENT_TIMEOUT_MS`(기본 2시간)로 스스로 끊는다. 여기서 13분에 자르면
 * **정상적인 장시간 위임을 죽인다**(실측: 완료 서브 138건 평균 124초·최대 627초지만 상한은
 * 시간 단위). 느림 경고 완화와 같은 판정을 쓰는 것은 우연이 아니다 —
 * "오래 걸리는 게 정상" 이라는 같은 사실의 두 얼굴이다.
 */
const hardExempt = (tool: string): boolean => isLongRunningByDesign(tool);

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
    console.warn(
      `[tool-slow] ${input.threadKey} 도구 ${input.tool} 이(가) ${Math.round(ms / 1000)}s+ ` +
        `실행 중 — 권한 다이얼로그(OS) 대기·외부 MCP 백엔드 부재(서버는 연결됐어도 대상 앱/` +
        `에디터 미실행)·hung·느림 의심.${input.note !== undefined ? ` ${input.note}` : ""}`,
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
    input.onHard !== undefined && !hardExempt(input.tool)
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
