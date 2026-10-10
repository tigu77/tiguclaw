/**
 * 회귀: **홈 하나에 데몬 하나 · 부팅 리퍼는 이전 세대만** (2026-10-09 전체 적대 검토 P4·P3).
 *
 * 사고 ①(P4): 같은 홈으로 두 번째 데몬이 막히지 않고 반쯤 살았다. 채널 start 실패는 로그뿐이고 부팅 복구·리퍼는
 *  그대로 돌아 — 첫 데몬의 돌던 잡을 «재시작으로 중단» 으로 바꿔 통지하고, 백그라운드 셸·`/project run` 을 SIGKILL 하고,
 *  스케줄이 두 번 발화하고, 텔레그램이 409 로 서로 끊었다.
 * 사고 ②(P3): 부팅 리퍼가 채널을 연 **뒤**에 돌며 status='running' 행을 라벨만 보고 전부 죽였다 — 이 세대가 방금 띄운
 *  셸까지.
 *
 * ★등급: ①은 진짜 데몬 셋을 띄워 본다(`_home-exclusive-child.ts`) + 잠금 판정을 직접 돌린다. ②는 리퍼를 실제로 부른다.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { tsxLoaderUrl } from "./_probe-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "daemon-home-is-exclusive",
  guards:
    "같은 홈의 두 번째 데몬이 반쯤 살아 첫 데몬의 잡을 중단 처리·셸 SIGKILL·스케줄 이중 발화하던 것 + 부팅 리퍼가 이 세대 셸까지 죽이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { acquireHomeLock, releaseHomeLock, HOME_LOCK_FILE } = await import("../../store/home-lock.js");

    // ── ① 잠금 판정 — 살아 있는 남 / 죽은 pid / PID 재사용 / 재부팅 전 ─────────────────
    {
      const home = mkdtempSync(path.join(tmpdir(), "home-lock-unit-"));
      const file = path.join(home, HOME_LOCK_FILE);
      const other = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" });
      await sleep(300);
      // 시작 시각은 **검사가 따로** 잰다(제품 함수로 재면 제품이 틀려도 같이 틀린다). 윈도우엔 `ps` 가 없다 — CIM 으로(2026-10-10 윈도우 실측에서 여기서 죽었다).
      const startOf = (pid: number): number => {
        const r =
          process.platform === "win32"
            ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true })
            : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
        return Date.parse(String(r.stdout ?? "").trim());
      };
      const otherStart = startOf(other.pid!);
      const bootAt = Date.now() - os.uptime() * 1000;
      const put = (b: object): void => writeFileSync(file, JSON.stringify(b));
      try {
        put({ pid: other.pid, startedAt: otherStart, bootAt });
        const held = acquireHomeLock(home);
        out.push(assert("★살아 있는 다른 프로세스가 쥔 잠금은 못 쥔다", held.ok === false && held.holderPid === other.pid, held));

        put({ pid: other.pid, startedAt: otherStart - 3_600_000, bootAt });
        const reused = acquireHomeLock(home);
        out.push(assert("PID 가 살아 있어도 시작 시각이 다르면(재사용) 회수한다", reused.ok === true && /PID 재사용/.test(reused.reclaimed ?? ""), reused));
        releaseHomeLock(home);

        put({ pid: other.pid, startedAt: otherStart, bootAt: bootAt - 86_400_000 });
        const rebooted = acquireHomeLock(home);
        out.push(assert("재부팅 전 잠금은 pid 를 볼 것도 없이 회수한다", rebooted.ok === true && /재부팅/.test(rebooted.reclaimed ?? ""), rebooted));
        releaseHomeLock(home);

        // ★신호 권한이 없는(EPERM) 살아 있는 프로세스 — pid 1(root 소유)로 흉내 낸다. EPERM 만으로는 회수하지 않고 **시작 시각**으로 가른다:
        //  시각이 다르면(PID 재사용) 회수, 같으면(샌드박스·관리자 권한의 우리 데몬) 거부(2026-10-09 재확인 검토 — EPERM 으로 바로 회수해 데몬이 둘 떴다).
        if (process.platform !== "win32" && process.getuid?.() !== 0) {
          const p1Start = startOf(1);
          put({ pid: 1, startedAt: 1, bootAt });
          const reusedForeign = acquireHomeLock(home);
          releaseHomeLock(home);
          put({ pid: 1, startedAt: p1Start, bootAt });
          const liveForeign = acquireHomeLock(home);
          out.push(
            assert(
              "★EPERM 인 살아 있는 pid: 시작 시각이 다르면(재사용) 회수, 같으면(우리 데몬일 수 있다) 거부",
              reusedForeign.ok === true && liveForeign.ok === false,
              { 재사용: reusedForeign, 같은시각: liveForeign },
            ),
          );
          rmSync(file, { force: true });
        }

        other.kill("SIGKILL");
        await sleep(200);
        put({ pid: other.pid, startedAt: otherStart, bootAt });
        const dead = acquireHomeLock(home);
        const mine = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
        out.push(assert("★죽은 pid 의 잠금은 회수하고 내 pid 로 쥔다", dead.ok === true && /없음/.test(dead.reclaimed ?? "") && mine.pid === process.pid, { dead, filePid: mine.pid }));
        releaseHomeLock(home);
        let gone = false;
        try {
          readFileSync(file);
        } catch {
          gone = true;
        }
        out.push(assert("해제는 내 잠금을 지운다", gone, `파일 삭제=${gone}`));
        put({ pid: 999_999_999, startedAt: 1, bootAt });
        releaseHomeLock(home);
        const kept = readFileSync(file, "utf8");
        out.push(assert("남의 잠금은 해제가 안 건드린다(다음 세대 잠금 보호)", kept.includes("999999999"), `해제 뒤 잠금=${kept}`));

        // ★읽을 수 없는 잠금 — 막 생긴 것은 «쓰는 중» 일 수 있어 지우지 않고, 오래된 것만 손상으로 회수한다(2026-10-10 아스트라 검토:
        //  `wx` 생성 → 기록 사이의 빈 파일을 손상으로 지워 두 데몬이 다 떴다).
        writeFileSync(file, "");
        const fresh = acquireHomeLock(home);
        const old = new Date(Date.now() - 60_000);
        utimesSync(file, old, old);
        const stale = acquireHomeLock(home);
        releaseHomeLock(home);
        out.push(assert("★막 생긴 빈 잠금은 지우지 않고(쓰는 중일 수 있다) 오래된 빈 잠금만 손상으로 회수한다", fresh.ok === false && stale.ok === true && /손상/.test(stale.reclaimed ?? ""), { 새것: fresh, 오래된것: stale }));
        rmSync(file, { force: true });
      } finally {
        other.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
      }
    }

    // ── ①' 생성 순간에 끼어든 다른 부팅 — 잠금 경로가 생긴 **바로 그 순간** B 를 돌린다(강제 교차, sleep 의존 0) ─────────────
    //  2026-10-10 아스트라 검토: `wx` 생성 → 기록 사이에 B 가 빈 파일을 «손상» 으로 지우고 쥐어 둘 다 떴다.
    {
      const home = mkdtempSync(path.join(tmpdir(), "home-lock-interleave-"));
      const lockMod = JSON.stringify(new URL("../../store/home-lock.ts", import.meta.url).href);
      const loader = tsxLoaderUrl(REPO) ?? "tsx";
      const bCode = `const { acquireHomeLock } = await import(${lockMod}); process.stdout.write(JSON.stringify(acquireHomeLock(${JSON.stringify(home)})));`;
      const aCode =
        `const { acquireHomeLock, homeLockTestHooks } = await import(${lockMod});` +
        `const { spawnSync } = await import("node:child_process");` +
        `let b = "";` +
        `homeLockTestHooks.onCreated = () => { b = spawnSync(process.execPath, ["--import", ${JSON.stringify(loader)}, "--input-type=module", "-e", ${JSON.stringify(bCode)}], { encoding: "utf8" }).stdout; };` +
        `const a = acquireHomeLock(${JSON.stringify(home)});` +
        `process.stdout.write(JSON.stringify({ a, b: b === "" ? null : JSON.parse(b) }));`;
      const r = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", aCode], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
      rmSync(home, { recursive: true, force: true });
      let g: { a?: { ok: boolean }; b?: { ok: boolean; why?: string } | null } = {};
      try {
        g = JSON.parse(r.stdout) as typeof g;
      } catch {
        /* 아래 판정이 빈손을 실패로 본다 */
      }
      out.push(
        assert(
          "★잠금이 생기는 바로 그 순간 끼어든 다른 부팅은 못 쥔다(빈 잠금을 손상으로 지우지 않는다) — 하나만 뜬다",
          g.a?.ok === true && g.b !== undefined && g.b !== null && g.b.ok === false,
          { A: g.a, B: g.b, stderr: r.stderr.slice(-200) },
        ),
      );
    }

    // ── ② 부팅 리퍼 — 이 세대가 띄운 셸은 안 죽이고, 이전 세대 잔류 행만 정리한다 ─────────
    {
      const fo = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
      const { insertBgShell, listRunningBgShells } = await import("../../store/bg-shells.js");
      // 셸마다 같은 뜻의 «오래 도는 명령» — 윈도우 셸엔 `sleep` 이 없어 곧바로 끝났다(2026-10-10 윈도우 실측).
      const started = await fo.startBackgroundShell(`"${process.execPath}" -e "setTimeout(()=>{},60000)"`, tmpdir(), "regression:reaper");
      // 이전 세대가 남긴 행 — 이미 죽은 pid(신원 불일치 → stale).
      const ghostId = `bash_ghost_${process.pid}`;
      insertBgShell({ bashId: ghostId, pid: 999_999, pgid: 999_999, command: "old", cwd: tmpdir(), startedAt: Date.now() - 60_000 });
      await sleep(800);
      await fo.reapPreviousGeneration();
      const after = await Promise.race([started.done.then((r) => r.status), sleep(1500).then(() => "running")]);
      const running = listRunningBgShells().map((r) => r.bashId);
      out.push(assert("★리퍼가 이 세대 셸은 안 죽인다(채널 뒤에 돌아도 /project run 이 산다)", after === "running" && running.includes(started.shellId), `셸=${after} · DB running 에 남음=${running.includes(started.shellId)}`));
      out.push(assert("이전 세대 잔류 행은 여전히 정리한다(리퍼가 죽은 게 아니다)", !running.includes(ghostId), `ghost running 잔류=${running.includes(ghostId)}`));
      await fo.killShellById(started.shellId);
    }

    // ── ③ 진짜 데몬 셋 — 막힘 · 첫 데몬 무사 · 죽은 잠금 회수 ─────────────────────────────
    {
      const r = spawnSync(process.execPath, ["--import", tsxLoaderUrl(REPO) ?? "tsx", path.join(HERE, "_home-exclusive-child.ts")], {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 240_000,
      });
      let g: Record<string, unknown> = {};
      try {
        g = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
      } catch {
        g = {};
      }
      out.push(assert("첫 데몬이 떴고 잠금을 쥐었다(빈손 통과 금지)", g.aBooted === true && g.lockPidIsA === true, g.aBooted === true ? `잠금 pid=A ${String(g.lockPidIsA)}` : `★프로브 실패: ${String(g.aWhy ?? (r.stderr ?? "").slice(-300))}`));
      out.push(assert("★같은 홈의 두 번째 데몬은 분명히 말하고 종료한다(반쯤 살지 않는다)", g.bExited === true && g.bExitCode === 1 && g.bSaysHeld === true, `종료=${String(g.bExited)} 코드=${String(g.bExitCode)} 문구=${String(g.bSaysHeld)}`));
      out.push(assert("★두 번째 데몬은 DB·채널·리퍼를 건드리기 전에 나갔고 첫 데몬은 무사하다", g.bTouchedNothing === true && g.aAliveAfterB === true && g.lockStillA === true, `무접촉=${String(g.bTouchedNothing)} A생존=${String(g.aAliveAfterB)} 잠금유지=${String(g.lockStillA)}`));
      out.push(assert("★SIGKILL 로 남은 잠금은 다음 부팅이 회수하고 뜬다(영영 못 뜨지 않는다)", g.lockLeftAfterKill === true && g.cBooted === true && g.cReclaimed === true, `잔류=${String(g.lockLeftAfterKill)} C기동=${String(g.cBooted)} 회수로그=${String(g.cReclaimed)} ${String(g.cTail ?? "")}`));
    }
    return out;
  },
};
