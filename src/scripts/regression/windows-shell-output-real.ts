/**
 * 회귀: **진짜 Windows `cmd` 출력이 한글로 읽힌다** (2026-10-23, 설계 docs/decisions/2026-10-23-windows-shell-output-encoding.md).
 *
 * 판정부·셸 경로는 `shell-output-encoding` 이 Windows 판정을 주입해 모든 OS 에서 본다. 여기서는 **그 기계의 실제 OEM 코드 페이지**(`chcp` 로 잰 값)와
 *  실제 `cmd` 내장 명령·콘솔 프로그램으로 — `echo 한글`(cmd 내장) · `ping -n 1 127.0.0.1`(콘솔 프로그램, 한국어 Windows 면 한글 출력) · `dir` 오류(stderr) ·
 *  node 가 UTF-8 로 쓰는 줄과 섞기 · 백그라운드 · 훅(`cmd /c` 의 `echo … 1>&2 & exit /b 2`).
 * ★Windows 전용 — 다른 OS 는 명시적 비대상. 한글이 «있다» 는 단언은 OEM 이 949 일 때만 의미가 있어 그 경우에만 한글을 찾고, 아니면 U+FFFD 0 만 본다.
 *
 * 등급: **동작**(실제 cmd).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, skip, type Assertion, type RegressionCheck } from "./_framework.js";

type Tools = Record<string, { handler?: (a: Record<string, unknown>, e: unknown) => Promise<{ content?: { text?: string }[] }> }>;
const HOOK_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_shell-output-hook-child.ts");

export const check: RegressionCheck = {
  name: "windows-shell-output-real",
  guards: "Windows 의 진짜 cmd 출력(echo 한글·ping·dir 오류)과 훅 사유가 OEM 코드 페이지라 깨지던 것 — 그 기계의 실제 코드 페이지로",
  run: async (): Promise<Assertion[]> => {
    if (process.platform !== "win32") {
      return [skip("진짜 cmd 출력 — Bash 포그라운드·백그라운드·훅", "Windows 가 아닌 OS — 판정부·셸 경로는 shell-output-encoding 이 Windows 판정을 주입해 본다")];
    }
    const out: Assertion[] = [];
    const chcp = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true });
    const cp = Number(((chcp.stdout ?? Buffer.alloc(0)).toString("latin1").match(/\d+/g) ?? ["0"]).pop());
    const korean = cp === 949;
    const fx = mkdtempSync(path.join(tmpdir(), "win-shell-real-"));
    try {
      const { createFileOpsMcpServer, killAllBgShells } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
      const tools = (createFileOpsMcpServer(fx, "regr:win-shell-real", {}) as unknown as { instance?: { _registeredTools?: Tools } }).instance?._registeredTools ?? {};
      const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
        ((await tools[name]!.handler!(args, {})).content ?? []).map((c) => c.text ?? "").join("\n");
      const cmd = `echo 한글테스트& "${process.execPath}" -e "process.stdout.write('노드한글\\n')"& ping -n 1 127.0.0.1& dir C:\\tiguclaw-없는폴더`;
      const fg = await call("Bash", { command: cmd });
      const ok = (t: string): boolean => !t.includes("\uFFFD") && (!korean || (t.includes("한글테스트") && t.includes("노드한글") && /Ping|바이트/.test(t) && /찾을 수 없|없습니다/.test(t)));
      out.push(assert(`★★Bash 포그라운드 — echo 한글·node UTF-8·ping·dir 오류(코드 페이지 ${cp})`, ok(fg), fg.slice(0, 400)));
      const id = /bash_[0-9a-f]{8}/.exec(await call("Bash", { command: cmd, run_in_background: true }))?.[0] ?? "";
      const bg = await call("BashOutput", { bash_id: id, wait_seconds: 20 });
      out.push(assert(`★★Bash 백그라운드 → BashOutput — 같은 출력(코드 페이지 ${cp})`, ok(bg), bg.slice(0, 400)));
      await killAllBgShells();
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
    const home = mkdtempSync(path.join(tmpdir(), "win-shell-real-hook-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", HOOK_CHILD], {
        encoding: "utf8", timeout: 60_000, env: { ...process.env, TIGUCLAW_HOME: home, REAL_CMD: "echo 정책상 금지된 도구입니다 1>&2 & exit /b 2" },
      });
      let got: { block?: boolean; reason?: string } = {};
      try { got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as typeof got; } catch { got = {}; }
      const reason = got.reason ?? "";
      out.push(assert(`★훅(cmd /c) — 차단 사유가 깨지지 않는다(코드 페이지 ${cp})`,
        got.block === true && !reason.includes("\uFFFD") && (!korean || reason.includes("정책상 금지된 도구입니다")), { got, err: (r.stderr ?? "").slice(-300) }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
