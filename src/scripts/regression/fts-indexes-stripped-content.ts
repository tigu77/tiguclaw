/**
 * 회귀: 전문 검색 색인은 **조립 프리픽스를 뺀 텍스트**를 담는다 — 원문은 건드리지 않는다.
 *
 * 사고 (2026-08-10, 효율 감사): DB 178MB 중 `transcripts_fts` 가 **101MB**(원문의 2.76배)
 *  였다. 파 보니 claude 어댑터가 SDK jsonl 을 색인하는데 그 "user 메시지" 가 우리가 넘긴
 *  **조립 프롬프트 전문**(SYSTEM.md 헌법 + 메모리 + 스킬 인덱스)이라, 사용자가 한 줄을 쳐도
 *  25KB 가 저장·색인됐다. 852행에 헌법이 852벌 있었고 그게 trigram 으로 2.76배 불었다.
 *  검색 품질도 같이 깎였다 — "게이트웨이" 154건 중 **138건이 헌법 오탐**이었다.
 *
 * ★고침의 핵심은 **무엇을 안 건드리는가**다. 원문(`transcripts.content`)은 그대로 둔다
 *  ("정리 ≠ 삭제" — 콜드 레코드는 안 지운다). 바꾸는 건 파생물인 색인뿐이다.
 *  실측: FTS 101.3MB → 47.0MB(−54MB), 마이그레이션 2.6초.
 *
 * ★뷰(`transcripts_fts_src`)가 필요한 이유가 이 검사의 존재 이유이기도 하다: FTS 의
 *  `rebuild` 는 `content=` 소스를 **다시 읽는다**. 트리거에서만 걸러내면 rebuild 한 번에
 *  조용히 되돌아간다(sessions.ts 가 실제로 rebuild 를 부른다). 그래서 소스 자체가 걸러진
 *  텍스트를 주도록 뷰를 끼웠다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { stripAssembledPrefix } from "../../store/memory.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const PREFIX =
  "<system-reminder>\n# SYSTEM.md — 비서 작동 헌법\n" +
  "게이트웨이 관련 규칙이 여기 잔뜩 있다.\n".repeat(20) +
  "</system-reminder>";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fts-"));
  try {
    const db = new Database(path.join(dir, "t.db"));
    db.exec(`
      CREATE TABLE transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT NOT NULL, ts INTEGER NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, content_indexed TEXT
      );
      CREATE VIEW transcripts_fts_src AS
        SELECT id, COALESCE(content_indexed, content) AS content_indexed, role FROM transcripts;
      CREATE VIRTUAL TABLE transcripts_fts USING fts5(
        content_indexed, role, content='transcripts_fts_src', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts BEGIN
        INSERT INTO transcripts_fts(rowid, content_indexed, role)
        VALUES (new.id, COALESCE(new.content_indexed, new.content), new.role);
      END;
    `);

    const ins = db.prepare(
      `INSERT INTO transcripts (claude_session_id, ts, role, content, content_indexed)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const add = (content: string): void => {
      const idx = stripAssembledPrefix(content);
      ins.run("s1", Date.now(), "user", content, idx === content ? null : idx);
    };
    add(`${PREFIX}\n복셀 씬을 정리해줘`); // 프리픽스 + 본문
    add("게이트웨이 상태 알려줘"); // 프리픽스 없음
    db.prepare(
      `INSERT INTO transcripts (claude_session_id, ts, role, content, content_indexed)
       VALUES (?,?,?,?,?)`,
    ).run("s1", Date.now(), "assistant", "게이트웨이는 정상입니다", null);

    const hits = (q: string): number =>
      (
        db
          .prepare(`SELECT count(*) n FROM transcripts_fts WHERE transcripts_fts MATCH ?`)
          .get(`"${q}"`) as { n: number }
      ).n;

    // ── ① 헌법 문구는 색인에 없다(오탐 0) ────────────────────────────────────
    out.push({
      name: "★프리픽스 문구로 검색해도 안 걸린다(오탐 제거)",
      ok: hits("작동 헌법") === 0,
      got: `"작동 헌법" → ${hits("작동 헌법")}건 (기대 0)`,
    });

    // ── ② 사용자 본문은 정상 검색된다 ────────────────────────────────────────
    out.push({
      name: "프리픽스 뒤 본문은 검색된다",
      ok: hits("복셀 씬") === 1,
      got: `"복셀 씬" → ${hits("복셀 씬")}건 (기대 1)`,
    });
    out.push({
      name: "프리픽스 없는 행도 그대로 검색된다(NULL → 원문 색인)",
      ok: hits("게이트웨이") === 2,
      got: `"게이트웨이" → ${hits("게이트웨이")}건 (기대 2: user+assistant)`,
    });

    // ── ③ ★원문은 보존된다 — 이 수정이 지켜야 할 선 ──────────────────────────
    {
      const row = db
        .prepare(`SELECT content FROM transcripts WHERE id = 1`)
        .get() as { content: string };
      out.push({
        name: "★원문(content)은 그대로다(정리 ≠ 삭제)",
        ok: row.content.startsWith("<system-reminder>") && row.content.includes("복셀 씬"),
        got: `원문 ${row.content.length}자, 프리픽스 보존=${row.content.startsWith("<system-reminder>")}`,
      });
    }

    // ── ④ ★rebuild 후에도 유지된다 — 뷰를 끼운 이유 ──────────────────────────
    //  트리거에서만 걸러냈다면 여기서 헌법이 되살아난다(조용한 원복).
    db.exec(`INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild')`);
    out.push({
      name: "★rebuild 후에도 프리픽스가 색인에 안 들어온다(소스가 뷰라서)",
      ok: hits("작동 헌법") === 0 && hits("복셀 씬") === 1,
      got: `rebuild 후 헌법=${hits("작동 헌법")}건 본문=${hits("복셀 씬")}건 (기대 0 / 1)`,
    });

    // ── ⑤ 색인 **대상 텍스트**가 원문보다 작다 ───────────────────────────────
    //  ★크기는 바이트가 아니라 **소스 길이**로 잰다. 몇 행짜리 표본에선 SQLite 페이지
    //   최소 단위(16KB)가 지배해 파일 크기 비교가 무의미하다 — 그걸 근거로 삼으면
    //   "통과했는데 아무것도 안 지킨" 검사가 된다(처음에 그렇게 썼다가 걸렸다).
    {
      const src = (
        db
          .prepare(`SELECT sum(length(content_indexed)) b FROM transcripts_fts_src`)
          .get() as { b: number }
      ).b;
      const raw = (
        db.prepare(`SELECT sum(length(content)) b FROM transcripts`).get() as {
          b: number;
        }
      ).b;
      out.push({
        name: "★색인 대상 텍스트가 원문보다 작다(프리픽스만큼)",
        ok: src < raw,
        got: `색인 대상 ${src}자 < 원문 ${raw}자 (절감 ${raw - src}자)`,
      });
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "fts-indexes-stripped-content",
  guards:
    "조립 프리픽스(헌법+메모리+스킬 인덱스)가 원문과 함께 색인돼 FTS 가 원문의 2.76배(101MB)로 부풀고 검색이 오탐 138건을 내던 것 + rebuild 가 그 수정을 조용히 원복하던 위험",
  run,
};
