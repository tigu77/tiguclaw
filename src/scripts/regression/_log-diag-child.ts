/**
 * `log-diagnosability` 검사용 자식 프로세스 (2026-08-01).
 *
 * ★왜 자식인가: 이 검사의 핵심은 **순서**다 — `load-env` 는 import 부작용이라
 *  `initFileLogging()` 보다 먼저 돈다. 그 순서를 진짜로 재현하려면 **새 프로세스에서
 *  진입점과 같은 import 순서로** 돌리는 수밖에 없다. 스위트 프로세스는 이미 둘 다
 *  로드된 뒤라 무엇을 해도 그 창을 재현할 수 없다.
 *
 * 진입점(src/index.ts)과 같은 순서: load-env 부작용 → initFileLogging → flush.
 */
import { flushEnvLoadLog } from "../../core/load-env.js";
import { initFileLogging } from "../../core/logging.js";
import { migrateLegacyAgent } from "../../core/paths.js";

const logFile = initFileLogging();
flushEnvLoadLog();

// 정상 상태 경로 — 홈 AGENT.md 가 시드가 아니면 "skip" 을 찍는다(이게 error 면 안 된다).
await migrateLegacyAgent().catch(() => undefined);

// node 프로세스 경고 — 기본 리스너면 stderr 직행 = [error]. 같은 경고를 3번 낸다
// (반복이 접히는지도 함께 본다).
for (let i = 0; i < 3; i += 1) {
  process.emitWarning("합성 경고 — 회귀 검사용", "DeprecationWarning");
}

// 경고는 비동기로 배달된다(process.emitWarning → nextTick). 로그가 파일에 닿을 시간을 준다.
await new Promise((r) => setTimeout(r, 300));
console.log(`LOGFILE=${logFile}`);
process.exit(0);
