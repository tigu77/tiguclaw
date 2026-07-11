#!/usr/bin/env node
// skill-forge eval 집계 — grader 결과 배치를 config 별로 묶어 정량 지표 + delta 산출.
// provider 중립(어댑터 특수분기 0). 라이브러리 위임 불가한 순수 계산만 직접 구현.
//
// 사용법:
//   node aggregate.mjs <results.json> [--baseline <name>] [--candidate <name>]
//
// results.json 형식 (오케스트레이터가 grader 산출물을 모아 작성):
// {
//   "skill": "my-skill",
//   "runs": [
//     { "config": "baseline", "eval_id": "e1", "run": 1,
//       "pass": true, "passed_count": 3, "total_count": 3,
//       "time_ms": 12000, "tokens": 4500 }, ...
//   ]
// }
// config 는 "baseline"/"candidate" 대조든 "claude"/"codex"/"gemini" 어댑터 비교든 자유.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
if (!file) {
  console.error("usage: node aggregate.mjs <results.json> [--baseline <name>] [--candidate <name>]");
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`결과 파일 파싱 실패: ${e.message}`);
  process.exit(2);
}
const runs = Array.isArray(data.runs) ? data.runs : [];
if (runs.length === 0) {
  console.error("runs 가 비어 있음 — eval 실행 결과가 없습니다.");
  process.exit(2);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// 표본 표준편차(n-1). 표본 1개면 0.
const stddev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const nums = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

// config 별 그룹
const byConfig = new Map();
for (const r of runs) {
  const c = String(r.config ?? "default");
  if (!byConfig.has(c)) byConfig.set(c, []);
  byConfig.get(c).push(r);
}

const summarize = (rs) => {
  const passVals = rs.map((r) => (r.pass ? 1 : 0));
  // assertion 통과율(부분점수): passed_count/total_count
  const assertRates = nums(
    rs.map((r) =>
      typeof r.total_count === "number" && r.total_count > 0
        ? r.passed_count / r.total_count
        : NaN,
    ),
  );
  const times = nums(rs.map((r) => r.time_ms));
  const toks = nums(rs.map((r) => r.tokens));
  const runnerFails = rs.filter((r) => r.runner_failed).length;
  return {
    runs: rs.length,
    pass_rate: mean(passVals),
    pass_rate_sd: stddev(passVals),
    assertion_rate: assertRates.length ? mean(assertRates) : null,
    time_ms: times.length ? mean(times) : null,
    tokens: toks.length ? mean(toks) : null,
    runner_failures: runnerFails,
  };
};

const summary = {};
for (const [c, rs] of byConfig) summary[c] = summarize(rs);

const baseName = opt("--baseline", byConfig.has("baseline") ? "baseline" : null);
const candName = opt("--candidate", byConfig.has("candidate") ? "candidate" : null);
let delta = null;
if (baseName && candName && summary[baseName] && summary[candName]) {
  const b = summary[baseName];
  const c = summary[candName];
  const d = (x, y) => (x == null || y == null ? null : x - y);
  delta = {
    baseline: baseName,
    candidate: candName,
    pass_rate: d(c.pass_rate, b.pass_rate),
    assertion_rate: d(c.assertion_rate, b.assertion_rate),
    time_ms: d(c.time_ms, b.time_ms),
    tokens: d(c.tokens, b.tokens),
  };
}

// ---- 사람용 표 ----
const sign = (x) => (x > 0 ? `+${f2(x)}` : f2(x));
const line = [];
line.push(`\n## skill-creator eval 집계 — ${data.skill ?? "(skill)"}\n`);
line.push("| config | runs | pass_rate | ±sd | assert_rate | time_s | tokens | runner_fail |");
line.push("|---|---|---|---|---|---|---|---|");
for (const [c, s] of Object.entries(summary)) {
  line.push(
    `| ${c} | ${s.runs} | ${f2(s.pass_rate)} | ${f2(s.pass_rate_sd)} | ` +
      `${s.assertion_rate == null ? "—" : f2(s.assertion_rate)} | ` +
      `${s.time_ms == null ? "—" : f2(s.time_ms / 1000)} | ` +
      `${s.tokens == null ? "—" : Math.round(s.tokens)} | ${s.runner_failures} |`,
  );
}
if (delta) {
  line.push(
    `\n**Δ (${delta.candidate} − ${delta.baseline})**: ` +
      `pass_rate ${sign(delta.pass_rate)}` +
      (delta.assertion_rate == null ? "" : ` · assert ${sign(delta.assertion_rate)}`) +
      (delta.time_ms == null ? "" : ` · time ${sign(delta.time_ms / 1000)}s`) +
      (delta.tokens == null ? "" : ` · tokens ${sign(delta.tokens)}`),
  );
  const verdict =
    delta.pass_rate > 0
      ? "후보가 baseline 대비 개선 (pass_rate ↑). 사람 승인 후 반영 권장."
      : delta.pass_rate < 0
        ? "후보가 baseline 대비 퇴보 (pass_rate ↓). 반영 금지·재설계."
        : "pass_rate 동률 — 변별 안 됨. 테스트셋이 약하거나 개선 효과 미미(assert_rate·time·tokens 로 판단).";
  line.push(`\n**판정:** ${verdict}`);
}
line.push("\n> 자동 판정은 참고. 스킬 파일 실제 교체는 **사람 승인 게이트** 필수(self-growth 단방향·human-gated).");

console.log(line.join("\n"));
// 기계용 JSON (마지막 줄, 필요 시 파싱)
console.log("\n<!--JSON-->" + JSON.stringify({ skill: data.skill ?? null, summary, delta }));
