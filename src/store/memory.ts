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

// ─── 메모리 인덱스 티어링 (효율감사 P2a, 2026-07-16 — architect 계약
// `_workspace/memory-index-tiering_contract.md`, ★사용자 확정 Option A) ─────
//
// archived_at: always-on 인덱스(listMemoriesForIndex)·listMemories 기본에서만 제외.
// searchMemories/getMemory 는 무변경 — FTS 에 아카이브 행이 그대로 남아 findable
// 보증(콜드=밀렸을 뿐, 검색으로 도달 가능). 비파괴·가역(unarchiveMemory).
//
// access_count/last_accessed: getMemory·searchMemories 히트 시 증분(별도 UPDATE,
// updated_at·FTS 무영향 — 트리거 재동기 content 동일). 지금 당장 절단 개선에는
// 무효(cold-start 전량 0) — 미래 hot-first 정렬(§6 Option D)로 가는 forward 투자.
/**
 * ★**«읽었다» 와 «검색에 걸렸다» 를 가른다** (2026-09-02).
 *
 * 종전엔 `getMemory`(모델이 이름을 대고 가져옴)와 `searchMemories`(매 턴 도는 자동 검색)가
 * **같은 카운터**를 올렸다. 그 결과 실측:
 *  - 197건 중 **171건(87%)이 «최근 7일 내 사용»** 으로 찍혀 시간축의 판별력이 0이었다
 *  - 상위 1~3위가 전부 **기계가 만든 메모리**(`feedback_growth_*`, 455/450/309) —
 *    흔한 낱말을 담아 FTS 에 계속 걸리고, 걸릴 때마다 올라 눌러앉는 **자기강화 루프**였다
 *  - 반면 「사용자를 '정태님'이라고 부른다」는 **193위**
 *
 * ★그리고 더 근본적으로 **신호의 방향이 반대다.** 이 카운터가 정하는 건 «인덱스에 상주할
 *  값이 있나» 인데, **검색으로 찾혔다는 건 상주가 필요 없다는 증거**다(낱말로 도달했으니까).
 *  검색 히트를 세면 «인덱스 없이도 되는 것» 이 인덱스를 차지한다. 세면 안 되는 게 아니라
 *  **거꾸로 세고 있었다.**
 *
 * 그래서 **명시적 fetch 만** 센다 — 모델이 인덱스를 보고 이름을 대서 가져온 경우.
 * 그때가 «인덱스가 제 일을 했다» 는 유일한 증거다.
 * ★그리고 **하루 1회로 접는다**: 한 대화에서 같은 것을 열 번 열어도 «그날 썼다» 는 하나다.
 *  raw 횟수는 대화 길이를 재는 것이지 가치를 재는 게 아니다.
 *
 * ★옛 카운트는 **안 지운다** — 사용자 데이터고, 지우면 되돌릴 수 없다. 오염분은 새로 안
 *  늘어나므로 시간이 지나며 상대적으로 묽어진다. 그 사이의 왜곡은 **종류별 캡**이 막는다
 *  (자동생성이 아무리 뜨거워도 제 몫을 넘어 남의 자리를 못 뺏는다).
 */
const bumpAccess = (db: ReturnType<typeof requireDb>, ids: readonly number[]): void => {
  if (ids.length === 0) return;
  const now = Date.now();
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const stmt = db.prepare(
    `UPDATE memories
        SET access_count = access_count + CASE WHEN coalesce(last_accessed, 0) < ? THEN 1 ELSE 0 END,
            last_accessed = ?
      WHERE id = ?`,
  );
  for (const id of ids) stmt.run(dayStart, now, id);
};

/** 검색 히트 — **카운트를 올리지 않는다**(위 주석 참조). 마지막 노출 시각만 남긴다. */
const touchSeen = (db: ReturnType<typeof requireDb>, ids: readonly number[]): void => {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`UPDATE memories SET last_accessed = ? WHERE id = ?`);
  for (const id of ids) stmt.run(now, id);
};

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
  if (row === undefined) return undefined;
  bumpAccess(db, [row.id]);
  return rowToMemory(row);
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
/**
 * 인덱스에서 이 메모리가 속한 **몫**. 종류(`type`)를 쓰되 **자동 생성분만 따로** 뺀다.
 *
 * ★자동 생성분을 가르는 이유: 그건 `feedback` 타입이지만 **성질이 다르다** — 기계가 쓰고
 *  기계가 읽으며, 사람이 쓴 규범과 같은 몫을 두고 경쟁하면 늘 이긴다(빈도로는). 소유자도
 *  다르다(self-growth 루프가 스스로 만료시킨다).
 * ★이름으로 가르는 게 손목록 아닌가? 아니다 — 이건 **생성 주체**의 표식이고 그 접두사는
 *  self-growth 가 코드로 붙인다([[feedback_hand_maintained_lists]] 의 «판정 기준으로
 *  바꿀 수 있나» 에 대한 답: 이게 그 판정 기준이다).
 */
const KNOWN_BUCKETS = new Set(["user", "feedback", "project", "reference"]);
const memoryBucket = (name: string, type: string): string =>
  name.startsWith("feedback_growth_") || name.startsWith("growth_")
    ? "auto"
    : KNOWN_BUCKETS.has(type)
      ? type
      : "other";

/**
 * 종류별 몫 — 총량 대비 비중으로 푼다(캡을 바꿔도 비례해서 따라간다).
 *
 * ★`user`(사람 사실)에 **넉넉히** 준다: 지금 894B 인데 10%(4KB)를 준다. 작아서 비용이
 *  없고, 잘리면 사용자가 **매 문장에서 겪는다**(호칭·말투). 남는 몫은 놀아도 된다.
 * ★`auto`(자동생성)는 **10% 로 묶는다**: 지금 5.3KB(15.8%)로 이미 넘고 상위 1~3위를
 *  차지하고 있다. 여기를 안 묶으면 나머지 조치가 다 무의미하다.
 * ★모르는 type 은 `other` 로 모아 받는다 — 새 type 이 생겨도 **0이 되지 않는다**(그러면
 *  그 종류가 통째로 사라진다).
 */
const memoryTypeBudgets = (total: number): Map<string, number> => {
  // ★합이 1.0 이다. `type` 은 DB 가 `CHECK (type IN ('user','feedback','project','reference'))`
  //  로 막고 있어 다섯 버킷(넷 + auto)이 전부다 — 처음엔 `other` 에 6% 를 뒀는데 **도달할
  //  수 없는 몫**이었다(검사가 그 타입을 못 만들어서 드러났다). 안 쓰는 자리에 예산을 두면
  //  그만큼 쓰는 자리가 줄어든다.
  //  ★그래도 `other` 자체는 남긴다(아래 0.02) — 미래에 type 이 늘면 **0이 되어 그 종류가
  //   통째로 사라지는** 게 최악이다. 몫이 작은 건 되돌릴 수 있지만 사라지는 건 조용하다.
  const share: Record<string, number> = {
    user: 0.1,
    feedback: 0.34,
    project: 0.34,
    reference: 0.1,
    auto: 0.1,
    other: 0.02,
  };
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(share)) out.set(k, Math.floor(total * v));
  return out;
};

export const listMemoriesForIndex = (
  maxBytes: number,
): { lines: string[]; total: number; truncated: number; cutNames: Set<string> } => {
  const db = requireDb("listMemoriesForIndex");
  // 인덱스 티어링(계약 §3.2): archived_at IS NULL — 아카이브분은 always-on 핫셋에서
  // 제외(FTS/searchMemories 로는 여전히 도달, §3.3 무변경).
  // ★hot-first 정렬 (2026-08-11). 종전엔 `updated_at DESC` — **최근에 고친 것**이 남고
  //  오래 안 건드린 것이 잘렸다. 그런데 남아야 할 것은 *최근에 고친 것*이 아니라
  //  **자주 쓰이는 것**이다. 실측: 82회 읽힌 리포트 시각 선호와 69회 읽힌 뉴스 선호가
  //  6월 갱신이라는 이유로 잘려 나갔고, 0회짜리 사실들이 더 최근이라 실렸다.
  //  (위 bumpAccess 주석이 예고한 "미래 hot-first 정렬" 이 여기다 — 그때는 전량 0이라
  //   미뤘고, 지금은 169건 중 163건이 읽힌 기록을 갖는다.)
  //
  //  동률·미사용분은 `updated_at DESC` 로 갈라 종전 동작을 유지한다(신규 메모리가
  //  0회라고 맨 뒤로 밀리지 않게 — 방금 적은 것은 곧 쓰인다).
  const rows = db
    .prepare(
      `SELECT type, name, description
       FROM memories
       WHERE archived_at IS NULL
       ORDER BY access_count DESC, updated_at DESC`,
    )
    .all() as Pick<MemoryRow, "type" | "name" | "description">[];

  // ★**고르기는 hot-first, 내보내기는 안정 순서** (2026-09-02).
  //  이 인덱스는 이제 **시스템 채널(프리픽스 캐시)** 에 실린다. 그런데 위 정렬은
  //  `access_count DESC` 라, `read_memory` 를 한 번 부를 때마다 카운트가 올라 **순서가
  //  바뀌고 텍스트가 바뀐다** — 캐시가 메모리를 읽는 족족 깨진다(실측: 인덱스 내용 자체가
  //  바뀌는 사건은 하루 1.7회인데, 읽기는 그보다 훨씬 잦다).
  //  ★hot-first 의 목적은 **캡에서 무엇이 살아남느냐**이지 화면 순서가 아니다
  //   (2026-08-11 주석: "82회 읽힌 것이 6월 갱신이라는 이유로 잘려 나갔다"). 그래서 자르는
  //   판정은 그대로 두고, 살아남은 것만 **이름순**으로 내보낸다 — 선택은 안 바뀌고
  //   텍스트만 안정된다. 둘 다 지킨다.
  // ★**종류마다 자기 몫이 있다** (2026-09-02). 종전엔 한 통에 넣고 hot-first 로 잘라서,
  //  한 종류가 다른 종류를 통째로 밀어냈다. 실측이 선명했다:
  //   1~3위 = 기계가 만든 `feedback_growth_*`(455/450/309) · 「정태님」 = **193위/197건**
  //   `user`(사람 사실) 10건은 인덱스의 **2.7%** 인데 순위는 20위·193위로 흩어져 있었다
  //  ★한 통에서 빈도로 줄 세우면 **기계 생성물이 사람 사실을 이긴다** — 기계는 매 턴
  //   돌며 자기가 쓴 것을 자기가 읽으니까. 순서를 바꿔 풀 문제가 아니라 **자리를 나눠야**
  //   하는 문제다([[feedback_external_things_own_their_unit]] 와 같은 결).
  //  ★몫은 **비율이 아니라 바이트**다 — 비율이면 한 종류가 폭증할 때 남의 몫도 같이 흔들린다.
  //  ★남은 몫은 **재분배하지 않는다.** 그러면 «자동생성이 남은 자리를 다 먹는» 옛 상태로
  //   돌아간다. 덜 쓰는 종류의 여유는 그 종류의 성장 여지로 남긴다.
  const budget = memoryTypeBudgets(maxBytes);
  const used = new Map<string, number>();
  const picked: Pick<MemoryRow, "type" | "name" | "description">[] = [];
  let bytes = 0;
  let truncated = 0;
  for (const r of rows) {
    const line = `- [${r.type}] ${r.name}: ${r.description}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +\n
    const bucket = memoryBucket(r.name, r.type);
    const cap = budget.get(bucket) ?? 0;
    const u = used.get(bucket) ?? 0;
    // ★**몫이 비었으면 첫 항목은 무조건 들인다** (2026-09-02, 검사가 잡았다).
    //  안 그러면 «항목 하나가 자기 몫보다 큰» 종류는 **통째로 0** 이 된다 — 중요도와
    //  무관하게 영영 안 보이고, 그건 몫을 나눈 목적(한 종류가 사라지지 않게)과 정반대다.
    //  총량 상한은 아래에서 여전히 지킨다.
    if (u > 0 && u + lineBytes > cap) continue; // 이 종류의 몫이 찼다 — 다음 것을 본다
    if (bytes + lineBytes > maxBytes) break; // 총량 상한(안전망)
    picked.push(r);
    used.set(bucket, u + lineBytes);
    bytes += lineBytes;
  }
  truncated = rows.length - picked.length;
  const lines = picked
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `- [${r.type}] ${r.name}: ${r.description}`);
  // ★**잘린 이름**도 함께 낸다 (2026-09-02) — 캡의 «피해» 를 재려면 이게 필요하다.
  //  종전 실측은 전부 **저장 쪽**(건수·바이트·증가율)이었고 «잘려서 실제로 놓친 적이
  //  있나» 를 세는 숫자가 **하나도 없었다**. 캐시 용어로 miss cost 를 안 재고 eviction
  //  정책을 튜닝하고 있었던 것이다. 여기서 한 번 계산하는 김에 내보낸다(추가 질의 0).
  const kept = new Set(picked.map((r) => r.name));
  const cutNames = new Set(rows.filter((r) => !kept.has(r.name)).map((r) => r.name));
  return { lines, total: rows.length, truncated, cutNames };
};

// 쿼리 → 단어별 연속 3-그램 집합(FTS5 trigram tokenizer 단위). 공백/구두점으로 단어 분리
// 후 각 단어 *안에서만* 슬라이딩(공백 넘는 트라이그램=노이즈 방지). <3자 단어는 skip
// (trigram 이 못 매치). 중복 제거 + 상한(쿼리 크기 바운드).
// ★배경: 예전엔 쿼리 전체를 한 phrase 로 quote → 문장 전체가 연속으로 나와야만 매치돼
//  대화체 입력에 사실상 0건이었다(실증). 트라이그램 OR 은 부분·조사(스케줄"이" → "스케줄"
//  트라이그램)까지 회수(실증 0→다수). bm25 가 흔한 트라이그램(낮은 IDF)을 자연 down-weight.
const QUERY_TRIGRAM_CAP = 64;
const queryToTrigrams = (q: string): string[] => {
  const words = q
    .split(/[\s,.;:!?()[\]{}"'`~/\\|@#$%^&*+=<>·…\n\t-]+/u)
    .filter((w) => w.length >= 3);
  const seen = new Set<string>();
  for (const w of words) {
    for (let i = 0; i + 3 <= w.length; i++) {
      seen.add(w.slice(i, i + 3));
      if (seen.size >= QUERY_TRIGRAM_CAP) return [...seen];
    }
  }
  return [...seen];
};

export const searchMemories = (query: string, limit = 10): Memory[] => {
  const db = requireDb("searchMemories");
  const trimmed = query.trim();
  if (trimmed === "") return [];

  // FTS5 MATCH against description+body+name; bm25 ascending = best first.
  // 트라이그램 OR (위 queryToTrigrams). 각 그램을 quote 해 FTS5 문법문자 중화.
  const grams = queryToTrigrams(trimmed);
  if (grams.length === 0) return [];
  const matchExpr = grams
    .map((g) => `"${g.replace(/"/g, '""')}"`)
    .join(" OR ");
  // ★무변경(계약 §3.3) — archived 필터 없음. FTS 에 아카이브 행이 그대로 남아
  // always-on 에서 밀린 콜드 메모리도 검색으로 계속 도달(findability 보증).
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
  // ★검색 히트는 **세지 않는다** — 낱말로 도달했다는 건 인덱스 상주가 필요 없다는 증거다.
  touchSeen(db, rows.map((r) => r.id));
  return rows.map(rowToMemory);
};

export const listMemories = (opts?: {
  type?: MemoryType;
  limit?: number;
  orderBy?: "updated" | "created";
  /**
   * true 면 archived_at 필터를 생략(아카이브분 포함) — unarchive 후보 탐색·유지보수용.
   * 기본(false/미지정) = archived_at IS NULL 만(계약 §3.5). ★중요: `retrieveContext`
   * 의 `recent`(ALWAYS_RECENT_MEMS) 가 이 기본을 쓴다 — 필터 없으면 방금 아카이브한
   * 항목이 always-on 스니펫에 계속 떠 아카이브가 무효화된다(gotcha, 계약 §3.5).
   */
  includeArchived?: boolean;
}): Memory[] => {
  const db = requireDb("listMemories");
  const limit = opts?.limit ?? 50;
  const orderCol = opts?.orderBy === "created" ? "created_at" : "updated_at";
  const archivedCond =
    opts?.includeArchived === true ? "" : "AND archived_at IS NULL";

  if (opts?.type !== undefined) {
    const rows = db
      .prepare(
        `SELECT id, type, name, description, body, created_at, updated_at
         FROM memories WHERE type = ? ${archivedCond}
         ORDER BY ${orderCol} DESC LIMIT ?`,
      )
      .all(opts.type, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }
  const rows = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories
       WHERE 1=1 ${archivedCond}
       ORDER BY ${orderCol} DESC LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
  return rows.map(rowToMemory);
};

// ─── 아카이브/되돌리기 (비파괴·가역 — 계약 §3.7) ─────────────────────────────
// archived_at 스탬프만 UPDATE. ★updated_at 은 건드리지 않는다 — 아카이브가 recency
// 를 흔들면 unarchive 시 부당하게 최상단 점프(계약 명문). updateMemory 재사용 금지
// (그건 항상 updated_at 범프). 없는 name → undefined(no-op).
export const archiveMemory = (name: string): Memory | undefined => {
  const db = requireDb("archiveMemory");
  const info = db
    .prepare(`UPDATE memories SET archived_at = ? WHERE name = ?`)
    .run(Date.now(), name);
  if (info.changes === 0) return undefined;
  return getMemoryRaw(db, name);
};

export const unarchiveMemory = (name: string): Memory | undefined => {
  const db = requireDb("unarchiveMemory");
  const info = db
    .prepare(`UPDATE memories SET archived_at = NULL WHERE name = ?`)
    .run(name);
  if (info.changes === 0) return undefined;
  return getMemoryRaw(db, name);
};

/**
 * 아카이브 후보 이름 목록 — 이름 프리픽스 + **access_count = 0**(한 번도 surfaced 안 됨)
 * + updated_at ≤ cutoff + 미아카이브. access_count 는 Memory 타입에 없어(read 시맨틱 분리)
 * SQL 에서 직접 필터 → 진짜 콜드만 정확히 잡는다. self-growth 콜드-obs 아카이브 정책이 씀.
 * 이름만 반환(archiveMemory 가 이름으로 처리). 프리픽스는 LIKE 특수문자 없는 것만 넘긴다.
 */
export const listColdMemoriesForArchive = (
  namePrefix: string,
  cutoffMs: number,
): string[] => {
  const db = requireDb("listColdMemoriesForArchive");
  const rows = db
    .prepare(
      `SELECT name FROM memories
       WHERE name LIKE ? AND access_count = 0
         AND updated_at <= ? AND archived_at IS NULL`,
    )
    .all(`${namePrefix}%`, cutoffMs) as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

// getMemory 는 access_count 를 증분하는 "read" 시맨틱(계약 §3.8) — archiveMemory/
// unarchiveMemory 는 관리 오퍼레이션이라 read 히트로 잡히면 안 됨. 원본 row 조회만
// 하는 내부 헬퍼로 분리(bumpAccess 미호출).
const getMemoryRaw = (
  db: ReturnType<typeof requireDb>,
  name: string,
): Memory | undefined => {
  const row = db
    .prepare(
      `SELECT id, type, name, description, body, created_at, updated_at
       FROM memories WHERE name = ?`,
    )
    .get(name) as MemoryRow | undefined;
  return row === undefined ? undefined : rowToMemory(row);
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
  // content_indexed — 조립 프리픽스가 있을 때만 채운다(없으면 NULL = 원문을 색인).
  // 원문(content)은 그대로 저장한다: 바꾸는 건 파생물인 색인뿐이다("정리 ≠ 삭제").
  const indexed = stripAssembledPrefix(input.content);
  db.prepare(
    `INSERT INTO transcripts (claude_session_id, ts, role, content, content_indexed)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.claudeSessionId,
    input.ts ?? Date.now(),
    input.role,
    input.content,
    indexed === input.content ? null : indexed,
  );
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
      `SELECT lines_indexed, bytes_indexed FROM transcript_index
       WHERE channel = ? AND thread_key = ? AND claude_session_id = ?`,
    )
    .get(channel, threadKey, claudeSessionId) as
    | { lines_indexed: number; bytes_indexed: number | null }
    | undefined;
  const offset = idxRow?.lines_indexed ?? 0;

  // ★꼬리만 읽는다 (2026-08-01 A4a). 종전엔 새 줄 몇 개를 얻으려고 **매 claude 턴마다
  //  파일 전체**를 동기로 읽었다 — 라이브 19.7MB 실측 47ms 이벤트루프 정지 + 270MB 피크
  //  RSS(꼬리만 = 0.7ms/42MB, 67배). 상시 데몬이 매 턴 그만큼 멎으면 텔레그램·SSE·
  //  스케줄러가 같이 멎는다. 세션이 길수록 선형으로 나빠지고 상한이 없었다.
  //
  //  bytes_indexed = "여기까지 읽었다"는 바이트 위치. 전체 재읽기로 되돌아가는 경우:
  //   ①레거시 행(NULL) ②파일이 그 위치보다 **작아졌을 때**(회전·절단·다른 세션 재사용).
  //  둘 다 한 번만 비싸고, 그 뒤로는 꼬리만 읽는다.
  const size = fs.statSync(jsonlPath).size;
  const from = idxRow?.bytes_indexed ?? null;
  // 파일이 기억한 위치보다 **작아졌다** = 절단·회전·세션 id 재사용. 이때 줄 오프셋도
  // 의미를 잃는다(다른 내용 스트림이다) → 통째로 다시 색인한다. 중복 행이 생길 수는
  // 있어도 **유실은 없다**(보존 > 정리 — 중복은 보이지만 유실은 안 보인다).
  const shrank = from !== null && from > size;
  const tailOnly = from !== null && !shrank;
  let raw: string;
  let baseBytes: number;
  if (tailOnly) {
    if (from === size) return { lines: 0 }; // 자란 게 없다 — 파일을 열지도 않는다.
    const fd = fs.openSync(jsonlPath, "r");
    try {
      const buf = Buffer.allocUnsafe(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    baseBytes = from;
  } else {
    raw = fs.readFileSync(jsonlPath, "utf8");
    baseBytes = 0;
  }

  // ★마지막 개행까지만 소비한다 — 그 뒤는 아직 쓰는 중일 수 있는 조각이다(부분 줄을
  //  파싱하면 조용히 버려지고, 바이트 위치를 그 너머로 옮기면 그 줄이 **영영 유실**된다).
  const lastNl = raw.lastIndexOf("\n");
  const consumable = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
  const consumedBytes = baseBytes + Buffer.byteLength(consumable, "utf8");
  const newLines = consumable === "" ? [] : consumable.split(/\r?\n/).slice(0, -1);

  // 전체 읽기였다면 앞부분(이미 색인된 offset 줄)을 건너뛴다. 꼬리 읽기면 전부 새 줄이다.
  const effectiveOffset = shrank ? 0 : offset; // 절단이면 처음부터.
  const pending = tailOnly ? newLines : newLines.slice(effectiveOffset);
  const totalLines = tailOnly ? offset + newLines.length : newLines.length;
  if (pending.length === 0) {
    // 색인할 줄은 없어도 **바이트 위치는 전진**시킨다 — 안 그러면 다음 턴이 같은 구간을
    // 다시 읽는다(전체 읽기 경로에서 특히 비싸다).
    if (consumedBytes !== from) {
      db.prepare(
        `INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed, bytes_indexed)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, thread_key, claude_session_id) DO UPDATE SET
           jsonl_path = excluded.jsonl_path,
           indexed_at = excluded.indexed_at,
           lines_indexed = excluded.lines_indexed,
           bytes_indexed = excluded.bytes_indexed`,
      ).run(channel, threadKey, claudeSessionId, jsonlPath, Date.now(), totalLines, consumedBytes);
    }
    return { lines: 0 };
  }

  const insert = db.prepare(
    `INSERT INTO transcripts (claude_session_id, ts, role, content, content_indexed)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const upsertIndex = db.prepare(
    `INSERT INTO transcript_index (channel, thread_key, claude_session_id, jsonl_path, indexed_at, lines_indexed, bytes_indexed)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel, thread_key, claude_session_id) DO UPDATE SET
       jsonl_path = excluded.jsonl_path,
       indexed_at = excluded.indexed_at,
       lines_indexed = excluded.lines_indexed,
       bytes_indexed = excluded.bytes_indexed`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const line of pending) {
      const parsed = parseJsonlLine(line);
      if (parsed === undefined) continue;
      // ★여기가 부풀던 자리다 — jsonl 의 user 메시지는 우리가 넘긴 **조립 프롬프트 전문**
      //  (헌법+메모리+스킬 인덱스)이라 한 줄 입력이 25KB 로 들어온다. 원문은 그대로 넣고,
      //  색인용만 프리픽스를 뺀다(같을 땐 NULL — 본문 이중 저장 0).
      const idx = stripAssembledPrefix(parsed.content);
      insert.run(
        claudeSessionId,
        parsed.ts,
        parsed.role,
        parsed.content,
        idx === parsed.content ? null : idx,
      );
      inserted++;
    }
    upsertIndex.run(
      channel,
      threadKey,
      claudeSessionId,
      jsonlPath,
      Date.now(),
      totalLines,
      consumedBytes,
    );
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
    content: r.role === "assistant" ? r.content : stripAssembledPrefix(r.content),
  }));
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

/**
 * charCap 디폴트 — **어댑터가 이 값을 import 한다**(단일 진실 소스, 2026-07-30 정정).
 * 종전 주석은 "어댑터와 정합"이라 적혀 있었지만 어댑터는 500_000 이었다(2.5배 차이).
 * ★주의: `loadThreadHistoryWithIds`(codex 압축 입력)는 charCap 을 적용하지 않는다 —
 *  그쪽은 `planHistoryCompaction` 의 적응 예산이 크기를 통제한다.
 */
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

/**
 * **조립 프리픽스를 걷어낸 사용자 원문.**
 *
 * ★왜 (2026-07-29 실사고): claude 어댑터는 SDK 가 남긴 jsonl 을 색인하는데, 그 jsonl 의
 *  "user 메시지" 는 우리가 `query()` 에 넘긴 **조립된 프롬프트 전문**이다 — SYSTEM.md 헌법 +
 *  메모리 인덱스 + 스킬·에이전트 인덱스까지 통째로. 그래서 사용자가 `진행해`(3자)를 쳐도
 *  히스토리엔 22,562자가 쌓인다. 같은 대화가 codex 로 돌면 262자다(원문만 INSERT) —
 *  **어댑터에 따라 81배 차이**(실측: claude 124턴 263만자 vs codex 68턴 1.8만자).
 *
 *  결과: 한 스레드 히스토리가 2,838,563자까지 부풀어 요약 압축이 매 턴 실패하고
 *  (oldest-drop 폴백) 모델이 하던 작업의 맥락을 잃었다 = "진행한다고 해놓고 안 함".
 *
 * ★읽을 때 걷어낸다(색인 때가 아니라): 이미 쌓인 레코드도 즉시 효과가 나고, 원본은
 *  그대로 보존된다("정리 ≠ 삭제" — 콜드 레코드는 안 지운다). 프리픽스는 어차피 매 턴
 *  새로 조립돼 주입되므로 히스토리에 실어 보낼 이유가 없다(순수 중복).
 *
 * 판정은 보수적으로: `<system-reminder>` 로 **시작할 때만**, **마지막** 닫는 태그 뒤를
 * 원문으로 본다. 사용자가 본문에 그 문자열을 쓴 경우를 잘라먹지 않는다.
 */
export const stripAssembledPrefix = (content: string): string => {
  if (typeof content !== "string") return "";
  if (!content.startsWith("<system-reminder>")) return content;
  const close = "</system-reminder>";
  const i = content.lastIndexOf(close);
  if (i === -1) return content;
  const rest = content.slice(i + close.length).trim();
  // 프리픽스만 있고 본문이 없으면(드묾) 원본 유지 — 빈 턴을 만들지 않는다.
  return rest === "" ? content : rest;
};

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
    // ★프리픽스를 **먼저** 걷어내고 센다 — 안 그러면 charCap 예산을 조립 보일러플레이트가
    //  잡아먹어 정작 실제 대화가 잘린다(위 stripAssembledPrefix 주석의 사고).
    const body = r.role === "assistant" ? r.content : stripAssembledPrefix(r.content);
    if (charSum + body.length > charCap) break;
    charSum += body.length;
    kept.unshift({
      role: r.role === "assistant" ? "assistant" : "user",
      content: body,
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
    // user 턴만 — assistant 응답엔 프리픽스가 없다(위 stripAssembledPrefix 주석).
    content: r.role === "assistant" ? r.content : stripAssembledPrefix(r.content),
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
