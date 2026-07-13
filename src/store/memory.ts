import fs from "node:fs";
import type { ChannelName } from "../channels/types.js";
import { getContextBoundary, getDb, getSession } from "./sessions.js";

// ─── Types ──────────────────────────────────────────────────────────────────
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  id: number;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

interface MemoryRow {
  id: number;
  type: string;
  name: string;
  description: string;
  body: string;
  created_at: number;
  updated_at: number;
}

const rowToMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  type: row.type as MemoryType,
  name: row.name,
  description: row.description,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const requireDb = (caller: string) => {
  // getDb() throws if initStore() not called — wrap to add caller context.
  try {
    return getDb();
  } catch (err) {
    throw new Error(
      `initStore() must be called before ${caller}() — store is not initialized.`,
      { cause: err },
    );
  }
};

// ─── §4 V1: typed memories CRUD + FTS5 search ───────────────────────────────

export const addMemory = (input: {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
}): Memory => {
  const db = requireDb("addMemory");
  const now = Date.now();
  // UPSERT on name; type follows input (user override or LLM reclassification).
  // created_at preserved on conflict, updated_at stamped fresh.
  db.prepare(
    `INSERT INTO memories (type, name, description, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       type = excluded.type,
       description = excluded.description,
       body = excluded.body,
       updated_at = excluded.updated_at`,
  ).run(input.type, input.name, input.description, input.body, now, now);

  const row = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories WHERE name = ?`,
    )
    .get(input.name) as MemoryRow;
  return rowToMemory(row);
};

export const getMemory = (name: string): Memory | undefined => {
  const db = requireDb("getMemory");
  const row = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories WHERE name = ?`,
    )
    .get(name) as MemoryRow | undefined;
  return row === undefined ? undefined : rowToMemory(row);
};

export const deleteMemory = (name: string): boolean => {
  const db = requireDb("deleteMemory");
  const result = db.prepare(`DELETE FROM memories WHERE name = ?`).run(name);
  return result.changes > 0;
};

export const updateMemory = (
  name: string,
  patch: {
    description?: string;
    body?: string;
    type?: MemoryType;
  },
): Memory | undefined => {
  const db = requireDb("updateMemory");
  const existing = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories WHERE name = ?`,
    )
    .get(name) as MemoryRow | undefined;
  if (existing === undefined) return undefined;

  const nextType = patch.type ?? (existing.type as MemoryType);
  const nextDescription = patch.description ?? existing.description;
  const nextBody = patch.body ?? existing.body;
  const now = Date.now();

  db.prepare(
    `UPDATE memories SET type = ?, description = ?, body = ?, updated_at = ?
     WHERE name = ?`,
  ).run(nextType, nextDescription, nextBody, now, name);

  const row = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories WHERE name = ?`,
    )
    .get(name) as MemoryRow;
  return rowToMemory(row);
};

// ─── V3 인덱스 빌더 — 모든 memories 의 1줄 요약 (contract §2.3) ────────────
export const listMemoriesForIndex = (
  maxBytes: number,
): { lines: string[]; total: number; truncated: number } => {
  const db = requireDb("listMemoriesForIndex");
  const rows = db
    .prepare(
      `SELECT type, name, description
       FROM memories
       ORDER BY updated_at DESC`,
    )
    .all() as Pick<MemoryRow, "type" | "name" | "description">[];

  const lines: string[] = [];
  let bytes = 0;
  let truncated = 0;
  for (const r of rows) {
    const line = `- [${r.type}] ${r.name}: ${r.description}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +\n
    if (bytes + lineBytes > maxBytes) {
      truncated = rows.length - lines.length;
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  return { lines, total: rows.length, truncated };
};

export const searchMemories = (query: string, limit = 10): Memory[] => {
  const db = requireDb("searchMemories");
  const trimmed = query.trim();
  if (trimmed === "") return [];

  // FTS5 MATCH against description+body+name; bm25 ascending = best first.
  // Quote query as a phrase to neutralize FTS5 syntax characters from user input.
  const matchExpr = `"${trimmed.replace(/"/g, '""')}"`;
  const rows = db
    .prepare(
      `SELECT m.id, m.type, m.name, m.description, m.body, m.created_at, m.updated_at
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ?
       ORDER BY bm25(memories_fts)
       LIMIT ?`,
    )
    .all(matchExpr, limit) as MemoryRow[];
  return rows.map(rowToMemory);
};

export const listMemories = (opts?: {
  type?: MemoryType;
  limit?: number;
  orderBy?: "updated" | "created";
}): Memory[] => {
  const db = requireDb("listMemories");
  const limit = opts?.limit ?? 50;
  const orderCol = opts?.orderBy === "created" ? "created_at" : "updated_at";

  if (opts?.type !== undefined) {
    const rows = db
      .prepare(
        `SELECT id, type, name, description, body, created_at, updated_at
         FROM memories WHERE type = ?
         ORDER BY ${orderCol} DESC LIMIT ?`,
      )
      .all(opts.type, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }
  const rows = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories
       ORDER BY ${orderCol} DESC LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
  return rows.map(rowToMemory);
};

// ─── /status revamp: 메모리 총 개수 (contract §3.1) ──────────────────────────
// listMemories 는 limit 디폴트(50) 라 총수 부정확 → 전용 COUNT(*) getter.
export const countMemories = (): number => {
  const db = requireDb("countMemories");
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as {
    n: number;
  };
  return row.n;
};

/**
 * name 이 주어진 SQL LIKE 패턴에 매칭하는 메모리 건수 — *제네릭* 유틸(패턴은 호출자가
 * 결정). maintenance.ts(runMaintenanceScan) 가 '%growth%' 로 self-growth 자동메모리
 * 콜드 누적을 관측(P1 detect 전용, 읽기전용)하는 데 쓴다. 이 store 함수 자체는 어떤
 * 플러그인 이름도 모른다(§0 단방향 — 패턴 문자열은 core 정책 registry 가 데이터로 주입).
 */
export const countMemoriesByNamePattern = (likePattern: string): number => {
  const db = requireDb("countMemoriesByNamePattern");
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM memories WHERE name LIKE ?`)
    .get(likePattern) as { n: number };
  return row.n;
};

/** 관측용 — transcripts 총 건수(콜드 보존, 무한이 정상). maintenance_status 정보 표시. */
export const countTranscripts = (): number => {
  const db = requireDb("countTranscripts");
  const row = db.prepare(`SELECT COUNT(*) AS n FROM transcripts`).get() as {
    n: number;
  };
  return row.n;
};

// ─── §9 V2: transcript search (transcripts_fts) ─────────────────────────────
// V8 통합 — messages 테이블 폐기로 messages_fts 분기 제거. transcripts_fts 전용.
// source 는 "transcripts" 단일이지만 TranscriptHit 소비처(어댑터 prompt 포맷) 호환을
// 위해 필드는 보존.

export interface TranscriptHit {
  source: "transcripts";
  channel?: string;
  threadKey?: string;
  claudeSessionId?: string;
  ts: number;
  role: string;
  content: string;
  score: number;
}

interface TranscriptsHitRow {
  claude_session_id: string;
  ts: number;
  role: string;
  content: string;
  score: number;
}

export const searchTranscripts = (
  query: string,
  opts?: {
    channel?: ChannelName;
    threadKey?: string;
    claudeSessionId?: string;
    limit?: number;
  },
): TranscriptHit[] => {
  const db = requireDb("searchTranscripts");
  const trimmed = query.trim();
  if (trimmed === "") return [];

  const limit = opts?.limit ?? 10;
  const matchExpr = `"${trimmed.replace(/"/g, '""')}"`;
  const hits: TranscriptHit[] = [];

  // transcripts_fts. Filter by claude_session_id (or via transcript_index for channel/threadKey).
  const sql: string[] = [
    `SELECT t.claude_session_id, t.ts, t.role, t.content,
            bm25(transcripts_fts) AS score
       FROM transcripts_fts f
       JOIN transcripts t ON t.id = f.rowid`,
  ];
  const where: string[] = [`transcripts_fts MATCH ?`];
  const params: unknown[] = [matchExpr];

  if (opts?.claudeSessionId !== undefined) {
    where.push(`t.claude_session_id = ?`);
    params.push(opts.claudeSessionId);
  } else if (opts?.channel !== undefined || opts?.threadKey !== undefined) {
    // Restrict to sessions registered in transcript_index matching channel/threadKey.
    sql.push(
      `JOIN transcript_index ti ON ti.claude_session_id = t.claude_session_id`,
    );
    if (opts?.channel !== undefined) {
      where.push(`ti.channel = ?`);
      params.push(opts.channel);
    }
    if (opts?.threadKey !== undefined) {
      where.push(`ti.thread_key = ?`);
      params.push(opts.threadKey);
    }
  }
  sql.push(`WHERE ${where.join(" AND ")}`);
  sql.push(`ORDER BY score LIMIT ?`);
  params.push(limit);
  const rows = db.prepare(sql.join(" ")).all(...params) as TranscriptsHitRow[];
  for (const r of rows) {
    hits.push({
      source: "transcripts",
      claudeSessionId: r.claude_session_id,
      ts: r.ts,
      role: r.role,
      content: r.content,
      score: r.score,
    });
  }

  // Cap to limit (bm25 lower = better; already ORDER BY score).
  return hits.slice(0, limit);
};

// ─── V2: jsonl tail-append catch-up indexing (contract §3) ──────────────────

interface JsonlLineMessage {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  timestamp?: string;
  ts?: number;
}

const flattenContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (block !== null && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
};

const parseJsonlLine = (
  line: string,
): { ts: number; role: string; content: string } | undefined => {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let obj: JsonlLineMessage;
  try {
    obj = JSON.parse(trimmed) as JsonlLineMessage;
  } catch {
    return undefined;
  }
  // SDK jsonl lines vary: {type:'user'|'assistant', message:{role,content}}
  // or flat {role,content}. Be permissive.
  const role = obj.message?.role ?? obj.role ?? obj.type ?? "unknown";
  const rawContent = obj.message?.content ?? obj.content;
  const content = flattenContent(rawContent);
  if (content === "") return undefined;
  const ts =
    typeof obj.ts === "number"
      ? obj.ts
      : typeof obj.timestamp === "string"
        ? Date.parse(obj.timestamp) || Date.now()
        : Date.now();
  return { ts, role, content };
};

/**
 * V5 — 어댑터 무관 transcript INSERT. claude 외 어댑터 (codex-oauth·openai 등) 가
 * 매 turn 응답 직후 호출. claude 는 jsonl catch-up(indexJsonlIfNeeded) 으로 진실 소스
 * 유지 — 중복 방지 위해 claude 어댑터 호출자는 본 함수 사용 X.
 */
export const appendTranscript = (input: {
  claudeSessionId: string;
  role: string;
  content: string;
  ts?: number;
}): void => {
  if (input.content === "") return;
  const db = requireDb("appendTranscript");
  db.prepare(
    `INSERT INTO transcripts (claude_session_id, ts, role, content)
     VALUES (?, ?, ?, ?)`,
  ).run(input.claudeSessionId, input.ts ?? Date.now(), input.role, input.content);
};

export const indexJsonlIfNeeded = (input: {
  channel: ChannelName;
  threadKey: string;
  claudeSessionId: string;
  jsonlPath: string;
}): { lines: number } => {
  const db = requireDb("indexJsonlIfNeeded");
  const { channel, threadKey, claudeSessionId, jsonlPath } = input;

  if (!fs.existsSync(jsonlPath)) return { lines: 0 };

  const idxRow = db
    .prepare(
      `SELECT lines_indexed FROM transcript_index
       WHERE channel = ? AND thread_key = ? AND claude_session_id = ?`,
    )
    .get(channel, threadKey, claudeSessionId) as
    | { lines_indexed: number }
    | undefined;
  const offset = idxRow?.lines_indexed ?? 0;

  // Read whole file, take lines after offset. Catch-up safe if daemon was down
  // for many turns — we always reconcile against current file length.
  const raw = fs.readFileSync(jsonlPath, "utf8");
  const allLines = raw.split(/\r?\n/);
  // Trim trailing empty line from final \n.
  const total = allLines[allLines.length - 1] === "" ? allLines.length - 1 : allLines.length;
  if (total <= offset) return { lines: 0 };

  const insert = db.prepare(
    `INSERT INTO transcripts (claude_session_id, ts, role, content)
     VALUES (?, ?, ?, ?)`,
  );
  const upsertIndex = db.prepare(
    `INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel, thread_key, claude_session_id) DO UPDATE SET
       jsonl_path = excluded.jsonl_path,
       indexed_at = excluded.indexed_at,
       lines_indexed = excluded.lines_indexed`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (let i = offset; i < total; i++) {
      const parsed = parseJsonlLine(allLines[i]!);
      if (parsed === undefined) continue;
      insert.run(claudeSessionId, parsed.ts, parsed.role, parsed.content);
      inserted++;
    }
    upsertIndex.run(channel, threadKey, claudeSessionId, jsonlPath, Date.now(), total);
  });
  tx();

  return { lines: inserted };
};

// ─── §10 V5.1' — Codex input 누적 헬퍼 ──────────────────────────────────────
//
// `previous_response_id` 폐기 (Codex backend `store:false` 강제 정책) 에 따라
// 매 turn 의 prior user/assistant 메시지를 input array 에 누적해 세션 재개.
// OpenClaw `openai-transport-stream.ts` 의 `buildOpenAIResponsesParams` (L802-828)
// + `convertResponsesMessages` (L197-298) 답습 — context.messages 안 prior turn 들이
// `{role, content}` shape 으로 ResponseInput 에 누적되어 server 로 전달됨.
//
// 본 헬퍼는 transcripts 테이블에서 (claude_session_id 또는 channel+threadKey 매칭)
// prior turn 들을 회수 → 단순 `{role, content: string}` array 로 변환해 반환.
// ResponseInput shape 으로의 wrap (`{type: "message", role, content: [{type, text}]}`)
// 은 어댑터 책임 — store 는 raw role+text 만 제공해 ResponseInput shape 정책 변화로부터
// 격리. 시간순(chronological) 정렬 = OpenClaw context.messages 가 들어오는 순서와 동일.

/** §5.6 — turn 갯수 limit 가드. prior turns 20 user + 20 assistant 쌍 ≈ ChatGPT 컨텍스트 윈도. */
export const CODEX_TURN_HISTORY_LIMIT = 40;

export type CodexTurnRole = "user" | "assistant";
export interface CodexTurn {
  role: CodexTurnRole;
  content: string;
}

interface TranscriptHistoryRow {
  role: string;
  content: string;
}

/**
 * V5.1' input 누적 — claudeSessionId 로 transcripts 직접 회수.
 * llm-runtime 어댑터가 prior session(`prior.claudeSessionId`) 을 이미 들고 있을 때 사용.
 *
 * - role 이 "user" / "assistant" 인 row 만 (system/tool 등은 input 누적 대상 아님).
 * - 최신 N row LIMIT 후 reverse 해 chronological 순서로 반환 (Codex 가 input 을 시간순 처리).
 * - 빈 thread / unknown sid → [].
 */
export const loadCodexTurnHistoryBySessionId = (
  claudeSessionId: string,
  opts?: { limitTurns?: number },
): CodexTurn[] => {
  if (claudeSessionId === "") return [];
  const limit = opts?.limitTurns ?? CODEX_TURN_HISTORY_LIMIT;
  if (limit <= 0) return [];
  const db = requireDb("loadCodexTurnHistoryBySessionId");
  // role IN ('user','assistant') — system / tool / 기타는 input 누적 비대상.
  // ORDER BY ts DESC + LIMIT 후 reverse → 가장 최근 N turn 만, chronological.
  const rows = db
    .prepare(
      `SELECT role, content FROM transcripts
       WHERE claude_session_id = ?
         AND role IN ('user', 'assistant')
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(claudeSessionId, limit) as TranscriptHistoryRow[];
  return rows.reverse().map((r) => ({
    role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: r.content,
  }));
};

/**
 * V5.1' input 누적 — (channel, threadKey) 진입점. 사용자 작업지시 시그니처.
 * (1) sessions 테이블에서 claudeSessionId 회수 → (2) transcripts 매칭.
 * - prior session 없음 (첫 turn) → [].
 * - prior 있어도 transcripts 비어있음 → [].
 */
export const loadCodexTurnHistory = (
  channel: ChannelName,
  threadKey: string,
  limit: number = CODEX_TURN_HISTORY_LIMIT,
): CodexTurn[] => {
  const session = getSession(channel, threadKey);
  if (session === undefined) return [];
  return loadCodexTurnHistoryBySessionId(session.claudeSessionId, {
    limitTurns: limit,
  });
};

// ─── Cross-adapter 단일 히스토리 (contract Part B v2 §B-1) ──────────────────
//
// 어댑터 무관 단일 진실 소스. transcript_index 로 (channel, threadKey) 의 모든
// session_id (claude UUID + codex sid) 를 회수 → transcripts 를 IN(…sid) 로 횡단,
// role IN ('user','assistant'), ORDER BY ts ASC 로 codex/claude turn 을 단일 타임라인
// 으로 병합. 반환 shape = loadCodexTurnHistoryBySessionId 와 동일 (CodexTurn[]) →
// 어댑터 wrap 무변경. 키잉 범위만 단일 sid → thread 전체로 확장.
//
// retrieveContext (L309-322) 의 transcript_index JOIN 패턴 재사용 (단 FTS MATCH 대신
// ts 정렬 전체). 기존 loadCodexTurnHistoryBySessionId 는 보존 (회귀/타 호출 안전).

/** charCap 디폴트 — 어댑터 charCap (CODEX_TURN_HISTORY_CHAR_CAP) 와 정합. */
export const CODEX_TURN_HISTORY_CHAR_CAP = 200_000;

interface TranscriptHistoryTsRow {
  role: string;
  content: string;
  ts: number;
  id: number;
}

/**
 * thread 의 전체 대화 (codex turn + claude turn 전부) 를 어댑터 무관 단일 소스로 회수.
 * - transcript_index 에서 (channel, threadKey) 의 모든 claude_session_id 회수.
 * - transcripts WHERE claude_session_id IN (…), role IN ('user','assistant'),
 *   ORDER BY ts ASC, id ASC (turn 인터리브를 시간순 단일 타임라인으로 병합).
 * - limit: 최신 N turn 만 (ts DESC 로 cap 후 chronological 재정렬).
 * - charCap: 최신 turn 부터 역누적, 초과 시 oldest drop.
 * - 빈 thread / 매핑 없음 → [].
 */
export const loadThreadHistory = (
  channel: ChannelName,
  threadKey: string,
  opts?: { limitTurns?: number; charCap?: number },
): CodexTurn[] => {
  const limit = opts?.limitTurns ?? CODEX_TURN_HISTORY_LIMIT;
  if (limit <= 0) return [];
  const charCap = opts?.charCap ?? CODEX_TURN_HISTORY_CHAR_CAP;
  const db = requireDb("loadThreadHistory");

  // thread 의 모든 session_id (claude UUID + codex sentinel sid 전부).
  const sidRows = db
    .prepare(
      `SELECT claude_session_id FROM transcript_index
       WHERE channel = ? AND thread_key = ?`,
    )
    .all(channel, threadKey) as { claude_session_id: string }[];
  if (sidRows.length === 0) return [];

  const placeholders = sidRows.map(() => "?").join(", ");
  const sids = sidRows.map((r) => r.claude_session_id);

  // Context boundary(/reset·/clear) — 리셋 시각 이후 transcript 만. 미설정 → 0 →
  // ts > 0 은 모든 epoch-ms ts 에 참이라 기존 동작(전체) 보존. 단일 enforcement point.
  const boundary = getContextBoundary(channel, threadKey);

  // 횡단 IN(…sid), role 필터, ts ASC 병합. 최신 N turn 만 취하려고 ts DESC LIMIT 후
  // reverse 하는 대신, 전체를 ts ASC 로 받아 tail N 을 취함 (인터리브 정확성 우선).
  const rows = db
    .prepare(
      `SELECT role, content, ts, id FROM transcripts
       WHERE claude_session_id IN (${placeholders})
         AND role IN ('user', 'assistant')
         AND ts > ?
       ORDER BY ts ASC, id ASC`,
    )
    .all(...sids, boundary) as TranscriptHistoryTsRow[];
  if (rows.length === 0) return [];

  // 최신 N turn 만 (tail). limit + charCap 둘 다 최신부터 역누적, 초과 시 oldest drop.
  let charSum = 0;
  const kept: CodexTurn[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (kept.length >= limit) break;
    const r = rows[i]!;
    if (charSum + r.content.length > charCap) break;
    charSum += r.content.length;
    kept.unshift({
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content,
    });
  }
  return kept;
};

// ─── 6b: 롤링 요약 압축용 전체 타임라인 (transcript id 동반) ──────────────────
//
// loadThreadHistory 는 oldest-drop + CodexTurn(role/content only) 를 반환 → 압축
// watermark(어느 turn 까지 요약에 접혔나) 추적 불가. 본 함수는 *압축 결정* 전용으로
// (channel, threadKey) 의 전체 user/assistant 타임라인을 transcript id 동반으로,
// **cap 없이** ts ASC 로 반환한다 (압축이 길이를 묶으므로 무한증가 아님). 어댑터가
// 이 목록에서 [요약 대상 오래된 턴]과 [원문 유지 최근 턴]을 분리한다.
//
// loadThreadHistory 와 동일한 sid 횡단·role 필터·정렬을 공유(타임라인 identity 일치
// — watermark id 가 loadThreadHistory 가 보는 것과 같은 턴을 가리킴).

export interface CodexTurnWithId extends CodexTurn {
  /** transcript id — 압축 watermark(compacted_through) 기준. */
  id: number;
}

/**
 * (channel, threadKey) 전체 user/assistant 타임라인을 id 동반·cap 없이 ts ASC 반환.
 * 압축 결정 전용 (loadThreadHistory 의 입력 재구성과 분리). 빈 thread → [].
 */
export const loadThreadHistoryWithIds = (
  channel: ChannelName,
  threadKey: string,
): CodexTurnWithId[] => {
  const db = requireDb("loadThreadHistoryWithIds");
  const sidRows = db
    .prepare(
      `SELECT claude_session_id FROM transcript_index
       WHERE channel = ? AND thread_key = ?`,
    )
    .all(channel, threadKey) as { claude_session_id: string }[];
  if (sidRows.length === 0) return [];

  const placeholders = sidRows.map(() => "?").join(", ");
  const sids = sidRows.map((r) => r.claude_session_id);

  // Context boundary(/reset·/clear) — loadThreadHistory 와 동일 필터로 타임라인
  // identity 유지(watermark id 가 같은 턴 집합을 가리킴). 미설정 → 0 → 전체 보존.
  const boundary = getContextBoundary(channel, threadKey);

  const rows = db
    .prepare(
      `SELECT role, content, ts, id FROM transcripts
       WHERE claude_session_id IN (${placeholders})
         AND role IN ('user', 'assistant')
         AND ts > ?
       ORDER BY ts ASC, id ASC`,
    )
    .all(...sids, boundary) as TranscriptHistoryTsRow[];
  return rows.map((r) => ({
    id: r.id,
    role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: r.content,
  }));
};

/**
 * codex 직접 INSERT 경로 (llm-runtime persist) 가 transcripts INSERT 후 호출 —
 * transcript_index 에 (channel, threadKey, codex sid) upsert 해 thread→sid 매핑 완성.
 * codex 는 jsonl 이 없으므로 jsonl_path 는 sentinel "(codex)" 사용 (NOT NULL 충족).
 * indexJsonlIfNeeded 의 line-offset catch-up 분기와 무충돌 — sentinel 은 fs.existsSync
 * 대상 아니고 jsonl 재인덱싱 호출 경로에 들어가지 않음.
 * lines_indexed 는 codex 에 무의미 (jsonl 라인 카운트 아님) → 0 고정.
 */
export const CODEX_TRANSCRIPT_INDEX_SENTINEL = "(codex)";

export const indexCodexTurn = (input: {
  channel: ChannelName;
  threadKey: string;
  claudeSessionId: string;
}): void => {
  if (input.claudeSessionId === "") return;
  const db = requireDb("indexCodexTurn");
  db.prepare(
    `INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT (channel, thread_key, claude_session_id) DO UPDATE SET
       indexed_at = excluded.indexed_at`,
  ).run(
    input.channel,
    input.threadKey,
    input.claudeSessionId,
    CODEX_TRANSCRIPT_INDEX_SENTINEL,
    Date.now(),
  );
};
