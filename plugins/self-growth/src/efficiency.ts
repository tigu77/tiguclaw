import {
  addMemory,
  listMemories,
  archiveMemory,
  listColdMemoriesForArchive,
} from "../../../src/store/memory.js";
import {
  REFLECTION_TTL_DAYS,
  OBS_ARCHIVE_DAYS,
  OBS_ARCHIVE_PREFIX,
  SELF_NAMESPACE,
  WEEKLY_REVIEW_INTERVAL_MS,
} from "./constants.js";

/**
 * V3 효율 관측 — turn_done 의 durationMs/토큰을 (adapter, model) 별로 누적 관측한다.
 * **관측 메모(비서가 읽는 신호)까지만** — 코어 라우팅 분기 절대 금지(원칙 2 하드게이트).
 * 토큰 필드는 자주 없음(openai) → "있을 때만" 합산, 0/거짓값 박지 않음.
 *
 * 순수 함수 — 누적 상태(EfficiencyAccumulator)는 호출자가 보유. 여기선 갱신만 반환.
 * 메모는 박지 않는다(효율은 신호 누적 → 주간 회고/명시 조회에서 소비). 효율 신호가
 * 또 다른 turn 을 낳지 않으므로 메타-재귀 0.
 */
export interface EfficiencyAccumulator {
  turns: number;
  totalDurationMs: number;
  // 토큰은 *보고된 턴만* 분모로 — 없는 턴은 분모에서 제외(정직한 미측정).
  tokenSampledTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export const emptyEfficiencyAccumulator = (): EfficiencyAccumulator => ({
  turns: 0,
  totalDurationMs: 0,
  tokenSampledTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
});

export const efficiencyKey = (adapter: string, model?: string): string =>
  `${adapter}|${model ?? "_"}`;

/**
 * 단일 turn_done 을 accumulator 에 반영. durationMs 양수일 때만 카운트.
 * 토큰은 양수(>0)일 때만 합산 — 0/음수/누락은 미측정으로 간주(생략, 거짓값 금지).
 */
export const accumulateEfficiency = (
  acc: EfficiencyAccumulator,
  sample: { durationMs?: number; inputTokens?: number; outputTokens?: number },
): EfficiencyAccumulator => {
  const next: EfficiencyAccumulator = { ...acc };
  if (typeof sample.durationMs === "number" && sample.durationMs > 0) {
    next.turns += 1;
    next.totalDurationMs += sample.durationMs;
  }
  const hasIn =
    typeof sample.inputTokens === "number" && sample.inputTokens > 0;
  const hasOut =
    typeof sample.outputTokens === "number" && sample.outputTokens > 0;
  if (hasIn || hasOut) {
    next.tokenSampledTurns += 1;
    if (hasIn) next.totalInputTokens += sample.inputTokens as number;
    if (hasOut) next.totalOutputTokens += sample.outputTokens as number;
  }
  return next;
};

/**
 * V2.2 사후 회고 — 지난 7일 동안 박힌 reflection 통계를 회고 메모로 박음.
 * 이미 7일 안에 회고 박힌 적 있으면 null (멱등). 강제 박기 = force=true.
 * 회고 name: `feedback_growth_weekly_review_<YYYY-MM-DD>`.
 */
export const generateWeeklyReview = (
  force: boolean = false,
): { reviewName: string; segmentCount: number; driftCount: number } | null => {
  const all = listMemories({ type: "feedback", limit: 10000 });
  const now = Date.now();
  const weekAgo = now - WEEKLY_REVIEW_INTERVAL_MS;

  // 멱등 — 최근 7일 안 회고 박힌 적 있으면 skip.
  if (!force) {
    const recent = all.find(
      (m) =>
        m.name.startsWith(`feedback_${SELF_NAMESPACE}_weekly_review_`) &&
        m.updatedAt >= weekAgo,
    );
    if (recent !== undefined) return null;
  }

  // 지난 7일 동안 생성된 reflection 통계.
  const segmentReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_reflection_segment_`) &&
      m.updatedAt >= weekAgo,
  );
  const driftReflections = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_drift_`) &&
      m.updatedAt >= weekAgo,
  );

  const date = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const reviewName = `feedback_${SELF_NAMESPACE}_weekly_review_${date}`;

  const body = JSON.stringify(
    {
      review_period: `최근 7일 (${new Date(weekAgo).toISOString().slice(0, 10)} ~ ${date})`,
      segment_reflection_count: segmentReflections.length,
      segment_reflection_names: segmentReflections.map((m) => m.name),
      drift_reflection_count: driftReflections.length,
      drift_reflection_names: driftReflections.map((m) => m.name),
      total_memory_count: all.length,
      suggested_action:
        segmentReflections.length + driftReflections.length > 0
          ? "비서가 사용자에게 이번 주 reflection 정리 의향 명시 확인."
          : "이번 주 신호 0 — 정상 운영.",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reviewName,
    description: `이번 주 회고 — segment ${segmentReflections.length}건, drift ${driftReflections.length}건`,
    body,
  });

  return {
    reviewName,
    segmentCount: segmentReflections.length,
    driftCount: driftReflections.length,
  };
};

/**
 * TTL 초과 회고 메모를 **아카이브**한다(삭제 아님·가역·검색 유지).
 *
 * ★2026-07-31: 원래 `deleteMemory` 로 물리 삭제였다(ADR 2026-05-23). 그 결정은
 * 유지보수 철학(2026-07-12 — **정리 ≠ 삭제**, 핫 워킹셋만 바운드하고 콜드 레코드는
 * 보존)보다 앞선 것이라 뒤집는다. 바로 아래 `archiveColdObservations` 가 이미 같은
 * 문제를 아카이브로 풀고 있었다(형제가 답을 들고 있었다).
 *
 * 멱등: `listMemories` 기본이 `archived_at IS NULL` 이라 아카이브분은 다음 실행에서
 * 재매칭되지 않는다 → 반환 카운트가 매 주기 반복되지 않는다.
 *
 * @returns 이번 실행에서 아카이브한 메모 수.
 */
export const archiveStaleReflections = (
  thresholdDays: number = REFLECTION_TTL_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const all = listMemories({ type: "feedback", limit: 10000 });
  const targets = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_`) &&
      m.updatedAt <= cutoffMs,
  );
  let archived = 0;
  for (const m of targets) {
    try {
      if (archiveMemory(m.name) !== undefined) archived++;
    } catch {
      // 무시 — 다른 프로세스가 동시에 처리했을 수 있음.
    }
  }
  return archived;
};

/**
 * P2 (2026-07-18) — 콜드 관측 아카이브. `feedback-obs-*` 중 OBS_ARCHIVE_DAYS 일 미변경 +
 * access_count 0(한 번도 surfaced 안 됨)을 archive(삭제 아님·가역·FTS 검색 유지). 핫 인덱스
 * (always-on) 만 비우고 콜드 레코드는 보존([[project_hotpath_bound_preserve_record]]). access
 * 필터는 store SQL(listColdMemoriesForArchive)에 있어 자주 surfaced 되는 durable obs 는 남는다.
 * 아카이브 갯수 반환. maintenance interval 에서 cleanupStaleReflections 와 나란히 호출.
 */
export const archiveColdObservations = (
  thresholdDays: number = OBS_ARCHIVE_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const names = listColdMemoriesForArchive(OBS_ARCHIVE_PREFIX, cutoffMs);
  let archived = 0;
  for (const name of names) {
    try {
      if (archiveMemory(name) !== undefined) archived++;
    } catch {
      // 무시 — 동시 아카이브/삭제 경합.
    }
  }
  return archived;
};
