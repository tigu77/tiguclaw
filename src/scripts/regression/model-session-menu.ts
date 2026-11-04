/** /model 모델 프로파일 메뉴 동작 검사. store/settings 전역은 자식으로 격리한다. */
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "model-session-menu",
  guards: "/model 세션 실효풀·LLM0 선택 · 프로파일/raw 원자 저장·대상 고정 · dashboard/Telegram 공유 경로",
  run: async () => {
    assertIsolated();
    const home = await mkdtemp(path.join(os.tmpdir(), "model-session-menu-"));
    const tmp = path.join(home, "tmp");
    await mkdir(tmp);
    const result = await spawnWithin(60_000, "model menu child", ["--import", "tsx", fileURLToPath(new URL("./_model-session-menu-child.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, TIGUCLAW_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, TIGUCLAW_DISABLE_ENV_FILE: "1" },
    });
    const line = result.out.split("\n").find((s) => s.startsWith("MODEL_MENU_RESULT="));
    // 실패 증거도 보존하며 부모 회귀 러너의 임시 루트 수명에 맡긴다.
    if (line === undefined || result.timedOut) return [assert("model 메뉴 자식 정상 완료", false, `${result.out.slice(-3000)}\n${result.err.slice(-3000)}`)];
    return JSON.parse(line.slice("MODEL_MENU_RESULT=".length)) as Assertion[];
  },
};
