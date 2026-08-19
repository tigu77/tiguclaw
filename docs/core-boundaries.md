# 코어 경계 지도 — 라우터·채널·권한 (신규 합류자용)

> 짝 문서: [`code-map.md`](code-map.md) 는 **무엇이 어느 파일에 있는지**(좌표),
> 이 문서는 **부팅·라우팅·권한이 어떤 순서로 엮이는지**(흐름)를 다룬다.

범위: `src/core/*.ts`(llm-runtime 제외), `src/core/entry|plugins|observers`,
`src/channels/`, `src/auth/`, `src/index.ts`, `src/cli.ts`, `bin/`.
경계 밖(llm-runtime 내부 어댑터 구현, store/)은 인터페이스만 언급.

## 1. 부팅 시퀀스 (`src/index.ts`, 순서대로)

1. **모듈 최상단 import 부작용** — `flushEnvLoadLog`(L2, `.env` 로드) → `net-config.js`
   import(L3, IPv4 우선 설정). 다른 무엇보다 먼저 있어야 한다는 주석 경고 있음.
2. `initFileLogging()`(L174) → 이후 모든 console.*가 `<home>/logs/daemon-*.log`로 미러.
3. `ensureHome()`(L208) → 런타임 홈 준비/시드, `migrateLegacyAgent()`(L213)로 레포
   `AGENT.md` 1회 마이그레이션.
4. `readSystem()` 바이트 체크(L221) — SYSTEM.md(작동 헌법) 비어있으면 부팅 로그에 경고.
5. `initStore()`(L231) → DB 준비. 직후 `setChannelSessionBindingLookup` 등록(L237),
   `restoreCooldowns()`(L250, 모델 쿨다운 Map 복원).
6. codex OAuth self-register 모듈 optional dynamic import(L256, 실패해도 무시).
7. `initEventBus()`(L268) → `startEventPersistence(bus)`(L272, 이벤트 DB 영속)
   → `setHookObserver()`(L278, 훅 발화를 EventBus로 배선).
8. **플러그인 로딩** — `loadPlugins(appRoot()/plugins, bus)`(L301, `core/plugins/loader.ts`).
   반환된 각 인스턴스를 capability(`channel`/`observer`/`trigger`/`service`)별로 분기해
   `getMcpServer`→MCP 등록, `channel`→`channels[]`에 push(시작은 아직 안 함),
   `trigger`/`observer`/`service`→즉시 `start*(bus)` 호출(L385~485). 코어에 채널이
   하드코딩되어 있지 않다 — cli/telegram도 전부 plugin(주석 L291).
9. `serializedHandler` 정의(L1925) + `registerWorkerHandler(serializedHandler)`(L2078,
   완료 워커 재주입이 메인 핸들러를 다시 부를 수 있게).
10. `SIGINT`/`SIGTERM`/`unhandledRejection`/`uncaughtException` 핸들러 등록(L2182~2203).
11. **채널 시작** — `for (const ch of channels) await ch.start(serializedHandler)`(L2205~2216).
12. 채널 presence 등록(L2223~2258, `setChannelPresence`).
13. `recoverInterruptedJobs()`(L2261, 재시작으로 끊긴 워커 사용자 통지) →
    `killAllBgShells` 부팅 reaper(L2264 부근, 고아 백그라운드 셸 정리).

**의존 관계 요지**: 로그 파일링 → 홈 준비 → 스토어 → 이벤트버스 → 플러그인 로드
(채널 push만, start는 아직) → 시그널 핸들러 → **채널 실제 start (리스닝 시작)** →
presence 노출 → 워커 복구. "리스닝"은 플러그인 로드가 끝난 뒤 맨 뒤쪽 단계다.

## 2. 메시지 라우팅 경로

```
Channel.start(serializedHandler)
  → serializedHandler(msg)  [index.ts:1925]
      - /stop 등 아웃오브밴드 처리, steering 개입점 체크
      - enqueueThreadTurn(threadKey, () => handler(msg))  [thread별 직렬 큐, index.ts:2071]
  → handler(msg)  [index.ts:719]
      1. publishInboundEcho (대시보드 낙관 버블용 관측 이벤트)
      2. 세션 정규화: canonicalSessionChannel(threadKey, channel)
      3. 하드코딩 슬래시 fast-path: /reset,/clear,/agents,/memo,/forget,/model,/models,
         /status 등 → 여기서 끝나면 route() 안 탐 (LLM 턴 0)
      4. expandCommand()  [core/entry/command-registry.ts] — 사용자 정의 슬래시 매크로
         (.claude/commands/, plugins/<name>/commands/) → effectiveText 치환
      5. runUserPromptSubmitHooks()  [core/entry/hook-runner.ts, index.ts:1513]
         exit 2 → 여기서 즉시 차단 반환. exit 0 stdout → effectiveText 앞에 prepend
      6. replyToText(답글 인용) 주입
      7. route(msg, { abortSignal, session, steering })  [core/router.ts:42]
           - 세션 id 정규화(resolveSessionId), 모델 override 조회
             (/model 세션 override > 엔드포인트 modelProfile > 기본 풀)
           - runClaude(input, modelOpts)  = core/claude.ts 의 facade
             → llm-runtime의 runRegionA (경계 밖, 3개 어댑터 풀 폴백)
      8. runStopHooks()  [Stop 훅, 응답 후처리]
      9. stripInternalRuntimeScaffolding(replyText)  [outbound-sanitize.ts, echo 방지]
      10. msg.reply(replyText) + bus.publish("channel.message.out")
```

중간에 끼는 것: 권한 게이트는 여기(라우터)에 없고 **어댑터 안**(`bypassPermissions` +
`disallowedTools`, §5 참조)에 있다. 훅(UserPromptSubmit/Stop)은 채널 입구/출구
단일 지점(`index.ts` handler)에서 강제되며, PreToolUse/PostToolUse/SubagentStop은
경계가 달라 각 어댑터의 도구 호출 지점·`worker-jobs.ts`가 호출한다
(`core/entry/hook-runner.ts` 전체가 실행 엔진, 3어댑터 공용).

`route()` 자체는 "순수 운반자"로 설계됨 — abortSignal/toolPolicy/steering/modelProfile을
소비하지 않고 그대로 `runClaude` input에 전달한다는 원칙이 주석에 반복 명시(router.ts
L44-97). 채널명으로 분기하는 코드는 라우터에 없음(§0 규율).

## 3. 시스템 프롬프트 조립 (`src/core/prompt-assembly.ts`)

담당 파일은 이 하나. 조립 순서·채널 배치의 **단일 정의점**은
`buildContextSlots()`(L409)이며, 3개 어댑터(claude/codex/openai, llm-runtime 소관)가
이 배열을 각자 복제해서 동일 순서를 지킨다(경계면 — 실제 소비는 어댑터 쪽).

- 슬롯은 두 "채널"로 나뉜다: `"system"`(어댑터 시스템 프롬프트, 프리픽스 캐시 적용)
  vs `"user"`(user 프롬프트의 `<system-reminder>` 블록, 캐시 밖).
- **system 채널**(안 변하는 것): `system`(SYSTEM.md, `identity.ts:readSystem`),
  `skillIndex`, `agentIndex`, `modelProfiles`(depth 0만, `formatModelProfiles`),
  `selfGrowth`(SELF_GROWTH.md 확정 지침, `formatSelfGrowthDirectives`, L102),
  `agentPathHint`, `agent`(AGENT.md, `identity.ts:readAgent`), `agentWarn`.
  AGENT.md 3인방은 일부러 **꼬리**에 둠(자주 바뀌므로 앞쪽 캐시 안 깨뜨리려고, L423 주석).
- **user 채널**(턴마다 변함): `env`(날짜 등), `convoContext`(현재 채널/dest_target,
  `formatConversationContext`), `foreignDelta`(claude 전용), `memoryIndex`,
  `memorySnippet`(검색된 메모리).
- `splitSystemContext()`(L446)가 실제로 채널별로 갈라 `stable`/`volatileParts`를
  만들고, `composeSystemChannel()`(L468)이 `[어댑터 sysprompt] + [stable]`을 이어붙이며,
  `assembleUserPrompt()`(L325)가 `volatileParts`를 `<system-reminder>` 태그로 감싸
  user 프롬프트 앞에 붙인다.
- 스킬/에이전트 인덱스 자체의 실제 스캔·포맷은 이 파일 밖(별도 모듈, 미확인 — 범위 밖
  가능성 높음)이고, 여기서는 문자열 슬롯으로만 다룬다.

## 4. 플러그인 로딩 계약 (`src/core/plugins/loader.ts`)

- 각 `<pluginsRoot>/<dir>/package.json`의 `"tiguclaw"` 마커 객체를 계약으로 삼는다:
  `{ schemaVersion, kind: string|string[], name, entry }`(L58-65).
- `kind`(capabilities)는 `channel|observer|trigger|service` 중 하나 이상(L77
  `KNOWN_CAPABILITIES`). 모르는 kind만 있으면 조용히 skip.
- `entry`는 plugin 디렉토리 기준 상대경로, **default export가 인자 없는 class**여야
  한다(`new Ctor()`, L187). 한 인스턴스가 여러 capability를 겸할 수 있다(hybrid).
- `resolveEntry()`(L42)가 built(dist)/source(tsx) 런타임을 흡수: `.ts`가 없고 `.js`
  형제가 있으면 `.js` 로드, 사용자 drop-in `.ts`면 tsx 온디맨드 등록.
- 로더는 **인스턴스화만** 한다 — `start*()` 호출은 `src/index.ts`가 capability별로
  분기(§1 참조). 채널이면 `startChannel(handler)` 우선, 없으면 `start(handler)` fallback;
  observer/trigger/service도 각각 `start{Observer,Trigger,Service}(bus)` 우선 폴백 패턴.
- 인스턴스가 `outbound`(ChannelOutbound) 또는 `getMcpServer()`를 duck-typing으로
  노출하면 코어가 각각 `registerChannelOutbound`/`registerMcpServer`에 등록.
- 격리: manifest parse/import/인스턴스화/각 start 실패는 전부 try/catch로 다음
  플러그인을 막지 않고, `eventBus.publish("plugin.error")`로 관측됨.
- `settings.json`의 `modules.disabled[]`에 이름이 있으면 로드 자체를 스킵
  (`isModuleDisabled`, loader.ts L167).
- `Channel` 인터페이스 계약은 `src/channels/types.ts`: `name`, `status?`,
  `start(handler)`, `stop()`, `outbound?`. `MessageHandler = (msg: IncomingMessage) => Promise<void>`.
  `IncomingMessage`는 LLM-agnostic 중립 필드 집합(text/attachments/session/channelAddress/
  correlationId/synthetic 등) — 어댑터가 절대 읽지 않는 필드들에 대한 주석이 반복 강조됨.

## 5. 권한 게이트 (`src/auth/permissions.ts`)

- 파일은 27줄, 실제 로직 없음 — 정책의 **단일 진실 소스**(데이터)만 제공:
  - `DISALLOWED_TOOLS: readonly string[] = []`(L20) — **현재 빈 배열**.
  - `DISALLOWED_URLS: readonly string[] = []`(L29) — **현재 빈 배열**.
- 실제 차단 기제(claude 어댑터, `llm-runtime/adapters/claude-agent-sdk.ts:782,789`):
  `permissionMode: "bypassPermissions"` + `disallowedTools: [...DISALLOWED_TOOLS,
  "AskUserQuestion"]`. 즉 V1 정책은 "전부 허용 + 하드코딩된 AskUserQuestion 1개만
  차단"이고, 회색지대(위험한 Bash 명령 등)는 전부 SYSTEM.md의 LLM 판단에 위임한다는
  설계(파일 상단 주석, L13-19).
- `DISALLOWED_TOOLS`/`DISALLOWED_URLS`는 `file-ops-mcp.ts`(경계 밖, llm-runtime)의
  Bash/WebFetch pre-check에서도 재사용됨(정책 소스 1개 원칙).
- `src/scripts/doctor.ts`가 부팅 진단 시 두 리스트가 빈 배열인지 보고(정상 상태로 취급).
- **평가**: 현재 코드베이스 시점(2026-08-08) 기준 실질 차단 리스트는 비어 있다 —
  "권한 게이트"는 인프라만 깔려 있고 실제 정책 추가는 아직 없음. 추가 시 "docs/decisions/
  또는 architect contract 갱신을 거친다"는 절차 주석이 있음(L16-18).

## 6. 함정 (★ 경고·과거 사고 흔적)

- **env 로드 순서**: `load-env.js`/`net-config.js`는 반드시 다른 import보다 먼저 —
  안 지키면 `.env` 오적용·IPv6 블랙홀로 텔레그램 전멸(과거 "409 봇 충돌 사고",
  index.ts L2-3, L176-179).
- **채널→세션 바인딩 조회 미등록 시 조용히 무시**: `/sessions`로 고른 세션이 무시되고
  전부 기본 세션으로 감 — 등록 실패를 반드시 로그로 드러내야 함(index.ts L232-246).
- **쿨다운 미복원 시 재부팅마다 죽은 백엔드 재시도**: 실측 07-27 "부팅 22회 ↔ 429 22건"
  (index.ts L247-250).
- **SYSTEM.md 빈 상태가 조용함**: 미러 실패해도 에러 없이 헌법 0바이트로 진행 —
  부팅 로그 1회 경고 + `/status`만이 알림(index.ts L215-229).
- **hook 손자 프로세스가 stdio를 물고 있으면 PreToolUse가 영원히 pending**:
  `spawn timeout`은 `sh`만 죽이고 손자(`tail -f &` 류)가 파이프를 상속하면
  `close` 이벤트가 안 옴 → 하드 백스톱(HOOK_BACKSTOP_GRACE_MS=5s) 없으면 턴이 조용히
  멈추고 `/stop`도 못 풀음(hook-runner.ts L278-302, 2026-07-28 실사고).
- **재시작이 진행 중 턴을 죽여도 사용자에게 침묵**: 2026-08-01 A5 실사고
  — 00:10:42 질문 → 00:13:22 재시작 → 7분 뒤 "응답 없다" 신고. `shutdown()`이
  이제 채널 stop 전에 `notifyInterruptedTurns` + `llm.turn_error` 이벤트 발행을
  선행(index.ts L2088-2131). 자식 프로세스 정리도 **1500ms force-exit 백스톱**보다
  먼저 와야 해서 shutdown 맨 앞으로 옮겨짐(L2132-2157).
- **프리픽스 캐시 배치 실수 = 캐시 무효화 연쇄**: system/user 채널 배치를
  `contextSlotKeys()`/`buildContextSlots()`(prompt-assembly.ts) 밖에서 개별 판단하면
  안 됨 — 새 슬롯의 `channel`을 잘못 고르면(특히 optional 슬롯은 타입 강제가 안 먹혀
  검사망에서 빠짐, L389-394 주석) 매 턴 캐시가 깨짐(실측: 캐시적중률 11.7%였던 과거
  회귀, L373-380).
- **로그 tail을 파일 전체 읽기로 구현하면 안 됨**: `readFileSync` 전체 읽기는 5.8MB+
  로그에서 이벤트 루프 정지·V8 문자열 상한 초과 위험 — 끝에서 512KB만 읽는 구조로
  교체됨(index.ts L534-598, `buildLogTail`).
- **모델 override 저장은 원문이 아니라 canonical 재파싱 결과**를 저장해야 함
  (router.ts L119, "DB에 구버전 무효 문자열 남아있을 가능성" 대비 빈 풀 가드 존재).
- **DISALLOWED_TOOLS 확장 시 정책 소스 분산 금지**: `file-ops-mcp.ts`와
  `claude-agent-sdk.ts` 양쪽이 이 배열을 참조하므로, 새 차단 룰은 이 배열에만 추가
  (다른 곳에 별도 하드코딩하면 정책이 두 곳이 됨).

## 미확인 (범위 밖 또는 시간상 미검증)

- 스킬 인덱스/에이전트 인덱스의 실제 스캔·렌더 로직 파일 위치(prompt-assembly.ts는
  문자열 슬롯만 다룸, 생성 쪽은 별도 모듈로 추정).
- `runRegionA`/3어댑터 폴백·쿨다운 세부 로직(llm-runtime 내부, 명시적으로 타 에이전트
  소관).
- `store/` 쪽 세션·메모리 스키마(threadkey.ts, sessions.ts 등은 계약 지점만 확인).
- PreToolUse/PostToolUse 훅이 각 어댑터에서 정확히 어느 줄에서 호출되는지(어댑터
  내부, llm-runtime 경계 밖).
