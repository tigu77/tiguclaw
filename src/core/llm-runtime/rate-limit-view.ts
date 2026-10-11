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
 *  ★(2026-10-10 정정) 지금은 SDK 도 `unifiedWindows` 사용률을 준다 — 9-23~10-02 돌쇠 로그에 «five_hour 24% · seven_day 93%» 가
 *   남아 있다. 그래서 아래 `noteTurnRateLimit` 이 그 값을 토큰 자신의 한도로 기억해 한도 화면에 쓴다. 아래 두 줄은 그 이전의 기록이다.
 *  즉 **우리 경로에서는 «몇 % 썼나» 를 알 수 없다.** 아는 것은 «어느 창이 걸려 있나 ·
 *  언제 리셋되나 · allowed / allowed_warning / rejected» 셋이다.
 *  ★그래도 값이 있다: `allowed_warning` 은 **거절 전에** 오는 신호다. 종전엔 부딪힌 뒤
 *   쿨다운으로만 알았다. 사용률은 SDK 가 주기 시작하면 이 코드가 **그대로** 받는다
 *   (그래서 `unifiedWindows` 갈래를 남겨둔다 — 지우면 올라갈 때 다시 짜야 한다).
 *
 * ★모르면 «모른다» 고 말한다 — 값이 없는 창은 아예 안 적는다(빈 자리가 «모름» 이라는 뜻이
 *  되게 둔다). 숫자를 지어내면 그 숫자로 판단하게 된다.
 */
import { createHash } from "node:crypto";

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
  /**
   * **거절됐으면 언제 풀리나**(epoch ms) — `status === "rejected"` 일 때만. 최상위 `resetsAt`(걸린 창)이 정본이고, 없으면 창들 중 가장 늦은
   * 리셋(가장 보수적). 쿨다운이 문구 대신 이 값을 쓴다(`rate-limit.ts` `withRateLimitUntil`).
   */
  readonly rejectedUntilMs?: number;
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

  // ★«거절이지만 초과분으로 진행 중» 은 막힌 게 아니다 — 요청은 정상으로 통과한다(번들 CLI 의 `isUsingOverage` 판정과 같다).
  //  그걸 거절로 기억하면 그 턴의 무관한 실패가 주간 리셋까지 쉬게 됐다(적대 검토 F3).
  const overageOk = usingOverage || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
  // 풀리는 시각은 걸린 창(rateLimitType)의 것 — 없으면 최상위, 그것도 없으면 가장 늦은 창(보수).
  const typed = typeof info.rateLimitType === "string" ? windows.find((w) => w.name === info.rateLimitType)?.resetsAt?.getTime() : undefined;
  const rejectedUntilMs =
    status !== "rejected" || overageOk
      ? undefined
      : (toDate(info.resetsAt)?.getTime() ??
        typed ??
        windows.reduce<number | undefined>((m, w) => (w.resetsAt === undefined ? m : Math.max(m ?? 0, w.resetsAt.getTime())), undefined));
  return { status, windows, usingOverage, line, signature: sig, ...(rejectedUntilMs !== undefined ? { rejectedUntilMs } : {}) };
};


/**
 * **턴에서 받은 마지막 사용률** — 인증된 토큰 **자신의 계정** 값이다 (2026-10-10 정태님: «셋업토큰 정보로 한도정보를 가져올 수 없나?»).
 * ★한도 화면은 이 기계의 Claude Code CLI 에 `/usage` 를 물어 왔는데, CLI 는 **자기 로그인 계정**을 말한다 — 토큰과 다른 계정이면
 *  남의 숫자다. SDK 의 `rate_limit_event` 는 턴마다 그 토큰으로 받은 사용률을 준다(2026-09 이후 실측 — 9월 초엔 없었다). 사용률이
 *  하나라도 있을 때만 기억한다(«모름» 을 0 으로 덮지 않는다). 메모리에만 둔다 — 재시작 뒤엔 다음 턴이 다시 채운다.
 */
let lastTurnUsage: { readonly token: string; readonly windows: ReadonlyMap<string, { readonly w: RateLimitWindow; readonly at: number }> } | undefined;
/** 지금 쓰는 토큰의 표지(해시 앞부분) — 토큰을 바꾸면 옛 계정의 사용률을 «최신» 으로 보이지 않게(적대 검토 F5). 값 자체는 안 둔다. */
const tokenKey = (): string =>
  createHash("sha256").update(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "").digest("hex").slice(0, 12);
export const noteTurnRateLimit = (view: RateLimitView, at: number = Date.now()): void => {
  const fresh = view.windows.filter((w) => w.utilization !== undefined);
  if (fresh.length === 0) return;
  const token = tokenKey();
  // ★일부 창만 담긴 이벤트가 앞 창들을 지우지 않게 이름별로 합친다(적대 검토 F9 — 각 창은 선택 항목이다). 토큰이 바뀌었으면 새로 시작.
  //  ★측정 시각은 **창마다** 둔다 — 하나만 두면 합친 옛 창도 «방금 잰 값» 이 됐다(릴리스 검토 F1).
  const merged = new Map(lastTurnUsage !== undefined && lastTurnUsage.token === token ? lastTurnUsage.windows : []);
  for (const w of fresh) merged.set(w.name, { w, at });
  lastTurnUsage = { token, windows: merged };
};
/**
 * 지금 토큰의 창들 — 리셋 시각이 지난 창은 뺀다(그 값은 이미 아니다). 측정 시각은 남은 창 중 **가장 오래된** 것(보수).
 * ★`only` 는 **받는 쪽이 보여 줄 창** — 측정 시각은 그 창들로만 잰다 (2026-10-11 수정분 재검토 F1). 종전엔 화면에 안 나오는
 *  창(sonnet·opus·overage)까지 넣어, 방금 잰 5시간·주간 값이 두 시간 전 sonnet 창 때문에 «낡음» 으로 판정돼 다른 계정 CLI 값으로 갔다.
 */
export const turnRateLimitSnapshot = (
  now: number = Date.now(),
  only?: readonly string[],
): { readonly at: number; readonly windows: readonly RateLimitWindow[] } | undefined => {
  if (lastTurnUsage === undefined || lastTurnUsage.token !== tokenKey()) return undefined;
  const kept = [...lastTurnUsage.windows.values()].filter(
    (x) => (only === undefined || only.includes(x.w.name)) && (x.w.resetsAt === undefined || x.w.resetsAt.getTime() > now),
  );
  if (kept.length === 0) return undefined;
  return { at: Math.min(...kept.map((x) => x.at)), windows: kept.map((x) => x.w) };
};
