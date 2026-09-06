/**
 * 회귀: **구독 한도를 «부딪히기 전에» 읽는다 — 타입이 아니라 실물을 보고** (2026-09-06).
 *
 * 배경: 실측에서 «아끼는 것은 돈이 아니라 한도» 라는 결론이 나왔다(구독 OAuth 로 도므로
 * $ 는 정가 환산일 뿐이다). 그런데 한도를 **부딪힌 뒤에만** 알았다(쿨다운 `remainingMs`).
 * SDK 가 `rate_limit_event` 로 사전 정보를 주는데 우리가 안 읽고 있었다.
 *
 * ★★**SDK 타입이 실제 페이로드와 다르다 — 이게 이 검사의 존재 이유다.**
 *  `sdk.d.ts` 의 `SDKRateLimitInfo` 는 `utilization?: number` 를 **최상위**에 선언한다.
 *  그런데 `claude -p` 로 실제로 떠보니 최상위 `utilization` 은 **null** 이고, 진짜 값은
 *  타입에 **선언조차 없는** `unifiedWindows` 안에 창별로 들어 있었다.
 *  타입만 믿고 짰으면 사용률이 **영원히 «?»** 로 찍혔을 것이다(첫 판이 실제로 그랬다).
 *  그래서 **실제 응답을 그대로 박아둔다** — 업스트림이 모양을 바꾸면 여기가 빨개진다.
 *
 * ★모르면 «모른다» 고 말한다 — 값 없는 창은 아예 안 적는다. 숫자를 지어내면 그 숫자로
 *  판단하게 된다(도구 지원 삼상태와 같은 규칙).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { parseRateLimit } from "../../core/llm-runtime/rate-limit-view.js";

/** ★2026-09-06 `claude -p` 로 실제로 받은 값(구독 OAuth). 손으로 지은 것이 아니다. */
const REAL = {
  status: "allowed",
  resetsAt: 1788694200,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  utilization: null, // ★타입은 여기 숫자가 있다고 말하는데 실제로는 null 이다
  unifiedWindows: {
    five_hour: { utilization: 0.1, resetsAt: 1788694200 },
    seven_day: { utilization: 0.34, resetsAt: 1788951600 },
  },
};

export const check: RegressionCheck = {
  name: "rate-limit-view-reads-reality",
  guards:
    "구독 한도를 부딪힌 뒤에만 알던 것 + SDK 타입이 `utilization` 을 최상위에 선언하는데 실물은 `unifiedWindows` 안에 있어, 타입만 믿으면 사용률이 영원히 «?» 로 찍히던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const v = parseRateLimit(REAL);
    out.push(
      assert(
        "★★실제 페이로드에서 **창별 사용률**을 읽는다 — 타입이 말하는 최상위 필드는 null 이다",
        v.windows.length === 2 &&
          v.windows.find((w) => w.name === "five_hour")?.utilization === 0.1 &&
          v.windows.find((w) => w.name === "seven_day")?.utilization === 0.34,
        `창 ${v.windows.length}개: ${v.windows.map((w) => `${w.name}=${w.utilization ?? "?"}`).join(" · ")}`,
      ),
    );
    out.push(
      assert(
        "사람이 읽는 한 줄이 두 창을 다 싣는다(5시간·7일이 따로 차오른다)",
        v.line !== null && v.line.includes("five_hour") && v.line.includes("seven_day"),
        v.line ?? "★한 줄이 null",
      ),
    );

    // ★모르면 «모른다» — 값이 없으면 창을 안 만든다(0% 로 뭉개지 않는다).
    const empty = parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: {} } });
    out.push(
      assert(
        "★값이 없는 창은 «0%» 로 뭉개지 않는다 — 지어낸 숫자로 판단하게 된다",
        empty.line === null,
        `line=${empty.line ?? "null"} · 창 ${empty.windows.length}개(값 있는 것 ${empty.windows.filter((w) => w.utilization !== undefined).length}개)`,
      ),
    );

    // ★★**우리 경로가 실제로 받는 모양** (2026-09-06 라이브 데몬 실측) — CLI 와 다르다.
    //  같은 계정·같은 구독인데 `claude` CLI(2.1.261)는 `unifiedWindows` 를 주고 번들
    //  SDK(0.3.222)는 **안 준다.** 사용률이 아예 없고 창 종류·리셋·status 만 온다.
    //  그래도 값이 있다 — `allowed_warning` 은 **거절 전에** 오는 신호다(종전엔 부딪힌
    //  뒤 쿨다운으로만 알았다). 이 갈래가 깨지면 그 신호까지 같이 죽으므로 못 박는다.
    const SDK_REAL = {
      status: "allowed",
      resetsAt: 1788694200,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
    };
    const sdk = parseRateLimit(SDK_REAL);
    out.push(
      assert(
        "★★사용률이 없는 SDK 페이로드에서도 «어느 창 · 언제 리셋» 은 말한다 — 우리 경로가 실제로 받는 모양이다",
        sdk.line !== null && sdk.line.includes("five_hour") && sdk.line.includes("리셋"),
        sdk.line ?? "★null — 이 경로에서 아무 말도 못 하게 됐다",
      ),
    );
    out.push(
      assert(
        "사용률이 없으면 빈 자리를 남기지 않는다(«five_hour  (리셋» 처럼 두 칸 벌어지면 값이 가려진 것처럼 읽힌다)",
        sdk.line !== null && !sdk.line.includes("  "),
        JSON.stringify(sdk.line),
      ),
    );

    // 타입이 약속하는 모양(최상위)만 오는 경우도 살아야 한다 — 업스트림이 바뀔 수 있다.
    const legacy = parseRateLimit({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.9,
      resetsAt: 1788951600,
    });
    out.push(
      assert(
        "`unifiedWindows` 가 없으면 타입이 선언한 최상위 모양으로 폴백한다",
        legacy.windows.length === 1 && legacy.windows[0]?.utilization === 0.9,
        legacy.line ?? "★null",
      ),
    );
    out.push(
      assert(
        "경고·거절 상태가 한 줄에 드러난다(조용히 지나가면 안 본다)",
        legacy.line !== null && legacy.line.includes("allowed_warning"),
        legacy.line ?? "★null",
      ),
    );

    // 서명은 5%p 버킷 — 1% 마다 찍으면 그것도 소음이다.
    const a = parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.11 } } });
    const b = parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.13 } } });
    const c = parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.28 } } });
    out.push(
      assert(
        "같은 버킷은 같은 서명(로그 반복을 접는다) · 버킷이 바뀌면 다른 서명",
        a.signature === b.signature && a.signature !== c.signature,
        `11%=${a.signature} 13%=${b.signature} 28%=${c.signature}`,
      ),
    );

    // 쓰레기 입력에 안 죽는다 — 관측이 턴을 깨면 안 된다.
    for (const junk of [undefined, null, 0, "x", [], { unifiedWindows: 3 }]) {
      parseRateLimit(junk);
    }
    out.push(assert("쓰레기 입력에 던지지 않는다(관측이 턴을 깨면 안 된다)", true, "6종 통과"));

    return out;
  },
};
export default check;
