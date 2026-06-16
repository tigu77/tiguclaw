# tiguclaw

항상 떠있는 멀티 LLM AI 비서 데몬. **Claude Code가 할 수 있는 모든 것**에 더해, 여러 LLM을 동시에 쓰고, Telegram · CLI · HTTP 다채널 입력을 **단일 인격**으로 관장한다. 자기 머신에 설치해 자기 키·봇으로 돌리는 자가호스트.

## 특징

- **Claude Code 슈퍼셋** — 파일 읽기/쓰기/편집, Bash, 웹 검색, 스킬, 서브에이전트, 훅, 슬래시 명령, 자동 메모리까지 그대로 + 그 위에 확장.
- **멀티 LLM, 어댑터 무관** — `codex`(ChatGPT) · `anthropic` · `openai` · `ollama`(로컬) · `google`(Gemini)를 `provider:model` 한 줄로 섞어 쓴다. 어떤 어댑터로 바꿔도 같은 능력.
- **항상 떠있는 데몬** — supervisor(launchd 등)로 상시 실행, 죽으면 자동 재기동.
- **다채널 단일 인격** — Telegram · CLI · HTTP 어디로 들어와도 한 비서, 대화 맥락 공유.
- **모델 티어 + 로컬 위임** — 작업 난이도별 티어(high/mid/low)에 더해 `nano` 로컬 티어. 단순 작업은 로컬 모델(Ollama)에 위임해 비용 0·오프라인.
- **데이터는 내 머신에** — 세션·메모리·DB 전부 로컬(`~/.tiguclaw`).

## 시작하기 (자가호스트)

> 설치 전 [`docs/security.md`](docs/security.md) 신뢰 모델을 꼭 읽어라 — 비서는 *당신 머신*에 쉘·파일 접근 권한을 갖는다(Claude Code와 동일한 자기-선택).

**준비물**: Node 20+ · git · LLM provider 1개(아래 중 택1) · (선택) 텔레그램 봇.

| LLM provider | 진입 |
|---|---|
| Ollama (로컬) | 키 불필요·무료·오프라인 (모델 품질은 낮음) |
| Anthropic API 키 | console.anthropic.com 발급 (가장 쉬움, 종량) |
| OpenAI API 키 | platform.openai.com (종량) |
| codex (ChatGPT 구독) | 설치 후 `npm run codex-auth` 로 OAuth |

**설치 (원샷):**

```bash
git clone https://github.com/tigu77/tiguclaw.git && cd tiguclaw
npm install        # 의존성 (better-sqlite3 네이티브 빌드 포함)
npm run onboard    # ★ 설정 마법사(.env) → (codex)OAuth → 데몬 등록 → 검증
```

`onboard` 하나로 설정·인증·상시 등록·검증이 순서대로 끝난다. 이후 **텔레그램 봇에게 메시지**를 보내면 응답한다 (마법사에 넣은 소유자 ID만 허용 — allowlist가 비면 봇은 잠긴다).

**개별 단계로**: `npm run init` / `npm run codex-auth` / `npm run daemon:install` / `npm run doctor` (포그라운드 개발은 `npm run dev`).

**전역 `tiguclaw` 명령**(선택): `npm link` 후 어디서나 `tiguclaw onboard | status | restart | logs`.

**데몬 관리**(macOS launchd): `npm run daemon:status | daemon:restart | daemon:logs | daemon:uninstall`.

**주의:**
- `.env`(봇 토큰·LLM 키)는 **절대 커밋·공유 금지**(gitignore 처리됨).
- LLM 호출 **비용은 본인 부담**(종량 키 또는 구독).
- 자동 등록은 현재 **macOS(launchd)** 검증. linux/windows는 수동 supervisor로 실행(`npm run daemon:install`이 명령 안내).

## 핵심 원칙

1. **Claude Code 슈퍼셋** — Claude Code의 모든 능력을 포함하고 그 위에 확장한다.
2. **멀티 LLM 동시 사용** — 작업별로 다른 LLM을, 어댑터 무관하게 같은 능력으로.
3. **항상 떠있다** — 상시 데몬, 자동 재기동.
4. **다채널 단일 인격** — 어느 채널로 들어와도 하나의 비서.
5. **진짜 일만 직접 만든다** — 핵심만 직접 구현, 나머지는 데이터(컨벤션·prompt·skill·hook·memory)로 확장.

## 아키텍처 (한눈에)

- **코어**: 단일 LLM 런타임(어댑터 풀: claude/codex/openai/ollama/google) + 라우터 + 스토어(SQLite: 세션·메모리·transcripts).
- **채널**: Telegram · CLI · HTTP 어댑터 — 추상 의도를 채널별로 렌더.
- **플러그인**: 스케줄러(cron) · 파일 워치 · 대시보드 · http-bridge 등 — 코어를 안 건드리고 능력 확장.
- **능력은 데이터**: `<home>/agents`·`skills`·메모리·훅으로 무한 확장(마이크로커널 + 플러그인 생태).

## 라이선스

MIT — [`LICENSE`](LICENSE) 참조.
