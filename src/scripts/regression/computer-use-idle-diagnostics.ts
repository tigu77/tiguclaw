/** 회귀: 유휴 실패가 null로 줄어들면서 원인까지 사라지던 경로. 실제 입력 없이 실행 경계부터 호스트 로그까지 확인한다. */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "computer-use-idle-diagnostics",
  guards: "유휴 조회 실패의 분류·종료 정보 소실, 원문 비밀 유출, 로그 장애로 인한 입력 보호 변화",
  run: async (): Promise<Assertion[]> => {
    // 소스와 격리 빌드에서 같은 검사를 실행한다. 대역은 별도 프로세스 안에만 설치한다.
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const helper = fileURLToPath(new URL(`./_computer-use-idle-diagnostics-child.${ext}`, import.meta.url));
    const child = await spawnWithin(30_000, "유휴 실패 진단 배선", [...(ext === "ts" ? ["--import", "tsx"] : []), helper], { env: { ...process.env } });
    const line = child.out.split("\n").find((s) => s.startsWith("IDLE_DIAGNOSTICS "));
    const out = [assert("격리 자식이 시한 안에 검사 결과를 반환", !child.timedOut && line !== undefined && child.err.trim() === "", { timedOut: child.timedOut, stderr: child.err })];
    if (line !== undefined) out.push(...JSON.parse(line.slice("IDLE_DIAGNOSTICS ".length)) as Assertion[]);
    return out;
  },
};
