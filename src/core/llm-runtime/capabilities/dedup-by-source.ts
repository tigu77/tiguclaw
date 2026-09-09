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
export const dedupeBySource = <T extends Sourced>(items: T[]): T[] =>
  dedupeWithShadows(items).kept;

/**
 * **플러그인이 빌트인을 덮은 자리** — 조용히 넘어가면 안 되는 유일한 충돌 (2026-09-09).
 *
 * ★user·project 가 덮는 것은 **의도**다(오버라이드 모델 — 사용자가 자기 홈에 같은 이름을
 *  두면 그게 이긴다). 그런데 **플러그인은 «남의 것»** 이다: 서드파티가 폴더를 `harness`
 *  라고만 지으면 빌트인을 덮고, 지금은 경고 한 줄도 없다. 격리가 0인 현행에서 그건
 *  «능력 바꿔치기» 가 조용히 되는 자리다.
 * ★그래서 **막지는 않는다** — 막으면 이름이 겹치는 정당한 플러그인이 통째로 죽는다.
 *  대신 **보이게** 한다. 이 레포의 처방은 늘 그것이었다(하드 게이트 금지, 관측은 필수).
 * ★이름공간 표기(`플러그인:이름`)를 도입하면 이 함수가 그 자리다 — 지금은 그 전에
 *  «조용히 덮이는 것만» 막아둔다.
 */
export const dedupeWithShadows = <T extends Sourced>(
  items: T[],
): { kept: T[]; shadowed: Array<{ name: string; by: string }> } => {
  const winners = new Map<string, T>();
  const shadowed: Array<{ name: string; by: string }> = [];
  for (const item of items) {
    const prev = winners.get(item.name);
    // 신규 이름이거나, 기존보다 rank 가 더 높을 때만 교체.
    // 동일 rank(<=)는 먼저 들어온 것 유지 (candidates[0] 동형).
    if (prev === undefined || sourceRank(item.source) > sourceRank(prev.source)) {
      if (prev?.source === "builtin" && item.source === "plugin") {
        shadowed.push({ name: item.name, by: (item as { pluginId?: string }).pluginId ?? "?" });
      }
      winners.set(item.name, item);
    }
  }
  return { kept: [...winners.values()], shadowed };
};

/**
 * 덮인 것을 **한 줄로 알린다** — 네 축(스킬·에이전트·커맨드·엔드포인트)이 같은 문장을
 * 각자 적으면 갈린다. 여기 한 벌만 둔다.
 *
 * ★`console.warn` 이다 — 데몬 로그가 1차 진단면이고, 원격 불가 설치본(회사 PC·윈도우)에선
 *  그게 유일한 창이다([[feedback_logs_must_stand_alone]]). 판정 수치(무엇이·누구에게)를 싣는다.
 */
export const warnShadowed = (
  kind: string,
  shadowed: ReadonlyArray<{ name: string; by: string }>,
): void => {
  if (shadowed.length === 0) return;
  console.warn(
    `[capability-shadow] 플러그인이 빌트인 ${kind} ${shadowed.length}개를 덮었습니다 — ` +
      shadowed.map((s) => `${s.name}(by ${s.by})`).join(", ") +
      ". 빌트인 대신 플러그인 것이 쓰입니다.",
  );
};
