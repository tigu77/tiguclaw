/** spawnFixtureWithin: a child stopped by its time limit has no exit code of its own (Windows taskkill /F closes it with 1). */
import { spawnFixtureWithin } from "./_guard-fixture-process.js";
import { assert, type RegressionCheck } from "./_framework.js";

// Writes both streams, then waits. On stop it exits 1 — what Windows `taskkill /F` gives, so POSIX takes the same order.
const child = "process.stdout.write('progress');process.stderr.write('diagnostic');process.on('SIGTERM',()=>process.exit(1));setInterval(()=>{},1000);";

export const check: RegressionCheck = {
  name: "fixture-timeout-has-no-exit-code",
  guards: "시간 한도로 멈춘 자식이 Windows 에서 taskkill 의 exit 1 로 보고돼 타임아웃과 실패를 가를 수 없던 것 — v4 Windows 회귀의 «status 1, stderr 빈 값» 이 그 모양이었다(원인은 미확정)",
  run: async () => {
    const stopped = await spawnFixtureWithin(5_000, ["-e", child], { env: process.env });
    const failed = await spawnFixtureWithin(30_000, ["-e", "process.stdout.write('progress');process.stderr.write('diagnostic');process.exit(1);"], { env: process.env });
    return [
      assert("시간 한도로 멈춘 자식: code 없음 + timedOut + 그때까지의 stdout·stderr 보존", stopped.code === null && stopped.timedOut && stopped.out === "progress" && stopped.err === "diagnostic", stopped),
      assert("스스로 exit 1 한 자식: code 1 그대로 + timedOut 아님", failed.code === 1 && !failed.timedOut && failed.out === "progress" && failed.err === "diagnostic", failed),
    ];
  },
};
