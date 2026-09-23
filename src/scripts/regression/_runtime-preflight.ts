/** Fail before suite discovery when Windows Node cannot copy Unicode paths.
 * Node 24.12.0 terminates natively in cpSync (0xC0000409); JS catch cannot help.
 * Probe the actual executable in a disposable child, not a guessed version range.
 * Upstream fix: nodejs/node#61950 (included in Node 24.15.0).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function assertRegressionRuntime(): void {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-runtime-probe-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
      import path from 'node:path';
      const root = process.argv[1];
      const src = path.join(root, 'source');
      const dest = path.join(root, '한글 대상');
      mkdirSync(src);
      writeFileSync(path.join(src, 'probe.txt'), 'runtime-probe');
      cpSync(src, dest, { recursive: true });
      if (readFileSync(path.join(dest, 'probe.txt'), 'utf8') !== 'runtime-probe') process.exit(2);
    `, root], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.status !== 0 || result.error) {
      throw new Error(
        `Windows Node ${process.version} runtime preflight failed: Unicode cpSync child ` +
        `exit=${String(result.status)}, signal=${String(result.signal)}, error=${result.error?.message ?? "none"}. ` +
        "No regression checks ran. Use a Node runtime containing nodejs/node#61950 " +
        "(verified: Node 24.15.0); do not skip the Unicode check. " +
        (result.stderr?.trim() ?? ""),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
