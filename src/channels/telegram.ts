import { Bot, InputFile, type Context } from "grammy";
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
} from "./types.js";
import { getPaths } from "../core/paths.js";

// 텔레그램 bot getFile 다운로드 한도 (20MB). 초과 시 다운로드 생략 + 명시 안내.
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

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

// markdown → 텔레그램 HTML subset 변환 + 4096 분할.
// `telegram-markdown-formatter@0.1.2` 위임 (원칙 6 "직접 만들 일 아님").
// 검증: _workspace/tg_html_alt_spike.{ts,md} (§2.2 (a)~(d) + 분할 ALL PASS).

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

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private bot: Bot | null = null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token === undefined || token.trim() === "") {
      throw new Error("TELEGRAM_BOT_TOKEN not set");
    }
    this.bot = new Bot(token);
    cachedBot = this.bot;
  }

  async start(handler: MessageHandler): Promise<void> {
    const bot = this.bot;
    if (bot === null) {
      throw new Error("telegram channel: bot not initialized");
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
      const msg: IncomingMessage = {
        channel: "telegram",
        channelUserId: ctx.from === undefined ? "unknown" : String(ctx.from.id),
        threadKey: `tg:${ctx.chat.id}`,
        text,
        ...(replyToText !== undefined ? { replyToText } : {}),
        receivedAt: ctx.message.date * 1000,
        reply: async (out: string, opts?: ReplyOptions): Promise<void> => {
          // contract §3 흐름: 변환 → 분할 → HTML 송신 → 실패 시 plain 1회 폴백.
          // replyToTrigger 시 *첫 청크만* reply_parameters 부착 (멀티 청크는 첫 청크만
          // 답글, 나머지 일반 — 시각 잡음 회피). 답글은 부수 UX라 실패 시 plain 폴백.
          const chunks = splitHtmlForTelegram(telegramFormat(out));
          const triggerId = ctx.message.message_id;
          for (let i = 0; i < chunks.length; i++) {
            const useReply = opts?.replyToTrigger === true && i === 0;
            const extra = useReply
              ? {
                  parse_mode: "HTML" as const,
                  reply_parameters: { message_id: triggerId },
                }
              : { parse_mode: "HTML" as const };
            try {
              await ctx.reply(chunks[i]!, extra);
            } catch (e) {
              console.error("telegram HTML send failed, falling back to plain:", e);
              await ctx.reply(chunks[i]!).catch((e2) => {
                console.error("telegram plain fallback also failed:", e2);
              });
            }
          }
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
      };
      // 텔레그램 "입력 중…" 표시. 한 번 보내면 5 초 유지 → 4 초 간격 갱신.
      // 응답 지연 동안 사용자가 비서가 살아있다는 신호를 받는다.
      void ctx.replyWithChatAction("typing").catch(() => {});
      const heartbeat = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      try {
        await handler(msg);
      } catch (e) {
        console.error("telegram handler error:", e);
      } finally {
        clearInterval(heartbeat);
      }
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
            // message:text 핸들러와 동일한 변환→분할→HTML→plain 폴백 흐름.
            const chunks = splitHtmlForTelegram(telegramFormat(out));
            for (let i = 0; i < chunks.length; i++) {
              const useReply = opts?.replyToTrigger === true && i === 0;
              const extra = useReply
                ? {
                    parse_mode: "HTML" as const,
                    reply_parameters: { message_id: triggerId },
                  }
                : { parse_mode: "HTML" as const };
              try {
                await ctx.reply(chunks[i]!, extra);
              } catch (e) {
                console.error("telegram HTML send failed, falling back to plain:", e);
                await ctx.reply(chunks[i]!).catch((e2) => {
                  console.error("telegram plain fallback also failed:", e2);
                });
              }
            }
          };

        // typing heartbeat — 다운로드+영역 A 처리 동안 살아있음 신호.
        void ctx.replyWithChatAction("typing").catch(() => {});
        const heartbeat = setInterval(() => {
          void ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

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
          if (text.length === 0 && attachments === undefined) return;

          const msg: IncomingMessage = {
            channel: "telegram",
            channelUserId: ctx.from === undefined ? "unknown" : String(ctx.from.id),
            threadKey: `tg:${ctx.chat.id}`,
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
          };
          await handler(msg);
        } catch (e) {
          console.error("telegram attachment handler error:", e);
        } finally {
          clearInterval(heartbeat);
        }
      },
    );

    bot.catch((err) => {
      console.error("telegram polling error:", err.error);
    });

    // bot.start() 는 polling 동안 resolve 되지 않으므로 await 하지 않는다.
    // grammy 는 init 후 첫 getUpdates 가 시작되면 polling on. 안정 시점은
    // 별도 콜백 없이 init 완료로 본다.
    await bot.init();

    // 봇 명령 메뉴를 6 항목으로 강제 교체 (reset + memory V2 슬래시 + plugins + status).
    // setMyCommands 는 전달된 리스트로 *전체 교체* — 빈 항목·옛 항목 모두 제거.
    // 실패해도 polling 은 진행 (메뉴는 부수적 UX, 핵심 흐름 무관).
    await bot.api
      .setMyCommands([
        { command: "reset", description: "대화 컨텍스트 초기화" },
        { command: "memo", description: "메모리 추가" },
        { command: "forget", description: "메모리 삭제" },
        { command: "memos", description: "메모리 목록" },
        { command: "plugins", description: "설치·활성 플러그인 목록" },
        { command: "status", description: "시스템 상태" },
        { command: "restart", description: "데몬 재시작" },
      ])
      .catch((e) => {
        console.error("telegram setMyCommands failed:", e);
      });

    void bot.start({ drop_pending_updates: true });
  }

  async stop(): Promise<void> {
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
  const chunks = splitHtmlForTelegram(telegramFormat(text));
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (e) {
      console.error("telegram sendOutgoing HTML failed, falling back to plain:", e);
      await bot.api.sendMessage(chatId, chunk).catch((e2) => {
        console.error("telegram sendOutgoing plain fallback failed:", e2);
        throw e2;
      });
    }
  }
};
