/**
 * `socket-snapshot-on-addrnotavail` 검사용 자식.
 *
 * 기본: 실제 로그 관문(`initFileLogging`)을 켜고 평범한 줄 → `EADDRNOTAVAIL` 줄을 낸다.
 *  왜 자식인가: 관문은 프로세스 전역 `console.*` 패치라 스위트 프로세스에서 켜면 다른 검사의 출력까지 바뀐다.
 *  macOS 에선 실제 netstat/lsof 를 각 1회 무해 조회한다(시험 전용 우회 스위치를 제품에 두지 않는다).
 * `--exit-during-run`: 실제 러너로 끝나지 않는 손자를 띄운 채 곧바로 종료한다 — 손자가 남는지 부모가 본다.
 */
import { readFileSync } from "node:fs";

if (process.argv.includes("--exit-during-run")) {
  const { runCountingLines } = await import("../../core/net/socket-snapshot.js");
  void runCountingLines(
    process.execPath,
    ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
    (l) => {
      if (/^\d+$/.test(l)) {
        process.stdout.write(`GRANDCHILD=${l}\n`, () => process.exit(0));
      }
    },
    { timeoutMs: 60_000, maxBytes: 1 << 20 },
  );
} else {
  const { initFileLogging } = await import("../../core/logging.js");
  const logFile = initFileLogging();
  const read = (): string => {
    try {
      return logFile === null ? "" : readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  // 평범한 줄(다른 연결 오류 포함)은 수집을 시작하지 않는다.
  console.log("[regression] before-error ordinary line");
  console.error("[regression] fetch failed ← ECONNREFUSED connect ECONNREFUSED");
  await new Promise((r) => setTimeout(r, 500));
  const before = read().split("\n").filter((l) => l.includes("[socket-snapshot]")).length;

  const fake = "[regression] fetch failed ← EADDRNOTAVAIL connect EADDRNOTAVAIL 127.0.0.1:3020 - Local (127.0.0.1:0)";
  // 같은 차례에 여러 줄 — 수집은 하나여야 한다.
  for (let i = 0; i < 5; i += 1) console.error(fake);
  console.log("[regression] after-error-1");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !read().includes("[socket-snapshot]")) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // 수집 뒤에 또 오류가 와도 같은 사건(창 안)이라 다시 수집하지 않는다.
  console.error(fake);
  console.log("[regression] after-error-2");
  await new Promise((r) => setTimeout(r, 1_500));
  console.log(`SNAPS_BEFORE_ERROR=${before}`);
  console.log(`LOGFILE=${logFile}`);
  process.exit(0);
}
