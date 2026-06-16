# tiguclaw

항상 떠있는 AI 비서. **Claude Code가 할 수 있는 모든 것**에 더해, 여러 LLM을 동시에 사용하고, CLI · Telegram 등 다채널 입력을 단일 인격으로 관장하는 데몬.

## 시작하기 (자가호스트)

자기 머신/서버에 직접 설치해 쓰는 비서다. **설치 전 [`docs/security.md`](docs/security.md) 신뢰 모델을 꼭 읽어라** — 비서는 *당신 머신*에 쉘·파일 접근 권한을 갖는다(Claude Code와 동일한 자기-선택).

**준비물**: Node 20+ · git · LLM provider 1개(아래 중 택1) · (선택) 텔레그램 봇.

| LLM provider | 진입 |
|---|---|
| Anthropic API 키 | console.anthropic.com 에서 발급 (가장 쉬움, 종량) |
| OpenAI API 키 | platform.openai.com (종량) |
| codex (ChatGPT 구독) | 설치 후 `npm run codex-auth` 로 OAuth |

**설치 흐름 (원샷):**

```bash
git clone <repository-url> && cd tiguclaw-v2
npm install        # 의존성 (better-sqlite3 네이티브 빌드 포함)
npm run onboard    # ★ 원샷: 설정 마법사(.env) → (codex)OAuth → 데몬 등록 → 검증
```

`onboard` 하나로 설정·인증·상시 등록·검증이 순서대로 끝난다. 설치 후 **텔레그램에서 봇에게 메시지**를 보내면 응답한다 (마법사에 넣은 소유자 ID만 허용 — allowlist 가 비면 봇은 잠긴다).

**전역 `tiguclaw` 명령** (선택): `npm link` 후 `tiguclaw onboard` · `tiguclaw status` · `tiguclaw restart` · `tiguclaw logs` 등으로 어디서나 사용.

**개별 단계로** 하려면: `npm run init` / `npm run codex-auth` / `npm run daemon:install` / `npm run doctor` (포그라운드 개발은 `npm run dev`).

**데몬 관리** (macOS launchd):
`npm run daemon:status` · `daemon:restart`(코드 변경 적용) · `daemon:logs` · `daemon:uninstall`.

**주의:**
- `.env` 는 봇 토큰·LLM 키를 담는다 — **절대 커밋·공유 금지**(gitignore 처리됨).
- LLM 호출 **비용은 본인 부담**(종량 키 또는 구독).
- 자동 등록은 현재 **macOS(launchd)** 검증. linux/windows 는 수동 supervisor 로 실행(`npm run daemon:install` 이 명령 안내) — 자동화는 후속(`docs/distribution-plan.md` Phase 2).

## 핵심 원칙 (변경 금지)

1. **Claude Code 슈퍼셋 — 능력 매트릭스 차원** — Claude Code가 할 수 있는 일은 무엇이든 가능해야 한다. 파일 ops · 코드 실행 · 웹 · MCP · 서브에이전트 · 스킬 · 플러그인 · 훅 · 슬래시 명령 · 태스크 · 플랜 모드 — 모두. 단, *그 능력을 Claude LLM 으로만 실행* 한다는 종속은 거절 — 어떤 LLM 으로도 실행 가능해야 한다 (2026-05-17 의도 정정, `docs/decisions/2026-05-17-llm-agnostic-vision.md`). 이 위에 다음 원칙들을 얹는다.
2. **멀티 LLM 동시 사용** — Claude만이 아니라 OpenAI · Google · 로컬 모델까지 작업별로 동시 운용. 라우터가 작업 특성을 보고 모델을 결정하고, 사용자가 명시적으로 지정할 수도 있다.
3. **항상 떠있다** — 데몬으로 상시 실행. 사용자 명령 외에 cron · 웹훅 · 알림으로 능동 행동.
4. **다채널 단일 인격** — CLI에서 시작한 대화를 Telegram에서 이어갈 수 있다. 채널은 입력 컨텍스트일 뿐이고 비서는 한 명.
5. **진짜 일만 직접 만든다** — Claude Agent SDK · provider별 LLM SDK · MCP가 주는 능력은 재구현하지 않는다. 데몬 · 채널 · 세션 · 라우터 · 권한 게이트만 직접 만든다.

## 비전 — 마이크로커널 + 플러그인 생태

**5종 코어는 작고 안정적으로 둔다. 나머지는 전부 플러그인으로 위임 — 채널·도구·스킬·트리거·자율 학습.** 코어 LOC 는 시간이 가도 안 늘어나고, 능력은 플러그인으로 무한 확장. 플러그인 패턴은 Claude Code 의 plugin/skill/MCP/hook 컨벤션을 그대로 차용 (원칙 1 슈퍼셋의 합리적 귀결).

```
┌─ 5종 코어 (직접 만드는 일) ─────────────────────────────────┐
│  1. LLM 런타임      (src/core/claude.ts + llm-runtime/)     │
│  2. 라우터          (src/core/router.ts)                    │
│  3. 권한 게이트     (src/auth/permissions.ts + canUseTool)  │
│  4. 채널 어댑터 IF  (src/channels/types.ts)  ← 플러그인 슬롯 │
│  5. 메모리 인프라   (AGENT.md + SQLite + V3 MCP 4 tools)    │
└──────────────────────────────────────────────────────────────┘
       │
       ▼ (플러그인 영역 — CC 패턴 그대로 위임)
┌─ (a) 채널         @tiguclaw/channel-* (CLI·Telegram·Dashboard·Slack…)
├─ (b) 도구 MCP    .mcp.json + SDK in-process MCP
├─ (c) 스킬        tiguclaw 컨벤션 — <home>/skills · <cwd>/skills · <cwd>/plugins/*/skills
├─ (d) 자동화      cron · webhook · hook  (트리거 = 채널의 한 종류)
└─ (e) 자율 학습   <cwd>/plugins/  (self-improving-agent 등 + <home>/AGENT.md)
```

> **런타임 디렉터리 = tiguclaw 자체 컨벤션 (`.claude` 아님).** 위 (a)~(e) 의 능력은
> 런타임 홈 `TIGUCLAW_HOME`(기본 `~/.tiguclaw`, dev `./tiguclaw-dev`) 공통 스코프 ∪
> 프로젝트 cwd 스코프 ∪ `<cwd>/plugins` 앱 번들에서 발견·병합(dedup: project>plugin>user)된다.
> `.claude` 는 tiguclaw 를 *Claude Code 로 개발하는 레포 한정* 이며 런타임은 쓰지 않는다.
> 진실 소스: ADR [`docs/decisions/2026-05-24-v9-runtime-home.md`](docs/decisions/2026-05-24-v9-runtime-home.md).

**Phase 로드맵:** A(비전 박기 + 시연) → B(V1 관리 Must 4종 — 발견·설치·권한·관측, **dashboard 첫 시민**) → C(V2 Should 4종 — 활성토글·충돌·격리·제거) → D(V3+ Could — 버전 매트릭스·자율 학습 정련).

전체 결정·근거·관리 9영역 우선순위·미해결 질문은 [`docs/decisions/2026-05-15-plugin-ecosystem-vision.md`](docs/decisions/2026-05-15-plugin-ecosystem-vision.md).

## 구현 원칙 (방법론)

위 5개가 **무엇을** 만드는가에 대한 원칙이라면, 아래는 **어떻게** 만드는가에 대한 메타 원칙. 모든 PR·제안에 적용.

> **언제나 단순하고 견고하게.** 단순함과 견고함은 동시에 만족해야 한다. 둘 중 하나만 가진 코드는 거부 또는 재작성.

- **단순함** — 적은 부품, 적은 분기, 적은 추상화. 한 줄로 되면 한 줄. 추상화는 최소 3번 반복된 후에. 화려한 메타프로그래밍·미래 확장 가능성으로의 일반화 금지.
- **견고함** — 예외 경로 명시, 외부 의존이 죽어도 데몬은 산다. happy path만 동작은 금지. 단, 가짜 견고함(불필요한 try/catch·defensive copy·validation 폭주)은 복잡도만 늘리므로 금지.
- **트레이드오프** — 단순함↔견고함 충돌 시 견고함 우선(데몬은 죽으면 안 된다). 단순함↔성능/기능 충돌 시 단순함 우선(나중에 측정 후 추가). 단순함↔일반성 충돌 시 항상 단순함.
- **판단 기준** — "이 코드가 6개월 후 새벽 3시 알람 받고 디버깅할 때 명확한가?"

## Claude Code 능력 매트릭스 (모두 커버)

| 능력 | Claude Code | tiguclaw | 구현 위치 |
|---|---|---|---|
| 파일 ops (Read/Write/Edit/Glob/Grep) | ✅ | ✅ | Claude Agent SDK |
| 코드 실행 (Bash/PowerShell) | ✅ | ✅ | Claude Agent SDK |
| 웹 검색 · 페치 | ✅ | ✅ | Claude Agent SDK |
| MCP 서버 (stdio/SSE/HTTP) | ✅ | ✅ | Claude Agent SDK + 데몬 로더 |
| 서브에이전트 | ✅ | ✅ | 디렉터리 컨벤션(`<home>`/`<cwd>`/plugins) — claude: SDK `options.agents` 주입 + native Task / codex: spawn_agent MCP 브리지 |
| 스킬 | ✅ | ✅ | 디렉터리 컨벤션(`<home>`/`<cwd>`/plugins) + invoke_skill MCP (양 어댑터 동일, LLM-agnostic) |
| 플러그인 (마켓플레이스 포함) | ✅ | ✅ | 디렉터리 컨벤션 + 데몬 로더 |
| 훅 (pre/post tool, user-prompt 등) | ✅ | ✅ | 데몬에서 강제 |
| 슬래시 명령 | ✅ | ✅ | 채널 어댑터에서 파싱 |
| 태스크 관리 (TaskList) | ✅ | ✅ | Claude Agent SDK |
| 플랜 모드 | ✅ | N/A (대화형 전용) | 권한 게이트가 안전 통제 대체 |
| 자동 메모리 | ✅ | ✅ | 자체 store + 컨텍스트 빌더 |
| 백그라운드 태스크 | ✅ | ✅ | 데몬 |
| IDE 연결 (VSCode/JetBrains) | ✅ | 추후 (채널로 확장) | 채널 어댑터 |
| **+ 멀티 LLM 동시 사용** | ❌ | ✅ | 라우터 + 어댑터 풀 (claude/codex/openai) |
| **+ Telegram / HTTP 채널** | ❌ | ✅ | 채널 어댑터 |
| **+ 항상 떠있기** | ❌ | ✅ | 데몬 |
| **+ cron · 웹훅 능동 트리거** | ❌ | ✅ | 트리거 시스템 |

Claude Code 능력은 빠짐없이 그대로, 거기에 ✚ 4가지를 더한다. 이게 가치 제안의 전부.

## 단일 LLM 런타임 (영역 가르기 폐기)

**모든 입력은 단일 파이프라인을 탄다 — provider:model 어댑터 풀(claude/codex/openai) + 폴백.** "단발 호출(요약·번역)" vs "에이전틱(도구 루프)" 으로 영역을 가르지 않는다 — 어떤 LLM 이든 같은 능력 = 풀 에이전트(LLM-agnostic parity). 깊은 사고·모델 선택은 routing prefix 가 아니라 비서가 부리는 능력 — 비서가 상위 모델 서브에이전트를 spawn 하거나 사용자가 자연어로 지정한다. (2026-05-27 V8 영역 통합, `docs/decisions/2026-05-27-region-unification.md`.)

| 차원 | 처리 |
|---|---|
| 모든 작업 (Claude Code 호환·코딩·요약·번역·분류 등) | 단일 파이프라인 → `runClaude`(어댑터 풀) |
| 모델 선택 | `REGION_A_MODELS`(provider:model 콤마 폴백) |
| 깊은 사고 / 등급 | agent 정의 `model: high/mid/low` → `MODEL_TIER_*` 풀 (서브에이전트) |
| 비전 · 음성 등 모달리티 | 어댑터 native 능력 (어댑터 풀 안에서) |

## 직접 만들 것 vs 라이브러리에서 받을 것

| 항목 | 직접 만듦 | 라이브러리 |
|---|---|---|
| 에이전틱 도구 사용 루프(Claude) | | Claude Agent SDK |
| 멀티 프로바이더 LLM 호출 | | provider별 어댑터 풀 (Claude Agent SDK · @openai/agents · codex OAuth) |
| MCP 클라이언트 · 서버 | | 표준 SDK |
| 데몬 / 항상 떠있기 | ✅ | |
| 채널 어댑터 (CLI/Telegram/HTTP) | ✅ | |
| 라우터 (모델 선택 · 작업 분기) | ✅ | |
| 세션 · 장기 메모리 스토어 | ✅ | |
| 트리거 시스템 (cron/웹훅) | ✅ | |
| 권한 게이트 | ✅ | |
| 슬래시 명령 파싱 (채널 입구) | ✅ | |
| 훅 강제 실행 (pre/post tool) | ✅ | |
| 플러그인 · 스킬 디렉터리 로더 | ✅ | |

## 스택 결정

- **언어**: TypeScript / Node 20+
- **LLM 런타임**: `@anthropic-ai/claude-agent-sdk`(claude 어댑터, 첫 시민) + `@openai/agents`(openai) + codex OAuth — provider별 어댑터 풀 (단일 파이프라인)
- **Telegram**: `grammy` 또는 `node-telegram-bot-api`
- **HTTP**: Hono 또는 Fastify
- **DB**: SQLite (`better-sqlite3`), 추후 필요시 Postgres
- **배포**: Linux 서버 + Docker
- **클라이언트**: Mac/Windows에서 Node CLI

자세한 결정 근거는 `docs/architecture.md`.

## 디렉터리 구조 (예정)

```
tiguclaw/
├── README.md
├── docs/
│   └── architecture.md
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts            # 데몬 진입점
│   ├── core/
│   │   ├── router.ts       # 단일 파이프라인 dispatch
│   │   ├── claude.ts       # LLM 런타임 facade (runClaude → llm-runtime 어댑터 풀)
│   │   └── llm-runtime/    # provider별 어댑터 (claude/openai/codex) + capabilities
│   ├── channels/
│   │   ├── types.ts        # Channel 인터페이스
│   │   ├── cli.ts
│   │   └── telegram.ts
│   ├── store/
│   │   ├── sessions.ts
│   │   └── memory.ts
│   ├── triggers/
│   │   └── cron.ts
│   ├── auth/
│   │   └── permissions.ts  # 단일 정책 차단 리스트
│   ├── hooks/
│   │   └── runner.ts       # Claude Code 훅 실행기
│   └── loaders/
│       ├── skills.ts       # 스킬 디렉터리 로더
│       └── plugins.ts      # 플러그인 디렉터리 로더
├── plugins/                # Claude Code 플러그인 호환 영역
└── skills/                 # Claude Code 스킬 호환 영역
```

## 셋업

새 머신에서 1 회 다음 5 단계로 끝.

1. **의존성 설치**
   ```
   npm install
   ```
2. **환경 파일 복사**
   ```
   cp .env.example .env
   ```
3. **키 발급 후 `.env` 편집**
   - `ANTHROPIC_API_KEY` (필수) — https://console.anthropic.com/
   - `TELEGRAM_BOT_TOKEN` (선택, Telegram 채널 활성화 시) — @BotFather 와 대화
   - `REGION_A_MODELS` / `MODEL_TIER_*` 는 `.env.example` 기본값으로 시작 가능
4. **셋업 검증**
   ```
   npm run doctor
   ```
   환경변수·DB·채널·LLM 런타임·권한 5 섹션이 모두 ✅ 또는 ⚠️ (선택 비활성) 인지 확인. ❌ 가 있으면 마지막 「다음 단계」 안내를 따른다.
5. **데몬 실행**
   ```
   npm run dev
   ```
   stdin 에 한 줄을 입력하거나, Telegram 봇에 메시지를 보내면 응답이 돌아온다.

> **dev 레포 vs 런타임 홈 경계.** 위 셋업의 `.claude/memory/` junction 은 tiguclaw 를
> *Claude Code 로 개발할 때* 쓰는 개발용 자동 메모리(사용자 선호·피드백)다 — 「비고」 참조.
> 데몬이 실행 중 prepend 하는 **런타임 인격(돌쇠)** 은 `.claude` 가 아니라
> 런타임 홈의 `<home>/AGENT.md`(`<home>` = `TIGUCLAW_HOME`, 기본 `~/.tiguclaw`)다.
> 즉 `.claude/*` = 개발 레포 한정, `<home>/*` = 앱 런타임. (ADR `2026-05-24-v9-runtime-home.md`)

## 비전 — 마이크로커널 + 플러그인 생태

장기 방향은 **5종 코어 마이크로커널 + 모든 능력 플러그인 위임**. 코어는 LLM 런타임 facade(`src/core/claude.ts` + `src/core/region-a/`)·라우터(`src/core/router.ts`)·권한 게이트(`src/auth/permissions.ts`)·채널 contract+메모리 인프라(`src/channels/types.ts` + `src/store/*` + `src/core/memory.ts`) 5종만. 그 외 채널 구현체·도구 MCP·스킬·자동화 트리거·자율 학습은 모두 플러그인 영역 — Claude Code 의 plugin/skill/MCP/자동 메모리 컨벤션을 그대로 차용한다. 단계는 Phase A(관측 dashboard 첫 시민 — 핵심 위험 해소) → B(트리거 cron) → C(외부 도구 MCP+스킬 적재) → D(자율 학습 정련). 코어 LOC 는 시간이 가도 ±30% 안에서 안정, 능력은 플러그인으로 무한 확장. 자세한 결정과 관리 9영역(로딩·격리·버전·설정·관측·에러복구·테스트·디스커버리·거버넌스) 정의는 `docs/decisions/2026-05-15-plugin-ecosystem-vision.md`.

**LLM-agnostic 방향 (2026-05-17 의도 정정, 2026-05-27 영역 통합으로 완성).** LLM 런타임의 모양은 **SDK-agnostic 인터페이스 + provider 별 어댑터** — 핵심 인터페이스 면(run · session resume · 도구 실행 · MCP 등록 · permission 게이트 · hook · 자동 발견 · stream fan-out 8 면)을 우리가 정의하고, Claude Agent SDK 가 *첫 어댑터*, @openai/agents / codex OAuth 가 *후속 어댑터*. 영역 A/B 가르기를 폐기하고 모든 입력이 이 단일 어댑터 풀을 타게 함으로써 "어떤 LLM 이든 같은 능력" 비전이 실코드로 완성됐다(2026-05-27 V8). 현재 `src/core/claude.ts` 는 본질적으로 첫 어댑터로의 facade. 원칙 1 의 "Claude Code 슈퍼셋" 은 *능력 매트릭스 차원* (plugin/skill/MCP/hook 등 무엇이든 가능) 으로 보존되지만, *Claude LLM 으로만 실행* 한다는 종속은 거절 — 어떤 LLM 으로도 실행 가능한 데몬이 본질. 다음 자연 진입점 = 「인터페이스 추출 라운드」(코드 라운드, 추상화 두께 vs 어댑터 자유도 트레이드오프 평가). 자세한 결정·인터페이스 면 sketch·V2/V3 후속은 `docs/decisions/2026-05-17-llm-agnostic-vision.md`.

## 현재 상태

> **V9 런타임 홈 분리 완료 (2026-05-25, V9.1~9.6).** tiguclaw 는 독립 앱 런타임으로 분리됨. 런타임 홈 = `TIGUCLAW_HOME` env(기본 `~/.tiguclaw`, dev `./tiguclaw-dev`), 개발 레포(`.claude`)와 완전 분리. DB = `<home>/data`, 인격 = `<home>/AGENT.md`(돌쇠), 훅 = `<home>/settings.json` + `<cwd>/settings.json` 머지. 능력 발견 = 공통 홈(`<home>/skills|agents|commands`) ∪ 프로젝트(`<cwd>/...`) ∪ 앱 번들(`<cwd>/plugins`), name 충돌 시 dedup **project > plugin > user**. 모든 경로 결정은 `src/core/paths.ts` 단일 모듈(`getPaths`/`projectScope`/`ensureHome`)로 수렴. `.claude` 는 tiguclaw 를 Claude Code 로 *개발*하는 레포 한정 — 런타임 미사용. 진실 소스 ADR: [`docs/decisions/2026-05-24-v9-runtime-home.md`](docs/decisions/2026-05-24-v9-runtime-home.md). (아래 날짜별 라운드 노트의 `data/tiguclaw.db`·`~/.claude/projects/` 등 구 경로 언급은 *당시 기록(changelog)* 이며 현재 모델은 본 단락·`docs/architecture.md` §7 을 따른다.) 비서의 프로젝트 cwd 선택 메커니즘은 V10(범위 밖).

**Phase 1 완료 (2026-05-04)** — 데몬 + CLI/Telegram 두 채널 + Claude Agent SDK 최소 래퍼 살아있는 흐름. (당시 "영역 A" — 2026-05-27 V8 영역 통합으로 단일 LLM 런타임이 됨.)

**Phase 2 완료 (2026-05-04)** — 채널 내 세션 지속성 (SDK `resume` 매핑). `(channel, threadKey) → claude_session_id` 한 줄을 `src/store/sessions.ts` (better-sqlite3) 에 보관, 매 호출에서 SDK 의 `Options.resume` 으로 전달. 대화 히스토리 본문은 SDK 가 `~/.claude/projects/<cwd-key>/` 에 저장 (messages 테이블 만들지 않음 — 진짜 일만 직접). 채널 간 이어가기·장기 메모리·관측·비용 추적은 후속 라운드.

**Phase 3 완료 (2026-05-04)** — 라우터 + 영역 B (멀티 LLM 풀 + 폴백). `src/core/llm.ts` 가 Vercel AI SDK `generateText` 위에 모델 풀 폴백 체인을 얹는다 (역할별 풀 `MODELS_DEFAULT`/`MODELS_DEEP`, 콤마 순서 = 폴백 우선순위). `src/core/router.ts` 는 prefix 룰로 분기 — **`@deep` 하나만** 영역 B (deep 풀) 진입, 그 외 입력은 영역 A 디폴트 (Phase 2 동작 100% 보존). 영역 B 의 멀티턴 히스토리는 `messages` 테이블에 직접 보관 (Vercel AI SDK 는 stateless). default 풀은 인프라(파서·풀·폴백·테이블) 모두 깔리지만 라우팅 진입점 없음 — 다음 라운드 자동 분류 룰(LLM 또는 글자수 임계) 도입 시 활성. 비용 추적·region 컬럼·시스템 프롬프트는 다음 라운드.

**Phase 4 완료 (2026-05-05)** — 권한 게이트 V1 (단일 정책 인프라). `src/auth/permissions.ts` 에 `DISALLOWED_TOOLS: readonly string[] = []` 상수 한 줄 + SDK `Options.disallowedTools: [...DISALLOWED_TOOLS]` 통합 지점 (`src/core/claude.ts`). 단일 정책 — 채널 인자 없음, 새 채널 추가 시 권한 코드 변경 0 (사용자 결정 2026-05-04). V1 차단 리스트는 **빈 배열** (인프라만, Phase 3 default 풀 패턴과 동일) — 모든 회색지대는 LLM 능동 평가에 위임, 차단 도구 추가는 V2 또는 추후 라운드. `permissionMode: 'bypassPermissions'` 보존 — `disallowedTools` 가 bypass 단락보다 먼저 평가되므로 양립 (스파이크 검증). 인터랙티브 ask 흐름·`canUseTool` 콜백은 V2.

**Plugin Inventory V1 완료 (2026-05-15)** — 비전 #1 발견 + #5 관측의 V1 인프라. `src/core/plugins/inventory.ts` (1.5층) 가 5 영역(채널 manifest read · 외부 plugin `~/.claude/plugins/cache/<vendor>/<name>/<version>/` 3단계 walk + `enabledPlugins` 합집합 cross-ref · 스킬·에이전트 frontmatter 자체 정규식 · MCP `.mcp.json` + in-process `memory` server hardcode) walk → 통합 인벤토리. 두 입구: (1) 비서 자연어 — `mcp__memory__list_installed_plugins` 도구 (memoryMcpServer 단일 server 일관, "뭐 켜져있어?" → SDK 자동 호출), (2) 사용자 직접 — `/plugins` 슬래시 (라우터 우회, 카테고리별 카운트 헤더 + entry 1줄). 텔레그램 `setMyCommands` 5 항목. 외부 라이브러리 0 (yaml lib 미도입). 라이브 13 entry 발견 (channel 1 + external 2 + skill 4 + agent 5 + mcp 1). 5종 코어 LOC ±30% 게이트 PASS (1617 → ~1655, +2.4%). dashboard 시각화·활성/비활성 토글은 Phase B/C 후속. 결정 노트: `docs/decisions/2026-05-15-plugin-inventory-v1.md`.

**Phase A 시연 1 완료 (2026-05-15)** — 채널 플러그인 컨벤션 dry-run. 비전 노트 미해결 질문 #1 답 픽스 — `package.json.tiguclaw.{schemaVersion:1, kind:"channel"|"trigger", name, entry}` 필드 마커 단독 (옵션 B, scope 강제는 V2 marketplace 로 YAGNI). 로더 1.5층 `src/core/plugins/channels.ts` (1단계 walk + 격리 try/catch + Windows `pathToFileURL`) + 부트스트랩 `src/index.ts` 가 hardcoded 채널 등록 후 `plugins/` 의 plugin 채널을 추가 등록 (name 충돌 시 hardcoded 우선). 첫 시민 = `plugins/channel-cli-plugin/` (CLI 단순 복사 + `name="cli-plugin"`, hardcoded 와 공존). 채널 0개여도 부팅 정상 (비전 §42 정합). `ChannelName` 리터럴 → `string` 완화 (1줄, plugin name 동적). 5종 코어 LOC ±30% 게이트 PASS (baseline 1617, 변동 0%). 결정 노트: `docs/decisions/2026-05-15-channel-plugin-convention.md`. 다음 라운드 자연 진입점 = Phase A 시연 2 (self-improving-agent 외부 plugin 실측) 또는 Phase B 진입 (관리 Must 4종 — 발견·설치·권한·관측, dashboard 첫 시민).

**Phase B dashboard 첫 라운드 완료 (2026-05-15)** — 비전 §74 Must #5 관측 첫 라운드. EventBus 코어 인프라(`src/core/eventbus.ts`, in-memory ring buffer cap 1000 + subscriber 격리 + recursion guard + lazy singleton/`initEventBus` alias) + Observer 인터페이스(`src/core/observers/types.ts`, 단방향 read-only — Channel 양방향과 책임 분리, 채널 분류 결정 2026-05-14 정합) + manifest kind 확장(`channel|trigger|observer` 3값, schemaVersion 1 보존) + observer 로더(`src/core/plugins/observers.ts`, channels 동형 + `start(bus)` 자동 호출 + 격리 throw 시 `plugin.error` publish) + 첫 시민 dashboard(`plugins/observer-dashboard/`, HTTP/SSE + 정적 HTML 한 장 + `/inventory` + `/events` SSE, 외부 의존 0). Publisher 4 source: `channel.message.in/out`·`region.a.sdk_message`·`memory.write`·`plugin.error`. narrative backpressure 4중 PASS(event type=string · observer schemaVersion 보존 · bus 격리 · ring cap). 5종 코어 본체 +1.9% (LOC ±30% 게이트 멀리 PASS). 결정 노트: `docs/decisions/2026-05-15-phaseB-dashboard.md`. **시연** — `npm run dev` 후 브라우저로 `http://localhost:3000` 접속하면 좌측에 plugin inventory, 우측에 실시간 이벤트 stream. 텔레그램에서 메시지 한 번 보내면 `channel.message.in` → 다수의 `region.a.sdk_message` → `channel.message.out` 이 순서대로 fan-out. V1 한계(슬래시 응답 publish · delete/update memory publish · inventory observer 누락) 는 V2 후속.

**EventBus HTTP/SSE expose — http-bridge 첫 시민 완료 (2026-05-15)** — *진짜 plugin* 의 충분조건 V1 인프라 (외부 access + 양방향, claude-mem 모델). manifest schema 진화 — `tiguclaw.kind: string | string[]` 자동 판별 (schemaVersion 1 보존, 호환 깸 0). 통합 로더 `src/core/plugins/loader.ts` (1 plugin = 1 instance, capability 별 분기 등록은 `src/index.ts` 책임). 첫 시민 `plugins/http-bridge/` = Channel + Observer 2 capability hybrid (`startChannel`/`startObserver` 명시 method, ensureServer idempotent). 4 endpoint: `/events` SSE · `/inventory` JSON · `/health` (인증 무) · `/messages` POST 양방향 (60초 timeout race + reply capture). token 인증 (`HTTP_BRIDGE_TOKEN`, 부재 시 random 16-byte hex ephemeral + console 1줄). 외부 raw access 시연 — `npm run dev` 부팅 후 다른 터미널에서 `curl -H "Authorization: Bearer <token>" http://localhost:3001/health` (JSON) · `/events` (SSE stream) · `POST /messages '{"text":"안녕"}'` → `{replyText:"..."}` (60초 이내). `.env` 에 `HTTP_BRIDGE_TOKEN=<your-secret>` 추가 권장 (ephemeral 은 부팅마다 변경). narrative backpressure 6중 PASS (5 기존 + (5) 외부 access + (6) multi-capability 자유). Phase B Must #2 설치·#4 권한 부분 진입. 결정 노트: `docs/decisions/2026-05-15-eventbus-http-expose.md`. V1 한계(token 단일·streaming X·install 슬래시 X) 는 V2 후속.

**Dashboard 외부화 라운드 (ii) 완료 (2026-05-15)** — claude-mem 모델 완성. internal `plugins/observer-dashboard/` 삭제 + `packages/dashboard/` 외부 process 로 추출 (monorepo V1). http-bridge 4 endpoint server-side proxy (`/api/inventory|/api/health|/api/events SSE pipe|/api/messages POST`) — `Authorization: Bearer` 헤더는 server-side 주입 (token browser 미노출). 채팅 UI 양방향 추가 (사용자 통찰 — "dashboard 가 꼭 관측만 할 필요는 없지"). narrative backpressure **7중** — (vii) 외부 process 격리 진입 첫 시민 (dashboard crash ≠ daemon down). Phase C #7 격리의 첫 발자국. 5종 코어 무수정 (`src/` 변동 0). 시연 — PowerShell 1: `npm run dev` (데몬 부팅, http-bridge `:3001` listen + ephemeral token 출력). PowerShell 2: `npm run dashboard` (외부 dashboard, `:3000` listen). 브라우저 `http://localhost:3000` — 좌측 inventory + 우측 events stream + 하단 채팅 UI 양방향. 주의: ephemeral token 매 부팅 변경. `.env` 에 `HTTP_BRIDGE_TOKEN=<your-secret>` 박으면 안정 (양쪽 같은 token). 결정 노트: `docs/decisions/2026-05-15-dashboard-externalize.md`. V2 후속: npm scope `@tiguclaw/dashboard` publish (라운드 iii), per-plugin token, 외부 작성자 dashboard.

**Dashboard V2 라운드 (iii) 완료 (2026-05-16)** — per-plugin token + role 3종(`read`/`write`/`admin`, admin=superset) + expiry + rotation + `@tiguclaw/dashboard` publish-ready + 외부 작성자 alt-dashboard 흐름. SQLite `bridge_tokens` 테이블 (token_hash sha256 만, raw 미저장) + CLI 3종 (`npm run bridge:grant`/`bridge:tokens`/`bridge:tokens -- --revoke <id>`) + doctor `[tokens]` 섹션. `HTTP_BRIDGE_TOKEN` env 보존 (admin role) — V1 회귀 0 (4 가드 PASS). endpoint × role 매핑: `/events`·`/inventory` = read 이상, `/messages` = write 이상. read-only alt-dashboard 시나리오 검증 — `read` 토큰으로 dashboard 부팅 시 chat UI 자동 차단 (403 `{error:"forbidden",required:"write",presented:"read"}`). `packages/dashboard/package.json` name → `@tiguclaw/dashboard`, `private:false`, `.npmignore` + `files` 화이트리스트 (publish dry-run 14/14 PASS — submodule 은 Phase D YAGNI). narrative backpressure **8중** — (viii) 외부 작성자 첫 시민. 5종 코어 LOC +10.7% (±30% 게이트 강 PASS). 외부 라이브러리 0 (sha256 + `node:crypto` 만, JWT/OAuth 도입 0). QA 62/62 PASS, typecheck 0 errors. 결정 노트: `docs/decisions/2026-05-16-dashboard-v2-tokens.md`. V3 후속: `/grant` 슬래시·dashboard admin UI·endpoint 별 세분 role·token rotation 자동화.

**Scheduler v1 완료 (2026-05-16)** — cron trigger 첫 시민. 비전 §39 (트리거 = 채널의 한 종류) 의 코드 실증 — channel-plugin-convention 의 `kind:"trigger"` 슬롯 V1 활성. `plugins/scheduler/` in-tree plugin (`layer=in_tree`, channel-cli-plugin 이후 두 번째 시민) — `package.json.tiguclaw.kind:["trigger"]` 배열 + entry `./src/index.ts` (runner / mcp / dispatcher 4 파일). cron 엔진 = `croner@^10` (deps 0, IANA timezone, `nextRun()` dryrun — 사용자 "lib 1개 허용" 정확 사용). schedules SQLite 테이블 12 컬럼 (bridge-tokens 동형 idempotent 마이그레이션, `data/tiguclaw.db` 안). 발화 = scheduler runner → `runClaude({text:prompt, threadKey:"scheduler:<id>", channel:"scheduler", cwd:process.cwd()})` → 결과를 `dest_channel` (cli/telegram/http-bridge V1 hardcoded) 로 dispatch. **두 진입**: (1) 비서 자연어 — MCP tool 3종 (`mcp__scheduler__add_schedule`/`list_schedules`/`delete_schedule`, SDK in-process MCP), (2) 사용자 직접 슬래시 — `/schedule list`·`/schedule delete <id>`·`/schedule enable <id>`·`/schedule disable <id>` (`/schedule add` 는 V1 미지원 — 인용 파싱 회피, MCP 권장). `claude.ts` 1 필드 진화 (`extraMcpServers`) + `src/core/mcp-registry.ts` 1.5층 신규 — plugin 의 `getMcpServer()` export 를 부팅 시 모아 영역 A 호출에 주입 (plugin 직접 import 회피 — 비전 §17 정합). `scheduler.toggle` EventBus 패턴 (capability-agnostic 슬래시 통신, daemon-engineer 합의). overlap 정책 = skip + `inFlight: Set<id>` (queue/병행 거절). 5종 코어 LOC 1721→1758 (+2.1%, ±30% 게이트 멀리 PASS). narrative 8중 — 6 강 PASS + (vii) 외부 process 격리 / (viii) 외부 작성자 trigger plugin 부분 진입 (V2 후속). QA 통합 PASS (typecheck 0, 경계면 정합 6중, spike 64/64, 라이브 7/7, 회귀 5중). 결정 노트: `docs/decisions/2026-05-16-scheduler-v1.md`. **시연** — `npm run dev` 부팅 후 대화창에서 "매일 8시에 오늘 뉴스 정리해서 CLI로 보내줘" → 비서가 `add_schedule({cron_expr:"0 8 * * *", dest_channel:"cli", ...})` 호출 → `/schedule list` 로 등록 확인 → 매일 8시 자동 발화. `/schedule disable 1` 일시 정지, `/schedule delete 1` 영구 삭제. V2/V3 후속: 외부 process 격상 (claude-mem 모델) · `/schedule add` 슬래시 · `update_schedule` MCP · 외부 trigger plugin (webhook/file-watch 첫 시민) · run history 테이블 · 사용자 prompt 위험성 능동 평가 sysprompt 보강 · 자연어 cron parsing.

**Scheduler v1.1 완료 (2026-05-16)** — reboot trigger + `daemon.boot` event. v1 의 자연 확장 — 사용자가 자연어로 "재시작될 때마다 ~" 등록 가능 + 외부 plugin 이 EventBus subscribe 만으로 자기 trigger plugin 구현 가능 (narrative (viii) **외부 작성자 trigger plugin 첫 시민 길의 보강 진입**). 결정 5: (Q1) cron_expr nullable 마이그레이션 = NOT NULL 유지 + reboot row 빈 문자열 (SQLite `ALTER COLUMN` 제약 회피, 마이그레이션 0 비용). (Q2) daemon.boot payload = `{pid, channels[], hostname, ts}` (`node:os` 표준만). (Q3) publish 위치 = `src/index.ts` `"tiguclaw daemon: ready"` 직후 inline 1블록 (eventbus.ts startup helper 거절 — 책임 누수). race 0 보장 — plugin 로더가 `channels.start` *전에* 실행되어 trigger plugin subscribe 박힘 + channel plugin 까지 channels[] 에 포함. (Q4) overlap 가드 = V1 무가드 + V2 후속 명시 (production 재시작 = 의도된 사건, dev hot reload 명시적 발화 = 디버깅 친화). (Q5) MCP `add_schedule(trigger_type?:"cron"|"reboot")` 옵셔널 default 'cron' (V1 회귀 0) + reboot 면 cron_expr 빈 문자열 + dryrun 건너뜀 + `next_run:null` 응답. `/schedule list` 출력 컬럼 분기 (cron row 기존 포맷 + reboot row cron_expr/timezone 자연 생략). schedules 테이블 진화 = idempotent `ALTER TABLE schedules ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK(...)` (`system_prompt_hash` 패턴 답습). scheduler plugin = `bus.subscribe` **단일 핸들러 안에서** `scheduler.toggle` + `daemon.boot` 두 type 분기 (cleanup 1번, 메타 단순+견고). `scheduler.toggle action="enable"` 의 reboot 가드 — 즉시 발화 0 (다음 daemon.boot 까지 대기, `fire_reboot_schedule` MCP 는 V2). 5종 코어 LOC 1758→1772 (+0.80%, ±30% 게이트 멀리 PASS). store-auth `toRow` forward-compat fallback (미지 type → 'cron' graceful degrade) 박혀 미래 v2 호환 안전. QA 통합 PASS (typecheck 0, 경계면 정합 (a)~(d), spike 57 + v1 회귀 67, 라이브 `qa_reboot_live` 7/7 + `qa_reboot_idempotent` 3/3, 회귀 5중). 결정 노트: `docs/decisions/2026-05-16-scheduler-v11-reboot.md`. **시연** — `npm run dev` 부팅 후 대화창에서 "데몬 재시작될 때마다 인사 메시지 CLI로 보내줘" → 비서가 `add_schedule({trigger_type:"reboot", prompt:"안녕!...", dest_channel:"cli"})` 호출 → `/schedule list` 로 `#1 [on] welcome-back reboot → cli` 확인 → 데몬 재시작 (Ctrl+C → `npm run dev`) → `daemon.boot` 자동 publish → reboot row 자동 발화. V2/V3 후속: `shutdown` event + 동형 trigger_type · production NODE_ENV 가드 · 외부 trigger plugin 첫 시민 (webhook/file-watch) · `/schedule list <type>` filter 인자 · `fire_reboot_schedule` MCP · 외부 process 격상.

**file-watch trigger v1 완료 (2026-05-16)** — chokidar 기반 폴더·파일 감시 trigger plugin 두 번째 시민 (외부 작성자 reference). scheduler 와 다른 trigger 영역 (cron/lifecycle vs fs.watch) 으로 narrative §9 (viii) "외부 작성자" **본격 진입**. `plugins/file-watch/` in-tree plugin (channel-cli-plugin → scheduler → **file-watch** 세 번째 in_tree trigger 시민) — `package.json.tiguclaw.kind:["trigger"]` 배열 + entry `./src/index.ts` (watcher / mcp / dispatcher 4 파일). fs.watch 엔진 = `chokidar@^5` (deps 1 [readdirp], OS 풀 ReadDirChange/FSEvents/inotify, `awaitWriteFinish` 빌트인 debounce — 외부 lib total 2 [croner + chokidar] 메타 정합, 각 plugin 책임 1개). watches SQLite 테이블 18 컬럼 별 (schedules 와 관심사 분리, bridge-tokens 동형 idempotent 마이그레이션). 발화 = chokidar event → debounce → `runClaude({text:prompt.replace("{path}",actualPath).replace("{event}",actualEvent), threadKey:"file-watch:<id>", channel:"file-watch", cwd:process.cwd()})` → 결과를 `dest_channel` (cli/telegram/http-bridge V1 hardcoded) 로 dispatch. **두 진입**: (1) 비서 자연어 — MCP tool 3종 (`mcp__file-watch__add_watch`/`list_watches`/`delete_watch`, SDK in-process MCP, scheduler 동형 패턴), (2) 사용자 직접 슬래시 — V1 미지원 (자연어 + safety-check 스킬로 충분, `/watch` 4종 V2 후속). placeholder `{path}` `{event}` 치환은 plugin runtime (escape 없음, V1 단순). **safety-check 스킬 본문 보강** — frontmatter description +5 키워드 (watch / 파일 변경 / 폴더 감시 / 감시 / 파일 추적, 결과 14 키워드) + §1 위험 layer file-watch 카테고리 추가 (safe=`./docs` 자체 폴더 / gray=home 일부+Telegram 송신 / danger=`/etc`·`~/.ssh`·`~/.aws`·`/proc`+`**` glob 폭주+자동 삭제 prompt) + §4 호출 시점 `add_*` MCP 도구 일반화. **sysprompt 무수정** — SKILL.md 본문만 보강 (옵션 A, SYSTEM_PROMPT_HASH 보존, 메타 단순+견고 강화). **daemon 본체 0 LOC delta** — loader.ts + mcp-registry.ts + src/index.ts 무수정 → *외부 작성자 reference 핵심 PASS 신호*. 5종 코어 LOC 1773→1799 (+1.46%, ±30% 게이트 멀리 PASS) — sessions.ts +25 (watches 마이그레이션) + claude.ts +1 (channel="file-watch" 매핑). narrative 8중 — 6 강 PASS + (vii) 외부 process 격리 부분 / **(viii) 외부 작성자 본격 진입 PASS** (cron/lifecycle/fs.watch 세 영역 동형 패턴 일반화 입증, 세 번째 trigger type 답습 시 동일 패턴 자명). 외부 작성자 reference 6 항목 박힘 (manifest / lifecycle 2 method / EventBus / MCP server export / dispatcher / README). QA 통합 105 PASS / 1 spike-self FAIL (file-watch 책임 0) — 경계면 6/6 + 회귀 5/5 + 정적 6/6 + 라이브 (daemon 6/6 + file-watch live 8/8 + store 55/55 + runner 13/13). 결정 노트: `docs/decisions/2026-05-16-file-watch-trigger.md`. **시연** — `npm run dev` 부팅 후 대화창에서 "`./docs` 폴더 변경되면 핵심만 CLI로 알려줘" → safety-check safe 판정 → `add_watch({path:"./docs", recursive:true, prompt:"{path} 가 {event} 됐어. 핵심만 1줄 요약.", dest_channel:"cli"})` 즉시 호출 → 외부 에디터로 `./docs/foo.md` 저장 → 500ms debounce → 비서 응답 CLI 도착. `/etc` 같은 시스템 폴더 등록 시도 시 danger 강한 경고. V2/V3 후속: publish-ready `@tiguclaw/file-watch` · `/watch` 슬래시 · `update_watch` MCP · multi-path · glob pattern 복수 · `awaitWriteFinish` 옵션 노출 · install CLI Phase B Must #2 · 외부 작성자 marketplace `@tiguclaw/trigger-*` (Phase D).

**영역 A 인터페이스 추출 V2 완료 (2026-05-17)** — LLM-agnostic 비전 (2026-05-17) §8 V2 의 첫 코드 라운드 = *재구성*. 영역 A 래퍼 의미 진화 — 단일 `src/core/claude.ts` (275 LOC, Claude Agent SDK thin shim) 에서 `src/core/region-a/` 디렉터리 (323 LOC, `types.ts` 46 + `index.ts` re-export hub 12 + `adapters/claude-agent-sdk.ts` 258) 로. `RegionASdk` 인터페이스 첫 시민 — 1 면 진입 (`run(input) → output`, contract §2 옵션 (A)), 나머지 7 면 (session resume / 도구 실행 흐름 / MCP 등록 / permission 게이트 / hook / 자동 발견 / stream fan-out) 모두 첫 어댑터 안쪽 캡슐화. facade 옵션 (B) 박힘 — `src/core/claude.ts` 7 LOC thin shim 보존 (`export { runClaude } from "./region-a/index.js"`), plugin (scheduler·file-watch) 진입점 `import { runClaude } from "../../../src/core/claude.js"` **완전 보존** (`git diff plugins/` 0 lines). 외부 작성자에게 facade 가 단일 진입점 — V3 두 번째 어댑터 추가 시에도 plugin 변동 0 보장. `McpSdkServerConfigWithInstance` 추상화 leak 은 의도된 trade (contract §2.4) — V3 두 번째 어댑터 (OpenAI Agents SDK / Vercel AI SDK Agent / Google ADK 중 1) 가 실제 shape 노출할 때 정규화 결정. 5종 코어 LOC delta +48 (+3.46%, ±30% 게이트 멀리 PASS — 영역 A single 측정 275→323 = +17.5%, 5종 전체 1385→1433 = +3.46%, 여유 25.5%). daemon 본체 0 LOC delta (`src/index.ts` / `router.ts` / `mcp-registry.ts` / `eventbus.ts` 무수정). store/auth 0 LOC delta. SYSTEM_PROMPT body sha256 byte-identical (`901778c8d9c9...`, fingerprint 가드 정합 — session-invalidation 2026-05-14). narrative backpressure **9중 후보 부분 진입** = `multi-LLM-adapter` ((a) 인터페이스 박힘 (b) plugin 진입점 불변 (c) LOC ±30% 게이트 PASS, 정식 9중 박기는 V3 두 번째 어댑터 spike 클로즈 시점). QA 통합 20/20 PASS / FAIL 0 — 경계면 6/6 (facade/hub/adapter 3 단 ESM binding 정합, plugin RegionASdkInput 인자 모양, extraMcpServers 타입 정합 router↔mcp-registry↔types↔adapter, ClaudeRunInput/Output legacy alias type identity, SYSTEM_PROMPT body byte-identical, DISALLOWED_TOOLS adapter 안쪽 보존) + 회귀 5/5 (Phase 2/3/4 + Memory V3 + scheduler v1+v1.1 + file-watch v1 + safety-check) + parity audit 14/14 능력 매트릭스 누락 0 + typecheck 0 errors. 결정 노트: `docs/decisions/2026-05-17-region-a-interface-extraction.md`. V3 후속: 두 번째 어댑터 라이브 spike (능력 매트릭스 1:1 보장 평가) · `claude-code-parity-audit` 어댑터별 자동 실행 · `McpSdkServerConfigWithInstance` 정규화 결정 · 인터페이스 면 추가 결정 (stream fan-out / session resume 키 매핑) · narrative 9중 정식 박기.

**영역 A 두 번째 어댑터 spike V3 완료 (2026-05-17)** — LLM-agnostic 비전 §3.3 OpenAI 후보 평가의 코드 실증. V2 가설 "RegionASdk 1 면으로 다른 SDK 어댑터 가능" 실증 PASS + **narrative 9중 정식 박기**. `src/core/region-a/adapters/openai-agents-sdk.ts` skeleton **48 LOC** 신규 (V2 첫 어댑터 동등 시그니처 `runOpenAi(input: RegionASdkInput) → Promise<RegionASdkOutput>`, hub 미통합 — production dispatch V5+). `package.json` `@openai/agents@^0.11.4` dep +1 (spike 한도, transitive 5 + 6.4 MB — V5 진입 시 사용자 합의 게이트). **14×2 능력 매트릭스** 첫 시민 — OpenAI column: 가능 **8** (Bash/Web/MCP/Agent/훅/슬래시/메모리/백그라운드) / 부분 **3** (파일ops/태스크관리/플랜모드polyfill) / 부분-대안 **2** (스킬/플러그인) / 불가능-대안 **1** (플랜모드) / 알림 **1** (IDE). region 실측 호환성 > architect 예측 5 — MCP/web/shell/handoff/guardrail 풍부함이 결정적. **MCP 시나리오 (i) 호환 판정** — `@openai/agents` 가 `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE` 3 transport + `getAllMcpTools` / `mcpToFunctionTool` / `hostedMcpTool` 3 bridge 모두 내장 → `extraMcpServers` leak 보존 결정 *강화* (V6+ 3번째 어댑터 시 정규화 재평가). **session resume 의미 1:1 정합** — Claude `resume:session_id` ↔ OpenAI Responses API `previous_response_id` 구조 동등 (string handle, 옵셔널 부재 시 새 conversation, 한 turn 당 1 값). store note (A) 추천 = 단일 컬럼 + 의미 일반화 (V5 schema 변경 0, additive `adapter_kind` 컬럼 후보만). 5종 코어 LOC delta +48 (V2 1433 → V3 1481, +3.35%, ±30% 게이트 멀리 PASS 여유 26.65%). **plugin / daemon 본체 4 파일 / store/auth / 인터페이스 면 (types.ts + index.ts) 모두 0 LOC delta** (`git diff` 빈 출력). SYSTEM_PROMPT body sha256 V1 ↔ V3 byte-identical (fingerprint 가드 정합). **narrative backpressure 9중 정식 박기 강 PASS** — 6 신호 중 7 강 (a/b/c/d/f/g/h) + 1 부분 (e — `.env` 의 `OPENAI_API_KEY` 빈 문자열, V3.1 키 등록 시 재실행 가능 ~$0.001) = 8/8 (5+ 만족). QA 통합 25/25 PASS / FAIL 0 — 4 워크스트림: region spike 22/22 (auth throw 실측 + V3 stateless 정합 (b) 라운드 보강) + store-auth 의미 1:1 정합 + daemon 무수정 19/19 + qa 14×2 매트릭스 + 회귀 5중 + V2 region-a 자체 회귀 spike 3 종 (runner 32/32 + daemon 10/10 + identity 3/3). typecheck 0 errors. 결정 노트: `docs/decisions/2026-05-17-region-a-v3-openai-spike.md`. narrative 9중 정식 박힘 진실 소스: `docs/decisions/2026-05-15-self-hosting-marketplace-narrative.md` §backpressure 9중 차원. **V3.1 후속** — 사용자 `OPENAI_API_KEY` 등록 후 `npx tsx _workspace/region_a_v3_openai_spike.ts` 재실행 (gpt-4o-mini default, ≈ $0.001) → 신호 (e) 강 격상. **V4 후속** — `claude-code-parity-audit` 스킬 어댑터별 자동 실행 + 어댑터별 매트릭스 표 정식 + 어댑터 폴백 모델. **V5 후속** — production 어댑터 dispatch (facade env 기반, OpenAI 완전 통합: session resume / 자동 메모리 / EventBus / permission 게이트 / extraMcpServers 처리, transitive 6.4 MB 사용자 합의). **V6+ 후속** — 3번째 어댑터 + MCP 정규화 재평가 + 영역 A/B 통합 abstraction 결정.

**영역 A 세 번째 어댑터 spike V3.1 완료 (2026-05-17)** — ChatGPT OAuth 우회 + **narrative 9중 차원 *심화 강* 박힘**. 사용자 명시 합의 통과 ("p2가 맞아" + AskUserQuestion 4 위험 layer 명시 동의). ChatGPT Plus/Pro 구독자가 platform API key 없이 영역 A 사용 가능한 경로 spike — `src/core/region-a/adapters/openai-codex-oauth.ts` **258 LOC** 신규 (RegionASdk implements, PKCE OAuth `@openauthjs/openauth/pkce` MIT 위임 + Codex backend `/responses` baseURL transform: `chatgpt.com/backend-api/responses` + `Authorization: Bearer` + `chatgpt-account-id` (JWT 추출) + `originator: codex_cli_rs` + `OpenAI-Beta: responses=experimental`). `@openauthjs/openauth@^0.4.3` dep +1 (MIT upstream, dep 누적 6). hub 미통합 — V5+ facade dispatch 후속. **V3 어댑터 byte-identical 보존** sha256 `83e27cdd…871f0` 입증 (narrative 회귀 가드 신규). **14×3 능력 매트릭스** — Codex OAuth column = 추정 13 + 어댑터 무관 확정 2 (슬래시·백그라운드) + IDE 알림 1. V3.2 라이브 후 확정. session resume Claude `resume:session_id` ↔ OpenAI `previous_response_id` 의미 1:1 정합 (V5 schema 변경 0). 5종 코어 LOC delta V3 1481 → V3.1 **1750 (+18.16%, ±30% 강 PASS 여유 11.84%)**. plugin/daemon 본체/store/auth/인터페이스 면 모두 0 LOC delta. **narrative 9중 차원 *심화 강* 박힘** — 13 강 + 1 부분 = 14 신호 만족 (i~n 6 신호 신규: 세 번째 어댑터 코드 / V3 byte-identical / `@openauthjs/openauth` MIT 위임 / 14×3 매트릭스 / store/auth 무수정 / hub 미통합). **메타 "최소 3번 반복 후 추상화 도달의 *첫* 신호"** 박힘 (V2 1번 + V3 2번 + V3.1 3번). **위험 4+1 layer 명시 박기** — (1) ToS 회색지대 = *personal use only* + 1-user 한정 / (2) 비공식 endpoint 깨짐 = 어댑터 분리로 V3/Claude 폴백 가능 / (3) 데몬 안정성 = hub 미통합 / (4) 1-user 정합 = tiguclaw 모델과 정확 정합 / (5) token storage = `.env` (V3.2 SQLite encrypted 후속). 라이브 spike 6 종 **133/133 PASS** (V3.1 47 + V3 OpenAI 22 + V3 daemon 19 + V2 runner 32 + V2 daemon 10 + V2 identity 3). 회귀 6중 PASS (Phase 2/3/4 + Memory + plugins + V2 인터페이스 + V3 byte-identical). 결정 노트: `docs/decisions/2026-05-17-region-a-v31-oauth.md` (11 섹션). 메모리: `project_v31_oauth_consent.md` 영구 박힘. **V3.2 후속** — callback HTTP server (localhost:1455) + `OPENAI_CODEX_OAUTH_TOKEN` 등록 → Codex `/responses` hello world 라이브 1 round-trip ($0, 구독 사용량 차감). **V4 후속** — 능력 매트릭스 시스템화 (`claude-code-parity-audit` 어댑터별 자동 실행). **V5 후속** — production dispatch (facade env 기반, Codex 깨짐 시 V3 → Claude 자동 폴백, RegionASdk 풀 fallback 패턴). **V6+ 후속** — 3번째 *LLM* 어댑터 (Vercel AI SDK Agent / Google ADK 등) + 인터페이스 면 정규화 + 영역 A/B 통합 abstraction 재평가.

**멀티모달 입력 V1 완료 (2026-05-27)** — 텔레그램 이미지·문서 인지. 사진/문서/음성 등 첨부를 보내면 비서가 인지한다 — 채널이 `getFile`→fetch 다운로드(deps 0) 후 `<home>/data/attachments/<channel>/<yyyymmdd>/<id>.<ext>` 에 저장(20MB 가드 + 실패 명시), 영역 A 에는 **파일 경로 + 메타(kind/mime/파일명/크기/caption)만** 넘긴다. 비서가 native file 도구(claude=Read / codex=file-ops MCP)로 그 경로를 읽음 — file-no-wall 모델([[2026-05-25-file-access-no-wall]]) 위에서 양 어댑터 **인지 parity 100% 대칭**. **척추 통찰: 첨부 = 파일 경로 + Read** — base64 를 우리 타입에 담아 어댑터별 SDK content-block 으로 변환하는 길은 어댑터가 자기 멀티모달 API 를 가져야 성립(즉시 비대칭)하나, 파일 경로 면은 이미 양쪽 보장. parity 2층 분리 — (1) 인지 parity 필수·전 어댑터 보장, (2) vision *해석* parity 는 LLM 본연 능력 차이(claude vision 즉시 / codex 인지+능력대로, 격차 명시 안내·조용한 격차 0). 중립 타입 `Attachment{kind,mimeType,path,filename,bytes,caption?}` + `IncomingMessage.attachments?` (additive, 미지정=현행 text-only 회귀 0). cross-adapter 첨부 0유실 — placeholder text 가 transcripts 에 녹아 `loadThreadHistory` 가 thread 횡단 회수([[2026-05-26-cross-adapter-conversation-continuity]] 대칭화), 스키마 변경 0. 반려: 이미지 dispatch 라우팅(원칙 4 위반) · describe 폴백(V2) · base64 운반(YAGNI). 의존성 0 (V1 `@anthropic-ai/sdk` 불요 — native vision V1.1 종속). QA PASS, P0 0, typecheck 신규 0. 결정 노트: `docs/decisions/2026-05-27-multimodal-input.md`. V1.1+ 후속: native vision(codex `/responses` input_image 라이브 실측 → 분기 A/B · claude `@anthropic-ai/sdk` image block) · 음성 STT · media group(앨범) · CLI/http-bridge 첨부 · 첨부 TTL/GC.

**codex persistence 보강 완료 (2026-05-27)** — codex(gpt) 어댑터가 claude급으로 "작업 완료까지 끊김 없이 자율 수행". 진단 — claude 는 Agent SDK 가 도구 루프를 *코드로* 자율 persistence 하지만, codex 는 우리 수동 while 루프(`openai-codex-oauth.ts:844`)가 `toolCalls.length===0` 텍스트를 내는 순간 break + gpt 조기 종료 성향 + 헌법 "멈추세요" 과적용 → 미완 종료 → `:982` fallback("요청은 처리했지만 요약 텍스트를 만들지 못했어요"). **2층 분리** — persistence("끝까지 일하기")는 *우리 영역*(claude급 parity 가능), 추론력은 *모델 본연*(사용자 수용 "추론력 차이는 LLM이 다르니 당연"). 4 결정: (Q1) **보강 위치 = codex 전용 delta** — claude persistence 는 SDK 가 코드로 보장하므로 `CODEX_PERSISTENCE_PROMPT` const 를 codex `instructions` 에만 append(공유 헌법 미수정). claude SDK 가 코드로 하는 걸 codex 는 prompt 로 = *인격 분기가 아니라 parity 정합*. (Q2) **동사 보호 균형** — 동사 보호(턴 *경계*, 작업 종류 전환 방지) ≠ persistence(턴 *내부*, 그 작업 끝까지), 충돌 0. 공유 `_shared-sysprompt.ts` "사용자 동사 보호" 정정 — 헤더 "(작업 종류 전환 방지 — 턴 경계)" + 신설 bullet + L38 "멈추세요" → "산출물 완성하면 보고, 한 스텝마다 멈추지 말고 동사 범위 끝까지". (Q3) **final-flush turn + nudge** — cap-1 에서 `tools:[]` + 마무리 메시지로 최종 텍스트 강제(빈 응답 fallback 근본 예방), empty-break nudge 1회. flush turn iteration 미증가 = architect 의사코드 버그 교정(구현이 옳음, cap 슬롯 전부를 실제 작업에). (Q4) **cap 10 → 25 + env** (`CODEX_MAX_TOOL_ITERATIONS` `parseCapEnv`) — 뉴스급 복잡 작업엔 10 부족. 기존 Fix1(누적)/Fix2(sideEffect fallback)/부작용 플래그 안전망 전부 보존. **SYSTEM_PROMPT_HASH** — Q2 공유 정정 → claude 세션 1회 무효화(정상, session-invalidation 2026-05-14 정합, foreign delta 로 컨텍스트 복원 — cross-adapter-continuity 2026-05-26), codex 는 hash 미사용 → 무효화 0. principle-check 강 PASS(원칙 1·2). 라이브 검증 5종 종속(`tools:[]` backend / 추종률 / cap 적정값 / 빈응답 0 회귀 / claude 회귀 0 — 맥 데몬+토큰). QA PASS, 정적 전항목, typecheck 신규 0. 결정 노트: `docs/decisions/2026-05-27-codex-persistence.md`. V2 후속: 적응형 cap · persistence 정량 회귀 스위트 · 3번째 어댑터 일반화.

**영역 A/B 구분 완전 폐기 (2026-05-27, V8)** — "단발 호출 영역 B vs 에이전틱 영역 A" 라는 영역 가르기 자체를 폐기. LLM-agnostic 비전("어떤 LLM 이든 같은 능력 = 풀 에이전트")의 자연 귀결 — `docs/decisions/2026-05-22-region-b-deprecation-path.md` 가 깔아둔 deprecation 경로의 최종 실행. **@deep prefix 완전 제거** — 깊은 사고는 routing prefix 가 아니라 *비서가 부리는 능력*(경로 1 사용자 자연어 / 경로 2 서브에이전트에 상위 모델 tier 지정 — `resolveTier`/`MODEL_TIER_*`, 현 코드 동작 확실 / 경로 3 메인 턴 자기 전환 — 미구현 gap, 후속 과제). 능력 상실 아님(접근이 prefix→비서 주도로 이동). **dead-code 제거** — region B 가 유일 소비처였던 `src/core/llm.ts`(Vercel AI SDK 래퍼)·`src/store/messages.ts`(`appendMessages` INSERT)·`ModelMessage` 전 사용처 → `ai`·`@ai-sdk/anthropic` dependency 둘 다 제거(grep 재평가로 확정 — region A 는 messages 테이블 미사용, `threads`+`transcripts` 로 지속성 보장). **단일 파이프라인 pass-through** — `route()` 가 분기·prefix 없이 `runClaude`(어댑터 풀) 직행, `classify()`/`PREFIX_RULES`/`RouteOutput.region` 제거. **tier 인프라 존치** — `resolveTier`/`MODEL_TIER_*`/`REGION_A_MODELS` 는 @deep 전용이 아니라 서브에이전트 모델 지정이 의존 → 절대 보존. **회귀 0** — @deep 아닌 모든 입력은 *이미* 영역 A 였어서 메인 흐름 행위 변화 0 · 메모리(callLlm 미사용, SDK MCP 도구로 동작) 무영향 · DB `region` 컬럼 애초 부재(architecture.md 문서 잔재)라 마이그레이션 무비용(messages 테이블은 region B turn 만 들었으므로 idempotent DROP). principle-check 통과(조건 없음) — Q1 슈퍼셋 위반 해소(능력=비서 주도), Q5/Q6 강화(중복 추상화·dead-code 제거 = 최대 단순화). 결정 노트: `docs/decisions/2026-05-27-region-unification.md`. 정직한 gap: 경로 3(메인 턴 비서 자기 모델 동적 상위 전환) 미구현 — 능력은 경로 2 로 실존, 별도 후속.

**진행 표시(Progress Indicator) V1 — 당일 철회 (2026-05-27)** [구현 후 같은 날 제거] — 긴 작업에서만 가벼운 진행 신호. "한 턴 = 도구 루프 전체 실행 → 최종 텍스트 1개" 단일 응답 모델은 그대로, 그 위에 긴 작업(typing만 한참 뜨는 뉴스급)에서 throttle된 "작업 진행 중…" 신호를 *추가*. **액션별 도배(옵션 2) 명시 거부** — 옵션 1(가벼운 표시)만. **절대 게이트 = LLM-agnostic parity**: 기존엔 claude 어댑터만 `region.a.sdk_message`(claude 전용 raw) publish → codex/openai 턴은 진행 표시 0. 해결 = 세 어댑터 공통 **중립 이벤트 `region.a.progress`** 신규(`RegionAProgressPayload{channel,threadKey,turnId?,tick}`, claude raw 재사용 금지=비대칭). **"1 tick = 모델 1 왕복"** 공통 의미 단위(claude=assistant 메시지, codex=parseCodexSse 직후, openai=spike 단발 tick=1 — stream 미노출 SDK 제약상 "수용 가능 빈도 차이"). **turnId nonce 격리** — 같은 threadKey 동시 턴 2개도 분리(handler `randomUUID()` → route→runClaude→runRegionA `input.turnId ?? randomUUID()` → 어댑터 publish → 소비자 매칭). `RegionASdkInput.turnId?` additive(미지정=회귀 0). **throttle = 시작 8s + 간격 10s**(짧은 작업 표시 0, 상수, 비상차단 `PROGRESS_INDICATOR=off` 1개만 노출). **portable separate-send** — `msg.reply` 재사용(다채널 단일 인격), editMessageText in-place는 채널-특화라 V1 미채택. turnId 키 Map 2개 `finally` 정리(누수 0). 회귀 0(최종 reply·sdk_message·typing·flush·retry·attachments 무변경, EventBus subscriber throw 격리). QA 7/7 PASS. **[당일 철회]** — 라이브에서 generic "작업 진행 중…"이 긴 작업 중 ~15회+ 반복돼 정보가치 없이 노이즈만 됨. 텔레그램 progress + `region.a.progress` 이벤트(3 어댑터) + turnId 인프라(router/index/region-a) 전체 제거(`region.a.sdk_message` 는 별개라 보존 — 대시보드 의존). 교훈: 실시간 진행 가시성은 텔레그램(대화면)엔 노이즈, 대시보드(관측면)에 적합 — rich + LLM-agnostic 대시보드 활동 스트림이 올바른 후속(별도 라운드 후보). 결정 노트: `docs/decisions/2026-05-27-progress-indicator.md`.

**`/model` override 모델 spec 검증 강화 완료 (2026-06-02)** — `/model anthropic:claude-sonnet-4-7`(미실재 모델) 설정 시 다음 turn 부터 "일시적 오류" 로 뭉개지고 깨진 override 가 DB 에 갇히던 버그 수정. **근본 원인(probe 실측)** — Claude Agent SDK 는 모델 거부를 throw 하지 않고 result 메시지 `subtype:"success"` + `is_error:true` + raw API 에러 본문(`404 not_found_error`)으로 싣는다 → 어댑터가 `is_error` 를 무시해 API 에러(거부뿐 아니라 429/529/401 전부)를 정상 응답으로 채택 → 직후 teardown throw 로 뭉개짐(claude 만 throw 안 하던 비대칭). **해결 = 하이브리드 C**(화이트리스트 A 거부 — 모델 카탈로그는 외부 사실, 코어가 들면 API 보다 먼저 stale): (1) claude 어댑터 `is_error===true → throw 승격` 으로 codex/openai 와 거부 표면 정규화(parity 복원). (2) facade(`llm-runtime/index.ts`) 단일 휴리스틱 `isModelRejected`(어댑터 분기 0·카탈로그 0) 가 override 거부 시 env 풀로 1회 폴백 + ⚠️ 고지. (3) `modelOverrideRejected` 신호로 router 가 `clearSessionModelOverride`(갇힘 해소). (4) `/model` set 은 차단 없이 prefix-mismatch 경고 한 줄(실재 여부는 런타임 권위). 비-거부 에러는 폴백 없이 재던져 일반 catch 로. principle-check 통과(Q2 LLM-agnostic 하드게이트). QA 2회 PASS(경계면 7/7 · is_error 승격 5/5 · `isModelRejected` 14-case probe positive 5/5·negative 9/9 teardown 오발동 0), 라이브 http-bridge 폴백 고지+override clear 실측, typecheck EXIT 0. 결정 노트: `docs/decisions/2026-06-02-model-override-validation.md`. P3 잔여: openai 거부 e2e 미검증 · codex 비-404 거부 narrowing.

**`/model` 콤마 풀 + 에러 메시지 노출 완료 (2026-06-02)** — 두 개선. **(1) 콤마 풀** — 사용자가 `/model codex:gpt-5.5,anthropic:claude-sonnet-4-6`(REGION_A_MODELS 동일 문법) 입력 시 `parseModelSpec` 단일 파싱이 콤마 뒤 전부를 model 로 삼아 깨진 spec 저장 → "일시적 오류" 갇히던 버그 수정. `/model` 이 콤마 풀(세션별 폴백 순서) 지원 — 정책 b(유효 spec 만 canonical 저장 + 무효 part ⚠️ 경고 + 유효 0개 거부). `specLabel` codex round-trip 버그픽스(`ADAPTER_TO_PROVIDER` 역매핑 — `codex-oauth`→`codex`), router override→`parseModelSpecList` 풀 주입, `isModelRejected` 비-404 codex 거부 보강. **(2) 에러 노출** — catch 가 "요청 처리 중 일시적 오류" 만 노출하던 것을 `errorDetail`(message+cause) 노출로(사용자 요청 "에러가 다 보이게"). **보안** — `redactSecrets` 2층 마스킹(`process.env` 시크릿 값 호출시 재수집 전역치환 + sk-ant/sk-/JWT/Telegram/Bearer 패턴)을 무게이트 무조건 통과, 콘솔엔 full·채널엔 redact본, 단일-운영자 전제. principle-check 통과(화이트리스트 거부 — 미실재 모델은 런타임 권위). QA 7/7(시크릿 누출 probe 11건 잔존 0 · round-trip drop 0), 라이브 http-bridge 실측(콤마 풀 canonical 저장 + 무효 part 경고 + reset; 에러 노출은 codex `401 token_revoked` 가 redact 되어 그대로 표시되며 실증), typecheck EXIT 0. 결정 노트: `docs/decisions/2026-06-02-error-exposure-and-model-pool.md`.

**대시보드 실시간 활동 가시화 V1 (Round 1) 완료 (2026-05-27)** — 진행 표시 철회의 올바른 후속(표면 = 대시보드, 텔레그램 아님). 신규 중립 이벤트 **`region.a.activity`**(`{channel,threadKey,adapter,model?,seq,kind("tool"|"turn"),label}`)를 세 어댑터 공통 발행 → 대시보드 실시간 스트림에 표시. **절대 게이트 = LLM-agnostic parity**: 기존엔 claude `region.a.sdk_message`(raw)만 흘려 codex/openai 턴은 in→침묵→out. 해결 = **1 activity = 도구 호출 1개**(claude=tool_use 블록당, codex=toolCalls 항목당, `label`=실제 도구명) — generic tick 아님, claude raw 재사용 아님. openai 는 `run()` 도구 경계 미노출 spike 라 coarse `kind:"turn"` 1개(parity 붕괴 0만 회피). **turnId·throttle 미부활**(철회 인프라 안 되살림 — 대시보드는 전역 관측이라 nonce·throttle 불요, `seq`는 어댑터 로컬 카운터). **대시보드 코드 변경 0** — http-bridge SSE → `index.html typeClass()`가 `region.*` 자동 렌더. `region.a.sdk_message` 보존(별개 firehose). 회귀 0(additive). tsc baseline. 라이브(codex 활동 실표시) = 맥 데몬 몫. 결정 노트: `docs/decisions/2026-05-27-dashboard-activity-v1.md`. **Round 2 완료(2026-05-27)**: 대시보드 renderEvent 가 `region.a.activity` 를 정돈 렌더 — 어댑터 배지(claude/codex/openai 색상) + 도구 아이콘🔧 + 도구명 + meta(model·thread·seq), raw JSON 대신. 프런트엔드 단독(코어/어댑터 무변경, region.* 자동 렌더 위 special-case). **Round 3 완료(2026-05-27)**: 대시보드가 activity 를 collapsible **턴 카드**로 그룹핑 — `seq` 리셋(턴마다 0)을 턴 경계로 감지(turnId 부활 없이·스키마 변경 0·순수 프런트엔드). 같은 thread 활동을 한 카드에 누적(헤더 접기/펼치기·step 수), cap 제거 detached 가드. Round 4 후속: `kind:"text"`·도구 args·openai stream per-tool·턴 제목(입력 preview).

**schedule-safety-check 스킬 완료 (2026-05-16)** — scheduler bypass 회색지대 V2 가드. scheduler 결정 노트 §11 클로즈 — `bypassPermissions` 가 cron/reboot 발화 시 사용자 부재로 위험 도구 자동 실행할 가능성. 등록 *시점* 비서 능동 평가 + 사용자 명시 승인이 가장 안전한 가드. 본 라운드 = `.claude/skills/schedule-safety-check/SKILL.md` 신규 + `src/core/claude.ts` SYSTEM_PROMPT +1줄 — 사용자 메모 `feedback_skill_first_prompts.md` "정체성·항상 적용 정책만 SYSTEM_PROMPT, 그 외 스킬화" **모범 실현**. 결정 5: (Q1) **위험 3 layer** — `safe` (즉시 등록, 일상 정보 정리/요약) / `gray` (외부 송신·제한 영향, 1회 확인) / `danger` (파일 삭제·시스템 변경·credential·폭주 cron·재정, 강한 경고 + 명시 동의). 판단 우선순위 `danger > gray > safe + 의심 시 gray 격상` (over-confirm 비용 < under-confirm 사고). (Q2) **승인 템플릿** = 분류 + 위험 카테고리 + 등록 인자 + 예상 발화 1~2줄 모의 + 위험 짚어보기 + "등록 진행 / OK" 명확 동의. 4 분기 (동의/거절/변경/모호) — 변경 시 인자 수정 후 *다시* 템플릿으로 재확인. **승인 후 즉시 add_schedule 호출 + 또 묻지 않음** (over-confirm 회피). (Q3) **sysprompt 1줄** = `src/core/claude.ts:89` "하네스 라우팅" 섹션 안 (orchestrator/스킬/harness:harness 다음, 단순 질의 우회 직전). 본문 모두 스킬 안 — sysprompt 비대화 회피. (Q4) **frontmatter trigger 9 키워드** — 명시 명령("스케줄 등록", "/schedule add") / cron 어휘("매일", "매시간", "매분", "주기적", "정기적", "cron") / reboot 어휘("재시작될 때마다") / 일반("자동으로", "~ 마다"). (Q5) **영구 옵트아웃 패턴** — `add_memory({type:"feedback", name:"feedback_schedule_no_confirm"})` 박으면 메모리 인덱스 보면 비서가 스킬 호출 자율 건너뜀. **시스템이 사용자 의도를 학습** — V3 후속 "danger 자동 학습" 첫 단추. region §6 사용 절차 8 step 자체 보강 인상적. **SYSTEM_PROMPT_HASH 자동 갱신** → 기존 session resume 1회 무효화 (session-invalidation 2026-05-14 정합). 5종 코어 LOC 1772→1773 (+0.06%, ±30% 멀리 PASS). QA PASS — typecheck 0 · 정적 검증 spike 8/8 · V1+V1.1 회귀 spike 모두 재실행 PASS · LOC 게이트 정확 일치. 결정 노트: `docs/decisions/2026-05-16-schedule-safety-check.md`. **시연 (V2 후속, 비용 회피로 정적 검증 대체)** — "매일 9시에 뉴스 정리해서 CLI로" → safe 즉시 등록 · "매일 12시에 슬랙 #general 에 점심 추천" → gray 승인 요청 → "OK" → 등록 · "매분마다 임시 파일 삭제" → danger 강한 경고 → 사용자 취소. V3 후속: danger 자동 학습 · 다른 bypass 능력 동형 스킬 · 외부 작성자 자기 스킬 · 영역 A 끝-to-끝 라이브.

**대시보드 자동 시작 — `service` capability 완료 (2026-06-11)** — `packages/dashboard` 외부화(2026-05-15)의 후속. 그간 `npm run dashboard` 수동 기동에 의존하던 관측 UI 를 **데몬 부팅과 함께 자동 기동**(원칙 3 "항상 떠있다" 강화). 우회안(trigger 위장) 거부 → 기존 lifecycle 패턴의 **4번째 capability `service`** 신설(`channel`/`trigger`/`observer` 동형). `loader.ts` `KNOWN_CAPABILITIES` +`"service"` · `src/index.ts` 가 `startService(bus)` 즉시 호출 + `stop()` 을 `serviceStops[]` 로 모아 `shutdown()` 채널 대칭 일괄 정리. 경계 = UI(`packages/dashboard`, 무수정에 가까움) / 기동·정리(`plugins/dashboard` `kind:["service"]`, child process spawn/kill) / 코어(lifecycle 호출만 — 대시보드를 코어에 안 박고 데몬이 `npm run dashboard` 를 모름). 중복 기동 방지 = 대시보드 포트 `GET /` health-check(이미 떠있으면 skip → orphan 재사용·`EADDRINUSE` 회피). dev/prod = `appRoot()` 기준 source+tsx **파일 존재**로 판정(`NODE_ENV` 아님 → 오설정 견고), 없으면 graceful skip(prod 분리 후속). 포트 = `DASHBOARD_PORT`(기본 **3101**)·`HTTP_BRIDGE_PORT` env 존중(child 상속), `.env` stale `3004`→`3101` 정정. 신규 추상화 0(분기 패턴 복제). 라이브 PASS — 리로드 후 child 자동 spawn `*:3101 LISTEN`(리스너 1개) · `GET /`→200 · `/api/health`→`{"ok":true}`(bridge 3000 프록시, 전체 체인 정상) · typecheck 0. principle-check 5+메타 PASS(원칙 3 강화). 결정 노트: `docs/decisions/2026-06-11-dashboard-service-autostart.md`. 후속: prod 실행 경로 분리 · 다른 service류 재사용.

**장기 메모리 V1+V2 완료 (2026-05-14)** — 마스터 에이전트의 채널·세션 무관 영구 사실 회상이 살아있다. `memories` (typed: user/feedback/project/reference) + `memories_fts` 로 V1, `messages_fts` + `transcripts` + `transcripts_fts` + `transcript_index` 로 V2. 자동 추출은 매 turn 종료 직후 영역 B haiku 가 atomic 사실을 fire-and-forget 으로 추출 → 다음 turn 에서 자동 회상 (memory snippet 은 user prompt prepend — sysprompt fingerprint 가드 보존). 슬래시: `/reset`·`/memo <text>`·`/forget <name>`·`/memos [n]` (다채널 단일 진입점). 외부 라이브러리 0 — `better-sqlite3` FTS5 빌트인만, claude-mem 위임 거절 (`docs/decisions/2026-05-14-memory-v1-v2.md`). 시연 4 단계: (1) `/memo 내 이름은 X` → (2) `/memos` 로 저장 확인 → (3) `/forget user-name` 으로 삭제 → (4) 일반 대화에서 사용자 정보를 흘리면 다음 turn 에 자동 회상.

범위 한계는 명시적:

- **권한 모델 = bypass + 비서 능동 평가** (2026-05-04 결정). 영역 A 의 도구·MCP·플러그인·스킬·서브에이전트 능력은 Claude Code 와 동일하게 활성. 단 발견 경로는 SDK 의 `.claude/` 자동 발견이 아니다 — claude 어댑터는 SDK 격리 모드(`settingSources` 미설정)라 `.claude` 를 자동 발견하지 않고, 양 어댑터(claude·codex) 모두 tiguclaw 컨벤션(`<home>`/`<cwd>`/plugins)에서 수동 인덱스를 구성한다 (`docs/decisions/2026-05-25-claude-adapter-parity-settingsources-isolation.md`). 매 도구 호출마다 묻지 않는다(`bypassPermissions`). 대신 비서(LLM) 가 시스템 프롬프트로 능동 보안 평가자 역할을 받아, 새 플러그인·스킬·MCP 활성화나 명백히 위험한 도구 호출 전에 사용자 승인을 구한다. 데몬측 1차 게이트(`src/auth/permissions.ts`) 인프라 깔림 (V1 차단 리스트 빈 배열 — 추가는 V2 또는 추후).
- **영역 A/B 가르기 폐기 (2026-05-27 V8)** — 단발 호출용 영역 B(Vercel AI SDK)·`@deep` prefix·자동 분류 룰 전부 폐기. 모든 입력이 단일 어댑터 풀(`REGION_A_MODELS`)을 탄다. 깊은 사고는 prefix 가 아니라 비서가 부리는 능력(서브에이전트 tier 지정). 결정 노트: `docs/decisions/2026-05-27-region-unification.md`.
- **TELEGRAM_BOT_TOKEN 부재**시 Telegram 만 비활성, CLI 와 데몬은 정상 부팅. **ANTHROPIC_API_KEY 부재**시 데몬 부팅·채널 시작 모두 정상, 메시지 처리 시점에 명확한 에러 회신.

이전 방향(harness 메타 플러그인)은 폐기 (2026-04-30 방향 전환).

## 비고

- 자동 메모리는 레포 안 `.claude/memory/` 에 둔다 (사용자 선호·피드백·프로젝트 컨텍스트). user-level `~/.claude/projects/E--work-test-tiguclaw-v2/memory` 는 이 경로로 junction되어 있어 Claude Code 자동 메모리 쓰기·읽기가 그대로 레포에 떨어진다 → 다른 머신에서도 동일 컨텍스트 재사용.
- 새 머신에서 클론 후 1회 셋업: `cmd /c mklink /J "%USERPROFILE%\.claude\projects\E--work-test-tiguclaw-v2\memory" "<repo>\.claude\memory"`.
- 모든 프로젝트 의사결정 · 아키텍처는 이 레포 안 (`docs/`).
