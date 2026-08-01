/**
 * 로컬 포트를 물고 있는 게 **우리 프로세스인가** — 세 갈래 판정.
 *
 * 종전엔 "응답이 오면 우리 것" 이라는 두 갈래였다. 그래서 다른 앱이 포트를 물고 있으면
 * 대시보드는 안 뜨는데 로그는 `already up … spawn skipped` 라고 말했다(2026-08-01, 이 기계
 * 에서 두 번 재현). 사용자는 그 주소를 열어 **남의 앱**을 본다.
 *
 * ★두 갈래로는 표현할 수 없는 상태였다. 셋이어야 한다 —
 *   `free`   → 띄운다
 *   `ours`   → 이미 떠 있다, 건너뛴다
 *   `foreign`→ **경고**하고 건너뛴다(spawn 하면 EADDRINUSE 로 죽는다)
 *  foreign 을 free 로 접으면 죽고, ours 로 접으면 지금 사고다. 끝까지 셋으로 유지한다.
 *
 * ★왜 core 에 있나: 이 판정을 쓰는 곳은 `plugins/dashboard` 하나뿐이다. 그런데 `plugins/`
 *  는 tsconfig `include`(`src/**`) 밖이라 **typecheck 도 회귀도 닿지 않는다**. 조용히
 *  틀리기 딱 좋은 자리 — 그래서 판정만 여기로 내리고 플러그인은 마커를 넘겨 쓴다.
 *  ("검사가 껄끄러우면 코드가 잘못 놓인 것")
 */

/** 포트의 상태 — **셋**이다. 둘로 접으면 위 사고 둘 중 하나가 된다. */
export type PortState = "free" | "ours" | "foreign";

/**
 * `127.0.0.1:<port>` 의 `GET /` 응답 본문에 `marker` 가 있으면 `ours`.
 *
 * ★`marker` 는 그 프로세스 **자신이** 만드는 응답에서 골라야 한다. 프록시하는 endpoint
 *  (예: 대시보드의 `/api/health` → bridge)를 쓰면 상류가 죽었을 때 **우리 것을 남의 것으로**
 *  오판한다 — 같은 병의 반대 방향이다.
 *
 * ★응답이 왔다 = 점유는 확실. 본문을 못 읽어도 `free` 로는 내려가지 않는다.
 */
export const probeLocalPort = async (
  port: string,
  marker: string,
  timeoutMs: number,
): Promise<PortState> => {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "free"; // ECONNREFUSED / timeout = 리스너 없음.
  }
  try {
    return (await res.text()).includes(marker) ? "ours" : "foreign";
  } catch {
    return "foreign"; // 응답은 왔는데 본문을 못 읽음 — 누군가 점유 중인 것은 확실하다.
  }
};
