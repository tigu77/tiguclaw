/**
 * 배경 스폰 중복 판정 (2026-08-20 — 사용자 신고)
 *
 * 사고: 한 응답 안에서 모델이 `spawn_agent` 을 **글자 그대로 같은 인자로 두 번** 발행했다
 * (`2단계 spawn_agent · spawn_agent`). 어댑터는 배치의 tool call 을 충실히 실행하므로
 * 에이전트가 **둘** 떴고, 사용자는 같은 일을 두 번 하는 비용(각 20만 토큰급)을 냈다.
 * 매니저(`run_in_background`)도 같았다.
 *
 * ★왜 지금 생겼나: 배경 서브에이전트(`wait:false`, 2026-08-19)가 들어오면서 도구 설명이
 *  *"여러 개를 동시에 돌릴 때 씁니다"* 로 **병렬 발행을 권하게** 됐다. 그전엔 항상 기다리는
 *  호출이라 두 번 부를 이유가 없었다. 새 기능이 만든 새 행동이다.
 *
 * ★그래서 병렬 자체를 막지 않는다 — 그건 이 기능의 목적이다. 막는 건 **같은 창에 같은
 *  인자**뿐이다. 다른 프롬프트로 다섯 개를 띄우는 건 그대로 된다.
 *
 * 세 질문(땜빵 금지):
 *  - 누가 정하나: 우리. "동일 인자 재발행" 은 모델의 슬립이지 의도가 아니다.
 *  - 어디 사나: 여기 한 곳. 두 스폰 도구가 같이 부르므로 어댑터 3종에 흩어지지 않는다.
 *  - 언제까지: 영구. 상류 모델이 나아져도 이 판정이 틀리는 경우가 없다(같은 인자 = 같은 일).
 *
 * ★조용히 삼키지 않는다 — 걸리면 로그를 남기고, 호출자는 **첫 jobId 를 그대로 돌려준다**
 *  (모델에겐 "이미 띄웠다" 가 사실이고, 그게 다음 판단에 옳은 입력이다).
 */

/** 같은 턴으로 볼 창. 한 배치의 병렬 tool call 은 수백 ms 안에 다 들어온다. */
const WINDOW_MS = 30_000;

interface Recent {
  key: string;
  jobId: string;
  at: number;
}

/** threadKey → 최근 스폰들. 잡 수명과 무관하므로 창 밖은 버린다(무한 증가 0). */
const recent = new Map<string, Recent[]>();

/** 인자 지문 — 도구·에이전트·프롬프트·경로가 모두 같아야 같은 일이다. */
export const spawnKey = (o: {
  tool: string;
  name?: string | undefined;
  prompt?: string | undefined;
  path?: string | undefined;
}): string =>
  [o.tool, o.name ?? "", o.prompt ?? "", o.path ?? ""].join("␟");

/**
 * 이미 같은 스폰이 이 창에 있었나 — 있으면 그 jobId.
 * 없으면 undefined(호출자가 실제로 띄운 뒤 `rememberSpawn` 을 부른다).
 */
export const findDuplicateSpawn = (
  threadKey: string,
  key: string,
  now: number,
): string | undefined => {
  const list = recent.get(threadKey);
  if (list === undefined) return undefined;
  const live = list.filter((r) => now - r.at < WINDOW_MS);
  if (live.length === 0) recent.delete(threadKey);
  else recent.set(threadKey, live);
  return live.find((r) => r.key === key)?.jobId;
};

/** 실제로 띄운 스폰을 기록. */
export const rememberSpawn = (
  threadKey: string,
  key: string,
  jobId: string,
  now: number,
): void => {
  const live = (recent.get(threadKey) ?? []).filter((r) => now - r.at < WINDOW_MS);
  live.push({ key, jobId, at: now });
  recent.set(threadKey, live);
};

/** 테스트 격리. */
export const __resetSpawnDedupeForTest = (): void => {
  recent.clear();
};
