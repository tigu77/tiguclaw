/**
 * 세션에 연결한 프로젝트 — 저장만 한다(판단은 `core/session-projects.ts`).
 * 키는 세션 id(thread_key) 하나 — 채널 무관. 진실 소스: docs/decisions/2026-10-08-session-project-links.md.
 */
import { getDb } from "./sessions.js";

/** 이 세션에 연결된 프로젝트 경로 — 연결한 순서대로. */
export const listSessionProjectPaths = (threadKey: string): string[] =>
  (
    getDb()
      .prepare(`SELECT project_path FROM session_projects WHERE thread_key = ? ORDER BY linked_at, rowid`)
      .all(threadKey) as { project_path: string }[]
  ).map((r) => r.project_path);

/** 연결 — 이미 있으면 그대로(true = 새로 연결됨). */
export const insertSessionProject = (threadKey: string, projectPath: string): boolean =>
  getDb()
    .prepare(`INSERT OR IGNORE INTO session_projects (thread_key, project_path, linked_at) VALUES (?, ?, ?)`)
    .run(threadKey, projectPath, Date.now()).changes > 0;

/** 해제 — 있었으면 true. */
export const deleteSessionProject = (threadKey: string, projectPath: string): boolean =>
  getDb().prepare(`DELETE FROM session_projects WHERE thread_key = ? AND project_path = ?`).run(threadKey, projectPath).changes > 0;
