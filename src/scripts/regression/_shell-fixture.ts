/** Real shell commands without POSIX-only quoting. Fixtures stay in the test TEMP. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export function nodeCommand(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "shell-fixture-"));
  const file = path.join(dir, "fixture.cjs");
  writeFileSync(file, source, "utf8");
  return process.platform === "win32"
    ? `"${process.execPath}" "${file}"`
    : `'${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}'`;
}
