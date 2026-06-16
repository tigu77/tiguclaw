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
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface Channel {
  readonly name: ChannelName;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
