import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { assert, assertIsolated, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "bridge-stop-active-request",
  guards: "브리지 stop이 진행 HTTP 요청을 기다려 SIGINT/SIGTERM 종료의 후속 정리를 막던 결함",
  run: async () => {
    assertIsolated();
    const out = [];
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./_bridge-stop-child.ts", import.meta.url)), signal], { env: process.env, encoding: "utf8", timeout: 15000 });
      const line = r.stdout.split("\n").find(s => s.startsWith("BRIDGE_STOP_RESULT="));
      const got = line ? JSON.parse(line.slice("BRIDGE_STOP_RESULT=".length)) : { error: r.stderr, status: r.status };
      out.push(assert(`${signal}: 정상 대기는 유지하고 종료 때 연결·상태 정리`, r.status === 0 && got.remainedOpenBeforeStop && got.clientClosed && got.cleared, got));
      out.push(assert(`${signal}: 후속 정리 도달·신규 접속 거절·중복 종료 완료`, r.status === 0 && got.refused && got.accepted === 1 && JSON.stringify(got.events) === JSON.stringify([signal, "unsubscribe", "next-service-stop"]), got));
    }
    const daemon = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    out.push(assert("실제 데몬은 채널 종료 후 서비스 종료를 기다림", /for \(const ch of channels\)[\s\S]*?await ch.stop\(\)[\s\S]*?for \(const svc of serviceStops\)[\s\S]*?await svc.stop\(\)/.test(daemon), daemon.match(/for \(const ch of channels\)[\s\S]*?await svc.stop\(\);/)?.[0]));
    return out;
  },
};
