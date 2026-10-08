/**
 * 회귀: **Windows stop/restart/update 는 이 인스턴스의 node 프로세스만 강제 종료한다** (2026-10-08 외부 검토 F1).
 *
 * 사고(검토 재현): 종료 대상 = «bridge 포트 리스너 PID» ∪ «명령줄로 찾은 데몬 PID» 였는데,
 *  ① 포트를 `l.includes(":3000")` 로 찾아 `:30000` 리스너도 걸렸고
 *  ② 포트를 잡은 프로세스가 우리 것인지 확인하지 않아, 그 포트를 쓰는 **다른 앱**(실측: Steam 이 3000)을 `taskkill /F /T` 했다.
 * 규칙: 포트는 로컬 주소의 **정확한** 포트 · 리스너는 **이 레포의 데몬 진입점을 실행하는 node** 일 때만 · 명령줄 판정은 이 홈만.
 *
 * 등급: **동작** — 실제 판정 함수에 netstat·프로세스 목록 고정 입력을 넣는다(OS 명령·kill 0).
 */
import { readFileSync } from "node:fs";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = "C:\\Users\\u\\tiguclaw";
const HOME = "C:\\Users\\u\\.tiguclaw";
const NETSTAT = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       111",
  "  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       222",
  "  TCP    [::]:3000              [::]:0                 LISTENING       111",
  "  TCP    127.0.0.1:3000         127.0.0.1:51000        ESTABLISHED     333",
  "  TCP    0.0.0.0:7011           0.0.0.0:0              LISTENING       444",
].join("\r\n");
const csv = (rows: [string, string][]) => ['"ProcessId","CommandLine"', ...rows.map(([p, c]) => `"${p}","${c}"`)].join("\r\n");

export const check: RegressionCheck = {
  name: "windows-stop-owns-its-pids",
  guards: "Windows 데몬 stop 이 포트 부분 문자열(:30000)·소유 미확인으로 다른 앱(Steam 등) 프로세스를 강제 종료하던 것",
  run: async (): Promise<Assertion[]> => {
    const d = (await import(new URL("../../../bin/daemon.mjs", import.meta.url).href)) as {
      parseNetstatListenerPids: (out: string, port: number) => string[];
      selectWinKillTargets: (i: { netstat: string; procsCsv: string; port: number; home: string; repoRoot: string }) => string[];
      winPortDaemonPids: (i: { netstat: string; procsCsv: string; port: number }) => string[];
    };
    // ★플랫폼 stop 의 반환 계약을 **실행**한다(2026-10-08 적대 검토 G — 업데이트 회귀는 가짜 stop 만 써서, 실제 winStop 이
    //  남은 PID 가 있어도 true 를 돌려줘도 초록이었다). 함수 본문을 떼어 OS 경계만 주입한다.
    const src = readFileSync(new URL("../../../bin/daemon.mjs", import.meta.url), "utf8");
    const fnSrc = (name: string): string => src.slice(src.indexOf(`const ${name} = (c) => {`), src.indexOf("\n};\n", src.indexOf(`const ${name} = (c) => {`)) + 3);
    const quiet = { log: () => {}, error: () => {} };
    const proc = { exitCode: 0 };
    const winStopWith = (survived: string[]) =>
      (new Function("winStopTask", "console", "process", `${fnSrc("winStop")}; return winStop;`)(() => survived, quiet, proc) as (c: unknown) => unknown)({ label: "L" });
    const linuxStopWith = (fails: boolean) =>
      (new Function("systemctlUser", "console", "process", `${fnSrc("linuxStop")}; return linuxStop;`)(
        () => { if (fails) throw new Error("fixture: unit busy"); }, quiet, proc,
      ) as (c: unknown) => unknown)({ label: "L" });
    const contract = { winAlive: winStopWith(["123"]), winGone: winStopWith([]), linuxFail: linuxStopWith(true), linuxOk: linuxStopWith(false) };
    // 종료 흐름 — 스캔 결과를 차례로 주고(실제 kill 0) 남은 것을 본다
    const killWith = (scans: { targets: string[]; portDaemons: string[] }[]) => {
      let i = 0;
      const killed: string[] = [];
      const fn = new Function("winScan", "spawnSync", `${fnSrc("winKillRunning")}; return winKillRunning;`)(
        () => scans[Math.min(i++, scans.length - 1)],
        (cmd: string, args: string[]) => { if (cmd === "taskkill") killed.push(args[1] ?? ""); return { status: 0 }; },
      ) as (c: unknown) => string[];
      return { survivors: fn({}), killed, scans: i };
    };
    const flow = {
      // 소유 확인된 데몬 5 — 세 번째 스캔에서 사라진다(늦게 죽음)
      late: killWith([{ targets: ["5"], portDaemons: ["5"] }, { targets: ["5"], portDaemons: ["5"] }, { targets: [], portDaemons: [] }]),
      // 소유 확인 못 한 포트 데몬 111 — 안 죽이되 남았다고 보고
      orphan: killWith([{ targets: [], portDaemons: ["111"] }]),
      // 끝까지 안 죽는다
      stuck: killWith([{ targets: ["5"], portDaemons: [] }]),
    };
    // 소유 확인 못 한 포트 데몬(상대경로로 띄운 `npm start`)은 안 죽이되 «남았다» 로 센다
    const orphan = d.winPortDaemonPids({ netstat: NETSTAT, procsCsv: csv([["111", "node.exe dist/src/index.js"], ["222", "node.exe C:\\apps\\other\\index.js"]]), port: 3000 });
    const ours = `node.exe ${REPO}\\dist\\src\\index.js`;
    const sup = `node.exe ${REPO}\\bin\\daemon.mjs supervise --home ${HOME}`;
    const other = `node.exe C:\\apps\\other\\index.js`;
    const sorted = (a: string[]) => [...a].sort().join(",");
    const exact = d.parseNetstatListenerPids(NETSTAT, 3000);
    // 포트 3000 을 우리 데몬(111)이 잡고 있고, 30000 은 다른 node(222)
    const normal = d.selectWinKillTargets({ netstat: NETSTAT, procsCsv: csv([["111", ours], ["222", other], ["555", sup]]), port: 3000, home: HOME, repoRoot: REPO });
    // 포트 3000 을 다른 앱이 잡았다(node 가 아님 — 프로세스 목록에 없다) · 우리 데몬은 없음
    const steam = d.selectWinKillTargets({ netstat: NETSTAT, procsCsv: csv([["555", sup]]), port: 3000, home: HOME, repoRoot: REPO });
    // 포트 3000 을 다른 레포의 node index.js 가 잡았다
    const foreignNode = d.selectWinKillTargets({ netstat: NETSTAT, procsCsv: csv([["111", other]]), port: 3000, home: HOME, repoRoot: REPO });
    // 다른 홈의 감독자(같은 기계 두 인스턴스) — 앞부분이 같은 홈 이름
    const otherHome = d.selectWinKillTargets({ netstat: "", procsCsv: csv([["666", `node.exe ${REPO}\\bin\\daemon.mjs supervise --home ${HOME}-inspection`]]), port: 3000, home: HOME, repoRoot: REPO });
    return [
      assert("★포트는 정확히 — :3000 은 30000·7011·ESTABLISHED 를 안 잡는다", sorted(exact) === "111", sorted(exact)),
      assert("이 인스턴스의 데몬(포트) + 감독자(명령줄의 홈)는 종료 대상", sorted(normal) === "111,555", sorted(normal)),
      assert("★포트를 잡은 것이 node 가 아니면(Steam 등) 죽이지 않는다", sorted(steam) === "555", sorted(steam)),
      assert("★포트를 잡은 node 라도 이 레포의 데몬이 아니면 죽이지 않는다", foreignNode.length === 0, sorted(foreignNode)),
      assert("다른 홈의 감독자는 건드리지 않는다(홈 경계)", otherHome.length === 0, sorted(otherHome)),
      assert(
        "★stop 은 멈췄는지를 돌려준다 — Windows 남은 PID 있으면 false · 없으면 true · linux systemctl 실패면 false",
        contract.winAlive === false && contract.winGone === true && contract.linuxFail === false && contract.linuxOk === true,
        contract,
      ),
      assert(
        "★종료 흐름: 늦게 죽는 데몬은 다시 세는 동안 사라지면 성공 · 소유 불명 포트 데몬은 안 죽이되 남았다고 보고 · 끝까지 남으면 실패",
        flow.late.survivors.length === 0 && flow.late.killed.join() === "5" && flow.late.scans >= 3 &&
          flow.orphan.survivors.join() === "111" && flow.orphan.killed.length === 0 &&
          flow.stuck.survivors.join() === "5",
        flow,
      ),
      assert("★소유를 확인 못 한 포트의 node 데몬(상대경로 `npm start`)도 «남았다» 로 센다 — 거짓 «✅ stopped» 금지", sorted(orphan) === "111", sorted(orphan)),
    ];
  },
};
