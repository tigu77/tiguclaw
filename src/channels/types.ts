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
}

export interface IncomingMessage {
  channel: ChannelName;
  channelUserId: string;
  threadKey: string;
  text: string;
  /**
   * 답글(reply) 원문 — 채널이 reply_to 메시지의 텍스트를 실으면 핸들러가 프롬프트에
   * 인용 주입(LLM-agnostic 단일 지점, 양 어댑터 동일). 미설정 = 답글 아님/미지원 채널
   * (cli·http-bridge). additive — 회귀 0.
   */
  replyToText?: string;
  /** 신규 additive — 미지정/빈 배열 = 현행 text-only 경로 (회귀 0). */
  attachments?: Attachment[];
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
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
