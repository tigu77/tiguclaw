/**
 * 관측 이벤트 영속 — 감사·메트릭 기반.
 *
 * EventBus(비영속 ring buffer)와 별개로, *의미있는* 이벤트를 SQLite 에 영속한다.
 * 기록 정책(어떤 type 을 남길지·페이로드 캡)은 core/event-persist.ts 의 sink 가 결정 —
 * 본 모듈은 순수 저장/조회/prune CRUD.
 */
import { getDb, visibleSessionSql } from "./sessions.js";

export interface PersistedEvent {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

interface DbRow {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

/** 이벤트 1건 기록. */
export const insertEvent = (
  ts: number,
  type: string,
  payload: string,
): void => {
  getDb()
    .prepare(`INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)`)
    .run(ts, type, payload);
};

/** 관측용 — 전체 건수. maintenance_status(runMaintenanceScan) 가 RETENTION_KEEP 대비 표시. */
export const countEvents = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number })
    .n;

/**
 * **잘리는 행만** 센다 — 경보선(bound) 비교용 (2026-08-27).
 *
 * ★`countEvents()`(전체)를 상한과 비교하면, 대화 도구 스텝이 레코드로 남기 시작한 순간부터
 *  총계가 상한을 넘어 **영구 오경보**가 난다. 경보가 물어야 할 것은 *"자동 정리가 제 일을
 *  하는가"* 이므로, 자르는 대상만 세는 게 맞다. 남기는 축은 별도로 보고한다(정보).
 */
export const countPrunableEvents = (): number => {
  const marks = HIGH_VOLUME_TYPES.map(() => "?").join(", ");
  const v = volatileActivitySql();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE type NOT IN (${marks}) OR (${v.sql})`,
    )
    .get(...HIGH_VOLUME_TYPES, ...v.params) as { n: number };
  return row.n;
};

/**
 * **고volume 타입 목록** — 이들만 자기 몫으로 따로 프루닝한다 (2026-07-30).
 *
 * ★왜: 종전 프루닝은 **전체 건수** 기준(`id <= MAX(id) - keepLast`)이라, 잦은 타입이 상한을
 *  혼자 채우면 **드물지만 중요한 타입이 같이 밀려났다.** 실측: events 10,118건 중
 *  `llm.activity` 8,925건(**88.2%**) → 보존창이 **3.8일**로 줄었고, 그 창 안에만
 *  `llm.turn_error`·`worker.*`·`llm.compaction_stuck` 같은 사고 단서가 남았다.
 *  오늘 고친 버그가 12일 묻혔던 것을 생각하면 조사 창 4일은 너무 짧다.
 *
 *  같은 파일 위쪽 주석이 stream-trace 를 DB 에서 뺀 근거로 **정확히 이 오염**("1만 건 prune
 *  이 에러·lifecycle 을 밀어내는 보존 오염")을 들고 있었는데, `llm.activity` 가 그 역할을
 *  하고 있었다 — 진단은 맞았고 대상만 놓쳤다.
 */
// ★`llm.delta`·`llm.sdk_message` 는 넣지 않는다 — event-persist 의 SKIP_TYPES 라 **애초에
//  영속되지 않는다**(DELETE 가 매번 0행). 원칙 검토 지적: "미래 가능성 위해 만든 항목" 차단.
const HIGH_VOLUME_TYPES = ["llm.activity"] as const;

/**
 * ★**`llm.activity` 는 두 가지 일을 겸한다** — 그래서 프루닝도 갈라야 한다 (2026-08-27).
 *
 *  - **대화의 도구 스텝** = 화면에 보이는 **레코드**. `/chat-history` 가 이걸로 옛 대화의
 *    도구 카드를 복원한다. 지우면 사용자가 **말은 있는데 도구만 사라진** 대화를 본다.
 *  - **그 밖의 활동** = 진짜 **휘발성 텔레메트리**(잡·서브에이전트·스케줄·엔드포인트·
 *    게이트웨이·내부 파생). 사용자가 **열 수 없는** 좌표라 화면 어디에도 안 나온다.
 *
 * ★**판정을 새로 만들지 않는다** (2026-08-27 적대 검토 F1). 첫 판은 접두 목록을 손으로 적었고
 *  (`worker:`/`agent:`/`gateway:`), 그건 정본(`INTERNAL_THREAD_PREFIXES`)과 **두 개가
 *  어긋난 네 번째 사본**이었다. 실측: `scheduler:` 677건 · `suggest:` 70 · `webfetch:` 6 이
 *  "대화 레코드" 로 분류돼 영원히 안 지워지고, 경보도 그걸 안 세서 **원리적으로 못 울렸다.**
 *  (라벨이 틀렸을 뿐 수치는 맞았다 — 내가 헤더에 "대화 0.12MB/일" 이라 적은 것의 **절반이
 *  대화가 아니었다**.)
 *
 * ★그래서 **뒤집는다**: 무엇이 휘발성인지 열거하는 대신, **"사용자가 열 수 있는 세션인가"**
 *  를 묻는다. 그 판정은 이미 있다 — `visibleSessionSql` 이고, **검색·세션 목록이 같은 걸
 *  쓴다**. 실측으로 레코드 1,523 → **770건**(753건이 열 수도 없는 좌표였다).
 *  ★접두가 새로 생겨도 자동으로 따라온다. 손 목록이 아예 없어진다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★`INTERNAL_THREAD_PRUNABLE_PREFIXES`(scheduler 제외판)를 쓰면 **안 된다** — 그건
 *  `threads` **행**을 지울 때의 판단이다(스케줄은 같은 threadKey 를 재사용하므로 지우면
 *  대화 연속성이 끊긴다). 여기서 다루는 건 `events` 행이고, 스케줄의 도구 스텝은 화면에
 *  안 나오므로 텔레메트리다. 두 판단이 겹쳐 보이지만 다른 것이다.
 *
 * 비용: 남기는 축 실측 **0.06MB/일**(연 22MB). 옆의 `transcripts` 가 무한으로 0.49MB/일이다.
 */
/**
 * **휘발성 활동인가** — SQL 조각. 프루닝과 관측(잔여 건수)이 **같은 판정**을 써야 한다.
 *
 * 정의: *"사용자가 열 수 있는 세션의 활동이 **아닌** 것."* 판정 자체는
 * `visibleSessionSql`(검색·세션 목록이 쓰는 그것)에 위임한다 — 여기서 다시 정의하지 않는다.
 *
 * ★`threads` 행이 **아예 없는** 좌표(`suggest:`·`webfetch:` 등 실측)도 자동으로 휘발성이다.
 *  세션이 없으면 열 수 없고, 열 수 없으면 화면에 안 나온다.
 */
const volatileActivitySql = (): { sql: string; params: string[] } => {
  // ★보관된 대화도 **레코드**다 — 보관은 숨기는 것이지 지우는 게 아니다(해제하면 돌아와야
  //  한다). 사용자 뷰와 판정이 갈리는 유일한 지점이라 여기 명시한다.
  const v = visibleSessionSql("t", { includeArchived: true });
  return {
    sql:
      `json_valid(payload) AND json_extract(payload, '$.threadKey') NOT IN (` +
      `SELECT t.channel_thread_id FROM threads t WHERE ${v.conds.join(" AND ")})`,
    params: v.params,
  };
};

/**
 * 프루닝 — 고volume 타입은 **타입별 상한**, 그 외는 **전체 상한**.
 *
 * 고volume 을 먼저 자기 몫으로 자르므로, 남는 상한을 희귀 타입이 쓴다 → 에러·lifecycle 의
 * 보존창이 활동량과 무관해진다. 반환값은 삭제된 총 행수(호출부 관측 문구 무변경).
 */
/**
 * **실제 총 상한** = 희귀 타입 몫(keepLast) + 고volume 타입별 몫(keepLast/2 × 종류수).
 * ★관측(maintenance)이 `RETENTION_KEEP` 을 총 상한으로 쓰면 경보선(bound×1.5)이 실제 상한과
 *  **정확히 같아져 여유가 0** 이 된다(원칙 검토 지적). 고volume 종류가 하나 늘면 그 즉시
 *  영구 `attention` 오경보가 난다. 그래서 공식을 여기서 노출한다.
 */
export const eventsTotalBound = (keepLast: number): number =>
  keepLast + Math.max(1, Math.floor(keepLast / 2)) * HIGH_VOLUME_TYPES.length;

export const pruneEvents = (keepLast: number): number => {
  const db = getDb();
  const marks = HIGH_VOLUME_TYPES.map(() => "?").join(", ");
  const v = volatileActivitySql();
  let removed = 0;
  // ★순위 기반으로 자른다 — `id <= MAX(id) - keepLast` 같은 **오프셋** 방식은 id 가 전역
  //  단조라 고volume 을 먼저 지워도 희귀 행이 여전히 컷오프 아래에 남는다(실측: 그 방식으로
  //  turn_error 5건이 0건이 됐다). 그룹별 "최신 N개만 남긴다"로 바꿔야 공정해진다.
  // ① 고volume 타입: 각자 자기 몫(전체 상한의 절반)까지만.
  const perType = Math.max(1, Math.floor(keepLast / 2));
  for (const t of HIGH_VOLUME_TYPES) {
    // ★**휘발성 축만** 자른다 — 대화의 도구 스텝은 레코드라 남긴다(위 헤더).
    //  `id NOT IN (...)` 의 안쪽 목록도 같은 축으로 좁혀야 한다. 안 좁히면 레코드 행이
    //  "최신 N" 자리를 차지해 **휘발성이 안 잘리고**, 결국 아무것도 안 잘린다.
    removed += db
      .prepare(
        `DELETE FROM events
           WHERE type = ? AND ${v.sql}
             AND id NOT IN (
               SELECT id FROM events
                WHERE type = ? AND ${v.sql}
                ORDER BY id DESC LIMIT ?
             )`,
      )
      .run(t, ...v.params, t, ...v.params, perType).changes;
  }
  // ② 그 외(희귀 타입 전부): 자기들끼리 상한을 쓴다 — 활동량과 무관해진다.
  removed += db
    .prepare(
      `DELETE FROM events
         WHERE type NOT IN (${marks})
           AND id NOT IN (
             SELECT id FROM events WHERE type NOT IN (${marks}) ORDER BY id DESC LIMIT ?
           )`,
    )
    .run(...HIGH_VOLUME_TYPES, ...HIGH_VOLUME_TYPES, keepLast).changes;
  return removed;
};

/** 감사·대시보드 조회 — 최신 먼저. type/sinceTs/limit 필터. */
export const listEvents = (opts?: {
  types?: string[];
  sinceTs?: number;
  limit?: number;
}): PersistedEvent[] => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.types !== undefined && opts.types.length > 0) {
    where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
    params.push(...opts.types);
  }
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 100;
  const sql =
    `SELECT id, ts, type, payload FROM events` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ``) +
    ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params) as DbRow[];
};

/**
 * 한 워커 thread(`worker:<jobId>`)의 *최신* llm.activity 1건 — list_workers 가
 * running 워커마다 "마지막: <도구> N분 전" 표시에 사용(stuck 신호 가시화).
 *
 * 어댑터가 흘린 활동 이벤트의 payload.threadKey 가 워커 thread 이고 payload.label 이
 * 도구명(kind="tool")/코어스 문구(kind="turn"). 활동이 없으면 null(워커가 아직 첫
 * 도구 전이거나 openai coarse floor 미발화 — 정직히 "활동 없음" 표시).
 */
export const getLastWorkerActivity = (
  threadKey: string,
): { label: string; ts: number } | null => {
  // ★json_valid 가드(2026-07-09): 깨진 JSON 행이 json_extract 를 터뜨리지 못하게 inner 에서
  // 유효 행만 걸러 투영(getRecentActivities 동형).
  const row = getDb()
    .prepare(
      `SELECT ts, label FROM (
         SELECT id, ts,
           json_extract(payload, '$.label') AS label,
           json_extract(payload, '$.threadKey') AS tk
         FROM events
         WHERE type = 'llm.activity' AND json_valid(payload)
       )
       WHERE tk = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(threadKey) as { ts: number; label: string | null } | undefined;
  if (row === undefined || row.label === null) return null;
  return { label: row.label, ts: row.ts };
};

/**
 * persisted `llm.activity` 활동 묶음 조회 — self-growth 스킬화 제안(Phase 1)의
 * 세그먼트화 입력. `getLastWorkerActivity` 동형 SELECT(type='llm.activity' +
 * json_extract)지만 *복수* 행을 `(threadKey, ts, label, kind)` 로 끌어온다.
 *
 * 정렬은 `(threadKey, ts)` 오름차순 — 호출자(세그먼트화)가 thread 별 시간순
 * 윈도로 끊기 쉽게. `sinceTs` 로 스캔 윈도를 제한(배치마다 전체 10k 재집계 회피),
 * `limit` 으로 cap. label/kind 가 없는 행(코어 누락·구버전)은 자연 제외(WHERE).
 *
 * 주의: threadKey 필터(worker:/internal 제외)는 SQL 이 아니라 *호출자* 가 한다 —
 * 제외 규칙(메타재귀 §6)을 store SQL 에 하드코딩하지 않고 순수 함수에 둬 테스트·
 * 진화 용이하게(원칙 5).
 */
export const getRecentActivities = (opts?: {
  sinceTs?: number;
  limit?: number;
}): { threadKey: string; ts: number; label: string; kind: string }[] => {
  // ★json_valid 가드(2026-07-09): 깨진 JSON payload 행이 하나라도 스캔 범위에 있으면 SQLite
  // json_extract 가 전체 쿼리를 "malformed JSON" 으로 터뜨린다. inner 에서 json_valid 로
  // 걸러 유효 행만 json_extract 로 투영 → 한 나쁜 행이 스캔을 죽이지 못하게(견고성).
  const innerWhere: string[] = [`type = 'llm.activity'`, `json_valid(payload)`];
  const params: unknown[] = [];
  if (opts?.sinceTs !== undefined) {
    innerWhere.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 5000;
  const rows = getDb()
    .prepare(
      `SELECT threadKey, ts, label, kind FROM (
         SELECT
           json_extract(payload, '$.threadKey') AS threadKey,
           ts,
           json_extract(payload, '$.label') AS label,
           json_extract(payload, '$.kind')  AS kind
         FROM events
         WHERE ${innerWhere.join(" AND ")}
       )
       WHERE threadKey IS NOT NULL AND label IS NOT NULL
       ORDER BY threadKey ASC, ts ASC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    threadKey: string | null;
    ts: number;
    label: string | null;
    kind: string | null;
  }[];
  return rows
    .filter(
      (r): r is { threadKey: string; ts: number; label: string; kind: string } =>
        typeof r.threadKey === "string" &&
        typeof r.label === "string" &&
        typeof r.kind === "string",
    )
    .map((r) => ({
      threadKey: r.threadKey,
      ts: r.ts,
      label: r.label,
      kind: r.kind,
    }));
};
