/**
 * 영역 A 세 번째 어댑터 — OpenAI Agents SDK 위임 (production). 정품 OpenAI 와
 * **OpenAI-compat 로컬/원격**(ollama·google gemini)을 단일 어댑터로 서빙한다 —
 * provider id → 이 어댑터(다대일). baseURL/apiKey 는 `resolveProviderConn` 단일
 * 지점 해석(어댑터별 if 분기 0). facade dispatch 는 `llm-runtime/index.ts` 가 이미 배선.
 *
 * 계보: V3 spike(hello world)에서 출발 → 2026-06-15 이후 codex/claude 와 *동형 규칙*
 * 으로 production 능력을 배선. 현재 구현된 parity(claude/codex 와 동일 의미):
 *  - 인격(공유 sysprompt) · SYSTEM.md/AGENT.md prepend · 자동 메모리(memoryMcpServer
 *    +retrieveContext) · `.claude` 자동발견(skills/agents) · 전 capability 도구
 *    (file-ops·todo·skills·agents·workers·endpoints·commands·update-self·send-file·
 *    prompt-options·reply-intent, depth/workerDepth 게이트 동형) · extraMcpServers.
 *  - 세션 연속성: ChatCompletions(ollama/gemini)는 Responses 의 previous_response_id
 *    미지원 → loadThreadHistory 로 prior turn 을 명시 주입(cross-adapter 연속성, 정답).
 *  - 토큰 스트리밍(llm.delta) + idle/turn 타임아웃 + abort 전파.
 *  - **per-tool activity(llm.activity kind="tool")** — run_item_stream_event 소비,
 *    detail 은 codex 와 동일 빌더(아래 run 루프).
 *
 * 후속(별건, 실수요 시):
 *  - DISALLOWED_TOOLS 구조 parity — 현재 그 리스트가 빈 배열(β 무벽: 기술차단 안 박음,
 *    prompt 가드가 유일 방어)이라 claude 도 실효 0. 채워질 미래 대비 구조 nicety 뿐.
 *  - usage 추출은 graceful(SDK 가 노출하면 캡처, 없으면 "측정 전").
 *  - 라이브 e2e(실 ollama/gemini/openai 모델 end-to-end) 실측 — 코드 parity 는 완료.
 */
import { randomUUID } from "node:crypto";
import { Agent, run, OpenAIProvider } from "@openai/agents";
import type { MCPServer, AgentInputItem } from "@openai/agents-core";
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
} from "../../prompt-assembly.js";
import { createMemoryMcpServer } from "../../memory-mcp.js";
import { retrieveContext } from "../../memory.js";
import { loadThreadHistory } from "../../../store/memory.js";
import { getEventBus } from "../../eventbus.js";
import { getPaths } from "../../paths.js";
import { resolveProviderConn } from "../provider-registry.js";
import { createFileOpsMcpServer } from "../capabilities/file-ops-mcp.js";
import { createTodoMcpServer } from "../capabilities/todo-mcp.js";
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
import { createWorkerMcpServer } from "../capabilities/worker-registry.js";
import { createEndpointToolsMcpServer } from "../capabilities/endpoint-tools-mcp.js";
import { createCommandToolsMcpServer } from "../capabilities/command-tools-mcp.js";
import { createUpdateSelfMcpServer } from "../capabilities/update-self-mcp.js";
import { notifyDestFromCoords } from "../../self-update.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../capabilities/prompt-options-mcp.js";
import { createProjectRegistryMcpServer } from "../capabilities/project-registry.js";
import { adaptClaudeMcpServer } from "./_mcp-bridge.js";
import { buildActivityDetailFromJson } from "./_activity-detail.js";
import { createDeltaStream } from "./_delta-stream.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
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
        await adaptClaudeMcpServer(createMemoryMcpServer(), "memory"),
        await adaptClaudeMcpServer(createFileOpsMcpServer(), "file-ops"),
        await adaptClaudeMcpServer(createTodoMcpServer(), "todo"),
        await adaptClaudeMcpServer(createProjectRegistryMcpServer(), "projects"),
        await adaptClaudeMcpServer(
          createSkillInvokeMcpServer(discoveryCwd, {
            channel: input.channel,
            threadKey: input.threadKey,
            adapter: "openai",
          }),
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

  // prompt-options(축1, 2026-06-25) — 객관식 선택지 제시. 채널 렌더 클로저가 있을 때만
  // 등록 (claude 조건부 주입과 parity). per-turn dedup Set(클로저 지역) → 같은 질문
  // 재호출 멱등. lean(none) 은 생략. 한쪽만 등록 = #2 차단이라 send-file 과 1:1 동형.
  if (!toolsNone && input.presentOptions !== undefined) {
    const askedQuestions = new Set<string>();
    mcpServers.push(
      await adaptClaudeMcpServer(
        createPromptOptionsMcpServer(input.presentOptions, askedQuestions),
        "prompt-options",
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

  // 백그라운드 워커 발사 도구 (2026-06-17) — run_in_background/list_workers.
  // depth 0 + workerDepth 0 turn 만 등록 → 워커가 또 워커 발사 불가(W-I5). lean(none)
  // 은 미등록(toolsNone). codex/claude 와 동일 의미(W-I3 — 어댑터 분기 0).
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(createWorkerMcpServer(input), "workers"),
    );
  }

  // 커스텀 HTTP 엔드포인트 등록/조회/삭제 도구 (2026-06-18) — register_endpoint/
  // list_endpoints/delete_endpoint. worker 와 *동일* 가드(!toolsNone && depth 0 &&
  // workerDepth 0). lean(none = restricted 엔드포인트 턴)이면 미등록 → 엔드포인트가
  // 또 엔드포인트를 만드는 재귀 자연 차단. claude/codex 와 동일 의미(어댑터 분기 0).
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(createEndpointToolsMcpServer(), "endpoints"),
    );
  }

  // 커스텀 슬래시 명령 등록/조회/삭제 도구 (2026-06-18) — register_command/
  // list_commands/delete_command. endpoint/worker 와 *동일* 가드(!toolsNone && depth 0
  // && workerDepth 0). lean(none) 이면 미등록. claude/codex 와 동일 의미(어댑터 분기 0).
  // 슬래시 명령은 항상 prompt 라 mode 무관.
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(createCommandToolsMcpServer(), "commands"),
    );
  }

  // 자가 업데이트 도구 (2026-06-26) — update_self. command-tools 와 *동일* 가드
  // (depth 0 + workerDepth 0) — 워커/서브에이전트가 자가 업데이트 트리거 불가(재귀 차단).
  // 위험 로직 0(전부 runSelfUpdate). notify 좌표는 현재 turn 의 channel/threadKey 에서
  // 도출 — 재시작 후 부팅이 요청자에게 "완료" 회신. claude/codex 와 parity(#2).
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(
        createUpdateSelfMcpServer(
          notifyDestFromCoords(input.channel, input.threadKey),
        ),
        "update-self",
      ),
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

  const systemContextParts = buildSystemContextParts({
    system,
    agent: agentBody,
    agentWarn,
    convoContext,
    memoryIndex,
    memorySnippet,
    skillIndex,
    agentIndex,
  });
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

  // llm.activity — per-tool (kind="tool"), claude/codex 와 동형. SDK 스트림의
  // `run_item_stream_event`(name="tool_called")가 도구 경계를 노출하므로(이전 spike
  // 헤더의 "run() 이 도구 경계 노출 안 함" 은 비스트림 가정의 잔재 — stream 오버로드는
  // 노출한다) 도구 호출당 1 activity 를 아래 run 루프에서 발행한다. 도구 0개 turn 은
  // 0 발행(claude/codex 와 동일 — 옛 coarse "turn" floor 폐기). seq = 어댑터 로컬
  // 단조(0,1,2…, run() 호출 내 누적, nonce 아님). detail 은 codex 와 *동일 빌더*
  // (buildActivityDetailFromJson — 양쪽 다 arguments=JSON 문자열 → parity DRY 강제).
  const bus = getEventBus();
  let activitySeq = 0;

  // 유휴 타임아웃 (G1 — 비스트림→스트림 전환). 현재 비스트림 run() 은 heartbeat 원천이
  // 0 이라 유휴 감지 불가 = 층1 parity 깨짐. SDK 동일 `run` 의 stream 오버로드로 전환
  // (재구현 0). 각 스트림 이벤트 = heartbeat → idle 타이머 reset. abort 시 signal 전파.
  // finalOutput·context.usage 출력 계약은 StreamedRunResult 에도 동일 형상으로 존재 →
  // 회귀 0 (아래 text/usage 추출 무변경).
  // 전 턴(메인·서브에이전트·워커) 1층 idle/first 면제 — 진행 중 작업(긴 도구 실행 등
  // 무이벤트 구간)을 임의 시간으로 컷하지 않는다(사용자 A안, 2026-06-24). hung 회복은
  // 워커 2층 WORKER_TIMEOUT_MS + /restart·cancel·외부 turn signal 이 담당. idleConfigExempt.
  const idleAc = new AbortController();
  const idleTimer = createIdleTimer(
    idleAc,
    idleConfigExempt(input.workerDepth, IDLE_TIMEOUT_CONFIG),
  );
  // 2층 합성 (TT-I2) — 1층 idle AC 와 핸들러 turn signal 을 OR 결합. effectiveAc.signal
  // 을 run() 에 주입하면 @openai/agents 가 전체 run 루프(LLM 호출 + listTools/callTool)에
  // 적용한다 (SharedRunOptions.signal). input.abortSignal 미지정이면 idleAc 만 → 현행(TT-I7).
  const effectiveAc = linkAbort(idleAc.signal, input.abortSignal);

  // llm.delta — 토큰 스트리밍 fan-out(보조 점증 렌더). depth-0 가드: 메인 답변만 발행
  // (서브에이전트/워커 depth>0 turn 은 out 도 안 내므로 화면 버블 대상 아님 = no-op).
  // SDK 가 OpenAI Responses·Chat Completions(openai/google/ollama)를 동일 RunStreamEvent
  // 로 정규화 → 단일 fan-out 지점 1개로 풀의 3 provider 전부 커버(어댑터 내 provider 분기 0).
  const deltaStream = createDeltaStream({
    enabled: depth === 0 && (input.workerDepth ?? 0) === 0,
    channel: input.channel,
    threadKey: input.threadKey,
    adapter: "openai",
    model,
  });

  // bridge close (in-memory transport 정리) — codex finally 패턴 답습. run() 동안
  // mcpServers 가 listTools/callTool 을 lazy connect 하므로, 응답 후 일괄 close.
  // 실패해도 응답 흐름 영향 0(개별 try/catch).
  const runOnce = async () => {
    try {
      const streamed = await run(agent, runInput, {
        stream: true,
        signal: effectiveAc.signal,
      });
      // 스트림 이벤트 소비 — heartbeat + llm.delta fan-out. raw text delta 면 증분 push,
      // 그 외 이벤트는 도착 사실만 heartbeat(활동 세분화는 별건). SDK 가 provider 무관
      // 정규화한 `raw_model_stream_event → output_text_delta` 가 증분 텍스트 소스.
      for await (const ev of streamed) {
        idleTimer.beat();
        // 안전 narrowing — SDK union 형상이 바뀌어도 turn 안 깨지게 방어적 접근.
        if (ev.type === "raw_model_stream_event") {
          const data = (ev as { data?: unknown }).data as
            | { type?: unknown; delta?: unknown }
            | undefined;
          if (
            data?.type === "output_text_delta" &&
            typeof data.delta === "string"
          ) {
            deltaStream.push(data.delta); // coalesce → publish (순수 텍스트 증분).
          }
        } else if (
          ev.type === "run_item_stream_event" &&
          (ev as { name?: unknown }).name === "tool_called"
        ) {
          // per-tool activity — 모델이 도구를 호출하려는 순간(codex "의도 시점"과
          // 동일 의미: 실행 성공/실패 무관). rawItem.arguments(JSON 문자열) → codex
          // 와 *동일* 빌더로 중립 detail(축3 사이드바). MCP 브리지 도구도 SDK 가
          // function_call 로 노출 → 동일 경로. 방어적 narrowing(union 변동에도 불괴).
          const raw = (ev as { item?: { rawItem?: unknown } }).item?.rawItem as
            | { type?: unknown; name?: unknown; arguments?: unknown }
            | undefined;
          if (raw?.type === "function_call" && typeof raw.name === "string") {
            bus.publish({
              type: "llm.activity",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "openai",
                model,
                seq: activitySeq++,
                kind: "tool",
                label: raw.name || "tool",
                detail:
                  typeof raw.arguments === "string"
                    ? buildActivityDetailFromJson(raw.arguments)
                    : undefined,
              } satisfies RegionAActivityPayload,
            });
          }
        }
      }
      // 정리 보장 — 스트림 완료까지 대기 후 finalOutput/usage 가 확정됨.
      await streamed.completed;
      return streamed;
    } catch (e) {
      // abort 가 1층(유휴)·2층(턴) 타임아웃이면 해당 에러로 승격 (facade 일관 신호,
      // 둘 다 비매칭 — I-3/TT-I3). reason 은 linkAbort 가 effectiveAc 로 보존.
      const reason = effectiveAc.signal.reason;
      if (
        effectiveAc.signal.aborted &&
        (reason instanceof IdleTimeoutError ||
          reason instanceof TurnTimeoutError)
      ) {
        throw reason;
      }
      throw e;
    } finally {
      idleTimer.done(); // 누수 0 (I-6).
      // 델타 잔여 flush(꼬리 유실 0) + coalesce 타이머 정리. best-effort — 실패해도
      // out 전체본이 권위 교체(자가치유). 성공·throw·abort 모든 경로에서 1회.
      deltaStream.flush();
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
