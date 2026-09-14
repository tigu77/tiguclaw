/** 실제 집계 CLI에 정상 대조와 감사에서 살아남은 잘못된 입력을 넣는다. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, type Assertion, type RegressionCheck } from './_framework.js';
const script = fileURLToPath(new URL('../../../skills/skill-creator/scripts/aggregate.mjs', import.meta.url));
export const check: RegressionCheck = {
  name: 'skill-eval-comparison',
  guards: '다른 과제·누락 사용량을 개선으로 집계하고 문자열 false·실패 러너를 성공으로 세던 것',
  run: async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skill-eval-contract-'));
    const conditions = { adapter: 'fixture', model: 'same', served_model: 'same', reasoning: 'low', prompt_hash: 'p', fixture_hash: 'f', assertions_hash: 'a' };
    const base = { config: 'baseline', eval_id: 'e1', run: 1, pass: true, passed_count: 2, total_count: 2, tokens: 100, time_ms: 10, conditions };
    const candidate = { ...base, config: 'candidate', tokens: 80 };
    const execute = (runs: unknown[]) => {
      const file = path.join(dir, 'results.json');
      writeFileSync(file, JSON.stringify({ runs }));
      const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
      const json = r.stdout.split('<!--JSON-->')[1];
      return { status: r.status, report: json ? JSON.parse(json) : undefined, error: r.stderr };
    };
    const out: Assertion[] = [];
    try {
      const good = execute([base, candidate]);
      out.push(assert('동일 조건의 기능 보존은 동률로 비교', good.status === 0 && good.report?.delta?.pass_rate === 0 && good.report.delta.tokens === -20, good));
      for (const [name, value] of [['문자열 false', 'false'], ['숫자 1', 1], ['누락', undefined]] as const) {
        const r = execute([base, { ...candidate, pass: value }]);
        out.push(assert(`pass ${name} 거부`, r.status === 2, r));
      }
      const failed = execute([base, { ...candidate, runner_failed: true }]);
      out.push(assert('실패 러너의 성공 판정 거부', failed.status === 2, failed));
      const duplicate = execute([base, base, candidate]);
      out.push(assert('중복 실행 거부', duplicate.status === 2, duplicate));
      const differentTask = execute([base, { ...candidate, eval_id: 'easy' }]);
      out.push(assert('다른 과제의 성공으로 개선을 만들지 않음', differentTask.status === 0 && differentTask.report.delta === null, differentTask));
      const mismatch = execute([base, { ...candidate, conditions: { ...conditions, reasoning: 'high' } }]);
      out.push(assert('실행 조건 불일치 비교 보류', mismatch.report?.delta === null, mismatch));
      const absent = execute([base, { ...candidate, conditions: undefined }]);
      out.push(assert('미확인 실행 조건 비교 보류', absent.report?.delta === null, absent));
      const partial = execute([base, { ...base, run: 2, tokens: undefined }, candidate, { ...candidate, run: 2 }]);
      out.push(assert('토큰 누락은 분모에 표시하고 비용 차이 보류', partial.report?.summary.baseline.coverage.tokens.missing === 1 && partial.report.delta.tokens === null && partial.report.delta.pass_rate === 0, partial));
      const incomplete = execute([base, { ...candidate, accounting_incomplete: true }]);
      out.push(assert('부분 계측도 완전한 토큰으로 세지 않음', incomplete.report?.summary.candidate.coverage.tokens.observed === 0 && incomplete.report.delta.tokens === null, incomplete));
      const regression = execute([base, { ...candidate, passed_count: 1, pass: false }]);
      out.push(assert('실제 기능 퇴보를 숨기지 않음', regression.report?.delta.pass_rate === -1 && regression.report.delta.assertion_rate === -0.5, regression));
      return out;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};
