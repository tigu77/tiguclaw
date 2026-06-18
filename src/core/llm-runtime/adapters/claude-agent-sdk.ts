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
import { getSession } from "../../../store/sessions.js";
import { getPaths } from "../../paths.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import { DISALLOWED_TOOLS } from "../../../auth/permissions.js";
import { getEventBus } from "../../eventbus.js";
import {
  agentPathHint,
  agentSizeWarning,
  assembleUserPrompt,
  formatAttachments,
  formatConversationContext,
  formatMemoryIndex,
  formatMemorySnippet,
  memoryMcpServer,
  readAgent,
  readSystem,
  resolveJsonlPath,
  retrieveContext,
} from "../../memory.js";
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
  type Agent,
} from "../capabilities/agent-registry.js";
import { createWorkerMcpServer } from "../capabilities/worker-registry.js";
import { createEndpointToolsMcpServer } from "../capabilities/endpoint-tools-mcp.js";
import { createCommandToolsMcpServer } from "../capabilities/command-tools-mcp.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import {
  createIdleTimer,
  IdleTimeoutError,
  IDLE_TIMEOUT_CONFIG,
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

  const prior = getSession(input.channel, input.threadKey);
  const resumable =
    prior !== undefined && prior.systemPromptHash === SYSTEM_PROMPT_HASH;

  // (C) 하이브리드 — cross-adapter foreign(codex) delta 산출.
  //  - resumable: resume 이 claude 자기 turn 을 재생 → 그 이후의 foreign turn 만 delta.
  //  - resume 불가(hash stale 등): resume 없이 thread 전체를 prepend = (A) 자연 폴백
  //    (claudeOwnTurns 가 비어 computeForeignDelta 가 thread 전체 반환).
  // 연속 claude turn(foreign 없음) → delta 0 → 현행 resume 그대로(회귀 0).
  let foreignDeltaBlock = "";
  if (prior !== undefined) {
    const threadTurns = loadThreadHistory(input.channel, input.threadKey);
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
        memory: memoryMcpServer,
        // invoke_skill 실행 경로 (모든 소스 — home/project/plugin). 격리 모드라
        // .claude/skills 자동발견 0 → 이 in-process MCP 가 유일 실행 경로. cwd 는
        // 위 options.cwd·아래 스킬 인덱스(discoverSkills)와 동일 소스 → 인덱스↔invoke 정합.
        skills: createSkillInvokeMcpServer(cwd),
        // reply-intent — 이 turn 응답을 트리거 메시지 직접 답글로 마킹 (codex 와 parity).
        "reply-intent": replyIntentServer,
        // send-file — 네이티브 멱등 아웃바운드 전송. 채널 전송 클로저가 있을 때만 등록
        // (스케줄러 등 비채널 turn 은 미등록 = 도구 노출 0). codex 와 parity.
        ...(input.sendAttachment !== undefined
          ? { "send-file": createSendFileMcpServer(input.sendAttachment, sentFiles) }
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
        // 커스텀 슬래시 명령 등록/조회/삭제 도구 (2026-06-18) —
        // register_command/list_commands/delete_command. endpoint/worker 와 *동일* 가드
        // (depth 0 + workerDepth 0). lean(toolsNone) 이면 leanMcpServers={} 라 미등록.
        // LLM-agnostic(어댑터 분기 0). 슬래시 명령은 항상 prompt 라 mode 무관.
        ...(depth === 0 && (input.workerDepth ?? 0) === 0
          ? { commands: createCommandToolsMcpServer() }
          : {}),
        ...(input.extraMcpServers ?? {}),
      };

  // 유휴 타임아웃 — SDK `Options.abortController` 경로 (runtimeTypes.d.ts:234,
  // "stop and clean up resources"). idle/first 만료 시 헬퍼가 ac.abort(IdleTimeoutError).
  // heartbeat = for-await msg 도착마다. timer.done() = finally (누수 0, I-6).
  const idleAc = new AbortController();
  const idleTimer = createIdleTimer(idleAc, IDLE_TIMEOUT_CONFIG);
  // 2층 합성 (TT-I2) — 1층 idle AC 와 핸들러 turn signal 을 OR 결합. idleTimer 는
  // 여전히 *원래 idleAc* 를 abort 하고, linkAbort 가 그걸 effectiveAc 로 전파한다
  // (결선 순서: idleAc abort → effectiveAc abort). SDK 는 signal 이 아닌
  // AbortController 객체를 받으므로 effectiveAc 를 그대로 abortController 로 넘긴다.
  // SDK 가 LLM+도구 실행을 같은 abortController 로 정리(runtimeTypes.d.ts:234).
  // input.abortSignal 미지정이면 link 는 idleAc 만 → 현행 1층 동작 그대로(TT-I7).
  const effectiveAc = linkAbort(idleAc.signal, input.abortSignal);

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    permissionMode: "bypassPermissions",
    abortController: effectiveAc,
    disallowedTools: [...DISALLOWED_TOOLS],
    persistSession: true,
    cwd,
    // lean(toolsNone) child 는 SDK 빌트인 도구도 0 (`tools: []` = disable all built-ins).
    ...(toolsNone ? { tools: [] as string[] } : {}),
    // facade 가 provider:model 에서 추출해 주입. 미지정 시 SDK 디폴트.
    ...(input.model !== undefined ? { model: input.model } : {}),
    mcpServers: leanMcpServers,
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
        retrieveContext(input.channel, input.threadKey, input.text, {
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

  // 현재 대화 컨텍스트 — 비서가 dest_channel/dest_target 을 정확히 알게.
  const convoContext = formatConversationContext(
    input.channel,
    input.threadKey,
  );

  // 멀티모달 V1 — 현재 turn 첨부 placeholder (경로+메타). 미지정/빈 배열 → "" (회귀 0).
  const attachmentBlock = formatAttachments(input.attachments);

  // SYSTEM.md(작동 헌법) — 매 turn 최상단 (on-demand Read 아님, 2026-05-27). codex parity.
  const system = readSystem();
  // 시스템 컨텍스트(매 turn 주입 스캐폴딩) ↔ 사용자 turn 분리 (2026-05-28 딴소리 fix).
  //  스캐폴딩 = SYSTEM.md·AGENT.md·hint·대화컨텍스트·foreign delta·메모리·스킬·에이전트.
  //  사용자 turn = 첨부 블록 + 실제 입력 텍스트 (구분선으로 명시 분리 — assembleUserPrompt).
  const systemContextParts = [
    system,
    agent,
    agentWarn,
    agentPathHint(),
    convoContext,
    foreignDeltaBlock, // (C) cross-adapter — foreign(codex) delta (resume 못 보는 turn).
    memoryIndex,
    memorySnippet,
    skillIndex,
    agentIndex,
  ];
  const userTurnParts = [attachmentBlock, input.text];
  const promptWithMemory = assembleUserPrompt(systemContextParts, userTurnParts);

  // resume 세션 부재/손상은 SDK 가 "process exited with code 1" 로 종료시킨다 →
  // resume 없이 fresh 세션으로 1회 graceful 폴백 (본질 수정: 마이그레이션·세션 만료·
  // cwd 변경에도 턴이 안 죽게). model 거부는 별도 표면(is_error throw)이라 무간섭.
  const isResumeProcessFailure = (e: unknown): boolean =>
    e instanceof Error && /process exited with code 1/i.test(e.message);
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
  // region.a.activity — 어댑터 로컬 단조 시퀀스 (turn 시작 0, publish 마다 +1). nonce 아님.
  let activitySeq = 0;

  const bus = getEventBus();

  try {
  for (;;) {
  try {
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    // 유휴 타임아웃 heartbeat — 매 SDK message 도착 = 살아있음 신호. 타이머 reset.
    idleTimer.beat();
    // 관측 publish — for-await 흐름 영향 0 (publish 동기 + EventBus 격리).
    // payload 핵심 필드만, 큰 객체는 truncate.
    bus.publish({
      type: "region.a.sdk_message",
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
      if (typeof msg.model === "string") lastModel = msg.model;
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
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "text"
          ) {
            const t = (block as { text?: unknown }).text;
            if (typeof t === "string") assistantTextChunks.push(t);
          } else if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "tool_use"
          ) {
            // region.a.activity — 도구당 1 activity (sdk_message firehose 와 별개 레이어).
            bus.publish({
              type: "region.a.activity",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "claude",
                model: lastModel ?? undefined,
                seq: activitySeq++,
                kind: "tool",
                label: String((block as { name?: unknown }).name ?? "tool"),
              } satisfies RegionAActivityPayload,
            });
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
      const freshOptions: Options = { ...options };
      delete (freshOptions as { resume?: unknown }).resume;
      q = buildQuery(freshOptions);
      continue; // resume 없이 재실행.
    }
    // SDK 가 abort 시 throw 하는 경우(AbortError 등) — 1층(유휴) 또는 2층(턴) 타임아웃이
    // 원인이면 해당 에러로 승격해 facade 가 일관된 타임아웃 신호를 받게 한다(둘 다
    // isModelRejected 비매칭 — I-3/TT-I3). reason 은 linkAbort 가 effectiveAc 로 보존.
    // 그 외 에러는 그대로 전파.
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
