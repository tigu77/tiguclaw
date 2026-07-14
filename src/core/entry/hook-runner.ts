/**
 * V7.4.a — Claude Code 훅 실행기 (UserPromptSubmit). 데몬에서 강제.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v74a-userpromptsubmit-hook.md`
 *  - README §능력 매트릭스 "훅 (pre/post tool, user-prompt 등) — 데몬에서 강제".
 *  - Claude Code settings.json hooks 표준:
 *    `{ hooks: { UserPromptSubmit: [{ matcher?, hooks: [{ type:"command", command }] }] } }`
 *
 * LLM-agnostic 핵심 (README "데몬에서 강제"):
 *  - 훅은 *채널 입구* (`src/index.ts`) 단일 지점에서 실행 → 영역 A(codex/claude)
 *    어느 어댑터든 동일하게 강제 (V7.3 슬래시와 같은 위치, LLM 무관).
 *
 * UserPromptSubmit 동작 (Claude Code 표준):
 *  - stdin 으로 JSON (`hook_event_name`/`prompt`/`cwd`/`channel`/`threadKey`) 전달.
 *  - exit 0 + stdout → stdout 을 추가 컨텍스트로 prompt 에 prepend.
 *  - exit 2 → block (stderr 가 이유). 그 외 exit → 에러 격리 (데몬 보호, 무시+로그).
 *
 * 보안·견고 게이트:
 *  - 셸 명령 자동 실행 — settings.json 은 *사용자 직접 정의* (신뢰 경계 안).
 *  - timeout 디폴트 60s (hook command `timeout` 필드로 조정). maxBuffer 1MB.
 *  - hook 실패가 데몬을 죽이지 않는다 (원칙 3 항상 떠있다) — spawn error/timeout
 *    모두 격리, block(exit 2) 만 명시 차단.
 *  - dep 추가 0 (node builtin child_process/fs/os/path).
 */
import { spawn } from "node:child_process";
import { loadSettingsLayers } from "../settings.js";

interface HookCommand {
  type: string;
  command: string;
  /** 초 단위. 미지정 시 60. */
  timeout?: number;
}

interface HookMatcher {
  /** 정규식 (optional). UserPromptSubmit 은 보통 빈 문자열 = 전체 매칭. */
  matcher?: string;
  hooks: HookCommand[];
}

export interface UserPromptSubmitResult {
  /** exit 0 stdout 누적 — prompt 에 prepend 할 추가 컨텍스트. 없으면 "". */
  additionalContext: string;
  /** exit 2 발생 시 true — 채널 입구가 prompt 처리 중단. */
  block: boolean;
  /** block 사유 (stderr). */
  blockReason?: string;
}

/**
 * settings.json 에서 hooks[event] 회수. V9.4 — 경로를 런타임 홈/프로젝트로 전환:
 *  - user 스코프 → `getPaths().settings`(=`<home>/settings.json`)
 *  - project 스코프 → `projectScope(cwd).settings`(=`<cwd>/settings.json`)
 * 이전 `.claude/settings.json` 폐기 (V9.3 §20 의도된 dev/runtime 분리 — `.claude` 는
 *  개발 레포 한정). 두 파일 병합 (user → project 순). 부재/파싱 실패는 빈 배열 (throw 0).
 * cwd 옵셔널 (기본 process.cwd()) — V9.3 discover* 하위호환 패턴 답습.
 *
 * 2026-07-14 — 공용 `loadSettingsLayers`(src/core/settings.ts) 로 일반화(ADR
 *  model-profiles-settings-json D4). 병합 순서·never-throw 격리·`.tiguclaw/`+레거시 flat
 *  경로는 그 헬퍼가 정확히 계승한다. 여기서는 hooks 의미(이벤트별 matcher concat/추가)만
 *  적용한다 — 소비자 2개(hooks + models.profiles)로 실증된 중복이라 추상화 정당.
 */
const loadSettingsHooks = (
  event: string,
  cwd: string = process.cwd(),
): HookMatcher[] => {
  const result: HookMatcher[] = [];
  // 홈 → 프로젝트 순 레이어. hooks 는 override 가 아니라 concat(프로젝트가 추가) — 병합
  // 순서 보존이 중요(기존 동작). 각 레이어에서 이벤트 matcher 배열만 뽑아 누적.
  for (const layer of loadSettingsLayers(cwd)) {
    const hooks = layer.hooks?.[event];
    if (Array.isArray(hooks)) {
      for (const m of hooks) {
        if (
          m &&
          typeof m === "object" &&
          Array.isArray((m as HookMatcher).hooks)
        ) {
          result.push(m as HookMatcher);
        }
      }
    }
  }
  return result;
};

/** spawn 셸 실행 — stdin JSON 주입, stdout/stderr 캡처, timeout. */
const runShellHook = (
  command: string,
  stdinData: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(process.env.ComSpec || "cmd", ["/c", command], {
            timeout: timeoutMs,
          })
        : spawn("sh", ["-c", command], {
            timeout: timeoutMs,
            // maxBuffer 는 spawn 에 없음 — stdout 누적 직접 cap.
          });
    let stdout = "";
    let stderr = "";
    const CAP = 1024 * 1024; // 1MB
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.on("error", () => {
      // spawn 실패 (sh 부재 등) — 에러 격리 (데몬 보호).
      resolve({ stdout, stderr, code: -1 });
    });
    try {
      child.stdin.write(stdinData);
      child.stdin.end();
    } catch {
      // stdin write 실패 격리.
    }
  });

/**
 * 범용 훅 실행 엔진 — 어느 hook event 든 settings.json 에서 읽어 셸 실행.
 * UserPromptSubmit/Stop/PreToolUse/PostToolUse 등이 본 함수를 공유한다.
 *  - exit 0 + stdout → additionalContext 누적 (이벤트별 호출자가 활용 방식 결정).
 *  - exit 2 → block (Claude Code 표준 — block 의미는 이벤트별 호출자가 해석).
 *  - 그 외 exit → 에러 격리 (무시 + 로그). 데몬 생존 우선 (원칙 3).
 *  - hook 0개면 즉시 반환 (오버헤드 0).
 *
 * payload 는 stdin JSON 에 그대로 직렬화 (`hook_event_name` 은 event 로 자동).
 */
export const runHooks = async (
  event: string,
  payload: Record<string, unknown>,
  cwd: string = process.cwd(),
): Promise<UserPromptSubmitResult> => {
  const matchers = loadSettingsHooks(event, cwd);
  if (matchers.length === 0) {
    return { additionalContext: "", block: false };
  }

  const stdinJson = JSON.stringify({ hook_event_name: event, ...payload });

  let additionalContext = "";
  for (const m of matchers) {
    for (const h of m.hooks) {
      if (h.type !== "command") continue;
      const timeoutMs = (h.timeout ?? 60) * 1000;
      const { stdout, stderr, code } = await runShellHook(
        h.command,
        stdinJson,
        timeoutMs,
      );
      if (code === 2) {
        return {
          additionalContext: "",
          block: true,
          blockReason: stderr.trim() || `${event} 훅이 차단했습니다.`,
        };
      }
      if (code === 0 && stdout.trim()) {
        additionalContext += stdout;
      }
      if (code !== 0 && code !== 2) {
        console.error(
          `[hook] ${event} 명령 비정상 종료 (code ${code}): ${h.command}`,
        );
      }
    }
  }

  return { additionalContext: additionalContext.trim(), block: false };
};

/**
 * UserPromptSubmit 훅 — 채널 입구가 route 직전 호출.
 * exit 2 → 요청 차단, exit 0 stdout → prompt 에 prepend 할 컨텍스트.
 */
export const runUserPromptSubmitHooks = (params: {
  prompt: string;
  cwd: string;
  channel: string;
  threadKey: string;
}): Promise<UserPromptSubmitResult> =>
  runHooks(
    "UserPromptSubmit",
    {
      prompt: params.prompt,
      cwd: params.cwd,
      channel: params.channel,
      threadKey: params.threadKey,
    },
    params.cwd, // V9.4 🚩A — project 스코프 settings 가 실제 호출 cwd 와 정합.
  );

/**
 * Stop 훅 — 채널 출구가 응답 reply 직전 호출 (응답 후처리·관측·알림).
 * 데몬은 turn 단발이라 exit 2(계속 진행) 의미는 약함 — block 신호는 반환하되
 * 호출자가 무시(응답 그대로 전달). stdout 은 additionalContext 로 받아
 * 호출자가 응답에 덧붙일지 결정 (현재는 fire-and-forget 후처리 위주).
 */
export const runStopHooks = (params: {
  response: string;
  cwd: string;
  channel: string;
  threadKey: string;
}): Promise<UserPromptSubmitResult> =>
  runHooks(
    "Stop",
    {
      response: params.response,
      cwd: params.cwd,
      channel: params.channel,
      threadKey: params.threadKey,
    },
    params.cwd, // V9.4 🚩A — project 스코프 settings 가 실제 호출 cwd 와 정합.
  );
