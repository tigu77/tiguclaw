/**
 * 회귀: **크래시 원인이 로그 파일에 착지한다** (2026-07-31 전체검토 P0).
 *
 * 사고: `console.*` 미러는 `createWriteStream` 에 **비동기 큐잉**되는데, crash-fast
 * 핸들러는 한 줄 찍고 곧바로 `process.exit(1)` 한다. 앞선 write 가 하나라도 in-flight 면
 * 큐가 통째로 버려진다 — 실측(실제 `initFileLogging` 재현): **직전 로그 12줄도, 크래시
 * 줄도 전부 유실**. 데몬이 재기동됐는데 `<home>/logs/daemon-<날짜>.log` 에 원인이 없고,
 * `/logs` 도 그 파일만 읽으므로 비서·사용자 모두 이유를 못 본다.
 *
 * macOS 는 launchd stderr 가 동기라 `launchd.err.log` 에 같은 텍스트가 남지만 아무도 그걸
 * 안 본다. **윈도우는 `bin/daemon.mjs` 의 `sh.Run` 에 리디렉션이 아예 없어 어디에도 안
 * 남는다** — 하필 원격 접속이 불가능한 인스턴스다.
 *
 * ★"로그가 1차 진단면" 이라는 이 프로젝트의 전제가, **가장 필요한 순간에만** 깨져 있었다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas, sourceOrder } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "crash-log-lands",
  guards:
    "crash-fast 직전 console.error 가 비동기 큐에 남아 버려져, 재기동된 데몬의 원인이 로그 어디에도 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★동작 — 실제 파일에 동기로 쓰이는지. 임시 홈에서만 돈다(격리).
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = mkdtempSync(path.join(os.tmpdir(), "regr-fatal-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home;
    let landed = false;
    try {
      const { initFileLogging, logFatal } = await import("../../core/logging.js");
      initFileLogging();
      logFatal("REGRESSION_CRASH_MARKER 원인 문자열");
      for (const f of readdirSync(path.join(home, "logs"))) {
        if (readFileSync(path.join(home, "logs", f), "utf8").includes("REGRESSION_CRASH_MARKER")) {
          landed = true;
        }
      }
    } catch {
      /* 착지 실패로 본다 */
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
    out.push(
      assert(
        "★logFatal 이 반환 시점에 파일에 착지한다(동기)",
        landed,
        landed ? "임시 홈 로그에서 마커 발견" : "마커 없음 — 비동기 큐에 남았다",
      ),
    );

    // 동기 write 여야 한다 — 스트림으로 되돌아가면 같은 유실이 재발한다.
    const sync = await sourceHas("../../core/logging.ts", [
      /export const logFatal = \(\.\.\.args: unknown\[\]\): void =>/,
      /appendFileSync\(currentLogPath, line\)/,
      // 소독도 통과시킨다(크래시 줄에도 토큰이 실릴 수 있다).
      /redactSecrets\(format\(\.\.\.args\)\)/,
      // 롤오버를 따라가야 한다 — 고정 경로면 자정 이후 엉뚱한 파일에 쓴다.
      /currentLogPath = logFile;/,
    ]);
    out.push(
      assert(
        "★동기 append + 소독 + 롤오버 추적",
        sync.ok,
        sync.ok ? "4개 확인" : `누락 ${sync.missing.join(" ")}`,
      ),
    );

    // ★배선 — crash-fast 3경로가 실제로 그걸 쓴다. `console.error` 로 되돌아가면 무의미.
    const wired = await sourceHas("../../index.ts", [
      /process\.on\("unhandledRejection", \(reason\) => \{\s*logFatal\(/,
      /process\.on\("uncaughtException", \(err\) => \{\s*logFatal\(/,
      /logFatal\("daemon: graceful shutdown 지연 — force exit"\)/,
    ]);
    out.push(
      assert(
        "★crash-fast·force-exit 3경로가 logFatal 을 쓴다",
        wired.ok,
        wired.ok ? "3경로 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );

    // logFatal 선언이 초기화 함수 **밖**(모듈 레벨)이어야 export 가 성립한다.
    const scoped = await sourceOrder("../../core/logging.ts", [
      /^let currentLogPath: string \| null = null;$/m,
      /^export const logFatal = /m,
      /^export const initFileLogging = /m,
    ]);
    out.push(
      assert(
        "logFatal 이 모듈 레벨에 있다(초기화 함수 안이면 컴파일 자체가 깨진다)",
        scoped.ok,
        scoped.detail,
      ),
    );
    return out;
  },
};
