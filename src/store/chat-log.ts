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
import type { TurnMark } from "./turn-marks.js";
import { getDb, SESSION_STORAGE_CHANNEL, sessionDisplayName, visibleSessionSql } from "./sessions.js";
import { lineageChain } from "./thread-members.js";

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
  /**
   * 행 id — **복합 커서**의 두 번째 축. 조회 결과에만 실린다(쓰기 시엔 없다).
   * 같은 `ts` 가 여럿일 때 페이지 경계에서 행이 유실되는 것을 막는다(검토 D-1).
   */
  id?: number;
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
  /** 이 답변의 턴에 **실제로 보낸 추론 강도**(어댑터가 보고하면). */
  reasoning?: string;
  /**
   * 이 답변의 턴 비용 — 실시간 카드와 **같은 값**(`turn-spend.ts` 가 고른 것). 새로고침·다른 기기에서도 같은 줄이 뜬다.
   * `unreportedRequests` > 0 이면 합계는 하한이고 캐시는 말하지 않는다(실시간과 같은 규칙).
   */
  spend?: { input: number; output: number; cached?: number; requests: number; unreportedRequests?: number };
  /**
   * 대화 가시 이벤트의 종류(예 `prompt.options`). 미지정 = 일반 메시지(종전 동작).
   * 프런트가 이 값으로 **라이브와 같은 렌더러**를 고른다 — 문구를 서버가 다시 짓지 않는다.
   */
  kind?: string;
  /** 그 이벤트의 원본 payload. kind 가 있을 때만. */
  data?: Record<string, unknown>;
  /**
   * 완료 턴 표식(`store/turn-marks.ts`) — 저장이 확인된 정상 답에만. 기록엔 전부 남기고, 조회는 화면이 쓰는 `turnId` 만 돌려준다
   *  (좌표는 서버가 갈라낼 때 다시 읽는다).
   */
  turn?: TurnMark;
  /** 조회 결과 — 그 답의 완료 턴 id(메뉴 «여기까지로 갈라내기» 의 대상). */
  turnId?: string;
}

interface ChatLogRow {
  id: number;
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
  reasoning: string | null;
  spend: string | null;
  turn: string | null;
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
        `INSERT INTO chat_log (ts, thread_key, channel, role, text, attachments, notice, model, kind, data, reasoning, spend, turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        typeof row.reasoning === "string" && row.reasoning !== "" ? row.reasoning : null,
        row.spend !== undefined ? JSON.stringify(row.spend) : null,
        row.turn !== undefined ? JSON.stringify(row.turn) : null,
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat-log] recordChatMessage failed (best-effort): ${msg}`);
  }
};

/** 저장된 표식 — 모양이 틀리거나 손상됐으면 없음(그 답에선 갈라낼 수 없다 · 거짓 좌표 금지). */
export const parseTurnMark = (raw: string | null): TurnMark | undefined => {
  if (raw === null || raw === "") return undefined;
  try {
    const t = JSON.parse(raw) as TurnMark;
    if (typeof t?.id !== "string" || typeof t.through !== "number") return undefined;
    if (t.claude !== undefined && (typeof t.claude.sid !== "string" || typeof t.claude.uuid !== "string")) return undefined;
    return t;
  } catch {
    return undefined;
  }
};

/**
 * 이 대화 **화면 범위 안**에서 그 완료 턴의 답 행 — 자기 행 + 조상 행(갈라진 순간까지). 물려받은 카드도 찾는다.
 * 없으면 undefined(다른 대화의 턴 · 범위 밖 · 표식 없음).
 */
export const findTurnRow = (threadKey: string, turnId: string): { id: number; ts: number; threadKey: string; turn: TurnMark } | undefined => {
  for (const seg of chatScreenSegments(threadKey)) {
    const r = getDb()
      .prepare(`SELECT id, ts, thread_key, turn FROM chat_log WHERE thread_key = ? AND turn IS NOT NULL AND json_extract(turn, '$.id') = ?${seg.maxId !== null ? " AND id <= ?" : ""} LIMIT 1`)
      .get(seg.key, turnId, ...(seg.maxId !== null ? [seg.maxId] : [])) as { id: number; ts: number; thread_key: string; turn: string } | undefined;
    const t = r === undefined ? undefined : parseTurnMark(r.turn);
    if (r !== undefined && t !== undefined) return { id: r.id, ts: r.ts, threadKey: r.thread_key, turn: t };
  }
  return undefined;
};

/**
 * 이 대화 화면 범위에서 **화면 행 `maxChatId` 이하**인 가장 최근 Claude 완료 턴 표식(그 행 시각과 함께).
 *  Codex 답에서 갈라낼 때 그 앞의 마지막 Claude 지점까지 SDK 복제하고 나머지는 재개 델타로 넣는다(설계 «유효 계약» §3-2).
 *  chat_log id 는 전역 단조라 «화면 행 ≤ Tc» 하나로 자기·조상 범위를 함께 자른다 — 표식의 모델 상한도 시간순으로만 커지므로
 *  (답 행은 그 턴 저장 뒤에 남는다) 이 조건이 «상한 ≤ T» 도 보장한다(따로 걸면 같은 판단 두 벌 — 변이 M6 이 동치로 확인).
 */
export const latestClaudeMarkUpTo = (
  threadKey: string,
  maxChatId: number,
): { ts: number; claude: NonNullable<TurnMark["claude"]> } | undefined => {
  let best: { id: number; ts: number; claude: NonNullable<TurnMark["claude"]> } | undefined;
  for (const seg of chatScreenSegments(threadKey)) {
    const cap = seg.maxId === null ? maxChatId : Math.min(seg.maxId, maxChatId);
    const r = getDb()
      .prepare(
        `SELECT id, ts, turn FROM chat_log WHERE thread_key = ? AND id <= ? AND turn IS NOT NULL
            AND json_extract(turn, '$.claude.sid') IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(seg.key, cap) as { id: number; ts: number; turn: string } | undefined;
    const t = r === undefined ? undefined : parseTurnMark(r.turn);
    if (r !== undefined && t?.claude !== undefined && (best === undefined || r.id > best.id)) best = { id: r.id, ts: r.ts, claude: t.claude };
  }
  return best === undefined ? undefined : { ts: best.ts, claude: best.claude };
};

/**
 * **이 대화 화면에 보이는 기록의 범위** — 자기 행 전부 + 갈라져 나온 조상의 행은 갈라진 순간(Tc)까지 (설계 §3, 2026-10-15).
 * 가지가 아니면 자기 하나 — 질의 모양이 종전과 같다. 조회·검색이 **이 한 함수**로 범위를 정한다.
 */
export const chatScreenSegments = (threadKey: string): { key: string; maxId: number | null }[] => [
  { key: threadKey, maxId: null },
  ...lineageChain(SESSION_STORAGE_CHANNEL, threadKey).map((a) => ({ key: a.key, maxId: a.throughChatId })),
];

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
  /** 복합 커서의 두 번째 축 — 같은 `ts` 안에서 이 id 보다 과거만(동률 유실 방지). */
  beforeId?: number;
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
  // 가지면 조상 구간을 세그먼트별로 따로 잡아 합친다 — OR 로 묶으면 인덱스 범위 탐색이 안 된다(아래 행-값 커서 주석의 실측과 같은 이유).
  const segments = opts?.threadKey !== undefined ? chatScreenSegments(opts.threadKey) : [];
  if (opts?.threadKey !== undefined && segments.length === 1) {
    where.push(`thread_key = ?`);
    params.push(opts.threadKey);
  }
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  if (opts?.beforeTs !== undefined) {
    // ★복합 커서 `(ts, id)` — `ts <` 만 쓰면 **경계에 걸린 동률 ts 행이 영영 안 온다**
    //  (2026-08-23 적대 검토 D-1, 실측: 8건 중 4건만 수집). 라이브 DB 에 동률 그룹이
    //  18개 있고 대부분 **user+assistant 쌍**이라, 질문이 사라지고 답만 남는 모양이었다.
    //  정렬이 `ts DESC, id DESC` 이므로 커서도 같은 두 축이어야 짝이 맞는다.
    //  ★행-값 비교 `(ts, id) < (?, ?)` 를 쓴다 — `(ts < ? OR (ts = ? AND id < ?))` 와
    //   **결과는 같지만** OR 은 SQLite 플래너가 인덱스 범위 탐색으로 못 접는다(EXPLAIN 에
    //   `thread_key=?` 만 남고 나머지는 전수 스캔). 실측 6만행·1,500페이지: OR 875ms →
    //   행-값 17.9ms. 게다가 분기가 사라져 코드도 한 줄 짧다.
    if (opts.beforeId !== undefined) {
      where.push(`(ts, id) < (?, ?)`);
      params.push(opts.beforeTs, opts.beforeId);
    } else {
      where.push(`ts < ?`);
      params.push(opts.beforeTs);
    }
  }
  const cols = `id, ts, thread_key, channel, role, text, attachments, notice, model, kind, data, reasoning, spend, turn`;
  let rows: ChatLogRow[];
  if (segments.length > 1) {
    const parts: string[] = [];
    const segParams: unknown[] = [];
    for (const seg of segments) {
      const w = [`thread_key = ?`, ...(seg.maxId !== null ? [`id <= ?`] : []), ...where];
      parts.push(`SELECT * FROM (SELECT ${cols} FROM chat_log WHERE ${w.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?)`);
      segParams.push(seg.key, ...(seg.maxId !== null ? [seg.maxId] : []), ...params, limit);
    }
    rows = getDb()
      .prepare(`${parts.join(" UNION ALL ")} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...segParams, limit) as ChatLogRow[];
    // 물려받은 행도 **이 대화의 화면**에 그려진다 — 표시 키를 이 대화로 둔다(화면은 행의 키로 탭을 가른다).
    for (const r of rows) r.thread_key = opts!.threadKey!;
  } else {
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ``;
    rows = getDb()
      .prepare(
        `SELECT ${cols}
           FROM chat_log
           ${whereClause}
          ORDER BY ts DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as ChatLogRow[];
  }
  // ts DESC 로 최신 N 건을 잡고 ASC(오래된→최신)로 뒤집어 렌더 순서로 반환.
  return rows.reverse().map((r) => {
    const entry: ChatLogEntry = {
      id: r.id, // 복합 커서용 — 클라가 다음 페이지 요청에 실어 보낸다.
      ts: r.ts,
      threadKey: r.thread_key,
      channel: r.channel,
      role: r.role === "assistant" ? "assistant" : "user",
      text: r.text,
      ...(r.notice === 1 ? { notice: true } : {}), // 구 행(NULL) = 비서 발화(종전 동작).
      ...(typeof r.model === "string" && r.model !== "" ? { model: r.model } : {}),
      ...(typeof r.reasoning === "string" && r.reasoning !== "" ? { reasoning: r.reasoning } : {}),
      ...(typeof r.kind === "string" && r.kind !== "" ? { kind: r.kind } : {}),
    };
    const turnId = parseTurnMark(r.turn)?.id;
    if (turnId !== undefined) entry.turnId = turnId;
    // 턴 비용 — 손상 JSON·모양이 틀린 값은 버린다(표시 없음 = 거짓값 금지).
    if (r.spend !== null && r.spend !== "") {
      try {
        const s = JSON.parse(r.spend) as ChatLogEntry["spend"];
        if (s !== undefined && s !== null && typeof s.input === "number" && s.input > 0) entry.spend = s;
      } catch {
        /* 무시 */
      }
    }
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

/**
 * 세션의 **첫 사용자 발화** — 표시명 파생의 재료(2026-08-03).
 *
 * ★처음엔 *최근* 메시지(`preview`)로 파생했다가 라이브에서 바로 틀린 게 보였다:
 *  기본 세션이 `돌쇠 재시작 완료! ✅` 로 뜨고 **매 턴 이름이 바뀌었다.** 이름은
 *  정체성이라 안정적이어야 한다 — 그래서 대화의 **처음**을 쓴다(그 세션이 무슨
 *  얘기로 시작했나 = 안 변한다). 인덱스 `(thread_key, ts)` 를 그대로 탄다.
 */
export const getFirstUserText = (threadKey: string): string => {
  const row = getDb()
    .prepare(
      `SELECT text FROM chat_log
        WHERE thread_key = ? AND role = 'user' AND text IS NOT NULL AND TRIM(text) <> ''
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(threadKey) as { text?: string } | undefined;
  return typeof row?.text === "string" ? row.text : "";
};

/**
 * 이 대화에서 **마지막 `kind` 표식 뒤의 첫 대화 기록**(사용자 메시지 또는 비서 답 · 통지·이벤트 행 제외) — 표식이 없으면 처음부터.
 *  가지 결론 보내기가 «지난번 보낸 뒤부터» 정리 범위를 잡는 데 쓴다(`thread.carried` 표식, 2026-10-15).
 * ★비서 답도 센다 — 매니저(백그라운드 작업) 완료는 사용자 말 없이 숨은 알림 + 비서 보고로 남는다. 사용자 메시지만 세면 «보낸 뒤 매니저가
 *  끝났다» 가 «새 내용 없음» 이 되어 그 결과가 원래 대화로 가지 않았다(10-15 정태님 «매니저들이 엄청나게 작업을 했어»).
 */
export const firstChatAfterKind = (
  threadKey: string,
  kind: string,
): { text: string; role: "user" | "assistant" | ""; marked: boolean } => {
  const db = getDb();
  // 표식이 «여기까지 보냈다» 를 실어 오면(`throughChatId` — 표식은 원래 대화가 받은 뒤에 남으므로 그 사이 생긴 기록을 묻지 않게) 그 위치,
  //  없으면 표식 행 자신.
  const mark = db
    .prepare(`SELECT MAX(COALESCE(json_extract(data, '$.throughChatId'), id)) AS id FROM chat_log WHERE thread_key = ? AND kind = ?`)
    .get(threadKey, kind) as { id: number | null };
  const after = mark.id ?? 0;
  const row = db
    .prepare(
      `SELECT role, text FROM chat_log
        WHERE thread_key = ? AND id > ? AND kind IS NULL AND notice IS NULL AND text IS NOT NULL AND TRIM(text) <> ''
        ORDER BY id ASC LIMIT 1`,
    )
    .get(threadKey, after) as { role?: string; text?: string } | undefined;
  return {
    text: typeof row?.text === "string" ? row.text : "",
    role: row?.role === "user" ? "user" : row?.role === "assistant" ? "assistant" : "",
    marked: mark.id !== null,
  };
};

/** 검색 결과 한 건 — 어느 세션의 언제/누가/무엇인지가 다 실려야 한다. */
export interface ChatSearchHit {
  /**
   * 행 id — 더보기 커서의 두 번째 축(`beforeId`)이 이 값을 쓴다.
   *
   * ★타입에 없었는데 `searchChatLog` 은 **실제로 돌려주고** 있었고, 브리지가 `...rest` 로
   *  퍼뜨려 클라이언트까지 갔다(2026-08-25 발견). 타입과 런타임이 갈린 자리라 채웠다 —
   *  이 값이 없으면 같은 `ts` 안에서 동률이 유실된다.
   */
  id: number;
  ts: number;
  threadKey: string;
  channel: string;
  role: string;
  /** 일치 지점 주변 조각(코어 `makeSnippet` 가 만든다). */
  snippet: string;
  /** `snippet` 안에서의 일치 위치·길이 — 프런트가 하이라이트한다(문자열 재검색 금지). */
  matchStart: number;
  matchLen: number;
  /** 세션 표시명 — `sessionDisplayName` 단일 판단에서 온다(클라가 파생하지 않는다). */
  sessionLabel: string;
}

/**
 * **전 세션 가로질러** 채팅 검색 (2026-08-22, 사용자 확정).
 *
 * ★세션 구분이 결과에 실린다 — 가로질러 찾는 순간 "이게 어느 대화였나" 가 첫 질문이 된다.
 *  표시명은 `sessionDisplayName`(서버 단일 판단)에서 온다. 클라가 threadKey 로 파생하면
 *  같은 세션이 화면마다 다른 이름으로 보인다(`/sessions` 가 이미 겪고 서버로 옮긴 문제).
 *
 * LIKE 부분일치 — 한국어 조사 어절 때문에 FTS 보다 정확하다(core/chat-search.ts 주석).
 * `ESCAPE '\'` 로 사용자가 친 `%`·`_` 를 글자 그대로 찾는다.
 */
/**
 * 검색 조건 조립 — **목록과 개수가 같은 판정을 쓰게** 한 곳에서 만든다.
 *
 * ★따로 적으면 갈린다: "1,438건 중 50건" 이라고 말해 놓고 그 1,438이 다른 규칙으로 센
 *  숫자면 안내가 거짓이 된다. 조건이 바뀔 때 한 곳만 고치면 되게 묶는다.
 */
const searchWhere = (
  like: string,
  opts?: { threadKey?: string; beforeTs?: number; beforeId?: number },
): { sql: string; params: unknown[] } => {
  const visible = visibleSessionSql("t");
  const where = [`c.text LIKE '%' || ? || '%' ESCAPE '\\'`];
  const params: unknown[] = [like];
  // 대화 하나로 좁히면 그 대화의 **화면 범위**(가지면 조상 구간 포함) — 보이는지는 행의 대화가 아니라 **이 대화**로 판정한다
  //  (부모를 보관·삭제해도 가지가 물려받은 기록은 가지에서 찾힌다).
  let join = `JOIN threads t ON t.channel_thread_id = c.thread_key`;
  const joinParams: unknown[] = [];
  if (opts?.threadKey !== undefined) {
    const segs = chatScreenSegments(opts.threadKey);
    where.push(`(${segs.map((g) => (g.maxId === null ? `c.thread_key = ?` : `(c.thread_key = ? AND c.id <= ?)`)).join(" OR ")})`);
    for (const g of segs) params.push(g.key, ...(g.maxId === null ? [] : [g.maxId]));
    join = `JOIN threads t ON t.channel_thread_id = ?`;
    joinParams.push(opts.threadKey);
  }
  // ★더보기 커서 — `ts <` 로 이어 받는다(OFFSET 아님). 목록이 `ts DESC` 인데 그 사이 새
  //  메시지가 오면 OFFSET 은 한 건을 건너뛰거나 두 번 보여준다. 커서는 그 창에 안 걸린다
  //  (`/chat-history` 의 `beforeTs` 와 같은 셈법 — 같은 문제엔 같은 해법).
  if (opts?.beforeTs !== undefined) {
    // 복합 커서 — 위 `getRecentChatLog` 와 같은 이유·같은 모양(동률 ts 유실 방지).
    if (opts.beforeId !== undefined) {
      where.push(`(c.ts, c.id) < (?, ?)`); // 행-값 비교 — 위와 같은 이유(인덱스 범위 탐색 보존).
      params.push(opts.beforeTs, opts.beforeId);
    } else {
      where.push(`c.ts < ?`);
      params.push(opts.beforeTs);
    }
  }
  return {
    sql:
      `FROM chat_log c\n         ${join}\n` +
      `        WHERE ${[...visible.conds, ...where].join("\n          AND ")}`,
    params: [...joinParams, ...visible.params, ...params],
  };
};

/**
 * 이 질의에 **실제로 몇 건**이 걸리나 — 목록은 상한이 있으므로 잘린 사실을 말하려면 필요하다.
 *
 * ★없을 때 UI 는 "'는' — 50건" 이라고 말했다. 실제로는 **1,438건**이었다(실측). 캡이 있는
 *  자리에서 캡을 안 말하면 그건 조용한 절삭이다([[project_hotpath_bound_preserve_record]]).
 *  비용 실측 8ms(3,977행) — 말해줄 수 있는 값이라 말한다.
 */
export const countChatLogMatches = (
  like: string,
  opts?: { threadKey?: string },
): number => {
  const w = searchWhere(like, opts);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n\n         ${w.sql}`)
    .get(...w.params) as { n: number } | undefined;
  return row?.n ?? 0;
};

/**
 * 기간 안의 **진짜** 총계 — 세션 수·메시지 수. `listChatPeriods` 는 상한이 있으므로
 * 잘렸다는 사실을 말하려면 이게 따로 필요하다(목록을 더하면 그 합도 잘린 값이다).
 */
export const countChatPeriod = (
  sinceTs: number,
  untilTs: number,
): { sessions: number; messages: number } => {
  const visible = visibleSessionSql("t");
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT c.thread_key) AS s, COUNT(*) AS m
         FROM chat_log c
         JOIN threads t ON t.channel_thread_id = c.thread_key
        WHERE ${[...visible.conds, "c.ts >= ?", "c.ts <= ?"].join("\n          AND ")}`,
    )
    .get(...visible.params, sinceTs, untilTs) as { s: number; m: number } | undefined;
  return { sessions: row?.s ?? 0, messages: row?.m ?? 0 };
};

/**
 * **기간 안에 오간 대화를 세션별로** 묶어 준다 — 키워드가 없을 때의 길 (2026-08-25).
 *
 * ★왜 필요했나 (사용자): *"2주전에 주요 대화 주제가 뭔지"* · *"저번달에 집중한 주제"*.
 *  키워드 검색밖에 없으면 비서는 키워드를 **짐작해서** 두드린다 — 실측 한 턴에
 *  `search_conversations` **56회**. 답은 맞았지만 그건 운이고 비용이다.
 *
 * ★세션 표시명이 곧 **그 대화의 주제**다(`sessionDisplayName`: 커스텀 이름 > 첫 발화).
 *  그래서 요약 LLM 호출 없이, 이미 있는 판단만으로 답이 선다.
 * ★가시성 판정은 검색과 **같은 것**(`visibleSessionSql`)을 쓴다 — 내부 파생·보관된 세션이
 *  한쪽에만 나오면 사용자는 두 화면이 다른 세상을 말한다고 느낀다.
 * ★정렬은 **많이 오간 순**이다 — 질문이 "주로 무슨 얘기" 이기 때문이다. 최근 순으로 두면
 *  스치듯 지나간 대화가 맨 위에 온다.
 */
export const listChatPeriods = (
  sinceTs: number,
  untilTs: number,
  opts?: { limit?: number },
): Array<{
  threadKey: string;
  channel: string;
  sessionLabel: string;
  messages: number;
  firstTs: number;
  lastTs: number;
}> => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? Math.min(opts.limit, 200) : 30;
  const visible = visibleSessionSql("t");
  const rows = getDb()
    .prepare(
      `SELECT c.thread_key, c.channel, t.name AS thread_name,
              COUNT(*) AS n, MIN(c.ts) AS first_ts, MAX(c.ts) AS last_ts
         FROM chat_log c
         JOIN threads t ON t.channel_thread_id = c.thread_key
        WHERE ${[...visible.conds, "c.ts >= ?", "c.ts <= ?"].join("\n          AND ")}
        GROUP BY c.thread_key
        ORDER BY n DESC, last_ts DESC
        LIMIT ?`,
    )
    .all(...visible.params, sinceTs, untilTs, limit) as Array<{
    thread_key: string;
    channel: string;
    thread_name: string | null;
    n: number;
    first_ts: number;
    last_ts: number;
  }>;
  return rows.map((r) => ({
    threadKey: r.thread_key,
    channel: r.channel,
    sessionLabel: sessionDisplayName(r.thread_key, r.thread_name, getFirstUserText(r.thread_key)),
    messages: r.n,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
  }));
};

export const searchChatLog = (
  like: string,
  opts?: { limit?: number; threadKey?: string; beforeTs?: number; beforeId?: number },
): Array<Omit<ChatSearchHit, "snippet" | "matchStart" | "matchLen"> & { text: string }> => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 50;
  const w = searchWhere(like, {
    ...(opts?.threadKey !== undefined ? { threadKey: opts.threadKey } : {}),
    ...(opts?.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
    ...(opts?.beforeId !== undefined ? { beforeId: opts.beforeId } : {}),
  });
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.ts, c.thread_key, c.channel, c.role, c.text, t.name AS thread_name
         ${w.sql}
        ORDER BY c.ts DESC, c.id DESC
        LIMIT ?`,
    )
    .all(...w.params, limit) as Array<{
    id: number;
    ts: number;
    thread_key: string;
    channel: string;
    role: string;
    text: string;
    thread_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    threadKey: opts?.threadKey ?? r.thread_key, // 물려받은 행도 이 대화에서 찾은 것 — 이 대화로 연다
    channel: r.channel,
    role: r.role,
    text: r.text,
    sessionLabel: sessionDisplayName(
      r.thread_key,
      r.thread_name,
      getFirstUserText(r.thread_key),
    ),
  }));
};
