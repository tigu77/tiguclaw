/**
 * dashboard service plugin — `service` capability (4번째 lifecycle, trigger/observer 미러).
 *
 * 책임: packages/dashboard 외부 프로세스의 *기동·정리만* 담당. 대시보드 UI/proxy 로직은
 *   packages/dashboard 가 그대로 소유(외부 프로세스, http-bridge endpoint 로만 통신).
 *   경계: 대시보드 UI = packages/dashboard / 자동 시작 책임 = 본 plugin / 데몬 코어 =
 *   service lifecycle(startService/stop) 호출만 (architect 2026-06-11 service-capability).
 *
 * lifecycle:
 *  - startService(bus) — 중복 기동 방지: 대시보드 포트에 HTTP GET 으로 살아있으면 spawn skip
 *    (orphan 재사용·EADDRINUSE 크래시 회피). 없으면 child process 로 packages/dashboard 기동.
 *  - stop() — child SIGTERM kill (데몬 종료 시 src/index.ts shutdown 이 호출).
 *
 * 실행 분기(dev): packages/dashboard/index.ts 를 레포 node_modules 의 tsx CLI 로 실행.
 *   prod(컴파일 dist 미포함·tsx 부재)는 graceful skip + 안내 로그 — 후속 분리(사용자 합의).
 *
 * 포트: DASHBOARD_PORT(기본 3101)·HTTP_BRIDGE_PORT 는 child 가 env 에서 직접 읽음(상속).
 *   HTTP_BRIDGE_TOKEN 부재 시 child 가 즉시 exit(1) → 미리 감지해 안내 후 skip.
 *
 * 격리: spawn/health-check 실패가 데몬 부팅을 죽이지 않음(loader 가 try/catch + plugin.error).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { appRoot } from "../../src/core/paths.js";
import type { EventBus } from "../../src/core/eventbus.js";

const DEFAULT_DASHBOARD_PORT = "3101";
const HEALTH_TIMEOUT_MS = 800;

class DashboardService {
  readonly name = "dashboard";

  private child: ChildProcess | null = null;
  private stopping = false;

  /** service capability — loader 가 startService(bus) 호출. */
  async startService(bus: EventBus): Promise<void> {
    const port = process.env.DASHBOARD_PORT?.trim() || DEFAULT_DASHBOARD_PORT;

    // 중복 기동 방지 — 이미 무언가 포트를 점유 중이면(우리 대시보드 orphan 포함) skip.
    if (await isPortAlive(port)) {
      console.log(
        `dashboard: already up on http://127.0.0.1:${port} — spawn skipped`,
      );
      return;
    }

    // bridge token 부재 — child 가 어차피 exit(1). 미리 안내하고 spawn 안 함(소음 회피).
    const token = process.env.HTTP_BRIDGE_TOKEN?.trim();
    if (token === undefined || token === "") {
      console.warn(
        "dashboard: HTTP_BRIDGE_TOKEN not set — dashboard requires it (same as daemon). spawn skipped",
      );
      return;
    }

    const root = appRoot();
    const sourceEntry = path.join(root, "packages", "dashboard", "index.ts");
    const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

    if (!existsSync(sourceEntry) || !existsSync(tsxCli)) {
      // prod(소스·tsx 미포함) — graceful skip. 후속 prod 분리(사용자 합의).
      console.warn(
        `dashboard: source or tsx runner not found (looked at ${sourceEntry}). ` +
          "skipping auto-start — launch dashboard separately in prod.",
      );
      return;
    }

    // child 는 부모(데몬) env 를 그대로 상속 — DASHBOARD_PORT/HTTP_BRIDGE_PORT/TOKEN 전파.
    // DASHBOARD_PORT 미설정 시에만 기본 3101 주입(설정돼 있으면 .env 값 존중).
    const childEnv = { ...process.env };
    if (childEnv.DASHBOARD_PORT === undefined || childEnv.DASHBOARD_PORT.trim() === "") {
      childEnv.DASHBOARD_PORT = DEFAULT_DASHBOARD_PORT;
    }

    const child = spawn(process.execPath, [tsxCli, sourceEntry], {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    pipePrefixed(child, "dashboard");

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      // stop() 가 의도적으로 죽인 경우는 조용히. 그 외 비정상 종료만 로그.
      if (!this.stopping) {
        console.warn(
          `dashboard: child exited (code=${code ?? "?"} signal=${signal ?? "?"})`,
        );
        try {
          bus.publish({
            type: "plugin.error",
            ts: Date.now(),
            payload: {
              pluginName: "dashboard",
              phase: "runtime",
              error: `child exited code=${code ?? "?"} signal=${signal ?? "?"}`,
            },
          });
        } catch {
          /* bus throw — ignore */
        }
      }
    });
    child.on("error", (err) => {
      console.error(`dashboard: spawn error: ${err.message}`);
    });

    console.log(
      `dashboard: spawned on http://127.0.0.1:${childEnv.DASHBOARD_PORT} (pid ${child.pid})`,
    );
  }

  /** 데몬 종료 시 src/index.ts shutdown 이 호출 — child 정리. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* 이미 죽었을 수 있음 — 무시 */
    }
  }
}

/** 포트에 HTTP 응답이 있으면 true(점유 중). 연결 거부면 false. */
const isPortAlive = async (port: string): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return true; // 어떤 HTTP status 든 응답 = 리스너 존재.
  } catch {
    return false; // ECONNREFUSED / timeout = 비어있음.
  }
};

/** child stdout/stderr 를 줄 단위로 `[prefix]` 붙여 데몬 콘솔로 포워드. */
const pipePrefixed = (child: ChildProcess, prefix: string): void => {
  const forward =
    (sink: (s: string) => void) =>
    (buf: Buffer): void => {
      const text = buf.toString("utf8").replace(/\n$/, "");
      for (const line of text.split("\n")) sink(`[${prefix}] ${line}`);
    };
  child.stdout?.on("data", forward((s) => console.log(s)));
  child.stderr?.on("data", forward((s) => console.error(s)));
};

export default DashboardService;
