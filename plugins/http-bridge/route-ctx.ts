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

/** 인입 처리 시한 — 라우트가 공유한다. */
export const HANDLER_TIMEOUT_MS = 60_000;
