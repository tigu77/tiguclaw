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
import type { WorkerNotifyDest } from "../worker-jobs.js";
import type { SteeringChannel } from "../steering.js";

export interface RegionASdkInput {
  text: string;
  threadKey: string;
  channel: ChannelName;
  /**
   * 신규(additive, 2026-07-15) — **세션-정체성 저장 채널** (채널/세션 분리 Phase 1,
   * ADR `docs/decisions/2026-07-15-channel-session-decoupling.md` §D1/§D4, 급소).
   *
   * `threadKey`(=세션 id)로 세션-정체성(resume=claude_session_id / transcript_index /
   * context boundary / model override)을 read/write 할 때 쓸 **canonical 채널**. 세션이
   * 채널 무관(#4)이 되려면 저장 채널이 인입 채널이 아니라 *세션의 함수(상수)* 여야 한다
   * → route() 가 채널 인입을 세션으로 정규화할 때 `SESSION_STORAGE_CHANNEL`(store 소유
   * 상수)을 실어보낸다. 그래야 텔레그램·CLI 인입이 기존 대시보드 기본 세션의 resume/
   * transcripts 를 **같은 행으로 계승**한다(파편화 0).
   *
   * ★미지정 → `channel` 폴백(회귀 0). 셀렉터 없는 채널을 세션으로 정규화하지 않는 경로
   * (스케줄러·워커·서브에이전트·file-watch·엔드포인트·Phase 1 이전 채널)는 이 필드를 안
   * 채우므로 현행 (channel, threadKey) 키잉 그대로 — 라이브 데몬 비파괴.
   *
   * ★§0/2분리: 이건 *저장 정체성* 채널일 뿐. 표시·감사(llm.activity/delta payload,
   * turn_done/error, prompt-assembly 좌표)는 `channel`(실채널) 유지 — 대시보드가
   * "텔레그램 경유" 를 알게. 어댑터는 이 값으로 채널 정체성을 분기하지 않는다(LLM-agnostic).
   */
  sessionChannel?: ChannelName;
  /**
   * 신규(additive, 2026-07-15) — **배달 좌표(delivery address)** (채널/세션 분리 §D3).
   * telegram=chatId, http=threadKey 등 이 인입의 outbound 목적지. 세션 id 를 파싱해
   * 좌표를 도출하던 것(extractTelegramChatId/deriveTargetFromThreadKey)을 대체하는
   * **캡처된 메타**. 워커 완료 통지 등 비동기 outbound 가 세션 id(=이제 채널 무관 dashboard:*)
   * 를 파싱해도 텔레그램 chatId 를 못 얻으므로, 인입 시점 좌표를 여기로 운반해
   * `notifyDestFromCoords` 가 파싱 대신 이 값을 우선 쓴다(파싱은 폴백 보존, 회귀 0).
   * 미지정(Phase 1 이전·좌표 없는 채널) → 기존 threadKey 파싱 폴백.
   */
  channelAddress?: string;
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
   * 신규(additive, 2026-06-25, 축1) — 객관식 선택지 제시 클로저. 채널 원본
   * (IncomingMessage.presentOptions)을 router 가 sendAttachment 와 *동일 경로*로 주입.
   * prompt_options MCP 도구가 호출. 미지정(미지원 채널·비채널 turn) = 도구가 graceful
   * 텍스트 안내. ★비차단 — 렌더만 하고 즉시 반환, 사용자 선택은 다음 인바운드 메시지.
   * 어댑터는 이 필드를 *값으로* createPromptOptionsMcpServer 에 주입만(읽어 분기 0,
   * LLM-agnostic). claude·codex 양쪽 동일 등록 = #2 parity 하드게이트.
   */
  presentOptions?: (
    question: string,
    options: { label: string; value: string }[],
    opts?: { note?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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
  /**
   * 신규(additive, 2026-06-22) — *내부 분류성* 1회 호출 플래그. 데이터 평면(self-growth
   * 등)이 "작은 yes/no/uncertain 분류"를 현재 활성 어댑터로 돌릴 때 세팅한다.
   *
   * true 일 때 facade(runPool)가:
   *  1. llm.turn_done / llm.turn_error 를 **발행하지 않음** (관측·학습 입력에서
   *     제외). 이게 *메타-재귀 킬스위치* — self-growth 가 이 경로를 쓰면, 자기 분류 호출이
   *     다시 turn 이벤트로 self-growth 입력에 되돌아오는 루프를 구조적으로 차단한다.
   *  2. persistOutput 을 **건너뜀** (transcripts/sessions 미오염 — 분류는 대화가 아니다).
   *
   * 어댑터는 이 필드를 읽지 않는다(LLM-agnostic — facade 단일 지점에서만 분기). 모델 선택·
   * 폴백·provider 해석은 일반 turn 과 *동일* 코드(runPool/resolveModelSpecs)를 타므로
   * 어댑터 락인 0. 미지정/false = 현행(회귀 0).
   */
  internal?: boolean;
  /**
   * 신규(additive, 2026-07-09) — **중립 시스템 프롬프트 override** (LLM 게이트웨이용).
   * 지정 시(빈 문자열 포함) 어댑터는 tiguclaw 작동헌법(REGION_A_SYSTEM_PROMPT)·AGENT.md
   * 페르소나·SYSTEM.md·메모리/스킬 인덱스 등 **모든 tiguclaw context prefix 를 넣지 않고**
   * 이 값만 시스템 프롬프트로 쓴다. 앱이 자기 system 메시지를 그대로 쓰게(비서 페르소나 누수 0).
   * 미지정 = 현행(SYSTEM_PROMPT + 전체 context, 회귀 0). 3어댑터 동형 처리.
   */
  systemPromptOverride?: string;
  /**
   * 신규(additive, 2026-06-24) — 이 turn 이 발사하는 백그라운드 워커의 완료/실패 *통지
   * 목적지*. generic 좌표(`WorkerNotifyDest` = {channel, target}) — 코어 소유, scheduler 무관.
   *
   * 채우는 주체: 비채널 트리거 플러그인(예 scheduler runner)이 자신이 아는 dest
   * (schedule.destChannel/destTarget)를 주입한다. 텔레그램 등 채널 직접 발화 turn 은
   * 미지정(undefined) — 그 경우 워커는 job.channel/threadKey 폴백으로 통지(회귀 0).
   *
   * 읽는 주체: ★어댑터는 이 필드를 읽지 않는다(LLM-agnostic — 통지 라우팅은 daemon 경계,
   * 모델 무관·claude/codex/openai 동일 동작·어댑터 분기 0). 오직 워커 발사 도구
   * (run_in_background, worker-registry.ts)만 parentInput.notifyDest 를 읽어 startWorkerJob
   * 으로 잡에 박는다 → onWorkerComplete 가 이 generic dest 로 dispatch.
   *
   * 멀티모달 attachments(텍스트 prepend)·sendAttachment(아웃바운드 클로저)와 직교 —
   * 이건 *워커 완료 통지의 라우팅 좌표* 일 뿐 prompt·전송 클로저와 무관.
   */
  notifyDest?: WorkerNotifyDest;
  /**
   * 신규(additive, 2026-07-16) — **진행 중 턴에 끼워넣을 사용자 steering 소스**(채널·LLM 무관).
   * ADR `docs/decisions/2026-07-16-midturn-steering.md` §4. 핸들러가 turn 별 SteeringChannel
   * 을 만들어 주입(inflightTurns 자매 레지스트리). 어댑터는 이 필드를 *값으로* 소비만 —
   * 읽어서 채널/모델 분기 0(#2). 소비 idiom 은 어댑터별(claude=stream·codex/openai=drain)이나
   * 계약(다음 model-call 경계 append)은 동일 = 인터페이스 parity 하드게이트.
   *
   * ★미지정 → 주입 없음(회귀 0). 스케줄러·워커·서브에이전트·비대화 turn 및 STEERING_ENABLED
   * off(기본) = 이 필드를 안 채움 = 현행 route input 바이트 동일. P0 = 계약·프리미티브·개입점만;
   * 어댑터 소비(drain/stream)는 P1(codex→openai→claude) 범위.
   */
  steering?: SteeringChannel;
  /**
   * 신규(additive, 2026-07-25) — **caller-supplied 함수 스키마 패스스루** (LLM 게이트웨이
   * 함수콜, ADR `docs/decisions/2026-07-25-llm-gateway-openrouter-scope.md` §Decision-5).
   * `toolPolicy`(tiguclaw 내장 도구 allowlist)와 시맨틱이 다르다 — 이 스키마들은 tiguclaw 가
   * *실행하지 않고* 모델에게 제시만 한다. 모델이 하나를 고르면 실행 대신
   * `RegionASdkOutput.externalToolCalls` 로 그대로 caller 에 반환. 미지정 = 현행(회귀 0).
   * 세 어댑터가 각자 SDK 별 방식으로 "제시하되 실행 가로채기"를 구현(#2 parity, region 소유).
   */
  externalTools?: Array<{ name: string; description?: string; parameters: unknown }>;
  /**
   * 신규(additive, 2026-07-25) — externalTools 와 짝(같은 ADR). OpenAI `tool_choice` 그대로:
   * "auto"=모델 재량, "none"=이번 turn 무시, "required"=반드시 하나 호출,
   * `{name}`=특정 함수 강제. 미지정 = "auto" 와 동형(어댑터 디폴트).
   */
  externalToolChoice?: "auto" | "none" | "required" | { name: string };
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
   * ★두 축을 **분리**한다 (2026-07-30, 세 어댑터 공통 계약):
   *   `inputTokens`/`cachedTokens` = **마지막 API 호출 1회** ("얼마나 찼나" — /status 컨텍스트 %)
   *   `*Total`                     = **턴 전체 합계**       (진짜 비용·진짜 적중률)
   *  섞으면 조용히 틀린다 — claude 가 누적합을 inputTokens 에 넣었을 때 실측 한 턴이
   *  cachedTokens=10,182,800(200K 창의 50.9배)이라 /status 가 "컨텍스트 ~3293%" 를 띄웠다.
   *  ★캐시 읽기 포함 여부도 통일: 셋 다 "이 호출이 실제로 먹은 입력"(비캐시+캐시읽기+캐시생성).
   *   Anthropic 원값은 캐시 읽기를 빼고 주므로 어댑터가 더해서 올린다.
   *  - claude: assistant 메시지 usage(호출 단위) + result `modelUsage`(누적) → Total.
   *  - codex: 마지막 turn 의 `response.completed` usage + iteration 합계 → Total.
   *  - openai: RunContext.usage(run 누적) — 미보고 빈번 → 생략.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * ★prefix 캐시 적중 입력 토큰 (2026-07-26, additive). 어댑터가 보고할 때만.
     * inputTokens 중 **재전송이지만 캐시로 처리된 몫** — 실효 비용은 (input - cached).
     * codex 처럼 매 반복 전체 재전송하는 루프에서 이 값이 곧 효율 지표다. 미보고 = 생략.
     */
    cachedTokens?: number;
    /**
     * ★턴 전체 합계 (2026-07-26, additive) — 도구 루프가 2회 이상 돈 턴에만 채운다.
     * codex 는 resume 이 없어 **매 iteration 마다 누적 입력을 통째로 재전송**한다.
     * 위 inputTokens 는 *마지막 한 번*이라 턴의 실제 비용을 iteration 수만큼
     * 과소평가한다. 진짜 비용·진짜 캐시 적중률은 이 합계 기준이다.
     */
    iterations?: number;
    inputTokensTotal?: number;
    cachedTokensTotal?: number;
  };
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
  /**
   * 신규(additive, 2026-07-25) — `externalTools` 로 제시된 스키마 중 모델이 실제로 호출을
   * 선택한 것들(LLM 게이트웨이 함수콜, ADR `2026-07-25-llm-gateway-openrouter-scope.md`
   * §Decision-5). 값이 있으면 호출자(게이트웨이)가 `finish_reason:"tool_calls"` 로 매핑하고
   * `content:null`. 미지정/빈 배열 = 현행(텍스트 응답, 회귀 0). 실행은 어댑터가 하지 않는다 —
   * 의도만 그대로 caller 에 반환(client-side function calling).
   */
  externalToolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
}

export interface RegionASdk {
  run(input: RegionASdkInput): Promise<RegionASdkOutput>;
}

/**
 * llm.activity — LLM-agnostic per-step 활동 관측 이벤트 (Round 1).
 *
 * 세 어댑터(claude/codex/openai) 공통. 대시보드가 "지금 무슨 도구를 쓰는 중"을
 * 실시간 표시하기 위한 *중립 rich* 이벤트. claude 전용 raw `llm.sdk_message`
 * 와는 별개 레이어(병존) — 그쪽은 firehose, 이쪽은 정규화된 활동 단위.
 *
 * EventBus publish 시:
 *   { type: "llm.activity", ts: Date.now(), payload: RegionAActivityPayload }
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
   *  - "text" (2026-07-13, additive·하위호환): 도구 호출 사이(및 턴 종료 직전)에
   *    낀 연속 assistant 텍스트 1덩어리(마크다운 원문). `seq` 는 tool activity 와
   *    *같은* 어댑터 로컬 카운터(`activitySeq`)에서 뽑는다 — 그래서 seq 정렬 순서 =
   *    실제 발행(=텍스트↔도구 인터리브) 순서가 된다. `_delta-stream.ts` 의
   *    `llm.delta`(고volume·비영속·타이핑 보조 렌더용)와는 별개 레이어 — 이쪽은
   *    "경계 확정된 완성 세그먼트 1건"으로, 저volume·영속 대상(기존 llm.activity
   *    denylist 파이프 그대로 탄다). 빈 세그먼트는 발행 안 함(closeSegment() no-op).
   */
  kind: "tool" | "turn" | "text";
  /**
   * 사람이 읽는 한 줄. kind="tool" 이면 도구명, kind="turn" 이면 코어스 문구.
   */
  label: string;
  /**
   * 그 활동 한 단계의 *중립 상세* — 사이드바 "자세히" 가 읽는 사람이 읽을 1줄
   * 요약(구조화 객체 아님, 단순 문자열). 예: "path=src/foo.ts" / "cmd: npm test".
   *
   * ★LLM-agnostic 하드게이트(원칙 #2): claude·codex·openai-agents 세 어댑터가
   * *동일 의미*로 채운다 — 각 어댑터가 이미 가진 도구 인자(tool input)에서 핵심만
   * 중립 요약. 한쪽만 채우면 #2 위반 — kind="tool"(per-tool activity)이면 셋 다
   * 채우고, 인자 정보가 없는 코어스 활동(kind="turn", openai spike floor)은 셋 다
   * 생략한다(= 정보 없으면 생략, optional).
   *
   * ★raw `llm.sdk_message`/SDK 내부 구조를 쏟지 말 것 — 사람이 읽을 중립 요약만.
   * 길면 어댑터에서 적당히 컷(현재 ~160자 상한).
   */
  detail?: string;
  /**
   * 도구 실행 단계 (2026-07-08, additive·하위호환). 미지정 = "start"(도구 시작, 기존 동작).
   *  - "start": 도구 호출 시작 — 대시보드가 새 스텝 렌더(기존과 동일).
   *  - "end"  : 같은 도구 완료 — 같은 좌표+같은 `seq` 로 1건 더 발행. 대시보드는
   *    (threadKey, adapter, seq)로 이미 렌더된 스텝을 찾아 `durationMs` 를 주석한다
   *    (새 스텝 만들지 않음). 못 찾으면 무시(best-effort).
   */
  phase?: "start" | "end";
  /**
   * 도구 실행 벽시계(ms). `phase:"end"` 에만 실린다 — 도구 시작→완료 구간 실측.
   * ★LLM-agnostic(#2): 측정 기전은 어댑터 로컬(codex=callTool race 구간,
   * claude/openai=tool_use→tool_result 구간)이나 필드 의미·단위는 셋 다 동일.
   */
  durationMs?: number;
  /**
   * 리치 렌더용 구조화 diff (2026-07-09, additive·하위호환·optional).
   * kind="tool" & 도구가 Edit/Write 일 때만 채운다(그 외 미설정). `phase:"start"` 에만
   * 실림 — 인자가 알려지는 시점.
   *
   * ★캡처/렌더 분리(ADR 2026-07-09): 여기(런타임)서 구조화만 하고, diff *뷰*(초록/빨강)
   * 는 대시보드 몫. 채널 무관 — 텔레그램은 안 그리지만 데이터는 채널 무관 payload 에 실려
   * events 로 영속(이력 복원·미래 채널 재사용 가능).
   *
   * ★LLM-agnostic 하드게이트(#2): 세 어댑터가 공유 빌더(`_activity-diff.ts`)로 동일하게
   * 채운다(detail 과 동형). 한쪽만 채우면 #2 위반.
   */
  diff?: ActivityDiff;
  /**
   * 리치 렌더용 도구 출력 프리뷰 (2026-07-09, additive·optional). diff 와 달리 *결과*
   * (tool_result)라 `phase:"end"` 에만 실린다 — Bash 출력·Read 내용·Grep/Glob 결과.
   * 화이트리스트(Bash/Read/Grep/Glob) 밖 도구는 미설정. 크기 캡(프리뷰).
   *
   * ★LLM-agnostic(#2): 세 어댑터가 공유 빌더(`_activity-output.ts`)로 동일하게 채운다.
   * ★캡처/렌더 분리(ADR 2026-07-09): 여기(런타임)선 프리뷰 텍스트만, 렌더는 대시보드 몫.
   */
  output?: ActivityOutput;
  /**
   * 텍스트 세그먼트 본문 (2026-07-13, additive·optional). `kind==="text"` 일 때만
   * 채운다 — 도구 경계 직전(또는 턴 종료)까지 누적된 연속 assistant 텍스트 원문
   * (마크다운, 모델이 생성한 그대로). `kind` 가 "tool"/"turn" 이면 항상 미설정.
   *
   * ★LLM-agnostic(#2): 세 어댑터가 공유 레이어(`_delta-stream.ts` `closeSegment()`)로
   * 동일하게 누적·경계 판단하고, 각 어댑터가 자기 `activitySeq++` 로 발행한다 —
   * 세그먼트 경계 정책은 공유, seq 출처는 도구와 동일(어댑터 로컬).
   */
  text?: string;
  /**
   * 서브에이전트 스폰 스텝 ↔ 백그라운드 잡 연결 (2026-07-13, additive·optional).
   * claude Task tool_use 처럼 어댑터가 이 스텝에서 관측 잡을 등록했을 때 그 `jobId` 를 실어
   * 대시보드가 인라인 스폰 스텝을 드로어 잡카드로 링크(클릭→점프·상태)한다. 어댑터가 jobId 를
   * 못 보는 경우(codex spawn_agent = 도구 핸들러가 생성)엔 미설정 → 프런트는 라벨로 감지해
   * 드로어 열기만(graceful). 세그먼트/도구 외 필드라 항상 optional.
   */
  jobId?: string;
  /**
   * 계획 승인(ExitPlanMode) 전체 계획 본문 (2026-07-19, additive·optional).
   * claude 가 plan 모드에서 `ExitPlanMode({plan})` 를 호출할 때 그 계획(마크다운)을 *잘리지
   * 않게* 실어 대시보드가 전체 렌더한다. `detail`(1줄 요약, ~160자)로는 계획이 잘려 사용자가
   * 계획을 못 보던 갭 수정(A안 — 계획 표시). `kind==="tool" & label==="ExitPlanMode"` 일 때만
   * 채운다(그 외 미설정). 크기 캡은 어댑터(과대 payload 방지).
   *
   * ★#2 노트: ExitPlanMode 는 Claude Code SDK 네이티브 도구(plan 모드) — codex/openai 모델은
   * 이 도구를 호출하지 않으므로 현재 claude 전용 필드다(존재하지 않는 도구의 parity 대상 아님).
   * 추상 "계획 승인" 능력의 3어댑터 parity 는 별건(인터랙티브 승인 UI = B안, 후속).
   */
  plan?: string;
}

/** 리치 도구 출력 프리뷰 (ADR 2026-07-09 슬라이스 2/3). */
export interface ActivityOutput {
  /** 출력 프리뷰 텍스트 (크기 캡 적용). */
  text: string;
  /** 크기 캡으로 잘렸나. */
  truncated?: boolean;
  /** 도구 실행 에러 결과인가 (렌더 붉은 틴트). */
  isError?: boolean;
}

/**
 * 리치 도구 렌더용 구조화 diff (ADR 2026-07-09 슬라이스 1).
 * Edit=old_string↔new_string 줄 diff, Write=쓴 내용 전부 추가.
 */
export interface ActivityDiff {
  /** 대상 파일 경로 (렌더 헤더 편의 — detail 과 중복이나 파싱 불요하게). */
  path?: string;
  /** 추가된 줄 수 (총계 — `lines` 컷 전 실제값). */
  added: number;
  /** 삭제된 줄 수 (총계 — `lines` 컷 전 실제값). */
  removed: number;
  /** 렌더용 줄들 (크기 캡 적용 — 초과 시 컷 + truncated). */
  lines: ActivityDiffLine[];
  /** `lines` 가 크기 캡으로 잘렸나. added/removed 카운트는 총계 유지. */
  truncated?: boolean;
  /**
   * 이 diff 가 **파일의 몇 번째 줄에서 시작**하는가(1-based). 구할 수 없으면 생략.
   *
   * ★못 구하면 **생략한다** — 지어내지 않는다. 파일이 없거나(도구 실행 후 관측), 너무 크거나,
   *  `old_string` 이 안 맞으면 없는 채로 간다. 화면은 번호 없이 그리면 그만이다.
   */
  startLine?: number;
}

/** diff 한 줄 — op(+추가/-삭제/공백=context) + 텍스트(개행 제외). */
export interface ActivityDiffLine {
  op: "+" | "-" | " ";
  text: string;
}

/**
 * llm.delta — LLM-agnostic 토큰 스트리밍 증분 관측 이벤트 (대시보드 L3 보조 렌더).
 *
 * 진실 소스: `docs/decisions/2026-06-25-dashboard-chat-cc-parity.md` §5.2 + §6.2(D6).
 *
 * 세 어댑터(claude/codex/openai) 공통 — 각자 *이미 텍스트가 지나가는 자리*에서
 * coalesce 후 fan-out. `llm.activity`(이산 step, 저volume, 영속) 와 다른 레이어:
 * delta = 연속 토큰 스트림(고volume, 영속 SKIP). 대시보드는 델타를 진행 버블에
 * progressive append 하다가 권위 전체본(`channel.message.out`) 도착 시 그 버블을
 * 전체본으로 *치환*(자가치유) — 델타 누적이 최종본과 미세 불일치해도 out 우선.
 *
 * EventBus publish 시:
 *   { type: "llm.delta", ts: Date.now(), payload: RegionADeltaPayload }
 *
 * ★turnNonce 없음 (D6 확정) — "nonce 제거 + 전체본 자가치유" 채택. 동시 turn 교차
 * 오염은 depth-0 가드(subagentDepth===0 && workerDepth===0 turn 만 발행)로 차단,
 * 순차 turn 빠른 전환의 미세 오귀속은 out 전체본 교체로 자가치유. "발행만 nonce"
 * 중간 상태 구현 금지(ADR §6.2).
 *
 * ★raw `llm.sdk_message`/SDK 내부 구조를 delta 에 넣지 말 것 — 순수 텍스트 증분만.
 */
export interface RegionADeltaPayload {
  /** 표시·필터·상관용 라벨 (라우팅 아님). 트리거 메시지의 채널. */
  channel: ChannelName;
  /** 진행 버블 상관 키 — 대시보드가 어느 버블에 append 할지. 트리거 메시지의 thread. */
  threadKey: string;
  /** 어느 LLM 어댑터가 흘렸는지 — parity 가시화 + 대시보드 색/그룹 단서. */
  adapter: "claude" | "codex" | "openai";
  /** 사용 모델 (있으면). 어댑터가 아는 시점에 박음, 모르면 생략. */
  model?: string;
  /**
   * 어댑터 로컬 단조 증가 시퀀스 (이 run() 호출 안에서 0,1,2…).
   * 대시보드가 델타 순서·유실을 감지. activity 의 seq 와 동일 의미·동일 카운터 패턴
   * (어댑터 함수 지역 변수라 동시 run 끼리 자연 격리).
   */
  seq: number;
  /**
   * 증분 텍스트 조각 — 이번 델타에서 *추가된 부분만*(누적본 아님).
   * coalesce(어댑터측 ~80ms ∥ ~120자) 후의 묶음일 수 있다.
   */
  delta: string;
}

/**
 * llm.tool_call_delta — LLM-agnostic 함수콜 스트리밍 증분 관측 이벤트 (LLM 게이트웨이 전용
 * 소비자, ADR `docs/decisions/2026-07-25-llm-gateway-openrouter-scope.md` §Decision-5).
 *
 * `RegionADeltaPayload`(순수 텍스트 증분)와 **형제 이벤트**로 신설 — ADR
 * `2026-06-25-dashboard-chat-cc-parity.md` §6.2 "llm.delta 는 순수 텍스트 증분만" 불변식을
 * `llm.delta` 필드 확장이 아니라 별도 타입으로 우회. `externalTools`(패스스루 함수 스키마)를
 * 받은 turn 에서만 발행 — 그 외 turn 은 발행처 자체가 없음(§2-c 의존).
 *
 * OpenAI 스트리밍 `delta.tool_calls[]` 와 동형 index-기반 조각 계약: 첫 조각에 id+name,
 * 이후 조각은 argumentsDelta(누적 아닌 증분) 만.
 *
 * EventBus publish 시:
 *   { type: "llm.tool_call_delta", ts: Date.now(), payload: RegionAToolCallDeltaPayload }
 */
export interface RegionAToolCallDeltaPayload {
  channel: ChannelName;
  threadKey: string;
  adapter: "claude" | "codex" | "openai";
  /** 어댑터 로컬 단조 증가 시퀀스 — llm.delta 의 seq 와 동일 패턴. */
  seq: number;
  /** OpenAI tool_calls[] 배열 위치. */
  index: number;
  /** 신규 tool_call 시작 조각에만(이후 조각은 생략). */
  id?: string;
  /** 신규 tool_call 시작 조각에만. */
  name?: string;
  /** 매 조각 — 누적 아닌 증분(text delta 와 동형 계약). */
  argumentsDelta?: string;
}

/**
 * skill.invoked — LLM-agnostic 스킬 호출 관측 이벤트 (텔레메트리 Phase 1.5).
 *
 * 진실 소스: `_workspace/skill_telemetry_architect_contract.md` §2.1.
 *
 * invoke_skill MCP 핸들러가 스킬 본문을 *성공 반환*하는 단일 지점에서 발행한다
 * (skill-registry.ts `createSkillInvokeMcpServer`). 세 어댑터(claude/codex/openai)가
 * 같은 팩토리를 per-call 호출하므로 발행 코드 한 벌 = 자동 parity(어댑터별 분기 0,
 * 원칙 2 하드게이트). 미발견·에러 분기는 발행 안 함 — "실제 호출"만 카운트.
 *
 * EventBus publish 시:
 *   { type: "skill.invoked", ts: Date.now(), payload: SkillInvokedPayload }
 *
 * generic 이벤트(turn_done·llm.activity 동형) — 코어는 *어느 스킬인지* 의미를 모름.
 * self-growth(데이터 평면)가 유일 구독자로 skill_usage 에 누적·P2 거버넌스 상관에 소비.
 * 코어는 skill_usage·self-growth 를 모른다(단방향). `ts` 는 EventBus 봉투에 있다
 * (payload 중복 금지 — turn_done 답습).
 */
export interface SkillInvokedPayload {
  /** 호출된 스킬명 (invoke_skill args.name 그대로). 어느 스킬이든 generic. */
  name: string;
  /** 표시·상관(P2)용 라벨 — 트리거 메시지의 채널. RegionAActivityPayload 동형. */
  channel: ChannelName;
  /** 표시·상관(P2)용 라벨 — 트리거 메시지의 thread. 세그먼트 상관 키. */
  threadKey: string;
  /** 어느 어댑터 경로에서 호출됐는지 — parity 가시화(분기 키 아님). */
  adapter: "claude" | "codex" | "openai";
}

/**
 * llm.turn_done / llm.turn_error — LLM-agnostic per-turn 종료 신호 (self-growth 입력).
 *
 * 진실 소스: `_workspace/selfgrowth_events_region_contract.md`.
 *
 * 발행처는 facade(`runPool`)의 `callAdapter` 래퍼 *단일 지점* — 세 어댑터를
 * parity 로 덮는다(어댑터별 분기 0, 원칙 2 하드게이트). 한 어댑터 run() 호출(=한 턴)이
 * 종료할 때마다 정확히 1회:
 *  - 성공(return) → llm.turn_done { ok:true }
 *  - 실패·타임아웃(throw) → llm.turn_error (+ llm.turn_done { ok:false } 미발행,
 *    아래 contract 참조: error 와 done 은 상호배타 — 한 턴 = 정확히 둘 중 하나 1회)
 *
 * llm.activity(per-step firehose)와 별개 레이어: activity 는 "지금 무슨 도구"이고,
 * 이쪽은 "한 턴이 어떻게 끝났나(효율·실패)" 의 turn-terminal 신호.
 *
 * ⚠ 관측 발행 전용 — 코어에 "claude 가 빠르니 claude 로 라우팅" 같은 어댑터별 라우팅
 * 분기를 만드는 입력으로 *코어 안에서* 쓰지 말 것(feedback_every_feature_llm_agnostic).
 * 학습·정책은 self-growth 플러그인(데이터 평면)에서.
 *
 * 메타-재귀 안전: self-growth 는 LLM 턴을 직접 돌리지 않으므로 이 이벤트 구독이
 * 또 turn_done/error 를 낳지 않는다(피드백 루프 0). 서브에이전트(subagentDepth)·
 * 워커(workerDepth)가 runRegionA 를 재귀 호출하는 경로는 *원래 사용자 턴의 하위 작업*
 * 으로 각자 1 이벤트를 내는 것이 정상이며(중복 아님), depth 필드로 self-growth 가 구분.
 */
export interface RegionATurnDonePayload {
  /** 표시·필터·집계용 라벨 (라우팅 아님). 트리거 메시지의 채널. */
  channel: ChannelName;
  /** 표시·필터·집계용 라벨 (라우팅 아님). 트리거 메시지의 thread. */
  threadKey: string;
  /**
   * 어느 어댑터가 이 턴을 돌렸는지. activity payload 와 동일 라벨 도메인
   * (facade 내부 "codex-oauth" → 사용자/관측 라벨 "codex" 정규화).
   */
  adapter: "claude" | "codex" | "openai";
  /** 사용 모델 (어댑터가 보고하면). spec.model "" (어댑터 디폴트) 거나 미보고면 생략. */
  model?: string;
  /** 이 턴(어댑터 run() 호출)의 wall-clock 소요. 항상 채움 (facade 가 측정 — 어댑터 무관). */
  durationMs: number;
  /** 항상 true (turn_done 은 성공 종료에만 발행). 분류 가독용 명시 필드. */
  ok: true;
  /**
   * usage 페이로드 의미 버전 (2026-07-30 도입, 현재 2). 없거나 1 = **옛 의미**
   * (claude 는 캐시 읽기 제외 증분). 같은 컬럼에 두 시대가 섞여 있으니 사후 집계는
   * 반드시 이 값으로 가를 것 — 날짜 손목록 말고.
   */
  usageSchema?: number;
  /**
   * 입력 토큰 — **마지막 API 호출 1회**(컨텍스트 참 정도). 턴 합계는 inputTokensTotal.
   * 캐시 읽기·생성을 **포함**한다(어댑터가 정규화). 캡처한 경우만.
   *  - claude: 마지막 parent assistant 메시지의 usage — 거의 항상 채워짐.
   *  - codex : 마지막 turn `response.completed` usage.input_tokens — 거의 항상.
   *  - openai: RunContext.usage 노출 시 — 스파이크 어댑터라 미보고 빈번 → 생략.
   * 거짓값 금지 — 못 얻으면 필드 자체를 생략(0 도 박지 않음).
   */
  inputTokens?: number;
  /** 출력 토큰. inputTokens 와 동일 출처·동일 생략 규칙. */
  outputTokens?: number;
  /** 캐시 적중 입력 토큰(2026-07-26). 실효 입력 = inputTokens - cachedTokens. 미보고 시 생략. */
  cachedTokens?: number;
  /** 도구 루프 iteration(=API 호출) 수. 2 이상일 때만. codex 는 매 iteration 전체 재전송. */
  iterations?: number;
  /** 턴 전체 입력 합계 — 진짜 비용(위 inputTokens 는 **마지막 호출 1회** 값). */
  inputTokensTotal?: number;
  /** 턴 전체 캐시 적중 합계 — 진짜 적중률 = cachedTokensTotal / inputTokensTotal. */
  cachedTokensTotal?: number;
  /**
   * 하위 작업 컨텍스트 — self-growth 가 채널 턴 vs 워커 vs 서브에이전트를 구분.
   *  - subagentDepth: spawn_agent child 면 ≥1, 메인 턴이면 0/생략.
   *  - workerDepth: 백그라운드 워커 작업이면 ≥1, 메인 턴이면 0/생략.
   * (depth>0 턴이 자체 turn_done 을 내는 건 정상 — 중복 아님. contract 참조.)
   */
  subagentDepth?: number;
  workerDepth?: number;
}

export interface RegionATurnErrorPayload {
  /** 표시·필터·집계용 라벨 (라우팅 아님). 트리거 메시지의 채널. */
  channel: ChannelName;
  /** 표시·필터·집계용 라벨 (라우팅 아님). 트리거 메시지의 thread. */
  threadKey: string;
  /** 어느 어댑터가 실패했는지 (turn_done 과 동일 라벨 도메인). */
  adapter: "claude" | "codex" | "openai";
  /** 시도한 모델 (있으면). spec.model "" 거나 미상이면 생략. */
  model?: string;
  /** 실패까지의 wall-clock 소요. 항상 채움 (타임아웃 진단·효율 학습용). */
  durationMs: number;
  /** 항상 false. turn_done(ok:true)과 대칭 — 분류 가독용. */
  ok: false;
  /**
   * 사용량 한도로 이 백엔드가 쉬는 **해제 시각**(epoch ms). 한도 실패일 때만.
   *
   * ★왜 페이로드에 싣나(2026-08-01, 사용자 지적): 429 원문에 `resets_at` 이 오는데
   *  사용자 대면 문구는 원문을 200자에서 잘라 **그 값 바로 앞에서 끊겼다**. 정작 우리는
   *  파싱해서 쿨다운까지 걸어 놓고 있었다 — **아는데 말을 안 한 것**이다.
   *  채널마다 문구를 다시 조립하지 않게 값으로 싣는다(대시보드·텔레그램 공용).
   */
  cooldownUntilTs?: number;
  /**
   * 실패 분류 (facade 단일 휴리스틱 — 어댑터별 분기 0).
   *  - "timeout": 1층 유휴 또는 2층 턴 타임아웃(Idle/TurnTimeoutError).
   *  - "model_rejected": 모델 부재·거부(isModelRejected 매칭) — 폴백 트리거 류.
   *  - "error": 그 외 일반 실패(네트워크·SDK·빈 응답 throw 등).
   */
  errorKind: "timeout" | "model_rejected" | "error";
  /** 이 실패 뒤에 시도할 다음 모델이 있나 — 없으면 UI 가 "다른 모델로 이어서" 라고 하면 안 된다. */
  hasFallback?: boolean;
  /**
   * 사람이 읽는 짧은 에러 요약 (errorDetail 결과를 cap). self-growth 가 "이 작업에서
   * 자꾸 X 에러" 를 군집화하는 학습 입력. PII/대형 본문 방지 위해 길이 cap.
   */
  message: string;
  /** turn_done 과 동형 하위 작업 컨텍스트. */
  subagentDepth?: number;
  workerDepth?: number;
}

// Legacy alias — V1 facade 호환 (plugin 진입점 import 무수정 게이트).
export type ClaudeRunInput = RegionASdkInput;
export type ClaudeRunOutput = RegionASdkOutput;
