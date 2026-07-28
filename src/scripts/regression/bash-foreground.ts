/**
 * 회귀: 포그라운드 Bash 의 타임아웃·중단이 **프로세스 그룹 전체**를 정리한다 (2026-07-28).
 *
 * 사고: execFile 내장 timeout 은 직계 자식(sh)만 죽여 `sh -c "node srv.js"` 의 손자가
 * 살아남았다 — 라이브 고아 1건 실측(10일 생존, 포트 3911 점유). 게다가 execFile 은
 * detached 옵션을 **전달하지 않아**(pgid 가 부모 그룹) 그룹 kill 이 ESRCH 로 실패했다.
 * 그래서 spawn 기반으로 바꿨고, 이 검사가 그 계약을 지킨다.
 *
 * 실제 어댑터가 쓰는 브리지 경로로 호출한다(내부 shape 흉내 금지).
 */
import { createFileOpsMcpServer } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const bashOf = async (
  abortSignal?: AbortSignal,
): Promise<(args: Record<string, unknown>) => Promise<string>> => {
  const srv = await adaptClaudeMcpServer(
    createFileOpsMcpServer(tmpdir(), "", abortSignal ? { abortSignal } : undefined),
    "file-ops",
  );
  return async (args) => {
    const content = (await srv.callTool("Bash", args)) as unknown;
    const arr = Array.isArray(content) ? content : [content];
    return (arr[0] as { text?: string } | undefined)?.text ?? JSON.stringify(content);
  };
};

export const check: RegressionCheck = {
  name: "bash-foreground",
  guards: "타임아웃/중단 시 손자 프로세스가 고아로 남던 것 + /stop 이 셸을 못 끊던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const bash = await bashOf();

    out.push(assert("정상 명령(회귀 0)", (await bash({ command: "echo hello-regression" })).includes("hello-regression"), "echo"));

    const nz = await bash({ command: "echo to-out; echo to-err 1>&2; exit 7" });
    out.push(assert("종료코드·stdout·stderr 보존", nz.includes("exit code: 7") && nz.includes("to-out") && nz.includes("to-err"), nz.replace(/\n/g, " ").slice(0, 60)));

    // ★핵심 — 손자가 함께 죽는가.
    const pidFile = path.join(tmpdir(), `regression-grandchild-${process.pid}.pid`);
    if (existsSync(pidFile)) unlinkSync(pidFile);
    const cmd = `node -e 'require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)' & wait`;
    // 시한 = 도구 timeout(2s) + 여유. 회귀가 돌아오면 여기서 영원히 안 끝나므로(실측)
    // 매달리는 대신 실패로 보고한다.
    const tR = await within(15_000, "timeout 후 반환", bash({ command: cmd, timeout: 2 }));
    const t = "value" in tR ? tR.value : "";
    if ("timedOut" in tR) out.push(assert("타임아웃이 제때 반환된다", false, tR.timedOut));
    await sleep(500);
    const gpid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    const stillAlive = gpid > 0 && alive(gpid);
    out.push(assert("타임아웃 보고", t.includes("timeout"), t.slice(-50).replace(/\n/g, " ")));
    out.push(assert("손자가 함께 죽는다(고아 0)", gpid > 0 && !stillAlive, `grandchild=${gpid} alive=${stillAlive}`));
    if (stillAlive) {
      try {
        process.kill(gpid, "SIGKILL");
      } catch {
        /* 검사가 고아를 남기지 않게 */
      }
    }
    if (existsSync(pidFile)) unlinkSync(pidFile);

    // /stop 경로 — abortSignal 로 즉시 끊기는가.
    const ac = new AbortController();
    const abortable = await bashOf(ac.signal);
    const started = Date.now();
    const p = abortable({ command: "sleep 30", timeout: 60 });
    setTimeout(() => ac.abort(), 500);
    const aR = await within(15_000, "중단 후 반환", p);
    const aborted = "value" in aR ? aR.value : "";
    const elapsed = Date.now() - started;
    out.push(
      assert(
        "중단 신호로 즉시 끊긴다",
        "value" in aR && elapsed < 5000 && aborted.includes("중단"),
        "timedOut" in aR ? aR.timedOut : `${elapsed}ms`,
      ),
    );
    return out;
  },
};
