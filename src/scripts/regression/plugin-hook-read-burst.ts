/** Windows 전체 회귀: 동시 SubagentStop 발견이 후속 memory.ts 읽기를 EMFILE 로 만들었다. */
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-hook-read-burst",
  guards: "동시 훅 발견이 파일 open 을 무제한으로 시작해 후속 파일 읽기까지 EMFILE 로 실패하는 것 — 결과 캐시 없이 매 호출 다시 읽는다",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const { pluginHookSources } = await import("../../core/plugins/plugin-hooks.js");
    const { readPluginText } = await import("../../core/plugins/plugin-file-reader.js");
    const root = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "hook-read-burst-"));
    const make = (scope: string, command: string): { root: string; file: string } => {
      const r = path.join(root, scope), dir = path.join(r, "probe");
      mkdirSync(path.join(dir, "hooks"), { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ tiguclaw: { name: "read-burst-probe" } }));
      const file = path.join(dir, "hooks", "hooks.json");
      writeFileSync(file, JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: "command", command }] }] } }));
      return { root: r, file };
    };
    const a = make("a", "first"), b = make("b", "other-root");
    const command = (sources: Awaited<ReturnType<typeof pluginHookSources>>): unknown =>
      (sources[0]?.entries[0]?.item as { command?: unknown } | undefined)?.command;
    const original = fs.readFile;
    let active = 0, peak = 0, reads = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      active += 1; peak = Math.max(peak, active); reads += 1;
      try { return await original(...args); }
      finally { active -= 1; }
    }) as typeof fs.readFile;
    const out: Assertion[] = [];
    try {
      const results = await Promise.all(Array.from({ length: 1200 }, () => pluginHookSources([a.root])));
      out.push(
        assert("★1200 동시 발견이 각자 manifest·훅을 실제로 다시 읽는다(진행 중 공유·누락·빈 결과 통과 금지)", reads === 2400 && results.every(s => s.length === 1 && s[0]?.status === "loaded" && command(s) === "first"), { loaded: results.filter(s => s[0]?.status === "loaded").length, calls: results.length, reads }),
        assert("★실제 readFile 동시수가 16 이하이고 끝나면 열린 읽기가 0이다", peak <= 16 && active === 0, { peak, active, reads }),
      );
      writeFileSync(a.file, JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: "command", command: "changed" }] }] } }));
      const fresh = command(await pluginHookSources([a.root]));
      out.push(assert("★발견 결과를 캐시하지 않는다 — 같은 경로의 다음 호출은 바뀐 파일을 읽는다", fresh === "changed", { command: fresh }));
      const [sa, sb] = await Promise.all([pluginHookSources([a.root]), pluginHookSources([b.root])]);
      out.push(assert("★동시에 읽는 서로 다른 뿌리의 결과가 섞이지 않는다", command(sa) === "changed" && command(sb) === "other-root", [command(sa), command(sb)]));
      const failures = await Promise.all(Array.from({ length: 40 }, () => readPluginText(path.join(root, "missing")).then(() => "unexpected", (e: NodeJS.ErrnoException) => e.code)));
      out.push(assert("★읽기 거절도 슬롯을 돌려준다 — 실제 ENOENT 40건 뒤 정상 파일을 다시 읽는다", failures.every(c => c === "ENOENT") && (await readPluginText(a.file)).includes("changed") && active === 0, { failures, active }));
    } finally {
      fs.readFile = original;
    }
    return out;
  },
};
