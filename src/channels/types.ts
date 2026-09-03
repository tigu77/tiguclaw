import type { ChannelOutbound } from "../core/channel-outbound.js";

export type ChannelName = string;

export interface ReplyOptions {
  /**
   * 트리거 메시지에 대한 직접 답글로 렌더(채널 재량). 미지원 채널은 무시.
   * 추상적 의도 — 채널 raw(telegram reply_parameters 등)는 채널 어댑터 안에서만.
   */
  replyToTrigger?: boolean;
}

/** 중립 첨부 분류 — 채널이 자기 raw(telegram photo/document/voice 등)를 이 5종으로 매핑. */
export type AttachmentKind = "image" | "document" | "audio" | "video" | "voice";

/**
 * 채널-무관 중립 첨부. 특정 SDK content-block 포맷 비종속 (LLM-agnostic 절대 게이트).
 * V1 진실 소스 = `path` (양 어댑터가 native file 도구로 읽음). 어댑터가 자기 SDK 포맷으로
 * 변환하는 경계는 *어댑터 내부* 에만 — 채널은 path+메타 중립 타입만 만든다.
 *
 * contract: `_workspace/multimodal_input_architect_contract.md` §Q1.
 */
export interface Attachment {
  kind: AttachmentKind;
  /** IANA MIME (예 "image/jpeg", "application/pdf"). 불명 시 "application/octet-stream". */
  mimeType: string;
  /** <home>/data/attachments/... 절대경로. 채널 다운로드 후 저장 위치. 항상 채워진다. */
  path: string;
  /** 원본 파일명 (telegram document file_name 등). 없으면 path basename. */
  filename: string;
  /** 바이트 크기 (가드·로그·표시용). */
  bytes: number;
  /** 첨부와 함께 온 caption. V1 텔레그램 미사용 (text 가 caption 진실 소스). */
  caption?: string;
  /**
   * 오디오/음성 전사 결과 텍스트(additive, 2026-07-18 config-driven 전사).
   * ★코어(`runRegionA` 진입 seam `enrichTranscripts`)가 채운다 — 채널은 안 건드린다.
   * SDK 비종속 순수 텍스트(다른 중립 첨부 메타와 동류). 미설정 = 전사 미설정/실패/비대상
   * (image·document 등) → `formatAttachments` 가 현행 path-reference 그대로 렌더(회귀 0).
   * `kind==="audio"|"voice"` 첨부에만 채워지며, 값이 있으면 프롬프트에 전사 텍스트로 실린다.
   * contract: `_workspace/transcription_architect_contract.md` §1/§8.
   */
  transcript?: string;
}

export interface IncomingMessage {
  channel: ChannelName;
  channelUserId: string;
  threadKey: string;
  /**
   * 채널 주소 — outbound 배달 좌표(telegram chatId, http threadKey 등). 세션 정체성
   * (`threadKey`/세션 id)과 **별개** 필드로 운반한다(채널/세션 분리 ADR 2026-07-15 §D1/§D3).
   * 비동기 outbound(매니저 완료·능동발신)의 기본 목적지를 세션 id 에서 *파싱*하지 않고 여기서
   * *캡처* 하도록 하는 슬롯 — region/daemon 이 인입 시점에 채워 setSessionChannelMeta 로 세션
   * 메타(last_channel_target)에 적재한다. **어떤 어댑터도 이 값을 읽지 않는다**(순수 배달
   * 좌표, LLM-agnostic). additive — 미지정(cli 등 주소 없음/미채움 채널) = 현행 동작(회귀 0).
   * ★declaration only — 실제로 채우는 건 웨이브2(region/daemon).
   */
  channelAddress?: string;
  /**
   * 세션 정규화 지시(채널/세션 분리 ADR 2026-07-15 §D1/§D2) — 사용자 대면 채널
   * (telegram/cli/dashboard/http)이 인입 시 채워, daemon handler 가 `route(msg, {session})`
   * 로 세션 정체성을 정규화하게 한다(채널이 자기 정체성을 threadKey 에 인코딩하던 것을
   * 코어 resolver 단일 정의점으로 대체). 채널은 `resolveSessionId` 로 sessionId 를 구해
   * **route 호출 전에** `msg.threadKey = sessionId` 로 세팅(직렬 큐/`/stop` 정합)하고, 이
   * 필드로 route 에 정규화를 지시한다 — route 가 세션-정체성을 canonical `(http-bridge,
   * sessionId)` 로 read/write 하고 `setSessionChannelMeta` 로 실채널·주소를 캡처한다.
   *
   * 미지정(스케줄러·매니저 재주입·서브에이전트·file-watch·엔드포인트 등 내부 파생 turn)
   * = 현행 passthrough(회귀 0). **어떤 어댑터도 이 값을 읽지 않는다**(순수 세션 라우팅
   * 메타, `channelAddress`·`synthetic`·`correlationId` 계열의 LLM-agnostic 중립 필드).
   * shape 는 `route()` opts.session 과 동일(daemon handler 가 그대로 forward). additive.
   */
  session?: { explicitSessionId?: string; channelAddress?: string };
  /**
   * 이 턴의 응답을 **인입 채널에 더해** 함께 배달할 *추가* 채널들(additive fan-out, ADR
   * 2026-07-16 §D4 Phase B2) — swap 아님. 대시보드 컴포저 체크박스 → http-bridge
   * `body.outboundChannels`. daemon handler 는 route() 후 인입 채널로 **항상** 답(현행 그대로)한
   * 다음, 이 목록의 각 채널(인입과 다르고 outbound-capable = 레지스트리 등록 + defaultOutboundTarget
   * 표명)에 대해 `deliverOutbound` 로 추가 배달한다("이 답도 텔레그램/슬랙에 보내"). 채널별 분기
   * 0(레지스트리 조회). push-to-telegram = 체크박스에 telegram 을 켠 인스턴스.
   *
   * 미지정/빈 배열(현행 모든 인입·슬래시·매니저·스케줄) = 인입 채널만(회귀 0, 코드경로 바이트 동일).
   * **어떤 어댑터도 이 값을 읽지 않는다**(순수 배달 라우팅 메타, `channelAddress`·`session`
   * 계열 LLM-agnostic 중립 필드). additive.
   */
  egressChannels?: string[];
  /**
   * **이 발화는 다른 채널로 복사하지 않는다** (2026-09-02).
   *
   * ★egress 는 «서버 설정 ∪ 메시지가 실어온 것» 이라, 설정에 telegram 이 있으면 프로그램이
   *  띄운 턴까지 전부 사용자 폰으로 간다 — 끌 방법이 없었다.
   * ★**한 방향만** 연다: 이 값은 «덜 보낸다» 만 할 수 있고, 없는 채널을 켜지는 못한다.
   *  자동 판정(세션 이름으로 «기계» 를 가려내기)은 안 한다 — 손목록이고, 스케줄 실패
   *  알림처럼 **정말 가야 하는 것**을 조용히 막을 수 있다. 보내는 쪽이 자기 의도를 안다.
   */
  noEgress?: boolean;
  /**
   * 이 메시지의 `reply` 가 **실제로 배달되는 좌표** — egress fan-out 중복 차단용 (2026-08-25).
   *
   * ★왜 필요한가: fan-out 은 종전에 `채널 이름`으로 중복을 걸렀다(`ch === input.channel`).
   *  보통은 그게 맞다 — 대시보드로 들어온 메시지는 대시보드로 답하니 이름이 곧 배달지다.
   *  그런데 **매니저 완료 재주입**은 다르다: `channel` 은 잡을 띄운 채널(`scheduler`)인데
   *  `reply` 는 잡의 목적지(telegram)로 나간다. 이름이 안 겹치니 가드가 안 걸리고 같은
   *  본문이 텔레그램으로 **두 번** 갔다(2026-08-25 실측: 08:11:29 · 08:11:31, 4,562자 동일).
   *
   * ★그래서 이름 대신 **좌표**를 준다. 미지정이면 종전 동작 그대로(회귀 0) — 일반 인입은
   *  이름 비교로 충분하므로 채널들이 이 필드를 채울 필요가 없다.
   */
  replyTarget?: { channel: string; target: string | null };
  text: string;
  /**
   * 답글(reply) 원문 — 채널이 reply_to 메시지의 텍스트를 실으면 핸들러가 프롬프트에
   * 인용 주입(LLM-agnostic 단일 지점, 양 어댑터 동일). 미설정 = 답글 아님/미지원 채널
   * (cli·http-bridge). additive — 회귀 0.
   */
  replyToText?: string;
  /** 신규 additive — 미지정/빈 배열 = 현행 text-only 경로 (회귀 0). */
  attachments?: Attachment[];
  /**
   * 내부 기원 합성 turn 표식(additive) — 매니저 done 재주입(buildCompletionPrompt) 등
   * *사용자가 보낸 게 아닌* turn. 미지정/false = 실제 인바운드(현행 동작, 회귀 0).
   * 핸들러는 이 플래그일 때 `channel.message.in` 관측 발행을 스킵한다 — 내부 스캐폴딩
   * 텍스트가 대시보드에 "나(user)" 메시지로 새는 걸 막는다. 라우팅·발송·직렬화 등
   * 나머지 처리는 실 인바운드와 동일(관측 발행만 억제). 직렬화/resume 무영향.
   */
  synthetic?: boolean;
  /**
   * 클라 부여 상관 id(additive 중립 필드) — 대기 중(큐) 메시지 취소용 식별 키
   * (ADR 2026-07-15). 클라가 전송 순간 `crypto.randomUUID()` 로 만들어 (a) 낙관적 버블,
   * (b) POST body, (c) 취소 요청을 하나로 묶는다. **어떤 어댑터도 이 값을 읽지 않는다**
   * (순수 큐/전송 상관용, LLM-agnostic — `synthetic`·`replyToText` 계열). 실제 사용자
   * 인바운드만 채운다 — 합성 turn(synthetic)·슬래시·스케줄·매니저 재주입은 미부여
   * (취소 대상 아님). 미지정 = 현행 동작(익명 큐 항목, 회귀 0).
   */
  correlationId?: string;
  receivedAt: number;
  reply: (text: string, opts?: ReplyOptions) => Promise<void>;
  /** 아웃바운드 첨부 전송 — 채널이 지원하면 구현(telegram), 미지원이면 undefined.
   *  멱등은 호출자(send_file 도구)가 per-turn dedup 으로 보장. 채널은 1회 전송만 담당. */
  sendAttachment?: (filePath: string, opts?: { caption?: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 객관식 선택지 제시(축1, 클로드코드 AskUserQuestion 동형) — 채널이 지원하면 구현
   * (telegram inline keyboard / 대시보드 버튼 / cli 번호목록), 미지원이면 undefined.
   * sendAttachment 동형 — 추상 의도만(채널 raw 절대 여기 안 옴). prompt_options MCP
   * 도구가 호출. additive — 미지정 = 현행 text-only(회귀 0).
   *
   * ★비차단: 선택지를 *렌더/전송*하고 즉시 반환한다. 답을 기다리지 않는다 —
   * 사용자의 선택은 *다음 인바운드 메시지*(버튼 클릭/번호 타이핑 = 새 IncomingMessage)
   * 로 따로 도착한다. 채널은 "보기를 띄우고 곧장 ok 반환"만 구현하면 된다.
   * 답을 받아야 하면 LLM 이 이 호출 뒤 턴을 마치고, 다음 사용자 메시지에서 이어간다.
   *
   * 채널 구현 1줄 계약: presentOptions 는 question + options(label/value)를 *채널 UX*
   * (버튼·번호 등)로 1회 렌더하고 즉시 `{ok:true}` 반환. 사용자 선택값은 채널이
   * value 를 *다음 인바운드 메시지의 text* 로 흘려보낸다(텔레그램 callback → POST /
   * 대시보드 버튼 클릭 → POST /messages 와 동형). 렌더 실패 시 `{ok:false, error}`.
   */
  presentOptions?: (
    question: string,
    options: { label: string; value: string }[],
    opts?: { note?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface Channel {
  readonly name: ChannelName;
  /**
   * 채널 가용성 자기선언(additive, D1(b) 2026-07-18) — 채널이 자기 presence 상태를
   * 선언한다. 미지정 = "up"(하위호환·회귀 0, cli·http-bridge 등 기존 채널 무수정).
   * presence 루프가 `c.status ?? "up"` 으로 범용 조회 → 특정 채널명 하드코딩 불필요(§0).
   * telegram: 토큰 있으면 "up"·폴링, 없으면 "disabled"·self-disable(목록엔 균일 표시).
   */
  status?: "up" | "disabled";
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  /**
   * 아웃바운드 능력(additive, ADR 2026-07-16 §D3) — 채널이 능동/직접 발신을 지원하면 구현.
   * 부팅 채널 로딩 때 코어 outbound 레지스트리에 등록(deliverOutbound 가 조회). 미구현 =
   * 관측-전용(http-bridge) or unsupported(현행). 3어댑터 parity: telegram=send/owner,
   * cli=console/null, http-bridge=관측전용/null.
   */
  outbound?: ChannelOutbound;
}
