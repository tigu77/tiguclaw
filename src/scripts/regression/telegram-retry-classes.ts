/**
 * 회귀: **어떤 텔레그램 에러를 재시도하는가** (2026-08-06 "간혹 메시지가 안 온다").
 *
 * 이 판정이 두 번 틀렸고 두 번 다 **조용한 유실**로 나타났다:
 *  ①2026-07-26 — GrammyError 를 전부 "논리 에러"로 보고 제외했는데 grammy 는 **502 도
 *    GrammyError 로 던진다**. 아침 스케줄 알림 2건이 재시도 한 번 없이 버려졌다.
 *  ②2026-08-06 — 그 수정이 `>= 500` 으로 좁혀지면서 **429 가 4xx 라는 이유로 제외**됐다.
 *    429 는 논리 오류가 아니라 **흐름 제어**다(`retry_after` 뒤에 보내면 성공한다).
 *    발송이 몰릴 때만 나므로 증상이 "간혹" 이다 — 긴 답변의 다중 청크·스케줄 겹침 등.
 *
 * ★공통 기제: "4xx=영구 / 5xx=일시" 라는 **코드 뭉치기**. 재시도 여부는 숫자 범위가 아니라
 *  **그 에러가 시간이 지나면 풀리는가**로 갈린다.
 *
 * 배선을 본다 — `plugins/` 는 tsconfig rootDir(`src/`) 밖이라 여기서 import 할 수 없다
 * (같은 이유로 typecheck 도 안 걸린다 = 이 부류에 검사가 더 필요한 자리다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

const SRC = "../../../plugins/telegram-channel/index.ts";

export const check: RegressionCheck = {
  name: "telegram-retry-classes",
  guards:
    "재시도 판정이 에러 코드를 뭉뚱그려 502·429 를 버리고 알림을 조용히 유실하던 것(두 번 재발)",
  run: async (): Promise<Assertion[]> => {
    const flow = await sourceHas(SRC, [
      // 429 는 흐름 제어 — 4xx 라고 버리면 몰릴 때 유실된다.
      /e\.error_code === 429\) return true/,
      // 서버가 준 retry_after 를 존중한다(우리 백오프로 먼저 때리면 또 429).
      /const retryAfterMs = /,
      /retry_after/,
      /const delay = retryAfterMs\(e\) \?\? delays\[attempt\]!/,
    ]);
    const fivexx = await sourceHas(SRC, [/e\.error_code >= 500/]);
    const loss = await sourceHas(SRC, [
      // 유실은 **판정 수치와 함께** 남는다 — 원격 인스턴스는 로그가 유일한 진단면이다.
      /telegram 발송 유실 — 청크 \$\{i \+ 1\}\/\$\{chunks\.length\}/,
    ]);

    return [
      assert(
        "★429(흐름 제어)를 재시도한다 — 4xx 라고 버리면 몰릴 때 조용히 유실된다",
        flow.ok,
        flow.ok ? "index.ts: 429 + retry_after 존중" : `누락: ${flow.missing.join(" / ")}`,
      ),
      assert(
        "5xx 재시도가 살아 있다(2026-07-26 아침 알림 2건 유실의 수정)",
        fivexx.ok,
        fivexx.ok ? "error_code >= 500" : `누락: ${fivexx.missing.join(" / ")}`,
      ),
      assert(
        "★양쪽(HTML·plain) 다 실패하면 몇 번째 청크가 못 갔는지 로그에 남는다",
        loss.ok,
        loss.ok ? "청크 i/총, 길이" : `누락: ${loss.missing.join(" / ")}`,
      ),
    ];
  },
};
