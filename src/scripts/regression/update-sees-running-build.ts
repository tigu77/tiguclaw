/**
 * 회귀: **«받을 커밋 없음» 을 «최신» 으로 읽지 않는다** — built 의 `/update` 는 돌고 있는 빌드·디스크 dist 의 커밋을 본다 (2026-10-30).
 *
 * 사고(프로젝트돌쇠, 실측): 소스를 `git checkout` 만 하고 빌드·재시작을 안 한 인스턴스에서 `/update` 가 `up-to-date` 로 끝났다.
 *  소스 0.79.0 · dist 10-29 · `/health` 0.78.0 · 로그는 `self-update: ripgrep 확인` 한 줄. 다시 눌러도 같아서 **빠져나올 길이 없었다**
 *  (`/restart` 는 옛 dist 를 다시 싣는다). 판정이 «이 호출 동안 HEAD 가 움직였나» 뿐이었고, «무엇이 돌고 있나» 는 기록하는 곳도
 *  비교하는 곳도 없었다. 설계: docs/decisions/2026-10-30-update-uptodate-running-build.md
 *
 * 무엇을 재나(둘 다 **실행**한다 — 소스 문자열을 세지 않는다):
 *  ① `bin/copy-dist-assets.mjs` 가 빌드를 끝까지 마쳤을 때만 HEAD 를 적고, 지우기 모드·위치 인자·git 실패에서 계약대로 군다.
 *     그 기록을 `self-update.ts` 의 `readBuildCommit` 으로 읽는다 — 두 파일의 이름이 갈리면 여기서 빨개진다.
 *  ② 실제 git 저장소에서 `runSelfUpdate` 를 분기마다(최신 · source · 소스로 돎 · dirty · 설치 실패 · native 실패 · 재빌드 실패 · 성공)
 *     돌린다 — 자식 프로세스에서(성공 경로가 잠금을 쥔 채 끝나고, PATH·env 를 바꾸므로).
 *  ③ (R2) 재시작 감독자가 **측정되지 않으면** 새 갈래는 아무것도 바꾸지 않는다 — 종전 이 입력에선 프로세스가 살아 있었다.
 *     측정 함수(`keepAliveServiceOwnsProcess`)는 launchctl 대역으로 표를 돌리고, 주입 없는 built 배치에서도 거짓(이 자식은 작업이 아니다).
 * 등급: **동작**.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { spawnProbe } from "./_probe-helpers.js";

const REPO = path.resolve(import.meta.dirname, "../../..");

type Row = {
  name: string; status: string; from?: string; to?: string; changedFiles?: number; rolledBack?: boolean; error: string;
  restarted: number; npm: string[]; tsc: string[]; head: string; diskStamp: string | null; oldKept: boolean; newEntry: boolean;
  leftovers: string[]; userEdit: string; marker: Record<string, unknown> | null; noSupervisor: boolean; ripgrep: number;
};

export const check: RegressionCheck = {
  name: "update-sees-running-build",
  guards:
    "HEAD 가 원격과 같으면 돌고 있는 빌드·디스크 dist 가 옛 커밋이어도 /update 가 «이미 최신» 으로 끝나 채팅으로는 빠져나올 길이 없던 것 (등급: 동작)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { readBuildCommit, BUILD_COMMIT_FILE } = await import("../../core/self-update.js");

    // ── ① 기록 스크립트 ────────────────────────────────────────────────────────────
    const tmp = mkdtempSync(path.join(os.tmpdir(), "upd-build-commit-"));
    try {
      const git = (args: string[]): string => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
      git(["init", "-q"]);
      git(["config", "user.email", "r@r.invalid"]);
      git(["config", "user.name", "r"]);
      writeFileSync(path.join(tmp, "x.txt"), "1\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "c"]);
      const head = git(["rev-parse", "HEAD"]).toLowerCase();
      // ★임시 레포 안으로 복사해 돌린다 — repoRoot 를 자기 위치에서 뽑으므로, 진짜 경로로 부르면 실제 dist 를 건드린다.
      mkdirSync(path.join(tmp, "bin"));
      copyFileSync(path.join(REPO, "bin", "copy-dist-assets.mjs"), path.join(tmp, "bin", "copy-dist-assets.mjs"));
      const copy = (args: string[], env?: NodeJS.ProcessEnv): number => {
        try {
          execFileSync(process.execPath, [path.join(tmp, "bin", "copy-dist-assets.mjs"), ...args], { cwd: tmp, stdio: "pipe", env: env ?? process.env });
          return 0;
        } catch (e) {
          return (e as { status?: number }).status ?? 1;
        }
      };
      const dist = path.join(tmp, "dist");
      const stamp = (dir: string): string | null => readBuildCommit(dir);

      const rcNoDist = copy(["--forget-build-commit"]);
      out.push(assert("지우기 모드: dist 가 없어도(첫 빌드) 성공하고 아무것도 만들지 않는다", rcNoDist === 0 && !existsSync(dist), `rc=${rcNoDist} dist=${existsSync(dist)}`));

      mkdirSync(dist);
      writeFileSync(path.join(dist, "asset.txt"), "keep\n");
      writeFileSync(path.join(dist, BUILD_COMMIT_FILE), `${"a".repeat(40)}\n`);
      const rcForget = copy(["--forget-build-commit"]);
      out.push(
        assert(
          "★지우기 모드: 기록만 지우고 다른 파일은 그대로(tsc 가 쓰기 전에 «그 커밋으로 빌드됨» 을 거둔다)",
          rcForget === 0 && !existsSync(path.join(dist, BUILD_COMMIT_FILE)) && readFileSync(path.join(dist, "asset.txt"), "utf8") === "keep\n",
          `rc=${rcForget} 기록=${existsSync(path.join(dist, BUILD_COMMIT_FILE))}`,
        ),
      );

      const rcCopy = copy([]);
      out.push(assert("★복사(무인자)가 끝까지 되면 dist 에 HEAD 를 적고, self-update 가 그 이름·형식으로 읽는다", rcCopy === 0 && stamp(dist) === head, `rc=${rcCopy} 읽음=${stamp(dist)} HEAD=${head}`));

      const staging = path.join(tmp, ".dist-staging-x");
      mkdirSync(staging);
      writeFileSync(path.join(dist, BUILD_COMMIT_FILE), `${"b".repeat(40)}\n`);
      const rcStage = copy([".dist-staging-x"]);
      out.push(
        assert(
          "위치 인자(스테이징): 기록은 그 대상에만 — 활성 dist 의 기록은 건드리지 않는다",
          rcStage === 0 && stamp(staging) === head && stamp(dist) === "b".repeat(40),
          `rc=${rcStage} 스테이징=${stamp(staging)} dist=${stamp(dist)}`,
        ),
      );

      // git 을 못 찾는 환경 — 옛 기록이 남으면 다른 커밋을 거짓으로 말한다.
      const rcNoGit = copy([], { PATH: path.join(tmp, "no-such-bin") });
      out.push(assert("★git 을 못 읽으면 기록이 없다(이전 기록도 남기지 않는다)", rcNoGit === 0 && !existsSync(path.join(dist, BUILD_COMMIT_FILE)), `rc=${rcNoGit} 기록=${existsSync(path.join(dist, BUILD_COMMIT_FILE))}`));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // in-place 빌드는 tsc 가 dist 에 쓰기 **전에** 기록을 거둔다 — tsc 가 JS 를 내고 실패하면 `&&` 가 멈춰 끝의 기록 단계가 안 돈다.
    const bp = (JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["build:prod"] ?? "";
    const seg = bp.split("&&").map((s) => s.trim());
    out.push(
      assert(
        "★build:prod = 기록 지우기 → tsc → 기록 쓰기(복사) 순서",
        seg.length === 3 &&
          /copy-dist-assets\.mjs --forget-build-commit$/.test(seg[0] ?? "") &&
          /^tsc -p tsconfig\.build\.json$/.test(seg[1] ?? "") &&
          /copy-dist-assets\.mjs$/.test(seg[2] ?? ""),
        bp,
      ),
    );

    // ── ③ 감독자 측정(launchctl 대역 표) ──────────────────────────────────────────────
    const { keepAliveServiceOwnsProcess } = await import("../../core/restart.js");
    const LIST = "PID\tStatus\tLabel\n-\t0\tcom.apple.x\n4242\t0\tcom.tiguclaw.devbot\n42\t0\tcom.other\n";
    const job = (pid: string, onDemand: string): string =>
      `{\n\t"Label" = "com.tiguclaw.devbot";\n\t"OnDemand" = ${onDemand};\n\t"PID" = ${pid};\n};\n`;
    type Lc = (args: string[]) => { status: number | null; stdout: string };
    const fake = (list: { status: number | null; stdout: string }, detail: { status: number | null; stdout: string }, seen?: string[][]): Lc =>
      (args) => {
        seen?.push(args);
        return args.length === 1 ? list : detail;
      };
    const seen: string[][] = [];
    const probe = (pid: number, lc: Lc, platform = "darwin"): boolean => keepAliveServiceOwnsProcess({ platform, pid, launchctl: lc });
    const rows: [string, boolean, boolean][] = [
      ["KeepAlive 작업의 그 PID", probe(4242, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("4242", "false") }, seen)), true],
      ["목록에 없는 PID(감독자 없이 띄운 고아 — ppid 1 이어도)", probe(5555, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("5555", "false") })), false],
      ["PID 앞자리만 같은 작업(424 ≠ 4242)", probe(424, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("424", "false") })), false],
      ["KeepAlive 아님(OnDemand = true)", probe(4242, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("4242", "true") })), false],
      ["작업 상세의 PID 가 다르다(그 사이 재기동)", probe(4242, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("4243", "false") })), false],
      ["목록 실패", probe(4242, fake({ status: 1, stdout: LIST }, { status: 0, stdout: job("4242", "false") })), false],
      ["상세 실패·시간 초과(status null)", probe(4242, fake({ status: 0, stdout: LIST }, { status: null, stdout: "" })), false],
      ["launchctl 이 던진다", probe(4242, () => { throw new Error("ENOENT"); }), false],
      ["linux — 측정 수단 없음", probe(4242, fake({ status: 0, stdout: LIST }, { status: 0, stdout: job("4242", "false") }), "linux"), false],
    ];
    const wrong = rows.filter(([, got, want]) => got !== want).map(([n, got]) => `${n}=${got}`);
    out.push(assert("★감독자 측정: KeepAlive 작업의 그 PID 일 때만 참 — 고아·비 KeepAlive·실패·리눅스는 거짓(모르면 죽지 않는다)", wrong.length === 0, wrong.join(" · ") || "9/9"));
    out.push(assert("감독자 측정: 라벨은 목록에서 찾은 그 작업으로 묻는다", JSON.stringify(seen) === JSON.stringify([["list"], ["list", "com.tiguclaw.devbot"]]), JSON.stringify(seen)));

    // ── ② 판정 — 자식에서 ──────────────────────────────────────────────────────────
    if (process.platform === "win32") {
      // Windows built 는 설치 블록 앞에서 CLI 로 위임한다(실제 업데이트를 띄운다) — 이 자식은 POSIX in-process 경로만 잰다.
      out.push(assert("(Windows: 판정 자식은 POSIX in-process 경로 전용 — 건너뜀)", true, "win32"));
      return out;
    }
    const child = spawnProbe(REPO, [path.join(REPO, "src", "scripts", "regression", "_update-sees-running-build-child.ts")], { cwd: REPO, timeout: 120_000 });
    const last = (child.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
    type Boot = { status: string; from?: string; to?: string; restarted: number; npm: string[]; head: string; noSupervisor: boolean };
    type Child = { c0: string; h: string; results: Row[]; b0: string; bh: string; bootStale: Boot; bootUnmeasured: Boot; bootFresh: Boot; bootBlank: Boot };
    let parsed: Child | null = null;
    try {
      parsed = JSON.parse(last) as Child;
    } catch {
      parsed = null;
    }
    out.push(assert("자식이 실제로 돌았다", child.status === 0 && parsed !== null, `status=${child.status} stderr=${(child.stderr ?? "").slice(-300)}`));
    if (parsed === null) return out;
    const { c0, h } = parsed;
    const by = (n: string): Row => parsed!.results.find((r) => r.name === n) as Row;
    const show = (r: Row): string => JSON.stringify({ ...r, marker: r.marker === null ? null : "…" }).slice(0, 400);

    const latest = by("latest");
    out.push(assert("진짜 최신(실행 = 디스크 = HEAD)은 종전대로 no-op — 설치·빌드·재시작 0", latest.status === "up-to-date" && latest.restarted === 0 && latest.npm.length === 0 && latest.tsc.length === 0, show(latest)));
    const src = by("source-runtime");
    out.push(assert("source 런타임은 판정 대상이 아니다(종전 그대로 up-to-date)", src.status === "up-to-date" && src.restarted === 0 && src.npm.length === 0, show(src)));
    const boot = by("boot-from-source");
    out.push(assert("★소스로 도는 프로세스(부팅 기록 없음 = 판정 대상 아님)는 env 가 built 여도 오탐하지 않는다", boot.status === "up-to-date" && boot.restarted === 0 && boot.npm.length === 0, show(boot)));
    const dirty = by("dirty");
    out.push(assert("미커밋 추적 변경은 판정보다 먼저 거절 — 설치·빌드 0, 사용자 편집 보존", dirty.status === "failed" && dirty.error.includes("a.txt") && dirty.npm.length === 0 && dirty.userEdit === "user edit\n", show(dirty)));

    const inst = by("install-fails");
    out.push(
      assert(
        "★실행 빌드가 뒤처지면 «최신» 이 아니다 — 설치로 간다. 설치 실패면 롤백 재설치·재시작 0·HEAD·dist 그대로",
        inst.status === "failed" && inst.npm.length === 2 && inst.restarted === 0 && inst.head === h && inst.diskStamp === h && inst.oldKept && inst.rolledBack === true,
        show(inst),
      ),
    );
    const nat = by("native-fails");
    out.push(
      assert(
        "기록이 없는 실행 빌드도 «최신» 이 아니다 — native 검사·복구 실패면 롤백 재설치·재시작 0",
        nat.status === "failed" && nat.npm.length === 3 && nat.restarted === 0 && nat.diskStamp === h,
        show(nat),
      ),
    );
    const disk = by("disk-stale-rebuild-fails");
    out.push(
      assert(
        "★디스크 dist 기록이 HEAD 와 다르면(없으면) 실행이 HEAD 여도 다시 빌드한다 — 빌드 실패면 활성 dist·기록 무손상·재시작 0·스테이징 정리",
        disk.status === "failed" && disk.tsc.some((a) => a.includes("--outDir")) && disk.restarted === 0 && disk.oldKept && !disk.newEntry && disk.diskStamp === null && disk.leftovers.length === 0,
        show(disk),
      ),
    );
    // ── (R2) 감독자 측정 실패 — 새 갈래는 손대지 않는다 ──
    const untouched = (r: Row, stamp: string | null): boolean =>
      r.status === "failed" && r.noSupervisor && r.restarted === 0 && r.npm.length === 0 && r.tsc.length === 0 &&
      r.head === h && r.diskStamp === stamp && r.oldKept && !r.newEntry && r.leftovers.length === 0 && r.marker === null && r.ripgrep > 0;
    const unRun = by("running-stale-unsupervised");
    out.push(
      assert(
        "★감독자가 측정되지 않으면 실행 빌드가 뒤처져도 설치·재빌드·재시작 0 — 종전처럼 살아 있고 이유·할 일을 알린다(ripgrep 확보는 돈다)",
        untouched(unRun, c0) && unRun.from === c0.slice(0, (unRun.to ?? "").length),
        show(unRun),
      ),
    );
    const unDisk = by("disk-stale-unsupervised");
    out.push(assert("★디스크만 뒤처진 경우도 같다 — 감독자 없이는 손대지 않는다", untouched(unDisk, null), show(unDisk)));
    const unLatest = by("latest-unsupervised");
    out.push(
      assert(
        "진짜 최신은 감독자 측정과 무관하게 종전 no-op(안내 아님)",
        unLatest.status === "up-to-date" && !unLatest.noSupervisor && unLatest.restarted === 0 && unLatest.npm.length === 0 && unLatest.ripgrep > 0,
        show(unLatest),
      ),
    );
    const unPull = by("pull-unsupervised");
    out.push(
      assert(
        "범위: HEAD 가 움직이는 정상 업데이트는 측정으로 막지 않는다(종전 계약 — 재빌드로 간다, 여기선 빌드 실패로 롤백)",
        unPull.status === "failed" && !unPull.noSupervisor && unPull.tsc.some((a) => a.includes("--outDir")) && unPull.rolledBack === true && unPull.head === h && unPull.restarted === 0,
        show(unPull),
      ),
    );

    const ok = by("running-stale-success");
    out.push(
      assert(
        "★성공: 설치 → 재빌드 → dist 기록 = HEAD → 재시작 1회 · «무엇에서» 는 돌고 있던 빌드 · 롤백 앵커(HEAD)는 그대로",
        ok.status === "updating" && ok.restarted === 1 && ok.npm.length === 1 && ok.diskStamp === h && ok.newEntry && !ok.oldKept &&
          ok.from === c0.slice(0, (ok.to ?? "").length) && ok.to !== undefined && h.startsWith(ok.to) && ok.changedFiles === 1 && ok.head === h &&
          ok.leftovers.length === 0 && ok.marker !== null && ok.marker.from === ok.from,
        show(ok),
      ),
    );

    // 주입 없이 — 빌드 산출물 배치로 실린 모듈이 **부팅 때** 읽은 기록.
    const { b0, bh, bootStale, bootFresh, bootBlank } = parsed;
    out.push(
      assert(
        "★실제 built 배치(주입 없음): 부팅 때 읽은 실행 빌드(옛 커밋)를 부팅 뒤 디스크가 새것이 돼도 유지 — «최신» 이 아니라 설치로 간다",
        bootStale.status === "failed" && bootStale.npm.length === 2 && bootStale.restarted === 0 &&
          bootStale.from === b0.slice(0, (bootStale.to ?? "").length) && bootStale.head === bh,
        JSON.stringify(bootStale),
      ),
    );
    const { bootUnmeasured } = parsed;
    out.push(
      assert(
        "★실제 built 배치·감독자도 측정(주입 0): 이 자식은 KeepAlive 작업이 아니다 → 뒤처져도 설치·재시작 0 · 안내",
        bootUnmeasured.status === "failed" && bootUnmeasured.noSupervisor && bootUnmeasured.npm.length === 0 && bootUnmeasured.restarted === 0 && bootUnmeasured.head === bh,
        JSON.stringify(bootUnmeasured),
      ),
    );
    out.push(
      assert(
        "실제 built 배치(주입 없음): 새 부팅에서 실행 = 디스크 = HEAD 면 no-op",
        bootFresh.status === "up-to-date" && bootFresh.npm.length === 0 && bootFresh.restarted === 0,
        JSON.stringify(bootFresh),
      ),
    );
    out.push(
      assert(
        "★실제 built 배치(주입 없음): 부팅 때 기록이 없으면(모름) «최신» 이 아니다 — 설치로 간다",
        bootBlank.status === "failed" && bootBlank.npm.length === 2 && bootBlank.restarted === 0 && bootBlank.head === bh,
        JSON.stringify(bootBlank),
      ),
    );
    return out;
  },
};
