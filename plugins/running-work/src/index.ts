/**
 * **Running Work 플러그인** — "지금 뭐 돌고 있나" 를 홈에 (2026-08-28, 증분 5).
 *
 * ★**이 플러그인이 증명하는 것은 기능이 아니라 경계다.** 설계(§I 5번)가 물은 것은
 *  *"코어 데이터도 **특권 없이** 같은 등록소로 붙는가"* 였다. 날씨·지도는 밖에서 온
 *  것이지만 이건 우리 데이터라, 이게 같은 문으로 들어오면 **그 문이 진짜 문이다.**
 *  반대로 안 되면 코어만 쓸 수 있는 뒷문이 있다는 뜻이다.
 *
 * ★그래서 여기엔 **서버 코드가 없다.** 도구도, 데이터 라우트도 없다 — 값은 화면에서
 *  `ctx.resource("running-work")` 로 온다(`resource-store` 가 순서·재연결·스냅샷을 푼다).
 *  이 파일은 매니페스트를 세우고 자산을 배달할 자리를 만들 뿐이다.
 */
export default class RunningWorkPlugin {
  readonly name = "running-work";
  async startService(): Promise<void> {}
  async stop(): Promise<void> {}
}
