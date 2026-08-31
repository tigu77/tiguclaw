# 설치와 운영

[README](../README.md) 로 돌아가기 · [English](setup.en.md)

설치를 마쳤거나 마치는 중인 분을 위한 문서입니다. "이게 뭔지" 는 [README](../README.md) 에 있습니다.

### provider 고르기

| provider | 방법 |
|---|---|
| **Ollama (로컬)** | 키 불필요·무료·오프라인. Ollama 만 설치하면 끝. (작은 모델 = 품질 낮음.) |
| **Anthropic API 키** | console.anthropic.com 에서 발급 — 가장 쉬움, 종량제. |
| **Claude 구독** ⚠️ | Claude Pro/Max 구독 사용 — 온보드가 **대신 발급**합니다(`npm run claude-auth`, 브라우저 로그인만). API 키 불필요·종량 과금 없음. **약관 주의 — [아래](#구독-토큰을-쓰기-전에) 참고.** |
| **OpenAI API 키** | platform.openai.com — 종량제. |
| **codex (ChatGPT 구독)** ⚠️ | 설치 후 `npm run codex-auth` 로 로그인. **약관 주의 — [아래](#구독-토큰을-쓰기-전에) 참고.** |
| **OpenAI 호환이면 무엇이든** | OpenRouter·Groq·Together·vLLM·직접 띄운 엔드포인트 — 코드 없이 `settings.json` 에 적으면 됩니다. 아래 참고. |

#### OpenAI 호환 provider 붙이기

OpenAI API 를 말하는 엔드포인트라면 무엇이든 정식 provider 가 됩니다. 어댑터를 짜는 게 아니라
세 줄을 적으면 돼요. `<home>/settings.json` 에 이렇게 넣습니다:

```json
{
  "models": {
    "providers": {
      "openrouter": {
        "adapter": "openai",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      }
    }
  }
}
```

`.env` 에 `OPENROUTER_API_KEY` 를 넣으면, 모델 이름을 쓰는 자리 어디서나 쓸 수 있습니다 —
`openrouter:anthropic/claude-sonnet-5` 처럼 직접 지정하거나, 모델 프로파일 풀에 넣거나,
폴백 대상으로 두거나요. OpenRouter 하나만 붙여도 수백 개 모델이 한 줄 거리에 들어옵니다.

**이름을 외울 필요는 없습니다.** 붙이고 나면 `/models` 가 그 provider 의 모델을 조회해
보여주고, 벤더가 알려주는 경우 컨텍스트 크기와 도구 사용 가능 여부도 `[131K · 도구✅]`
처럼 같이 붙습니다(안 알려주면 아무 표시도 안 붙습니다 — 모르는 걸 아는 척하지 않습니다).
다만 **목록에 있다고 다 쓸 수 있는 건 아닙니다** — 벤더가 오래된 모델을 목록에만 남겨두는
경우가 있어서, 고른 게 안 되면 그때 사유를 알려드립니다.

몇 가지 알아두실 것: 키는 환경변수에 있고 파일에는 안 들어갑니다(`apiKeyEnv` 는 변수
*이름*입니다). 빌트인 provider 이름은 덮어쓸 수 없어요 — 여기에 `anthropic` 을 적어도
무시되므로, 설정 하나가 믿고 쓰던 이름을 조용히 다른 데로 돌리는 일이 없습니다. `adapter` 가
`openai`·`claude`·`codex-oauth` 가 아니면 어중간하게 도는 대신 거부됩니다.

### 키·토큰 발급 가이드

단계별 — 고른 provider 1개 (+ 채팅 원하면 텔레그램 봇) 만 있으면 됩니다. `onboard` 가 각 항목을 물어보며 이 힌트를 인라인으로 보여줍니다.

**텔레그램 봇 토큰** (채팅 인터페이스)
1. 텔레그램에서 **[@BotFather](https://t.me/BotFather)** 열고 `/newbot` 전송.
2. 봇 표시 이름 입력 → 그다음 `bot` 으로 끝나는 username 입력 (예: `my_assistant_bot`).
3. BotFather 가 `123456:ABC-DEF…` 형태 토큰을 줍니다 — 복사.
4. *(권장 — 1:1 전용 잠금)* `/setjoingroups` → **Disable**, `/setprivacy` → **Enable**.

**내 텔레그램 user ID** (소유자 allowlist)
- 가장 쉬움: `onboard` 중에 봇에게 메시지 1번 보내면 ID 자동 감지.
- 수동: **[@userinfobot](https://t.me/userinfobot)** 에게 메시지 → 숫자 `Id` 확인.

**Anthropic API 키** (`sk-ant-…`)
1. **console.anthropic.com** 로그인.
2. **Settings → API Keys → Create Key** → 이름 입력 → 복사 (한 번만 표시됨).
3. **Plans & Billing** 에서 크레딧 충전 (종량제).

**Claude 구독** (API 키 대신 Claude Pro/Max 구독 사용) — ⚠️ [약관 주의](#구독-토큰을-쓰기-전에)

마법사에서 **claude-sub** 를 고르면 끝입니다. 토큰은 **저희가 받아 적습니다** — 브라우저가
열리면 로그인만 하세요. 따로 설치할 것은 없습니다(발급에 쓰는 `claude` 실행기가 `npm ci` 때
의존성으로 함께 깔립니다).

나중에 다시 받거나 계정을 바꾸려면 아무 때나:

```bash
npm run claude-auth      # 또는 tiguclaw claude-auth
```

**OpenAI API 키** (`sk-…`)
1. **platform.openai.com** 로그인.
2. **API keys → Create new secret key** → 복사.
3. **Billing** 에서 크레딧 충전.

**Google Gemini 키** (선택)
1. **aistudio.google.com** → **Get API key → Create API key** → 복사. (무료 한도 넉넉.)

**codex (ChatGPT 구독)** — *붙여넣을 키 없음* · ⚠️ [약관 주의](#구독-토큰을-쓰기-전에)
- 설치 후 `npm run codex-auth` 실행 → 로그인 URL 열림 → ChatGPT 로그인 → 권한 허용. 토큰 자동 저장·갱신. (ChatGPT Plus/Pro 구독 필요.)

**Ollama (로컬)** — *키 없음*
1. **ollama.com** 에서 설치 (macOS는 `brew install ollama`).
2. 모델 받기: `ollama pull llama3.2` (품질 원하면 `ollama pull qwen2.5:7b`).

### 구독 토큰을 쓰기 전에

⚠️ **구독(Claude Pro/Max · ChatGPT Plus/Pro)으로 얻은 토큰을 서드파티 도구에서 쓰는 것은 각
제공사 약관이 허용하지 않을 수 있습니다.** 구독은 대개 **그 회사의 공식 클라이언트**에서 쓰라고
파는 것이고, 프로그램적 접근에는 API 키(종량제)를 따로 둡니다.

정직하게 말씀드립니다 — 우리는 이 경로를 **막지 않습니다.** 실제로 잘 돌고, 개인이 자기
계정으로 자기 기계에서 쓰는 건 널리 하는 일입니다. 다만 **결과는 계정 주인에게 갑니다**:
제한·정지·해지가 일어나면 그건 tiguclaw 가 아니라 제공사와 사용자 사이의 일입니다. 모르고
고르는 일이 없도록 적어 둡니다.

**특히 LLM 게이트웨이와 같이 쓰지 마세요.** 게이트웨이(`/v1/chat/completions`)를 켜면 내가 만든
앱이 이 풀을 백엔드로 씁니다. 거기에 구독 토큰이 물려 있으면 **개인 구독이 임의 앱의 API
백엔드**가 되는데, 그건 대화형 개인 사용과 성격이 다릅니다. 게이트웨이가 쓸 프로파일은
**API 키 프로바이더로** 따로 두세요 ([LLM 게이트웨이](gateway.md)).

약관이 걸리신다면 — **Ollama(로컬·무료)** 또는 **API 키(종량제)** 는 이 문제에서 자유롭습니다.

### 평소 사용

- **어디서나 제어** — `onboard` 가 `npm link` 를 자동 실행해, 어느 폴더에서나 `tiguclaw status | restart | stop | start | update | logs | doctor | uninstall` 가 됩니다(진짜 앱처럼). **`update` 가 복구 명령이기도 합니다** — 아래 [업데이트](#업데이트) 참고. *(레포 안에선 `npm run daemon:*` 도 가능.)*
- **서비스 관리**(macOS / Linux / Windows 공통 명령): `npm run daemon:status | daemon:restart | daemon:stop | daemon:start | daemon:logs`.
- **일시정지 vs 제거** — `daemon:stop` 은 실행만 멈추고 등록은 유지합니다(다음 로그인 때 다시 자동 가동). `daemon:start` 로 재개. 완전히 없애려면 `daemon:uninstall`.
- **뭔가 이상하면?** `npm run doctor` 가 키·봇 도달·홈·서비스를 점검합니다.

**규칙 가르치기.** "앞으로는 항상 ~해줘" 라고 말하면 런타임 홈의 `AGENT.md` 에 적습니다 —
비서의 정체성 파일이자 **상시 지침이 사는 유일한 자리**예요. 여기 적힌 건 **매 턴** 실리니까
조용히 잊히지 않습니다. 가끔 찾는 사실(일정·링크·수치)은 메모리로, 특정 프로젝트 얘기는 그
프로젝트 폴더 안으로 갑니다. 비서가 쓰는 기준은 하나예요 — *이게 매 턴 필요한가?* 아니면
상세는 아래로 내리고 포인터만 남깁니다.

참고:

- `.env` 에는 봇 토큰·LLM 키가 들어 있어요 — **절대 커밋·공유 금지**(이미 gitignore 처리됨).
- LLM 사용 **비용은 본인 부담**(본인 키 / 구독).
- 설치는 **`npm ci`** 권장 — `package-lock.json` 그대로 결정적으로 깔고 lockfile 을 수정하지 않습니다. `npm install` 도 되지만 lockfile 을 로컬에서 살짝 바꿀 수 있어요(그 변경은 커밋 안 해도 됨).
- `npm run daemon:install` 은 OS별로 상시 서비스를 등록합니다:
  - **macOS** → launchd (crash 자동 재시작·로그인 시 가동).
  - **Linux** → systemd **user** 서비스 (`Restart=always`). 로그인 없이 부팅 가동하려면: `loginctl enable-linger $USER`.
  - **Windows** → 레지스트리 Run 키(HKCU — **관리자 권한 불요**; 로그온 시 숨김 가동). crash 자동재시작 없음; 완전한 KeepAlive 는 **WSL2** 권장.
  - KeepAlive 강도는 솔직히 macOS > Linux > Windows 순. 위 관리 명령은 3 OS 모두 동일합니다.
- **의존성이 깨져도 관리 명령은 항상 됩니다** — install / uninstall / restart / stop / start / **update** 는 순수 Node 로만 돕니다(빌드·`tsx` 불필요). 그래서 `node_modules` 가 깨졌거나 없어도 서비스를 멈추거나, 제거하거나, **`tiguclaw update` 로 되살릴 수** 있습니다.
- **뭔가 깨졌으면 `tiguclaw update` 한 줄입니다.** 데몬 정지 → `npm ci` → 재빌드 → 기동을 순서대로 하고, 실패하면 이전 상태로 롤백합니다. ★`npm ci` 를 직접 돌리지 마세요 — 데몬이 떠 있으면 네이티브 모듈 파일이 잠겨(`EPERM`) 설치가 깨집니다. 멀쩡히 돌던 설치가 그렇게 망가집니다. 정지를 먼저 해주는 게 `update` 가 있는 이유입니다.

### 업데이트

그냥 **"업데이트해줘"** 라고 하거나 `/update` 를 보내면 됩니다. 최신 코드를 받아 재시작하고, 다 되면 알려줍니다. 기억·세션·설정은 그대로 이어집니다 — 업데이트는 코드만 건드리고 데이터는 손대지 않아요. 새 코드가 실행 가능한 형태로 빌드되지 않으면 이전 버전으로 롤백해 계속 돌아갑니다(데몬이 죽는 일은 없습니다).

터미널에서 직접 하려면 **`tiguclaw update`** — 같은 일을 합니다(정지 → 최신 코드 → `npm ci` → 재빌드 → 기동, 실패 시 롤백). 데몬이 아예 안 뜨는 상태에서도 이 명령은 됩니다.

★`git pull` 이나 `npm ci` 를 손으로 치지 마세요. 순서를 하나라도 빠뜨리면(특히 정지 없이 `npm ci`) 네이티브 모듈이 안 깔려 데몬이 못 뜹니다 — `update` 가 그 순서를 알고 있습니다.

### 재설치 · 런타임 모드

**재설치 / 복구** — `npm run onboard`(또는 `npm run daemon:install`)를 다시 실행하면 서비스 등록을 그 자리에서 덮어씁니다. 레포 폴더를 옮겼거나 서비스가 이상해졌을 때 쓰면 돼요 — 데이터는 건드리지 않고 안전합니다.

**런타임 모드** — `npm run onboard` 는 기본으로 **컴파일된 빌드**를 설치합니다: `dist/` 로 컴파일한 뒤 `node dist/src/index.js` 로 구동해요 — 부팅이 빠르고 실행 중 변환이 없습니다. 따로 할 건 없습니다.

**TypeScript 소스**로 바로 돌리고 싶다면 — 빌드 단계가 없고 업데이트가 받는 즉시 적용됩니다(개발할 때 편함) — `TIGUCLAW_RUNTIME=source` 로 설치하세요:

```bash
TIGUCLAW_RUNTIME=source npm run onboard
```

모드는 설치할 때 고정되어 저절로 바뀌지 않습니다 — 업데이트는 고른 모드를 유지합니다(built 설치는 자동 재컴파일, 업데이트마다 몇 초 추가). 나중에 바꾸려면 `TIGUCLAW_RUNTIME` 을 지정하고 install 을 다시 실행하세요.

### 삭제 (Uninstall)

1. **서비스 중지·제거** — `npm run daemon:uninstall` (macOS launchd / Linux systemd user / Windows 레지스트리 Run 공통).
2. **데이터 삭제** — ⚠️ 되돌릴 수 없음 (세션·메모리·DB·agents·skills): `rm -rf ~/.tiguclaw` (또는 `TIGUCLAW_HOME` 이 가리키는 경로).
3. **전역 명령 제거** (`npm link` 했을 때만) — `npm rm -g tiguclaw`.
4. **프로젝트 폴더 삭제** — `rm -rf tiguclaw`.
5. *(선택)* 외부 정리 — **@BotFather** 에서 봇 삭제(`/deletebot`), 콘솔에서 API 키 폐기, 받은 로컬 모델은 `ollama rm <모델>`.
