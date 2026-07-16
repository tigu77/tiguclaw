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
 * `discoverSkills`/`discoverAgents` 로 직접 인덱스를 구성해 user prompt 에 prepend
 * + 서브에이전트는 `options.agents` 로 주입(SDK native Task tool 이 실행) +
 * 스킬 실행은 invoke_skill MCP — codex 어댑터와 parity (원칙 1·2).
 * 이중 노출 방지: settingSources 를 켜지 말 것 (아래 options 가드 주석 참조).
 *
 * Memory Round 2 변경 (contract `_workspace/memory_round2_architect_contract.md`):
 *  - AGENT.md (1층 self markdown, cwd 루트 hub) user prompt prepend.
 *  - V3 도구 4종 (read/add/update/delete memory) SDK in-process MCP server 로 노출.
 *  - 전체 memories 1줄 인덱스 user prompt prepend.
 *  - V2 fire-and-forget haiku 자동 추출 deprecate (LLM 자기 도구로 대체).
 *
 *  fingerprint 가드 양립: 모든 동적 컨텐츠 (AGENT.md, 인덱스, snippet) 는 user prompt
 *  prepend — sysprompt 는 정적으로 두어 SYSTEM_PROMPT_HASH 무변, resume 보존.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  query,
  type AgentDefinition,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getSession, invalidateResume } from "../../../store/sessions.js";
import { getPaths } from "../../paths.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import { buildActivityDetail } from "./_activity-detail.js";
import { buildActivityDiff } from "./_activity-diff.js";
import { buildActivityOutput } from "./_activity-output.js";
import { createDeltaStream } from "./_delta-stream.js";
import { DISALLOWED_TOOLS } from "../../../auth/permissions.js";
import { getEventBus } from "../../eventbus.js";
import {
  agentSizeWarning,
  readAgent,
  readSystem,
} from "../../identity.js";
import {
  assembleUserPrompt,
  buildSystemContextParts,
  formatAttachments,
  formatConversationContext,
  formatMemoryIndex,
  formatMemorySnippet,
  formatModelProfiles,
} from "../../prompt-assembly.js";
import { formatEnvContext } from "../../runtime-env.js";
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
import { createProjectRegistryMcpServer } from "../capabilities/project-registry.js";
import { createFindCapabilitiesMcpServer } from "../capabilities/find-capabilities-mcp.js";
import {
  createIdleTimer,
  IdleTimeoutError,
  IDLE_TIMEOUT_CONFIG,
  idleConfigExempt,
} from "../idle-timeout.js";
import { linkAbort, TurnTimeoutError } from "../turn-timeout.js";
import type {
  RegionAActivityPayload,
  RegionASdkInput,
  RegionASdkOutput,
} from "../types.js";

// payload 사이즈 가드 — tool_use input · result text 등이 큰 경우 truncate.
// in-memory ring buffer 라 토큰/비용 영향 0 이지만 buffer 점유 보호.
const PAYLOAD_FIELD_CAP = 2048;
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
const parseTaskInput = (
  input: unknown,
): { agentName: string; task: string; label: string } => {
  const o =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const subagentType =
    typeof o.subagent_type === "string" && o.subagent_type.trim() !== ""
      ? o.subagent_type.trim()
      : "subagent"; // 없으면 방어적 폴백(임무 제약).
  const prompt = typeof o.prompt === "string" ? o.prompt : "";
  const description = typeof o.description === "string" ? o.description : "";
  return {
    agentName: subagentType,
    label: subagentType,
    task: prompt !== "" ? prompt : description,
  };
};

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
    return `${who}: ${t.content}`;
  });
  return [
    "## 지난 대화 (다른 응답 포함)",
    "아래는 이 thread 에서 직전까지 오간 대화로, 다른 LLM 의 응답이 섞여 있을 수 있습니다. 맥락 연속을 위해 참고하세요.",
    "",
    lines.join("\n\n"),
  ].join("\n");
};

// agent frontmatter `model` → SDK `AgentDefinition.model`.
// SDK 는 anthropic 3종 등급(`sonnet|opus|haiku`)과 `inherit` 만 받는다
// (`coreTypes.d.ts` AgentDefinition.model). 우리 레지스트리 `model` 은
// 티어(high/mid/low) 또는 `provider:model` 직접 지정.
//  - 티어: codex spawn 의 resolveTier(MODEL_TIER_*)는 임의 provider:model 풀이지만,
//    claude SDK 는 대표 모델 1개만 받으므로 high→opus / mid→sonnet / low→haiku 로
//    대표 매핑(능력 경계 — claude 어댑터는 anthropic 모델만 실행, contract §3.2).
//  - sonnet/opus/haiku 직접 지정도 그대로 통과.
//  - 그 외(provider:model 직접·미지정·미인식) → undefined → SDK 가 main model 상속
//    (`inherit` 동등). undefined 면 키 자체를 안 박아 SDK 디폴트.
const mapTierToSdkModel = (
  model: string | undefined,
): AgentDefinition["model"] | undefined => {
  const s = (model ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  switch (s) {
    case "high":
    case "opus":
      return "opus";
    case "mid":
    case "sonnet":
      return "sonnet";
    case "low":
    case "haiku":
      return "haiku";
    case "inherit":
      return "inherit";
    default:
      // provider:model 직접 지정 등 — SDK 등급 밖. 미지정 처리 → main model 상속.
      return undefined;
  }
};

export const runClaude = async (
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
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

  const discoveredAgents: Agent[] = depth === 0 ? await discoverAgents(cwd) : [];
  let agents: Record<string, AgentDefinition> | undefined;
  if (discoveredAgents.length > 0) {
    const entries = await Promise.all(
      discoveredAgents.map(async (a): Promise<[string, AgentDefinition]> => {
        let prompt = a.description;
        try {
          // .md raw 본문(frontmatter 포함) = agent 의 system prompt (전략 A).
          prompt = await fs.readFile(a.filePath, "utf8");
        } catch {
          // read 실패 시 description 으로 폴백 (drop 보다 노출 우선).
        }
        const sdkModel = mapTierToSdkModel(a.model);
        // lean 도구 정책 (2026-06-15, architect §4 — claude SDK Task 경로 parity).
        // agent.md `tools` 를 중립 신호(deriveToolPolicy)로 정규화해 적용.
        //  - {mode:"none"}: tools: [] = 도구 0 (SDK "[] = disable all"). lean child.
        //  - {mode:"allow"}/undefined: tools 키 미설정 = 전체 도구. allow 정밀 allowlist 는
        //    codex/openai 가 아직 미지원(MCP 도구명 단위 필터 필요)이라, claude 만 native
        //    allowlist 를 켜면 어댑터 간 동작이 갈려 LLM-agnostic 하드게이트 위반.
        //    → 3어댑터 동시 구현 전까지 allow=전체도구로 *일관 degrade* (2026-06-15 결정).
        // 메모리 lean: claude child 는 SDK Task 가 AgentDefinition.prompt(=.md 본문)로
        // 독립 실행 → 부모 turn 의 retrieveContext/memoryIndex 가 child prompt 에 애초
        // 주입되지 않는다(부모 프롬프트 전용). 즉 메모리 생략은 이 경로에서 *구조적으로*
        // 보장 — leanMemory 별도 처리 불요(parity 갭 없음, 보고 참조).
        const policy = deriveToolPolicy(a.tools);
        const toolsField =
          policy?.mode === "none" ? { tools: [] as string[] } : {};
        return [
          a.name,
          {
            description: a.description,
            prompt,
            ...(sdkModel !== undefined ? { model: sdkModel } : {}),
            ...toolsField,
          },
        ];
      }),
    );
    agents = Object.fromEntries(entries);
  }

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

  const options: Options = {
    // 중립 override(게이트웨이) 지정 시 그 값이 시스템 프롬프트 — tiguclaw 작동헌법 대체.
    systemPrompt: input.systemPromptOverride ?? SYSTEM_PROMPT,
    permissionMode: "bypassPermissions",
    abortController: effectiveAc,
    disallowedTools: [...DISALLOWED_TOOLS],
    persistSession: true,
    cwd,
    // lean(toolsNone) child 는 SDK 빌트인 도구도 0 (`tools: []` = disable all built-ins).
    ...(toolsNone ? { tools: [] as string[] } : {}),
    // facade 가 provider:model 에서 추출해 주입. 미지정 시 SDK 디폴트.
    ...(input.model !== undefined ? { model: input.model } : {}),
    mcpServers: {
      ...leanMcpServers,
      ...externalMcpServers,
      ...(toolsNone
        ? {}
        : {
            "find-capabilities": createFindCapabilitiesMcpServer(
              capabilityActiveNames,
              "`Task` 도구로 위임하세요 (subagent_type 에 에이전트 이름, prompt 에 작업 지시). 다른 프로젝트/병렬 위임엔 spawn_agent 도 사용 가능",
              input.extraMcpServers,
            ),
          }),
    },
    // 커스텀 서브에이전트 (격리라 SDK 가 .claude/agents 못 봄 → 수동 주입).
    // SDK native Task tool 이 이 정의를 발견·실행 (codex spawn_agent 브리지 불요).
    ...(agents !== undefined ? { agents } : {}),
    ...(resumable ? { resume: prior.claudeSessionId } : {}),
  };

  // user prompt prefix 조립 순서:
  //   [AGENT body] + [AGENT warning] + [memory index] + [formatMemorySnippet] + [user text]
  // sysprompt 는 정적 → fingerprint 가드 보존 (Phase 2 회귀 0).
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

  // 서브에이전트 인덱스 — codex 와 동일 노출 (LLM 이 에이전트 존재를 알게).
  // depth 0 turn 만 (위 discoveredAgents 재사용 — 중복 fs walk 0). SDK options.agents
  // 주입과 병행: 인덱스는 "존재 인지", agents 주입은 Task 발견·실행 경로.
  // claude 는 spawn_agent 도구가 없으므로(codex 전용) Task 도구로 위임하도록 힌트 주입
  // — 없는 도구로 오도 방지 (options.agents 의 subagent_type 으로 실행).
  const agentIndex = formatAgentIndex(
    discoveredAgents,
    "`Task` 도구로 위임하세요 (subagent_type 에 에이전트 이름, prompt 에 작업 지시)",
  );

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
  const systemContextParts =
    input.systemPromptOverride !== undefined
      ? []
      : buildSystemContextParts({
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
  const promptWithMemory = assembleUserPrompt(systemContextParts, userTurnParts);

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
  const buildQuery = (o: Options) =>
    query({ prompt: promptWithMemory, options: o });
  let q = buildQuery(options);
  let resumeRetried = false;

  let resultText: string | undefined;
  let assistantTextChunks: string[] = [];
  let lastSessionId: string | undefined;
  let lastModel: string | null = null;
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  let succeeded = false;
  // llm.activity — 어댑터 로컬 단조 시퀀스 (turn 시작 0, publish 마다 +1). nonce 아님.
  let activitySeq = 0;

  // 도구 실행시간(#3) — top-level tool_use id → {그 도구의 activity seq, 시작 벽시계, 라벨}.
  // tool_result 도착 시 이 맵에서 찾아 phase:"end"+durationMs 로 1건 더 발행(대시보드 seq 매칭).
  const toolTiming = new Map<string, { seq: number; t0: number; label: string }>();

  const bus = getEventBus();

  // ─── 서브에이전트(Task) 관측 상태 (per-turn, 클로저 지역 = 동시 turn 격리) ────────
  // Task tool_use id → 관측 jobId 매핑. 한 턴에 Task 여러 개 가능 → Map.
  // 서브 내부 스텝(parent_tool_use_id === taskId)은 부모 좌표가 아니라 agent:<jobId>
  // 좌표의 llm.activity 로 발행(codex 서브 per-step 과 동형). agentSeq 는 잡별 단조 시퀀스.
  const taskJobs = new Map<
    string,
    { jobId: string; agentName: string; task: string; seq: number }
  >();

  // 서브 내부 도구 스텝을 agent:<jobId> 좌표로 발행 (best-effort — throw 격리).
  // kind 는 "tool" 만 — llm.activity 스키마(RegionAActivityPayload.kind: "tool"|"turn")가
  // 이산 도구 스텝 단위라, 서브 내부 텍스트는 별도 activity 로 만들지 않는다(codex 서브도
  // 도구만 per-step 관측 — parity). 코어 타입 무편집(임무 제약) 하에 동형 유지.
  const publishAgentToolActivity = (
    entry: { jobId: string; agentName: string; seq: number },
    label: string,
    detail: string | undefined,
    diff: ReturnType<typeof buildActivityDiff>,
  ): void => {
    try {
      bus.publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: {
          channel: input.channel,
          threadKey: `agent:${entry.jobId}`, // 워커 worker:<jobId> 와 동형 — 대시보드 서브 카드 귀속.
          adapter: "claude",
          model: lastModel ?? undefined,
          seq: entry.seq++,
          kind: "tool",
          label,
          ...(detail !== undefined ? { detail } : {}),
          ...(diff !== undefined ? { diff } : {}),
        } satisfies RegionAActivityPayload,
      });
    } catch {
      /* 관측 발행 실패가 부모 turn 을 무르지 않는다(원칙 3). */
    }
  };

  // Task tool_use 감지 시 관측 잡 등록 (best-effort). 등록 실패해도 부모 turn 무영향.
  const registerTaskJob = (taskId: string, rawInput: unknown): void => {
    if (taskJobs.has(taskId)) return; // 중복 감지 방어(같은 tool_use id 재관측).
    try {
      const { agentName, label, task } = parseTaskInput(rawInput);
      // 모델 티어 관측 — 발견된 에이전트 정의의 model(티어) 을 잡에 기록(대시보드·/agents).
      // codex(agent.model)와 동일 정보. 미발견/미지정이면 "default".
      const modelTier =
        discoveredAgents.find((a) => a.name === agentName)?.model ?? "default";
      const jobId = registerJob({
        kind: "agent",
        agentName,
        modelTier,
        label,
        task,
        threadKey: input.threadKey, // 어느 대화가 띄운 서브인지 상관(codex 와 동일).
        channel: input.channel,
        channelUserId: "", // agent 잡은 재주입/통지 안 함(U-I1).
      });
      taskJobs.set(taskId, { jobId, agentName, task, seq: 0 });
    } catch {
      /* registerJob 실패해도 부모 turn 진행(원칙 3). 이 Task 는 관측 누락으로 degrade. */
    }
  };

  // Task 완료 마킹 — tool_result 도착 시. best-effort. isError=true(서브 실패)면 markFailed
  // 로 닫아 실패 lifecycle 이 codex(spawn_agent throw→markFailed)와 parity(#2 하드게이트).
  const completeTaskJob = (
    taskId: string,
    resultText: string,
    isError: boolean,
  ): void => {
    const entry = taskJobs.get(taskId);
    if (entry === undefined) return;
    taskJobs.delete(taskId);
    try {
      if (isError) {
        markFailed(entry.jobId, resultText || "서브에이전트 실행 실패");
      } else {
        markDone(entry.jobId, resultText);
      }
    } catch {
      /* 완료 마킹 실패 무해 — 아래 finally 정리가 고아 방지 백업 아님(이미 delete). */
    }
  };

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
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    // 유휴 타임아웃 heartbeat — 매 SDK message 도착 = 살아있음 신호. 타이머 reset.
    idleTimer.beat();
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

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.model === "string") {
        lastModel = msg.model;
        deltaStream.setModel(msg.model); // 델타 라벨 보정(늦게 알게 된 모델).
      }
    } else if (msg.type === "result") {
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
            | { inputTokens?: number; outputTokens?: number }
            | undefined;
          if (usageEntry !== undefined) {
            lastUsage = {
              inputTokens: usageEntry.inputTokens ?? 0,
              outputTokens: usageEntry.outputTokens ?? 0,
            };
          }
        }
      } else {
        const errs = (msg.errors ?? []).join("; ") || msg.subtype;
        throw new Error(`claude-agent-sdk error: ${errs}`);
      }
    } else if (msg.type === "assistant") {
      // 서브에이전트(Task) 관측 라우팅 (ADR 2026-07-03 Phase A). parent_tool_use_id 가
      // 추적 중인 Task id 면 이 assistant 메시지는 *서브 내부* 스텝 → agent:<jobId> 좌표로
      // 분기. null(부모 자신)이면 기존 부모 좌표 발행 그대로(회귀 0).
      const parentToolUseId = (msg as { parent_tool_use_id?: unknown })
        .parent_tool_use_id;
      const nestedEntry =
        typeof parentToolUseId === "string"
          ? taskJobs.get(parentToolUseId)
          : undefined;
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
              if (nestedEntry === undefined) {
                assistantTextChunks.push(t);
                // llm.delta — assistant 텍스트 청크 fan-out(sdk_message firehose 와 별개
                // 레이어, 순수 텍스트 증분). coalescer 가 ~80ms∥120자로 묶어 발행.
                deltaStream.push(t);
              }
            }
          } else if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "tool_use"
          ) {
            const toolName = String((block as { name?: unknown }).name ?? "tool");
            const toolInput = (block as { input?: unknown }).input;
            const normInput =
              toolInput && typeof toolInput === "object"
                ? (toolInput as Record<string, unknown>)
                : undefined;
            const detail = buildActivityDetail(normInput);
            const diff = buildActivityDiff(toolName, normInput);
            if (nestedEntry !== undefined) {
              // 서브 내부 도구 — agent:<jobId> 좌표 activity(codex 서브 per-step 동형).
              publishAgentToolActivity(nestedEntry, toolName, detail, diff);
            } else {
              // 부모 top-level tool_use. name==="Task" 면 서브에이전트 spawn → 관측 잡 등록.
              // (nested 는 위에서 이미 분기되므로 여기 도달 = parent_tool_use_id===null 부모.)
              // 이 도구 앞까지 누적된 연속 텍스트가 있으면 kind:"text" 로 먼저 닫는다
              // (인터리브 순서 보존 — 텍스트 세그먼트가 이 도구보다 낮은 seq 를 받게).
              closeTextSegment();
              const toolUseId = (block as { id?: unknown }).id;
              if (toolName === "Task" && typeof toolUseId === "string") {
                registerTaskJob(toolUseId, toolInput);
              }
              // 인라인 스폰 스텝 ↔ 드로어 잡 링크(2026-07-13) — Task 로 등록된 관측 잡 jobId 를
              // 이 활동에 실어 대시보드가 클릭→드로어 점프·상태 표시. (등록 실패 시 undefined.)
              const spawnJobId =
                toolName === "Task" && typeof toolUseId === "string"
                  ? taskJobs.get(toolUseId)?.jobId
                  : undefined;
              // llm.activity — 도구당 1 activity (sdk_message firehose 와 별개 레이어).
              // detail — tool_use 블록의 input 객체에서 중립 인자 요약(축3 사이드바).
              // Task 도구 자체도 부모 좌표 activity 로 남긴다(부모가 '서브를 띄웠다' 스텝).
              const toolSeq = activitySeq++;
              // 실행시간(#3) — tool_use id 로 시작 시각 기록 → tool_result 에서 durationMs.
              if (typeof toolUseId === "string") {
                toolTiming.set(toolUseId, { seq: toolSeq, t0: Date.now(), label: toolName });
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
                  ...(spawnJobId ? { jobId: spawnJobId } : {}),
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
      if (taskJobs.size > 0 || toolTiming.size > 0) {
        for (const { toolUseId, text, isError } of extractToolResults(msg)) {
          if (taskJobs.size > 0) completeTaskJob(toolUseId, text, isError);
          // 실행시간(#3) — 이 tool_result 에 대응하는 top-level 도구가 있으면 phase:"end"
          // +durationMs 로 발행(같은 seq → 대시보드가 시작 스텝에 실행시간 주석). best-effort.
          const timing = toolTiming.get(toolUseId);
          if (timing !== undefined) {
            toolTiming.delete(toolUseId);
            const output = buildActivityOutput(timing.label, text, isError);
            try {
              bus.publish({
                type: "llm.activity",
                ts: Date.now(),
                payload: {
                  channel: input.channel,
                  threadKey: input.threadKey,
                  adapter: "claude",
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
        }
      }
    }
  }
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
      succeeded = false;
      activitySeq = 0;
      deltaStream.closeSegment(); // 세그먼트 버퍼 드레인(발행 안 함) — 실패한 첫 시도의 잔여
      // 텍스트가 fresh 세션의 첫 세그먼트로 새지 않게(activitySeq=0 리셋과 동형 취지).
      toolTiming.clear(); // 실행시간(#3) 매핑도 리셋 — fresh 세션엔 이전 tool_use id 안 옴.
      // 서브에이전트 관측 리셋 — 첫 시도서 등록된 Task 잡을 닫고(고아 running 방지) 매핑
      // 초기화. fresh 세션엔 그 Task id 가 안 오므로 tool_result 로 닫힐 길 없음 → 여기서
      // markFailed 로 명시 종료(best-effort). taskJobs.clear() 로 재실행 매핑 청결.
      for (const entry of taskJobs.values()) {
        try {
          markFailed(entry.jobId, "resume 폴백 재실행으로 서브에이전트 관측 중단");
        } catch {
          /* 마킹 실패 무해. */
        }
      }
      taskJobs.clear();
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
    const reason = effectiveAc.signal.reason;
    if (
      effectiveAc.signal.aborted &&
      (reason instanceof IdleTimeoutError || reason instanceof TurnTimeoutError)
    ) {
      throw reason;
    }
    throw e;
  }
  } // for(;;) — resume 폴백 재시도 루프
  } finally {
    // 타이머 누수 0 (I-6) — 성공·throw·abort 모든 경로에서 해제.
    idleTimer.done();
    // 델타 잔여 flush(꼬리 유실 0) + coalesce 타이머 정리. best-effort — 실패해도
    // out 전체본이 권위 교체(자가치유). 성공·throw·abort 모든 경로에서 1회.
    deltaStream.flush();
    // 트레일링 텍스트 세그먼트 닫기(2026-07-13 인터리브) — 마지막 도구 이후(또는 도구가
    // 전혀 없었던) 턴 종료 시점까지 누적된 텍스트를 kind:"text" 로 발행. flush() 다음(델타
    // 코얼레스 버퍼와 무관한 별개 버퍼) — 순서·타이밍 상관없이 항상 이 자리 1회.
    closeTextSegment();
    // 서브에이전트 관측 고아 정리 — 턴 종료(성공·throw·abort)까지 tool_result 로 안 닫힌
    // Task 잡(SDK abort·에러로 서브 미완, 또는 완료 메시지 유실)을 running 고아로 남기지
    // 않는다. 정상 완료는 completeTaskJob 이 이미 delete 했으므로 여기 남은 건 미완만 →
    // markFailed 로 명시 종료(대시보드 카드가 running 에 영영 머물지 않게). best-effort.
    for (const entry of taskJobs.values()) {
      try {
        markFailed(entry.jobId, "턴 종료까지 서브에이전트 완료 신호 미도착");
      } catch {
        /* 마킹 실패 무해 — 데몬 생존 우선(원칙 3). */
      }
    }
    taskJobs.clear();
  }

  // 유휴/턴 abort 의 "조용한 종결" 승격 (§2.2) — SDK 가 abort 시 throw 없이 for-await 를
  // 조용히 끝낼 수 있다. 그 경우 succeeded=false 로 떨어져 facade 가 실패를 못 본다.
  // reason 이 Idle/TurnTimeoutError 면 명시 throw 로 승격 (둘 다 비매칭 — facade 무폴백).
  {
    const reason = effectiveAc.signal.reason;
    if (
      effectiveAc.signal.aborted &&
      (reason instanceof IdleTimeoutError || reason instanceof TurnTimeoutError)
    ) {
      throw reason;
    }
  }

  const text = resultText ?? assistantTextChunks.join("");
  const effectiveSuccess = succeeded || text.length > 0;
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
