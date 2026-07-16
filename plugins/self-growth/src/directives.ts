import {
  addMemory,
  deleteMemory,
  listMemories,
} from "../../../src/store/memory.js";
import { getPaths } from "../../../src/core/paths.js";
import {
  upsertDirective,
  type DirectiveSource,
} from "../../../src/store/self-growth-md.js";
import {
  FAILURE_DIRECTIVE_GROUP,
  LEGACY_LESSON_PREFIX,
  POINTER_MEMO_NAME,
} from "./constants.js";

// ─── V4 — 확정 지침 층 포인터·마이그레이션·사람 승격 ──────────────────────────

/**
 * V4 포인터 메모 (단방향 핵심) — `growth_directive_pointer` 1건 멱등 upsert.
 *
 * description 이 매 턴 메모리 인덱스(listMemoriesForIndex) prepend 로 generic 주입돼
 * 비서가 *작업 시작 시 SELF_GROWTH.md 를 Read 해 적용* 하게 유도한다. **코어는 이 메모도
 * SELF_GROWTH.md 도 모른다** — self-growth 가 데이터로만 박는 단방향(임무 §3).
 *
 * growth namespace(parseSegment="growth") 라 후속 add 분석에서 self-growth 자기분석
 * skip(메타재귀 0). addMemory 는 raw store 라 memory.write 미발행 → 자기입력 루프 0.
 * 멱등 — 이미 있으면 description/body 갱신만(addMemory UPSERT). never-throw.
 */
export const ensureDirectivePointer = (): boolean => {
  try {
    const file = getPaths().selfGrowthMd;
    addMemory({
      type: "reference",
      name: POINTER_MEMO_NAME,
      description: `작업 시작 시 확정 지침 파일을 Read 해 적용하라: ${file}`,
      body: JSON.stringify(
        {
          purpose:
            "self-growth 확정 지침 층(SELF_GROWTH.md) 으로의 단방향 포인터. 작업 착수 전 이 파일을 Read 해 해당 상황 지침을 적용하라.",
          path: file,
          note: "코어는 이 파일을 모름 — self-growth 가 데이터로만 관리. 자율 확정은 저위험 한정, 사용자 승격분은 source:user.",
        },
        null,
        2,
      ),
    });
    return true;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`self-growth: ensureDirectivePointer failed: ${reason}`);
    return false;
  }
};

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

/**
 * V4 사람 승격 경로 (임무 §4) — 사용자가 확정/직접 교정한 지침을 SELF_GROWTH.md 에 올린다.
 * 자율 경로와 *같은 upsert 재사용* (동일 키 덮어쓰기·캡·TTL). 단 source 기본 "user" 라
 * 캡/TTL 자동 폐기에서 보호된다(명시 확정 보존). 비서가 사용자 승인 후 호출하는 진입점.
 *
 * 같은 키가 이미 auto 로 있으면 user 로 승격(덮어씀) — source 가 user 로 올라가면
 * 이후 자동 정리 대상에서 제외(applyCapAndTtl 의 user 보호). never-throw.
 */
export const promoteDirective = (input: {
  key: string;
  text: string;
  group?: string;
  source?: DirectiveSource;
}): Promise<boolean> =>
  upsertDirective({
    key: input.key,
    text: input.text,
    group: input.group,
    source: input.source ?? "user",
  }).then(
    (d) => d !== null,
    () => false,
  );
