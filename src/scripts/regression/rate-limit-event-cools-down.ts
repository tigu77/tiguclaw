/**
 * 회귀: **한도 쿨다운은 SDK 의 구조화된 한도 신호를 먼저 쓴다 — 문구 판독은 보조** (2026-10-10 정태님: «메시지로 인식하는 거였어? 다른 좋은 방법은?»).
 *
 * 사고: 쿨다운은 오류 문구(«hit your … limit · resets 3pm»)를 정규식으로 읽어 걸었다. v0.68 의 정규식은 «hit your **weekly** limit»
 *  을 못 읽어 주간 한도 동안 쿨다운 없이 매 턴 claude 를 다시 두드렸다(«다른 모델로 이어서 시도합니다» 반복). claude SDK 는 턴 중에
 *  `rate_limit_event`(status·resetsAt epoch)를 주는데 그건 로그에만 찍고 있었다.
 *
 * 지키는 것(실제 `runClaude` 에 가짜 SDK 스트림 → 실제 `registerCooldownIfRateLimited`):
 *  ① `rejected` 이벤트 뒤 실패 → 오류 **문구가 한도처럼 안 생겨도** 그 이벤트의 resetsAt 까지 쿨다운
 *  ② 이벤트가 없으면 종전처럼 문구로(보조) — «weekly limit · resets …» 를 한도로 읽는다
 *  ③ `allowed`·`allowed_warning` 이벤트는 쿨다운 근거가 아니다(경고는 막힌 게 아니다)
 *
 * 등급: **동작**. 모델 호출 0.
 */
import { runClaude, withFakeClaudeQuery } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";
import { clearCooldowns, parseModelSpec, registerCooldownIfRateLimited } from "../../core/llm-runtime/index.js";
import { assert, assertIsolated, within, type Assertion, type RegressionCheck } from "./_framework.js";

type Frame = Record<string, unknown>;

/** 한도 이벤트를 하나 주고 에러 result 로 끝나는 가짜 SDK. */
const failingWith = (status: string | null, resetsAt: number, resultText: string, extra: Record<string, unknown> = {}, subtype = "success") =>
  ((args: { prompt: unknown }) => {
    const prompt = args.prompt as AsyncIterable<unknown> | string;
    return (async function* (): AsyncGenerator<Frame> {
      if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sess-rl", model: "claude-fake" };
      if (status !== null) {
        yield { type: "rate_limit_event", rate_limit_info: { status, rateLimitType: "seven_day", resetsAt: Math.floor(resetsAt / 1000), ...extra } };
      }
      yield subtype === "success"
        ? { type: "result", subtype: "success", is_error: true, result: resultText, session_id: "sess-rl" }
        : { type: "result", subtype, is_error: true, errors: [resultText], session_id: "sess-rl" };
    })();
  }) as never;

export const check: RegressionCheck = {
  name: "rate-limit-event-cools-down",
  guards: "한도 쿨다운이 오류 문구 판독에만 기대 «hit your weekly limit» 같은 새 문구를 놓치면 매 턴 같은 한도를 다시 두드리던 것 — SDK 의 구조화 신호를 안 쓰고 있었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    const spec = parseModelSpec("codex:gpt-6-sol"); // 판정은 spec 과 무관 — 파싱되는 아무 spec(claude-tool-hang-surfaces 와 같다)
    const run = async (status: string | null, resetsAt: number, text: string, extra: Record<string, unknown> = {}, subtype = "success"): Promise<{ err: unknown; remain: number; reason?: string }> => {
      clearCooldowns();
      let err: unknown;
      const r = await within(
        10_000,
        "가짜 SDK 한도",
        withFakeClaudeQuery(failingWith(status, resetsAt, text, extra, subtype), () => runClaude({ text: "x", threadKey: `regr:rl:${Math.random()}`, channel: "cli" } as never)).then(
          () => undefined,
          (e: unknown) => {
            err = e;
          },
        ),
      );
      if ("timedOut" in r) err = new Error(r.timedOut);
      // 등록이 정한 해제 시각을 직접 본다 — 조회 함수는 긴 쿨다운을 2시간마다 한 번 «탐침» 으로 통과시켜 첫 조회가 0 이다.
      const reg = spec !== null && err !== undefined ? registerCooldownIfRateLimited(spec, err) : null;
      return { err, remain: reg === null ? 0 : reg.untilTs - Date.now(), ...(reg !== null ? { reason: reg.reason } : {}) };
    };
    out.push(assert("픽스처: spec 이 파싱된다(아니면 등록이 건너뛰어져 아래가 공짜 빨강/초록)", spec !== null, String(spec?.model)));
    try {
      const in3h = Date.now() + 3 * 3_600_000;
      // ① 문구는 한도처럼 안 생겼다(업스트림이 문장을 바꾼 경우) — 신호만으로 걸려야 한다
      const a = await run("rejected", in3h, "API Error: something new happened");
      out.push(
        assert(
          "★① SDK 가 «거절» 신호를 주면 문구가 낯설어도 그 해제 시각(3시간 뒤)까지 쿨다운",
          a.err !== undefined && a.remain > 2.9 * 3_600_000 && a.remain <= 3 * 3_600_000,
          { 남은분: Math.round(a.remain / 60_000), 오류: String(a.err).slice(0, 80) },
        ),
      );
      // ② 신호가 없으면 종전처럼 문구로
      const b = await run(null, 0, "You've hit your weekly limit · resets 3pm (Asia/Seoul)");
      out.push(assert("② 신호가 없으면 문구 판독(보조)으로 한도를 잡는다 — «weekly limit · resets»", b.remain > 0, { 남은분: Math.round(b.remain / 60_000) }));
      // ④ 턴에서 받은 사용률이 «토큰 자신의 한도» 로 플러그인에 닿는다 — 어댑터가 기억하고 호스트가 창 길이·남은 비율로 바꾼다(2026-10-10)
      {
        const { createPluginHost } = await import("../../core/plugins/host.js");
        const okQuery = ((args: { prompt: unknown }) => {
          const prompt = args.prompt as AsyncIterable<unknown> | string;
          return (async function* (): AsyncGenerator<Frame> {
            if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
            yield { type: "system", subtype: "init", session_id: "sess-u", model: "claude-fake" };
            yield {
              type: "rate_limit_event",
              rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: Math.floor(in3h / 1000) }, seven_day: { utilization: 0.6 } } },
            };
            yield { type: "result", subtype: "success", is_error: false, result: "끝", session_id: "sess-u" };
          })();
        }) as never;
        await within(10_000, "가짜 SDK 사용률", withFakeClaudeQuery(okQuery, () => runClaude({ text: "x", threadKey: `regr:rl-u:${Math.random()}`, channel: "cli" } as never)).catch(() => undefined));
        const host = createPluginHost("regr-usage", { auth: ["claude-subscription"] } as never);
        const u = host.claudeUsageFromTurns();
        const noAuth = createPluginHost("regr-usage-no", {} as never).claudeUsageFromTurns();
        out.push(
          assert(
            "★④ 턴의 사용률이 플러그인에 «5시간 75% · 7일 40% 남음» 으로 닿는다(구독 인증을 선언한 플러그인만)",
            u?.windows.length === 2 && u.windows[0]?.windowSeconds === 18_000 && u.windows[0]?.remainingPercent === 75 && u.windows[1]?.remainingPercent === 40 && noAuth === undefined,
            { 창: u?.windows, 미선언: noAuth },
          ),
        );
      }
      // ⑤ 적대 검토 반영 — 초과분으로 진행 중인 거절은 막힌 게 아니다(F3) · 401 은 인증이다 · 실패 결과(subtype) 경로도 신호를 싣는다 ·
      //  사용자 문구·매니저 통지(문자열만 받는다)도 같은 판정을 한다(F4)
      const over = await run("rejected", in3h, "API Error: 529 overloaded", { isUsingOverage: true, overageStatus: "allowed" });
      out.push(assert("★⑤ «거절 + 초과분 사용 중» 은 한도가 아니다 — 무관한 실패(529)에 쿨다운 없음", over.remain === 0, { 남은분: Math.round(over.remain / 60_000) }));
      const auth = await run("rejected", in3h, "Failed to authenticate. API Error: 401 OAuth token has expired");
      out.push(assert("⑤ 401 은 남아 있던 거절 신호보다 먼저 «인증» 이다(재로그인 안내가 맞다)", auth.reason === "auth", { 사유: auth.reason }));
      const sub = await run("rejected", in3h, "API Error: something new", {}, "error_during_execution");
      out.push(assert("⑤ 실패 결과(error_* subtype) 경로도 신호를 싣는다", sub.remain > 2.9 * 3_600_000, { 남은분: Math.round(sub.remain / 60_000) }));
      {
        const { isRateLimited, parseCooldownMs } = await import("../../core/llm-runtime/rate-limit.js");
        const msg = a.err instanceof Error ? a.err.message : String(a.err);
        const ms = parseCooldownMs(msg) ?? 0;
        out.push(
          assert(
            "★⑤ 문자열만 받는 소비처(사용자 답·매니저 통지)도 신호를 «한도 · 그 시각» 으로 읽는다",
            isRateLimited(msg) && ms > 2.9 * 3_600_000 && ms <= 3 * 3_600_000,
            { 문장: msg.slice(-90), 분: Math.round(ms / 60_000) },
          ),
        );
      }
      // ⑥ 턴 사용률 — 일부 창만 담긴 이벤트는 앞 창을 지우지 않고(F9), 토큰을 바꾸면 옛 계정 값을 안 보인다(F5)
      {
        const v = await import("../../core/llm-runtime/rate-limit-view.js");
        const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        try {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = "regr-token-a";
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } } }));
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { seven_day_overage_included: { utilization: 0.5 } } }));
          const merged = (v.turnRateLimitSnapshot()?.windows ?? []).map((w) => w.name).sort().join(",");
          process.env.CLAUDE_CODE_OAUTH_TOKEN = "regr-token-b";
          const afterSwap = v.turnRateLimitSnapshot();
          // 토큰을 바꾼 뒤 첫 이벤트는 옛 계정 창과 섞이지 않는다(릴리스 검토 G1)
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.7 } } }));
          const bOnly = (v.turnRateLimitSnapshot()?.windows ?? []).map((w) => w.name).join(",");
          // 창마다 측정 시각 — 리셋이 지난 옛 창은 빠지고, 스냅샷 시각은 남은 창 중 가장 오래된 것(릴리스 검토 F1)
          process.env.CLAUDE_CODE_OAUTH_TOKEN = "regr-token-c";
          const T = Date.now();
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: Math.floor((T - 5 * 3_600_000) / 1000) } } }), T - 6 * 3_600_000);
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3 } } }), T - 2 * 3_600_000);
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { seven_day_opus: { utilization: 0.1 } } }), T);
          const snapC = v.turnRateLimitSnapshot(T);
          const cNames = (snapC?.windows ?? []).map((w) => w.name).sort().join(",");
          // 측정 시각은 받는 쪽이 보여 줄 창으로만 — 두 시간 전에만 온 sonnet 창이 방금 잰 5시간·주간 값을 «낡음» 으로 만들지 않는다(수정분 재검토 F1)
          process.env.CLAUDE_CODE_OAUTH_TOKEN = "regr-token-d";
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.5 }, seven_day_sonnet: { utilization: 0.2 } } }), T - 2 * 3_600_000);
          v.noteTurnRateLimit(v.parseRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.45 }, seven_day: { utilization: 0.52 } } }), T);
          // 실제 소비처(host)로 잰다 — host 가 보여 줄 창을 넘기지 않으면(게으른 편집) 여기서 빨개진다.
          const { createPluginHost } = await import("../../core/plugins/host.js");
          const usageD = createPluginHost("regr-usage-d", { auth: ["claude-subscription"] } as never).claudeUsageFromTurns();
          out.push(
            assert(
              "★⑥ 토큰을 바꾼 뒤 첫 이벤트는 옛 계정 창과 안 섞이고 · 리셋이 지난 창은 빠지며 · 측정 시각은 남은 창 중 가장 오래된 것",
              bOnly === "seven_day" && cNames === "seven_day,seven_day_opus" && snapC?.at === T - 2 * 3_600_000,
              { 바꾼뒤첫: bOnly, 남은창: cNames, 측정: snapC === undefined ? null : Math.round((T - snapC.at) / 60_000) + "분 전" },
            ),
          );
          out.push(
            assert(
              "★⑥ 측정 시각은 보여 줄 창으로만 잰다 — 다시 잰 창은 새 시각, 안 보이는 옛 창이 «낡음» 을 정하지 않는다",
              usageD?.measuredAt === T && usageD.windows.length === 2 && usageD.windows[0]?.remainingPercent === 55,
              { 측정: usageD === undefined ? null : Math.round((T - usageD.measuredAt) / 60_000) + "분 전", 창: usageD?.windows },
            ),
          );
          out.push(
            assert(
              "★⑥ 일부 창만 담긴 이벤트가 앞 창을 지우지 않고, 토큰을 바꾸면 옛 계정의 사용률을 안 보인다",
              merged === "five_hour,seven_day,seven_day_overage_included" && afterSwap === undefined,
              { 합친창: merged, 바꾼뒤: afterSwap },
            ),
          );
        } finally {
          if (savedTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
          else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTok;
        }
      }
      // ③ 경고는 막힌 게 아니다 — 낯선 문구 + allowed_warning 이면 쿨다운 없음
      const c = await run("allowed_warning", in3h, "API Error: something new happened");
      out.push(assert("③ «allowed_warning» 은 쿨다운 근거가 아니다(경고는 거절이 아니다)", c.remain === 0, { 남은분: Math.round(c.remain / 60_000) }));
    } finally {
      clearCooldowns();
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    return out;
  },
};

export default check;
