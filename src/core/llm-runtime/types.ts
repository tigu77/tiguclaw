/**
 * 영역 A SDK 인터페이스 contract (V2 진입 = 1 면).
 *
 * 진실 소스:
 *  - `docs/decisions/2026-05-17-llm-agnostic-vision.md` §3 (8 면 sketch)
 *  - `_workspace/region_a_abstract_architect_contract.md` §2 (V2 = 1 면 결정)
 *
 * V2 진입 면 = `run(input) → output` 1 시그니처. 나머지 7 면 (session resume /
 * 도구 실행 흐름 / MCP 등록 / permission / hook / 자동 발견 / stream fan-out) 은
 * 첫 어댑터 안쪽 캡슐화. V3 두 번째 어댑터 spike 시 면 추가 = additive 변경.
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, ChannelName } from "../../channels/types.js";

export interface RegionASdkInput {
  text: string;
  threadKey: string;
  channel: ChannelName;
  /**
   * 멀티모달 입력 V1 (additive) — 사용자가 채널로 보낸 첨부(이미지/문서/음성 등).
   * 운반 타입(`Attachment`)은 SDK 비종속 — path+메타(kind/mime/크기/caption)만.
   * 어댑터는 formatAttachments() 로 placeholder text 를 prompt 에 prepend 하고,
   * 비서가 native file 도구(claude=Read, codex=file-ops MCP read)로 절대경로를 읽는다.
   * 미지정/빈 배열 = 현행 text-only 경로 (회귀 0). native vision 은 V1.1 (어댑터 경계 안).
   */
  attachments?: Attachment[];
  /**
   * 영역 A SDK 가 작업할 cwd. 미지정 시 어댑터가 process.cwd() default
   * (Phase 2 동작 보존).
   */
  cwd?: string;
  /**
   * 호출자가 주입하는 추가 MCP server map. memory 는 어댑터 내장.
   * scheduler 등 plugin MCP server 가 부팅 시 등록되어 router 에서 전달
   * (scheduler v1 §8.1 대안 C 보존).
   *
   * 추상화 leak (의도) — `McpSdkServerConfigWithInstance` 는 Claude Agent SDK 타입.
   * V2 진입 = 그대로 두기 (contract §2.4). V3 두 번째 어댑터 spike 결과 다른 SDK 가
   * 호환되지 않는 shape 가지면 정규화 층 신규.
   */
  extraMcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /**
   * V7.2.b — sub-agent 중첩 실행 깊이. top-level turn = 0 (또는 undefined),
   * spawn_agent 로 실행되는 child turn = 1. depth ≥ 1 인 turn 에는
   * spawn_agent 도구를 등록하지 않아 재spawn 을 물리적으로 차단 (depth 1 제한).
   * OpenClaw `subagent-spawn.ts` 의 maxSpawnDepth 가드를 *도구 가용성* 으로 단순화.
   */
  subagentDepth?: number;
  /**
   * 신규(additive, 2026-06-17) — 백그라운드 워커 중첩 깊이. 메인(채널) turn = 0
   * (또는 undefined), `spawn_worker`(run_in_background) 로 실행되는 워커 작업 turn = 1.
   * depth ≥ 1 인 turn 에는 run_in_background/list_workers 도구를 등록하지 않아
   * 워커가 또 워커를 발사하는 것을 물리적으로 차단(무한 워커 봉쇄, W-I5).
   * subagentDepth 와 동형 메커니즘(도구 가용성 가드) — 직교(워커 안의 spawn_agent 블로킹
   * 위임은 허용). architect contract `_workspace/background-worker_architect.md` §2·§9-a.
   */
  workerDepth?: number;
  /**
   * 사용할 모델 (provider 별 모델명, 예 "gpt-5.5" / "claude-opus-4-7").
   * facade 가 `provider:model` 스펙에서 추출해 주입. 미지정 시 어댑터 디폴트
   * (codex=env/gpt-5.5, claude=SDK 디폴트). provider→어댑터 매핑은 facade 책임.
   */
  model?: string;
  /**
   * 신규(additive, 2026-06-15) — provider id (예 "openai"/"ollama"/"google").
   * facade(runPool)가 spec.provider 를 운반. openai 어댑터가 resolveProviderConn 으로
   * baseURL/apiKey 를 self-lookup 하는 데 사용. claude/codex 어댑터는 무시(읽지 않음).
   * 미지정 = openai 어댑터의 경우 정품 OpenAI 경로(현행 회귀 0).
   */
  provider?: string;
  /**
   * 아웃바운드 첨부 전송 클로저 — 채널 원본(IncomingMessage.sendAttachment)을 router가 주입.
   * send_file MCP 도구가 호출. 미지정(스케줄러 등 비채널 turn) 이면 도구가 미지원 안내.
   */
  sendAttachment?: (filePath: string, opts?: { caption?: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 신규(additive, 2026-06-15) — 이 turn 에 등록할 도구 정책. 어댑터 무관 *추상 신호*.
   * spawn_agent 가 agent.md `tools` 필드를 정규화해 주입.
   *  - 미지정(undefined): 현행 = 전체 도구 (회귀 0).
   *  - { mode: "none" }: 도구 0 (lean 단순작업·도구 미지원 모델 graceful).
   *  - { mode: "allow", names: string[] }: allowlist (Claude Code tools 답습).
   * 어댑터가 자기 도구 집합(claude builtin / codex·openai MCP)에서 이 신호로
   * 필터. 도구명 매핑은 *어댑터 안*에서 (추상 누수 0 — childInput 은 중립 신호만).
   * 본 라운드 구현 범위는 mode:"none" 강제. mode:"allow" 정밀 필터는 후속(YAGNI) —
   * 미지원 시 안전 degrade(전체 또는 none). (architect contract §2a, I-2·I-3)
   */
  toolPolicy?: { mode: "none" } | { mode: "allow"; names: string[] };
  /**
   * 신규(additive, 2026-06-15) — lean child 의 컨텍스트 생략 신호. 어댑터 무관.
   *  - 미지정/false: 현행 = retrieveContext + memoryIndex prepend (회귀 0).
   *  - true: 메모리 스니펫·인덱스 prepend 생략 (단순 텍스트 작업 child).
   * persona(SYSTEM/AGENT)는 영향 없음 — 불변식 I-4. memory MCP *도구*는
   * toolPolicy 가 따로 관할(직교, I-5). (architect contract §2c)
   */
  leanMemory?: boolean;
  /**
   * 신규(additive, 2026-06-17) — 2층 턴 타임아웃 신호. 핸들러가 턴당 AbortController
   * 를 만들어 signal 을 route→runRegionA→어댑터로 운반한다. 어댑터는 자기 1층 idle
   * AbortController 와 OR 결합(linkAbort) — 둘 중 하나 abort 시 LLM 호출/도구 실행
   * 중단. 미지정(스케줄러 등 비채널 turn) = 백스톱 없음(현행 회귀 0, TT-I7).
   * 1층(idle, iteration 단위)과 직교 — 본 신호는 턴 전체 wall-clock.
   * abort reason 은 TurnTimeoutError(turn-timeout.ts) — isModelRejected 비매칭(TT-I3).
   */
  abortSignal?: AbortSignal;
}

export interface RegionASdkOutput {
  text: string;
  /**
   * V5 — 어댑터가 자기 session id 박음 (claude = SDK 보고, 다른 어댑터 = 자체 uuid).
   * runRegionA 가 이 값 보고 saveSession 자동 호출.
   */
  sessionId?: string;
  /** 사용 모델 — saveSession 저장용. */
  model?: string | null;
  /** sysprompt hash — claude 어댑터만 (fingerprint 가드). */
  systemPromptHash?: string | null;
  /**
   * SDK 자체 jsonl 경로 — claude 어댑터만 (`~/.claude/projects/.../sid.jsonl`).
   * 있으면 jsonl catch-up 진실 소스, 없으면 runRegionA 가 transcripts INSERT 직접.
   */
  jsonlPath?: string;
  /**
   * 신규 (additive) — 이 turn 응답을 트리거 메시지 직접 답글로 마킹.
   * 비서가 reply_to_current_message() 도구를 호출했을 때만 true.
   * 추상적 의도 — 채널이 렌더(telegram=reply_parameters, 그 외 no-op).
   */
  replyToTrigger?: boolean;
  /**
   * 신규 (additive, /status 개편) — 이 turn 의 토큰 사용량. 세 어댑터 공통 형상.
   * 어댑터가 *이미 받는* result/SSE 에서 추출 (추가 호출 0). 미캡처 시 미지정.
   * inputTokens = 이 turn 에 보낸 누적 컨텍스트 proxy ("얼마나 찼나" 측정용).
   *  - claude: result 메시지 `modelUsage[model]` → {inputTokens, outputTokens}.
   *  - codex: 마지막 turn 의 `response.completed` usage → {input_tokens, output_tokens}.
   *  - openai: 미캡처 → 생략 (NULL → /status "측정 전").
   */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * 신규 (additive) — 세션 모델 override(opts.specs 단일 spec)가 런타임에 거부되어
   * env 풀로 자동 폴백했음을 호출자에게 알리는 신호. facade(runRegionA)만 세팅한다.
   * 어댑터 무관 — facade 단일 지점에서 에러 종류를 분류하므로 claude/codex/openai
   * 어느 어댑터든 동일하게 채워진다 (LLM-agnostic parity 보장 지점).
   *
   * router 가 이 신호를 보면 clearSessionModelOverride 로 깨진 override 를 DB 에서
   * 제거 → 다음 turn 정상화 (매 turn 경고 반복 방지). 고지 문구 자체는 facade 가
   * 이미 output.text 에 덧붙였으므로 이 필드는 순수 제어 신호다.
   *  - requested: 사용자가 지정했던(거부된) 모델 spec ("provider:model").
   *  - fellBackTo: 실제로 응답한 폴백 모델 spec ("provider:model").
   */
  modelOverrideRejected?: { requested: string; fellBackTo: string };
}

export interface RegionASdk {
  run(input: RegionASdkInput): Promise<RegionASdkOutput>;
}

/**
 * region.a.activity — LLM-agnostic per-step 활동 관측 이벤트 (Round 1).
 *
 * 세 어댑터(claude/codex/openai) 공통. 대시보드가 "지금 무슨 도구를 쓰는 중"을
 * 실시간 표시하기 위한 *중립 rich* 이벤트. claude 전용 raw `region.a.sdk_message`
 * 와는 별개 레이어(병존) — 그쪽은 firehose, 이쪽은 정규화된 활동 단위.
 *
 * EventBus publish 시:
 *   { type: "region.a.activity", ts: Date.now(), payload: RegionAActivityPayload }
 *
 * turnId/throttle/nonce 없음 (의도) — 대시보드는 전역 관측면이라 per-turn reply
 * 라우팅 불요(2026-05-27 progress-indicator 철회 교훈). channel/threadKey 는
 * 표시·필터용 라벨일 뿐, 라우팅 키 아님. throttle 없음 — 관측은 전 이벤트 표시.
 */
export interface RegionAActivityPayload {
  /** 표시·필터용 라벨 (라우팅 아님). 트리거 메시지의 채널. */
  channel: ChannelName;
  /** 표시·필터용 라벨 (라우팅 아님). 트리거 메시지의 thread. */
  threadKey: string;
  /** 어느 LLM 어댑터가 흘렸는지 — parity 가시화 + 대시보드 색/그룹 단서. */
  adapter: "claude" | "codex" | "openai";
  /** 사용 모델 (있으면). 어댑터가 아는 시점에 박음, 모르면 생략. */
  model?: string;
  /**
   * 어댑터 로컬 단조 증가 시퀀스 (이 run() 호출 안에서 0,1,2…).
   * 대시보드가 동일 turn 활동 순서를 알게(Round 2 그룹핑 단서).
   * turn 격리 nonce 아님 — 어댑터 함수 지역 변수라 동시 run 끼리 자연 격리.
   */
  seq: number;
  /**
   * 1 활동의 종류. Round 1 핵심 = "tool".
   *  - "tool": 도구/함수 호출 1개 (claude tool_use 블록, codex toolCalls 항목).
   *  - "turn": iteration 시작 1개 — openai spike 의 coarse floor 전용.
   */
  kind: "tool" | "turn";
  /**
   * 사람이 읽는 한 줄. kind="tool" 이면 도구명, kind="turn" 이면 코어스 문구.
   */
  label: string;
}

// Legacy alias — V1 facade 호환 (plugin 진입점 import 무수정 게이트).
export type ClaudeRunInput = RegionASdkInput;
export type ClaudeRunOutput = RegionASdkOutput;
