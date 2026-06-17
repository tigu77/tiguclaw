/**
 * 영역 A 두 번째 어댑터 — OpenAI Agents SDK 위임 (V3 spike).
 *
 * 진실 소스: `_workspace/region_a_v3_openai_architect_contract.md` §5.
 *
 * 본 라운드 = spike (production 통합 아님). hello world 1 케이스 라이브 + 능력 매트릭스
 * 정적 평가 산출이 본 어댑터의 V3 책임. V5+ production 진입 시 facade 가 env 기반
 * 어댑터 dispatch.
 *
 * V3 미구현 (TODO, V5+):
 *  - extraMcpServers 처리 — MCP 시나리오 (i) 호환 판정 (Workstream A spike). 변환 어댑터 V5.
 *  - 자동 메모리 (AGENT.md prepend, memoryMcpServer) — adapter 안쪽 동등 패턴 가능.
 *  - session resume — OpenAI Responses API previous_response_id 검증 필요.
 *  - stream fan-out (EventBus publish) — `run(... { stream: true })` 검토.
 *  - permission 게이트 (DISALLOWED_TOOLS 매핑) — OpenAI tool 차단 메커니즘 평가.
 *  - 자동 발견 (.claude/) — adapter 안쪽 자체 구현 필요 (능력 매트릭스 부분/대안).
 */
import { randomUUID } from "node:crypto";
import { Agent, run, OpenAIProvider } from "@openai/agents";
import type { MCPServer, AgentInputItem } from "@openai/agents-core";
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
  retrieveContext,
} from "../../memory.js";
import { loadThreadHistory } from "../../../store/memory.js";
import { getEventBus } from "../../eventbus.js";
import { getPaths } from "../../paths.js";
import { resolveProviderConn } from "../provider-registry.js";
import { fileOpsMcpServer } from "../capabilities/file-ops-mcp.js";
import { todoMcpServer } from "../capabilities/todo-mcp.js";
import {
  createSkillInvokeMcpServer,
  discoverSkills,
  formatSkillIndex,
} from "../capabilities/skill-registry.js";
import {
  createSpawnAgentMcpServer,
  discoverAgents,
  formatAgentIndex,
} from "../capabilities/agent-registry.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import { adaptClaudeMcpServer } from "./_mcp-bridge.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import {
  createIdleTimer,
  IdleTimeoutError,
  IDLE_TIMEOUT_CONFIG,
} from "../idle-timeout.js";
import type {
  RegionAActivityPayload,
  RegionASdkInput,
  RegionASdkOutput,
} from "../types.js";

export const runOpenAi = async (
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
  // provider 연결 해석 — input.provider 미지정(레거시 호출)이면 정품 openai 로 폴백.
  // ollama/google 은 baseURL/apiKey 가 여기서 단일 지점 해석된다(어댑터별 if 분기 0).
  const conn = resolveProviderConn(input.provider) ?? resolveProviderConn("openai")!;

  // 인증 가드 — provider conn 기반(기존 OPENAI_API_KEY 직접 throw 완화).
  // ollama 는 apiKeyFallback("ollama") 덕에 항상 통과. 정품 openai/google 은 키 필요.
  if (conn.apiKey === undefined || conn.apiKey === "") {
    throw new Error(
      `'${input.provider ?? "openai"}' 인증 없음. ${conn.apiKeyEnv} 가 필요합니다.`,
    );
  }

  // V3 spike = hello world. instructions·tools·MCP·session resume·자동 메모리 모두 V5+.
  // model 우선순위: facade 주입(input.model) > env > 디폴트.
  const model = input.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  // baseURL 지정(ollama/google 등 compat) → OpenAIProvider 로 Model 인스턴스 생성 후 주입.
  //  - 동시성 안전: provider/Model 이 호출 스코프 지역 변수(전역 setDefaultOpenAIClient 금지).
  //  - Chat Completions 강제(useResponses:false): Ollama/Gemini 가 OpenAI Responses API
  //    미지원 → compat 안전 경로. provider 가 baseURL/apiKey 로 OpenAI 클라이언트를 내부 생성
  //    (cross-package OpenAI 타입 동일성 충돌 회피 — node_modules 실측 반영. §2 경로 B 동치).
  //  - Model 인스턴스를 Agent.model 에 주입하므로 전역 run() 그대로 사용(현행 흐름 보존).
  // baseURL 미지정(정품 openai) → 현행 string model 유지(Responses 경로·회귀 0).
  const modelArg =
    conn.baseURL === undefined
      ? model
      : await new OpenAIProvider({
          apiKey: conn.apiKey,
          baseURL: conn.baseURL,
          useResponses: false,
        }).getModel(model);

  // 2b (2026-06-15) — 도구 능력 parity (층 1). codex 어댑터가 depth 0 turn 에 등록하는
  // 도구 세트와 *동일 능력*을 등록한다. 분기 A(직접 주입): 기존 capability 팩토리 +
  // `_mcp-bridge.ts` 가 만든 `MCPServer` 인스턴스를 `Agent.mcpServers` 에 그대로 주입.
  //  - 핸들러 로직 단일 소스: codex/claude 와 동일 팩토리·동일 bridge 재사용(재구현 0).
  //  - agents SDK 가 run() 루프에서 listTools/callTool 을 자동 구동(codex 의 수동 raw-fetch
  //    agentic loop 재현 불필요) — getMcpToolsFromServer 가 listTools 직접 호출,
  //    bridge listTools 는 lazy 자동 connect(_mcp-bridge.ts ensureConnected).
  //  - 어댑터별 특수 분기 0: depth 가드·sendAttachment 조건부·extraMcpServers 는 codex
  //    (openai-codex-oauth.ts L820~953)와 *동일 규칙* 답습.
  // discoveryCwd — 스킬/스폰 발견 cwd. codex 답습(input.cwd ?? home). β: home 폴백.
  const discoveryCwd = input.cwd ?? getPaths().home;
  const depth = input.subagentDepth ?? 0;

  // lean 도구 정책 (2026-06-15, architect §2a I-2). 중립 신호 toolPolicy 를 *이 어댑터의
  // 도구 집합*(MCP 서버들)에서 해석한다 — 도구명 매핑은 어댑터 안(추상 누수 0, I-3).
  //  - {mode:"none"}: capability/spawn/extra 서버 0개 등록 → 도구 없는 lean child.
  //    (= 로컬 nano 가 실제 타는 경로. 도구 미지원 모델 graceful 도 자연 해결.)
  //  - {mode:"allow"}: 정밀 allowlist 필터는 후속(YAGNI §2a). 안전 degrade = 전체 유지.
  //  - undefined: 현행 전체 도구 (회귀 0).
  // codex/claude 와 *동형 규칙* — 한쪽만 적용 시 미완성(I-2).
  const toolsNone = input.toolPolicy?.mode === "none";

  // reply-intent — 무인자 도구 호출 시 클로저로 플래그 set (turn 별 격리, 함수 지역).
  let replyToTrigger = false;

  const mcpServers: MCPServer[] = toolsNone
    ? []
    : [
        await adaptClaudeMcpServer(memoryMcpServer, "memory"),
        await adaptClaudeMcpServer(fileOpsMcpServer, "file-ops"),
        await adaptClaudeMcpServer(todoMcpServer, "todo"),
        await adaptClaudeMcpServer(
          createSkillInvokeMcpServer(discoveryCwd),
          "skills",
        ),
        await adaptClaudeMcpServer(
          createReplyIntentMcpServer(() => {
            replyToTrigger = true;
          }),
          "reply-intent",
        ),
      ];

  // send-file — 채널 전송 클로저가 있을 때만 등록 (codex/claude 조건부 주입과 parity).
  // per-turn dedup Set(클로저 지역) → 같은 경로 재호출 멱등. lean(none) 은 전부 생략.
  if (!toolsNone && input.sendAttachment !== undefined) {
    const sentFiles = new Set<string>();
    mcpServers.push(
      await adaptClaudeMcpServer(
        createSendFileMcpServer(input.sendAttachment, sentFiles),
        "send-file",
      ),
    );
  }

  // spawn_agent — depth 0 turn 만 등록(child depth≥1 미등록 → 재spawn 물리 차단).
  // codex L932-940 답습. runner 인자 주입(circular 회피)은 팩토리 내부 처리.
  if (!toolsNone && depth === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(createSpawnAgentMcpServer(input), "agents"),
    );
  }

  // extraMcpServers — router 가 facade 통해 전달하는 plugin MCP(scheduler add_schedule 등).
  // codex L946-953 / claude mcpServers spread 와 동등(LLM-agnostic parity). lean 은 생략.
  if (!toolsNone) {
    for (const [name, server] of Object.entries(input.extraMcpServers ?? {})) {
      mcpServers.push(await adaptClaudeMcpServer(server, name));
    }
  }

  // 2a (2026-06-15) — 인격(sysprompt) parity. 더미 instructions 폐기, 세 어댑터
  // 공유 작동헌법(`_shared-sysprompt.ts` REGION_A_SYSTEM_PROMPT)을 그대로 주입.
  //  - claude 어댑터: options.systemPrompt = SYSTEM_PROMPT (claude-agent-sdk.ts L283)
  //  - codex 어댑터: instructions = `${SYSTEM_PROMPT}\n${CODEX_PERSISTENCE_PROMPT}`
  //    (openai-codex-oauth.ts L1056, persistence 는 codex 전용 append)
  //  - openai 어댑터(본): instructions = SYSTEM_PROMPT (동일 소스, 어댑터 분기 0).
  // SYSTEM.md·AGENT.md 본문 user-prompt prepend·세션 연속성·메모리 본문 검색은 아래
  // 2c+2d 블록에서 codex 와 동일 함수로 배선 (sysprompt 는 정적 instructions 로 분리).
  const agent = new Agent({
    name: "tiguclaw-spike",
    instructions: SYSTEM_PROMPT,
    model: modelArg,
    mcpServers,
  });

  // 2c+2d (2026-06-15) — 세션 연속성 + 메모리/정체성 parity (층 1).
  // codex 어댑터(openai-codex-oauth.ts L785-841)와 *동일 조립 함수*를 그대로 배선:
  // 어댑터 무관 단일 소스(readSystem/readAgent/retrieveContext/...)로 user prompt prefix
  // 를 조립한다. openai 전용 조립 로직 신규 작성 0 — 차이는 "SDK 에 넘기는 형태"(아래
  // AgentInputItem[] 메시지 배열)뿐.
  //
  //   [SYSTEM.md body] + [AGENT.md body] + [AGENT warning] + [agentPathHint]
  //   + [conversation context] + [memory index] + [memory snippet] + [skill index]
  //   + [agent index]  → systemContextParts (system-reminder 스캐폴딩)
  //   [attachment block] + [user text]  → userTurnParts
  // (codex L829-841 의 순서·구성과 1:1. skillIndex/agentIndex 는 위에서 이미 계산됨.)
  const agentBody = readAgent();
  const agentWarn = agentSizeWarning(agentBody);
  // leanMemory (2026-06-15, architect §2c I-5) — lean child 는 메모리 스니펫·인덱스
  // prepend 를 생략(장기기억은 단순작업의 잡음). persona(SYSTEM.md/AGENT.md)는 불가침
  // (I-4) — 아래 systemContextParts 의 system/agentBody 는 그대로. codex/claude 동형(I-2).
  const leanMemory = input.leanMemory === true;
  const memoryIndex = leanMemory ? "" : formatMemoryIndex();
  const memorySnippet = leanMemory
    ? ""
    : formatMemorySnippet(
        retrieveContext(input.channel, input.threadKey, input.text, {
          limit: 5,
        }),
      );
  // 현재 대화 컨텍스트 — depth 0(실제 사용자 대화)만 (codex L814-818 parity).
  const convoContext =
    depth === 0
      ? formatConversationContext(input.channel, input.threadKey)
      : "";
  // 스킬/에이전트 인덱스 — depth 0 turn 만 (codex L805-813 parity). depth≥1 child 는
  // spawn 도구 미등록과 정합해 인덱스도 박지 않음 (재spawn 유도 0).
  const skills = await discoverSkills(discoveryCwd);
  const skillIndex = formatSkillIndex(skills);
  const agentIndex =
    depth === 0 ? formatAgentIndex(await discoverAgents(discoveryCwd)) : "";

  // SYSTEM.md(작동 헌법) — 매 turn 최상단 (codex/claude parity).
  const system = readSystem();
  // 멀티모달 V1 — 현재 turn 첨부 placeholder (경로+메타). 미지정/빈 배열 → "" (회귀 0).
  const attachmentBlock = formatAttachments(input.attachments);

  const systemContextParts = [
    system,
    agentBody,
    agentWarn,
    agentPathHint(),
    convoContext,
    memoryIndex,
    memorySnippet,
    skillIndex,
    agentIndex,
  ];
  const userTurnParts = [attachmentBlock, input.text];
  const promptWithMemory = assembleUserPrompt(systemContextParts, userTurnParts);

  // 2c 세션 연속성 — thread 단위 단일 소스(loadThreadHistory) 로 prior turn 들을 로드해
  // @openai/agents 입력 메시지 배열로 주입(node_modules run.d.ts L204: run(agent,
  // input: string | AgentInputItem[])). ChatCompletions 경로(로컬 ollama/google)는
  // Responses 전용 previousResponseId/session 미지원 → 명시적 히스토리 주입이 정답.
  //  - 데이터 소스는 codex/claude 와 동일(cross-adapter 연속성): 폴백으로 끼어든 다른
  //    어댑터 turn 도 같은 thread 타임라인에서 함께 회수된다.
  //  - 한도(turn/char)는 loadThreadHistory 내부 디폴트에 위임 — openai 전용 매직넘버 0.
  //  - wrap shape: user→input_text, assistant→output_text(+status:"completed")
  //    (protocol.d.ts UserMessageItem/AssistantMessageItem 실측).
  const priorTurns = loadThreadHistory(input.channel, input.threadKey);
  const historyItems: AgentInputItem[] = priorTurns.map((t) =>
    t.role === "assistant"
      ? {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: t.content }],
        }
      : {
          role: "user",
          content: [{ type: "input_text", text: t.content }],
        },
  );
  const currentTurn: AgentInputItem = {
    role: "user",
    content: [{ type: "input_text", text: promptWithMemory }],
  };
  // 첫 turn(히스토리 0) 이면 단일 user item — string 입력과 동치(회귀 0).
  const runInput: AgentInputItem[] = [...historyItems, currentTurn];

  // region.a.activity — coarse floor. run() 이 도구 경계를 외부 노출 안 해 per-tool
  // activity 불가(spike 한계) → run() 1회당 turn activity 1개로 parity 붕괴(0)만 회피.
  const bus = getEventBus();
  bus.publish({
    type: "region.a.activity",
    ts: Date.now(),
    payload: {
      channel: input.channel,
      threadKey: input.threadKey,
      adapter: "openai",
      model,
      seq: 0,
      kind: "turn",
      label: "실행",
    } satisfies RegionAActivityPayload,
  });

  // 유휴 타임아웃 (G1 — 비스트림→스트림 전환). 현재 비스트림 run() 은 heartbeat 원천이
  // 0 이라 유휴 감지 불가 = 층1 parity 깨짐. SDK 동일 `run` 의 stream 오버로드로 전환
  // (재구현 0). 각 스트림 이벤트 = heartbeat → idle 타이머 reset. abort 시 signal 전파.
  // finalOutput·context.usage 출력 계약은 StreamedRunResult 에도 동일 형상으로 존재 →
  // 회귀 0 (아래 text/usage 추출 무변경).
  const idleAc = new AbortController();
  const idleTimer = createIdleTimer(idleAc, IDLE_TIMEOUT_CONFIG);

  // bridge close (in-memory transport 정리) — codex finally 패턴 답습. run() 동안
  // mcpServers 가 listTools/callTool 을 lazy connect 하므로, 응답 후 일괄 close.
  // 실패해도 응답 흐름 영향 0(개별 try/catch).
  const runOnce = async () => {
    try {
      const streamed = await run(agent, runInput, {
        stream: true,
        signal: idleAc.signal,
      });
      // 스트림 이벤트 소비 — 내용 무시(도착 사실만 heartbeat). 활동 세분화는 별건.
      for await (const _ev of streamed) {
        idleTimer.beat();
      }
      // 정리 보장 — 스트림 완료까지 대기 후 finalOutput/usage 가 확정됨.
      await streamed.completed;
      return streamed;
    } catch (e) {
      // abort 가 유휴 타임아웃이면 IdleTimeoutError 로 승격 (facade 일관 신호, I-3 비매칭).
      if (idleAc.signal.aborted && idleAc.signal.reason instanceof IdleTimeoutError) {
        throw idleAc.signal.reason;
      }
      throw e;
    } finally {
      idleTimer.done(); // 누수 0 (I-6).
      for (const server of mcpServers) {
        try {
          await server.close();
        } catch {
          /* noop */
        }
      }
    }
  };
  const result = await runOnce();

  const text =
    typeof result.finalOutput === "string"
      ? result.finalOutput
      : JSON.stringify(result.finalOutput);

  // /status 개편 — usage graceful 추출 (이번 라운드 필수 아님). Agents SDK 가
  // result 에 usage 를 노출하면(통상 RunContext.usage = {inputTokens, outputTokens, ...})
  // 동일 형상으로 캡처, 없으면 미설정(정직 → /status "측정 전"). spike 어댑터라 SDK
  // 타입 미검증 → 런타임 가드 + 옵셔널 체이닝으로 안전 추출(타입 결합 0).
  const rawUsage = (result as { context?: { usage?: unknown } }).context?.usage;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  if (rawUsage !== null && typeof rawUsage === "object") {
    const u = rawUsage as { inputTokens?: unknown; outputTokens?: unknown };
    if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
      usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    }
  }

  // V5 — 자체 sessionId 생성. session resume(previous_response_id)·메모리 통합은 후속.
  // replyToTrigger — reply-intent 도구 호출 시 set (codex/claude 와 동일 출력 필드).
  return {
    text,
    sessionId: `openai-${randomUUID()}`,
    model,
    replyToTrigger,
    usage,
  };
};
