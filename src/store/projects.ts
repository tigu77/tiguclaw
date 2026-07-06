/**
 * 프로젝트 레지스트리 (인덱스만) — 등록된 프로젝트 경로 조회 캐시.
 *
 * ★진실 소스는 각 폴더의 `<path>/PROJECT.md`. 이 테이블은 대시보드/조회용 인덱스일 뿐이다
 * (self-growth SELF_GROWTH.md + SQLite 하이브리드 동형: 파일=진실, DB=인덱스). store 는
 * PROJECT.md 를 *파싱하지 않는다* — 파싱은 project-registry MCP 도구가 하고 결과만 upsert.
 * → store 는 "프로젝트"를 데이터 스키마로만 안다(파일 진실 참조 0, 단방향 정합).
 *
 * 진실 소스 ADR: docs/decisions/2026-07-06-projects-feature.md §1.
 */
import { getDb } from "./sessions.js";

export type ProjectStatus = "active" | "paused" | "done";

export interface ProjectRow {
  /** 절대경로 (프로젝트 폴더 = PK). PROJECT.md 는 <path>/PROJECT.md. */
  path: string;
  /** PROJECT.md frontmatter name 캐시 (등록/갱신 시점 스냅샷). */
  name: string;
  status: ProjectStatus;
  /** 카드 요약 캐시 (본문 전문은 상세 열 때 파일 재-Read). */
  description: string | null;
  registeredAt: number;
  updatedAt: number;
}

interface DbRow {
  path: string;
  name: string;
  status: string;
  description: string | null;
  registered_at: number;
  updated_at: number;
}

const toRow = (r: DbRow): ProjectRow => ({
  path: r.path,
  name: r.name,
  status:
    r.status === "paused" || r.status === "done" ? r.status : "active",
  description: r.description,
  registeredAt: r.registered_at,
  updatedAt: r.updated_at,
});

/**
 * 등록/갱신 — path 가 PK(재등록=갱신). name/status/description 은 호출자(도구)가
 * PROJECT.md 를 파싱해 전달한다(store 는 파일 안 읽음 — 순수 저장). registered_at 은
 * 최초 등록 시각 보존(재등록 시 유지), updated_at 은 매번 now.
 */
export const upsertProject = (row: {
  path: string;
  name: string;
  status: ProjectStatus;
  description?: string | null;
}): void => {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO projects (path, name, status, description, registered_at, updated_at)
       VALUES (@path, @name, @status, @description, @now, @now)
       ON CONFLICT(path) DO UPDATE SET
         name = @name, status = @status, description = @description, updated_at = @now`,
    )
    .run({
      path: row.path,
      name: row.name,
      status: row.status,
      description: row.description ?? null,
      now,
    });
};

/** 등록 목록 — updated_at 내림차순(최근 활동 먼저). */
export const listProjects = (): ProjectRow[] =>
  (
    getDb()
      .prepare(
        `SELECT path, name, status, description, registered_at, updated_at
           FROM projects ORDER BY updated_at DESC`,
      )
      .all() as DbRow[]
  ).map(toRow);

export const getProject = (path: string): ProjectRow | undefined => {
  const r = getDb()
    .prepare(
      `SELECT path, name, status, description, registered_at, updated_at
         FROM projects WHERE path = ?`,
    )
    .get(path) as DbRow | undefined;
  return r === undefined ? undefined : toRow(r);
};

/** 등록 해제 — 인덱스에서만 제거. PROJECT.md 파일은 안 지운다. */
export const forgetProject = (path: string): void => {
  getDb().prepare(`DELETE FROM projects WHERE path = ?`).run(path);
};
