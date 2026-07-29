/**
 * 회귀: 메모리 **조회**가 FTS 재색인을 유발하지 않는다 (2026-07-28).
 *
 * 사고: memories_au 트리거가 컬럼 제한 없는 AFTER UPDATE 라, 조회 때마다 도는
 * bumpAccess(access_count/last_accessed)가 매번 FTS 삭제+재삽입을 일으켰다
 * → memories_fts_data 가 원본의 11배(1.76MB vs 156KB). "읽기가 쓰기를 유발"하는 구조.
 *
 * 격리: 이 검사는 **임시 홈의 새 DB** 만 쓴다(runner 가 TIGUCLAW_HOME 을 임시로 잡음).
 */
import { getDb } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const ftsBytes = (): number =>
  (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(pgsize),0) n FROM dbstat WHERE name='memories_fts_data'`,
      )
      .get() as { n: number }
  ).n;

export const check: RegressionCheck = {
  name: "fts-reindex",
  guards: "조회가 FTS 를 재색인해 색인이 원본의 11배로 부푼 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated(); // 라이브 DB 접촉 차단(러너 밖 실행 방지).
    const db = getDb();
    const trig = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'`,
      )
      .get() as { sql?: string } | undefined;

    db.prepare(
      `INSERT INTO memories(name, description, body, type, created_at, updated_at)
       VALUES (?, ?, ?, 'reference', ?, ?)`,
      // ★본문을 충분히 길게 (2026-07-29). 12자 본문이면 200회 재색인해도 dbstat 한 페이지
      //  (4096B) 안에 들어가 **크기 무변** 단언이 항상 통과했다(변이 테스트에서 트리거를
      //  넓혀도 초록). 400자면 재색인이 페이지를 넘겨 실제로 잡힌다(실측 4096→12288).
    ).run(
      "regression-fts",
      "회귀 검사용",
      `본문 zqxbase ${"가나다라마바사아자차카타파하".repeat(30)}`,
      Date.now(),
      Date.now(),
    );
    const id = (db.prepare(`SELECT id FROM memories WHERE name='regression-fts'`).get() as { id: number }).id;

    const before = ftsBytes();
    const bump = db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
    );
    for (let i = 0; i < 200; i++) bump.run(Date.now(), id);
    const afterBump = ftsBytes();

    // 내용 수정은 여전히 색인돼야 한다 — 트리거를 좁히다 죽여 버리면 검색이 조용히 썩는다.
    const needle = "zqxregressionneedle";
    db.prepare(`UPDATE memories SET body = ? WHERE id = ?`).run(needle, id);
    const found = (
      db
        .prepare(`SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH ?`)
        .get(needle) as { n: number }
    ).n;

    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return [
      assert("트리거가 UPDATE OF 로 좁혀져 있다", /UPDATE\s+OF/i.test(trig?.sql ?? ""), (trig?.sql ?? "").split("\n")[1] ?? "(없음)"),
      assert("조회성 UPDATE 200회 — FTS 크기 무변", afterBump === before, `${before} → ${afterBump}`),
      assert("내용 수정은 색인에 반영(트리거 생존)", found === 1, `match=${found}`),
    ];
  },
};
