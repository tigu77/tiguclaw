/**
 * V7.4.a — Claude Code 훅 실행기 (UserPromptSubmit). 데몬에서 강제.
 * Phase 1 (2026-07-24) — PreToolUse(차단)/PostToolUse(관찰) 확장.
 * Phase 1.1 (2026-07-24) — SubagentStop(관찰) 확장. 지점: `worker-jobs.ts`
 *   `markDone`/`markFailed` 단일 진입점(kind==='agent' 만) — codex/openai(agent-registry.ts)
 *   ·claude(claude-agent-sdk.ts) 양쪽 경로가 이미 이 두 함수로 수렴하므로 새 실행 경로
 *   0 으로 3어댑터 대칭이 공짜로 확보된다(데몬레벨 단일 지점, README "데몬에서 강제").
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v74a-userpromptsubmit-hook.md`,
 *    `docs/decisions/2026-05-24-...v74b-stop-hook.md`,
 *    `docs/decisions/2026-07-24-pretooluse-posttooluse-hooks.md`(예정).
 *  - 계약: `_workspace/hooks_phase1_architect_contract.md` (architect 확정본).
 *  - README §능력 매트릭스 "훅 (pre/post tool, user-prompt 등) — 데몬에서 강제".
 *  - Claude Code settings.json hooks 표준:
 *    `{ hooks: { UserPromptSubmit: [{ matcher?, hooks: [{ type:"command", command }] }] } }`
 *
 * LLM-agnostic 핵심 (README "데몬에서 강제"):
 *  - 훅은 *채널 입구* (`src/index.ts`) 단일 지점에서 실행 → 영역 A(codex/claude)
 *    어느 어댑터든 동일하게 강제 (V7.3 슬래시와 같은 위치, LLM 무관).
 *  - PreToolUse/PostToolUse 는 채널 입구가 아니라 *도구 호출 경계* (어댑터별 callTool
 *    직전/직후)에서 3어댑터가 각자 이 파일의 `runPreToolUseHooks`/`runPostToolUseHooks`
 *    를 호출 — 실행 엔진(`runHooks`)은 완전히 동일해 #2(멀티 LLM) 를 물리적으로 보장.
 *
 * UserPromptSubmit 동작 (Claude Code 표준):
 *  - stdin 으로 JSON (`hook_event_name`/`prompt`/`cwd`/`channel`/`threadKey`) 전달.
 *  - exit 0 + stdout → stdout 을 추가 컨텍스트로 prompt 에 prepend.
 *  - exit 2 → block (stderr 가 이유). 그 외 exit → 에러 격리 (데몬 보호, 무시+로그).
 *
 * PreToolUse/PostToolUse 동작 (Phase 1 — 계약 §0 "관찰 + 차단"만):
 *  - PreToolUse: exit 2 → 도구 실행 차단(`block`). exit 0 stdout(additionalContext)
 *    은 *의도적으로 버린다* — openai(@openai/agents) guardrail 이 입력수정/자유주입을
 *    지원하지 않아 3어댑터 대칭을 깨기 때문 (계약 §0 명시 제외, Phase 2 별건).
 *  - PostToolUse: 관찰 전용. block/additionalContext 전부 무시 — 반환 없음(void).
 *  - 두 이벤트 모두 `tool_name` 은 `normalizeToolName` 으로 어댑터 간 통일한 뒤
 *    payload 에 넣는다 (계약 §4-3, O2 — claude 의 `mcp__server__tool` 접두사 제거).
 *  - 차단 시 모델에게 보일 문자열은 `formatToolBlock` 단일 함수로만 생성(계약 §2).
 *
 * 보안·견고 게이트:
 *  - 셸 명령 자동 실행 — settings.json 은 *사용자 직접 정의* (신뢰 경계 안).
 *  - timeout 디폴트 60s (hook command `timeout` 필드로 조정). maxBuffer 1MB.
 *  - hook 실패가 데몬을 죽이지 않는다 (원칙 3 항상 떠있다) — spawn error/timeout
 *    모두 격리, block(exit 2) 만 명시 차단.
 *  - dep 추가 0 (node builtin child_process/fs/os/path).
 */
import { spawn } from "node:child_process";
import { loadSettingsLayers, loadSettingsLayersWithSource } from "../settings.js";

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
 * 훅 발화 관측 이벤트 (대시보드 emit 전용, 2026-07-24) — `PROJECT.md` daemon-engineer
 * 지시. 4이벤트(UserPromptSubmit/Stop/PreToolUse/PostToolUse) 공통 shape. `runHooks` 가
 * 매칭된 훅을 **실제로 spawn 했을 때만**(matchers.length>0) emit — 훅 미설정/미매칭이면
 * emit 0(노이즈 0·회귀 0, 아래 `setHookObserver` 참고).
 */
export interface HookActivity {
  /** UserPromptSubmit | Stop | PreToolUse | PostToolUse. */
  event: string;
  /** PreToolUse/PostToolUse 만 — `normalizeToolName` 적용된 값. */
  toolName?: string;
  /** true — matcher 매칭된 훅이 1개 이상 있어 실제 spawn 했다(emit 자체가 이 조건에서만 일어나므로 항상 true). */
  matched: boolean;
  /** exit 2 (차단) 발생 여부. */
  blocked: boolean;
  /** blocked=true 일 때만 의미 — stderr. */
  blockReason?: string;
  /** 매칭된 모든 훅 실행 합산 소요시간(ms). */
  durationMs: number;
  cwd?: string;
  channel?: string;
  threadKey?: string;
}

// 모듈레벨 observer sink — self-update 의 `setSelfUpdateRestart` 와 동형 패턴(index.ts
// 부팅 시 1회 EventBus 로 배선). 어댑터 시그니처(runPreToolUseHooks 등)는 불변 — sink
// 는 부수효과로만 관여, 반환값에 영향 0(프런트 렌더는 별도 소비자 몫, 여기선 emit 만).
let hookObserver: ((ev: HookActivity) => void) | null = null;

/** 부팅 시 1회 등록 (index.ts). 미등록 상태(null)면 emit 은 완전 no-op. */
export const setHookObserver = (
  fn: ((ev: HookActivity) => void) | null,
): void => {
  hookObserver = fn;
};

/** observer 콜백 예외가 훅 실행 경로를 절대 방해하지 않도록 격리(원칙 3). */
const emitHookActivity = (
  event: string,
  toolName: string | undefined,
  blocked: boolean,
  blockReason: string | undefined,
  startedAt: number,
  payload: Record<string, unknown>,
): void => {
  if (hookObserver === null) return;
  try {
    hookObserver({
      event,
      toolName,
      matched: true,
      blocked,
      blockReason,
      durationMs: Date.now() - startedAt,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      channel: typeof payload.channel === "string" ? payload.channel : undefined,
      threadKey:
        typeof payload.threadKey === "string" ? payload.threadKey : undefined,
    });
  } catch (err) {
    console.error("[hook] observer 콜백 예외(격리):", err);
  }
};

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

/**
 * 인벤토리 노출용 훅 이벤트 목록(2026-07-24, daemon-engineer PROJECT.md 지시) —
 * 대시보드가 "등록된 훅"을 1급 능력 카테고리로 봐야 하므로, `runHooks`가 실제 지원하는
 * 5이벤트를 열거한다(SubagentStop 추가, Phase 1.1). 새 이벤트 추가 시 이 배열도 갱신
 * (런타임 `runHooks` 자체는 임의 event 문자열을 받지만, settings.json 관례상 알려진
 * 이벤트만 사용자가 채운다).
 */
const INVENTORY_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "SubagentStop",
] as const;

/** 인벤토리 한 항목 — 이벤트/matcher/command 요약 + 어느 settings.json 스코프에서 왔는지. */
export interface HookInventoryItem {
  event: string;
  /** 미지정/빈 문자열이면 "*"(전체 매칭) — `matchesTool` 시맨틱과 동일. */
  matcher: string;
  command: string;
  /** "home" = `<home>/settings.json`. "project" = `.tiguclaw/settings.json`(+레거시 flat). */
  scope: "home" | "project";
  /** settings.json 절대 경로. */
  source: string;
}

/**
 * settings.json(홈+프로젝트) 에 등록된 모든 훅을 인벤토리 아이템으로 열거(2026-07-24).
 * `loadSettingsHooks`(런타임 매칭 실행 경로) 와 목적이 다르다 — 이건 "무엇이 설정돼
 * 있는가" 를 스코프 보존한 채 보여주는 읽기 전용 나열이라, 이벤트별 concat 이 아니라
 * 이벤트×레이어 조합을 그대로 펼친다. 파싱 자체는 `loadSettingsLayersWithSource`
 * (settings.ts) 단일 소스 재사용 — 여기서 JSON 읽기/파싱을 다시 구현하지 않는다(중복
 * 파서 금지, PROJECT.md §3). never-throw(한 hook 엔트리 실패는 skip, 나머지는 계속).
 */
export const listHooksForInventory = (
  cwd: string = process.cwd(),
): HookInventoryItem[] => {
  const out: HookInventoryItem[] = [];
  for (const layer of loadSettingsLayersWithSource(cwd)) {
    for (const event of INVENTORY_HOOK_EVENTS) {
      try {
        const matchers = layer.settings.hooks?.[event];
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers) {
          if (
            !m ||
            typeof m !== "object" ||
            !Array.isArray((m as HookMatcher).hooks)
          ) {
            continue;
          }
          const rawMatcher = (m as HookMatcher).matcher;
          const matcher =
            typeof rawMatcher === "string" && rawMatcher.trim() !== ""
              ? rawMatcher.trim()
              : "*";
          for (const h of (m as HookMatcher).hooks) {
            if (!h || h.type !== "command" || typeof h.command !== "string") {
              continue;
            }
            out.push({
              event,
              matcher,
              command: h.command,
              scope: layer.scope,
              source: layer.path,
            });
          }
        }
      } catch {
        // 한 (레이어, 이벤트) 조합 실패 — 다른 조합은 계속(원칙 3).
      }
    }
  }
  return out;
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
 * matcher 정규식이 현재 tool_name 에 매칭되는지 판정 (Claude Code 시맨틱, QA 결함
 * "matcher" 수정, 2026-07-24).
 *  - `toolName === undefined` → 이벤트 자체가 tool_name 을 안 실는다(UserPromptSubmit/
 *    Stop) → matcher 필드가 있을 수 없는 이벤트라 항상 매칭(기존 동작 불변, 회귀 0).
 *  - `matcher` 미지정/빈문자열 → Claude Code 표준상 전체 매칭.
 *  - 그 외 → 정규식 test. 잘못된 정규식은 throw 대신 매칭 실패로 격리(원칙 3).
 */
const matchesTool = (
  matcher: string | undefined,
  toolName: string | undefined,
): boolean => {
  if (toolName === undefined) return true;
  if (!matcher || matcher.trim() === "") return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
};

/**
 * 범용 훅 실행 엔진 — 어느 hook event 든 settings.json 에서 읽어 셸 실행.
 * UserPromptSubmit/Stop/PreToolUse/PostToolUse 등이 본 함수를 공유한다.
 *  - exit 0 + stdout → additionalContext 누적 (이벤트별 호출자가 활용 방식 결정).
 *  - exit 2 → block (Claude Code 표준 — block 의미는 이벤트별 호출자가 해석).
 *  - 그 외 exit → 에러 격리 (무시 + 로그). 데몬 생존 우선 (원칙 3).
 *  - hook 0개면 즉시 반환 (오버헤드 0).
 *  - `toolName` (옵션) — PreToolUse/PostToolUse 호출자가 넘기면 각 matcher 엔트리의
 *    `matcher` 정규식을 이 값에 매칭해, 매칭되는 엔트리의 hooks 만 실행한다(Claude
 *    Code parity — QA 결함 "matcher" 수정). 미전달(UserPromptSubmit/Stop) 시 전부 매칭
 *    (기존 동작 불변).
 *
 * payload 는 stdin JSON 에 그대로 직렬화 (`hook_event_name` 은 event 로 자동).
 */
export const runHooks = async (
  event: string,
  payload: Record<string, unknown>,
  cwd: string = process.cwd(),
  toolName?: string,
): Promise<UserPromptSubmitResult> => {
  const matchers = loadSettingsHooks(event, cwd).filter((m) =>
    matchesTool(m.matcher, toolName),
  );
  if (matchers.length === 0) {
    return { additionalContext: "", block: false };
  }

  const startedAt = Date.now();
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
        const blockReason = stderr.trim() || `${event} 훅이 차단했습니다.`;
        emitHookActivity(event, toolName, true, blockReason, startedAt, payload);
        return {
          additionalContext: "",
          block: true,
          blockReason,
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

  emitHookActivity(event, toolName, false, undefined, startedAt, payload);
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

// ── Phase 1 (2026-07-24) — PreToolUse/PostToolUse ──────────────────────────
// 계약: `_workspace/hooks_phase1_architect_contract.md` §1/§2/§4-3.

/**
 * tool_name 정규화 (계약 §4-3, O2).
 *
 * claude Agent SDK 는 in-process MCP 도구를 `mcp__<server>__<tool>` 네임스페이스로
 * 노출한다(예: `mcp__file_ops__Read`, `mcp__memory__read_memory`). codex/openai 수동
 * 브리지는 같은 도구를 접두사 없는 원래 이름으로 노출한다(예: `Read`, `read_memory`
 * — `src/scripts/verify-external-mcp.ts` 실증: 외부 MCP 도 codex 는 `echo`, claude 는
 * `mcp__echo__echo`). matcher 가 정규식으로 `tool_name` 을 매칭하므로, 세 어댑터가
 * 같은 도구에 다른 이름을 넘기면 #2(멀티 LLM 대칭) 가 조용히 깨진다 — 그래서 hook
 * payload 에 넣기 전 항상 이 함수를 통과시켜 접두사를 벗긴다.
 *
 * `mcp__` 로 시작하지 않으면 원본 그대로 반환(codex/openai 는 이미 정규화된 이름).
 * 서버/도구 이름 자체는 이 코드베이스 관례상 `_`(단일 밑줄) 만 쓰고 `__`(이중 밑줄)
 * 은 세그먼트 구분자 전용이라 `split("__")` 로 안전하게 3파트(`mcp`/server/tool) 이상
 * 으로 나뉜다 — 마지막 세그먼트가 실제 도구명.
 */
export const normalizeToolName = (rawName: string): string => {
  if (!rawName.startsWith("mcp__")) return rawName;
  const parts = rawName.split("__");
  return parts.length >= 3 ? parts[parts.length - 1] : rawName;
};

/**
 * 도구 차단 시 모델에게 보일 단일 포맷 문자열 (계약 §2 — 3어댑터 바이트 동일 강제).
 * 어댑터가 제각각 포맷하지 못하도록 이 함수 하나만 사용한다.
 */
export const formatToolBlock = (toolName: string, blockReason?: string): string =>
  `⛔ Tool \`${toolName}\` blocked by PreToolUse hook: ${
    blockReason?.trim() || "PreToolUse 훅이 차단했습니다."
  }`;

/** PreToolUse 결과 — 차단 판정만(계약 §1.2). additionalContext 는 노출 안 함. */
export interface PreToolUseResult {
  block: boolean;
  /** exit2 stderr. `block=true` 일 때만 의미. */
  blockReason?: string;
}

/**
 * PreToolUse 훅 — 3어댑터가 callTool 직전에 호출(codex/openai 수동 배선,
 * claude 는 SDK hooks 콜백에서 위임). `runHooks("PreToolUse", ...)` 를 그대로 재사용
 * (새 실행 경로 0 — 계약 §1). exit2 → block, `additionalContext`(stdout) 는 의도적으로
 * 버린다 — openai guardrail 이 입력수정/자유주입을 지원하지 않아 살리면 3어댑터
 * 비대칭이 생기기 때문(계약 §0 명시 제외, Phase 2 별건).
 */
export const runPreToolUseHooks = async (params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  channel: string;
  threadKey: string;
}): Promise<PreToolUseResult> => {
  const normalizedToolName = normalizeToolName(params.toolName);
  const result = await runHooks(
    "PreToolUse",
    {
      tool_name: normalizedToolName,
      tool_input: params.toolInput,
      cwd: params.cwd,
      channel: params.channel,
      threadKey: params.threadKey,
    },
    params.cwd, // V9.4 🚩A 패턴 계승 — project 스코프 settings 가 실제 호출 cwd 와 정합.
    normalizedToolName, // QA 결함 "matcher" 수정 — settings.json matcher 정규식 매칭용.
  );
  return { block: result.block, blockReason: result.blockReason };
};

/**
 * PostToolUse 훅 — 3어댑터가 callTool 결과 확정 직후 호출(관찰 전용, 계약 §1.2).
 * `runHooks("PostToolUse", ...)` 를 재사용하되 반환(block/additionalContext) 은 전부
 * 무시한다 — Phase 1 은 PostToolUse mutate/block 을 지원하지 않는다(계약 §0 제외).
 * 훅이 0 개면 `runHooks` 가 즉시 반환(오버헤드 0). fire-and-forget 호출 관례(codex
 * §3.1: `void runPostToolUseHooks(...)`) 를 지원하도록 내부에서 에러를 추가 격리한다
 * — 관찰 전용 경로가 도구 실행 결과 반환을 절대 지연·실패시키면 안 된다(원칙 3).
 */
export const runPostToolUseHooks = async (params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: string;
  cwd: string;
  channel: string;
  threadKey: string;
}): Promise<void> => {
  try {
    const normalizedToolName = normalizeToolName(params.toolName);
    await runHooks(
      "PostToolUse",
      {
        tool_name: normalizedToolName,
        tool_input: params.toolInput,
        tool_response: params.toolResponse,
        cwd: params.cwd,
        channel: params.channel,
        threadKey: params.threadKey,
      },
      params.cwd,
      normalizedToolName, // QA 결함 "matcher" 수정 — settings.json matcher 정규식 매칭용.
    );
  } catch (err) {
    // runHooks 는 원래 never-throw 지만, 관찰 전용 경로라 이중 방어(원칙 3).
    console.error("[hook] PostToolUse 실행 중 예외(격리):", err);
  }
};

// ── Phase 1.1 (2026-07-24) — SubagentStop ───────────────────────────────────
// 지점: `src/core/worker-jobs.ts` `markDone`/`markFailed`(kind==='agent' 잡만).
// 서브에이전트(spawn_agent, claude 네이티브 Task 포함) 완료 시 daemon 이 강제 호출.
// 워커(kind==='worker', run_in_background)는 Claude Code 시맨틱상 SubagentStop 대상이
// 아니라(SubagentStop = Task *서브에이전트* 종료 전용, 워커는 별개 개념) 제외.

/**
 * SubagentStop 훅 — 서브에이전트(kind:'agent' 워커 잡) 완료(done/failed) 시 daemon 이
 * 호출(관찰 전용, Claude Code 표준 SubagentStop 시맨틱 답습). PreToolUse/PostToolUse 와
 * 마찬가지로 `runHooks("SubagentStop", ...)` 를 재사용(새 실행 경로 0). 이미 종료된
 * 잡에 대한 통지라 block/additionalContext 는 의미가 없어 전부 버린다(반환 void) —
 * PostToolUse 와 동형(계약 §0 관찰형 이벤트 패턴).
 *
 * 호출자(`worker-jobs.ts`)가 동기 함수(markDone/markFailed) 안에서 fire-and-forget
 * (`void runSubagentStopHooks(...)`)으로 부르므로, 내부에서 예외를 이중 격리해
 * 훅 실행이 절대 잡 완료 마킹 경로를 지연·실패시키지 않는다(원칙 3).
 */
export const runSubagentStopHooks = async (params: {
  /** 완료된 잡 id (worker-jobs 의 jobId). */
  jobId: string;
  /** 서브에이전트 정의 이름(agent.md 의 name). */
  agentName?: string;
  /** 잡을 띄운 *원* 대화 thread (부모 threadKey — 실행 thread `agent:<jobId>` 가 아님). */
  threadKey: string;
  /** 잡이 실행된 cwd. 미지정 시 process.cwd() 폴백(호출자가 항상 채우는 게 원칙). */
  cwd?: string;
  channel: string;
  status: "done" | "failed";
  /** 결과(done) 또는 에러(failed) 요약 — stdin JSON 의 `summary` 필드. 길이 컷은 호출자 몫. */
  summary: string;
}): Promise<void> => {
  try {
    const cwd = params.cwd ?? process.cwd();
    await runHooks(
      "SubagentStop",
      {
        job_id: params.jobId,
        agent_name: params.agentName,
        threadKey: params.threadKey,
        cwd,
        channel: params.channel,
        status: params.status,
        summary: params.summary,
      },
      cwd,
    );
  } catch (err) {
    // runHooks 는 never-throw 지만, 완료-마킹 경로 안에서 fire-and-forget 되므로
    // 이중 방어(PostToolUse 패턴 동형, 원칙 3).
    console.error("[hook] SubagentStop 실행 중 예외(격리):", err);
  }
};
