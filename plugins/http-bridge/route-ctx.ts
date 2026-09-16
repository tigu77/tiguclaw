/**
 * **라우트가 보는 전부** — 한 벌만 둔다.
 *
 * ★`index.ts` 의 `handleRequest`(원래 2,972줄)를 관심사별 모듈로 가르면서 만들었다
 *  (2026-08-30). 군집마다 자기 `RouteCtx` 를 두면 그게 곧 **같은 개념 여러 벌**이고,
 *  필드 하나를 더할 때 어디까지 고쳐야 하는지 아무도 모르게 된다
 *  ([[feedback_simple_composable_no_duplication]]).
 *
 * ★필드는 **재서 정했다** — 라우트 본문 전체를 훑어 실제로 쓰는 것만 넣었다:
 *  `this.bus` 11회 · `this.name` 7 · `this.sseClients` 3 · `this.channelHandler` 3.
 *  나머지 멤버(`port`·`allowedHosts`·`resolveToken`)는 **인증 전처리**에서만 쓰이고
 *  라우트 본문은 안 쓴다 — 그래서 여기 없다.
 *
 * ★클래스를 통째로 넘기지 않는 이유: 그러면 라우트가 `stop()`·`ensureServer()` 까지
 *  부를 수 있게 되고, "이 라우트가 무엇을 만지나" 를 파일만 보고 알 수 없다.
 */
import type http from "node:http";
import type { EventBus } from "../../src/core/eventbus.js";
import type { MessageHandler } from "../../src/channels/types.js";

export interface RouteCtx {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  /**
   * 요청 경로 — `url.pathname` 과 같은 값이다.
   * ★**프리픽스 라우트**(`/attachments/…`·`/plugin-data/…`)가 접두를 잘라 뒤를 쓴다.
   *  `url` 에서 매번 꺼내게 두면 그 한 줄이 라우트마다 복사된다.
   */
  readonly pathname: string;
  /** 채널 이름(`"http-bridge"`) — 관측 이벤트의 출처로 실린다. */
  readonly channelName: string;
  readonly bus: EventBus | null;
  /**
   * 열려 있는 SSE 연결들.
   *
   * ★**읽기 전용이 아니다** — `/events` 가 자기 연결을 **등록하고, 끊기면 지운다.**
   *  처음엔 `ReadonlySet` 으로 뒀는데 타입체커가 바로 잡았다(`add`·`delete` 없음).
   *  구독 수명을 그 라우트가 소유하는 게 맞다 — 연결을 연 쪽이 닫는다.
   */
  readonly sseClients: Set<http.ServerResponse>;
  /** 인입 메시지를 비서에게 넘기는 통로 — `/messages` 가 쓴다. */
  readonly channelHandler: MessageHandler | null;
}

/**
 * 인입 처리 시한 — 라우트가 공유한다. **기본 없음(무한).**
 *
 * ★연혁과 근거 (2026-09-16 정태님 지적). 이 값은 브리지 첫 커밋(2026-05-15)부터 `60_000`
 *  이었고, 그때 `/messages` 는 «POST 로 넣고 `{replyText}` 를 받는» 동기 API 였다. 턴이
 *  짧던 시절의 숫자였고 **그 뒤 분포를 대고 다시 본 적이 없다.**
 *
 * ★실측(개발돌쇠 `llm.turn_done` 119건, 2026-08-07~09-15):
 *
 *      60초 초과 **69.7%** (대시보드만 65.5%) · 평균 턴 **349초** = 시한의 6배
 *
 *  즉 이 시계는 **건강한 턴의 셋 중 둘에서 발화**했다. 정상 경로에서 울리는 가드는 가드가
 *  아니다 — 그리고 발화해도 **일을 멈추지 못한다**: `Promise.race` 는 기다리기만 그만두고
 *  핸들러는 계속 돌아 턴을 끝낸다(격리 재현: 504 를 60.0초에 받은 뒤 핸들러가 75.0초에
 *  정상 완료). 소켓 하나를 닫을 뿐인데 그 대가로 **동기 계약이 깨졌다** — 60초를 넘는
 *  호출자는 `{replyText}` 를 영영 못 받는다. 시한을 푸는 쪽이 그 계약을 **지키는** 쪽이다.
 *
 * ★**매니저에서 이미 내린 결정과 같은 모양이다** (2026-08-22, `WORKER_TIMEOUT_MS`). 거기
 *  근거는 *"상한에 걸린 작업은 멈춘 게 아니라 돌고 있었는데 잘린 것"* + *"정당하게 발화한
 *  적 0회"* 였다. 여기는 더 나쁘다 — **69.7%가 부당 발화**다. 시계의 역할은 죽이기가
 *  아니라 확인이고, 확인은 턴 쪽(취소·`/stop`·잡 점검)이 이미 갖고 있다. 시계를 두 곳에
 *  두면 갈린다.
 *
 * ★**푸는 것이 자원을 위험하게 하지 않는다** — 둘 다 실측했다:
 *   ① Node 는 응답 시간에 기본 상한이 **없다**(`requestTimeout` 은 요청 *수신*만 잰다 —
 *     3초로 놓고 응답을 6초 늦춰도 발화 안 함). 그래서 여기서 풀면 정말 턴 끝까지 간다.
 *   ② 클라가 끊긴 뒤 `writeJson` 은 **안 던진다**(`destroyed=true` 인데 조용히 지나감).
 *     오래 잡고 있다가 탭이 닫혀도 크래시 경로가 없다.
 *
 * env `HTTP_BRIDGE_HANDLER_TIMEOUT_MS` 로 유한값 복원(`"0"`·`"off"` 는 무한).
 */
const parseTimeoutEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  if (/^(0|off|none|infinite|infinity)$/i.test(raw.trim())) {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const HANDLER_TIMEOUT_MS = parseTimeoutEnv(
  process.env.HTTP_BRIDGE_HANDLER_TIMEOUT_MS,
  Number.POSITIVE_INFINITY,
);
