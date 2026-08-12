/**
 * 회귀: **모델 하나가 막히면 회전한다 — 사람을 부르지 않는다.**
 *
 * 사고 (2026-08-12, 사용자: "자가 이상이 너무 자주 발생하는데"):
 *  회사 PC 로그(08-11) 실측 — `server_is_overloaded` 39건이 **전부 한 모델**
 *  (`model=gpt-5.6-sol`)이었는데, 그 축은 쿨다운 대상 밖이라 **매 턴 죽은 모델부터**
 *  다시 두드렸다. 어댑터는 같은 모델에 같은 요청을 4번 더 보내(14:53:05→15:04:04 = 11분)
 *  실패를 쌓았고, 그 실패가 자가 점검 임계(3건)를 넘겨 사용자에게 알림으로 나갔다.
 *  즉 소음의 뿌리는 점검 로직이 아니라 **회전하지 않는 라우팅**이었다.
 *  (2026-07-30 에도 같은 부류였다 — 그때는 사람이 모델을 바꿔서 끝냈다.)
 *
 * 지키는 것 —
 *  ① 한도(계정 축)와 과부하(모델 축)를 **가른다** — 대책이 다르므로 판정도 달라야 한다
 *  ② 과부하 쿨다운 키는 **모델까지**(provider 통째로 쉬면 멀쩡한 형제 모델까지 죽는다)
 *  ③ 쿨다운은 **선호 순서**지 하드 차단이 아니다 — 전부 막히면 그래도 시도한다
 *  ④ 성공하면 **두 축 모두** 해제(한쪽만 지우면 살아난 모델을 계속 스킵 = 자기 잠금)
 *  ⑤ codex 는 모델 축 실패에 사다리를 다 오르지 않는다(회전이 대책)
 *  ⑥ ★"오래 걸림" 은 실패 판정 재료가 아니다 — 경과 시간으로는 아무것도 분류하지 않는다
 */
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const { isModelOverloaded, isRateLimited, OVERLOAD_COOLDOWN_MS } = await import(
    "../../core/llm-runtime/rate-limit.js"
  );
  const rt = await import("../../core/llm-runtime/index.js");

  // ── ① 두 축을 가른다 ───────────────────────────────────────────────────────
  {
    const overload = "error/server_is_overloaded: Our servers are currently overloaded.";
    const limit = 'Codex backend 호출 실패: 429 {"error":{"type":"usage_limit_reached"';
    out.push({
      name: "★과부하(모델 축)와 한도(계정 축)를 서로 다른 판정으로 가른다",
      ok:
        isModelOverloaded(overload) &&
        !isRateLimited(overload) &&
        isRateLimited(limit) &&
        !isModelOverloaded(limit),
      got:
        `과부하문구: overloaded=${isModelOverloaded(overload)} limit=${isRateLimited(overload)} / ` +
        `한도문구: overloaded=${isModelOverloaded(limit)} limit=${isRateLimited(limit)}`,
    });
    out.push({
      name: "★경과 시간은 실패 판정 재료가 아니다(느린 것은 실패가 아니다)",
      ok: !isModelOverloaded("11분 걸림 slow 300s+ 실행 중") && !isRateLimited("느림 slow"),
      got: "시간 문구로는 어떤 축도 참이 되지 않음",
    });
    out.push({
      name: "과부하 쿨다운은 짧다(과부하는 초~분 단위로 풀린다)",
      ok: OVERLOAD_COOLDOWN_MS > 0 && OVERLOAD_COOLDOWN_MS <= 10 * 60_000,
      got: `${Math.round(OVERLOAD_COOLDOWN_MS / 60000)}분`,
    });
  }

  // ── ②③④ 등록·스킵·해제 (실제 함수를 돌린다) ─────────────────────────────
  {
    const spec = { adapter: "codex", model: "gpt-5.6-sol", provider: "codex" } as never;
    const sibling = { adapter: "codex", model: "gpt-5.6-terra", provider: "codex" } as never;
    const overloadErr = new Error(
      "error/server_is_overloaded: Our servers are currently overloaded. Please try again later.",
    );
    rt.clearCooldowns();

    const entered = rt.registerCooldownIfModelOverloaded(spec, overloadErr);
    out.push({
      name: "★과부하 쿨다운 키가 모델까지다(계정 전체를 쉬지 않는다)",
      ok: entered !== null && entered.key === "codex:gpt-5.6-sol",
      got: `key=${entered === null ? "(미등록)" : entered.key}`,
    });
    out.push({
      name: "★같은 provider 의 형제 모델은 안 막힌다",
      ok: rt.cooldownRemainingMs(spec) > 0 && rt.cooldownRemainingMs(sibling) === 0,
      got: `죽은모델 ${Math.round(rt.cooldownRemainingMs(spec) / 1000)}s · 형제 ${Math.round(rt.cooldownRemainingMs(sibling) / 1000)}s`,
    });

    const pool = [spec, sibling];
    const eligible = rt.selectEligiblePool(pool);
    out.push({
      name: "★풀이 죽은 모델을 건너뛰고 다음 모델로 회전한다",
      ok: eligible.length === 1 && (eligible[0] as { model: string }).model === "gpt-5.6-terra",
      got: `${eligible.map((s) => (s as { model: string }).model).join(",")}`,
    });

    // ③ 전부 막혀도 풀을 비우지 않는다 — 부분 장애를 전면 장애로 키우지 않는다.
    rt.registerCooldownIfModelOverloaded(sibling, overloadErr);
    const allDown = rt.selectEligiblePool(pool);
    out.push({
      name: "★마지막 하나까지 막혀도 그래도 시도한다(쿨다운은 선호지 차단이 아니다)",
      ok: allDown.length === pool.length,
      got: `${allDown.length}/${pool.length}개 남음`,
    });

    // ④ 성공하면 두 축 모두 해제.
    rt.clearCooldownOnSuccess(spec);
    out.push({
      name: "★성공하면 그 모델 쿨다운이 즉시 풀린다(살아난 걸 계속 스킵하지 않게)",
      ok: rt.cooldownRemainingMs(spec) === 0,
      got: `${Math.round(rt.cooldownRemainingMs(spec) / 1000)}s 남음(기대 0)`,
    });

    // 한도 문구로는 모델 축이 등록되지 않는다(축 혼선 방지).
    rt.clearCooldowns();
    const wrongAxis = rt.registerCooldownIfModelOverloaded(
      spec,
      new Error('429 {"error":{"type":"usage_limit_reached"}}'),
    );
    out.push({
      name: "한도 실패는 모델 축에 등록하지 않는다(같은 실패를 두 축에 걸지 않게)",
      ok: wrongAxis === null,
      got: wrongAxis === null ? "미등록" : `★등록됨 ${wrongAxis.key}`,
    });
    rt.clearCooldowns();
  }

  // ── ⑤ runPool 이 실제로 모델 축 등록을 부른다(배선) ────────────────────────
  {
    const src = await readFile(
      new URL("../../core/llm-runtime/index.ts", import.meta.url),
      "utf8",
    );
    const wired = /registerCooldownIfModelOverloaded\(spec, e\)/.test(src);
    out.push({
      name: "★턴 실패 경로가 모델 축 등록을 부른다(안 부르면 회전이 영영 안 생긴다)",
      ok: wired,
      got: wired ? "runPool 배선 확인" : "★미배선(함수만 있고 아무도 안 부름)",
    });
  }

  // ── ⑥ 자가 점검이 스스로 처리된 실패를 안 센다 + 근거를 싣는다 ─────────────
  {
    // 진단은 코어 모듈이다 (2026-08-12 이관) — 검사가 `plugins/` 를 넘겨다볼 이유가 없다.
    const { isSelfHandled, describeTurnErrors } = await import("../../core/health-sweep.js");
    const restart = JSON.stringify({
      threadKey: "dashboard:default",
      reason: "daemon-restart",
      error: "데몬 재시작(SIGTERM)으로 중단",
    });
    const limit = JSON.stringify({
      threadKey: "dashboard:default",
      adapter: "claude",
      message: "claude-agent-sdk error: You've hit your limit · resets 2:20am",
    });
    const overload = JSON.stringify({
      threadKey: "agent:abc",
      adapter: "codex",
      model: "gpt-5.6-sol",
      message: "error/server_is_overloaded: Our servers are currently overloaded.",
    });
    out.push({
      name: "★데몬 재시작 중단을 '어댑터 이상' 으로 세지 않는다(라벨이 틀렸었다)",
      ok: isSelfHandled(restart),
      got: isSelfHandled(restart) ? "제외" : "★어댑터 이상으로 집계됨",
    });
    out.push({
      name: "★사용량 한도를 다시 세지 않는다(쿨다운 진입 때 이미 통지했다)",
      ok: isSelfHandled(limit),
      got: isSelfHandled(limit) ? "제외" : "★같은 일을 두 번 말함",
    });
    out.push({
      name: "실제 백엔드 실패는 그대로 센다(폴백이 받아냈어도 가리지 않는다)",
      ok: !isSelfHandled(overload),
      got: isSelfHandled(overload) ? "★과부하까지 침묵" : "집계 대상",
    });
    const line = describeTurnErrors([overload, overload]);
    out.push({
      name: "★알림에 원인·모델·배경여부가 실린다(받는 사람이 로그를 안 뒤지게)",
      ok:
        line.includes("codex/gpt-5.6-sol") &&
        line.includes("과부하") &&
        line.includes("배경"),
      got: JSON.stringify(line),
    });
  }

  // ── ⑦ 로그가 "느림 = 의심" 이라고 적지 않는다 ──────────────────────────────
  {
    const src = await readFile(
      new URL("../../core/llm-runtime/tool-watchdog.ts", import.meta.url),
      "utf8",
    );
    // ★주석이 아니라 **발화하는 문자열**에 앵커를 건다 — 이 파일 주석에도 `[tool-slow]`
    //  가 나오는데 첫 등장으로 창을 잡으면 엉뚱한 데를 검사한다(실제로 그렇게 헛불이 났다).
    const i = src.indexOf("`[tool-slow] ${input.threadKey}");
    const body = i < 0 ? "" : src.slice(i, i + 500);
    const clean = body.includes("실패가 아닙니다") && !body.includes("hung·느림 의심");
    out.push({
      name: "★경과 시간 보고가 판정처럼 읽히지 않는다",
      ok: clean,
      got: clean ? "중립 문구" : "★'hung·느림 의심' 이 남아 있다",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "model-outage-rotates",
  guards:
    "모델 하나가 막혔는데 쿨다운 축이 provider 뿐이라 매 턴 죽은 모델부터 다시 두드리고, 어댑터가 같은 모델에 4번 재전송해 한 턴에 11분을 태우고, 그 실패가 자가 점검 알림으로 사용자에게 넘어가던 것",
  run,
};
