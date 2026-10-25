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

type LowEvent = { t: string; ms?: number };

interface MacModule {
  selfCheck: () => Promise<
    | { ok: true; dryFired: number; dryStopped: boolean; dryMs: number }
    | { ok: false; where: "dry"; detail: string }
  >;
  DRY_EVENTS: readonly LowEvent[];
  POST_SCRIPT: string;
  dryPost: (events: readonly LowEvent[]) => Promise<{ ok: true; fired: number; stopped: boolean; ms: number } | { ok: false; detail: string }>;
}

interface ControlModule {
  postTimeoutMs: (events: readonly LowEvent[], baseMs: number) => number;
}

/** 실행부 간격 — `POST_SCRIPT` 의 `pause(0.012)` 와 같은 값이어야 한다(이 값이 «최소» 다). */
const GAP_MS = 12;
/** `wait` 표본 길이와 허용 초과분 — `pause` 는 1ms 씩 자며 기한을 보므로 초과는 한 번 깨는 몫(데몬 자식 실측 ~7ms)이다. */
const WAIT_SAMPLE_MS = 300;
const WAIT_SLACK_MS = 60;

export const check: RegressionCheck = {
  name: "computer-use-mac-executor-runs",
  guards:
    "mac 조작 실행부(JXA)가 아예 안 도는데 순수부 회귀가 전부 초록이던 것 · " +
    "«쏜 횟수»(fired)가 루프 밖에서 «받은 항목 수» 를 세어, 한 번도 안 쐈는데 같은 수를 내고 " +
    "그 수가 사용자 로그에 「N번 쏨」으로 적히던 것 · " +
    "launchd 데몬 자식에서 `delay()` 가 ~8.6배 늘어나 빈 연습이 자기 시한에 죽던 것(2026-10-23) · " +
    "입력 사이 최소 간격이 사라지는 것",
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

    const { selfCheck, DRY_EVENTS, POST_SCRIPT, dryPost } = await loadPluginModule<MacModule>(
      "../../../plugins/computer-use/src/mac.ts",
    );
    const { postTimeoutMs } = await loadPluginModule<ControlModule>(
      "../../../plugins/computer-use/src/control.ts",
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

    // ★★**입력 사이 최소 간격이 지켜진다** (2026-10-23). 간격을 «늘어나지 않게» 고치다가
    //  **없애 버리면** 시한은 초록인데 앱이 이벤트를 흘린다 — 그래서 아래(상한)와 짝으로 둔다.
    //  입력 원소(mark·wait·guard 제외)마다 최소 12ms 이므로 루프는 그 합 이상이어야 한다.
    const inputs = DRY_EVENTS.filter((e) => e.t !== "mark" && e.t !== "wait" && e.t !== "guard").length;
    const floorMs = inputs * GAP_MS;
    out.push(
      assert(
        "★★빈 연습 루프가 **입력마다 최소 간격**을 지킨다 — 간격을 없애면 앱이 이벤트를 흘린다",
        r.ok && r.dryMs >= floorMs,
        r.ok ? `dryMs=${String(r.dryMs)} · 하한 ${String(floorMs)}ms (입력 ${String(inputs)} × ${String(GAP_MS)}ms)` : "실행부 실패로 판정 불가",
      ),
    );

    // ★★**쓴 시간이 시한 예산 안이다** — `postTimeoutMs` 가 원소마다 주는 몫(기동분 base 제외)이
    //  실제 루프를 덮어야 진짜 열이 중간에 죽지 않는다(죽으면 붙여넣기 도중 클립보드를 못 되돌린다).
    //  ★데몬 자식에서 `delay(0.012)` 가 103ms 로 늘던 판은 여기서(그리고 위 시한에서) 빨강이다.
    const budgetMs = postTimeoutMs(DRY_EVENTS, 0);
    out.push(
      assert(
        "★★빈 연습 루프가 **`postTimeoutMs` 의 원소 몫 안에서** 끝난다 — 대기가 늘어나면 시한이 거짓이 된다",
        r.ok && r.dryMs >= 0 && r.dryMs <= budgetMs,
        r.ok ? `dryMs=${String(r.dryMs)} · 예산 ${String(budgetMs)}ms(base 제외)` : "실행부 실패로 판정 불가",
      ),
    );

    // ★★**사용자 `wait` 는 준 시간만큼 — 늘지도 줄지도 않는다** (GPT R1-A1). 위 루프 단언은 1ms 표본이라 `wait` 를
    //  옛 `delay` 로 되돌려도 전체 허용 범위에 묻혔다. 입력 없는 `wait` 하나를 따로 잰다(데몬 자식에서 옛 `delay(0.3)` ≈ 0.45초).
    const w = await dryPost([{ t: "wait", ms: WAIT_SAMPLE_MS }]);
    const w0 = await dryPost([{ t: "wait", ms: 0 }]);
    out.push(
      assert(
        `★★\`wait ${String(WAIT_SAMPLE_MS)}ms\` 가 실제로 ${String(WAIT_SAMPLE_MS)}~${String(WAIT_SAMPLE_MS + WAIT_SLACK_MS)}ms · \`wait 0\` 은 즉시 — 쓴 시간이 거짓이 되지 않는다`,
        w.ok && w.ms >= WAIT_SAMPLE_MS && w.ms <= WAIT_SAMPLE_MS + WAIT_SLACK_MS && w0.ok && w0.ms >= 0 && w0.ms <= WAIT_SLACK_MS,
        { wait: w.ok ? w.ms : w.detail.slice(0, 80), wait0: w0.ok ? w0.ms : w0.detail.slice(0, 80) },
      ),
    );

    // ★★**대기는 `pause` 한 곳으로만** (GPT R1-A1). 붙여넣기 대기 셋은 빈 연습이 클립보드를 안 건드리려고 **그 앞에서
    //  돌아오므로** 시간으로 잴 수 없다 — 그래서 스크립트 원문에서 `delay(` 가 `pause` 의 몸통 한 곳뿐인지 본다.
    //  하나라도 `delay(s)` 로 되돌아가면 데몬 자식에서 그 대기가 다시 늘어난다.
    const delays = POST_SCRIPT.match(/\bdelay\(/g)?.length ?? 0;
    const inPause = /function pause\(s\)\{[^\n]*\bdelay\(0\.001\)/.test(POST_SCRIPT);
    out.push(
      assert(
        "★★실행 스크립트의 대기는 전부 `pause`(단조시계 기한) — 날 `delay(` 는 `pause` 몸통 한 곳뿐이다",
        delays === 1 && inPause,
        { delays, inPause },
      ),
    );

    return out;
  },
};
