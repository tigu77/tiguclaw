// src/core/resource-revision.ts
/**
 * **스냅샷과 이벤트에 순서를 준다** — 리소스별 단조 리비전 (2026-08-27, Phase 1).
 *
 * ★사고가 아니라 **없는 것**을 짓는다. 감사 실측(`docs/decisions/2026-08-27-frontend-
 *  architecture.md` §A.4): 지금 실시간 경로엔 `resource`·`revision`·`eventId` 가 **0곳**이다.
 *  스냅샷(`GET /worker-jobs`)과 이벤트(`worker.*`)가 **서로 순서를 모르기 때문에**, 화면이
 *  재연결할 때마다 손으로 병합해야 했고 그 대가가 `sse.js`·`background-drawer.js` 의
 *  **"재연결 replay 방어" 주석 6곳**이다 — 중복 렌더 · 짝 없는 진행표시 · 과거 메시지가
 *  바닥에 붙음 · 끝난 잡이 다시 도는 것처럼 보임. 전부 실사고였다.
 *
 * ★계약은 **한 줄**이다:
 *
 *      이벤트를 적용할 수 있는 조건은 `event.revision === local.revision + 1` 뿐이다.
 *      크면 → 중간을 놓쳤다 → **스냅샷을 다시 받는다.**
 *      작거나 같으면 → 이미 본 것 → **버린다.**
 *
 *  이 한 줄이 dedup 집합 · sticky 종료 · 순서 가드 · "replay 창 50 밖으로 밀린 긴 매니저" 를
 *  **전부** 대체한다. 각각을 따로 막던 것을 하나로 줄이는 게 이 작업의 값이다.
 *
 * ★**epoch 이 필요하다.** 리비전은 메모리에 산다(프로세스 로컬). 데몬이 재시작하면 1부터
 *  다시 세는데, 그때 옛 리비전을 든 화면이 **"내가 더 최신"** 이라고 오판한다. 부팅마다
 *  바뀌는 값을 같이 실어 **다르면 무조건 스냅샷부터** 받게 한다. 영속 카운터를 두지 않는
 *  이유는 그게 재시작 후 정합을 **보장하지 못하기** 때문이다 — 프로세스가 죽는 사이 DB 가
 *  바뀔 수 있고(수동 편집·복구), 그러면 리비전만 이어져 **더 나쁘다**(틀린 연속성).
 *
 * ★여기 있는 것은 **순서뿐**이다. 무엇이 바뀌었는지는 payload 가 말한다. 이 모듈은 어떤
 *  리소스가 있는지도 모른다 — 문자열 키를 받을 뿐이라 손 목록이 생기지 않는다.
 */

/**
 * 이 프로세스의 리비전 세대. 부팅마다 바뀐다.
 *
 * ★`Date.now()` 를 쓰지 않는다 — 시계가 뒤로 갈 수 있고(NTP·수동), 같은 밀리초에 두 번
 *  뜰 수도 있다. 순서가 아니라 **다름**만 필요하므로 난수 문자열이면 충분하다.
 */
const EPOCH = `e${Math.random().toString(36).slice(2, 10)}`;

/**
 * 첫 리소스 — **하나로 시작한다** (2026-08-27 결정). 계약을 위젯 하나로 증명한 뒤 넓힌다.
 * 이름을 상수로 두는 이유는 서버·화면·회귀가 같은 글자를 쓰게 하려는 것뿐이다.
 */
export const RUNNING_WORK = "running-work";

const revisions = new Map<string, number>();

/** 지금 리비전(아직 한 번도 안 바뀌었으면 0). */
export const currentRevision = (resource: string): number =>
  revisions.get(resource) ?? 0;

/** 이 프로세스의 세대. 화면이 이 값이 달라지면 스냅샷부터 다시 받는다. */
export const revisionEpoch = (): string => EPOCH;

/**
 * 리소스가 바뀌었다 — 리비전을 하나 올리고 새 값을 돌려준다.
 *
 * ★**변경마다 정확히 한 번** 불러야 한다. 이벤트를 발행하는 그 자리에서 부르는 게 규칙이다
 *  (두 곳에서 부르면 화면이 "중간을 놓쳤다" 고 판단해 불필요한 스냅샷을 받는다 — 틀리진
 *  않지만 낭비다). 반대로 안 부르면 **조용히 안 따라온다** — 그쪽이 훨씬 나쁘다.
 */
export const bumpRevision = (resource: string): number => {
  const next = currentRevision(resource) + 1;
  revisions.set(resource, next);
  return next;
};

/** 스냅샷 응답에 실을 좌표. 목록은 호출자가 붙인다(이 모듈은 데이터를 모른다). */
export interface ResourceStamp {
  resource: string;
  epoch: string;
  revision: number;
}

export const stampFor = (resource: string): ResourceStamp => ({
  resource,
  epoch: EPOCH,
  revision: currentRevision(resource),
});

/**
 * 화면이 이벤트를 어떻게 다뤄야 하는가 — **판정을 여기 한 곳에 둔다.**
 *
 * ★서버(TS)와 화면(브라우저 JS)이 각자 구현하면 **반드시 갈린다**. 그래서 판정은 순수
 *  함수로 여기 있고, 회귀가 이걸 **실행해서** 검사한다. 화면 쪽 구현이 생기면 같은
 *  케이스 표를 공유한다([[feedback_simple_composable_no_duplication]]).
 */
export type ApplyDecision = "apply" | "ignore" | "resnapshot";

export const decideApply = (
  local: { epoch: string; revision: number } | null,
  event: { epoch: string; revision: number },
): ApplyDecision => {
  // 아직 스냅샷을 못 받았거나 세대가 다르다 → 이벤트만으로는 상태를 만들 수 없다.
  if (local === null || local.epoch !== event.epoch) return "resnapshot";
  if (event.revision === local.revision + 1) return "apply";
  if (event.revision <= local.revision) return "ignore"; // 중복·replay
  return "resnapshot"; // 건너뛴 구간이 있다
};
