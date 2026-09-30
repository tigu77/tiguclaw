/**
 * **첨부 수납** — 업로드를 받아 홈에 저장하고, 나갈 파일을 되돌려 준다.
 *
 * ★`index.ts` 에서 떼어냈다 (2026-08-30). 그 파일은 3,905줄이었고 여기 137줄은 **라우트와
 *  아무 상태도 공유하지 않는** 순수 조각이었다 — 클래스 밖 최상위 함수 그대로였다.
 *  옮기는 데 필요한 건 import 다섯뿐이었다.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Attachment, AttachmentKind } from "../../src/channels/types.js";
import { getPaths } from "../../src/core/paths.js";
import type { EventBus } from "../../src/core/eventbus.js";

/**
 * **개수 상한.** ★`export` 다 — `/health` 가 이 셋을 화면에 실어 보낸다 (2026-09-15).
 *  브라우저가 자기 숫자를 들고 있으면 서버에서 올려도 안 따라온다(그래서 이 사고가 났다).
 */
export const ATTACH_MAX_COUNT = 10;
/**
 * **파일당 상한 — 텔레그램 채널과 같은 값** (2026-09-15).
 *
 * ★종전 10MiB 는 앵커 없는 수였고, 그래서 **채널마다 능력이 갈렸다**: 텔레그램은 Bot API
 *  `getFile` 한도(20MB)까지 받아 `fs.writeFile` 로 바로 저장하므로 이 캡을 **안 지난다**.
 *  즉 같은 15MB 영상이 텔레그램으로는 처리되고 대시보드로는 거절됐다 — 기능이 채널에
 *  묶인 것이고 이 레포 원칙과 어긋난다([[feedback_every_feature_llm_agnostic]]).
 * ★20MiB 를 고른 근거는 «넉넉해 보여서» 가 아니라 **다른 채널이 이미 받아주는 천장**이다.
 *  그리고 전사 provider 한도(25MiB)보다 낮아 오디오 경로도 그대로 성립한다.
 */
export const ATTACH_MAX_FILE_BYTES = 20 * 1024 * 1024;
/**
 * **한 요청 합계** — 파일당 상한 둘 + 여유. 실측(3개월) 최대가 8.03MiB 이므로 6배 여유다.
 *
 * ★이 수가 곧 **HTTP 본문 상한의 뿌리**다(`http-body.ts` 가 base64 표현으로 유도한다).
 *  즉 여기를 올리면 한 요청이 메모리에 올릴 수 있는 최대치가 같이 오른다 — 데몬 RSS 가
 *  169MiB 인 기계에서 한 요청 67.7MiB 는 감당되지만, 더 키울 땐 그 대가를 먼저 세라.
 */
export const ATTACH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export class AttachmentError extends Error {}
const attachmentKindOf = (mime: string): AttachmentKind =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("video/")
        ? "video"
        : "document";
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "application/pdf": "pdf", "text/plain": "txt",
  "text/markdown": "md", "application/json": "json", "text/csv": "csv",
};
// 🎤 음성입력(/transcribe) 임시파일 확장자 — 오디오 mime → ext. MediaRecorder 기본은 webm/opus.
// whisper wrapper 가 ffmpeg 로 재변환하므로 확장자만 맞으면 충분(미지 = webm 폴백).
export const AUDIO_EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/oga": "ogg",
  "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac",
};
// 서빙용 확장자→content-type (인바운드 첨부 파일 렌더). 미지 확장자는 octet-stream.
export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf",
  // ★svg 는 **의도적으로 뺐다** (2026-07-31 전체검토 P0). SVG 는 스크립트를 담을 수 있고,
  //  `image/svg+xml` 로 inline 서빙하면 top-level 이동 시 **같은 오리진에서 실행**된다
  //  (실증: `<svg><script>fetch('/pwned')</script></svg>` 가 서버 요청을 냈다).
  //  첨부 URL 은 인증을 `?token=` 으로 싣기 때문에, 실행되는 순간 `location.search` 로
  //  브리지 토큰을 읽어 API 전부를 부를 수 있다. 심는 경로는 write 토큰뿐 아니라
  //  **프롬프트 인젝션으로 비서가 send_file 한 경우·텔레그램 인바운드 첨부**도 같다.
  //  → 미지 확장자로 떨어져 `application/octet-stream` + 아래 nosniff/attachment 로 닫힌다.
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8",
};
export const sanitizeFilename = (n: string): string =>
  n.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim().slice(-120) || "file";
const extForAttachment = (filename: string, mime: string): string => {
  const e = path.extname(filename).replace(/^\./, "").toLowerCase();
  if (e.length > 0 && e.length <= 8) return e;
  return EXT_BY_MIME[mime] ?? "bin";
};
const yyyymmddUtc = (): string =>
  new Date().toISOString().slice(0, 10).replace(/-/g, "");
// body.attachments([{filename?, mimeType?, dataBase64}]) → Attachment[] (홈 저장). 캡 위반 throw.
export const ingestAttachments = async (
  raw: unknown,
  channel: string,
): Promise<Attachment[]> => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > ATTACH_MAX_COUNT) {
    throw new AttachmentError(`첨부는 최대 ${ATTACH_MAX_COUNT}개까지 가능합니다.`);
  }
  const dir = path.join(getPaths().attachmentsDir, channel, yyyymmddUtc());
  const out: Attachment[] = [];
  let total = 0;
  for (const a of raw) {
    const item = a as { filename?: unknown; mimeType?: unknown; dataBase64?: unknown };
    if (typeof item.dataBase64 !== "string" || item.dataBase64 === "") continue;
    const filename = sanitizeFilename(
      typeof item.filename === "string" ? item.filename : "file",
    );
    const mimeType =
      typeof item.mimeType === "string" && item.mimeType !== ""
        ? item.mimeType
        : "application/octet-stream";
    const buf = Buffer.from(item.dataBase64, "base64");
    if (buf.length === 0) continue;
    if (buf.length > ATTACH_MAX_FILE_BYTES) {
      throw new AttachmentError(
        `'${filename}' 이(가) 파일당 한도(${ATTACH_MAX_FILE_BYTES / 1024 / 1024}MB)를 초과합니다.`,
      );
    }
    total += buf.length;
    if (total > ATTACH_MAX_TOTAL_BYTES) {
      throw new AttachmentError(
        `첨부 총합이 한도(${ATTACH_MAX_TOTAL_BYTES / 1024 / 1024}MB)를 초과합니다.`,
      );
    }
    await fs.mkdir(dir, { recursive: true });
    const id = crypto.randomBytes(8).toString("hex");
    const abs = path.join(dir, `${id}.${extForAttachment(filename, mimeType)}`);
    await fs.writeFile(abs, buf);
    out.push({
      kind: attachmentKindOf(mimeType),
      mimeType,
      path: abs,
      filename,
      bytes: buf.length,
    });
  }
  return out;
};

// ── 아웃바운드 첨부(send_file, #2 parity) — 비서가 send_file 로 보낸 절대경로 파일을 대시보드가
// 받아볼 수 있게 통제 디렉터리로 *복사*해 servable rel 을 확보한다. ★임의 절대경로를 그대로
// 서빙하지 않는다(보안): 인바운드와 동일하게 attachmentsDir/<channel>/<yyyymmdd>/<id>.<ext> 만
// /attachments 로 노출된다. 인바운드 ingest 와 대칭(같은 디렉터리·명명·kind 매핑 헬퍼 재사용). ──
// ext → 깨끗한 mime(CONTENT_TYPE_BY_EXT 는 charset 파라미터 포함 → 첫 토큰만). 미지 = octet-stream.
const mimeForExt = (ext: string): string => {
  const ct = CONTENT_TYPE_BY_EXT[ext];
  return ct !== undefined ? (ct.split(";")[0]?.trim() ?? "application/octet-stream") : "application/octet-stream";
};
interface OutboundAttachmentMeta {
  rel: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: number;
}
// srcPath(절대경로) → 통제 디렉터리 복사 후 서빙 메타. 파일 부재/디렉터리/접근불가면 null(호출자 {ok:false}).
export const persistOutboundAttachment = async (
  srcPath: string,
  channel: string,
): Promise<OutboundAttachmentMeta | null> => {
  const st = await fs.stat(srcPath).catch(() => null);
  if (st === null || !st.isFile()) return null;
  const name = sanitizeFilename(path.basename(srcPath));
  const srcExt = path.extname(srcPath).replace(/^\./, "").toLowerCase();
  const mime = mimeForExt(srcExt);
  const kind = attachmentKindOf(mime);
  const dir = path.join(getPaths().attachmentsDir, channel, yyyymmddUtc());
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const destExt = srcExt.length > 0 && srcExt.length <= 8 ? srcExt : (EXT_BY_MIME[mime] ?? "bin");
  const abs = path.join(dir, `${id}.${destExt}`);
  await fs.copyFile(srcPath, abs);
  const rel = path
    .relative(getPaths().attachmentsDir, abs)
    .split(path.sep)
    .join("/"); // URL 경로 정규화(윈도우 \ → /).
  return { rel, name, mime, kind, bytes: st.size };
};


/**
 * 파일 하나를 대화에 붙인다 — **판단은 여기 한 곳** (2026-09-30). 인입 턴의 `send_file`(routes-chat)과 좌표만 있는
 * 발송(`outbound.deliverAttachment` — 매니저 완료 보고처럼 인입 메시지가 없는 턴)이 같은 함수를 쓴다.
 * 통제 디렉터리로 복사해 서빙 경로를 확보한 뒤 `channel.message.out` 에 `attachments` 를 실어 발행한다 → 대시보드가
 * 첨부 카드로 그리고 event-persist 가 chat_log 에 남긴다(새로고침·재시작 후에도 유지). 멱등은 호출자(send_file 도구의
 * 턴별 sentPaths)가 보장한다. 실패는 던지지 않고 사유로 돌려준다.
 */
export const publishOutboundAttachment = async (input: {
  bus: EventBus | null;
  channel: string;
  threadKey: string;
  filePath: string;
  caption?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const meta = await persistOutboundAttachment(input.filePath, input.channel).catch(() => null);
  if (meta === null) {
    return { ok: false, error: `파일을 찾을 수 없거나 접근할 수 없습니다: ${input.filePath}` };
  }
  if (input.bus === null) {
    return { ok: false, error: "control bus not started (대시보드 미연결)" };
  }
  try {
    input.bus.publish({
      type: "channel.message.out",
      ts: Date.now(),
      payload: {
        channel: input.channel,
        threadKey: input.threadKey,
        text: "", // 첨부-only 아웃바운드(캡션은 attachment.caption 으로). 최종 답변 text-out 과 별개 버블.
        attachments: [
          {
            rel: meta.rel,
            mime: meta.mime,
            name: meta.name,
            kind: meta.kind,
            bytes: meta.bytes,
            ...(input.caption !== undefined && input.caption !== "" ? { caption: input.caption } : {}),
          },
        ],
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** 좌표(=세션 threadKey)만으로 — 좌표가 없으면 다시 해도 안 된다(`unavailable`). `outbound.deliverAttachment` 가 쓴다. */
export const deliverSessionAttachment = (input: {
  bus: EventBus | null;
  channel: string;
  target: string | null;
  filePath: string;
  caption?: string;
}): Promise<{ ok: true } | { ok: false; error: string; unavailable?: true }> =>
  input.target === null || input.target.trim() === ""
    ? Promise.resolve({ ok: false, error: "http-bridge target required (session threadKey)", unavailable: true })
    : publishOutboundAttachment({
        bus: input.bus,
        channel: input.channel,
        threadKey: input.target,
        filePath: input.filePath,
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
      });
