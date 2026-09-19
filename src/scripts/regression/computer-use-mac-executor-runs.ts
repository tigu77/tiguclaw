/**
 * 회귀: **mac 조작 실행부가 실제로 돌고, «쏜 횟수» 가 뜻대로 도는가** (2026-09-19).
 *
 * ★배경 — 2026-09-19 에 `sent` → `fired` 개명을 하면서 **Windows 만 고쳤다.** 맥은 JXA 가
 *  루프 **밖에서** `evs.length` 를 돌려주고 TS 가 그 값을 `fired` 로 이름만 바꿔 읽고
 *  있었다: 「N번 쏨」이라고 사용자 로그에 적으면서 실제로는 **받은 항목 수**였다.
 *  고친 쪽에는 검사가 붙었는데(`computer-use-windows-executor-runs`) 그 검사가
 *  `process.platform !== "win32"` 면 통째로 비켜서므로, **맥 축은 아무도 안 재고 있었다.**
 *
 * ★★그래서 이 파일의 요지는 «맥에도 같은 검사를 붙였다» 가 아니다 — **한 플랫폼만 고친
 *  수정은 반쪽이고, 그 반쪽을 가리는 것이 바로 «플랫폼 가드가 달린 검사»** 라는 것이다
 *  ([[feedback_scope_of_a_fix]] 의 «조건반전 → 도달 입력 전수» 와 같은 모양).
 *
 * ★**제품이 만드는 바로 그 스크립트**(`POST_SCRIPT`)를 돌린다 — 검사용 사본은 이 부류를
 *  못 잡는다(§15-15).
 * ★**입력은 0이다**: `TIGUCLAW_DRY=1` 이 발사구(`post`)와 붙여넣기(`uni`) 둘 다에서 돌아
 *  나오므로 커서·키보드·클립보드 **어느 것도 안 건드린다**. 회귀가 사용자 화면을 만지면
 *  안 된다(principle-check Q7).
 *
 * ★등급: **동작 게이트**(실제로 돌린다). 단 **맥에서만** — 다른 OS 엔 `CGEventPost` 가 없다.
 *  조용히 통과시키지 않고 «대상 아님» 을 한 줄로 말한다(Windows 축과 같은 규율).
 */
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

interface MacModule {
  selfCheck: () => Promise<
    | { ok: true; dryFired: number; dryStopped: boolean }
    | { ok: false; where: "dry"; detail: string }
  >;
}

export const check: RegressionCheck = {
  name: "computer-use-mac-executor-runs",
  guards:
    "mac 조작 실행부(JXA)가 아예 안 도는데 순수부 회귀가 전부 초록이던 것 · " +
    "«쏜 횟수»(fired)가 루프 밖에서 «받은 항목 수» 를 세어, 한 번도 안 쐈는데 같은 수를 내고 " +
    "그 수가 사용자 로그에 「N번 쏨」으로 적히던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    if (process.platform !== "darwin") {
      out.push(
        assert(
          "맥이 아님 — 실행부 스모크는 **대상이 없다**(`CGEventPost` 는 macOS 것이다)",
          true,
          `platform=${process.platform} · 이 축은 맥에서만 의미가 있다`,
        ),
      );
      return out;
    }

    const { selfCheck } = await loadPluginModule<MacModule>(
      "../../../plugins/computer-use/src/mac.ts",
    );
    const r = await selfCheck();

    out.push(
      assert(
        "★**제품이 만드는 JXA 가 실제로 돈다** — 함수 정의 + **대표 이벤트 빈 연습**(입력 0)",
        r.ok,
        r.ok ? `빈 연습 통과 · dryFired=${String(r.dryFired)}` : `${r.where} 에서 실패: ${r.detail.slice(0, 160)}`,
      ),
    );

    // ★★**빈 연습이면 «쏜 횟수» 가 0이어야 한다.** 0이 아니면 그 수는 «우리가 부른 횟수» 가
    //  아니라 «받은 항목 수» 이고, 그러면 이름이 읽는 쪽을 속인다 — Windows 에서 실제로
    //  «`{ok:true, sent:1}` 인데 0자» 를 낳았던 그 모양이다.
    //  ★변이 실측(2026-09-19): `fired: evs.length` 로 되돌리면 **13**, 발사구의 `DRY` 가드를
    //   빼면 **12** — 둘 다 이 단정이 잡는다. 고친 판은 **0**이다.
    out.push(
      assert(
        "★★**빈 연습에서 «쏜 횟수» 가 0이다** — 이름이 뜻대로 돌지 않으면 그게 다음 오진이다",
        r.ok && r.dryFired === 0,
        r.ok
          ? `dryFired=${String(r.dryFired)} (이벤트 13개를 흘렸지만 발사 0이어야 한다)`
          : "실행부 실패로 판정 불가",
      ),
    );

    // ★★**가드가 «빈 연습에서 실제로 멈추는가»** (2026-09-19). 빈 연습 목록 끝에 일부러
    //  어긋나는 `front` 를 두었으므로 반드시 멈춰야 한다.
    //  ★이 단언이 없으면 «가드를 넣었다» 가 «가드가 돈다» 를 뜻하지 않는다 — 실제로 맥에만
    //   넣고 Windows 에는 안 넣었는데 스모크가 전부 초록이었다(모르는 원소를 조용히
    //   건너뛰었기 때문이다). [[feedback_gate_must_actually_run]]
    out.push(
      assert(
        "★★빈 연습의 **어긋난 가드에서 실제로 멈춘다** — 「넣었다」와 「돈다」는 다르다",
        r.ok && r.dryStopped,
        r.ok ? `dryStopped=${String(r.dryStopped)}` : "실행부 실패로 판정 불가",
      ),
    );

    return out;
  },
};
