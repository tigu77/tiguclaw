/**
 * `limit-resume-wake-time` 의 자식 — 실제 `runRegionA` 를 가짜 어댑터로 돌려 **한도 실패에 실린 재개 시각**을 잰다.
 *
 * ★왜 자식인가: 용량 필터(`models.limits`)를 재려면 홈 settings.json 을 써야 한다 — 스위트 홈에 쓰면 뒤따르는 검사가 그 설정을 본다.
 *  이 프로세스만의 하위 홈을 만들어 거기 쓴다(`pinModelForTest` 와 같은 범위).
 * 출력: 마지막 줄에 JSON 한 줄 — 시나리오 이름 → 관측값.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";

assertIsolated();
const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "limit-resume-"));
process.env.TIGUCLAW_HOME = home;
// 용량 상한 — `regr-big:m` 은 5자까지만 받는다(④).
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ models: { limits: { "regr-big:m": { maxInputChars: 5 } } } }));

const { initStore } = await import("../../store/sessions.js");
initStore();
const { runRegionA, __setAdapterForTest, clearCooldowns } = await import("../../core/llm-runtime/index.js");
const { resumeAtOf, partialReasonOf } = await import("../../core/llm-runtime/resume-signal.js");
const { markToolDispatch } = await import("../../core/llm-runtime/replay-safety.js");
const { ToolHangError } = await import("../../core/llm-runtime/tool-watchdog.js");
const { saveCooldown, getCooldownRow } = await import("../../store/cooldowns.js");

type Spec = { adapter: "claude"; provider: string; model: string };
const spec = (provider: string, model = "m"): Spec => ({ adapter: "claude", provider, model });
const limitErr = (sec: number): Error => new Error(`429 usage_limit_reached {"resets_in_seconds": ${sec}}`);

type Behavior = (provider: string, replay: unknown) => never | { text: string };
const run = async (chain: Spec[][], behave: Behavior, text = "x"): Promise<{ t0: number; resumeAt?: number; partial?: string; attempts: string[]; msg: string }> => {
  clearCooldowns();
  return runWith(chain, behave, text);
};
const runWith = async (chain: Spec[][], behave: Behavior, text = "x"): Promise<{ t0: number; resumeAt?: number; partial?: string; attempts: string[]; msg: string }> => {
  const attempts: string[] = [];
  const restore = __setAdapterForTest(async (_a: string, i: { provider?: string; replay?: unknown }) => {
    attempts.push(i.provider ?? "?");
    return behave(i.provider ?? "?", i.replay) as { text: string };
  });
  const t0 = Date.now();
  try {
    await runRegionA({ text, threadKey: "regr:limit-resume-rt", channel: "cli" } as never, { chain } as never);
    return { t0, attempts, msg: "(성공)" };
  } catch (e) {
    const resumeAt = resumeAtOf(e);
    const partial = partialReasonOf(e);
    return { t0, attempts, msg: e instanceof Error ? e.message.slice(0, 160) : String(e), ...(resumeAt !== undefined ? { resumeAt } : {}), ...(partial !== undefined ? { partial } : {}) };
  } finally {
    restore();
  }
};
const rel = (r: { t0: number; resumeAt?: number }): number | null => (r.resumeAt === undefined ? null : Math.round((r.resumeAt - r.t0) / 1000));
const out: Record<string, unknown> = {};

// ① [A, B] — A 가 부작용 도구 실행 뒤 한도. B 는 쿨다운 없음 → 지금 가능.
{
  const r = await run([[spec("regr-a"), spec("regr-b")]], (p, replay) => {
    if (p === "regr-a") {
      markToolDispatch(replay as never, "send_file", false);
      throw limitErr(3600);
    }
    return { text: "B 성공" };
  });
  out.sideEffectThenLimit = { rel: rel(r), attempts: r.attempts, partial: r.partial ?? null };
}
// ② 단일 [A] — A 의 해제 시각. ⑦ 장부 until_ts 는 백엔드가 말한 값 그대로(여유 없음).
{
  const r = await run([[spec("regr-a")]], () => { throw limitErr(3600); });
  const row = getCooldownRow("regr-a", Date.now());
  out.single = { rel: rel(r), ledgerRel: row === null ? null : Math.round((row.untilTs - r.t0) / 1000), equal: row !== null && r.resumeAt === row.untilTs };
}
// ③ 풀 전부 쿨다운 — last-resort 로 둘 다 시도, 각자 새 해제 시각 → 가장 이른 것.
{
  clearCooldowns();
  const now = Date.now();
  saveCooldown("regr-a", now + 20 * 60_000);
  saveCooldown("regr-b", now + 10 * 60_000);
  const r = await runWith([[spec("regr-a"), spec("regr-b")]], (p) => { throw limitErr(p === "regr-a" ? 1800 : 900); });
  out.allCooling = { rel: rel(r), attempts: r.attempts };
}
// ④ 용량 상한을 넘는 후보는 «지금 가능» 에 안 센다 — [Big(5자 상한), A]·입력 20자 · A 한도 600초.
{
  // Big 은 호출되면 안 된다 — 호출되면 성공해 버려 이 시나리오 자체가 «성공» 으로 드러난다.
  const r = await run([[spec("regr-big"), spec("regr-a")]], (p) => {
    if (p === "regr-big") return { text: "용량 넘는 후보가 불렸다" };
    throw limitErr(600);
  }, "x".repeat(20));
  out.capacity = { rel: rel(r), attempts: r.attempts };
}
// ⑤ 401 → 재개 없음.
{
  const r = await run([[spec("regr-a")]], () => { throw new Error("401 authentication_error: invalid x-api-key"); });
  out.auth = { rel: rel(r) };
}
// ⑥ 탐침 부작용 없음 — A 는 10시간 쉬는 중(탐침 시각 = 지금), B 한도 600초. 재개 판정이 A 를 읽어도 last_probe_ts 가 안 바뀐다.
{
  clearCooldowns();
  const probeAt = Date.now() - 1000;
  saveCooldown("regr-a", Date.now() + 10 * 3600_000);
  // saveCooldown 은 탐침 시각을 지금으로 적는다 — 그 값을 기준으로 잰다.
  const before = getCooldownRow("regr-a", Date.now())?.lastProbeTs ?? -1;
  const r = await runWith([[spec("regr-a"), spec("regr-b")]], () => { throw limitErr(600); });
  const after = getCooldownRow("regr-a", Date.now())?.lastProbeTs ?? -2;
  out.probe = { rel: rel(r), attempts: r.attempts, probeUnchanged: before === after && before >= probeAt };
}
// ⑧ [자격 증명 없는 A, 한도 B] — A 는 이번 실행에서 한도 아닌 이유로 실패 → 빠지고 B 의 해제 시각.
{
  const r = await run([[spec("regr-a"), spec("regr-b")]], (p) => {
    if (p === "regr-a") throw new Error("no credentials configured for provider regr-a");
    throw limitErr(1200);
  });
  out.otherExcluded = { rel: rel(r), attempts: r.attempts };
}
// ⑨ 앞 풀 구조적 거부 → 다음 풀 한도 → 다음 풀 기준.
{
  const r = await run([[spec("regr-a")], [spec("regr-b")]], (p) => {
    if (p === "regr-a") throw new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: m"}}');
    throw limitErr(1500);
  });
  out.nextPool = { rel: rel(r), attempts: r.attempts };
}
// ⑩ 한도가 **아닌** 오류 + 이름에 quota/rate_limit 이 든 도구가 실행된 뒤 → 재개 없음(사유 문장을 분류하지 않는다).
{
  const r = await run([[spec("regr-a"), spec("regr-b")]], (p, replay) => {
    if (p === "regr-a") {
      markToolDispatch(replay as never, "mcp__x__quota_rate_limit_check", false);
      throw new Error("socket hang up");
    }
    return { text: "B" };
  });
  out.toolNameNotLimit = { rel: rel(r), msgHasTool: r.msg.includes("quota_rate_limit") };
}
// ⑪ 401 + 그 도구 이름 → 재개 없음.
{
  const r = await run([[spec("regr-a"), spec("regr-b")]], (p, replay) => {
    if (p === "regr-a") {
      markToolDispatch(replay as never, "mcp__x__quota_rate_limit_check", false);
      throw new Error("401 Unauthorized");
    }
    return { text: "B" };
  });
  out.authWithToolName = { rel: rel(r) };
}
// ⑫ ToolHangError(도구 이름 rate_limit_status) → 재개 없음.
{
  const r = await run([[spec("regr-a")]], () => { throw new ToolHangError("rate_limit_status", 60_000); });
  out.toolHang = { rel: rel(r), msg: r.msg.slice(0, 60) };
}
// 성공 턴엔 아무것도 안 실린다(던지지 않으니 당연하지만, 한도 뒤 성공 폴백이 칸을 남기지 않는지도 본다).
{
  const r = await run([[spec("regr-a"), spec("regr-b")]], (p) => {
    if (p === "regr-a") throw limitErr(600);
    return { text: "B 성공" };
  });
  out.fallbackSuccess = { msg: r.msg, rel: rel(r) };
}
// 작업 결과로 운반 — 두 레지스트리 공용 `failureOutcome` 이 런타임이 실은 시각을 `WorkerOutcome.resumeAtMs` 로 옮긴다(GPT 검토 R1 — 그물이 없었다).
{
  const { failureOutcome } = await import("../../core/worker-jobs.js");
  const r = await run([[spec("regr-a")]], () => { throw limitErr(900); });
  // 같은 오류 객체를 다시 만들 수 없어 실제 실패를 한 번 더 받는다.
  let thrown: unknown;
  const restore = __setAdapterForTest(async () => { throw limitErr(900); });
  try { await runRegionA({ text: "x", threadKey: "regr:limit-resume-rt", channel: "cli" } as never, { chain: [[spec("regr-a")]] } as never); } catch (e) { thrown = e; } finally { restore(); }
  const o = failureOutcome(thrown) as { resumeAtMs?: number };
  const plain = failureOutcome(new Error("그냥 실패")) as { resumeAtMs?: number };
  const str = failureOutcome("문자열 실패") as { resumeAtMs?: number };
  out.outcome = { carried: o.resumeAtMs !== undefined && o.resumeAtMs === resumeAtOf(thrown), relSec: o.resumeAtMs === undefined ? null : Math.round((o.resumeAtMs - r.t0) / 1000), plain: "resumeAtMs" in plain, str: "resumeAtMs" in str };
}
clearCooldowns();
console.log(JSON.stringify(out));
process.exit(0);
