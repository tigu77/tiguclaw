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
import { createHash } from "node:crypto";
import {
  safeUnsubscribe,
  type EventBus,
  type EventBusEvent,
} from "../../../src/core/eventbus.js";
import { getMemory } from "../../../src/store/memory.js";
import { recordSkillInvocation } from "../../../src/store/skill-usage.js";
import {
  cleanupDirectives,
  ensureSelfGrowthFile,
} from "../../../src/store/self-growth-md.js";
import {
  reflectFailureCause,
  type FailureReflection,
} from "../../../src/core/llm-runtime/classify-failure.js";
import {
  PATTERN_MAP_CAP,
  SELF_NAMESPACE,
  TTL_CLEANUP_INTERVAL_MS,
  EVENT_SWEEP_MIN_INTERVAL_MS,
} from "./constants.js";
import {
  analyzeDriftPattern,
  analyzeRepeatedSegment,
  correlateTurnOutcome,
  failureKey,
  normalizeErrorMessage,
  type MemoryWritePayload,
  type SkillInvokedPayload,
  type TurnDonePayload,
  type TurnErrorPayload,
} from "./analysis.js";
import { deliverOutbound } from "../../../src/core/outbound.js";
import { runHealthSweep } from "./health.js";
import {
  analyzeFailurePattern,
  deriveWorkerAdapter,
  deriveWorkerErrorKind,
  normalizeTaskKey,
  routeFailureReflection,
  WORKER_FAILURE_THRESHOLD,
  type WorkerFailedPayload,
} from "./failure.js";
import {
  accumulateEfficiency,
  archiveStaleReflections,
  archiveColdObservations,
  efficiencyKey,
  emptyEfficiencyAccumulator,
  generateWeeklyReview,
  type EfficiencyAccumulator,
} from "./efficiency.js";
import { runSkillImproveScan, runSkillProposalScan } from "./skills.js";
import {
  ensureDirectivePointer,
  migrateLegacyLessons,
} from "./directives.js";

class SelfGrowthPlugin {
  readonly name = "self-growth";
  private bus: EventBus | null = null;
  private unsubscribe: (() => void) | null = null;
  // V2 — 메모 update 카운트 (이 데몬 부팅 이후 누적). 재시작 시 리셋.
  private updateCounts: Map<string, number> = new Map();
  // V2.1 — TTL cleanup interval handle.
  private cleanupInterval: NodeJS.Timeout | null = null;
  // V3 — 실패 패턴 누적 카운트 (부팅 이후 in-memory, 영구성 불필요). cap 으로 누수 방지.
  private failureCounts: Map<string, number> = new Map();
  /** 자가 진단 스윕 증분 기준(마지막 스윕 시각). 부팅 시각으로 시작 = 과거분 재보고 0. */
  private lastHealthSweepTs = Date.now();
  // V3 — 효율 관측 누적 ((adapter,model) 별). 관측 신호까지만 — 라우팅 분기 0.
  private efficiency: Map<string, EfficiencyAccumulator> = new Map();

  async startObserver(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event);
    });
    // V4 — 시작 시 1회: 포인터 메모 멱등 upsert(단방향 핵심) + 레거시 lesson 마이그레이션.
    // 포인터는 동기·즉시. 마이그레이션은 async(파일 쓰기) → fire-and-forget(내부 never-throw).
    // ★파일 seed 선행 — 확정 지침이 아직 없어도 SELF_GROWTH.md 가 존재하게 해 포인터가
    //  dangling 안 되게(fresh install 에서 비서가 "SELF_GROWTH.md 못 찾음" 하던 버그 수정).
    void ensureSelfGrowthFile();
    ensureDirectivePointer();
    void migrateLegacyLessons();
    // V2.1+V2.2 — 시작 시 즉시 1회 + 1시간 간격 maintenance (cleanup + 주간 회고 + 지침 정리).
    this.runMaintenance();
    this.cleanupInterval = setInterval(() => {
      this.runMaintenance();
    }, TTL_CLEANUP_INTERVAL_MS);
    console.log(
      "self-growth: started, subscribe[memory.write, llm.turn_error, llm.turn_done, skill.invoked, scheduler.error] + health sweep(주기+이벤트) + TTL cleanup + weekly review + SELF_GROWTH.md directives + skill proposal scan + skill improve proposal scan",
    );
  }

  private runMaintenance(): void {
    this.runHealthSweep();
    this.runCleanup();
    this.runWeeklyReview();
    this.runDirectiveCleanup();
    this.runSkillProposals();
    this.runSkillImproveProposals();
  }

  // ★자가 진단 스윕 (2026-07-26) — 기존 maintenance interval 에 합류(새 interval 0).
  // "티구클로가 자기 이상을 스스로 알아채고 먼저 보고한다" — 종전엔 codex 22문단 반복도,
  // 아침 알림 502 유실도 **사용자가** 발견했다(자기관측 맹점). 읽기 전용 진단만 하고 조치는
  // 사용자 몫. **증분**(마지막 스윕 이후 발생분만)이라 같은 문제를 매 시간 재보고하지 않고,
  // 정상이면 아무것도 안 보낸다(침묵이 기본 — 통보가 잦으면 무시하게 된다).
  // 보고 경로는 2겹: EventBus(대시보드 표시) + 기본 outbound 채널(텔레그램 등). 텔레그램이
  // 죽어 생긴 이상이면 발송도 실패하지만, 대시보드 이벤트는 남아 나중에 확인된다.
  /**
   * 이벤트로 깨우는 스윕 — 짧은 창에 실패가 몰려도 스윕은 한 번만(디바운스). 스윕 자체가
   * 증분이라 중복 보고는 안 되지만, 장애 시 실패 이벤트가 연달아 터지면 DB 조회가 그만큼
   * 반복되므로 최소 간격을 둔다. 주기 스윕(1시간)은 그대로 백스톱으로 남는다.
   */
  private runHealthSweepDebounced(): void {
    const now = Date.now();
    if (now - this.lastHealthSweepTs < EVENT_SWEEP_MIN_INTERVAL_MS) return;
    this.runHealthSweep();
  }

  private runHealthSweep(): void {
    try {
      const since = this.lastHealthSweepTs;
      this.lastHealthSweepTs = Date.now();
      const findings = runHealthSweep(since);
      if (findings.length === 0) return; // 정상 = 침묵.
      for (const f of findings) {
        console.log(`self-growth: health — ${f.kind}: ${f.summary}`);
      }
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.health.finding",
          ts: Date.now(),
          payload: { findings },
        });
      }
      const lines = findings.map((f) => `• ${f.summary}`).join("\n");
      void deliverOutbound({
        channel: "telegram",
        target: null, // 채널 기본 대상(소유자)으로 — 좌표 하드코딩 0.
        text: `🩺 자가 점검에서 이상을 발견했습니다.\n\n${lines}`,
        label: "self-growth:health",
        notice: true, // 인프라 통지(자가 점검) — 비서 발화 아님.
      }).catch(() => {
        /* 발송 실패해도 위 EventBus 통보는 남는다(2겹 보고) */
      });
    } catch (e) {
      console.error(
        `self-growth: health sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Phase 2 (2026-06-24) — 스킬 *개선* 제안 배치 스캔. 기존 maintenance interval 에
  // 합류(새 interval 신설 0). 자체 try/catch 로 store 조회·평가·박기 실패해도 데몬·다른
  // maintenance 안 죽음(견고성 2겹 — runSkillImproveScan 행 단위 + 여기 전체).
  private runSkillImproveProposals(): void {
    try {
      const proposals = runSkillImproveScan();
      for (const p of proposals) {
        console.log(
          `self-growth: skill improve 제안 박힘 — ${p.reflectionName} ` +
            `(skill='${p.skillName}', basis=${p.basis}, failRate=${(p.failRate * 100).toFixed(1)}%)`,
        );
        if (this.bus !== null) {
          // self_growth.* 는 self-growth 입력 아님(메타재귀 무관, 관측·대시보드용).
          this.bus.publish({
            type: "self_growth.skill_improve.added",
            ts: Date.now(),
            payload: {
              reflectionName: p.reflectionName,
              skillName: p.skillName,
              basis: p.basis,
              failRate: p.failRate,
            },
          });
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: skill improve scan failed: ${reason}`);
    }
  }

  // V5 — 스킬화 제안 배치 스캔. 기존 maintenance interval 에 합류(새 interval 신설 0).
  // 자체 try/catch 로 store 조회 실패해도 데몬·다른 maintenance 안 죽음(견고성).
  private runSkillProposals(): void {
    try {
      const proposals = runSkillProposalScan();
      for (const p of proposals) {
        console.log(
          `self-growth: skill proposal 박힘 — ${p.reflectionName} (fingerprint='${p.fingerprint}', count=${p.count})`,
        );
        if (this.bus !== null) {
          // self_growth.* 는 self-growth 입력 아님(메타재귀 무관, 관측·대시보드용).
          this.bus.publish({
            type: "self_growth.skill_proposal.added",
            ts: Date.now(),
            payload: {
              reflectionName: p.reflectionName,
              fingerprint: p.fingerprint,
              count: p.count,
            },
          });
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: skill proposal scan failed: ${reason}`);
    }
  }

  // V4 — SELF_GROWTH.md 확정 지침 cap/TTL 정리. maintenance interval 안에서 호출.
  // cleanupDirectives 가 직렬화(writeLock)·never-throw → 동시 쓰기 경합 0. async fire-and-forget.
  private runDirectiveCleanup(): void {
    void cleanupDirectives().then(
      (removed) => {
        if (removed > 0) {
          console.log(
            `self-growth: directive cleanup — ${removed} stale/over-cap directive(s) removed`,
          );
        }
      },
      (e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`self-growth: directive cleanup failed: ${reason}`);
      },
    );
  }

  private runCleanup(): void {
    try {
      // 둘 다 아카이브(삭제 아님·가역·검색 유지) — 핫 인덱스만 비운다.
      const reflectionsArchived = archiveStaleReflections();
      const obsArchived = archiveColdObservations();
      if (reflectionsArchived > 0 || obsArchived > 0) {
        console.log(
          `self-growth: TTL cleanup — ${reflectionsArchived} stale reflection(s) archived, ${obsArchived} cold obs archived`,
        );
        if (this.bus !== null) {
          this.bus.publish({
            type: "self_growth.cleanup.run",
            ts: Date.now(),
            payload: { reflectionsArchived, obsArchived },
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
    this.unsubscribe = safeUnsubscribe(this.unsubscribe);
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.bus = null;
  }

  private handle(event: EventBusEvent): void {
    // V3 — 입력 축 3종 라우팅. 각 분기 try/catch 는 내부 핸들러가 보유.
    switch (event.type) {
      case "memory.write":
        this.handleMemoryWrite(event.payload as MemoryWritePayload);
        return;
      case "llm.turn_error":
        // fire-and-forget — handleTurnError 는 async(박기 직전 LLM 모순판단)이나
        // 내부 try/catch 로 never-reject. void 로 floating promise 의도 명시.
        void this.handleTurnError(event.payload as TurnErrorPayload);
        return;
      case "worker.failed":
        // Phase 7a (2026-07-02) — 실패 주도 개선. 작업 단위(task) 1급 실패 신호.
        // fire-and-forget async(게이트 통과 시 reflect 1회 LLM 호출) — 내부 try/catch
        // never-reject. worker.failed 는 유저/스케줄 워커만 발행(self-growth 는 워커 안
        // 띄움 = internal 분류만) → 구조적으로 자기입력 아님(§4-3).
        void this.handleWorkerFailed(event.payload as WorkerFailedPayload);
        return;
      case "llm.turn_done":
        this.handleTurnDone(event.payload as TurnDonePayload);
        return;
      case "scheduler.error": {
        // ★즉시 감지 (2026-07-26) — 주기 스윕(1시간)만으론 유실 알림을 최대 한 시간 뒤에야
        // 보고한다. 전달 실패는 사용자가 **받았어야 할 것을 못 받은** 상태라 지연이 그대로
        // 손해다. 실패 이벤트가 오면 그 자리에서 스윕을 돌린다(지표·임계는 동일 — 트리거만 추가).
        //
        // ★단 `willRetry` 면 무시한다. 스케줄러가 자동 재전송을 예약해 둔 상태라 아직 확정된
        //  유실이 아니다. 여기서 알리면 5분 뒤 복구될 건을 "실패했다" 고 먼저 떠드는 꼴
        //  (자동 조치와 통보가 서로를 밟는 전형적 중복).
        const p = event.payload as { willRetry?: unknown } | null;
        if (p !== null && typeof p === "object" && p.willRetry === true) return;
        this.runHealthSweepDebounced();
        return;
      }
      case "skill.invoked":
        // 텔레메트리(2026-06-24) — upsert *만*. self-growth 입력축(repeated/failure/
        // drift/skill_proposal)을 *재트리거하지 않음*(메타재귀 차단, 계약 §4·§10-4).
        // harness 가 스킬 생성 중 invoke_skill 해도 카운트만 오르고 분석은 안 깨움.
        this.handleSkillInvoked(event.payload as SkillInvokedPayload);
        return;
      default:
        return;
    }
  }

  // 텔레메트리(2026-06-24) — skill.invoked → skill_usage 멱등 upsert. **upsert만** —
  // 입력축 재트리거 0(메타재귀). never-throw: upsert 실패가 EventBus subscriber 격리를
  // 넘어 데몬을 못 죽이게(원칙 3). 발행(region)·upsert(여기) 2겹 never-throw.
  private handleSkillInvoked(payload: SkillInvokedPayload): void {
    try {
      if (typeof payload.name !== "string" || payload.name.length === 0) return;
      recordSkillInvocation(payload.name, Date.now());
    } catch (e) {
      console.error(`self-growth: skill.invoked upsert failed: ${e}`);
    }
  }

  private handleMemoryWrite(payload: MemoryWritePayload): void {
    if (typeof payload.name !== "string") return;
    if (payload.action === "add") {
      this.handleAdd(payload.name);
    } else if (payload.action === "update") {
      this.handleUpdate(payload.name);
    }
  }

  // V3 — Map cap (LRU-ish): 초과 시 가장 먼저 들어온 키부터 제거. Map 은 삽입 순서
  // 보존이므로 keys().next() 가 가장 오래된 키. 누수 방지(원칙 6 견고성).
  private capMap<V>(m: Map<string, V>, cap: number): void {
    while (m.size > cap) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  // V3 실패 학습 — turn_error 구독. 같은 (errorKind·adapter·message 군집) 패턴이
  // N≥threshold 누적 시 학습. 단발 무시(원칙 6/12).
  // V3.1 — analyzeFailurePattern 가 async(박기 직전 LLM 모순판단 1회). handle() 는
  // 핸들러를 await 하지 않으므로(EventBus 동기 구독) 여기서 자체 await + catch 로 닫는다.
  // judgeContradiction 은 never-throw + 짧은 타임아웃(10s)이라 데몬 동결 위험 bound.
  private async handleTurnError(payload: TurnErrorPayload): Promise<void> {
    try {
      // 메타-재귀 차단 (iii): self-growth 자신이 LLM 턴을 돌리지 않으므로 region
      // turn_error 는 본 플러그인이 입력으로 되돌리는 루프가 없다. 방어적으로
      // adapter 라벨이 self namespace 면 skip. (모순판단 internal:true 라 turn 이벤트
      // 미발행 → 모순판단 호출 자체도 자기입력을 낳지 않음 — 구조적 차단 유지.)
      const adapter =
        typeof payload.adapter === "string" ? payload.adapter : "";
      if (adapter === "" || adapter.toLowerCase().includes(SELF_NAMESPACE)) {
        return;
      }

      // Phase 1.6 — 이 (실패) 턴 윈도에 invoke 된 스킬에 fail 귀속. message 가 비어도
      // (학습 불가여도) 결과 누적은 유효하니 message 가드 *앞*에서 상관. 자체 try/catch
      // 로 격리 — 상관 실패가 실패-학습 로직을 못 깨게(회귀 0).
      try {
        const ts = Date.now();
        const names = correlateTurnOutcome(
          {
            threadKey: payload.threadKey,
            durationMs: payload.durationMs,
            ok: false,
          },
          ts,
        );
        if (names.length > 0) {
          console.log(
            `self-growth: skill outcome fail 귀속 — ${names.join(", ")}`,
          );
        }
      } catch (e) {
        console.error(`self-growth: skill outcome (fail) correlation failed: ${e}`);
      }

      const errorKind =
        typeof payload.errorKind === "string" ? payload.errorKind : "error";
      const message = typeof payload.message === "string" ? payload.message : "";
      if (message === "") return; // 군집 키 없음 — 학습 불가

      const messageNorm = normalizeErrorMessage(message);
      const key = failureKey({ errorKind, adapter, messageNorm });
      const count = (this.failureCounts.get(key) ?? 0) + 1;
      this.failureCounts.set(key, count);
      this.capMap(this.failureCounts, PATTERN_MAP_CAP);

      // Phase 7a (§4-2 이중 학습 방지) — workerDepth>0 turn_error 는 워커 내부 LLM 턴.
      // 같은 작업 실패가 (a) worker.failed(작업 단위·풍부) (b) turn_error(턴 단위) 둘 다 올
      // 수 있다. worker.failed 를 1급으로 삼고, 워커 turn_error 는 여기서 *reflect 브랜치만*
      // skip 한다(카운트·효율·스킬 결과 귀속은 위에서 이미 유지 — 이중학습은 박기에서만 막음).
      // 메인·서브에이전트 턴(workerDepth 미존재)은 종전대로 학습.
      if (typeof payload.workerDepth === "number" && payload.workerDepth > 0) {
        return;
      }

      const result = await analyzeFailurePattern({
        errorKind,
        adapter,
        message,
        count,
      });
      if (result === null) return;

      console.log(
        `self-growth: failure ${
          result.autoLanded
            ? "확정 지침 SELF_GROWTH.md 박힘"
            : "reflection 강등"
        } — ${result.target}:${result.memoryName} (count=${count})`,
      );
      if (this.bus !== null) {
        this.bus.publish({
          type: "self_growth.failure.learned",
          ts: Date.now(),
          payload: {
            memoryName: result.memoryName,
            autoLanded: result.autoLanded,
            target: result.target, // V4 — "directive"(SELF_GROWTH.md) | "memory"(reflection)
            errorKind,
            adapter,
            count,
          },
        });
      }
      // ★푸시 통보 (2026-07-26) — 확정 지침은 **사람 승인 없이** 행동을 바꾸고 TTL 까지
      // 최장 90일 남는다. 종전엔 대시보드 이벤트로만 알려서, 대시보드를 안 보는 동안 적재된
      // 지침은 사실상 조용히 들어갔다(교정 기회 0). 자동으로 반영하되 **알리고, 사용자가
      // 되돌릴 수 있게** 한다 — 자동화의 안전판은 확신도가 아니라 취소 가능성이다.
      // reflection 강등(제안 상태)은 여기서 침묵 — 아직 아무것도 안 바뀌었다(노이즈 억제).
      if (result.autoLanded && result.target === "directive") {
        void deliverOutbound({
          channel: "telegram",
          target: null,
          text:
            `🧠 반복된 실패를 학습해 **행동 지침**을 자동 반영했습니다.\n\n` +
            `• ${result.memoryName}\n\n` +
            `SELF_GROWTH.md 에 적재됐고 다음 턴부터 적용됩니다. ` +
            `잘못된 판단이면 "그 지침 지워" 라고 말씀해 주세요(확정 안 하면 자동 만료).`,
          label: "self-growth:directive",
          notice: true, // 인프라 통지(자동 학습 반영 알림) — 비서 발화 아님.
        }).catch(() => {
          /* 발송 실패해도 위 EventBus 통보는 남는다(2겹 보고) */
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: turn_error handler failed: ${reason}`);
    }
  }

  // ─── Phase 7a (2026-07-02) — worker.failed 실패 주도 개선 ──────────────────────
  // 게이트 A(의미) → 게이트 B(반복 threshold=2) → 멱등 체크 → 통과+박기임박 순간에만
  // reflect 1회(비용 bound) → routeFailureReflection(4종 라우팅, 전부 suggester).
  // fire-and-forget async — 내부 try/catch never-reject(데몬 생존, 원칙 3).
  private async handleWorkerFailed(payload: WorkerFailedPayload): Promise<void> {
    try {
      const task = typeof payload.task === "string" ? payload.task : "";
      const error = typeof payload.error === "string" ? payload.error : "";
      const status = typeof payload.status === "string" ? payload.status : "";
      const threadKey =
        typeof payload.threadKey === "string" ? payload.threadKey : "";

      // ── 게이트 A (의미성) — reflect 도달 전 drop ─────────────────────────────
      // error·task 둘 다 비면 학습 근거 0 → drop.
      if (task === "" && error === "") return;
      // 사용자 명시 취소는 실패 아님(worker-jobs markCancelled 별도 status) → drop.
      if (status === "cancelled") return;
      // self namespace(growth) 경로면 drop(방어적, 실제 미발생 — self-growth 는 워커 안 띄움).
      if (threadKey.toLowerCase().includes(SELF_NAMESPACE)) return;

      // ── 원인 라벨 도출 (LLM-agnostic 문자열 휴리스틱 — 분기 키 아님, 집계 라벨) ──
      // worker.failed error 문자열에서 errorKind/adapter 를 근사(handleTurnError 는 코어가
      // 실어주지만 worker.failed payload 엔 없음). 어댑터명은 프롬프트에 *사실* 로만 들어감.
      const errorKind = deriveWorkerErrorKind(error);
      const adapter = deriveWorkerAdapter(error);

      // ── 게이트 B (반복성) — 작업 근사 키 count ≥ threshold 만 reflect ───────────
      // failureCounts Map 합류(별도 Map 신설 불요). worker 접두로 turn_error 키와 분리.
      // ★반복 그룹 키 = label 우선. 비서가 task *텍스트* 는 매 실행 재작성(라이브 실측:
      // 같은 작업도 "사용자 요청: …" vs 리워딩 → 다른 키) 하나 label 은 짧고 안정하며,
      // 스케줄 label 의 날짜("…루틴 2026-06-24")는 normalizeErrorMessage 의 숫자 마스킹이
      // 흡수해 날짜 무관 동일 키가 된다. label 없으면 task 폴백.
      const label = typeof payload.label === "string" ? payload.label : "";
      const taskNorm = normalizeTaskKey(label || task);
      const key = `worker|${failureKey({ errorKind, adapter, messageNorm: taskNorm })}`;
      const count = (this.failureCounts.get(key) ?? 0) + 1;
      this.failureCounts.set(key, count);
      this.capMap(this.failureCounts, PATTERN_MAP_CAP);
      if (count < WORKER_FAILURE_THRESHOLD) return; // 단발/미달 무시(일회성 blip 배제)

      // ── 멱등 체크 — 이미 박힌 reflection 있으면 reflect·박기 skip(LLM 호출 0) ───────
      // routeFailureReflection 의 두 산출 name(failure/core_flag)을 사전 확인. skill 경로는
      // analyzeSkillImprove 자체 멱등이라 여기선 failure/core_flag slug 만 확인(보수적 —
      // 둘 중 하나라도 있으면 이미 이 작업키로 학습됨 → 재reflect 불요, 비용 bound §3).
      // slug — 멱등·가독 이름. ASCII 화가 3자 미만(한국어 등 비-ASCII 작업)이면 taskNorm
      // 해시로 폴백 → 빈/동일 slug 충돌 방지(라이브 실측: 한국어 label 이 전부 "_" 로 뭉개져
      // feedback_growth_failure__ 동명 충돌). 해시는 taskNorm 기반이라 같은 작업=같은 이름(멱등).
      const asciiSlug = taskNorm
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50);
      const slug =
        asciiSlug.length >= 3
          ? asciiSlug
          : `w${createHash("sha1").update(taskNorm).digest("hex").slice(0, 12)}`;
      const failureName = `feedback_${SELF_NAMESPACE}_failure_${slug}`;
      const coreFlagName = `feedback_${SELF_NAMESPACE}_core_flag_${slug}`;
      if (getMemory(failureName) !== undefined || getMemory(coreFlagName) !== undefined) {
        return; // 이미 학습됨 — 멱등, LLM 호출 skip(매 실패 호출 금지, ADR Q6)
      }

      // ── reflect 1회 (박기 임박·비멱등 순간에만) — never-throw, internal:true ─────
      // 실패 윈도에 겹친 skill.invoked 이름들(있으면) — skill 유형 라우팅 근거. threadKey 는
      // 원 thread(worker:<id> 아님). 워커 활동은 worker:<jobId> 로 흐르므로 원 thread 로는
      // 못 잡을 수 있음 → 보수적으로 최근 invoke 를 그냥 안 붙이고 빈 배열(과귀속 방지).
      const relatedSkills: string[] = [];
      const reflection: FailureReflection = await reflectFailureCause({
        task,
        errorKind,
        adapter,
        error,
        relatedSkills,
      });

      // ── 4종 라우팅 (전부 suggester — 자동 확정 0) ───────────────────────────
      const routed = routeFailureReflection({
        key: slug,
        reflection,
        task,
        errorKind,
        adapter,
        count,
        relatedSkills,
      });
      if (routed === null) return; // 멱등·근거부족 등으로 미박기

      console.log(
        `self-growth: worker.failed 학습 — ${routed.target}:${routed.name} ` +
          `(cause=${reflection.cause}, ${errorKind}·${adapter}, count=${count})`,
      );
      if (this.bus !== null) {
        // self_growth.* 는 self-growth 입력 아님(메타재귀 무관, 관측·대시보드용).
        this.bus.publish({
          type: "self_growth.failure.learned",
          ts: Date.now(),
          payload: {
            memoryName: routed.name,
            autoLanded: false, // Phase 7a 는 전부 suggester
            target: routed.target,
            cause: reflection.cause,
            errorKind,
            adapter,
            count,
            source: "worker.failed",
          },
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: worker.failed handler failed: ${reason}`);
    }
  }

  // V3 효율 관측 — turn_done 구독. durationMs/토큰을 (adapter,model) 별 누적.
  // **관측 신호까지만** — 코어 라우팅 분기 절대 만들지 않음(원칙 2 하드게이트).
  // 토큰은 "있을 때만" 합산(openai 자주 누락). 메모는 박지 않음(루프 0).
  private handleTurnDone(payload: TurnDonePayload): void {
    try {
      const adapter =
        typeof payload.adapter === "string" ? payload.adapter : "";
      if (adapter === "" || adapter.toLowerCase().includes(SELF_NAMESPACE)) {
        return;
      }

      // Phase 1.6 — 이 (성공) 턴 윈도에 invoke 된 스킬에 success 귀속. 자체 try/catch
      // 로 격리 — 상관 실패가 효율 관측을 못 깨게(회귀 0).
      try {
        const ts = Date.now();
        const names = correlateTurnOutcome(
          {
            threadKey: payload.threadKey,
            durationMs: payload.durationMs,
            ok: true,
          },
          ts,
        );
        if (names.length > 0) {
          console.log(
            `self-growth: skill outcome success 귀속 — ${names.join(", ")}`,
          );
        }
      } catch (e) {
        console.error(`self-growth: skill outcome (success) correlation failed: ${e}`);
      }

      const model = typeof payload.model === "string" ? payload.model : undefined;
      const key = efficiencyKey(adapter, model);
      const acc = this.efficiency.get(key) ?? emptyEfficiencyAccumulator();
      const next = accumulateEfficiency(acc, {
        durationMs: payload.durationMs,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
      });
      this.efficiency.set(key, next);
      this.capMap(this.efficiency, PATTERN_MAP_CAP);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth: turn_done handler failed: ${reason}`);
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
