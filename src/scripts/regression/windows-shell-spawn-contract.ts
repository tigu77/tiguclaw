/**
 * 회귀: **Windows 셸 실행 계약은 맥에서도 잰다** — 따옴표 그대로 넘기기 · 창 숨김 (2026-09-24).
 *
 * ★사고 둘, 같은 모양:
 *  ① 09-23 Windows 따옴표 수정(`cmd /d /s /c "…"` + `windowsVerbatimArguments`)은 포그라운드만
 *     그물에 걸렸다 — 백그라운드(`run_in_background`) 쪽 플래그를 지워도 **어느 플랫폼에서도**
 *     초록이었다(싱크 레드팀 B G-1). Windows 전용 분기라 맥 회귀에선 실행조차 안 된다.
 *  ② 백그라운드 셸과 훅 spawn 에 `windowsHide` 가 없어 Windows 에서 명령마다 cmd 창이 떴다
 *     (포그라운드엔 있었다 — 두 자리가 옵션을 각자 적다 한쪽만 빠졌다).
 * ★고침은 옵션을 **한 함수**(`shellSpawnOptions`)로 모은 것이고, 이 검사는 `process.platform` 을
 *  잠깐 win32 로 바꿔 그 함수와 `detectShell` 을 **실행**한다 — 맥에서도 Windows 계약이 운다.
 *
 * 등급: 동작(detectShell·shellSpawnOptions 실행) + 소스 대조(셸 도구의 모든 spawn 자리가 그 함수를
 *  지나는가 · 훅 spawn 의 창 숨김 — 이 둘은 spawn 을 띄우지 않고는 못 재서 글자로 잰다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectShell, shellSpawnOptions } from "../../core/runtime-env.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 플랫폼·env 를 잠깐 바꿔 실행하고 반드시 되돌린다. */
const asPlatform = <T>(platform: string, env: Record<string, string | undefined>, fn: () => T): T => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process, "platform", desc);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

export const check: RegressionCheck = {
  name: "windows-shell-spawn-contract",
  guards:
    "Windows 따옴표 수정이 백그라운드 셸에선 그물 밖이었고, 백그라운드 셸·훅이 창 숨김 없이 떠 명령마다 cmd 창이 뜨던 것 — Windows 분기라 맥 회귀가 실행조차 안 하던 계약",
  run: async (): Promise<Assertion[]> => {
    const win = asPlatform("win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe", TIGUCLAW_BASH_SHELL: undefined }, () => {
      const spec = detectShell();
      return {
        args: spec.argsFor('echo "a b"'),
        verbatim: spec.windowsVerbatimArguments,
        opts: shellSpawnOptions(spec, { cwd: "C:\\w" }, { processGroup: true }),
      };
    });
    const override = asPlatform("win32", { TIGUCLAW_BASH_SHELL: "bash" }, () => {
      const spec = detectShell();
      return shellSpawnOptions(spec, { cwd: "C:\\w" });
    });
    const posix = asPlatform("darwin", { TIGUCLAW_BASH_SHELL: undefined }, () =>
      shellSpawnOptions(detectShell(), { cwd: "/w" }, { processGroup: true }),
    );

    const fileOps = readFileSync(
      path.join(REPO, "src/core/llm-runtime/capabilities/file-ops-mcp.ts"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    // spawn(SHELL.bin, SHELL.argsFor(…), <세 번째 인자>) — 세 번째 인자가 공통 함수인지 본다.
    const spawnCount = (fileOps.match(/spawn\(\s*SHELL\.bin\b/g) ?? []).length;
    const thirdArgs = [
      ...fileOps.matchAll(/spawn\(\s*SHELL\.bin,\s*SHELL\.argsFor\([^)]*\),\s*([^\s(]+)/g),
    ].map((m) => m[1]);
    const sitesViaHelper = thirdArgs.filter((a) => a === "shellSpawnOptions").length;
    // 모든 spawn 자리가 프로세스 그룹을 요청한다 — 빠지면 POSIX 에서 손자를 kill(-pgid) 로 못 죽인다.
    const groupRequests = (fileOps.match(/shellSpawnOptions\(SHELL,[^;]*?\{ processGroup: true \}\)/g) ?? []).length;
    const forcedHide = asPlatform("win32", { TIGUCLAW_BASH_SHELL: undefined }, () =>
      shellSpawnOptions(detectShell(), { windowsHide: false } as Record<string, unknown>),
    );
    // 주석을 벗기고 잰다 — 창 숨김을 주석 처리해도 초록이던 구멍(싱크 레드팀 G7).
    const hook = readFileSync(path.join(REPO, "src/core/entry/hook-runner.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    // 호출부가 `detached` 를 직접 적으면 Windows 에서 창 숨김이 무시된다 — 공통 함수만 정한다.
    const directDetached = /spawn\(\s*SHELL\.bin[\s\S]{0,240}?detached\s*:/.test(fileOps);
    const hookWin = /process\.platform === "win32"\s*\?\s*spawn\([\s\S]*?\}\)/.exec(hook)?.[0] ?? "";

    return [
      assert(
        "① win32 cmd 인자는 `/d /s /c \"명령\"` — 명령 안 따옴표를 그대로 둔다",
        JSON.stringify(win.args) === JSON.stringify(["/d", "/s", "/c", '"echo "a b""']),
        JSON.stringify(win.args),
      ),
      assert(
        "① win32 cmd 는 따옴표를 Node 가 다시 이스케이프하지 않게 한다(verbatim) — spawn 옵션에 실린다",
        win.verbatim === true && win.opts.windowsVerbatimArguments === true,
        `spec=${String(win.verbatim)} opts=${String(win.opts.windowsVerbatimArguments)}`,
      ),
      assert(
        "② spawn 옵션은 창을 숨긴다(명령마다 cmd 창이 뜨지 않게) — 넘긴 옵션은 그대로 둔다",
        win.opts.windowsHide === true && win.opts.cwd === "C:\\w",
        JSON.stringify(win.opts),
      ),
      assert(
        "① 셸을 바꿔 지정하면(bash) verbatim 을 안 준다 — bash 에는 Node 기본 인용이 맞다",
        override.windowsVerbatimArguments === undefined && override.windowsHide === true,
        JSON.stringify(override),
      ),
      assert(
        "POSIX 는 verbatim 없음 · 창 숨김은 무해하게 같이",
        posix.windowsVerbatimArguments === undefined && posix.windowsHide === true,
        JSON.stringify(posix),
      ),
      assert(
        "★★Windows 에선 프로세스 그룹을 달라고 해도 `detached` 를 안 켠다 — 켜면 창 숨김이 무시돼 콘솔 프로그램마다 창이 뜬다(nodejs/node#21825)",
        win.opts.detached === undefined,
        `win32 detached=${String(win.opts.detached)}`,
      ),
      assert(
        "POSIX 에선 프로세스 그룹(`detached`)을 켠다 — 손자까지 kill(-pgid) 로 죽이는 전제",
        posix.detached === true,
        `posix detached=${String(posix.detached)}`,
      ),
      assert(
        "셸 도구의 모든 spawn 자리가 프로세스 그룹을 요청한다(빠지면 POSIX 에서 손자를 못 죽인다)",
        spawnCount >= 2 && groupRequests === spawnCount,
        `spawn ${spawnCount}곳 중 그룹 요청 ${groupRequests}곳`,
      ),
      assert(
        "창 숨김은 호출부 값과 무관하게 켜진다(`windowsHide:false` 를 넘겨도)",
        forcedHide.windowsHide === true,
        `windowsHide=${String(forcedHide.windowsHide)}`,
      ),
      assert(
        "셸 도구 spawn 자리가 `detached` 를 직접 적지 않는다(공통 함수만 정한다)",
        !directDetached,
        directDetached ? "★호출부가 detached 를 직접 적었다" : "없음",
      ),
      assert(
        "★셸 도구의 **모든** spawn 자리(포그라운드·백그라운드)가 공통 옵션 함수를 지난다(한쪽만 빠질 수 없게)",
        spawnCount >= 2 && sitesViaHelper === spawnCount,
        `spawn 자리 ${spawnCount}개 중 ${sitesViaHelper}개가 shellSpawnOptions`,
      ),
      assert(
        "② 훅의 win32 spawn 도 창을 숨긴다",
        /windowsHide:\s*true/.test(hookWin) && /windowsVerbatimArguments:\s*true/.test(hookWin),
        hookWin === "" ? "★win32 분기를 못 찾음" : "확인",
      ),
    ];
  },
};
