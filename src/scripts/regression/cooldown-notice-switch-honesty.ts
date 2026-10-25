/**
 * 회귀: **쿨다운 통지의 «다른 모델로 자동 전환합니다» 는 전환할 후보가 있을 때만** (2026-10-23).
 *
 * 사고: 후보가 하나뿐인 풀(`frontier-claude`·`frontier-gpt` 같은 단일 모델 프로파일)이 한도에 걸려도 통지가
 *  «그때까지 다른 모델로 자동 전환합니다(대화는 그대로 이어집니다)» 라고 말했다 — 전환할 모델이 없으니 거짓이다.
 * 판정은 재개 시각 판정(`poolReadyAt`)을 그대로 쓴다 — 용량·쿨다운·이번 실행의 구조적 실패를 이미 거른다.
 * 가짜 어댑터로 `runRegionA` 를 실제로 태워 **배달된 통지 본문**을 받는다(모델 호출 0).
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "cooldown-notice-switch-honesty",
  guards:
    "후보가 하나뿐인 풀(단일 모델 프로파일)이 한도·인증 거부로 쉬게 될 때 통지가 «그때까지 다른 모델로 자동 전환합니다» 라고 " +
    "거짓말하던 것 · 같은 provider 의 다른 모델·이미 쉬는 후보·이번 턴에 구조적으로 실패한 후보를 «전환할 곳» 으로 세는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { __setAdapterForTest, runRegionA, clearCooldownKeys } = await import("../../core/llm-runtime/index.js");
    const { registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
    const { translate } = await import("../../core/i18n.js");
    const { initStore, getDb } = await import("../../store/sessions.js");
    const { saveCooldown } = await import("../../store/cooldowns.js");
    initStore();

    const rnd = Math.random().toString(36).slice(2, 8);
    const CH = `regr-cooldown-${rnd}`;
    const P = { a: `regr-cd-a-${rnd}`, b: `regr-cd-b-${rnd}`, c: `regr-cd-c-${rnd}` };
    const got: string[] = [];
    registerChannelOutbound(CH, { deliver: async (_t: string | null, text: string) => { got.push(text); } } as never);

    const LIMIT = "You've hit your limit · resets 2:20am (Asia/Seoul)";
    const AUTH = "claude-agent-sdk error: Failed to authenticate. API Error: 401 OAuth access token is invalid.";
    /** 모델 이름 → 그 후보가 던질 오류(없으면 성공). */
    let plan: Record<string, string | undefined> = {};
    /** 이 턴에 실제로 불린 모델(순서대로) · 던지기 전 지연(ms). */
    let called: string[] = [];
    let delayMs = 0;
    const restore = __setAdapterForTest(async (_adapter, input) => {
      called.push(String(input.model));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const err = plan[String(input.model)];
      if (err !== undefined) throw new Error(err);
      return { text: "ok" } as never;
    });
    const spec = (model: string, provider: string) => ({ adapter: "claude" as const, model, provider });
    /** 한 턴을 돌리고 그 턴에 배달된 쿨다운 통지(없으면 undefined)를 돌려준다. */
    const turn = async (
      specs: ReturnType<typeof spec>[],
      p: Record<string, string | undefined>,
    ): Promise<string | undefined> => {
      plan = p;
      called = [];
      const before = got.length;
      try {
        await runRegionA(
          { text: "probe", threadKey: `regr:cd-switch:${rnd}`, channel: "cli" as never, notifyDest: { channel: CH, target: "t" } as never },
          { specs },
        );
      } catch {
        /* 실패가 목적인 경우가 있다 */
      }
      await new Promise((r) => setTimeout(r, 20)); // 통지는 void 발송이다
      return got.slice(before).join("\n---\n") || undefined;
    };
    const SWITCH = [translate("srv.limit.switchUntil"), translate("srv.limit.switchMeanwhile")];
    const says = (t: string | undefined): boolean => t !== undefined && SWITCH.some((s) => t.includes(s));
    const reset = (): void => { clearCooldownKeys(Object.values(P)); };

    const out: Assertion[] = [];
    try {
      reset();
      const single = await turn([spec("m-a", P.a)], { "m-a": LIMIT });
      reset();
      const singleAuth = await turn([spec("m-a", P.a)], { "m-a": AUTH });
      reset();
      const two = await turn([spec("m-a", P.a), spec("m-b", P.b)], { "m-a": LIMIT });
      reset();
      const twoAuth = await turn([spec("m-a", P.a), spec("m-b", P.b)], { "m-a": AUTH });
      reset();
      // 같은 provider 의 다른 모델 — 쿨다운이 provider 단위라 같이 쉰다(전환할 곳이 아니다). 두 번째는 시도돼도 한도다.
      const sameProv = await turn([spec("m-a", P.a), spec("m-a2", P.a)], { "m-a": LIMIT, "m-a2": LIMIT });
      reset();
      // 이번 턴에 한도 아닌 이유로 먼저 실패한 후보 뒤에 한도 — 남은 후보가 없다.
      const afterStructural = await turn([spec("m-c", P.c), spec("m-a", P.a)], { "m-c": "socket hang up", "m-a": LIMIT });
      reset();
      // 다른 후보가 이미 쉬는 중 — 먼저 B 를 쉬게 하고(그 통지는 버린다), A 가 한도.
      await turn([spec("m-b", P.b)], { "m-b": LIMIT });
      const otherCooling = await turn([spec("m-a", P.a), spec("m-b", P.b)], { "m-a": LIMIT, "m-b": LIMIT });
      reset();
      // ★시작 때 쉬어서 순회에서 빠진 후보가 **도중에 풀려도** 이 턴엔 시도되지 않는다(GPT R1-B1) — 전환한다고 말하면 거짓이다.
      saveCooldown(P.b, Date.now() + 150);
      delayMs = 300;
      const expiredMid = await turn([spec("m-a", P.a), spec("m-b", P.b)], { "m-a": LIMIT });
      const expiredMidCalled = [...called];
      delayMs = 0;
      reset();
      // ★쿨다운 **쓰기만** 실패(조회는 됨) — 같은 provider 의 다른 모델을 «쓸 수 있다» 로 세지 않는다(GPT R1-B2).
      getDb().pragma("query_only = ON");
      let writeBlocked: string | undefined;
      try {
        writeBlocked = await turn([spec("m-a", P.a), spec("m-a2", P.a)], { "m-a": LIMIT, "m-a2": LIMIT });
      } finally {
        getDb().pragma("query_only = OFF");
      }

      out.push(
        assert(
          "★후보가 하나뿐인 풀(한도·인증 거부)의 통지에는 «다른 모델로 자동 전환합니다» 가 없다 — 첫 줄(무엇이 막혔나)은 있다",
          single !== undefined && singleAuth !== undefined && !says(single) && !says(singleAuth),
          { single: single?.slice(0, 120) ?? "(통지 없음)", singleAuth: singleAuth?.slice(0, 120) ?? "(통지 없음)" },
        ),
      );
      out.push(
        assert(
          "★다른 provider 의 후보가 쓸 수 있으면 그 문장이 있다(한도=«그때까지» · 인증=«그동안»)",
          two?.includes(translate("srv.limit.switchUntil")) === true && twoAuth?.includes(translate("srv.limit.switchMeanwhile")) === true,
          { two: two?.slice(0, 160) ?? "(통지 없음)", twoAuth: twoAuth?.slice(0, 160) ?? "(통지 없음)" },
        ),
      );
      out.push(
        assert(
          "같은 provider 의 다른 모델 · 이번 턴에 구조적으로 실패한 후보 · 이미 쉬는 후보는 «전환할 곳» 이 아니다",
          sameProv !== undefined && afterStructural !== undefined && otherCooling !== undefined &&
            !says(sameProv) && !says(afterStructural) && !says(otherCooling),
          {
            sameProv: sameProv?.slice(0, 100) ?? "(통지 없음)",
            afterStructural: afterStructural?.slice(0, 100) ?? "(통지 없음)",
            otherCooling: otherCooling?.slice(0, 100) ?? "(통지 없음)",
          },
        ),
      );
      out.push(
        assert(
          "★판정은 **이번 순회에 남은 후보**만 본다 — 시작 때 쉬어 빠진 후보가 도중에 풀려도(이 턴엔 안 부른다) 전환을 약속하지 않는다 · " +
            "쿨다운 쓰기만 실패해도 같은 provider 는 «전환할 곳» 이 아니다",
          expiredMid !== undefined && !says(expiredMid) && !expiredMidCalled.includes("m-b") &&
            writeBlocked !== undefined && !says(writeBlocked),
          {
            expiredMid: expiredMid?.slice(0, 100) ?? "(통지 없음)",
            expiredMidCalled,
            writeBlocked: writeBlocked?.slice(0, 100) ?? "(통지 없음)",
          },
        ),
      );
    } finally {
      restore();
      unregisterChannelOutbound(CH);
      reset();
    }
    return out;
  },
};
