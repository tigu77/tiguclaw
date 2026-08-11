/**
 * 회귀: **부팅 중 죽어도 로그에 이유가 남는다.**
 *
 * 사고 (2026-08-11, 윈도우 신규 설치): 데몬이 8번 연속으로 `작동 헌법 로드` 직후 죽었는데
 *  로그에 **에러가 한 줄도 없었다**. 사용자가 볼 수 있는 건 `tiguclaw status` 의
 *  `running: 불명` 뿐이었다.
 *
 * 근본: 최후 그물(`uncaughtException`/`unhandledRejection` → `logFatal`)이 index.ts **맨
 *  아래**(≈2,350행)에 등록됐는데, `initStore()` 를 비롯한 부팅은 266행에서 돈다 —
 *  **부팅 전체가 그물 밖**이었다. 핸들러가 없으면 node 는 스택을 console 을 거치지 않고
 *  raw stderr 로 찍고, 윈도우 런처는 창을 숨겨(`sh.Run …, 0, False`) 그걸 버린다.
 *  → 사용자에게도 우리에게도 아무것도 안 남는다.
 *
 * ★부류: **그물이 있다 ≠ 필요한 창에 쳐져 있다.** 하필 가장 깨지기 쉬운 구간(부팅·첫 설치)
 *  이 밖이었고, 잘 도는 기계에선 영영 안 보인다. 이 레포가 반복해 겪은 형상이다
 *  ("게이트는 '있다'가 아니라 '도는가").
 *
 * ★검사 등급 — ①은 **행동**(logFatal 을 실제로 돌려 파일을 읽는다), ②는 순서 린트다.
 *  ②는 최상위 스크립트의 *실행 순서* 판정이라 소스 대조 말곤 수단이 없다(모듈로 뽑으면
 *  그 자체가 부팅 순서를 바꾼다). 그만큼만 믿어라 — 무는 힘은 ①과 ②의 조합에 있다.
 */
import { logFatal } from "../../core/logging.js";
import { sourceOrder } from "./_wiring.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① logFatal 은 **동기로** 뱉는다(exit 직전에도 살아남는다) ────────────
  //  비동기 큐잉 미러였다면 `process.exit(1)` 이 큐를 버려 크래시 줄만 사라진다
  //  (2026-07-31 실측: 직전 줄은 남고 크래시 줄만 증발). 호출 **직후** 그 자리에서
  //  잡히는지 본다 — await 도 tick 도 주지 않는다.
  //  ★제품에 테스트용 구멍을 내지 않는다 — stderr 를 잠깐 가로챌 뿐이다.
  {
    // ★토큰 **모양**의 리터럴을 소스에 남기지 않는다 — 조각으로 조립한다.
    //  처음엔 그냥 적었다가 public 싱크의 시크릿 게이트에 걸렸다(가짜인데도 모양이 같다).
    //  픽스처도 배포되는 파일이고, 그 게이트는 진짜/가짜를 구분할 수단이 없다 — 구분하게
    //  만드는 게 아니라 **모양을 안 만드는** 것이 맞다(예외를 파면 게이트가 약해진다).
    const shapedLikeToken = `${"1234567890"}:${"AA"}${"z".repeat(33)}`;
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
      seen.push(String(chunk));
      return true;
    };
    try {
      logFatal(
        "daemon: uncaughtException — crash-fast:",
        new Error(`부팅 실패 표본 token=${shapedLikeToken}`),
      );
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    const line = seen.join("");
    out.push({
      name: "★logFatal 은 동기 — 호출 직후 그 자리에서 이미 나가 있다",
      ok: line.includes("[fatal]") && line.includes("부팅 실패 표본"),
      got: `즉시 관측=${JSON.stringify(line.slice(0, 80))}`,
    });
    out.push({
      name: "크래시 줄도 소독된다(로그는 사람이 복사해 붙이는 면이다)",
      ok: !line.includes(shapedLikeToken),
      got: line.includes(shapedLikeToken) ? "🔴 토큰이 평문으로 남았다" : "토큰 미노출",
    });
  }

  // ── ② 그물이 부팅 **앞**에 쳐져 있다 ────────────────────────────────────
  {
    const order = await sourceOrder("../../index.ts", [
      /initFileLogging\(\)/, // 로그 파일이 열리고
      /process\.on\("uncaughtException"/, // 곧바로 그물을 치고
      /^initStore\(\);/m, // 그 다음에 부팅이 시작된다
    ]);
    out.push({
      name: "★최후 그물이 initStore() 보다 먼저 등록된다(부팅이 그물 밖이면 안 된다)",
      ok: order.ok,
      got: order.detail,
    });

    const rejOrder = await sourceOrder("../../index.ts", [
      /process\.on\("unhandledRejection"/,
      /^initStore\(\);/m,
    ]);
    out.push({
      name: "unhandledRejection 도 같은 창을 덮는다",
      ok: rejOrder.ok,
      got: rejOrder.detail,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "boot-crash-is-logged",
  guards:
    "부팅 중 크래시가 그물 밖이라 로그에 한 줄도 안 남던 것 — 윈도우 신규 설치에서 데몬이 8번 죽는 동안 사용자가 볼 수 있는 게 'running: 불명' 뿐이었다",
  run,
};
