/**
 * V9.5 — 워크스페이스 능력 병합 dedup (공통 홈 ∪ 프로젝트 스코프).
 *
 * 진실 소스:
 *  - contract: `_workspace/v95_architect_contract.md`
 *  - ADR: `docs/decisions/2026-05-24-v9-runtime-home.md` L31 (V9.5 = 병합 규칙 확정)
 *
 * 같은 `name` 충돌 시 **project > user(home) > plugin > builtin override** — 이름당 1개만 노출.
 * (이미 getSkillBody/getAgentDefinition/expandCommand 의 우선순위와 동일 규칙.
 *  그 규칙을 discover/인덱스 레벨에도 확장 = 단일 진실.)
 *
 *  - 발견 순서(builtin→user→project→plugin) 그대로 순회하며 name 키 upsert. 더 높은 rank 가
 *    기존을 덮음. 동일 rank 충돌(예: user 안 동일 이름 2개)은 **먼저 들어온 것 유지**
 *    — 기존 body fetch `candidates[0]` 동작 보존.
 *  - 반환 순서: 첫 등장(insertion) 순서 유지 — 인덱스 표시 안정성. fetch 는 순서 무관.
 *
 * 3 registry(skill/agent/command)가 `name`/`source` 필드 동형이므로 공용 1개로 추출
 * (source 우선순위 rank 가 3곳 동일 = 3회 반복 추상화 정당, README 추상화 게이트 충족).
 */
type Sourced = {
  name: string;
  source: "builtin" | "user" | "project" | "plugin";
};

/**
 * source 우선순위: project(3) > user(2) > plugin(1) > builtin(0).
 *
 * 사용자 결정 (2026-06-06, harness 부트스트랩 설계): user(home) override 가 plugin
 * 보다 위. 사용자가 홈에 같은 이름 스킬을 두면 어떤 플러그인보다 우선. builtin
 * (`appRoot()/skills`) 은 최하 — 사용자 홈에 같은 이름이 있으면 home 이 이김
 * (= "기본 번들이 있고 사용자가 홈에 오버라이드하면 홈 버전을 우선").
 */
const sourceRank = (s: Sourced["source"]): number => {
  switch (s) {
    case "project":
      return 3;
    case "user":
      return 2;
    case "plugin":
      return 1;
    case "builtin":
      return 0;
  }
};

/**
 * name 기준 우선순위 dedup. 더 높은 rank 가 기존을 덮고, 동일 rank 는 먼저 등장한 것
 * 유지. 첫 등장 순서로 반환.
 */
export const dedupeBySource = <T extends Sourced>(items: T[]): T[] => {
  const winners = new Map<string, T>();
  for (const item of items) {
    const prev = winners.get(item.name);
    // 신규 이름이거나, 기존보다 rank 가 더 높을 때만 교체.
    // 동일 rank(<=)는 먼저 들어온 것 유지 (candidates[0] 동형).
    if (prev === undefined || sourceRank(item.source) > sourceRank(prev.source)) {
      winners.set(item.name, item);
    }
  }
  return [...winners.values()];
};
