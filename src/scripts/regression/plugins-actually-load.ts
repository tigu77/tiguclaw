/**
 * 회귀: **플러그인이 실제로 로드된다** (2026-08-23).
 *
 * ★타입 OK ≠ 로드 OK. 2026-08-22 에 `typecheck` 범위를 넓혀 `plugins/` 의 타입 오류는
 *  잡게 됐지만, 데몬은 플러그인을 **tsx 로 런타임 로드**한다 — import 실패나 모듈 스코프
 *  초기화 throw 는 타입체크를 통과하고 **부팅 시에야** "플러그인 로드 실패" 로 죽는다.
 *  데몬은 살아 있고 그 플러그인만 빠지므로, 표는 로그에 `loaded ... plugin:` 라인이
 *  *없는 것*으로만 남는다(에러가 눈에 안 띈다).
 *
 *  실사고 (v0.3.1, 2026-07-01): add_schedule 설명 문자열 파싱이 깨져 scheduler 플러그인이
 *  로드 실패 → **cron·reboot 전부 미발화**(아침뉴스·보안감사·재시작알림). typecheck 통과·
 *  릴리스까지 됨.
 *
 * ★왜 여기로 옮기나: `verify:plugins` 스크립트는 **있었다**. 그런데 `sync-public` 릴리스
 *  게이트에서만 돌아서, 릴리스를 안 하는 동안엔 아무도 안 불렀다. 같은 날 `typecheck` 에서
 *  똑같은 것을 배웠다 — 07-18 부터 있던 `typecheck:plugins` 가 호출부 0이라 컴파일 안 되는
 *  코드가 하루를 살아남았다. **게이트는 '있다' 가 아니라 '도는가'**
 *  ([[feedback_gate_must_actually_run]]). 그래서 매번 도는 자리로 옮긴다.
 *
 * 판정은 스크립트와 **같은 근거**를 쓴다: 로더(`core/plugins/loader.ts`)가 읽는
 * `package.json` 의 `tiguclaw.entry`/`mcp`. 파일명을 추측하지 않는다 — 2026-08-17 에
 * 이름을 손으로 열거해서 4개 플러그인을 한 번도 안 보면서 "전부 OK" 라고 말한 적이 있다.
 *
 * 등급: **동작 검사**(실제 플러그인 및 무해 fixture의 import/생성, 공개·개발 동일).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(REPO, "src/scripts/verify-plugins-load.ts");

export const check: RegressionCheck = {
  name: "plugins-actually-load",
  guards: "플러그인의 import·생성 실패가 부팅 때만 드러나던 것 + 공개/개발 모두 verifier 부재·0개·부분 엔트리 누락을 성공으로 보지 않는다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    out.push(assert("verify:plugins command names the shipped standalone verifier", pkg.scripts?.["verify:plugins"] === "tsx src/scripts/verify-plugins-load.ts", undefined));
    if (!existsSync(SCRIPT)) {
      out.push(assert("required plugin verifier exists", false, SCRIPT));
      return out;
    }
    const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], { cwd: REPO, encoding: "utf8", timeout: 180_000 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const summary = /플러그인 (\d+)개 \/ 엔트리 (\d+)개 전부 로드 OK/.exec(output);
    out.push(assert("all plugin entries import and instantiate; nonempty coverage required", !r.error && r.signal === null && r.status === 0 && Number(summary?.[1]) > 0 && Number(summary?.[2]) > 0 && !output.includes("🔴"), { status: r.status, error: r.error?.message, output: output.slice(-600) }));

    // Only inert modules are evaluated; no plugin starts or external channels.
    const root = await mkdtemp(path.join(os.tmpdir(), "tigu-plugin-gate-"));
    try {
      const fixtures: Array<{ name: string; files: Record<string, string>; expected: number }> = [
        { name: "empty", files: {}, expected: 1 },
        { name: "missing-entry", files: { "missing/package.json": '{"tiguclaw":{"entry":"index.ts"}}' }, expected: 1 },
        { name: "partial", files: { "good/package.json": '{"tiguclaw":{"entry":"src/index.ts","mcp":"missing.ts"}}', "good/src/index.ts": "export default class {}" }, expected: 1 },
        { name: "bad-default", files: { "bad/package.json": '{"tiguclaw":{"entry":"src/index.ts"}}', "bad/src/index.ts": "export default {}" }, expected: 1 },
        { name: "throws", files: { "bad/package.json": '{"tiguclaw":{"entry":"src/index.ts"}}', "bad/src/index.ts": "export default class { constructor() { throw Error('fixture') } }" }, expected: 1 },
        { name: "late-throws", files: { "good/package.json": '{"tiguclaw":{"entry":"index.ts","mcp":"mcp.ts"}}', "good/index.ts": "export default class {}", "good/mcp.ts": "export default class { constructor() { throw Error('second entry fixture') } }" }, expected: 1 },
        { name: "source", files: { "good/package.json": '{"tiguclaw":{"entry":"src/index.ts"}}', "good/src/index.ts": "export default class {}" }, expected: 0 },
        { name: "built", files: { "good/package.json": '{"type":"module","tiguclaw":{"entry":"index.ts"}}', "good/index.js": "export default class {}" }, expected: 0 },
      ];
      for (const fixture of fixtures) {
        const dir = path.join(root, fixture.name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
        for (const [file, content] of Object.entries(fixture.files)) {
          const target = path.join(dir, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, dir], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
        const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        out.push(assert(`plugin verifier fixture ${fixture.name}`, !result.error && result.signal === null && result.status === fixture.expected && (fixture.expected === 0 ? /플러그인 1개 \/ 엔트리 1개 전부 로드 OK/.test(text) : text.includes("🔴") && !text.includes("전부 로드 OK")), { status: result.status, error: result.error?.message, output: text.slice(-800) }));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return out;
  },
};
