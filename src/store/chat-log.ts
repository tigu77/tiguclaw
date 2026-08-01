/**
 * 대시보드 대화 이력 영속 (기능 B, 2026-06-25).
 *
 * 대시보드 채팅은 EventBus 인메모리 ring(최근 50)으로만 그려져 데몬 재시작 시 화면서
 * 사라진다. `transcripts` 는 raw 모델 I/O(사용자 턴에 system-reminder 스캐폴딩이
 * 섞임)라 그대로 못 쓴다 → 깨끗한 `channel.message.in/out` 텍스트만 담는 전용 작은
 * 테이블(`chat_log`)의 read/write 헬퍼. 메시지당 insert 1줄(비용 무시).
 *
 * 견고성 경계: recordChatMessage 는 *boundary*(턴/메시지 처리 핫패스에서 불림)라 내부
 * try/catch 로 감싸 로깅 실패가 호출자를 절대 못 깨게 한다(best-effort). getRecentChatLog
 * 는 읽기(렌더용)라 throw 가능 — 호출자(대시보드 핸들러)가 정상 경로에서 가린다.
 *
 * 기존 store 모듈(skill-usage.ts·worker-jobs.ts) 의 prepared statement·getDb 접근 동형.
 */
import { getDb } from "./sessions.js";

export type ChatRole = "user" | "assistant";

/**
 * 첨부 메타 — base64 본문이 아니라 **참조**만 영속(경로·mime·이름·종류). 실제 바이트는 이미
 * `<home>/data/attachments/<rel>` 파일로 저장돼 있어, 대시보드가 그 rel 로 서빙 엔드포인트를
 * 통해 렌더한다(새로고침·과거 이력 보존). base64 를 chat_log 에 담지 않아 DB 비대 0.
 */
export interface ChatAttachmentMeta {
  /** attachmentsDir 기준 상대경로 (예: `http-bridge/20260710/abc.png`). 서빙 키. */
  rel: string;
  mime: string;
  name: string;
  /** image | pdf | audio | video | file 등 Attachment.kind. */
  kind: string;
  bytes?: number;
  /**
   * 아웃바운드 첨부(send_file caption) 전용(additive) — 비서가 파일과 함께 보낸 설명.
   * 인바운드(유저 업로드)는 미사용. 미지정 = 캡션 없음(회귀 0). 대시보드 카드가 렌더.
   */
  caption?: string;
}

export interface ChatLogEntry {
  ts: number;
  threadKey: string;
  channel: string;
  role: ChatRole;
  text: string;
  /** 첨부 참조 메타(있을 때만). 이미지-only 메시지는 text="" + attachments 로 온다. */
  attachments?: ChatAttachmentMeta[];
  /**
   * 시스템 통지인가(스케줄 실패·자가 점검 등). 기본 false = 비서 발화.
   * role 을 늘리지 않고 이 플래그로 구분한다 — role='assistant' 를 보는 기존 소비자 무영향.
   */
  notice?: boolean;
  /** 이 답변에 **실제로 응답한 모델**(어댑터가 보고하면). 사용자 메시지·통지엔 없음. */
  model?: string;
  /**
   * 대화 가시 이벤트의 종류(예 `prompt.options`). 미지정 = 일반 메시지(종전 동작).
   * 프런트가 이 값으로 **라이브와 같은 렌더러**를 고른다 — 문구를 서버가 다시 짓지 않는다.
   */
  kind?: string;
  /** 그 이벤트의 원본 payload. kind 가 있을 때만. */
  data?: Record<string, unknown>;
}

interface ChatLogRow {
  ts: number;
  thread_key: string;
  channel: string;
  role: string;
  text: string;
  attachments: string | null;
  notice: number | null;
  model: string | null;
  kind: string | null;
  data: string | null;
}

/**
 * 깨끗한 채팅 메시지 1줄 기록 — INSERT. 빈 text 는 스킵(무의미 로그 방지).
 *
 * boundary: 내부 try/catch 로 best-effort — DB write 실패(디스크 가득 등)가 호출자(턴/
 * 메시지 처리)를 절대 안 깨게 한다(1차 안전망, 데몬 생존 우선). 실패는 console.error 만.
 */
export const recordChatMessage = (row: ChatLogEntry): void => {
  const hasAtt = row.attachments !== undefined && row.attachments.length > 0;
  const hasKind = typeof row.kind === "string" && row.kind !== "";
  // 빈 text·첨부無 = 무의미 로그 스킵. 단 **대화 가시 이벤트(kind)는 통과** — 선택지처럼
  // 본문이 payload 에 있고 text 는 빈 것이 정상인 종류가 있다(이미지-only 메시지와 동형).
  if (row.text === "" && !hasAtt && !hasKind) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO chat_log (ts, thread_key, channel, role, text, attachments, notice, model, kind, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        row.threadKey,
        row.channel,
        row.role,
        row.text,
        hasAtt ? JSON.stringify(row.attachments) : null,
        row.notice === true ? 1 : null, // null = 종전 행과 동일(비서 발화).
        typeof row.model === "string" && row.model !== "" ? row.model : null,
        hasKind ? (row.kind as string) : null,
        row.data !== undefined ? JSON.stringify(row.data) : null,
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat-log] recordChatMessage failed (best-effort): ${msg}`);
  }
};

/**
 * 최근 채팅 메시지 — 시간 오름차순 반환(렌더용). limit 기본 200.
 *  - sinceTs: 그 시각 *이후*(>=)만 (라이브 갱신용).
 *  - beforeTs: 그 시각 *이전*(<)만 (스크롤 더보기 — 페이지네이션). 가장 최근 N 건을 잡아
 *    ASC 반환하므로, beforeTs=현재 로드된 최古 ts 로 호출하면 그 바로 앞 묶음이 온다.
 *
 * 내부 조회는 최신 N 건을 잡기 위해 ts DESC LIMIT 로 가져온 뒤 ASC 로 뒤집어 반환한다
 * (가장 최근 N 건을 시간순으로 — 오래된 쪽이 잘리고 최신이 남게). 읽기라 throw 가능.
 */
export const getRecentChatLog = (opts?: {
  limit?: number;
  sinceTs?: number;
  beforeTs?: number;
  /**
   * threadKey 스코프(멀티세션 탭 — ADR 2026-07-15 D5.3). 지정 시 `WHERE thread_key = ?`
   * 를 기존 sinceTs/beforeTs 와 AND 결합 → per-thread 이력. **미지정 = 현행(전 스레드
   * 병합, 회귀 0).** 코어는 threadKey 를 opaque 로 취급(§0 — "dashboard" 특수참조 X).
   */
  threadKey?: string;
}): ChatLogEntry[] => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 200;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.threadKey !== undefined) {
    where.push(`thread_key = ?`);
    params.push(opts.threadKey);
  }
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  if (opts?.beforeTs !== undefined) {
    where.push(`ts < ?`);
    params.push(opts.beforeTs);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ``;
  const rows = getDb()
    .prepare(
      `SELECT ts, thread_key, channel, role, text, attachments, notice, model, kind, data
         FROM chat_log
         ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as ChatLogRow[];
  // ts DESC 로 최신 N 건을 잡고 ASC(오래된→최신)로 뒤집어 렌더 순서로 반환.
  return rows.reverse().map((r) => {
    const entry: ChatLogEntry = {
      ts: r.ts,
      threadKey: r.thread_key,
      channel: r.channel,
      role: r.role === "assistant" ? "assistant" : "user",
      text: r.text,
      ...(r.notice === 1 ? { notice: true } : {}), // 구 행(NULL) = 비서 발화(종전 동작).
      ...(typeof r.model === "string" && r.model !== "" ? { model: r.model } : {}),
      ...(typeof r.kind === "string" && r.kind !== "" ? { kind: r.kind } : {}),
    };
    // 손상 JSON 은 조용히 무시 — data 없이라도 나머지는 렌더된다(첨부와 같은 정책).
    if (r.data !== null && r.data !== "") {
      try {
        const parsed: unknown = JSON.parse(r.data);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          entry.data = parsed as Record<string, unknown>;
        }
      } catch {
        /* 무시 */
      }
    }
    if (r.attachments !== null && r.attachments !== "") {
      // 파싱 실패(손상 JSON)는 조용히 무시 — 첨부 없이라도 메시지는 렌더(견고성).
      try {
        const parsed = JSON.parse(r.attachments) as ChatAttachmentMeta[];
        if (Array.isArray(parsed) && parsed.length > 0) entry.attachments = parsed;
      } catch {
        /* 손상 첨부 메타 무시. */
      }
    }
    return entry;
  });
};
