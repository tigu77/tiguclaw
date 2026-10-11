/**
 * Mid-turn steering 프리미티브 (코어 소유 — 단방향 §0: 어댑터·채널 이름 참조 0).
 *
 * 진실 소스: `docs/decisions/2026-07-16-midturn-steering.md` §3(프리미티브)·§4(계약 필드).
 *
 * 사용자가 비서 작업(턴) 중에 보낸 메시지를 **그 턴에 즉시 반영**(steering)하기 위한
 * 채널·LLM 무관 중립 큐. 핸들러가 turn 마다 1개 생성해 `Map<threadKey, SteeringChannel>`
 * (inflightTurns 자매)에 등록하고 finally 에서 close 한다. producer=핸들러(개입점 push),
 * consumer=어댑터(P1 이후 — P0 에선 소비 0).
 *
 * 두 소비 shape 를 모두 노출한다(SDK idiom 흡수 — presentOptions/sendAttachment 가 클로저로
 * 흡수하는 것과 동형, 과한 추상 아님):
 *  - `drain()`  : 비블로킹 pull-all — codex 루프 상단·openai callModelInputFilter 가 소비.
 *  - `stream()` : 도착 시 yield 하는 async 제너레이터 — claude streaming-input prompt 가 소비.
 * 공통 계약 = "대기 steering 은 다음 model-call 경계에서 대화에 append"(ADR §계약2).
 *
 * ★견고성(ADR §3): close() 멱등, drain 은 빈 배열 안전, stream 은 close/abort 에 종료 보장
 * (무한대기 0). 부품 1개(작은 async 큐)로 최소 표면 유지(단순성 게이트 §Q6).
 */
import type { Attachment, IncomingMessage } from "../channels/types.js";
import { withReplyQuote } from "./reply-quote.js";
import { translate } from "./i18n.js";

/** 채널이 만드는 중립 steering 의도(채널·LLM 무관). telegram·대시보드·cli·http 동형. */
export interface SteeringInput {
  /** steer 텍스트 — 진행 턴에 끼워넣을 사용자 메시지 본문(개입점이 framing 으로 감싼 값). */
  text: string;
  /**
   * 사용자가 실제로 친 **원문**(framing 없음).
   *
   * ★왜 따로 드는가 (2026-07-27 라이브 버그): `text` 는 모델에게 "하던 작업을 이어가라" 고
   *  지시하는 노트로 감싼 값이다. 그 문맥은 *진행 중 턴에 끼워넣을 때만* 맞는데, 미소비
   *  steering 재주입(새 턴으로 다시 태우는 경로)이 감싼 값을 그대로 써서 **사용자 화면에
   *  "내가 보낸 메시지" 로 framing 전문이 노출**됐다(회사 인스턴스 대시보드 실측).
   *  게다가 새 턴엔 "이어갈 작업" 이 없으니 모델에게도 틀린 문맥이다.
   *  재주입·표시처럼 *사용자 관점* 이 필요한 곳은 반드시 이 필드를 쓴다.
   */
  raw: string;
  /**
   * 멀티모달 parity — 첨부도 steer 가능(없으면 생략). `IncomingMessage.attachments` 와
   * 동형(운반 타입 `Attachment` = SDK 비종속, path+메타만).
   */
  attachments?: Attachment[];
  /** 도착 시각(관측·정렬용). 개입점이 Date.now() 로 채운다. */
  ts: number;
  /**
   * 이 메시지가 답글이면 그 대상 원문(2026-10-06). `text` 에는 이미 붙어 있고, 미소비분을 새 턴으로 재주입할 때
   * `raw` 에 **자기** 원문을 다시 붙이려고 따로 든다(재주입은 그 턴을 연 다른 메시지의 원문을 쓰면 안 된다).
   */
  replyToText?: string;
  /**
   * **누가 넣었나** (2026-08-19, ADR background-subagents 위험 목록).
   *
   * ★같은 큐에 두 종류가 들어온다: 사용자 개입과 **백그라운드 자식의 결과**.
   *  출처 표식이 없으면 소비처가 둘을 구분할 수 없고, 실제로 두 군데서 틀린다 —
   *   ① 턴 끝 잔여 통지가 자식 결과를 "방금 보내신 지시" 로 사용자에게 되읽어준다
   *   ② 모델이 자식 결과를 "사용자가 말했다" 로 읽는다
   *  미지정 = `"user"`(종전 호출부 전부가 그 의미였다 — 회귀 0).
   *
   * ★순서는 출처와 무관하게 **도착 순** 그대로다. 사용자의 "그만" 이 자식 결과보다
   *  먼저 반영돼야 하므로 출처로 재정렬하지 않는다.
   */
  source?: "user" | "job";
}

/**
 * 큐에서 걷은 것을 **출처로 가른다** (2026-08-19).
 *
 * ★두 소비처가 서로 다른 걸 원한다:
 *  - 매니저의 거두기 루프 → 자식 결과(`job`)만. 그걸로 턴을 이어 마무리한다.
 *  - 턴 끝 잔여 통지 → 사용자 지시(`user`)만. 자식 결과를 "방금 보내신 지시" 로
 *    되읽어주면 사용자는 **자기가 안 보낸 문장**을 자기 것으로 통보받는다.
 *
 * 미지정은 `user` 로 본다 — 이 필드가 생기기 전 호출부가 전부 사용자 개입이었다.
 */
export const partitionSteering = (
  msgs: readonly SteeringInput[],
): { jobResults: SteeringInput[]; userMessages: SteeringInput[] } => {
  const jobResults: SteeringInput[] = [];
  const userMessages: SteeringInput[] = [];
  for (const m of msgs) {
    if (m.source === "job") jobResults.push(m);
    else userMessages.push(m);
  }
  return { jobResults, userMessages };
};

/**
 * 매니저가 **턴을 더 끌어야 하나** — "소환자는 거두고 끝난다" 의 판정 한 줄.
 *
 * ★프롬프트로 부탁하지 않고 여기서 정하는 이유: 모델이 안 지키는 날이 오고 그날은
 *  조용하다(자식 결과가 아무에게도 안 간다). 사용자 확정 사항이다 —
 *  *"시스템적으로 안 거둘 수 없게 해야지"*.
 *
 * ★**종료 보장은 `aborted` 하나뿐이다**(WORKER_TIMEOUT_MS·사용자 취소). `liveChildren` 은
 *  단조 감소가 **아니다** — 자식은 스스로 또 자식을 못 띄우지만(depth 게이트), **매니저는
 *  거두는 중에도 새 자식을 띄울 수 있다**(`reaches("agents","manager")`).
 *
 * ★그건 빠뜨림이 아니라 **결정이다**(2026-09-01 정태님 확정). 작업 전체를 매니저가
 *  소유하고, 늦게 온 결과가 완료조건을 실제로 깨면 매니저가 이어서 고쳐야 한다. 한때
 *  거두기 턴의 도구를 0으로 막아 여기서 단조 감소를 만들었다가 **되돌렸다** — 그러면
 *  진짜 차단 결함도 못 고친다. 대신 거두기 턴에 **원래 요청과 완료조건을 다시 싣는다**
 *  (`worker-registry.ts` 의 범위 보존 문구).
 *
 * ★그래서 이 루프가 길어지는 것은 **모델의 범위 판단이 틀렸다는 신호**이지 배관 결함이
 *  아니다. 라이브 사고(worker:4bb5d813)가 그 경우였다 — 마감 보고 뒤 86분간 새 자식 7개.
 *
 * ★**그걸 어떻게 아는가 — 정확히 적는다** (2026-09-01 적대 검토 G-2). 처음엔 *"로그의
 *  «남은 자식» 수가 라운드마다 늘면 보인다"* 고 적었는데 **그 사고 모양에선 거짓이다.**
 *  검토가 사고를 재현하니 `남은 자식 0건` 이 찍혔다. 이유는 구조적이다:
 *   - `listLiveChildJobs` 는 **라운드 경계에서만** 표본을 뜨는데, `spawn_agent(wait:true)`
 *     자식은 턴 **안에서** 나고 죽는다 → 경계엔 흔적이 없다.
 *   - awaited 자식은 `onWorkerComplete`→수신함 경로를 안 타므로 **추가 라운드도 안 생긴다**.
 *  ★기제는 **표본 시점**이지 카운터의 성질이 아니다 — `listLiveChildJobs` 에 `detached`
 *   필터는 **없다**(`status === "running"` + 세션 소속만 본다). awaited 자식도 똑같이
 *   등록된다. 라운드 경계에서 재기 때문에 이미 끝나 있을 뿐이다(2라운드 검토 정정 —
 *   내가 «detached 만 센다» 고 요약해서, 없는 필터를 찾으러 가게 만들었다).
 *
 * ★실제로 폭주를 드러낸 신호는 이 둘이었다(오늘 사고를 이걸로 재구성했다):
 *   - `[tool-slow] … 도구 spawn_agent 이(가) 600s+` — awaited 호출 **하나당 한 번**.
 *     실측: 자식 7개 중 600초를 넘긴 4개가 정확히 4줄로 찍혔다.
 *   - `worker-registry: … **거두기 턴** N회째 시작` — 턴 경계를 주므로 «그 86분이 어느
 *     턴에 속하나» 를 답할 수 있다(종전엔 이 줄이 없어 추론해야 했다).
 */
export const shouldKeepReaping = (o: {
  aborted: boolean;
  /** 아직 안 먹인 자식 결과 수. */
  pendingResults: number;
  /** 아직 도는 직계 자식 수. */
  liveChildren: number;
}): boolean => {
  if (o.aborted) return false;
  return o.pendingResults > 0 || o.liveChildren > 0;
};

export interface SteeringChannel {
  /**
   * producer(핸들러 개입점) — 대기 steering 1건 적재 + pending stream 대기자 unblock.
   * 반환값(ADR §"완료 데드락 + 수정" Part B) — `true`=적재 성공(진행 턴에 반영),
   * `false`=채널이 이미 close 됨(result 후 손실창 — 호출자는 새 턴으로 fall-through 해야
   * 손실 0 유지). 호출자는 index.ts 개입점 1곳뿐(codex/openai 는 drain 소비라 반환값 무영향).
   */
  push(msg: SteeringInput): boolean;
  /** consumer(codex/openai) — 비블로킹 pull-all(버퍼 반환+클리어, 빈 배열 안전). */
  drain(): SteeringInput[];
  /**
   * 이미 꺼냈던 것을 **맨 앞에** 되돌린다. 꺼낸 것은 아직 안 꺼낸 대기분보다 **먼저 도착한 것**이라 앞에 둬야 도착 순서가
   * 지켜진다(2026-10-10 아스트라 검토: `push` 로 되돌리니 «A 소비 → 정정 B 대기 → 실패» 가 B, A 로 뒤집혔다).
   * ★**닫혀 있어도 받는다** (2026-10-11 릴리스 검토 F1). «닫힘» 은 `/stop` 만이 아니라 claude 어댑터가 result 를 보고 스스로 닫는
   *  것도 뜻한다 — 종전엔 닫힘이면 0 이라, 끼워넣은 메시지가 SDK 에 들어간 뒤 턴이 오류 result(한도 «hit your limit» 포함)로 끝나면
   *  되돌릴 곳이 없어 **조용히 사라졌다.** 턴 출구는 늘 닫은 **뒤에** drain 하고(`endTurn`·매니저 정리), `/stop` 이면 거기서
   *  버린다(`reinjectUnlessStopped`) — 그 판정은 그 한 곳에 둔다. 되돌리는 쪽은 그 전에 자기 입력 스트림을 끊어야 한다
   *  (`stream()` 은 닫혀도 버퍼를 먼저 비운다).
   */
  restore(msgs: SteeringInput[]): number;
  /** consumer(claude) — 도착 시 yield, close/abort 시 종료(무한대기 0). */
  stream(signal: AbortSignal): AsyncGenerator<SteeringInput>;
  /** 턴 종료 — 멱등. pending stream 대기자 unblock(→ 제너레이터 종료). */
  close(): void;
  /**
   * **소비하지 않고** 닫힐 때까지(또는 abort) 기다린다 (2026-09-30).
   * ★claude 는 줄 선 턴이 도는 동안 입력(stdin)을 열어 둬야 한다(닫으면 그 턴의 훅·내장 도구가 취소된다).
   *  그 사이 온 입력은 되돌려 놓아 코어의 drain→새 턴이 받게 하고, 제너레이터는 여기서 닫힘만 기다린다.
   *  `stream()` 으로 기다리면 되돌려 놓은 걸 **다시 꺼내** 무한히 돈다.
   */
  untilClosed(signal: AbortSignal): Promise<void>;
}

/**
 * 작은 async 큐 1개. push=버퍼 append + waiter resolve, drain=버퍼 반환+클리어,
 * stream=버퍼 flush 후 새 도착 await(close/abort 시 return), close=멱등 + waiter unblock.
 */
export const createSteeringChannel = (): SteeringChannel => {
  const buffer: SteeringInput[] = [];
  // stream() 이 새 도착을 기다리며 등록한 resolve 들. push/close 가 깨운다.
  let waiters: Array<() => void> = [];
  let closed = false;

  // 대기 중인 stream 소비자 전부 깨우기(push 도착·close 공통). 스냅샷 후 클리어 —
  // 깨어난 소비자가 다시 등록하는 것과 재진입 충돌 0.
  const wake = (): void => {
    if (waiters.length === 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    push(msg: SteeringInput): boolean {
      // 턴 종료(close) 후 도착 = 소비자 없음 → 드롭 + false 반환(호출자가 새 턴으로
      // fall-through 해 손실 0 유지 — ADR §Part B). close↔push 경합 방어(P0 부터 동일 가드,
      // 반환형만 boolean 화).
      if (closed) return false;
      buffer.push(msg);
      wake();
      return true;
    },
    drain(): SteeringInput[] {
      if (buffer.length === 0) return []; // 빈 배열 안전.
      return buffer.splice(0, buffer.length);
    },
    restore(msgs: SteeringInput[]): number {
      if (msgs.length === 0) return 0;
      buffer.unshift(...msgs);
      wake();
      return msgs.length;
    },
    async *stream(signal: AbortSignal): AsyncGenerator<SteeringInput> {
      if (signal.aborted) return; // 이미 abort — 즉시 종료(무한대기 0).
      const onAbort = (): void => wake(); // abort 도 대기자를 깨워 루프가 재평가 후 종료.
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          // 1) 버퍼 flush — 도착분 즉시 yield.
          for (;;) {
            if (signal.aborted) return;
            const next = buffer.shift();
            if (next === undefined) break;
            yield next;
          }
          // 2) 종료 조건 — close 또는 abort 면 즉시 종료.
          if (closed || signal.aborted) return;
          // 3) 새 도착/close/abort 대기(무한대기 0 — wake 가 push·close·abort 에서 호출).
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close(): void {
      if (closed) return; // 멱등.
      closed = true;
      wake(); // pending stream 대기자 unblock → 루프가 closed 감지 후 종료.
    },
    async untilClosed(signal: AbortSignal): Promise<void> {
      const onAbort = (): void => wake();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        // push 도 깨우므로 조건을 다시 본다 — 버퍼는 건드리지 않는다.
        while (!closed && !signal.aborted) await new Promise<void>((resolve) => { waiters.push(resolve); });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
};

// ★steering framing(2026-07-24): mid-turn 메시지를 "새 지시"가 아니라 "작업 중 끼어든 노트"로
// 감싼다. 안 감싸면 진행 중 codex/claude 모델이 새 사용자 메시지를 새 지시로 받아 **하던 작업을
// 버리고** 그것만 답하고 턴을 끝냈다(강제완료 버그). 이 note 로 "작업 이어가되 반영/후처리" 를
// 지시. echo(publishInboundEcho)는 원문 msg 를 쓰므로 사용자 화면엔 원문만 보인다 — 이 framing 은
// 모델 입력에만 실린다. 3어댑터 전부 s.text 를 읽으므로 여기 한 곳 = LLM-agnostic parity.
export const STEERING_NOTE_PREFIX =
  "[진행 중 작업에 사용자가 끼어들어 보낸 메시지입니다. 지금 하던 작업을 중단·포기하지 말고 " +
  "계속하세요 — 현재 작업에 대한 조정·추가 지시면 반영해 이어가고, 별개의 새 요청이면 지금 " +
  "작업을 마친 뒤에 다루세요. 사용자 원문:]";

/**
 * 채널 IncomingMessage → 중립 SteeringInput(ADR §3). 텍스트(framing 래핑)·첨부·도착시각만 실어 채널 무관화.
 * ★답글 원문도 싣는다(2026-10-06) — 응답 중에 보낸 답글이 무엇에 대한 말인지 비서가 알아야 한다(종전엔 빠졌다).
 */
export const toSteeringInput = (msg: IncomingMessage): SteeringInput => ({
  text: `${STEERING_NOTE_PREFIX}\n${withReplyQuote(msg.text, msg.replyToText)}`,
  raw: msg.text, // 사용자 원문 — 재주입·표시는 반드시 이걸 쓴다(framing 노출 사고 방지).
  ...(msg.replyToText !== undefined && msg.replyToText.trim() !== "" ? { replyToText: msg.replyToText } : {}),
  ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
  ts: Date.now(),
});

/**
 * 미소비 끼워넣기를 새 턴으로 재주입할 본문 — 원문(raw)으로, 메시지마다 **자기** 답글 원문을 붙인다(2026-10-06).
 * ★재주입 메시지는 그 턴을 연 메시지(`...msg`)를 바탕으로 만들므로, 그 답글 원문이 남아 있으면 다른 메시지에 엉뚱한
 *  원문이 붙는다 — 호출부가 그 필드를 비우고 이 본문을 쓴다.
 */
export const reinjectTextFor = (leftover: readonly SteeringInput[]): string =>
  leftover
    // 본문이 비어도 답글이면 남긴다 — 첨부만 담은 답글의 인용이 재주입에서 사라지지 않게(재검토 P1, 새 턴 경로와 같게).
    .filter((s) => (typeof s.raw === "string" && s.raw.trim() !== "") || (s.replyToText ?? "").trim() !== "")
    .map((s) => withReplyQuote(s.raw ?? "", s.replyToText))
    .join("\n\n");

/**
 * 미소비 끼워넣기를 **새 턴으로 다시 태울 메시지** — 없으면 null.
 * ★그 턴을 연 메시지(`msg`)를 바탕으로 하되 그 메시지의 답글 원문은 **비운다** — 본문에 이미 메시지마다 자기 원문이
 *  붙어 있다(reinjectTextFor). 남겨 두면 새 턴 경로가 그 원문을 한 번 더, 다른 메시지들 앞에 붙인다.
 * ★`synthetic` — 이 메시지들은 끼워넣을 때 이미 화면에 떴다. 재주입에서 또 echo 하면 두 번 보인다.
 * 순수 함수로 둔 이유: index.ts 안에서 조립하면 검사가 정규식밖에 못 하고, 덧붙이기 한 줄에 뚫렸다(재검토 G1·G2).
 */
export const buildReinjectMessage = <M extends IncomingMessage>(
  msg: M,
  leftover: readonly SteeringInput[],
  now: number = Date.now(),
): IncomingMessage | null => {
  const text = reinjectTextFor(leftover);
  const atts = leftover.flatMap((s) => s.attachments ?? []);
  if (text === "" && atts.length === 0) return null;
  const { replyToText: _thisTurnsQuote, ...turnMsg } = msg;
  return {
    ...turnMsg,
    text,
    ...(atts.length > 0 ? { attachments: atts } : {}),
    receivedAt: now,
    synthetic: true as const,
  } as IncomingMessage;
};

const USER_CANCELLED = "UserCancelledError";

/**
 * 사용자 중단(`/stop`) — 진행 중 턴을 프로세스 안 죽이고 abort 할 때 넣는 사유. 핸들러는 이 사유를 보면 에러가 아니라
 * 사용자 취소로 알고 조용히 끝낸다(안내는 `/stop` 이 한다).
 * ★판정은 `isUserCancelled` 한 곳이다 — 종전엔 이름 문자열이 index.ts·여기·llm-runtime facade 세 곳에 흩어져, 하나만 바뀌면
 *  `/stop` 이 재주입·turn_error·폴백으로 새는데 회귀는 이름을 손으로 만들어 써서 초록이었다(적대 검토 2026-10-06).
 */
export class UserCancelledError extends Error {
  constructor() {
    super("user cancelled turn (/stop)");
    this.name = USER_CANCELLED;
  }
}

/** abort 사유가 `/stop` 인가 — 이름으로 본다(어댑터가 사유를 감싸 다시 던져도 같은 판정). */
export const isUserCancelled = (reason: unknown): boolean => reason instanceof Error && reason.name === USER_CANCELLED;

/** `/stop` 으로 끝난 턴인가. */
export const stoppedByUser = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && isUserCancelled(signal.reason);

/**
 * `/stop` 이 걸리는 **그 순간** 이 턴의 끼워넣기 통로를 닫는다 — 이미 멈췄으면 바로 닫는다 (2026-10-06).
 * ★종전엔 통로가 턴의 finally 에서야 닫혔다. 그 사이(어댑터 정리 · 멈춤 안내 송신)에 사용자가 «아니, 이렇게 해 줘» 를 보내면
 *  끼워넣기로 받혀(push=true) 새 턴이 안 열리고, finally 는 `/stop` 이라 그걸 버렸다 — 건수에도 안 잡힌 **조용한 유실**이다.
 *  닫아 두면 push 가 false 를 받아 새 턴이 된다(«멈추고 방향 틀기»). 그 전에 쌓인 것은 finally 가 지금처럼 버리고 `/stop` 답이 센다.
 * ★`/stop` 만 닫는다 — 무응답 시한 같은 다른 끝은 남은 것을 새 턴으로 다시 태우므로(`reinjectUnlessStopped`) 받아도 잃지 않는다.
 */
export const closeWhenStopped = (ch: SteeringChannel, signal: AbortSignal): void => {
  if (stoppedByUser(signal)) {
    ch.close();
    return;
  }
  signal.addEventListener("abort", () => {
    if (stoppedByUser(signal)) ch.close();
  }, { once: true });
};

/**
 * 턴이 끝날 때 남은 끼워넣기를 **새 턴으로 다시 태울 메시지** — `/stop` 으로 끝났으면 null(버린다) (2026-10-06).
 * ★멈춘 동안 쌓인 메시지는 대개 «왜 답이 없어» · «??» 다 — 멈춘 직후 그걸로 새 턴을 열면 «Tell me what to do next» 라고 해 놓고
 *  엉뚱한 답을 늘어놓는다. 그리고 어댑터마다 달랐다: claude 는 SDK 안쪽 대기열과 함께 조용히 사라지고, codex·openai 는 이
 *  재주입으로 새 턴이 됐다. `/stop` 이면 어댑터와 무관하게 버리고, 몇 건이었는지는 `/stop` 답이 알린다(`stopReplyText`).
 */
export const reinjectUnlessStopped = <M extends IncomingMessage>(
  signal: AbortSignal | undefined,
  msg: M,
  leftover: readonly SteeringInput[],
  now: number = Date.now(),
): IncomingMessage | null => (stoppedByUser(signal) ? null : buildReinjectMessage(msg, leftover, now));

/**
 * `/stop` 답 — 멈춘 것 · 함께 멈춘 백그라운드 작업 · **이 턴에 끼워 넣었던 메시지**를 알린다(2026-10-06).
 * ★끼워 넣은 메시지는 처리하지 않고 버린다 — 조용히 버리지 않는다(진짜 지시가 섞였을 수 있다). claude 는 SDK 가 그중 무엇을
 *  이미 소화했는지 우리가 모르므로 «처리하지 못한 것은» 으로 말한다. 문장은 카탈로그(`srv.stop.*`)에 있다.
 */
export const stopReplyText = (stoppedJobs: number, steeredMessages: number): string => {
  // 문장 단위로 고르고 잇는다 — 단수/복수는 키가 갈린다(카탈로그에 로직 없음).
  const first =
    stoppedJobs > 0
      ? translate(stoppedJobs === 1 ? "srv.stop.stoppedWithJobs.one" : "srv.stop.stoppedWithJobs.other", { count: stoppedJobs })
      : translate("srv.stop.stopped");
  const dropped =
    steeredMessages > 0
      ? [translate(steeredMessages === 1 ? "srv.stop.dropped.one" : "srv.stop.dropped.other", { count: steeredMessages })]
      : [];
  return [first, ...dropped, translate("srv.stop.next")].join(" ");
};
