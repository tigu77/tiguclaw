/**
 * 영역 코어 leaf — 런타임 환경 자기인지 (env 블록) + 셸 선택 단일 소스.
 *
 * 계약: `_workspace/env-awareness_architect_contract.md` (architect, 2026-07-16).
 *
 * 문제: `buildSystemContextParts`(prompt-assembly.ts)가 매 턴 SYSTEM.md·AGENT.md·
 * 메모리·스킬/에이전트 인덱스 등을 주입하나 **환경 사실이 0개** — Claude Code 의
 * `<env>`(Working directory·Platform·OS Version·Today's date) 대비 파리티 갭이었다.
 * 또한 file-ops Bash 가 `sh` 하드코딩이라 Windows 에서 ENOENT — 그런데 셸을
 * win32 분기해도 모델이 자기가 Windows 인 줄 모르면 유닉스 문법을 뱉어 여전히
 * 실패한다. **env 블록의 셸 힌트와 Bash 도구가 실제 쓰는 셸은 반드시 이 한 leaf**
 * (`detectShell()`)에서 나와야 문법↔실행이 항상 일치한다.
 *
 * §0(단방향 불변식): node builtin `os`/`fs`/`path` 만 import. 순환 0, 플러그인
 * 이름·경로 참조 0. prompt-assembly(코어)와 file-ops-mcp(capability) 둘 다 여기서
 * import 한다.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShellSpec {
  /** 실행 바이너리. unix="sh", win32=ComSpec(보통 "cmd") 또는 override. */
  bin: string;
  /** command → child_process args. sh: ["-c", cmd] / cmd: ["/c", cmd]. */
  argsFor: (command: string) => string[];
  /** env 블록·도구 description 표기용 라벨. "sh" | "cmd.exe" | … */
  label: string;
  /** env 블록에 넣을 문법 힌트(모델이 이 문법으로 명령을 뱉게). */
  syntaxHint: string;
}

/**
 * 플랫폼별 셸 1개 선택. 순수(부작용 0)·동기·프로세스당 불변.
 *
 * 결정(계약 §2.1): win32 = `cmd /c`(ComSpec) — hook-runner.ts/restart.ts 기존
 * 선례와 동일 패턴(신규 리스크 0). Git Bash/WSL 자동탐지는 하지 않는다(WSL 이
 * Windows cwd 를 `/mnt/c` 네임스페이스로 조용히 깨뜨릴 수 있어 숨은 버그원 —
 * 원하는 사용자는 `TIGUCLAW_BASH_SHELL` 로 명시 opt-in).
 */
export const detectShell = (): ShellSpec => {
  const override = process.env.TIGUCLAW_BASH_SHELL?.trim();
  if (override !== undefined && override !== "") {
    return {
      bin: override,
      argsFor: (c: string) => ["-c", c],
      label: override,
      syntaxHint: `사용자 지정 셸(${override}) 문법을 쓰세요.`,
    };
  }
  if (process.platform === "win32") {
    const bin = process.env.ComSpec || "cmd.exe";
    return {
      bin,
      argsFor: (c: string) => ["/c", c],
      label: "cmd.exe (Windows cmd 문법)",
      syntaxHint:
        "Windows 명령을 쓰세요 (dir, type, findstr, copy, del). ls/cat/grep 아님. " +
        "파일 작업은 가급적 네이티브 Read/Glob/Grep/Write/Edit 도구를 쓰세요 (크로스플랫폼).",
    };
  }
  return {
    bin: "sh",
    argsFor: (c: string) => ["-c", c],
    label: "sh (POSIX 셸)",
    syntaxHint: "POSIX 셸 (ls, cat, grep, …).",
  };
};

const toYmd = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * `<env>` 블록 문자열 렌더. Claude Code `<env>` 컨벤션 파리티 + tiguclaw 확장(Shell).
 * cwd=턴 cwd(프로젝트/홈). now 미지정 시 `new Date()`(매 턴 fresh — 캐시 무해,
 * 계약 §1.5).
 */
export const formatEnvContext = (input: {
  cwd: string;
  now?: Date;
}): string => {
  const shell = detectShell();
  const lines = [
    "<env>",
    `Working directory: ${input.cwd}`,
    `Platform: ${process.platform}`,
    `OS Version: ${os.type()} ${os.release()}`,
    `Today's date: ${toYmd(input.now ?? new Date())}`,
    `Shell: ${shell.label} — ${shell.syntaxHint}`,
  ];
  // P2(선택) — 단순 체크(상위 워크트리 탐색 안 함). 미검출 시 라인 생략.
  if (existsSync(path.join(input.cwd, ".git"))) {
    lines.push("Is a git repo: yes");
  }
  lines.push("</env>");
  return lines.join("\n");
};
