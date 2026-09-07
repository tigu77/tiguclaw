/**
 * 구독 한도 한 줄 — SDK `rate_limit_event` 를 사람이 읽는 문장으로 (2026-09-06).
 *
 * 왜 있나: 종전엔 한도를 **부딪힌 뒤에만** 알았다(쿨다운 `remainingMs`). 그런데 실측에서
 * «아끼는 것은 돈이 아니라 한도» 라는 결론이 나왔는데(구독 OAuth 로 도므로 $ 는 정가
 * 환산일 뿐이다) 정작 그 한도를 볼 방법이 없었다.
 *
 * ★**SDK 타입이 실제 페이로드와 다르다** — 이게 이 모듈이 순수 함수로 따로 있는 이유다.
 *  `sdk.d.ts` 는 `utilization` 을 최상위에 선언하는데, 실제로 온 값은 **최상위가 비어
 *  있고** 타입에 **선언되지 않은** `unifiedWindows` 안에 창별로 들어 있다:
 *
 *    {"status":"allowed","rateLimitType":"five_hour","utilization":null,
 *     "unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":…},
 *                       "seven_day":{"utilization":0.34,"resetsAt":…}}}
 *
 *  타입만 믿고 짰으면 **사용률이 영원히 «?»** 로 찍혔을 것이다. 그래서 실제 응답을 떠서
 *  회귀에 박아둔다 — 업스트림이 모양을 바꾸면 그때 여기가 빨개진다.
 *
 * ★★**그리고 경로마다 오는 것이 다르다** (2026-09-06 라이브 실측). 같은 계정·같은 구독인데
 *  `claude` CLI(v2.1.261)와 번들 SDK(0.3.222)가 **다른 페이로드**를 준다:
 *    CLI  → `unifiedWindows: { five_hour: {utilization 0.1}, seven_day: {utilization 0.34} }`
 *    SDK  → `{status, resetsAt, rateLimitType, overage*}` — **사용률이 아예 없다**
 *  즉 **우리 경로에서는 «몇 % 썼나» 를 알 수 없다.** 아는 것은 «어느 창이 걸려 있나 ·
 *  언제 리셋되나 · allowed / allowed_warning / rejected» 셋이다.
 *  ★그래도 값이 있다: `allowed_warning` 은 **거절 전에** 오는 신호다. 종전엔 부딪힌 뒤
 *   쿨다운으로만 알았다. 사용률은 SDK 가 주기 시작하면 이 코드가 **그대로** 받는다
 *   (그래서 `unifiedWindows` 갈래를 남겨둔다 — 지우면 올라갈 때 다시 짜야 한다).
 *
 * ★모르면 «모른다» 고 말한다 — 값이 없는 창은 아예 안 적는다(빈 자리가 «모름» 이라는 뜻이
 *  되게 둔다). 숫자를 지어내면 그 숫자로 판단하게 된다.
 */

/** 초 단위 epoch 도 ms 도 받는다 — 업스트림이 어느 쪽인지 약속하지 않는다. */
const toDate = (v: unknown): Date | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return new Date(v < 1e12 ? v * 1000 : v);
};

const hhmm = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export interface RateLimitWindow {
  readonly name: string;
  /** 0~1. 모르면 undefined — 0 으로 뭉개지 않는다. */
  readonly utilization?: number;
  readonly resetsAt?: Date;
}

export interface RateLimitView {
  readonly status: string;
  readonly windows: readonly RateLimitWindow[];
  readonly usingOverage: boolean;
  /** 로그·화면 한 줄. 창을 하나도 모르면 `null`(할 말이 없으면 안 한다). */
  readonly line: string | null;
  /** 같은 값 반복을 접기 위한 서명 — 사용률은 5%p 버킷으로 접는다. */
  readonly signature: string;
}

export const parseRateLimit = (raw: unknown): RateLimitView => {
  const info = (raw ?? {}) as Record<string, unknown>;
  const status = typeof info.status === "string" ? info.status : "unknown";
  const usingOverage = info.isUsingOverage === true;

  const windows: RateLimitWindow[] = [];
  const uw = info.unifiedWindows;
  if (uw !== null && typeof uw === "object") {
    for (const [name, v] of Object.entries(uw as Record<string, unknown>)) {
      const w = (v ?? {}) as Record<string, unknown>;
      const util = typeof w.utilization === "number" ? w.utilization : undefined;
      const resets = toDate(w.resetsAt);
      windows.push({
        name,
        ...(util !== undefined ? { utilization: util } : {}),
        ...(resets !== undefined ? { resetsAt: resets } : {}),
      });
    }
  }
  // 폴백 — `unifiedWindows` 가 없으면 최상위 선언을 쓴다(타입이 약속하는 모양).
  if (windows.length === 0) {
    const util = typeof info.utilization === "number" ? info.utilization : undefined;
    const resets = toDate(info.resetsAt);
    const name = typeof info.rateLimitType === "string" ? info.rateLimitType : "window";
    if (util !== undefined || resets !== undefined) {
      windows.push({
        name,
        ...(util !== undefined ? { utilization: util } : {}),
        ...(resets !== undefined ? { resetsAt: resets } : {}),
      });
    }
  }

  const parts = windows
    .filter((w) => w.utilization !== undefined || w.resetsAt !== undefined)
    .map((w) => {
      // ★사용률이 없으면 자리를 비워 두지 않는다 — 「five_hour  (리셋 …)」처럼 두 칸이
      //  벌어지면 «값이 있는데 안 보이는» 것처럼 읽힌다. 없으면 없는 대로 붙인다.
      const u = w.utilization === undefined ? "" : ` ${(w.utilization * 100).toFixed(0)}%`;
      const r = w.resetsAt === undefined ? "" : ` (리셋 ${hhmm(w.resetsAt)})`;
      return `${w.name}${u}${r}`;
    });

  const line =
    parts.length === 0
      ? null
      : `한도: ${parts.join(" · ")}${status !== "allowed" ? ` — ${status}` : ""}${usingOverage ? " · 초과분 사용중" : ""}`;

  const sig = [
    status,
    usingOverage ? "ov" : "",
    ...windows.map(
      (w) => `${w.name}:${w.utilization === undefined ? "?" : Math.floor(w.utilization * 20) * 5}`,
    ),
  ].join("|");

  return { status, windows, usingOverage, line, signature: sig };
};
