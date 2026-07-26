import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import { telegramFormat, splitHtmlForTelegram } from "telegram-markdown-formatter";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Attachment,
  AttachmentKind,
  Channel,
  IncomingMessage,
  MessageHandler,
  ReplyOptions,
} from "../../src/channels/types.js";
import type { ChannelOutbound } from "../../src/core/channel-outbound.js";
import { getPaths } from "../../src/core/paths.js";
import { getAllCommands } from "../../src/core/entry/command-registry.js";
import { getEventBus } from "../../src/core/eventbus.js";
import { resolveSessionId } from "../../src/core/threadkey.js";
import { getMostRecentTelegramChatId } from "../../src/store/sessions.js";

// 텔레그램 bot getFile 다운로드 한도 (20MB). 초과 시 다운로드 생략 + 명시 안내.
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

// ─── 텔레그램 발송 공통 흐름 ──────────────────────────────────────────────
// contract §3: Markdown → Telegram HTML subset 변환 → 청크별 송신 → 실패 시 plain 1회 폴백.
// message:text reply·attachment reply·edited reply·sendOutgoing 4곳이 이 흐름을 공유한다.
// 발송 함수(ctx.reply vs bot.api.sendMessage)와 옵션만 다르므로 여기 하나로 모은다.
//
// ★HTML 채택 근거(2026-07-23): 텔레그램 HTML 은 `< > &` 3글자만 이스케이프하면 되고 표·긴
// 메시지에도 크래시가 없다. MarkdownV2(telegramify)는 18개 예약문자를 문맥마다 이스케이프해야
// 해 표 셀 하이픈(`\\-`) 등에서 parse 400 → plain 폴백으로 포맷을 통째로 잃었다(라이브 실사고).
interface TgSendExtra {
  parse_mode?: "HTML";
  reply_parameters?: { message_id: number };
}
type TgSend = (chunk: string, extra: TgSendExtra) => Promise<unknown>;

// telegramFormat output 은 Telegram HTML subset(<b>·<code>·<a> 등)이다. HTML parse 실패
// fallback 에서는 parse_mode 없이 보낼 plain text 가 필요하므로 태그를 제거·언이스케이프한다.
// ★원래 태그 노출 버그(2026-07): 실패 시 raw HTML 을 그대로 보내 <b> 등이 노출됐다 — 폴백에서
// 태그를 스트립해 재발을 막는다(라이브러리 교체가 아니라 폴백을 고치는 게 옳은 수정이었다).
const htmlToPlainText = (html: string): string =>
  html
    // 링크는 "텍스트 (url)" 로 살린다. 아래 태그 스트립에 `a` 도 포함해, 이 규칙이 못 잡은
    // 비표준 <a>(href 없음 등)의 잔여 태그까지 반드시 제거(태그 노출 재발 안전망).
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(
      /<\/?(?:a|b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler|span)[^>]*>/gi,
      "",
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// Markdown → Telegram HTML subset 변환 + 4096 분할(라이브러리가 태그 경계 보존).
const formatForTelegram = (text: string): { chunks: string[]; parseMode?: "HTML" } => ({
  chunks: splitHtmlForTelegram(telegramFormat(text)),
  parseMode: "HTML",
});

// ─── transport(HttpError) 재시도 ─────────────────────────────────────────
// 실 버그(2026-07): 새벽 스케줄 outbound 가 grammy HttpError("Network request … failed")
// 로 실패 → 재시도 없어 알림 유실(schedules.last_error). 맥 sleep 아님·폴링 생존 =
// 순간 transport 실패(유휴 커넥션 노화 추정). 재연결이면 곧 복구되므로 바운드 재시도한다.
//
// ★재시도 대상 = **일시적 실패**만. 영구/논리 실패는 즉시 전파해 호출부 폴백에 맡긴다:
//   - HttpError = 네트워크/전송 계층 실패 → 재연결로 복구 가능 → 재시도.
//   - GrammyError **5xx**(502 Bad Gateway 등) = 텔레그램 **서버측 일시 장애** → 재시도.
//     ★2026-07-26 실측 버그: 종전엔 GrammyError 를 전부 "논리 에러"로 보고 재시도에서
//     제외했는데, grammy 는 502 도 GrammyError 로 던진다(error.js:47 `Call to '<m>' failed!`
//     + error_code=502). 그래서 아침 스케줄 알림 2건(뉴스 브리핑 5661자·GA 리포트 2056자)이
//     **재시도 한 번 없이** 버려졌다 — 내용은 transcripts 에 남았는데 사용자에겐 미도달.
//   - GrammyError **4xx**(400 parse HTML 실패·403 forbidden 등) = 같은 요청 재전송해도
//     동일 실패 → 재시도 무의미. 즉시 전파해서 호출부의 HTML→plain 폴백이 처리하게 둔다.
// sendMessage 는 멱등이 아니라 재시도 시 드문 중복 가능하나, 알림은 "드문 중복 > 유실"
// 이므로 재시도 채택. 추가 dedup 장치는 두지 않는다(과설계 회피 — 중복은 감수).
const isRetriableSendError = (e: unknown): boolean => {
  if (e instanceof HttpError) return true;
  // 5xx = 서버측 일시 장애(502/503/504…). 4xx(논리 오류)는 재시도 안 함.
  if (e instanceof GrammyError) return e.error_code >= 500;
  return false;
};

// 재시도 예산 2종 — **호출 성격에 따라 다르다**:
//  - 대화형(답글·첨부·수정): 사용자가 기다리므로 짧게(총 ~5s). 늦은 답보다 빠른 실패가 낫다.
//  - 아웃바운드 알림(scheduler 등 fire-and-forget): 아무도 안 기다리므로 길게(총 ~80s).
//    실측 502 장애가 분 단위였다 — 5s 창으론 못 넘긴다. 유실이 지연보다 훨씬 나쁘다.
const TRANSPORT_RETRY_DELAYS_MS = [500, 1500, 3000];
const OUTBOUND_RETRY_DELAYS_MS = [500, 1500, 3000, 15_000, 60_000];

export const sendWithTransportRetry = async (
  send: TgSend,
  chunk: string,
  extra: TgSendExtra,
  delays: readonly number[] = TRANSPORT_RETRY_DELAYS_MS,
): Promise<unknown> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(chunk, extra);
    } catch (e) {
      // 일시적 실패만, 그리고 바운드 내에서만 재시도. 그 외는 즉시 전파.
      if (!isRetriableSendError(e) || attempt >= delays.length) throw e;
      const delay = delays[attempt]!;
      console.warn(
        `telegram send failed (일시적 — ${e instanceof GrammyError ? `API ${e.error_code}` : "transport"}), ` +
          `retry ${attempt + 1}/${delays.length} in ${delay}ms:`,
        e,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

// text 를 변환·분할해 청크별로 send 한다. replyToMessageId 있으면 *첫 청크만* 답글로
// (멀티청크 시각잡음 회피). throwOnFail 이면 plain 폴백까지 실패 시 rethrow(발신 실패를
// 호출자가 알아야 하는 sendOutgoing 용); 아니면 로그만(답글은 부수 UX).
// send 는 sendWithTransportRetry 로 감싸므로 여기 하나로 4곳(reply·attachment·edited·
// sendOutgoing) 발송 경로 전부가 transport 재시도를 얻는다.
export const sendFormatted = async (
  send: TgSend,
  text: string,
  opts?: { replyToMessageId?: number; throwOnFail?: boolean; retryDelays?: readonly number[] },
): Promise<void> => {
  const { chunks, parseMode } = formatForTelegram(text);
  for (let i = 0; i < chunks.length; i++) {
    const extra: TgSendExtra = {
      ...(parseMode !== undefined ? { parse_mode: parseMode } : {}),
      ...(opts?.replyToMessageId !== undefined && i === 0
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {}),
    };
    try {
      await sendWithTransportRetry(send, chunks[i]!, extra, opts?.retryDelays);
    } catch (e) {
      // HTML 실패(주로 Telegram parse error) → plain 폴백. ★태그를 스트립해 보낸다(raw HTML
      // 그대로 보내면 <b> 등이 노출됨 = 원래 버그). transport 실패였다면 여기 도달 시점엔 이미
      // 재시도가 소진된 상태이나, plain 폴백도 한 번 더 재시도해 본다.
      console.error("telegram formatted send failed, falling back to plain:", e);
      await sendWithTransportRetry(send, htmlToPlainText(chunks[i]!), {}, TRANSPORT_RETRY_DELAYS_MS).catch((e2) => {
        console.error("telegram plain fallback also failed:", e2);
        if (opts?.throwOnFail === true) throw e2;
      });
    }
  }
};

// ─── 축1 선택지(inline keyboard) callback_data 맵 ─────────────────────────
// 텔레그램 callback_data 는 64바이트 제한 — 긴 value(보기 값)를 직접 실으면 잘리거나
// 전송이 실패한다. 그래서 presentOptions 가 보기를 띄울 때 value 를 *맵에 저장*하고
// 짧은 id(`o<n>`)만 callback_data 에 싣는다. 사용자가 버튼을 누르면 callback_query
// 핸들러가 id→value 를 복원해 *일반 인바운드 메시지처럼* router 로 흘려보낸다.
//
// 누수 방지: 전역 LRU(삽입순 Map) 로 총 항목 수를 cap. cap 초과 시 가장 오래된 항목부터
// 제거(per-chat 격리 대신 단순 전역 cap — 작고 견고). id 는 단조 증가 카운터로 충돌 0.
const PROMPT_OPTION_CAP = 500;
const promptOptionMap = new Map<string, string>();
let promptOptionSeq = 0;
const storePromptOption = (value: string): string => {
  const id = `o${(promptOptionSeq++).toString(36)}`;
  promptOptionMap.set(id, value);
  while (promptOptionMap.size > PROMPT_OPTION_CAP) {
    const oldest = promptOptionMap.keys().next().value;
    if (oldest === undefined) break;
    promptOptionMap.delete(oldest);
  }
  return id;
};

// IANA mime → 확장자 최소 매핑 (mime 우선, 없으면 file_path 확장자, 둘 다 없으면 "bin").
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "text/plain": "txt",
};

const pickExt = (mime: string | undefined, filePath: string | undefined): string => {
  if (mime !== undefined && MIME_EXT[mime] !== undefined) return MIME_EXT[mime];
  if (filePath !== undefined) {
    const e = path.extname(filePath).replace(/^\./, "").toLowerCase();
    if (e !== "") return e;
  }
  return "bin";
};

// 축1 presentOptions 본체(ctx 클로저) — question + options 를 inline keyboard 로 1회
// 렌더하고 즉시 반환(비차단). 각 보기의 value 는 promptOptionMap 에 저장하고 짧은 id 만
// callback_data 로 싣는다(64바이트 제한 회피). note 가 있으면 질문 아래 덧붙인다. 렌더
// 실패(텔레그램 API 등)는 {ok:false,error} — MCP 도구가 재시도/텍스트 폴백 판단.
const buildPresentOptions =
  (ctx: Context): NonNullable<IncomingMessage["presentOptions"]> =>
  async (question, options, opts) => {
    try {
      const inline_keyboard = options.map((o) => [
        { text: o.label, callback_data: storePromptOption(o.value) },
      ]);
      const prompt =
        opts?.note !== undefined && opts.note.trim() !== ""
          ? `${question}\n\n${opts.note}`
          : question;
      await ctx.reply(prompt, { reply_markup: { inline_keyboard } });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  };

const yyyymmdd = (epochSeconds: number): string => {
  const d = new Date(epochSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
};

interface RawFileRef {
  fileId: string;
  fileUniqueId: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

/** ctx.message 에서 첫 첨부의 raw 참조 + 중립 kind 추출 (photo 는 최대 해상도 1장). */
const extractFileRef = (
  ctx: Context,
): { ref: RawFileRef; kind: AttachmentKind } | null => {
  const m = ctx.message;
  if (m === undefined) return null;
  if (m.photo !== undefined && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    return {
      kind: "image",
      ref: {
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
        mimeType: "image/jpeg", // telegram photo 는 항상 jpeg
        fileSize: largest.file_size,
      },
    };
  }
  if (m.document !== undefined) {
    const d = m.document;
    const kind: AttachmentKind = d.mime_type?.startsWith("image/") === true
      ? "image"
      : "document";
    return {
      kind,
      ref: {
        fileId: d.file_id,
        fileUniqueId: d.file_unique_id,
        mimeType: d.mime_type,
        fileName: d.file_name,
        fileSize: d.file_size,
      },
    };
  }
  if (m.voice !== undefined) {
    const v = m.voice;
    return {
      kind: "voice",
      ref: {
        fileId: v.file_id,
        fileUniqueId: v.file_unique_id,
        mimeType: v.mime_type,
        fileSize: v.file_size,
      },
    };
  }
  if (m.audio !== undefined) {
    const a = m.audio;
    return {
      kind: "audio",
      ref: {
        fileId: a.file_id,
        fileUniqueId: a.file_unique_id,
        mimeType: a.mime_type,
        fileName: a.file_name,
        fileSize: a.file_size,
      },
    };
  }
  if (m.video !== undefined) {
    const vid = m.video;
    return {
      kind: "video",
      ref: {
        fileId: vid.file_id,
        fileUniqueId: vid.file_unique_id,
        mimeType: vid.mime_type,
        fileName: vid.file_name,
        fileSize: vid.file_size,
      },
    };
  }
  return null;
};

/**
 * 첨부 다운로드 결과 — 성공 시 Attachment, 실패/초과 시 사용자 안내 노트.
 * 조용한 실패 금지 (원칙 3 + contract §Q2): note 가 있으면 IncomingMessage.text 에 주입.
 */
interface AcquireResult {
  attachment?: Attachment;
  note?: string;
}

const humanSize = (bytes: number | undefined): string => {
  if (bytes === undefined) return "크기 불명";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
};

const acquireAttachment = async (
  ctx: Context,
  token: string,
  channel: string,
  receivedAtSeconds: number,
): Promise<AcquireResult> => {
  const picked = extractFileRef(ctx);
  if (picked === null) return {};
  const { ref, kind } = picked;
  const displayName = ref.fileName ?? `${kind}.${pickExt(ref.mimeType, undefined)}`;

  // 크기 상한 — getFile 전에 알 수 있으면 (file_size) 즉시 차단.
  if (ref.fileSize !== undefined && ref.fileSize > ATTACHMENT_MAX_BYTES) {
    return {
      note: `[첨부 파일이 너무 큼: ${displayName} (${humanSize(ref.fileSize)}) — 처리 생략]`,
    };
  }

  try {
    const file = await ctx.api.getFile(ref.fileId);
    const filePath = file.file_path;
    if (filePath === undefined) {
      return { note: `[첨부 다운로드 실패: ${displayName} (file_path 없음)]` };
    }
    // getFile 가 보고한 크기로 2차 가드.
    if (file.file_size !== undefined && file.file_size > ATTACHMENT_MAX_BYTES) {
      return {
        note: `[첨부 파일이 너무 큼: ${displayName} (${humanSize(file.file_size)}) — 처리 생략]`,
      };
    }

    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      return { note: `[첨부 다운로드 실패: ${displayName} (HTTP ${res.status})]` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
      return {
        note: `[첨부 파일이 너무 큼: ${displayName} (${humanSize(buf.byteLength)}) — 처리 생략]`,
      };
    }

    const mime = ref.mimeType ?? "application/octet-stream";
    const ext = pickExt(ref.mimeType, filePath);
    const dir = path.join(
      getPaths().attachmentsDir,
      channel,
      yyyymmdd(receivedAtSeconds),
    );
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, `${ref.fileUniqueId}.${ext}`);
    await fs.writeFile(abs, buf);

    const attachment: Attachment = {
      kind,
      mimeType: mime,
      path: abs,
      filename: ref.fileName ?? path.basename(abs),
      bytes: buf.byteLength,
    };
    return { attachment };
  } catch (e) {
    console.error("telegram attachment download failed:", e);
    return { note: `[첨부 다운로드 실패: ${displayName}]` };
  }
};

// Markdown → Telegram HTML subset 변환 + 4096 분할.
// `telegram-markdown-formatter` 위임(원칙 6 "직접 만들 일 아님"). 파싱 실패 시 per-chunk
// plain 폴백이 태그를 스트립해 보낸다(htmlToPlainText).

// module-scope bot 인스턴스 — sendOutgoing 이 scheduler 등 outgoing 사용자 (region
// dispatcher) 에게서 직접 호출될 때 재사용. TelegramChannel.start 가 가장 먼저
// init/start 하므로 그 시점에 cached 가 채워진다.
let cachedBot: Bot | null = null;

// 소유자 식별 집합 파싱 — TELEGRAM_ALLOWED_USER_IDS(콤마 구분 user id). 빈 = 잠금.
// 다중 ID = 미래 ① 공유 팀 비서 seam (배포 계획서 §6 / docs/security.md).
const parseAllowedTelegramIds = (): Set<string> =>
  new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

export default class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  /**
   * presence 상태 자기선언(D1(b) §12.2) — 토큰 있으면 "up"(폴링), 없으면 "disabled"
   * (self-disable). 생성자에서 스냅샷(env 는 런타임 불변). 로더가 wrapper 로 forward.
   */
  readonly status: "up" | "disabled";
  /**
   * 아웃바운드 능력(ADR 2026-07-16 §D1/§D3) — 코어 레지스트리에 등록.
   *  - deliver = sendOutgoing(현행 switch telegram 케이스와 동일 함수). null/빈 target 은
   *    현행 그대로 throw("telegram target required") — 비트 동일 가드 이관.
   *  - defaultOutboundTarget = owner allowlist 첫 id → 폴백 getMostRecentTelegramChatId().
   *    (파싱 특수분기를 코어에서 채널 안으로 이관 = §D2/§D3 Phase 3 정합. 명시 target 이
   *    있는 현행 호출자는 이 함수를 타지 않음 → 현행 발송 경로 비트 동일.)
   *
   * ★정직성(§12.2): 무토큰(disabled)이면 undefined 로 두어 로더가 registerChannelOutbound
   * 를 건너뛰게 한다(canDeliver/hasDefaultTarget=false 로 정확 — 현행 무토큰=미등록과 동일).
   */
  readonly outbound?: ChannelOutbound;
  private bot: Bot | null = null;
  // EventBus 구독 해제 핸들 — start() 에서 commands.changed 구독, stop() 에서 해제(누수 0).
  private unsubscribeCommandsChanged: (() => void) | null = null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    // 무조건 로드 + self-disable(§12.2) — 생성자 throw 금지. 토큰 없으면 disabled 로
    // 인스턴스화만 하고(로더가 channels[] 등록 → presence 균일 표시) bot·outbound 미구성.
    if (token === undefined || token.trim() === "") {
      this.status = "disabled";
      return;
    }
    this.status = "up";
    this.bot = new Bot(token);
    cachedBot = this.bot;
    this.outbound = {
      deliver: async (target: string | null, text: string): Promise<void> => {
        if (target === null || target.trim() === "") {
          throw new Error("telegram target required (chatId)");
        }
        await sendOutgoing(target, text);
      },
      defaultOutboundTarget: (): string | null => {
        const owner = [...parseAllowedTelegramIds()][0];
        return owner ?? getMostRecentTelegramChatId();
      },
    };
  }

  async start(handler: MessageHandler): Promise<void> {
    const bot = this.bot;
    // self-disable(§12.2 / D2) — 무토큰이면 폴링 no-op return(grammy 미기동 → 409 hazard 0).
    if (bot === null) {
      console.warn(
        "telegram: TELEGRAM_BOT_TOKEN not set, channel disabled (폴링 미시작).",
      );
      return;
    }

    // 소유자 allowlist (자가호스트 보안 게이트 — 배포 계획서 Phase 0). 인터넷 노출은
    // 텔레그램 봇이 유일하므로 여기서 막는다. 빈 집합 = 잠금(아무도 통과 못 함).
    const allowedIds = parseAllowedTelegramIds();
    if (allowedIds.size === 0) {
      console.warn(
        "telegram: ⚠️ TELEGRAM_ALLOWED_USER_IDS 미설정 — 봇 잠김(모든 메시지 무시). " +
          ".env 에 소유자 텔레그램 user id 추가(콤마로 여러 명).",
      );
    } else {
      console.log(`telegram: allowlist 활성 (${allowedIds.size} ID)`);
    }
    const isAllowed = (ctx: Context): boolean => {
      const id = ctx.from === undefined ? undefined : String(ctx.from.id);
      if (id !== undefined && allowedIds.has(id)) return true;
      console.warn(
        `telegram: 차단된 접근 무시 — user=${id ?? "unknown"} (allowlist 외)`,
      );
      return false;
    };

    bot.on("message:text", async (ctx) => {
      if (!isAllowed(ctx)) return;
      const text = ctx.message.text.trim();
      if (text.length === 0) return;
      // 답글(reply) 원문 회수 — telegram 이 주는 reply_to_message 의 텍스트/캡션을
      // 중립 필드 replyToText 로 실어 핸들러가 인용 주입(LLM-agnostic). 텍스트 없는
      // 답글(사진 등)은 미설정(skip). 길이 캡 1500 — 장문 원문 bloat 방지.
      const repliedRaw = (
        ctx.message.reply_to_message?.text ??
        ctx.message.reply_to_message?.caption ??
        ""
      ).trim();
      const replyToText =
        repliedRaw.length === 0
          ? undefined
          : repliedRaw.length > 1500
            ? `${repliedRaw.slice(0, 1500)}…(이하 생략)`
            : repliedRaw;
      // 채널/세션 분리(ADR 2026-07-15) — 텔레그램은 세션 셀렉터 없음 → 기본 세션(DEFAULT).
      // chatId 는 세션 정체성이 아니라 **배달 좌표**(channelAddress)로만 운반한다. resolveSessionId
      // 로 sessionId 를 구해 threadKey 에 세팅(직렬 큐/`/stop` 정합)하고, session 을 실어 route 가
      // canonical (http-bridge, DEFAULT) 로 세션-정체성을 정규화 + last_channel/target 캡처하게
      // 한다 → 텔레그램 대화가 대시보드 기본 세션과 한 대화로 합류. 즉시 답글(reply)은 여전히
      // ctx 클로저로 텔레그램 직접(세션 무관).
      const chatId = String(ctx.chat.id);
      const sessionId = resolveSessionId("telegram", chatId);
      const msg: IncomingMessage = {
        channel: "telegram",
        channelUserId: ctx.from === undefined ? "unknown" : String(ctx.from.id),
        threadKey: sessionId,
        channelAddress: chatId,
        session: { channelAddress: chatId },
        text,
        ...(replyToText !== undefined ? { replyToText } : {}),
        receivedAt: ctx.message.date * 1000,
        reply: async (out: string, opts?: ReplyOptions): Promise<void> => {
          await sendFormatted((chunk, extra) => ctx.reply(chunk, extra), out, {
            replyToMessageId:
              opts?.replyToTrigger === true
                ? ctx.message.message_id
                : undefined,
          });
        },
        // 아웃바운드 첨부 — send_file 도구가 호출. 토큰은 grammY 내부라 노출 0.
        // 멱등은 호출자(도구)가 보장; 채널은 1회 전송만. 실패(파일 없음/접근불가 등)는
        // catch 로 {ok:false,error} 반환.
        sendAttachment: async (filePath, opts) => {
          try {
            await ctx.api.sendDocument(
              ctx.chat.id,
              new InputFile(filePath),
              opts?.caption !== undefined ? { caption: opts.caption } : undefined,
            );
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        },
        // 축1 선택지 제시 — inline keyboard 로 1회 렌더 후 즉시 반환(비차단). 사용자 선택은
        // callback_query 핸들러가 *다음 인바운드*로 흘려보낸다(같은 chat=같은 thread·인격).
        presentOptions: buildPresentOptions(ctx),
      };
      // 텔레그램 "입력 중…" 표시. 한 번 보내면 5 초 유지 → 4 초 간격 갱신.
      // 응답 지연 동안 사용자가 비서가 살아있다는 신호를 받는다.
      void ctx.replyWithChatAction("typing").catch(() => {});
      const heartbeat = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      // ── 비차단 발사 (CLI cli.ts:36 동형) ──────────────────────────────────
      // 폴러는 턴을 *기다리지 않는다*. `await handler(msg)` 로 직렬화하면 한 턴이
      // 안 끝날 때 grammy 순차 폴러가 동결 → 채널 전체(모든 대화) 무응답 (a05c368
      // 11h outage 의 구조적 원인). 발사만 하고 즉시 다음 update 로 넘어가면, 긴/hung
      // 턴은 그 thread(대화)만 막고 채널·다른 thread 는 정상. thread별 순서는
      // serializedHandler(enqueueThreadTurn)가 보장하므로 같은 대화 내 순서·typing 정상.
      //
      // typing heartbeat 는 `await ... finally` 가 아니라 **턴 Promise 에 재배선** —
      // 폴러가 p 를 await 안 해도 typing 은 턴 진행 동안 살아있고 settle 시 정확히 멈춘다
      // (누수 0). handler 에러는 .catch 로 흡수 — 폴러 루프(unhandled rejection)를
      // 죽이지 않게(cli.ts 동형). 버려진 promise·LLM 연결이 hung thread 에 묶이는 건
      // 허용(사용자 원칙: turn-abandon ≫ daemon-freeze), heartbeat clear 만 보장.
      void handler(msg)
        .catch((e) => {
          console.error("telegram handler error:", e);
        })
        .finally(() => {
          clearInterval(heartbeat);
        });
    });

    // 첨부 핸들러 (사진/문서/음성/오디오/영상). message:text 와 병렬·독립.
    // text update 는 위 핸들러가, 첨부 update 는 이 핸들러가 처리 (filter query 가 분리).
    // 첨부는 다운로드 → <home>/data/attachments/ 저장 → Attachment[] → handler 전달.
    // caption 은 IncomingMessage.text 의 진실 소스 (Attachment.caption 은 V1 미사용).
    bot.on(
      ["message:photo", "message:document", "message:voice", "message:audio", "message:video"],
      async (ctx) => {
        if (!isAllowed(ctx)) return;
        const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
        const receivedAtSeconds = ctx.message.date;
        const triggerId = ctx.message.message_id;

        const buildReply =
          () =>
          async (out: string, opts?: ReplyOptions): Promise<void> => {
            await sendFormatted((chunk, extra) => ctx.reply(chunk, extra), out, {
              replyToMessageId:
                opts?.replyToTrigger === true ? triggerId : undefined,
            });
          };

        // typing heartbeat — 다운로드+영역 A 처리 동안 살아있음 신호.
        void ctx.replyWithChatAction("typing").catch(() => {});
        const heartbeat = setInterval(() => {
          void ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        // 다운로드(acquireAttachment)는 await 유지 — 첨부 데이터가 handler 입력에 필요해
        // 발사 전 완료돼야 한다. 다운로드는 보통 짧음. (다운로드 자체 비차단화는 별건 — 본
        // P0 핵심은 "턴 발사 비차단".) 다운로드 I/O 실패는 acquireAttachment 가 acquired.note
        // 로 흡수하므로 여기 throw 면 아래 catch 가 잡고 finally 가 heartbeat clear.
        try {
          const caption = ctx.message.caption?.trim() ?? "";
          const acquired = await acquireAttachment(ctx, token, "telegram", receivedAtSeconds);

          // text 조립: caption(있으면) + 다운로드 실패/초과 안내 노트(있으면).
          const parts: string[] = [];
          if (caption.length > 0) parts.push(caption);
          if (acquired.note !== undefined) parts.push(acquired.note);
          const text = parts.join("\n\n");

          const attachments =
            acquired.attachment !== undefined ? [acquired.attachment] : undefined;

          // text·attachments 둘 다 비면 drop (message:text 의 빈 텍스트 가드 정합 확장).
          // ★ handler 발사 *전* early-return 이라 아래 비차단 .finally(clearInterval) 이
          // 안 걸린다 — 여기서 명시 clear 안 하면 heartbeat 누수(QA P0 지적). text 핸들러엔
          // 없던 분기(첨부 전용)라 별도 가드 필요.
          if (text.length === 0 && attachments === undefined) {
            clearInterval(heartbeat);
            return;
          }

          // 채널/세션 분리(ADR 2026-07-15) — message:text 핸들러와 동형(parity). chatId=배달
          // 좌표, sessionId=기본 세션. threadKey=sessionId + session 으로 route 정규화.
          const chatId = String(ctx.chat.id);
          const sessionId = resolveSessionId("telegram", chatId);
          const msg: IncomingMessage = {
            channel: "telegram",
            channelUserId: ctx.from === undefined ? "unknown" : String(ctx.from.id),
            threadKey: sessionId,
            channelAddress: chatId,
            session: { channelAddress: chatId },
            text,
            attachments,
            receivedAt: receivedAtSeconds * 1000,
            reply: buildReply(),
            // 아웃바운드 첨부 — message:text 핸들러와 동일 (parity). 토큰 노출 0.
            sendAttachment: async (filePath, opts) => {
              try {
                await ctx.api.sendDocument(
                  ctx.chat.id,
                  new InputFile(filePath),
                  opts?.caption !== undefined ? { caption: opts.caption } : undefined,
                );
                return { ok: true };
              } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
              }
            },
            // 축1 선택지 제시 — message:text 핸들러와 동일(parity). inline keyboard 1회 렌더.
            presentOptions: buildPresentOptions(ctx),
          };
          // ── 비차단 발사 (text 핸들러·cli.ts 동형) ─────────────────────────
          // 폴러는 턴을 *기다리지 않는다*. await handler 로 직렬화하면 사진+긴 캡션 한 턴이
          // settle 까지 grammy 순차 폴러를 동결 → 채널 전체 무응답(11h outage 재발 경로,
          // blast radius=채널 전체). 발사만 하고 즉시 반환하면 hung 턴은 그 thread 큐에만
          // 격리되고 채널·다른 thread 는 정상. thread별 순서는 serializedHandler
          // (enqueueThreadTurn)가 보장. heartbeat 는 턴 Promise.finally 에 재배선 — 폴러가
          // await 안 해도 typing 은 턴 진행 동안 살아있고 settle 시 정확히 clear(누수 0).
          // handler 에러는 .catch 로 흡수 — 폴러 루프(unhandled rejection) 안 죽게.
          void handler(msg)
            .catch((e) => {
              console.error("telegram attachment handler error:", e);
            })
            .finally(() => {
              clearInterval(heartbeat);
            });
        } catch (e) {
          // 발사 *전* 동기/다운로드(acquireAttachment) 경로 throw 만 여기 도달. 비차단 발사
          // 이후엔 turn 에러가 위 .catch 로 흡수되므로 이 catch 로 오지 않는다. 발사 전
          // throw 면 heartbeat 가 아직 도는 상태라 여기서 명시 clear 필요(위 early-return
          // 가드와 동일 이유 — finally 제거로 인한 누수 차단).
          console.error("telegram attachment acquire error:", e);
          clearInterval(heartbeat);
        }
      },
    );

    // 축1 선택지 클릭 핸들러 — 사용자가 inline keyboard 보기를 누르면 도착. answerCallbackQuery
    // 로 버튼 로딩을 해제하고, callback_data(id)→value 를 복원해 *일반 인바운드 메시지처럼*
    // router 로 흘려보낸다(같은 chat=같은 thread·인격 — 새 세션/분기 0). 이는 message:text
    // 핸들러가 텍스트를 router 로 보내는 경로와 동형(비차단 발사 + heartbeat 재배선).
    bot.on("callback_query:data", async (ctx) => {
      if (!isAllowed(ctx)) {
        // 차단된 사용자에게도 로딩은 풀어줘야 버튼이 영원히 도는 걸 막는다.
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const id = ctx.callbackQuery.data;
      const value = promptOptionMap.get(id);
      // 로딩 해제(선택값 미복원이어도 먼저). 만료/재시작으로 맵에 없으면 안내 후 종료.
      await ctx.answerCallbackQuery().catch(() => {});
      if (value === undefined) {
        await ctx
          .reply("이 선택지는 만료되었습니다. 다시 시도해 주세요.")
          .catch(() => {});
        return;
      }
      // 1회용 — 복원 즉시 제거(중복 클릭 = 중복 메시지 방지 + 맵 위생).
      promptOptionMap.delete(id);
      const chat = ctx.chat;
      if (chat === undefined) return; // 채팅 컨텍스트 없는 콜백(이론상) — 안전 종료.
      // 선택값을 사용자 발화로 에코(텍스트 흐름과 시각 정합). 부수 UX라 실패해도 무시.
      await ctx.reply(value).catch(() => {});
      // 채널/세션 분리(ADR 2026-07-15) — message:text 동형(parity). 선택지 클릭도 같은
      // 기본 세션으로 흘려보낸다(같은 chat=같은 세션·인격). chatId=배달 좌표.
      const chatId = String(chat.id);
      const sessionId = resolveSessionId("telegram", chatId);
      const msg: IncomingMessage = {
        channel: "telegram",
        channelUserId: ctx.from === undefined ? "unknown" : String(ctx.from.id),
        threadKey: sessionId,
        channelAddress: chatId,
        session: { channelAddress: chatId },
        text: value,
        receivedAt: Date.now(),
        // 답글 송신 — 공통 흐름(이 경로는 답글 대상 미부착).
        reply: async (out: string, _opts?: ReplyOptions): Promise<void> => {
          await sendFormatted((chunk, extra) => ctx.reply(chunk, extra), out);
        },
        // 아웃바운드 첨부·후속 선택지 — 같은 chat 컨텍스트라 message:text 와 동일하게 지원.
        sendAttachment: async (filePath, opts) => {
          try {
            await ctx.api.sendDocument(
              chat.id,
              new InputFile(filePath),
              opts?.caption !== undefined ? { caption: opts.caption } : undefined,
            );
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        },
        presentOptions: buildPresentOptions(ctx),
      };
      // typing heartbeat — 선택 후 후속 턴 동안 살아있음 신호. message:text 동형.
      void ctx.replyWithChatAction("typing").catch(() => {});
      const heartbeat = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      // 비차단 발사 — 폴러를 막지 않는다(message:text 동형). thread별 순서는 serializedHandler.
      void handler(msg)
        .catch((e) => {
          console.error("telegram callback handler error:", e);
        })
        .finally(() => {
          clearInterval(heartbeat);
        });
    });

    bot.catch((err) => {
      console.error("telegram polling error:", err.error);
    });

    // bot.start() 는 polling 동안 resolve 되지 않으므로 await 하지 않는다.
    // grammy 는 init 후 첫 getUpdates 가 시작되면 polling on. 안정 시점은
    // 별도 콜백 없이 init 완료로 본다.
    // ★부팅 hang 수정(2026-07-19) — bot.init()(getMe)·refreshMenu()(setMyCommands)는 텔레그램 API
    // 네트워크 호출이다. API 가 실패/지연하면 이 await 가 무한 대기해 *데몬 부팅 전체*(채널 presence
    // 등록·recoverInterruptedJobs·"daemon: ready" 등 이후 코드)가 멈췄다(실측: 로그가 여기서 정지,
    // /channels 빈 배열, ready 미도달). polling 루프(bot.start, 아래)만 가드돼 있고 init 은 무가드였다.
    // → 타임아웃 가드 + 비치명으로 부팅을 막지 않는다. polling 이 네트워크 회복 시 재시도하고, 채널은
    // 로드 상태(presence 균일)를 유지한다.
    const initTimeout = (p: Promise<unknown>, ms: number, label: string): Promise<unknown> =>
      Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} ${ms}ms 타임아웃`)), ms)),
      ]);
    try {
      await initTimeout(bot.init(), 8000, "telegram bot.init");
    } catch (e) {
      console.error(
        "telegram: bot.init 실패/타임아웃 — 부팅 계속(polling 이 회복 시 재시도)",
        e instanceof Error ? e.message : e,
      );
    }
    // 봇 명령 메뉴(setMyCommands) — 부수 UX. 부팅 블로킹 금지 → fire-and-forget(실패 무해).
    void this.refreshMenu().catch(() => {});

    // 런타임 명령 변경 즉시 반영 — region 도구(register_command/delete_command)가 성공 시
    // EventBus 에 commands.changed 를 publish. telegram 채널은 이를 구독해 setMyCommands 재설정
    // (재시작 불필요). 핸들러는 동기여야 하므로 async refreshMenu 는 void 로 fire-and-forget.
    this.unsubscribeCommandsChanged = getEventBus().subscribe((ev) => {
      if (ev.type === "commands.changed") void this.refreshMenu();
    });

    // polling 루프 에러는 데몬 전체를 죽이면 안 된다 (unhandled rejection 방지).
    // 특히 409 Conflict = 같은 봇을 다른 인스턴스가 폴링 중 — 명확히 경고하되
    // 데몬은 계속 가동(http-bridge·기타 채널 유지). grammy 는 일시적 네트워크
    // 에러는 내부 재시도하고, 여기 도달하는 건 폴링이 멈춘 치명적 에러다.
    bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      const e = err as { error_code?: number; description?: string } & Error;
      if (e?.error_code === 409) {
        console.error(
          "telegram: 409 Conflict — 같은 봇 토큰을 다른 tiguclaw 인스턴스가 " +
            "폴링 중입니다. 이 인스턴스의 텔레그램 폴링을 중단합니다(데몬은 계속 " +
            "가동). 중복 인스턴스를 끄거나, 인스턴스마다 다른 봇 토큰을 쓰세요.",
        );
      } else {
        console.error(
          "telegram: polling 종료 —",
          e?.description ?? e?.message ?? String(err),
        );
      }
    });
  }

  /**
   * 봇 명령 메뉴 재설정 — 빌트인 네이티브 명령 + 발견된 커스텀 명령(`<home>/commands/*.md`)
   * 병합 후 setMyCommands(*전체 교체*).
   *
   * 텔레그램 명령명 규칙(`^[a-z0-9_]{1,32}$`)을 어기면 호출 전체가 실패하므로 유효 이름만
   * 합친다 — 한글·하이픈 이름 커스텀 명령은 *동작은 하나* 메뉴엔 못 뜬다(텔레그램 제약).
   *
   * 부팅 시 1회 + commands.changed 이벤트마다 호출. bot 미시작/stop 후엔 no-op(가드). 메뉴는
   * 부수 UX 라 실패해도 catch 만(polling/핵심 흐름 무영향).
   */
  private async refreshMenu(): Promise<void> {
    const bot = this.bot;
    if (bot === null) return; // stop 후 잔여 이벤트 등 — 안전 no-op.
    // 명령 목록의 단일 canonical 소스 — 빌트인 + 발견 커스텀 병합(채널중립).
    // 여기서는 텔레그램 특수 변환만 잔류: (a) 이름 규칙 필터, (b) 이름 dedup(빌트인 우선),
    // (c) `{command, description}` 리네임, (d) 100개 slice.
    const all = await getAllCommands();
    const validTgName = /^[a-z0-9_]{1,32}$/;
    const seen = new Set<string>();
    const menuCommands: { command: string; description: string }[] = [];
    for (const c of all) {
      if (!validTgName.test(c.name) || seen.has(c.name)) continue;
      seen.add(c.name);
      menuCommands.push({
        command: c.name,
        description: (c.description || c.name).slice(0, 256),
      });
      if (menuCommands.length >= 100) break; // 텔레그램 최대 100개.
    }
    await bot.api.setMyCommands(menuCommands).catch((e) => {
      console.error("telegram setMyCommands failed:", e);
    });
  }

  async stop(): Promise<void> {
    // 구독 해제 먼저 — bot 정지 후 잔여 이벤트로 refreshMenu 호출 방지(누수 0).
    if (this.unsubscribeCommandsChanged !== null) {
      this.unsubscribeCommandsChanged();
      this.unsubscribeCommandsChanged = null;
    }
    if (this.bot !== null) {
      await this.bot.stop();
      if (cachedBot === this.bot) cachedBot = null;
      this.bot = null;
    }
  }
}

/**
 * scheduler 등 region dispatcher 가 직접 호출하는 outgoing API.
 * Channel 인터페이스 무수정 — 1 named export 만 추가.
 *
 * TelegramChannel 미부팅 (TELEGRAM_BOT_TOKEN 미설정) 시 throw — 호출자는 dispatch
 * 실패로 schedule.last_error 적재 (scheduler runner 책임).
 */
export const sendOutgoing = async (
  chatId: string | number,
  text: string,
): Promise<void> => {
  const bot = cachedBot;
  if (bot === null) {
    throw new Error("telegram channel not initialized");
  }
  await sendFormatted(
    (chunk, extra) => bot.api.sendMessage(chatId, chunk, extra),
    text,
    // fire-and-forget 알림 = 긴 재시도 예산(위 OUTBOUND_RETRY_DELAYS_MS 주석) — 유실 > 지연.
    { throwOnFail: true, retryDelays: OUTBOUND_RETRY_DELAYS_MS },
  );
};
