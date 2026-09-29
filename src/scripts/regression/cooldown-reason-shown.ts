/**
 * 회귀: **쉬는 이유를 화면이 안다 — 인증 거부를 «사용량 한도» 로 보여주지 않는다** (2026-09-29).
 *
 * 사고(지인 설치본): 모든 턴이 `401 OAuth access token is invalid` 였는데 화면은 «사용량 한도 — 12시간 뒤 해제 ·
 *  그때까지 이 모델은 건너뜁니다 · 잠시 후 다시 시도해 주세요» 였다. 셋 다 틀렸다 — 인증은 기다려도 안 풀리고,
 *  모델이 하나라 건너뛰지도 않았다(마지막 수단으로 다시 시도). 원인: `turn_error` 가 해제 시각만 싣고 사유를 안
 *  실어, 프런트가 무조건 한도 문구를 썼다. 텔레그램 통지는 이미 구분하고 있었다.
 * 가짜 어댑터로 `runRegionA` 를 실제로 태워 발행된 `turn_error` 를 받는다(모델 호출 0).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "cooldown-reason-shown",
  guards: "인증 거부(401)를 화면이 «사용량 한도 — 12시간 뒤 · 건너뜁니다 · 잠시 후 다시» 로 보여주던 것",
  run: async (): Promise<Assertion[]> => {
    const { __setAdapterForTest, runRegionA } = await import("../../core/llm-runtime/index.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const { initStore } = await import("../../store/sessions.js");
    const { deleteCooldown } = await import("../../store/cooldowns.js");
    initStore();
    const out: Assertion[] = [];
    const TK = `regr:cooldown-reason:${Date.now()}`;
    const seen: Array<{ cooldownReason?: string; cooldownUntilTs?: number }> = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload: { threadKey?: string } }) => {
      if (e.type === "llm.turn_error" && e.payload.threadKey === TK) seen.push(e.payload as never);
    });
    let throwWith = "";
    const restore = __setAdapterForTest(async () => {
      throw new Error(throwWith);
    });
    const turn = async (msg: string) => {
      throwWith = msg;
      try {
        await runRegionA({ text: "probe", threadKey: TK, channel: "cli" as never }, { specs: [{ adapter: "claude", model: "regr", provider: "anthropic" }] });
      } catch {
        /* 실패가 목적이다 */
      }
      return seen.at(-1);
    };
    try {
      deleteCooldown("anthropic");
      const auth = await turn("claude-agent-sdk error: Failed to authenticate. API Error: 401 OAuth access token is invalid.");
      const limit = await turn("You've hit your limit · resets 2:20am (Asia/Seoul)");
      const other = await turn("socket hang up");
      // 한도·인증이 섞인 문자열은 등록이 «한도» 로 본다(`!isRateLimited && isAuthRejected`) — 사유도 같아야 한다.
      const mixed = await turn("API Error: 401 rate_limit_error — too many requests");
      out.push(
        assert(
          "★인증 거부는 사유 auth · 한도는 limit · 쉬는 중 다른 오류면 사유를 싣지 않는다(모르는 것을 한도라 하지 않는다)",
          auth?.cooldownReason === "auth" && typeof auth.cooldownUntilTs === "number" &&
            limit?.cooldownReason === "limit" && typeof limit.cooldownUntilTs === "number" &&
            other?.cooldownReason === undefined && typeof other?.cooldownUntilTs === "number" && mixed?.cooldownReason === "limit",
          { auth: auth?.cooldownReason, limit: limit?.cooldownReason, other: other?.cooldownReason ?? "(없음)", mixed: mixed?.cooldownReason, n: seen.length },
        ),
      );
    } finally {
      restore();
      unsub();
      deleteCooldown("anthropic");
    }

    // 화면 — 사유별로 다른 문구, 인증 거부에는 «잠시 후 다시» 를 안 붙인다.
    const ui = await sourceHas("../../../packages/dashboard/js/sse.js", [
      /const authRejected = p\.cooldownReason === "auth";/,
      /: authRejected \? "" : i18n\("sys\.fallback\.exhausted"\);/,
      /until = authRejected\s*\?\s*i18n\("sys\.cooldown\.auth"\)\s*:\s*p\.cooldownReason === "limit"\s*\?\s*i18n\("sys\.cooldown\.note", \{ when, dur \}\)\s*:\s*i18n\("sys\.cooldown\.paused", \{ when, dur \}\);/,
    ]);
    const cats = await Promise.all(
      ["ko", "en"].map(async (l) => JSON.parse(await readFile(new URL(`../../../locales/${l}.json`, import.meta.url), "utf8")) as Record<string, string>),
    );
    const distinct = cats.every((c) => new Set([c["sys.cooldown.auth"], c["sys.cooldown.note"], c["sys.cooldown.paused"]]).size === 3 && c["sys.cooldown.auth"] !== undefined);
    // 모델이 하나면 마지막 수단으로 다시 시도한다 — 한도 문구가 «건너뜁니다» 를 약속하면 거짓이다.
    const noSkipPromise = !/건너뜁/.test(cats[0]!["sys.cooldown.note"] ?? "") && !/skipped/.test(cats[1]!["sys.cooldown.note"] ?? "");
    out.push(
      assert(
        "★화면은 사유별로 다른 문구(인증·한도·모름)를 쓰고, 인증 거부에 «잠시 후 다시» 를, 한도에 «건너뜁니다» 를 붙이지 않는다",
        ui.ok && distinct && noSkipPromise,
        { ui: ui.ok ? "O" : ui.missing, distinct, noSkipPromise },
      ),
    );
    return out;
  },
};
