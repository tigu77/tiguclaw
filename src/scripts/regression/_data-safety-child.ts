/**
 * `data-safety` 의 자식 프로세스 — **비가역 연산을 실제로 돌린다**.
 *
 * ★자식으로 도는 이유: `initStore` 는 프로세스당 한 번이고, 여기서 쓰는 것들은 전부
 *  **DB 를 실제로 지우거나 덮어쓰는** 함수라 스위트 홈과 절대 섞일 수 없다.
 *  (그리고 그게 이 검사의 핵심이다 — 손으로 만든 픽스처를 보는 대신 그 함수를 부른다.)
 *
 * 결과를 마지막 줄 JSON 으로 낸다. 부모가 그것만 읽는다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const home = process.env.TIGUCLAW_HOME ?? "";

/** 마이그레이션이 만든 색인본(`content_indexed`) 한 건. */
const db2Indexed = (h: string): string | null => {
  const db = new Database(path.join(h, "data", "tiguclaw.db"), { readonly: true });
  const row = db.prepare(`SELECT content_indexed FROM transcripts WHERE id = 1`).get() as
    | { content_indexed: string | null }
    | undefined;
  db.close();
  return row?.content_indexed ?? null;
};
const out: Record<string, unknown> = {};

// ── ① FTS 마이그레이션이 **원문을 보존**하나 ────────────────────────────────────
//  옛 스키마(FTS 가 transcripts 를 직접 가리킴)를 만들어 `initStore()` 를 태운다.
//  ★이 판정은 회귀에 이미 있었지만 **자기 손으로 INSERT 한 행**을 봤다 — 마이그레이션
//   함수를 한 번도 부르지 않았다. 그래서 그 함수가 원문을 덮어쓰게 만들어도 초록이었다.
// ★픽스처가 **실제 스트립 대상**이어야 한다: 마이그레이션은 `<system-reminder>` 로
//  시작하는 행만 골라 그 닫는 태그 **뒤 본문**을 색인용으로 뽑는다. 내 첫 픽스처는
//  임의의 프리픽스라 그 경로를 아예 안 지나갔고 — 원문을 덮어쓰는 변이를 넣어도 초록이었다.
//  **사고를 재현하지 못하는 픽스처는 검사가 아니다**(오늘 WebFetch 에서 겪은 것과 같은 부류).
const PREFIX = "<system-reminder>조립 프리픽스: 색인에서 빠져야 한다</system-reminder>\n";
const BODY = "사용자 원문입니다 — 이 줄은 절대 사라지면 안 된다";
{
  mkdirSync(path.join(home, "data"), { recursive: true });
  const dbPath = path.join(home, "data", "tiguclaw.db");
  const db = new Database(dbPath);
  // ★옛 스키마를 **충실히** 만든다 — FTS 가 `transcripts` 를 직접 가리키는 형태
  //  (`transcripts_fts_src` 가 없음 = 백필 대상). ★`tokenize='trigram'` 을 이미 준다 —
  //  안 주면 **앞선 트리거램 분기**가 FTS 를 새 형태로 갈아치워서 백필 게이트가 건너뛴다
  //  (그 상태로는 원문을 덮어쓰는 변이를 넣어도 초록이었다 — 픽스처가 경로를 안 지났다).
  //  `content_indexed` 컬럼은 있지만 비어 있는 게 실제 옛 설치의 모습이다.
  db.exec(`
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, claude_session_id TEXT, ts INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, content_indexed TEXT
    );
    CREATE VIRTUAL TABLE transcripts_fts USING fts5(
      content, role, content='transcripts', content_rowid='id', tokenize='trigram'
    );
  `);
  db.prepare(`INSERT INTO transcripts (claude_session_id, ts, role, content) VALUES (?,?,?,?)`).run(
    "s1",
    Date.now(),
    "user",
    PREFIX + BODY,
  );
  db.close();
}

const { initStore } = await import("../../store/sessions.js");
initStore(); // ← 여기서 migrateFtsToTrigram 이 돈다(실제 경로)

{
  const db = new Database(path.join(home, "data", "tiguclaw.db"), { readonly: true });
  const row = db.prepare(`SELECT content FROM transcripts WHERE id = 1`).get() as
    | { content: string }
    | undefined;
  db.close();
  const content = row?.content ?? "";
  const idx = (db2Indexed(home) ?? "").trim();
  out.ftsContentPreserved = content === PREFIX + BODY;
  out.ftsContentLen = content.length;
  out.ftsBodyKept = content.includes(BODY);
  // ★"정리 ≠ 삭제" 의 다른 쪽 — 색인본에서는 프리픽스가 **빠져야** 한다.
  //  둘을 같이 봐야 "아무것도 안 하고 통과" 를 막는다.
  out.ftsIndexedStripped = idx === BODY;
}

// ── ② 희귀 이벤트 프루닝 — **상한을 넘겨** 넣고 "최신이 남는가" ─────────────────
//  ★종전 검사는 희귀 타입을 10건만 넣고 상한 100 으로 돌려 **상한을 절대 안 넘겼다** →
//   정렬 방향이 결과에 영향을 못 줬다. 뒤집으면 최신이 지워지고 최고령이 남는데 초록.
{
  const { insertEvent, pruneEvents } = await import("../../store/events.js");
  for (let i = 0; i < 30; i++) {
    insertEvent(Date.now() + i, "llm.turn_error", `{"i":${i}}`);
  }
  pruneEvents(20);
  const db = new Database(path.join(home, "data", "tiguclaw.db"), { readonly: true });
  const rows = db
    .prepare(`SELECT payload FROM events WHERE type = 'llm.turn_error' ORDER BY id`)
    .all() as { payload: string }[];
  db.close();
  const idx = rows.map((r) => Number(JSON.parse(r.payload).i));
  out.pruneKeptNewest = idx.includes(29);
  out.pruneDroppedOldest = !idx.includes(0);
  out.pruneRange = idx.length === 0 ? "(없음)" : `${idx[0]}~${idx[idx.length - 1]}`;
}

// ── ③ 터미널 잡 프루닝이 **running 을 지우지 않나** ─────────────────────────────
{
  const { upsertWorkerJob, pruneTerminalWorkerJobs, listInterruptedWorkerJobs } = await import(
    "../../store/worker-jobs.js"
  );
  for (const [id, status] of [
    ["d1", "done"],
    ["d2", "done"],
    ["d3", "done"],
    ["r1", "running"],
  ] as const) {
    upsertWorkerJob({
      jobId: id,
      label: id,
      threadKey: "t",
      channel: "cli",
      channelUserId: "u",
      status,
      startedAt: Date.now(),
    });
  }
  pruneTerminalWorkerJobs(2);
  out.pruneKeptRunning = listInterruptedWorkerJobs().some((j) => j.jobId === "r1");
}

// ── ④ 내부 스레드 프루닝이 **`scheduler:` 를 지키나** ───────────────────────────
//  스케줄은 30일 넘게 도는 게 정상이라 일부러 제외됐다("절대 제외" 라고 주석에 못박음).
{
  const db = new Database(path.join(home, "data", "tiguclaw.db"));
  const old = Date.now() - 40 * 864e5;
  const cols = (db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  // ★실물 컬럼명을 쓴다 — `channel_thread_id`·`last_used_at`(내 첫 픽스처는 `thread_key`·
  //  `updated_at` 을 가정해 깨졌다. 픽스처가 스키마를 추측하면 검사가 아니라 추측이다).
  const hasCols = cols.includes("channel_thread_id") && cols.includes("last_used_at");
  if (hasCols) {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO threads
         (channel, channel_thread_id, claude_session_id, last_used_at, created_at)
         VALUES (?,?,?,?,?)`,
    );
    ins.run("cli", "scheduler:3", "sess-sched", old, old);
    ins.run("cli", "worker:zzz", "sess-worker", old, old);
  }
  db.close();
  const { pruneInternalThreads } = await import("../../store/sessions.js");
  const removed = pruneInternalThreads(30 * 864e5);
  const db2 = new Database(path.join(home, "data", "tiguclaw.db"), { readonly: true });
  const left = db2
    .prepare(
      `SELECT channel_thread_id FROM threads
         WHERE channel_thread_id IN ('scheduler:3','worker:zzz')`,
    )
    .all() as { channel_thread_id: string }[];
  db2.close();
  out.pruneKeptScheduler = left.some((r) => r.channel_thread_id === "scheduler:3");
  out.pruneDroppedWorker = !left.some((r) => r.channel_thread_id === "worker:zzz");
  out.pruneThreadsRemoved = removed;
  out.pruneThreadsFixtureOk = hasCols;
}

// ── ⑤ 백업 실패가 **조용하지 않나** ────────────────────────────────────────────
//  백업 디렉터리 자리에 파일을 둬 실패를 만든다. 실패는 `error` 로 돌아와야 하고
//  `backupNotice` 가 문장을 내야 한다 — 종전 검사는 이 함수를 한 번도 안 불렀다.
{
  const { runBackupIfDue, backupNotice } = await import("../../store/backup.js");
  // ★실제 자리는 `<home>/data/backup` 이다 — 내 첫 픽스처는 `<home>/backups` 를 막아서
  //  **실패가 안 났고**, 그러면 "실패를 말하나" 를 재는 검사가 성공 경로를 재고 있었다.
  //  (픽스처가 자리를 추측하면 검사가 조용히 딴 걸 잰다.)
  const backupsDir = path.join(home, "data", "backup");
  writeFileSync(backupsDir, "not-a-directory", "utf8"); // mkdir 실패 유도(파일이 그 자리에 있음)
  const r = runBackupIfDue(Date.now());
  out.backupRan = (r as { ran?: boolean }).ran === true;
  out.backupReportedError = "error" in (r as Record<string, unknown>);
  out.backupNoticeSpoken = typeof backupNotice(r) === "string";
}

process.stdout.write(`\n${JSON.stringify(out)}\n`);
