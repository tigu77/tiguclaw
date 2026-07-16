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
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
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
import { detectShell } from "../../runtime-env.js";

const execFileP = promisify(execFile);

// 셸 선택 — env 블록(runtime-env.ts formatEnvContext)의 Shell 힌트와 단일 소스
// (계약 §0 핵심통찰: 모델이 뱉는 문법 = 도구가 실행하는 셸 = 항상 일치). 모듈 로드
// 1회 호출(불변) — RG_PATH 패턴과 동형. unix 는 {bin:"sh", argsFor:["-c",cmd]} 라
// 아래 fg/bg 배선이 기존 하드코딩과 인자 바이트 동일(회귀 0).
const SHELL = detectShell();

// ─── ripgrep 바이너리 해소 (크로스플랫폼) ────────────────────────────────
// Glob/Grep 는 ripgrep 에 의존한다. claude 는 SDK 내장 도구가 알아서 번들 rg 를
// 쓰지만, codex 등 SDK 내장도구가 없는 어댑터는 이 file-ops 가 직접 rg 를 부른다.
// system PATH 의 `rg` 는 mac(brew 미설치·데몬 PATH 누락)·Windows(rg 부재)에서 깨짐.
// 그런데 하드의존인 @anthropic-ai/claude-agent-sdk 가 *모든 플랫폼* rg 를 vendor 로
// 동봉한다(npm tarball 동봉 — postinstall 다운로드 아님, files 미지정=전체배포).
// 그 바이너리를 직접 가리켜 PATH 의존을 제거 → mac·Windows·로컬LLM 사용자 모두
// 무설치 동작. claude(SDK 내장)는 이 경로를 안 거치므로 영향 0 — codex 결함을
// codex 어댑터 안에서 닫는 수정. 못 찾으면 PATH 의 "rg" 폴백(절대 현행보다 안 나빠짐).
const RG_PATH = ((): string => {
  try {
    const require = createRequire(import.meta.url);
    const sdkPkg = require.resolve(
      "@anthropic-ai/claude-agent-sdk/package.json",
    );
    const bin = process.platform === "win32" ? "rg.exe" : "rg";
    const vendored = path.join(
      path.dirname(sdkPkg),
      "vendor",
      "ripgrep",
      `${process.arch}-${process.platform}`,
      bin,
    );
    return existsSync(vendored) ? vendored : "rg";
  } catch {
    return "rg";
  }
})();

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
// codex/openai 어댑터는 이 file-ops Bash 를 쓰므로 여기서 채워 #2 parity 회복.
// ★모듈 레지스트리 = 턴을 가로질러 생존(worker-jobs 패턴 동형, in-memory·best-effort).
//   file-ops 팩토리가 턴마다 새 인스턴스여도(baseCwd 주입, McpServer transport 격리)
//   BG_SHELLS 는 모듈 레벨이라 유지 → BashOutput/KillShell 회귀 0.
// 데몬 종료 시 자식은 함께 죽음(detach 안 함 → orphan 0). 재시작 비생존 = 정직(W-I7 동형).
interface BgShell {
  child: ReturnType<typeof spawn>;
  command: string;
  stdout: string;
  stderr: string;
  stdoutRead: number; // BashOutput 이 이미 반환한 offset (증분 폴링).
  stderrRead: number;
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  startedAt: number;
}
const BG_SHELLS = new Map<string, BgShell>();
const BG_MAX = 20; // 동시 백그라운드 셸 상한(메모리 바운드).

// 버퍼 append — 1MB cap 도달 후엔 더 안 쌓는다(메모리 바운드 + offset 보존).
const appendCapped = (cur: string, chunk: string): string => {
  if (cur.length >= BASH_MAX_BUFFER_BYTES) return cur;
  const next = cur + chunk;
  return next.length > BASH_MAX_BUFFER_BYTES
    ? next.slice(0, BASH_MAX_BUFFER_BYTES) + BASH_TRUNCATE_MARKER
    : next;
};

// baseCwd 주입(3b) — 백그라운드 셸도 턴 cwd 기준으로 실행(포그라운드 Bash 와 대칭).
const launchBgShell = (command: string, cwd: string): string => {
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
  const child = spawn(SHELL.bin, SHELL.argsFor(command), { cwd });
  const shell: BgShell = {
    child,
    command,
    stdout: "",
    stderr: "",
    stdoutRead: 0,
    stderrRead: 0,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
  };
  child.stdout?.on("data", (d: Buffer) => {
    shell.stdout = appendCapped(shell.stdout, d.toString("utf8"));
  });
  child.stderr?.on("data", (d: Buffer) => {
    shell.stderr = appendCapped(shell.stderr, d.toString("utf8"));
  });
  child.on("error", () => {
    if (shell.status === "running") {
      shell.status = "completed";
      shell.exitCode = -1;
    }
  });
  child.on("close", (code) => {
    if (shell.status === "running") {
      shell.status = "completed";
      shell.exitCode = code ?? 0;
    }
  });
  BG_SHELLS.set(id, shell);
  return id;
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

// ─── 도구 빌더 (baseCwd 클로저) ──────────────────────────────────────────
// ★3b: 도구들이 base(턴 cwd)를 클로저로 잡는다. 상대경로 기준점·Glob/Grep/Bash 기본
//   cwd 가 전부 base. 팩토리가 턴마다 base 를 주입하므로 병렬 안전(무전역, 인스턴스=턴).
const makeFileOpsTools = (base: string) => {
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
        const raw = await fs.readFile(abs, "utf8");
        const lines = raw.split("\n");
        const start = (args.offset ?? 1) - 1;
        const limit = args.limit ?? DEFAULT_READ_LIMIT;
        const slice = lines.slice(start, start + limit);
        let body = slice.join("\n");
        if (body.length > READ_BODY_HARD_CAP) {
          body = `${body.slice(0, READ_BODY_HARD_CAP - 1)}…`;
        }
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
    "글로브 패턴으로 파일 경로를 찾습니다. cwd 미지정 시 현재 작업폴더(프로젝트/홈). 최대 1000개 반환.",
    {
      pattern: z.string().min(1),
      cwd: z.string().optional(),
    },
    async (args) => {
      try {
        const cwd = args.cwd !== undefined ? resolvePath(args.cwd) : base;
        // rg `--files` = cwd 내 모든 파일 나열 (.gitignore 존중), `-g <pattern>` 으로 필터.
        const { stdout } = await execFileP(
          RG_PATH,
          ["--files", "-g", args.pattern, cwd],
          { maxBuffer: GLOB_MAX_BUFFER },
        ).catch(
          (e: NodeJS.ErrnoException & { stdout?: string; code?: number }) => {
            if (e.code === 1) return { stdout: "" };
            throw e;
          },
        );
        const lines = stdout.split("\n").filter((l) => l.length > 0);
        const sliced = lines.slice(0, GLOB_MAX_RESULTS);
        return okText(JSON.stringify(sliced));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("ENOENT")) {
          return errText(
            `ripgrep(rg) 가 PATH 에 없습니다. brew install ripgrep 후 재시도. (원본: ${msg})`,
          );
        }
        return errText(msg);
      }
    },
  );

  // ─── Grep 도구 ─────────────────────────────────────────────────────────
  // ripgrep 직접 호출. path 미지정 시 base. glob 으로 파일 필터.
  const grepTool = tool(
    "Grep",
    "ripgrep 으로 패턴 매칭 라인을 찾습니다. path 미지정 시 현재 작업폴더(프로젝트/홈). glob 으로 파일 필터링.",
    {
      pattern: z.string().min(1),
      path: z.string().optional(),
      glob: z.string().optional(),
    },
    async (args) => {
      try {
        const searchPath =
          args.path !== undefined ? resolvePath(args.path) : base;
        const rgArgs = ["-n", "--no-heading", "--color=never"];
        if (args.glob !== undefined) {
          rgArgs.push("--glob", args.glob);
        }
        rgArgs.push("-e", args.pattern, searchPath);
        const { stdout } = await execFileP(RG_PATH, rgArgs, {
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
        const sliced = lines.slice(0, GREP_MAX_LINES);
        return okText(JSON.stringify(sliced));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // ripgrep 부재 케이스 별도 hint.
        if (msg.includes("ENOENT")) {
          return errText(
            `ripgrep(rg) 가 PATH 에 없습니다. brew install ripgrep 후 재시도. (원본: ${msg})`,
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
    "파일 내 부분 문자열 교체. old_string 이 0 또는 다수 매칭이면 (replace_all=false 디폴트 시) reject.",
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
        const id = launchBgShell(args.command, base);
        return okText(
          `백그라운드 실행 시작 (bash_id: ${id}). ` +
            `BashOutput({ bash_id: "${id}" }) 로 출력 폴링, KillShell 로 종료.`,
        );
      }

      // V5.7 안전 가드 2 — timeout clamp. ★param 은 *초* 단위(설명·모델 기대와 일치). 예전엔
      // ms 로 써서 모델이 `timeout:120`(120초 의도)을 넘기면 120ms→즉시 SIGKILL 이었다(2026-07-10).
      const timeoutSec = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS / 1000;
      const timeout = Math.min(timeoutSec * 1000, BASH_MAX_TIMEOUT_MS);

      try {
        // execFile SHELL.bin/argsFor — single shell layer, no shell:true (injection
        // 표면 최소). unix=sh -c, win32=cmd /c (detectShell() 단일 소스, env 블록의
        // Shell 힌트와 동형). killSignal = SIGKILL (디폴트 SIGTERM 무시하는 sleep/yes
        // 등 강제 종료).
        const { stdout, stderr } = await execFileP(
          SHELL.bin,
          SHELL.argsFor(args.command),
          {
            cwd: base,
            timeout,
            maxBuffer: BASH_MAX_BUFFER_BYTES,
            killSignal: "SIGKILL",
          },
        );
        const out = truncateBashOutput(stdout);
        const err = truncateBashOutput(stderr);
        // okText 본문 — stdout + stderr + exit code (성공 시 0).
        const parts: string[] = [];
        if (out.length > 0) parts.push(`stdout:\n${out}`);
        if (err.length > 0) parts.push(`stderr:\n${err}`);
        parts.push(`exit code: 0`);
        return okText(parts.join("\n\n"));
      } catch (e) {
        // execFile 실패 — timeout / non-zero exit / maxBuffer 초과 등.
        // NodeJS.ErrnoException 에 stdout/stderr/code/killed/signal 박혀 있음.
        const errExec = e as NodeJS.ErrnoException & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals;
        };
        const stdout =
          typeof errExec.stdout === "string"
            ? errExec.stdout
            : errExec.stdout instanceof Buffer
              ? errExec.stdout.toString("utf8")
              : "";
        const stderr =
          typeof errExec.stderr === "string"
            ? errExec.stderr
            : errExec.stderr instanceof Buffer
              ? errExec.stderr.toString("utf8")
              : "";
        const out = truncateBashOutput(stdout);
        const err = truncateBashOutput(stderr);

        // maxBuffer 초과 케이스 — ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
        const isMaxBuffer =
          errExec.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        // timeout 케이스 — killed === true && signal === "SIGKILL" (timeout clamp 후).
        // (maxBuffer 도 killed 박힘 — 분리 필수.)
        const isTimeout = errExec.killed === true && !isMaxBuffer;

        // maxBuffer 초과 시 stdout/stderr 의 끝에 truncate marker 박음
        // (truncateBashOutput 가 byte cap 이하라 marker 박지 않은 경계 케이스 보강).
        const outWithMarker =
          isMaxBuffer && !out.endsWith(BASH_TRUNCATE_MARKER)
            ? `${out}${BASH_TRUNCATE_MARKER}`
            : out;
        const errWithMarker =
          isMaxBuffer && err.length > 0 && !err.endsWith(BASH_TRUNCATE_MARKER)
            ? `${err}${BASH_TRUNCATE_MARKER}`
            : err;

        const parts: string[] = [];
        if (outWithMarker.length > 0) parts.push(`stdout:\n${outWithMarker}`);
        if (errWithMarker.length > 0) parts.push(`stderr:\n${errWithMarker}`);
        if (isTimeout) {
          parts.push(
            `Error: timeout — command 이 ${Math.round(timeout / 1000)}s 안에 끝나지 않아 SIGKILL 로 종료됨.`,
          );
        } else if (isMaxBuffer) {
          parts.push(`Error: maxBuffer 초과 (1MB) — stdout/stderr truncated.`);
        } else {
          const codeStr =
            typeof errExec.code === "number"
              ? `exit code: ${errExec.code}`
              : `Error: ${errExec.message ?? String(e)}`;
          parts.push(codeStr);
        }
        return okText(parts.join("\n\n"));
      }
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
      if (s.status === "running") {
        try {
          s.child.kill("SIGKILL");
        } catch {
          /* noop — 이미 죽었을 수 있음 */
        }
        s.status = "killed";
      }
      return okText(`종료 처리됨: ${args.bash_id} (status: ${s.status}).`);
    },
  );

  // ─── WebFetch 도구 (V5.9 — cwd 무관) ───────────────────────────────────
  const webFetchTool = tool(
    "WebFetch",
    "URL 의 본문을 받아 markdown 변환 후 반환합니다. http(s):// 만 허용. HTML 은 script/style 제거 + tag strip. timeout 디폴트 30s / max 60s. body 5MB cap.",
    {
      url: z.string().min(1),
      prompt: z.string().optional(),
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
 */
export const createFileOpsMcpServer = (
  baseCwd?: string,
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "file-ops",
    version: "1.7.0",
    tools: makeFileOpsTools(baseCwd ?? getPaths().home),
  });

// 노출 도구 목록 (inventory 등에서 참조 가능 — 본 라운드 hardcode 0).
export const FILE_OPS_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebFetch",
] as const;
