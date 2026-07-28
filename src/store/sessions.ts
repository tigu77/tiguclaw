import fs from "node:fs";
import { extractTelegramChatId, DEFAULT_SESSION_ID } from "../core/threadkey.js";
import path from "node:path";
import Database from "better-sqlite3";
import type { ChannelName } from "../channels/types.js";
import { getPaths } from "../core/paths.js";

/**
 * ★세션-정체성 저장 채널 (canonical) — 채널/세션 분리 Phase 1
 * (ADR `docs/decisions/2026-07-15-channel-session-decoupling.md` §D1/§D4, 급소).
 *
 * 세션-정체성 테이블(`threads`·`transcript_index`·`context_boundaries`·
 * `session_model_override`)은 현재 **(channel, threadKey) 복합키**다. 세션이 채널
 * 무관(#4)이 되려면 이 저장 채널이 **인입 채널이 아니라 세션의 함수(=상수)** 여야 한다.
 *
 * ★값 = 기존 `dashboard:default` 세션 행들이 만들어진 채널값(`"http-bridge"`). 셀렉터
 * 없는 채널(telegram·cli·http default) 인입이 `DEFAULT_SESSION_ID`(=`dashboard:default`)
 * 로 수렴할 때, 세션-정체성을 이 **canonical 채널**로 read/write 해야 기존 대시보드 기본
 * 세션의 resume(claude_session_id)/transcripts 를 **마이그레이션 0 으로 계승**한다.
 * 인입 채널(telegram)로 저장하면 기존 `("http-bridge","dashboard:default")` 행과 **다른
 * 행**이 되어 파편화·resume 미계승 → 이 상수가 그걸 막는다.
 *
 * ★§0 단방향 불변식: 이 canonical 규칙은 **store 레이어가 소유**한다(core 는 채널명을
 * 특수 참조하지 않는다). core(route/adapter)는 이 상수를 opaque 하게 import 해 "세션-정체성
 * 저장 채널" 로만 쓰고, 채널 정체성으로 분기하지 않는다. 이 문자열은 core 가 "http-bridge"
 * 채널을 아는 게 아니라 *마이그레이션 0* 을 위해 승계하는 레거시 물리 키다. Phase 2 에서
 * PK 가 sessionId 단독으로 축소되면 이 값은 순수 내부 관습이 된다.
 *
 * ★표시/감사는 분리: 실제 인입 채널·주소는 `setSessionChannelMeta`(last_channel/target)와
 * chat_log/activity 의 **실채널**로 유지된다(대시보드가 "텔레그램 경유" 를 알게). 즉
 * 세션-정체성=canonical, 표시/감사=실채널의 2분리(급소).
 */
export const SESSION_STORAGE_CHANNEL: ChannelName = "http-bridge";

export interface ThreadSession {
  channel: ChannelName;
  threadKey: string;
  claudeSessionId: string;
  model: string | null;
  systemPromptHash: string | null;
  // /status revamp — 이 thread 마지막 turn 의 토큰 사용량 (표시용, 미측정 turn → null 보존).
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  // 채널/세션 분리(ADR 2026-07-15 §D3) — 이 세션의 마지막 인입 채널+주소(비동기 outbound
  // 기본 목적지). 미캡처(기존 row·셀렉터 없는 인입 웨이브2 전) → null.
  lastChannel: ChannelName | null;
  lastChannelTarget: string | null;
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
  last_channel: string | null;
  last_channel_target: string | null;
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

  // ─── 채널/세션 분리: threads.last_channel / last_channel_target (ADR 2026-07-15 §D3) ──
  // 세션은 채널 무관이지만, 비동기 outbound(워커 완료·능동발신)의 **기본 목적지**는
  // 세션의 *마지막 인입 채널+주소* 다. 채널 주소를 세션 id 에서 파싱하지 않고(=폐지 대상)
  // 인입 턴 저장 시 **캡처**해 여기 경량 메타로 둔다(§D3). generic 데이터(채널명·주소) —
  // 코어는 이 값으로 채널 정체성을 분기하지 않는다(§0 단방향). 둘 다 nullable → 미기록
  // (기존 row·미캡처 인입)이면 호출부가 getMostRecentTelegramChatId 등으로 폴백(회귀 0).
  // system_prompt_hash/last_*_tokens 패턴 동형(idempotent probe+ADD). 실제 setter 호출은
  // region/daemon 웨이브2가 채운다 — store 는 스키마 + setSessionChannelMeta 만 제공.
  // 신규 DB: threads CREATE 직후 cols probe 에 없음 → ADD. 반복 부팅: 이미 존재 → skip.
  const hasLastChannelCol = cols.some((c) => c.name === "last_channel");
  if (!hasLastChannelCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN last_channel TEXT`);
  }
  const hasLastChannelTargetCol = cols.some(
    (c) => c.name === "last_channel_target",
  );
  if (!hasLastChannelTargetCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN last_channel_target TEXT`);
  }

  // ─── 세션 커스텀 이름: threads.name (idempotent ALTER, 채널/세션 탭 계약 §1) ──
  // nullable TEXT. 미지정(기존 row·미명명) = NULL = 대시보드 파생 폴백(프리뷰/채널/세션N).
  // threadKey(channel_thread_id) 로만 키잉되는 채널무관 세션 1:1 속성 — system_prompt_hash/
  // last_channel 과 동형 패턴. 신규 DB: CREATE 직후 probe 에 없음 → ADD. 반복 부팅: skip.
  const hasNameCol = cols.some((c) => c.name === "name");
  if (!hasNameCol) {
    handle.exec(`ALTER TABLE threads ADD COLUMN name TEXT`);
  }

  // ─── Memory V1: typed memories + FTS5 (contract §2) ─────────────────────
  handle.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
      name          TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL,
      body          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER,
      archived_at   INTEGER
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
    -- ★UPDATE OF 로 좁힌다 (2026-07-28). 종전엔 컬럼 제한 없는 AFTER UPDATE 라 **모든**
    -- UPDATE 에 반응했고, 조회 때마다 도는 bumpAccess(access_count/last_accessed 갱신)가
    -- 매번 FTS 삭제+재삽입을 일으켰다 → memories_fts_data 가 원본의 11배(실측 1.76MB
    -- vs 156KB). 색인 대상 3컬럼이 바뀔 때만 재색인하면 된다. 기존 DB 는 아래 마이그레이션.
    CREATE TRIGGER IF NOT EXISTS memories_au
      AFTER UPDATE OF name, description, body ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, body)
      VALUES ('delete', old.id, old.name, old.description, old.body);
      INSERT INTO memories_fts(rowid, name, description, body)
      VALUES (new.id, new.name, new.description, new.body);
    END;
  `);

  // ─── memories_au 범위 축소 마이그레이션 (2026-07-28) ─────────────────────
  // `CREATE TRIGGER IF NOT EXISTS` 는 이미 있는 트리거를 갱신하지 않으므로, 구 정의
  // (UPDATE OF 없음)를 감지해 교체한다. 교체 후 rebuild 로 그동안 쌓인 중복 색인을
  // 회수한다(external content FTS5 라 원본에서 무손실 재구성 — 데이터 삭제 아님).
  // 멱등: 이미 좁혀져 있으면 probe 만 하고 끝(부팅 비용 무시).
  const memAuSql = handle
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'`,
    )
    .get() as { sql?: string } | undefined;
  if (
    memAuSql?.sql !== undefined &&
    !/UPDATE\s+OF/i.test(memAuSql.sql)
  ) {
    handle.exec(`
      DROP TRIGGER memories_au;
      CREATE TRIGGER memories_au
        AFTER UPDATE OF name, description, body ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, name, description, body)
        VALUES ('delete', old.id, old.name, old.description, old.body);
        INSERT INTO memories_fts(rowid, name, description, body)
        VALUES (new.id, new.name, new.description, new.body);
      END;
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);
    console.log(
      "store: memories_au 트리거 범위 축소(UPDATE OF name/description/body) + FTS 재구축",
    );
  }

  // ─── Memory 인덱스 티어링 P0: access_count/last_accessed/archived_at
  // idempotent ALTER 가드 (효율감사 P2a 계약 §0.1/§3.1, 2026-07-16) ──────────
  // 라이브 dev DB 는 이미 out-of-band ALTER 로 세 컬럼 보유(신규 CREATE 문 무영향
  // — IF NOT EXISTS). 신규 DB(설치·타 인스턴스·테스트)는 위 CREATE TABLE 에 이미
  // 세 컬럼이 있어 여기서도 no-op. 이 가드는 **과거에 이미 배포된, CREATE 문에
  // 컬럼이 없던 버전으로 만들어진 DB**(라이브 dev DB 포함— 그쪽은 실제로 out-of-band
  // 였을 수도, 혹은 아직 컬럼이 전혀 없을 수도 있음 — 확실히 하기 위해 항상 probe)를
  // 위한 안전망. system_prompt_hash 패턴 동형(PRAGMA table_info probe 후 부재 시 ADD).
  const memCols = handle
    .prepare(`PRAGMA table_info(memories)`)
    .all() as ColumnInfoRow[];
  if (!memCols.some((c) => c.name === "access_count")) {
    handle.exec(
      `ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!memCols.some((c) => c.name === "last_accessed")) {
    handle.exec(`ALTER TABLE memories ADD COLUMN last_accessed INTEGER`);
  }
  if (!memCols.some((c) => c.name === "archived_at")) {
    handle.exec(`ALTER TABLE memories ADD COLUMN archived_at INTEGER`);
  }
  // 핫 쿼리 커버 인덱스(계약 §3.1 선택 권고) — listMemoriesForIndex 의
  // WHERE archived_at IS NULL ORDER BY updated_at DESC 를 커버. 132행엔 성능상
  // 불필요하나 정합상 저비용 추가(CREATE INDEX IF NOT EXISTS 멱등).
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_memories_live ON memories(archived_at, updated_at)`,
  );

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

  // ─── 백그라운드 워커 잡 영속 (메타만 — 재시작 정직 통지용, 2026-06-19) ─────────
  // 런타임 진실 소스는 core/worker-jobs.ts 의 in-memory Map(핫패스 무변경). 이 테이블은
  // *재시작 생존*만 담당 — 부팅 시 status='running' 잔류 = 그 잡을 돌던 프로세스가 죽었음
  // → 중단으로 보고. result/error 본문은 비영속(option b: 메타 영속 + 정직 통지, 풀 재개 아님).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS worker_jobs (
      job_id          TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      thread_key      TEXT NOT NULL,
      channel         TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      status          TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);
  `);

  // ─── 워커 통지 dest threading: worker_jobs.notify_channel/notify_target ────
  // Idempotent ALTER TABLE ADD COLUMN — schedules.trigger_type 패턴 동형.
  // generic 통지 좌표(채널 무관 데이터) 영속 — 스케줄 발화 워커가 재시작 후에도
  // 올바른 telegram chatId 등으로 완료/실패 통지 도달하게. NULL 허용 = 미지정(=기존
  // 텔레그램 직접 발화 워커)이면 core 폴백(job.channel/threadKey)으로 회귀 0.
  // 신규 DB: CREATE 직후 probe 에 없음 → ADD. 반복 부팅: 이미 존재 → skip.
  const wjCols = handle
    .prepare(`PRAGMA table_info(worker_jobs)`)
    .all() as ColumnInfoRow[];
  if (!wjCols.some((c) => c.name === "notify_channel")) {
    handle.exec(`ALTER TABLE worker_jobs ADD COLUMN notify_channel TEXT`);
  }
  if (!wjCols.some((c) => c.name === "notify_target")) {
    handle.exec(`ALTER TABLE worker_jobs ADD COLUMN notify_target TEXT`);
  }

  // ─── 서브·워커 통합: worker_jobs.kind/agent_name (2026-07-03, ADR subagent-worker-unify) ──
  // 잡 관측 체계를 워커+서브에이전트 공용으로 통합. kind='worker'(detached, run_in_background)
  // | 'agent'(awaited 서브에이전트). agent_name = 서브에이전트 정의 이름(대시보드 라벨). NULL
  // 허용 + DEFAULT 'worker' → 기존 워커 레코드 100% 호환(재시작 복구 시 kind 없으면 worker).
  // notify_channel 패턴 동형(idempotent probe+ADD). awaited 는 별 컬럼 아닌 kind==='agent' 파생.
  if (!wjCols.some((c) => c.name === "kind")) {
    handle.exec(
      `ALTER TABLE worker_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'`,
    );
  }
  if (!wjCols.some((c) => c.name === "agent_name")) {
    handle.exec(`ALTER TABLE worker_jobs ADD COLUMN agent_name TEXT`);
  }

  // ─── 프로젝트 레지스트리 인덱스 (2026-07-06, ADR projects-feature) ──────────────
  // 등록된 프로젝트 경로 조회 캐시. ★진실은 각 폴더 <path>/PROJECT.md — 이 테이블은
  // 대시보드/조회용 인덱스일 뿐(self-growth SELF_GROWTH.md+SQLite 하이브리드 동형).
  // 코어는 프로젝트를 데이터 스키마로만 앎(파일 진실 참조 0, 단방향). CREATE IF NOT EXISTS 멱등.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL,
      description   TEXT,
      registered_at INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
  `);

  // ─── 관측 이벤트 영속 (감사·메트릭 — 2026-06-19) ──────────────────────────────
  // EventBus 는 비영속 ring buffer(hot cache)뿐 — 재시작 시 이력 소실. 이 테이블은
  // *의미있는* 이벤트(에러·발화·lifecycle·memory.write 등; 고volume 스트리밍/본문 제외)를
  // 영속해 감사(누가/언제/무슨 일)와 메트릭 기반을 만든다. core/event-persist.ts 의
  // 단일 subscriber 가 기록(publish() 무수정 — 데이터로 확장). 보존 한도로 무한증가 방지.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
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

  // ─── 세션 모델 *프로파일* 선택 (대시보드 드롭다운, 2026-07-19, ADR
  //     _workspace/model-dropdown_architect_contract.md §1) ────────────────────
  // session_model_override(raw specs)의 *mirror* 별 테이블. 저장값 = **프로파일 이름**만
  // (constraint 3: raw model id 미노출). 코어(router)가 resolveProfileChain 으로 이름을
  // 해석(constraint 1). override 와 분리된 별 테이블이라 서로 clobber 0 이고, 세션
  // clear/reset(deleteSession)의 override DELETE 에 **의도적으로 포함하지 않는다** —
  // 프로파일 선택은 대화 리셋을 가로질러 sticky(durable UI 선호, 계약 §2).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS session_model_profile (
      channel      TEXT NOT NULL,
      thread_key   TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (channel, thread_key)
    );
    -- ─── 채널→세션 바인딩 (2026-07-28, ADR channel-session-decoupling §D5 확장점 (b)) ──
    -- 세션 셀렉터가 없는 채널(텔레그램·CLI)이 "이 대화방은 이 세션" 을 **영속**으로 기억한다.
    -- 대시보드 탭은 브라우저 localStorage 라 그 브라우저에서만 유지되는데, 이쪽은 서버라
    -- 재시작·기기교체와 무관하게 유지된다. 키 = (채널, 채널주소) — 같은 사람이라도 DM 과
    -- 그룹은 다른 대화방이므로 각각 따로 묶인다(사용자 확정 2026-07-28).
    -- 행이 없으면 = 바인딩 없음 = 기본 세션(기존 동작 그대로, 회귀 0).
    CREATE TABLE IF NOT EXISTS channel_session_binding (
      channel         TEXT NOT NULL,
      channel_address TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (channel, channel_address)
    );
  `);

  // ─── 스킬 사용 텔레메트리 (self-growth Phase 1.5, 2026-06-24) ────────────────
  // events(ring 10k prune)는 *장기* 스킬 카운트 부적합(오래된 호출 잘림) → 전용 누적
  // 테이블. self-growth 가 generic skill.invoked 구독 시 멱등 upsert(count+1, last_used
  // 갱신). 코어는 이 테이블을 모름(단방향 — 코어에 skill_usage 문자열 0). 기존
  // CREATE TABLE IF NOT EXISTS 들과 동형 멱등(신규 테이블이라 IF NOT EXISTS 로 충분 —
  // ALTER 로직 0). 역할 분리: 시점 상관=events / 장기 누적 카운트=skill_usage.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      skill_name   TEXT PRIMARY KEY,
      invoke_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL
    );
  `);

  // ─── 스킬 결과 축 (self-growth Phase 1.6, 2026-06-24) ──────────────────────────
  // Phase 1.5 의 invoke_count 위에 *성공/실패* 누적을 더한다 — "이 스킬 자꾸 실패한다"를
  // 계산 가능하게(Phase 2 스킬 개선 제안의 연료). skill_usage 는 1.5 에서 이미 배포됐으니
  // 멱등 ALTER ADD COLUMN(schedules.trigger_type / worker_jobs.notify_* 패턴 동형) —
  // PRAGMA table_info probe 후 부재 시만 추가. DEFAULT 0 으로 기존 row 회귀 0.
  // 결과는 forward-fill(그 순간 안 잡으면 복원 불가)이라 지금 누적 시작.
  const skillUsageCols = handle
    .prepare(`PRAGMA table_info(skill_usage)`)
    .all() as ColumnInfoRow[];
  if (!skillUsageCols.some((c) => c.name === "success_count")) {
    handle.exec(
      `ALTER TABLE skill_usage ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!skillUsageCols.some((c) => c.name === "fail_count")) {
    handle.exec(
      `ALTER TABLE skill_usage ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // ─── 6b: codex 대화 히스토리 롤링 요약 압축 (architect contract §6b, 2026-06-19) ──
  // codex(ChatGPT 비공식 백엔드)는 resume API 가 없어 매 턴 전체 히스토리를 input[]
  // 으로 재전송한다. loadThreadHistory 의 oldest-drop(상한 초과 시 버림)이 긴 대화의
  // 초반 맥락을 통째 소실 → 버리는 대신 오래된 턴을 요약 1덩어리로 압축해 보존한다.
  // claude 는 SDK resume+자동 compaction 이라 무관 → 이 테이블은 codex 한정(LLM-agnostic
  // #2: codex 결함을 codex 안에서 닫음). thread_key = 어댑터 무관 단일 히스토리 키
  // (transcript_index.thread_key 와 동일 의미). compacted_through = 요약에 접힌 마지막
  // transcript id (loadThreadHistory 의 ts ASC, id ASC 타임라인 기준 watermark).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS thread_summaries (
      thread_key        TEXT PRIMARY KEY,
      summary           TEXT NOT NULL,
      compacted_through INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);

  // ─── Context boundary watermark (/reset·/clear P0, 2026-07-10) ──────────────
  // 리셋 = 삭제 아니라 경계선. threadKey 별 boundary_ts(epoch ms) 이후 transcript 만
  // loadThreadHistory·loadThreadHistoryWithIds 가 반환 → codex/openai 가 과거 턴을
  // 재주입하던 P0 버그를 단일 enforcement point 로 차단(3어댑터 parity, claude
  // foreign-delta 도 이 함수 경유라 자동 상속). transcripts 는 물리 보존(FTS 검색·
  // 대시보드 chat_log 이력 유지). ★전용 테이블인 이유: claude 리셋의 deleteSession 이
  // `threads` 행을 지우므로 boundary 를 거기 두면 함께 소실 → boundary 는 리셋을
  // *가로질러* 살아남아야 필터가 유효. 신규 테이블이 threads 컬럼 수정보다 블래스트
  // 반경 최소. CREATE IF NOT EXISTS 멱등 — 기존 tiguclaw.db 에 안전 적용.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS context_boundaries (
      channel     TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      boundary_ts INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (channel, thread_key)
    );
  `);

  // ─── 대시보드 대화 이력 영속 (기능 B, 2026-06-25) ──────────────────────────────
  // 대시보드 채팅이 EventBus 인메모리 ring(최근 50)으로만 그려져 재시작 시 소실. transcripts
  // 는 raw 모델 I/O(사용자 턴에 system-reminder·SYSTEM.md 주입 섞임)라 그대로 못 씀 → 깨끗한
  // `channel.message.in/out` 텍스트만 담는 전용 작은 테이블. 메시지당 insert 1줄(비용 무시).
  // role = 'user'|'assistant'. 기존 CREATE IF NOT EXISTS 들과 동형 멱등(신규 테이블이라
  // IF NOT EXISTS 로 충분 — ALTER 로직 0). 프루닝 없음(YAGNI — text 행은 작고 transcripts
  // 도 무한증가 중. 필요해지면 추가). idx_ts=최근 N 조회, idx_thread_ts=향후 per-thread 조회.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      thread_key  TEXT NOT NULL,
      channel     TEXT NOT NULL,
      role        TEXT NOT NULL,
      text        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_log_ts ON chat_log(ts);
    CREATE INDEX IF NOT EXISTS idx_chat_log_thread_ts ON chat_log(thread_key, ts);
  `);
  // 첨부 참조 메타(JSON, nullable) — 기존 DB 마이그레이션. 첨부 이미지/파일이 새로고침·과거
  // 이력에도 남게(base64 아닌 rel 경로 참조만). SQLite 는 ADD COLUMN IF NOT EXISTS 미지원 →
  // pragma 로 존재 확인 후 추가(threads 마이그레이션과 동형).
  const chatLogCols = handle
    .prepare(`SELECT name FROM pragma_table_info('chat_log')`)
    .all() as { name: string }[];
  if (!chatLogCols.some((c) => c.name === "attachments")) {
    handle.exec(`ALTER TABLE chat_log ADD COLUMN attachments TEXT`);
  }
  // ─── 어댑터 쿨다운 영속 (2026-07-28) ────────────────────────────────────────
  // 프로세스 메모리에만 있던 쿨다운이 재시작마다 사라져, 매 부팅 직후 죽은 백엔드를 다시
  // 두드렸다(실측 07-27: 부팅 22회 ↔ 429 22건). 절대 만료시각 1행으로 영속한다.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS cooldowns (
      key      TEXT PRIMARY KEY,
      until_ts INTEGER NOT NULL
    );
  `);

  // 시스템 통지 표식(2026-07-27) — 스케줄 실패·자가 점검 같은 인프라 통지가 비서 발화와
  // 같은 role='assistant' 로 저장돼, 새로고침하면 구분이 완전히 사라졌다. ★role 값을 늘리지
  // 않고 **additive 컬럼**으로 둔다 — role='assistant' 로 필터하는 기존 소비자(자가 점검
  // 스윕·이력 렌더·전체활동)의 동작을 그대로 두기 위해서다(NULL/0 = 종전 동작).
  if (!chatLogCols.some((c) => c.name === "notice")) {
    handle.exec(`ALTER TABLE chat_log ADD COLUMN notice INTEGER`);
  }
  // 실제 응답 모델(2026-07-27) — 답변이 *어느 모델로* 나왔는지. 활동 이벤트에만 있으면
  // 활동이 다른 스레드(스케줄 등)에 속한 답변은 표시할 길이 없다(실측: 세션 답변 12건 중
  // 11건 미표시). 메시지에 직접 붙여 경로 무관하게 같은 값이 보이게 한다. 구 행은 NULL.
  if (!chatLogCols.some((c) => c.name === "model")) {
    handle.exec(`ALTER TABLE chat_log ADD COLUMN model TEXT`);
  }

  // ─── 백그라운드 셸 프로세스 영속 (reap 전용 메타 — 2026-07-17) ──────────────────
  // ADR `docs/decisions/2026-07-17-background-shell-observability.md` §4. 런타임
  // 진실은 file-ops-mcp.ts 의 in-memory BG_SHELLS Map(worker_jobs 와 동형 — 이 테이블은
  // *재시작 생존*만 담당). 부팅 reaper 가 status='running' 잔류 행(=이전 세대, detached
  // 프로세스가 데몬 프로세스그룹을 이탈해 kickstart -k/hard-kill/크래시로 살아남을 수 있는
  // 고아)을 PID 재사용 신원검증(started_label — ps lstart+command 스냅샷) 후에만 killTree.
  // 신원 불일치·프로세스 부재는 status='stale' 로만 마킹(무고한 프로세스 오살 0). 출력·결과는
  // 비영속(순수 프로세스 위생 메타만 — worker_jobs 의 "메타만" 보다도 얇음, 재개·통지 없음).
  // codex/openai 전용(file-ops BG_SHELLS 소유) — claude 는 SDK 빌트인 Bash 가 셸을 자체
  // 소유해 이 테이블·reaper 범위 밖(ADR §6, 무영향).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS bg_shells (
      bash_id       TEXT PRIMARY KEY,
      pid           INTEGER NOT NULL,
      pgid          INTEGER NOT NULL,
      command       TEXT NOT NULL,
      cwd           TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      exit_code     INTEGER,
      started_label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bg_shells_status ON bg_shells(status);
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
      `SELECT channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_input_tokens, last_output_tokens, last_channel, last_channel_target, last_used_at, created_at
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
    lastChannel: row.last_channel as ChannelName | null,
    lastChannelTarget: row.last_channel_target,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
};

/**
 * 내부(비-대화) 스레드 접두 — 사용자 대면 세션 목록에서 배제 대상(ADR 2026-07-15 §D6).
 *
 * threadKey 파생(비-채널) 관습(ADR §1.2) + 스케줄 실행 컨텍스트:
 *  - `worker:<jobId>`      detached 백그라운드 잡
 *  - `agent:<uuid>`        awaited 서브에이전트 잡
 *  - `endpoint:<name>:…`   http 엔드포인트 합성 턴
 *  - `gateway:<uuid>`      게이트웨이 합성 턴
 *  - `scheduler:<id>`      ★스케줄 발화 실행 컨텍스트(사용자 대화 아님 — worker: 와 동류).
 *                          task 열거엔 없었으나 "scheduler:3" 같은 합성 실행 스레드를 채팅
 *                          탭으로 노출하는 건 명백한 오노출이라 §D6 "사용자 대면 대화 세션"
 *                          기준으로 배제(판단·보고 대상). 제외 원하면 이 상수에서 빼면 됨.
 *  - `<parent>::sub::…`    서브에이전트 파생(마커 포함, 접두 아님) → 별도 배제.
 *
 * ★§0 단방향: 이 접두들은 코어가 특정 채널을 참조하는 게 아니라 *내부 파생 스레드*의
 * 범용 네임스페이스 관습이다. `tg:`·`cli:`·`dashboard:` 같은 **채널 대화** 접두는
 * 여기 없다 — 그것들은 과거·현재 사용자 대화이므로 목록에 포함된다.
 */
export const INTERNAL_THREAD_PREFIXES = [
  "worker:",
  "agent:",
  "endpoint:",
  "gateway:",
  "scheduler:",
] as const;

/** 서브에이전트 파생 스레드 마커(접두 아닌 중간 삽입). */
export const SUBAGENT_THREAD_MARKER = "::sub::";

/**
 * 프루닝 *대상* 내부 접두 — `INTERNAL_THREAD_PREFIXES` 에서 `scheduler:` 를 뺀 부분집합
 * (효율감사 P3, 2026-07-16). `scheduler:` 는 사용자 뷰에서는 배제 대상(대화 세션 아님)이지만
 * **재사용되는 반복 스레드**(같은 스케줄이 매 발화 같은 threadKey 를 다시 씀 — 스케줄 실행
 * 컨텍스트·resume 연속성)이라 완료 즉시 휘발되는 worker:/agent:/endpoint:/gateway:/`::sub::`
 * 과 볼라틸리티 클래스가 다르다. 프루닝하면 다음 발화가 신선한(비어있는) 세션으로 재시작되어
 * 그 스케줄의 대화 연속성이 끊긴다 → 절대 제외.
 */
const INTERNAL_THREAD_PRUNABLE_PREFIXES = INTERNAL_THREAD_PREFIXES.filter(
  (p) => p !== "scheduler:",
);

/**
 * 내부 파생 스레드(`threads` 행) 프루닝 — 효율감사 P3(2026-07-16), events(`pruneEvents`)·
 * worker_jobs(`pruneTerminalWorkerJobs`) 동형 패턴(순수 DELETE, keep/cutoff 는 호출자가 결정).
 *
 * ★핫경로 바운드 + 레코드 보존 원칙([[project_hotpath_bound_preserve_record]]): 여기서
 * 지우는 건 `threads` **메타 행**(세션-정체성 포인터: claude_session_id·model·last_used_at
 * 등)뿐이다. 대화 레코드 자체(`transcripts`·`transcript_index`·`chat_log`)는 threadKey 로
 * 키잉된 **별 테이블**이라 이 DELETE 로 전혀 건드리지 않는다 — 완료된 워커/서브에이전트/
 * 엔드포인트/게이트웨이 잡의 메타 포인터만 정리하고, 그 잡이 실제로 무슨 대화를 했는지의
 * 레코드는 콜드 보존된다(감사·검색 가능, 대시보드 세션 탭에만 안 뜸 — 원래도 excludeInternal
 * 로 배제되던 것들).
 *
 * 대상 네임스페이스(★`scheduler:` 는 제외 — 위 `INTERNAL_THREAD_PRUNABLE_PREFIXES` 주석 참조):
 *  - `worker:<jobId>`      detached 백그라운드 잡
 *  - `agent:<uuid>`        awaited 서브에이전트 잡
 *  - `endpoint:<name>:…`   http 엔드포인트 합성 턴
 *  - `gateway:<uuid>`      게이트웨이 합성 턴
 *  - `<parent>::sub::…`    서브에이전트 파생(마커 포함, 어느 접두든)
 *
 * `olderThanMs` 이전에 `last_used_at` 이 갱신된 행만 삭제(살아있는/최근 잡은 안 건드림 —
 * 내부 잡은 분/시간 단위로 완료되므로 보수적인 TTL(예 30일)이면 활성 잡 오삭제 위험 0).
 *
 * @returns 삭제된 행 수.
 */
export const pruneInternalThreads = (olderThanMs: number): number => {
  const handle = requireDb("pruneInternalThreads");
  const cutoff = Date.now() - olderThanMs;

  const conds: string[] = [];
  const params: (string | number)[] = [];
  for (const p of INTERNAL_THREAD_PRUNABLE_PREFIXES) {
    conds.push(`channel_thread_id LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLike(p)}%`);
  }
  conds.push(`channel_thread_id LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLike(SUBAGENT_THREAD_MARKER)}%`);

  const result = handle
    .prepare(
      `DELETE FROM threads
        WHERE last_used_at < ?
          AND (${conds.join(" OR ")})`,
    )
    .run(cutoff, ...params);
  return result.changes;
};

/**
 * 세션-정체성 저장 채널 도출 — 슬래시 핸들러·워커 재주입이 route() 정규화와 **동일 키**로
 * 세션-정체성(resume/context boundary/model override/summary)을 read/write 하도록 canonical
 * 채널을 준다(채널/세션 분리 ADR 2026-07-15 §D1, QA BLOCKER 후속).
 *
 * route() 는 정규화 turn 의 세션-정체성을 `(SESSION_STORAGE_CHANNEL, sessionId)` 로 키잉하는데,
 * 슬래시 핸들러는 route() *이전*에 `(msg.channel, msg.threadKey)` 로 직접 키잉했다 → 텔레그램
 * 정규화 turn(msg.channel=telegram, msg.threadKey=dashboard:default)에서 orphan
 * `(telegram, dashboard:default)` 를 만져 실세션 `(http-bridge, dashboard:default)` 을 못
 * 건드렸다(/reset·/model 무효). 이 헬퍼로 route() 와 같은 결정 규칙에 정렬한다.
 *
 *  - **사용자 세션 threadKey**(기본 세션 `DEFAULT_SESSION_ID` 또는 대시보드 세션 `dashboard:`
 *    네임스페이스 — route 가 정규화하는 대상) → `SESSION_STORAGE_CHANNEL`(canonical).
 *  - **내부 파생 스레드**(`INTERNAL_THREAD_PREFIXES`=worker:/agent:/endpoint:/gateway:/
 *    scheduler: · `SUBAGENT_THREAD_MARKER`) → `fallbackChannel` 그대로(정규화 대상 아님 =
 *    현행 passthrough, 회귀 0). ★스케줄러·서브에이전트 세션 정체성 무변경 보장.
 *  - 그 외(레거시 `tg:*`·`cli:*` 등 과거 채널-키드 대화) → `fallbackChannel`(무변경 — 신규
 *    turn 은 이 형태를 안 만든다).
 *
 * ★§0 단방향: `dashboard:` 접두는 `DEFAULT_SESSION_ID` 와 동일한 opaque 레거시 물리 키
 * 네임스페이스(마이그레이션 0 계승)일 뿐 — 코어가 "dashboard" 채널을 특수 참조하는 게 아니다.
 * 순수·멱등(DB 무접근). resolveSessionId·route() 와 같은 결정 규칙.
 */
export const canonicalSessionChannel = (
  threadKey: string,
  fallbackChannel: ChannelName,
): ChannelName => {
  for (const p of INTERNAL_THREAD_PREFIXES) {
    if (threadKey.startsWith(p)) return fallbackChannel;
  }
  if (threadKey.includes(SUBAGENT_THREAD_MARKER)) return fallbackChannel;
  if (threadKey === DEFAULT_SESSION_ID || threadKey.startsWith("dashboard:")) {
    return SESSION_STORAGE_CHANNEL;
  }
  return fallbackChannel;
};

/**
 * 우회 통지(워커 done/failed·stall·tool-slow 등)의 **관측 세션 threadKey** 도출 —
 * canonicalSessionChannel 과 동일 분류(§D3 표시 귀속). job.threadKey 가 실 dashboard
 * 세션이면 그 세션에 표시, 아니면(내부 파생 scheduler:/worker:/sub·물리 tg:/cli) 기본
 * 세션. deliverOutbound({observeThreadKey}) 에 실어 통지가 발원 세션(또는 기본)에 뜨게 한다.
 * ★스케줄이 띄운 워커(job.threadKey="scheduler:<id>")를 물리 tg: 키에 남기던 비대칭 해소.
 */
export const notifySessionThreadKey = (threadKey: string): string => {
  for (const p of INTERNAL_THREAD_PREFIXES) {
    if (threadKey.startsWith(p)) return DEFAULT_SESSION_ID;
  }
  if (threadKey.includes(SUBAGENT_THREAD_MARKER)) return DEFAULT_SESSION_ID;
  if (threadKey === DEFAULT_SESSION_ID || threadKey.startsWith("dashboard:")) {
    return threadKey;
  }
  return DEFAULT_SESSION_ID;
};

// SQLite LIKE 특수문자(% _ \)를 리터럴 취급하도록 ESCAPE '\' 용 이스케이프.
const escapeLike = (s: string): string => s.replace(/([\\%_])/g, "\\$1");

/**
 * 세션 목록 조회 — 멀티세션 탭(ADR 2026-07-15 §D6). 경량 행만
 * (`channel·threadKey·lastChannel·lastChannelTarget·lastUsedAt·model`) last_used_at 내림차순.
 *
 * ★채널/세션 분리(ADR 2026-07-15): 세션은 채널 무관이므로 `dashboard:` prefix 필터는
 * 무의미해졌다. 대시보드 세션 목록은 이제 **사용자 대면 대화 세션 전체**를 원한다 →
 * `excludeInternal: true` 로 내부 파생 스레드(worker:/agent:/endpoint:/gateway:/scheduler:/
 * `::sub::`)만 배제하고 나머지(현행 `dashboard:*` + 레거시 `tg:*`·`cli:*` 과거 대화)는 모두
 * 포함한다. 텔레그램 기본 세션 = 대시보드 첫 탭 = 동일 id(`DEFAULT_SESSION_ID`)라 중복 0.
 *
 * 옵션(전부 additive — 기존 호출부 회귀 0):
 *  - `prefix`         threadKey 네임스페이스 필터(LIKE `<prefix>%`). **범용 인자** — 코어는
 *                     threadKey 를 opaque 로 취급(§0 단방향). 미지정이면 전체. 잔존은 하위호환
 *                     (http-bridge 기존 `prefix:'dashboard:'` 호출 무깨짐 — 라우트 정렬은 웨이브2).
 *  - `excludeInternal` true 면 위 내부 접두/마커 스레드 배제(사용자 대면 세션만). 기본 false
 *                     (하위호환). 웨이브2 `/sessions` 라우트가 이 옵션으로 전환.
 *  - `limit`          기본 100(무한증가 바운드).
 *
 * getSession/getMostRecentTelegramChatId 와 동형 prepared stmt·threads 조회.
 */
export interface ThreadSummary {
  channel: ChannelName;
  threadKey: string;
  /** 세션의 마지막 인입 채널+주소(§D3, 미캡처 → null). outbound 기본 목적지·목록 표시용. */
  lastChannel: ChannelName | null;
  lastChannelTarget: string | null;
  lastUsedAt: number;
  model: string | null;
  /** 커스텀 세션 이름(채널무관, 사용자 지정). NULL = 미지정 → 소비자가 파생 라벨로 폴백. */
  name: string | null;
}

export const listThreads = (opts?: {
  prefix?: string;
  excludeInternal?: boolean;
  limit?: number;
}): ThreadSummary[] => {
  const handle = requireDb("listThreads");
  const prefix = opts?.prefix ?? "";
  const like = prefix === "" ? "%" : `${escapeLike(prefix)}%`;
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 100;

  const conds: string[] = ["channel_thread_id LIKE ? ESCAPE '\\'"];
  const params: (string | number)[] = [like];
  if (opts?.excludeInternal === true) {
    for (const p of INTERNAL_THREAD_PREFIXES) {
      conds.push("channel_thread_id NOT LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(p)}%`);
    }
    conds.push("channel_thread_id NOT LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(SUBAGENT_THREAD_MARKER)}%`);
  }
  params.push(limit);

  const rows = handle
    .prepare(
      `SELECT channel, channel_thread_id, last_channel, last_channel_target, last_used_at, model, name
         FROM threads
        WHERE ${conds.join("\n          AND ")}
        ORDER BY last_used_at DESC
        LIMIT ?`,
    )
    .all(...params) as {
    channel: string;
    channel_thread_id: string;
    last_channel: string | null;
    last_channel_target: string | null;
    last_used_at: number;
    model: string | null;
    name: string | null;
  }[];
  return rows.map((r) => ({
    channel: r.channel as ChannelName,
    threadKey: r.channel_thread_id,
    lastChannel: r.last_channel as ChannelName | null,
    lastChannelTarget: r.last_channel_target,
    lastUsedAt: r.last_used_at,
    model: r.model,
    name: r.name as string | null,
  }));
};

/**
 * 세션 커스텀 이름 설정(채널무관·비파괴). name=null|"" → 커스텀 제거(NULL, 파생 폴백).
 * threadKey 로만 매칭(channel 무시) = 단일인격. UPDATE-only(행 없으면 no-op).
 * @returns 갱신된 행 수(0 = 아직 백엔드 세션 없음, 호출부 graceful).
 */
export const setThreadName = (threadKey: string, name: string | null): number => {
  const handle = requireDb("setThreadName");
  const norm = name === null ? null : name.trim() === "" ? null : name.trim().slice(0, 60);
  const info = handle
    .prepare(`UPDATE threads SET name = ? WHERE channel_thread_id = ?`)
    .run(norm, threadKey);
  if (info.changes > 0) return info.changes;
  // 행이 아직 없음 = 대화 전 새 세션 탭을 rename 한 경우. UPDATE-only 면 이름이 조용히
  // 증발하고, 이후 첫 turn 의 saveSession 이 name=NULL 로 행을 만들어 대시보드 폴이 "세션N"
  // 으로 되돌린다(revert 버그). placeholder 행을 만들어 이름을 미리 보존한다.
  //   - 이름 제거(norm=null)인데 행도 없으면 할 일 없음 → no-op.
  //   - system_prompt_hash=NULL 로 둬 resumable(hash===SYSTEM_PROMPT_HASH) 을 피함 →
  //     빈 claude_session_id 로 resume 시도하는 사고 방지. 첫 claude turn 의 saveSession
  //     (default 경로, ON CONFLICT)이 실제 sid/hash 로 채운다(placeholder 대체).
  //   - 채널은 canonicalSessionChannel 로 saveSession 과 동일 산출(dashboard:*→저장채널) →
  //     복합 PK (channel, channel_thread_id) 일치 → 중복행 없이 이후 turn 이 같은 행 갱신.
  if (norm === null) return 0;
  const channel = canonicalSessionChannel(threadKey, SESSION_STORAGE_CHANNEL);
  const now = Date.now();
  const ins = handle
    .prepare(
      `INSERT INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at, name)
       VALUES (?, ?, '', NULL, NULL, ?, ?, ?)
       ON CONFLICT (channel, channel_thread_id) DO UPDATE SET name = excluded.name`,
    )
    .run(channel, threadKey, now, now, norm);
  return ins.changes;
};

/**
 * 가장 최근에 봇과 대화한 텔레그램 chatId — 매 부팅 "재시작 완료" 통지의 대상.
 * `tg:<chatId>` 형태의 primary thread 만(worker:/::sub:: 파생 제외). 없으면 null
 * (설치 직후·아무도 말 안 검 → 콘솔 통지). config·seed 불필요 — DB 의 활성 대화가 진실.
 */
export const getMostRecentTelegramChatId = (): string | null => {
  const handle = requireDb("getMostRecentTelegramChatId");
  const row = handle
    .prepare(
      `SELECT channel_thread_id FROM threads
       WHERE channel = 'telegram'
         AND channel_thread_id LIKE 'tg:%'
         AND channel_thread_id NOT LIKE '%::%'
       ORDER BY last_used_at DESC LIMIT 1`,
    )
    .get() as { channel_thread_id: string } | undefined;
  if (row === undefined) return null;
  return extractTelegramChatId(row.channel_thread_id);
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

// resume 세션 오염 복구 — 이미지 처리불가(400) 등으로 resume jsonl 에 재생 불가한 turn 이
// 박히면(예: Read 로 읽은 처리불가 이미지가 tool_result 에 남음) 이후 모든 turn 이 그 resume 을
// 재생하며 같은 400 으로 영구 실패한다. system_prompt_hash 를 비워 **resume 만 무효화** →
// 다음 turn 이 이미 문서화된 "해시 stale = 비-resumable" 경로로 가서 오염 jsonl 을 버리고
// fresh 세션 + 스레드 히스토리 full prepend(문맥 보존)로 자가치유한다. deleteSession 과 달리
// claude_session_id·model override·usage 는 **보존**(최소 침습). 행 없으면 no-op.
// [[project_bad_image_poisons_claude_resume]]
export const invalidateResume = (
  channel: ChannelName,
  threadKey: string,
): boolean => {
  const handle = requireDb("invalidateResume");
  const result = handle
    .prepare(
      `UPDATE threads SET system_prompt_hash = '' WHERE channel = ? AND channel_thread_id = ?`,
    )
    .run(channel, threadKey);
  return result.changes > 0;
};

// ─── 채널/세션 분리: 세션의 마지막 인입 채널+주소 메타 (ADR 2026-07-15 §D3) ────────
// 비동기 outbound(워커 완료·능동발신)의 **기본 목적지**를 세션 id 에서 파싱하지 않고
// 인입 시점에 캡처해 둔다. region/daemon 웨이브2가 인입 턴 처리 시 saveSession **직후**
// 호출한다(행 존재 전제 — UPDATE-only, 없으면 no-op 폴백). 키는 saveSession 과 동일한
// (channel, threadKey) — Phase 1 은 threads PK 가 아직 복합키라 동일 키잉으로 정합.
// generic 데이터(채널명·주소) — 코어는 이 값으로 채널 정체성을 분기하지 않는다(§0 단방향).

/**
 * 세션 행의 last_channel/last_channel_target upsert(UPDATE-only). 행이 없으면 no-op
 * (false 반환) — 인입 턴의 saveSession 이 먼저 행을 만든 뒤 호출하는 계약.
 * target=null 허용(cli 등 outbound 주소 없는 채널). 행 있으면 항상 최신값으로 덮어씀.
 */
export const setSessionChannelMeta = (input: {
  channel: ChannelName;
  threadKey: string;
  lastChannel: ChannelName;
  lastChannelTarget: string | null;
}): boolean => {
  const handle = requireDb("setSessionChannelMeta");
  const result = handle
    .prepare(
      `UPDATE threads
          SET last_channel = ?, last_channel_target = ?
        WHERE channel = ? AND channel_thread_id = ?`,
    )
    .run(
      input.lastChannel,
      input.lastChannelTarget,
      input.channel,
      input.threadKey,
    );
  return result.changes > 0;
};

/**
 * 세션의 마지막 인입 채널+주소 회수 — 비동기 outbound 기본 목적지 도출용(§D3).
 * 행 없음·미캡처 → null(호출부가 getMostRecentTelegramChatId 등으로 폴백).
 */
export const getSessionChannelMeta = (
  channel: ChannelName,
  threadKey: string,
): { lastChannel: ChannelName; lastChannelTarget: string | null } | null => {
  const handle = requireDb("getSessionChannelMeta");
  const row = handle
    .prepare(
      `SELECT last_channel, last_channel_target FROM threads
        WHERE channel = ? AND channel_thread_id = ?`,
    )
    .get(channel, threadKey) as
    | { last_channel: string | null; last_channel_target: string | null }
    | undefined;
  if (row === undefined || row.last_channel === null) return null;
  return {
    lastChannel: row.last_channel as ChannelName,
    lastChannelTarget: row.last_channel_target,
  };
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

// ─── 세션 모델 프로파일 helpers (대시보드 드롭다운, 2026-07-19) ─────────────────
// getSessionModelOverride 3종의 mirror. 저장·조회값은 **프로파일 이름**(constraint 3).
// 미기재 세션(텔레그램·cli·http-default·새 탭) → null → 상속(전역 default 프로파일).
// ★sticky: deleteSession(/reset)의 override DELETE 에 이 테이블을 포함하지 않는다 —
// 프로파일 선택은 대화 리셋과 독립 durable(계약 §2).

export const getSessionModelProfile = (
  channel: ChannelName,
  threadKey: string,
): string | null => {
  const handle = requireDb("getSessionModelProfile");
  const row = handle
    .prepare(
      `SELECT profile_name FROM session_model_profile
       WHERE channel = ? AND thread_key = ?`,
    )
    .get(channel, threadKey) as { profile_name: string } | undefined;
  return row?.profile_name ?? null;
};

export const setSessionModelProfile = (
  channel: ChannelName,
  threadKey: string,
  profileName: string,
): void => {
  const handle = requireDb("setSessionModelProfile");
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO session_model_profile (channel, thread_key, profile_name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel, thread_key) DO UPDATE SET
         profile_name = excluded.profile_name,
         updated_at = excluded.updated_at`,
    )
    .run(channel, threadKey, profileName, now);
};

export const clearSessionModelProfile = (
  channel: ChannelName,
  threadKey: string,
): boolean => {
  const handle = requireDb("clearSessionModelProfile");
  const result = handle
    .prepare(
      `DELETE FROM session_model_profile
       WHERE channel = ? AND thread_key = ?`,
    )
    .run(channel, threadKey);
  return result.changes > 0;
};

// ─── Context boundary watermark helpers (/reset·/clear P0, 2026-07-10) ────────
// 리셋 시 index.ts 가 setContextBoundary(channel, threadKey, Date.now()) 호출 →
// 이후 loadThreadHistory·loadThreadHistoryWithIds 가 boundary 이후 transcript 만 반환.
// deleteSession(threads 삭제)과 독립된 전용 테이블이라 리셋을 가로질러 생존.

/** thread 의 context boundary(epoch ms) upsert. 리셋 시각 이후만 히스토리에 노출. */
export const setContextBoundary = (
  channel: ChannelName,
  threadKey: string,
  ts: number,
): void => {
  const handle = requireDb("setContextBoundary");
  handle
    .prepare(
      `INSERT INTO context_boundaries (channel, thread_key, boundary_ts, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (channel, thread_key) DO UPDATE SET
         boundary_ts = excluded.boundary_ts,
         created_at = excluded.created_at`,
    )
    .run(channel, threadKey, ts, Date.now());
};

/** thread 의 context boundary(epoch ms) 회수. 미설정(리셋 이력 없음) → 0(전체 노출). */
export const getContextBoundary = (
  channel: ChannelName,
  threadKey: string,
): number => {
  const handle = requireDb("getContextBoundary");
  const row = handle
    .prepare(
      `SELECT boundary_ts FROM context_boundaries
       WHERE channel = ? AND thread_key = ?`,
    )
    .get(channel, threadKey) as { boundary_ts: number } | undefined;
  return row?.boundary_ts ?? 0;
};
