/**
 * self-growth plugin — observer capability (자가 성장 V1, 2026-05-22).
 *
 * 역할 (확장 여지 — V1 은 Reflection 단계만, V2+ 에서 Validator/Cleanup/Drift 등 추가):
 *  - V1 (지금): 시간 축 관측 + 반복 패턴 추정 + suggestion 메모리 박기. *적용 0* (원칙 5).
 *  - V2+ 예: contradiction detection · TTL/stale cleanup · drift monitor · 사후 회고 cron.
 *
 * V1 동작:
 *  - memory.write event subscribe.
 *  - 새 feedback_<segment>_* 메모리 add 시 같은 segment 의 누적 count.
 *  - N≥3 누적 → reflection 메모리 박음 (feedback_growth_reflection_segment_<segment>).
 *  - 비서가 매 turn 인덱스 prepend 로 자동 회수 → 사용자에게 명시 확인 후 결정.
 *
 * 원칙 정합:
 *  - 원칙 5: 직접 정책 수정 X — reflection 메모리만 박음 (suggester).
 *  - 원칙 6/12: 반복 패턴 (N≥3) 만 정책화 — 단발 무시.
 *  - 원칙 3: body 에 observed/assumed/confidence 분리 JSON.
 *  - 원칙 20: 코어 sysprompt·5대 원칙·security 무수정 — 메모리만 박음.
 *  - 메타-재귀 차단: feedback_growth_* prefix 는 분석 skip (자기 트리거 막음).
 */
import type { EventBus, EventBusEvent } from "../../../src/core/eventbus.js";
import {
  addMemory,
  deleteMemory,
  getMemory,
  listMemories,
} from "../../../src/store/memory.js";

export const REPEAT_THRESHOLD = 3;
export const SELF_NAMESPACE = "growth";

// V2 (2026-05-23) — drift monitor. 같은 메모가 N≥5 update 시 *인격 표류* 의심.
// 카운트는 플러그인 내부 Map — 데몬 재시작 시 리셋 (마지막 부팅 이후 누적만).
// reflection 멱등 — 이미 박힌 drift reflection 있으면 skip.
export const DRIFT_THRESHOLD = 5;

// V2.1 (2026-05-23) — TTL cleanup. 90일 미접근 reflection 메모 자동 삭제.
// reflection 은 *사용자 미확인 suggestion* 이라 90일 지나면 기각된 것으로 해석.
// 데몬 시작 시 + 1시간 간격 setInterval 검사.
export const REFLECTION_TTL_DAYS = 90;
export const TTL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1시간

// V2.2 (2026-05-23) — 사후 회고 cron. 매 7일 1회 회고 메모 자동 생성.
// 마지막 회고 메모의 updated_at 검사로 멱등 (데몬 재시작 시점 어긋남 무관).
// cleanup 과 같은 1시간 interval 안에서 추가 호출.
export const WEEKLY_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

interface MemoryWritePayload {
  name?: string;
  memoryType?: string;
  action?: string;
}

/**
 * 메모 name 에서 segment 를 robust 하게 추출 (하이픈·언더스코어 공용).
 *
 * 비서(LLM)는 feedback 메모 name 을 일관된 구분자/접두로 만들지 않는다
 * (`feedback-obs-...`, `style-...`, `feedback_growth_...` 모두 관측됨).
 * 원칙 "어떤 기능이든 LLM 무관" — 탐지가 LLM 의 정확한 네이밍에 의존하면 안 됨.
 *
 * 규칙:
 *  - `/[-_]/` 로 토큰화 (하이픈·언더스코어 모두 구분자로 취급).
 *  - 첫 토큰이 "feedback" 이면 segment = 2번째 토큰 (`feedback-obs-*` → "obs").
 *  - 첫 토큰이 "feedback" 이 아니면 segment = 첫 토큰 (`style-*` → "style").
 *  - 토큰이 부족하면 null.
 */
export const parseSegment = (name: string): string | null => {
  const tokens = name.split(/[-_]/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const first = tokens[0]!;
  if (first === "feedback") {
    // feedback 단독(2번째 토큰 없음) 은 segment 없음.
    return tokens.length >= 2 ? tokens[1]! : null;
  }
  return first;
};

/**
 * growth namespace (self-growth 자기 reflection) 메모 여부 — 하이픈·언더스코어 무관.
 * `feedback_growth_*` / `feedback-growth-*` / segment==="growth" 모두 차단.
 * plugin 자기 reflection 이 입력으로 재분석되는 메타-재귀를 막는다.
 */
export const isSelfNamespace = (name: string): boolean => {
  return parseSegment(name) === SELF_NAMESPACE;
};

/**
 * 메모 name 에서 segment 를 robust 하게 추출해, 같은 segment feedback 메모리가
 * N≥threshold 누적 시 reflection 메모리 박음. 이미 박혀 있으면 null (멱등).
 *
 * 토큰화·segment·member 매칭 모두 parseSegment 기반 — 하이픈/언더스코어/접두 무관.
 */
export const analyzeRepeatedSegment = (
  newMemoryName: string,
  threshold: number = REPEAT_THRESHOLD,
): { reflectionName: string; segment: string; members: string[] } | null => {
  const segment = parseSegment(newMemoryName);
  if (segment === null) return null;
  if (segment === SELF_NAMESPACE) return null; // 메타-재귀 차단 (growth)

  // member 매칭도 robust — 문자열 prefix 가 아니라 각 메모를 같은 규칙으로
  // 파싱해 segment 비교 (하이픈/언더스코어/접두 무관 동일 그룹핑).
  const all = listMemories({ type: "feedback", limit: 10000 });
  const members = all
    .filter((m) => parseSegment(m.name) === segment)
    .map((m) => m.name);
  if (members.length < threshold) return null;

  const reflectionName = `feedback_${SELF_NAMESPACE}_reflection_segment_${segment}`;
  if (getMemory(reflectionName) !== undefined) return null;

  const body = JSON.stringify(
    {
      observed_pattern: `feedback 메모리 segment '${segment}' 가 ${members.length}건 반복 (구분자·접두 무관 robust 그룹핑)`,
      members,
      evidence_count: members.length,
      assumed_significance:
        "동일 영역의 반복 피드백 — 상위 정책으로 통합 또는 영역 명시화 후보",
      confidence: 0.4,
      triggered_by: newMemoryName,
      suggested_action:
        "비서가 사용자에게 segment 통합/명시화 의향 명시 확인. 단발 거절 가능 (이 reflection delete).",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reflectionName,
    description: `'${segment}' segment 반복 (${members.length}건) — suggester only, 비서가 사용자 확인 후 결정`,
    body,
  });

  return { reflectionName, segment, members };
};

/**
 * V2 drift monitor — 같은 메모 update 카운트 추적.
 * N≥threshold update 시 `feedback_growth_drift_<name>` reflection 박음.
 * 멱등 — 이미 박혀 있으면 null.
 */
export const analyzeDriftPattern = (
  memoryName: string,
  updateCount: number,
  threshold: number = DRIFT_THRESHOLD,
): { reflectionName: string; updateCount: number } | null => {
  if (updateCount < threshold) return null;

  // 메타-재귀 차단 — growth namespace 메모는 분석 skip (하이픈·언더스코어 무관).
  if (isSelfNamespace(memoryName)) return null;

  const reflectionName = `feedback_${SELF_NAMESPACE}_drift_${memoryName}`;
  if (getMemory(reflectionName) !== undefined) return null;

  const body = JSON.stringify(
    {
      observed_pattern: `메모 '${memoryName}' 가 ${updateCount}회 update — 인격 정합 표류 의심`,
      target_memory: memoryName,
      update_count: updateCount,
      assumed_cause:
        "사용자 의도가 시간에 따라 변하고 있거나, 비서가 사용자 의도를 잘못 추정해 반복 정정 받는 중. SYSTEM.md §Identity 보존선 검토 후보.",
      confidence: 0.4,
      suggested_action:
        "비서가 사용자에게 해당 메모의 정합성 명시 확인. 의도 변경이면 영구 박음, 잘못 추정이면 메모 본문 검토 또는 delete.",
    },
    null,
    2,
  );

  addMemory({
    type: "feedback",
    name: reflectionName,
    description: `'${memoryName}' 메모 ${updateCount}회 update — drift 의심, 사용자 확인 필요`,
    body,
  });

  return { reflectionName, updateCount };
};

/**
 * V2.1 TTL cleanup — `feedback_growth_*` reflection 메모 중 `updated_at` 이
 * thresholdDays 일 이전인 것 자동 삭제. 사용자 미확인 suggestion 의 기각 처리.
 * 삭제된 메모 갯수 반환. 0 개면 console log 0 (noise 0).
 *
 * thresholdDays = 0 시 모든 reflection 삭제 (테스트 용도).
 */
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

export const cleanupStaleReflections = (
  thresholdDays: number = REFLECTION_TTL_DAYS,
): number => {
  const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const all = listMemories({ type: "feedback", limit: 10000 });
  const targets = all.filter(
    (m) =>
      m.name.startsWith(`feedback_${SELF_NAMESPACE}_`) &&
      m.updatedAt <= cutoffMs,
  );
  for (const m of targets) {
    try {
      deleteMemory(m.name);
    } catch {
      // 무시 — 다른 프로세스가 동시 삭제했을 수 있음.
    }
  }
  return targets.length;
};

class SelfGrowthPlugin {
  readonly name = "self-growth";
  private bus: EventBus | null = null;
  private unsubscribe: (() => void) | null = null;
  // V2 — 메모 update 카운트 (이 데몬 부팅 이후 누적). 재시작 시 리셋.
  private updateCounts: Map<string, number> = new Map();
  // V2.1 — TTL cleanup interval handle.
  private cleanupInterval: NodeJS.Timeout | null = null;

  async startObserver(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event);
    });
    // V2.1+V2.2 — 시작 시 즉시 1회 + 1시간 간격 maintenance (cleanup + 주간 회고).
    this.runMaintenance();
    this.cleanupInterval = setInterval(() => {
      this.runMaintenance();
    }, TTL_CLEANUP_INTERVAL_MS);
    console.log(
      "self-growth: started, memory.write subscribe + TTL cleanup + weekly review",
    );
  }

  private runMaintenance(): void {
    this.runCleanup();
    this.runWeeklyReview();
  }

  private runCleanup(): void {
    try {
      const removed = cleanupStaleReflections();
      if (removed > 0) {
        console.log(
          `self-growth: TTL cleanup — ${removed} stale reflection(s) removed`,
        );
        if (this.bus !== null) {
          this.bus.publish({
            type: "self_growth.cleanup.run",
            ts: Date.now(),
            payload: { removed },
          });
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: cleanup failed: ${reason}`);
    }
  }

  // V2.2 — 매 7일 1회 회고 박기 (멱등). cleanup 과 같은 interval 안에서 호출.
  private runWeeklyReview(): void {
    try {
      const result = generateWeeklyReview();
      if (result === null) return;
      console.log(
        `self-growth: weekly review — segment=${result.segmentCount} drift=${result.driftCount}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.weekly_review.added",
          ts: Date.now(),
          payload: {
            reviewName: result.reviewName,
            segmentCount: result.segmentCount,
            driftCount: result.driftCount,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: weekly review failed: ${reason}`);
    }
  }

  async start(bus: EventBus): Promise<void> {
    await this.startObserver(bus);
  }

  async stop(): Promise<void> {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        // 무시.
      }
      this.unsubscribe = null;
    }
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.bus = null;
  }

  private handle(event: EventBusEvent): void {
    if (event.type !== "memory.write") return;
    const payload = event.payload as MemoryWritePayload;
    if (typeof payload.name !== "string") return;

    if (payload.action === "add") {
      this.handleAdd(payload.name);
    } else if (payload.action === "update") {
      this.handleUpdate(payload.name);
    }
  }

  private handleAdd(name: string): void {
    try {
      const result = analyzeRepeatedSegment(name);
      if (result === null) return;
      console.log(
        `self-growth: reflection 박힘 — segment='${result.segment}', members=${result.members.length}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.reflection.added",
          ts: Date.now(),
          payload: {
            reflectionName: result.reflectionName,
            segment: result.segment,
            memberCount: result.members.length,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: analyze (add) failed: ${reason}`);
    }
  }

  // V2 — update event 처리. 누적 카운트 N≥5 시 drift reflection 박음.
  private handleUpdate(name: string): void {
    const next = (this.updateCounts.get(name) ?? 0) + 1;
    this.updateCounts.set(name, next);

    try {
      const result = analyzeDriftPattern(name, next);
      if (result === null) return;
      console.log(
        `self-growth: drift reflection 박힘 — name='${name}', updates=${result.updateCount}`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.drift.detected",
          ts: Date.now(),
          payload: {
            reflectionName: result.reflectionName,
            target: name,
            updateCount: result.updateCount,
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: analyze (update) failed: ${reason}`);
    }
  }
}

export default class SelfGrowthPluginFactory extends SelfGrowthPlugin {}
