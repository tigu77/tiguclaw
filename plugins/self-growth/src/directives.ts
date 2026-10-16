import {
  deleteMemory,
  listMemories,
} from "../../../src/store/memory.js";
import {
  upsertDirective,
} from "../../../src/store/self-growth-md.js";
import {
  FAILURE_DIRECTIVE_GROUP,
  LEGACY_LESSON_PREFIX,
} from "./constants.js";

// ─── V4 — 확정 지침 층 포인터·마이그레이션 ──────────────────────────

/**
 * V4 1회 마이그레이션 — V3 가 박아둔 `growth_failure_lesson_*` reference 메모를
 * SELF_GROWTH.md 확정 지침으로 옮기고 *메모는 삭제*(이중 노출 0, 임무 §2).
 *
 * 멱등: 옮긴 메모는 삭제되므로 다음 실행 땐 대상 0. directiveKey 는 `failure_<slug>`
 * (V4 신규 경로와 동일 규칙) — 같은 패턴이 신규로 다시 확정돼도 같은 키 덮어쓰기.
 * upsert 성공분만 메모 삭제(실패 시 메모 보존 = 데이터 유실 0). never-throw.
 *
 * @returns 옮겨 삭제된 메모 수.
 */
export const migrateLegacyLessons = async (): Promise<number> => {
  let migrated = 0;
  try {
    const all = listMemories({ type: "reference", limit: 10000 });
    const legacy = all.filter((m) => m.name.startsWith(LEGACY_LESSON_PREFIX));
    for (const m of legacy) {
      // name: growth_failure_lesson_<slug> → directiveKey: failure_<slug>
      const slug = m.name.slice(LEGACY_LESSON_PREFIX.length);
      const directiveKey = `failure_${slug}`;
      const landed = await upsertDirective({
        key: directiveKey,
        text: m.description,
        source: "auto",
        group: FAILURE_DIRECTIVE_GROUP,
      });
      if (landed === null) continue; // 파일 쓰기 실패 → 메모 보존(유실 0).
      try {
        deleteMemory(m.name);
        migrated++;
      } catch {
        // 삭제 실패해도 지침은 들어감 — 다음 실행이 재시도(upsert 멱등이라 이중노출 0:
        // 같은 키 덮어쓰기 + 메모만 잔존). 잔존 메모는 후속 실행에서 재삭제 시도.
      }
    }
    if (migrated > 0) {
      console.log(
        `self-growth: V4 migration — ${migrated} legacy lesson(s) → SELF_GROWTH.md (memos deleted)`,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`self-growth: migrateLegacyLessons failed: ${reason}`);
  }
  return migrated;
};
