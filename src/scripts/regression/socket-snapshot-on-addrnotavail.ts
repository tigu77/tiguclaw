/**
 * 회귀: **`EADDRNOTAVAIL` 이 로그에 나타나면 그 순간의 소켓 상태가 한 번 남는다** (2026-10-31).
 *
 * 사고: 10/30 밤 같은 Mac 두 데몬의 외부·루프백 연결이 `EADDRNOTAVAIL` 로 실패했고, 재부팅으로 상태가 사라져
 *  당시 TCP 상태·소켓 소유 프로세스를 알 수 없었다(원인 미확정). 설계: docs/decisions/2026-10-31-eaddrnotavail-socket-snapshot-design.md.
 * 본다: 정책(사건 창 24h·프로세스 3사건·같은 차례 몰림 1회·재진입 0·끄기) · 집계(상태·자기 fd·상위 5·주소 없음) ·
 *  실제 러너 경계(시한·출력 상한에 죽이고 close 뒤 반환·명령 비중첩·최소 env) · 실제 로그 관문 배선(자식 프로세스).
 * 등급: **동작 + 실행**(가짜 자식은 `node -e`, 네트워크 0 · 관문 자식은 macOS 에서 netstat/lsof 각 1회 무해 조회).
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, within, type Assertion, type RegressionCheck } from "./_framework.js";
import {
  createSocketSnapshot,
  runCountingLines,
  SOCKET_SNAPSHOT_WINDOW_MS,
  type LineRunLimits,
  type LineRunStatus,
  type SocketSnapshotDeps,
} from "../../core/net/socket-snapshot.js";

const ADDR = /\d+\.\d+\.\d+\.\d+|::1|\*\.\d+/;
const TRIG = "x fetch failed ← EADDRNOTAVAIL connect";
const SELF = 4242;

const NETSTAT = [
  "Active Internet connections (including servers)",
  "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
  "tcp4       0      0  127.0.0.1.3020         127.0.0.1.52344        TIME_WAIT",
  "tcp4       0      0  127.0.0.1.52344        127.0.0.1.3020         TIME_WAIT",
  "tcp6       0      0  ::1.7011               ::1.60000              ESTABLISHED",
  "tcp4       0      0  *.3000                 *.*                    LISTEN",
  "udp4       0      0  *.5353                 *.*",
];
const lsofLines = (extra: string[] = []): string[] => [
  // n(주소) 줄도 섞는다 — 요청하지 않지만 혹시 와도 이름·수치로 새면 안 된다.
  "p100", "cnode", "f20", "n127.0.0.1:3020->127.0.0.1:52344", "f21", "f22",
  `p${SELF}`, "cnode", "f30", "f31",
  "p7", "cbad name#x=y\u0001", "f9",
  "p8", "ca", "f1", "p9", "cb", "f1", "p10", "cc", "f1", "p11", "cd", "f1",
  ...extra,
];

interface Harness {
  deps: SocketSnapshotDeps;
  emitted: string[];
  runs: string[];
  args: Record<string, string[]>;
  scheduled: number;
  clock: { t: number };
}
const harness = (o: Partial<SocketSnapshotDeps> & { lsof?: string[]; lsofStatus?: LineRunStatus } = {}): Harness => {
  const h: Harness = { deps: undefined as never, emitted: [], runs: [], args: {}, scheduled: 0, clock: { t: 1_000_000 } };
  h.deps = {
    now: () => h.clock.t,
    platform: "darwin",
    pid: SELF,
    env: {},
    run: async (cmd, args, onLine) => {
      h.runs.push(path.basename(cmd));
      h.args[path.basename(cmd)] = [...args];
      const lines = cmd.endsWith("netstat") ? NETSTAT : (o.lsof ?? lsofLines());
      for (const l of lines) onLine(l);
      return cmd.endsWith("lsof") && o.lsofStatus !== undefined ? o.lsofStatus : { kind: "ok" };
    },
    emit: (l) => h.emitted.push(l),
    resources: () => ["TCPSocketWrap", "TCPSocketWrap", "TCPServerWrap", "Timeout"],
    schedule: (fn) => {
      h.scheduled += 1;
      setImmediate(fn);
    },
    limits: { timeoutMs: 1000, maxBytes: 1 << 20 },
    ...o,
  };
  return h;
};

const node = process.execPath;
/**
 * 실제 러너를 **시한 안에서** 돌린다 — 러너가 안 돌아오면(시한 변이) 스위트를 매달지 말고 실패로 보고하고,
 * 자식(첫 줄에 자기 pid 를 찍는다)을 직접 치운다(실측: 시한을 뺀 변이에서 스위트가 끝나지 않았고 고아 자식이 남았다).
 */
const runBounded = async (
  script: string,
  onLine: (l: string) => void,
  limits: LineRunLimits,
): Promise<{ st: LineRunStatus | "hung"; pid: number }> => {
  let pid = 0;
  const r = await within(
    8_000,
    "러너",
    runCountingLines(node, ["-e", script], (l) => {
      if (pid === 0 && /^\d+$/.test(l)) pid = Number(l);
      else onLine(l);
    }, limits),
  );
  if (!("value" in r)) {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 이미 없으면 됐다 */
      }
    }
    return { st: "hung", pid };
  }
  return { st: r.value, pid };
};
const HANG = "console.log(process.pid); setInterval(() => {}, 1000)";
const pidDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as { code?: string }).code === "ESRCH";
  }
};

export const check: RegressionCheck = {
  name: "socket-snapshot-on-addrnotavail",
  // ★이 문구에 오류 코드 낱말을 그대로 쓰지 않는다 — `crash-log-lands` 가 러너 프로세스에서 실제 로그 관문을 켜므로,
  //  러너가 이 줄을 찍는 순간 러너 자신의 수집이 돈다(실측: 부분 실행에서 한 줄 나왔다).
  guards:
    "10/30 두 데몬의 외부·루프백 연결이 «주소 할당 불가» 로 실패했는데 재부팅으로 당시 소켓 상태가 사라져 원인을 좁힐 수 없던 것 — 재발 때 한 번 기록",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── 집계 ─────────────────────────────────────────────────────────────
    {
      const h = harness();
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      const line = h.emitted[0] ?? "";
      out.push(
        assert(
          "TCP 상태별 수·합계(udp·머리줄 제외)",
          /TIME_WAIT=2/.test(line) && /ESTABLISHED=1/.test(line) && /LISTEN=1/.test(line) && /합계 4\b/.test(line),
          line.slice(0, 300),
        ),
        assert(`이 데몬(pid ${SELF}) TCP fd 수가 따로 있다`, line.includes(`이 데몬(pid ${SELF}) TCP fd 2`), line),
        assert(
          "상위 5개만 · 이름은 정리됨(공백·#·=·제어문자 → _)",
          /node#100=3/.test(line) && /bad_name_x_y_#7=1/.test(line) && (line.match(/#\d+=\d+/g) ?? []).length === 5 && /프로세스 7개/.test(line),
          line,
        ),
        assert("★출력에 주소·포트 모양이 없다", !ADDR.test(line) && !/\.3020|\.52344/.test(line), line),
        assert(
          "이벤트 루프 보조 지표는 이름이 따로다",
          line.includes("이벤트 루프를 붙든 TCP 자원: TCPSocketWrap=2 TCPServerWrap=1"),
          line,
        ),
        assert("명령은 netstat → lsof 하나씩", h.runs.join(",") === "netstat,lsof", h.runs),
        assert(
          "★요청 인자: 이름 조회 없음(netstat -n · lsof -nP) · lsof 는 PID·이름 필드만(-F pc — 주소 필드 n 미요청)",
          (h.args.netstat ?? []).join(" ") === "-an -p tcp" && (h.args.lsof ?? []).join(" ") === "-nP -w -iTCP -F pc",
          h.args,
        ),
      );
    }
    {
      // ★자기 PID 가 PID 표 상한(5,000) 뒤에 와도 빠지지 않는다.
      const many: string[] = [];
      for (let p = 20_000; p < 25_100; p += 1) many.push(`p${p}`, "cx", "f1");
      const h = harness({ lsof: [...many, `p${SELF}`, "cnode", "f1", "f2", "f3"] });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      const line = h.emitted[0] ?? "";
      out.push(
        assert(
          "★다른 PID 5,000개 뒤의 자기 fd 수 보존 · 상한 밖은 따로 표기",
          line.includes(`TCP fd 3`) && /상한 밖 fd \d+/.test(line),
          line.slice(0, 400),
        ),
      );
    }
    {
      const h = harness({ lsofStatus: { kind: "timeout", ms: 5000 } });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      const line = h.emitted[0] ?? "";
      out.push(
        assert(
          "lsof 가 시한에 걸리면 자기 수치 바로 뒤에 «부분 집계»",
          new RegExp(`TCP fd 2 \\(lsof 부분 집계 — 시한 5초 초과\\)`).test(line),
          line,
        ),
      );
    }

    // ── 정책 ─────────────────────────────────────────────────────────────
    {
      // 무관한 줄만 — 예약·실행·출력 모두 0 (뒤에 오는 트리거의 running 가드에 기대지 않게 따로 본다).
      const h = harness();
      const s = createSocketSnapshot(h.deps);
      for (const l of ["평범한 오류 ECONNREFUSED", "fetch failed", "EADDRINUSE 포트 사용 중", ""]) s.note(l);
      await new Promise((r) => setImmediate(r));
      await s.whenIdle();
      out.push(assert("★무관한 줄은 예약·실행·출력 0", h.scheduled === 0 && h.runs.length === 0 && h.emitted.length === 0, { scheduled: h.scheduled, runs: h.runs, emitted: h.emitted.length }));
    }
    {
      const h = harness();
      const s = createSocketSnapshot(h.deps);
      for (let i = 0; i < 50; i += 1) s.note(TRIG);
      const scheduledSameTick = h.scheduled;
      s.note(TRIG); // 수집 중
      await s.whenIdle();
      const afterFirst = h.emitted.length;
      h.clock.t += 60 * 60 * 1000; // 1h — 같은 사건
      s.note(TRIG);
      await s.whenIdle();
      const inWindow = h.emitted.length;
      h.clock.t += SOCKET_SNAPSHOT_WINDOW_MS; // 창 밖 → 사건 2
      s.note(TRIG);
      await s.whenIdle();
      h.clock.t += SOCKET_SNAPSHOT_WINDOW_MS; // 사건 3
      s.note(TRIG);
      await s.whenIdle();
      h.clock.t += SOCKET_SNAPSHOT_WINDOW_MS; // 상한
      s.note(TRIG);
      await s.whenIdle();
      out.push(
        assert("같은 차례 50줄 → 예약 1", scheduledSameTick === 1, { scheduledSameTick }),
        assert("수집 중 반복은 추가 수집 0", afterFirst === 1, { afterFirst }),
        assert("★24시간 창 안 관측은 같은 사건 → 0", inWindow === 1, { inWindow }),
        assert(
          "창 밖은 새 사건 · 프로세스당 3사건 · 3번째에 «마지막 기록»",
          h.emitted.length === 3 && /사건 2\/3/.test(h.emitted[1] ?? "") && /사건 3\/3 .*마지막 기록/.test(h.emitted[2] ?? ""),
          h.emitted.map((l) => l.slice(0, 80)),
        ),
      );
    }
    {
      const h = harness({ env: { TIGUCLAW_SOCKET_SNAPSHOT: "0" } });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      out.push(assert("TIGUCLAW_SOCKET_SNAPSHOT=0 이면 수집 0", h.scheduled === 0 && h.runs.length === 0, h));
    }
    {
      // ★재진입: 출력 줄도 관문을 지나 note 로 돌아온다(EADDRNOTAVAIL 이 들어 있다). 그때 창이 지난 시계여도 다시 수집하지 않는다.
      const h = harness();
      const s = createSocketSnapshot({
        ...h.deps,
        emit: (l) => {
          h.emitted.push(l);
          h.clock.t += SOCKET_SNAPSHOT_WINDOW_MS * 2;
          s.note(l);
        },
      });
      s.note(TRIG);
      await s.whenIdle();
      await new Promise((r) => setImmediate(r));
      await s.whenIdle();
      out.push(assert("★자기 출력 줄이 자기 수집을 다시 부르지 않는다", h.emitted.length === 1 && h.scheduled === 1, { emitted: h.emitted.length, scheduled: h.scheduled }));
    }
    {
      const h = harness({
        run: async () => {
          throw new Error("boom");
        },
      });
      const s = createSocketSnapshot(h.deps);
      let threw = false;
      try {
        s.note(TRIG);
      } catch {
        threw = true;
      }
      await s.whenIdle();
      out.push(
        assert("수집이 던져도 note 는 안 던지고 «기록 실패» 한 줄", !threw && h.emitted.length === 1 && /기록 실패/.test(h.emitted[0] ?? ""), h.emitted),
      );
    }
    {
      const h = harness({
        run: async (cmd) => {
          h.runs.push(path.basename(cmd));
          return { kind: "spawn-error", code: "EMFILE" };
        },
      });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      const line = h.emitted[0] ?? "";
      out.push(
        assert(
          "실행 실패는 «미확인» 으로 정직하게(0 으로 쓰지 않는다)",
          /TCP 상태: 미확인 \(netstat 실행 실패 EMFILE\)/.test(line) && /TCP fd 미확인 \(lsof 실행 실패 EMFILE\)/.test(line),
          line,
        ),
      );
    }
    {
      const h = harness({ platform: "win32" });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      out.push(
        assert(
          "macOS 밖은 시스템 명령 0회 · «미지원» · 보조 지표만",
          h.runs.length === 0 && /이 플랫폼\(win32\) 미지원/.test(h.emitted[0] ?? "") && /TCPSocketWrap=2/.test(h.emitted[0] ?? ""),
          { runs: h.runs, line: h.emitted[0] },
        ),
      );
    }

    // ── 실제 러너 경계 ────────────────────────────────────────────────────
    {
      const t0 = Date.now();
      const { st, pid } = await runBounded(HANG, () => {}, { timeoutMs: 300, maxBytes: 1 << 20 });
      out.push(
        assert(
          "★끝나지 않는 자식 → 시한에 죽고 «timeout» · 돌아온 때 이미 죽어 있다",
          st !== "hung" && st.kind === "timeout" && Date.now() - t0 < 4000 && pid > 0 && pidDead(pid),
          { st, ms: Date.now() - t0, pid, dead: pid > 0 && pidDead(pid) },
        ),
      );
    }
    {
      const lines: string[] = [];
      let longest = 0;
      const { st, pid } = await runBounded(
        "console.log(process.pid); const s = 'x'.repeat(65535) + '\\n'; setInterval(() => process.stdout.write(s), 1)",
        (l) => {
          lines.push(l.slice(0, 16));
          longest = Math.max(longest, l.length);
        },
        { timeoutMs: 6_000, maxBytes: 300_000 },
      );
      out.push(
        assert(
          "★출력 상한을 넘으면 죽이고 «overflow» · 돌아온 때 이미 죽어 있다 · 받은 것은 줄 조각뿐",
          st !== "hung" && st.kind === "overflow" && pid > 0 && pidDead(pid) && longest <= 65535 && lines.length <= 5,
          { st, pid, lines: lines.length, longest },
        ),
      );
    }
    {
      const lines: string[] = [];
      const st = await runCountingLines(
        node,
        ["-e", "process.stdout.write('가나\\nb\\n'); process.stdout.write(Object.keys(process.env).sort().join(','))"],
        (l) => lines.push(l),
        { timeoutMs: 5000, maxBytes: 1 << 20 },
      );
      const envKeys = (lines[2] ?? "").split(",");
      out.push(
        assert("줄 단위 전달 · 끝 줄(개행 없음)도 전달 · 정상 종료는 ok", st.kind === "ok" && lines[0] === "가나" && lines[1] === "b" && lines.length === 3, { st, lines: lines.slice(0, 2) }),
        assert(
          "★자식 env 는 최소(PATH·LC_ALL) — 데몬 env(홈·토큰)를 넘기지 않는다",
          envKeys.includes("PATH") && envKeys.includes("LC_ALL") && !envKeys.includes("TIGUCLAW_HOME") && !envKeys.includes("HOME"),
          envKeys,
        ),
      );
    }
    {
      const st = await runCountingLines("/nonexistent/socket-snapshot-cmd", [], () => {}, { timeoutMs: 1000, maxBytes: 1000 });
      out.push(assert("없는 명령은 던지지 않고 «spawn-error»", st.kind === "spawn-error" && st.code === "ENOENT", st));
    }
    {
      // ★두 명령의 실행 구간이 겹치지 않는다 — 실제 러너 + 실제 수집 순서.
      const spans: Array<{ start: number; end: number; pid: number; deadAtEnd: boolean }> = [];
      const h = harness({
        run: async (_cmd, _args, onLine, limits) => {
          const start = Date.now();
          const { st, pid } = await runBounded(HANG, onLine, { ...limits, timeoutMs: 250 });
          spans.push({ start, end: Date.now(), pid, deadAtEnd: pid > 0 && pidDead(pid) });
          return st === "hung" ? { kind: "exit", code: -1 } : st;
        },
      });
      const s = createSocketSnapshot(h.deps);
      s.note(TRIG);
      await s.whenIdle();
      out.push(
        assert(
          "★명령은 하나씩 — 두 번째는 첫 자식이 죽은 뒤에 시작",
          spans.length === 2 && spans[0]!.deadAtEnd && spans[1]!.start >= spans[0]!.end && spans[1]!.deadAtEnd && /netstat 부분 집계 — 시한/.test(h.emitted[0] ?? ""),
          { spans, line: (h.emitted[0] ?? "").slice(0, 200) },
        ),
      );
    }

    {
      // ★부모가 먼저 끝나도 진단 자식이 남지 않는다 — 시한 타이머는 부모와 함께 사라지므로 exit 훅이 치운다.
      const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_socket-snapshot-child.ts");
      const r = await spawnWithin(30_000, "러너 중 종료 자식", ["--import", "tsx", child, "--exit-during-run"], { env: process.env });
      const gpid = Number((r.out.match(/GRANDCHILD=(\d+)/) ?? [])[1] ?? 0);
      await new Promise((res) => setTimeout(res, 400));
      const dead = gpid > 0 && pidDead(gpid);
      if (gpid > 0 && !dead) {
        try {
          process.kill(gpid, "SIGKILL"); // 검사가 고아를 남기지 않는다
        } catch {
          /* 없음 */
        }
      }
      out.push(assert("★러너 도중 부모가 exit → 손자(진단 명령)도 죽는다", !r.timedOut && gpid > 0 && dead, { gpid, dead, timedOut: r.timedOut, err: r.err.slice(0, 200) }));
    }

    // ── 실제 로그 관문 배선(자식 프로세스) ────────────────────────────────
    {
      const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_socket-snapshot-child.ts");
      const r = await spawnWithin(60_000, "소켓 스냅샷 관문 자식", ["--import", "tsx", child], { env: process.env });
      const logPath = (r.out.match(/LOGFILE=(.+)/) ?? [])[1]?.trim() ?? "";
      const text = logPath === "" ? "" : await readFile(logPath, "utf8").catch(() => "");
      const lines = text.split("\n");
      const snaps = lines.filter((l) => l.includes("[socket-snapshot]"));
      const snap = snaps[0] ?? "";
      const idx = (needle: string): number => lines.findIndex((l) => l.includes(needle));
      out.push(
        assert("자식이 로그 파일을 남겼다(검사 전제)", text !== "" && !r.timedOut, { logPath, timedOut: r.timedOut, err: r.err.slice(0, 300) }),
        assert("★실제 관문: 오류 전의 평범한 줄·다른 연결 오류는 수집을 시작하지 않는다", /SNAPS_BEFORE_ERROR=0\b/.test(r.out), (r.out.match(/SNAPS_BEFORE_ERROR=\S*/) ?? ["없음"])[0]),
        assert(
          "원래 오류 줄은 그대로 · 그 뒤 로그도 계속 기록",
          lines.filter((l) => l.includes("[error] [regression] fetch failed ← EADDRNOTAVAIL")).length === 6 && idx("after-error-1") > idx("[error] [regression] fetch failed ← EADDRNOTAVAIL") && idx("after-error-2") > 0,
          { errors: lines.filter((l) => l.includes("[error] [regression]")).length },
        ),
        assert("★관문을 지난 EADDRNOTAVAIL → [socket-snapshot] 정확히 한 줄(몰림·창 안 재발에도)", snaps.length === 1, { n: snaps.length }),
        assert("기록 줄은 warn 이고 주소·포트 모양이 없다", /\] \[warn\] \[socket-snapshot\]/.test(snap) && !ADDR.test(snap), snap.slice(0, 400)),
        process.platform === "darwin"
          ? assert(
              "macOS: 실제 netstat/lsof 로 상태·자기 fd 를 남겼다",
              /TCP 상태\(시스템 전체\): .*합계 \d+/.test(snap) && /이 데몬\(pid \d+\) TCP fd \d+/.test(snap),
              snap.slice(0, 400),
            )
          : assert("macOS 밖: «미지원» 을 정직하게", /미지원/.test(snap), snap.slice(0, 200)),
      );
    }
    return out;
  },
};
