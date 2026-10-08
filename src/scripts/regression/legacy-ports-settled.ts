/**
 * 회귀: **기본 포트를 17010·17011 로 옮겨도 기존 설치는 쓰던 포트를 지키고, 포트를 못 열면 이유와 고칠 길을 말한다** (2026-10-08).
 *
 * 사고(집 윈도우): 윈도우가 6917~7016 을 예약해 대시보드(7010)·브리지(7011)가 `listen EACCES` 로 못 떴다. 데몬은 «ready» 라고
 *  해서 화면이 안 열린다는 것밖에 알 수 없었다. 지키는 것:
 *  ① 기존 설치 고정 — `src/core/legacy-ports.ts` 와 `bin/daemon.mjs` 가 **같은 입력에서 같은 결과**(코드를 나눌 수 없는 두 구현)
 *  ② 포트 실패 안내 — 브리지·대시보드(실제로 띄워서)가 표식이 붙은 한 줄을 남긴다 · 예약 범위 파서
 *  ③ 자기 점검이 그 표식을 사용자 알림으로 바꾼다 · 표식 없는 플러그인 오류는 안 바꾼다
 *
 * 등급: **동작** — 임시 홈·실제 파일·실제 소켓·실제 자식 프로세스.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Settle = (home: string, repoEnv: string, env?: NodeJS.ProcessEnv) => string[];

export const check: RegressionCheck = {
  name: "legacy-ports-settled",
  guards: "기본 포트 이동(7010·7011→17010·17011) 때 기존 설치의 주소가 조용히 바뀌는 것 + 윈도우 예약 범위로 대시보드·브리지가 «ready» 뒤에서 조용히 죽던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const ts = (await import("../../core/legacy-ports.js")).settleLegacyPorts as Settle;
    const mjs = (await import(new URL("../../../bin/daemon.mjs", import.meta.url).href)).settleLegacyPorts as Settle;
    const hint = await import("../../core/port-hint.js");
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-ports-"));
    const out: Assertion[] = [];
    try {
      // ① 같은 시나리오를 두 구현에 — 결과(.env 글·표식·반환)를 대조한다
      type Scenario = { name: string; db: boolean; env?: string; repoEnv?: string; procEnv?: NodeJS.ProcessEnv; marker?: boolean };
      const scenarios: Scenario[] = [
        { name: "새 설치(DB 없음)", db: false, env: "TELEGRAM_BOT_TOKEN=x\n" },
        { name: "기존 설치·포트 없음", db: true, env: "TELEGRAM_BOT_TOKEN=x\n" },
        { name: "기존·대시보드만 지정", db: true, env: "DASHBOARD_PORT=3010\n" },
        { name: "기존·환경변수로 브리지", db: true, env: "A=1", procEnv: { HTTP_BRIDGE_PORT: "9000" } },
        { name: "기존·레포 .env 에 둘 다", db: true, env: "A=1\n", repoEnv: "HTTP_BRIDGE_PORT=1\nDASHBOARD_PORT=2\n" },
        { name: "기존·.env 없음", db: true },
        { name: "이미 표식", db: true, env: "A=1\n", marker: true },
        { name: "CRLF 유지", db: true, env: "A=1\r\nB=2\r\n" },
      ];
      const run = (impl: Settle, s: Scenario, tag: string): { env: string | null; marker: boolean; wrote: string[]; again: string[] } => {
        const home = path.join(root, `${tag}-${scenarios.indexOf(s)}`);
        mkdirSync(path.join(home, "data"), { recursive: true });
        if (s.db) writeFileSync(path.join(home, "data", "tiguclaw.db"), "");
        if (s.marker) writeFileSync(path.join(home, "data", "ports-settled"), "x");
        if (s.env !== undefined) writeFileSync(path.join(home, ".env"), s.env);
        const repoEnv = path.join(home, "repo.env");
        if (s.repoEnv !== undefined) writeFileSync(repoEnv, s.repoEnv);
        const wrote = impl(home, repoEnv, { ...(s.procEnv ?? {}) });
        const again = impl(home, repoEnv, { ...(s.procEnv ?? {}) });
        const envPath = path.join(home, ".env");
        return { env: existsSync(envPath) ? readFileSync(envPath, "utf8") : null, marker: existsSync(path.join(home, "data", "ports-settled")), wrote, again };
      };
      const results = scenarios.map((s) => ({ s, a: run(ts, s, "ts"), b: run(mjs, s, "mjs") }));
      const same = results.filter((r) => JSON.stringify(r.a) !== JSON.stringify(r.b)).map((r) => r.s.name);
      out.push(assert("★두 구현(데몬 본체·관리 스크립트)이 같은 입력에서 같은 결과", same.length === 0, { differs: same }));
      const byName = (n: string) => results.find((r) => r.s.name === n)!.a;
      out.push(
        assert(
          "★기존 설치는 정해지지 않은 포트만 옛 값으로 고정 · 새 설치·이미 정해진 곳은 손대지 않음 · 한 번만(두 번째 호출은 무변경) · CRLF 유지",
          byName("새 설치(DB 없음)").wrote.length === 0 && byName("새 설치(DB 없음)").marker &&
            byName("기존 설치·포트 없음").wrote.join() === "HTTP_BRIDGE_PORT,DASHBOARD_PORT" &&
            /^HTTP_BRIDGE_PORT=7011$/m.test(byName("기존 설치·포트 없음").env ?? "") && /^DASHBOARD_PORT=7010$/m.test(byName("기존 설치·포트 없음").env ?? "") &&
            byName("기존·대시보드만 지정").wrote.join() === "HTTP_BRIDGE_PORT" &&
            byName("기존·환경변수로 브리지").wrote.join() === "DASHBOARD_PORT" &&
            byName("기존·레포 .env 에 둘 다").wrote.length === 0 &&
            byName("기존·.env 없음").wrote.length === 2 &&
            byName("이미 표식").wrote.length === 0 &&
            results.every((r) => r.a.again.length === 0) &&
            /A=1\r\nB=2\r\n# The default ports[^\n]*\r\n/.test(byName("CRLF 유지").env ?? ""),
          results.map((r) => ({ n: r.s.name, wrote: r.a.wrote, env: r.a.env })),
        ),
      );

      // ① 배선 — 포트를 읽기 **전에** 부른다(데몬 본체: .env 로드 전 · 관리 스크립트: 컨텍스트를 만들며 포트를 읽기 전)
      const { sourceOrder } = await import("./_wiring.js");
      const loadOrder = await sourceOrder("../../core/load-env.ts", [/settleLegacyPorts\(path\.dirname\(homeEnv\), repoEnv\)/, /const home_ok = tryLoad\(homeEnv\)/]);
      const cliOrder = await sourceOrder("../../../bin/daemon.mjs", [
        /const homeAbs = path\.resolve\(repoRoot, expandHome\(homeRaw\)\);\s*\/\/[^\n]*\n\s*settleLegacyPorts\(homeAbs, path\.join\(repoRoot, "\.env"\)\);/,
        /const winPort = \(c\) =>/,
      ]);
      out.push(assert("★고정은 포트를 읽기 전에 — 데몬 본체(.env 로드 전)·관리 스크립트(buildCtx)", loadOrder.ok && cliOrder.ok, { loadOrder, cliOrder }));

      // ② 포트 실패 안내 — 순수 함수
      const eacces = hint.portListenFailure(Object.assign(new Error("x"), { code: "EACCES" }), "DASHBOARD_PORT", 7010) ?? "";
      const inuse = hint.portListenFailure(Object.assign(new Error("x"), { code: "EADDRINUSE" }), "HTTP_BRIDGE_PORT", 7011) ?? "";
      const other = hint.portListenFailure(Object.assign(new Error("x"), { code: "ENOENT" }), "DASHBOARD_PORT", 7010);
      const parsed = hint.parsePortUnavailable(eacces);
      const netsh = "\n프로토콜 tcp 포트 제외 범위\n\n시작 포트    끝 포트\n----------    --------\n      2752        2851\n      6917        7016\n     50000       50059     *\n\n* - 관리 포트 제외입니다.\n";
      const ranges = hint.parseExcludedPortRanges(netsh);
      out.push(
        assert(
          "안내: EACCES 는 윈도우 예약 범위·고칠 키 · EADDRINUSE 는 다른 프로그램 · 그 밖은 원래 오류 · 표식을 다시 읽는다 · netsh(한국어) 범위 파싱",
          eacces.includes("excludedportrange") && eacces.includes("DASHBOARD_PORT") && inuse.includes("in use") && other === undefined &&
            parsed?.code === "EACCES" && parsed.key === "DASHBOARD_PORT" && parsed.port === "7010" &&
            JSON.stringify(ranges) === "[[2752,2851],[6917,7016],[50000,50059]]" &&
            hint.excludedRangeOf(7010, ranges)?.[0] === 6917 && hint.excludedRangeOf(17010, ranges) === undefined,
          { eacces, inuse, parsed, ranges },
        ),
      );

      // ② 실제로 막힌 포트 — 브리지는 표식이 붙은 오류로 실패, 대시보드 자식은 표식 줄을 남기고 끝난다
      const blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
      const busy = (blocker.address() as net.AddressInfo).port;
      const prevBridge = process.env.HTTP_BRIDGE_PORT;
      let bridgeErr = "";
      process.env.HTTP_BRIDGE_PORT = String(busy);
      try {
        const { default: HttpBridge } = await import(new URL("../../../plugins/http-bridge/index.ts", import.meta.url).href);
        const { getEventBus } = await import("../../core/eventbus.js");
        const bridge = new HttpBridge();
        try {
          await bridge.startObserver(getEventBus());
        } catch (e) {
          bridgeErr = e instanceof Error ? e.message : String(e);
        }
        await bridge.stop?.().catch?.(() => {});
      } finally {
        if (prevBridge === undefined) delete process.env.HTTP_BRIDGE_PORT;
        else process.env.HTTP_BRIDGE_PORT = prevBridge;
      }
      const dash = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "packages/dashboard/index.ts")], {
          cwd: REPO,
          env: { ...process.env, DASHBOARD_PORT: String(busy), DASHBOARD_HOST: "127.0.0.1", HTTP_BRIDGE_TOKEN: "regr", HTTP_BRIDGE_PORT: "1" },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.on("exit", (code) => {
          clearTimeout(t);
          resolve({ code, stderr });
        });
      });
      blocker.close();
      out.push(
        assert(
          "★막힌 포트: 브리지는 표식(EADDRINUSE·HTTP_BRIDGE_PORT)이 붙은 오류로 실패 · 대시보드 자식은 표식 줄을 남기고 종료 코드 1",
          hint.parsePortUnavailable(bridgeErr)?.key === "HTTP_BRIDGE_PORT" &&
            dash.code === 1 && hint.parsePortUnavailable(dash.stderr)?.key === "DASHBOARD_PORT",
          { bridgeErr, dashCode: dash.code, dashStderr: dash.stderr.slice(-400) },
        ),
      );

      // ③ 자기 점검 — 표식 있는 플러그인 오류만 사용자 알림으로
      const { initStore } = await import("../../store/sessions.js");
      const { insertEvent } = await import("../../store/events.js");
      const { runHealthSweep } = await import("../../core/health-sweep.js");
      initStore();
      const since = Date.now() - 1;
      insertEvent(Date.now(), "plugin.error", JSON.stringify({ pluginName: "dashboard", phase: "runtime", error: eacces }));
      insertEvent(Date.now(), "plugin.error", JSON.stringify({ pluginName: "x", phase: "start", error: "something else broke" }));
      const findings = runHealthSweep(since).filter((f) => f.kind === "port_unavailable");
      out.push(
        assert(
          "★자기 점검: 포트 표식이 붙은 오류만 «포트를 못 열었다» 알림으로(키·포트가 문장에) · 다른 플러그인 오류는 아님",
          findings.length === 1 && findings[0]!.summary.includes("DASHBOARD_PORT") && findings[0]!.summary.includes("7010"),
          findings,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return out;
  },
};
