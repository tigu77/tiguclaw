/**
 * 회귀: **한 기계의 두 인스턴스가 서로를 건드리지 않는다** (2026-10-03).
 *
 * 회사 PC: 운영 홈 `C:\Users\…\.tiguclaw` 옆에 점검용 `…\.tiguclaw-inspection` 을 두자 세 가지가 샜다.
 *  ① 멈출 프로세스를 «명령줄에 홈이 들어 있나» 를 **부분 문자열**로 골라, 운영을 멈추거나 재시작·업데이트하면 점검용
 *    감독자·데몬까지 죽었다(앞부분이 같아서).
 *  ② CLI 가 서비스 라벨을 환경변수에서만 읽어, `--home` 만 주고 설치·재시작하면 기본 라벨 = **운영의 예약작업**을
 *    덮어쓰거나 겨눴다(포트는 홈 `.env` 를 읽는데 라벨만 안 읽었다).
 *  ③ 감독자가 없는데 재시작 요청에 202 «접수» 를 줬다 — 판단은 그 뒤 코어가 해서 «중단» 은 로그에만 남았다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Daemon = {
  cmdlineHasHome: (cmdline: string, home: string) => boolean;
  resolveLabel: (homeAbs: string) => string;
  readHomeEnvValue: (homeAbs: string, key: string) => string | undefined;
  parseDaemonFlags: (args: readonly string[]) => string | undefined;
  winSuperviseArgv: (c: { nodePath: string; repoRoot: string; homeRaw: string; runtime: string }) => string[];
};

export const check: RegressionCheck = {
  name: "instance-isolation",
  guards: "한 기계의 두 인스턴스 — 운영 재시작이 점검용을 죽이고(홈 앞부분 일치) · --home 만 준 설치가 운영 예약작업을 덮어쓰고 · 감독자 없는 재시작이 202 를 주던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const d = (await import(path.join(repo, "bin/daemon.mjs"))) as Daemon;
    const prod = "C:\\Users\\M\\.tiguclaw";
    // 예약작업 감독자 명령줄 · ConvertTo-Csv 가 따옴표를 겹친 모양 · 홈 아래 클론의 데몬 · 슬래시·대소문자가 다른 홈
    const sup = (home: string): string => `"C:\\nodejs\\node.exe" "E:\\r\\bin\\daemon.mjs" "supervise" "--home" "${home}" "--runtime" "built"`;
    const csv = (line: string): string => `"4242","${line.replace(/"/g, '""')}"`;
    const cases = {
      sibling: d.cmdlineHasHome(sup("C:\\Users\\M\\.tiguclaw-inspection"), prod),
      siblingCsv: d.cmdlineHasHome(csv(sup("C:\\Users\\M\\.tiguclaw-inspection")), prod),
      siblingClone: d.cmdlineHasHome("C:\\nodejs\\node.exe C:\\Users\\M\\.tiguclaw-inspection\\app\\dist\\src\\index.js", prod),
      own: d.cmdlineHasHome(sup(prod), prod),
      ownCsv: d.cmdlineHasHome(csv(sup(prod)), prod),
      ownClone: d.cmdlineHasHome("C:\\nodejs\\node.exe C:\\Users\\M\\.tiguclaw\\app\\dist\\src\\index.js", prod),
      ownSlashCase: d.cmdlineHasHome(sup(prod), "c:/users/m/.tiguclaw/"),
      emptyHome: d.cmdlineHasHome(sup(prod), ""),
    };

    // 라벨 — 홈 .env → 환경변수 → 기본값. 셸에 다른 인스턴스의 라벨이 남아 있어도 그 홈 자신의 라벨이 이긴다.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-instance-"));
    const withEnv = path.join(tmp, "with");
    const without = path.join(tmp, "without");
    fs.mkdirSync(withEnv);
    fs.mkdirSync(without);
    fs.writeFileSync(path.join(withEnv, ".env"), 'HTTP_BRIDGE_PORT=7021\nTIGUCLAW_SERVICE_LABEL="com.tiguclaw.inspection"\n');
    // ★CLI 와 데몬이 **같은 값**을 읽는가 — 데몬이 쓰는 process.loadEnvFile 결과와 CLI 판정을 같은 입력으로 맞대 본다(파서가 둘로 갈리면 깨진다).
    const edgeLines = [
      "TIGUCLAW_SERVICE_LABEL = com.tiguclaw.inspection",
      "export TIGUCLAW_SERVICE_LABEL=com.tiguclaw.inspection",
      "TIGUCLAW_SERVICE_LABEL=com.tiguclaw.daemon\nTIGUCLAW_SERVICE_LABEL=com.tiguclaw.inspection",
      "TIGUCLAW_SERVICE_LABEL=com.tiguclaw.inspection # 점검용",
      'TIGUCLAW_SERVICE_LABEL=" com.tiguclaw.inspection "', // 따옴표 안 공백 — 데몬은 그대로 둔다(CLI 만 자르면 갈린다)
    ];
    const parity = edgeLines.map((line) => {
      const h = path.join(tmp, `edge-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(h);
      fs.writeFileSync(path.join(h, ".env"), line + "\n");
      const savedLabel = process.env.TIGUCLAW_SERVICE_LABEL;
      delete process.env.TIGUCLAW_SERVICE_LABEL;
      let daemonSees: string | undefined;
      try {
        process.loadEnvFile(path.join(h, ".env"));
        daemonSees = process.env.TIGUCLAW_SERVICE_LABEL;
      } finally {
        if (savedLabel === undefined) delete process.env.TIGUCLAW_SERVICE_LABEL;
        else process.env.TIGUCLAW_SERVICE_LABEL = savedLabel;
      }
      return { line, cli: d.readHomeEnvValue(h, "TIGUCLAW_SERVICE_LABEL"), daemon: daemonSees };
    });
    const saved = process.env.TIGUCLAW_SERVICE_LABEL;
    let labels: Record<string, string>;
    try {
      process.env.TIGUCLAW_SERVICE_LABEL = "com.tiguclaw.other";
      labels = { envAndFile: d.resolveLabel(withEnv), envOnly: d.resolveLabel(without) };
      delete process.env.TIGUCLAW_SERVICE_LABEL;
      labels = { ...labels, fileOnly: d.resolveLabel(withEnv), neither: d.resolveLabel(without) };
      // ★실제 설치 문맥이 이 판정을 쓰는가 — `print` 는 등록할 유닛(plist·systemd)을 그대로 보여 준다. 셸에 다른 라벨이 있어도.
      const printed = spawnSync(process.execPath, [path.join(repo, "bin/daemon.mjs"), "print"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, TIGUCLAW_HOME: withEnv, TIGUCLAW_SERVICE_LABEL: "com.tiguclaw.other" },
      });
      labels = { ...labels, printUsesHomeLabel: String(/com\.tiguclaw\.inspection/.test(printed.stdout) && !/com\.tiguclaw\.other/.test(printed.stdout)) };
    } finally {
      if (saved === undefined) delete process.env.TIGUCLAW_SERVICE_LABEL;
      else process.env.TIGUCLAW_SERVICE_LABEL = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // 재시작 경로 — 재기동 수단이 없으면 409 를 주고 이벤트를 던지지 않는다. win32 로 보이게 하면 예약작업 조회가 실패해
    //  감독자 없음으로 판정된다(이 기계엔 schtasks 가 없다). darwin 은 launchd 가 되살리므로 접수한다.
    const routes = await loadPluginModule<{ handleRestart: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-ops.js");
    const drive = async (platform: string): Promise<{ status: number; body: unknown; published: number }> => {
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      let status = 0;
      let body: unknown;
      let published = 0;
      const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = JSON.parse(b); }, setHeader: () => {} };
      Object.defineProperty(process, "platform", { value: platform });
      try {
        await routes.handleRestart({ res, bus: { publish: () => { published += 1; } } });
      } finally {
        Object.defineProperty(process, "platform", real);
      }
      return { status, body, published };
    };
    const noSup = await drive("win32");
    const sup2 = await drive("darwin");

    // ★인자 — `--home=X` 도 받고, 모르는 인자·빈 값은 거절한다(조용히 무시하면 기본 홈 = 첫 인스턴스로 떨어진다, 적대 검토 F4).
    const savedHome = process.env.TIGUCLAW_HOME;
    const savedRuntime = process.env.TIGUCLAW_RUNTIME;
    let flags: Record<string, unknown>;
    try {
      delete process.env.TIGUCLAW_HOME;
      // 예약작업이 실제로 넘기는 꼴 그대로 — 드라이브 문자·백슬래시·공백 든 홈(재검토 F-B).
      const winHome = "C:\\Users\\John Doe\\.tiguclaw-test";
      const argv = d.winSuperviseArgv({ nodePath: "C:\\Program Files\\nodejs\\node.exe", repoRoot: "C:\\r", homeRaw: winHome, runtime: "built" });
      const winErr = d.parseDaemonFlags(argv.slice(3));
      flags = { winErr, winHomeOk: process.env.TIGUCLAW_HOME === winHome, runtime: process.env.TIGUCLAW_RUNTIME };
      delete process.env.TIGUCLAW_HOME;
      // `--home=~/x` 는 셸이 `~` 를 안 펼쳐 유닛에 그대로 박힌다 — 받지 않는다(재검토 F-A).
      flags = { ...flags, eqForm: d.parseDaemonFlags(["--home=~/x"]), eqHome: process.env.TIGUCLAW_HOME };
      delete process.env.TIGUCLAW_HOME;
      flags = {
        ...flags,
        typo: d.parseDaemonFlags(["--hom", "/h/test"]),
        missing: d.parseDaemonFlags(["--home"]),
        swallowed: d.parseDaemonFlags(["--home", "--runtime", "built"]),
        stray: d.parseDaemonFlags(["extra"]),
        homeAfterReject: process.env.TIGUCLAW_HOME,
      };
    } finally {
      if (savedHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = savedHome;
      if (savedRuntime === undefined) delete process.env.TIGUCLAW_RUNTIME;
      else process.env.TIGUCLAW_RUNTIME = savedRuntime;
    }
    // 실제 명령 실행 자리가 거절하는가 — 모르는 인자면 비영으로 끝나고 아무 유닛도 안 찍는다.
    const rejected = spawnSync(process.execPath, [path.join(repo, "bin/daemon.mjs"), "print", "--home=", "x"], { cwd: repo, encoding: "utf8" });

    // 실제 프로세스 선택 자리가 경계 판정을 쓰는가(이 기계엔 PowerShell 이 없어 실행으로는 못 잰다 — 배선만).
    const daemonSrc = fs.readFileSync(path.join(repo, "bin/daemon.mjs"), "utf8");
    const pidsFn = daemonSrc.slice(daemonSrc.indexOf("const winDaemonPids"), daemonSrc.indexOf("const winKillRunning"));
    const wired = /cmdlineHasHome\(l, home\)/.test(pidsFn) && !/\.includes\(home\)/.test(pidsFn);
    return [
      assert(
        "★인자: 예약작업이 넘기는 꼴(공백·백슬래시 든 윈도우 홈)을 그대로 받고 · `--home=X`·오타·빈 값·값 자리에 다른 플래그·떠도는 인자는 거절 · 실제 실행도 비영 종료",
        flags.winErr === undefined && flags.winHomeOk === true && flags.runtime === "built" &&
          typeof flags.eqForm === "string" && flags.eqHome === undefined &&
          typeof flags.typo === "string" && typeof flags.missing === "string" && typeof flags.swallowed === "string" &&
          typeof flags.stray === "string" && flags.homeAfterReject === undefined &&
          rejected.status === 1 && !/<key>Label/.test(rejected.stdout),
        { flags, rejectedStatus: rejected.status, rejectedErr: rejected.stderr.trim() },
      ),
      assert("★홈 .env 를 CLI 와 데몬이 같은 값으로 읽는다 — 띄어쓰기·export·같은 키 두 번·줄 끝 주석", parity.every((p) => p.cli === p.daemon) && parity.slice(0, 4).every((p) => p.cli === "com.tiguclaw.inspection"), parity),
      assert("Windows 프로세스 선택(winDaemonPids)이 경계 판정을 쓴다 — 부분 문자열 비교가 남아 있지 않다", wired, { wired }),
      assert(
        "★다른 홈(앞부분만 같은 이웃)의 감독자·데몬은 이 홈 것이 아니다 — 따옴표 겹친 CSV·홈 아래 클론까지",
        !cases.sibling && !cases.siblingCsv && !cases.siblingClone,
        cases,
      ),
      assert("이 홈의 감독자·홈 아래 클론의 데몬은 이 홈 것이다 — 슬래시·대소문자·끝 구분자가 달라도 · 빈 홈은 아무것도 아니다", cases.own && cases.ownCsv && cases.ownClone && cases.ownSlashCase && !cases.emptyHome, cases),
      assert(
        "★라벨: 홈 .env 가 셸 환경변수를 이긴다 · .env 가 없으면 환경변수 · 둘 다 없으면 기본값",
        labels.envAndFile === "com.tiguclaw.inspection" && labels.printUsesHomeLabel === "true" && labels.fileOnly === "com.tiguclaw.inspection" && labels.envOnly === "com.tiguclaw.other" && labels.neither === "com.tiguclaw.daemon",
        labels,
      ),
      assert(
        "★감독자가 없으면 재시작을 접수하지 않는다(409·no-supervisor · 이벤트 0) · 있으면 접수(202 · 이벤트 1)",
        noSup.status === 409 && (noSup.body as { error?: string })?.error === "no-supervisor" && noSup.published === 0 && sup2.status === 202 && sup2.published === 1,
        { noSup, sup: sup2 },
      ),
    ];
  },
};
