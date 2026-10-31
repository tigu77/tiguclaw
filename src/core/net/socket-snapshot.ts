/**
 * **`EADDRNOTAVAIL` 이 로그에 나타나면 그 순간의 소켓 상태를 한 줄 남긴다** (2026-10-31).
 *
 * ★사고: 10/30 18:50~10/31 02:40, 같은 Mac 의 두 데몬에서 외부 연결과 **루프백(127.0.0.1)** 연결이 함께
 *  `EADDRNOTAVAIL` 로 실패했다. 재부팅으로 상태가 사라져 당시 TCP 상태·소켓 소유 프로세스를 알 수 없었다 —
 *  포트 고갈·소켓 누수·특정 프로세스 책임은 **미확정**이다. 이 모듈은 다음 재발을 좁히려는 것이지 그 사고를
 *  설명하지 않는다. 설계·검토: `docs/decisions/2026-10-31-eaddrnotavail-socket-snapshot-design.md`.
 *
 * 트리거는 로그 관문(`logging.ts` 의 `console.*` 미러) 한 곳이다 — 호출부마다 감지하면 새 호출부가 빠진다.
 * `logFatal`(치명 종료 직전 동기 기록)은 지나지 않는다: 거기서 수집을 기다리면 crash-fast 가 바뀐다.
 *
 * 정책(권위는 여기 하나):
 *  - **사건 = 직전 수집을 시작한 시각부터 24시간 창.** 창 안의 관측은 같은 사건으로 보고 아무것도 안 한다
 *    (원래 오류 줄은 로그에 그대로 있다). 사건의 끝은 주기 관찰 없이는 알 수 없어 시간 창으로 **정의**한다.
 *  - 프로세스당 최대 3사건. 상태는 메모리뿐 — 재시작하면 새로 센다.
 *  - 예약 **전에** 상태를 바꾼다 — 같은 차례에 오류 줄이 몰려도 수집은 하나.
 *  - 끄기: `TIGUCLAW_SOCKET_SNAPSHOT=0`.
 *
 * 부하·민감 정보:
 *  - 셸 없음 · 절대 경로 · 최소 env · 명령은 하나씩(앞 자식의 `close` 뒤에 다음) · 명령마다 시한·출력 상한.
 *  - `netstat` 줄엔 주소·포트 열이 있다 — 스트림 조각을 줄로 잘라 **상태 칸만 읽고 버린다**(보존·기록 0).
 *    `lsof` 는 PID·프로세스 이름·fd 번호 필드만 요청한다(주소 필드 `n` 미요청). 명령줄 인자·사용자명·env 는 안 본다.
 *  - `-n -P`: 이름 조회를 하지 않는다(장애 중 추가 연결 0).
 *  - macOS 만 시스템 집계를 한다. 다른 플랫폼은 «미지원» 이라고 쓰고 이 프로세스 안의 보조 지표만 남긴다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const SOCKET_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SOCKET_SNAPSHOT_MAX_PER_PROCESS = 3;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIDS = 5_000;
const TOP_PROCESSES = 5;
const LINE_CAP = 1_500;
const TRIGGER = "EADDRNOTAVAIL";

/**
 * ★부모가 먼저 끝나도 진단 자식을 남기지 않는다 — 자식을 만든 모듈이 자기 exit 훅으로 치운다(`src/index.ts` 종료 절의
 *  계약 · 같은 관례 `external-mcp.ts`·`file-ops-mcp.ts`). 시한 타이머는 부모와 함께 사라지므로 이 훅이 최후 그물이다.
 *  훅은 첫 자식 때 한 번만 건다(자식이 없으면 훅도 없다).
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
const ensureExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const c of liveChildren) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* 종료 중 */
      }
    }
  });
};

export type LineRunStatus =
  | { kind: "ok" }
  | { kind: "exit"; code: number | null }
  | { kind: "timeout"; ms: number }
  | { kind: "overflow"; bytes: number }
  | { kind: "spawn-error"; code: string };

export interface LineRunLimits {
  timeoutMs: number;
  maxBytes: number;
}

/**
 * 명령 하나를 셸 없이 돌려 stdout 을 **줄 단위로** `onLine` 에 넘긴다 — 원문을 모으지 않는다.
 * 시한·출력 상한을 넘으면 SIGKILL 하고, 그래도 자식의 `close` 를 본 **뒤에만** 돌아온다(다음 명령과 안 겹친다).
 * 던지지 않는다.
 */
export const runCountingLines = (
  cmd: string,
  args: readonly string[],
  onLine: (line: string) => void,
  limits: LineRunLimits,
): Promise<LineRunStatus> =>
  new Promise<LineRunStatus>((resolve) => {
    let settled = false;
    const done = (s: LineRunStatus): void => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    let child: ChildProcess;
    ensureExitHook();
    try {
      child = spawn(cmd, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
        windowsHide: true,
      });
    } catch (e) {
      done({ kind: "spawn-error", code: errCode(e) });
      return;
    }
    liveChildren.add(child);
    let killed: LineRunStatus | undefined;
    let bytes = 0;
    let rest = "";
    const decoder = new StringDecoder("utf8");
    const kill = (why: LineRunStatus): void => {
      if (killed !== undefined) return;
      killed = why;
      try {
        child.kill("SIGKILL");
      } catch {
        /* 이미 끝났으면 close 가 온다 */
      }
    };
    const timer = setTimeout(() => kill({ kind: "timeout", ms: limits.timeoutMs }), limits.timeoutMs);
    timer.unref(); // 진단 시한이 데몬 종료를 붙들지 않는다(자식 파이프가 끝나면 close 는 온다).
    const feed = (text: string): void => {
      const parts = (rest + text).split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (killed !== undefined) return;
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        kill({ kind: "overflow", bytes: limits.maxBytes });
        return;
      }
      feed(decoder.write(chunk));
    });
    child.on("error", (e) => {
      // 실행 자체가 안 됐으면(ENOENT·EMFILE 등) close 가 안 올 수 있다 — 자식이 없으니 겹칠 것도 없다.
      if (child.pid === undefined) {
        clearTimeout(timer);
        liveChildren.delete(child);
        done({ kind: "spawn-error", code: errCode(e) });
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      if (killed !== undefined) {
        done(killed);
        return;
      }
      feed(decoder.end());
      if (rest !== "") onLine(rest);
      rest = "";
      done(code === 0 ? { kind: "ok" } : { kind: "exit", code });
    });
  });

const errCode = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[A-Z0-9_]{1,32}$/.test(c) ? c : "unknown";
};

/** 시스템 TCP 상태 집계 — `netstat -an -p tcp` 의 `tcp…` 줄 **마지막 칸**만 본다. */
export const countTcpStates = (): { onLine: (l: string) => void; states: Map<string, number> } => {
  const states = new Map<string, number>();
  return {
    states,
    onLine: (l) => {
      if (!l.startsWith("tcp")) return;
      const m = /(\S+)\s*$/.exec(l);
      const raw = m?.[1] ?? "";
      const st = /^[A-Z][A-Z0-9_]{1,15}$/.test(raw) ? raw : "OTHER";
      states.set(st, (states.get(st) ?? 0) + 1);
    },
  };
};

/**
 * 프로세스별 TCP fd 집계 — `lsof -F pc` 의 `p`(PID)·`c`(이름)·`f`(fd) 줄.
 * ★`selfPid` 는 PID 표(상한 있음)와 **따로** 센다 — 다른 PID 가 표를 채운 뒤에 와도 빠지지 않는다.
 */
export const countLsofProcesses = (selfPid: number): {
  onLine: (l: string) => void;
  procs: Map<number, { name: string; fds: number }>;
  overflowFds: () => number;
  selfFds: () => number;
} => {
  const procs = new Map<number, { name: string; fds: number }>();
  let cur: { name: string; fds: number } | undefined;
  let overflow = 0;
  let inOverflow = false;
  let isSelf = false;
  let self = 0;
  return {
    procs,
    overflowFds: () => overflow,
    selfFds: () => self,
    onLine: (l) => {
      const tag = l.charAt(0);
      const val = l.slice(1);
      if (tag === "f" && isSelf) self += 1;
      if (tag === "p") {
        const pid = Number(val);
        cur = undefined;
        inOverflow = false;
        isSelf = pid === selfPid;
        if (!Number.isInteger(pid) || pid <= 0) return;
        const seen = procs.get(pid);
        if (seen !== undefined) cur = seen;
        else if (procs.size < MAX_PIDS) {
          cur = { name: "?", fds: 0 };
          procs.set(pid, cur);
        } else inOverflow = true;
      } else if (tag === "c") {
        if (cur !== undefined) cur.name = processName(val);
      } else if (tag === "f") {
        if (cur !== undefined) cur.fds += 1;
        else if (inOverflow) overflow += 1;
      }
    },
  };
};

/** 프로세스 이름 — 출력 가능한 ASCII 로, 24자까지. 구분자로 쓰는 `#`·`=`·공백은 바꾼다. */
const processName = (s: string): string => {
  const t = s.replace(/[^\x21-\x7E]/g, "_").replace(/[#=]/g, "_").slice(0, 24);
  return t === "" ? "?" : t;
};

export interface SocketSnapshotDeps {
  now: () => number;
  platform: NodeJS.Platform;
  pid: number;
  env: NodeJS.ProcessEnv;
  run: typeof runCountingLines;
  emit: (line: string) => void;
  resources: () => string[];
  schedule: (fn: () => void) => void;
  limits: LineRunLimits;
}

const statusNote = (name: string, s: LineRunStatus): string => {
  switch (s.kind) {
    case "ok":
      return "";
    case "exit":
      return ` (${name} 종료 코드 ${s.code ?? "?"})`;
    case "timeout":
      return ` (${name} 부분 집계 — 시한 ${Math.round(s.ms / 100) / 10}초 초과)`;
    case "overflow":
      return ` (${name} 부분 집계 — 출력 상한 ${s.bytes}B 초과)`;
    case "spawn-error":
      return ` (${name} 실행 실패 ${s.code})`;
  }
};

/** 수집기 — 상태·정책을 한 객체가 쥔다. 기본 인스턴스는 아래 `noteLogLineForSocketSnapshot`. */
export const createSocketSnapshot = (deps: SocketSnapshotDeps) => {
  let running = false;
  let windowStart: number | undefined;
  let taken = 0;
  let current: Promise<void> = Promise.resolve();

  const capture = async (n: number): Promise<string> => {
    const t0 = deps.now();
    const parts: string[] = [
      `[socket-snapshot] 주소 할당 실패(${TRIGGER}) 관측 → 소켓 상태 기록 (사건 ${n}/${SOCKET_SNAPSHOT_MAX_PER_PROCESS} · 같은 사건 창 ${SOCKET_SNAPSHOT_WINDOW_MS / 3_600_000}시간${n >= SOCKET_SNAPSHOT_MAX_PER_PROCESS ? " · 이 프로세스의 마지막 기록" : ""})`,
    ];
    if (deps.platform === "darwin") {
      const tcp = countTcpStates();
      const tcpStatus = await deps.run("/usr/sbin/netstat", ["-an", "-p", "tcp"], tcp.onLine, deps.limits);
      if (tcpStatus.kind === "spawn-error") parts.push(`TCP 상태: 미확인${statusNote("netstat", tcpStatus)}`);
      else {
        const sorted = [...tcp.states].sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((s, [, v]) => s + v, 0);
        parts.push(
          `TCP 상태(시스템 전체): ${sorted.map(([k, v]) => `${k}=${v}`).join(" ") || "없음"} · 합계 ${total}${statusNote("netstat", tcpStatus)}`,
        );
      }
      const ls = countLsofProcesses(deps.pid);
      const lsStatus = await deps.run("/usr/sbin/lsof", ["-nP", "-w", "-iTCP", "-F", "pc"], ls.onLine, deps.limits);
      if (lsStatus.kind === "spawn-error") parts.push(`이 데몬(pid ${deps.pid}) TCP fd 미확인${statusNote("lsof", lsStatus)}`);
      else {
        const self = ls.selfFds();
        const top = [...ls.procs]
          .sort((a, b) => b[1].fds - a[1].fds)
          .slice(0, TOP_PROCESSES)
          .map(([pid, p]) => `${p.name}#${pid}=${p.fds}`);
        const over = ls.overflowFds();
        parts.push(`이 데몬(pid ${deps.pid}) TCP fd ${self}${statusNote("lsof", lsStatus)}`);
        parts.push(
          `TCP 소켓 많은 프로세스(이 사용자 소유): ${top.join(" ") || "없음"} (프로세스 ${ls.procs.size}개${over > 0 ? ` · 상한 밖 fd ${over}` : ""})`,
        );
      }
    } else {
      parts.push(`TCP 상태·프로세스별 집계: 이 플랫폼(${deps.platform}) 미지원`);
    }
    const res = deps.resources();
    const sock = res.filter((r) => r === "TCPSocketWrap").length;
    const server = res.filter((r) => r === "TCPServerWrap").length;
    parts.push(`이벤트 루프를 붙든 TCP 자원: TCPSocketWrap=${sock} TCPServerWrap=${server}`);
    parts.push(`소요 ${deps.now() - t0}ms`);
    return parts.join(" · ").slice(0, LINE_CAP);
  };

  const note = (line: string): void => {
    if (running) return;
    if (!line.includes(TRIGGER)) return;
    if (deps.env.TIGUCLAW_SOCKET_SNAPSHOT === "0") return;
    if (taken >= SOCKET_SNAPSHOT_MAX_PER_PROCESS) return;
    const t = deps.now();
    if (windowStart !== undefined && t - windowStart < SOCKET_SNAPSHOT_WINDOW_MS) return;
    // ★예약 전에 상태를 바꾼다 — 같은 차례에 몰린 줄은 위 `running` 에서 멈춘다.
    running = true;
    windowStart = t;
    taken += 1;
    const n = taken;
    let release!: () => void;
    current = new Promise<void>((r) => (release = r));
    deps.schedule(() => {
      void capture(n)
        .catch((e: unknown) => `[socket-snapshot] 소켓 상태 기록 실패(사건 ${n}/${SOCKET_SNAPSHOT_MAX_PER_PROCESS}) — ${errCode(e)}`)
        .then((out) => {
          // ★출력은 `running` 을 풀기 **전에** 한다 — 이 줄도 관문을 지나 `note` 로 돌아오는데(`EADDRNOTAVAIL` 이 들어 있다),
          //  그때 아직 running 이라 자기 수집을 다시 부르지 않는다.
          try {
            deps.emit(out);
          } catch {
            /* 출력 실패가 관문을 깨지 않는다 */
          }
        })
        .finally(() => {
          running = false;
          release();
        });
    });
  };

  /** 회귀용 — 진행 중 수집이 끝날 때까지 기다린다. */
  const whenIdle = (): Promise<void> => current;
  return { note, whenIdle };
};

let defaultInstance: ReturnType<typeof createSocketSnapshot> | undefined;

/**
 * 로그 관문이 매 줄 부른다 — 판정은 수집기의 `note` 한 곳(`EADDRNOTAVAIL` 이 없으면 문자열 검사 하나로 끝난다). 던지지 않는다.
 */
export const noteLogLineForSocketSnapshot = (line: string): void => {
  try {
    defaultInstance ??= createSocketSnapshot({
      now: Date.now,
      platform: process.platform,
      pid: process.pid,
      env: process.env,
      run: runCountingLines,
      emit: (l) => console.warn(l),
      resources: () => process.getActiveResourcesInfo(),
      schedule: (fn) => setImmediate(fn),
      limits: { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: COMMAND_MAX_BYTES },
    });
    defaultInstance.note(line);
  } catch {
    /* 진단이 로그 관문을 깨지 않는다 */
  }
};
