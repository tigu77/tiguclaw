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

// V3 (2026-06-22) — 작업에서 배우기. 입력 축 확장: llm.turn_error(실패) +
// llm.turn_done(효율). region contract(selfgrowth_events_region_contract.md)
// 가 진실 소스. ADR 2026-06-22-self-growth-v3-learn-from-work 가드레일 6종 준수.
//
// 실패 학습: 같은 (errorKind, adapter, message prefix) 패턴이 N≥threshold 누적 시
// 학습 (단발 무시 — 원칙 6/12). 누적 카운트는 부팅 이후 in-memory Map (영구성 불필요,
// 기존 drift Map 답습). cap 으로 메모리 누수 방지.
export const FAILURE_THRESHOLD = REPEAT_THRESHOLD; // N≥3 답습
// 실패/효율 키 Map 의 최대 엔트리 수 — 초과 시 가장 오래된 키부터 제거 (LRU-ish).
export const PATTERN_MAP_CAP = 2000;

// V3.1 — LLM 모순판단 게이트 (박기 임박 순간만 1회 호출).
// 타임아웃 짧게(동기 EventBus 핸들러가 데몬을 길게 블로킹 못 하게, ADR 가드레일 c ≤15s).
export const CONTRADICTION_TIMEOUT_MS = 10_000;
// existing 비교 대상 cap — 토큰·본질(과하게 주지 말 것). 관련 상위 N개만.
export const CONTRADICTION_EXISTING_CAP = 5;

// V4 (2026-06-22) — 확정 지침 층 포인터 + 마이그레이션.
// 포인터 메모: 매 턴 메모리 인덱스 prepend 로 generic 주입돼 비서가 SELF_GROWTH.md 를
// Read 하게 유도(단방향). growth namespace 라 self-growth 자기분석 skip 됨(메타재귀 0).
export const POINTER_MEMO_NAME = "growth_directive_pointer";
// V3 레거시 reference 메모 prefix — V4 가 1회 SELF_GROWTH.md 로 이관 후 삭제(이중 노출 0).
export const LEGACY_LESSON_PREFIX = "growth_failure_lesson_";
// 실패 지침의 SELF_GROWTH.md 그룹 라벨(사람이 읽는 분류).
export const FAILURE_DIRECTIVE_GROUP = "failure";

// ─── V5 (2026-06-24) — 스킬화 제안 (반복 작업 능동 감지 → suggester) ───────────
// 진실 소스: _workspace/skill_proposal_architect_contract.md + ADR
// 2026-06-24-self-growth-skill-proposal.md. 신호 = persisted llm.activity 도구
// 시퀀스 fingerprint. 코어 무수정 — 기존 events 조회·reflection 층·maintenance
// interval 재사용(신규 코어 기계 0).
//
// 임계 — V3 REPEAT_THRESHOLD 답습(단발·우연 2회 무시, 서로 다른 세그먼트 N회).
export const SKILL_PROPOSAL_THRESHOLD = REPEAT_THRESHOLD; // = 3
// 연속 activity 간 간격이 이 이하면 같은 세그먼트(=1 작업 근사). turnId 부재의 근사.
export const SEGMENT_GAP_MS = 5 * 60 * 1000; // 5분
// 세그먼트 fingerprint 의 최소 고유 도구 종류 — 미달이면 fingerprint 안 만듦.
// 단일 Read 류 trivial·openai coarse turn(도구 0) 자연 제외(어댑터 분기 아님 = 신호 게이트).
export const MIN_DISTINCT_TOOLS = 2;
// 제안 reflection name prefix — growth namespace(isSelfNamespace) → 메타재귀 skip 자동.
export const SKILL_PROPOSAL_PREFIX = `feedback_${SELF_NAMESPACE}_skill_proposal_`;
// events 스캔 윈도 — 배치마다 전체 10k 재집계 회피(최근 N일분만). cap 도 둠.
export const SKILL_PROPOSAL_SCAN_DAYS = 14;
export const SKILL_PROPOSAL_SCAN_LIMIT = 5000;
// §5 제외 — 메타·거버넌스 스킬/하네스 이름(도구 label 에 이 토큰이 들어가면 제안 skip).
// activity fingerprint 는 도구 시퀀스라 스킬명을 직접 담진 않지만, 거버넌스 작업이
// 자기 이름 도구(예: harness 발화·skill 호출)를 쓰면 label 에 묻어 나올 수 있어 방어.
export const GOVERNANCE_TOKENS: readonly string[] = [
  "harness",
  "principle-check",
  "tiguclaw-orchestrator",
  "sync-public",
  "code-review",
  "daemon-health-check",
  "claude-code-parity-audit",
  "integration-qa",
  "schedule-safety-check",
  "self-growth",
  "skill_proposal",
];
