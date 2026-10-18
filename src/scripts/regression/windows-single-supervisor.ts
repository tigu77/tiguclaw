/**
 * 회귀: **Windows 감독자는 한 홈에 하나 — 나중에 뜬 쪽이 물러난다** (2026-10-18 리뷰).
 *
 * 사고(코드로 확인): 데몬이 도는 중에 `install` 하면 `Stop-ScheduledTask` 가 작업의 런처만 끝내고 그 런처가 띄운 감독자는 살아남는다.
 *  새 등록의 Enable+Start 가 감독자를 하나 더 띄워 둘이 같은 홈·SQLite 를 다퉜다(새 데몬은 포트를 못 잡아 스로틀 재기동을 반복).
 *  밖에서 먼저 죽이는 길은 비서가 셸로 부를 때 CLI 까지 죽였다(10-18 재검토 P2) — 그래서 판단을 **뜨는 감독자** 쪽에 둔다.
 * 본다: 판정 함수(`winSupervisorIsDuplicate`) — 이 홈만 · 먼저 뜬 쪽이 남는다 · 동시면 PID 작은 쪽 · 질의가 비면 종전처럼 뜬다 ·
 *  그리고 `runSupervise` 가 데몬을 띄우기 **전에** 그 판정을 부른다(순서가 계약).
 * 등급: **동작**(판정) + 배선(순서) — 실제 프로세스 기동은 집 윈도우 샌드박스 몫.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const HOME = "C:\\Users\\u\\.tiguclaw";
const OTHER = "C:\\Users\\u\\tiguclaw-home";
const sup = (home: string): string => `"C:\\node\\node.exe" "C:\\Users\\u\\tiguclaw\\bin\\daemon.mjs" supervise --home "${home}" --runtime built`;

export const check: RegressionCheck = {
  name: "windows-single-supervisor",
  guards: "Windows 에서 데몬이 도는 중 install 하면 감독자가 둘 떠 같은 홈·SQLite 를 다투던 것 — 감독자에 «하나만» 판정이 없었다",
  run: async (): Promise<Assertion[]> => {
    const d = (await import(new URL("../../../bin/daemon.mjs", import.meta.url).href)) as {
      winSupervisorIsDuplicate: (i: { lines: string; home: string; selfPid: number }) => string | null;
    };
    const lines = (rows: Array<[number, number, string]>): string => rows.map(([p, t, c]) => `${p},${t},${c}`).join("\r\n");
    const older = d.winSupervisorIsDuplicate({ lines: lines([[100, 1000, sup(HOME)], [200, 2000, sup(HOME)]]), home: HOME, selfPid: 200 });
    const iAmOldest = d.winSupervisorIsDuplicate({ lines: lines([[100, 1000, sup(HOME)], [200, 2000, sup(HOME)]]), home: HOME, selfPid: 100 });
    const otherHome = d.winSupervisorIsDuplicate({ lines: lines([[100, 1000, sup(OTHER)], [200, 2000, sup(HOME)]]), home: HOME, selfPid: 200 });
    const tie = d.winSupervisorIsDuplicate({ lines: lines([[300, 5000, sup(HOME)], [150, 5000, sup(HOME)]]), home: HOME, selfPid: 300 });
    const tieWinner = d.winSupervisorIsDuplicate({ lines: lines([[300, 5000, sup(HOME)], [150, 5000, sup(HOME)]]), home: HOME, selfPid: 150 });
    const emptyQuery = d.winSupervisorIsDuplicate({ lines: "", home: HOME, selfPid: 200 });
    // 실제 FILETIME 크기(~1.3e17) — 1틱 차이가 Number 로는 사라진다. 먼저 뜬 쪽의 PID 가 더 크게 둬, 정밀도를 잃으면 판정이 뒤집히게 한다.
    const bigOlder = d.winSupervisorIsDuplicate({ lines: ["300,134367607695314890," + sup(HOME), "100,134367607695314891," + sup(HOME)].join("\r\n"), home: HOME, selfPid: 100 });

    const src = readFileSync(new URL("../../../bin/daemon.mjs", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("const runSupervise = (c) => {"), src.indexOf("\n};\n", src.indexOf("const runSupervise = (c) => {")));
    const guardAt = body.indexOf("winSupervisorIsDuplicate(");
    const firstSpawnCall = body.lastIndexOf("spawnOnce();");
    // 동작으로도 — 실제 runSupervise 본문을 OS 경계만 바꿔 돌린다: 먼저 뜬 감독자가 있으면 데몬을 **안** 띄운다 · 없으면 띄운다 · 질의가 멈춰도 띄운다.
    let connHandler: ((s: unknown) => void) | undefined;
    const runSup = (queryOut: string, selfPid: number, lockErr?: string): { spawned: number; logs: string[]; exited: boolean } => {
      let spawned = 0;
      let exited = false;
      const logs: string[] = [];
      const fakeProcess = { platform: "win32", pid: selfPid, env: {}, on: () => {}, exit: () => { exited = true; }, stdout: { write: (l: string) => void logs.push(l) } };
      // 가짜 잠금 — lockErr 이면 그 오류로 실패, 아니면 바로 잡힌다(실제 파이프의 배타성은 샌드박스 실측: 2026-10-18).
      const fakeNet = { createServer: (handler: (s: unknown) => void) => { connHandler = handler; let onErr: (e: { code: string }) => void = () => {}; return { on: (_ev: string, fn: (e: { code: string }) => void) => { onErr = fn; }, listen: (_n: string, cb: () => void) => (lockErr === undefined ? cb() : onErr({ code: lockErr })) }; } };
      const supSrc = src.slice(src.indexOf("const runSupervise = (c) => {"), src.indexOf("\n};\n", src.indexOf("const runSupervise = (c) => {")) + 3);
      const run = new Function("process", "spawn", "mkdirSync", "appendFileSync", "path", "execStrings", "winLaunchEnv", "WIN_SERVICE_ENV_KEYS", "Date", "setTimeout",
        "spawnSync", "winSupervisorQueryArgs", "winSupervisorIsDuplicate", "statSync", "writeFileSync", "net", "winSupervisorPipeName", supSrc + "; return runSupervise;")(
        fakeProcess, () => { spawned += 1; return { pid: 1, kill: () => {}, on: () => {} }; }, () => {}, () => {}, path, () => ["node", "x"], () => ({}), [], Date, () => {},
        () => ({ stdout: queryOut }), () => [], d.winSupervisorIsDuplicate, () => { throw new Error("ENOENT"); }, () => {}, fakeNet, () => "pipe");
      run({ label: "tiguclaw", runtime: "built", repoRoot: "C:\\r", homeRaw: HOME, homeAbs: HOME, logsDir: "C:\\logs" });
      return { spawned, logs, exited };
    };
    const dup = runSup([`100,1000,${sup(HOME)}`, `200,2000,${sup(HOME)}`].join("\r\n"), 200);
    const alone = runSup(`200,2000,${sup(HOME)}`, 200);
    const timedOut = runSup("", 200);
    // 잠금 서버에 붙었다 바로 끊는 클라이언트 — 소켓 오류가 감독자를 죽이지 않게 **처리기를 단다**(재검토 10-18: 없으면 EPIPE 미처리 예외로 종료).
    const sockEvents: string[] = [];
    connHandler?.({ on: (ev: string) => void sockEvents.push(`on:${ev}`), end: () => void sockEvents.push("end"), destroy: () => void sockEvents.push("destroy") });
    const lockHeld = runSup(`200,2000,${sup(HOME)}`, 200, "EADDRINUSE");
    const lockBroken = runSup(`200,2000,${sup(HOME)}`, 200, "EACCES");
    const pipeA = (d as unknown as { winSupervisorPipeName: (h: string) => string }).winSupervisorPipeName;
    return [
      assert("★같은 홈에 먼저 뜬 감독자가 있으면 나는 물러난다(남을 쪽 PID 를 돌려준다)", older === "100", String(older)),
      assert("내가 가장 먼저 떴으면 남는다", iAmOldest === null, String(iAmOldest)),
      assert("다른 홈(다른 인스턴스)의 감독자는 세지 않는다", otherHome === null, String(otherHome)),
      assert("동시에 떴으면 PID 작은 쪽이 남는다 — 둘 다 물러나지 않는다", tie === "150" && tieWinner === null, JSON.stringify({ tie, tieWinner })),
      assert("질의가 비면(실패) 판단하지 않고 종전처럼 뜬다", emptyQuery === null, String(emptyQuery)),
      assert("★runSupervise 가 데몬을 띄우기 전에 판정한다(순서가 계약)", guardAt > 0 && firstSpawnCall > guardAt, JSON.stringify({ guardAt, firstSpawnCall })),
      assert("★실제 본문: 먼저 뜬 감독자가 있으면 데몬을 안 띄우고 그 사실을 남긴다 · 혼자면 띄운다 · 질의가 비면(시한 초과) 띄운다",
        // ★«안 띄운다» 만이 아니라 **끝난다**까지 — 안 끝나면 파이프를 쥔 채 데몬 없는 감독자가 남아 이후 감독자가 전부 물러난다(재검토 10-18).
        dup.spawned === 0 && dup.exited && dup.logs.some((l) => l.includes("pid=100")) && alone.spawned === 1 && !alone.exited && timedOut.spawned === 1,
        JSON.stringify({ dup: dup.spawned, dupExit: dup.exited, alone: alone.spawned, timedOut: timedOut.spawned })),
      assert("★잠금 서버의 연결 소켓에 오류 처리기를 단다 — 붙었다 끊는 클라이언트(EPIPE)가 감독자를 죽이지 않게",
        sockEvents.indexOf("on:error") >= 0 && (sockEvents.indexOf("end") < 0 || sockEvents.indexOf("on:error") < sockEvents.indexOf("end")), sockEvents.join(",")),
      assert("시각은 FILETIME 정밀도로 비교한다(1틱 차이 — Number 로는 사라진다)", bigOlder === "300", String(bigOlder)),
      assert("★배타 잠금(이름 있는 파이프)이 이미 잡혀 있으면 데몬을 안 띄우고 끝난다 · 잠금을 못 만드는 다른 오류면 가용성 우선으로 뜬다",
        lockHeld.spawned === 0 && lockHeld.exited && lockHeld.logs.some((l) => l.includes("lock is held")) && lockBroken.spawned === 1 && lockBroken.logs.some((l) => l.includes("availability first")),
        JSON.stringify({ held: lockHeld.spawned, heldExit: lockHeld.exited, broken: lockBroken.spawned })),
      assert("잠금 이름은 홈마다 하나 — 대소문자·끝 구분자가 달라도 같은 홈이면 같다 · 다른 홈은 다르다",
        pipeA("C:\\Users\\u\\.tiguclaw") === pipeA("c:\\users\\U\\.tiguclaw\\") && pipeA(HOME) !== pipeA(OTHER) && pipeA(HOME).startsWith("\\\\.\\pipe\\"),
        pipeA(HOME)),
    ];
  },
};
