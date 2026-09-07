/**
 * codex 구독 한도 — **얼마나 남았나** (2026-09-07).
 *
 * ★provider 지식이 provider 플러그인에 사는 자리다. 코어는 «남은 양» 이라는 표현만 알고,
 *  «어떻게 알아내나» 는 여기 있다. claude 쪽은 완전히 다른 방식(턴마다 오는 SDK 이벤트)이라
 *  같은 코드로 못 묶는다 — 묶으려 하면 둘 다 이상해진다.
 *
 * ★**전용 엔드포인트가 있다**(OpenClaw 참조본에서 찾음, 2026-09-07 실호출로 확인):
 *    GET https://chatgpt.com/backend-api/wham/usage
 *  우리가 이미 가진 access token + `ChatGPT-Account-Id`(JWT 클레임) 로 그대로 된다.
 *  실측 응답: `primary_window {used_percent 44, limit_window_seconds 18000, reset_at}` ·
 *            `secondary_window {used_percent 81, limit_window_seconds 604800, reset_at}`
 *
 * ★**비공식 경로다.** codex 어댑터 자체와 같은 성격이고, 상용 배포에는 못 싣는다
 *  (비즈니스 문서: *"팔면 약관 위반"*). 개인·자가호스팅 전용이다.
 * ★그래서 **실패가 조용해야 한다** — 언제든 막힐 수 있고, 그때는 «모름» 이지 에러가 아니다.
 *  던지지 않고 `undefined` 를 돌려준다.
 *
 * ★**배경 폴링을 안 한다** (2026-09-07 정태님). 타이머로 주기 조회하면 사용자가 안 볼 때도
 *  외부를 때리고, 그건 비공식 경로에 대고 하기엔 나쁜 습관이다. 대신 **구독 플러그인 상세를
 *  열 때** 한 번 가져온다 — 그 화면이 이 숫자를 보는 유일한 자리다.
 * ★캐시 **5분** — 그리고 이 캐시의 일은 «할당량 아끼기» 가 **아니다**. 화면 한 번 여는
 *  동안의 중복 호출(재렌더·연속 새로고침)을 접는 것뿐이다. 그러니 짧을수록 좋다
 *  (2026-09-07 정태님): 사용자가 그 뒤 다시 열었으면 그건 **새로 알고 싶다는 뜻**이다.
 *  ★길게 잡으면 «지금 얼마나 남았지» 에 옛 숫자로 답하게 되고, 그게 이 기능의 존재 이유를
 *   깎는다. 이 레포는 그 부류(낡은 값을 최신인 척 보여주는 것)로 여러 번 데였다.
 */
import type { ProviderUsage, UsageWindow } from "../../src/core/plugins/provider-usage.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** 5분 — 화면 한 번 여는 동안의 중복 호출을 접는다(2026-09-07 정태님). */
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

let cached: { at: number; value: ProviderUsage | undefined } | undefined;

/**
 * ★**왜 비었는지는 로그에만 남는다** (2026-09-07). 실패가 조용한 것과 **아무 흔적도 없는 것**은
 *  다르다 — 화면엔 «모름» 이 맞지만, 로그까지 0줄이면 «이 제공자가 원래 안 주는 것» 인지
 *  «지금 막힌 것» 인지 구분할 수가 없다. 로그가 1차 진단면인 설치본(원격 불가)에서는 그게
 *  곧 못 잡는다는 뜻이다.
 * ★반복은 세고 안 반복한다(같은 이유가 매번 찍히면 배경소음이 되고 진짜 신호가 묻힌다).
 */
let logSink: ((m: string) => void) | undefined;
let lastReason = "";
let sameCount = 0;
export const setUsageLogSink = (fn: (m: string) => void): void => {
  logSink = fn;
};
const note = (reason: string): void => {
  if (reason === lastReason) {
    sameCount += 1;
    return;
  }
  const tail = sameCount > 0 ? ` (직전 «${lastReason}» ${sameCount + 1}회)` : "";
  lastReason = reason;
  sameCount = 0;
  logSink?.(`[usage] codex: ${reason}${tail}`);
};

/** JWT 클레임에서 account id — 어댑터의 `extractAccountId` 와 같은 자리를 본다. */
const accountIdOf = (token: string): string | undefined => {
  try {
    const part = token.split(".")[1];
    if (part === undefined) return undefined;
    const claim = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as Record<string, unknown>;
    const auth = claim["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
};

/** 저쪽은 «쓴 %» 로 준다 — 우리 표현은 «남은 %» 다(사용자가 묻는 것이 그것이다). */
const toWindow = (w: unknown): UsageWindow | undefined => {
  if (w === null || typeof w !== "object") return undefined;
  const o = w as Record<string, unknown>;
  const used = typeof o.used_percent === "number" ? o.used_percent : undefined;
  const secs = typeof o.limit_window_seconds === "number" ? o.limit_window_seconds : undefined;
  const resetAt = typeof o.reset_at === "number" ? o.reset_at * 1000 : undefined;
  if (used === undefined && secs === undefined && resetAt === undefined) return undefined;
  return {
    ...(secs !== undefined ? { windowSeconds: secs } : {}),
    ...(used !== undefined ? { remainingPercent: Math.max(0, Math.min(100, 100 - used)) } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
};

export const fetchCodexUsage = async (
  getAccessToken: () => Promise<string>,
): Promise<ProviderUsage | undefined> => {
  const now = Date.now();
  if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;
  let value: ProviderUsage | undefined;
  // 못 쟀을 때도 «언제 다시 잰다» 는 말해준다 — 빈 자리는 «원래 안 준다» 로 읽힌다.
  const pending: ProviderUsage = { windows: [], measuredAt: now, retryAt: now + CACHE_MS };
  try {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const acc = accountIdOf(token);
    if (acc !== undefined) headers["ChatGPT-Account-Id"] = acc;
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as Record<string, unknown>;
      // ★창은 **`rate_limit` 안**에 있다 — 최상위가 아니다(2026-09-07 실측으로 잡음).
      //  최상위 키는 `user_id·account_id·email·plan_type·rate_limit·model_usage…` 다.
      //  첫 판이 최상위에서 찾아 **HTTP 200 인데 결과가 undefined** 였다. 내 첫 프로브가
      //  `j.rate_limit ?? j` 로 찍어서 그 껍데기를 못 보고 넘어간 것이다 —
      //  «떠본 것과 코드가 보는 것이 같은 자리여야 한다».
      const rl = (j.rate_limit ?? {}) as Record<string, unknown>;
      const windows = [toWindow(rl.primary_window), toWindow(rl.secondary_window)].filter(
        (w): w is UsageWindow => w !== undefined,
      );
      if (windows.length > 0) {
        value = {
          ...(typeof rl.limit_reached === "boolean" ? { limitReached: rl.limit_reached } : {}),
          windows,
          measuredAt: now,
        };
        note(
          `창 ${windows.length}개 — ` +
            windows
              .map((w) => `${w.windowSeconds ?? "?"}초:${Math.round(w.remainingPercent ?? -1)}%남음`)
              .join(" "),
        );
      } else {
        note(`200 인데 창이 0개 — 응답 모양이 바뀌었나(최상위 키: ${Object.keys(j).join(",")})`);
      }
    } else {
      note(`HTTP ${res.status} — 사용량 «모름» 으로 답한다`);
    }
  } catch (e) {
    value = undefined; // 조용히 «모름» — 비공식 경로는 언제든 막힌다.
    const err = e as { name?: string; message?: string };
    note(`조회 실패 — ${err?.name ?? "Error"}: ${String(err?.message ?? e).slice(0, 120)}`);
  }
  cached = { at: now, value };
  return value ?? pending;
};
