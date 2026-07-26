---
name: app-ai-wiring
description: "앱(웹·서버·스크립트 등)에 AI/LLM 을 연결할 때 사용. tiguclaw 에 붙이는 두 방식 — (A) tiguclaw 직결 커스텀 엔드포인트(비서의 도구·스킬·메모리까지 쓰는 에이전틱 호출, 규약 자유) vs (B) OpenAI 호환 LLM 게이트웨이(OpenRouter·OpenAI 와 baseURL 만 바꿔 스왑 가능한 표준 규약) — 의 선택 기준·규약·배선 절차·검증을 담는다. 트리거: '앱에 AI 붙여줘', '이 앱에서 LLM 쓰게 해줘', 'tiguclaw 를 백엔드로', '오픈라우터처럼 연결', 'API 로 비서 호출', '게이트웨이 켜줘', 앱 개발 중 LLM 연결 지점에 도달했을 때. 사용자가 방식을 안 정했으면 §1 기준으로 추천하고 확인받은 뒤 배선한다."
---

# 앱 ↔ AI 연결 배선 (tiguclaw)

앱에 AI 를 붙이는 방법은 **두 가지**다. 성격이 완전히 달라 먼저 고르고 배선한다.
**사용자가 지정했으면 그대로 따르고, 안 정했으면 §1 로 추천 + 확인**받는다(맘대로 정하지 말 것).

---

## §1 어느 쪽인가 — 판단 기준

| | **A. tiguclaw 직결 엔드포인트** | **B. OpenAI 호환 게이트웨이** |
|---|---|---|
| 앱이 얻는 것 | **비서 자체**(도구·스킬·메모리·서브에이전트·프로젝트 맥락) | **LLM 한 방**(순수 텍스트 생성) |
| 규약 | **없음** — 내가 자유 설계 | **OpenAI 스펙 고정** |
| 교체 | tiguclaw 전용(스왑 불가) | **OpenRouter·OpenAI 로 baseURL 만 바꿔 스왑** |
| 반영 | 재시작 **불요**(데이터 기반) | 토큰 설정 시 **재시작 필요**(.env) |

**A 를 고르는 신호**: "내 파일 읽어서", "메모리 참고해서", "스킬 태워서", "프로젝트 맥락 알고",
여러 단계 자율 작업, tiguclaw 만의 능력이 핵심일 때.
**B 를 고르는 신호**: 요약·분류·번역·챗봇 등 **모델만 있으면 되는** 일, 나중에 상용 API 로
갈아탈 계획, 이미 OpenAI SDK 로 짠 앱, 함수호출/비전 같은 **표준 기능**이 필요할 때.

> 애매하면 **B**(표준이라 나중에 A 로 못 바꾸는 손해가 없고, 스왑 자유). 단 "비서를 부르고
> 싶은 것"이면 B 로는 절대 안 되니 A.

---

## §2 모드 A — tiguclaw 직결 커스텀 엔드포인트

엔드포인트 = **슬래시 명령의 HTTP 판**. `<home>/endpoints/<name>.md`(frontmatter + 프롬프트
템플릿)를 http-bridge 가 **매 요청 발견**해 서빙한다. 임의 코드 0 = 데이터만, **재시작 불요**.

### 배선
1. `registerEndpoint` 도구로 등록(`listEndpoints`/`deleteEndpoint` 로 조회·삭제).
   - `path` — 라우트(예 `/weather`). 슬래시 시작·소문자 정규화.
   - `method` — `GET`|`POST`(기본 POST).
   - `role` — 인증 게이트(기본 `write`). 앱은 **bridge 토큰**으로 호출.
   - `mode` — 기본 `restricted`(도구 0). 비서 도구가 필요하면 명시적으로 열어야 함.
   - 본문 = 프롬프트 템플릿(요청 파라미터를 끼워 넣음).
2. 앱은 그 경로를 호출: `POST http://127.0.0.1:<HTTP_BRIDGE_PORT>/<path>` + bridge 토큰.

### 주의
- 기본이 `restricted`(도구 0)라 **에이전틱 능력을 쓰려면 mode 를 열어야** 한다. 열 때는
  무인 트리거라는 점을 감안해 위험 도구 노출을 최소화(사용자 확인).
- 응답 규약은 내가 정한다 = 앱과 **계약을 명시**해 둘 것(문서/주석).

---

## §3 모드 B — OpenAI 호환 LLM 게이트웨이 (규약)

`POST /v1/chat/completions` · `GET /v1/models` 를 OpenAI 규격 그대로 서빙한다.
**OpenRouter 와 같은 규약**이라 앱은 `baseURL`·`apiKey`만 바꾸면 그대로 붙는다.

### 켜는 법 (기본은 꺼져 있음 = 404)

**① 토큰(시크릿) — `<home>/.env`, 최초 1회만 · 재시작 필요**
```
LLM_GATEWAY_TOKEN=<임의 비밀문자열>
```
시크릿이라 **파일(settings.json)에 raw 로 두지 않는다**(D5 원칙). env 는 부팅 고정이라
이 값을 새로 넣거나 바꿀 때만 재시작(`npm run build:prod && npm run daemon:restart`).

**② 나머지 설정 — `<home>/settings.json`, ★재시작 불요(매 요청 fresh read)**
```json
{
  "gateway": {
    "enabled": true,
    "models": ["codex:gpt-5.5"],
    "maxConcurrency": 4,
    "tokenEnv": "LLM_GATEWAY_TOKEN"
  }
}
```
- `enabled` — **킬스위치**(토큰은 둔 채 껐다 켰다). 생략=true.
- `models` — 기본 모델 풀. 생략 시 env `LLM_GATEWAY_MODELS`→`REGION_A_MODELS` 폴백.
- `maxConcurrency` — 동시 처리 상한(초과 429). 생략=4.
- `tokenEnv` — 토큰을 읽을 env 변수명. 생략=`LLM_GATEWAY_TOKEN`.
- ★`gateway` 섹션 자체가 없으면 **레거시 env 경로**(토큰 존재만으로 활성) = 기존 설정 무회귀.

→ **토큰만 한 번 심어두면, 그 뒤 켜기/끄기·모델·동시성 변경은 재시작 없이 즉시 반영된다.**
즉 비서가 사용자 대화를 끊지 않고 게이트웨이를 토글할 수 있다.

주소 = `http://127.0.0.1:<HTTP_BRIDGE_PORT>/v1` (기본 127.0.0.1 바인드 = 로컬 전용).

### 앱 배선 (OpenAI SDK — OpenRouter 자리에 그대로)
```js
const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,  // http://127.0.0.1:<port>/v1
  apiKey:  process.env.OPENAI_API_KEY,   // = LLM_GATEWAY_TOKEN
});
```

### 모델 이름 규약 (★OpenRouter 슬러그와 다름)
- `provider:model` — `codex:gpt-5.5`, `anthropic:claude-opus-4-7`, `openai:gpt-4o-mini`, `ollama:qwen2.5:7b`
- `tier:<프로파일>` — settings.json `models.profiles` 의 명명 프로파일(`tier:high`·`tier:default` 등)
- 목록은 `GET /v1/models` 로 확인(거기 나온 id 를 그대로 쓰면 왕복 보장)
- ⚠️ **목록에 없는 이름을 보내면 400 이 아니라 조용히 기본 풀로 폴백**한다(알려진 갭) —
  반드시 `/v1/models` 의 id 를 쓸 것.

### 지원 범위
**되는 것**: 채팅 · 스트리밍(SSE) · **함수호출(tools/tool_calls)** · **비전(이미지 입력)** ·
`usage` 토큰 · `/v1/models`
- 함수호출: 앱이 `tools` 를 주면 모델이 **실행하지 않고** `tool_calls` 를 반환
  (`finish_reason:"tool_calls"`) → **앱이 실행**하고 `role:"tool"` 로 결과를 돌려주면 이어감.
- 비전: `image_url` 의 **`data:` URI(base64)만** 지원. `http(s)` URL 은 미지원(SSRF 방지).

**안 되는 것**: 이미지·음성 **생성**(`/v1/images`·`/v1/audio`) · `/v1/completions`(legacy) ·
embeddings · `response_format` 스키마 강제.
→ 이미지/음성 생성이 필요하면 **그 모달리티만 실제 프로바이더**(OpenAI·Replicate 등)로 직접 붙인다.

### 멀티라운드 한계(정직하게)
게이트웨이는 요청마다 새 세션이라, 이전 `tool_calls`/`role:"tool"` 은 **텍스트로 재구성**해
모델에 전달한다(네이티브 tool-state 재현이 아님). 단순 왕복엔 충분하나, 복잡한 다단계 함수
호출 루프는 기대만큼 안 이어질 수 있다.

---

## §4 dev ↔ prod 스위처블 배선 (기본 권장)

두 모드 다 OpenAI 호환이라 **코드 수정 0**으로 전환된다. 앱엔 항상 env 두 벌을 준비:
```bash
# dev — tiguclaw 게이트웨이(무료·로컬)
OPENAI_BASE_URL=http://127.0.0.1:3000/v1
OPENAI_API_KEY=<LLM_GATEWAY_TOKEN>
OPENAI_MODEL=codex:gpt-5.5

# prod — 상용 API / OpenRouter
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-...
OPENAI_MODEL=anthropic/claude-sonnet-4.6
```
모델 이름이 규약별로 다르므로 **모델명도 env 로** 뽑아둘 것.

### ★약관 가드 (중요)
tiguclaw 는 **개인 구독 인증**(Claude Code OAuth·ChatGPT)으로 돌 수 있다. 이 백엔드를
**외부 앱·타인에게 중계·판매하면 약관 위반 소지**가 크다.
- **본인 로컬 dev/테스트** → 게이트웨이 OK
- **외부 배포·타인 사용·부하 테스트** → 반드시 **상용 API 키**(`LLM_GATEWAY_MODELS` 를 상용
  프로바이더로 두거나, 앱을 OpenRouter/OpenAI 로 직결)

### 네트워크 노출 시
기본 `127.0.0.1`. 다른 기기에서 붙이려면 `HTTP_BRIDGE_HOST=0.0.0.0` — 단 **TLS 없음**이라
Tailscale 같은 암호화 경로 권장, 그리고 그 포트엔 대시보드·제어 API 도 함께 열리므로
프록시로 `/v1/*` 만 통과시키는 게 안전.

---

## §5 배선 후 검증 (반드시)

```bash
# 게이트웨이(모드 B)
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:<port>/v1/models
curl http://127.0.0.1:<port>/v1/chat/completions \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"<위 목록의 id>","messages":[{"role":"user","content":"안녕"}]}'
```
- 함수호출을 쓰는 앱이면 `tools` 를 실어 `finish_reason:"tool_calls"` 가 오는지까지 확인.
- 모드 A 면 등록한 경로를 bridge 토큰으로 호출해 실제 응답을 확인.
- **앱에서 한 번 실제로 호출**해 보고 보고할 것(추측 금지).

---

## 불변식
- 사용자가 모드를 정했으면 **그대로**. 안 정했으면 §1 로 **추천 후 확인**.
- 게이트웨이 토큰·상용 키는 **절대 코드·settings.json 에 raw 로 두지 말 것**(env 만, D5).
- **토큰을 새로 심을 때만** 재시작이 필요하다 — 라이브 데몬이 대화 중일 수 있으니 **사전 고지**.
  그 외(켜기/끄기·모델·동시성)는 settings.json 편집으로 재시작 없이 처리한다.
