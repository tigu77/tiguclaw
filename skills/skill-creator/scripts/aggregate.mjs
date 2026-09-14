#!/usr/bin/env node
// skill-creator eval 집계 — grader 결과 배치를 config 별로 묶어 정량 지표 + delta 산출.
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
// config 는 "baseline"/"candidate" 대조든 "claude"/"codex"/"openai" 어댑터 비교든 자유.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(2); };
let file;
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (["--baseline", "--candidate"].includes(arg)) {
    if (!args[i + 1] || args[i + 1].startsWith("--") || options[arg]) fail(`잘못된 옵션: ${arg}`);
    options[arg] = args[++i];
  } else if (arg.startsWith("--") || file) fail(`알 수 없는 인자: ${arg}`);
  else file = arg;
}
const opt = (flag, def) => options[flag] ?? def;
if (!file) fail("usage: node aggregate.mjs <results.json> [--baseline <name>] [--candidate <name>]");
let data;
try { data = JSON.parse(readFileSync(file, "utf8")); }
catch (e) { fail(`결과 파일 파싱 실패: ${e.message}`); }
const runs = data?.runs;
if (!Array.isArray(runs) || !runs.length) fail("runs 가 비어 있거나 배열이 아닙니다.");
const metrics = ["time_ms", "tokens", "input_tokens", "cached_input_tokens", "output_tokens"];
const seen = new Set();
for (const [i, r] of runs.entries()) {
  if (!r || typeof r !== "object" || typeof r.config !== "string" || !r.config.trim() ||
      typeof r.eval_id !== "string" || !r.eval_id.trim() || !Number.isSafeInteger(r.run) || r.run < 1 ||
      typeof r.pass !== "boolean" || (r.runner_failed !== undefined && typeof r.runner_failed !== "boolean") ||
      (r.accounting_incomplete !== undefined && typeof r.accounting_incomplete !== "boolean") ||
      !Number.isSafeInteger(r.total_count) || r.total_count < 1 ||
      !Number.isSafeInteger(r.passed_count) || r.passed_count < 0 || r.passed_count > r.total_count ||
      r.pass !== (!r.runner_failed && r.passed_count === r.total_count)) fail(`runs[${i}]: 잘못된 판정·식별자·단언 수`);
  for (const m of metrics) if (r[m] !== undefined &&
      (typeof r[m] !== "number" || !Number.isFinite(r[m]) || r[m] < 0 || (m !== "time_ms" && !Number.isSafeInteger(r[m])))) fail(`runs[${i}]: 잘못된 ${m}`);
  if (r.cached_input_tokens !== undefined && r.input_tokens !== undefined && r.cached_input_tokens > r.input_tokens) fail(`runs[${i}]: 캐시 입력이 전체 입력 초과`);
  const key = JSON.stringify([r.config, r.eval_id, r.run]);
  if (seen.has(key)) fail(`중복 실행: ${key}`);
  seen.add(key);
}
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const stddev = (xs) => xs.length < 2 ? null : Math.sqrt(xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / (xs.length - 1));
const f2 = (x) => x == null ? "—" : (Math.round(x * 100) / 100).toFixed(2);

// config 별 그룹
const byConfig = new Map();
for (const r of runs) {
  const c = String(r.config ?? "default");
  if (!byConfig.has(c)) byConfig.set(c, []);
  byConfig.get(c).push(r);
}

const summarize = (rs) => {
  const passVals = rs.map(r => Number(r.pass));
  const coverage = Object.fromEntries(metrics.map(m => {
    const observed = rs.filter(r => r[m] !== undefined && (m === "time_ms" || !r.accounting_incomplete));
    return [m, { observed: observed.length, missing: rs.length - observed.length,
      mean: mean(observed.map(r => r[m])) }];
  }));
  return {
    runs: rs.length, pass_rate: mean(passVals), pass_rate_sd: stddev(passVals),
    assertion_rate: mean(rs.map(r => r.passed_count / r.total_count)),
    ...Object.fromEntries(metrics.map(m => [m, coverage[m].mean])), coverage,
    runner_failures: rs.filter(r => r.runner_failed).length,
  };
};
const summary = Object.fromEntries([...byConfig].map(([c, rs]) => [c, summarize(rs)]));
const baseName = opt("--baseline", byConfig.has("baseline") ? "baseline" : null);
const candName = opt("--candidate", byConfig.has("candidate") ? "candidate" : null);
const warnings = [];
let delta = null;
const conditionKeys = ["adapter", "model", "served_model", "reasoning", "prompt_hash", "fixture_hash", "assertions_hash"];
if (baseName || candName) {
  if (!baseName || !candName || baseName === candName || !byConfig.has(baseName) || !byConfig.has(candName)) fail("비교 config 두 개를 서로 다르게 지정하고 실제 결과를 포함하세요.");
  const key = r => JSON.stringify([r.eval_id, r.run]);
  const base = new Map(byConfig.get(baseName).map(r => [key(r), r]));
  const candidate = new Map(byConfig.get(candName).map(r => [key(r), r]));
  if (base.size !== candidate.size || [...base.keys()].some(k => !candidate.has(k))) warnings.push("과제·반복 번호 집합이 다름: 비교 보류");
  for (const [k, b] of base) {
    const c = candidate.get(k);
    if (!c) continue;
    if (b.total_count !== c.total_count || conditionKeys.some(f =>
      typeof b.conditions?.[f] !== "string" || !b.conditions[f].trim() || b.conditions[f] !== c.conditions?.[f])) warnings.push(`${k}: 단언·모델·프롬프트·초기 상태 조건 불명/불일치`);
  }
  if (!warnings.length) {
    const b = summary[baseName], c = summary[candName];
    delta = { baseline: baseName, candidate: candName, pairs: base.size,
      pass_rate: c.pass_rate - b.pass_rate, assertion_rate: c.assertion_rate - b.assertion_rate };
    for (const m of metrics) {
      delta[m] = b.coverage[m].missing || c.coverage[m].missing ? null : c[m] - b[m];
      if (delta[m] === null) warnings.push(`${m}: 미관측 실행이 있어 차이 계산 보류`);
    }
  }
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
  line.push("\n**해석:** 이 표본의 관측 차이입니다. 동률은 기능 보존 신호일 수 있으며 검사 삭제 근거가 아닙니다. 작은 표본·실행 순서·캐시 영향과 개별 실패를 확인한 뒤 판단하세요.");
}
for (const [c, s] of Object.entries(summary)) {
  line.push(`\n${c} 관측/전체: ` + metrics.map(m => `${m} ${s.coverage[m].observed}/${s.runs}`).join(" · "));
}
for (const warning of warnings) line.push(`\n⚠ ${warning}`);

console.log(line.join("\n"));
// 기계용 JSON (마지막 줄, 필요 시 파싱)
console.log("\n<!--JSON-->" + JSON.stringify({ skill: data.skill ?? null, summary, delta, warnings }));
