/**
 * 영역 A 첫 어댑터 — Claude Agent SDK 위임.
 *
 * 진실 소스: `_workspace/region_a_abstract_architect_contract.md` §3.4.
 * 본 파일은 V1 의 `src/core/claude.ts` 본문을 *이동* (기능 변경 0). import path 만 정정.
 *
 * 권한 모델 (진실 소스: `.claude/memory/feedback_security_proactive.md`):
 *  1) 도구 호출 단위 = bypass. Claude Code 의 `bypassPermissions` 와 동일.
 *  2) 능력 도입 단위 + 명백히 위험한 도구 = 비서(LLM)가 능동 평가 → 사용자 승인.
 *
 * Claude Code 능력 발견 — **SDK 격리 모드** (settingSources 미설정,
 * runtimeTypes.d.ts L504). SDK 는 `.claude/{skills,agents,commands}` 를 자동
 * 발견하지 않는다. 따라서 tiguclaw 컨벤션(`<home>`/`<cwd>`/plugins)에서
 * `discoverSkills`/`discoverAgents` 로 직접 인덱스를 구성해 시스템 채널에 주입
 * + 서브에이전트는 `options.agents` 로 주입(SDK native Task tool 이 실행) +
 * 스킬 실행은 invoke_skill MCP — codex 어댑터와 parity (원칙 1·2).
 * 이중 노출 방지: settingSources 를 켜지 말 것 (아래 options 가드 주석 참조).
 *
 * Memory Round 2 변경 (contract `_workspace/memory_round2_architect_contract.md`):
 *  - AGENT.md (1층 self markdown, 런타임 홈 hub) 시스템 채널 주입.
 *  - V3 도구 4종 (read/add/update/delete memory) SDK in-process MCP server 로 노출.
 *  - 전체 memories 1줄 인덱스 user prompt prepend (휘발 조각 — 채널 유지).
 *  - V2 fire-and-forget haiku 자동 추출 deprecate (LLM 자기 도구로 대체).
 *
 *  fingerprint 가드 양립: SYSTEM_PROMPT_HASH 는 **정적 sysprompt 본문만** 해싱한다
 *  (2026-07-30 이후 systemPrompt 엔 안정 스캐폴딩이 함께 실리지만 해시엔 안 들어간다)
 *  — AGENT.md 편집·스킬 추가로 resume 이 끊기지 않게. 상세는 조립부 주석.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  query,
  type AgentDefinition,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type HookCallbackMatcher,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { SteeringChannel } from "../../steering.js";
import { getSession, invalidateResume } from "../../../store/sessions.js";
import { getPaths } from "../../paths.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import { buildActivityDetail } from "./_activity-detail.js";
import { buildActivityDiff } from "./_activity-diff.js";
import { buildActivityOutput } from "./_activity-output.js";
import { createDeltaStream } from "./_delta-stream.js";
import { DISALLOWED_TOOLS } from "../../../auth/permissions.js";
import {
  createFileOpsMcpServer,
  SEARCH_TOOL_NAMES,
  SHELL_TOOL_NAMES,
} from "../capabilities/file-ops-mcp.js";
import { getEventBus } from "../../eventbus.js";
import {
  agentSizeWarning,
  readAgent,
  readSystem,
} from "../../identity.js";
import {
  assembleUserPrompt,
  composeSystemChannel,
  formatAttachments,
  formatConversationContext,
  formatMemoryIndex,
  formatMemorySnippet,
  formatModelProfiles,
  splitSystemContext,
} from "../../prompt-assembly.js";
import { formatEnvContext } from "../../runtime-env.js";
import { stripInternalRuntimeScaffolding } from "../../outbound-sanitize.js";
import { createMemoryMcpServer } from "../../memory-mcp.js";
import { resolveJsonlPath, retrieveContext } from "../../memory.js";
import {
  loadCodexTurnHistoryBySessionId,
  loadThreadHistory,
  type CodexTurn,
} from "../../../store/memory.js";
import {
  createSkillInvokeMcpServer,
  discoverSkills,
  formatSkillIndex,
} from "../capabilities/skill-registry.js";
import {
  deriveToolPolicy,
  discoverAgents,
  formatAgentIndex,
  createSpawnAgentMcpServer,
  type Agent,
} from "../capabilities/agent-registry.js";
import { createWorkerMcpServer } from "../capabilities/worker-registry.js";
import {
  registerJob,
  markDone,
  markFailed,
  setCancelHook,
  clearCancelHook,
  WorkerCancelledError,
} from "../../worker-jobs.js";
import { createEndpointToolsMcpServer } from "../capabilities/endpoint-tools-mcp.js";
import { createCommandToolsMcpServer } from "../capabilities/command-tools-mcp.js";
import { createUpdateSelfMcpServer } from "../capabilities/update-self-mcp.js";
import { createMaintenanceMcpServer } from "../capabilities/maintenance-mcp.js";
import { createMcpAdminMcpServer } from "../capabilities/mcp-admin-mcp.js";
import { readExternalMcpServers, isProjectMcpCwd } from "../../external-mcp.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { notifyDestFromCoords } from "../../self-update.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../capabilities/prompt-options-mcp.js";
import { createSessionToolsMcpServer } from "../capabilities/session-tools-mcp.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  formatToolBlock,
  normalizeToolName,
} from "../../entry/hook-runner.js";
import { createProjectRegistryMcpServer } from "../capabilities/project-registry.js";
import { createFindCapabilitiesMcpServer } from "../capabilities/find-capabilities-mcp.js";
import {
  createIdleTimer,
  IdleTimeoutError,
  IDLE_TIMEOUT_CONFIG,
  idleConfigExempt,
} from "../idle-timeout.js";
import { linkAbort, TurnTimeoutError } from "../turn-timeout.js";
import { watchToolStart } from "../tool-watchdog.js";
import {
  SDK_SUBAGENT_TOOLS,
  withSdkSubagentsBlocked,
} from "../subagent-tools.js";
import { JOB_OWNING_TOOL_CALL_TIMEOUT_MS } from "../../worker-jobs.js";

// ★claude 도구 천장 (2026-07-29 검토) — SDK 는 `MCP_TOOL_TIMEOUT` 미설정 시 1e8ms
//  (27.8시간, SDK 주석도 "effectively infinite")를 쓴다. codex/openai 는 브리지에서
//  11분(잡 소유 125분) 천장을 받는데 claude 만 사실상 무한 = 어댑터 비대칭.
//  ★11분으로 맞추면 안 된다 — claude 의 Task(서브에이전트)는 **잡 소유 도구**라
//   그렇게 조이면 codex 에서 고친 "정상 진행 중인 작업을 바깥이 자른다" 를 claude 에
//   그대로 심는다. SDK env 는 도구별이 아니라 프로세스 전역이므로, 안전한 쪽인
//   **잡 소유 천장**에 맞춘다(바깥은 느슨하게 — 경계 순서 원칙).
//  사용자가 명시 설정했으면 존중한다(미설정일 때만).
if (
  process.env.MCP_TOOL_TIMEOUT === undefined ||
  process.env.MCP_TOOL_TIMEOUT.trim() === ""
) {
  process.env.MCP_TOOL_TIMEOUT = String(JOB_OWNING_TOOL_CALL_TIMEOUT_MS());
}
import type {
  RegionAActivityPayload,
  RegionASdkInput,
  RegionASdkOutput,
} from "../types.js";

// payload 사이즈 가드 — tool_use input · result text 등이 큰 경우 truncate.
// in-memory ring buffer 라 토큰/비용 영향 0 이지만 buffer 점유 보호.
const PAYLOAD_FIELD_CAP = 2048;
// ExitPlanMode 계획 전용 캡 — 계획은 detail(1줄) 대신 전체를 보여줘야 하므로 넉넉히(16KB).
// 현실적 계획은 대개 몇 KB. 과대 payload(bus/DB) 방지를 위한 상한.
const PLAN_FIELD_CAP = 16384;
const truncateForBus = (v: unknown): unknown => {
  if (v === null || v === undefined) return v;
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
  if (s.length <= PAYLOAD_FIELD_CAP) return v;
  return `${s.slice(0, PAYLOAD_FIELD_CAP - 1)}…`;
};

// ★정적 헌법 본문만 해싱한다 — systemPrompt 로 함께 나가는 안정 스캐폴딩(SYSTEM.md·
//  AGENT.md·스킬/에이전트 인덱스)은 **의도적으로 제외**. 그것들은 매 턴 최신값이 새로
//  실려 stale 이 없고, 해시에 넣으면 비서가 AGENT.md 를 한 줄 고칠 때마다 세션이
//  끊겨 thread 전체가 재prepend 된다.
const SYSTEM_PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex");

// ─── 서브에이전트(Task) 관측 — ADR 2026-07-03 subagent-worker-unify Phase A ────
//
// claude 는 SDK native Task tool 로 서브를 *SDK 내부 실행* 한다(codex spawn_agent 처럼
// runRegionA 재진입이 아님). 그래서 codex 는 자식 turn 의 threadKey=`agent:<jobId>` 로
// 활동이 자연히 흘렀지만, claude 서브 내부 스텝은 *부모의 SDK 스트림*에 그대로 흘러오며
// 그 서브를 띄운 Task tool_use id 로 `parent_tool_use_id` 태깅된다(SDK coreTypes.d.ts
// SDKAssistantMessage:431 / SDKUserMessage:399). → 콜백/후킹 불필요, 메시지 루프에서
// parent_tool_use_id 만 읽어 라우팅. codex 와 동등한 잡 관측(카드 등장·완료 + per-step).
//
// U-I1 자동: registerJob/markDone/markFailed 는 재주입을 안 타므로 kind:'agent' 안전.
// best-effort: 관측 로직 throw 가 부모 turn 을 무르면 안 됨(원칙 3) → 아래 전 경로 try/catch.

/** Task tool_use input 에서 서브에이전트 이름·작업지시를 방어적으로 추출. */

/**
 * user 메시지 content 에서 tool_result 블록들을 (tool_use_id, resultText) 로 추출.
 * Task 완료 감지용 — Task tool_use id 에 대응하는 tool_result 가 부모 스트림에 도착.
 * content 는 string | block[] (Anthropic MessageParam). block.content 도 string | block[].
 */
const extractToolResults = (
  msg: unknown,
): Array<{ toolUseId: string; text: string; isError: boolean }> => {
  const out: Array<{ toolUseId: string; text: string; isError: boolean }> = [];
  const message = (msg as { message?: unknown }).message;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "tool_result"
    ) {
      continue;
    }
    const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id;
    if (typeof toolUseId !== "string") continue;
    // Anthropic tool_result 표준 is_error — 서브에이전트(Task) 실패면 true. 이걸 읽어야
    // 실패 서브가 done 이 아니라 failed 로 관측된다(#2 parity: codex spawn_agent 는 throw→
    // markFailed, claude 도 동일해야). is_error 미존재/비불리언이면 성공 취급(회귀 0).
    const isError = (block as { is_error?: unknown }).is_error === true;
    const c = (block as { content?: unknown }).content;
    let text = "";
    if (typeof c === "string") {
      text = c;
    } else if (Array.isArray(c)) {
      text = c
        .map((b) =>
          b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .join("");
    }
    out.push({ toolUseId, text, isError });
  }
  return out;
};

// ─── cross-adapter (C) 하이브리드 — foreign(codex) delta prepend (contract B-3) ──
//
// claude 는 SDK resume 으로 자기 jsonl(고fidelity)을 재생하지만 codex turn 은 모른다.
// (C): 연속 claude turn(resume 가능 + foreign turn 없음) 은 현행 resume 그대로(회귀 0),
//      전환 시점(직전이 foreign 이거나 resume 불가) 만 foreign turn 을 텍스트로 보강.
//
// delta 경계: resume sid(claude 자기 세션) 의 마지막 turn 이후의 thread 히스토리 turn
// = foreign(codex) delta. store 가 ts API 를 노출하지 않으므로, thread 전체 타임라인
// (loadThreadHistory) 에서 claude 자기 세션 turn(loadCodexTurnHistoryBySessionId) 의
// 마지막 turn 위치를 content 매칭으로 찾아 그 이후를 delta 로 취한다. claude 가 자기
// 세션 resume 으로 이미 보는 turn 은 prepend 0 (중복 0).
//
// codex persist 가 threads.claude_session_id 를 더는 clobber 안 하므로(preserveSessionId)
// prior.claudeSessionId = 항상 claude 자기 resume sid → 그 sid 의 transcripts 가 곧
// "resume 커버 끝" 경계 산출의 진실 소스.

/** 마지막 claude turn 위치 이후의 thread 타임라인 turn = foreign delta. */
const computeForeignDelta = (
  threadTurns: CodexTurn[],
  claudeOwnTurns: CodexTurn[],
): CodexTurn[] => {
  if (threadTurns.length === 0) return [];
  // claude 자기 세션 turn 이 없으면(첫 claude turn 인데 thread 엔 codex turn 만 존재)
  // 전체가 foreign → thread 전체 prepend.
  if (claudeOwnTurns.length === 0) return threadTurns;

  const lastClaude = claudeOwnTurns[claudeOwnTurns.length - 1]!;
  // thread 타임라인에서 claude 마지막 turn 과 동일한 (role, content) 의 최후 위치.
  let boundary = -1;
  for (let i = threadTurns.length - 1; i >= 0; i--) {
    const t = threadTurns[i]!;
    if (t.role === lastClaude.role && t.content === lastClaude.content) {
      boundary = i;
      break;
    }
  }
  // 경계 못 찾음(텍스트 불일치·인터리브 모호) → 안전하게 delta 0 (resume 이 자기 turn
  // 을 이미 커버 → 중복 회피 우선). cross-adapter 손실은 다음 turn 에서 회복.
  if (boundary === -1) return [];
  return threadTurns.slice(boundary + 1);
};

/** foreign delta turn 들을 user prompt 에 prepend 할 텍스트 블록으로 포맷. */
const formatForeignDelta = (delta: CodexTurn[]): string => {
  if (delta.length === 0) return "";
  const lines = delta.map((t) => {
    const who = t.role === "assistant" ? "다른 응답(예: codex)" : "사용자";
    // ★저장된 user 턴은 *조립된* 프롬프트다 — 걷어내지 않으면 옛 SYSTEM.md·인덱스
    //  사본이 통째로 되돌아온다(실측 평균 41,132자·최대 1,324,574자). 더 나쁜 건
    //  본문 속 `</system-reminder>` 가 새 래퍼를 조기 종료시켜 뒤따르는 메모리·실제
    //  사용자 텍스트가 태그 밖(=사용자 발화)으로 보이는 것 — 태그를 도입한 원 사고
    //  (딴소리·imperative 메아리)의 재현 조건 그대로다. codex/openai 는 이미 같은
    //  strip 을 건다(2026-07-28). 여기만 빠져 있었다(#2 parity). 빈 결과면 원문 보존.
    const content = stripInternalRuntimeScaffolding(t.content).trim() || t.content;
    return `${who}: ${content}`;
  });
  return [
    "## 지난 대화 (다른 응답 포함)",
    "아래는 이 thread 에서 직전까지 오간 대화로, 다른 LLM 의 응답이 섞여 있을 수 있습니다. 맥락 연속을 위해 참고하세요.",
    "",
    lines.join("\n\n"),
  ].join("\n");
};


/**
 * **첫 `result` 가 이 턴의 끝인가** — 답변 경계 판정 (2026-08-09).
 *
 * SDK 0.3 은 백그라운드 알림(`task_notification`)이 오면 **합성 턴**을 연다. 그 턴의
 * `result` 가 우리 답변보다 **먼저** 올 수 있다(실측: 턴 시작 1초 만에).
 *
 * 두 사고를 **구분**해야 한다:
 *  - 2026-08-06: 답변이 **이미 있는데** 알림 턴 텍스트가 뒤에 붙어 섞였다 → 경계를 잡아야 한다.
 *  - 2026-08-09: 답변이 **아직 없는데** 알림 턴의 result 가 먼저 왔다 → 잡으면 진짜 답변
 *    49조각을 버린다(실제로 버렸고 화면엔 빈 말풍선, `ok:true`).
 *
 * 판별은 하나다 — **우리 답변에 내용이 생겼는가.** 생겼으면 그 뒤는 남의 턴이고,
 * 안 생겼으면 그 result 는 우리 것이 아니다.
 */
export const isOwnTurnEnd = (seen: { chunks: number; deltas: number }): boolean =>
  seen.chunks > 0 || seen.deltas > 0;

export const runClaude = async (
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
  // externalTools/externalToolChoice(LLM 게이트웨이 함수콜 패스스루) — ★스코프아웃(ADR
  // `docs/decisions/2026-07-25-llm-gateway-openrouter-scope.md` §Decision-3). Claude Agent
  // SDK 구독 로그인 경로는 agent loop 를 서브프로세스로 통째 소유해 "실행 말고 tool_calls
  // 만 반환하고 멈춤" 원시기능이 없다(개입점은 allow/deny 뿐) — abort-후-재개는 resume jsonl
  // 오염 위험(project_bad_image_poisons_claude_resume 동급). "Claude 모델 + 툴"은 prod
  // 모드(openai 어댑터, Anthropic OpenAI-호환 엔드포인트)가 이미 커버해 능력 공백 0(ADR
  // §Decision-2/§Decision-4). 이 어댑터는 `input.externalTools`/`externalToolChoice` 를
  // **의도적으로 읽지 않는다** — 값이 있어도 무시하고 기존 텍스트/비전 경로 그대로 동작
  // (방어적 no-op, 회귀 0). 재검토는 실 수요 발생 시 별도 스파이크(ADR 본문 "추후 재검토").
  if (
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    throw new Error(
      "Claude 인증 없음. ANTHROPIC_API_KEY 또는 CLAUDE_CODE_OAUTH_TOKEN 이 필요합니다.",
    );
  }

  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성(resume/transcripts/context)은
  // canonical 저장 채널로 키잉. route() 가 채널 인입을 세션으로 정규화할 때 sessionChannel
  // (=SESSION_STORAGE_CHANNEL)을 실어보낸다. 미지정 → channel 폴백(회귀 0). 표시/감사
  // (activity·delta·notifyDest·log)는 input.channel(실채널) 유지 — 정체성/표시 2분리.
  const idChannel = input.sessionChannel ?? input.channel;

  const prior = getSession(idChannel, input.threadKey);
  const resumable =
    prior !== undefined && prior.systemPromptHash === SYSTEM_PROMPT_HASH;

  // (C) 하이브리드 — cross-adapter foreign(codex) delta 산출.
  //  - resumable: resume 이 claude 자기 turn 을 재생 → 그 이후의 foreign turn 만 delta.
  //  - resume 불가(hash stale 등): resume 없이 thread 전체를 prepend = (A) 자연 폴백
  //    (claudeOwnTurns 가 비어 computeForeignDelta 가 thread 전체 반환).
  // 연속 claude turn(foreign 없음) → delta 0 → 현행 resume 그대로(회귀 0).
  let foreignDeltaBlock = "";
  if (prior !== undefined) {
    const threadTurns = loadThreadHistory(idChannel, input.threadKey);
    if (threadTurns.length > 0) {
      const claudeOwnTurns = resumable
        ? loadCodexTurnHistoryBySessionId(prior.claudeSessionId)
        : [];
      foreignDeltaBlock = formatForeignDelta(
        computeForeignDelta(threadTurns, claudeOwnTurns),
      );
    }
  }

  // β (2026-05-25): 기본 cwd = 런타임 홈 (만능 비서 기본 작업 위치, codex 어댑터와 parity).
  //  input.cwd 우선순위 유지 (미래 프로젝트 cwd 수요 시 라우터가 넘기면 존중) — 현재
  //  라우터 미전달이라 home 폴백. claude 는 bypassPermissions 라 cwd 와 무관하게
  //  절대경로 접근이 이미 가능 (무벽) → additionalDirectories 미설정 (무벽이라 무의미).
  const cwd = input.cwd ?? getPaths().home;
  const depth = input.subagentDepth ?? 0;

  // 커스텀 서브에이전트 → SDK `options.agents` 주입 (codex spawn_agent 브리지의
  // claude 대응 — SDK native Task tool 이 발견·실행). depth 0 turn 만 주입
  // (codex depth 가드와 parity — child turn 은 재spawn 유도 0). discovered 는
  // 아래 prompt 인덱스(formatAgentIndex) 에도 재사용.
  //
  // 전략 A (architect 권고·사용자 확정): SDK `AgentDefinition.prompt` =
  // 그 에이전트의 system prompt = agent 정의 .md 본문(frontmatter 포함 raw).
  // sub-agent 는 Claude Code 에서도 독립 system prompt 를 갖는 게 표준
  // (단일 인격 원칙은 사용자와 대화하는 main turn 의 원칙). codex spawn 은
  // 본문을 child *user prompt* 로 박지만, SDK 는 prompt 가 system prompt 라
  // 메커니즘이 다르며 — 그 native 의도를 존중. (contract §3.1)
  // reply-intent — per-call factory. 무인자 도구 호출 시 클로저로 플래그 set.
  // 함수 지역 변수 → 동시 turn 별 별 클로저 (교차 오염 0). contract §5.1.
  let replyToTrigger = false;
  const replyIntentServer = createReplyIntentMcpServer(() => {
    replyToTrigger = true;
  });

  // send-file — per-turn dedup Set(클로저 지역). 같은 경로 재호출 시 실제 전송 차단.
  // 함수 지역 변수 → 동시 turn 별 격리 (reply-intent per-turn flag 와 동형, 멱등 핵심).
  const sentFiles = new Set<string>();
  // prompt-options(축1) — per-turn dedup Set(같은 질문 재호출 시 중복 렌더 차단). send-file 동형.
  const askedQuestions = new Set<string>();
  // 중첩 메시지 경고 1회용(배경 소음 방지).
  let warnedNested = false;

  const discoveredAgents: Agent[] = depth === 0 ? await discoverAgents(cwd) : [];

  // ⚠ settingSources 미설정 = SDK 격리 모드 (sdk runtimeTypes.d.ts L504).
  //   .claude/{skills,agents,commands} 자동 발견 안 됨 → 아래 수동 스킬 인덱스 prepend
  //   + options.agents 주입 + invoke_skill MCP 가 유일 소스 (중복 0). settingSources 를
  //   켜면 SDK 자동발견과 이중 노출(스킬 인덱스 중복 / agents 키 충돌)되므로, 켜려면
  //   수동 prepend/주입을 동시에 제거할 것. (V9 런타임 홈 = tiguclaw 컨벤션 사용 =
  //   settingSources OFF 가 의도, ADR 2026-05-24-v9-runtime-home.)
  // lean 도구 정책 (2026-06-15, architect §2a I-2). claude *가 child 로 실행되는* 경로
  // (부모 codex/openai 가 anthropic 티어 agent spawn → runRegionA → runClaude(childInput))
  // 에서 toolPolicy 를 자기 도구 집합에서 해석. claude 가 부모로 SDK Task 를 돌리는
  // 경로의 lean 은 위 AgentDefinition.tools 로 별도 적용(동일 신호, 다른 SDK 메커니즘).
  //  - {mode:"none"}: tools: [] = SDK 빌트인 도구 0 + mcpServers 빈 맵 → 도구 0 lean.
  //  - {mode:"allow"}: 정밀 allowlist 후속(YAGNI §2a) — 안전 degrade = 전체 유지.
  //  - undefined: 현행 전체 도구 (회귀 0). codex/openai 와 동형 규칙(I-2).
  const toolsNone = input.toolPolicy?.mode === "none";
  const leanMcpServers: Options["mcpServers"] = toolsNone
    ? {}
    : {
        memory: createMemoryMcpServer(),
        // 프로젝트 레지스트리 (register/list/update/forget) — codex 와 parity(#2). 진실은
        // 폴더 PROJECT.md, 도구는 파싱→얇은 store 인덱스 upsert(단방향, 코어 무참조).
        projects: createProjectRegistryMcpServer(),
        // 런타임 유지보수 detect (2026-07-12, P1 runtime-maintenance) — maintenance_status.
        // 읽기전용·저위험 = find_capabilities/skills 류 게이트(depth·workerDepth 무관,
        // lean(toolsNone) 만 게이트) — update-self(depth0&&workerDepth0)와 다르다(계약서 §3.1).
        maintenance: createMaintenanceMcpServer(),
        // invoke_skill 실행 경로 (모든 소스 — home/project/plugin). 격리 모드라
        // .claude/skills 자동발견 0 → 이 in-process MCP 가 유일 실행 경로. cwd 는
        // 위 options.cwd·아래 스킬 인덱스(discoverSkills)와 동일 소스 → 인덱스↔invoke 정합.
        skills: createSkillInvokeMcpServer(cwd, {
          channel: input.channel,
          threadKey: input.threadKey,
          adapter: "claude",
        }),
        // reply-intent — 이 turn 응답을 트리거 메시지 직접 답글로 마킹 (codex 와 parity).
        "reply-intent": replyIntentServer,
        // 세션 이름 도구(2026-08-07) — rename_session·list_sessions. 3어댑터 동일 등록(#2).
        "session-tools": createSessionToolsMcpServer(input.threadKey),
        // send-file — 네이티브 멱등 아웃바운드 전송. 채널 전송 클로저가 있을 때만 등록
        // (스케줄러 등 비채널 turn 은 미등록 = 도구 노출 0). codex 와 parity.
        ...(input.sendAttachment !== undefined
          ? { "send-file": createSendFileMcpServer(input.sendAttachment, sentFiles) }
          : {}),
        // prompt-options(축1, 2026-06-25) — 객관식 선택지 제시. 채널 렌더 클로저가 있을
        // 때만 등록(미지원 채널·비채널 turn 은 미등록 = 도구 노출 0). codex/openai 와 parity.
        ...(input.presentOptions !== undefined
          ? {
              "prompt-options": createPromptOptionsMcpServer(
                input.presentOptions,
                askedQuestions,
              ),
            }
          : {}),
        // 백그라운드 워커 발사 도구 (2026-06-17) — run_in_background/list_workers.
        // depth 0(서브에이전트 아님) + workerDepth 0(워커 안 아님) turn 만 등록 →
        // 워커가 또 워커 발사 불가(W-I5). claude native Task 는 *블로킹* 위임이라
        // 비차단 백그라운드 워커와 의미가 달라 양 어댑터 모두 명시 등록(W-I3, contract §2).
        // SDK in-process MCP server (McpSdkServerConfigWithInstance) 를 그대로 맵에 주입
        // — spawn_agent 와 달리 native 대응이 없으므로 codex/openai 와 동일 server 사용.
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? { workers: createWorkerMcpServer(input) }
          : {}),
        // 커스텀 HTTP 엔드포인트 등록/조회/삭제 도구 (2026-06-18) —
        // register_endpoint/list_endpoints/delete_endpoint. worker 와 *동일* 가드
        // (depth 0 + workerDepth 0). lean(toolsNone) 이면 leanMcpServers={} 라 미등록
        // → restricted 엔드포인트 턴 안에선 register_endpoint 미노출 = 엔드포인트가 또
        // 엔드포인트를 만드는 재귀 자연 차단. LLM-agnostic(어댑터 분기 0).
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? { endpoints: createEndpointToolsMcpServer() }
          : {}),
        // ★spawn_agent MCP (projects 3a, 2026-07-07) — cross-project/병렬 위임 경로.
        // SDK 네이티브 Task(options.agents)는 *현재 cwd* 서브 전용이라 다른 프로젝트를
        // 못 띄운다(SDK 가 per-Task cwd 미지원). 이 MCP 도구는 runRegionA(childInput.cwd=
        // project) 로 실행해 codex/openai 와 **동일 경로·동일 project 인자** = #2 parity.
        // 분업: Task=현재 컨텍스트 서브 / spawn_agent(project=X)=임의 프로젝트 위임(병렬).
        // depth 0 만(codex/openai 와 동일 게이트) — 자식은 subagentDepth 1 라 재spawn 차단.
        // 회귀 0: Task 경로 무변경(additive), 자식이 same-cwd 면 기존과 동일 동작.
        ...(depth === 0 ? { agents: createSpawnAgentMcpServer(input) } : {}),
        // 커스텀 슬래시 명령 등록/조회/삭제 도구 (2026-06-18) —
        // register_command/list_commands/delete_command. endpoint/worker 와 *동일* 가드
        // (depth 0 + workerDepth 0). lean(toolsNone) 이면 leanMcpServers={} 라 미등록.
        // LLM-agnostic(어댑터 분기 0). 슬래시 명령은 항상 prompt 라 mode 무관.
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? { commands: createCommandToolsMcpServer() }
          : {}),
        // 자가 업데이트 도구 (2026-06-26) — update_self. command-tools 와 *동일* 가드
        // (depth 0 + workerDepth 0) — 워커/서브에이전트가 자가 업데이트 트리거 불가(재귀
        // 차단). 위험 로직 0(전부 runSelfUpdate). notify 좌표는 현재 turn 의 channel/threadKey
        // 에서 도출 — 재시작 후 부팅이 요청자에게 "완료" 회신. codex/openai 와 parity(#2).
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? {
              "update-self": createUpdateSelfMcpServer(
                notifyDestFromCoords(
                  input.channel,
                  input.threadKey,
                  input.channelAddress,
                ),
              ),
            }
          : {}),
        // 외부 MCP 등록 도구(add/list/remove_mcp_server) — endpoint/command 동형 가드.
        // 파일(<home>/mcp.json)만 다룸. codex/openai 와 parity(#2 — 어댑터 분기 0).
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? { "mcp-admin": createMcpAdminMcpServer() }
          : {}),
        ...(input.extraMcpServers ?? {}),
      };

  // ★외부 MCP 서버 연결(ADR 2026-07-07) — <home>/mcp.json 의 stdio/sse config 를 SDK
  // options.mcpServers 유니온에 *그대로* 주입 → SDK 가 네이티브로 spawn+연결·도구 노출.
  // depth0 메인 턴만(서브/워커는 외부 MCP 재연결 안 함). lean(toolsNone)은 생략. 읽기
  // 실패=빈 맵(external-mcp never-throw) → 데몬 생존(#3). codex/openai 는 Phase 2 브리지.
  // 메인 턴(전역) 또는 프로젝트 위임 서브/워커(그 프로젝트 <cwd>/.mcp.json — readExternalMcpServers
  // 가 전역+프로젝트 병합). 비프로젝트 서브/워커는 기존대로 생략(재spawn 회피). lean 생략.
  const externalMcpServers =
    !toolsNone &&
    ((depth === 0 && (input.workerDepth ?? 0) === 0) || isProjectMcpCwd(input.cwd))
      ? ((await readExternalMcpServers(input.cwd)) as Options["mcpServers"])
      : {};

  // find_capabilities (P1, capability-awareness contract §3c) — 위 두 맵(leanMcpServers·
  // externalMcpServers) 이 *이번 턴 실제 빌드된* 활성 서버명 집합. 병렬 static
  // active-list 를 두지 않고 이 결과 맵의 keys 를 그대로 읽어 게이트 드리프트를
  // 원천 차단(§3b). skills 와 동일하게 depth 무관 + !toolsNone 만 게이트 —
  // find_capabilities 자기 자신은 아직 mcpServers 에 없으므로 활성 목록엔 안 잡힌다
  // (§3d, 순환 없음). "agents" 항목은 claude 만 Task 도구 병기 문구로 override.
  const capabilityActiveNames = Object.keys({
    ...leanMcpServers,
    ...externalMcpServers,
  });

  // 유휴 타임아웃 — SDK `Options.abortController` 경로 (runtimeTypes.d.ts:234,
  // "stop and clean up resources"). idle/first 만료 시 헬퍼가 ac.abort(IdleTimeoutError).
  // heartbeat = for-await msg 도착마다. timer.done() = finally (누수 0, I-6).
  // 전 턴(메인·서브에이전트·워커) 1층 idle/first 면제 — 진행 중 작업(긴 Bash 등 SDK
  // 무이벤트 구간)을 임의 시간으로 컷하지 않는다(사용자 A안, 2026-06-24). hung 회복은
  // 워커 2층 WORKER_TIMEOUT_MS + /restart·cancel·외부 turn signal 이 담당. idleConfigExempt.
  const idleAc = new AbortController();
  const idleTimer = createIdleTimer(
    idleAc,
    idleConfigExempt(input.workerDepth, IDLE_TIMEOUT_CONFIG),
  );
  // 2층 합성 (TT-I2) — 1층 idle AC 와 핸들러 turn signal 을 OR 결합. idleTimer 는
  // 여전히 *원래 idleAc* 를 abort 하고, linkAbort 가 그걸 effectiveAc 로 전파한다
  // (결선 순서: idleAc abort → effectiveAc abort). SDK 는 signal 이 아닌
  // AbortController 객체를 받으므로 effectiveAc 를 그대로 abortController 로 넘긴다.
  // SDK 가 LLM+도구 실행을 같은 abortController 로 정리(runtimeTypes.d.ts:234).
  // input.abortSignal 미지정이면 link 는 idleAc 만 → 현행 1층 동작 그대로(TT-I7).
  const effectiveAc = linkAbort(idleAc.signal, input.abortSignal);

  // PreToolUse/PostToolUse 훅 배선 — Phase 1 (2026-07-24, 계약 §3.2·O1 실측).
  // settings.json 의 `hooks` 는 hook-runner(`runHooks`)만 읽는 유일 소스다. 여기서
  // 쓰는 `options.hooks` 는 filesystem settings 로딩(`settingSources`, 위 §L11-17
  // 가드로 계속 미설정)과 무관한 SDK 의 순수 JS 콜백 슬롯이라, settings.json 훅을
  // 중복 로드하지 않는다(이중실행 위험 0 — O1, `_workspace/hooks_phase1_O1_claude_doubleload.md`).
  // 두 콜백 모두 이 파일이 아니라 `runPreToolUseHooks`/`runPostToolUseHooks` 로
  // 즉시 위임 — codex/openai 와 동일 엔진을 통과해 #2(멀티 LLM 대칭) 를 물리적으로
  // 보장한다(계약 §4-1). 차단 문자열은 `formatToolBlock` 단일 포맷(계약 §2).
  const hooksOption: Options["hooks"] = {
    PreToolUse: [
      {
        hooks: [
          async (rawInput) => {
            const hookInput = rawInput as PreToolUseHookInput;
            // 결함 B 수정(2026-07-24) — formatToolBlock 에도 정규화값 재사용(아래
            // runPreToolUseHooks 와 동일 값). RAW `mcp__file_ops__Read` 를 그대로
            // 넘기면 codex/openai(`⛔ Tool \`Read\` blocked...`)와 바이트 불일치 →
            // #2(멀티 LLM 대칭) 위반(계약 §2/§4-3).
            const normalizedToolName = normalizeToolName(hookInput.tool_name);
            const pre = await runPreToolUseHooks({
              toolName: normalizedToolName,
              toolInput: (hookInput.tool_input ?? {}) as Record<
                string,
                unknown
              >,
              cwd,
              channel: input.channel,
              threadKey: input.threadKey,
            });
            if (!pre.block) return {};
            // SDK deny 반환 — hookSpecificOutput.permissionDecision:"deny" (coreTypes.d.ts
            // SyncHookJSONOutput). 도구는 실행되지 않고 모델은 reason 을 tool_result 로 받는다.
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: formatToolBlock(
                  normalizedToolName,
                  pre.blockReason,
                ),
              },
            };
          },
        ],
      },
    ] satisfies HookCallbackMatcher[],
    PostToolUse: [
      {
        hooks: [
          async (rawInput) => {
            const hookInput = rawInput as PostToolUseHookInput;
            // 관찰 전용(계약 §1.2) — 반환 무시, 도구 결과 확정을 지연시키지 않는다.
            void runPostToolUseHooks({
              toolName: normalizeToolName(hookInput.tool_name),
              toolInput: (hookInput.tool_input ?? {}) as Record<
                string,
                unknown
              >,
              toolResponse:
                typeof hookInput.tool_response === "string"
                  ? hookInput.tool_response
                  : JSON.stringify(hookInput.tool_response ?? ""),
              cwd,
              channel: input.channel,
              threadKey: input.threadKey,
            });
            return {};
          },
        ],
      },
    ] satisfies HookCallbackMatcher[],
  };

  // 컨텍스트 조립 — 안정 조각은 시스템 프롬프트(캐시 대상), 휘발 조각은 user
  //   `<system-reminder>` (2026-07-30, splitSystemContext 주석 참조).
  // ★resume 게이트(SYSTEM_PROMPT_HASH)는 **정적 sysprompt 본문만** 해싱한다 — 아래에서
  //  systemPrompt 에 붙는 안정 스캐폴딩은 해시에 안 들어간다. AGENT.md 는 비서 자신이
  //  수시로 편집하고 스킬은 추가될 수 있는데, 그걸 해시에 넣으면 편집 한 번에 세션이
  //  끊기고 thread 전체가 재prepend 된다(값비싼 폴백). 게이트의 목적은 "작동 헌법이
  //  바뀌면 세션 무효화" 이고, 스캐폴딩은 매 턴 최신값이 새로 실리므로 stale 이 없다.
  const agent = readAgent();
  const agentWarn = agentSizeWarning(agent);
  // leanMemory (2026-06-15, architect §2c I-5) — claude-as-child 경로의 메모리 생략.
  // (claude 가 부모로 SDK Task child 를 돌리는 경로는 부모 retrieveContext 가 child
  // prompt 에 애초 안 들어가 구조적으로 lean — 별도 처리 불요. 보고 참조.)
  // persona(SYSTEM.md/AGENT.md) 는 불가침(I-4) — 아래 systemContextParts 의 system/agent
  // 는 그대로. codex/openai 와 동형(I-2).
  const leanMemory = input.leanMemory === true;
  const memoryIndex = leanMemory ? "" : formatMemoryIndex();
  const memorySnippet = leanMemory
    ? ""
    : formatMemorySnippet(
        retrieveContext(idChannel, input.threadKey, input.text, {
          limit: 5,
        }),
      );

  // 스킬 인덱스 — codex 어댑터와 동일하게 전체 deduped (home/project/plugin).
  // 격리 모드라 SDK 가 .claude/skills 를 자동 발견하지 않으므로 이 prepend 가
  // LLM 이 스킬 존재를 아는 유일 경로. dedupe 기본값(true): 동일 이름은
  // project > plugin > user 우선 1개만 → invoke_skill 의 fetch 우선순위와 일치
  // (인덱스↔실행 단일 진실).
  const skills = await discoverSkills(cwd);
  const skillIndex = formatSkillIndex(skills);

  // 서브에이전트 인덱스 — 세 어댑터 동일 노출(LLM 이 에이전트 존재를 알게).
  // depth 0 turn 만 (위 discoveredAgents 재사용 — 중복 fs walk 0).
  // ★어댑터 전용 힌트를 제거했다 (2026-08-08). 종전엔 claude 에만 "`Task` 도구로 위임하세요
  //  (subagent_type 에 …)" 를 주입했다 — 그 근거였던 "claude 는 spawn_agent 이 없다(codex
  //  전용)" 가 **더는 참이 아니고**(depth 0 에 등록된다), 무엇보다 그 도구를 이제 차단한다.
  //  즉 **우리 프롬프트가 막아놓은 도구를 가리키고** 있었다 — 라이브 실측에서 첫 위임이
  //  `subagent_type:"Explore"` 로 와 검증 에러가 난 게 모델 습관이 아니라 **이 문장 탓**이다.
  //  기본 힌트(`spawn_agent({name, prompt})`)로 되돌리면 셋이 같은 문장을 쓴다(분기 0).
  const agentIndex = formatAgentIndex(discoveredAgents);

  // 모델 프로파일 인지 — depth 0 turn 만 (agentIndex 와 동일 게이트: 서브에이전트/워커를
  // 구성하는 최상위 turn 에서만 필요). settings.json 프로파일 부재/오류 시 ""(graceful).
  const modelProfiles = depth === 0 ? formatModelProfiles(cwd) : "";

  // 현재 대화 컨텍스트 — 비서가 dest_channel/dest_target 을 정확히 알게.
  const convoContext = formatConversationContext(
    input.channel,
    input.threadKey,
    input.channelAddress,
  );

  // 멀티모달 V1 — 현재 turn 첨부 placeholder (경로+메타). 미지정/빈 배열 → "" (회귀 0).
  const attachmentBlock = formatAttachments(input.attachments);

  // SYSTEM.md(작동 헌법) — 매 turn 최상단 (on-demand Read 아님, 2026-05-27). codex parity.
  const system = readSystem();
  // 환경 자기인지(env 블록, runtime-env.ts) — depth 게이트 없음(전 depth, 계약 §1.4).
  // 서브에이전트/워커도 Bash 를 쓰고 플랫폼을 알아야 하므로 child turn 에도 간다.
  const env = formatEnvContext({ cwd });
  // 시스템 컨텍스트(매 turn 주입 스캐폴딩) ↔ 사용자 turn 분리 (2026-05-28 딴소리 fix).
  //  스캐폴딩 = SYSTEM.md·env·AGENT.md·hint·대화컨텍스트·foreign delta·메모리·스킬·에이전트.
  //  사용자 turn = 첨부 블록 + 실제 입력 텍스트 (구분선으로 명시 분리 — assembleUserPrompt).
  // 중립 override(게이트웨이) 지정 시 tiguclaw context prefix(SYSTEM.md·AGENT.md·메모리·스킬…)를
  // 통째로 스킵 — 앱 호출에 비서 페르소나·컨텍스트 누수 0.
  const { stable: stableContext, volatileParts } =
    input.systemPromptOverride !== undefined
      ? { stable: "", volatileParts: [] as string[] }
      : splitSystemContext({
          system,
          env,
          agent,
          agentWarn,
          convoContext,
          foreignDelta: foreignDeltaBlock, // (C) cross-adapter — foreign(codex) delta (resume 못 보는 turn).
          memoryIndex,
          memorySnippet,
          skillIndex,
          agentIndex,
          modelProfiles,
        });
  const userTurnParts = [attachmentBlock, input.text];
  const promptWithMemory = assembleUserPrompt(volatileParts, userTurnParts);
  // 중립 override(게이트웨이) 지정 시 그 값이 시스템 프롬프트 — tiguclaw 작동헌법 대체.
  const systemChannel =
    input.systemPromptOverride ??
    composeSystemChannel(SYSTEM_PROMPT, stableContext);

  const options: Options = {
    // 작동헌법 + 안정 스캐폴딩 (위에서 조립). override 시 그 값이 전부 대체.
    systemPrompt: systemChannel,
    permissionMode: "bypassPermissions",
    abortController: effectiveAc,
    // AskUserQuestion 차단(2026-07-17) — claude 전용 SDK 네이티브 도구. tiguclaw 인터랙티브
    // 선택지는 자체 prompt_options(prompt.options 이벤트)만 렌더(축1, 2026-06-25) — 네이티브로
    // 새면 대시보드/텔레그램이 옵션을 못 그려 질문만 뜨고 응답 불가(대기 고아). 어댑터-지역
    // 차단(codex/openai 는 이 도구 자체가 없어 무영향 = #2 parity, 공유 DISALLOWED_TOOLS 정책은
    // 무편집). SDK 문서 도구명 정확 매칭(coreTypes.d.ts 네이티브 도구 목록).
    // ★SDK 네이티브 서브에이전트 차단(2026-08-08) — 팬아웃을 우리 루프(spawn_agent)로 일원화.
    //  같은 능력에 길이 둘이었고 SDK 쪽은 우리 계약을 **하나도** 못 지켰다:
    //   ①관측 0 — 0.3 의 Agent 는 "Async agent launched successfully" 라는 **발사 확인증**을
    //     tool_result 로 즉시 준다. 우리는 그걸 최종 결과로 받아 잡을 0초에 닫았다(실측
    //     10건 중 9건 0초·1건은 확인증 미도착으로 6분 뒤 실패). 대시보드엔 스쳐 지나는
    //     카드만 남고, 진짜 완료(`system/task_notification`)는 로그로만 흘렀다.
    //   ②스티어·취소 불가 — per-Task abort 가 없어 취소가 **부모 턴 전체**를 끊는다.
    //   ③claude 전용 — codex/openai 엔 이 도구가 없다(원칙 2 위반). 게다가 이 경로는
    //     모델 프로파일을 opus/sonnet/haiku 로 **납작하게 투영**해 풀·폴백을 잃는다.
    //   ④손자가 열린다 — 이 배열은 **깊이 무관**이라 자식도 Agent 를 들고 있었다. "손자
    //     금지는 하드" 가 claude 경로에서만 소프트였다(프로브로 실측: 자식이 Agent 호출 성공).
    //  실측(프로브 6케이스): disallow 는 빌트인에 확실히 먹고, 모델은 **스스로 spawn_agent 을
    //  찾아 썼다**("막으면 인라인으로 도망간다"는 걱정은 일어나지 않았다).
    disallowedTools: withSdkSubagentsBlocked([
      ...DISALLOWED_TOOLS,
      "AskUserQuestion",
      // ★SDK 빌트인 셸·검색 차단 — 위 file-ops 가 대체한다. 이름을 여기 다시 적지 않고
      //  **정의점에서 가져온다**(손으로 관리하는 목록 금지). 파일 도구는 안 막는다 —
      //  우리 Read 가 PDF 를 못 줘서(MCP 콘텐츠 타입 한계) 막으면 능력 손실이다.
      ...SHELL_TOOL_NAMES,
      ...SEARCH_TOOL_NAMES,
    ]),
    // 델타 스트리밍 파리티(2026-07-17) — 미설정 시 SDK 는 *완성된* assistant 텍스트 블록만
    // 발행해 토큰이 한꺼번에 뜬다(codex SSE output_text.delta 대비 파리티 갭). true 로 켜면
    // SDKPartialAssistantMessage(type:"stream_event")가 함께 오고, 아래 메시지 루프가
    // content_block_delta/text_delta 를 즉시 deltaStream.push (이중발행 방지는 완성 블록
    // 분기에서 receivedPartialText 가드로 처리).
    includePartialMessages: true,
    persistSession: true,
    cwd,
    hooks: hooksOption,
    // lean(toolsNone) child 는 SDK 빌트인 도구도 0 (`tools: []` = disable all built-ins).
    ...(toolsNone ? { tools: [] as string[] } : {}),
    // facade 가 provider:model 에서 추출해 주입. 미지정 시 SDK 디폴트.
    ...(input.model !== undefined ? { model: input.model } : {}),
    mcpServers: {
      ...leanMcpServers,
      ...externalMcpServers,
      // ★셸을 우리 도구로 일원화 (2026-08-09). SDK 빌트인 Bash 는 서브프로세스 안에서 돌아
      //  데몬이 출력을 못 쥔다 → 대시보드 잡카드에 **출력이 안 뜬다**(카드는 뜬다).
      //  우리 MCP Bash 는 `BG_SHELLS` 에 적재하고 `shell.*` 를 발행하므로 비소비 tail·kill·
      //  관측이 codex 와 **같은 경로**가 된다. 파일 도구는 안 건드린다(위 shellsOnly 주석).
      ...(toolsNone
        ? {}
        : {
            "file-ops": createFileOpsMcpServer(input.cwd, input.threadKey, {
              shellsOnly: true,
            }),
          }),
      ...(toolsNone
        ? {}
        : {
            "find-capabilities": createFindCapabilitiesMcpServer(
              capabilityActiveNames,
              "`spawn_agent({name, prompt})` 도구로 실행하세요 (다른 프로젝트/병렬 위임은 `path` 로)",
              input.extraMcpServers,
            ),
          }),
    },
    ...(resumable ? { resume: prior.claudeSessionId } : {}),
  };

  // resume 세션 부재/손상은 SDK 가 "process exited with code 1" 로 종료시킨다 →
  // resume 없이 fresh 세션으로 1회 graceful 폴백 (본질 수정: 마이그레이션·세션 만료·
  // cwd 변경에도 턴이 안 죽게). model 거부는 별도 표면(is_error throw)이라 무간섭.
  const isResumeProcessFailure = (e: unknown): boolean =>
    e instanceof Error && /process exited with code 1/i.test(e.message);
  // 처리불가 이미지 등 재생 불가한 turn 이 resume jsonl 에 박히는 400 — 그대로 두면 이후 모든
  // turn 이 그 resume 을 재생하며 영구 실패(스레드 오염). 감지 시 resume 만 무효화(아래) 하면
  // 다음 turn(풀의 다음 모델·또는 다음 사용자 turn)이 fresh+prepend 로 자가치유.
  // [[project_bad_image_poisons_claude_resume]]
  const isUnprocessableImage = (e: unknown): boolean =>
    e instanceof Error &&
    /API Error: 400/i.test(e.message) &&
    /invalid_request_error/i.test(e.message) &&
    /\bimage\b/i.test(e.message);
  // ── P1c mid-turn steering (ADR `2026-07-16-midturn-steering.md` §claude, Phase P1c) ──
  //
  // steering 미주입(STEERING_ENABLED off·스케줄러·워커·서브에이전트·비대화 turn) =
  // `input.steering === undefined` → **현행 string-prompt 경로 바이트 동일**(회귀 0,
  // 하드게이트). steering 주입 시에만 async-generator prompt(streaming-input 모드)로 전환.
  //
  // ★SP-1 종료조건(SDK 소스 확정): streaming 모드는 첫 result 후 stdin 을 *안 닫는다* →
  // 제너레이터가 result 뒤 추가 user 메시지를 yield 하면 CLI 가 또 한 턴(추가 result) =
  // 응답 2개 발산. 따라서 제너레이터는 **미완 steering 이 없으면 즉시 return** 해야 단일
  // result 가 보장된다. 이 조건은 steering.stream(signal) 이 SteeringChannel.close()(턴
  // finally, P0 배선) 또는 abort 에 종료 → for-await 종료 → 제너레이터 자연 return →
  // SDK 가 stdin(endInput) close → 단일 result. (빈 steering·무한대기 0.)
  //
  // 초기 유저 메시지 = 현행 promptWithMemory(string)를 그대로 SDKUserMessage.content(string)로
  // 실어 컨텍스트 바이트 동일. steering 메시지 = s.text + 첨부 placeholder(현행 claude 첨부
  // 주입 = formatAttachments 텍스트, 초기 turn userTurnParts 와 동형). resume·hook·permission·
  // options(o)·첨부 배선은 두 경로 공통(제너레이터도 동일 options 로 query).
  const toUserMessage = (content: string): SDKUserMessage => ({
    type: "user",
    session_id: "", // streaming 모드 = CLI 가 세션 배정(SP-1 SDK-layer 스파이크 확인).
    parent_tool_use_id: null,
    message: { role: "user", content },
  });
  const buildSteeringPrompt = (
    steering: SteeringChannel,
    signal: AbortSignal,
  ): AsyncGenerator<SDKUserMessage> =>
    (async function* () {
      yield toUserMessage(promptWithMemory); // 초기 유저 메시지 — 현행 string 동일 텍스트.
      for await (const s of steering.stream(signal)) {
        // 첨부 placeholder(있으면) + steer 텍스트 = 초기 turn(userTurnParts)과 동형 조립.
        const parts = [formatAttachments(s.attachments), s.text].filter(
          (p) => p.trim() !== "",
        );
        yield toUserMessage(parts.join("\n\n"));
      }
      // stream 종료(close/abort) → 제너레이터 return → stdin close → 단일 result(발산 0).
    })();
  // signal = effectiveAc.signal(현행 turn abort + idle/turn 타임아웃 합성) 재사용 →
  // 턴이 abort/타임아웃돼도 steering 대기가 매달리지 않고 즉시 종료(무한대기 0).
  const buildQuery = (o: Options) =>
    input.steering === undefined
      ? query({ prompt: promptWithMemory, options: o }) // 현행 경로 — 바이트 동일(회귀 0).
      : query({
          prompt: buildSteeringPrompt(input.steering, effectiveAc.signal),
          options: o,
        });
  let q = buildQuery(options);
  let resumeRetried = false;

  let resultText: string | undefined;
  let assistantTextChunks: string[] = [];
  let lastSessionId: string | undefined;
  let lastModel: string | null = null;
  let lastUsage:
    | {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        iterations?: number;
        inputTokensTotal?: number;
        outputTokensTotal?: number;
        cachedTokensTotal?: number;
      }
    | undefined;
  /**
   * ★**마지막 API 호출 한 번**의 입력 규모 (2026-07-30). 계약(types.ts)상 `inputTokens`
   *  는 "이 턴에 보낸 누적 컨텍스트 proxy = 얼마나 찼나" 이고 턴 합계는 `*Total` 이다.
   *  claude 는 그간 `result.modelUsage[model]` 을 썼는데 그건 **턴 안 모든 호출의 누적합**
   *  이다 — 실측: 한 턴의 cachedTokens 가 10,182,800 (200K 창의 50.9배). 그래서 /status
   *  컨텍스트 %가 구조적으로 틀린다. assistant 메시지마다 오는 호출 단위 usage 를 잡는다.
   *  ★parent_tool_use_id 가 null 인 것만 — 서브에이전트(Task) 내부 호출은 부모의 "컨텍스트
   *  참 정도"가 아니다.
   */
  let lastCallUsage:
    | { input: number; cacheRead: number; output: number }
    | undefined;
  let succeeded = false;
  /**
   * ★**턴 경계 가드** — 첫 `result` 이후 도착분은 *이 턴의 답이 아니다* (2026-08-06 실사고).
   *
   * SDK 0.3 은 한 스트림에 **여러 턴**을 실을 수 있다. 블로킹 도구를 백그라운드로 돌리면
   * 턴이 즉시 이어지고(`backgroundTasks()`), 그 작업이 끝나면 `system/task_notification`
   * (status: completed|failed|**stopped**)을 내는데 **그 알림이 새 턴을 시작시킨다**
   * (`system/init` 재발화). 0.1 엔 없던 동작이라 우리 루프는 그걸 같은 턴으로 먹었다.
   *
   * 실측(2026-08-06 14:59, 회사 PC 대시보드 세션): 사용자 입력은 14:36 이 마지막인데
   *  - 14:59:44 result/success  ← 진짜 답변(작업 요약)
   *  - 14:59:45 task_notification → system/init  ← 알림이 새 턴 개시
   *  - 14:59:56 result/success  ← "알겠습니다. 멈추겠습니다"(알림에 대한 대답)
   * 결과 ①두 턴 텍스트가 한 답변으로 이어붙어 화면에 나갔고(`…알려드리겠습니다.Unity MCP는…`)
   *      ②`resultText` 가 **대입**이라 첫 result 본문이 마지막 것으로 덮였다 —
   *        스트림 1,646자 / 확정 답변 279자. 즉 **사용자가 시키지도 않은 문장만 기록에 남았다**.
   *
   * 그래서 첫 result 에서 답을 **확정**하고, 이후 도착분은 이 답변에 섞지 않는다. 버리되
   * 조용히 버리지 않는다 — 로그·이벤트에 판정 수치와 함께 남긴다(대응은 후속 결정).
   */
  let turnResultSeen = false;
  let emptyResultNoted = false;
  let postResultMsgs = 0;
  // 이중발행 방지 가드(2026-07-17, delta 파리티) — depth-0 부모 turn 에서 부분 델타
  // (stream_event/content_block_delta)를 한 번이라도 push 했으면, 뒤따르는 완성
  // assistant 텍스트 블록에서는 deltaStream.push 를 다시 하지 않는다(같은 텍스트 2번
  // 스트리밍 방지). 무회귀 하드게이트 — SDK 가 부분 이벤트를 안 주는 경우(비지원/누락)엔
  // 이 플래그가 false 로 남아 기존 완성블록 push 경로가 그대로 동작(폴백 보존).
  let receivedPartialText = false;
  // llm.activity — 어댑터 로컬 단조 시퀀스 (turn 시작 0, publish 마다 +1). nonce 아님.
  let activitySeq = 0;

  // 도구 실행시간(#3) — top-level tool_use id → {그 도구의 activity seq, 시작 벽시계, 라벨}.
  // tool_result 도착 시 이 맵에서 찾아 phase:"end"+durationMs 로 1건 더 발행(대시보드 seq 매칭).
  const toolTiming = new Map<
    string,
    { seq: number; t0: number; label: string; stopSlow?: () => void }
  >();

  const bus = getEventBus();

  // ─── 서브에이전트(Task) 관측 상태 (per-turn, 클로저 지역 = 동시 turn 격리) ────────
  // Task tool_use id → 관측 jobId 매핑. 한 턴에 Task 여러 개 가능 → Map.
  // 서브 내부 스텝(parent_tool_use_id === taskId)은 부모 좌표가 아니라 agent:<jobId>
  // 좌표의 llm.activity 로 발행(codex 서브 per-step 과 동형). agentSeq 는 잡별 단조 시퀀스.

  // ─── claude 백그라운드 셸 관측 브리지 (ADR `2026-07-17-background-shell-observability.md`
  // §6, Phase 4) ────────────────────────────────────────────────────────────────────
  //
  // file-ops BG_SHELLS(codex/openai 전용)와 달리 claude 는 SDK 빌트인 Bash
  // (run_in_background) 가 셸을 *SDK 내부에서* 소유한다 — pid 를 몰라 밖에서 kill/reap
  // 불가. 여기서는 SDK 메시지 스트림에서 Bash(run_in_background) tool_use/tool_result 를
  // 파싱해 file-ops 와 동일 shell.started/shell.exited 스키마로 **관측만**(read-only)
  // 미러링한다 — status/lifecycle 의 진실은 항상 SDK. 이 브리지는 kill·reap 을 절대
  // 수행하지 않는다(payload 에 owner:"sdk"·killable:false — 대시보드가 이 두 필드로
  // claude 셸엔 ⏹️ 를 비활성/미표시하고 "SDK 소유" 안내를 렌더할 계약, P3 가 읽음).
  //
  // 식별 신호(이 저장소에 고정된 @anthropic-ai/claude-agent-sdk 버전의 cli.js 실측 —
  // node_modules/@anthropic-ai/claude-agent-sdk/cli.js 소스 대조로 확정, 추측 아님):
  //  - Bash tool_use(top-level, input.run_in_background===true) 자체엔 shellId 가 없다
  //    (SDK 가 나중에 배정) — 그 tool_result 텍스트에 "Command running in background
  //    with ID: <id>. Output is being written to: <path>"(모델이 수동 backgrounding 시
  //    "was manually backgrounded by user with ID: ...")가 실려야 비로소 shellId 를 안다.
  //  - 종료는 모델이 후속으로 `TaskOutput`(canonical 이름 — SDK 는 "BashOutput" 도
  //    alias 로 받지만 실제 발행되는 tool_use.name 은 "TaskOutput")·`KillShell` 을 호출해
  //    그 tool_result 를 받을 때만 추론 가능(coarse, ADR §6 명시 — 모델이 한 번도 상태를
  //    확인 안 하면 exited 는 영영 관측 안 됨. 정직한 한계, 억지 폴링 0).
  //  - 매칭 실패(향후 SDK 가 문구를 바꾸면) → 조용히 미관측(throw 0, best-effort,
  //    기존 claude Bash 동작·부모 turn 은 무변경, additive).
  const pendingBgBash = new Map<string, { command: string }>(); // toolUseId -> 대기중 백그라운드 Bash 요청.
  const pendingTaskOutput = new Map<string, string>(); // toolUseId -> 조회 대상 shellId(우리가 관측 중인 것만 등록).
  const pendingKillShellCalls = new Map<string, string>(); // toolUseId -> kill 대상 shellId(관측 중인 것만).
  const observedShells = new Map<string, { command: string; startedAt: number }>(); // shellId -> shell.started 발행 시 기록(관측 중 = 우리가 발행한 것만).
  const finalizedShells = new Set<string>(); // shell.exited 이미 발행된 shellId(이중발행 0).

  const BG_BASH_ID_RE =
    /Command (?:running in background|was manually backgrounded by user) with ID:\s*(\S+?)\.\s*Output is being written to:/;
  const TASK_STATUS_RE = /<status>([^<]*)<\/status>/;
  const TASK_EXIT_CODE_RE = /<exit_code>(-?\d+)<\/exit_code>/;
  const KILL_SUCCESS_RE = /Successfully killed shell:\s*(\S+)/;

  /** file-ops publishShellEventSafe 동형 — best-effort, 발행 실패가 turn 을 무르지 않는다. */
  const publishClaudeShellEvent = (
    type: "shell.started" | "shell.exited",
    payload: Record<string, unknown>,
  ): void => {
    try {
      bus.publish({
        type,
        ts: Date.now(),
        payload: { owner: "sdk", killable: false, ...payload },
      });
    } catch {
      /* 관측 발행 실패가 turn 을 무르지 않는다(원칙 3). */
    }
  };


  // Task tool_use 감지 시 관측 잡 등록 (best-effort). 등록 실패해도 부모 turn 무영향.

  // Task 완료 마킹 — tool_result 도착 시. best-effort. isError=true(서브 실패)면 markFailed
  // 로 닫아 실패 lifecycle 이 codex(spawn_agent throw→markFailed)와 parity(#2 하드게이트).

  // llm.delta — 토큰 스트리밍 fan-out(보조 점증 렌더). depth-0 가드: 메인 답변만 발행
  // (서브에이전트/워커 depth>0 turn 은 out 도 안 내므로 화면 버블 대상 아님 = no-op).
  // SDK assistant message text 는 이미 덩어리(자연 coalesce) — coalescer 가 통일 정책 적용.
  const deltaStream = createDeltaStream({
    enabled: depth === 0 && (input.workerDepth ?? 0) === 0,
    channel: input.channel,
    threadKey: input.threadKey,
    adapter: "claude",
    model: lastModel ?? undefined,
  });

  // 대시보드 인터리브(2026-07-13) — 도구 경계(및 턴 종료) 직전까지 deltaStream 이
  // 누적한 텍스트를 kind:"text" activity 로 발행. seq 는 도구와 *같은* activitySeq
  // 카운터에서 뽑는다(closeSegment 자체의 delta seq 는 안 씀) — 그래야 seq 정렬 순서
  // = 실제 발행(텍스트↔도구 인터리브) 순서. best-effort — 실패해도 turn 진행(원칙 3).
  const closeTextSegment = (): void => {
    const text = deltaStream.closeSegment();
    if (text === undefined) return; // 빈 세그먼트 — no-op.
    const segSeq = activitySeq++;
    try {
      bus.publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: {
          channel: input.channel,
          threadKey: input.threadKey,
          adapter: "claude",
          model: lastModel ?? undefined,
          seq: segSeq,
          kind: "text",
          label: "text",
          text,
        } satisfies RegionAActivityPayload,
      });
    } catch {
      /* 관측 발행 실패가 turn 을 무르지 않는다(원칙 3). */
    }
  };

  try {
  for (;;) {
  try {
  // 완료-hang 진단 계측(2026-07-17) — sdk_message 는 firehose 라 DB 미영속이므로, 완료 경로가
  // 어디서 멈추는지 *로그*(영속)로 남긴다. stream_event(토큰)는 flood 라 200개마다만, 그 외
  // 메시지·loop-exit·return 은 매번. hang 재현 시 로그 마지막 [claude-complete] 줄이 멈춘 지점.
  let diagStreamCount = 0;
  /**
   * ★**우리 답변의 텍스트 델타** 수 (2026-08-09 적대 검토 C).
   *
   * 종전엔 경계 판정에 `diagStreamCount` 를 썼는데 그건 진단용이라 **모든 stream_event** 를
   * 센다 — 텍스트 없는 `message_start`·`content_block_start|stop` 과 서브에이전트 내부
   * 델타까지. 백그라운드 Task 가 도는 중이면 우리 답변이 한 글자도 없어도 참이 되어
   * **고치려던 조건 그대로** 첫 result 에서 경계를 잡았다.
   * ★"재는 것과 잡으려는 것이 다르다" — 같은 날 세션 필터에서 쓴 그 문장이다.
   */
  let ownTextDeltas = 0;
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    // 유휴 타임아웃 heartbeat — 매 SDK message 도착 = 살아있음 신호. 타이머 reset.
    idleTimer.beat();
    if (msg.type === "stream_event") {
      diagStreamCount += 1;
      if (diagStreamCount % 200 === 0) {
        console.log(`[claude-complete] ${input.threadKey} stream_event x${diagStreamCount} (still consuming, no result yet)`);
      }
    } else {
      const sub = (msg as { subtype?: unknown }).subtype;
      // ★백그라운드 Task 알림은 **status 까지** 찍는다 (2026-08-06). 종전엔 type/subtype 만
      //  남아, 모델이 왜 갑자기 "멈추겠습니다" 라고 했는지를 로그만으로는 못 갈랐다
      //  (status: completed|failed|stopped 중 무엇인지가 그 답인데 안 보였다).
      const note =
        sub === "task_notification"
          ? ` status=${String((msg as { status?: unknown }).status)}` +
            ` summary=${JSON.stringify(String((msg as { summary?: unknown }).summary ?? "").slice(0, 80))}`
          : "";
      console.log(`[claude-complete] ${input.threadKey} recv=${msg.type}${sub ? "/" + String(sub) : ""}${note}`);
    }
    // 관측 publish — for-await 흐름 영향 0 (publish 동기 + EventBus 격리).
    // payload 핵심 필드만, 큰 객체는 truncate.
    bus.publish({
      type: "llm.sdk_message",
      ts: Date.now(),
      payload: {
        channel: input.channel,
        threadKey: input.threadKey,
        sdkType: msg.type,
        sdkSubtype: (msg as { subtype?: unknown }).subtype,
        snapshot: truncateForBus(msg),
      },
    });

    const maybeSid = (msg as { session_id?: unknown }).session_id;
    if (typeof maybeSid === "string") lastSessionId = maybeSid;

    // ★턴 경계 — 첫 result 이후는 이 턴이 아니다(위 turnResultSeen 주석의 사고).
    //  관측 발행(llm.sdk_message)은 **위에서 이미** 했으므로 기록은 남고, 답변 조립에서만
    //  뺀다. 스트림 소비는 계속한다 — 여기서 break 하면 steering 채널 close → stdin close
    //  → 스트림 종료로 이어지는 기존 teardown 순서가 바뀐다(완료 데드락 수정의 전제).
    if (turnResultSeen) {
      postResultMsgs += 1;
      if (postResultMsgs === 1) {
        const sub = (msg as { subtype?: unknown }).subtype;
        console.warn(
          `[claude-turn-boundary] ${input.threadKey} 첫 result 이후 메시지 도착 ` +
            `(${msg.type}${sub !== undefined ? "/" + String(sub) : ""}) — SDK 가 새 턴을 ` +
            `시작한 것으로 보고 **이 답변에는 섞지 않습니다**. 백그라운드 Task 알림이 ` +
            `자동으로 턴을 여는 0.3 동작(task_notification → system/init).`,
        );
      }
      continue;
    }

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.model === "string") {
        lastModel = msg.model;
        deltaStream.setModel(msg.model); // 델타 라벨 보정(늦게 알게 된 모델).
      }
    } else if (msg.type === "stream_event") {
      // ★델타 스트리밍 파리티(2026-07-17) — `includePartialMessages: true` 로 켠
      // SDKPartialAssistantMessage. content_block_delta/text_delta 만 다룬다(다른
      // stream_event 서브타입 — message_start/content_block_start/stop 등 — 은 텍스트
      // 증분이 없어 무시). 서브(Task) 내부 텍스트는 위 "assistant" 분기와 동형으로
      // parent_tool_use_id 로 depth 게이트(부모 답변/델타 버블에 섞이면 안 됨 — 회귀 0).
      const parentToolUseId = (msg as { parent_tool_use_id?: unknown })
        .parent_tool_use_id;
      // ★"더 엄격하고 동치" 라고 적었는데 **동치가 아니었다**(레드팀 적발, 2026-08-08).
      //  종전 판정(`taskJobs.get(id)`)은 **모르는** parent id 를 부모로 취급해 텍스트를
      //  **보존**했다. 존재만으로 중첩 처리하면 그 텍스트가 답변에서도 delta 에서도 조용히
      //  사라진다. 그리고 `DISALLOWED_TOOLS` 는 빈 배열이라 SDK 의 다른 도구가 중첩 메시지를
      //  올릴 창이 남아 있다 — 그때 답변이 통째로 증발한다(종전엔 오염이지만 **보였다**).
      //  ★조용한 소실보다 보이는 오염이 낫다. 보존하되 **한 번 로그**로 남긴다.
      if (typeof parentToolUseId === "string" && !warnedNested) {
        warnedNested = true;
        console.warn(
          `[claude-nested] ${input.threadKey} parent_tool_use_id 가 붙은 메시지가 도착했다 ` +
            `— SDK 서브에이전트는 차단돼 있으므로 예상 밖이다(텍스트는 보존한다).`,
        );
      }
      {
        const event = msg.event;
        // ★호출 단위 usage 의 **최종값**은 여기 있다 (2026-08-05, SDK 0.3 업그레이드 부작용).
        //  0.1.77 에선 `assistant` 메시지 usage 가 완료 시점 값이었는데, 0.3 은 그 자리에
        //  **`message_start` 스냅샷**을 싣는다 — `output_tokens: 1`(플레이스홀더)이다.
        //  그걸 그대로 쓰던 아래 assistant 분기 때문에 **모든 턴의 outputTokens 가 1 로
        //  붕괴**했다(실측: 라이브 turn_done outputTokens=1, 벤치 중앙값 1 — 업그레이드 전
        //  같은 태스크는 1,221). 비용·/status·프리픽스 캐시 관측이 동시에 죽는 값이다.
        //  최종값은 `message_delta.usage`(output_tokens=215 실측) — 호출마다 한 번 온다.
        //  타입 이름은 그대로인데 **의미가 바뀐** 경우라 타입체크·회귀·한 턴 성공이 전부
        //  통과했다(ADR 2026-08-03-sdk-drift §3 이 경고한 바로 그 부류).
        if (
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "message_delta"
        ) {
          const u = (event as { usage?: Record<string, unknown> }).usage;
          if (u !== undefined && typeof u.output_tokens === "number") {
            const num = (k: string): number =>
              typeof u[k] === "number" ? (u[k] as number) : 0;
            lastCallUsage = {
              input:
                num("input_tokens") +
                num("cache_read_input_tokens") +
                num("cache_creation_input_tokens"),
              cacheRead: num("cache_read_input_tokens"),
              output: u.output_tokens,
            };
          }
        }
        if (
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "content_block_delta"
        ) {
          const delta = (event as { delta?: unknown }).delta;
          if (
            delta &&
            typeof delta === "object" &&
            (delta as { type?: unknown }).type === "text_delta"
          ) {
            const t = (delta as { text?: unknown }).text;
            if (typeof t === "string" && t.length > 0) {
              receivedPartialText = true; // 완성 블록 재push 방지 가드(위 "assistant" 분기).
              ownTextDeltas += 1; // ★경계 판정용 — 진단 카운터(모든 stream_event)와 구분한다.
              // 부분델타 = deltaStream.push (llm.delta 실시간 스트리밍 + segBuf 겸용 적재
              // — closeSegment 인터리브(2026-07-13)는 push() 를 그대로 재사용하므로 별도
              // 처리 불요, 도구 경계/턴종료 시 기존 closeTextSegment() 가 자연히 커버).
              deltaStream.push(t);
            }
          }
        }
      }
    } else if (msg.type === "result") {
      // 완료 데드락 수정(ADR 2026-07-16-midturn-steering §"완료 데드락 + 수정" 채택안 Part A) —
      // result 는 모델 turn 종료 신호. steering.stream(signal) 을 소비하는 제너레이터
      // (buildQuery) 는 이 채널이 close 되어야 return → SDK 가 stdin(endInput) close →
      // 출력 스트림 done → 이 for-await 가 LOOP-EXIT. 종전엔 close 가 **턴 finally**(index.ts)
      // 에만 걸려 있어 "턴 완료(=이 루프 종료) 대기 ↔ 채널 close(=턴 완료 후) 대기" 순환 데드락이
      // 났다. result 를 **관측하는 이 지점**(어댑터 루프)에서 직접 close 해 순환을 끊는다.
      // 미주입(steering undefined, flag off·비대화 turn)은 `?.` no-op → string 경로 바이트
      // 동일(회귀 0). success·is_error throw·error subtype throw 모든 result 경로를 아래
      // subtype 분기 *이전*에 덮으므로 throw 경로에서도 제너레이터가 return 해 stdin 이 닫힌다.
      // close 는 동기(closed=true+waiter wake) — 인라인 호출 안전, for-await 흐름 영향 0.
      // 턴 finally 의 steeringCh.close()(index.ts, 멱등)는 2차 안전망으로 그대로 유지
      // (abort·에러로 result 미도달 시 여전히 닫음).
      input.steering?.close();
      // ★경계 확정은 **우리 답변에 내용이 생긴 뒤에만** 한다 (2026-08-09 라이브 사고).
      //
      //  종전엔 첫 result 를 무조건 이 턴의 끝으로 봤다. 그런데 백그라운드 알림이 턴 **시작**에
      //  도착하면 SDK 가 합성 턴을 열고 그 턴의 result 가 **1초 만에** 먼저 온다. 그러면 가드가
      //  거기에 걸려, 그 뒤 24초간 스트리밍된 **진짜 답변을 통째로 버렸다**.
      //  실측(devbot 10:34): `task_notification` → `result/success`(1초) → assistant × 다수 →
      //  `LOOP-EXIT streamDeltas=49` → `FINALIZE textLen=0 succeeded=true`.
      //  사용자 화면엔 **빈 말풍선**만 남았고 `ok:true` 라 아무도 이상을 몰랐다.
      //
      //  ★두 관심사를 분리한다: `steering.close()`(데드락 수정)는 **첫 result 에 그대로**,
      //   답변 경계만 내용 유무로 판정한다. 이 가드가 원래 막던 사고(알림 텍스트가 답변에
      //   섞임)는 그때 **이미 답변이 있었으므로** 여전히 잡힌다 — 두 사고가 구분된다.
      const hasOwnAnswer = isOwnTurnEnd({
        chunks: assistantTextChunks.length,
        deltas: ownTextDeltas,
      });
      if (hasOwnAnswer) {
        turnResultSeen = true;
      } else if (!emptyResultNoted) {
        emptyResultNoted = true;
        console.warn(
          `[claude-turn-boundary] ${input.threadKey} 첫 result 가 **내용 없이** 도착 — ` +
            `백그라운드 알림이 연 합성 턴으로 보고 경계를 확정하지 않습니다(계속 수집). ` +
            `chunks=${assistantTextChunks.length} deltas=${diagStreamCount}`,
        );
      }
      if (msg.subtype === "success") {
        // 실측 (probe 2026-06-02): 모델 거부(미존재 model)는 SDK 가 result.subtype
        // "success" + is_error=true + result 본문에 API 에러를 실어 보낸다 (errors[]
        // 아님, throw 아님). 예: `API Error: 404 {"type":"error","error":
        // {"type":"not_found_error","message":"model: claude-sonnet-4-7"},...}`.
        // is_error 무시 시 이 API 에러 문자열이 정상 응답으로 사용자에게 노출되고,
        // 직후 SDK 의 "process exited with code 1" teardown throw 가 모든 걸 뭉갠다.
        // → is_error 면 result 본문(진짜 거부 상세)을 담아 throw → facade
        // isModelRejected 가 분류·폴백. 어댑터별 분기 아님(claude 의 단일 진실 표면).
        if (msg.is_error === true) {
          throw new Error(`claude-agent-sdk error: ${msg.result}`);
        }
        resultText = msg.result;
        succeeded = true;
        if (lastModel === null) {
          const usageKeys = Object.keys(msg.modelUsage ?? {});
          if (usageKeys.length > 0) lastModel = usageKeys[0] ?? null;
        }
        // /status 개편 — modelUsage[model] 의 {inputTokens, outputTokens} 추출 (추가
        // 호출 0). modelUsage = {[modelId]: {inputTokens, outputTokens, ...}} 형태 —
        // 위 키→model 추론과 같은 객체. 사용 모델 엔트리 우선, 없으면 첫 엔트리.
        // 형태가 다르거나 없으면 미설정(graceful → persist 가 기존값 보존).
        {
          const mu = msg.modelUsage ?? {};
          const usageEntry = ((lastModel !== null && mu[lastModel]) ??
            Object.values(mu)[0]) as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadInputTokens?: number;
                cacheCreationInputTokens?: number;
              }
            | undefined;
          if (usageEntry !== undefined || lastCallUsage !== undefined) {
            // ★두 축을 **분리해서** 싣는다 (2026-07-30). 계약(types.ts §usage):
            //   inputTokens/cachedTokens = **마지막 호출 1회** ("얼마나 찼나" — /status)
            //   *Total                   = **턴 전체 합계**   (진짜 비용·적중률)
            //  codex 는 원래 이 계약을 지켰는데 claude 만 안 지켰다. `modelUsage[model]`
            //  은 턴 안 모든 호출의 **누적합**이다 — 실측: 한 턴 cachedTokens=10,182,800
            //  (200K 창의 50.9배, 단일 호출로는 물리적으로 불가능). 그걸 inputTokens 에
            //  넣으면 /status 가 "컨텍스트 ~3293%" 를 띄우고 85% 경고가 상시 울린다
            //  (직전 상태는 캐시 읽기를 빼 늘 ~0% 라 경고가 아예 안 떴다 — 반대 방향의
            //  같은 실패). 호출 단위 값은 assistant 메시지 usage 에서 잡는다.
            const cumCached = usageEntry?.cacheReadInputTokens;
            const cumCreate = usageEntry?.cacheCreationInputTokens;
            const cumInput =
              (usageEntry?.inputTokens ?? 0) +
              (cumCached ?? 0) +
              (cumCreate ?? 0);
            // ★출력도 **턴 합계**를 싣는다 (2026-08-09). `outputTokens` 는 입력과 같은 규칙이라
            //  마지막 호출 1회다 — 도구 루프가 긴 턴을 iteration 수만큼 과소계상한다.
            //  입력엔 합계가 있었는데 출력만 없어서 벤치가 claude-code(세션 누적)와
            //  비대칭 비교를 했다(실측: 387 vs 4,338 — 같은 수렴 스텝 11 vs 11인데).
            const cumOutput = usageEntry?.outputTokens ?? 0;
            // 호출 단위가 없으면(비정상 종료 등) 누적값으로 폴백 — 없는 것보단 낫다.
            const perCall = lastCallUsage;
            lastUsage = {
              inputTokens: perCall?.input ?? cumInput,
              outputTokens: perCall?.output ?? usageEntry?.outputTokens ?? 0,
              ...(perCall !== undefined
                ? { cachedTokens: perCall.cacheRead }
                : typeof cumCached === "number"
                  ? { cachedTokens: cumCached }
                  : {}),
              // 턴 합계는 누적값 그대로. num_turns 를 iterations 로 실어야 소비처
              // (대시보드 카드·벤치)가 "여러 호출짜리 턴" 임을 알고 Total 을 쓴다.
              ...(usageEntry !== undefined && cumInput > 0
                ? {
                    iterations:
                      typeof msg.num_turns === "number" ? msg.num_turns : 2,
                    inputTokensTotal: cumInput,
                    ...(cumOutput > 0 ? { outputTokensTotal: cumOutput } : {}),
                    ...(typeof cumCached === "number"
                      ? { cachedTokensTotal: cumCached }
                      : {}),
                  }
                : {}),
            };
          }
        }
      } else {
        const errs = (msg.errors ?? []).join("; ") || msg.subtype;
        // ★이미 받은 성공 결과를 뒤따르는 에러로 버리지 않는다 (2026-07-28 실사고).
        //  SDK 는 한 실행에서 `result` 를 **두 번** 보낼 수 있다 — 실측 로그:
        //    01:15:17 recv=result/success
        //    01:15:17 recv=result/error_during_execution
        //      errors=["only prompt commands are supported in streaming mode",
        //              "MaxFileReadTokenExceededError: File content (33,579 tokens) …"]
        //  종전엔 두 번째를 무조건 throw 해 **55분짜리 워커의 완성된 결과를 통째로 폐기**하고
        //  "모든 어댑터 실패" 로 끝냈다(폴백까지 태우고 실패). 큰 파일 Read 는 모델이
        //  offset/limit 으로 다시 읽으면 되는 **회복 가능한 도구 에러**지, 완료된 작업을
        //  날릴 사유가 아니다. 로그 전수 3건 발생(07-19 2 · 07-28 1) — 드물지만 손실이 크다.
        //  ★결과가 없을 때만 throw 한다(그때는 진짜 실패라 폴백이 맞다). 결과가 있으면
        //   경고 + 관측 이벤트로 남기고 그 결과로 턴을 닫는다 — 조용히 삼키지 않는다.
        if (succeeded && resultText !== undefined && resultText !== "") {
          console.warn(
            `[claude-complete] ${input.threadKey} 완료 후 에러 result 수신 — 이미 받은 결과를 유지합니다: ${errs}`,
          );
          try {
            bus.publish({
              type: "llm.post_result_error",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "claude",
                subtype: String(msg.subtype),
                errors: errs.slice(0, 500),
              },
            });
          } catch {
            /* 관측 실패가 턴을 무르지 않는다 */
          }
          continue;
        }
        throw new Error(`claude-agent-sdk error: ${errs}`);
      }
    } else if (msg.type === "assistant") {
      // 서브에이전트(Task) 관측 라우팅 (ADR 2026-07-03 Phase A). parent_tool_use_id 가
      // 추적 중인 Task id 면 이 assistant 메시지는 *서브 내부* 스텝 → agent:<jobId> 좌표로
      // 분기. null(부모 자신)이면 기존 부모 좌표 발행 그대로(회귀 0).
      const parentToolUseId = (msg as { parent_tool_use_id?: unknown })
        .parent_tool_use_id;
      // 호출 단위 usage 캡처 — 부모 자신의 호출만(서브 내부 호출은 부모 컨텍스트가 아님).
      if (typeof parentToolUseId !== "string") {
        const u = (
          msg.message as unknown as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }
        )?.usage;
        // ★**폴백 전용**이다 (2026-08-05) — SDK 0.3 에선 이 usage 가 `message_start`
        //  스냅샷(`output_tokens: 1`)이라 최종값이 아니다. 최종값은 위 stream_event
        //  `message_delta` 가 채운다. 여기선 output 을 **덮지 않고**, message_delta 를
        //  못 본 경우(부분 스트리밍 미사용 경로)에만 입력 축을 채운다.
        if (u !== undefined && typeof u.input_tokens === "number") {
          const input =
            u.input_tokens +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          lastCallUsage = {
            input,
            cacheRead: u.cache_read_input_tokens ?? 0,
            // 이미 message_delta 가 실제 출력량을 넣었으면 그걸 지키고, 없을 때만 스냅샷.
            output: lastCallUsage?.output ?? u.output_tokens ?? 0,
          };
        }
      }
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "text"
          ) {
            const t = (block as { text?: unknown }).text;
            if (typeof t === "string") {
              // 서브 내부(nested) 텍스트는 부모 answer 수집·delta 에 넣지 않는다 —
              // 부모 회귀 0 핵심(서브 텍스트가 사용자 답변으로 새거나 부모 델타 버블에
              // 섞이면 안 됨). 관측은 도구 스텝(아래) 단위라 서브 텍스트는 activity 화 안 함
              // (스키마상 이산 도구 step 만, codex 서브도 도구만 per-step — parity).
              if (typeof parentToolUseId !== "string") {
                assistantTextChunks.push(t); // 권위 전체본(resultText 폴백) — 항상 적재.
                // llm.delta — assistant 텍스트 청크 fan-out(sdk_message firehose 와 별개
                // 레이어, 순수 텍스트 증분). coalescer 가 ~80ms∥120자로 묶어 발행.
                // ★이중발행 가드(2026-07-17) — 이 turn 에서 부분 델타(stream_event)를 이미
                // 한 번이라도 스트리밍했으면, 완성 블록에서 같은 텍스트를 또 push 하지 않는다
                // (완성 블록 = 그 텍스트의 부분 델타들이 이미 합쳐진 것). 부분 델타를 못 받은
                // 경우(SDK 미지원·이벤트 누락)에만 기존처럼 완성 블록에서 push(폴백 보존).
                if (!receivedPartialText) {
                  deltaStream.push(t);
                }
              }
            }
          } else if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "tool_use"
          ) {
            // ★MCP 도구명 정규화 (#2 LLM-agnostic) — claude Agent SDK 는 in-process MCP
            // 도구를 `mcp__<server>__<tool>` 로 노출한다(예 `mcp__skills__invoke_skill`).
            // 그대로 activity label 로 쓰면 codex/openai(접두사 없는 bare 이름) 와 label 이
            // 달라져, 대시보드의 label 기반 렌더(예 invoke_skill → 🛠 스킬 배지, background-drawer
            // skillStepInfo)가 claude 에서만 안 걸린다. 훅 경로가 이미 쓰는 normalizeToolName 으로
            // 접두사를 벗겨 세 어댑터 label 을 일치시킨다. 빌트인 도구(Edit/Task/Bash…)는 접두사가
            // 없어 무변(raw===정규화) → diff/timing/output/스폰 감지 분기 전부 회귀 0.
            const toolName = normalizeToolName(
              String((block as { name?: unknown }).name ?? "tool"),
            );
            const toolInput = (block as { input?: unknown }).input;
            const normInput =
              toolInput && typeof toolInput === "object"
                ? (toolInput as Record<string, unknown>)
                : undefined;
            const detail = buildActivityDetail(normInput);
            const diff = buildActivityDiff(toolName, normInput);
            // ExitPlanMode(plan 모드 계획 승인) — 전체 계획을 잘리지 않게 실어 대시보드가
            // 전체 렌더(detail 1줄로는 계획이 잘려 안 보이던 갭, A안). 과대 payload 방지 캡.
            const plan =
              toolName === "ExitPlanMode" &&
              normInput &&
              typeof normInput.plan === "string"
                ? normInput.plan.slice(0, PLAN_FIELD_CAP)
                : undefined;
            {
              // 부모 top-level tool_use. 서브에이전트 spawn 이면 관측 잡 등록.
              // ★도구 이름을 여기 박지 않는다 — SDK 0.3 이 `Task`→`Agent` 로 개명했는데
              //  하드코딩이라 **잡 등록이 통째로 죽어** 백그라운드 패널이 항상 0이었다
              //  (실측 24h: Agent 14회 / Task 0회). 판정은 subagent-tools 한 곳.
              // (nested 는 위에서 이미 분기되므로 여기 도달 = parent_tool_use_id===null 부모.)
              // 이 도구 앞까지 누적된 연속 텍스트가 있으면 kind:"text" 로 먼저 닫는다
              // (인터리브 순서 보존 — 텍스트 세그먼트가 이 도구보다 낮은 seq 를 받게).
              closeTextSegment();
              const toolUseId = (block as { id?: unknown }).id;
              // claude 백그라운드 셸 관측 등록(Phase 4, best-effort) — 이 tool_use 자체는
              // 아직 shellId 를 모른다(Bash 는 tool_result 에서, TaskOutput/KillShell 은
              // *우리가 이미 관측 중인* shellId 를 요청할 때만 상관— 서브에이전트 백그라운드
              // (`Agent` run_in_background)나 리모트 세션 등 남의 task_id 는 무시).
              if (typeof toolUseId === "string") {
                try {
                  if (toolName === "Bash" && normInput?.run_in_background === true) {
                    pendingBgBash.set(toolUseId, {
                      command:
                        typeof normInput.command === "string" ? normInput.command : "",
                    });
                  } else if (toolName === "TaskOutput") {
                    const reqId =
                      typeof normInput?.task_id === "string"
                        ? normInput.task_id
                        : undefined;
                    if (reqId !== undefined && observedShells.has(reqId)) {
                      pendingTaskOutput.set(toolUseId, reqId);
                    }
                  } else if (toolName === "KillShell") {
                    const reqId =
                      typeof normInput?.shell_id === "string"
                        ? normInput.shell_id
                        : undefined;
                    if (reqId !== undefined && observedShells.has(reqId)) {
                      pendingKillShellCalls.set(toolUseId, reqId);
                    }
                  }
                } catch {
                  /* 관측 등록 실패 무해 — 부모 turn 무영향(원칙 3). */
                }
              }
              // 인라인 스폰 스텝 ↔ 드로어 잡 링크(2026-07-13) — Task 로 등록된 관측 잡 jobId 를
              // 이 활동에 실어 대시보드가 클릭→드로어 점프·상태 표시. (등록 실패 시 undefined.)
              // llm.activity — 도구당 1 activity (sdk_message firehose 와 별개 레이어).
              // detail — tool_use 블록의 input 객체에서 중립 인자 요약(축3 사이드바).
              // Task 도구 자체도 부모 좌표 activity 로 남긴다(부모가 '서브를 띄웠다' 스텝).
              const toolSeq = activitySeq++;
              // 실행시간(#3) — tool_use id 로 시작 시각 기록 → tool_result 에서 durationMs.
              if (typeof toolUseId === "string") {
                toolTiming.set(toolUseId, {
                  seq: toolSeq,
                  t0: Date.now(),
                  label: toolName,
                  // ★도구 지연 감시 (2026-07-28, D) — 종전엔 codex 에만 있어, claude 로 도는
                  //  워커는 도구가 권한 다이얼로그에 막혀도 사용자에게 신호가 없었다.
                  //  판정은 공통 엔진이 하고 여기선 시작/종료만 건다.
                  // ★2026-08-06 — 경고에 더해 **중단 레버**를 넘긴다. 종전엔 "경고만" 이라
                  //  아무도 안 끊었고, 회사 PC 로그에서 도구가 멈춘 뒤 39분간 그 세션이
                  //  통째로 먹통이었다(직렬 큐라 다음 메시지도 처리 안 됨). codex·openai 는
                  //  `_mcp-bridge` 의 11분 상한이 있었지만 claude 는 MCP 를 SDK 에 직접 넘겨
                  //  그 그물 밖이었다 — 어댑터별로 안전망이 달랐던 것(원칙 #2).
                  stopSlow: watchToolStart({
                    channel: input.channel,
                    threadKey: input.threadKey,
                    tool: toolName,
                    onHard: (tool, ms) => {
                      if (!effectiveAc.signal.aborted) {
                        effectiveAc.abort(
                          new Error(
                            `도구 '${tool}' 이(가) ${Math.round(ms / 1000)}초 안에 응답하지 않아 턴을 중단했습니다.`,
                          ),
                        );
                      }
                    },
                  }),
                });
              }
              bus.publish({
                type: "llm.activity",
                ts: Date.now(),
                payload: {
                  channel: input.channel,
                  threadKey: input.threadKey,
                  adapter: "claude",
                  model: lastModel ?? undefined,
                  seq: toolSeq,
                  kind: "tool",
                  label: toolName,
                  detail,
                  ...(diff !== undefined ? { diff } : {}),
                  ...(plan !== undefined ? { plan } : {}),
                  // ★알려진 회귀 (2026-08-08, 레드팀 F2): 스텝→잡카드 점프가 죽었다.
                  //  종전엔 SDK Task 등록 시점의 jobId 를 여기 실어 대시보드가 칩 클릭으로
                  //  해당 잡카드로 스크롤·하이라이트했다. `spawn_agent` 은 **MCP 도구가
                  //  실행돼야** jobId 가 생겨서, 부모가 이 스텝을 낼 때는 아직 없다 —
                  //  복원하려면 별도 연결 기제(등록 시 부모 좌표로 링크 이벤트)가 필요하다.
                  //  지금은 `RegionAActivityPayload.jobId` 의 생산자가 0이다(그 필드는 죽은
                  //  스키마). 고치기 전까지 **없는 걸 없다고 적어둔다** — 빈 객체를 조용히
                  //  넣어두면 다음 사람이 "있는데 안 되네" 로 시간을 태운다.
                } satisfies RegionAActivityPayload,
              });
            }
          }
        }
      }
    } else if (msg.type === "user") {
      // Task 완료 감지 — 부모가 자기 Task tool_use 에 대응하는 tool_result 를 받는 user
      // 메시지(parent_tool_use_id===null). content 의 tool_result 블록 중 tool_use_id 가
      // 추적 중인 Task id 면 그 서브 완료 → markDone(agent 잡 종료 = 대시보드 카드 완료).
      // best-effort — extractToolResults·completeTaskJob 은 throw 없음(순수/try 내장).
      if (
        toolTiming.size > 0 ||
        pendingBgBash.size > 0 ||
        pendingTaskOutput.size > 0 ||
        pendingKillShellCalls.size > 0
      ) {
        for (const { toolUseId, text, isError } of extractToolResults(msg)) {
          // 실행시간(#3) — 이 tool_result 에 대응하는 top-level 도구가 있으면 phase:"end"
          // +durationMs 로 발행(같은 seq → 대시보드가 시작 스텝에 실행시간 주석). best-effort.
          const timing = toolTiming.get(toolUseId);
          if (timing !== undefined) {
            toolTiming.delete(toolUseId);
            timing.stopSlow?.(); // 결과 도착 = 더 감시할 이유 없음(타이머 누수 0).
            const output = buildActivityOutput(timing.label, text, isError);
            try {
              bus.publish({
                type: "llm.activity",
                ts: Date.now(),
                payload: {
                  channel: input.channel,
                  threadKey: input.threadKey,
                  adapter: "claude",
                  // ★도구 *완료* 이벤트만 model 을 빠뜨리고 있었다(2026-07-27). 실측: claude
                  //  tool activity 2,103건 중 904건(43%)에 model 부재 — 전부 이 phase:"end".
                  //  같은 파일의 다른 3개 발행부는 전부 싣고 codex 는 100% 라, "알 수 없는 값"
                  //  이 아니라 단순 누락이었다. 대시보드가 실제 모델을 표시하려면 여기가 채워져야
                  //  같은 도구의 시작/완료가 같은 모델로 보인다(폴백 추적의 전제).
                  model: lastModel ?? undefined,
                  seq: timing.seq,
                  kind: "tool",
                  label: timing.label,
                  phase: "end",
                  durationMs: Date.now() - timing.t0,
                  ...(output !== undefined ? { output } : {}),
                } satisfies RegionAActivityPayload,
              });
            } catch {
              /* 관측 발행 실패가 turn 을 무르지 않는다(원칙 3). */
            }
          }

          // claude 백그라운드 셸 관측(Phase 4) — best-effort, 매칭 실패 시 조용히 미관측.
          try {
            // (a) Bash(run_in_background) tool_result — 여기서 처음 shellId 를 안다.
            const pendingBash = pendingBgBash.get(toolUseId);
            if (pendingBash !== undefined) {
              pendingBgBash.delete(toolUseId);
              const m = !isError ? BG_BASH_ID_RE.exec(text) : null;
              const shellId = m?.[1];
              if (shellId !== undefined) {
                const startedAt = Date.now();
                observedShells.set(shellId, { command: pendingBash.command, startedAt });
                publishClaudeShellEvent("shell.started", {
                  shellId,
                  command: pendingBash.command,
                  cwd,
                  status: "running",
                  startedAt,
                  threadKey: input.threadKey,
                });
              }
            }

            // (b) KillShell tool_result — 모델이 자기 KillShell 도구로 종료(우리 kill 아님,
            // 대시보드 ⏹️ 는 killable:false 라 비활성 — 이건 모델 스스로의 종료를 미러링).
            const killTarget = pendingKillShellCalls.get(toolUseId);
            if (killTarget !== undefined) {
              pendingKillShellCalls.delete(toolUseId);
              if (
                !isError &&
                !finalizedShells.has(killTarget) &&
                KILL_SUCCESS_RE.test(text)
              ) {
                finalizedShells.add(killTarget);
                const meta = observedShells.get(killTarget);
                publishClaudeShellEvent("shell.exited", {
                  shellId: killTarget,
                  command: meta?.command,
                  cwd,
                  status: "killed",
                  exitCode: null,
                  startedAt: meta?.startedAt,
                  threadKey: input.threadKey,
                });
              }
            }

            // (c) TaskOutput tool_result — coarse exit 추론(모델이 상태를 확인했을 때만).
            const pollTarget = pendingTaskOutput.get(toolUseId);
            if (pollTarget !== undefined) {
              pendingTaskOutput.delete(toolUseId);
              if (!finalizedShells.has(pollTarget)) {
                const statusMatch = TASK_STATUS_RE.exec(text);
                const status = statusMatch?.[1]?.trim();
                if (status !== undefined && status !== "" && status !== "running") {
                  finalizedShells.add(pollTarget);
                  const exitMatch = TASK_EXIT_CODE_RE.exec(text);
                  const meta = observedShells.get(pollTarget);
                  publishClaudeShellEvent("shell.exited", {
                    shellId: pollTarget,
                    command: meta?.command,
                    cwd,
                    status: "exited",
                    exitCode: exitMatch !== null ? Number(exitMatch[1]) : null,
                    startedAt: meta?.startedAt,
                    threadKey: input.threadKey,
                  });
                }
              }
            }
          } catch {
            /* 관측 실패가 turn 을 무르지 않는다(원칙 3). */
          }
        }
      }
    }
  }
    console.log(`[claude-complete] ${input.threadKey} LOOP-EXIT (스트림 정상 종료) resultText=${resultText !== undefined} chunks=${assistantTextChunks.length} streamDeltas=${diagStreamCount}`);
    break; // 스트림 정상 소비 — 재시도 루프 종료.
  } catch (e) {
    // resume 세션 부재/손상("process exited with code 1") → resume 제거 후 fresh
    // 세션으로 1회만 재시도. resumable(애초 resume 시도) + 미재시도 + 비-abort 한정.
    if (
      !resumeRetried &&
      resumable &&
      isResumeProcessFailure(e) &&
      !effectiveAc.signal.aborted
    ) {
      resumeRetried = true;
      resultText = undefined;
      assistantTextChunks = [];
      lastSessionId = undefined;
      lastModel = null;
      lastUsage = undefined;
      lastCallUsage = undefined; // 실패한 첫 시도의 호출 단위 값이 새 시도로 새지 않게.
      succeeded = false;
      activitySeq = 0;
      receivedPartialText = false; // fresh 세션 재시도 — 이중발행 가드도 새 시도 기준 리셋.
      deltaStream.closeSegment(); // 세그먼트 버퍼 드레인(발행 안 함) — 실패한 첫 시도의 잔여
      // 텍스트가 fresh 세션의 첫 세그먼트로 새지 않게(activitySeq=0 리셋과 동형 취지).
      toolTiming.clear(); // 실행시간(#3) 매핑도 리셋 — fresh 세션엔 이전 tool_use id 안 옴.
      const freshOptions: Options = { ...options };
      delete (freshOptions as { resume?: unknown }).resume;
      q = buildQuery(freshOptions);
      continue; // resume 없이 재실행.
    }
    // SDK 가 abort 시 throw 하는 경우(AbortError 등) — 1층(유휴) 또는 2층(턴) 타임아웃이
    // 원인이면 해당 에러로 승격해 facade 가 일관된 타임아웃 신호를 받게 한다(둘 다
    // isModelRejected 비매칭 — I-3/TT-I3). reason 은 linkAbort 가 effectiveAc 로 보존.
    // 그 외 에러는 그대로 전파.
    // 처리불가 이미지 400 — resume 세션 jsonl 이 오염됐다(재생 시 매번 400). resumable 이었을
    // 때만(= 저장된 세션에 오염이 append 됨) resume 을 무효화 → 다음 turn 은 비-resumable 로
    // fresh+prepend(문맥 보존, 오염 jsonl 폐기). 풀의 다음 모델이 곧바로 이 turn 을 자가복구할
    // 수 있고(과거 오염일 때), 아니어도 다음 사용자 turn 이 clean. 에러는 그대로 전파(풀 폴백).
    if (resumable && isUnprocessableImage(e)) {
      try {
        invalidateResume(idChannel, input.threadKey);
        console.warn(
          `claude: 처리불가 이미지 400 — resume 무효화(스레드 오염 자가치유). ` +
            `channel=${input.channel} thread=${input.threadKey}`,
        );
      } catch {
        /* 무효화 실패해도 에러 전파는 계속(원칙 3). */
      }
    }
    // abort reason 승격 — 유휴/턴 타임아웃, 그리고 native Task 취소(WorkerCancelledError,
    // U-I4 개정)면 raw AbortError 대신 그 typed reason 을 throw 해 상위(index.ts)가 일관되게
    // 분류하게 한다. WorkerCancelledError 는 "모델 거부 아님" 토큰이라 isModelRejected 비매칭 +
    // index.ts 가 name 으로 취소 분류(폴백 단락·turn_error 미발행) → "stop 이 실제 stop".
    const reason = effectiveAc.signal.reason;
    if (
      effectiveAc.signal.aborted &&
      (reason instanceof IdleTimeoutError ||
        reason instanceof TurnTimeoutError ||
        reason instanceof WorkerCancelledError)
    ) {
      throw reason;
    }
    throw e;
  }
  } // for(;;) — resume 폴백 재시도 루프
  } finally {
    // 타이머 누수 0 (I-6) — 성공·throw·abort 모든 경로에서 해제.
    idleTimer.done();
    // 도구 지연 감시 잔여 해제 — tool_result 없이 턴이 끝난 경우(중단·에러·SDK abort)
    // 타이머가 남아 **끝난 도구에 대해 뒤늦게 경고**를 찍는다. 그건 오탐이다.
    for (const t of toolTiming.values()) t.stopSlow?.();
    toolTiming.clear();
    // 델타 잔여 flush(꼬리 유실 0) + coalesce 타이머 정리. best-effort — 실패해도
    // out 전체본이 권위 교체(자가치유). 성공·throw·abort 모든 경로에서 1회.
    deltaStream.flush();
    // 트레일링 텍스트 세그먼트 닫기(2026-07-13 인터리브) — 마지막 도구 이후(또는 도구가
    // 전혀 없었던) 턴 종료 시점까지 누적된 텍스트를 kind:"text" 로 발행. flush() 다음(델타
    // 코얼레스 버퍼와 무관한 별개 버퍼) — 순서·타이밍 상관없이 항상 이 자리 1회.
    closeTextSegment();
  }

  // 유휴/턴 abort 의 "조용한 종결" 승격 (§2.2) — SDK 가 abort 시 throw 없이 for-await 를
  // 조용히 끝낼 수 있다. 그 경우 succeeded=false 로 떨어져 facade 가 실패를 못 본다.
  // reason 이 Idle/TurnTimeoutError, 또는 native Task 취소(WorkerCancelledError, U-I4 개정)면
  // 명시 throw 로 승격 (셋 다 isModelRejected 비매칭 — facade 무폴백, index.ts 취소 분류).
  {
    const reason = effectiveAc.signal.reason;
    if (
      effectiveAc.signal.aborted &&
      (reason instanceof IdleTimeoutError ||
        reason instanceof TurnTimeoutError ||
        reason instanceof WorkerCancelledError)
    ) {
      throw reason;
    }
  }

  // ★`??` 는 **빈 문자열에 폴백하지 않는다** (2026-08-09 적대 검토 A). 합성 턴(백그라운드
  //  알림)의 result 본문이 `""` 로 오면 `resultText = ""` 가 대입되고, 그 뒤 우리가 조각
  //  49개를 모아도 마감이 `""` 를 골라 **빈 말풍선 + ok:true** 가 그대로 재현된다.
  //  경계를 늦게 잡는 것만으론 반쪽이었다 — 마감도 "내용 있는 쪽"을 골라야 닫힌다.
  const chunkText = assistantTextChunks.join("");
  const text = resultText !== undefined && resultText !== "" ? resultText : chunkText;
  console.log(
    `[claude-complete] ${input.threadKey} FINALIZE (loop 이후 마감 진입) textLen=${text.length} ` +
      `succeeded=${succeeded} (result=${resultText === undefined ? "없음" : String(resultText.length) + "자"} chunks=${chunkText.length}자)`,
  );
  const effectiveSuccess = succeeded || text.length > 0;
  console.log(`[claude-complete] ${input.threadKey} RETURN (어댑터 반환 — 이후 turn_done/전달은 facade) len=${text.length}`);
  if (effectiveSuccess && lastSessionId !== undefined) {
    const sessionId: string = lastSessionId;
    const jsonl = resolveJsonlPath(input.cwd ?? getPaths().home, sessionId);
    // V5 — 어댑터는 sessionId·model·hash·jsonlPath 만 보고, saveSession·indexJsonl
    // 은 runRegionA(facade)가 어댑터 무관 통합 처리. transcript 진실 소스 = jsonl.
    return {
      text,
      sessionId,
      model: lastModel,
      systemPromptHash: SYSTEM_PROMPT_HASH,
      jsonlPath: jsonl,
      replyToTrigger,
      usage: lastUsage,
    };
  }

  return { text, replyToTrigger };
};
