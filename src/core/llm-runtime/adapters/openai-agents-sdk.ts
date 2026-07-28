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
import fs from "node:fs/promises";
import { Agent, run, tool, OpenAIProvider } from "@openai/agents";
import type {
  MCPServer,
  AgentInputItem,
  CallModelInputFilterArgs,
  ModelInputData,
} from "@openai/agents-core";
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
import { retrieveContext } from "../../memory.js";
import { stripInternalRuntimeScaffolding } from "../../outbound-sanitize.js";
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
import { createMcpAdminMcpServer } from "../capabilities/mcp-admin-mcp.js";
import { getConnectedExternalMcpBridges, isProjectMcpCwd } from "../../external-mcp.js";
import { createCommandToolsMcpServer } from "../capabilities/command-tools-mcp.js";
import { createUpdateSelfMcpServer } from "../capabilities/update-self-mcp.js";
import { createMaintenanceMcpServer } from "../capabilities/maintenance-mcp.js";
import { notifyDestFromCoords } from "../../self-update.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../capabilities/prompt-options-mcp.js";
import { createProjectRegistryMcpServer } from "../capabilities/project-registry.js";
import { createFindCapabilitiesMcpServer } from "../capabilities/find-capabilities-mcp.js";
import { adaptClaudeMcpServer } from "./_mcp-bridge.js";
import { buildActivityDetailFromJson } from "./_activity-detail.js";
import { buildActivityDiffFromJson } from "./_activity-diff.js";
import { buildActivityOutput } from "./_activity-output.js";
import { createDeltaStream } from "./_delta-stream.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import {
  createIdleTimer,
  IdleTimeoutError,
  IDLE_TIMEOUT_CONFIG,
  idleConfigExempt,
} from "../idle-timeout.js";
import { linkAbort, TurnTimeoutError } from "../turn-timeout.js";
import { watchToolStart } from "../tool-watchdog.js";
import { JOB_OWNING_TOOL_CALL_TIMEOUT_MS } from "../../worker-jobs.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  formatToolBlock,
} from "../../entry/hook-runner.js";
import type { SteeringInput } from "../../steering.js";
import type {
  RegionAActivityPayload,
  RegionASdkInput,
  RegionASdkOutput,
  RegionAToolCallDeltaPayload,
} from "../types.js";

// 멀티모달 (2026-07-10) — 현재 turn 이미지 첨부를 SDK `input_image` content 로 주입. @openai/agents
// 가 OpenAI(Responses) native + ChatCompletions(gemini/ollama)는 openaiChatCompletionsConverter 로
// `image_url` 로 자동 번역(node_modules 실측). codex 어댑터 buildMediaContentItems 의 agents-SDK 대응.
// ★과거 turn 은 텍스트로만 재구성(loadThreadHistory) → 이미지 재주입 0 = claude 식 오염 없음.
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
type SdkImageItem = { type: "input_image"; image: string };
const buildImageContentItems = async (
  attachments: RegionASdkInput["attachments"],
): Promise<SdkImageItem[]> => {
  if (attachments === undefined) return [];
  const items: SdkImageItem[] = [];
  for (const a of attachments) {
    if (a.kind !== "image" || a.bytes > MAX_INLINE_IMAGE_BYTES) continue;
    try {
      const b64 = (await fs.readFile(a.path)).toString("base64");
      items.push({ type: "input_image", image: `data:${a.mimeType};base64,${b64}` });
    } catch {
      /* 읽기 실패 → 텍스트 경로 블록(formatAttachments)이 경로/메타 인지 보장(조용한 실패 0). */
    }
  }
  return items;
};

// 비전 가능 모델 휴리스틱 — 이 어댑터는 이질 모델(openai·gemini·ollama)을 한 몸으로 굴리고
// vision 은 모델별이라, 비전 없는 모델에 이미지를 넣으면 그 turn 이 에러난다. 매치 시에만 이미지
// 주입, 아니면 텍스트 경로 폴백(현행·회귀 0). 미매치(비전인데 누락)=텍스트 폴백(안전), 오탐(비전
// 아닌데 매치)=그 turn 실패→풀 폴백이라 보수적으로. 새 비전 모델은 여기 패턴만 추가하면 된다.
const VISION_MODEL_RE =
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|gemini|llava|bakllava|vision|llama-?4|minicpm-v|moondream|qwen[\d.]*-?vl|pixtral|gemma-?3|mistral-small-?3|internvl/i;
const modelSupportsVision = (model: string): boolean => VISION_MODEL_RE.test(model);

// 도구(function calling) 미지원 모델 에러 감지 — 다수 로컬 비전/소형 모델(ollama llava·moondream
// 등)이 tools 를 넘기면 400 "does not support tools" 로 거부한다. 감지 시 도구 없이 1회 재시도해
// (텍스트/vision 만) 그 모델도 최소한 응답하게 한다. 도구가 정말 필요한 작업은 그 모델로 애초에
// 불가하므로 no-tools 폴백이 최선. openai/gemini(도구 지원)엔 무영향(이 에러 안 남).
const isToolsUnsupported = (e: unknown): boolean =>
  e instanceof Error &&
  /does not support tools|tools?\b[^.]{0,20}not support|not support[^.]{0,20}\btools?\b|does not support function/i.test(
    e.message,
  );

// PostToolUse 관찰용 문자열화(Phase 1, 2026-07-24) — MCP CallToolResult.content =
// Array<{type:"text", text:string} | ...>. codex 어댑터(openai-codex-oauth.ts
// "MCP CallToolResult.content" 주석)와 동일 규칙: text 노드만 join, 빈 결과면
// JSON.stringify 폴백(관찰 전용이라 손실 있어도 무해 — 계약 §1.1 "요약" 허용).
const summarizeMcpToolResult = (result: unknown): string => {
  const arr = Array.isArray(result) ? result : [];
  const text = arr
    .filter(
      (c) =>
        c !== null && typeof c === "object" && (c as { type?: string }).type === "text",
    )
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
  return text !== "" ? text : JSON.stringify(result ?? {});
};

export const runOpenAi = async (
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성(context/transcripts)은 canonical
  // 저장 채널로 키잉. route() 가 정규화 시 sessionChannel 실어보냄, 미지정 → channel 폴백
  // (회귀 0). 표시/감사는 input.channel 유지 — claude 어댑터와 parity(#2).
  const idChannel = input.sessionChannel ?? input.channel;

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

  // externalTools 패스스루 (ADR 2026-07-25 §Decision-5, 스파이크 §2) — LLM 게이트웨이 전용,
  // toolsNone(=tiguclaw MCP 서버 0)과 완전 독립인 `Agent.tools`(native FunctionTool[]) 필드에
  // 등록한다(§2.3 확정 — mcpServers 와 서로 다른 필드라 toolPolicy 게이팅과 애초에 안 만남).
  // execute() 는 부작용 0 — 실제 실행 대신 `{callId, name, argumentsJson}` 을 클로저 배열에
  // 수집만 하고 마커 문자열을 반환한다. `stopAtToolNames` 가 그 반환값을 finalOutput 으로
  // 승격해(§2.1) 즉시 턴을 멈추지만, 우리는 finalOutput 을 안 쓰고 이 수집 배열로 판정한다
  // (실제 실행 자체를 막는 원시기능이 SDK 에 없어 "실행되지만 부작용 0"으로 동등 효과, 확인됨).
  // 병렬 tool_call 도 SDK 가 각 호출마다 execute() 를 1회씩 부르므로(§2.2 코드 확정) 전량 수집.
  const externalToolNames = new Set((input.externalTools ?? []).map((t) => t.name));
  const externalToolCallsCollected: NonNullable<RegionASdkOutput["externalToolCalls"]> = [];
  const nativeExternalTools = (input.externalTools ?? []).map((t) =>
    tool({
      name: t.name,
      description: t.description ?? "",
      // 앱 함수 스키마(JSON Schema) 원본 그대로 통과 — non-strict(스키마를 tiguclaw 가
      // 임의로 조이지 않는다). 런타임 형상 검증은 model+SDK 가 수행, 여기선 캐스팅만.
      parameters: (t.parameters ?? {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: true,
      }) as never,
      strict: false,
      execute: async (
        _args: unknown,
        _ctx?: unknown,
        details?: { toolCall?: { callId?: string; arguments?: string } },
      ) => {
        const callId = details?.toolCall?.callId ?? randomUUID();
        const argumentsJson =
          details?.toolCall?.arguments ?? JSON.stringify(_args ?? {});
        externalToolCallsCollected.push({ id: callId, name: t.name, argumentsJson });
        return JSON.stringify({ __passthrough: true, name: t.name });
      },
    } as Parameters<typeof tool>[0]),
  );

  // reply-intent — 무인자 도구 호출 시 클로저로 플래그 set (turn 별 격리, 함수 지역).
  let replyToTrigger = false;

  const mcpServers: MCPServer[] = toolsNone
    ? []
    : [
        await adaptClaudeMcpServer(createMemoryMcpServer(), "memory"),
        // 3b — baseCwd=discoveryCwd(input.cwd ?? home) 주입 → 상대경로 기준점이 턴 cwd
        // (프로젝트). claude(SDK options.cwd) 와 대칭 = #2 parity(ADR 2026-07-06 §3b).
        // threadKey(ADR 2026-07-17 §Phase 2/§6 마감) — openai 백그라운드 셸의
        // shell.started.threadKey 가 실 세션이 되도록 전파(이전엔 baseCwd 만 넘겨 "" 폴백).
        await adaptClaudeMcpServer(
          // ★includeWebSearch — openai 어댑터는 자체 웹 검색 수단이 없다(claude=SDK
          //  builtin, codex=backend native). 여기만 config-driven provider 로 닫는다
          //  (settings.json search.provider + 키 env, 미설정이면 도구 미등록).
          createFileOpsMcpServer(discoveryCwd, input.threadKey, {
            includeWebSearch: true,
            // abortSignal — /stop·취소가 포그라운드 셸까지 끊게(G, 2026-07-28).
            abortSignal: input.abortSignal,
          }),
          "file-ops",
        ),
        await adaptClaudeMcpServer(createTodoMcpServer(), "todo"),
        await adaptClaudeMcpServer(createProjectRegistryMcpServer(), "projects"),
        // 런타임 유지보수 detect (2026-07-12, P1) — maintenance_status. 읽기전용·저위험 =
        // memory/projects/skills 와 동일 무조건 등록(claude/codex 와 parity, 계약서 §3.1).
        await adaptClaudeMcpServer(createMaintenanceMcpServer(), "maintenance"),
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
      // 잡 소유 브리지 — 안쪽 경계(잡 상한)보다 넉넉한 천장(codex 어댑터와 동형).
      await adaptClaudeMcpServer(
        createSpawnAgentMcpServer(input),
        "agents",
        JOB_OWNING_TOOL_CALL_TIMEOUT_MS(),
      ),
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

  // 외부 MCP 등록 도구 (2026-07-07) — add/list/remove_mcp_server. endpoint/command 와
  // *동일* 가드. 파일(<home>/mcp.json)만 다룸. claude/codex 와 parity(#2 — 도구 분기 0).
  // (외부 MCP 실연결 브리지는 Phase 2 — 지금은 등록 도구만 3어댑터 대칭.)
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(createMcpAdminMcpServer(), "mcp-admin"),
    );
  }

  // ★외부 MCP 실연결(Phase 2, #2) — <home>/mcp.json 의 서버를 @mcp/sdk 클라이언트로 연결한
  // persistent 브리지를 도구로 노출(claude 네이티브와 parity). depth0 메인 턴만. 이 브리지는
  // close()=no-op 이라 아래 finally 의 일괄 close 가 외부 연결을 끊지 않는다(캐시 재사용).
  // 메인 턴(전역) 또는 프로젝트 위임 서브/워커(전역+프로젝트 <cwd>/.mcp.json — 지연연결 캐시).
  if (
    !toolsNone &&
    ((depth === 0 && (input.workerDepth ?? 0) === 0) || isProjectMcpCwd(input.cwd))
  ) {
    for (const bridge of await getConnectedExternalMcpBridges(input.cwd)) {
      mcpServers.push(bridge);
    }
  }

  // 자가 업데이트 도구 (2026-06-26) — update_self. command-tools 와 *동일* 가드
  // (depth 0 + workerDepth 0) — 워커/서브에이전트가 자가 업데이트 트리거 불가(재귀 차단).
  // 위험 로직 0(전부 runSelfUpdate). notify 좌표는 현재 turn 의 channel/threadKey 에서
  // 도출 — 재시작 후 부팅이 요청자에게 "완료" 회신. claude/codex 와 parity(#2).
  if (!toolsNone && depth === 0 && (input.workerDepth ?? 0) === 0) {
    mcpServers.push(
      await adaptClaudeMcpServer(
        createUpdateSelfMcpServer(
          notifyDestFromCoords(
            input.channel,
            input.threadKey,
            input.channelAddress,
          ),
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

  // find_capabilities (P1, capability-awareness contract §3c) — 여기까지 push 된
  // mcpServers 가 *이번 턴 실제 활성* 서버 집합(게이트-aware, 병렬 static list 0 —
  // §3b). skills 와 동일하게 depth 무관 + !toolsNone 만 게이트. 자기 자신은 아직
  // push 전이라 활성 목록에 안 잡힘(§3d, 순환 없음). claude/codex 와 parity — 동일
  // 팩토리·동일 카탈로그, 이 어댑터 몫은 activeNames 주입뿐(분기 0).
  if (!toolsNone) {
    const capabilityActiveNames = mcpServers.map((s) => s.name);
    mcpServers.push(
      await adaptClaudeMcpServer(
        createFindCapabilitiesMcpServer(
          capabilityActiveNames,
          undefined,
          input.extraMcpServers,
        ),
        "find-capabilities",
      ),
    );
  }

  // PreToolUse/PostToolUse 훅 배선 — Phase 1 (2026-07-24, 계약 §3.3 실측 갱신).
  // 계약 초안은 ToolInputGuardrail(tool 정의 시 부착)+AgentHooks onToolEnd 를 지시했으나,
  // node_modules 실측(`@openai/agents-core/dist/mcp.js` mcpToFunctionTool → `tool({...})`
  // 호출에 inputGuardrails/outputGuardrails 옵션 미전달)상 **MCP 로 노출되는 도구는 guardrail
  // 이 물리적으로 안 붙는다** — 이 어댑터의 전 capability(file-ops/memory/todo/skills/...) 와
  // 외부 MCP 브리지가 전부 MCP 경로라 guardrail 방식으론 커버리지 0%. 대신 실제 실행
  // choke-point 인 `MCPServer.callTool()` 자체를 **이 파일 로컬에서만** wrap 한다 — 원본
  // 팩토리(`_mcp-bridge.ts`/`external-mcp.ts`, codex 어댑터와 공유)는 원본 그대로 두고
  // (다른 어댑터 무영향·회귀 0), 여기서 만든 `mcpServers` 배열 원소만 감싼다. 결과: 이
  // 어댑터가 등록하는 **모든** MCP 도구(capability + extraMcpServers + 외부 MCP 브리지)가
  // 예외 없이 한 지점에서 Pre(차단)/Post(관찰)를 통과 — guardrail 방식보다 오히려 커버리지가
  // 넓다(§한계 없음, MCP 기반이 아닌 native `tool()` 을 이 어댑터가 쓰지 않으므로 100%).
  //  - Pre: block 이면 실제 callTool 을 스킵하고 `formatToolBlock` 문자열을 content 로 반환
  //    (모델이 tool_result 자리에서 거부를 인지 — claude/codex 와 동일 시맨틱, 계약 §2).
  //    codex parity — 차단된 호출은 Post 를 발행하지 않는다(도구가 실행되지 않았으므로).
  //  - Post: callTool 성공/실패(에러 포함) 양쪽에서 발행(계약 §3.1 "에러 케이스 포함" 과
  //    동형) — 관찰 전용, fire-and-forget(`void`, claude 콜백과 동일 — 도구 결과 반환을
  //    지연시키지 않는다). 훅 미설정(대부분) 이면 `runHooks` 조기반환으로 오버헤드 0.
  //  - tool_name 정규화(계약 §4-3)는 `runPreToolUseHooks`/`runPostToolUseHooks` 내부에서
  //    이미 수행(hook-runner.ts) — 이 어댑터의 MCP 브리지가 노출하는 이름은 애초에
  //    `mcp__` 접두사가 없어(codex 와 동일 무접두사 규약) normalize 는 no-op, 원본 이름을
  //    그대로 넘긴다(claude 의 `mcp__server__tool` 접두사 케이스와 무관).
  const wireToolHooks = (server: MCPServer): MCPServer => ({
    ...server,
    async callTool(toolName, args, meta) {
      const toolInput = (args ?? {}) as Record<string, unknown>;
      const pre = await runPreToolUseHooks({
        toolName,
        toolInput,
        cwd: discoveryCwd,
        channel: input.channel,
        threadKey: input.threadKey,
      });
      if (pre.block) {
        return [
          { type: "text", text: formatToolBlock(toolName, pre.blockReason) },
        ] as Awaited<ReturnType<MCPServer["callTool"]>>;
      }
      try {
        const result = await server.callTool(toolName, args, meta);
        void runPostToolUseHooks({
          toolName,
          toolInput,
          toolResponse: summarizeMcpToolResult(result),
          cwd: discoveryCwd,
          channel: input.channel,
          threadKey: input.threadKey,
        });
        return result;
      } catch (e) {
        void runPostToolUseHooks({
          toolName,
          toolInput,
          toolResponse: `Error: ${e instanceof Error ? e.message : String(e)}`,
          cwd: discoveryCwd,
          channel: input.channel,
          threadKey: input.threadKey,
        });
        throw e;
      }
    },
  });
  for (let i = 0; i < mcpServers.length; i++) {
    mcpServers[i] = wireToolHooks(mcpServers[i]);
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
    // 중립 override(게이트웨이) 지정 시 그 값이 instructions — tiguclaw 작동헌법 대체.
    instructions: input.systemPromptOverride ?? SYSTEM_PROMPT,
    model: modelArg,
    mcpServers,
    // externalTools 패스스루(§2.3) — 미지정/빈 배열이면 두 필드 모두 생략(스프레드 {} =
    // 현행과 바이트 동일 Agent 구성, 회귀 0). toolsNone 게이팅과 무관 — mcpServers 축과
    // 별개 필드라 tiguclaw 도구가 꺼져도 앱 함수는 그대로 노출된다(ADR §Decision-1 3항).
    ...(nativeExternalTools.length > 0
      ? {
          tools: nativeExternalTools,
          toolUseBehavior: { stopAtToolNames: [...externalToolNames] },
        }
      : {}),
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
        retrieveContext(idChannel, input.threadKey, input.text, {
          limit: 5,
        }),
      );
  // 현재 대화 컨텍스트 — depth 0(실제 사용자 대화)만 (codex L814-818 parity).
  const convoContext =
    depth === 0
      ? formatConversationContext(
          input.channel,
          input.threadKey,
          input.channelAddress,
        )
      : "";
  // 스킬/에이전트 인덱스 — depth 0 turn 만 (codex L805-813 parity). depth≥1 child 는
  // spawn 도구 미등록과 정합해 인덱스도 박지 않음 (재spawn 유도 0).
  const skills = await discoverSkills(discoveryCwd);
  const skillIndex = formatSkillIndex(skills);
  const agentIndex =
    depth === 0 ? formatAgentIndex(await discoverAgents(discoveryCwd)) : "";
  // 모델 프로파일 인지 — depth 0 만 (agentIndex 게이트 parity). 부재/오류 시 ""(graceful).
  const modelProfiles = depth === 0 ? formatModelProfiles(discoveryCwd) : "";

  // SYSTEM.md(작동 헌법) — 매 turn 최상단 (codex/claude parity).
  const system = readSystem();
  // 환경 자기인지(env 블록, runtime-env.ts) — depth 게이트 없음(전 depth, 계약 §1.4).
  const env = formatEnvContext({ cwd: discoveryCwd });
  // 멀티모달 V1 — 현재 turn 첨부 placeholder (경로+메타). 미지정/빈 배열 → "" (회귀 0).
  const attachmentBlock = formatAttachments(input.attachments);

  // 중립 override(게이트웨이) 지정 시 tiguclaw context prefix 전부 스킵(페르소나·컨텍스트 누수 0).
  const systemContextParts =
    input.systemPromptOverride !== undefined
      ? []
      : buildSystemContextParts({
          system,
          env,
          agent: agentBody,
          agentWarn,
          convoContext,
          memoryIndex,
          memorySnippet,
          skillIndex,
          agentIndex,
          modelProfiles,
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
  const priorTurns = loadThreadHistory(idChannel, input.threadKey);
  // ★스캐폴딩 스트립 (2026-07-28) — transcripts 의 user 턴에는 SYSTEM.md·system-reminder 등
  //  런타임 주입물이 함께 박혀 있다(실측: 최근 14일 282행 평균 41,132자·최대 1,324,574자).
  //  그대로 재주입하면 **캡의 대부분을 헌법 재전송이 먹어** 정작 대화 히스토리가 밀려난다
  //  (charCap 200,000 기준 스캐폴딩 5턴이면 대화 0). codex 는 같은 자리에서 이미 스트립한다
  //  (openai-codex-oauth-history.ts) — 어댑터 간 동작이 갈리던 것을 맞춘다(원칙 2).
  //  스트립 결과가 비면 원문 유지(정보 손실 방지) — codex 와 같은 폴백.
  const stripped = (c: string): string =>
    stripInternalRuntimeScaffolding(c).trim() || c;
  const historyItems: AgentInputItem[] = priorTurns.map((t) =>
    t.role === "assistant"
      ? {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: stripped(t.content) }],
        }
      : {
          role: "user",
          content: [{ type: "input_text", text: stripped(t.content) }],
        },
  );
  // 멀티모달 — 모델이 vision 가능하면 현재 turn 이미지 첨부를 input_image 로 함께 주입(SDK 가
  // Responses/ChatCompletions 로 자동 번역). 비전 없는 모델은 [] → 텍스트 경로 블록만(회귀 0).
  const imageItems =
    input.attachments !== undefined && modelSupportsVision(model)
      ? await buildImageContentItems(input.attachments)
      : [];
  const currentTurn: AgentInputItem = {
    role: "user",
    content: [{ type: "input_text", text: promptWithMemory }, ...imageItems],
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

  // 도구 실행시간(#3) — callId → {그 도구의 activity seq, 시작 벽시계, 라벨}. tool_called
  // 에서 기록, tool_output(function_call_result) 도착 시 phase:"end"+durationMs 로 발행.
  const toolTiming = new Map<
    string,
    { seq: number; t0: number; label: string; stopSlow?: () => void }
  >();

  // externalTools 스트리밍(llm.tool_call_delta, §2.4) — SDK 는 `tool_called` 를 도구콜이
  // *완전히 조립된 뒤* 1회만 노출한다(codex 의 문자 단위 진짜 델타와 달리 이 어댑터는 "단일
  // 청크 = 전체 call", 스파이크 §2.4 명시 비대칭 — 추가 열화 아님, additive 이벤트). index 는
  // 이 run() 호출 안에서 externalTools 매치 도구가 등장한 순서(0,1,2…), seq 는 여타 이벤트와
  // 동일 패턴의 독립 단조 카운터.
  let externalToolDeltaIndex = 0;
  let toolCallDeltaSeq = 0;

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

  // 대시보드 인터리브(2026-07-13) — 도구 경계(및 턴 종료) 직전까지 deltaStream 이
  // 누적한 텍스트를 kind:"text" activity 로 발행. seq 는 도구와 *같은* activitySeq
  // 카운터에서 뽑는다(closeSegment 자체의 delta seq 는 안 씀) — seq 정렬 순서 = 실제
  // 발행(텍스트↔도구 인터리브) 순서. best-effort — 실패해도 turn 진행(원칙 3).
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
          adapter: "openai",
          model,
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

  // P1b mid-turn steering (ADR `2026-07-16-midturn-steering.md` §openai, Phase P1b).
  // codex(수동 루프 inputArray.push)·claude(streaming-input)와 *동일 계약* = "대기 steering
  // 은 다음 model-call 경계에서 대화에 append". openai 는 run() 을 유지한 채 RunConfig
  // `callModelInputFilter`(각 agentic turn 모델호출 직전 실행, stream/non-stream 동일 —
  // node_modules `@openai/agents-core/dist/runner/conversation.d.ts:17` CallModelInputFilter
  // 시그니처 / `run.js:1024` applyCallModelInputFilter 를 #prepareModelCall = per-turn 에서
  // 호출)에서 대기 steering 을 `modelData.input` 에 append 한다 → run() 의 도구·usage·스트림·
  // 에러·폴백 비트 전부 SDK 보존(동작 보존 하드게이트 자동 충족, manual-loop 재작성 0).
  //
  // ★SP-2 교정(accumulator): `modelData.input` 은 매 turn `getTurnInput` 가 새로 만드는
  // clone(run.js items.js:232 `[...toAgentInputList, ...outputItems]`) → 필터가 push 한
  // 아이템은 그 turn 에만 있고 다음 turn 엔 사라지는 **ephemeral**(codex 의 inputArray.push
  // 영속과 대비). 따라서 drain-once(§openai 스니펫)면 turn N 에 도착한 steer 가 turn N+1
  // 에서 소실(SP-2 3턴 프로브 재현). codex parity(inputArray 영속)를 위해 **adapter-local
  // accumulator 를 유지 — 매 filter 호출마다 새 drain 분을 축적하고 전량을 재-append** 한다.
  //  - accumulate 단위 = *조립된* AgentInputItem (초기 유저 턴과 바이트 동형: buildSteering
  //    Item = input_text + modelSupportsVision 시 input_image, 스캐폴딩 prefix 0 = 순수
  //    사용자 발화. codex buildSteeringInputItem 과 동형). 한 번 조립 후 재사용(파일 재-read 0).
  //  - runOpenAi 스코프(runOnce 밖) → 도구 미지원 no-tools 재시도(2번째 runOnce)에서도
  //    이미 drain 된 steer 가 accumulator 에 남아 유지(재시도 중 손실 0).
  const accumulatedSteering: AgentInputItem[] = [];
  const steeringChannel = input.steering;
  const buildSteeringItem = async (s: SteeringInput): Promise<AgentInputItem> => {
    // 초기 유저 턴(currentTurn)과 동형 — 순수 사용자 발화(text + vision 모델이면 image).
    // 비전 미지원 모델은 이미지 생략(현재 turn 게이트와 동일 = 그 turn 에러 회피, 텍스트만).
    const imgs = modelSupportsVision(model)
      ? await buildImageContentItems(s.attachments)
      : [];
    return {
      role: "user",
      content: [{ type: "input_text", text: s.text }, ...imgs],
    };
  };

  // bridge close (in-memory transport 정리) — codex finally 패턴 답습. run() 동안
  // mcpServers 가 listTools/callTool 을 lazy connect 하므로, 응답 후 일괄 close.
  // 실패해도 응답 흐름 영향 0(개별 try/catch).
  const runOnce = async (agentToRun: Agent = agent, closeServers = true) => {
    try {
      const streamed = await run(agentToRun, runInput, {
        stream: true,
        signal: effectiveAc.signal,
        // ★무회귀 하드게이트: steering 미주입/STEERING_ENABLED off = `input.steering`
        // undefined → `steeringChannel === undefined` → 아래 조건부 spread = `{}` →
        // runConfig = `{ stream, signal }` = 현행과 바이트 동일(훅 미등록). 어댑터는 이
        // 값을 *소비만* — 채널/모델 분기 0(#2 LLM-agnostic). Phase 2 관측(steering.injected)
        // 은 deferred — 여기선 codex 와 동형 console 만(P0 가 도착 시 channel.message.in 발행).
        ...(steeringChannel !== undefined
          ? {
              callModelInputFilter: async (
                args: CallModelInputFilterArgs,
              ): Promise<ModelInputData> => {
                // 이번 turn 새로 도착한 steer 를 축적(조립 1회) 후, accumulator 전량을
                // 이 turn 의 (clone) input 에 재-append → N/N+1/N+2 모든 후속 호출 present.
                const drained = steeringChannel.drain();
                for (const s of drained) {
                  accumulatedSteering.push(await buildSteeringItem(s));
                }
                if (drained.length > 0) {
                  console.error(
                    `[openai-agents steering] injected ${drained.length} mid-turn message(s) ` +
                      `(accumulated=${accumulatedSteering.length}) threadKey=${input.threadKey}`,
                  );
                }
                for (const item of accumulatedSteering) {
                  args.modelData.input.push(item);
                }
                return args.modelData;
              },
            }
          : {}),
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
            | { type?: unknown; name?: unknown; arguments?: unknown; callId?: unknown; call_id?: unknown }
            | undefined;
          if (raw?.type === "function_call" && typeof raw.name === "string") {
            // 이 도구 앞까지 누적된 연속 텍스트가 있으면 kind:"text" 로 먼저 닫는다
            // (인터리브 순서 보존 — 텍스트 세그먼트가 이 도구보다 낮은 seq 를 받게).
            closeTextSegment();
            const seq = activitySeq++;
            // 실행시간(#3) — callId 로 시작 기록 → tool_output 에서 durationMs.
            const callId =
              typeof raw.callId === "string"
                ? raw.callId
                : typeof raw.call_id === "string"
                  ? raw.call_id
                  : undefined;
            if (callId !== undefined) {
              toolTiming.set(callId, {
                seq,
                t0: Date.now(),
                label: raw.name || "tool",
                // 도구 지연 감시(2026-07-28, D) — codex 에만 있던 신호를 openai 에도.
                // 판정은 공통 엔진(tool-watchdog), 여기선 시작/종료만 건다.
                stopSlow: watchToolStart({
                  channel: input.channel,
                  threadKey: input.threadKey,
                  tool: raw.name || "tool",
                }),
              });
            }
            bus.publish({
              type: "llm.activity",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "openai",
                model,
                seq,
                kind: "tool",
                label: raw.name || "tool",
                detail:
                  typeof raw.arguments === "string"
                    ? buildActivityDetailFromJson(raw.arguments)
                    : undefined,
                ...(() => {
                  const diff =
                    typeof raw.arguments === "string"
                      ? buildActivityDiffFromJson(raw.name || "tool", raw.arguments)
                      : undefined;
                  return diff !== undefined ? { diff } : {};
                })(),
              } satisfies RegionAActivityPayload,
            });
            // externalTools 스트리밍(§2.4) — 매치되는 이름만, 단일 청크(전체 call)로 발행.
            if (externalToolNames.has(raw.name)) {
              try {
                bus.publish({
                  type: "llm.tool_call_delta",
                  ts: Date.now(),
                  payload: {
                    channel: input.channel,
                    threadKey: input.threadKey,
                    adapter: "openai",
                    seq: toolCallDeltaSeq++,
                    index: externalToolDeltaIndex++,
                    id: callId,
                    name: raw.name,
                    ...(typeof raw.arguments === "string"
                      ? { argumentsDelta: raw.arguments }
                      : {}),
                  } satisfies RegionAToolCallDeltaPayload,
                });
              } catch {
                /* best-effort — 스트리밍 관측 실패가 turn 을 무르지 않는다(원칙 3). */
              }
            }
          }
        } else if (
          ev.type === "run_item_stream_event" &&
          (ev as { name?: unknown }).name === "tool_output"
        ) {
          // 실행시간(#3) — 도구 완료(function_call_result). 같은 callId 의 시작 기록을 찾아
          // phase:"end"+durationMs 발행(같은 seq → 대시보드가 시작 스텝에 주석). best-effort.
          const raw = (ev as { item?: { rawItem?: unknown } }).item?.rawItem as
            | { callId?: unknown; call_id?: unknown; output?: unknown }
            | undefined;
          const callId =
            typeof raw?.callId === "string"
              ? raw.callId
              : typeof raw?.call_id === "string"
                ? raw.call_id
                : undefined;
          const timing = callId !== undefined ? toolTiming.get(callId) : undefined;
          if (callId !== undefined && timing !== undefined) {
            toolTiming.delete(callId);
            timing.stopSlow?.(); // 결과 도착 = 감시 종료(타이머 누수 0).
            // 결과 텍스트 추출(방어적) — string 이거나 {type:"text",text} / {text} 노드.
            const rawOut = raw?.output;
            const outText =
              typeof rawOut === "string"
                ? rawOut
                : rawOut && typeof rawOut === "object"
                  ? String((rawOut as { text?: unknown }).text ?? "")
                  : "";
            const outPreview = buildActivityOutput(timing.label, outText);
            bus.publish({
              type: "llm.activity",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "openai",
                model,
                seq: timing.seq,
                kind: "tool",
                label: timing.label,
                phase: "end",
                durationMs: Date.now() - timing.t0,
                ...(outPreview !== undefined ? { output: outPreview } : {}),
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
      // 도구 지연 감시 잔여 해제 — 결과 없이 턴이 끝나면(중단·에러) 타이머가 남아 끝난
      // 도구에 대해 뒤늦게 경고를 찍는다(오탐). claude 어댑터와 동형.
      for (const t of toolTiming.values()) t.stopSlow?.();
      toolTiming.clear();
      // 델타 잔여 flush(꼬리 유실 0) + coalesce 타이머 정리. best-effort — 실패해도
      // out 전체본이 권위 교체(자가치유). 성공·throw·abort 모든 경로에서 1회.
      deltaStream.flush();
      // 트레일링 텍스트 세그먼트 닫기(2026-07-13 인터리브) — 마지막 도구 이후(또는 도구가
      // 전혀 없었던) 턴 종료 시점까지 누적된 텍스트를 kind:"text" 로 발행.
      closeTextSegment();
      if (closeServers) {
        for (const server of mcpServers) {
          try {
            await server.close();
          } catch {
            /* noop */
          }
        }
      }
    }
  };
  // 도구 미지원 모델 폴백 — run() 이 "does not support tools" 로 실패하면(ollama llava 등) 도구
  // 없는 Agent 로 1회 재시도(텍스트/vision 만). mcpServers 는 첫 runOnce finally 에서 이미 close
  // 됐으니 재시도는 closeServers=false. abort/도구 없던 turn(toolsNone)엔 재시도 안 함.
  let result: Awaited<ReturnType<typeof runOnce>>;
  try {
    result = await runOnce();
  } catch (e) {
    if (
      isToolsUnsupported(e) &&
      !toolsNone &&
      mcpServers.length > 0 &&
      !effectiveAc.signal.aborted
    ) {
      console.warn(
        `openai: '${model}' 도구(function calling) 미지원 — 도구 없이 재시도(텍스트/vision). ` +
          `channel=${input.channel} thread=${input.threadKey}`,
      );
      const noToolsAgent = new Agent({
        name: "tiguclaw-spike",
        instructions: input.systemPromptOverride ?? SYSTEM_PROMPT,
        model: modelArg,
        mcpServers: [],
      });
      result = await runOnce(noToolsAgent, false);
    } else {
      throw e;
    }
  }

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

  // externalTools 패스스루 얼리 리턴 (ADR 2026-07-25 §Decision-5, 스파이크 §2.1) — 이
  // 경우 `result.finalOutput` 은 우리 execute() 마커의 반환값(`stopAtToolNames` 가 승격한
  // 것)이라 사용자에게 보일 진짜 텍스트가 아니다 — 절대 text 로 흘리지 않는다. 게이트웨이도
  // externalToolCalls 값이 있으면 content:null 로 매핑하므로(types.ts §Output 주석) text=""
  // 는 무해(호출자가 애초에 안 읽음). sessionId/usage 는 일반 경로와 동일 값.
  if (externalToolCallsCollected.length > 0) {
    return {
      text: "",
      sessionId: `openai-${randomUUID()}`,
      model,
      replyToTrigger,
      usage,
      externalToolCalls: externalToolCallsCollected,
    };
  }

  // ★undefined 누출 차단 (2026-07-28) — finalOutput 이 undefined 면 JSON.stringify 는
  //  문자열이 아니라 **undefined 값**을 돌려준다. 타입은 string 이라 컴파일러도 못 잡고,
  //  그 값이 facade·router·채널까지 그대로 흘러간다. 빈 문자열로 닫는다(다른 어댑터와 동형).
  const text =
    typeof result.finalOutput === "string"
      ? result.finalOutput
      : result.finalOutput === undefined || result.finalOutput === null
        ? ""
        : JSON.stringify(result.finalOutput);

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
