/**
 * 회귀: **대시보드 자식이 죽으면 다시 뜨고, 끝내 안 되면 알린다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고: 데몬이 띄운 대시보드 자식 프로세스가 죽으면 «child exited» 로그 한 줄뿐 — 데몬을 재시작할 때까지 화면이 안 열렸고
 * 사용자는 이유를 알 길이 없었다.
 *
 * 재는 것 — 진짜 `DashboardService` 의 자식 기동·감시 경로(`launch`)에 «뜨자마자 죽는» 자식을 준다(엔트리만 바꾼다):
 *  ① 백오프로 다시 띄운다 — 정해진 횟수만큼(크래시 루프를 무한히 돌지 않는다)
 *  ② 그래도 죽으면 `plugin.error`(pluginName=dashboard)로 포기를 알린다 — 한 번만
 *  ③ 포트를 못 연 자식은 다시 띄우지 않고 포트 표식을 실은 채 바로 알린다(기존 port-unavailable 알림 경로)
 *  ④ stop() 이 대기 중인 재시작을 지운다(데몬 종료 뒤 자식이 되살아나지 않는다)
 *
 * 등급: **동작**(진짜 자식 프로세스 · 약 8초).
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

interface Service {
  launch: (bus: unknown, args: string[], env: NodeJS.ProcessEnv, root: string) => void;
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 실행될 때마다 파일에 한 줄 남기고 곧바로 죽는 자식. */
const crasher = (log: string, stderrLine = ""): string[] => [
  "-e",
  `require("fs").appendFileSync(${JSON.stringify(log)}, "x\\n");` +
    (stderrLine === "" ? "" : `process.stderr.write(${JSON.stringify(stderrLine + "\n")});`) +
    "process.exit(3);",
];
const runs = (log: string): number => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

export const check: RegressionCheck = {
  name: "dashboard-child-restarts",
  guards: "대시보드 자식 프로세스가 죽으면 로그 한 줄뿐 다시 뜨지도 알리지도 않아, 데몬을 재시작할 때까지 화면이 조용히 안 열리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const Dashboard = (await loadPluginModule<{ default: new () => Service }>("../../../plugins/dashboard/index.ts")).default;
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-dash-restart-"));
    const events: Array<{ type: string; error: string }> = [];
    const bus = {
      publish: (e: { type: string; payload?: { pluginName?: string; error?: string } }) => {
        if (e.type === "plugin.error" && e.payload?.pluginName === "dashboard") events.push({ type: e.type, error: String(e.payload.error) });
      },
    };
    try {
      // ── ①② 크래시 루프 → 정해진 횟수 재시작 후 포기 알림 ─────────────────
      {
        const log = path.join(dir, "loop.log");
        const svc = new Dashboard();
        svc.launch(bus, crasher(log), process.env, dir);
        // 1+2+4초 백오프 + 자식 4개 기동 — 부하가 걸린 기계를 감안해 넉넉히 기다린다(오면 즉시 넘어간다)
        for (let i = 0; i < 250 && events.length === 0; i++) await sleep(100);
        await sleep(1_500); // 포기 뒤 더 뜨지 않는지
        const n = runs(log);
        out.push(
          assert(
            "★죽은 자식을 다시 띄운다 — 정해진 횟수만큼(무한 루프 아님)",
            n === 4,
            `자식 실행 ${n}회(최초 1 + 재시작)`,
          ),
        );
        out.push(
          assert(
            "★끝내 안 되면 plugin.error 로 포기를 한 번 알린다",
            events.length === 1 && events[0]!.error.includes("gave up"),
            `plugin.error ${events.length}건 ${JSON.stringify(events.map((e) => e.error.slice(0, 100)))}`,
          ),
        );
        await svc.stop();
      }

      // ── ③ 포트를 못 연 자식은 재시작 없이 바로(표식 그대로) ───────────────
      {
        events.length = 0;
        const log = path.join(dir, "port.log");
        const svc = new Dashboard();
        svc.launch(bus, crasher(log, "[port-unavailable:EADDRINUSE] DASHBOARD_PORT=1 is already in use"), process.env, dir);
        for (let i = 0; i < 100 && events.length === 0; i++) await sleep(100);
        await sleep(1_500);
        out.push(
          assert(
            "포트를 못 연 자식은 다시 띄우지 않고 포트 표식을 실어 바로 알린다",
            runs(log) === 1 && events.length === 1 && events[0]!.error.includes("[port-unavailable:EADDRINUSE]"),
            `자식 실행 ${runs(log)}회 · plugin.error ${JSON.stringify(events.map((e) => e.error.slice(0, 80)))}`,
          ),
        );
        await svc.stop();
      }

      // ── ④ stop() 이 대기 중인 재시작을 지운다 ──────────────────────────────
      {
        const log = path.join(dir, "stop.log");
        const svc = new Dashboard();
        svc.launch(bus, crasher(log), process.env, dir);
        // 첫 자식이 실행되고 **죽어서** 재시작이 예약된 상태까지 기다린다(시간이 아니라 상태로 — 부하에 안 흔들리게)
        for (let i = 0; i < 100 && runs(log) === 0; i++) await sleep(50);
        for (let i = 0; i < 100 && (svc as unknown as { restartTimer: unknown }).restartTimer === null; i++) await sleep(20);
        await svc.stop();
        await sleep(1_500);
        out.push(
          assert(
            "stop() 뒤엔 예약된 재시작이 돌지 않는다",
            runs(log) === 1,
            `자식 실행 ${runs(log)}회`,
          ),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return out;
  },
};
