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
 * 실행 분기(2026-07-14): built(.js) 우선 → source(.ts+tsx). loader 의 .ts→.js 폴백과 결.
 *   - built: appRoot()=dist → dist/packages/dashboard/index.js 를 node 로 직접 스폰(tsx 미경유).
 *   - source(dev): packages/dashboard/index.ts 를 레포 node_modules 의 tsx CLI 로 실행(불변).
 *   둘 다 부재 시에만 graceful skip + 안내 로그. (이전엔 built 에서 소스·tsx 부재로 항상 skip →
 *   신규 설치자가 대시보드를 못 썼다. build:prod 가 dist/packages/dashboard 로 컴파일+정적복사.)
 *
 * 포트: DASHBOARD_PORT(기본 7010)·HTTP_BRIDGE_PORT 는 child 가 env 에서 직접 읽음(상속).
 *   HTTP_BRIDGE_TOKEN 부재 시 child 가 즉시 exit(1) → 미리 감지해 안내 후 skip.
 *
 * 격리: spawn/health-check 실패가 데몬 부팅을 죽이지 않음(loader 가 try/catch + plugin.error).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { appRoot } from "../../src/core/paths.js";
import { probeLocalPort } from "../../src/core/local-port-probe.js";
import type { EventBus } from "../../src/core/eventbus.js";

const DEFAULT_DASHBOARD_PORT = "7010";
const HEALTH_TIMEOUT_MS = 800;

/**
 * 우리 대시보드임을 식별하는 마커 — 서빙되는 `index.html` 의 `<title>`.
 *
 * ★왜 `/api/health` 가 아닌가: 그건 **bridge 로 프록시**된다. 브리지가 죽어 있으면 우리
 *  대시보드가 멀쩡히 떠 있어도 실패해서 "남의 것" 으로 오판한다. 대시보드 **자신이** 답하는
 *  것으로 판정해야 한다.
 * ★왜 전용 endpoint 를 안 만드는가: 이 판정이 필요한 주된 상대가 **구버전 orphan**(데몬이
 *  죽으며 남긴 자식)이라, 새 endpoint 는 그쪽에 없다. 이 마커는 대시보드 외부화(2026-05-15)
 *  이래 안 바뀌었다 — 어느 세대의 orphan 이든 식별된다.
 * ★마커가 바뀌면 조용히 오판하므로 회귀(`dashboard-port-identity`)가 `index.html` 과 대조한다.
 */
const DASHBOARD_MARKER = "티구클로 대시보드";

class DashboardService {
  readonly name = "dashboard";

  private child: ChildProcess | null = null;
  private stopping = false;

  /** service capability — loader 가 startService(bus) 호출. */
  async startService(bus: EventBus): Promise<void> {
    const port = process.env.DASHBOARD_PORT?.trim() || DEFAULT_DASHBOARD_PORT;

    // 중복 기동 방지 — 이미 무언가 포트를 점유 중이면(우리 대시보드 orphan 포함) skip.
    // ★포트 점유 판정은 **세 갈래**다. 종전엔 "누가 듣고 있으면 우리겠지" 로 뭉뚱그려,
    //  다른 앱(3000 은 Next.js·Rails 의 기본값이다)이 물고 있으면 **대시보드가 안 뜬 채
    //  로그는 "already up" 이라 말했다**. 사용자는 대시보드 대신 남의 앱을 보게 된다.
    const state = await probeLocalPort(port, DASHBOARD_MARKER, HEALTH_TIMEOUT_MS);
    if (state === "ours") {
      console.log(`dashboard: already up on http://127.0.0.1:${port} — spawn skipped`);
      return;
    }
    if (state === "foreign") {
      console.warn(
        `dashboard: port ${port} is held by another app (GET / has no tiguclaw marker) — ` +
          `spawn skipped. Set DASHBOARD_PORT in .env to a free port, or stop that app. ` +
          `Check with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
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

    // 엔트리 해석 — built(.js) 우선 → 없으면 source(.ts + tsx). loader 의 .ts→.js 폴백과 결.
    //  - built: appRoot()=dist → dist/packages/dashboard/index.js 를 node 로 직접 스폰(tsx 미경유).
    //    정적파일(index.html 등)은 그 __dirname 옆(copy-dist-assets 가 복사)에서 서빙된다.
    //  - source(dev): packages/dashboard/index.ts 를 레포 node_modules 의 tsx CLI 로 실행(불변).
    // skip 경고는 양쪽 다 없을 때만 — built 는 tsx 형제 부재가 정상이라 예전처럼 오검출하면 안 됨.
    const root = appRoot();
    const builtEntry = path.join(root, "packages", "dashboard", "index.js");
    const sourceEntry = path.join(root, "packages", "dashboard", "index.ts");
    const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

    let spawnArgs: string[];
    if (existsSync(builtEntry)) {
      // built — node 로 컴파일된 .js 직접 실행. tsx 불요.
      spawnArgs = [builtEntry];
    } else if (existsSync(sourceEntry) && existsSync(tsxCli)) {
      // source(dev) — tsx 로 .ts 실행(현행 동작·바이트 불변).
      spawnArgs = [tsxCli, sourceEntry];
    } else {
      // built .js 도, source .ts(+tsx) 도 없음 — graceful skip.
      console.warn(
        "dashboard: no runnable entry found " +
          `(built ${builtEntry} absent; source ${sourceEntry} + tsx missing). ` +
          "skipping auto-start.",
      );
      return;
    }

    // child 는 부모(데몬) env 를 그대로 상속 — DASHBOARD_PORT/HTTP_BRIDGE_PORT/TOKEN 전파.
    // DASHBOARD_PORT 미설정 시에만 기본 7010 주입(설정돼 있으면 .env 값 존중).
    const childEnv = { ...process.env };
    if (childEnv.DASHBOARD_PORT === undefined || childEnv.DASHBOARD_PORT.trim() === "") {
      childEnv.DASHBOARD_PORT = DEFAULT_DASHBOARD_PORT;
    }
    // ★고아 방지 (2026-07-27) — 자식에게 부모 pid 를 알려준다. stop() 의 SIGTERM 은 데몬이
    //  *정상 종료*할 때만 불린다. SIGKILL·크래시·하드킬이면 stop() 이 안 돌고, 자식은 부모를
    //  잃은 채 계속 살아 포트를 문다(실측: 대시보드 고아 4개가 최장 6일 20시간 생존, ppid=1).
    //  부모 종료를 자식이 스스로 감지해 빠지게 하는 것이 유일하게 확실한 방법 — 부모가 어떻게
    //  죽든 동작한다. 데몬이 띄운 경우에만 설정하므로 수동 실행(npm run dashboard)은 무영향.
    childEnv.TIGUCLAW_PARENT_PID = String(process.pid);

    const child = spawn(process.execPath, spawnArgs, {
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
