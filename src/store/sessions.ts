import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ChannelName } from "../channels/types.js";
import { getPaths } from "../core/paths.js";

export interface ThreadSession {
  channel: ChannelName;
  threadKey: string;
  claudeSessionId: string;
  model: string | null;
  systemPromptHash: string | null;
  // /status revamp — 이 thread 마지막 turn 의 토큰 사용량 (표시용, 미측정 turn → null 보존).
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  lastUsedAt: number;
  createdAt: number;
}

interface ThreadRow {
  channel: string;
  channel_thread_id: string;
  claude_session_id: string;
  model: string | null;
  system_prompt_hash: string | null;
  last_input_tokens: number | null;
  last_output_tokens: number | null;
  last_used_at: number;
  created_at: number;
}

interface ColumnInfoRow {
  name: string;
}

let db: Database.Database | null = null;

const requireDb = (caller: string): Database.Database => {
  if (db === null) {
    throw new Error(
      `initStore() must be called before ${caller}() — store is not initialized.`,
    );
  }
  return db;
};

export const getDb = (): Database.Database => requireDb("getDb");

/**
 * V9.2 — DB·brain 의 data 디렉터리 단일 결정 지점.
 *
 * 진실 소스: ADR `docs/decisions/2026-05-24-v9-runtime-home.md`
 *  ("V9.2 DB: sessions.ts → getPaths().data, DATA_DIR 호환분기+migrate").
 *
 * 규칙:
 *  - `DATA_DIR` env 가 **명시적으로** 설정돼 있으면 그 값을 절대경로화해 우선 사용
 *    (기존 사용자의 명시 override 존중 — 절대 깨지 않음).
 *  - 미설정이면 V9.1 `getPaths().data` (= `<TIGUCLAW_HOME>/data`) 사용.
 *
 * 동일 로직을 doctor.ts 가 재사용하도록 export (진단이 실제 경로를 가리키게).
 */
export const resolveDataDir = (): string => {
  const env = process.env.DATA_DIR?.trim();
  if (env !== undefined && env !== "") return path.resolve(env);
  return getPaths().data;
};

// 구 기본 위치 (V9.2 이전). DATA_DIR 미설정으로 새 기본을 쓰게 됐을 때만 migrate 대상.
const LEGACY_DATA_DIR = path.resolve("./data");

/**
 * 구 기본(`./data`) → 새 기본(`getPaths().data`) 1회 마이그레이션 (멱등·안전).
 *
 * 발동 조건 (모두 충족):
 *  - DATA_DIR 미설정 (명시 override 시엔 migrate 안 함).
 *  - 구·새 경로가 서로 다름.
 *  - 구 위치에 `tiguclaw.db` 존재.
 *  - 새 위치에 `tiguclaw.db` **부재** (이미 있으면 절대 덮어쓰지 않고 skip + 로그).
 *
 * better-sqlite3 WAL 동반 파일(`-wal`/`-shm`)과 `brain/` 디렉터리를 함께 옮긴다.
 * 데이터 유실 방지를 위해 copy → 검증 → 원본 제거 순서로 수행하며,
 * 실패 시 throw 하지 않고 console.error 후 빈 새 위치로 진행(데몬 생존 우선).
 */
const migrateLegacyData = (newDir: string): void => {
  // 명시 override 면 migrate 대상 아님.
  const explicit = process.env.DATA_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return;
  // 동일 경로면 no-op.
  if (path.resolve(newDir) === LEGACY_DATA_DIR) return;

  const legacyDb = path.join(LEGACY_DATA_DIR, "tiguclaw.db");
  const newDb = path.join(newDir, "tiguclaw.db");
  if (!fs.existsSync(legacyDb)) return; // 옮길 게 없음.
  if (fs.existsSync(newDb)) {
    console.error(
      `[store] migrate skip: new DB already exists at ${newDb} — leaving legacy ${legacyDb} untouched.`,
    );
    return;
  }

  try {
    fs.mkdirSync(newDir, { recursive: true });
    // 1) DB 본체 + WAL/SHM 동반 파일 copy (copyFile=원자적 per-file).
    const dbCompanions = ["tiguclaw.db", "tiguclaw.db-wal", "tiguclaw.db-shm"];
    for (const name of dbCompanions) {
      const src = path.join(LEGACY_DATA_DIR, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(newDir, name));
      }
    }
    // 2) brain/ 디렉터리 copy (재귀).
    const legacyBrain = path.join(LEGACY_DATA_DIR, "brain");
    if (fs.existsSync(legacyBrain)) {
      fs.cpSync(legacyBrain, path.join(newDir, "brain"), { recursive: true });
    }
    // 3) 검증 — 새 위치에 DB 본체가 안착했는지 확인 후 원본 제거.
    if (!fs.existsSync(newDb)) {
      throw new Error(`copy verification failed — ${newDb} missing after copy`);
    }
    for (const name of dbCompanions) {
      fs.rmSync(path.join(LEGACY_DATA_DIR, name), { force: true });
    }
    fs.rmSync(legacyBrain, { recursive: true, force: true });
    console.error(
      `[store] migrated data from ${LEGACY_DATA_DIR} → ${newDir} (V9.2).`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[store] migrate failed (${msg}) — continuing with empty new data dir ${newDir}.`,
    );
  }
};

export const initStore = (): void => {
  if (db !== null) return;

  const resolvedDir = resolveDataDir();
  migrateLegacyData(resolvedDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  fs.mkdirSync(path.join(resolvedDir, "brain"), { recursive: true });

  const file = path.join(resolvedDir, "tiguclaw.db");
  const handle = new Database(file);
  handle.pragma("journal_mode = WAL");

  handle.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      channel             TEXT NOT NULL,
      channel_thread_id   TEXT NOT NULL,
      claude_session_id   TEXT NOT NULL,
      model               TEXT,
      last_used_at        INTEGER NOT NULL,
      created_at          INTEGER NOT NULL,
      PRIMARY KEY (channel, channel_thread_id)
    );
  `);

  // ─── V8 영역 통합: messages 테이블·FTS·트리거 폐기 (멱등 DROP) ──────────
  // region B(stateless) turn 만 들던 테이블. region A 는 transcripts 로 연속성
  // 보장 → messages 폐기 시 데이터 손실 의미 없음. 기존 배포 DB 대비 idempotent
  // DROP. 순서 = 트리거 → fts(가상 테이블) → base. DROP TRIGGER/TABLE IF EXISTS 는
  // 대상 부재 시 no-op 이라 신규 DB·여러 번 부팅 모두 안전.
  dropLegacyMessages(handle);

  // Idempotent migration: threads.system_prompt_hash (SQLite has no
  // ALTER TABLE ADD COLUMN IF NOT EXISTS, so probe pragma first).
  const cols = handle
    .prepare(`PRAGMA table_info(threads)`)
    .all() as ColumnInfoRow[];
  const hasHashCol = cols.some((c) => c.name === "system_prompt_hash");
  if (!hasHashCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN system_prompt_hash TEXT`);
  }

  // ─── /status revamp: threads usage 컬럼 (idempotent ALTER) ───────────────
  // system_prompt_hash 패턴 동형 — PRAGMA probe 후 미존재 시 ADD COLUMN.
  // nullable INTEGER (미측정 turn → NULL, saveSession 가 NULL clobber 방지).
  // 신규 DB: threads CREATE 직후 cols probe 에 없음 → ADD. 반복 부팅: 이미 존재 → skip.
  const hasInputTokensCol = cols.some((c) => c.name === "last_input_tokens");
  if (!hasInputTokensCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN last_input_tokens INTEGER`);
  }
  const hasOutputTokensCol = cols.some((c) => c.name === "last_output_tokens");
  if (!hasOutputTokensCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN last_output_tokens INTEGER`);
  }

  // ─── Memory V1: typed memories + FTS5 (contract §2) ─────────────────────
  handle.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
      name        TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name, description, body,
      content='memories', content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, description, body)
      VALUES (new.id, new.name, new.description, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, body)
      VALUES ('delete', old.id, old.name, old.description, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, body)
      VALUES ('delete', old.id, old.name, old.description, old.body);
      INSERT INTO memories_fts(rowid, name, description, body)
      VALUES (new.id, new.name, new.description, new.body);
    END;
  `);

  // ─── V8: messages_fts 도 dropLegacyMessages 에서 함께 폐기됨 (위 참조). ──

  // ─── Memory V2b: transcripts (jsonl ingest) + FTS5 ──────────────────────
  handle.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      claude_session_id TEXT NOT NULL,
      ts                INTEGER NOT NULL,
      role              TEXT NOT NULL,
      content           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcripts_sid_ts
      ON transcripts(claude_session_id, ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
      content, role,
      content='transcripts', content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
      INSERT INTO transcripts_fts(rowid, content, role)
      VALUES (new.id, new.content, new.role);
    END;
    CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, content, role)
      VALUES ('delete', old.id, old.content, old.role);
    END;
    CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, content, role)
      VALUES ('delete', old.id, old.content, old.role);
      INSERT INTO transcripts_fts(rowid, content, role)
      VALUES (new.id, new.content, new.role);
    END;

    CREATE TABLE IF NOT EXISTS transcript_index (
      channel             TEXT NOT NULL,
      thread_key          TEXT NOT NULL,
      claude_session_id   TEXT NOT NULL,
      jsonl_path          TEXT NOT NULL,
      indexed_at          INTEGER NOT NULL,
      lines_indexed       INTEGER NOT NULL,
      PRIMARY KEY (channel, thread_key, claude_session_id)
    );
  `);

  // ─── Memory V2.5: trigram tokenizer migration (contract §3.3) ───────────
  // FTS5 가상 테이블의 tokenizer 는 ALTER 불가 → DROP/RECREATE.
  // idempotency: sqlite_master.sql 에 tokenize='trigram' 포함 시 스킵.
  // 기반 테이블(memories/messages/transcripts) 과 트리거는 무수정.
  migrateFtsToTrigram(handle);

  // ─── Dashboard V2: bridge_tokens (contract §1.Q1) ───────────────────────
  // per-plugin token + role + expiry + revocation. token_hash 만 저장.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS bridge_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash    TEXT NOT NULL UNIQUE,
      label         TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('read','write','admin')),
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER,
      revoked_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_tokens_active
      ON bridge_tokens(revoked_at, expires_at);
  `);

  // ─── Scheduler v1: schedules (contract §2) ──────────────────────────────
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      label           TEXT NOT NULL,
      cron_expr       TEXT NOT NULL,
      timezone        TEXT NOT NULL DEFAULT 'Asia/Seoul',
      prompt          TEXT NOT NULL,
      dest_channel    TEXT NOT NULL,
      dest_target     TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_fired_at   INTEGER,
      last_status     TEXT,
      last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
  `);

  // ─── Scheduler v1.1: schedules.trigger_type (reboot trigger) ────────────
  // Idempotent ALTER TABLE ADD COLUMN — system_prompt_hash 패턴 동형.
  // 기존 row 는 DEFAULT 'cron' 으로 채워져 v1 회귀 0.
  const schedCols = handle
    .prepare(`PRAGMA table_info(schedules)`)
    .all() as ColumnInfoRow[];
  const hasTriggerType = schedCols.some((c) => c.name === "trigger_type");
  if (!hasTriggerType) {
    handle.exec(
      `ALTER TABLE schedules ADD COLUMN trigger_type TEXT NOT NULL
         DEFAULT 'cron' CHECK(trigger_type IN ('cron','reboot'))`,
    );
  }

  // ─── file-watch trigger v1: watches (contract §3) ───────────────────────
  handle.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      label           TEXT NOT NULL,
      path            TEXT NOT NULL,
      pattern         TEXT,
      recursive       INTEGER NOT NULL DEFAULT 1,
      debounce_ms     INTEGER NOT NULL DEFAULT 500,
      event_filter    TEXT NOT NULL DEFAULT 'all',
      prompt          TEXT NOT NULL,
      dest_channel    TEXT NOT NULL,
      dest_target     TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_fired_at   INTEGER,
      last_path       TEXT,
      last_event      TEXT,
      last_status     TEXT,
      last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_watches_enabled ON watches(enabled);
  `);

  // ─── /model V1: per-session model override (Claude Code 슈퍼셋 — 2026-05-28) ──
  // 사용자가 채널에서 `/model <provider:model>` 로 메인 turn 모델을 세션별로 override.
  // `threads` 와 *분리된* 테이블 → `/reset` 가 영향 0 (threads 만 DELETE). 사용자 명시
  // `/model reset` 만 override 해제. 키 = (channel, thread_key) — Claude Code 의
  // 세션 단위 모델 선택 답습. 결정노트 2026-05-27-region-unification §gap "메인 모델
  // 동적 전환" 의 사용자-driven 갈래.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS session_model_override (
      channel     TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      model_spec  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (channel, thread_key)
    );
  `);

  db = handle;
};

interface FtsMasterRow {
  sql: string | null;
}

const ftsHasTrigram = (
  handle: Database.Database,
  table: string,
): boolean | undefined => {
  const row = handle
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as FtsMasterRow | undefined;
  if (row === undefined || row.sql === null) return undefined;
  return (
    row.sql.includes("tokenize='trigram'") ||
    row.sql.includes('tokenize="trigram"')
  );
};

/**
 * V8 영역 통합 — 폐기된 `messages` 테이블·`messages_fts`(가상)·관련 트리거를
 * 멱등 DROP. region B(stateless) turn 만 들던 표면이라 데이터 손실 의미 없음
 * (region A 연속성은 transcripts 가 보장).
 *
 * 멱등성 근거: 모든 DROP 이 `IF EXISTS` → 신규 DB(대상 부재)·여러 번 부팅(이미
 * 삭제됨) 모두 no-op 으로 안전. DROP 순서는 트리거 → fts 가상 테이블 → base 로
 * 의존 역순(트리거가 messages_fts/messages 를 참조, messages_fts 가 messages 를
 * content 테이블로 참조)이라 dangling reference 없이 깨끗이 제거된다.
 */
const dropLegacyMessages = (handle: Database.Database): void => {
  handle.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS messages;
  `);
};

const migrateFtsToTrigram = (handle: Database.Database): void => {
  // memories_fts
  const memState = ftsHasTrigram(handle, "memories_fts");
  if (memState === false) {
    handle.exec(`
      DROP TABLE memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        name, description, body,
        content='memories', content_rowid='id',
        tokenize='trigram'
      );
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);
  }

  // V8 — messages_fts trigram 마이그레이션 분기 제거 (messages 테이블 폐기).

  // transcripts_fts
  const transState = ftsHasTrigram(handle, "transcripts_fts");
  if (transState === false) {
    handle.exec(`
      DROP TABLE transcripts_fts;
      CREATE VIRTUAL TABLE transcripts_fts USING fts5(
        content, role,
        content='transcripts', content_rowid='id',
        tokenize='trigram'
      );
      INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild');
    `);
  }
};

export const getSession = (
  channel: ChannelName,
  threadKey: string,
): ThreadSession | undefined => {
  const handle = requireDb("getSession");
  const row = handle
    .prepare(
      `SELECT channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_input_tokens, last_output_tokens, last_used_at, created_at
       FROM threads
       WHERE channel = ? AND channel_thread_id = ?`,
    )
    .get(channel, threadKey) as ThreadRow | undefined;

  if (row === undefined) return undefined;

  return {
    channel: row.channel as ChannelName,
    threadKey: row.channel_thread_id,
    claudeSessionId: row.claude_session_id,
    model: row.model,
    systemPromptHash: row.system_prompt_hash,
    lastInputTokens: row.last_input_tokens,
    lastOutputTokens: row.last_output_tokens,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
};

export const saveSession = (input: {
  channel: ChannelName;
  threadKey: string;
  claudeSessionId: string;
  model: string | null;
  // V5 — 어댑터별 nullable (claude 어댑터 = SYSTEM_PROMPT_HASH, 다른 어댑터 = null).
  systemPromptHash: string | null;
  // B-5 cross-adapter clobber 해소 — true 면 claude_session_id/system_prompt_hash 를
  // 보존하고 model/last_used_at 만 갱신 (codex turn 이 claude resume sid 를 덮지 않음).
  // 행이 아직 없으면 신규 INSERT 는 입력값으로 생성 (codex-only thread 도 관측 가능).
  preserveSessionId?: boolean;
  // /status revamp — 이 turn 의 토큰 사용량 (표시용). optional → 기존 호출부 회귀 0.
  // NULL-clobber 가드: undefined 면 UPDATE SET 절에서 제외 (usage 미캡처 turn 이 기존
  //   측정값을 NULL 로 덮지 않게). 값(0 포함) 있으면 갱신. 둘 다 INSERT 시엔 ?? null.
  lastInputTokens?: number | null;
  lastOutputTokens?: number | null;
}): void => {
  const handle = requireDb("saveSession");
  const now = Date.now();

  // usage 캡처 여부 — undefined 면 UPDATE SET 에서 제외 (NULL clobber 방지).
  // INSERT 시엔 값/`null` 둘 다 NULL 로 들어가도 무방 (신규 row 엔 기존값 없음).
  const captureUsage =
    input.lastInputTokens !== undefined || input.lastOutputTokens !== undefined;
  const inputTokens = input.lastInputTokens ?? null;
  const outputTokens = input.lastOutputTokens ?? null;

  // UPDATE SET 절 — usage 캡처 turn 일 때만 두 컬럼 포함 (미캡처는 기존값 보존).
  const usageSet = captureUsage
    ? `,
           last_input_tokens = excluded.last_input_tokens,
           last_output_tokens = excluded.last_output_tokens`
    : ``;

  if (input.preserveSessionId === true) {
    // 기존 행이 있으면 claude_session_id / system_prompt_hash 무변경, model+last_used_at(+usage) 만 갱신.
    // 없으면 입력값으로 신규 생성 (이후 claude turn 이 들어와도 resume sid 를 따로 세팅).
    handle
      .prepare(
        `INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_input_tokens, last_output_tokens, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, channel_thread_id) DO UPDATE SET
           model = excluded.model,
           last_used_at = excluded.last_used_at${usageSet}`,
      )
      .run(
        input.channel,
        input.threadKey,
        input.claudeSessionId,
        input.model,
        input.systemPromptHash,
        inputTokens,
        outputTokens,
        now,
        now,
      );
    return;
  }

  handle
    .prepare(
      `INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_input_tokens, last_output_tokens, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, channel_thread_id) DO UPDATE SET
         claude_session_id = excluded.claude_session_id,
         model = excluded.model,
         system_prompt_hash = excluded.system_prompt_hash,
         last_used_at = excluded.last_used_at${usageSet}`,
    )
    .run(
      input.channel,
      input.threadKey,
      input.claudeSessionId,
      input.model,
      input.systemPromptHash,
      inputTokens,
      outputTokens,
      now,
      now,
    );
};

export const deleteSession = (
  channel: ChannelName,
  threadKey: string,
): boolean => {
  const handle = requireDb("deleteSession");
  const result = handle
    .prepare(
      `DELETE FROM threads WHERE channel = ? AND channel_thread_id = ?`,
    )
    .run(channel, threadKey);
  // `/reset` 의미 = "이 세션의 모든 상태 초기화" — model override 도 함께 클리어.
  // 별도 보존 정책 안 둠 (사용자 결정 2026-05-28). 명시 `/model reset` 와 동일 효과.
  handle
    .prepare(
      `DELETE FROM session_model_override WHERE channel = ? AND thread_key = ?`,
    )
    .run(channel, threadKey);
  return result.changes > 0;
};

// ─── /model V1: session_model_override helpers ────────────────────────────
// 세션별 메인 모델 override. `threads` 와 분리 → `/reset` 무영향. 키는 thread 와
// 동일(channel, thread_key) 라 같은 채널+스레드에서 ad-hoc 모델 선택이 컨텍스트
// (resume sid)와 정합. 폴백 chain: 세션 override → REGION_A_MODELS env → 디폴트.

export const getSessionModelOverride = (
  channel: ChannelName,
  threadKey: string,
): string | null => {
  const handle = requireDb("getSessionModelOverride");
  const row = handle
    .prepare(
      `SELECT model_spec FROM session_model_override
       WHERE channel = ? AND thread_key = ?`,
    )
    .get(channel, threadKey) as { model_spec: string } | undefined;
  return row?.model_spec ?? null;
};

export const setSessionModelOverride = (
  channel: ChannelName,
  threadKey: string,
  modelSpec: string,
): void => {
  const handle = requireDb("setSessionModelOverride");
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO session_model_override (channel, thread_key, model_spec, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel, thread_key) DO UPDATE SET
         model_spec = excluded.model_spec,
         updated_at = excluded.updated_at`,
    )
    .run(channel, threadKey, modelSpec, now);
};

export const clearSessionModelOverride = (
  channel: ChannelName,
  threadKey: string,
): boolean => {
  const handle = requireDb("clearSessionModelOverride");
  const result = handle
    .prepare(
      `DELETE FROM session_model_override
       WHERE channel = ? AND thread_key = ?`,
    )
    .run(channel, threadKey);
  return result.changes > 0;
};
