/**
 * 영역 A V5.5+V5.6+V5.7+V5.9 + β — file-ops MCP server (in-process, codex 어댑터 전용).
 *
 * 진실 소스:
 *  - V5.5 (Read/Glob/Grep): `docs/decisions/2026-05-23-region-a-v55-codex-file-ops.md`
 *  - V5.6 (Write/Edit): 본 코드 + 라이브 검증 — 메인 ADR 후속 작성.
 *  - V5.7 (Bash): `docs/decisions/2026-05-23-region-a-v57-codex-bash.md`
 *  - V5.9 (WebFetch): `docs/decisions/2026-05-23-region-a-v59-codex-webfetch.md`
 *  - V7.8 (invoke_skill 분리): `skill-registry.skillInvokeMcpServer` 단일 정의로
 *    통일 — file-ops 는 파일·셸·웹 본연만 (정의 2곳 중복 부채 해소).
 *  - β (2026-05-25, 파일 접근 모델): `_workspace/beta_fileaccess_build_plan.md`.
 *    하드 기술 벽 제거 + cwd=home + LLM parity + prompt-gated 보안.
 *  - P3-3b (2026-07-07, 프로젝트 cwd parity): `docs/decisions/2026-07-06-projects-feature.md` §3b.
 *    팩토리에 baseCwd 주입 — 상대경로 기준점을 home 고정이 아니라 **턴 cwd**(프로젝트)로.
 *    codex 를 claude(SDK builtin options.cwd 반영)와 대칭화 → #2 어댑터 parity 회복.
 *    벽 아님(절대경로 무변) — 바뀌는 건 상대경로 기준점뿐. 미주입 시 home(회귀 0).
 *
 * β 보안 모델 (사용자 확정 2026-05-25 — 하드 벽 제거 승인):
 *  - **기술 벽 없음.** SYSTEM.md §1 "기술적 차단(canUseTool·hook·validator) 박지 X.
 *    가드는 sysprompt·룰 차원" 정합. 기존 `ensureInsideCwd` throw 는 그 §1 을 위반한
 *    anomaly 였고 β 가 제거 = 헌법 복귀. claude 어댑터(bypassPermissions, 가드 0)와
 *    이미 무벽이던 것과 대칭화 (LLM parity).
 *  - 경로 해소: 상대경로는 `baseCwd`(미주입 시 `getPaths().home`) 기준 절대화, 절대경로는
 *    그대로 허용 (home/프로젝트 밖도 거부 0 = 만능 비서). symlink escape 가드 제거.
 *  - 유일 보안 가드 = **prompt 레벨** (SYSTEM.md §1 사전승인·확인트리거 +
 *    `_shared-sysprompt.ts` 위험-경로 명시). 자격증명·시스템·자기 코어·DB·home 밖
 *    R/W 는 비서가 실행 전 사용자 확인 (prompt-gated).
 *
 * 정책 게이트 (사용자 결정 고정):
 *  - codex 어댑터에만 등록. claude 어댑터는 SDK builtin Read/Glob/Grep/Write/Edit/Bash/WebFetch 그대로 사용 (회귀 0).
 *  - V5.5 = 읽기 전용 3 종 (Read / Glob / Grep).
 *  - V5.6 = 쓰기 2 종 (Write / Edit).
 *  - V5.7 = Bash 1 종.
 *  - V5.9 = WebFetch 1 종.
 *  - `createSdkMcpServer` + `tool` (memoryMcpServer 패턴 답습) — 별 프로세스 0,
 *    schema 자연 노출, `_mcp-bridge.ts` 의 `adaptClaudeMcpServer` 그대로 회수.
 *
 * 동작 가드 (벽 아닌 — UX·payload 보호):
 *  - 경로 해소: 상대경로 → baseCwd 기준, 절대경로 → 그대로 (검증·throw 0).
 *  - Read: 디폴트 limit 2000 라인 (Claude Code Read 도구 동등).
 *  - Glob/Grep: base 미지정 시 baseCwd(턴 cwd 또는 home).
 *  - Write: 디렉터리 부재 시 `fs.mkdir({recursive:true})` 자동 생성.
 *  - Edit: `old_string` 0/다수 매칭 시 명확 에러 (`replace_all=false` 디폴트).
 *  - Bash: `execFile(SHELL.bin, SHELL.argsFor(cmd), {cwd: baseCwd, timeout, maxBuffer})`
 *    — `detectShell()`(runtime-env.ts) 단일 소스. unix="sh -c", win32="cmd /c"
 *    (env 블록의 Shell 힌트와 동일 함수 — 계약 `env-awareness_architect_contract.md`).
 *    timeout 디폴트 120s / max 600s (초과 시 clamp). maxBuffer 1MB (stdout/stderr 각).
 *    초과 시 truncate marker 박음. `DISALLOWED_TOOLS` pre-check (현재 빈 배열, 정책 진실 소스 1개 박기).
 *  - 위험 명령·위험 경로 차단은 *LLM 측 정책* (sysprompt prompt-gated). MCP server
 *    본체는 DISALLOWED_TOOLS/DISALLOWED_URLS 만 차단 (정책 진실 소스 hook) — 경로 벽 0.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { findRipgrep, forgetRipgrep, rgBinName } from "../../ripgrep.js";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { DISALLOWED_TOOLS, DISALLOWED_URLS } from "../../../auth/permissions.js";
import { getPaths } from "../../paths.js";
import { loadWebSearchConfig } from "../../settings.js";
import { detectShell } from "../../runtime-env.js";
import { getEventBus } from "../../eventbus.js";
// 셸의 원 세션 환원 — 워커·서브가 띄운 셸은 threadKey 가 잡 좌표(worker:/agent:)라 세션 키가
// 아니다. 잡 레지스트리를 보는 코어가 환원해서 관측면에 실어 준다(대시보드 추측 제거).
import { resolveOwnerThreadKey } from "../../worker-jobs.js";
import {
  insertBgShell as insertBgShellDb,
  markBgShellStatus as markBgShellStatusDb,
  updateBgShellStartedLabel as updateBgShellStartedLabelDb,
  listRunningBgShells as listRunningBgShellsDb,
  pruneTerminalBgShells as pruneTerminalBgShellsDb,
  type BgShellStatus,
} from "../../../store/bg-shells.js";

const execFileP = promisify(execFile);

// 셸 선택 — env 블록(runtime-env.ts formatEnvContext)의 Shell 힌트와 단일 소스
// (계약 §0 핵심통찰: 모델이 뱉는 문법 = 도구가 실행하는 셸 = 항상 일치). 모듈 로드
// 1회 호출(불변) — RG_PATH 패턴과 동형. unix 는 {bin:"sh", argsFor:["-c",cmd]} 라
// 아래 fg/bg 배선이 기존 하드코딩과 인자 바이트 동일(회귀 0).
const SHELL = detectShell();

// ─── ripgrep 해소 ────────────────────────────────────────────────────────
// ★해소도 기억도 **`core/ripgrep.ts` 가 전부 소유한다** (2026-08-09 적대 검토 4R).
//  종전엔 여기에도 memo(`rgResolved`)가 있었는데, **층이 둘이면 위층에 캐시를 얹는 것만으로
//  아래층 검사가 통째로 무의미해진다**(실제 변이가 그렇게 통과했다: ENOENT 뒤 "없는 게
//  확인됐으니 재탐색 생략" 이라는 그럴듯한 최적화 한 줄). 소유자를 하나로 두면 그 층이 없다.
//  비용: 캐시 적중은 Set 조회 + `existsSync` 한 번(실측 0.21ms/호출) — 무시 가능.
const rgPath = (): string => findRipgrep(getPaths().home) ?? rgBinName();

const okText = (
  text: string,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text }],
});

const errText = (
  msg: string,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: `Error: ${msg}` }],
});

// ─── 공용 상수 ───────────────────────────────────────────────────────────
const DEFAULT_READ_LIMIT = 2000;
const READ_BODY_HARD_CAP = 1_000_000; // 1MB — payload 폭주 방어.
/** 비전 채널로 인라인할 이미지 최대 크기. 넘으면 읽지 않고 사실을 말한다. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * **매직 바이트로** 이미지를 판정한다 (2026-08-01).
 *
 * ★확장자가 아니라 내용으로 보는 이유: 확장자는 이름 열거고 틀릴 수 있다. 우리가 답을
 *  바꾸는 근거는 "이 바이트가 이미지인가" 지 "이름이 .jpg 로 끝나는가" 가 아니다.
 */
const sniffImageMime = (head: Buffer): string | null => {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 8 && head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (head.length >= 6 && head.subarray(0, 6).toString("latin1").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
};
/**
 * **텍스트가 아닌가**를 내용으로 판정한다 (2026-08-10).
 *
 * ★왜 필요한가: 이미지 분기를 뺀 나머지는 전부 `readFile(utf8)` 이었다. APK·실행파일·
 *  zip·폰트 무엇이든 **깨진 글자 덩어리를 "성공"으로** 돌려줬다. 그게 이 레포가 이미
 *  한 번 크게 데인 모양이다 — 2026-08-01 JPEG 사고 주석이 바로 위에 있다("모델은 판독
 *  불가라 답하는데 호출한 앱은 정상 응답으로 받아 캐시에 저장했다 — 사흘간 캐시 오염").
 *  그때는 **이미지만** 고쳤고 나머지 바이너리는 구멍이 그대로였다.
 *
 * ★문제는 "못 다룬다" 가 아니라 **"막혔다는 걸 모른다"** 다. Bash 라는 만능 우회로가
 *  있어서 능력은 충분한데, 판독 실패가 실패로 보고되지 않으면 그 우회로로 갈 계기가
 *  안 생긴다. 그래서 여기서 하는 일은 **사실을 말하는 것**이 전부다.
 *
 * 판정 = ①NUL 바이트가 있으면 텍스트가 아니다(UTF-8 텍스트엔 안 나온다) ②U+FFFD
 *  (디코딩 실패 대체문자) 비율이 높으면 아니다. 확장자는 보지 않는다 — 위 sniffImage 와
 *  같은 이유다(우리가 답을 바꾸는 근거는 내용이지 이름이 아니다).
 */
const BINARY_SNIFF_BYTES = 8192;
const BINARY_REPLACEMENT_RATIO = 0.1;
export const looksBinary = (head: Buffer): boolean => {
  if (head.length === 0) return false; // 빈 파일은 텍스트로 본다(기존 동작).
  if (head.includes(0)) return true;
  const decoded = head.toString("utf8");
  if (decoded.length === 0) return false;
  let bad = 0;
  for (const ch of decoded) if (ch === "\uFFFD") bad += 1;
  return bad / decoded.length > BINARY_REPLACEMENT_RATIO;
};

/** 사람이 읽는 크기 — 진단 수치는 항상 같이 남긴다. */
const humanBytes = (n: number): string =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)}MB`
    : n >= 1024
      ? `${Math.round(n / 1024)}KB`
      : `${n}B`;

const GLOB_MAX_RESULTS = 1000;
const GLOB_MAX_BUFFER = 10 * 1024 * 1024;
const GREP_MAX_LINES = 1000;
const GREP_MAX_BUFFER = 10 * 1024 * 1024; // 10MB stdout cap.
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const BASH_MAX_BUFFER_BYTES = 1_048_576;
const BASH_TRUNCATE_MARKER = "\n… [truncated at 1MB]";

const truncateBashOutput = (raw: string): string => {
  // execFile 의 maxBuffer 는 byte 기준. raw 는 이미 UTF-8 decoded string.
  // 안전하게 utf8 byte 길이로 재검사.
  const buf = Buffer.from(raw, "utf8");
  if (buf.length <= BASH_MAX_BUFFER_BYTES) return raw;
  return `${buf.subarray(0, BASH_MAX_BUFFER_BYTES).toString("utf8")}${BASH_TRUNCATE_MARKER}`;
};

// ── 백그라운드 Bash (run_in_background + BashOutput + KillShell) ──────────────
// Claude Code parity(#1) — claude 어댑터는 SDK 빌트인 Bash 가 이 기능을 이미 제공.
// codex/openai 어댑터는 이 file-ops Bash 를 쓰므로 여기서 채워 #2 parity 회복. claude
// 어댑터는 이 모듈을 아예 안 로드하므로(§ 정책 게이트: codex 전용 등록) 아래 detached·
// killTree·bg_shells 영속·reaper 전부 claude 무영향 — SDK 가 자체 소유하는 claude 셸은
// 이 파일 밖(ADR `2026-07-17-background-shell-observability.md` §6, Phase 4 후행 과제).
//
// ★모듈 레지스트리 = 턴을 가로질러 생존(worker-jobs 패턴 동형, in-memory·best-effort).
//   file-ops 팩토리가 턴마다 새 인스턴스여도(baseCwd 주입, McpServer transport 격리)
//   BG_SHELLS 는 모듈 레벨이라 유지 → BashOutput/KillShell 회귀 0.
//
// ★고아 정확성(Unit 1 Phase 0+1, 2026-07-17) — 이전엔 non-detached spawn 이라 데몬
// 프로세스그룹에 얹혀, graceful 종료·KillShell 이 셸 래퍼 단일 PID 만 죽이고 조용한
// (stdout 무출력) 손자 프로세스가 고아로 생존할 수 있었다. 지금은:
//  - detached:true(POSIX setsid) — child 가 새 프로세스그룹 리더(pgid===pid). unref() 는
//    하지 않는다(추적·킬·exit 이벤트 유지 필요, 데몬이 핸들 보유).
//  - killTree(pgid, signal) — POSIX `process.kill(-pgid, sig)`(그룹 전체=셸+손자),
//    win32 `taskkill /PID <pid> /T /F`(트리 kill). KillShell·killAllBgShells·부팅
//    reaper 가 전부 이 단일 헬퍼로 수렴(정확성+단순성, ADR §3).
//  - detached 의 유일 손실(`daemon:restart` kickstart -k 시 잡그룹 이탈)은 bg_shells
//    영속 + 부팅 reaper(reapPreviousGeneration)가 벌충 — P0/P1 은 함께 간다(ADR §3-3).
interface BgShell {
  child: ReturnType<typeof spawn>;
  pgid: number; // detached=true → child 가 그룹 리더 → pgid === child.pid.
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  stdoutRead: number; // BashOutput 이 이미 반환한 offset (증분 폴링).
  stderrRead: number;
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  startedAt: number;
  // 어느 대화 턴이 이 셸을 띄웠나 (ADR §1 shell.started.threadKey). 팩토리/Bash 도구가
  // 전파 안 하면 "" 폴백(회귀 0) — 대시보드 관측용, 실행/추적 로직엔 영향 0.
  threadKey: string;
}
const BG_SHELLS = new Map<string, BgShell>();
const BG_MAX = 20; // 동시 백그라운드 셸 상한(메모리 바운드).

// 터미널(비-running) bg_shells DB 행 캡 — worker_jobs TERMINAL_WORKER_JOB_KEEP 동형
// (저volume: 백그라운드 명령당 1행). running 은 캡 대상 아님(reaper 소스 보존).
const TERMINAL_BG_SHELL_KEEP = 500;

// 버퍼 append — 1MB cap 도달 후엔 더 안 쌓는다(메모리 바운드 + offset 보존).
const appendCapped = (cur: string, chunk: string): string => {
  if (cur.length >= BASH_MAX_BUFFER_BYTES) return cur;
  const next = cur + chunk;
  return next.length > BASH_MAX_BUFFER_BYTES
    ? next.slice(0, BASH_MAX_BUFFER_BYTES) + BASH_TRUNCATE_MARKER
    : next;
};

// ─── DB 미러(bg_shells) — best-effort, 영속 실패가 셸 실행을 무르지 않는다 ─────────
// worker-jobs.ts `persistSafe` 동형. 런타임 진실은 위 BG_SHELLS Map — DB 는 재시작
// 생존(부팅 reaper 신원검증 소스)만 담당.
const persistBgShellSafe = (label: string, fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`bg-shells: DB 미러 실패(${label}): ${reason}`);
  }
};

// ─── shell.* 라이프사이클 이벤트 (ADR 2026-07-17 Phase 2 §1) ───────────────────
// worker-jobs.ts `publishWorkerLifecycle` 동형 — best-effort try-catch(발행 실패가
// 셸 실행을 무르지 않는다, persistBgShellSafe 동형). 셸은 상태공간이 단순(running→
// exited(code)|killed)이라 2종만: shell.started(등록 시)·shell.exited(자연종료/kill 시).
// §0 단방향: 코어(file-ops-mcp)가 generic type 을 버스에 발행 — 대시보드 이름 참조 0.
const publishShellEventSafe = (
  type: "shell.started" | "shell.exited",
  payload: Record<string, unknown>,
): void => {
  try {
    getEventBus().publish({ type, ts: Date.now(), payload });
  } catch {
    /* noop — 관측 발행 실패가 셸을 무르지 않는다. */
  }
};

/**
 * 프로세스 신원 스냅샷 — 부팅 reaper 의 PID 재사용 봉쇄용(ADR §4). launch 직후와
 * 부팅 reap 시 같은 pid 를 조회해 문자열 동일성으로 "같은 프로세스"를 판정한다.
 *  - POSIX: `ps -o lstart=,command= -p <pid>` (OS 가 보고하는 정확한 시작시각+커맨드).
 *  - win32: `wmic process where ProcessId=<pid> get CreationDate,CommandLine /value`
 *    (신형 Windows 는 wmic 이 없을 수 있음 — 실패 시 undefined, reaper 는 그 행을
 *    stale 로만 마킹하고 kill 하지 않는다 = 안전측 열화, ADR §4 best-effort 명시).
 * 프로세스 부재·조회 실패는 undefined(호출자가 "신원 불일치"로 취급).
 */
const captureProcessLabel = async (pid: number): Promise<string | undefined> => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileP("wmic", [
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "CreationDate,CommandLine",
        "/value",
      ]);
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    const { stdout } = await execFileP("ps", [
      "-o",
      "lstart=,command=",
      "-p",
      String(pid),
    ]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 손자 포함 프로세스 그룹 전체 종료 — 고아 봉쇄의 유일 신뢰 경로(ADR §3).
 *  - POSIX: `process.kill(-pgid, signal)` — detached(setsid) 로 pgid===pid 인 그룹
 *    리더에 음수 pid 를 주면 커널이 그룹 전체(셸+손자)에 시그널을 보낸다.
 *  - win32: `taskkill /PID <pid> /T /F` — 프로세스 트리 강제 종료(`/T`=tree, `/F`=force).
 * ESRCH(이미 종료)·권한 등은 무해(정리가 목적) — never-throw.
 */
const killTree = async (
  pgid: number,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> => {
  // 방어 — pgid<=1 은 spawn 실패(pid 미할당, 위 launchBgShell 의 -1 fallback)나 손상값.
  // 음수 변환한 process.kill(-1, sig) 은 *시스템 전역* 프로세스 그룹(사실상 전 프로세스)에
  // 시그널을 보내는 위험한 케이스라 반드시 걸러야 한다(never-touch PID 1/그룹 0).
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  if (process.platform === "win32") {
    try {
      await execFileP("taskkill", ["/PID", String(pgid), "/T", "/F"]);
    } catch {
      // 이미 종료·PID 부재 등 — 무해.
    }
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH(이미 종료)·EPERM 등 — 무해.
  }
};

/**
 * 추적 중인 백그라운드 셸을 **동기로** SIGKILL — process.on("exit") 전용.
 *
 * ★왜 별도로 있나 (2026-07-28): killAllBgShells 는 DB 기록·이벤트 발행까지 하는 async
 *  경로라 force-exit(1500ms 백스톱)·크래시 때는 실행될 시간이 없다(실측: /restart 2건에서
 *  종료 시작 2초 뒤 force exit, 자식 정리 로그 없음). 종료 훅은 async 를 못 기다리므로
 *  여기서는 **시그널만** 보낸다 — 장부(DB·이벤트)는 포기하고 프로세스 누수만 막는다.
 *  우선순위가 명확하다: 기록보다 고아 0.
 *  killTree 와 같은 pgid<=1 방어(전역 그룹 시그널 금지)를 그대로 지킨다.
 */
let bgShellExitHookInstalled = false;
/** 최후 그물 등록(1회) — 첫 셸을 띄울 때 건다. 자식이 없는 런타임엔 훅도 안 걸린다. */
const ensureBgShellExitHook = (): void => {
  if (bgShellExitHookInstalled) return;
  bgShellExitHookInstalled = true;
  process.on("exit", () => {
    try {
      const n = killAllBgShellsSync();
      // 여기서 남았다는 건 정상 정리(shutdown)를 못 탔다는 뜻 — 진단에 필요하니 남긴다.
      if (n > 0) console.log(`bg-shells: exit 훅 최후 정리 — ${n}건 강제 종료`);
    } catch {
      /* 종료 중 — 더 할 수 있는 게 없다 */
    }
  });
};

/** 실행 중인 **포그라운드** 셸의 그룹장 pid — detached 로 띄우므로 최후 그물이 필요하다.
 *  정상 종료(성공·실패·타임아웃) 시 cleanupExec 가 즉시 뺀다 = 평시엔 거의 비어 있다. */
const FOREGROUND_SHELL_PIDS = new Set<number>();

export const killAllBgShellsSync = (): number => {
  let killed = 0;
  for (const pgid of FOREGROUND_SHELL_PIDS) {
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-pgid, "SIGKILL");
      }
      killed += 1;
    } catch {
      /* 이미 종료 */
    }
  }
  FOREGROUND_SHELL_PIDS.clear();
  for (const [, s] of BG_SHELLS) {
    if (s.status !== "running") continue;
    const pgid = s.pgid;
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pgid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-pgid, "SIGKILL");
      }
      killed += 1;
    } catch {
      /* 이미 종료·권한 — 무시 */
    }
  }
  return killed;
};

// baseCwd 주입(3b) — 백그라운드 셸도 턴 cwd 기준으로 실행(포그라운드 Bash 와 대칭).
// threadKey(ADR Phase 2 §1) — 어느 대화 턴이 이 셸을 띄웠나(관측용, 미전파 시 "" 폴백).
const launchBgShell = async (
  command: string,
  cwd: string,
  threadKey: string,
): Promise<string> => {
  // 끝난 셸 하나 정리해 상한 압박 완화(전부 running 이면 그대로 진행 — 20 이면 충분).
  if (BG_SHELLS.size >= BG_MAX) {
    for (const [k, s] of BG_SHELLS) {
      if (s.status !== "running") {
        BG_SHELLS.delete(k);
        break;
      }
    }
  }
  const id = `bash_${randomUUID().slice(0, 8)}`;
  // detached:true(POSIX setsid) — 새 프로세스그룹 리더(pgid===pid). unref() 는 하지
  // 않는다: 데몬이 child 핸들을 계속 들고 stdout/stderr/close 를 추적해야 BashOutput/
  // KillShell 이 정상 동작(unref 는 이벤트루프 이탈만 막을 뿐 추적엔 무관하나, 명시로
  // "추적 유지 의도"를 박아둔다 — ADR §3-1).
  const child = spawn(SHELL.bin, SHELL.argsFor(command), {
    cwd,
    detached: true,
  });
  const pgid = child.pid ?? -1;
  const startedAt = Date.now();
  const shell: BgShell = {
    child,
    pgid,
    command,
    cwd,
    stdout: "",
    stderr: "",
    stdoutRead: 0,
    stderrRead: 0,
    status: "running",
    exitCode: null,
    startedAt,
    threadKey,
  };
  child.stdout?.on("data", (d: Buffer) => {
    shell.stdout = appendCapped(shell.stdout, d.toString("utf8"));
  });
  child.stderr?.on("data", (d: Buffer) => {
    shell.stderr = appendCapped(shell.stderr, d.toString("utf8"));
  });
  // shell.exited 페이로드 — close/error(자연종료) 공용 빌더. status="exited"(kill 경로는
  // killShellById/killAllBgShells 가 별도로 "killed" 를 발행 — 이 핸들러는 status==="running"
  // 가드 덕에 kill 이후엔 실행돼도 no-op 이라 이중발행 0).
  const publishExited = (): void => {
    publishShellEventSafe("shell.exited", {
      shellId: id,
      command: shell.command,
      cwd: shell.cwd,
      status: "exited",
      exitCode: shell.exitCode,
      startedAt: shell.startedAt,
      threadKey: shell.threadKey,
      ownerThreadKey: resolveOwnerThreadKey(shell.threadKey), // 원 세션(잡 좌표 환원).
    });
  };
  child.on("error", () => {
    if (shell.status === "running") {
      shell.status = "completed";
      shell.exitCode = -1;
      persistBgShellSafe("close(error)", () =>
        markShellTerminalDb(id, "completed", shell.exitCode),
      );
      publishExited();
    }
  });
  child.on("close", (code) => {
    if (shell.status === "running") {
      shell.status = "completed";
      shell.exitCode = code ?? 0;
      persistBgShellSafe("close", () =>
        markShellTerminalDb(id, "completed", shell.exitCode),
      );
      publishExited();
    }
  });
  BG_SHELLS.set(id, shell);
  ensureBgShellExitHook(); // 자식이 생겼다 = 최후 그물이 필요하다(1회 등록, 멱등).
  publishShellEventSafe("shell.started", {
    shellId: id,
    command,
    cwd,
    status: "running",
    startedAt,
    threadKey,
    ownerThreadKey: resolveOwnerThreadKey(threadKey), // 원 세션(잡 좌표 환원).
  });
  // DB insert — *동기* 실행(spawn 과 같은 tick). ★레이스 회피: child 의 close/error
  // 이벤트는 libuv 콜백이라 이번 tick 안엔 절대 못 들어온다 — 그래서 이 INSERT 가
  // 항상 close/error 의 UPDATE(markShellTerminalDb)보다 먼저 반영됨을 보장한다(순서
  // 뒤집히면 INSERT OR REPLACE 가 완료 상태를 'running' 으로 덮어써버리는 버그가 된다).
  // best-effort — 실패해도 셸 실행/추적엔 무영향(런타임 진실=BG_SHELLS).
  persistBgShellSafe("insert", () => {
    insertBgShellDb({
      bashId: id,
      pid: pgid,
      pgid,
      command,
      cwd,
      startedAt,
      // startedLabel 은 아래서 비동기 사후 채움(ps 조회가 async라 아직 없음).
    });
  });
  // started_label(신원검증 스냅샷) — spawn 직후 비동기 ps 조회(수 ms) 후 채운다. bash_id
  // 를 즉시 반환하는 "안 막힘" 계약을 지키려 이 조회는 await 하지 않는다(fire-and-forget).
  // status 는 안 건드리는 별도 UPDATE 라 close/error 와 경합해도 안전(무엇을 먼저 실행해도
  // 결과 동일 — 이미 종료된 행에 label 만 채워져도 reaper 는 status='running' 만 보므로 무해).
  void captureProcessLabel(pgid)
    .then((startedLabel) => {
      if (startedLabel === undefined) return;
      persistBgShellSafe("updateStartedLabel", () => {
        updateBgShellStartedLabelDb(id, startedLabel);
      });
    })
    .catch(() => {
      /* 무해 — label 미보유 시 reaper 는 "신원확인 불가"로 stale 처리(안전측). */
    });
  return id;
};

// ─── bg_shells DB 접근 — worker-jobs.ts 정적 import 패턴 동형(store/bg-shells.js,
// 상단 import 블록). 순환 없음(store→core 참조 0, 단방향). ─────────────────────────

/**
 * close/error 전이 시 DB 미러 + 터미널 캡. 없는 bashId 는 no-op(UPDATE 0-row, 무해).
 *
 * ★반드시 동기 함수 — `persistBgShellSafe(label, fn: () => void)` 는 *동기* throw 만
 * try/catch 로 잡는다. 이 함수가 `async` 면 내부 synchronous throw 가 (spec 상) rejected
 * Promise 로 바뀌어 persistBgShellSafe 의 catch 를 그냥 통과해버리고, 호출자가 그 Promise
 * 를 버리므로(void 호출) unhandled rejection 이 된다 — 데몬의 `process.on("unhandledRejection")`
 * 은 *crash-fast* 라 벌한 DB 미러 실패 하나가 데몬 전체를 죽이는 회귀가 된다(실측: 본 함수를
 * async 로 뒀을 때 verify-bg-bash.ts 가 정확히 이 경로로 크래시했다). markBgShellStatusDb·
 * pruneTerminalBgShellsDb 는 better-sqlite3 라 원래 동기 — async 로 감쌀 이유가 없었다.
 */
const markShellTerminalDb = (
  bashId: string,
  status: Exclude<BgShellStatus, "running">,
  exitCode: number | null,
): void => {
  markBgShellStatusDb(bashId, status, { finishedAt: Date.now(), exitCode });
  pruneTerminalBgShellsDb(TERMINAL_BG_SHELL_KEEP);
};

/**
 * 데몬 shutdown 시 백그라운드 Bash 셸 정리 — external-mcp `closeAllExternalMcp` orphan-0
 * 의도 동형(ADR §1e). BG_SHELLS 는 모듈 레벨이라 file-ops 인스턴스와 무관하게 전체 정리.
 *
 * ★Unit 1: killTree(pgid, "SIGTERM") 로 교체 — 셸 래퍼뿐 아니라 손자까지 그룹 종료
 * (이전 단일-PID 부분픽스가 남기던 "조용한 손자 고아" 갭을 닫음). DB 도 'killed' 로
 * 마킹해(best-effort) 이 경로로 정상 종료된 셸을 부팅 reaper 가 다시 건드리지 않게 한다.
 *
 * 커버리지(정직):
 *  - `daemon:restart`(launchctl kickstart -k)=SIGKILL 즉시 → shutdown() 자체가 실행
 *    안 됨(launchd 몫). detached 라 셸이 잡그룹 이탈 가능 → 다음 부팅의
 *    `reapPreviousGeneration()` 이 벌충(P0+P1 동반 설계, ADR §3-3).
 *  - graceful(`/restart`·SIGTERM/SIGINT)=본 함수가 각 running 셸에 killTree(SIGTERM) →
 *    셸+손자 그룹 전체 종료. 레지스트리 정리(추적 소실 방지)까지 수행.
 *  - 데몬 hard kill(kill -9)·전원상실·크래시 = 본 함수 미실행 → 부팅 reaper 가 닫음.
 */
export const killAllBgShells = async (): Promise<void> => {
  const entries = [...BG_SHELLS.entries()];
  await Promise.all(
    entries.map(async ([id, s]) => {
      if (s.status === "running") {
        await killTree(s.pgid, "SIGTERM");
        persistBgShellSafe("killAllBgShells", () => {
          markBgShellStatusDb(id, "killed", {
            finishedAt: Date.now(),
            exitCode: s.exitCode,
          });
        });
        publishShellEventSafe("shell.exited", {
          shellId: id,
          command: s.command,
          cwd: s.cwd,
          status: "killed",
          exitCode: s.exitCode,
          startedAt: s.startedAt,
          threadKey: s.threadKey,
        });
      }
      BG_SHELLS.delete(id);
    }),
  );
};

// ─── 코어 export (ADR 2026-07-17 Phase 2 §B) — http-bridge 가 §0 단방향으로 호출 ──────
// (코어는 http-bridge/대시보드 이름을 참조하지 않는다 — 플러그인이 아래 3개를 가져다 쓴다.)

/** 대시보드 표면 C 라이브 시드용 셸 레코드 shape — listShells 반환 원소. */
export interface BgShellSnapshot {
  shellId: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "killed";
  startedAt: number;
  threadKey: string;
  /** 원 세션 threadKey — threadKey 가 잡 좌표(worker:/agent:)면 환원한 값. 미상은 "". */
  ownerThreadKey: string;
  exitCode: number | null;
}

/**
 * 현재 BG_SHELLS 스냅샷(모듈 레벨 in-memory Map 그대로 복사) — startedAt 내림차순(최신 먼저,
 * listJobs 패턴 동형). running·터미널(completed/killed, 아직 캡에 밀려 안 지워진 것) 전부
 * 포함 — 대시보드 사이드바 뷰가 방금 끝난 셸도 잠시 보여줄 수 있게(worker-jobs 의 "런타임
 * 진실=in-memory Map" 원칙과 동형). http-bridge `GET /shells` 가 그대로 JSON 직렬화.
 */
export const listShells = (): BgShellSnapshot[] =>
  [...BG_SHELLS.entries()]
    .map(([shellId, s]) => ({
      shellId,
      command: s.command,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt,
      threadKey: s.threadKey,
      // 워커·서브가 띄운 셸의 threadKey 는 세션 키가 아니라 잡 좌표 → 서버가 환원해서 준다
      // (잡 레지스트리 전체를 보는 쪽이 authoritative — 대시보드 세션 스코프 판정 근거).
      ownerThreadKey: resolveOwnerThreadKey(s.threadKey),
      exitCode: s.exitCode,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);

// 대시보드 tail 스냅샷 cap — 버퍼 꼬리 마지막 N KB 만 반환(ADR §1 "출력=폴링, 비소비").
const SHELL_TAIL_BYTES = 16 * 1024;

/** utf8 문자열의 마지막 N 바이트만 잘라낸다(byte 경계 — appendCapped 의 truncate 와 동형 사고). */
const tailBytes = (s: string, cap: number): string => {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= cap) return s;
  return buf.subarray(buf.length - cap).toString("utf8");
};

/** tailShell 반환 shape. */
export interface BgShellTail {
  shellId: string;
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 대시보드 라이브 tail(표면 D) — ★비소비 스냅샷. `s.stdoutRead`/`s.stderrRead`(모델
 * BashOutput 의 증분 폴링 offset)를 **절대 건드리지 않는다** — 버퍼 꼬리(마지막 16KB)를
 * 그냥 slice 해 반환할 뿐, 커서를 전진시키지 않는다. 이게 P2 검증 핵심 불변식(ADR §1·검증
 * line 141): 모델 offset 커서와 대시보드 tail 은 완전히 분리된 두 소비자다 — 대시보드
 * 폴링이 모델이 받을 증분 출력을 훔치면 안 된다. 존재하지 않는 shellId 는 undefined.
 */
export const tailShell = (shellId: string): BgShellTail | undefined => {
  const s = BG_SHELLS.get(shellId);
  if (s === undefined) return undefined;
  return {
    shellId,
    status: s.status,
    exitCode: s.exitCode,
    stdout: tailBytes(s.stdout, SHELL_TAIL_BYTES),
    stderr: tailBytes(s.stderr, SHELL_TAIL_BYTES),
  };
};

/**
 * 셸 강제 종료 — killTree(그룹 전체) + status=killed 마킹 + DB 미러 + shell.exited 발행
 * (ADR Phase 2 §B). 모델 대면 `KillShell` 도구와 대시보드 `POST /api/kill-shell`(http-bridge)
 * 이 공유하는 단일 헬퍼(로직 재사용 — 두 경로가 각자 구현 X). 존재하지 않는 shellId·이미
 * 종료된 셸은 무해(변경 0, false 아님 — "요청 자체는 처리됨" 의미로 존재 여부만 반환).
 *
 * @returns true=shellId 존재(이미 종료돼 있었어도), false=그런 shellId 없음.
 */
export const killShellById = async (shellId: string): Promise<boolean> => {
  const s = BG_SHELLS.get(shellId);
  if (s === undefined) return false;
  if (s.status === "running") {
    await killTree(s.pgid, "SIGKILL");
    s.status = "killed";
    persistBgShellSafe("killShellById", () => {
      markBgShellStatusDb(shellId, "killed", {
        finishedAt: Date.now(),
        exitCode: s.exitCode,
      });
    });
    publishShellEventSafe("shell.exited", {
      shellId,
      command: s.command,
      cwd: s.cwd,
      status: "killed",
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      threadKey: s.threadKey,
    });
  }
  return true;
};

/**
 * 부팅 reaper — 이전 세대(재시작 전 데몬)가 띄운 detached 셸 고아를 정리(ADR §4).
 * `recoverInterruptedJobs`(core/worker-jobs.ts) 동형 위치·논리: 갓 부팅한 데몬엔 도는
 * 셸이 없으므로 bg_shells 의 status='running' 잔류 행 = 전부 이전 세대 후보.
 *
 * ★PID 재사용 함정 봉쇄(신원검증 필수) — 맹목 kill 금지. `captureProcessLabel(pid)` 로
 * *지금* 그 PID 의 OS 신원 스냅샷을 다시 뜨고, launch 시 저장해둔 `startedLabel` 과
 * 문자열 동일성 비교. 일치할 때만 killTree(실제로 그 프로세스). 불일치(PID 가 다른
 * 프로세스로 재사용됨)·프로세스 부재(label 조회 실패)·label 미보유(launch 직후 재시작
 * 레이스) 는 전부 status='stale' 로만 마킹하고 **kill 하지 않는다**(무고한 프로세스
 * 오살 0, 안전측 열화).
 *
 * never-throw at boot — 최상위 + 행별 try/catch 이중 격리. 실패는 로그만(데몬 생존).
 */
/**
 * 리퍼가 정리한 셸을 **화면에도 알린다** (2026-08-10).
 *
 * ★사고: 셸이 끝났는데 대시보드가 계속 "실행 중" 으로 보였고, 새로고침하면 사라졌다.
 *  `shell.exited` 는 `child.on("close")` 에서만 발행되는데 그건 **데몬이 그 자식을 들고
 *  있을 때만** 온다. 데몬이 재시작하면 연결이 끊겨 영영 안 오고, 부팅 리퍼는 DB 행만
 *  고치고 **아무에게도 안 알렸다.** 그래서 열려 있던 화면은 죽은 셸을 계속 그렸다
 *  (실측: shell.started 116건 vs shell.exited 106건).
 *
 * ★이 레포가 세 번째 겪는 부류다 — `llm.tool_slow`·`llm.compaction_stuck` 도 "발행은
 *  했는데 소비처가 없음" 이었고, 이번엔 반대로 **소비처는 있는데 발행이 없었다.**
 *  상태를 바꾸는 자리는 그 사실을 말하는 자리이기도 해야 한다.
 *
 * 페이로드는 자연 종료 경로와 **같은 모양**이다 — 소비처(view-shells.js handleShellExited)
 * 가 분기 없이 그대로 처리한다.
 */
const announceReaped = (
  row: { bashId: string; command: string; cwd: string; startedAt: number },
  status: "exited" | "killed",
): void => {
  publishShellEventSafe("shell.exited", {
    shellId: row.bashId,
    command: row.command,
    cwd: row.cwd,
    status,
    exitCode: null,
    startedAt: row.startedAt,
    threadKey: "",
    ownerThreadKey: "",
  });
};

export const reapPreviousGeneration = async (): Promise<void> => {
  let rows: ReturnType<typeof listRunningBgShellsDb>;
  try {
    rows = listRunningBgShellsDb();
  } catch (e) {
    console.error(
      `bg-shells reaper: listRunningBgShells 실패(무해, 부팅 계속): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }
  for (const row of rows) {
    try {
      const nowLabel = await captureProcessLabel(row.pid);
      const identityMatch =
        nowLabel !== undefined &&
        row.startedLabel !== undefined &&
        nowLabel === row.startedLabel;
      if (identityMatch) {
        await killTree(row.pgid, "SIGKILL");
        markBgShellStatusDb(row.bashId, "killed", {
          finishedAt: Date.now(),
          exitCode: null,
        });
        console.log(
          `bg-shells reaper: 이전 세대 고아 killTree(bashId=${row.bashId}, pgid=${row.pgid}).`,
        );
        announceReaped(row, "killed");
      } else {
        // 프로세스 부재 / 신원 불일치(PID 재사용) / label 미보유 — 전부 안전측 stale.
        markBgShellStatusDb(row.bashId, "stale", {
          finishedAt: Date.now(),
          exitCode: null,
        });
        announceReaped(row, "exited");
      }
    } catch (e) {
      console.error(
        `bg-shells reaper: 행 처리 실패(bashId=${row.bashId}, 무해): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  try {
    pruneTerminalBgShellsDb(TERMINAL_BG_SHELL_KEEP);
  } catch {
    // 캡 실패는 무해(무한증가 리스크만, 다음 전이 때 재시도).
  }
};

// ─── WebFetch 상수/헬퍼 (cwd 무관 — 모듈 레벨) ───────────────────────────
const WEBFETCH_DEFAULT_TIMEOUT_MS = 30_000;
const WEBFETCH_MAX_TIMEOUT_MS = 60_000;
const WEBFETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
const WEBFETCH_TRUNCATE_MARKER = "\n… [truncated at 5MB]";
const WEBFETCH_ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/json",
  "text/markdown",
] as const;

// HTML → markdown 변환 헬퍼. 사용자 결정 (ADR): turndown/readability dep 거부, 50 LOC 정합.
//   1) `<script>...</script>` 블록 제거 (case-insensitive, 비탐욕).
//   2) `<style>...</style>` 블록 제거 (case-insensitive, 비탐욕).
//   3) 모든 잔여 태그 `<[^>]+>` strip.
//   4) HTML entity 최소 해독 (&nbsp; &amp; &lt; &gt; &quot; &#39;).
//   5) 연속 공백/개행 정리 — 3+ 개행 → 2개, trailing space 정리.
const stripHtmlToMarkdown = (html: string): string => {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
  // 연속 개행 3+ → 2, trailing whitespace per line 제거, leading/trailing whitespace 정리.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
};

// ─── WebSearch 상수/헬퍼 (2026-07-26 — parity 갭 해소) ────────────────────
// claude 어댑터는 SDK 내장 WebSearch 가 있는데 codex 엔 없었다 → "모르는 것을 찾기" 가
// 어댑터에 따라 갈렸다(원칙 #2 위반). 여기서 codex 안에 닫는다(claude 폴백으로 덮지 않음).
//
// ★결과는 강하게 바운드한다. 검색 결과는 그대로 컨텍스트에 쌓이는 순수 비용이라
//  "많이 주면 좋다" 가 아니라 **판단에 필요한 최소**가 맞다. 제목+URL+요약 3필드만,
//  기본 5건, 요약 240자. 더 필요하면 모델이 WebFetch 로 파고든다(검색=발견, fetch=깊이 2단 구조).
const WEBSEARCH_DEFAULT_COUNT = 5;
const WEBSEARCH_MAX_COUNT = 10;
const WEBSEARCH_SNIPPET_CHARS = 240;
const WEBSEARCH_TIMEOUT_MS = 20_000;

interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

const clipSnippet = (s: unknown): string => {
  const t = stripHtmlToMarkdown(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > WEBSEARCH_SNIPPET_CHARS
    ? `${t.slice(0, WEBSEARCH_SNIPPET_CHARS)}…`
    : t;
};

/** Brave Search — GET + 헤더 토큰. */
const searchBrave = async (
  q: string,
  count: number,
  apiKey: string,
): Promise<WebSearchHit[]> => {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`brave ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: clipSnippet(r.description),
  }));
};

/** Tavily — POST + body 토큰. */
const searchTavily = async (
  q: string,
  count: number,
  apiKey: string,
): Promise<WebSearchHit[]> => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query: q, max_results: count }),
    signal: AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tavily ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: clipSnippet(r.content),
  }));
};

// ─── 도구 빌더 (baseCwd 클로저) ──────────────────────────────────────────
// ★3b: 도구들이 base(턴 cwd)를 클로저로 잡는다. 상대경로 기준점·Glob/Grep/Bash 기본
//   cwd 가 전부 base. 팩토리가 턴마다 base 를 주입하므로 병렬 안전(무전역, 인스턴스=턴).
// ★threadKey(ADR Phase 2 §1) — baseCwd 와 동형으로 팩토리가 턴마다 주입. run_in_background
//   Bash 가 launchBgShell 에 전달해 shell.started.threadKey 로 관측(미전파 시 "" 폴백).
// 턴 스코프 읽기 캐시 상한 — 긴 턴에서도 메모리·오동작이 없도록 바운드.
const READ_CACHE_MAX_ENTRIES = 512; // 넘으면 통째 비움(단순·안전, LRU 불필요).
const READ_CACHE_MAX_STUBS = 2; // 같은 키에 스텁 2회까지 — 그 이상은 본문 재제공(탈출구).
// ★작은 파일은 캐시하지 않는다 — 스텁 자체가 ~200자라, 그보다 조금 큰 본문을 스텁으로
//  바꾸면 절감이 거의 없거나 오히려 손해다(검증에서 310자 파일이 195자 스텁으로 바뀌며
//  드러났다). 캐시의 값어치는 "큰 본문이 여러 벌 쌓이는 것"을 막는 데 있으므로 그 구간만 건다.
const READ_CACHE_MIN_BYTES = 1024;

const makeFileOpsTools = (
  base: string,
  threadKey: string,
  includeWebSearch: boolean,
  /** 턴/워커 중단 신호 — /stop·취소가 실행 중인 포그라운드 셸까지 끊게 한다(G, 2026-07-28). */
  abortSignal?: AbortSignal,
) => {
  // ★이 Map 이 곧 "턴 스코프" — createFileOpsMcpServer 가 턴마다 새로 호출되므로
  //  (openai-codex-oauth.ts:490) 클로저 하나가 그 턴의 수명과 정확히 일치한다.
  //  턴이 끝나면 서버·브리지가 close 되며 통째로 사라진다 = 누수·교차오염 0.
  const turnReadCache = new Map<
    string,
    { sig: string; lines: number; bytes: number; stubs: number }
  >();
  // β — 벽 아닌 해소만. 상대경로 → base 기준, 절대경로 → 그대로(home/프로젝트 밖 허용).
  const resolvePath = (target: string): string =>
    path.isAbsolute(target) ? target : path.resolve(base, target);

  // ─── Read 도구 ─────────────────────────────────────────────────────────
  const readTool = tool(
    "Read",
    "파일 본문을 읽어 반환합니다. 상대경로는 현재 작업폴더(프로젝트/홈) 기준, 절대경로면 밖도 허용. limit 미지정 시 2000 라인. offset 은 1-based.",
    {
      path: z.string().min(1),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(50_000).optional(),
    },
    async (args) => {
      try {
        const abs = resolvePath(args.path);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          return errText(`path 가 파일이 아닙니다: ${abs}`);
        }
        // ★턴 스코프 읽기 캐시 (2026-07-27) — 같은 턴에서 같은 구간을 또 읽으면 본문을 다시
        //  주지 않는다. 실측(codex Read 933건): 12%(114건)가 **같은 턴 안** 재읽기였고, 한
        //  파일을 같은 초에 3번 읽는 경우까지 있었다. 그 내용은 이미 그 턴의 누적 입력에
        //  들어 있으므로 순수 낭비다 — codex 는 매 iteration 히스토리를 통째로 재전송해서
        //  중복 본문이 iteration 수만큼 곱해진다.
        //  ★무효화는 추측이 아니라 관측으로: mtime+size 가 그대로일 때만 캐시 적중.
        //   파일이 바뀌었으면 정상적으로 다시 읽는다(오래된 내용을 쥐여주지 않는다).
        //  ★탈출구: 같은 키에 스텁을 2회까지만 준다. 그 이상 물으면 앞선 결과가 실제로
        //   컨텍스트에서 사라진 것으로 보고 본문을 다시 준다(스텁 무한루프 방지).
        const ck = `${abs}\u0000${args.offset ?? 1}\u0000${args.limit ?? DEFAULT_READ_LIMIT}`;
        const sig = `${stat.mtimeMs}:${stat.size}`;
        const hit = turnReadCache.get(ck);
        if (
          hit !== undefined &&
          hit.sig === sig &&
          hit.bytes >= READ_CACHE_MIN_BYTES &&
          hit.stubs < READ_CACHE_MAX_STUBS
        ) {
          hit.stubs += 1;
          return okText(
            `(이 턴에서 이미 읽은 파일입니다 — 파일이 그대로라 본문을 다시 싣지 않습니다.)\n` +
              `path=${abs}${args.offset !== undefined ? `, offset=${args.offset}` : ""} · ${hit.lines}줄\n` +
              `앞서 이 턴에서 반환한 내용을 그대로 사용하세요. 다시 확인이 꼭 필요하면 한 번 더 호출하면 본문을 줍니다.`,
          );
        }
        // ★이미지는 **비전 채널로** 답한다 (2026-08-01, 라이브 사고).
        //  종전엔 무조건 `readFile(utf8)` 이라 JPEG 이 깨진 텍스트로 나갔고, 그게
        //  **성공으로** 반환됐다. 모델은 "판독 불가" 라 답하는데 호출한 앱은 정상 응답으로
        //  받아 캐시에 저장했다 — 사흘간 캐시 오염·workspace 초기화로 세 번 오진했다.
        //  claude 는 네이티브 Read 가 비전으로 처리하는데 codex 만 이랬다(어댑터 비대칭 =
        //  "모든 기능 LLM 무관" 위반). 어댑터가 이 블록을 input_image 로 옮긴다.
        //  ★실패를 성공으로 답하지 않는 것이 핵심이다 — 비전 미지원보다 미지원을
        //   성공이라 답하는 것이 훨씬 해롭다.
        // 이미지 판정엔 16B 면 되지만, 아래 텍스트 여부 판정은 표본이 더 필요하다
        // (앞부분만 우연히 ASCII 인 바이너리가 있다). 한 번만 읽어 둘 다 쓴다.
        const headBuf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
        if (headBuf.length > 0) {
          const fh = await fs.open(abs, "r");
          try {
            await fh.read(headBuf, 0, headBuf.length, 0);
          } finally {
            await fh.close();
          }
        }
        const imageMime = sniffImageMime(headBuf);
        if (imageMime !== null) {
          if (stat.size > MAX_INLINE_IMAGE_BYTES) {
            return errText(
              `이미지가 너무 큽니다(${Math.round(stat.size / 1024)}KB > ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024}MB) — ` +
                `비전 채널로 실을 수 없습니다. path=${abs}`,
            );
          }
          const b64 = (await fs.readFile(abs)).toString("base64");
          return {
            content: [
              {
                type: "text" as const,
                text: `이미지를 비전 채널로 첨부했습니다(${imageMime}, ${Math.round(stat.size / 1024)}KB). path=${abs}`,
              },
              { type: "image" as const, data: b64, mimeType: imageMime },
            ],
          };
        }
        // ★텍스트가 아니면 **본문 대신 사실을 준다** (2026-08-10). 깨진 UTF-8 을 성공으로
        //  돌려주면 비서가 그걸 재료로 헛다리를 짚는다(2026-08-01 이미지 사고와 같은 부류).
        //  도구 이름을 열거해 주지는 않는다 — 파일 종류마다 맞는 도구가 다르고 그 판단은
        //  모델이 하는 게 맞다(목록을 박으면 그게 또 손으로 관리하는 목록이 된다).
        if (looksBinary(headBuf)) {
          return okText(
            `이 파일은 텍스트가 아닙니다 — 본문을 싣지 않았습니다.\n` +
              `path=${abs} · ${humanBytes(stat.size)}\n` +
              `내용을 확인하려면 Bash 로 그 형식에 맞는 도구를 쓰세요(예: 무엇인지부터 알아보려면 \`file\`).`,
          );
        }
        const raw = await fs.readFile(abs, "utf8");
        // ★노트북(.ipynb)은 **셀 단위로 편다** (2026-08-09). 원본 JSON 은 base64 이미지·
        //  실행 메타로 부풀어 있어 그대로 읽으면 컨텍스트만 태우고 코드가 안 보인다.
        //  claude 빌트인 Read 가 하던 일이라, 우리 도구로 일원화하려면 여기 있어야 한다
        //  (없으면 원칙 1 "슈퍼셋 — 누락은 버그" 위반).
        const lines = abs.endsWith(".ipynb")
          ? flattenNotebook(raw).split("\n")
          : raw.split("\n");
        const start = (args.offset ?? 1) - 1;
        const limit = args.limit ?? DEFAULT_READ_LIMIT;
        const slice = lines.slice(start, start + limit);
        let body = slice.join("\n");
        if (body.length > READ_BODY_HARD_CAP) {
          body = `${body.slice(0, READ_BODY_HARD_CAP - 1)}…`;
        }
        // 캐시 적재(턴 스코프). 상한을 둬 긴 턴에서도 Map 이 무한 증가하지 않는다.
        if (turnReadCache.size >= READ_CACHE_MAX_ENTRIES) turnReadCache.clear();
        turnReadCache.set(ck, { sig, lines: slice.length, bytes: body.length, stubs: 0 });
        return okText(body);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ─── Glob 도구 ─────────────────────────────────────────────────────────
  // ripgrep `--files -g <pattern>` 위임. 매칭 파일 경로 string[] 반환. cwd 미지정 시 base.
  const globTool = tool(
    "Glob",
    "글로브 패턴으로 파일 경로를 찾습니다. cwd 미지정 시 현재 작업폴더(프로젝트/홈). **최근 수정 순**, 최대 1000개.",
    {
      pattern: z.string().min(1),
      cwd: z.string().optional(),
    },
    async (args) => {
      try {
        const cwd = args.cwd !== undefined ? resolvePath(args.cwd) : base;
        // rg `--files` = cwd 내 모든 파일 나열 (.gitignore 존중), `-g <pattern>` 으로 필터.
        const { stdout } = await execFileP(
          rgPath(),
          ["--files", "-g", args.pattern, cwd],
          { maxBuffer: GLOB_MAX_BUFFER },
        ).catch(
          (e: NodeJS.ErrnoException & { stdout?: string; code?: number }) => {
            if (e.code === 1) return { stdout: "" };
            throw e;
          },
        );
        const lines = stdout.split("\n").filter((l) => l.length > 0);
        // ★**최근 수정 순**으로 준다 (2026-08-09). claude 빌트인 Glob 이 그렇게 주고, 그게
        //  실제로 유용하다 — "방금 건드린 파일" 이 위로 온다. rg 는 파일시스템 순서라
        //  같은 질문에 어댑터마다 다른 순서가 나왔다(일원화하려면 순서도 같아야 한다).
        //  stat 실패(경합 중 삭제 등)는 0 으로 떨어뜨려 뒤로 보낸다 — 목록이 통째로 죽지 않게.
        // ★**전체를 정렬한 뒤** 자른다 (2026-08-09 적대 검토 ③). 종전엔 rg 의 파일시스템
        //  순서로 앞 1000개를 뽑고 그 안에서만 정렬해서, 매칭이 1000개를 넘으면
        //  "방금 건드린 파일이 위로 온다" 가 **거짓**이었다(claude 빌트인은 전체 최신순).
        const withMtime = await Promise.all(
          lines.map(async (f) => {
            try {
              return { f, m: (await fs.stat(f)).mtimeMs };
            } catch {
              return { f, m: 0 };
            }
          }),
        );
        withMtime.sort((a, b) => b.m - a.m);
        const files = withMtime.slice(0, GLOB_MAX_RESULTS).map((x) => x.f);
        // ★잘렸으면 **말한다** — Grep 은 말하는데 Glob 만 침묵하면 같은 커밋 안에서
        //  원칙이 갈린다. 조용한 절단은 모델이 "그게 전부" 로 읽는다.
        return okText(
          JSON.stringify(
            withMtime.length > files.length
              ? { results: files, truncated: true, total: withMtime.length }
              : files,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("ENOENT")) {
          forgetRipgrep(rgPath()); // 죽었다 — 기억을 지워 다음 호출이 다시 찾는다.
          return errText(
            `ripgrep(rg) 을 못 찾았습니다 — \`npm run doctor\` 를 돌리면 자동으로 받아 둡니다. (원본: ${msg})`,
          );
        }
        return errText(msg);
      }
    },
  );

  // ─── 노트북 평탄화 ────────────────────────────────────────────────────
  /**
   * `.ipynb` 를 사람이 읽는 형태로 편다 — 셀 번호·종류·소스, 그리고 **출력 요약**.
   *
   * 원본 JSON 을 그대로 주면 셀 하나가 base64 이미지 수십 KB 일 수 있고 `execution_count`
   * 같은 메타가 코드보다 많다. 파싱 실패는 **원문으로 폴백**한다 — 읽기가 실패하는 것보다
   * 원본이라도 보이는 게 낫다(깨진 노트북도 고쳐야 할 대상이다).
   */
  const flattenNotebook = (raw: string): string => {
    try {
      const nb = JSON.parse(raw) as {
        cells?: Array<{
          cell_type?: string;
          source?: string[] | string;
          outputs?: Array<Record<string, unknown>>;
        }>;
      };
      if (!Array.isArray(nb.cells)) return raw;
      const out: string[] = [];
      nb.cells.forEach((c, i) => {
        const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
        out.push(`# ── cell ${i + 1} [${c.cell_type ?? "?"}] ──`);
        out.push(src.replace(/\n$/, ""));
        for (const o of c.outputs ?? []) {
          const text = o["text"];
          const data = o["data"] as Record<string, unknown> | undefined;
          const asText = Array.isArray(text)
            ? (text as string[]).join("")
            : typeof text === "string"
              ? text
              : typeof data?.["text/plain"] === "string"
                ? (data["text/plain"] as string)
                : Array.isArray(data?.["text/plain"])
                  ? (data["text/plain"] as string[]).join("")
                  : undefined;
          if (asText !== undefined && asText.trim() !== "") {
            out.push(`#   out: ${asText.trim().slice(0, 2000)}`);
          } else if (data !== undefined && Object.keys(data).length > 0) {
            // 이미지 등 — 있다는 사실만 남기고 본문은 싣지 않는다(컨텍스트 보호).
            out.push(`#   out: <${Object.keys(data).join(", ")}>`);
          }
          const err = o["ename"];
          if (typeof err === "string") out.push(`#   error: ${err}: ${String(o["evalue"] ?? "")}`);
        }
      });
      return out.join("\n");
    } catch {
      return raw;
    }
  };

  // ─── Grep 도구 ─────────────────────────────────────────────────────────
  // ripgrep 직접 호출. path 미지정 시 base. glob 으로 파일 필터.
  const grepTool = tool(
    "Grep",
    "ripgrep 으로 코드/파일을 검색합니다. path 미지정 시 현재 작업폴더(프로젝트/홈). " +
      "output_mode: content(매칭 라인, 기본) · files_with_matches(파일 경로만) · count(파일별 개수). " +
      "-A/-B/-C 는 content 에서만 의미가 있습니다. head_limit 로 결과를 잘라 컨텍스트를 아끼세요.",
    {
      pattern: z.string().min(1),
      path: z.string().optional(),
      glob: z.string().optional(),
      /** 파일 종류 필터(ripgrep --type) — 예: ts, py, rust. glob 보다 빠르다. */
      type: z.string().optional(),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
      /** 대소문자 무시. */
      "-i": z.boolean().optional(),
      /** content 모드에서 줄 번호 표시(기본 켬 — 끄려면 false). */
      "-n": z.boolean().optional(),
      /** 매칭 뒤/앞/양쪽 컨텍스트 줄 수(content 모드 전용). */
      "-A": z.number().int().min(0).max(50).optional(),
      "-B": z.number().int().min(0).max(50).optional(),
      "-C": z.number().int().min(0).max(50).optional(),
      /** 여러 줄에 걸친 패턴 매칭(. 이 개행에도 매칭). */
      multiline: z.boolean().optional(),
      /** 앞에서 N 개만 반환 — 넓은 검색의 컨텍스트 폭주를 모델이 직접 막을 수 있게. */
      head_limit: z.number().int().min(1).max(10_000).optional(),
    },
    async (args) => {
      try {
        const searchPath =
          args.path !== undefined ? resolvePath(args.path) : base;
        const mode = args.output_mode ?? "content";
        const rgArgs = ["--no-heading", "--color=never"];
        if (mode === "files_with_matches") rgArgs.push("-l");
        else if (mode === "count") rgArgs.push("-c");
        else if (args["-n"] !== false) rgArgs.push("-n");
        if (args["-i"] === true) rgArgs.push("-i");
        if (args.multiline === true) rgArgs.push("-U", "--multiline-dotall");
        // ★**빈 문자열도 걸러야 한다** (2026-08-09 윈도우 실측). 모델은 선택적 인자를
        //  `""` 로 채우는 일이 흔한데, 그걸 그대로 `rg --type ""` 로 넘기면 rg 가 에러를
        //  내고 검색이 통째로 실패한다. `undefined` 만 보던 것이 원인 — 스키마가 optional
        //  이라고 해서 빈 값이 안 온다는 뜻은 아니다.
        const glob = args.glob?.trim();
        const type = args.type?.trim();
        if (glob !== undefined && glob !== "") rgArgs.push("--glob", glob);
        if (type !== undefined && type !== "") rgArgs.push("--type", type);
        // 컨텍스트 줄은 content 모드에서만 의미가 있다 — `-l`/`-c` 와 함께 주면 rg 가
        // **조용히 무시한다**(에러가 아니다, rg 15.1.0 실측). 조용한 무시는 "왜 컨텍스트가
        // 없지" 로 돌아오므로 여기서 아예 안 넘긴다.
        if (mode === "content") {
          if (args["-C"] !== undefined) rgArgs.push("-C", String(args["-C"]));
          else {
            if (args["-A"] !== undefined) rgArgs.push("-A", String(args["-A"]));
            if (args["-B"] !== undefined) rgArgs.push("-B", String(args["-B"]));
          }
        }
        rgArgs.push("-e", args.pattern, searchPath);
        const { stdout } = await execFileP(rgPath(), rgArgs, {
          maxBuffer: GREP_MAX_BUFFER,
        }).catch(
          (e: NodeJS.ErrnoException & { stdout?: string; code?: number }) => {
            // ripgrep exit code 1 = no matches (정상). code !== 0 && stdout 부재면 오류.
            if (e.code === 1) {
              return { stdout: "" };
            }
            throw e;
          },
        );
        const lines = stdout.split("\n").filter((l) => l.length > 0);
        // ★상한이 둘이다: 모델이 지정한 head_limit(의도)과 우리 안전망(GREP_MAX_LINES).
        //  둘 중 작은 쪽을 쓰고, **잘렸으면 말한다** — 조용히 자르면 모델이 "그게 전부" 로 읽는다.
        const cap = Math.min(args.head_limit ?? GREP_MAX_LINES, GREP_MAX_LINES);
        const sliced = lines.slice(0, cap);
        const truncated = lines.length > sliced.length;
        return okText(
          JSON.stringify(
            truncated
              ? { mode, results: sliced, truncated: true, total: lines.length }
              : sliced,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // ripgrep 부재 케이스 별도 hint.
        if (msg.includes("ENOENT")) {
          forgetRipgrep(rgPath()); // 죽었다 — 기억을 지워 다음 호출이 다시 찾는다.
          return errText(
            `ripgrep(rg) 을 못 찾았습니다 — \`npm run doctor\` 를 돌리면 자동으로 받아 둡니다. (원본: ${msg})`,
          );
        }
        return errText(msg);
      }
    },
  );

  // ─── Write 도구 (V5.6) ─────────────────────────────────────────────────
  // 파일 전체 덮어쓰기. 디렉터리 부재 시 fs.mkdir({recursive:true}) 자동 생성.
  const writeTool = tool(
    "Write",
    "파일을 작성합니다 (전체 덮어쓰기). 상대경로는 현재 작업폴더 기준, 절대경로면 밖도 허용. 부모 디렉터리 부재 시 자동 생성.",
    {
      path: z.string().min(1),
      content: z.string(),
    },
    async (args) => {
      try {
        const abs = resolvePath(args.path);
        // 부모 디렉터리 ensure. recursive:true 라 이미 존재해도 무해.
        const dir = path.dirname(abs);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(abs, args.content, "utf8");
        return okText(`Wrote ${args.content.length} chars to ${abs}.`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ─── Edit 도구 (V5.6) ──────────────────────────────────────────────────
  // 부분 교체. old_string 0/다수 매칭 시 명확 에러 (replace_all=false 디폴트).
  const editTool = tool(
    "Edit",
    "파일 안의 부분 문자열 교체. old_string 이 0 또는 다수 매칭이면 (replace_all=false 디폴트 시) reject.",
    {
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
    async (args) => {
      try {
        const abs = resolvePath(args.path);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          return errText(`path 가 파일이 아닙니다: ${abs}`);
        }
        const original = await fs.readFile(abs, "utf8");
        // 매칭 카운트 — split 길이 - 1 = 발생 횟수.
        const occurrences = original.split(args.old_string).length - 1;
        if (occurrences === 0) {
          return errText(
            `old_string 이 파일에 없습니다 (path: ${abs}). 사용자 의도 확인 필요.`,
          );
        }
        const replaceAll = args.replace_all === true;
        if (occurrences > 1 && !replaceAll) {
          return errText(
            `old_string 이 ${occurrences}회 매칭됩니다. replace_all=true 명시 또는 더 구체적인 old_string 필요 (path: ${abs}).`,
          );
        }
        const next = replaceAll
          ? original.split(args.old_string).join(args.new_string)
          : original.replace(args.old_string, args.new_string);
        await fs.writeFile(abs, next, "utf8");
        return okText(
          `Edited ${abs} — replaced ${replaceAll ? occurrences : 1} occurrence(s).`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ─── Bash 도구 (V5.7) ──────────────────────────────────────────────────
  // 임의 셸 명령 실행. `execFile("sh", ["-c", cmd], {cwd: base, timeout, maxBuffer})`.
  // cwd 기본 = base (β — 만능 비서 작업 위치, 프로젝트 진입 시 그 폴더. `cd`/절대경로로
  // 밖 접근은 벽 없이 허용, 위험 경로는 sysprompt prompt-gated).
  const bashTool = tool(
    "Bash",
    `셸 명령을 실행합니다 (${SHELL.label} 로 실행). timeout 디폴트 120s / max 600s. stdout/stderr 각 1MB cap. cwd 기본은 현재 작업폴더 (절대경로·cd 로 밖도 가능). **긴 명령(빌드·서버·스크립트)은 \`run_in_background: true\` 로 띄우면 즉시 bash_id 를 받고 막히지 않는다 — 이후 BashOutput 으로 출력 폴링, KillShell 로 종료.**`,
    {
      command: z.string().min(1),
      timeout: z.number().int().min(1).optional().describe("타임아웃 (초 단위, 기본 120, 최대 600)"),
      description: z.string().optional(),
      run_in_background: z.boolean().optional(),
    },
    async (args) => {
      // V5.7 안전 가드 1 — DISALLOWED_TOOLS pre-check (정책 진실 소스 1개 박기).
      // (a) "Bash" 자체 차단 시 — 도구 명시 거부.
      // (b) command 내 차단 토큰 매칭 시 — 명령 본문 거부.
      if (DISALLOWED_TOOLS.includes("Bash")) {
        return errText(`Bash 도구가 DISALLOWED_TOOLS 에 박혀 있어 거부됨.`);
      }
      for (const banned of DISALLOWED_TOOLS) {
        if (banned !== "Bash" && args.command.includes(banned)) {
          return errText(
            `command 에 DISALLOWED_TOOLS 토큰("${banned}") 포함 — 거부.`,
          );
        }
      }

      // 백그라운드 실행 — 즉시 bash_id 반환(안 막힘). timeout 미적용(완료/Kill 까지 돎).
      if (args.run_in_background === true) {
        const id = await launchBgShell(args.command, base, threadKey);
        return okText(
          `백그라운드 실행 시작 (bash_id: ${id}). ` +
            `BashOutput({ bash_id: "${id}" }) 로 출력 폴링, KillShell 로 종료.`,
        );
      }

      // V5.7 안전 가드 2 — timeout clamp. ★param 은 *초* 단위(설명·모델 기대와 일치). 예전엔
      // ms 로 써서 모델이 `timeout:120`(120초 의도)을 넘기면 120ms→즉시 SIGKILL 이었다(2026-07-10).
      const timeoutSec = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS / 1000;
      const timeout = Math.min(timeoutSec * 1000, BASH_MAX_TIMEOUT_MS);

      // ★포그라운드 셸을 **그룹장**으로 띄운다 (G, 2026-07-28).
      //  종전엔 execFile 의 내장 timeout 이 **직계 자식(sh)만** 죽여, `sh -c "node srv.js"`
      //  의 손자는 그대로 살아남았다(라이브 고아 1건 실측: 10일 생존·포트 3911 점유).
      //  ★execFile 은 detached 옵션을 **전달하지 않는다**(실측: pgid 가 부모 그룹으로 남아
      //   process.kill(-pid) 이 ESRCH). 그래서 백그라운드 셸(launchBgShell)과 동형으로
      //   spawn 을 직접 쓴다 — 그래야 setsid 가 걸려 그룹 전체를 정리할 수 있다.
      //  ★detach 는 "부모가 죽어도 살아남음"이므로 추적 집합에 넣어 exit 훅 리퍼가 덮는다.
      const useGroup = process.platform !== "win32";
      const child = spawn(SHELL.bin, SHELL.argsFor(args.command), {
        cwd: base,
        windowsHide: true,
        ...(useGroup ? { detached: true } : {}),
      });
      const childPid = child.pid ?? -1;
      if (childPid > 1) {
        FOREGROUND_SHELL_PIDS.add(childPid);
        ensureBgShellExitHook();
      }
      const killGroup = (): void => {
        if (childPid > 1) void killTree(childPid, "SIGKILL");
        else child.kill("SIGKILL"); // spawn 실패(pid 미할당) 방어 — 그룹 시그널 금지.
      };

      // stdout/stderr 수집 — cap 초과 시 즉시 죽이고 maxBuffer 로 보고(execFile 동형).
      let outBuf = "", errBuf = "", outBytes = 0, errBytes = 0;
      let overflow = false, timedOut = false, abortedByUser = false;
      const collect = (chunk: Buffer, which: "out" | "err"): void => {
        const n = chunk.length;
        if (which === "out") { outBytes += n; if (outBuf.length < BASH_MAX_BUFFER_BYTES * 2) outBuf += chunk.toString("utf8"); }
        else { errBytes += n; if (errBuf.length < BASH_MAX_BUFFER_BYTES * 2) errBuf += chunk.toString("utf8"); }
        if (!overflow && (outBytes > BASH_MAX_BUFFER_BYTES || errBytes > BASH_MAX_BUFFER_BYTES)) {
          overflow = true;
          killGroup();
        }
      };
      child.stdout?.on("data", (c: Buffer) => collect(c, "out"));
      child.stderr?.on("data", (c: Buffer) => collect(c, "err"));

      // timeout 은 우리가 소유한다(내장은 직계 자식만 죽임 = 위 구멍).
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout);
      const onAbort = (): void => { abortedByUser = true; killGroup(); };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; err?: Error }>(
        (resolve) => {
          child.once("error", (err) => resolve({ code: null, signal: null, err }));
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (childPid > 1) FOREGROUND_SHELL_PIDS.delete(childPid);

      const out = truncateBashOutput(outBuf);
      const err = truncateBashOutput(errBuf);
      const outWithMarker =
        overflow && !out.endsWith(BASH_TRUNCATE_MARKER) ? `${out}${BASH_TRUNCATE_MARKER}` : out;
      const errWithMarker =
        overflow && err.length > 0 && !err.endsWith(BASH_TRUNCATE_MARKER)
          ? `${err}${BASH_TRUNCATE_MARKER}`
          : err;
      const parts: string[] = [];
      if (outWithMarker.length > 0) parts.push(`stdout:\n${outWithMarker}`);
      if (errWithMarker.length > 0) parts.push(`stderr:\n${errWithMarker}`);
      if (timedOut) {
        parts.push(
          `Error: timeout — command 이 ${Math.round(timeout / 1000)}s 안에 끝나지 않아 SIGKILL 로 종료됨.`,
        );
      } else if (abortedByUser) {
        parts.push(`Error: 중단됨 — 사용자/상위 취소로 셸(프로세스 그룹)을 SIGKILL 했습니다.`);
      } else if (overflow) {
        parts.push(`Error: maxBuffer 초과 (1MB) — stdout/stderr truncated.`);
      } else if (finished.err !== undefined) {
        parts.push(`Error: ${finished.err.message}`);
      } else {
        parts.push(`exit code: ${finished.code ?? 0}`);
      }
      return okText(parts.join("\n\n"));
    },
  );

  // ─── BashOutput / KillShell (BG_SHELLS 조회 — cwd 무관) ─────────────────
  const bashOutputTool = tool(
    "BashOutput",
    "백그라운드 Bash(run_in_background)의 *새로 쌓인* 출력을 가져옵니다. bash_id 로 조회 — 마지막 호출 이후의 증분 stdout/stderr + 상태(running / 완료 시 exit code)를 반환합니다.",
    {
      bash_id: z.string().min(1),
    },
    async (args) => {
      const s = BG_SHELLS.get(args.bash_id);
      if (s === undefined) {
        return errText(
          `bash_id 없음: ${args.bash_id} (종료 후 정리됐거나 잘못된 id).`,
        );
      }
      const newOut = s.stdout.slice(s.stdoutRead);
      s.stdoutRead = s.stdout.length;
      const newErr = s.stderr.slice(s.stderrRead);
      s.stderrRead = s.stderr.length;
      const parts: string[] = [
        `status: ${s.status}${s.status !== "running" ? ` (exit ${s.exitCode})` : ""}`,
      ];
      if (newOut.length > 0) parts.push(`stdout(new):\n${newOut}`);
      if (newErr.length > 0) parts.push(`stderr(new):\n${newErr}`);
      if (newOut.length === 0 && newErr.length === 0)
        parts.push("(새 출력 없음)");
      return okText(parts.join("\n\n"));
    },
  );

  const killShellTool = tool(
    "KillShell",
    "백그라운드 Bash(run_in_background)를 강제 종료합니다. bash_id 로 지정.",
    {
      bash_id: z.string().min(1),
    },
    async (args) => {
      const s = BG_SHELLS.get(args.bash_id);
      if (s === undefined) {
        return errText(`bash_id 없음: ${args.bash_id}.`);
      }
      // ★Phase 2: killShellById 로 위임(단일 헬퍼 재사용 — 대시보드 POST /kill-shell 과
      // 로직 동일화). killTree(pgid, 그룹 전체)+status=killed+DB미러+shell.exited 발행까지
      // 그 안에서 수행(이전엔 여기 인라인 — Unit 1 의 손자 그룹킬 동작은 그대로 보존).
      await killShellById(args.bash_id);
      return okText(`종료 처리됨: ${args.bash_id} (status: ${s.status}).`);
    },
  );

  // ─── WebFetch 도구 (V5.9 — cwd 무관) ───────────────────────────────────
  const webFetchTool = tool(
    "WebFetch",
    "URL 의 본문을 받아 markdown 변환 후 반환합니다. `prompt` 를 주면 본문에 그 지시를 돌려 **답만** 돌려줍니다. http(s):// 만 허용. HTML 은 script/style 제거 + tag strip. timeout 디폴트 30s / max 60s. body 5MB cap.",
    {
      url: z.string().min(1),
      prompt: z
        .string()
        .optional()
        .describe(
          "선택 — 받아온 본문에 **돌릴 지시**(예: '가격표만 뽑아줘'). 주면 본문 대신 그 답이 옵니다(토큰 절약). 없으면 본문 전체.",
        ),
      timeout: z.number().int().min(1).optional().describe("타임아웃 (초 단위, 기본 30, 최대 60)"),
    },
    async (args) => {
      // 안전 가드 1 — URL 파싱 + 스킴 검사.
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        return errText(`url 파싱 실패: ${args.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return errText(
          `http(s):// 만 허용됩니다 (received protocol: ${parsed.protocol}). file://, data:, javascript: 거부.`,
        );
      }

      // 안전 가드 2 — DISALLOWED_URLS pre-check (정확 매칭).
      if (DISALLOWED_URLS.includes(args.url)) {
        return errText(`url 이 DISALLOWED_URLS 에 박혀 있어 거부됨: ${args.url}`);
      }

      // 안전 가드 3 — timeout clamp. ★param 은 *초* 단위(설명·모델 기대와 일치). 예전엔 ms 로
      // 써서 모델이 `timeout:30`(30초 의도)을 넘기면 30ms→즉시 실패했다(2026-07-10 fix). 내부는 ms.
      const timeoutSec = args.timeout ?? WEBFETCH_DEFAULT_TIMEOUT_MS / 1000;
      const timeout = Math.min(timeoutSec * 1000, WEBFETCH_MAX_TIMEOUT_MS);

      try {
        const res = await fetch(args.url, {
          signal: AbortSignal.timeout(timeout),
          redirect: "follow",
        });

        // 안전 가드 4 — content-type 검사.
        const rawContentType = res.headers.get("content-type") ?? "";
        const baseType =
          rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
        if (
          !WEBFETCH_ALLOWED_CONTENT_TYPES.includes(
            baseType as (typeof WEBFETCH_ALLOWED_CONTENT_TYPES)[number],
          )
        ) {
          return errText(
            `content-type 거부: "${rawContentType}". 허용: ${WEBFETCH_ALLOWED_CONTENT_TYPES.join(", ")}.`,
          );
        }

        // 안전 가드 5 — body 5MB cap.
        const buf = Buffer.from(await res.arrayBuffer());
        let truncated = false;
        let body: string;
        if (buf.length > WEBFETCH_MAX_BODY_BYTES) {
          body = buf.subarray(0, WEBFETCH_MAX_BODY_BYTES).toString("utf8");
          truncated = true;
        } else {
          body = buf.toString("utf8");
        }

        // HTML/XHTML 은 markdown 변환, 나머지는 원본.
        let payload: string;
        if (baseType === "text/html" || baseType === "application/xhtml+xml") {
          payload = stripHtmlToMarkdown(body);
        } else {
          payload = body;
        }
        if (truncated) payload = `${payload}${WEBFETCH_TRUNCATE_MARKER}`;

        const header = `HTTP ${res.status} ${res.statusText} (content-type: ${rawContentType})\n\n`;

        // ★prompt 가 오면 **본문에 실제로 돌린다** (2026-08-15). 종전엔 이 파라미터를
        //  선언만 하고 안 썼다 — codex 가 "이게 진짜 AAD 페이지인지 확인해줘" 라고 물으면
        //  답 대신 페이지 전문이 돌아왔고, 에러도 로그도 없었다(20일간 22건 전부).
        //  claude 는 SDK 것이라 정상 처리돼서 **어댑터 간 비대칭**이기도 했다.
        const wantPrompt = (args.prompt ?? "").trim();
        if (wantPrompt !== "") {
          const { extractFromContent } = await import("../webfetch-extract.js");
          const ex = await extractFromContent({
            url: args.url,
            prompt: wantPrompt,
            content: payload,
            // ★호출자가 시한을 줬으면 **추출까지 그 안에** 끝낸다. 안 그러면 `timeout: 5`
            //  라고 적은 쪽이 30초를 기다린다 — 시한을 준 이유가 사라진다.
            ...(args.timeout !== undefined ? { timeoutMs: timeout } : {}),
          });
          if (ex.ok) {
            const note = ex.truncated
              ? "\n\n(문서가 길어 앞부분만 읽었습니다 — 전문이 필요하면 prompt 없이 다시 부르세요.)"
              : "";
            return okText(`${header}${ex.text}${note}`);
          }
          // ★실패는 **말한다**. 이 결함의 본질이 "조용한 무시" 였으므로 같은 병을 다른
          //  모양으로 다시 만들지 않는다 — 본문은 그대로 주되 왜 못 돌렸는지 한 줄.
          return okText(
            `${header}⚠️ prompt 를 본문에 돌리지 못했습니다(${ex.reason}) — 아래는 본문 원문입니다.\n\n${payload}`,
          );
        }
        return okText(`${header}${payload}`);
      } catch (e) {
        const err = e as Error & { name?: string };
        // AbortSignal.timeout → DOMException(name="TimeoutError").
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          return errText(`timeout — fetch 가 ${Math.round(timeout / 1000)}s 안에 끝나지 않음.`);
        }
        return errText(err.message ?? String(e));
      }
    },
  );

  // ─── WebSearch 도구 (2026-07-26 · 2026-07-27 스코프 정정) ────────────────
  // ★codex 는 제외한다 — backend native `{type:"web_search"}` 를 이미 보낸다
  //  (ADR 2026-05-23-region-a-v76, 2026-07-27 전송 payload 로 재확인: tools 42개 중 1개).
  //  같은 능력을 두 벌 붙이면 모델이 어느 쪽을 쓸지 흔들리고, 이쪽은 API 키까지 든다.
  //  실제 갭은 **openai 어댑터**다 — file-ops 를 쓰는데 검색 수단이 없다.
  //  claude=SDK builtin / codex=backend native / openai=config provider 로 각자 닫는다.
  const searchCfg = includeWebSearch ? loadWebSearchConfig(base) : undefined;
  const webSearchTool = tool(
    "WebSearch",
    `웹을 검색해 상위 결과(제목·URL·요약)를 반환합니다. 결과는 요약만 주므로, 내용이 필요하면 WebFetch 로 해당 URL 을 이어서 읽으세요. 기본 ${WEBSEARCH_DEFAULT_COUNT}건 / 최대 ${WEBSEARCH_MAX_COUNT}건.`,
    {
      query: z.string().min(1).describe("검색어"),
      count: z
        .number()
        .int()
        .min(1)
        .max(WEBSEARCH_MAX_COUNT)
        .optional()
        .describe(`결과 수 (기본 ${WEBSEARCH_DEFAULT_COUNT}, 최대 ${WEBSEARCH_MAX_COUNT})`),
    },
    async (args) => {
      if (searchCfg === undefined) {
        // 등록 조건상 도달 불가지만, 설정이 런타임에 사라진 경우를 대비한 정직한 안내.
        return errText(
          "웹 검색이 설정되지 않았습니다. settings.json 의 `search.provider`(brave|tavily) + 해당 API 키 env 를 설정하세요.",
        );
      }
      const count = Math.min(args.count ?? WEBSEARCH_DEFAULT_COUNT, WEBSEARCH_MAX_COUNT);
      try {
        const hits =
          searchCfg.provider === "brave"
            ? await searchBrave(args.query, count, searchCfg.apiKey)
            : await searchTavily(args.query, count, searchCfg.apiKey);
        if (hits.length === 0) return okText(`검색 결과 없음: "${args.query}"`);
        // 사람·모델이 같이 읽는 최소 형태. JSON 이 아니라 줄 단위 — 토큰이 덜 든다.
        const body = hits
          .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
          .join("\n\n");
        return okText(`검색: "${args.query}" (${hits.length}건)\n\n${body}`);
      } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          return errText(`timeout — 검색이 ${WEBSEARCH_TIMEOUT_MS / 1000}s 안에 끝나지 않음.`);
        }
        return errText(err.message ?? String(e));
      }
    },
  );

  return [
    readTool,
    globTool,
    grepTool,
    writeTool,
    editTool,
    bashTool,
    bashOutputTool,
    killShellTool,
    webFetchTool,
    // ★미설정이면 등록 자체를 안 한다 — 항상 실패하는 도구를 목록에 두면 매 턴 스키마
    //   토큰만 먹는다(호출도 안 될 도구에 컨텍스트를 내주지 않는다).
    ...(searchCfg !== undefined ? [webSearchTool] : []),
  ];
};

// ─── server 본체 ─────────────────────────────────────────────────────────
/**
 * codex 어댑터 전용 — file-ops in-process MCP server.
 * 외부 이름 노출 (SDK 가 박는 prefix): `mcp__file_ops__Read` 등.
 * (codex 어댑터는 SDK prefix 무관 — `tools[].name` 그대로 노출.)
 *
 * V5.5 = 3종 (Read/Glob/Grep). V5.6 = +2종 (Write/Edit). V5.7 = +1종 (Bash).
 * V5.9 = +1종 (WebFetch). 총 7종(+백그라운드 BashOutput/KillShell = 9 도구).
 *
 * ★공유 금지 (2026-07-03): McpServer 는 transport 하나만 물어 싱글턴 공유 시 한 브리지
 * close 가 다른 브리지 callTool 을 죽인다. 턴마다 전용 인스턴스로 격리. 백그라운드 셸
 * `BG_SHELLS` 는 **모듈 레벨**이라 인스턴스 재생성에도 유지(BashOutput/KillShell 회귀 0).
 *
 * ★3b (2026-07-07): `baseCwd` 주입 — 상대경로·Glob/Grep/Bash 기본 cwd 의 기준점.
 * 미주입 시 `getPaths().home`(회귀 0). codex/openai 어댑터가 턴 등록 시
 * `input.cwd ?? home` 을 넘겨 claude(SDK options.cwd) 와 대칭화 → #2 parity.
 *
 * ★threadKey (ADR 2026-07-17 Phase 2 §1, additive) — `baseCwd` 와 동형 선택적 2번째
 * 인자. 호출자(codex/openai 어댑터)가 `RegionASdkInput.threadKey` 를 전달하면
 * run_in_background Bash 가 그 값을 `shell.started.threadKey` 로 발행(대시보드 상관용).
 * 미전달 시 `""` 폴백 — 기존 호출부(baseCwd 만 주입) 전부 회귀 0.
 */
/**
 * 셸 도구 이름 — **여기가 정의점**이다. 어댑터가 이름을 다시 적지 않는다.
 *
 * ★claude 는 SDK 빌트인 Bash 를 쓰는데, 그건 SDK 서브프로세스 안에서 돌아 데몬이 파이프를
 *  못 쥔다 → `BG_SHELLS` 에 아무것도 안 쌓이고 대시보드 tail(`/api/shell-output`)이 404 다.
 *  카드는 뜨는데 **출력만 안 보인다**(2026-08-09 사용자 신고). codex·openai 는 이 MCP 를 써서
 *  잘 보인다 — 같은 기능이 어댑터마다 다른 것은 "모든 기능 LLM 무관" 위반이다.
 *  그래서 셋을 **한 경로로** 모은다(`Agent` → `spawn_agent` 와 같은 수법·같은 이유).
 */
export const SHELL_TOOL_NAMES = ["Bash", "BashOutput", "KillShell"] as const;

/**
 * 검색 도구 이름 — claude 빌트인을 대체할 수 있게 **동등 이상**으로 올린 것들(2026-08-09).
 *
 * - `Grep`: output_mode(content|files_with_matches|count)·`-i`·`-n`·`-A/-B/-C`·type·
 *   multiline·head_limit 을 갖췄고, **잘리면 잘렸다고 말한다**(조용한 절단 금지).
 * - `Glob`: **최근 수정 순** 정렬(claude 빌트인과 같은 순서 — 같은 질문에 같은 답).
 *
 * 파일 도구(Read/Write/Edit)는 **아직 아니다**: 우리 Read 는 PDF 를 못 준다 — MCP 도구 결과
 * 콘텐츠 타입에 문서가 없어서(text·image·resource 뿐) 프로토콜 한계다. 노력 문제가 아니라
 * 계약 문제라, 여기서 막으면 원칙 1(슈퍼셋 — 누락은 버그) 위반이 된다.
 */
export const SEARCH_TOOL_NAMES = ["Grep", "Glob"] as const;

export const createFileOpsMcpServer = (
  baseCwd?: string,
  threadKey?: string,
  opts?: {
    includeWebSearch?: boolean;
    abortSignal?: AbortSignal;
    /**
     * claude 용 부분 노출 — **우리 것이 동등 이상인 도구만** 넘긴다(셸 3종 + 검색 2종).
     * 파일 도구(Read/Write/Edit)는 SDK 빌트인을 유지한다(위 SEARCH_TOOL_NAMES 주석의 PDF 한계).
     */
    shellsOnly?: boolean;
    /**
     * ★중립 턴(게이트웨이) 전용 — **`Read` 하나만** 노출한다.
     *
     * claude 의 비전은 "첨부를 경로로 주고 모델이 `Read` 로 연다" 방식이다(prompt-assembly
     * formatAttachments). 게이트웨이는 `toolPolicy:none` 이라 도구가 0인데, 그동안은 SDK
     * 빌트인 `Read` 가 남아 있고 cwd 가 홈이라 우연히 열렸다. 소유자 컨텍스트 누수를 막으려
     * cwd 를 홈 밖으로 옮기자 **첨부가 cwd 밖이 되어 비전이 죽었다**(2026-08-09 실측:
     * 모델이 Read 를 부르려다 실패). 그래서 첨부가 있는 중립 턴에만 Read 를 되돌려준다 —
     * 셸·검색·쓰기는 없다.
     */
    readsOnly?: boolean;
  },
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "file-ops",
    version: "1.9.0",
    tools: (() => {
      const all = makeFileOpsTools(
        baseCwd ?? getPaths().home,
        threadKey ?? "",
        // 기본 false — 자체 검색 수단이 있는 어댑터(codex)에 중복 부착하지 않는다.
        // 검색이 없는 어댑터(openai)만 명시적으로 켠다.
        opts?.includeWebSearch === true,
        opts?.abortSignal,
      );
      if (opts?.readsOnly === true) {
        return all.filter((t) => ((t as { name?: string }).name ?? "") === "Read");
      }
      if (opts?.shellsOnly !== true) return all;
      const want = new Set<string>([...SHELL_TOOL_NAMES, ...SEARCH_TOOL_NAMES]);
      return all.filter((t) => want.has((t as { name?: string }).name ?? ""));
    })(),
  });
