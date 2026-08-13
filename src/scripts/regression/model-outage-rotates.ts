/**
 * 회귀: **답하는 모델이 조용히 바뀌지 않는다** — 과부하는 분류만 하고 회전은 안 한다.
 *
 * 이력(왜 이 파일이 이런 모양인가):
 *  · 2026-08-12 — 회사 PC 실측(`server_is_overloaded` 39건이 전부 `gpt-5.6-sol`)을 근거로
 *    **모델 축 쿨다운 + 회전**을 넣었다. 죽은 모델을 매 턴 다시 두드리던 낭비가 목적이었다.
 *  · 2026-08-13 — 사용자가 **뺐다**: "모델 돌리는 거 빼는 게 낫겠어."
 *    이유가 벤치 원칙과 같다 — 답하는 모델이 사용자 모르게 바뀌면 **"이 모델을 쓸 때
 *    tiguclaw 가 어떤가"** 를 알 수 없다. 조용한 치환은 그 판단 자체를 불가능하게 만든다.
 *
 * 지금 지키는 것 —
 *  ① 과부하로 **모델을 쉬게 하지 않는다**(모델 축 쿨다운 API 부재)
 *  ② 쿨다운은 **계정 축(provider)만** — 한도는 같은 계정의 형제 모델로 옮겨봐야 소용없다
 *  ③ 실패 경로에 모델 축 등록 배선이 없다(있으면 언젠가 다시 불린다)
 *  ④ 과부하 판정 자체는 남는다 — **분류·보고**(자가 점검 문구·실패 분류)에는 계속 쓴다
 *  ⑤ codex 재전송은 조건 없이 사다리 끝까지(회전이 없으니 빨리 포기할 이유가 없다)
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const { isModelOverloaded, isRateLimited } = await import(
    "../../core/llm-runtime/rate-limit.js"
  );
  const rt = (await import("../../core/llm-runtime/index.js")) as Record<string, unknown>;

  const OVER = "error/server_is_overloaded: Our servers are currently overloaded.";
  const LIMIT = 'Codex backend 호출 실패: 429 {"error":{"type":"usage_limit_reached"}}';

  out.push({
    name: "과부하와 한도를 여전히 다른 축으로 분류한다(보고용)",
    ok: isModelOverloaded(OVER) && !isRateLimited(OVER) && isRateLimited(LIMIT),
    got: `over: overload=${isModelOverloaded(OVER)} limit=${isRateLimited(OVER)} / limit=${isRateLimited(LIMIT)}`,
  });

  out.push({
    name: "★과부하로 모델을 쉬게 하는 경로가 없다(회전 미도입)",
    ok: rt.registerCooldownIfModelOverloaded === undefined,
    got:
      rt.registerCooldownIfModelOverloaded === undefined
        ? "모델 축 등록 API 없음"
        : "★모델 축 쿨다운이 살아 있다 — 답하는 모델이 조용히 바뀔 수 있다",
  });

  {
    const spec = { adapter: "codex", model: "gpt-5.6-sol", provider: "codex" } as never;
    const status = (rt.cooldownStatus as (s: never) => { key: string })(spec);
    out.push({
      name: "★쿨다운 키는 계정 축(provider)이다",
      ok: status.key === "codex",
      got: `key=${status.key} (기대 codex — 모델명이 들어가면 모델 단위로 쉬는 것)`,
    });
  }

  const facade = await readFile(
    new URL("../../core/llm-runtime/index.ts", import.meta.url),
    "utf8",
  );
  const codex = await readFile(
    new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url),
    "utf8",
  );
  const noRotate = !/registerCooldownIfModelOverloaded\(/.test(facade);
  out.push({
    name: "★턴 실패 경로가 모델을 쉬게 하지 않는다",
    ok: noRotate,
    got: noRotate ? "호출 없음" : "★다시 배선됐다",
  });
  const fullLadder =
    /backendFailAttempt < CODEX_BACKEND_FAIL_BACKOFF_MS\.length/.test(codex) &&
    !/CODEX_OVERLOAD_MAX_RESEND/.test(codex);
  out.push({
    name: "★재전송은 조건 없이 사다리 끝까지(옮겨 갈 데가 없으면 기다리는 게 대책)",
    ok: fullLadder,
    got: fullLadder ? "무조건 4단계" : "★과부하 단축이 남아 있다 — 회전 없이 빨리 포기한다",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "model-outage-rotates",
  guards:
    "과부하 시 모델을 쉬게 해 답하는 모델이 사용자 모르게 바뀌던 것(2026-08-12 도입 → 08-13 사용자 결정으로 철회) + 철회 뒤 남으면 안 되는 조기 포기(재전송 단축)",
  run,
};
